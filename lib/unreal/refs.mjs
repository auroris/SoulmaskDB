/**
 * collectGuids(decoded) — walk a decoded blob and return every Guid
 * struct value encountered, paired with the property path it was found
 * at.
 *
 * Shared between two callsites today:
 *   - `lib/workers/decode-worker.mjs::extractManifest` populates the
 *     per-row manifest's `references` field with
 *     `[{kind:'guid', guid, path}]` entries built from this output.
 *   - `scripts/find-guid-refs.mjs` uses it directly to build the
 *     offline cross-reference table.
 *
 * The output keeps the property path that `collectStrings`
 * (lib/unreal/strings.mjs) throws away when it flattens everything
 * into a single haystack. A future `ReferencesService` on the main
 * thread pairs these with each row's `SelfUid` to build a
 * bidirectional GUID index without re-decoding blobs.
 *
 * Output shape per entry: { path, guid }
 *   path  — same syntax as collectStrings (PropName.SubField[i].key, …)
 *   guid  — canonical uppercase 8-4-4-4-12 hex string
 *
 * The zero-GUID `00000000-0000-0000-0000-000000000000` is filtered
 * out: it's the "unset" sentinel and would otherwise dominate every
 * cross-reference index with thousands of meaningless matches.
 */

import { FName } from './primitives.mjs';
import { StructValue } from './structs.mjs';
import { ObjectRef, SoftObjectRef } from './values.mjs';
import { ArrayValue, SetValue, MapValue } from './properties.mjs';

const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

export function collectGuids(decoded) {
  if (!decoded) return [];
  const out = [];
  if (decoded.kind === 'unreal-properties') {
    walkProps(decoded.properties, '', out);
  }
  return out;
}

function walkProps(properties, prefix, out) {
  if (!Array.isArray(properties)) return;
  for (const p of properties) {
    const name = p?.tag?.name?.value;
    if (typeof name !== 'string') continue;
    const childPath = prefix ? `${prefix}.${name}` : name;
    walkValue(p.value, childPath, out);
  }
}

function walkValue(value, path, out) {
  if (value == null) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return;
  if (value instanceof FName) return;
  if (value instanceof ObjectRef) {
    if (Array.isArray(value.embedded)) walkProps(value.embedded, path, out);
    return;
  }
  if (value instanceof SoftObjectRef) return;
  if (value instanceof StructValue) {
    if (value.structName === 'Guid' && typeof value.value === 'string' && value.value.length > 0) {
      if (value.value !== ZERO_GUID) out.push({ path, guid: value.value });
      return;
    }
    if (Array.isArray(value.value)) walkProps(value.value, path, out);
    return;
  }
  if (value instanceof ArrayValue || value instanceof SetValue) {
    for (let i = 0; i < value.elements.length; i++) {
      walkValue(value.elements[i], `${path}[${i}]`, out);
    }
    return;
  }
  if (value instanceof MapValue) {
    for (let i = 0; i < value.entries.length; i++) {
      walkValue(value.entries[i].key,   `${path}[${i}].key`,   out);
      walkValue(value.entries[i].value, `${path}[${i}].value`, out);
    }
    return;
  }
}
