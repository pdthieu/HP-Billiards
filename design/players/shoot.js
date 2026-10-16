// node shoot.js out.png "scene=sheet&view=front" [w h] [gpu|soft]
const fs = require('fs'), path = require('path');
const { chromium } = require(path.join(__dirname, '../../e2e/node_modules/playwright'));
const REPO = path.join(__dirname, '../../web');
const HERE = __dirname;
const shots = process.argv.slice(2);
(async () => {
  const mode = process.env.GL || 'gpu';
  const args = mode === 'soft' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'];
  const browser = await chromium.launch({ args });
  const jobs = [];
  for (let i = 0; i < shots.length; i += 2) jobs.push([shots[i], shots[i + 1]]);
  for (const [out, query] of jobs) {
    const qs = new URLSearchParams(query);
    const w = Number(qs.get('w') || 1200), h = Number(qs.get('h') || 800);
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
    await page.route('http://chars.test/**', (route) => {
      const u = new URL(route.request().url());
      const file = u.pathname.startsWith('/vendor/') ? path.join(REPO, u.pathname) : path.join(HERE, u.pathname.replace(/^\/chars\//, ''));
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'nope' });
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
      route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
    });
    const t = Date.now();
    await page.goto('http://chars.test/chars/sheet.html?' + query);
    try {
      await page.waitForFunction(() => window.__ready, null, { timeout: 120000 });
    } catch (e) { console.log('timeout', errors.join('\n')); }
    const built = await page.evaluate(() => window.__built);
    const joints = await page.evaluate(() => window.__joints);
    if (joints && process.env.JOINTS) console.log(JSON.stringify(joints, null, 1));
    await page.screenshot({ path: out });
    console.log(out, 'built', built, 'ms; total', Date.now() - t, 'ms', errors.length ? '\n  ' + errors.slice(0, 6).join('\n  ') : '');
    await ctx.close();
  }
  await browser.close();
})();
