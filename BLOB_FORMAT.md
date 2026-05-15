# Soulmask Blob Format Notes

## Storage Layer

Soulmask saves are SQLite databases (`world.db`, `account.db`). Actors are stored in `actor_table`, with binary blob data in the `actor_data` column.

**Database schema (actor_table):**

| Column | Type | Description |
|--------|------|-------------|
| `actor_serial` | int32 | Primary key |
| `server_id` | int32 | Server identifier |
| `data_version` | int32 | Negative of DataVersion (e.g. -2) |
| `actor_name` | string | Actor name/identifier |
| `actor_level` | string | Level name |
| `actor_script` | string | Blueprint class path |
| `actor_owner` | string | Owner identifier |
| `actor_transf` | string | Transform string |
| `actor_data` | BLOB | Compressed blob data |
| `actor_time` | datetime | Timestamp |

---

## Blob Structure (`actor_data`)

**Header (8 bytes) + LZ4-compressed payload:**

```
[Offset 0-3]  int32   DataVersion      (currently 2)
[Offset 4-7]  int32   DecompressedSize (size after decompression)
[Offset 8+]   bytes   Raw LZ4-compressed data
```

> Note: `actor_version` in the database stores the *negative* of DataVersion, so a normal blob has `actor_version = -2`.

**Compression:** Raw LZ4 via `K4os.Compression.LZ4` (`LZ4Codec.Encode` / `LZ4Codec.Decode`). This is *not* the LZ4 framing format.

---

## Special Cases

### Double-Compression Bug (version -131074)

Some actors were compressed twice due to a game server version mismatch. These have `actor_version = -131074`. The `--fix-double-compress` action detects and fixes these by decompressing once and re-saving with the correct version (-2).

### GAME_SETTINGS Actor

Not compressed. Stored raw in the blob and handled separately from regular actors using a dedicated `GameSettings` class.

---

## Decompressed Payload (Property List)

After decompression, the data is an Unreal Engine property list:

```
[int32]       DataVersion = 2
[FPropertyTag list]         -- zero or more property tags, read until name == "None"
[FString]     "None"        -- list terminator
[int32]       0x00000000    -- optional null terminator
```

---

## UE Save File Header (GVAS)

The top-level save file format (`.sav` files, before SQLite wrapping) uses the standard Unreal Engine GVAS format.

**Magic:** `0x53415647` — ASCII `"SAVG"` (reads as `"GVAS"` in little-endian)

**Header layout:**

1. `SaveGameVersion` (int32)
   - `1` = InitialVersion
   - `2` = AddedCustomVersions
   - `3` = PackageFileSummaryVersionChange
2. `PackageVersionUE4` (uint32)
3. `PackageVersionUE5` (uint32) — only if SaveGameVersion >= 3
4. EngineVersion struct (variable size)
5. CustomFormatData:
   - `Version` (int32)
   - `Count` (uint32)
   - `Count` × { 16-byte GUID + int32 value }
6. SaveClass name (FString)
7. Property list

---

## FString Serialization

Used for all strings throughout the format.

```
[int32] Length
```

| Length value | Meaning |
|-------------|---------|
| `0` | Null string — no further bytes |
| `1` | Empty string — 1 null terminator byte follows |
| `> 0` | ASCII string — `Length` bytes including null terminator |
| `< 0` | UTF-16 string — `-Length` chars × 2 bytes including null terminator |

---

## FPropertyTag Layout (UE4 Format)

Soulmask uses **UE4 format** (`VER_UE4_CORRECT_LICENSEE_FLAG`).

Each tag contains (in order):

1. **Property Name** (FString)
2. **Property Type Name** (FPropertyTypeName — see below)
3. **Size** (int32) — byte size of the value; written as placeholder and filled in after the value is serialized
4. **Array Index** (int32) — UE4 only; index if part of an array
5. **Type-specific header** — varies by type (e.g. StructProperty adds struct name FString + 16-byte GUID)
6. **Bool value** (byte) — BoolProperty only; `0` or `1`

### UE5 Differences (not active for Soulmask, but supported by the lib)

In UE5 format, step 4 is replaced by a flags byte and optional fields:

- **Flags byte:**
  - `0x01` HasArrayIndex
  - `0x02` HasPropertyGuid
  - `0x04` HasPropertyExtensions
  - `0x08` HasBinaryOrNativeSerialize
  - `0x10` BoolTrue (bool value encoded here instead of separate byte)
  - `0x20` SkippedSerialize
- **Optional Array Index** (int32) — if HasArrayIndex flag set
- Bool value is encoded in the BoolTrue flag, not a separate byte

---

## FPropertyTypeName

```
[FString]  TypeName         (e.g. "IntProperty", "ArrayProperty", "StructProperty")
[int32]    ParameterCount   -- UE5+ only
  [recursive FPropertyTypeName] × ParameterCount
```

---

## Property Value Formats

### Primitive Types

| Type | Size | Format |
|------|------|--------|
| `BoolProperty` | 1 byte (UE4) | `0` or `1`; UE5 uses BoolTrue flag |
| `ByteProperty` | 1 byte | Raw byte |
| `IntProperty` | 4 bytes | int32 |
| `Int64Property` | 8 bytes | int64 |
| `FloatProperty` | 4 bytes | IEEE 754 float |
| `DoubleProperty` | 8 bytes | IEEE 754 double |
| `UInt32Property` | 4 bytes | uint32 |
| `UInt64Property` | 8 bytes | uint64 |

### String Types

| Type | Format |
|------|--------|
| `StrProperty` | FString |
| `NameProperty` | FString |
| `TextProperty` | Complex — culture info + source text |

### Container Types

**ArrayProperty:**
```
[int32]  Count
[value]  × Count elements of ItemType
```
UE4 struct arrays include a prototype tag before the element data.

**SetProperty:**
```
[int32]  Count
[value]  × Count elements
```

**MapProperty:**
```
[int32]  ModifiedCount  (usually 0)
[int32]  Count
[key][value] × Count pairs
```

### Struct Types

**StructProperty header (UE4):**
```
[FString]   StructName
[16 bytes]  GUID
```
Data follows as either a nested property list or raw binary struct data.

### Reference Types

| Type | Notes |
|------|-------|
| `ObjectProperty` | Soulmask-specific `WSObjectProperty` |
| `SoftObjectProperty` | Soft object path reference |
| `MulticastDelegateProperty` | Array of delegate bindings |
| `MulticastInlineDelegateProperty` | Inline variant |

---

## Key Code Locations

| Concern | File |
|---------|------|
| Blob compress / decompress | `EditSoulmaskSave/ActorDataUtil.cs` |
| LZ4 helpers | `EditSoulmaskSave/CompressionUtil.cs` |
| Property read / write | `UeSaveGame/PropertySerializationHelper.cs` |
| Save file header (GVAS) | `UeSaveGame/SaveGame.cs` |
| Double-compress fix | `EditSoulmaskSave/Actions/FixDoubleCompressProgramAction.cs` |
