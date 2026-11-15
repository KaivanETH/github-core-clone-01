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

done = true;
const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 10000))]);
check('entry exits 0 on done', code === 0, `code=${code}`);
env.close();
console.log(`passed ${passed}, failed ${failures.length}`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
