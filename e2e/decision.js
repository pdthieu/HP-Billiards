// Forces an illegal break (soft tap) and checks the decision dialog.
const { chromium } = require('playwright');
const flat = require('./flat');
const path = require('path');
const base = process.argv[2] || 'http://127.0.0.1:18080';
const shots = path.join(__dirname, 'shots');
require('fs').mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fail(msg) { console.error('FAIL:', msg); process.exit(1); }
const state = (page) => page.evaluate(() => ({
  seat: S.seat, phase: S.phase, turn: S.turn, moving: S.moving, decision: S.decision,
  status: document.getElementById('status').textContent,
  decisionShown: !document.getElementById('decision').hidden,
  waitText: document.getElementById('waitText').textContent,
  title: document.getElementById('decisionTitle').textContent,
  options: [...document.querySelectorAll('#decisionOptions button .option__title')].map((b) => b.textContent),
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
  const sa = await waitFor(A, (s) => s.phase === 'breaking', 'breaking');
  const breaker = sa.turn === sa.seat ? A : B, other = breaker === A ? B : A;
  await waitFor(breaker, (s) => s.phase === 'breaking' && !s.moving && s.turn === s.seat, 'breaker ready');
  // soft tap straight at the rack: nothing pocketed, no rails -> illegal break
  await breaker.evaluate(() => { setAngle(0); setPower(0.12); });
  await breaker.keyboard.press('Enter');
  await waitFor(breaker, (s) => s.moving, 'moving');
  const sb = await waitFor(breaker, (s) => !s.moving, 'settled', 30000);
  if (!sb.decision) fail(`expected a decision, got ${JSON.stringify(sb)}`);
  if (sb.decision.seat !== (await state(other)).seat) fail('decision should go to the opponent');
  if (!/Illegal break|broke illegally/.test(sb.status)) fail(`status: ${sb.status}`);
  if (!sb.waitText.includes('to decide')) fail(`wait text: ${sb.waitText}`);
  const so = await waitFor(other, (s) => s.decisionShown, 'dialog on the chooser');
  if (so.title !== 'Illegal break') fail(`title ${so.title}`);
  if (so.options.length !== 3) fail(`options ${so.options}`);
  if (await other.evaluate(() => document.activeElement && document.activeElement.classList.contains('option')) !== true) fail('first option not focused');
  const bannerText = await breaker.evaluate(() => { const b = document.querySelector('#tableWrap .banner'); return b ? b.textContent : ''; });
  if (!/to decide/.test(bannerText)) fail(`banner on the breaker: ${bannerText}`);
  console.log('dialog:', so.title, '|', so.options.join(' / '));
  await other.screenshot({ path: path.join(shots, '8-decision.png') });
  // the breaker cannot shoot while the decision is pending
  await breaker.evaluate(() => send({ type: 'shoot', angle: 0, power: 0.5 }));
  await sleep(300);
  if ((await state(breaker)).moving) fail('shot accepted during a decision');
  // choose: re-rack, chooser breaks
  await other.click('#decisionOptions button:nth-child(2)');
  const r = await waitFor(other, (s) => s.phase === 'breaking' && !s.decision, 're-rack');
  if (r.turn !== r.seat) fail('chooser should break after rerack_break');
  await waitFor(breaker, (s) => s.phase === 'breaking' && !s.decision && !s.decisionShown, 're-rack on breaker');
  console.log('re-rack ok, breaker is now the chooser');
  if (errors.length) fail(errors.join('\n'));
  console.log('OK');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
