/**
 * collectStrings(decoded) — walk a decoded blob and return every string
 * value found, paired with a path describing where in the property tree
 * it lives.
 *
 * Used by the worker pool to build the per-row search index. The OLD
 * `extractBlobText` in app.js scanned the RAW LZ4-compressed bytes for
 * printable-ASCII runs, which mostly matched random byte coincidences in
 * the compressed payload. This walker runs after decode/decompress and
 * therefore returns the actual strings the game wrote.
 *
 * Output shape per entry: { path, value }
 *   path   — informational, describes which field contains the match
 *   value  — raw string content (caller lowercases when building a haystack)
 *
 * Path syntax:
 *   PropName                  top-level property
 *   PropName.SubField         struct field
 *   PropName[i]               array / set element
 *   PropName[i].key           map entry key
 *   PropName[i].value         map entry value
 *   PropName.class            ObjectRef.classPath alongside its .path
 *   PropName.sub              SoftObjectRef.subPath alongside its .assetPath
 *
 * Empty strings are skipped (they'd just bloat the index without aiding
 * substring search).
 */

import { FName } from './primitives.mjs';
import { StructValue } from './structs.mjs';
import { ObjectRef, SoftObjectRef } from './values.mjs';
import { ArrayValue, SetValue, MapValue } from './properties.mjs';

export function collectStrings(decoded) {
  if (!decoded) return [];
  const out = [];
  if (decoded.kind === 'unreal-properties') {
    collectFromPropertyArray(decoded.properties, '', out);
  } else if (decoded.kind === 'json-wrapped') {
    if (decoded.parsed != null) {
      collectFromJson(decoded.parsed, '', out);
    } else if (typeof decoded.text === 'string' && decoded.text.length > 0) {
      // parseError fallback: keep the raw text so the row is still searchable.
      out.push({ path: '', value: decoded.text });
    }
  }
  return out;
}

function collectFromPropertyArray(properties, prefix, out) {
  if (!Array.isArray(properties)) return;
  for (const p of properties) {
    const name = p?.tag?.name?.value;
    if (typeof name !== 'string') continue;
    const path = prefix ? `${prefix}.${name}` : name;
    collectFromValue(p.value, path, out);
  }
}

function collectFromValue(value, path, out) {
  if (value == null) return;
  if (typeof value === 'string') {
    if (value.length > 0) out.push({ path, value });
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return;
  if (value instanceof FName) {
    if (typeof value.value === 'string' && value.value.length > 0) {
      out.push({ path, value: value.value });
    }
    return;
  }
  if (value instanceof ObjectRef) {
    if (value.path) out.push({ path, value: value.path });
    if (value.classPath) out.push({ path: `${path}.class`, value: value.classPath });
    if (Array.isArray(value.embedded)) collectFromPropertyArray(value.embedded, path, out);
    return;
  }
  if (value instanceof SoftObjectRef) {
    if (value.assetPath) out.push({ path, value: value.assetPath });
    if (value.subPath)   out.push({ path: `${path}.sub`, value: value.subPath });
    return;
  }
  if (value instanceof StructValue) {
    // Three shapes for value.value:
    //   - Array  → nested property stream (unknown struct or fall-through);
    //              recurse so children land in the haystack.
    //   - string → Guid / DateTime / Timespan — emit it. Without this, GUIDs
    //              like ZhuRenGuid / GongHuiGuid / SelfUid would never be
    //              searchable and cross-row lookups by GUID would miss.
    //   - POJO   → numeric struct (Vector, Quat, Color, …) — nothing useful
    //              to index.
    if (Array.isArray(value.value)) {
      collectFromPropertyArray(value.value, path, out);
    } else if (typeof value.value === 'string' && value.value.length > 0) {
      out.push({ path, value: value.value });
    }
    return;
  }
  if (value instanceof ArrayValue) {
    for (let i = 0; i < value.elements.length; i++) {
      collectFromValue(value.elements[i], `${path}[${i}]`, out);
    }
    return;
  }
  if (value instanceof SetValue) {
    for (let i = 0; i < value.elements.length; i++) {
      collectFromValue(value.elements[i], `${path}[${i}]`, out);
    }
    return;
  }
  if (value instanceof MapValue) {
    for (let i = 0; i < value.entries.length; i++) {
      collectFromValue(value.entries[i].key,   `${path}[${i}].key`,   out);
      collectFromValue(value.entries[i].value, `${path}[${i}].value`, out);
    }
    return;
  }
  // OpaqueValue and anything else: nothing extractable.
}

function collectFromJson(node, path, out) {
  if (node == null) return;
  if (typeof node === 'string') {
    if (node.length > 0) out.push({ path, value: node });
    return;
  }
  if (typeof node === 'number' || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      collectFromJson(node[i], `${path}[${i}]`, out);
    }
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      collectFromJson(v, path ? `${path}.${k}` : k, out);
    }
  }
}
