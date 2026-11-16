// Is a built application affected? Reads the build output, nothing else.
//   node tools/check-dist.mjs [dist/ng-chunk-collition]
// Lists the prerendered pages that import the same server asset chunk, with the size the manifest
// declares for each page next to the size of the chunk it would be served from.
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const server = join(resolve(process.argv[2] ?? 'dist/ng-chunk-collition'), 'server');
const { default: manifest } = await import(
  pathToFileURL(join(server, 'angular-app-manifest.mjs')).href
);

const chunks = new Map();
for (const [page, asset] of Object.entries(manifest.assets)) {
  if (!page.endsWith('.html')) continue;
  // The chunk path only exists inside the lazy `text` function of the entry.
  const chunk = asset.text.toString().match(/import\((["'])(.+?)\1\)/)[2];
  const held = await asset.text().then(Buffer.byteLength, (error) => `unreadable: ${error.code}`);
  chunks.set(chunk, [...(chunks.get(chunk) ?? []), { page, declared: asset.size, held }]);
}

const shared = [...chunks].filter(([, pages]) => pages.length > 1);
for (const [chunk, pages] of shared) {
  console.log(`SHARED ${chunk}`);
  for (const { page, declared, held } of pages) {
    console.log(`  ${page.padEnd(34)} declares ${declared}, chunk holds ${held}`);
  }
}
const total = [...chunks.values()].flat().length;
console.log(`${total} pages, ${chunks.size} chunks, ${shared.length} shared`);
process.exit(shared.length ? 1 : 0);
