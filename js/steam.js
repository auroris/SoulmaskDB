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
 * No remote lookups — Steam Web API requires a key and isn't CORS-friendly,
 * and steamcommunity.com blocks cross-origin XHR. We provide a profile
 * link the user can click, and a localStorage-backed label cache the user
 * fills in manually.
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

  // ---- persistent label cache (user-edited persona names) -------------

  const LABEL_KEY = 'soulmaskdb.steam.labels.v1';

  function loadLabels() {
    try { return JSON.parse(localStorage.getItem(LABEL_KEY) || '{}'); }
    catch { return {}; }
  }

  function saveLabels(obj) {
    localStorage.setItem(LABEL_KEY, JSON.stringify(obj));
  }

  function getLabel(steamid64) {
    return loadLabels()[steamid64] || null;
  }

  function setLabel(steamid64, label) {
    const all = loadLabels();
    if (label && label.trim()) all[steamid64] = label.trim();
    else delete all[steamid64];
    saveLabels(all);
  }

  function allLabels() { return loadLabels(); }

  return { isSteamId64, decompose, getLabel, setLabel, allLabels, STEAM_BASE };
})();
