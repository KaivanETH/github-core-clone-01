// Runs the kit's own conformance check tables (program/env/src, imported read-only) against a fresh
// entry process, sequentially, and prints per-group pass counts plus every failure detail.
// Not part of the entry.   node tools/kitsuite.mjs [group ...]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = '/root/entries/kits/github-core-clone-01/github-core-clone-01-kit/program/env/src';
const envMain = await import(`${SRC}/main.ts`);
const wire = await import(`${SRC}/wire.ts`);
const graphql = await import(`${SRC}/checks-graphql.ts`);
const TOKEN = 'kit-suite-token';
const only = new Set(process.argv.slice(2));

let port = null;
let done = false;
const env = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/register') {
      port = JSON.parse(body).port;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    } else if (req.url === '/done') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ done }));
    else res.writeHead(404).end();
  });
});
await new Promise((r) => env.listen(0, '127.0.0.1', r));
const child = spawn(process.execPath, ['main.ts'], {
  cwd: root,
  env: { ...process.env, MAKEFUN_ENV_URL: `http://127.0.0.1:${env.address().port}`, MAKEFUN_SHOP_TOKEN: TOKEN },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const killChild = () => { try { child.kill('SIGKILL'); } catch {} };
process.on('exit', killChild);
for (let i = 0; i < 100 && port === null; i++) await new Promise((r) => setTimeout(r, 50));
const baseUrl = `http://127.0.0.1:${port}`;

const scenario = wire.buildScenario();
const controller = new AbortController();
graphql.configureGraphQLGit(envMain.createGitFixture({ baseUrl, token: TOKEN, signal: controller.signal, log: () => {} }));
const totals = new Map();
const failures = [];
for (const spec of envMain.suiteChecks()) {
  if (only.size > 0 && !only.has(spec.group)) continue;
  const timeoutMs = spec.timeoutMs ?? 10000;
  const context = { baseUrl, token: TOKEN, scenario, signal: controller.signal, deadlineMs: performance.now() + timeoutMs, timeoutMs, log: () => {} };
  let result;
  try {
    result = await Promise.race([spec.fn(context), new Promise((r) => setTimeout(() => r({ ok: false, detail: 'timeout' }), timeoutMs + 2000))]);
  } catch (err) {
    result = { ok: false, detail: `threw ${err?.message ?? err}` };
  }
  const t = totals.get(spec.group) ?? { pass: 0, total: 0 };
  t.total++;
  if (result.ok) t.pass++;
  else failures.push(`${spec.id}: ${result.detail}`);
  totals.set(spec.group, t);
}
for (const [group, t] of totals) console.log(`${group}: ${t.pass}/${t.total}`);
for (const f of failures) console.log(`FAIL ${f}`);
done = true;
await new Promise((r) => setTimeout(r, 300));
killChild();
env.close();
process.exit(0);
