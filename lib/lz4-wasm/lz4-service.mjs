/**
 * Lz4Service — boots the lz4-wasm backend and exposes compress/decompress.
 *
 * Backends, picked at init() time:
 *   Node:    `lz4-wasm-nodejs` (npm; bare specifier).
 *   Browser: `./lz4-browser.mjs` (local adapter that loads lz4_wasm_bg.wasm
 *            via fetch + WebAssembly.instantiateStreaming, no bundler needed).
 *
 * Why a service rather than module-load TLA:
 *   The previous version did `await import('lz4-wasm-nodejs')` at the top of
 *   blob.mjs, which made every module that imported blob.mjs (codecs, the
 *   decode-worker, app.mjs) a TLA module — and forced bootstrap.mjs to do
 *   its UI wiring inside a dynamic import to dodge a defer-vs-await race.
 *   Concentrating the wasm boot in an explicit init() lets the orchestrator
 *   run it (and the sqlite3 wasm boot) in parallel up front, and removes
 *   the surprise side effect from importing blob.mjs.
 *
 * Each JS context (main thread, worker, node test) constructs its own
 * Lz4Service — wasm instances aren't shareable across contexts anyway.
 *
 * Usage:
 *   const lz4 = new Lz4Service();
 *   await lz4.init();          // loads the .wasm; idempotent
 *   lz4.decompress(bytes);     // throws if init() not awaited
 *   lz4.compress(bytes);
 */
export class Lz4Service {
  constructor() {
    this._impl = null;
    this._initPromise = null;
  }

  /**
   * Load the wasm backend. Repeated calls share the same promise so it's
   * safe to await from multiple call sites. Resolves to `this`.
   */
  async init() {
    if (this._impl) return this;
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      let impl = null;
      try {
        // Node path. In a browser this throws (bare specifier unresolvable).
        impl = await import('lz4-wasm-nodejs');
      } catch {
        // Browser path. Relative import → resolvable in native ESM.
        // The adapter's ready() loads the .wasm before the first call.
        const mod = await import('./lz4-browser.mjs');
        await mod.ready();
        impl = mod;
      }
      this._impl = impl;
      return this;
    })();
    return this._initPromise;
  }

  isReady() { return !!this._impl; }

  /**
   * Decompress a Soulmask-format LZ4 block: [u32 LE uncompressed_size][raw].
   * `srcOff` lets callers point past their outer header without slicing.
   */
  decompress(src, srcOff = 0) {
    if (!this._impl) throw new Error('Lz4Service: init() not awaited');
    const view = srcOff === 0 ? src : src.subarray(srcOff);
    return this._impl.decompress(view);
  }

  compress(decompressed) {
    if (!this._impl) throw new Error('Lz4Service: init() not awaited');
    return this._impl.compress(decompressed);
  }
}
