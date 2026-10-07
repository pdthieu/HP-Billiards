// Reconnect scenarios for the pool client against a running server.
const { chromium } = require('playwright');
const flat = require('./flat');
const path = require('path');
const base = process.argv[2] || 'http://127.0.0.1:18080';
const shots = path.join(__dirname, 'shots');
require('fs').mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fail(msg) { console.error('FAIL:', msg); process.exit(1); }
const state = (page) => page.evaluate(() => ({
  seat: S.seat, phase: S.phase, turn: S.turn, moving: S.moving, token: S.token,
  players: S.players, attempt: S.reconnectAttempt, snaps: S.snaps.length,
  balls: [...S.balls.entries()].map(([id, p]) => ({ id, ...p })),
  status: document.getElementById('status').textContent,
  overlay: !document.getElementById('disconnected').hidden,
  overlayText: document.getElementById('disconnectedText').textContent,
  landing: !document.getElementById('landing').hidden,
  landingError: document.getElementById('landingError').textContent,
  waitText: document.getElementById('waitText').textContent,
  seat1: document.getElementById('seat1').textContent,
}));
async function waitFor(page, pred, what, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const s = await state(page); if (pred(s)) return s; await sleep(50); }
  fail(`timeout: ${what}: ${JSON.stringify(await state(page))}`);
}
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const mk = async () => {
    const page = await (await flat(browser, { viewport: { width: 900, height: 650 } })).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    return page;
  };
  const A = await mk(), B = await mk();
  await A.goto(base + '/'); await A.fill('#name', 'Ann'); await A.click('#create');
  await A.waitForFunction(() => document.getElementById('landing').hidden);
  const code = await A.textContent('#roomCode');
  await B.goto(`${base}/?room=${code}`); await B.fill('#name', 'Bob'); await B.click('#join');
  await B.waitForFunction(() => document.getElementById('landing').hidden);
  await A.click('#ready'); await B.click('#ready');
  await waitFor(A, (s) => s.phase === 'breaking', 'breaking');
  const sb = await waitFor(B, (s) => s.phase === 'breaking', 'breaking on B');
  const tokenB = sb.token;
  if (!/^[0-9a-f]{32}$/.test(tokenB)) fail(`token ${tokenB}`);

  // 1. Reload B: the tab rejoins its seat with the stored token, no landing form.
  await B.reload();
  const r1 = await waitFor(B, (s) => s.phase === 'breaking' && s.seat === 1 && !s.overlay && !s.landing, 'B rejoined after reload');
  if (r1.token !== tokenB) fail('token changed after reload');
  const a1 = await waitFor(A, (s) => s.players[1].connected && s.players[1].name === 'Bob', 'A sees Bob back');
  if (!a1.status.includes('lost connection')) fail(`A status after Bob dropped: ${a1.status}`);
  if (a1.phase !== 'breaking') fail('game was abandoned by a reload');
  console.log('reload rejoin ok');

  // 2. Kill B's socket from inside the page: automatic reconnect.
  // an instant reconnect never shows the card (it appears only after 300 ms offline)
  const tokenBefore = await B.evaluate(() => S.token);
  await B.evaluate(() => { S._wsClosedAt = performance.now(); S.ws.close(); });
  const r2 = await waitFor(B, (s) => !s.overlay && s.seat === 1 && s.phase === 'breaking' && s.attempt === 0 && s.token === tokenBefore, 'auto reconnect');
  if (r2.overlay) fail('card shown for an instant reconnect');
  // a slow reconnect shows the card with the retry strip
  await B.evaluate(() => {
    window._RealWS = window.WebSocket;
    window.WebSocket = class { constructor() { this.readyState = 0; setTimeout(() => this.onclose && this.onclose({ code: 1006, reason: '' }), 100); } send() {} close() {} };
    S.ws.close();
  });
  await waitFor(B, (s) => s.overlay && /Reconnecting/.test(s.overlayText), 'card while offline', 3000);
  const meta = await B.evaluate(() => document.getElementById('retryTry').textContent);
  if (!/Try \d/.test(meta)) fail(`retry meta: ${meta}`);
  await B.evaluate(() => { window.WebSocket = window._RealWS; });
  await B.click('#rejoin');
  await waitFor(B, (s) => !s.overlay && s.seat === 1 && s.phase === 'breaking' && s.attempt === 0, 'reconnect after retry now');
  await waitFor(A, (s) => s.players[1].connected, 'A sees Bob back again');
  console.log('auto reconnect ok');

  // 3. Reload the watcher while balls are rolling: it resumes mid-shot and
  //    ends with the same positions.
  const breaker = (await state(A)).turn === 0 ? A : B;
  const watcher = breaker === A ? B : A;
  await breaker.evaluate(() => { setAngle(0); setPower(1); });
  await breaker.keyboard.press('Enter');
  await waitFor(watcher, (s) => s.moving, 'watcher sees the shot');
  await watcher.reload();
  const mid = await waitFor(watcher, (s) => !s.landing && !s.overlay && s.seat >= 0, 'watcher rejoined during the shot');
  console.log('rejoined mid-shot, moving =', mid.moving, 'snaps =', mid.snaps);
  const e1 = await waitFor(breaker, (s) => !s.moving && s.phase !== 'breaking', 'break settled', 30000);
  const e2 = await waitFor(watcher, (s) => !s.moving && s.phase !== 'breaking', 'break settled on watcher', 5000);
  if (JSON.stringify(e1.balls) !== JSON.stringify(e2.balls)) fail('positions differ after a mid-shot reconnect');
  if (e2.status === '') fail('watcher has no shot summary after reconnecting');
  await watcher.screenshot({ path: path.join(shots, '9-after-midshot-reconnect.png') });
  console.log('mid-shot reconnect ok:', e2.status);

  // 4. A third tab without a token gets the landing form and room_full.
  const C = await mk();
  await C.goto(`${base}/?room=${code}`);
  await sleep(300);
  if (!(await state(C)).landing) fail('third tab auto-joined without a token');
  await C.fill('#name', 'Cat'); await C.click('#join');
  const c1 = await waitFor(C, (s) => s.landing && s.landingError !== '', 'room_full shown on landing', 5000);
  if (!/full/.test(c1.landingError)) fail(`landing error: ${c1.landingError}`);
  console.log('third tab refused:', c1.landingError);

  // 5. Leave on B: back to the landing page; A sees the seat held (offline).
  // drop with reconnects failing, then leave from the card
  await B.evaluate(() => {
    window._RealWS = window.WebSocket;
    window.WebSocket = class { constructor() { this.readyState = 0; setTimeout(() => this.onclose && this.onclose({ code: 1006, reason: '' }), 100); } send() {} close() {} };
    S.ws.close();
  });
  await waitFor(B, (s) => s.overlay, 'overlay', 3000);
  await B.evaluate(() => { window.WebSocket = window._RealWS; });
  await B.click('#leave');
  const l = await waitFor(B, (s) => s.landing && s.seat < 0, 'B on landing after leave', 3000);
  if (l.overlay) fail('overlay still shown after leave');
  const aHeld = await waitFor(A, (s) => s.players[1].name === 'Bob' && !s.players[1].connected, 'A sees Bob offline');
  if (!/offline/.test(aHeld.seat1)) fail(`seat card: ${aHeld.seat1}`);
  if (!/reconnect/.test(aHeld.waitText) && !aHeld.status.includes('held')) fail(`A texts: ${aHeld.waitText} / ${aHeld.status}`);
  await A.screenshot({ path: path.join(shots, '10-opponent-offline.png') });
  // B's session was cleared: reopening the link shows the landing form.
  await B.goto(`${base}/?room=${code}`);
  await sleep(300);
  if (!(await state(B)).landing) fail('B auto-rejoined after leaving');
  console.log('leave ok');

  if (errors.length) fail(errors.join('\n'));
  console.log('OK');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
