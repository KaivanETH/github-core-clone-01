// Runs the kit's own benchmark (program/env/src/bench.ts runBenchmark, imported read-only) against a
// fresh entry process and prints each workload's rounds, p50 and points. Not part of the entry.
//   node tools/bench-local.mjs [workload ...]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = '/root/entries/kits/github-core-clone-01/github-core-clone-01-kit/program/env/src';
const envMain = await import(`${SRC}/main.ts`);
const wire = await import(`${SRC}/wire.ts`);
const bench = await import(`${SRC}/bench.ts`);
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
const child = spawn(process.execPath, [...(process.env.PROF ? ['--cpu-prof', '--cpu-prof-dir=' + process.env.PROF] : []), 'main.ts'], {
  cwd: root,
  env: { ...process.env, MAKEFUN_ENV_URL: `http://127.0.0.1:${env.address().port}`, MAKEFUN_SHOP_TOKEN: TOKEN },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const killChild = () => { try { child.kill('SIGKILL'); } catch {} };
process.on('exit', killChild);
for (let i = 0; i < 100 && port === null; i++) await new Promise((r) => setTimeout(r, 50));
const baseUrl = `http://127.0.0.1:${port}`;

const workloads = process.argv.slice(2);
const perf = await bench.runBenchmark({ baseUrl, token: TOKEN, log: () => {}, ...(workloads.length ? { workloads } : {}) });
for (const w of perf.workloads) console.log(`${w.name}: p50 ${w.p50_ms} ms rounds ${JSON.stringify(w.rounds)} points ${w.points}${w.error ? ` ERROR ${w.error}` : ''}`);
console.log(`points_total ${perf.points_total} perf_p50_us ${perf.perf_p50_us}`);
done = true;
await Promise.race([new Promise((r) => child.on('exit', r)), new Promise((r) => setTimeout(r, 5000))]);
killChild();
env.close();
process.exit(0);
