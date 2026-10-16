// node anim.js outdir "scene=stance&frames=24": render the stroke frames and keep them as JPEGs
const fs = require('fs'), path = require('path');
const { chromium } = require(path.join(__dirname, '../../e2e/node_modules/playwright'));
const REPO = path.join(__dirname, '../../web');
(async () => {
  const [outDir, query] = process.argv.slice(2);
  const qs = new URLSearchParams(query);
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
  const ctx = await browser.newContext({ viewport: { width: Number(qs.get('w') || 900), height: Number(qs.get('h') || 600) } });
  const page = await ctx.newPage();
  await page.route('http://chars.test/**', (route) => {
    const u = new URL(route.request().url());
    const file = u.pathname.startsWith('/vendor/') ? path.join(REPO, u.pathname) : path.join(__dirname, u.pathname.replace(/^\/chars\//, ''));
    route.fulfill({ status: 200, contentType: file.endsWith('.html') ? 'text/html' : 'text/javascript', body: fs.readFileSync(file) });
  });
  await page.goto('http://chars.test/chars/sheet.html?' + query);
  await page.waitForFunction(() => window.__ready, null, { timeout: 120000 });
  const n = await page.evaluate(() => window.__animate());
  fs.mkdirSync(outDir, { recursive: true });
  const frames = await page.evaluate(() => window.__frames);
  frames.forEach((d, i) => fs.writeFileSync(path.join(outDir, `f${String(i).padStart(3, '0')}.jpg`), Buffer.from(d.split(',')[1], 'base64')));
  console.log('frames', n);
  await browser.close();
})();
