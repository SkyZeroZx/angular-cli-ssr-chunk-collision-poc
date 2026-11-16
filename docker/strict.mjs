// The server of the lab with the workaround of REPORT.md in front of the Angular handler, so that it
// writes no more bytes than it declared. Started in place of the scaffold's server.mjs:
//   SERVER=docker/strict.mjs docker compose up -d --force-recreate app
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = process.argv[2] ?? 'dist/ng-chunk-collition';
const { reqHandler } = await import(pathToFileURL(resolve(dist, 'server/server.mjs')).href);

createServer((request, response) => {
  response.strictContentLength = true;
  reqHandler(request, response);
}).listen(4000, () => console.log('server on port 4000, strictContentLength set'));
