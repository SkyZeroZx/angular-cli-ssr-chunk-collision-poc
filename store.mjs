// The record store behind the site: people sign up, then create projects under their name.
// It applies every check an application has access to. Loopback only, in memory.
//   node store.mjs
//   STORE_HOST=0.0.0.0 node store.mjs    inside the Docker lab, where the clients are other containers
import { createServer } from 'node:http';

const SLUG = /^[a-zA-Z0-9-_]+$/; // the allowlist of GHSA-w34w-96hf-98hj
const RESERVED = new Set(['legal', 'api', 'admin', 'login', 'signup', 'settings', 'assets']);

const users = [
  { name: 'alice', bio: 'I keep my notes in plain text.', website: 'https://alice.example.test/' },
  {
    name: 'acme_docs',
    bio: 'The documentation team at ACME.',
    website: 'https://acme.example.test/',
  },
  {
    name: 'kube-tools',
    bio: 'Small tools for cluster operators.',
    website: 'https://kube-tools.example.test/',
  },
  { name: 'mlopez', bio: 'PhD student, compilers.', website: 'https://mlopez.example.test/' },
];
const projects = [
  { user: 'alice', name: 'notes', description: 'Plain-text notes, synced.' },
  { user: 'alice', name: 'dotfiles', description: 'My shell and editor configuration.' },
  { user: 'acme_docs', name: 'intro', description: 'Getting started with ACME.' },
  { user: 'acme_docs', name: 'style-guide', description: 'How we write documentation.' },
  { user: 'kube-tools', name: 'lint', description: 'Checks manifests before they are applied.' },
  { user: 'mlopez', name: 'thesis', description: 'Sources of my thesis.' },
];

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const slug = (value) => typeof value === 'string' && value.length <= 39 && SLUG.test(value);

function signUp({ name, bio = '', website = '' }) {
  if (!slug(name)) throw new Error('name is not a valid slug');
  if (RESERVED.has(name.toLowerCase())) throw new Error('name is reserved');
  if (users.some((u) => same(u.name, name))) throw new Error('name is taken');
  users.push({ name, bio: String(bio), website: String(website) });
}

// `user` stands for the signed-in account; the lab has no sessions.
function createProject({ user, name, description = '' }) {
  if (!users.some((u) => u.name === user)) throw new Error('no such user');
  if (!slug(name)) throw new Error('name is not a valid slug');
  if (projects.some((p) => p.user === user && same(p.name, name))) throw new Error('name is taken');
  projects.push({ user, name, description: String(description) });
}

// The owner edits the text of a record. Names do not change.
function edit(record, changes) {
  for (const field of ['bio', 'website', 'description']) {
    if (field in record && typeof changes[field] === 'string') record[field] = changes[field];
  }
}

const read = (path) => {
  const [what, a, b] = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (what === 'users') return a ? users.find((u) => u.name === a) : users;
  if (what === 'projects') return a ? projects.find((p) => p.user === a && p.name === b) : projects;
};

createServer(async (request, response) => {
  const send = (status, body) =>
    response
      .writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      .end(JSON.stringify(body));
  const { pathname } = new URL(request.url, 'http://store');
  const found = read(pathname);

  if (request.method === 'GET') {
    return found ? send(200, found) : send(404, { error: 'not found' });
  }
  try {
    const body = JSON.parse(Buffer.concat(await request.toArray()).toString());
    if (request.method === 'POST' && (pathname === '/users' || pathname === '/projects')) {
      (pathname === '/users' ? signUp : createProject)(body);
      return send(201, body);
    }
    if (request.method === 'PUT' && found && !Array.isArray(found)) {
      edit(found, body);
      return send(200, found);
    }
  } catch (error) {
    return send(400, { error: error.message });
  }
  return send(404, { error: 'not found' });
}).listen(4400, process.env.STORE_HOST ?? '127.0.0.1', () => console.log('record store on port 4400'));
