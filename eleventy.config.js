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
export default function(eleventyConfig) {
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

  // jQuery + DataTables + FlexSearch. The page loads the ESM builds via an
  // import map in index.html (`jquery`, `datatables.net`, `datatables.net-dt`,
  // `flexsearch`). Copy just the entry .mjs / .css files we actually
  // reference — no bundling, the browser resolves the bare specifiers
  // through the map.
  eleventyConfig.addPassthroughCopy({
    'node_modules/jquery/dist-module/jquery.module.js':
      'lib/jquery/jquery.module.js',
    'node_modules/datatables.net/js/dataTables.mjs':
      'lib/datatables.net/dataTables.mjs',
    'node_modules/datatables.net-dt/js/dataTables.dataTables.mjs':
      'lib/datatables.net-dt/dataTables.dataTables.mjs',
    'node_modules/datatables.net-dt/css/dataTables.dataTables.css':
      'lib/datatables.net-dt/dataTables.dataTables.css',
    'node_modules/datatables.net-columncontrol/js/dataTables.columnControl.mjs':
      'lib/datatables.net-columncontrol/dataTables.columnControl.mjs',
    'node_modules/datatables.net-columncontrol-dt/js/columnControl.dataTables.mjs':
      'lib/datatables.net-columncontrol-dt/columnControl.dataTables.mjs',
    'node_modules/datatables.net-columncontrol-dt/css/columnControl.dataTables.css':
      'lib/datatables.net-columncontrol-dt/columnControl.dataTables.css',
    'node_modules/datatables.net-colreorder/js/dataTables.colReorder.mjs':
      'lib/datatables.net-colreorder/dataTables.colReorder.mjs',
    'node_modules/datatables.net-colreorder-dt/js/colReorder.dataTables.mjs':
      'lib/datatables.net-colreorder-dt/colReorder.dataTables.mjs',
    'node_modules/datatables.net-colreorder-dt/css/colReorder.dataTables.css':
      'lib/datatables.net-colreorder-dt/colReorder.dataTables.css',
    'node_modules/datatables.net-rowgroup/js/dataTables.rowGroup.mjs':
      'lib/datatables.net-rowgroup/dataTables.rowGroup.mjs',
    'node_modules/datatables.net-rowgroup-dt/js/rowGroup.dataTables.mjs':
      'lib/datatables.net-rowgroup-dt/rowGroup.dataTables.mjs',
    'node_modules/datatables.net-rowgroup-dt/css/rowGroup.dataTables.css':
      'lib/datatables.net-rowgroup-dt/rowGroup.dataTables.css',
    'node_modules/flexsearch/dist/flexsearch.bundle.module.min.mjs':
      'lib/flexsearch/flexsearch.module.mjs',
  });

  return {
    dir: { input: '.', output: '_site' },
  };
};
