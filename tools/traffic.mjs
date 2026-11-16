// Visitors and the attacker at the same time, every request on its own connection to the proxy.
//   node tools/traffic.mjs [visitors=8] [attackers=4] [seconds=20]
// Visitors ask for pages of the site and for its main bundle. Each response is read for the script
// first and only then compared, byte for byte, with a copy of that URL fetched before the attacker
// starts: with a cache in front that copy can be the script already. The attacker only requests one
// of his own two pages.
import { PAGES, SCRIPT, get, pair, paths, pathOf, uncached } from './lab.mjs';

const [visitors = 8, attackers = 4, seconds = 20] = process.argv.slice(2).map(Number);

const urls = await paths();
const copies = new Map();
for (const path of urls) copies.set(path, (await get(path)).body);

const { read } = await pair();
const attack = read ?? pathOf(PAGES[0]);

const count = { visitor: 0, own: 0, attacker: 0, other: 0, none: 0, hit: 0, attackerRequests: 0 };
const samples = { attacker: [], other: [] };
const end = Date.now() + seconds * 1000;

async function visitor(first) {
  for (let i = first; Date.now() < end; i++) {
    const path = urls[i % urls.length];
    const response = await get(path, 'Cookie: sid=session-of-this-visitor\r\n');
    count.visitor++;
    if (response.cache === 'HIT') count.hit++;
    const kind =
      response.status === 0
        ? 'none'
        : response.body.includes(SCRIPT)
          ? 'attacker'
          : response.status === 200 && response.body.equals(copies.get(path))
            ? 'own'
            : 'other';
    count[kind]++;
    if (samples[kind]?.length < 2) samples[kind].push({ path, response });
  }
}

async function attacker() {
  while (Date.now() < end) {
    await get(uncached(attack));
    count.attackerRequests++;
  }
}

await Promise.all([
  ...Array.from({ length: visitors }, (_, i) => visitor(i)),
  ...Array.from({ length: attackers }, attacker),
]);

const percent = ((100 * count.attacker) / Math.max(count.visitor, 1)).toFixed(1);
console.log(`${visitors} visitors, ${attackers} attacker loops on ${attack}, ${seconds} s`);
console.log(`visitor requests            ${count.visitor}`);
console.log(`  got what they asked for   ${count.own}`);
console.log(`  got the attacker's script ${count.attacker}  (${percent} %)`);
console.log(`  got something else        ${count.other}`);
console.log(`  got no response           ${count.none}`);
if (count.hit) console.log(`  answered from the cache   ${count.hit}`);
console.log(`attacker requests           ${count.attackerRequests}`);
for (const [kind, list] of Object.entries(samples)) {
  for (const { path, response } of list) {
    const headers = response.head.split('\r\n').filter((line) => /^(HTTP|content-|x-cache)/i.test(line));
    console.log(`\n${kind === 'attacker' ? 'a visitor' : 'something else:'} GET ${path}`);
    console.log(`  ${headers.join('\n  ')}\n\n  ${response.body.subarray(0, 160).toString('latin1')}`);
  }
}
// One line for fuzz.mjs.
console.log(`\nRESULT ${JSON.stringify(count)}`);
