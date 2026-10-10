// Landing page: invite mode, name validation and memory, the room limit.
// Usage: node landing.js [base] [base of a server started with -max-rooms 1]
const { chromium } = require('playwright');
const flat = require('./flat');
const path = require('path');
const base = process.argv[2] || 'http://127.0.0.1:18080';
const lim = process.argv[3] || 'http://127.0.0.1:18081';
const shots = path.join(__dirname, 'shots');
require('fs').mkdirSync(shots, { recursive: true });
(async () => {
  const browser = await chromium.launch();
  const page = await (await flat(browser, { viewport: { width: 420, height: 760 } })).newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/?room=ABCDE');
  await page.waitForTimeout(200);
  const t = await page.textContent('#landingTitle');
  if (t.replace(/\s+/g, ' ').trim() !== 'Join room ABCDE') throw new Error('title ' + t);
  if (!(await page.isVisible('#landingInvite'))) throw new Error('invite block hidden');
  if (!(await page.isHidden('#createRow')) || !(await page.isHidden('#code'))) throw new Error('create/code visible in join mode');
  if (await page.evaluate(() => document.activeElement.id) !== 'name') throw new Error('name not focused');
  await page.screenshot({ path: path.join(shots, '11-join-screen.png') });
  // empty name on the plain landing: create is refused with a message
  await page.goto(base + '/');
  await page.waitForTimeout(200);
  if (await page.isVisible('#landingInvite')) throw new Error('invite block shown on the plain landing');
  if (!(await page.isVisible('#landingBrand'))) throw new Error('brand hidden on the plain landing');
  await page.fill('#name', '');
  await page.click('#create');
  await page.waitForTimeout(200);
  const err = await page.textContent('#nameError');
  if (!(await page.isVisible('#nameError')) || !/name/.test(err)) throw new Error('no name error: ' + err);
  if (!(await page.evaluate(() => document.getElementById('name').classList.contains('input--error')))) throw new Error('input not marked');
  await page.fill('#name', 'x');
  if (await page.isVisible('#nameError')) throw new Error('error not cleared on input');
  await page.click('#shuffleName');
  if (!/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(await page.inputValue('#name'))) throw new Error('shuffle did not suggest a name');
  // the remembered name comes back after a reload
  await page.fill('#name', 'Remembered Me');
  await page.click('#create');
  await page.waitForTimeout(300);
  await page.goto(base + '/');
  await page.waitForTimeout(200);
  if (await page.inputValue('#name') !== 'Remembered Me') throw new Error('name not remembered');

  // room limit: a server with -max-rooms 1
  await page.goto(lim + '/');
  await page.waitForTimeout(300);
  let res = await page.evaluate(async (u) => { const r = await fetch(u + '/api/rooms', { method: 'POST' }); return [r.status, await r.json()]; }, lim);
  if (res[0] !== 200) throw new Error('first room refused ' + JSON.stringify(res));
  res = await page.evaluate(async (u) => { const r = await fetch(u + '/api/rooms', { method: 'POST' }); return [r.status, await r.json()]; }, lim);
  if (res[0] !== 409 || res[1].error !== 'room_limit') throw new Error('second room not refused ' + JSON.stringify(res));
  await page.waitForTimeout(3200); // next poll
  if (!(await page.isDisabled('#create'))) throw new Error('create not disabled at the limit');
  const note = await page.textContent('#createNote');
  if (!/1 rooms? are in use/.test(note)) throw new Error('note: ' + note);
  if (!/1 of 1 in use/.test(await page.textContent('#roomsCount'))) throw new Error('rooms count');
  const joinBtn = await page.textContent('#roomList li .room-row__join');
  if (joinBtn !== 'Join') throw new Error('empty room not joinable: ' + joinBtn);
  await page.screenshot({ path: path.join(shots, '12-room-limit.png') });

  // The home page only ever scrolls up and down, in each of its shapes and
  // both tabs: nothing in it is wider than the screen, and no pane that
  // scrolls has more to the side than it shows. A few rooms fill the list.
  for (const data of [{ mode: '9ball', race: 5, table: 'predator', cloth: 'electric-blue' }, { mode: '3cushion' }, { table: 'rasson', spectators: 0 }]) {
    const res = await page.request.post(base + '/api/rooms', { data });
    if (!res.ok()) throw new Error(`room ${JSON.stringify(data)}: ${res.status()}`);
  }
  const shapes = [
    { width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844, phone: true },
    { width: 360, height: 640, phone: true }, { width: 844, height: 390, phone: true }, { width: 844, height: 340, phone: true },
  ];
  for (const { width, height, phone } of shapes) {
    const p = await (await flat(browser, { viewport: { width, height }, hasTouch: !!phone, isMobile: !!phone })).newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base + '/');
    await p.waitForSelector('#roomList li.room-row', { state: 'attached' });
    for (const tab of ['#tabNew', '#tabRooms']) {
      if (await p.isVisible(tab)) await p.click(tab);
      const wide = await p.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const out = document.documentElement.scrollWidth > vw ? [`the page is ${document.documentElement.scrollWidth} px`] : [];
        for (const el of document.querySelectorAll('#landing, #landing *')) {
          const cs = getComputedStyle(el);
          const scrolls = /auto|scroll/.test(cs.overflowX) || (cs.overflowX === 'hidden' && /auto|scroll/.test(cs.overflowY));
          if (scrolls && el.scrollWidth > el.clientWidth) out.push(`${el.id || el.className}: ${el.scrollWidth} in ${el.clientWidth}`);
          const b = el.getBoundingClientRect();
          if (b.width && (b.left < -0.5 || b.right > vw + 0.5)) out.push(`${el.id || el.className} at ${Math.round(b.left)}–${Math.round(b.right)}`);
        }
        return out;
      });
      if (wide.length) throw new Error(`${width}x${height} ${tab}: wider than the screen: ${wide.slice(0, 6).join('; ')}`);
    }
    await p.screenshot({ path: path.join(shots, `home-${width}x${height}.png`) });
    await p.context().close();
  }
  console.log('home fits every screen');

  if (errors.length) throw new Error(errors.join('\n'));
  console.log('landing OK');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
