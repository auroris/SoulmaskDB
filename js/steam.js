'use strict';
/**
 * Steam ID utilities.
 *
 * Soulmask stores per-player saves keyed by SteamID64 (the 17-digit form).
 * SteamID64 = STEAM_BASE + accountId, where the 64-bit value encodes
 * (universe, type, instance, accountId). Player accounts on the public
 * universe always use accountType=1 (Individual), instance=1.
 *
 * SteamID64 values exceed Number.MAX_SAFE_INTEGER (2^53 - 1), so this
 * module uses BigInt for arithmetic and returns string forms throughout.
 *
 * One unified info cache per steamid64. Each entry may carry any subset of
 *   - label       : user-typed name (manual override, highest priority)
 *   - personaName : auto-fetched from Steam (null = we asked, Steam had nothing)
 *   - avatar      : auto-fetched from Steam
 *   - profileUrl  : auto-fetched from Steam
 *
 * Cache presence is "we've already looked at this ID" — `resolveNames` skips
 * any ID that's in the cache, whether the entry came from a user label or a
 * Steam fetch. A label is enough info to display, so labeled IDs are never
 * fetched from Steam (you only get an avatar if Steam was hit before the
 * label, or instead of one).
 *
 * Steam-fetch failures (404 / CORS / offline) are silently swallowed — the
 * manual-label flow remains the user-facing fallback.
 *
 * Display precedence: label > personaName > bare steam64.
 */
window.SMDB = window.SMDB || {};

SMDB.steam = (() => {
  // Public universe, type Individual, instance 1: 0x0110000100000000.
  const STEAM_BASE = 76561197960265728n;
  const ACCOUNT_TYPE_INDIVIDUAL = 1;

  function isSteamId64(s) {
    return typeof s === 'string' && /^7656119[789]\d{9}$/.test(s);
  }

  /**
   * Decompose a SteamID64 string into all common ID forms plus a profile URL.
   * Returns null if input isn't a recognizable SteamID64.
   */
  function decompose(steamid64) {
    if (!isSteamId64(steamid64)) return null;
    const id = BigInt(steamid64);
    const accountId = id - STEAM_BASE;
    if (accountId < 0n) return null;
    const y = accountId & 1n;
    const z = accountId >> 1n;
    return {
      steamid64,
      steamid3:   `[U:${ACCOUNT_TYPE_INDIVIDUAL}:${accountId.toString()}]`,
      steamidV1:  `STEAM_0:${y}:${z}`,
      accountId:  accountId.toString(),
      profileUrl: `https://steamcommunity.com/profiles/${steamid64}`,
    };
  }

  // ---- unified info cache -----------------------------------------------

  const INFO_KEY     = 'soulmaskdb.steam.info.v1';
  const RESOLVER_URL = '/api/steam/names';
  // Keep batches well under common URL-length limits (~2KB safe).
  // 50 IDs × ~18 chars = ~900 chars + path; comfortably under.
  const CLIENT_BATCH = 50;

  function loadInfo() {
    try { return JSON.parse(localStorage.getItem(INFO_KEY) || '{}'); }
    catch { return {}; }
  }

  function saveInfo(obj) {
    localStorage.setItem(INFO_KEY, JSON.stringify(obj));
  }

  // Returns the full unified entry (label + Steam-fetched fields), or null.
  function getInfo(steamid64) {
    return loadInfo()[steamid64] || null;
  }

  function getLabel(steamid64) {
    const info = getInfo(steamid64);
    return (info && info.label) || null;
  }

  // Upserts the user-typed label. Empty/whitespace removes just the label;
  // any Steam-fetched fields on the entry are left intact (so clearing a
  // label doesn't lose the auto-fetched avatar/profile).
  function setLabel(steamid64, label) {
    const all = loadInfo();
    const cur = all[steamid64] || {};
    const trimmed = (label || '').trim();
    if (trimmed) cur.label = trimmed;
    else delete cur.label;
    all[steamid64] = cur;
    saveInfo(all);
  }

  // Display precedence: user label > resolved persona name > null.
  function displayName(steamid64) {
    const info = getInfo(steamid64);
    if (!info) return null;
    return info.label || info.personaName || null;
  }

  function cacheCount() {
    return Object.keys(loadInfo()).length;
  }

  // Total wipe — drops manual labels and Steam-fetched data alike.
  function clearCache() {
    localStorage.removeItem(INFO_KEY);
  }

  /**
   * Resolve a batch of Steam IDs via the CF function. Skips any ID already
   * in the cache (label-only and Steam-fetched alike). Fetch/CORS/non-OK
   * failures are silently swallowed.
   * Returns the number of newly cached entries (for UI refresh).
   */
  async function resolveNames(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    const cache = loadInfo();
    const seen = new Set();
    const unknown = [];
    for (const id of ids) {
      if (!isSteamId64(id) || seen.has(id) || (id in cache)) continue;
      seen.add(id);
      unknown.push(id);
    }
    if (unknown.length === 0) return 0;
    unknown.sort();  // stable URL → better edge-cache hits

    const batches = [];
    for (let i = 0; i < unknown.length; i += CLIENT_BATCH) {
      batches.push(unknown.slice(i, i + CLIENT_BATCH));
    }

    const responses = await Promise.all(batches.map(async (b) => {
      try {
        const r = await fetch(`${RESOLVER_URL}?ids=${b.join(',')}`);
        if (!r.ok) return null;
        return await r.json();
      } catch {
        return null;
      }
    }));

    let updated = 0;
    for (let bi = 0; bi < batches.length; bi++) {
      const arr = responses[bi];
      if (!Array.isArray(arr)) continue;  // batch failed; leave uncached so we retry next time
      const batch = batches[bi];
      for (let i = 0; i < batch.length && i < arr.length; i++) {
        const p = arr[i];
        const cur = cache[batch[i]] || {};
        if (p) {
          if (p.personaName) cur.personaName = p.personaName;
          if (p.avatar)      cur.avatar      = p.avatar;
          if (p.profileUrl)  cur.profileUrl  = p.profileUrl;
        } else {
          cur.personaName = null;  // sentinel: asked, Steam had nothing
        }
        cache[batch[i]] = cur;
        updated++;
      }
    }
    if (updated > 0) saveInfo(cache);
    return updated;
  }

  return {
    isSteamId64, decompose,
    getLabel, setLabel,
    getInfo, displayName,
    resolveNames, cacheCount, clearCache,
    STEAM_BASE,
  };
})();
