'use strict';
/**
 * Eleventy build config.
 *
 * Today the build is mostly passthrough copy — the app's static assets
 * (the JS modules, the wasm payload, and the Cloudflare Pages Function)
 * are copied into _site/ verbatim so wrangler can serve everything from
 * a single directory. Markdown / HTML pages added later (tutorials,
 * docs) get processed normally by Eleventy.
 *
 * Output: _site/ (gitignored).
 */
module.exports = function(eleventyConfig) {
  eleventyConfig.addPassthroughCopy('js');
  eleventyConfig.addPassthroughCopy('lib');
  eleventyConfig.addPassthroughCopy('functions');

  // The browser lz4 adapter (lib/lz4-wasm/lz4-browser.mjs) fetches this
  // .wasm at runtime via `new URL('./lz4_wasm_bg.wasm', import.meta.url)`.
  // Eleventy's input scan never walks node_modules, so we map it
  // explicitly into lib/lz4-wasm/ alongside the adapter.
  eleventyConfig.addPassthroughCopy({
    'node_modules/lz4-wasm/lz4_wasm_bg.wasm': 'lib/lz4-wasm/lz4_wasm_bg.wasm',
  });

  return {
    dir: { input: '.', output: '_site' },
  };
};
