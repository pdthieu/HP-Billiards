// 9-ball: picking the game on the landing page and in the lobby, the
// diamond rack, the break and a push out answered with "pass it back".
// Usage: node nine.js <base>
const { chromium } = require('playwright');
const path = require('path');

const base = process.argv[2] || 'http://127.0.0.1:18080';
const shots = path.join(__dirname, 'shots');
require('fs').mkdirSync(shots, { recursive: true });

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
const st = (page) => page.evaluate(() => ({
  mode: S.mode, phase: S.phase, turn: S.turn, seat: S.seat, moving: S.moving, balls: S.balls.size,
  pushOut: S.pushOut, decision: S.decision, callText: document.getElementById('callText').textContent,
}));

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const mk = async (viewport) => {
    const page = await (await browser.newContext({ viewport })).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    return page;
  };
  const A = await mk({ width: 1100, height: 700 });
  const B = await mk({ width: 390, height: 800 });
  try {
    await A.goto(base + '/');
    await A.click('#landingMode [data-mode="9ball"]');
    await A.fill('#name', 'Ann');
    await A.click('#create');
    await A.waitForFunction(() => document.getElementById('landing').hidden && S.mode === '9ball');
    const code = await A.textContent('#roomCode');
    if ((await A.textContent('#roomEyebrow')) !== '9-ball room') fail(`eyebrow ${await A.textContent('#roomEyebrow')}`);

    // The room list names the game.
    const L = await mk({ width: 800, height: 700 });
    await L.goto(base + '/');
    await L.waitForFunction((c) => !!document.querySelector(`li.room-row[data-code="${c}"]`), code);
    const listed = await L.textContent(`li.room-row[data-code="${code}"] .chip__text`);
    if (!listed.startsWith('9-ball')) fail(`room list chip ${listed}`);
    await L.close();
    console.log('landing and room list ok');

    await B.goto(`${base}/?room=${code}`);
    await B.fill('#name', 'Bob');
    await B.click('#join');
    await B.waitForFunction(() => document.getElementById('landing').hidden && S.mode === '9ball');

    // Switching in the lobby reaches both players.
    await A.waitForFunction(() => document.getElementById('seat1').textContent.includes('Bob'));
    await A.click('#settingsBtn');
    await A.click('#settingsMode [data-mode="8ball"]');
    await A.click('#settingsClose');
    await B.waitForFunction(() => S.mode === '8ball');
    await B.click('#settingsBtn');
    await B.click('#settingsMode [data-mode="9ball"]');
    await B.click('#settingsClose');
    await A.waitForFunction(() => S.mode === '9ball' && S.balls.size === 10);
    await B.waitForFunction(() => S.balls.size === 10);
    await B.screenshot({ path: path.join(shots, 'nine-lobby-B.png') });
    console.log('lobby switch ok');

    await A.click('#ready');
    await B.click('#ready');
    await A.waitForFunction(() => S.phase === 'breaking');
    const a0 = await st(A);
    if (a0.balls !== 10) fail(`${a0.balls} balls in a 9-ball rack`);
    const breaker = a0.turn === a0.seat ? A : B;
    await breaker.waitForFunction(() => !document.getElementById('shotPanel').hidden);
    if (!(await st(breaker)).callText.startsWith('Break: hit the 1')) fail(`break line: ${(await st(breaker)).callText}`);
    await A.screenshot({ path: path.join(shots, 'nine-rack-A.png') });

    await breaker.evaluate(() => { setAngle(0); setPower(1); shoot(); });
    for (const p of [A, B]) await p.waitForFunction(() => S.phase !== 'breaking' && !S.moving, null, { timeout: 20000 });
    const after = await st(A);
    if (after.phase !== 'open') fail(`after the break: ${JSON.stringify(after)}`);
    if (!after.pushOut) fail('no push out after the break');
    const shooter = after.turn === after.seat ? A : B;
    const other = shooter === A ? B : A;
    const shooterSeat = after.turn;
    console.log('break ok:', (await A.textContent('#status')).trim().split('\n').pop().trim());

    await shooter.waitForFunction(() => !document.getElementById('pushOut').hidden);
    await shooter.click('#pushOut');
    if (!(await st(shooter)).callText.startsWith('Push out')) fail(`push out line: ${(await st(shooter)).callText}`);
    await A.screenshot({ path: path.join(shots, 'nine-pushout-A.png') });
    await B.screenshot({ path: path.join(shots, 'nine-pushout-B.png') });
    await shooter.evaluate(() => { setAngle(Math.PI / 2); setPower(0.02); shoot(); });

    await other.waitForFunction(() => !document.getElementById('decision').hidden, null, { timeout: 15000 });
    if ((await other.textContent('#decisionTitle')) !== 'Push out') fail(`decision title ${await other.textContent('#decisionTitle')}`);
    await other.screenshot({ path: path.join(shots, 'nine-decision.png') });
    await other.click('.option:has-text("Pass it back")');
    for (const p of [A, B]) {
      await p.waitForFunction((s) => S.turn === s && !S.decision && !S.pushOut, shooterSeat, { timeout: 5000 });
    }
    console.log('push out and pass back ok');
    if (errors.length) fail(`page errors: ${errors.join('; ')}`);
    console.log('OK');
  } finally {
    await browser.close();
  }
})().catch((e) => { if (!process.exitCode) { console.error(e); process.exitCode = 1; } });
