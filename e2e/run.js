// Builds the server, starts three instances (a normal one, one limited to a
// single room and one with a short shot clock) on free ports, runs the
// browser scenarios against them and stops everything.
// Usage: node run.js [scenario ...]
//
// Needs Node, Go and a Playwright Chromium (`npx playwright install chromium`).
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

const repo = path.join(__dirname, '..');
const scenarios = process.argv.length > 2 ? process.argv.slice(2) : ['landing', 'smoke', 'decision', 'reconnect', 'clock'];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitFor(url, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server at ${url} did not come up`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billiards-e2e-'));
  const bin = path.join(dir, 'server');
  const build = spawnSync('go', ['build', '-o', bin, './cmd/server'], { cwd: repo, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);

  const [p1, p2, p3] = [await freePort(), await freePort(), await freePort()];
  const servers = [
    spawn(bin, ['-addr', `127.0.0.1:${p1}`, '-max-rooms', '50'], { stdio: ['ignore', 'ignore', 'inherit'] }),
    spawn(bin, ['-addr', `127.0.0.1:${p2}`, '-max-rooms', '1'], { stdio: ['ignore', 'ignore', 'inherit'] }),
    spawn(bin, ['-addr', `127.0.0.1:${p3}`, '-shot-clock', '11s', '-shot-clock-long', '13s'], { stdio: ['ignore', 'ignore', 'inherit'] }),
  ];
  const stop = () => { for (const s of servers) s.kill(); fs.rmSync(dir, { recursive: true, force: true }); };
  process.on('SIGINT', () => { stop(); process.exit(130); });

  const base = `http://127.0.0.1:${p1}`, limited = `http://127.0.0.1:${p2}`, quick = `http://127.0.0.1:${p3}`;
  let failed = 0;
  try {
    await waitFor(base + '/');
    await waitFor(limited + '/');
    await waitFor(quick + '/');
    for (const name of scenarios) {
      console.log(`\n--- ${name}`);
      const code = await run(process.execPath, [path.join(__dirname, `${name}.js`), base, limited, quick]);
      if (code !== 0) { failed++; console.error(`--- ${name} FAILED (exit ${code})`); }
    }
  } finally {
    stop();
  }
  console.log(failed ? `\n${failed} scenario(s) failed` : '\nall scenarios passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
