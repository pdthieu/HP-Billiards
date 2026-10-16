// node ingame.js: pictures of the players in the running game's 3D view.
// The game is the local dev server; the players come from inject.js, put in
// through the page, so web/ is not touched.
const fs = require('fs'), path = require('path');
const { chromium } = require(path.join(__dirname, '../../e2e/node_modules/playwright'));
const base = process.env.BASE || 'http://127.0.0.1:8093';
const HERE = __dirname, OUT = path.join(HERE, process.env.OUTDIR || 'out');
const only = process.argv.slice(2);

async function open(browser, viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: opts.dpr || 2, isMobile: !!opts.mobile, hasTouch: !!opts.mobile });
  await ctx.route('**/chars/**', (route) => {
    const u = new URL(route.request().url());
    const file = path.join(HERE, u.pathname.replace(/^\/chars\//, ''));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'nope' });
    route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(file) });
  });
  await ctx.addInitScript((o) => { Object.assign(window, o); import('/chars/inject.js'); }, opts.init || {});
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  return page;
}
async function practice(page) {
  await page.goto(base + '/');
  await page.fill('#name', 'Ann');
  await page.click('#practice');
  await page.waitForFunction(() => S.practice && S.phase === 'open');
  await page.evaluate(() => { if (S.view !== '3d' && typeof setView === 'function') setView('3d'); });
  await page.waitForFunction(() => typeof v3 !== 'undefined' && v3 && window.__chars && window.__chars.scene, null, { timeout: 60000 });
}
const settle = (page, mode) => page.waitForFunction((m) => v3 && v3.mode === m && v3.settled, mode, { timeout: 30000 });

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
  const shots = {
    // desktop: behind the cue, the opponent in her chair across the table
    async aim() {
      const page = await open(browser, { width: 1280, height: 800 });
      await practice(page);
      await page.evaluate(() => setAngle(-0.5));
      await settle(page, 'aim');
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(OUT, 'ig-aim.png') });
      // the stroke: the cue drawn back
      await page.evaluate(() => { setPower(0.55); shoot(); });
      await page.waitForFunction(() => v3 && v3.mode === 'follow', null, { timeout: 10000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, 'ig-follow.png') });
      console.log('aim, follow', page.errors.slice(0, 4));
    },
    async lobby() {
      const page = await open(browser, { width: 1280, height: 800 }, { init: {} });
      await page.goto(base + '/');
      await page.fill('#name', 'Ann');
      await page.click('#create');
      await page.waitForFunction(() => S.phase === 'lobby' && v3 && window.__chars && window.__chars.scene, null, { timeout: 60000 });
      await page.evaluate(() => { window.__chars.mode = 'stand'; });
      for (const [i, t] of [[1, 2500], [2, 9000], [3, 9000]]) {
        await page.waitForTimeout(t);
        await page.screenshot({ path: path.join(OUT, `ig-lobby${i}.png`) });
      }
      console.log('lobby', page.errors.slice(0, 4));
    },
    async phone() {
      const page = await open(browser, { width: 390, height: 844 }, { mobile: true, dpr: 3 });
      await practice(page);
      await page.evaluate(() => setAngle(-0.5));
      await settle(page, 'aim');
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(OUT, 'ig-phone.png') });
      console.log('phone', page.errors.slice(0, 4));
    },
    async land() {
      const page = await open(browser, { width: 844, height: 390 }, { mobile: true, dpr: 3 });
      await practice(page);
      await page.evaluate(() => setAngle(-0.5));
      await settle(page, 'aim');
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(OUT, 'ig-land.png') });
      console.log('land', page.errors.slice(0, 4));
    },
  };
  for (const [k, fn] of Object.entries(shots)) {
    if (only.length && !only.includes(k)) continue;
    try { await fn(); } catch (e) { console.log(k, 'failed', e.message.split('\n')[0]); }
  }
  await browser.close();
})();
