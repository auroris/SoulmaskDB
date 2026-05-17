/**
 * collectFacts(decoded) — extract player-visible name data from a decoded blob.
 *
 * Returns a plain object with any of the following fields set (omitted when
 * absent or empty):
 *
 *   displayName     — player-set label (JianZhuDisplayName TextProperty on
 *                     buildings/structures, CurGaoShiString StrProperty on signs)
 *   customNote      — NPC custom note (CustomBeiZhu StrProperty)
 *   ownerPlayerName — player who owns the NPC (OwnerPlayerName StrProperty)
 *
 * `deriveName(facts)` collapses these into a single best display string for
 * use in the row table Name column.
 */

export function collectFacts(decoded) {
  if (!decoded || decoded.kind !== 'unreal-properties') return {};
  const props = decoded.properties;
  if (!Array.isArray(props)) return {};

  const facts = {};
  for (const p of props) {
    switch (p.name) {
      case 'JianZhuDisplayName': {
        const t = p.value?.text;
        if (t && !facts.displayName) facts.displayName = t;
        break;
      }
      case 'CurGaoShiString': {
        if (typeof p.value === 'string' && p.value && !facts.displayName) {
          facts.displayName = p.value;
        }
        break;
      }
      case 'CustomBeiZhu': {
        if (typeof p.value === 'string' && p.value) facts.customNote = p.value;
        break;
      }
      case 'OwnerPlayerName': {
        if (typeof p.value === 'string' && p.value) facts.ownerPlayerName = p.value;
        break;
      }
    }
  }
  return facts;
}

/**
 * Collapse facts into a single display string, or null if nothing useful.
 *
 * Priority:
 *   1. displayName (building/sign label)
 *   2. customNote + ownerPlayerName together  → "Craftsman [Aleena]"
 *   3. customNote alone
 *   4. ownerPlayerName alone
 */
export function deriveName(facts) {
  if (!facts) return null;
  if (facts.displayName) return facts.displayName;
  if (facts.customNote && facts.ownerPlayerName) return `${facts.customNote} [${facts.ownerPlayerName}]`;
  if (facts.customNote) return facts.customNote;
  if (facts.ownerPlayerName) return facts.ownerPlayerName;
  return null;
}
