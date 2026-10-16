// phone-audit.js: the in-game screens on phones, pictured and measured. Not
// a pass/fail scenario (run.js does not run it): it writes a picture and a
// JSON of findings per state; phone-audit-report.py sums them up.
// BASE=http://127.0.0.1:8098 node phone-audit.js <outdir> <en|vi> <WxH> [<WxH> ...]
// (a server with room to spare: -max-rooms 300 -abandon 3s; launch.json's
// pool-audit).
// The phone (A) makes a room, a desktop (B) joins, they rack and break; then
// A's screen is taken in each state: aiming, pulling the bar, waiting, the
// 8-ball to call, ball in hand, Settings, chat, the game's end. States after
// the break are set on A's client for the picture.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const base = process.env.BASE || 'http://127.0.0.1:8093';
const [outDir, lang, ...sizes] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function metrics() {
  const vw = innerWidth, vh = innerHeight, de = document.documentElement;
  const shown = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    if (!el.offsetParent && cs.position !== 'fixed' && el.tagName !== 'BODY') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const name = (el) => el.id ? '#' + el.id : (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : el.tagName.toLowerCase());
  const label = (el) => (el.getAttribute('aria-label') || el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 32);
  const R = (r) => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  const out = { hscroll: de.scrollWidth > de.clientWidth + 1, vscroll: de.scrollHeight > de.clientHeight + 1, small: [], offscreen: [], overlaps: [], clipped: [] };
  const ctl = [...document.querySelectorAll('button, [role=button], [role=slider], input, select, a[href]')].filter(shown);
  for (const b of ctl) {
    const r = b.getBoundingClientRect();
    if (Math.min(r.width, r.height) < 40) out.small.push(`${name(b)} "${label(b)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
    if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) out.offscreen.push(`${name(b)} "${label(b)}" ${R(r)}`);
  }
  for (let i = 0; i < ctl.length; i++) for (let j = i + 1; j < ctl.length; j++) {
    const a = ctl[i], b = ctl[j];
    if (a.contains(b) || b.contains(a)) continue;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const ix = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (ix > 2 && iy > 2) out.overlaps.push(`${name(a)} × ${name(b)} ${Math.round(ix)}×${Math.round(iy)}`);
  }
  for (const el of document.querySelectorAll('body *')) {
    if (el.tagName === 'CANVAS' || el.tagName === 'svg' || !shown(el)) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const cs = getComputedStyle(el);
    const wide = el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0;
    const tall = el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0 && cs.overflowY !== 'visible';
    if ((wide && (cs.overflowX !== 'visible' || cs.textOverflow === 'ellipsis')) || tall) out.clipped.push(`${name(el)} "${label(el)}" ${el.scrollWidth}x${el.scrollHeight}/${el.clientWidth}x${el.clientHeight}`);
    // text running out of the screen
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) out.offscreen.push(`${name(el)} "${label(el)}" ${R(r)}`);
  }
  let minFont = 99, minEl = '';
  for (const el of document.querySelectorAll('body *')) {
    if (!shown(el) || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const f = parseFloat(getComputedStyle(el).fontSize);
    if (f < minFont) { minFont = f; minEl = `${name(el)} "${label(el)}"`; }
  }
  out.minFont = `${minFont}px ${minEl}`;
  const box = (s) => { const e = document.querySelector(s); return e && shown(e) ? R(e.getBoundingClientRect()) : null; };
  out.geo = { mode: [...document.body.classList].filter((c) => /phone|playing|lefty/.test(c)).join(' '), pbar: box('#powerBar'), track: box('#powerTrack'), table: box('#table'), wrap: box('#tableWrap'), controls: box('#controls'), top: box('#top') };
  // how wide a target the bar is: where a touch at its middle height lands on it
  const pb = document.getElementById('powerBar');
  if (pb && shown(pb)) {
    const r = pb.getBoundingClientRect(), y = r.top + r.height / 2;
    let x0 = null, x1 = null;
    for (let x = 0; x < vw; x++) { const e = document.elementFromPoint(x, y); if (e && pb.contains(e)) { if (x0 === null) x0 = x; x1 = x; } }
    out.geo.hit = x0 === null ? null : [x0, x1 - x0 + 1];
  }
  return out;
}

async function one(browser, size) {
  const [vw, vh] = size.split('x').map(Number);
  const mk = async (opts) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript((l) => { try { localStorage.setItem('pool:view', '2d'); localStorage.setItem('pool:lang', l); } catch { } }, lang);
    const p = await ctx.newPage();
    p.errs = [];
    p.on('pageerror', (e) => p.errs.push(e.message));
    return p;
  };
  const A = await mk({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const B = await mk({ viewport: { width: 1100, height: 700 } });
  const res = { size, lang, states: {} };
  const tag = `${lang}-${size}`;
  const shot = async (state) => {
    await sleep(350);
    await A.screenshot({ path: path.join(outDir, `${tag}-${state}.png`) });
    res.states[state] = await A.evaluate(metrics);
  };
  try {
    await A.goto(base + '/');
    await A.fill('#name', lang === 'vi' ? 'Nguyễn Thị Minh Khai' : 'Annabelle Featherstone');
    await A.click('#create');
    await A.waitForFunction(() => document.getElementById('landing').hidden);
    const code = await A.textContent('#roomCode');
    await B.goto(`${base}/?room=${code}`);
    await B.fill('#name', lang === 'vi' ? 'Trần Bảo Ngọc' : 'Bob');
    await B.click('#join');
    await B.waitForFunction(() => document.getElementById('landing').hidden);
    await A.waitForFunction(() => document.getElementById('seat1').textContent.trim().length > 0);
    await shot('lobby');
    await A.click('#ready');
    await B.click('#ready');
    await A.waitForFunction(() => S.phase === 'breaking');
    await sleep(500);
    const aTurn = await A.evaluate(() => S.turn === S.seat);
    const breaker = aTurn ? A : B;
    await breaker.evaluate(() => { setPower(0.55); shoot(); });
    await A.waitForFunction(() => S.phase !== 'breaking' && !S.moving, null, { timeout: 30000 }).catch(() => {});
    await sleep(3500);
    const setTurn = (mine, extra = {}) => A.evaluate(([mine, extra]) => {
      S.groups = ['solids', 'stripes'];
      for (const id of [1, 3, 10, 14]) S.balls.delete(id);
      S.turn = mine ? S.seat : 1 - S.seat;
      if (S.clock) S.clock.seat = S.turn;
      S.ballInHand = !!extra.inHand;
      S.call = null;
      if (extra.eight) for (const id of [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15]) S.balls.delete(id);
      refreshPanels(); renderTrays(); wakeDraw();
    }, [mine, extra]);
    await setTurn(true);
    await sleep(1500);
    await shot('aim');
    // a finger's pull on the bar, from where it lands; back to there and
    // up, which shoots nothing
    const t = await A.locator('#powerTrack').boundingBox();
    if (t) {
      const cdp = await A.context().newCDPSession(A);
      const touch = (type, f) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: f === null ? [] : [{ x: t.x + t.width / 2, y: t.y + t.height * f, id: 0 }] });
      await touch('touchStart', 0.25);
      for (const f of [0.35, 0.45, 0.55, 0.62]) await touch('touchMove', f);
      await shot('pull');
      await touch('touchMove', 0.25);
      await touch('touchEnd', null);
    }
    await setTurn(true, { inHand: true });
    await shot('inhand');
    await setTurn(true, { eight: true });
    await shot('call8');
    await setTurn(false);
    await sleep(800);
    await shot('wait');
    await A.click('#settingsBtn').catch(() => {});
    await shot('settings');
    await A.keyboard.press('Escape');
    await sleep(300);
    if (await A.locator('#chatBtn').isVisible()) {
      await A.click('#chatBtn');
      await shot('chat');
      await A.keyboard.press('Escape');
    }
    await A.evaluate(() => { S.phase = 'game_over'; S.winner = S.seat; refreshPanels(); renderTrays(); wakeDraw(); });
    await shot('over');
  } catch (e) {
    res.error = e.message.split('\n')[0];
  }
  res.errors = [...A.errs, ...B.errs].slice(0, 5);
  await A.context().close();
  await B.context().close();
  return res;
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  for (const size of sizes) {
    const t = Date.now();
    const r = await one(browser, size);
    fs.writeFileSync(path.join(outDir, `${lang}-${size}.json`), JSON.stringify(r, null, 1));
    console.log(lang, size, r.error || 'ok', Math.round((Date.now() - t) / 1000) + 's');
  }
  await browser.close();
})();
