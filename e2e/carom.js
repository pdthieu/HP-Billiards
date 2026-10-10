// 3-cushion: picking the game and its points on the landing page, the
// carom table and the opening position, a point on the break, the
// equalizing inning and the end of the game.
// Usage: node carom.js <base>
const { chromium } = require('playwright');
const flat = require('./flat');
const path = require('path');

const base = process.argv[2] || 'http://127.0.0.1:18080';
const shots = path.join(__dirname, 'shots');
require('fs').mkdirSync(shots, { recursive: true });

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
const st = (page) => page.evaluate(() => ({
  mode: S.mode, phase: S.phase, turn: S.turn, seat: S.seat, moving: S.moving, balls: S.balls.size,
  carom: S.carom, target: S.target, winner: S.winner, W, pockets: POCKETS.length,
  callText: document.getElementById('callText').textContent, status: document.querySelector('#status .status__layer.is-active').textContent.trim(),
}));

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const mk = async (viewport) => {
    const page = await (await flat(browser, { viewport })).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    return page;
  };
  const A = await mk({ width: 1100, height: 700 });
  const B = await mk({ width: 390, height: 800 });
  try {
    // The landing picker asks for points, and leaves out the break rule.
    await A.goto(base + '/');
    await A.click('#landingMode [data-mode="3cushion"]');
    if (!(await A.isHidden('#landingTableField'))) fail('a pool table offered for 3-cushion');
    await A.click('#landingOptsBtn'); // the match rules fold under a summary
    if ((await A.textContent('#landingMatch .js-race-label')) !== 'Points') fail('no points picker');
    if (!(await A.isHidden('#landingMatch .js-breaks'))) fail('break rule shown for 3-cushion');
    await A.fill('#landingMatch .js-race-input', '1');
    await A.press('#landingMatch .js-race-input', 'Tab');
    await A.fill('#name', 'Ann');
    await A.click('#create');
    await A.waitForFunction(() => document.getElementById('landing').hidden && S.mode === '3cushion');
    const code = await A.textContent('#roomCode');
    if ((await A.textContent('#roomEyebrow')) !== '3-cushion room') fail(`eyebrow ${await A.textContent('#roomEyebrow')}`);
    const lobby = await st(A);
    if (lobby.balls !== 3 || lobby.pockets !== 0 || Math.abs(lobby.W - 2.84) > 1e-9) fail(`carom table: ${JSON.stringify(lobby)}`);

    const L = await mk({ width: 800, height: 700 });
    await L.goto(base + '/');
    await L.waitForFunction((c) => !!document.querySelector(`li.room-row[data-code="${c}"]`), code);
    const listed = await L.textContent(`li.room-row[data-code="${code}"] .chip__text`);
    if (!listed.startsWith('3-cushion · to 1')) fail(`room list chip ${listed}`);
    await L.close();
    console.log('landing and room list ok');

    await B.goto(`${base}/?room=${code}`);
    await B.fill('#name', 'Bob');
    await B.click('#join');
    await B.waitForFunction(() => document.getElementById('landing').hidden && S.mode === '3cushion' && S.balls.size === 3);
    await A.waitForFunction(() => document.getElementById('seat1').textContent.includes('Bob'));
    await A.click('#ready');
    await B.click('#ready');
    for (const p of [A, B]) await p.waitForFunction(() => S.phase === 'breaking' && !!S.carom);
    const a0 = await st(A);
    if (a0.target !== 1 || a0.carom.cue[a0.turn] !== 0) fail(`the breaker plays the white: ${JSON.stringify(a0)}`);
    const breaker = a0.turn === a0.seat ? A : B;
    const other = breaker === A ? B : A;
    await breaker.waitForFunction(() => !document.getElementById('shotPanel').hidden);
    if (!(await st(breaker)).callText.startsWith('Break with the white')) fail(`break line: ${(await st(breaker)).callText}`);
    await A.screenshot({ path: path.join(shots, 'carom-break-A.png') });
    await B.screenshot({ path: path.join(shots, 'carom-break-B.png') });

    // A break that scores (found with the server's physics): the red, three
    // cushions, the yellow. The white starts on either side of the yellow.
    await breaker.evaluate(() => {
      const w = S.balls.get(0);
      setAngle(w.y > H / 2 ? 0.519235 : -0.519235);
      setPower(0.4);
      S.spin = { x: 0, y: 0.3 };
      shoot();
    });
    for (const p of [A, B]) await p.waitForFunction(() => S.phase === 'open' && !S.moving, null, { timeout: 30000 });
    const after = await st(other);
    if (after.carom.points[a0.turn] !== 1 || !after.carom.equalizing || after.turn === a0.turn) fail(`after the break: ${JSON.stringify(after)}`);
    if (!after.status.startsWith('Point! 3 cushions.')) fail(`status: ${after.status}`);
    await other.waitForFunction(() => !document.getElementById('shotPanel').hidden);
    if (!(await st(other)).callText.startsWith('Last inning')) fail(`equalizing line: ${(await st(other)).callText}`);
    if ((await other.evaluate(() => cueId())) !== 1) fail('the other player does not strike the yellow');
    console.log('point on the break ok:', after.status);

    // The equalizing inning, missed: the breaker wins.
    await other.evaluate(() => { setAngle(Math.PI / 2); setPower(0.03); shoot(); });
    for (const p of [A, B]) await p.waitForFunction(() => S.phase === 'game_over', null, { timeout: 15000 });
    const end = await st(A);
    if (end.winner !== a0.turn) fail(`winner ${end.winner}, want the breaker ${a0.turn}`);
    const result = await A.textContent('.result');
    const score = a0.turn === 0 ? '1–0' : '0–1';
    if (!/wins? the game/.test(result) || !result.includes(`${score} in 1 inning`)) fail(`result: ${result}`);
    await A.screenshot({ path: path.join(shots, 'carom-over-A.png') });
    await B.screenshot({ path: path.join(shots, 'carom-over-B.png') });
    console.log('equalizing inning and game over ok:', result);
    if (errors.length) fail(`page errors: ${errors.join('; ')}`);
    console.log('OK');
  } finally {
    await browser.close();
  }
})().catch((e) => { if (!process.exitCode) { console.error(e); process.exitCode = 1; } });
