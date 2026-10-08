// Phones held both ways and desktops: one finger at a time on the table,
// the loupe, turning the phone in the middle of a gesture, the landscape side
// column, the mouse wheel, vibration, the wake lock, full screen and the pace
// of the flat table.
// Usage: node devices.js <base>
const { chromium } = require('playwright');
const flat = require('./flat');
const path = require('path');

const base = process.argv[2] || 'http://127.0.0.1:18080';
const shots = path.join(__dirname, 'shots');
require('fs').mkdirSync(shots, { recursive: true });

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
const deg = (rad) => rad * 180 / Math.PI;

// stubs records what the page asks of the device: vibrations and wake locks.
function stubs() {
  window.__buzz = [];
  window.__wake = 0;
  navigator.vibrate = (p) => { window.__buzz.push(p); return true; };
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      request: async () => {
        window.__wake++;
        const lock = new EventTarget();
        lock.release = async () => { window.__wake--; lock.dispatchEvent(new Event('release')); };
        return lock;
      },
    },
  });
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const mk = async (options) => {
    const ctx = await flat(browser, options);
    await ctx.addInitScript(stubs);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    return page;
  };
  const practice = async (page) => {
    await page.goto(base + '/');
    await page.click('#practice');
    await page.waitForFunction(() => S.practice && S.phase === 'open' && document.body.classList.contains('is-playing'));
    await page.waitForTimeout(400);
  };
  // overflow lists the panels and header parts whose content does not fit.
  const overflow = (page) => page.evaluate(() => [...document.querySelectorAll('#controls > .panel, .seat__name')]
    .filter((e) => e.offsetParent && (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1)).map((e) => e.id || e.className));
  const box = (page, sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; }, sel);

  try {
    // --- a phone held upright: an iPhone in Safari (393 x 670) -------------
    const P = await mk({ viewport: { width: 393, height: 670 }, hasTouch: true, isMobile: true });
    await practice(P);
    if ((await overflow(P)).length) fail(`portrait overflow ${await overflow(P)}`);
    if (await P.evaluate(() => window.__wake) !== 1) fail('no wake lock in the room');
    // A drag down from the header must not pull the page to refresh it.
    const over = await P.evaluate(() => [document.documentElement, document.body].map((e) => getComputedStyle(e).overscrollBehaviorY));
    if (over.some((v) => v !== 'none')) fail(`pull to refresh allowed: ${over}`);
    const cdp = await P.context().newCDPSession(P);
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    // at: a point on a circle about the cue ball, `r` m away at `a` degrees
    const at = (a, r = 0.4, id = 0) => P.evaluate(([a, r, id]) => {
      const rect = canvas.getBoundingClientRect();
      const c = S.balls.get(0);
      const sp = toScreen({ x: c.x + r * Math.cos(a * DEG), y: c.y + r * Math.sin(a * DEG) });
      return { x: rect.left + sp.x, y: rect.top + sp.y, id };
    }, [a, r, id]);

    // A second finger neither aims nor takes the table over: the first
    // keeps turning the cue as before.
    const a0 = await P.evaluate(() => { setAngle(1.234); return S.angle; });
    await touch('touchStart', [await at(10)]);
    for (let d = 12; d <= 20; d += 2) await touch('touchMove', [await at(d)]);
    const thumb = await at(200, 0.6, 1);
    await touch('touchStart', [await at(20), thumb]);
    for (let d = 200; d <= 260; d += 15) await touch('touchMove', [await at(20), await at(d, 0.6, 1)]);
    const mid = await P.evaluate(() => S.angle);
    if (Math.abs(deg(mid - a0) - 10) > 0.5) fail(`the second finger turned the cue: ${deg(mid - a0)}° instead of 10°`);
    for (let d = 22; d <= 30; d += 2) await touch('touchMove', [await at(d), await at(260, 0.6, 1)]);
    await touch('touchEnd', []);
    const turned = deg(await P.evaluate(() => S.angle) - a0);
    if (Math.abs(turned - 20) > 0.5) fail(`two fingers: the cue turned ${turned}° instead of 20°`);
    if (await P.evaluate(() => S.pointer !== null || S.aiming)) fail('the table still follows a finger');
    console.log('one finger at a time ok');

    // While a finger aims, a loupe in a corner clear of the contact shows it
    // magnified; it goes with the finger.
    await P.evaluate(() => { const c = S.balls.get(0), t = S.balls.get(1); setAngle(Math.atan2(t.y - c.y, t.x - c.x)); });
    await touch('touchStart', [await at(-100, 0.3)]);
    await touch('touchMove', [await at(-100.3, 0.3)]);
    await P.waitForTimeout(100);
    const lp = await P.evaluate(() => {
      const g = toScreen(castAim(displayBalls(), S.balls.get(0), S.angle).ghost);
      return loupe.shown && { ...loupe.shown, clear: Math.hypot(loupe.shown.x - g.x, loupe.shown.y - g.y) - LOUPE_PX };
    });
    if (!lp || lp.hit !== 1 || lp.clear < 0) fail(`loupe ${JSON.stringify(lp)}`);
    await P.screenshot({ path: path.join(shots, 'devices-loupe.png') });
    await touch('touchEnd', []);
    await P.waitForTimeout(100);
    if (await P.evaluate(() => loupe.shown)) fail('the loupe stayed after the finger lifted');
    console.log('loupe ok');

    // Resting: with nothing moving and no input for 3 s the flat table is
    // drawn four times a second; a touch brings every frame back.
    const frames = (ms) => P.evaluate((ms) => new Promise((done) => {
      let n = 0;
      const real = drawLoupe;
      drawLoupe = (...a) => { n++; return real(...a); };
      setTimeout(() => { drawLoupe = real; done(n); }, ms);
    }), ms);
    await P.waitForTimeout(3200);
    const resting = await frames(1000);
    if (resting > 6) fail(`a resting table was drawn ${resting} times in a second`);
    await touch('touchStart', [await at(-100, 0.3)]);
    await touch('touchEnd', []);
    const woken = await frames(1000);
    if (woken < 30) fail(`after a touch the table was drawn only ${woken} times in a second`);
    console.log(`rest ok (${resting} frames resting, ${woken} after a touch)`);

    // A held finger selects nothing and a double tap does not zoom; the
    // table and the power bar take no browser gestures at all.
    const gestures = await P.evaluate(() => Object.fromEntries(['.hdr', 'main.game', '#ready', '#table', '#powerBar'].map((s) => {
      const c = getComputedStyle(document.querySelector(s));
      return [s, `${c.touchAction}/${c.webkitUserSelect}`];
    })));
    const want = { '.hdr': 'pan-x pan-y/none', 'main.game': 'pan-x pan-y/none', '#ready': 'manipulation/none', '#table': 'none/none', '#powerBar': 'none/none' };
    for (const [s, v] of Object.entries(want)) if (gestures[s] !== v) fail(`${s} gestures ${gestures[s]}, want ${v}`);
    console.log('touch gestures ok');

    // Turning the phone stops an aim: where the finger goes next means
    // nothing on the turned table.
    await touch('touchStart', [await at(40)]);
    await touch('touchMove', [await at(45)]);
    await P.setViewportSize({ width: 670, height: 393 });
    await P.waitForTimeout(300);
    const turnedAt = await P.evaluate(() => ({ angle: S.angle, aiming: S.aiming, pointer: S.pointer }));
    if (turnedAt.aiming || turnedAt.pointer !== null) fail(`aim not stopped by the turn ${JSON.stringify(turnedAt)}`);
    await touch('touchMove', [await at(90)]);
    await touch('touchEnd', []);
    if (await P.evaluate(() => S.angle) !== turnedAt.angle) fail('a finger kept aiming across the turn');

    // ... and a pull: the release after the turn shoots nothing. The pull
    // ticks at each quarter of the bar on the way.
    const pb = await box(P, '#powerTrack');
    const power0 = await P.evaluate(() => S.power);
    const barAt = (f) => ({ x: (pb.l + pb.r) / 2, y: pb.t + f * (pb.b - pb.t), id: 0 });
    await P.evaluate(() => { window.__buzz.length = 0; });
    await touch('touchStart', [barAt(0.2)]);
    for (let f = 0.25; f <= 0.8; f += 0.05) await touch('touchMove', [barAt(f)]);
    const buzzed = await P.evaluate(() => window.__buzz.slice());
    if (buzzed.length < 2 || !buzzed.every((p) => p === 8)) fail(`power ticks ${JSON.stringify(buzzed)}`);
    await P.setViewportSize({ width: 393, height: 670 });
    await P.waitForTimeout(300);
    await touch('touchEnd', []);
    await P.waitForTimeout(500);
    const pulled = await P.evaluate(() => ({ moving: S.moving, drag: S.powerDrag, power: S.power }));
    if (pulled.moving || pulled.drag || pulled.power !== power0) fail(`a pull across the turn ${JSON.stringify(pulled)}`);
    console.log('turning the phone mid-gesture ok, ticks', buzzed.length);

    // Settings offers vibration on a phone that has it.
    await P.click('#settingsBtn');
    if (!(await P.isVisible('#hapticsToggle'))) fail('no vibration switch in Settings');
    await P.click('#hapticsToggle');
    if (await P.evaluate(() => S.haptics || localStorage.getItem('pool:haptics') !== 'off')) fail('vibration switch');
    await P.click('#hapticsToggle');
    await P.click('#settingsClose');

    await P.click('#practiceLeave');
    await P.waitForFunction(() => !document.getElementById('landing').hidden);
    if (await P.evaluate(() => window.__wake) !== 0) fail('the wake lock outlived the room');
    console.log('wake lock ok');
    await P.close();

    // --- a phone on its side ------------------------------------------------
    // The header and the practice tools sit in the side column, clear of the
    // table, which gets the whole height; nothing in the column overflows,
    // with or without Safari's bars (390 and 340 px tall).
    for (const height of [390, 340]) {
      const L = await mk({ viewport: { width: 844, height }, hasTouch: true, isMobile: true });
      await practice(L);
      const t = await box(L, '#table');
      for (const sel of ['#top', '#practiceBar', '#controls']) {
        const b = await box(L, sel);
        if (b.l < t.r) fail(`${sel} over the table at ${height}: ${JSON.stringify(b)} vs ${JSON.stringify(t)}`);
        if (b.b > height + 1) fail(`${sel} below the screen at ${height}: ${JSON.stringify(b)}`);
      }
      const fill = await L.evaluate(() => view.cssH / document.getElementById('tableWrap').clientHeight);
      if (fill < 0.95 && (await L.evaluate(() => view.cssW / document.getElementById('tableWrap').clientWidth)) < 0.85) fail(`the table fills ${fill} of the height`);
      if ((await overflow(L)).length) fail(`landscape overflow at ${height}: ${await overflow(L)}`);
      await L.screenshot({ path: path.join(shots, `devices-landscape-${height}.png`) });
      await L.close();
    }

    // Two players: both seats and the score fit the column.
    const L1 = await mk({ viewport: { width: 844, height: 340 }, hasTouch: true, isMobile: true });
    const D = await mk({ viewport: { width: 1100, height: 700 } });
    await L1.goto(base + '/');
    await L1.fill('#name', 'Annabelle');
    await L1.click('#create');
    await L1.waitForFunction(() => document.getElementById('landing').hidden);
    const code = await L1.textContent('#roomCode');
    await D.goto(`${base}/?room=${code}`);
    await D.fill('#name', 'Bartholomew');
    await D.click('#join');
    await L1.waitForFunction(() => document.getElementById('seat1').textContent.includes('Barth'));
    await L1.click('#ready');
    await D.click('#ready');
    await L1.waitForFunction(() => document.body.classList.contains('is-playing'));
    await L1.waitForTimeout(400);
    const t1 = await box(L1, '#table');
    for (const sel of ['#seat0', '#seat1', '#score', '#controls']) {
      const b = await box(L1, sel);
      if (b.l < t1.r || b.b > 341) fail(`${sel} in the two-player column: ${JSON.stringify(b)}`);
    }
    const ov = (await overflow(L1)).filter((c) => !/seat__name/.test(c)); // long names may be cut
    if (ov.length) fail(`two-player landscape overflow ${ov}`);
    await L1.screenshot({ path: path.join(shots, 'devices-landscape-match.png') });
    await L1.close();
    await D.close();
    console.log('landscape column ok');

    // --- a desktop ----------------------------------------------------------
    const M = await mk({ viewport: { width: 1100, height: 700 } });
    await practice(M);
    const mt = await box(M, '#table');
    await M.mouse.move((mt.l + mt.r) / 2, (mt.t + mt.b) / 2);
    const w0 = await M.evaluate(() => S.angle);
    await M.mouse.wheel(0, 100);
    await M.waitForTimeout(100);
    const w1 = await M.evaluate(() => S.angle);
    if (Math.abs(deg(w1 - w0) - 0.05) > 0.001) fail(`a wheel notch turned ${deg(w1 - w0)}°`);
    await M.keyboard.down('Shift');
    await M.mouse.wheel(0, -100);
    await M.keyboard.up('Shift');
    await M.waitForTimeout(100);
    const w2 = await M.evaluate(() => S.angle);
    if (Math.abs(deg(w2 - w1) + 0.01) > 0.001) fail(`a Shift wheel notch turned ${deg(w2 - w1)}°`);
    const jb = await box(M, '#aimJog');
    await M.mouse.move((jb.l + jb.r) / 2, (jb.t + jb.b) / 2);
    await M.mouse.wheel(0, 200);
    await M.waitForTimeout(100);
    const w3 = await M.evaluate(() => S.angle);
    if (Math.abs(deg(w3 - w2) - 0.1) > 0.001) fail(`two notches on the wheel turned ${deg(w3 - w2)}°`);
    console.log('mouse wheel ok');

    // Full screen, by the header button or F.
    if (await M.evaluate(() => canFullscreen)) {
      if (!(await M.isVisible('#fullBtn'))) fail('no full screen button');
      await M.click('#fullBtn');
      await M.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 3000 });
      if (await M.getAttribute('#fullBtn', 'aria-pressed') !== 'true') fail('full screen button state');
      await M.keyboard.press('f');
      await M.waitForFunction(() => !document.fullscreenElement, null, { timeout: 3000 });
      console.log('full screen ok');
    } else {
      console.log('full screen not available here, skipped');
    }
    await M.close();

    // A slow device: the flat table steps its pixel ratio down.
    const Q = await mk({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 2 });
    await practice(Q);
    if (await Q.evaluate(() => view.dpr) !== 2) fail(`pixel ratio ${await Q.evaluate(() => view.dpr)}`);
    await Q.evaluate(() => {
      rest.hotUntil = Infinity; // draw every frame, as while a shot runs
      const slow = window.__drawFx = drawFx;
      drawFx = (layer, now) => { const t = performance.now(); while (performance.now() - t < 4); slow(layer, now); };
    });
    // back to full speed as soon as it has stepped down once
    await Q.waitForFunction(() => view.dpr < 2 && ((drawFx = window.__drawFx), true), null, { timeout: 15000 });
    const dpr = await Q.evaluate(() => view.dpr);
    if (dpr !== 1.5) fail(`slow pixel ratio ${dpr}`);
    await Q.close();
    console.log('pace ok');

    if (errors.length) fail(`page errors: ${errors.join('; ')}`);
    console.log('OK');
  } finally {
    await browser.close();
  }
})().catch((e) => { if (!process.exitCode) { console.error(e); process.exitCode = 1; } });
