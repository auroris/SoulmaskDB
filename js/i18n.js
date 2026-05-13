'use strict';
/**
 * Internationalization layer.
 *
 * Catalogs live on `window.SMDB_LOCALES`, populated by per-locale script
 * files that MUST load BEFORE this file:
 *
 *   <script src="js/locale/en.js"></script>
 *   <script src="js/locale/zh.js"></script>
 *   <script src="js/i18n.js"></script>
 *
 * Each locale script does:
 *   window.SMDB_LOCALES = window.SMDB_LOCALES || {};
 *   window.SMDB_LOCALES.en = { 'ui.button.save': 'Save', 'gloss.JianZhu': 'building', ... };
 *
 * Keys are namespaced:
 *   ui.*    — strings we author. Missing key returns ⟨key⟩ sentinel and
 *             logs a warning so untranslated UI stands out.
 *   gloss.* — game vocabulary (open-ended). Missing key falls back silently
 *             to the raw token; that's expected because game updates add
 *             tokens we haven't yet glossed.
 *
 * Locale resolution order:
 *   1. ?lang=xx URL parameter (persists to localStorage on use)
 *   2. localStorage 'soulmaskdb.locale.v1'
 *   3. navigator.language (zh-CN tries 'zh-CN' then 'zh')
 *   4. 'en' fallback
 *
 * Interpolation: `t('ui.loaded', {file: 'world.db', count: 12})` against
 * a value of "loaded {file} — {count} rows" substitutes both placeholders.
 *
 * Static HTML: elements with `data-i18n="key"` get their text content set;
 * `data-i18n-title` / `data-i18n-placeholder` set those attributes. Call
 * `SMDB.i18n.applyToDom()` after DOMContentLoaded.
 *
 * Locale switching reloads the page with the new ?lang= so all the static
 * substitution and JS-side string captures pick up the new catalog.
 */
window.SMDB = window.SMDB || {};

SMDB.i18n = (() => {
  const LOCALE_KEY = 'soulmaskdb.locale.v1';
  const DEFAULT_LOCALE = 'en';
  const locales = window.SMDB_LOCALES || {};

  function detect() {
    const url = new URL(location.href);
    const fromUrl = url.searchParams.get('lang');
    if (fromUrl && locales[fromUrl]) {
      try { localStorage.setItem(LOCALE_KEY, fromUrl); } catch {}
      return fromUrl;
    }
    let stored = null;
    try { stored = localStorage.getItem(LOCALE_KEY); } catch {}
    if (stored && locales[stored]) return stored;
    const nav = (navigator.language || '').toLowerCase();
    if (nav) {
      for (const c of [nav, nav.split('-')[0]]) {
        if (locales[c]) return c;
      }
    }
    return DEFAULT_LOCALE;
  }

  const currentLocale = detect();
  const catalog = locales[currentLocale] || {};
  const fallback = locales[DEFAULT_LOCALE] || {};

  function interpolate(template, opts) {
    if (typeof template !== 'string' || !opts) return template;
    return template.replace(/\{(\w+)\}/g, (m, k) => (k in opts ? String(opts[k]) : m));
  }

  function t(key, opts) {
    let v = catalog[key];
    if (v == null) v = fallback[key];
    if (v != null) return interpolate(v, opts);
    if (opts && 'default' in opts) return interpolate(opts.default, opts);
    if (key.startsWith('ui.')) {
      console.warn('[i18n] missing UI key:', key);
      return `⟨${key}⟩`;
    }
    // gloss.* and any other namespace: silent fallback to the key tail.
    return key.split('.').pop();
  }

  function setLocale(lang) {
    try { localStorage.setItem(LOCALE_KEY, lang); } catch {}
    const url = new URL(location.href);
    url.searchParams.set('lang', lang);
    location.href = url.toString();
  }

  function availableLocales() {
    return Object.keys(locales).sort();
  }

  function applyToDom(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.dataset.i18n);
    });
    // Opt-in HTML version — catalog values may contain markup. The catalog
    // is author-controlled (not user input), so this is XSS-safe by design.
    root.querySelectorAll('[data-i18n-html]').forEach(el => {
      el.innerHTML = t(el.dataset.i18nHtml);
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = t(el.dataset.i18nTitle);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
  }

  return { t, setLocale, currentLocale, availableLocales, applyToDom };
})();
