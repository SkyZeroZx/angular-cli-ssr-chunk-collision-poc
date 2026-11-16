// Lab-only edit, for the control: the chunk name gets a hash of the page path, so it is unique per
// page. It changes this container's copy of @angular/build and nothing else.
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'node_modules/@angular/build/src/utils/server-rendering/manifest.js';
const line = "const jsChunkFilePath = `assets-chunks/${file.path.replace(/[./]/g, '_')}.mjs`;";
const unique =
  "const jsChunkFilePath = `assets-chunks/${file.path.replace(/[./]/g, '_')}-" +
  "${require('node:crypto').createHash('sha256').update(file.path).digest('hex').slice(0, 8)}.mjs`;";

const source = readFileSync(file, 'utf8');
if (!source.includes(line)) throw new Error(`${file}: the line to change is not there`);
writeFileSync(file, source.replace(line, unique));
console.log('lab edit applied: chunk names carry a hash of the page path');
