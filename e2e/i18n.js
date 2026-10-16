// English and Vietnamese (web/i18n.js): every sentence of the code has a
// Vietnamese line with the same {n} values and the same markup; a browser
// set to Vietnamese opens in Vietnamese; EN · VI on the home page and
// Language in Settings switch at once; two players in one room each read
// their own language; a server error reads in Vietnamese; and no sentence
// shown is missing a line (window.__i18nMissing).
// Usage: node i18n.js <base>
const { chromium } = require('playwright');
const flat = require('./flat');
const path = require('path');
const { appKeys, loadVI } = require('./i18n-keys');

const base = process.argv[2] || 'http://127.0.0.1:18080';
const shots = path.join(__dirname, 'shots');
require('fs').mkdirSync(shots, { recursive: true });

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
const text = async (page, sel) => (await page.textContent(sel)).replace(/\s+/g, ' ').trim();

// The table: every key of the code has a line, with the same placeholders
// and the same tags.
function checkTable() {
  const vi = loadVI();
  const holes = (s) => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort().join();
  const tags = (s) => [...s.matchAll(/<\/?[a-z]+/g)].map((m) => m[0]).sort().join();
  const bad = [];
  for (const k of appKeys()) {
    if (!/[A-Za-z]/.test(k)) continue;
    const v = vi[k];
    if (v === undefined) bad.push(`missing: ${k}`);
    else if (holes(v) !== holes(k)) bad.push(`values differ: ${k} → ${v}`);
    else if (tags(v) !== tags(k)) bad.push(`markup differs: ${k} → ${v}`);
  }
  for (const [k, v] of Object.entries(vi)) {
    if (holes(v) !== holes(k)) bad.push(`values differ: ${k} → ${v}`);
  }
  if (bad.length) fail(`the Vietnamese table:\n  ${bad.join('\n  ')}`);
  console.log(`table ok: ${appKeys().size} sentences of the code`);
}

(async () => {
  checkTable();
  const browser = await chromium.launch();
  const errors = [];
  const mk = async (options) => {
    const page = await (await flat(browser, options)).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    return page;
  };
  const missing = (page) => page.evaluate(() => [...window.__i18nMissing]);
  try {
    // A Vietnamese browser opens in Vietnamese, every word of the page too.
    const V = await mk({ viewport: { width: 1100, height: 700 }, locale: 'vi-VN' });
    await V.goto(base + '/');
    if (await V.evaluate(() => document.documentElement.lang) !== 'vi') fail('a Vietnamese browser did not open in Vietnamese');
    if ((await text(V, '#create')) !== 'Tạo phòng') fail(`create button: ${await text(V, '#create')}`);
    if ((await V.getAttribute('#langPick [data-lang="vi"]', 'aria-pressed')) !== 'true') fail('VI not pressed');
    await V.screenshot({ path: path.join(shots, 'i18n-vi-home.png') });

    // EN · VI on the home page switches at once, and is remembered.
    await V.click('#langPick [data-lang="en"]');
    if ((await text(V, '#create')) !== 'Create a room' || await V.evaluate(() => document.documentElement.lang) !== 'en') fail('EN on the home page');
    await V.reload();
    if ((await text(V, '#create')) !== 'Create a room') fail('English was not remembered');
    await V.click('#langPick [data-lang="vi"]');
    if ((await text(V, '#create')) !== 'Tạo phòng') fail('VI on the home page');
    console.log('home page and its switch ok');

    // One room, two languages.
    const E = await mk({ viewport: { width: 390, height: 800 }, locale: 'en-US', hasTouch: true, isMobile: true });
    await V.fill('#name', 'Hiếu');
    await V.click('#create');
    await V.waitForFunction(() => document.getElementById('landing').hidden);
    const code = await V.textContent('#roomCode');
    if (!(await text(V, '#lobbyText')).includes('Đang chờ đối thủ')) fail(`lobby: ${await text(V, '#lobbyText')}`);
    await E.goto(`${base}/?room=${code}`);
    if (await E.evaluate(() => document.documentElement.lang) !== 'en') fail('an English browser did not open in English');
    await E.fill('#name', 'Maryah');
    await E.click('#join');
    await E.waitForFunction(() => document.getElementById('landing').hidden);
    await V.click('#ready');
    await E.click('#ready');
    for (const p of [V, E]) await p.waitForFunction(() => S.phase === 'breaking');
    const [sv, se] = [await text(V, '#status'), await text(E, '#status')];
    if (!/phá bi/.test(sv) || !/break/.test(se)) fail(`statuses: vi "${sv}", en "${se}"`);
    await V.waitForTimeout(1800); // the Your turn banner goes
    await V.screenshot({ path: path.join(shots, 'i18n-vi-game.png') });
    console.log('one room, two languages ok:', sv, '|', se);

    // Settings → Table → Language, in the room.
    await V.click('#settingsBtn');
    await V.click('#settingsTabs [data-tab="table"]');
    await V.screenshot({ path: path.join(shots, 'i18n-vi-settings.png') });
    await V.click('#langSeg [data-lang="en"]');
    if (await V.evaluate(() => document.documentElement.lang) !== 'en' || !/Language/.test(await text(V, '#settings'))) fail('Language in Settings');
    await V.click('#langSeg [data-lang="vi"]');
    if (!/Ngôn ngữ/.test(await text(V, '#settings'))) fail('back to Vietnamese in Settings');
    await V.click('#settingsClose');
    const shooter = await V.evaluate(() => S.turn === S.seat) ? V : E;
    const panel = await text(V, shooter === V ? '#callText' : '#waitText');
    if (!/[ạ-ỹ]|Phá|Lượt/.test(panel)) fail(`Vietnamese panel: ${panel}`);
    console.log('Language in Settings ok:', panel);

    // On a phone the Vietnamese Settings tabs go two by two, each name on
    // one line (four to a row they broke: "Phòng / này", "Điều / khiển").
    const VP = await mk({ viewport: { width: 375, height: 667 }, locale: 'vi-VN', hasTouch: true, isMobile: true });
    await VP.goto(base + '/');
    await VP.click('#landingSettings');
    const tabs = await VP.evaluate(() => [...document.querySelectorAll('#settingsTabs .seg__btn')].filter((b) => b.offsetParent).map((b) => {
      const r = document.createRange();
      r.selectNodeContents(b);
      return { name: b.textContent.trim(), lines: new Set([...r.getClientRects()].map((q) => Math.round(q.top))).size };
    }));
    const broken = tabs.filter((t) => t.lines !== 1);
    if (!tabs.length || broken.length) fail(`Settings tabs on a phone: ${JSON.stringify(tabs)}`);
    await VP.close();
    console.log('Settings tabs on a phone ok:', tabs.map((t) => t.name).join(' · '));

    // A server error: the room is full.
    const Z = await mk({ viewport: { width: 1100, height: 700 }, locale: 'vi-VN' });
    await Z.goto(base + '/');
    await Z.evaluate((c) => connectAndJoin(c, 'Zed'), code);
    await Z.waitForFunction(() => !document.getElementById('landingError').hidden);
    const err = await text(Z, '#landingError');
    if (!err.includes('Phòng đã đủ người')) fail(`room full error: ${err}`);
    console.log('server error ok:', err);

    for (const p of [V, Z]) {
      const m = await missing(p);
      if (m.length) fail(`shown without a Vietnamese line: ${JSON.stringify(m)}`);
    }
    if (errors.length) fail(`page errors: ${errors.join('; ')}`);
    console.log('OK');
  } finally {
    await browser.close();
  }
})().catch((e) => { if (!process.exitCode) { console.error(e); process.exitCode = 1; } });
