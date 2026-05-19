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

// ObjectRef paths that point at an actor INSTANCE (rather than a class
// blueprint asset) end with `_C_<digits>` — the trailing decimal is the
// engine's per-instance ID. Class references like
// `/Game/.../BP_Foo.BP_Foo_C` lack the trailing `_<digits>` and don't
// resolve to anything in actor_table, so we skip them when emitting
// cross-row reference candidates.
const ACTOR_INSTANCE_RE = /_C_\d+$/;

export function collectGuids(decoded) {
  if (!decoded) return [];
  const out = [];
  if (decoded.kind === 'unreal-properties') {
    walkProps(decoded.properties, '', { guids: out, objRefs: null });
  }
  return out;
}

/**
 * Emit every ObjectRef value whose `path` looks like an actor instance
 * (`/Game/.../BP_FooBar_C_2143004545`). Returns `[{path, targetPath}]`
 * where `path` is the property path where the reference lives and
 * `targetPath` is the full Unreal path of the referenced actor — which
 * equals the target row's `actor_name` in `actor_table`. Class-blueprint
 * references (no trailing `_<digits>`) are filtered out. Mirrors the
 * shape of `collectGuids` so a sibling index in ReferencesService can
 * absorb both with the same lifecycle.
 */
export function collectObjRefs(decoded) {
  if (!decoded) return [];
  const out = [];
  if (decoded.kind === 'unreal-properties') {
    walkProps(decoded.properties, '', { guids: null, objRefs: out });
  }
  return out;
}

function walkProps(properties, prefix, sinks) {
  if (!Array.isArray(properties)) return;
  for (const p of properties) {
    const name = p?.tag?.name?.value;
    if (typeof name !== 'string') continue;
    const childPath = prefix ? `${prefix}.${name}` : name;
    walkValue(p.value, childPath, sinks);
  }
}

function walkValue(value, path, sinks) {
  if (value == null) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return;
  if (value instanceof FName) return;
  if (value instanceof ObjectRef) {
    if (sinks.objRefs && typeof value.path === 'string' && ACTOR_INSTANCE_RE.test(value.path)) {
      sinks.objRefs.push({ path, targetPath: value.path });
    }
    if (Array.isArray(value.embedded)) walkProps(value.embedded, path, sinks);
    return;
  }
  if (value instanceof SoftObjectRef) return;
  if (value instanceof StructValue) {
    if (value.structName === 'Guid' && typeof value.value === 'string' && value.value.length > 0) {
      if (sinks.guids && value.value !== ZERO_GUID) sinks.guids.push({ path, guid: value.value });
      return;
    }
    if (Array.isArray(value.value)) walkProps(value.value, path, sinks);
    return;
  }
  if (value instanceof ArrayValue || value instanceof SetValue) {
    for (let i = 0; i < value.elements.length; i++) {
      walkValue(value.elements[i], `${path}[${i}]`, sinks);
    }
    return;
  }
  if (value instanceof MapValue) {
    for (let i = 0; i < value.entries.length; i++) {
      walkValue(value.entries[i].key,   `${path}[${i}].key`,   sinks);
      walkValue(value.entries[i].value, `${path}[${i}].value`, sinks);
    }
    return;
  }
}
