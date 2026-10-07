// Measures on-screen ball motion: per-frame displacement of balls while a shot
// plays, and snapshot arrival jitter. Also screenshots pockets at rest.
const { chromium } = require('playwright');
const flat = require('./flat');
const path = require('path');
const base = process.argv[2] || 'http://127.0.0.1:18080';
const power = parseFloat(process.argv[3] || '0.35');
const shots = path.join(__dirname, 'shots');
require('fs').mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch();
  const mk = async (vp) => (await flat(browser, { viewport: vp })).newPage();
  const A = await mk({ width: 1100, height: 700 }), B = await mk({ width: 1100, height: 700 });
  await A.goto(base + '/'); await A.fill('#name', 'Ann'); await A.click('#create');
  await A.waitForFunction(() => document.getElementById('landing').hidden);
  const code = await A.textContent('#roomCode');
  await B.goto(`${base}/?room=${code}`); await B.fill('#name', 'Bob'); await B.click('#join');
  await B.waitForFunction(() => document.getElementById('landing').hidden);
  await A.click('#ready'); await B.click('#ready');
  await A.waitForFunction(() => S.phase === 'breaking');
  await sleep(400);
  await A.screenshot({ path: path.join(shots, 'm-table.png') });
  // zoomed pocket crops
  const pt = await A.evaluate(() => {
    const rect = canvas.getBoundingClientRect();
    const f = (x, y) => ({ x: rect.left + view.ox + x * view.s, y: rect.top + view.oy + y * view.s });
    return { corner: f(0, 0), side: f(W / 2, 0), s: view.s };
  });
  await A.screenshot({ path: path.join(shots, 'm-corner.png'), clip: { x: pt.corner.x - 60, y: pt.corner.y - 60, width: 160, height: 160 } });
  await A.screenshot({ path: path.join(shots, 'm-side.png'), clip: { x: pt.side.x - 90, y: pt.side.y - 60, width: 180, height: 140 } });
  console.log('scale px/m', pt.s.toFixed(1));

  const breaker = (await A.evaluate(() => S.turn === S.seat)) ? A : B;
  const watcher = breaker === A ? B : A;
  for (const p of [breaker, watcher]) {
    await p.evaluate(() => {
      window.__frames = []; window.__snaps = [];
      const orig = window.onSnapshot;
      window.onSnapshot = (msg) => { window.__snaps.push({ arr: performance.now(), t: msg.t, n: msg.balls.length }); return orig(msg); };
      const loop = () => {
        const b = displayBalls();
        const c = b.get(0), o = b.get(1);
        window.__frames.push({ now: performance.now(), c: c && [c.x, c.y], o: o && [o.x, o.y], moving: S.moving, n: S.snaps.length });
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
  }
  // aim straight at the apex ball and shoot
  await breaker.evaluate((pw) => { const c = S.balls.get(0), a = S.balls.get(1); setAngle(Math.atan2(a.y - c.y, a.x - c.x)); setPower(pw); }, power);
  await breaker.keyboard.press('Enter');
  await breaker.waitForFunction(() => S.moving);
  const t0 = Date.now();
  await breaker.waitForFunction(() => !S.moving, null, { timeout: 60000 });
  console.log('shot lasted ms', Date.now() - t0);
  for (const [name, p] of [['breaker', breaker], ['watcher', watcher]]) {
    const { frames, snaps } = await p.evaluate(() => ({ frames: window.__frames, snaps: window.__snaps }));
    const mv = frames.filter((f) => f.moving);
    // arrival jitter: arr - arr0 - t
    const a0 = snaps[0].arr;
    const jit = snaps.map((s) => s.arr - a0 - s.t);
    const gaps = []; for (let i = 1; i < snaps.length; i++) gaps.push(snaps[i].t - snaps[i - 1].t);
    console.log(`\n[${name}] snapshots ${snaps.length}, t gaps unique: ${[...new Set(gaps)].join(',')}; arrival-minus-simtime min/max ms: ${Math.min(...jit).toFixed(0)}/${Math.max(...jit).toFixed(0)}`);
    // per-frame speed of the cue ball and ball 1
    const rows = [];
    for (let i = 1; i < mv.length; i++) {
      const a = mv[i - 1], b = mv[i];
      const dt = (b.now - a.now) / 1000;
      const sp = (p, q) => (p && q ? Math.hypot(q[0] - p[0], q[1] - p[1]) / dt : NaN);
      rows.push({ t: b.now - mv[0].now, dt: dt * 1000, vc: sp(a.c, b.c), vo: sp(a.o, b.o), n: b.n });
    }
    // summarise: stalls (v==0 mid-motion), big frame-to-frame ratio changes
    let stalls = 0, spikes = 0;
    for (let i = 1; i < rows.length - 1; i++) {
      const r = rows[i];
      if (r.vc === 0 && rows[i - 1].vc > 0.05 && rows.slice(i + 1, i + 30).some((x) => x.vc > 0.05)) stalls++;
      if (r.vc > 0.05 && rows[i - 1].vc > 0.05 && (r.vc / rows[i - 1].vc > 1.6 || rows[i - 1].vc / r.vc > 1.6)) spikes++;
    }
    console.log(`frames ${rows.length}, mean dt ${(rows.reduce((s, r) => s + r.dt, 0) / rows.length).toFixed(1)} ms, cue stalls ${stalls}, cue speed spikes ${spikes}`);
    // print a downsampled speed profile (every 6 frames)
    const line = rows.filter((_, i) => i % 6 === 0).map((r) => `${(r.t / 1000).toFixed(2)}:${r.vc.toFixed(2)}`).join(' ');
    console.log('cue speed m/s by time:', line);
    const line2 = rows.filter((_, i) => i % 6 === 0).map((r) => `${(r.t / 1000).toFixed(2)}:${r.vo.toFixed(2)}`).join(' ');
    console.log('ball1 speed m/s by time:', line2);
    // detail of first 40 frames
    console.log('ball1 tail m/s per frame:', rows.filter((r) => r.t > 900 && r.t < 1700).map((r) => r.vo.toFixed(3)).join(' '));
    console.log('first frames dt/vc/n:', rows.slice(0, 40).map((r) => `${r.dt.toFixed(0)}/${r.vc.toFixed(2)}/${r.n}`).join(' '));
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
