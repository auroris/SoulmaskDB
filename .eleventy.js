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

  // node-lz4 ships a UMD browser build at node_modules/lz4/build/lz4.js
  // (declared as its `browser` entry in package.json). We surface it at
  // /lib/lz4/lz4.js so the dep is pinned via package.json instead of
  // bundling our own copy.
  eleventyConfig.addPassthroughCopy({
    'node_modules/lz4/build/lz4.js': 'lib/lz4/lz4.js',
  });

  return {
    dir: { input: '.', output: '_site' },
  };
};
