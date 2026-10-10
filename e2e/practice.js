// Practice: a private table for one player who plays both sides, with undo,
// free placement of any ball and re-racking.
// Usage: node practice.js <base>
const { chromium } = require('playwright');
const flat = require('./flat');
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
    const page = await (await flat(browser, { viewport })).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    return page;
  };
  const A = await mk({ width: 1100, height: 700 });
  try {
    await A.goto(base + '/');
    await A.fill('#name', 'Ann');
    await A.click('#practice');
    await A.waitForFunction(() => document.getElementById('landing').hidden && S.practice && S.phase === 'open');
    const code = await A.textContent('#roomCode');
    if ((await A.textContent('#roomEyebrow')) !== 'Practice · 8-ball') fail(`eyebrow ${await A.textContent('#roomEyebrow')}`);
    // One player, free play: no second seat, no score, no calls.
    if (await A.isVisible('#seat1') || await A.isVisible('#score')) fail('sides or score shown in practice');
    if (!/^Free play/.test(await A.textContent('#callText'))) fail(`call line ${await A.textContent('#callText')}`);
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
    // the recordings load and decode (the synthesized sounds only stand in)
    await A.waitForFunction(() => SND.takes.clack.length === 7 && SND.takes.cue.length === 4 && SND.takes.pocket.length === 1, null, { timeout: 10000 });
    const st = await A.evaluate(() => ({ seat: S.seat, turn: S.turn, decision: S.decision, phase: S.phase, ballInHand: S.ballInHand }));
    if (st.seat !== 0 || st.turn !== 0 || st.decision || st.phase !== 'open' || st.ballInHand) fail(`not free play after a shot: ${JSON.stringify(st)}`);
    await A.waitForTimeout(300); // the status cross-fade
    if (/You break|turn|[Ff]oul/.test(await A.textContent('#status .is-active'))) fail(`status after the shot: ${await A.textContent('#status .is-active')}`);
    await A.screenshot({ path: path.join(shots, 'practice-after-shot.png') });
    await A.keyboard.press('z');
    await A.waitForFunction(() => S.undos === 0);
    const after = await balls(A);
    for (const id of Object.keys(before)) if (!after[id] || !near(before[id], after[id])) fail(`ball ${id} not restored`);
    console.log('free play and undo ok');

    // Jump: J raises the cue 5° a press; the guide passes over a ball the
    // cue ball clears, and so does the shot. The next turn starts level.
    await A.evaluate(() => { send({ type: 'place_cue', x: 0.5, y: 0.635 }); send({ type: 'place_ball', id: 3, x: 0.65, y: 0.635 }); });
    await A.waitForFunction(() => S.balls.get(0).x === 0.5 && S.balls.get(3).x === 0.65, null, { timeout: 5000 });
    await A.evaluate(() => { setAngle(0); setPower(0.5); document.activeElement.blur(); });
    for (let i = 0; i < 9; i++) await A.keyboard.press('j');
    const jump = await A.evaluate(() => {
      const cast = castAim(S.balls, S.balls.get(0), 0, jumpFlight(S.power, 0, S.elev * DEG));
      return { elev: S.elev, text: document.getElementById('elevText').textContent, hit: cast.hit, land: !!cast.land, level: castAim(S.balls, S.balls.get(0), 0).hit };
    });
    if (jump.elev !== 45 || jump.text !== '45°' || jump.hit === 3 || !jump.land || jump.level !== 3) fail(`jump aim ${JSON.stringify(jump)}`);
    await A.evaluate(() => {
      window.__maxZ = 0;
      const look = () => { for (const s of S.snaps) window.__maxZ = Math.max(window.__maxZ, (s.balls.get(0) || {}).z || 0); if (S.moving || !window.__maxZ) requestAnimationFrame(look); };
      look();
    });
    await shootAndSettle(A, 0, 0.5);
    const flew = await A.evaluate(() => ({ z: window.__maxZ, three: [S.balls.get(3).x, S.balls.get(3).y], elev: S.elev, replay: S.lastShot.elev }));
    if (!(flew.z > 0.05) || !near(flew.three, [0.65, 0.635]) || flew.elev !== 0 || !(flew.replay > 0.7)) fail(`jump shot ${JSON.stringify(flew)}`);
    await A.keyboard.press('z');
    await A.waitForFunction(() => S.undos === 0);
    console.log('jump ok, the cue ball rose', flew.z.toFixed(3), 'm');

    // Massé: past 60° the slider reads Massé; with right english the guide
    // curves right round the blocker and the cue ball follows it.
    await A.evaluate(() => { send({ type: 'place_cue', x: 0.6, y: 0.3 }); send({ type: 'place_ball', id: 3, x: 0.75, y: 0.3 }); send({ type: 'place_ball', id: 5, x: 0.9, y: 0.75 }); });
    await A.waitForFunction(() => S.balls.get(0).x === 0.6 && S.balls.get(3).x === 0.75 && S.balls.get(5).x === 0.9, null, { timeout: 5000 });
    const masse = await A.evaluate(() => {
      setAngle(0); setPower(0.4); setSpin(1, 0); setElev(80);
      const g = aimGuide(S.balls, S.balls.get(0), { angle: 0, power: 0.4, elev: S.elev * DEG, mine: true });
      return { label: document.getElementById('elevLabel').textContent, hit: g.cast.hit, curve: !!g.cast.curve };
    });
    if (masse.label !== 'Massé' || masse.hit !== 5 || !masse.curve) fail(`massé aim ${JSON.stringify(masse)}`);
    await shootAndSettle(A, 0, 0.4);
    const curved = await A.evaluate(() => ({ three: [S.balls.get(3).x, S.balls.get(3).y], five: [S.balls.get(5).x, S.balls.get(5).y], label: document.getElementById('elevLabel').textContent }));
    if (!near(curved.three, [0.75, 0.3]) || near(curved.five, [0.9, 0.75]) || curved.label !== 'Jump') fail(`massé shot ${JSON.stringify(curved)}`);
    await A.keyboard.press('z');
    await A.waitForFunction(() => S.undos === 0);
    console.log('massé ok');

    // Practice has no This room in Settings; a 9-ball rack (rerack) still
    // comes when asked for.
    await A.click('#settingsBtn');
    if (await A.isVisible('#settingsTabs [data-tab="room"]')) fail('This room in practice');
    await A.click('#settingsClose');
    await A.evaluate(() => send({ type: 'rerack', mode: '9ball' }));
    await A.waitForFunction(() => S.mode === '9ball' && S.balls.size === 10 && S.phase === 'open');
    await A.click('#rackBtn'); // the Rack button racks the same game again
    await A.waitForFunction(() => S.mode === '9ball' && S.balls.size === 10);
    await A.screenshot({ path: path.join(shots, 'practice-A.png') });
    console.log('rack ok');

    // The spin's words change, their box does not: nothing beside it moves.
    const spinBoxes = await A.evaluate(() => {
      const out = new Set();
      for (const [x, y] of [[0, 0], [0, 1], [-1, 0], [0.7, 0.7], [0.71, -0.71], [0.3, 0.2]]) {
        setSpin(x, y);
        const m = document.querySelector('.spin__meta').getBoundingClientRect();
        out.add(`${m.width}x${m.height}`);
      }
      setSpin(0, 0);
      return [...out];
    });
    if (spinBoxes.length !== 1) fail(`the spin label resizes: ${spinBoxes}`);
    // Fine aim: the wheel turns 0.02° per px dragged, clockwise to the right;
    // focused, the arrow keys turn 0.05°.
    const jog = await A.locator('#aimJog').boundingBox();
    const j0 = await A.evaluate(() => S.angle);
    await A.mouse.move(jog.x + jog.width / 2, jog.y + jog.height / 2);
    await A.mouse.down();
    await A.mouse.move(jog.x + jog.width / 2 + 50, jog.y + jog.height / 2, { steps: 4 });
    await A.mouse.move(jog.x + jog.width / 2 + 100, jog.y + jog.height / 2, { steps: 4 });
    await A.mouse.up();
    const j1 = await A.evaluate(() => S.angle);
    await A.keyboard.press('ArrowLeft'); // the wheel has focus
    const j2 = await A.evaluate(() => S.angle);
    const deg = (a, b) => (b - a) * 180 / Math.PI;
    if (Math.abs(deg(j0, j1) - 2) > 0.01 || Math.abs(deg(j1, j2) + 0.05) > 0.001) fail(`fine aim turned ${deg(j0, j1)}° then ${deg(j1, j2)}°`);
    console.log('spin label and fine aim ok');

    // Settings: sound on by default, a volume slider.
    await A.click('#settingsBtn');
    await A.click('#settingsTabs [data-tab="sound"]');
    if ((await A.getAttribute('#soundToggle', 'aria-pressed')) !== 'true') fail('sound off by default');
    await A.waitForTimeout(500); // the sheet slides in
    await A.screenshot({ path: path.join(shots, 'settings-sound.png') });
    await A.click('#soundToggle');
    if (await A.evaluate(() => SND.on)) fail('sound toggle did not turn it off');
    await A.click('#soundToggle');
    await A.click('#settingsClose');

    // Phone layout: an iPhone in Safari with its bars (393 x 670). The table
    // stands upright and every panel fits its slot.
    const P = await (await flat(browser, { viewport: { width: 393, height: 670 }, hasTouch: true, isMobile: true })).newPage();
    P.on('pageerror', (e) => errors.push(e.message));
    await P.goto(base + '/');
    await P.fill('#name', 'Pho');
    await P.click('#practice');
    await P.waitForFunction(() => S.practice && S.phase === 'open');
    await P.waitForTimeout(400);
    const layout = await P.evaluate(() => ({
      rotated: view.rotated,
      ball: 2 * R * view.s,
      overflow: [...document.querySelectorAll('#controls > .panel')].filter((e) => !e.hidden && e.scrollHeight > e.clientHeight).map((e) => e.id),
    }));
    if (!layout.rotated || layout.ball < 9 || layout.overflow.length) fail(`phone layout ${JSON.stringify(layout)}`);
    await P.screenshot({ path: path.join(shots, 'practice-phone.png') });

    // The fine aim wheel and the jump slider are always in the shot panel,
    // clear of the table; the spin is behind the small cue ball.
    if (await P.isVisible('#spinPad')) fail('spin pad shown in the phone shot row');
    for (const id of ['aimJog', 'elevRange']) {
      if (!(await P.isVisible(`#shotPanel #${id}`))) fail(`#${id} not in the phone shot panel`);
    }
    const under = await P.evaluate(() => {
      const t = document.getElementById('table').getBoundingClientRect();
      return ['aimJog', 'elevRange'].filter((id) => document.getElementById(id).getBoundingClientRect().top < t.bottom);
    });
    if (under.length) fail(`over the table: ${under}`);
    const pj = await P.locator('#shotPanel #aimJog').boundingBox();
    const jw = await P.locator('#shotPanel #elevRange').boundingBox();
    if (pj.width < 60 || jw.width < 100) fail(`wheel ${pj.width}px, jump slider ${jw.width}px wide`);
    // the jump slider; a raised cue rings the small cue ball
    await P.locator('#shotPanel #elevRange').fill('30');
    if (await P.evaluate(() => S.elev) !== 30 || !(await P.getAttribute('#optionsBtn', 'class')).includes('opts-btn--jump')) fail('the jump slider');
    // the fine aim wheel, under the finger
    const p0 = await P.evaluate(() => S.angle);
    await P.touchscreen.tap(pj.x + 10, pj.y + pj.height / 2); // a tap alone turns nothing
    await P.mouse.move(pj.x + 20, pj.y + pj.height / 2);
    await P.mouse.down();
    await P.mouse.move(pj.x + 70, pj.y + pj.height / 2, { steps: 5 });
    await P.mouse.up();
    const pturn = (await P.evaluate(() => S.angle) - p0) * 180 / Math.PI;
    if (Math.abs(pturn - 1) > 0.01) fail(`the wheel turned ${pturn}°`);
    // The small cue ball opens a big one in the middle of the screen.
    await P.click('#optionsBtn');
    await P.waitForFunction(() => !document.getElementById('spinPop').hidden);
    const pad = await P.locator('#spinPad').boundingBox();
    const vp = P.viewportSize();
    if (pad.width < 200 || Math.abs(pad.x + pad.width / 2 - vp.width / 2) > 4) fail(`spin pad ${JSON.stringify(pad)}`);
    const a0 = await P.evaluate(() => S.angle);
    await P.mouse.click(pad.x + pad.width / 2, pad.y + pad.height * 0.25);
    const picked = await P.evaluate((a) => ({ spin: S.spin, turned: S.angle - a, dot: document.getElementById('optsDot').style.top }), a0);
    if (!(picked.spin.y > 0.3) || picked.turned || picked.dot === '50%') fail(`spin picker ${JSON.stringify(picked)}`);
    await P.waitForTimeout(300);
    await P.screenshot({ path: path.join(shots, 'practice-phone-spin.png') });
    // a tap on the dimmed table beside it puts it away and does not aim
    await P.mouse.click(vp.width / 2, vp.height - 12);
    await P.waitForFunction(() => document.getElementById('spinPop').hidden);
    if (await P.evaluate((a) => S.angle !== a, a0)) fail('closing the spin picker turned the cue');
    await P.click('#optionsBtn');
    await P.click('#spinPopDone');
    await P.waitForFunction(() => document.getElementById('spinPop').hidden);
    console.log('phone spin picker ok');

    // A finger on the felt turns the cue by as much as it turns about the cue
    // ball, from wherever it lands: the aim never jumps to it.
    const cdp = await P.context().newCDPSession(P);
    const onArc = (deg) => P.evaluate((deg) => {
      const r = document.getElementById('table').getBoundingClientRect();
      const c = S.balls.get(0), a = deg * DEG;
      const sp = toScreen({ x: c.x + 0.4 * Math.cos(a), y: c.y + 0.4 * Math.sin(a) });
      return { x: r.left + sp.x, y: r.top + sp.y };
    }, deg);
    const touch = async (type, at) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: at ? [at] : [] });
    const l0 = await P.evaluate(() => { setAngle(1.234); return S.angle; });
    await touch('touchStart', await onArc(10));
    await touch('touchEnd');
    if (await P.evaluate(() => S.angle) !== l0) fail('a touch on the felt turned the cue');
    await touch('touchStart', await onArc(10));
    for (let d = 12; d <= 30; d += 2) await touch('touchMove', await onArc(d));
    await touch('touchEnd');
    const lturn = (await P.evaluate(() => S.angle) - l0) * 180 / Math.PI;
    if (Math.abs(lturn - 20) > 0.5) fail(`a finger turning 20° about the cue ball turned the cue ${lturn}°`);
    console.log('lever aim ok');

    // A touch beside a ball names it (a fingertip is wider than a ball here),
    // and the ball the aim hits is named while aiming.
    const beside = await P.evaluate(() => {
      const r = document.getElementById('table').getBoundingClientRect();
      const sp = toScreen(S.balls.get(1));
      return { x: r.left + sp.x + 12, y: r.top + sp.y + 4 };
    });
    await P.touchscreen.tap(beside.x, beside.y);
    await P.waitForTimeout(100);
    const named = await P.evaluate(() => S.hoverBall);
    if (named === null) fail('a touch beside a ball named nothing');
    const aimed = await P.evaluate(() => { const c = S.balls.get(0), t = S.balls.get(1); setAngle(Math.atan2(t.y - c.y, t.x - c.x)); return castAim(displayBalls(), c, S.angle).hit; });
    if (aimed !== 1) fail(`aim at the 1 hits ${aimed}`);
    await P.waitForTimeout(2100); // the touch label fades, the aim tag stays
    await P.screenshot({ path: path.join(shots, 'practice-phone-aim-tag.png') });
    console.log('ball names ok, touch named', named);

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
