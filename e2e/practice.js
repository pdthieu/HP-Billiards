// Practice: a private table for one player who plays both sides, with undo,
// free placement of any ball and re-racking.
// Usage: node practice.js <base>
const { chromium } = require('playwright');
const path = require('path');

const base = process.argv[2] || 'http://127.0.0.1:18080';
const shots = path.join(__dirname, 'shots');
require('fs').mkdirSync(shots, { recursive: true });

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
const balls = (page) => page.evaluate(() => Object.fromEntries([...S.balls].map(([id, p]) => [id, [p.x, p.y]])));
const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.003;

async function tablePoint(page, x, y) {
  return page.evaluate(([x, y]) => {
    const rect = canvas.getBoundingClientRect();
    if (!view.rotated) return { x: rect.left + view.ox + x * view.s, y: rect.top + view.oy + y * view.s };
    return { x: rect.left + view.ox + y * view.s, y: rect.top + view.oy + (W - x) * view.s };
  }, [x, y]);
}

async function drag(page, from, to) {
  const a = await tablePoint(page, ...from), b = await tablePoint(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

async function shootAndSettle(page, angle, power) {
  await page.evaluate(([a, p]) => { setAngle(a); setPower(p); shoot(); }, [angle, power]);
  await page.waitForFunction(() => S.moving, null, { timeout: 5000 });
  await page.waitForFunction(() => !S.moving, null, { timeout: 30000 });
}

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
  try {
    await A.goto(base + '/');
    await A.fill('#name', 'Ann');
    await A.click('#practice');
    await A.waitForFunction(() => document.getElementById('landing').hidden && S.practice && S.phase === 'breaking');
    const code = await A.textContent('#roomCode');
    if ((await A.textContent('#roomEyebrow')) !== 'Practice · 8-ball') fail(`eyebrow ${await A.textContent('#roomEyebrow')}`);
    if (await A.isVisible('#copyLink')) fail('copy link shown in practice');
    if (!(await A.isVisible('#practiceBar')) || !(await A.isDisabled('#undoBtn'))) fail('practice bar state at the start');

    // Private: not listed, and nobody else gets in.
    const L = await mk({ width: 800, height: 700 });
    await L.goto(base + '/');
    await L.waitForFunction(() => /in use/.test(document.getElementById('roomsCount').textContent));
    if (await L.$(`li.room-row[data-code="${code}"]`)) fail('practice room listed');
    await L.goto(`${base}/?room=${code}`);
    await L.fill('#name', 'Bob');
    await L.click('#join');
    await L.waitForFunction(() => !document.getElementById('landingError').hidden);
    if (!/full/i.test(await L.textContent('#landingError'))) fail(`join error: ${await L.textContent('#landingError')}`);
    await L.close();
    console.log('private room ok');

    // The cue ball goes anywhere, even outside the kitchen on the break.
    await A.waitForTimeout(300);
    await drag(A, (await balls(A))[0], [1.0, 0.4]);
    await A.waitForFunction(() => { const c = S.balls.get(0); return Math.abs(c.x - 1.0) < 0.003 && Math.abs(c.y - 0.4) < 0.003; }, null, { timeout: 5000 });

    // Move balls: drag the 5 somewhere else.
    await A.click('#moveBtn');
    if ((await A.getAttribute('#moveBtn', 'aria-pressed')) !== 'true') fail('move tool not on');
    await drag(A, (await balls(A))[5], [1.6, 0.25]);
    await A.waitForFunction(() => { const b = S.balls.get(5); return Math.abs(b.x - 1.6) < 0.003 && Math.abs(b.y - 0.25) < 0.003; }, null, { timeout: 5000 });
    await A.keyboard.press('m');
    if ((await A.getAttribute('#moveBtn', 'aria-pressed')) !== 'false') fail('M did not turn the move tool off');
    console.log('placement ok');

    // Shoot, then take it back.
    const before = await balls(A);
    await shootAndSettle(A, Math.atan2(0.635 - 0.4, 1.905 - 1.0), 0.9);
    if (await A.isDisabled('#undoBtn')) fail('undo disabled after a shot');
    const played = await A.evaluate(() => SND.played);
    if (played < 5) fail(`only ${played} sounds scheduled for a shot into the rack`);
    console.log('sounds scheduled:', played);
    const st = await A.evaluate(() => ({ seat: S.seat, turn: S.turn, decision: S.decision, phase: S.phase }));
    const side = st.decision ? st.decision.seat : st.turn;
    if (st.seat !== side) fail(`playing seat ${st.seat}, side to play ${side}`);
    await A.waitForTimeout(300); // the status cross-fade
    if (/You break/.test(await A.textContent('#status .is-active'))) fail('status not updated after the shot');
    await A.screenshot({ path: path.join(shots, 'practice-after-shot.png') });
    await A.keyboard.press('z');
    await A.waitForFunction(() => S.phase === 'breaking' && S.undos === 0);
    const after = await balls(A);
    for (const id of Object.keys(before)) if (!after[id] || !near(before[id], after[id])) fail(`ball ${id} not restored`);
    console.log('undo ok, side to play after the shot:', side ? 'B' : 'A');

    // Rack a 9-ball game.
    await A.click('#practiceMode [data-mode="9ball"]');
    await A.click('#rackBtn');
    await A.waitForFunction(() => S.mode === '9ball' && S.balls.size === 10 && S.phase === 'breaking');
    await A.screenshot({ path: path.join(shots, 'practice-A.png') });
    console.log('rack ok');

    // Settings: sound on by default, a volume slider.
    await A.click('#settingsBtn');
    if ((await A.getAttribute('#soundToggle', 'aria-pressed')) !== 'true') fail('sound off by default');
    await A.waitForTimeout(500); // the dialog fades in
    await A.screenshot({ path: path.join(shots, 'settings-sound.png') });
    await A.click('#soundToggle');
    if (await A.evaluate(() => SND.on)) fail('sound toggle did not turn it off');
    await A.click('#soundToggle');
    await A.click('#settingsClose');

    // Phone layout: an iPhone in Safari with its bars (393 x 670). The table
    // stands upright and every panel fits its slot.
    const P = await mk({ width: 393, height: 670 });
    await P.goto(base + '/');
    await P.fill('#name', 'Pho');
    await P.click('#practice');
    await P.waitForFunction(() => S.practice && S.phase === 'breaking');
    await P.waitForTimeout(400);
    const layout = await P.evaluate(() => ({
      rotated: view.rotated,
      ball: 2 * R * view.s,
      overflow: [...document.querySelectorAll('#controls > .panel')].filter((e) => !e.hidden && e.scrollHeight > e.clientHeight).map((e) => e.id),
    }));
    if (!layout.rotated || layout.ball < 7.5 || layout.overflow.length) fail(`phone layout ${JSON.stringify(layout)}`);
    await P.screenshot({ path: path.join(shots, 'practice-phone.png') });

    // The page can be added to a home screen.
    const manifest = await P.evaluate(async () => {
      const r = await fetch('/manifest.webmanifest');
      const icon = await fetch('/icons/apple-touch-icon.png');
      return { type: r.headers.get('content-type'), body: await r.json(), icon: icon.headers.get('content-type') };
    });
    if (manifest.type !== 'application/manifest+json' || manifest.body.display !== 'standalone' || manifest.icon !== 'image/png') fail(`manifest ${JSON.stringify(manifest)}`);
    console.log('phone layout and manifest ok');
    if (errors.length) fail(`page errors: ${errors.join('; ')}`);
    console.log('OK');
  } finally {
    await browser.close();
  }
})().catch((e) => { if (!process.exitCode) { console.error(e); process.exitCode = 1; } });
