// Matches: a race picked on the landing page and changed in the lobby, the
// header score and the match dialog, and leaving mid-match, which forfeits.
// Usage: node match.js <base>
const { chromium } = require('playwright');
const flat = require('./flat');
const path = require('path');

const base = process.argv[2] || 'http://127.0.0.1:18080';
const shots = path.join(__dirname, 'shots');
require('fs').mkdirSync(shots, { recursive: true });

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
const text = async (page, sel) => (await page.textContent(sel)).replace(/\s+/g, ' ').trim();

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const mk = async (viewport) => {
    const page = await (await flat(browser, { viewport })).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    return page;
  };
  const A = await mk({ width: 1100, height: 700 });
  const B = await mk({ width: 390, height: 800 });
  try {
    // Race to 3, winner breaks, from the landing page; the room list says so.
    await A.goto(base + '/');
    await A.click('#landingOptsBtn'); // the match rules fold under a summary
    await A.click('#landingMatch [data-race="3"]');
    await A.click('#landingMatch [data-breaks="winner"]');
    await A.fill('#landingMatch .js-race-input', '4');
    await A.press('#landingMatch .js-race-input', 'Enter');
    if (!(await A.isVisible('#landing'))) fail('Enter in the race field submitted the form');
    if (await A.getAttribute('#landingMatch [data-race="3"]', 'aria-pressed') !== 'false') fail('preset still pressed after typing 4');
    await A.click('#landingMatch [data-race="3"]');
    await A.screenshot({ path: path.join(shots, 'match-landing.png') });
    await A.fill('#name', 'Ann');
    await A.click('#create');
    await A.waitForFunction(() => document.getElementById('landing').hidden && S.match && S.match.race === 3);
    const code = await A.textContent('#roomCode');
    if (await text(A, '#score') !== '0–0race to 3') fail(`header score ${await text(A, '#score')}`);
    if (await A.evaluate(() => S.race) !== 3) fail(`room race ${await A.evaluate(() => S.race)}`);

    const L = await mk({ width: 800, height: 700 });
    await L.goto(base + '/');
    await L.waitForFunction((c) => !!document.querySelector(`li.room-row[data-code="${c}"]`), code);
    const chip = await L.textContent(`li.room-row[data-code="${code}"] .room-row__meta`);
    if (!chip.includes('race 3')) fail(`room list chip ${chip}`);
    await L.close();
    console.log('landing and room list ok');

    await B.goto(`${base}/?room=${code}`);
    await B.fill('#name', 'Bob');
    await B.click('#join');
    await B.waitForFunction(() => document.getElementById('landing').hidden && S.breaks === 'winner');

    // Settings → This room has the invite link and nothing of the match: the
    // room keeps the race it was made with. The protocol still carries a new
    // race for the next match (set_match), and both players see it.
    await A.waitForFunction(() => document.getElementById('seat1').textContent.includes('Bob'));
    await A.click('#settingsBtn');
    if (await text(A, '#inviteCode') !== code) fail(`invite code ${await text(A, '#inviteCode')}`);
    if (await A.locator('#settings [data-race], #settings [data-breaks], #settings [data-mode]').count()) fail('match pickers in Settings');
    await A.waitForTimeout(500); // the sheet's entry
    await A.screenshot({ path: path.join(shots, 'match-settings.png') });
    await A.click('#settingsClose');
    await A.evaluate(() => send({ type: 'set_match', race: 5, breaks: 'alternate' }));
    await B.waitForFunction(() => S.race === 5 && S.breaks === 'alternate' && S.match.race === 5);
    if (!(await text(B, '#lobbySub')).includes('first to 5 racks')) fail(`B's lobby line ${await text(B, '#lobbySub')}`);
    await B.screenshot({ path: path.join(shots, 'match-lobby-B.png') });
    console.log('lobby race ok');

    await A.click('#ready');
    await B.click('#ready');
    await A.waitForFunction(() => S.phase === 'breaking');
    await B.waitForFunction(() => S.phase === 'breaking');

    // The score opens the match dialog.
    await B.click('#score');
    await B.waitForFunction(() => !document.getElementById('matchDialog').hidden);
    if (!(await text(B, '#matchRacks')).includes('No rack finished yet')) fail(`racks: ${await text(B, '#matchRacks')}`);
    await B.keyboard.press('Escape');
    await B.waitForFunction(() => document.getElementById('matchDialog').hidden);

    // How a match in progress looks (drawn locally, the server is not asked).
    await A.evaluate(() => {
      S.match = { race: 5, breaks: 'alternate', score: [1, 1], racks: [
        { winner: 0, breaker: 0, end: 'made' }, { winner: 1, breaker: 1, end: 'eight_foul', foul: 'scratch' }] };
      S.match.winner = null;
      refreshPanels();
      S.match = { ...S.match, score: [2, 1], racks: [...S.match.racks, { winner: 0, breaker: 0, end: 'eight_early' }] };
      refreshPanels();
    });
    if (!(await A.isVisible('#score .score__new'))) fail('no score tick');
    await A.waitForTimeout(400);
    await A.screenshot({ path: path.join(shots, 'match-score-A.png') });
    await A.click('#score');
    const rows = await A.$$eval('#matchRacks .rack', (els) => els.map((e) => e.textContent));
    if (rows.length !== 3 || !rows[1].includes('fouled on the 8-ball: scratch') || !rows[2].includes('Bob pocketed the 8-ball early')) fail(`rows ${JSON.stringify(rows)}`);
    await A.waitForTimeout(500); // the dialog's entry
    await A.screenshot({ path: path.join(shots, 'match-dialog-A.png') });
    await A.click('#matchClose');
    console.log('score and match dialog ok');

    // Leaving mid-match asks first, then forfeits.
    await A.click('#leaveBtn');
    await A.waitForFunction(() => !document.getElementById('leaveConfirm').hidden);
    await A.waitForTimeout(500); // the dialog's entry
    await A.screenshot({ path: path.join(shots, 'match-leave-confirm.png') });
    await A.click('#leaveStay');
    if (!(await A.isHidden('#leaveConfirm')) || !(await A.isHidden('#landing'))) fail('Stay did not keep the player in');
    await A.click('#leaveBtn');
    await A.click('#leaveForfeit');
    await A.waitForFunction(() => !document.getElementById('landing').hidden && S.seat === -1);
    await B.waitForFunction(() => S.phase === 'lobby' && S.match.winner === S.seat && !document.getElementById('matchDialog').hidden);
    const title = await text(B, '#matchTitle');
    const why = await text(B, '#matchRacks');
    if (title !== 'You win the match' || !why.includes('Ann left the match')) fail(`after the forfeit: ${title} / ${why}`);
    if (!(await text(B, '#status')).includes('Ann left. You win the match')) fail(`status ${await text(B, '#status')}`);
    await B.waitForTimeout(500); // the dialog's entry
    await B.screenshot({ path: path.join(shots, 'match-forfeit-B.png') });
    await B.click('#matchClose');
    if (!(await text(B, '#lobbyText')).includes('Ann left the room')) fail(`lobby ${await text(B, '#lobbyText')}`);
    console.log('leave and forfeit ok');

    // The game-over panel (drawn locally): the next rack between racks, a
    // new match after the race is won.
    const over = await B.evaluate(() => {
      const racks = [{ winner: S.seat, breaker: 0, end: 'made' }];
      Object.assign(S, { phase: 'game_over', winner: S.seat, lastBreaker: 0 });
      S.match = { race: 2, breaks: 'alternate', score: S.seat ? [0, 1] : [1, 0], racks, winner: null };
      refreshPanels();
      const between = [document.getElementById('overText').textContent, document.getElementById('rematch').textContent, document.getElementById('rematchNote').textContent];
      S.match = { ...S.match, score: S.seat ? [0, 2] : [2, 0], racks: [...racks, racks[0]], winner: S.seat };
      refreshPanels();
      const after = [document.getElementById('overText').textContent, document.getElementById('rematch').textContent];
      return { between, after };
    });
    if (over.between[0] !== 'You win the rack' || over.between[1] !== 'Next rack' || !over.between[2].includes('race to 2')) fail(`between racks: ${JSON.stringify(over.between)}`);
    if (over.after[0] !== 'You win the match 2–0' || over.after[1] !== 'New match') fail(`after the match: ${JSON.stringify(over.after)}`);
    console.log('game-over panel ok');

    // Leaving after the match needs no confirmation.
    await B.click('#leaveBtn');
    await B.waitForFunction(() => !document.getElementById('landing').hidden);
    if (errors.length) fail(errors.join('\n'));
    console.log('OK');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
