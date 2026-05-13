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
  eleventyConfig.addPassthroughCopy('jswasm');
  eleventyConfig.addPassthroughCopy('functions');

  return {
    dir: { input: '.', output: '_site' },
  };
};
