// Your player (CLIENT.md, "Your player"): the face before the name, a tip
// pointing at it the first time, opens the sheet with the player on its
// stage; made by hand (the body and its
// hairstyles, a colour shown at once without meshing again, a measure of
// the face meshed again a moment after), the stage drawing nothing while
// nothing changes; Done keeps the look and a picture of the face, × keeps
// nothing; a photo read on the device (cancelled the first time, then the
// colours and the measures it set, Undo), one without a face and a file
// that is no picture; the look going with the name to a room; on a phone
// the sheet filling the screen. Quick changes of shape end on the newest.
// Usage: node player.js <base>
const { chromium } = require('playwright');
const path = require('path');

const base = process.argv[2] || 'http://127.0.0.1:18080';
const shots = path.join(__dirname, 'shots');
require('fs').mkdirSync(shots, { recursive: true });

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
// (software WebGL on a busy machine can take a while)
const stageReady = (page) => page.waitForFunction(() => window.__playerStage && window.__playerStage.ready, null, { timeout: 180000, polling: 200 })
  .catch(() => fail('the stage did not show the player'));
const toMode = (page, mode, timeout = 90000) => page.waitForFunction((m) => document.querySelector('.player__sheet').dataset.mode === m, mode, { timeout, polling: 100 })
  .catch(async () => fail(`the sheet is in ${await page.evaluate(() => document.querySelector('.player__sheet').dataset.mode)}, not ${mode}`));
const draft = (page) => page.evaluate(() => JSON.parse(JSON.stringify(ME.draft)));
const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('pool:look') || 'null'));
// still: the stage has stopped drawing (the camera at rest, nothing new)
async function still(page) {
  for (let i = 0; i < 60; i++) {
    const a = await page.evaluate(() => window.__playerStage.frames);
    await page.waitForTimeout(700);
    if (await page.evaluate(() => window.__playerStage.frames) === a) return;
  }
  fail('the stage never stops drawing');
}
// picture: a picture drawn in the page, as a file to choose
async function picture(page, name, draw) {
  const url = await page.evaluate(draw);
  return { name, mimeType: url.slice(5, url.indexOf(';')), buffer: Buffer.from(url.slice(url.indexOf(',') + 1), 'base64') };
}

(async () => {
  // Software WebGL, as on a machine without a GPU.
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  const mk = async (options) => {
    const ctx = await browser.newContext(options);
    // the room on the flat table: the stage is the only 3D here
    await ctx.addInitScript(() => { try { localStorage.setItem('pool:view', '2d'); } catch { /* unavailable */ } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    // MediaPipe tells of its CPU delegate as an error
    page.on('console', (m) => { if (m.type() === 'error' && !/XNNPACK/.test(m.text())) errors.push(`console: ${m.text()}`); });
    return page;
  };
  try {
    const A = await mk({ viewport: { width: 1280, height: 800 } });
    await A.goto(base + '/');
    await A.fill('#name', 'Ann');
    if (!/^data:image\/svg/.test(await A.getAttribute('#playerFaceImg', 'src'))) fail('no drawn face before the name');
    if (await A.isHidden('#faceTip')) fail('no tip under the face the first time');
    await A.click('#playerFace');
    if (await A.isHidden('#player')) fail('the sheet did not open');
    if (await A.isVisible('#faceTip') || await A.evaluate(() => localStorage.getItem('pool:faceTip')) !== '1') fail('the tip stays once the sheet is open');
    await stageReady(A);
    if ((await draft(A)).body !== 'man') fail('the first player is not the man');
    if (await A.locator('#playerHair [data-hair]').count() !== 3 || await A.isHidden('#playerBeardField')) fail('his hairstyles or beard are missing');
    await still(A);
    console.log('the sheet opens on the player ok');

    // a shape changed back while the other is on its way: the newest wins
    await A.click('#playerBodySeg [data-body="woman"]');
    await A.click('#playerBodySeg [data-body="man"]');
    await stageReady(A);
    if (await A.evaluate(() => window.__playerStage.look.body) !== 'man') fail('a quick change back left the other shape on the stage');
    // by hand: the woman, with her own hairstyles and no beard
    await A.click('#playerBodySeg [data-body="woman"]');
    const her = await draft(A);
    if (her.body !== 'woman' || her.hair !== 'pony') fail(`the woman's draft: ${JSON.stringify(her)}`);
    if (await A.locator('#playerHair [data-hair]').count() !== 2 || await A.isVisible('#playerBeardField')) fail('her hairstyles or the beard are wrong');
    await stageReady(A);
    await A.click('#playerHair [data-hair="bun"]');
    await stageReady(A);
    await still(A);
    // a colour shows at once, with no new mesh: one frame drawn, still ready
    const f0 = await A.evaluate(() => window.__playerStage.frames);
    await A.click('#playerHairColor [data-color="#9a4a26"]');
    if (!(await A.evaluate(() => window.__playerStage.ready && !window.__playerStage.busy))) fail('a colour meshed the player again');
    await A.waitForFunction((f) => window.__playerStage.frames > f, f0, { timeout: 10000, polling: 100 }).catch(() => fail('a colour was not drawn'));
    if (await A.getAttribute('#playerHairColor [data-color="#9a4a26"]', 'aria-pressed') !== 'true') fail('the colour picked is not marked');
    // a measure: the face meshed again once the slider stops
    await A.evaluate(() => { const i = document.querySelector('#playerRanges input[data-measure="w"]'); i.value = '90'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    if ((await draft(A)).face.w !== 1.12) fail(`the face's width is ${(await draft(A)).face.w}`);
    await A.waitForFunction(() => window.__playerStage.busy, null, { timeout: 5000, polling: 50 }).catch(() => fail('the measure was not meshed'));
    await stageReady(A);
    await A.screenshot({ path: path.join(shots, 'player-hand.png') });
    console.log('by hand: body, hair, colour at once, a measure ok');

    // Done keeps the look and a picture of the face
    await A.click('#playerDone');
    if (await A.isVisible('#player')) fail('Done left the sheet open');
    const kept = await saved(A);
    if (!kept || kept.body !== 'woman' || kept.hair !== 'bun' || kept.hairColor !== '#9a4a26' || kept.face.w !== 1.12) fail(`kept ${JSON.stringify(kept)}`);
    if (!/^data:image\/png/.test(await A.getAttribute('#playerFaceImg', 'src'))) fail('no picture of the face before the name');
    // × keeps nothing
    await A.click('#playerFace');
    await stageReady(A);
    await A.click('#playerSkin [data-color="#8d5a3c"]');
    await A.click('#playerClose');
    if (JSON.stringify(await saved(A)) !== JSON.stringify(kept)) fail('× kept the change');
    console.log('Done keeps, × does not ok');

    // a photo: the player's own face, on a grey wall
    await A.click('#playerFace');
    await stageReady(A);
    const photo = await picture(A, 'me.jpg', async () => {
      const shot = new Image();
      shot.src = window.__playerStage.snapshot(512);
      await shot.decode();
      const c = document.createElement('canvas');
      c.width = c.height = 512;
      const g = c.getContext('2d');
      g.fillStyle = '#6b7079';
      g.fillRect(0, 0, 512, 512);
      g.drawImage(shot, 0, 0);
      return c.toDataURL('image/jpeg', 0.9);
    });
    const before = await draft(A);
    // the first time the reader comes down: cancelled, nothing changes
    await A.setInputFiles('#playerFile', photo);
    await toMode(A, 'read', 10000);
    if (await A.isHidden('#playerFirst')) fail('no first-time note while the reader loads');
    await A.click('#playerCancel');
    await toMode(A, 'edit', 5000);
    if (JSON.stringify(await draft(A)) !== JSON.stringify(before) || await A.isVisible('#playerTaken')) fail('a cancelled photo changed the player');
    // read
    await A.setInputFiles('#playerFile', photo);
    await toMode(A, 'read', 10000);
    await A.waitForFunction(() => document.querySelector('.player__sheet').dataset.mode === 'edit' && !!ME.photo, null, { timeout: 90000, polling: 200 })
      .catch(async () => fail(`the photo was not read: ${await A.evaluate(() => document.querySelector('.player__sheet').dataset.mode)}`));
    const read = await A.evaluate(() => ME.photo.look), now = await draft(A);
    const ranges = await A.evaluate(() => ME.body3d.FACE_RANGES);
    for (const k of ['w', 'jaw', 'chin', 'cheek', 'eye', 'gap', 'nose', 'mouth', 'lips']) {
      const v = read.face[k], [lo, hi] = ranges[k];
      if (!(v >= lo && v <= hi) || now.face[k] !== v) fail(`the photo's ${k}: ${v} (draft ${now.face[k]})`);
    }
    if (!read.skin || now.skin !== read.skin || (read.eyes && now.eyes !== read.eyes)) fail(`the photo's colours ${JSON.stringify(read)} draft ${JSON.stringify(now)}`);
    if (now.body !== 'woman' || now.hair !== 'bun') fail('the photo changed the body or the hairstyle');
    // the hair is the auburn above the hairline, not the forehead under it
    const luma = (h) => [1, 3, 5].reduce((a, i, k) => a + parseInt(h.slice(i, i + 2), 16) / 255 * [0.2126, 0.7152, 0.0722][k], 0);
    if (!read.hairColor || luma(read.skin) - luma(read.hairColor) < 0.15) fail(`the photo's hair ${read.hairColor} is not the hair (skin ${read.skin})`);
    if (await A.isHidden('#playerTaken') || await A.locator('#playerChips .taken__chip').count() < 3) fail('what the photo set is not shown');
    if (await A.locator('#playerSkin .cloth-pick__swatch').first().locator('.cloth-pick__badge').count() !== 1) fail("the photo's skin is not first");
    if (await A.locator('#playerRanges .range__tick:not([hidden])').count() !== 9) fail("the photo's measures are not marked");
    if (await A.isHidden('#playerUndo') || await A.isHidden('#playerAnother') || await A.isHidden('#playerThumb')) fail('Undo, Another photo or the photo is missing');
    if (await A.evaluate(() => localStorage.getItem('pool:faceReader')) !== '1') fail('the reader is not remembered as loaded');
    await stageReady(A);
    await A.screenshot({ path: path.join(shots, 'player-photo.png') });
    // Undo: back to the player before the photo
    await A.click('#playerUndo');
    if (JSON.stringify(await draft(A)) !== JSON.stringify(before) || await A.isVisible('#playerTaken') || await A.isVisible('#playerUndo')) fail('Undo did not go back');
    console.log(`photo read: skin ${read.skin}, hair ${read.hairColor}, eyes ${read.eyes}; Undo ok`);

    // no face, then no picture at all: say so, make the player by hand
    const table = await picture(A, 'table.png', () => {
      const c = document.createElement('canvas');
      c.width = 640; c.height = 400;
      const g = c.getContext('2d');
      g.fillStyle = '#4a2a14'; g.fillRect(0, 0, 640, 400);
      g.fillStyle = '#1d6b3a'; g.fillRect(30, 30, 580, 340);
      for (const [x, y, col] of [[200, 200, '#f4f0e6'], [420, 180, '#e2b52c'], [450, 230, '#1e3fa8']]) { g.fillStyle = col; g.beginPath(); g.arc(x, y, 12, 0, Math.PI * 2); g.fill(); }
      return c.toDataURL('image/png');
    });
    await A.setInputFiles('#playerFile', table);
    await toMode(A, 'noface');
    if (await A.isHidden('#playerPick') || await A.isHidden('#playerHand')) fail('no way on from a photo without a face');
    await A.click('#playerHand');
    await toMode(A, 'edit', 5000);
    await A.setInputFiles('#playerFile', { name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('not a picture') });
    await toMode(A, 'noface', 10000);
    await A.click('#playerHand');
    await A.click('#playerClose');
    console.log('no face, no picture ok');

    // the look goes with the name: the room shows it back
    const sent = [];
    A.on('websocket', (ws) => ws.on('framesent', (f) => sent.push(String(f.payload))));
    await A.click('#create');
    await A.waitForFunction(() => S.phase === 'lobby' && S.players[0] && S.players[0].look, null, { timeout: 20000 })
      .catch(async () => fail(`the room has ${JSON.stringify(await A.evaluate(() => S.players))}`));
    const join = sent.map((s) => { try { return JSON.parse(s); } catch { return {}; } }).find((m) => m.type === 'join');
    if (!join || !join.look || join.look.hairColor !== '#9a4a26') fail(`the join sent ${JSON.stringify(join)}`);
    const back = await A.evaluate(() => S.players[0].look);
    if (back.body !== 'woman' || back.hair !== 'bun' || back.hairColor !== '#9a4a26' || back.face.w !== 1.12) fail(`the room has the look ${JSON.stringify(back)}`);
    console.log('the look goes to the room ok');
    await A.context().close();

    // entering a room puts the tip away too
    const R = await mk({ viewport: { width: 1280, height: 800 } });
    await R.goto(base + '/');
    await R.fill('#name', 'Cy');
    if (await R.isHidden('#faceTip')) fail('no tip under the face');
    await R.click('#create');
    await R.waitForFunction(() => document.getElementById('landing').hidden && S.players[0] && S.players[0].name, null, { timeout: 20000 });
    if (await R.evaluate(() => localStorage.getItem('pool:faceTip')) !== '1') fail('the tip is kept after entering a room');
    await R.context().close();
    console.log('the tip under the face ok');

    // a phone: the sheet fills the screen, its buttons in reach
    const P = await mk({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await P.goto(base + '/');
    await P.fill('#name', 'Bo');
    if (await P.isHidden('#faceTip')) fail('no tip under the face on the phone');
    await P.tap('#playerFace');
    await stageReady(P);
    const fit = await P.evaluate(() => {
      const r = document.querySelector('.player__sheet').getBoundingClientRect(), d = document.querySelector('#playerDone').getBoundingClientRect();
      const body = document.querySelector('#playerBody');
      return { sheet: [r.left, r.top, r.right, r.bottom].map(Math.round), done: d.bottom <= innerHeight && d.top >= 0, wide: document.documentElement.scrollWidth - innerWidth, side: body.scrollWidth - body.clientWidth };
    });
    if (fit.sheet.join() !== '0,0,390,844' || !fit.done || fit.wide > 0 || fit.side > 0) fail(`the sheet on a phone: ${JSON.stringify(fit)}`);
    await P.screenshot({ path: path.join(shots, 'player-phone.png') });
    await P.tap('#playerClose');
    console.log('on a phone the sheet fills the screen ok');
    await P.context().close();

    if (errors.length) fail(`errors: ${errors.slice(0, 5).join(' | ')}`);
    console.log('player OK');
  } catch (e) {
    if (!process.exitCode) { console.error(e); process.exitCode = 1; }
  } finally {
    await browser.close();
  }
})();
