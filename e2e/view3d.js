// The 3D view: the default per device, aiming from behind the cue, the
// camera following a shot, looking from above to place the cue ball, the
// replay in 3D and 2D, naming a ball through the 3D camera, and the fall
// back to 2D without WebGL, and the Graphics levels.
// Usage: node view3d.js <base>
const { chromium } = require('playwright');
const path = require('path');

const base = process.argv[2] || 'http://127.0.0.1:18080';
const shots = path.join(__dirname, 'shots');
require('fs').mkdirSync(shots, { recursive: true });

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }

// screenAt is where table point p shows in the page, through the 3D camera.
const screenAt = (page, p) => page.evaluate((p) => {
  const rect = canvas.getBoundingClientRect();
  const s = toScreen(p);
  return { x: rect.left + s.x, y: rect.top + s.y };
}, p);
// cameraIs waits for the 3D camera to take mode and come to rest there.
// A camera following moving balls never rests: wait for its mode only.
const cameraIs = (page, mode, rest = true) =>
  page.waitForFunction(([m, r]) => v3 && v3.mode === m && (!r || v3.settled), [mode, rest], { timeout: 30000 });

async function practice(page) {
  await page.goto(base + '/');
  await page.fill('#name', 'Ann');
  await page.click('#practice');
  await page.waitForFunction(() => S.practice && S.phase === 'open');
}

(async () => {
  // Software WebGL, as on a machine without a GPU.
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  const mk = async (options, init) => {
    const ctx = await browser.newContext(options);
    if (init) await ctx.addInitScript(init);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    return page;
  };
  try {
    // A desktop opens in 3D, behind the cue.
    const A = await mk({ viewport: { width: 1100, height: 700 } });
    await practice(A);
    await A.waitForFunction(() => S.view === '3d' && !!v3, null, { timeout: 45000 });
    await cameraIs(A, 'aim');
    await A.screenshot({ path: path.join(shots, 'view3d-aim.png') });
    console.log('desktop opens in 3D ok');

    // The mouse over a ball names it: the pointer goes through the camera.
    const five = await A.evaluate(() => { const p = S.balls.get(5); return { x: p.x, y: p.y }; });
    const at5 = await screenAt(A, five);
    await A.mouse.move(at5.x, at5.y);
    await A.waitForFunction(() => S.hoverBall === 5, null, { timeout: 3000 }).catch(async () => fail(`hover names ${await A.evaluate(() => S.hoverBall)}`));
    console.log('pick through the camera ok');

    // Behind the cue a sideways drag turns the aim; holding the butt, a
    // drag to the right swings the shot left (the angle goes down).
    const box = await A.evaluate(() => { const r = canvas.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const before = await A.evaluate(() => S.angle);
    const y = box.y + box.h * 0.85, x = box.x + box.w * 0.2;
    await A.mouse.move(x, y);
    await A.mouse.down();
    await A.mouse.move(x + 40, y, { steps: 4 });
    await A.mouse.move(x + 80, y, { steps: 4 });
    await A.mouse.up();
    const turned = (await A.evaluate(() => S.angle)) - before;
    const deg = turned * 180 / Math.PI;
    if (!(deg < -1 && deg > -10)) fail(`a drag of 80 px near the butt turned the aim by ${deg.toFixed(2)}°`);
    console.log(`aim turned ${deg.toFixed(2)}° ok`);

    // A shot: the camera rises over the balls, then comes back behind the cue.
    await A.evaluate(() => { setAngle(0); setPower(0.5); shoot(); });
    await A.waitForFunction(() => S.moving, null, { timeout: 5000 });
    await cameraIs(A, 'follow', false);
    await A.waitForTimeout(700);
    await A.screenshot({ path: path.join(shots, 'view3d-follow.png') });
    await A.waitForFunction(() => !S.moving, null, { timeout: 30000 });
    await cameraIs(A, 'aim');
    console.log('camera follows the shot ok');

    // Replay: the balls go back to where the shot began and run again,
    // chased by the camera; a press ends it with the table as it is.
    if (await A.isHidden('#replayBtn')) fail('no replay button after the shot');
    await A.click('#replayBtn');
    await A.waitForFunction(() => !!S.replay);
    const start = await A.evaluate(() => { const p = displayBalls().get(0); return [p.x, p.y]; });
    const shotStart = await A.evaluate(() => { const p = S.lastShot.snaps[0].balls.get(0); return [p.x, p.y]; });
    if (Math.hypot(start[0] - shotStart[0], start[1] - shotStart[1]) > 1e-6) fail(`the replay starts at ${start}, the shot at ${shotStart}`);
    await cameraIs(A, 'chase', false);
    if (await A.isHidden('#replayTag')) fail('no replay tag');
    await A.waitForTimeout(500);
    await A.screenshot({ path: path.join(shots, 'view3d-replay.png') });
    await A.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
    await A.waitForFunction(() => !S.replay);
    if (!(await A.evaluate(() => displayBalls() === S.balls))) fail('the table did not come back after the replay');
    console.log('replay in 3D ok');

    // Looking from above, the cue ball is dragged where it should go.
    await A.click('#camTopBtn');
    await cameraIs(A, 'top');
    const cue = await A.evaluate(() => { const p = S.balls.get(0); return { x: p.x, y: p.y }; });
    const target = { x: 0.5, y: 0.4 };
    const a = await screenAt(A, cue), b = await screenAt(A, target);
    await A.mouse.move(a.x, a.y);
    await A.mouse.down();
    await A.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
    await A.mouse.move(b.x, b.y, { steps: 4 });
    await A.mouse.up();
    await A.waitForFunction((t) => { const p = S.balls.get(0); return Math.hypot(p.x - t.x, p.y - t.y) < 0.01; }, target, { timeout: 5000 })
      .catch(async () => fail(`cue ball at ${JSON.stringify(await A.evaluate(() => S.balls.get(0)))}`));
    await A.screenshot({ path: path.join(shots, 'view3d-top.png') });
    await A.click('#camTopBtn');
    await cameraIs(A, 'aim');
    console.log('top view placement ok');

    // The replay in 2D, and switching back and forth.
    await A.click('#viewBtn');
    await A.waitForFunction(() => S.view === '2d' && !v3 && !document.querySelector('.stage__table3d'));
    await A.click('#replayBtn');
    await A.waitForFunction(() => !!S.replay);
    await A.waitForFunction(() => !S.replay, null, { timeout: 30000 }); // runs to its end
    await A.click('#viewBtn');
    await A.waitForFunction(() => !!v3);
    await A.click('#viewBtn');
    await A.click('#viewBtn');
    await A.waitForFunction(() => S.view === '3d' && !!v3 && document.querySelectorAll('.stage__table3d').length === 1);
    console.log('2D replay and switching ok');
    await A.context().close(); // software WebGL is slow: one 3D page at a time

    // A phone opens in 2D; 3D can be turned on, and a touch names a ball.
    const P = await mk({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
    await practice(P);
    if (await P.evaluate(() => S.view) !== '2d') fail('a phone opened in 3D');
    await P.click('#viewBtn');
    await P.waitForFunction(() => !!v3, null, { timeout: 45000 });
    await cameraIs(P, 'aim');
    const one = await P.evaluate(() => { const p = S.balls.get(1); return { x: p.x, y: p.y }; });
    const at = await screenAt(P, one);
    await P.touchscreen.tap(at.x, at.y);
    await P.waitForFunction(() => S.hoverBall === 1, null, { timeout: 3000 }).catch(async () => fail(`the touch named ${await P.evaluate(() => S.hoverBall)}`));
    await P.screenshot({ path: path.join(shots, 'view3d-phone-landscape.png') });
    if (await P.evaluate(() => localStorage.getItem('pool:view')) !== '3d') fail('the choice was not kept');
    console.log('phone ok');

    // Graphics in Settings: each level sets the sharpness and the shadows;
    // only Auto steps down by itself.
    await P.click('#settingsBtn');
    const level = async (q) => {
      await P.click(`#qualitySeg [data-quality="${q}"]`);
      return P.evaluate(() => v3.quality);
    };
    const low = await level('low');
    if (low.ratio !== 1 || low.soft || low.shadow !== 512 || !low.fixed) fail(`3D low ${JSON.stringify(low)}`);
    const high = await level('high');
    if (!high.soft || high.shadow !== 2048 || !high.fixed) fail(`3D high ${JSON.stringify(high)}`);
    const auto = await level('auto');
    if (!auto.soft || auto.shadow !== 1024 || auto.fixed) fail(`3D auto ${JSON.stringify(auto)}`);
    await P.click('#settingsClose');
    console.log('3D graphics levels ok');

    // No WebGL: the table stays flat, with a word why.
    const N = await mk({ viewport: { width: 1100, height: 700 } }, () => {
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) { return /webgl/.test(type) ? null : get.call(this, type, ...rest); };
    });
    await practice(N);
    await N.waitForFunction(() => S.view === '2d' && !v3);
    if (!(await N.textContent('#toasts')).includes('3D is not available')) fail(`no notice: ${await N.textContent('#toasts')}`);
    console.log('no WebGL ok');

    if (errors.length) fail(errors.join('\n'));
    console.log('OK');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
