# Soulmask `actor_data` blob format

Status as of 2026-05-14: header is reliably decoded; the body's property
layout is **not** fully reverse-engineered; the inventory slot array can be
located by byte-pattern matching, and explicit per-slot counts decode, but
many per-slot fields (including the slot 0 count) and the property-name
encoding scheme are unsolved.

## Honesty roll-call

What we have actually verified vs. what's still a guess. Read this before
trusting anything else in this doc. Audited 2026-05-14 against the
12,027-row example `world.db`.

| Claim | Status |
|---|---|
| 14-byte header layout (versionTag/word1/word2/extra) | **verified** — same shape across every blob |
| Body is uncompressed | **verified** — strings appear in plain ASCII; byte-frequency histograms are stable across two saves of the same world |
| First two body fields are full FStrings (`[i32 len][bytes][\0]`) | **verified** — `ZhuRenGuid` and `StructProperty` always decode cleanly at offset 14 |
| Body is a standard UE `FObjectAndNameAsStringProxyArchive` stream | **falsified** — a strict FArchive walker fails at offset 14 (interprets `Stru` as a 4-byte length 1,970,435,155) |
| Back-refs index into a **per-blob** name pool (not a global cooked one) | **confirmed** — user-supplied chest name "Aleena's Medicines" encodes as `[back-ref]'s Medicines\0`, where "Aleena" was player-typed and emitted earlier in the same blob. A global engine table wouldn't carry "Aleena" |
| Back-ref markers are uniformly 2 bytes | **falsified** — observed markers range 2–7 bytes in one ObjectProperty value. The marker encoding has internal structure we haven't decoded |
| Object-path "values" are single FStrings | **falsified** — they're multi-piece structures with binary markers between ASCII chunks; the length prefix isn't a clean byte count of one FString |
| Inventory `Entries\0` marker locates the slot array | **partially verified** — present in every BG actor that holds items, also present on player rows (see below). The current decoder finds *some* records but also produces false positives when applied to player blobs |
| 1B / 2B / 3a-1f slot count encoding | **verified for explicit counts** — diff'd against known stack sizes in test boxes |
| Slot-record structure (sep / count / slot-idx / instance-meta / sentinel / FGuid / sep) | **verified by diff** on chest/workbench BG actors; not validated against NPC inventory bags or player on-row inventory |
| "23 bytes of 0xFF padding after `None` terminator" | **wrong** — it's 24 bytes |
| Per-row max-stack | **unknown** — not in `world.db`. Defaulting to anything hardcoded is the source of the "sand bandits carry 300 hammers" bug |
| `BP_BindBGCompActor_C` rows are paired with `HPlayerState` rows by Steam ID | **falsified** — 0/1881 BindBGCompActor rows have Steam-ID `actor_name`, and 0/5 player rows have a name-matched BG actor. The pairing is by **adjacent serial to a pawn**, not by name to HPlayerState |
| `BP_BindBGCompActor_C` is "for NPCs" | **too narrow** — it's for any pawn-like actor. In this DB, that's NPCs (sand bandits, savage, desert wolf, exiles, scouts) AND the player's own pawn (`BP_EgyptDLC_PlayerBase_F_C` / `_M_C`, classed under `/NPC/Human/` in the game files). The 1881 BindBGCompActor rows: ~1876 paired with NPC classes, 5 with player pawns |
| Player inventory lives entirely on a BG-actor row | **partially wrong** — there are TWO storage rows for a player. The player's `HPlayerState` row carries its own snapshot (the user's experiment: hotbar + some upper-inventory items copied across when the HPlayerState row alone was duplicated). The live runtime inventory is on the `BindBGCompActor` paired with the player's pawn (`PlayerBase_F/M_C`). Which row holds which subset of items isn't fully understood |
| The `serial+1 = owner` heuristic is reliable | **empirical, not guaranteed** — it works because the game spawns the inventory actor, then the owner, then links them, so they end up at adjacent allocated serials. There's no format-level invariant; orphaned BG actors and out-of-order spawns can break it |

## Where the format lives

Every row in `actor_table.actor_data` holds a binary blob describing one
UE actor's persisted state. Three kinds:

| Detection | Codec | Status |
|---|---|---|
| First 4 bytes are length prefix matching JSON-looking text | `codec-json.js` | fully decoded, round-trip safe |
| First 4 bytes = `02 00 00 00` (version tag) | `codec-unreal-properties.js` | header decoded, body opaque pass-through |
| BG-actor variant of the above with an `Entries` slot array | `codec-inventory.js` | slot array located, explicit counts decoded, per-slot sub-stream opaque |

The unreal-properties codec is the catch-all. The inventory codec is a
specialization that runs on top of unreal-properties bodies whose body
contains the literal substring `Entries\0` (the property name for the slot
array).

## File layout (verified)

```
[14-byte header]
  u32  versionTag    always 0x00000002
  u32  headerWord1   varies — loosely correlates with body size,
                     possibly a save-sequence number or checksum
  u32  headerWord2   `?? ?? 02 00` pattern (top half always 0x0002);
                     61 distinct values seen across a 12k-row DB;
                     likely a per-row FCustomVersion tag or class hash
  u16  headerExtra   always 0 in observed data

[body]  uncompressed property stream (layout NOT fully reverse-engineered)
```

**Body is NOT compressed.** Exhaustively tested zlib (at every offset
including each `78 01` near-magic byte hit), LZ4 frame, LZ4 block, and
zstd. All failed. The entropy is ~6.87 bits/byte; literal strings
`ZhuRenGuid`, `StructProperty`, `BaoGuoComponent` etc. appear in plain
ASCII inside the body. The `XX 00` frequency histogram is also nearly
identical between two saves of the same world (e.g. `0x15 00` appears 395
times in both), which would be impossible if the body were the compressed
output of two different inputs.

## Property serialization (mostly unsolved)

The body is a sequence of (property name, property type, property value)
records terminated by a `None` marker, in the same spirit as UE's
`FObjectAndNameAsStringProxyArchive`. The first two records always decode
cleanly:

```
0x0e: 0b 00 00 00  Z h u R e n G u i d \0          ← FString "ZhuRenGuid"
0x1d: 0f 00 00 00  S t r u c t P r o p e r t y \0  ← FString "StructProperty"
```

But the standard UE property-tag walker fails right after that. With
`FName = FString + i32 Number`, a strict walker at offset 14 produces:

```
read 1970435155 @ 37: only 65092 left
```

`1970435155` is `0x75747253` little-endian = `"Stru"`. The walker has
gotten 4 bytes off and is reading ASCII as a length prefix.

### What we've cracked

- **FName is a plain FString** (no `FName.Number` int32 after).
- **Each property record has an 8-byte tail** between Type FName and the
  value's length prefix. For BaoGuoComponent / ObjectProperty in a chest
  BG actor the 8 bytes are `2e 73 00 01 00 f8 1a 03`. Standard UE has 9
  bytes minimum here (Size i32 + ArrayIndex i32 + HasGuid u8). The
  layout of the 8 bytes is **unknown** — no clean interpretation as
  Size/ArrayIndex/etc. has matched. Possibly variable-length, possibly
  packs the FName.Number that's missing from the FName itself.

### Object-path values are multi-piece, not single FStrings

This is the biggest surprise. The "value" of an ObjectProperty has a
4-byte length prefix that looks like an FString length, but the bytes
inside are NOT a single FString. They're a sequence of ASCII chunks
separated by binary markers, with the markers (presumably) encoding
back-references to a per-blob name pool.

Example: the BaoGuoComponent object path on a chest BG row encodes the
full path `/Game/AdditionMap01/Maps/DLC_Level01/DLC_Level01_Main.DLC_Level01_Main:PersistentLevel.BP_BGActor_JianZhu_RongQi_C_2142980989`
(125 chars) as a 142-byte block:

```
36 chars  /Game/AdditionMap01/Maps/DLC_Level01     ← package path (literal)
2 bytes   [0c 00]                                   ← marker
7 chars   l_Main.                                   ← partial map name
3 bytes   [11 00 b1]                                ← marker
11 chars  :Persistent                               ← partial outer
4 bytes   [17 00 fc 19]                             ← marker
40 chars  .BP_BGActor_JianZhu_RongQi_C_2142980989.  ← partial inner actor
7 bytes   [af 00 10 1c 92 00 bc]                    ← marker (also bridges into NEXT property)
12 chars  Script/WS.H                               ← (start of next property)
... etc.
```

The 142 literal characters from the source path become ~94 chars
written + ~31 chars "saved" by back-refs. The marker bytes vary
2–7 bytes long and mix low / high byte values. Some markers carry past
the "end" of one property into the next, so the length prefix at the
front isn't strictly a byte count of one property's value.

### Back-references are per-blob and include arbitrary strings

User-supplied: a chest renamed to "Aleena's Medicines" in-game gets
encoded as `[back-ref to Aleena]'s Medicines\0`. The literal bytes
written are just `27 73 20 4d 65 64 69 63 69 6e 65 73 00`
(`'s Medicines\0`) and the player's typed-in name "Aleena" — which was
emitted earlier in the same blob as the player persona — gets stitched
on by the back-ref.

This rules out a global "engine cooked name table" as the back-ref
source. The back-ref pool is **per-blob** and built up from full FNames
as they appear in occurrence order, including names the player types
in. The exact indexing scheme (whether the index is into FNames only or
also into ASCII fragments, whether multi-byte markers encode different
operations, etc.) is unsolved.

### What this means for decoding

Until the marker scheme is cracked, expect every property name beyond
the first two and every object-path-like value to be opaque. The
inventory codec works because it pattern-matches on byte signatures
inside the slot array region without needing to parse property tags;
that's why explicit slot counts decode but the per-slot
`CunDangShuXingJi` sub-stream doesn't.

## Inventory storage and owner relationships

Audited against the example `world.db` on 2026-05-14. Counts in
parentheses are rows in that DB.

The general pattern: **inventory storage rows and their owners live at
adjacent serials.** The game appears to spawn the inventory actor
first, then the owner, then link them — so they end up at allocated
serials N and N+1 in spawn order. There's no format-level invariant
that guarantees this; it's an emergent property of the spawn sequence
and breaks when actors are spawned out of band (or one half of a pair
has been destroyed).

Two storage-row classes cover the cases we've seen:

| Storage row | Paired-owner classes (in this DB) | Direction |
|---|---|---|
| `BP_BGActor_JianZhu_RongQi_C` (332) — building/workbench bag | Chests, workbenches, lighting, conveyors, animal pens, beds, etc. — anything in `JianZhu/`. Most common owners: `BP_GongZuoTai_JinShuXiang_C` (75), `BP_JianZhu_Lighting_LiShiHuoPen_C` (71), `BP_GongZuoTai_DaMuXiang_C` (44) | `owner_serial = bg_serial + 1` |
| `BP_BindBGCompActor_C` (1881) — pawn bag | Any pawn-like actor. In this DB: NPCs (sand bandits ~700, savage ~420, desert wolf ~417, exiles ~289, scouts ~47, bosses, elite, custom-gift NPCs); and the 5 player pawns (`BP_EgyptDLC_PlayerBase_F_C`, `BP_EgyptDLC_PlayerBase_M_C` — classed under `/NPC/Human/` in the game files) | `owner_serial = bg_serial + 1` |
| `BP_BindBGCompDongWu_C` (60) — animal/mount bag | Tribe boats (`BP_TribeBoat_*`), occasional ships, occasional tamed animals | `owner_serial = bg_serial ± 1` — mixed direction |

### The player case is a triple, not a pair

A player has *three* associated rows:

```
serial N      HPlayerState              actor_name = SteamID64
serial N+1    BP_BindBGCompActor_C      live runtime inventory bag (paired with the pawn below)
serial N+2    BP_EgyptDLC_PlayerBase_X_C   the player's pawn (X = F/M)
```

(The HPlayerState ↔ pawn distance varies. Player 18699's pawn is at
18701, but the other four player rows in this DB cluster at
22803–22806 with no nearby pawn — likely offline players whose pawn
isn't currently in the persisted world.)

Both `HPlayerState` and `BindBGCompActor` carry inventory data:

- **HPlayerState** has its own `DaoJuList → Entries` array at body
  offset ~303. The user's "copying a player row brought along the
  hotbar and some upper-inventory items" experiment confirmed this:
  copying just the HPlayerState row brings those items with it.
- **BindBGCompActor** is the runtime inventory bag, paired with the
  pawn. The bulk of the player's items live here, decoded the same way
  as any other pawn bag.

Which slots are mirrored on HPlayerState vs. owned only by
BindBGCompActor isn't yet understood. Best current guess: HPlayerState
caches what gets restored on respawn (hotbar + equipped + some quick
slots); BindBGCompActor holds everything that's "in the world" on the
pawn.

### Stale claims to ignore

Earlier versions of this doc said:

- "BindBGCompActor is paired with HPlayerState by Steam ID." Wrong.
  Zero of the 1881 BindBGCompActor rows have a Steam-ID `actor_name`,
  and zero of the 5 player rows match a BG actor by name. The
  Steam-ID branch in `findRelations` matches nothing in this DB; keep
  it as a defensive fallback or remove it.
- "BindBGCompActor is the NPC inventory bag." Too narrow. It's the
  pawn inventory bag — pawns happen to mostly be NPCs in this DB, but
  the player's pawn uses the same shape.
- "Player inventory lives on the player row." Half right. Some items
  are on HPlayerState's blob, but the live inventory is on the
  paired BindBGCompActor row at the pawn.

### Relationship reliability

Using the heuristic `owner_serial = bg_serial + 1` with a permissive
owner-class predicate (chests, workbenches, lighting, conveyors,
pawns, mounts, tribe boats):

- **2246 / 2443 (91.9%)** of BG-shaped rows resolve to an owner at
  `serial + 1`
- **34 (1.4%)** resolve to an owner at `serial - 1` (some are stored
  in the opposite direction)
- **163 (6.7%)** are orphans with no owner-shaped neighbor either way
  — chests in regions (only neighbor is a `BP_JianZhuPianQu_C`),
  building fragments, BG actors on tribe boats that aren't
  immediately adjacent

If you need this to be more robust than ~92%, the signal to chase is
probably the BG actor's `BaoGuoComponent` property, which is an
ObjectProperty holding the full path of the *parent* actor. The path
embeds the parent's instance ID, which would let us find the owner
directly by name lookup. We haven't decoded that ObjectProperty value
yet because the body format isn't fully cracked — but the FName
fragments are visible in the blob.

### BG-actor body shape

```
"BaoGuoComponent" (ObjectProperty) → object path of this BG actor itself
"DaoJuLis(t)"   → some metadata
"Entries"       → ArrayProperty<StructProperty<...>>
  [slot 0]
  [slot 1]
  ...
  [None terminator]
[24 bytes of 0xFF]   ← padding, purpose unknown
"Liang", "InM", "KuaiJieLan", "ZhuangBei", "RanLiao", "PeiFang",
"XiuLi", "ChengJi", "UpcomingItemDecayTime" (Double),
"LastUpdate" (FDateTime int64)  — the field that ticks on every save
```

The 24 0xFF bytes always appear regardless of how many slots are in the
array. Best guess: per-slot status-flag table reserved for up to ~24
slots. (Earlier versions of this doc said 23; counted again, it's 24.)

### Slot record layout

```
[SEP] (2 bytes)         item-class name-table index. Varies per item:
                          bandage    = d3 01
                          arrow      = dd 01
                          wood wall  = bc 01
                          hammer     = d3 01 (shared category w/ bandage)
                        Acts both as the in-record separator and as the
                        slot's class tag.

# Count property — OMITTED for slot 0 of the array (count lives in the
# nested CunDangShuXingJi sub-stream). On slot N>0:
[11 1f LOW]             1-byte count. The HIGH byte is "carried" from
                        whatever the previous 2-byte form set, starting
                        at the caller-provided seed (0 by default).
[11 2f LOW HIGH]        2-byte count (u16 LE). Also resets the running
                        high byte to HIGH for subsequent slots.

[SEP]

# Slot-index property — also omitted on slot 0 and on max-stack slots.
[15 1f IDX]             paired with 11 1f count
[14 1f IDX]             paired with 11 2f count
[3a 1f IDX]             implicit-max: no count property, count equals the
                        item-class max stack (which we don't have a lookup
                        for; decoder returns count = null).
                        Slot-idx tag's 2nd byte varies (1f, 13, ...) per
                        name-table position — accept any 3-byte chunk
                        and read byte 3 as the index.

[SEP]
[per-slot properties — the CunDangShuXingJi nested sub-stream]
[SEP]

[sentinel: 3 bytes]     7f ff 01 / 80 ff 01 / 80 ff 00 / 2b ff 01
[FGuid: 16 bytes]       the slot's unique instance ID
[SEP]                   slot terminator (re-used as the leading SEP of
                        the next slot — they're shared)
```

### Count encoding: descending-order + carry trick

The cleverest part of the format. Slots are typically stored in
**descending count order**. The parser carries a "current high byte"
across slots. A slot whose count fits in the current high range can use
the 1-byte `11 1f LOW` form (saves 1 byte). When the count drops below
the current 256-aligned boundary, a 2-byte `11 2f LOW HIGH` is written,
which resets the running high byte.

The decoder accepts a `carryHighSeed` for the running high byte at slot
0. The first 2B count in the stream resets it, so the seed only affects
1B counts that appear BEFORE any 2B count. We default to 0 (correct for
items that never exceed a 256-stack); callers that know the item class
can pass `max_stack >> 8` to decode at-max slots cleanly.

Worked example for the bandage TestBox with eight stacks `300, 299, 298,
256, 255, 128, 50, 19` (bandages have max stack 300, so seed `>>8` = 1):

| Slot | Stored as | Decoded count |
|---|---|---|
| 0 | (no count property — count lives in sub-stream) | unknown (= 300 if we knew the max stack) |
| 1 | `11 1f 2b` | `1 * 256 + 0x2b` = 299 |
| 2 | `11 1f 2a` | `1 * 256 + 0x2a` = 298 |
| 3 | `11 1f 00` | `1 * 256 + 0x00` = 256 |
| 4 | `11 2f ff 00` | `0 * 256 + 0xff` = 255 *(also resets carry to 0)* |
| 5 | `11 1f 80` | `0 * 256 + 0x80` = 128 |
| 6 | `11 1f 32` | `0 * 256 + 0x32` = 50 |
| 7 | `11 1f 13` | `0 * 256 + 0x13` = 19 |

Across the 2,810 slots in the sample database, the form distribution was:

- 1B count: 1289 (46%)
- 3a 1f implicit-max: 803 (29%) — decoder reports null
- implicit-first (slot 0): 664 (24%) — decoder reports null
- 2B count: 54 (2%)

**Roughly half of slots can't have their count surfaced today.** That's
the limit of what's possible without either (a) cracking the per-slot
sub-stream so slot 0's `Amount` property decodes, or (b) a static per-item
max-stack lookup so `3a 1f` slots can be filled in.

### What an empty inventory looks like

The slot array shrinks (bytes really go away, not zeroed in place):

```
Entries\0 ... ArrayProperty header ... 05 00 00 00 4e 6f 6e 65 00  ← "None\0" terminator
[24 bytes of 0xFF]
... rest of BG actor properties (Liang / InM / KuaiJieLan / ...)
```

A full → empty transition removes ~50 bytes per slot from the blob.

### Adding to a stack vs. splitting

When the user adds N items to an existing stack: the slot's count byte
changes in place, plus ~5 bytes are inserted nearby (probably an access-
log entry). When the user splits 1 off a max stack into a new slot:

1. The source slot transitions from implicit-max to explicit count
   (its 2-byte name-table marker changes — `3a 1f → 15 1f` or similar)
2. A new slot record is appended, 35–43 bytes long depending on whether
   a fresh actor instance ID is minted

## The CunDangShuXingJi sub-stream (per-slot properties)

The "instance metadata" region of each slot is a nested property stream
named **`CunDangShuXingJi`** (= 存档属性集, "saved properties set"). For a
steel hammer it contains:

| Property name | Type | Notes |
|---|---|---|
| `bName` | bool | is the item user-renamed? |
| `DamageDec` (DamageDecay) | FloatProperty | damage reduction |
| `Value` | FloatProperty | |
| `qaoZuoFuh` (CaoZuoFuhao?) | Int | operation mode flag |
| `LaiYuan` (来源) | Int | source/origin (where the item came from) |
| `lockWeakenTenacityDefense` | Float | combat stat |
| `IncAgainstDun` (IncAgainstDungeon?) | Float | |
| `HasXiuLiCount` (有修理次数) | bool/int | times the item has been repaired |
| `Uid` | int | |
| `Guid` | **FGuid** (16 bytes) | the instance GUID we kept finding at the end of each slot — this is where it's declared |
| `GIndex` | int | |
| `PinZhi` (品质) | ByteProperty enum `::EDJPZ...` | item quality enum |
| `NaiJiuDu` (耐久度) | u16 LE | current durability — **plain u16 LE, no carry trick** |
| `NaiJiuDuMax` | u16 LE | max durability |

For stackable items like bandages and arrows, the sub-stream is mostly
empty/small. For unique items with state (weapons, tools, armor with
durability), it's larger and contains the full saved state.

**Slot 0's count is also stored in this sub-stream** (probably as an
`Amount`/`数量` property) which is why slot 0 has no top-level count tag.
We see `mount\0` in the dump — likely `[backref-to-A]mount`.

Until the back-reference scheme is solved, the entire sub-stream is
read-only / opaque to the decoder.

## What's still unknown

| Item | Notes |
|---|---|
| Back-reference scheme | Confirmed per-blob pool (Aleena evidence). Markers vary 2–7 bytes long. Index encoding inside the marker is unsolved. Cracking this unlocks the rest of the format. Best path forward: controlled in-game experiments (see "Suggested next steps"). |
| The 8-byte property tag tail | Between Type FName and value length prefix every property has 8 unknown bytes (e.g. `2e 73 00 01 00 f8 1a 03` for an ObjectProperty). No clean i32+i32+u8 interpretation matches. Likely packs Size + ArrayIndex + flags + maybe FName.Number for the Name FName. |
| Multi-piece value structure | Object-path values aren't single FStrings — they're sequences of ASCII chunks with markers. The marker bytes also bridge into adjacent properties, so the "length prefix" isn't strictly a byte count of one property's value. |
| Slot 0 explicit count | Lives inside the CunDangShuXingJi sub-stream as an `Amount` property. Decodable once back-ref FString parsing works. |
| Item-class max-stack | Not in `world.db`. Probably defined in game-content tables (`.uasset` files). A small static table for the common cases (bandage 300, arrow 600, wall 100, hammer 1, etc.) would unlock the `3a 1f` slots; could also be inferred from observed `11 2f` resets across a player's history. |
| Decoding player-on-row inventory | The player blob's `DaoJuList → Entries` array IS the player's inventory. The current decoder finds it (one `Entries\0` at body offset ~303) but produces false-positive slots — the byte-pattern heuristics aren't tight enough for the player blob. Needs the player slot record shape verified end-to-end. |
| The 6.7% orphan rate | 163 BG-actor rows in the example DB have no owner-shaped neighbor at `serial ± 1`. Most are chest BG rows in regions; a few are `BP_BindBGCompDongWu_C` on tribe boats. A better link signal than adjacent-serial would handle these. |
| `headerWord1` | Varies per save, loosely correlates with body size. Best guess: a sequence number or rolling hash. |
| Pre-hash sentinel variants | `7f ff 01`, `80 ff 01`, `80 ff 00`, `2b ff 01`. Why they vary per slot is unclear — they don't track count high byte cleanly. Probably encodes per-slot flags (durability flag? newly-created flag?). |
| Crafting-queue formats | Workstation actors (`BP_BGActor_XiuLiTai_C`, `BP_BGActor_ChaiJieTai_C`, `BP_BGActor_GaoKeJi_C`) have 0% decode rate — they use a different storage shape we haven't analyzed. |
| The 24-byte `0xFF` padding | Always 24 bytes after the `Entries` array's `None` terminator, regardless of slot count. Maybe a per-slot flags bitmap reserved for ~24 slots. |

## How to reproduce / verify

The differential-RE workflow that produced the slot decoder:

1. Load a save in-game, stop in a controlled state.
2. Save → `world_mannual_1.db`.
3. Make ONE small, well-known change (e.g., take exactly 7 of an item).
4. Save → `world_mannual_2.db`.
5. `python soulmaskdiff.py world_mannual_1.db world_mannual_2.db --ignore-time`

`soulmaskdiff.py` shows byte-level diffs with the nearest preceding FName
as context, which makes it possible to spot "this byte represents that
quantity" from a clean experiment.

The cleanest experiment for cracking new fields is a **dedicated test
box** with only the item type of interest and known stack counts.

## Repo files

| File | Purpose |
|---|---|
| `js/codec-unreal-properties.js` | Generic FArchive primitives (Cursor, Writer, property tag read/write). Pass-through encode — the body isn't decoded. |
| `js/codec-inventory.js` | Inventory slot decoder. Detects, parses slot array, exposes `{slots, notes}`. Returns `count: null` for slots whose count we can't determine. |
| `js/classify.js` | `findRelations()` resolves parent/child links between owner rows and BG-actor rows (heuristic). |
| `js/partials.js` | `RelatedRows` and `Inventory` section partials for the detail panel. |
| `decode_inventory.py` | Python prototype of the slot decoder. |
| `analyze_blobs.py`, `analyze_strings.py` | Early-stage analysis (FName extraction, entropy, hexdumps). |
| `mine_backrefs.py` | Pattern miner: catalogs ASCII fragments + leading bytes in a blob, cross-matches against full FNames to look for back-ref scheme. |
| `decode_one_property.py` | Dumps the bytes of one specific property end-to-end with a structural breakdown (ASCII runs vs. marker bytes). Useful for staring at one property at a time. |
| `soulmaskdiff.py` | The diff tool that cracked the slot shape. |
| `investigate.py` | Per-type FName context dump. |
| `blob_analysis/` | Saved blob snapshots used during reverse-engineering. |

## Handoff: suggested next steps

### Controlled experiments to run when Soulmask is available

The fastest path to cracking the back-reference scheme is targeted
in-game experiments that produce diffable blobs. For each:

1. Set up the controlled state in-game.
2. Save → `world_mannual_1.db`.
3. Make ONE specific change.
4. Save → `world_mannual_2.db`.
5. `python soulmaskdiff.py world_mannual_1.db world_mannual_2.db --ignore-time`
6. `python decode_one_property.py <serial>` on the changed row to see
   the structural breakdown.

Experiments in priority order:

1. **Chest rename — first occurrence.** Place a chest with a default
   name. Save. Rename it to a short distinctive string like `XYZZY`.
   Save again. Diff. We'd see how a NEW string (not already in the
   name pool) gets first-emitted, which gives us the "introduce a new
   pool entry" encoding.

2. **Chest rename — back-ref to existing.** Rename the chest to
   `Aleena1` (using your already-emitted player name "Aleena"). Save.
   Compare against the same chest renamed to `XYZZY1`. The "Aleena1"
   case should show a back-ref byte where the "XYZZY1" case has full
   literal bytes. The difference is the back-ref encoding for that
   specific pool index.

3. **Chest rename — back-ref to specific index.** Rename to just
   `Aleena` (no suffix). The marker bytes alone should encode the
   back-ref to "Aleena" with zero literal append. Comparing the marker
   bytes between this experiment and the chest-rename `Aleena1`
   experiment isolates "the back-ref index for Aleena" vs. "the
   append-1 instruction."

4. **Item rename in a slot.** Pick an item in inventory, give it a
   custom name like `Aleena's Sword`. Save. We'd see the same back-ref
   pattern inside the `CunDangShuXingJi` sub-stream, which is what's
   needed to crack per-slot properties.

5. **Same chest, different player-name worlds.** If we run experiment
   #2 in one world and again in another world where the player is
   named `Bob` instead of `Aleena`, the marker bytes should
   *change* (because the pool index of "the player's name" differs).
   This confirms the back-ref index is per-blob, not global.

### Open lines of inquiry (no game needed)

1. **The 8-byte property tag tail.** Same blob, look at the bytes
   between `Type FName end` and `value length prefix` for many
   different property types. The pattern of which bytes vary by
   type might give away the layout.

2. **Decode the property tag tail by brute force.** Try every plausible
   field-width combo (Size i32 / i16 / packed, with / without HasGuid,
   etc.) and see which produces a Size value that matches the actual
   value byte count across many properties.

3. **Item-class max-stack table.** Build a small static lookup of
   the common items (bandage 300, arrow 600, wall 100, hammer 1, ...)
   so `3a 1f` slots can be filled in.

4. **Crafting-queue format.** Workstation rows
   (`BP_BGActor_XiuLiTai_C`, `BP_BGActor_ChaiJieTai_C`,
   `BP_BGActor_GaoKeJi_C`) use a different storage shape. Same diff
   methodology should crack it once back-refs are in.
