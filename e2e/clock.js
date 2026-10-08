// The shot clock: the ring on the shooter's seat, the low-time warning, the
// extension and the time foul. Needs a server started with
// -shot-clock 11s -shot-clock-long 13s (run.js passes it as the third URL).
// Usage: node clock.js <base> <limited> <quick>
const { chromium } = require('playwright');
const flat = require('./flat');
const path = require('path');

const base = process.argv[4] || 'http://127.0.0.1:18082';
const shots = path.join(__dirname, 'shots');
require('fs').mkdirSync(shots, { recursive: true });

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }

async function ring(page, seat) {
  return page.evaluate((seat) => {
    const r = document.querySelector(`#seat${seat} .hold--clock`);
    return r && { num: Number(r.querySelector('.hold__num').textContent), low: r.classList.contains('hold--low') };
  }, seat);
}

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
    await A.goto(base + '/');
    await A.fill('#name', 'Ann');
    await A.click('#create');
    await A.waitForFunction(() => document.getElementById('landing').hidden);
    const code = await A.textContent('#roomCode');
    await B.goto(`${base}/?room=${code}`);
    await B.fill('#name', 'Bob');
    await B.click('#join');
    await B.waitForFunction(() => document.getElementById('landing').hidden);
    await A.waitForFunction(() => document.getElementById('seat1').textContent.includes('Bob'));
    await A.click('#ready');
    await B.click('#ready');
    await A.waitForFunction(() => S.phase === 'breaking' && S.clock);
    await B.waitForFunction(() => S.phase === 'breaking' && S.clock);

    const turn = await A.evaluate(() => S.turn);
    const aSeat = await A.evaluate(() => S.seat);
    const shooter = turn === aSeat ? A : B;
    const waiter = shooter === A ? B : A;

    // Both players see the shooter's ring; only the shooter has the button.
    for (const p of [A, B]) {
      const r = await ring(p, turn);
      if (!r || r.num < 9 || r.num > 11) fail(`ring at the start: ${JSON.stringify(r)}`);
      if (await ring(p, 1 - turn)) fail('the waiting player has a ring');
    }
    if (await shooter.isHidden('#extend')) fail('no extension button for the shooter');
    if ((await shooter.textContent('#extend')) !== '+13s') fail(`extension label ${await shooter.textContent('#extend')}`);
    console.log('ring and extension button ok');

    // The shooter's table lights up with a chime; the other's does not.
    await shooter.waitForFunction(() => $('tableWrap').classList.contains('is-my-turn') && SND.chimes >= 1, null, { timeout: 3000 });
    if (await waiter.evaluate(() => $('tableWrap').classList.contains('is-my-turn') || SND.chimes > 0)) fail('the waiting player got the your-turn cue');
    console.log('your-turn cue ok');

    // Under ten seconds: red ring and a warning for the shooter.
    await shooter.waitForFunction((t) => document.querySelector(`#seat${t} .hold--low`), turn, { timeout: 5000 });
    await shooter.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('seconds left')), null, { timeout: 3000 });
    await A.screenshot({ path: path.join(shots, 'clock-low-A.png') });
    await B.screenshot({ path: path.join(shots, 'clock-low-B.png') });
    console.log('low-time warning ok');

    // The last ten seconds: a red light and a tick a second for the shooter
    // alone; the last five count down over the table and hurry them along.
    await shooter.waitForFunction(() => $('tableWrap').classList.contains('is-hurry') && SND.ticks >= 1, null, { timeout: 3000 });
    if (await waiter.evaluate(() => $('tableWrap').classList.contains('is-hurry') || SND.ticks > 0)) fail('the waiting player is hurried');
    await shooter.waitForFunction(() => $('tableWrap').classList.contains('is-hurry-last') && !$('clockBig').hidden, null, { timeout: 7000 });
    const last = await shooter.evaluate(() => ({ n: Number($('clockBig').textContent), ticks: SND.ticks, line: SND.lastLine }));
    if (!(last.n >= 1 && last.n <= 5)) fail(`countdown ${last.n}`);
    if (last.ticks < 4) fail(`only ${last.ticks} ticks by ${last.n}s`);
    if (!last.line.startsWith('hurry-')) fail(`no hurry line, last line ${last.line}`);
    await shooter.screenshot({ path: path.join(shots, 'clock-hurry.png') });
    console.log('hurry ok:', JSON.stringify(last));

    // The extension resets the clock to 13 s, once.
    await shooter.click('#extend');
    await waiter.waitForFunction((t) => Number(document.querySelector(`#seat${t} .hold__num`)?.textContent) >= 12, turn, { timeout: 3000 });
    await shooter.waitForFunction(() => document.getElementById('extend').hidden);
    if ((await ring(shooter, turn)).low) fail('ring still red after the extension');
    await shooter.waitForFunction(() => !$('tableWrap').classList.contains('is-hurry') && $('clockBig').hidden, null, { timeout: 2000 });
    console.log('extension ok');

    // Let it run out: the other player breaks instead.
    for (const p of [A, B]) {
      await p.waitForFunction((t) => S.turn === 1 - t && S.ballInHand && S.kitchen, turn, { timeout: 16000 });
    }
    const status = await waiter.textContent('#status');
    if (!/ran out of time/.test(status) || !/break instead/.test(status)) fail(`status after the time foul: ${status}`);
    if (await waiter.isHidden('#shotPanel')) fail('the new breaker has no shot panel');
    if (!(await ring(A, 1 - turn))) fail('no ring for the new breaker');
    await waiter.waitForFunction(() => $('tableWrap').classList.contains('is-my-turn') && SND.chimes >= 1, null, { timeout: 3000 });
    await shooter.waitForFunction(() => !$('tableWrap').className.match(/is-my-turn|is-hurry/), null, { timeout: 3000 });
    await waiter.screenshot({ path: path.join(shots, 'clock-timeout.png') });
    console.log('time foul ok:', status.trim());
    if (errors.length) fail(`page errors: ${errors.join('; ')}`);
    console.log('OK');
  } finally {
    await browser.close();
  }
})().catch((e) => { if (!process.exitCode) { console.error(e); process.exitCode = 1; } });
