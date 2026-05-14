'use strict';
/**
 * Row classifier — maps a raw actor_table row to a (kind, label, summary)
 * triple, plus the small set of canonical strings other code uses to detect
 * specific row shapes (paste-collision logic, etc.).
 *
 * The classification db lives in the RULES array below. Each rule is one
 * record; matching is first-rule-wins, so ORDER MATTERS — specific patterns
 * before generic ones (e.g. 'jianzhu/rongqi' must come before bare
 * 'jianzhu'). To extend coverage, drop a new rule into the right slot and
 * (if introducing a brand-new kind) add ui.kind.* / ui.kindFilter.* entries
 * to js/locale/{en,zh}.js.
 *
 * Rule shape:
 *   { name:           '...'              } — exact actor_name match
 *   { script:         '...'              } — exact actor_script match
 *   { scriptContains: '...' | [...]      } — case-insensitive substring
 *                                            test on actor_script (any-of)
 *   kind:    result kind (drives pill color + filter dropdown)
 *   summary: optional i18n key. If present, the row is treated as
 *            "canonical": label = actor_name, no position appended.
 *            If absent, label = shortClassName(actor_script) and
 *            summary = translateIdent(label) + " @ pos".
 *
 * Result shape, returned by classify(row):
 *   kind     'system' | 'player' | 'inventory' | 'npc' | 'animal' |
 *            'container' | 'station' | 'building' | 'furniture' |
 *            'vegetation' | 'region' | 'vehicle' | 'other'.
 *   label    short identifier for the "class" table column
 *   summary  localized descriptive text for the "summary" table column
 *
 * SMDB.classify.SCRIPT and SMDB.classify.NAME expose the canonical strings
 * (script paths, reserved actor_names) so callers that need to detect a
 * specific row shape don't have to restate them.
 *
 * Depends on SMDB.i18n being loaded first (load order in index.html).
 */
window.SMDB = window.SMDB || {};

SMDB.classify = (() => {
  // Canonical script paths. Compare actor_script === SCRIPT.X to detect a
  // specific row kind structurally rather than guessing from substrings.
  const SCRIPT = Object.freeze({
    PLAYER_STATE: '/Script/WS.HPlayerState',
  });

  // Reserved actor_name strings used by the game for global config rows.
  const NAME = Object.freeze({
    GAME_SETTINGS: 'GAME_SETTINGS',
    GAMEMODE:      'GAMEMODE',
  });

  // The classification db. Order = priority. See file header for shape.
  const RULES = [
    // ---- Canonical named rows ---------------------------------------------
    { name: NAME.GAME_SETTINGS,                kind: 'system', summary: 'ui.classify.gameSettings' },
    { name: NAME.GAMEMODE,                     kind: 'system', summary: 'ui.classify.gameMode' },

    // ---- Canonical script paths -------------------------------------------
    { script: SCRIPT.PLAYER_STATE,             kind: 'player', summary: 'ui.classify.playerSave' },

    // ---- Substring rules (specific BEFORE generic) ------------------------
    { scriptContains: 'bindbgcompactor',                                                         kind: 'inventory'  },
    // *GuanLiQi (管理器) blueprints are singleton managers/registries — e.g.
    // /Blueprints/GongHui/BP_WenMingGuanLiQi (per-server civilization state).
    // Placed early so a name like Jianzhu*GuanLiQi reads as system, not building.
    { scriptContains: 'guanliqi',                                                                kind: 'system'     },
    { scriptContains: 'jianzhupianqu',                                                           kind: 'region'     },
    { scriptContains: ['jianzhu/rongqi', 'jianzhu/baoguoactor', 'hbaoxiang'],                    kind: 'container'  },
    { scriptContains: ['jianzhu/gongzuotai', 'jianzhu/fengche', 'jianzhu/lighting',
                       'jianzhu/chuansongmen', 'conveyor'],                                      kind: 'station'    },
    { scriptContains: 'jianzhu/zhongzhi',                                                        kind: 'vegetation' },
    { scriptContains: 'jianzhu/jiaju',                                                           kind: 'furniture'  },
    { scriptContains: 'animalhouse',                                                             kind: 'building'   },
    { scriptContains: 'jianzhu',                                                                 kind: 'building'   },
    { scriptContains: ['/npc/', 'tribe', 'savage', 'sandbandits', 'desertwolf', 'exiles'],       kind: 'npc'        },
    { scriptContains: ['monster', 'dongwu'],                                                     kind: 'animal'     },
    { scriptContains: ['plant', 'crop', 'zhibei'],                                               kind: 'vegetation' },
    { scriptContains: ['/ship/', 'bp_ship', 'bp_boat', 'bp_deck', 'gangway'],                    kind: 'vehicle'    },
  ];

  // ".../Foo.BP_DongWu_Yu_C" → "BP_DongWu_Yu_C". Falls back to the last
  // path-segment if there's no trailing _C suffix.
  function shortClassName(scriptPath) {
    if (!scriptPath) return '';
    const m = scriptPath.match(/[./]([^./]+)_C$/);
    if (m) return m[1];
    const parts = scriptPath.split(/[./]/);
    return parts[parts.length - 1] || scriptPath;
  }

  // "x,y,z|rx,ry,rz|sx,sy,sz" → { pos, rot, scale }. null on malformed input.
  function parseTransform(transf) {
    if (!transf) return null;
    const parts = transf.split('|');
    if (parts.length !== 3) return null;
    const triples = parts.map(p => p.split(',').map(Number));
    if (triples.some(tr => tr.length !== 3 || tr.some(n => !isFinite(n)))) return null;
    return { pos: triples[0], rot: triples[1], scale: triples[2] };
  }

  // Yaw (rotation around Z-up axis) → 8-way compass code: 'N','NE','E',…
  // Unreal serializes FRotator as (pitch, yaw, roll), so yaw is rot[1].
  // World-axis-to-compass: +X=East, +Y=North. Positive yaw rotates from +X
  // toward +Y (CCW on map). If verification against a known actor shows the
  // game's world axes are oriented differently, flip COMPASS or the sign of
  // yaw here — it's the only place that bakes in the convention.
  const COMPASS_8 = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];
  function bearingFromTransform(tx) {
    if (!tx || !Array.isArray(tx.rot) || tx.rot.length !== 3) return null;
    let yaw = tx.rot[1];
    if (!isFinite(yaw)) return null;
    yaw = ((yaw % 360) + 360) % 360;
    return COMPASS_8[Math.round(yaw / 45) % 8];
  }

  // 3D Euclidean distance between a parsed transform and an [x,y,z] anchor,
  // converted from Unreal units (cm) to meters. null on malformed input.
  function distanceMeters(tx, anchorPos) {
    if (!tx || !Array.isArray(tx.pos) || tx.pos.length !== 3) return null;
    if (!Array.isArray(anchorPos) || anchorPos.length !== 3) return null;
    const dx = tx.pos[0] - anchorPos[0];
    const dy = tx.pos[1] - anchorPos[1];
    const dz = tx.pos[2] - anchorPos[2];
    return Math.hypot(dx, dy, dz) / 100;
  }

  // Romanized-Mandarin blueprint identifier → friendly per-locale words.
  // Gloss table lives in js/locale/{en,zh}.js under 'gloss.*'; missing
  // tokens fall back to the raw token (right default for new
  // game-introduced names we haven't yet mapped).
  //
  // Strips Unreal's conventional prefixes (BP_ blueprint, H WS-class
  // marker) and the _C class suffix, then decomposes each
  // underscore-separated part token-by-token. A "token" may itself be a
  // PascalCase compound like "ZhiBeiGuanLiQi"; decomposeIdent walks the
  // longest gloss-prefix and recurses so 'ZhiBei' + 'GuanLiQi' both
  // translate without needing a one-shot compound entry.
  function translateIdent(ident) {
    if (!ident) return '';
    const cleaned = ident
      .replace(/^BP_/, '')
      .replace(/^H(?=[A-Z][a-z])/, '')
      .replace(/_C$/, '');
    return cleaned.split(/[_.]/).filter(Boolean).map(decomposeIdent).join(' ');
  }

  function decomposeIdent(token) {
    if (!token) return '';
    const tr = SMDB.i18n.t;
    let v = tr('gloss.' + token, { default: null });
    if (v != null) return v;
    // Whole-token miss: look for the longest PascalCase prefix that has
    // a gloss entry, then recurse on what's left. Iterating from the
    // end yields the longest match first.
    for (let i = token.length - 1; i > 0; i--) {
      if (!isPascalBoundary(token, i)) continue;
      v = tr('gloss.' + token.slice(0, i), { default: null });
      if (v != null) {
        const rest = decomposeIdent(token.slice(i));
        return rest ? v + ' ' + rest : v;
      }
    }
    return token;
  }

  function isPascalBoundary(s, i) {
    return /[a-z]/.test(s[i - 1]) && /[A-Z]/.test(s[i]);
  }

  // Predicates — callers can ask "is this a player row?" without restating
  // which field carries the signal.
  function isPlayerRow(row) {
    return !!row && row.actor_script === SCRIPT.PLAYER_STATE;
  }
  function isSystemRow(row) {
    const n = row && row.actor_name;
    return n === NAME.GAME_SETTINGS || n === NAME.GAMEMODE;
  }

  function ruleMatches(rule, row, scriptLower) {
    if (rule.name   && rule.name   === row.actor_name)   return true;
    if (rule.script && rule.script === row.actor_script) return true;
    if (rule.scriptContains) {
      const pats = Array.isArray(rule.scriptContains) ? rule.scriptContains : [rule.scriptContains];
      return pats.some(p => scriptLower.includes(p));
    }
    return false;
  }

  function classify(row) {
    const name   = (row && row.actor_name)   || '';
    const script = (row && row.actor_script) || '';
    const scriptLower = script.toLowerCase();
    const t = SMDB.i18n.t;

    for (const rule of RULES) {
      if (!ruleMatches(rule, row || {}, scriptLower)) continue;
      if (rule.summary) {
        // Canonical row: label = actor_name, fixed summary, no position.
        return { kind: rule.kind, label: name, summary: t(rule.summary) };
      }
      // Generic substring match: label and summary derived from script.
      return buildGenericResult(rule.kind, script, row && row.actor_transf);
    }
    return buildGenericResult('other', script, row && row.actor_transf);
  }

  function buildGenericResult(kind, script, transf) {
    const cls = shortClassName(script);
    const tx = parseTransform(transf);
    const pos = tx ? ` @ ${tx.pos.map(n => Math.round(n)).join(',')}` : '';
    const bearing = tx ? bearingFromTransform(tx) : null;
    const facing = bearing ? ' ' + SMDB.i18n.t('ui.compass.' + bearing, { default: bearing }) : '';
    return { kind, label: cls, summary: translateIdent(cls) + pos + facing };
  }

  // Group an array of classified rows by actor_script. For each distinct
  // script, returns { script, count, kind, sampleLabel }. The kind is the
  // dominant _kind for that script (almost always uniform, since classify
  // is deterministic per script). sampleLabel is the _label from one of
  // the rows — handy when the script path alone is opaque.
  function aggregateScripts(rows) {
    const stats = new Map();
    for (const r of rows) {
      const script = r.actor_script == null ? '' : r.actor_script;
      let s = stats.get(script);
      if (!s) {
        s = { script, count: 0, kindCounts: {}, sampleLabel: r._label || '' };
        stats.set(script, s);
      }
      s.count++;
      s.kindCounts[r._kind] = (s.kindCounts[r._kind] || 0) + 1;
    }
    const out = [];
    for (const s of stats.values()) {
      let bestKind = 'other', bestCount = -1;
      for (const [k, c] of Object.entries(s.kindCounts)) {
        if (c > bestCount) { bestKind = k; bestCount = c; }
      }
      out.push({ script: s.script, count: s.count, kind: bestKind, sampleLabel: s.sampleLabel });
    }
    return out;
  }

  // ===========================================================
  // Parent/child relationships
  // ===========================================================
  //
  // Soulmask splits "owning actor" and "inventory storage" across two
  // adjacent SQLite rows. For workbench-style containers (chests,
  // workstations, …) the inventory's BG-actor row is at chest_serial - 1
  // — confirmed across our test boxes (22638↔22637, 39160↔39159, …).
  //
  // For players the relationship is by Steam ID:
  //   HPlayerState.actor_name == BindBGCompActor.actor_name
  //
  // findRelations(row, lookupRow) returns:
  //   { parent: row | null, children: row[] }
  // where each entry is the lightweight `allRows` shape (no blob). The
  // caller supplies a `(serial) => row | null` lookup and (optionally)
  // an `allRowsIter` iterator for the Steam-ID match scan.
  function isInventoryStorageRow(row) {
    const s = (row && row.actor_script) || '';
    const sl = s.toLowerCase();
    return sl.includes('bgactor') || sl.includes('bindbgcompactor') || sl.includes('bindbgcompdongwu');
  }
  function isInventoryOwnerRow(row) {
    const k = row && row._kind;
    return k === 'container' || k === 'station' || k === 'building' ||
           k === 'furniture' || k === 'player' || k === 'animal' || k === 'npc';
  }

  function findRelations(row, lookupRow, allRowsIter) {
    const out = { parent: null, children: [] };
    if (!row) return out;

    // BG / BindBG actor → look for its owner.
    if (isInventoryStorageRow(row)) {
      // (1) Adjacent serial heuristic (chest/workbench case).
      const cand = lookupRow(row.actor_serial + 1);
      if (cand && isInventoryOwnerRow(cand)) {
        out.parent = cand;
        return out;
      }
      // (2) Steam-ID match for BindBGCompActor (player case).
      if (row.actor_name && /^7656119\d{10}$/.test(row.actor_name) && allRowsIter) {
        for (const r of allRowsIter()) {
          if (r === row) continue;
          if (r.actor_name === row.actor_name && r.actor_script === SCRIPT.PLAYER_STATE) {
            out.parent = r;
            return out;
          }
        }
      }
      // (3) actor_owner path fallback.
      if (row.actor_owner && allRowsIter) {
        for (const r of allRowsIter()) {
          if (r === row) continue;
          if (r.actor_script && row.actor_owner.includes(r.actor_script.replace(/^.*[./]/, '').replace(/_C$/, ''))) {
            // Loose match — owner string contains the parent's class name
            out.parent = r;
            break;
          }
        }
      }
      return out;
    }

    // Owner row (chest, player, etc.) → look for child BG.
    if (isInventoryOwnerRow(row)) {
      // (1) Adjacent serial heuristic.
      const cand = lookupRow(row.actor_serial - 1);
      if (cand && isInventoryStorageRow(cand)) {
        out.children.push(cand);
      }
      // (2) Steam-ID match for player → BindBGCompActor.
      if (row.actor_script === SCRIPT.PLAYER_STATE && row.actor_name && allRowsIter) {
        for (const r of allRowsIter()) {
          if (r === row) continue;
          if (r.actor_name === row.actor_name && isInventoryStorageRow(r)) {
            if (!out.children.includes(r)) out.children.push(r);
          }
        }
      }
    }
    return out;
  }

  return {
    classify,
    isPlayerRow, isSystemRow,
    shortClassName, parseTransform, translateIdent,
    bearingFromTransform, distanceMeters,
    aggregateScripts,
    findRelations, isInventoryStorageRow, isInventoryOwnerRow,
    SCRIPT, NAME, RULES,
  };
})();
