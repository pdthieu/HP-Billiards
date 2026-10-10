// Tables and cloths: picked on the landing (the table behind it shows the
// pick), sent with the new room, shown to the player who joins and in the
// room list; changed in Settings → This room for everyone, a new table
// asking both players to be ready again and a new cloth not; a practice
// room racks again on a new table; 3D builds each table's legs.
// Usage: node tables.js <base>
const { chromium } = require('playwright');
const flat = require('./flat');
const path = require('path');

const base = process.argv[2] || 'http://127.0.0.1:18080';
const shots = path.join(__dirname, 'shots');
require('fs').mkdirSync(shots, { recursive: true });

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const mk = async (options) => {
    const page = await (await flat(browser, options)).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    return page;
  };
  const A = await mk({ viewport: { width: 1100, height: 760 } });
  const B = await mk({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  try {
    // The pickers: four tables with their pockets, eight cloths; the table
    // behind the landing takes the pick.
    await A.goto(base + '/');
    if (await A.locator('#landingTable [data-table]').count() !== 4) fail('not four tables');
    if (await A.locator('#landingCloth [data-cloth]').count() !== 8) fail('not eight cloths');
    if (!(await A.textContent('#landingTable [data-table="acurra"]')).includes('corners 4″ · sides 4.5″')) fail(`acurra: ${await A.textContent('#landingTable [data-table="acurra"]')}`);
    await A.click('#landingTable [data-table="predator"]');
    await A.click('#landingCloth [data-cloth="electric-blue"]');
    if (await A.getAttribute('#landingTable [data-table="predator"]', 'aria-pressed') !== 'true') fail('predator not pressed');
    if (!(await A.textContent('#landingClothLabel')).includes('Electric Blue')) fail(`cloth label: ${await A.textContent('#landingClothLabel')}`);
    const behind = await A.evaluate(() => ({ table: S.table, cloth: S.cloth, half: POCKETS[0].half }));
    if (behind.table !== 'predator' || behind.cloth !== 'electric-blue' || Math.abs(behind.half - 0.054) > 1e-9) fail(`behind the landing: ${JSON.stringify(behind)}`);
    if (!(await A.isVisible('#create'))) fail('Create a room out of view');
    await A.screenshot({ path: path.join(shots, 'tables-landing.png') });

    // The room is made with them; the one who joins plays on it.
    await A.fill('#name', 'Ann');
    await A.click('#create');
    await A.waitForFunction(() => S.seat === 0 && S.phase === 'lobby');
    const code = await A.textContent('#roomCode');
    if (await A.evaluate(() => [S.table, S.cloth].join()) !== 'predator,electric-blue') fail(`room: ${await A.evaluate(() => [S.table, S.cloth].join())}`);
    await B.goto(base + '/');
    await B.waitForFunction((c) => !!document.querySelector(`#roomList li[data-code="${c}"]`), code);
    const chip = await B.textContent(`#roomList li[data-code="${code}"] .room-row__meta`);
    if (!chip.includes('Predator Apex')) fail(`room list chip: ${chip}`);
    await B.goto(`${base}/?room=${code}`);
    await B.fill('#name', 'Bob');
    await B.click('#join');
    await B.waitForFunction(() => S.seat === 1 && S.table === 'predator' && S.cloth === 'electric-blue' && Math.abs(POCKETS[1].half - 0.0625) < 1e-9);
    await A.waitForFunction(() => S.players[1].name === 'Bob');
    if (!(await A.textContent('#lobbySub')).includes('Predator Apex')) fail(`lobby line: ${await A.textContent('#lobbySub')}`);
    console.log('room on its table ok');

    // Settings: a new cloth keeps Ann ready, a new table does not.
    await A.click('#ready');
    await B.waitForFunction(() => S.players[0].ready);
    await A.click('#settingsBtn');
    await A.click('#settingsCloth [data-cloth="burgundy"]');
    await B.waitForFunction(() => S.cloth === 'burgundy');
    if (!(await B.evaluate(() => S.players[0].ready))) fail('a new cloth unreadied Ann');
    await A.click('#settingsTable [data-table="acurra"]');
    await B.waitForFunction(() => S.table === 'acurra' && Math.abs(POCKETS[0].half - 2 * 0.0254) < 1e-9);
    if (await B.evaluate(() => S.players[0].ready)) fail('a new table left Ann ready');
    await A.waitForFunction(() => document.querySelector('#settingsTable [data-table="acurra"]').getAttribute('aria-pressed') === 'true', null, { timeout: 5000 })
      .catch(() => fail('settings do not show the new table'));
    await A.screenshot({ path: path.join(shots, 'tables-settings.png') });
    await A.click('#settingsClose');
    console.log('changing table and cloth ok');

    // Locked while a rack is played.
    await A.click('#ready');
    await B.click('#ready');
    await A.waitForFunction(() => S.phase === 'breaking');
    await A.click('#settingsBtn');
    if (!(await A.isDisabled('#settingsTable [data-table="diamond"]')) || !(await A.isDisabled('#settingsCloth [data-cloth="spruce"]'))) fail('table and cloth not locked during the rack');
    await A.click('#settingsClose');
    console.log('locked during a rack ok');

    // Practice: a new table racks again.
    const P = await mk({ viewport: { width: 1100, height: 760 } });
    await P.goto(base + '/');
    await P.fill('#name', 'Cy');
    await P.click('#landingTable [data-table="diamond"]');
    await P.click('#practice');
    await P.waitForFunction(() => S.practice && S.phase === 'open' && S.table === 'diamond');
    await P.click('#settingsBtn');
    await P.click('#settingsTable [data-table="rasson"]');
    await P.waitForFunction(() => S.table === 'rasson' && Math.abs(POCKETS[0].half - 4.25 * 0.0254 / 2) < 1e-9);
    await P.click('#settingsClose');
    console.log('practice on a new table ok');

    // 3D (software WebGL, as in view3d.js): the table behind the landing is
    // built again for each pick, on its own legs.
    const gpu = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    try {
      const D = await (await gpu.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
      D.on('pageerror', (e) => errors.push(e.message));
      await D.goto(base + '/');
      await D.waitForFunction(() => !!v3, null, { timeout: 45000 }); // a desktop opens in 3D
      for (const t of ['predator', 'rasson', 'acurra', 'diamond']) {
        await D.click(`#landingTable [data-table="${t}"]`);
        await D.waitForFunction((id) => !!v3 && tableKey === id, t, { timeout: 45000 });
      }
      await D.click('#landingCloth [data-cloth="slate-grey"]');
      if (await D.evaluate(() => S.cloth) !== 'slate-grey') fail('the cloth did not change in 3D');
    } finally {
      await gpu.close();
    }
    console.log('3D tables ok');

    if (errors.length) fail(errors.join('\n'));
    console.log('OK');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
