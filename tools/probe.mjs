// Serves a build on loopback and requests every prerendered page once, over a raw socket so that
// nothing stops reading at Content-Length.
//   node tools/probe.mjs [dist/ng-chunk-collition]
//   STRICT=1 node tools/probe.mjs        same, with response.strictContentLength set (the workaround)
// Prints what the server declared, what it wrote, and the <title> of the page it wrote.
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The scaffold ships `allowedHosts: []`, which answers 400 to everything.
process.env.NG_ALLOWED_HOSTS ??= 'localhost';

const dist = join(resolve(process.argv[2] ?? 'dist/ng-chunk-collition'), 'server');
const load = (file) => import(pathToFileURL(join(dist, file)).href);
const { default: manifest } = await load('angular-app-manifest.mjs');
const { reqHandler } = await load('server.mjs');

const server = createServer((request, response) => {
  if (process.env.STRICT) response.strictContentLength = true;
  reqHandler(request, response);
}).listen(0, '127.0.0.1');
await new Promise((ready) => server.once('listening', ready));

function get(path) {
  return new Promise((done) => {
    const socket = connect(server.address().port, '127.0.0.1');
    const parts = [];
    socket.on('connect', () =>
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`),
    );
    socket.on('data', (part) => parts.push(part));
    socket.on('error', () => {});
    socket.setTimeout(8000, () => socket.destroy());
    socket.on('close', () => {
      const raw = Buffer.concat(parts);
      const split = raw.indexOf('\r\n\r\n');
      const head = raw.subarray(0, Math.max(split, 0)).toString('latin1');
      const body = split < 0 ? Buffer.alloc(0) : raw.subarray(split + 4);
      done({
        status: head.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? '-',
        declared: Number(head.match(/^content-length: (\d+)/im)?.[1] ?? NaN),
        etag: head.match(/^etag: "(.+)"/im)?.[1],
        sent: body.length,
        title: body.toString().match(/<title>(.*?)<\/title>/)?.[1] ?? '-',
      });
    });
  });
}

const pages = Object.keys(manifest.assets)
  .filter((page) => page === 'index.html' || page.endsWith('/index.html'))
  .map((page) => [`/${page.slice(0, -'index.html'.length)}`.replace(/(.)\/$/, '$1'), page])
  .sort();
for (const [path, page] of pages) {
  const { status, declared, etag, sent, title } = await get(path);
  console.log(
    `GET ${path.padEnd(22)} ${status}  declared ${String(declared).padStart(5)}  ` +
      `sent ${String(sent).padStart(5)}  ` +
      `etag ${etag === manifest.assets[page].hash ? 'of this page' : (etag ?? '-')}  ` +
      `"${title}"${sent === declared ? '' : '   <-- not the declared length'}`,
  );
}
server.close();
process.exit(0);
