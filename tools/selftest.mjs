// Local self-test: plays the env (POST /register, GET /done), spawns `node main.ts`, drives the
// REST v3 surface, then answers done and checks the entry exits 0. Not part of the entry.
//   node tools/selftest.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'test-token-123';
const OWNER = 'alicejones';
let port = null;
let done = false;

const env = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/register') {
      port = JSON.parse(body).port;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    } else if (req.url === '/done') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ done }));
    } else res.writeHead(404).end();
  });
});
await new Promise((r) => env.listen(0, '127.0.0.1', r));
const envUrl = `http://127.0.0.1:${env.address().port}`;
const child = spawn(process.execPath, ['main.ts'], { cwd: root, env: { ...process.env, MAKEFUN_ENV_URL: envUrl, MAKEFUN_SHOP_TOKEN: TOKEN }, stdio: ['ignore', 'inherit', 'inherit'] });
const exited = new Promise((r) => child.on('exit', (code) => r(code)));
const killChild = () => { try { child.kill('SIGKILL'); } catch {} };
process.on('exit', killChild);
process.on('uncaughtException', (e) => { console.log('CRASH', e); console.log(`passed ${passed}, failed ${failures.length}`); for (const f of failures) console.log(`FAIL ${f}`); killChild(); process.exit(1); });
for (let i = 0; i < 100 && port === null; i++) await new Promise((r) => setTimeout(r, 50));
if (port === null) throw new Error('entry never registered');
const base = `http://127.0.0.1:${port}`;

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) passed++;
  else failures.push(`${name} ${detail}`);
}
async function call(method, path, { body, raw, token = TOKEN } = {}) {
  const headers = { accept: 'application/vnd.github+json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) { payload = raw; headers['content-type'] = 'application/json'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const res = await fetch(path.startsWith('http') ? path : `${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try { json = text === '' ? undefined : JSON.parse(text); } catch { json = undefined; }
  const ct = res.headers.get('content-type') ?? '';
  const rid = res.headers.get('x-github-request-id') ?? '';
  check(`${method} ${path} json+rid`, (res.status === 204 || /^application\/json/.test(ct)) && rid !== '', `ct=${ct} rid=${rid}`);
  return { status: res.status, json, headers: res.headers };
}
const b64 = (s) => Buffer.from(s).toString('base64');
const SHA = /^[0-9a-f]{40}$/;
const R = (name) => `/api/v3/repos/${OWNER}/${name}`;

// basics
let r = await fetch(`${base}/healthz`); check('healthz', r.status === 200 && (await r.json()).ok === true);
r = await call('GET', '/api/v3/'); check('root', r.status === 200 && r.headers.get('x-oauth-scopes')?.includes('repo'));
r = await call('GET', '/api/v3/meta', { token: null }); check('meta unauth 401', r.status === 401 && typeof r.json?.message === 'string');
r = await call('GET', '/api/v3/meta', { token: 'wrong' }); check('meta bad token 401', r.status === 401);
r = await call('GET', '/api/v3/meta'); check('meta', r.status === 200 && r.json.installed_version !== '');
r = await call('GET', '/api/v3/no-such-route/x'); check('unknown 404', r.status === 404 && r.json.message === 'Not Found');
r = await call('GET', '/nothing/here', { token: null }); check('unknown non-api 404', r.status === 404 && r.json.message === 'Not Found');
r = await call('POST', '/api/v3/user/repos', { raw: '{"name":' }); check('bad json 400', r.status === 400 && typeof r.json.message === 'string');

// repos + pagination (bind the owner first)
r = await call('POST', '/api/v3/user/repos', { body: { name: 'proj', private: true, description: 'd1' } });
check('repo create', r.status === 201 && r.json.name === 'proj' && r.json.private === true && r.json.default_branch === 'main');
r = await call('GET', R('proj')); check('repo get', r.status === 200 && r.json.full_name === `${OWNER}/proj` && r.json.owner.login === OWNER);
r = await call('GET', `/api/v3/repos/strangerx/proj`); check('foreign after bind 404', r.status === 404 && typeof r.json.message === 'string');
r = await call('GET', R('proj'), { token: null }); check('repo unauth 401', r.status === 401);
r = await call('POST', '/api/v3/user/repos', { body: { name: 'proj' } }); check('repo dup 422', r.status === 422);
r = await call('PATCH', R('proj'), { body: { description: 'd2' } }); check('repo patch', r.status === 200 && r.json.description === 'd2');
r = await call('GET', R('proj')); check('repo patch persists', r.json.description === 'd2');
for (let i = 0; i < 30; i++) await call('POST', '/api/v3/user/repos', { body: { name: `page-${String(i).padStart(2, '0')}`, private: true } });
const seen = [];
let next = `${base}/api/v3/user/repos?per_page=10`; let pages = 0;
while (next) {
  r = await call('GET', next); pages++;
  check('page size', r.status === 200 && r.json.length <= 10);
  seen.push(...r.json.map((x) => x.name));
  const m = /<([^>]*)>;\s*rel="next"/.exec(r.headers.get('link') ?? '');
  next = m ? m[1] : null;
  if (pages > 10) break;
}
check('pagination', pages >= 3 && new Set(seen).size === seen.length && seen.length === 31, `pages=${pages} n=${seen.length}`);
r = await call('DELETE', R('page-00')); check('repo delete 204', r.status === 204);
r = await call('GET', R('page-00')); check('repo gone 404', r.status === 404);

// contents
r = await call('PUT', `${R('proj')}/contents/docs/readme.md`, { body: { message: 'm1', content: b64('hello\n') } });
check('contents create 201', r.status === 201 && SHA.test(r.json.content.sha) && SHA.test(r.json.commit.sha), JSON.stringify(r.json)?.slice(0, 200));
const firstCommit = r.json.commit.sha; const blob1 = r.json.content.sha;
r = await call('GET', `${R('proj')}/contents/docs/readme.md`);
check('contents get', r.status === 200 && r.json.encoding === 'base64' && Buffer.from(r.json.content, 'base64').toString() === 'hello\n' && r.json.sha === blob1 && r.json.size === 6);
r = await call('GET', `${R('proj')}/contents/docs`); check('contents dir', r.status === 200 && Array.isArray(r.json) && r.json[0].name === 'readme.md');
r = await call('PUT', `${R('proj')}/contents/docs/readme.md`, { body: { message: 'm2', content: b64('hello2\n'), sha: blob1 } });
check('contents update 200', r.status === 200 && r.json.content.sha !== blob1);
r = await call('PUT', `${R('proj')}/contents/docs/readme.md`, { body: { message: 'm3', content: b64('x'), sha: blob1 } });
check('contents stale 409', r.status === 409 && typeof r.json.message === 'string');
r = await call('PUT', `${R('proj')}/contents/gone.txt`, { body: { message: 'add', content: b64('bye') } });
const goneSha = r.json.content.sha;
r = await call('DELETE', `${R('proj')}/contents/gone.txt`, { body: { message: 'rm', sha: goneSha } });
check('contents delete 200', r.status === 200 && SHA.test(r.json.commit.sha));
r = await call('GET', `${R('proj')}/contents/gone.txt`); check('contents gone 404', r.status === 404);

// branches + commits
r = await call('POST', `${R('proj')}/git/refs`, { body: { ref: 'refs/heads/feat', sha: firstCommit } });
check('ref create 201', r.status === 201 && r.json.ref === 'refs/heads/feat' && r.json.object.sha === firstCommit);
r = await call('GET', `${R('proj')}/branches`); check('branches', r.status === 200 && r.json.some((b) => b.name === 'feat' && b.commit.sha === firstCommit) && r.json.some((b) => b.name === 'main'));
r = await call('PUT', `${R('proj')}/contents/feat.txt`, { body: { message: 'feat commit', content: b64('feature\nline2\n'), branch: 'feat' } });
const featCommit = r.json.commit.sha;
r = await call('GET', `${R('proj')}/commits?sha=feat`); check('commits on branch', r.status === 200 && r.json.some((c) => c.sha === featCommit && c.commit.message === 'feat commit'));
r = await call('GET', `${R('proj')}/commits`); check('commits default excludes', r.status === 200 && !r.json.some((c) => c.sha === featCommit));

// labels + issues
r = await call('POST', `${R('proj')}/labels`, { body: { name: 'bug', color: 'ededed' } }); check('label 201', r.status === 201 && r.json.name === 'bug');
r = await call('POST', `${R('proj')}/issues`, { body: { title: 'T1', body: 'B1', labels: ['bug'] } });
check('issue 201', r.status === 201 && r.json.state === 'open' && r.json.number === 1 && r.json.labels[0].name === 'bug' && r.json.body === 'B1');
r = await call('POST', `${R('proj')}/issues`, { body: { title: 'T2', body: 'B2' } }); check('issue increments', r.json.number === 2);
r = await call('POST', `${R('proj')}/issues`, { body: { title: 'T3', labels: ['nope'] } }); check('issue bad label 422', r.status === 422 && typeof r.json.message === 'string');
r = await call('GET', `${R('proj')}/issues/1`); check('issue get', r.status === 200 && r.json.title === 'T1');
r = await call('GET', `${R('proj')}/issues/99`); check('issue get 404', r.status === 404);
r = await call('PATCH', `${R('proj')}/issues/2`, { body: { state: 'closed' } }); check('issue close', r.status === 200 && r.json.state === 'closed');
r = await call('GET', `${R('proj')}/issues?state=open`); check('issues open', r.json.length === 1 && r.json[0].number === 1);
r = await call('GET', `${R('proj')}/issues?state=all&sort=created&direction=asc`); check('issues asc', r.json.map((i) => i.number).join() === '1,2');
r = await call('GET', `${R('proj')}/issues?state=all&sort=created&direction=desc`); check('issues desc', r.json.map((i) => i.number).join() === '2,1');
r = await call('POST', `${R('proj')}/issues/1/comments`, { body: { body: 'C1' } }); check('comment 201', r.status === 201 && r.json.id >= 1 && r.json.body === 'C1');
const cid = r.json.id;
r = await call('GET', `${R('proj')}/issues/1/comments`); check('comments list', r.status === 200 && r.json.some((c) => c.id === cid));

// pulls
r = await call('POST', `${R('proj')}/pulls`, { body: { title: 'P1', body: 'PB', head: 'feat', base: 'main' } });
check('pull 201', r.status === 201 && r.json.state === 'open' && r.json.head.ref === 'feat' && r.json.base.ref === 'main' && r.json.head.sha === featCommit, JSON.stringify(r.json)?.slice(0, 300));
const pn = r.json.number;
const baseTipBefore = r.json.base.sha;
r = await call('GET', `${R('proj')}/pulls/${pn}`); check('pull get', r.status === 200 && r.json.number === pn && r.json.mergeable === true);
r = await call('GET', `${R('proj')}/pulls/999999999`); check('pull get 404', r.status === 404);
r = await call('GET', `${R('proj')}/pulls/${pn}/files`); check('pull files', r.status === 200 && r.json.length === 1 && r.json[0].filename === 'feat.txt' && r.json[0].status === 'added' && r.json[0].additions === 2);
r = await call('GET', `${R('proj')}/pulls`); check('pulls list open', r.json.some((p) => p.number === pn));
r = await call('PUT', `${R('proj')}/pulls/999999999/merge`, { body: { merge_method: 'squash' } }); check('merge 404', r.status === 404 && typeof r.json.message === 'string');
r = await call('PUT', `${R('proj')}/pulls/${pn}/merge`, { body: { merge_method: 'squash' } });
check('merge 200', r.status === 200 && r.json.merged === true && SHA.test(r.json.sha) && typeof r.json.message === 'string');
const mergeSha = r.json.sha;
r = await call('GET', `${R('proj')}/pulls/${pn}`); check('pull merged', r.json.state === 'closed' && r.json.merged === true && r.json.merged_at && r.json.merge_commit_sha === mergeSha && r.json.base.sha === baseTipBefore);
r = await call('GET', `${R('proj')}/commits?sha=main`); check('merge on main', r.json[0].sha === mergeSha);
r = await call('GET', `${R('proj')}/contents/feat.txt?ref=main`); check('merge content', r.status === 200 && Buffer.from(r.json.content, 'base64').toString() === 'feature\nline2\n');
r = await call('PUT', `${R('proj')}/pulls/${pn}/merge`, {}); check('merge again 405', r.status === 405);
r = await call('GET', `${R('proj')}/pulls`); check('pulls default open', !r.json.some((p) => p.number === pn));
r = await call('GET', `${R('proj')}/pulls?state=all`); check('pulls all', r.json.some((p) => p.number === pn));

// conflict 405
r = await call('GET', `${R('proj')}/commits?sha=main`);
const tip = r.json[0].sha;
await call('POST', `${R('proj')}/git/refs`, { body: { ref: 'refs/heads/ca', sha: tip } });
await call('POST', `${R('proj')}/git/refs`, { body: { ref: 'refs/heads/cb', sha: tip } });
r = await call('GET', `${R('proj')}/contents/docs/readme.md?ref=ca`); const cur = r.json.sha;
r = await call('PUT', `${R('proj')}/contents/docs/readme.md`, { body: { message: 'a', content: b64('A'), sha: cur, branch: 'ca' } }); check('branch update', r.status === 200);
r = await call('PUT', `${R('proj')}/contents/docs/readme.md`, { body: { message: 'b', content: b64('B'), sha: cur, branch: 'cb' } });
const pa = (await call('POST', `${R('proj')}/pulls`, { body: { title: 'A', body: '', head: 'ca', base: 'main' } })).json.number;
const pb = (await call('POST', `${R('proj')}/pulls`, { body: { title: 'B', body: '', head: 'cb', base: 'main' } })).json.number;
r = await call('PUT', `${R('proj')}/pulls/${pa}/merge`, { body: { merge_method: 'squash' } }); check('merge a 200', r.status === 200);
r = await call('PUT', `${R('proj')}/pulls/${pb}/merge`, { body: { merge_method: 'squash' } }); check('merge b 405', r.status === 405 && typeof r.json.message === 'string');
r = await call('POST', `${R('proj')}/pulls`, { body: { title: 'same', head: 'main', base: 'main' } }); check('pull head==base 422', r.status === 422);

// determinism of shas: an identical repo built the same way yields the same commit sha only if clock matches; just check 40-hex.
check('commit sha hex', SHA.test(mergeSha));

// ---------------------------------------------------------------- git smart HTTP (the kit's own client)
{
  const kit = '/root/entries/kits/github-core-clone-01/github-core-clone-01-kit/program/env/src/git-client.ts';
  const G = await import(kit);
  const gc = new G.GitClient({ baseUrl: base, token: TOKEN, timeoutMs: 8000 });
  const gc0 = new G.GitClient({ baseUrl: base, token: TOKEN, timeoutMs: 8000, gitProtocol: 0 });
  const objs = new Map();
  const put = (type, data) => { const oid = G.hashObject(type, data); objs.set(oid, { type, oid, data }); return oid; };
  const mkCommit = (files, msg, parents = [], ts = 1700000000) => {
    const tree = put('tree', G.buildTree(files.map(([name, text]) => ({ mode: '100644', name, oid: put('blob', Buffer.from(text)) }))));
    return put('commit', G.buildCommit({ tree, parents, message: `${msg}\n`, timestamp: ts }));
  };
  const reach = (tips) => [...G.collectReachable ? G.collectReachable(tips, (o) => objs.get(o)) : []].map((o) => objs.get(o));
  await call('POST', '/api/v3/user/repos', { body: { name: 'gitrepo', private: true } });
  await call('GET', R('gitrepo'));
  // empty repo: v2 advertisement, ls-refs, receive-pack advertisement, v0 headers
  let raw = await gc.infoRefs(OWNER, 'gitrepo', 'git-upload-pack');
  check('git v2 adv', raw.status === 200 && /x-git-upload-pack-advertisement/.test(raw.contentType) && raw.packets[0]?.payload?.toString() === 'version 2\n');
  raw = await gc0.infoRefs(OWNER, 'gitrepo', 'git-upload-pack');
  check('git v0 adv preamble', raw.status === 200 && raw.packets[0]?.payload?.toString() === '# service=git-upload-pack\n');
  const adv = await gc.advertisement(OWNER, 'gitrepo', 'git-receive-pack');
  check('git receive adv caps', adv.protocol === 0 && ['report-status', 'side-band-64k', 'delete-refs'].every((c) => adv.capabilities.has(c)));
  let ls = await gc.lsRefs(OWNER, 'gitrepo', {});
  check('git empty ls-refs', ls.refs.filter((r) => r.name.startsWith('refs/')).length === 0);
  const empty = await gc.clone(OWNER, 'gitrepo');
  check('git empty clone', empty.objects.size === 0);
  raw = await gc.infoRefs(OWNER, 'nope-missing', 'git-upload-pack');
  check('git missing 404', raw.status === 404 && /application\/json/.test(raw.contentType ?? ''));
  raw = await gc.infoRefs(OWNER, 'nope-missing', 'git-receive-pack');
  check('git missing 404 receive', raw.status === 404);
  const anon = await fetch(`${base}/${OWNER}/gitrepo.git/info/refs?service=git-upload-pack`);
  check('git unauth 401', anon.status === 401 && /application\/json/.test(anon.headers.get('content-type') ?? ''));
  // first push + second push + tag
  const c1 = mkCommit([['a.txt', 'one\n'], ['b.txt', 'bee\n']], 'first');
  const all = (tips) => { const out = []; const seen = new Set(); const st = [...tips]; while (st.length) { const o = st.pop(); if (seen.has(o) || !objs.has(o)) continue; seen.add(o); const ob = objs.get(o); out.push(ob); if (ob.type === 'commit') { const c = G.parseCommit(ob.data); st.push(c.tree, ...c.parents); } else if (ob.type === 'tree') st.push(...G.parseTree(ob.data).map((e) => e.oid)); else if (ob.type === 'tag') st.push(G.parseTag(ob.data).object); } return out; };
  let pr = await gc.push(OWNER, 'gitrepo', [{ oldOid: G.ZERO_OID, newOid: c1, ref: 'refs/heads/main' }], { objects: all([c1]) });
  check('git push first', pr.sideband && pr.report?.unpackOk && pr.report.refs[0]?.ok, JSON.stringify(pr.report));
  const c2 = mkCommit([['a.txt', 'one\ntwo\n'], ['b.txt', 'bee\n']], 'second', [c1], 1700000100);
  const c3 = mkCommit([['a.txt', 'one\ntwo\nthree\n'], ['b.txt', 'bee\n']], 'third', [c2], 1700000200);
  const tag = put('tag', G.buildTag({ object: c3, type: 'commit', tag: 'v1', message: 'v1\n' }));
  pr = await gc.push(OWNER, 'gitrepo', [{ oldOid: c1, newOid: c3, ref: 'refs/heads/main' }, { oldOid: G.ZERO_OID, newOid: tag, ref: 'refs/tags/v1' }], { objects: all([tag]).filter((o) => o.oid !== c1) });
  check('git push ff + tag', pr.report?.refs.every((r) => r.ok), JSON.stringify(pr.report));
  ls = await gc.lsRefs(OWNER, 'gitrepo', { peel: true, symrefs: true });
  check('git ls-refs', ls.refs.find((r) => r.name === 'HEAD')?.symrefTarget === 'refs/heads/main' && ls.refs.find((r) => r.name === 'refs/heads/main')?.oid === c3 && ls.refs.find((r) => r.name === 'refs/tags/v1')?.peeled === c3);
  const pre = await gc.lsRefs(OWNER, 'gitrepo', { prefixes: ['refs/tags/'] });
  check('git ls-refs prefix', pre.rawRefs.length === 1 && pre.rawRefs[0].name === 'refs/tags/v1');
  // full clone verifies object for object
  const cl = await gc.clone(OWNER, 'gitrepo');
  const want = all([c3, tag]);
  check('git clone objects', want.every((o) => cl.objects.get(o.oid)?.data.equals(o.data)) && cl.checksumOk, `got ${cl.objects.size} want ${want.length}`);
  // shallow
  const sh = await gc.clone(OWNER, 'gitrepo', { depth: 1 });
  check('git shallow depth1', sh.objects.has(c3) && !sh.objects.has(c2) && sh.shallow.includes(c3));
  const dp = await gc.fetch(OWNER, 'gitrepo', { wants: [c3], haves: [c3], shallow: sh.shallow, depth: 2, haveObjects: sh.objects });
  check('git deepen 2', dp.objects.has(c2) && !dp.objects.has(c1) && (dp.shallow.includes(c2) || dp.unshallow.includes(c3)));
  const inc = await gc.fetch(OWNER, 'gitrepo', { wants: [c3], haves: [c2] });
  check('git incremental', inc.objects.has(c3) && !inc.objects.has(c2) && !inc.objects.has(c1));
  const none = await gc.fetch(OWNER, 'gitrepo', { wants: [c3], haves: [c3] });
  check('git nothing new', none.objects.size === 0);
  // v0 fetch path
  const v0 = await gc0.clone(OWNER, 'gitrepo');
  check('git v0 clone', v0.objects.has(c3) && v0.objects.has(c1));
  // non-fast-forward + mixed report
  const sib = mkCommit([['a.txt', 'sibling\n']], 'sibling', [c1], 1700000300);
  const c4 = mkCommit([['a.txt', 'four\n']], 'fourth', [c3], 1700000400);
  pr = await gc.push(OWNER, 'gitrepo', [{ oldOid: G.ZERO_OID, newOid: c3, ref: 'refs/heads/side' }], { objects: [] });
  check('git create branch', pr.report?.refs[0]?.ok);
  pr = await gc.push(OWNER, 'gitrepo', [{ oldOid: c3, newOid: c4, ref: 'refs/heads/main' }, { oldOid: c3, newOid: sib, ref: 'refs/heads/side' }], { objects: [...all([c4]), ...all([sib])].filter((o) => ![c1, c2, c3].includes(o.oid)) });
  const rm = pr.report?.refs.find((r) => r.ref === 'refs/heads/main'); const rs = pr.report?.refs.find((r) => r.ref === 'refs/heads/side');
  check('git mixed report', rm?.ok === true && rs?.ok === false && /non-fast-forward/.test(rs?.reason ?? ''), JSON.stringify(pr.report));
  ls = await gc.lsRefs(OWNER, 'gitrepo', {});
  check('git ng unchanged', ls.refs.find((r) => r.name === 'refs/heads/side')?.oid === c3 && ls.refs.find((r) => r.name === 'refs/heads/main')?.oid === c4);
  pr = await gc.push(OWNER, 'gitrepo', [{ oldOid: c3, newOid: G.ZERO_OID, ref: 'refs/heads/side' }, { oldOid: tag, newOid: G.ZERO_OID, ref: 'refs/tags/v1' }]);
  ls = await gc.lsRefs(OWNER, 'gitrepo', {});
  check('git delete refs', pr.report?.refs.every((r) => r.ok) && !ls.refs.some((r) => r.name === 'refs/heads/side' || r.name === 'refs/tags/v1'));
  // REST sees pushed history
  r = await call('GET', `${R('gitrepo')}/commits`);
  check('git REST commits', r.status === 200 && r.json.map((c) => c.sha).join() === [c4, c3, c2, c1].join() && r.json[1].commit.message === 'third', JSON.stringify(r.json?.map?.((c) => c.sha)));
  r = await call('GET', `${R('gitrepo')}/contents/a.txt`);
  check('git REST contents', r.status === 200 && Buffer.from(r.json.content, 'base64').toString() === 'four\n');
  r = await call('GET', `${R('gitrepo')}/contents/b.txt?ref=${c3}`);
  check('git REST contents at sha', r.status === 200 && Buffer.from(r.json.content, 'base64').toString() === 'bee\n');
  // REST commit then clone sees it
  r = await call('PUT', `${R('gitrepo')}/contents/c.txt`, { body: { message: 'rest commit', content: b64('see\n') } });
  const restSha = r.json.commit.sha;
  const cl2 = await gc.clone(OWNER, 'gitrepo');
  check('git clone sees REST commit', cl2.objects.has(restSha) && cl2.objects.has(c4));
  // malformed body survives
  const bad = await fetch(`${base}/${OWNER}/gitrepo.git/git-upload-pack`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'git-protocol': 'version=2', 'content-type': 'application/x-git-upload-pack-request' }, body: 'zzzznot-a-pkt-line' });
  check('git malformed 400 json', bad.status === 400 && /application\/json/.test(bad.headers.get('content-type') ?? ''));
  raw = await gc.infoRefs(OWNER, 'gitrepo', 'git-upload-pack');
  check('git survives', raw.status === 200);
  // sideband framing of a large pack (several pkt-lines)
  const big = mkCommit([['big.bin', 'x'.repeat(200000) + Math.PI]], 'big', [restSha], 1700000500);
  pr = await gc.push(OWNER, 'gitrepo', [{ oldOid: restSha, newOid: big, ref: 'refs/heads/main' }], { objects: all([big]).filter((o) => o.oid === big || !cl2.objects.has(o.oid)) });
  check('git big push', pr.report?.refs[0]?.ok, JSON.stringify(pr.report));
  const bigFetch = await gc.fetch(OWNER, 'gitrepo', { wants: [big], haves: [restSha] });
  check('git big fetch', bigFetch.objects.has(big) && bigFetch.checksumOk);
}

done = true;
const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 10000))]);
check('entry exits 0 on done', code === 0, `code=${code}`);
env.close();
console.log(`passed ${passed}, failed ${failures.length}`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
