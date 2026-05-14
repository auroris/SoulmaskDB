# Soulmask `actor_data` blob format

Status as of 2026-05-14: header + inventory slot array decoded; remaining
work is the nested per-slot property sub-stream and the back-reference
FString convention used inside it.

## Where the format lives

Every row in `actor_table.actor_data` holds a binary blob that describes
one UE actor's persisted state. Three kinds:

| Detection | Codec | Status |
|---|---|---|
| First 4 bytes are length prefix matching JSON-looking text | `codec-json.js` | fully decoded, round-trip safe |
| First 4 bytes = `02 00 00 00` (version tag) | `codec-unreal-properties.js` | header decoded, body partial |
| BG-actor variant of the above with an `Entries` slot array | `codec-inventory.js` | slot array decoded |

The unreal-properties codec is the catch-all. The inventory codec is a
specialization that runs on top of unreal-properties bodies whose body
contains the literal substring `"Entries\0"` (the property name for the
slot array).

## File layout

```
[14-byte header]
  u32  versionTag    always 0x00000002
  u32  headerWord1   varies — loosely correlates with body size,
                     possibly a save-sequence number or checksum
  u32  headerWord2   varies, but always matches the pattern `?? ?? 02 00`
                     (i.e. the top half is `0x0002`, the bottom half
                     varies). 61 distinct values seen across one 12k-row
                     DB; identical pairs of saves of the same world tend
                     to repeat one value. Likely a per-row FCustomVersion
                     tag or class-instance-specific hash.
  u16  headerExtra   always 0

[body]  uncompressed FArchive-style property stream
```

**Body is NOT compressed.** We exhaustively tested zlib (at every offset
including each `78 01` near-magic byte hit), LZ4 frame, LZ4 block, and
zstd. All failed. The entropy is ~6.87 bits/byte and the literal strings
`ZhuRenGuid`, `StructProperty`, `BaoGuoComponent` etc. appear in plain
ASCII inside the body. The `XX 00` frequency histogram is also nearly identical between two
saves of the *same* world (e.g. `0x15 00` appears 395 times in both),
which would not be possible if the body were the compressed output of
two different inputs.

## Property serialization

Soulmask uses a variant of UE's `FObjectAndNameAsStringProxyArchive` where:

- The **first** time an FName / FString appears in the blob, it's written
  as the standard `[i32 length][bytes][\0]` form.
- **Subsequent** mentions of the same name are written as a 2-byte index
  into an implicit per-blob name table built in occurrence order.

We see this in the body almost everywhere:

```
0x0e:  0b 00 00 00 5a 68 75 52 65 6e 47 75 69 64 00     ← FName "ZhuRenGuid" written in full (length 11)
0x1d:  0f 00 00 00 53 74 72 75 63 74 50 72 6f 70 65 72  ← FName "StructProperty" written in full
       74 79 00
...
0x82c: 7f 44 69 73 70 6c 61 79                          ← partial "Display" preceded by `7f` index byte
0x822: 27 73 20 4d 65 64 69 63 69 6e 65 73 00           ← "'s Medicines" — the player-set chest name
                                                          encoded as `[backref to "Aleena"]'s Medicines`
```

The full back-reference scheme is not yet cracked. Once it is, every
named property surfaces clearly; until then, decoders see lots of strings
fragmented across non-ASCII control bytes (e.g. `JNone` for "None",
`2tor` for "Actor", `mount` for "Amount").

## Inventory slot array

Lives in BG-actor sibling rows, not in the visible chest/player row:

| Owner row | Inventory storage row | Relationship |
|---|---|---|
| `BP_GongZuoTai_*` (chest/workbench) | `BP_BGActor_JianZhu_RongQi_C` or `BP_BGActor_GongZuoTai_C` | adjacent serials: `bg_serial = owner_serial - 1` |
| `HPlayerState` | `BP_BindBGCompActor_C` | by Steam ID: same `actor_name` |
| Animal-class blueprints | `BP_BindBGCompDongWu_C` | adjacent serials |

The BG-actor blob body looks like:

```
"BaoGuoComponent" (ObjectProperty) → object path of this BG actor itself
"DaoJuLis(t)" → some metadata
"Entries"     → ArrayProperty<StructProperty<...>>
  [slot 0]
  [slot 1]
  ...
  [None terminator]
"Liang", "InM", "KuaiJieLan", "ZhuangBei", "RanLiao", "PeiFang",
"XiuLi", "ChengJi", "UpcomingItemDecayTime" (Double),
"LastUpdate" (FDateTime int64)  — the field that ticks on every save
```

23 bytes of `0xFF` padding follow the `None` terminator regardless of how
many slots are in the array. Best guess: per-slot status flags table for
up to ~24 slots.

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
                        at (max_stack >> 8) for slot 0.
[11 2f LOW HIGH]        2-byte count (u16 LE). Also resets the running
                        high byte to HIGH for subsequent slots.

[SEP]

# Slot-index property — also omitted on slot 0 and on max-stack slots.
[15 1f IDX]             paired with 11 1f count
[14 1f IDX]             paired with 11 2f count
[3a 1f IDX]             implicit-max: no count property, count = max_stack
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
across slots, initialized to `(max_stack >> 8)`. A slot whose count fits
in the current high range can use the 1-byte `11 1f LOW` form
(saves 1 byte). When the count drops below the current 256-aligned
boundary, a 2-byte `11 2f LOW HIGH` is written, which resets the running
high byte.

Worked example for the bandage TestBox with eight stacks `300, 299, 298,
256, 255, 128, 50, 19` (bandages have `max_stack = 300`):

| Slot | Stored as | Decoded count |
|---|---|---|
| 0 | (no count property — implicit-first) | 300 (= max stack) |
| 1 | `11 1f 2b` | `1 * 256 + 0x2b` = 299 |
| 2 | `11 1f 2a` | `1 * 256 + 0x2a` = 298 |
| 3 | `11 1f 00` | `1 * 256 + 0x00` = 256 |
| 4 | `11 2f ff 00` | `0 * 256 + 0xff` = 255 *(also resets carry to 0)* |
| 5 | `11 1f 80` | `0 * 256 + 0x80` = 128 |
| 6 | `11 1f 32` | `0 * 256 + 0x32` = 50 |
| 7 | `11 1f 13` | `0 * 256 + 0x13` = 19 |

A typical bandage inventory of 8 stacks needs **one** 2-byte count entry
total, regardless of how many stacks are at-max — the 1B form pays for
itself everywhere else.

For real inventories that aren't sorted (the user can rearrange freely),
the format pays the 2B cost more often. Across the 2,810 slots in the
sample database, the distribution was:

- 1B count: 1289 (46%)
- 3a 1f implicit-max: 803 (29%)
- implicit-first: 664 (24%) — one per non-empty inventory
- 2B count: 54 (2%)

### What an empty inventory looks like

The slot array shrinks (the bytes really go away, not zeroed in place):

```
Entries\0 ... ArrayProperty header ... 05 00 00 00 4e 6f 6e 65 00  ← "None\0" terminator
[23 bytes of 0xFF padding]
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

**Durability is stored as raw u16 LE**, not using the count's
descending-carry trick. That's the right call — durability isn't sorted
across slots, so a sort-dependent compression wouldn't pay off.

Slot 0's count is also stored in this sub-stream (probably as an
`Amount`/`数量` property) which is why slot 0 has no top-level count tag.
We see `mount\0` in the dump — likely `[backref-to-A]mount`.

## What's still unknown

| Item | Notes |
|---|---|
| Back-reference FString convention | The mechanism that turns `mount\0` into "Amount", `JNone\0` into "None", `2tor\0` into "Actor". Likely a per-blob name table built in occurrence order, with a 2-byte index for back-refs. Cracking this unlocks the rest of the format. |
| Slot 0 explicit count | Lives inside the CunDangShuXingJi sub-stream as an Amount property. Decodable once back-ref FString parsing works. |
| Item-class max-stack | Hardcoded to 300 in `decode_inventory.py` and `codec-inventory.js`. Real max-stack varies per item (300 bandages, 600 arrows, 100 walls, 1 hammers). Probably defined in game-content tables (`.uasset` files), not in `world.db`. Could be inferred from observed counts but that's not robust. |
| `headerWord1` | Varies per save, loosely correlates with body size. Best guess: a sequence number or rolling hash. |
| Pre-hash sentinel variants | `7f ff 01`, `80 ff 01`, `80 ff 00`, `2b ff 01`. Why they vary per slot is unclear — they don't track count high byte cleanly. Probably encodes per-slot flags (durability flag? newly-created flag?). |
| Crafting-queue formats | Workstation actors (`BP_BGActor_XiuLiTai_C`, `BP_BGActor_ChaiJieTai_C`, `BP_BGActor_GaoKeJi_C`) have 0% decode rate — they use a different storage shape we haven't analyzed. |
| The 23-byte `0xFF` padding | Always 23 bytes after the `Entries` array's `None` terminator, regardless of slot count. Maybe a per-slot flags bitmap reserved for up to ~24 slots. |

## How to reproduce / verify

The differential-RE workflow that cracked the format:

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
| `js/codec-unreal-properties.js` | Generic FArchive primitives (Cursor, Writer, property tag read/write). Pass-through encode for now since body isn't fully decoded. |
| `js/codec-inventory.js` | Inventory slot decoder. Detects, parses slot array, exposes `{slots, notes}`. |
| `js/classify.js` | `findRelations()` resolves parent/child links between owner rows and BG-actor rows. |
| `js/partials.js` | `RelatedRows` and `Inventory` section partials for the detail panel. |
| `decode_inventory.py` | Python prototype of the slot decoder. |
| `analyze_blobs.py`, `analyze_strings.py` | Early-stage analysis (FName extraction, entropy, hexdumps). |
| `soulmaskdiff.py` | The diff tool that cracked it. |
| `investigate.py` | Per-type FName context dump. |
| `blob_analysis/` | Saved blob snapshots used during reverse-engineering. |

## Handoff: suggested next steps

In rough order of payoff:

1. **Back-reference FString parser** — single biggest unlock. Once
   strings parse cleanly, the CunDangShuXingJi sub-stream becomes
   readable, which gives us:
   - Slot 0 count (via Amount property)
   - Durability + max durability for tools/weapons
   - Item quality
   - All other per-slot state

2. **Item-class max-stack lookup** — the decoder still uses a hardcoded
   `300`. Either build a small static table of known maxes (bandage 300,
   arrow 600, wall 100, hammer 1, etc.) or extract from game content. A
   static table is fine for the common cases.

3. **Display item names in the inventory partial** — the per-slot
   `instance_meta` text contains the item-class blueprint name (e.g.
   `Ship_Deck_Wall1`, `_WuQi/Gong/...Rhui_6`). Surface those alongside
   the GUID and count so the UI shows "297 × Simple Bandage" instead of
   just "count=297".

4. **Crafting-queue format** for `BP_BGActor_XiuLiTai_C`,
   `BP_BGActor_ChaiJieTai_C`, etc. — different storage shape (input
   slots + output slots + progress timer + recipe ref). Same diff
   methodology should crack it.

5. **Header word1 semantics** — would clarify whether saves can be
   identified / ordered without parsing the body.
