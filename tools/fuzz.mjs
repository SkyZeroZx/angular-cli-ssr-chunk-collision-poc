// The sweep behind the numbers of REPORT.md. Runs on the host, drives docker/compose.yml, and prints
// one line per cell. The lab must be up and the pair in place (README, "Behind a proxy").
//   node tools/fuzz.mjs rtt      the round trip of the proxy-to-server link, and the two ways to send an attempt
//   node tools/fuzz.mjs pool     the proxy's upstream pool: none, one connection, many
//   node tools/fuzz.mjs load     visitors against attacker loops, no cache
//   node tools/fuzz.mjs cache    one attempt per URL, then visitors with nobody attacking
//   node tools/fuzz.mjs size     what the lost page declares; one build per cell, slow
//   node tools/fuzz.mjs chain    how many responses stand after it; one build per cell, slow
//   node tools/fuzz.mjs all      the four quick ones
// N=100 attempts a cell, SECONDS=10 for a traffic cell.
import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const N = Number(process.env.N ?? 100);
const SECONDS = Number(process.env.SECONDS ?? 10);

// What the lab is left on, and what every cell starts from: one variable moves at a time.
const base = { RTT: '300us', PROXY: 'keepalive', SIZE: String(9 * 1448), CHAIN: '1', LAB_FIX: '' };

async function compose(args, env = {}) {
  const result = await exec('docker', ['compose', '-f', 'docker/compose.yml', ...args], {
    env: { ...process.env, ...base, ...env },
    maxBuffer: 64 * 1024 * 1024,
  }).catch((error) => error);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

const flags = (env) => Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
const client = (argv, env = {}) =>
  compose(['run', '--rm', '--no-deps', ...flags(env), 'client', 'node', ...argv], env);

const take = (out, label) => {
  const line = out.match(new RegExp(`^${label} (.*)$`, 'm'));
  if (!line) throw new Error(out.trim().split('\n').slice(-6).join('\n'));
  return JSON.parse(line[1]);
};

const shots = async (env, k = 1) =>
  take(await client(['tools/attacker.mjs', 'shots', String(N), String(k)], env), 'SHOTS');
const traffic = async (env, visitors, attackers) =>
  take(
    await client(['tools/traffic.mjs', String(visitors), String(attackers), String(SECONDS)], env),
    'RESULT',
  );

// netem on the server's interface. A recreated app gets a new namespace, so this runs after it.
const link = (rtt) =>
  rtt === 'none'
    ? compose(['run', '--rm', 'link', 'tc', 'qdisc', 'del', 'dev', 'eth0', 'root'])
    : compose(['run', '--rm', 'link'], { RTT: rtt });

// A proxy that has just started has an empty cache, which is what a deployment looks like.
const proxy = (conf) => compose(['up', '-d', '--force-recreate', 'proxy'], { PROXY: conf });

// The attacker sizes the two descriptions, CI builds, the server serves what came out.
//
// The services come up first and the build runs with --no-deps, and both of those matter: store, app
// and client are one image, so a rebuilt image makes compose recreate the store when anything brings
// it up, and the store keeps its records in memory. Left to itself, `run build` restarts the store on
// its way in and `ng build` then prerenders a site the attacker was never in, which it reports as
// `14 pages, 14 chunks, 0 shared` and nothing else.
async function rebuild(env) {
  await compose(['up', '-d', 'store', 'app', 'proxy'], env);
  await client(['tools/attacker.mjs', 'signup'], env);
  await client(['tools/attacker.mjs', 'fit'], env);
  const built = await compose(['run', '--rm', '--no-deps', 'build'], env);
  await compose(['up', '-d', '--force-recreate', 'app'], env);
  await link(env.RTT ?? base.RTT);
  const checked = await client(['tools/attacker.mjs', 'check'], env);
  return {
    ok: !checked.includes('not in place'),
    note: built.match(/^\d+ pages, \d+ chunks, \d+ shared$/m)?.[0] ?? 'the build printed no count',
  };
}

const pct = (of) => (count) => `${((100 * count) / Math.max(of, 1)).toFixed(1).padStart(5)} %`;
const row = (cells) => console.log(cells.map((cell, i) => String(cell).padEnd(i ? 18 : 12)).join(''));

async function rtt() {
  console.log(`\n# One attempt, ${N} a cell: how often the next request is answered by the response\n`);
  row(['proxy', 'RTT', 'one segment', 'a connection each']);
  for (const conf of ['keepalive', 'cache']) {
    await proxy(conf);
    for (const value of ['none', '100us', '300us', '1ms', '3ms', '10ms']) {
      await link(value);
      const segment = await shots({ PROXY: conf, RTT: value });
      const serial = await shots({ PROXY: conf, RTT: value, SERIAL: '1' });
      row([conf, value, pct(N)(segment.landed), pct(N)(serial.landed)]);
    }
  }
  await link(base.RTT);
}

const poolConf = (keepalive) => `# Written by tools/fuzz.mjs for the pool axis of the sweep.
upstream app {
  server app:4000;${keepalive ? `\n  keepalive ${keepalive};` : ''}
}

server {
  listen 80;

  location / {
    proxy_pass http://app;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
  }
}
`;

// `bare` is nginx with nothing but proxy_pass, which talks HTTP/1.0 upstream and closes. The rest
// keep the connection alive as the documentation writes it, and differ only in how many of them the
// proxy holds in its pool: a pool is what puts one visitor's request on a connection the attacker
// has read from, so the two columns answer different questions.
async function pool() {
  console.log(`\n# The proxy's upstream connections: ${N} attempts, then ${SECONDS} s of visitors\n`);
  row(['upstream', 'landed', 'visitors got it', 'visitor requests']);
  for (const keepalive of ['bare', 0, 1, 2, 8, 16, 64]) {
    const conf = keepalive === 'bare' ? 'bare' : 'fuzz';
    if (conf === 'fuzz') await writeFile('docker/nginx/fuzz.conf', poolConf(keepalive));
    await proxy(conf);
    const landed = (await shots({ PROXY: conf })).landed;
    const count = await traffic({ PROXY: conf }, 8, 1);
    row([
      keepalive === 'bare' ? 'nginx default' : keepalive || 'alive, no pool',
      pct(N)(landed),
      pct(count.visitor)(count.attacker),
      count.visitor,
    ]);
  }
  await rm('docker/nginx/fuzz.conf', { force: true });
  await proxy(base.PROXY);
}

async function load() {
  console.log(`\n# Visitors and attacker loops at once, ${SECONDS} s a cell, no cache\n`);
  await proxy('keepalive');
  row(['visitors', 'attacker loops', 'got the script', 'visitor requests']);
  for (const [visitors, attackers] of [
    [8, 0],
    [8, 1],
    [8, 2],
    [8, 4],
    [8, 16],
    [8, 64],
    [1, 1],
    [32, 4],
  ]) {
    const count = await traffic({}, visitors, attackers);
    row([visitors, attackers, pct(count.visitor)(count.attacker), count.visitor]);
  }
}

async function cache() {
  console.log(`\n# One attempt per URL into an empty cache, then visitors with nobody attacking\n`);
  await proxy('cache');
  console.log((await client(['tools/attacker.mjs', 'poison'])).match(/^\/.*$/gm).join('\n'));
  const count = await traffic({ PROXY: 'cache' }, 8, 0);
  row(['', 'visitors', 'got the script', 'visitor requests']);
  row(['after', 8, pct(count.visitor)(count.attacker), count.visitor]);
  await proxy(base.PROXY);
}

async function size() {
  await proxy(base.PROXY);
  console.log(`\n# What the lost page declares, one build a cell. 1448 bytes is one segment\n`);
  row(['SIZE', 'segments', 'landed']);
  for (const segments of [4, 8, 9, 10, 11, 14, 20]) {
    const SIZE = String(segments * 1448);
    const built = await rebuild({ SIZE });
    if (!built.ok) {
      row([SIZE, segments, 'not in place', built.note]);
      continue;
    }
    row([SIZE, segments, pct(N)((await shots({ SIZE })).landed), built.note]);
  }
  await rebuild({});
}

async function chain() {
  await proxy(base.PROXY);
  console.log(`\n# Responses standing after byte SIZE, one build a cell, ${N} attempts, 4 requests each\n`);
  row(['CHAIN', 'landed of 4', 'by position']);
  for (const CHAIN of ['1', '2', '4', '8']) {
    const built = await rebuild({ CHAIN });
    if (!built.ok) {
      row([CHAIN, 'not in place', built.note]);
      continue;
    }
    const count = await shots({ CHAIN }, 4);
    row([CHAIN, pct(4 * N)(count.landed), count.at.join(' ')]);
  }
  await rebuild({});
}

const axes = { rtt, pool, load, cache, size, chain };
const asked = process.argv[2] ?? 'all';
for (const name of asked === 'all' ? ['rtt', 'pool', 'load', 'cache'] : [asked]) await axes[name]();
