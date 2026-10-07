// Spectators and the chat: a room picked with one spectator, someone
// watching it from the room list, comments both ways with the 5 s wait,
// comments floating over a player's table, a second spectator turned
// away; and the commentator's lines.
// Usage: node spectate.js <base>
const { chromium } = require('playwright');
const flat = require('./flat');
const path = require('path');

const base = process.argv[2] || 'http://127.0.0.1:18080';
const shots = path.join(__dirname, 'shots');
require('fs').mkdirSync(shots, { recursive: true });

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  const mk = async (viewport, mobile) => {
    const page = await (await flat(browser, { viewport, hasTouch: !!mobile, isMobile: !!mobile })).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    return page;
  };
  try {
    const A = await mk({ width: 1100, height: 700 });
    const B = await mk({ width: 1000, height: 700 });
    const W = await mk({ width: 390, height: 800 }, true);

    // A room for one spectator.
    await A.goto(base + '/');
    await A.fill('#name', 'Ann');
    await A.click('#landingAudience [data-n="1"]');
    await A.click('#create');
    await A.waitForFunction(() => S.seat === 0 && S.audience.max === 1);
    const code = await A.textContent('#roomCode');
    await B.goto(`${base}/?room=${code}`);
    await B.fill('#name', 'Bob');
    await B.click('#join');
    await B.waitForFunction(() => S.seat === 1);

    // Watching from the room list.
    await W.goto(base + '/');
    await W.fill('#name', 'Chi');
    const watchBtn = `li.room-row[data-code="${code}"] .room-row__watch`;
    await W.waitForSelector(`${watchBtn}:not([hidden])`);
    await W.click(watchBtn);
    await W.waitForFunction(() => S.spectator && S.seat === -1 && document.getElementById('landing').hidden);
    if (!(await W.textContent('#roomEyebrow')).startsWith('Watching')) fail(`eyebrow ${await W.textContent('#roomEyebrow')}`);
    await A.waitForFunction(() => S.audience.names.join() === 'Chi');
    console.log('watch from the room list ok');

    // The spectator sees the game but cannot play it.
    await A.click('#ready');
    await B.click('#ready');
    await W.waitForFunction(() => S.phase === 'breaking');
    if (!(await W.isHidden('#powerBar')) || await W.isVisible('#shotPanel')) fail('a spectator has the shot controls');
    const breaker = (await W.evaluate(() => S.turn)) === 0 ? A : B; // the first breaker is random
    await breaker.waitForFunction(() => isMyShot());
    await breaker.evaluate(() => { setAngle(0); setPower(0.6); shoot(); });
    await W.waitForFunction(() => S.moving, null, { timeout: 5000 });
    await W.waitForFunction(() => !S.moving, null, { timeout: 30000 });
    await W.waitForTimeout(400);
    await W.screenshot({ path: path.join(shots, 'spectate-phone.png') });
    console.log('spectator sees the shot ok');

    // Comments both ways; the Send button counts down the wait.
    await W.click('#chatBtn');
    await W.fill('#chatInput', 'Đỉnh của chóp!');
    await W.press('#chatInput', 'Enter');
    await A.waitForFunction(() => S.chat.length === 1 && S.chat[0].from === 'Chi' && S.chat[0].seat === -1);
    if (!/^\ds$/.test(await W.textContent('#chatSend')) || !(await W.isDisabled('#chatSend'))) fail(`send button ${await W.textContent('#chatSend')}`);
    // the player's chat is closed: the comment floats over the table, the button counts it
    await A.waitForSelector('#chatBubbles .chat-bubble');
    if ((await A.textContent('#chatBadge')) !== '1') fail(`badge ${await A.textContent('#chatBadge')}`);
    await A.screenshot({ path: path.join(shots, 'spectate-bubble.png') });
    await A.keyboard.press('c');
    await A.waitForFunction(() => !document.getElementById('chatPanel').hidden && document.getElementById('chatBadge').hidden);
    await A.fill('#chatInput', 'cảm ơn nha');
    await A.press('#chatInput', 'Enter');
    await W.waitForFunction(() => S.chat.length === 2 && S.chat[1].from === 'Ann' && S.chat[1].seat === 0);
    // too soon: the server says how long to wait
    await W.evaluate(() => send({ type: 'chat', text: 'again' }));
    await W.waitForFunction(() => S.chatReadyAt > performance.now() + 1000);
    await W.screenshot({ path: path.join(shots, 'spectate-chat.png') });
    await A.screenshot({ path: path.join(shots, 'spectate-player-chat.png') });
    console.log('chat ok');

    // One spectator only: another is turned away.
    const X = await mk({ width: 800, height: 600 });
    await X.goto(base + '/');
    await X.fill('#name', 'Dan');
    await X.evaluate((c) => connectAndJoin(c, 'Dan', null, true), code);
    await X.waitForFunction(() => !document.getElementById('landingError').hidden);
    if (!(await X.textContent('#landingError')).includes('no more spectators')) fail(`second spectator: ${await X.textContent('#landingError')}`);
    // the players raise the limit in Settings
    await A.click('#settingsBtn');
    await A.click('#roomAudience [data-n="3"]');
    await A.waitForFunction(() => S.audience.max === 3);
    await A.click('#settingsClose');
    await X.evaluate((c) => connectAndJoin(c, 'Dan', null, true), code);
    await X.waitForFunction(() => S.spectator);
    await A.waitForFunction(() => S.audience.names.join() === 'Chi,Dan');
    // leaving
    await X.click('#leaveBtn');
    await X.waitForFunction(() => !document.getElementById('landing').hidden);
    await A.waitForFunction(() => S.audience.names.join() === 'Chi');
    console.log('audience limit ok');

    // The commentator: the lines load, a shot with two balls made gets a
    // great line with its caption, and strong language can be left out.
    await A.mouse.click(10, 300); // a gesture: the audio starts
    await A.waitForFunction(() => SND.lines.length > 60, null, { timeout: 10000 });
    const said = await A.evaluate(() => {
      SND.spokeAt = -Infinity;
      S.shotWasBreak = false; // a shot after the break
      const before = SND.voices;
      voiceFor({ pocketed: [3, 5], shooter: 0, phase: 'open' });
      return { n: SND.voices - before, line: SND.lines.find((l) => l.id === SND.lastLine) };
    });
    if (said.n !== 1 || said.line.kind !== 'great') fail(`commentator ${JSON.stringify(said)}`);
    await A.waitForFunction((t) => document.getElementById('voiceCaption').textContent === t && !document.getElementById('voiceCaption').hidden, said.line.text);
    const strong = await A.evaluate(() => {
      SND.strong = false;
      let n = 0;
      for (let i = 0; i < 300; i++) if (pickLine(['great', 'miss', 'win', 'foul', 'lose'][i % 5]).strong) n++;
      SND.strong = true;
      return n;
    });
    if (strong) fail(`${strong} strong lines with strong language off`);
    const file = await A.evaluate(async () => { const r = await fetch('/voice/great-01.m4a'); return [r.status, r.headers.get('content-type')]; });
    if (file[0] !== 200 || file[1] !== 'audio/mp4') fail(`voice file ${file}`);
    console.log('commentator ok:', said.line.text);

    if (errors.length) fail(errors.join('\n'));
    console.log('OK');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
