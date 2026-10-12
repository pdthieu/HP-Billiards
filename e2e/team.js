// 2v2: a room for four made on the landing page, teams picked with "Sit
// here", all four ready, teammates shooting in turn (A1 → B1 → A2 → B2), the
// header naming both players of each side, and a player leaving while the
// match goes on with the teammate playing both turns. Then 9-ball doubles
// (scotch doubles): partners alternate every shot, and after a push out
// passed back the pusher's partner shoots.
// Usage: node team.js <base>
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
  const mk = async (viewport, extra = {}) => {
    const page = await (await flat(browser, { viewport, ...extra })).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    return page;
  };
  const A = await mk({ width: 1100, height: 700 });
  const B = await mk({ width: 390, height: 800 }, { hasTouch: true, isMobile: true });
  const C = await mk({ width: 1000, height: 680 });
  const D = await mk({ width: 1000, height: 680 });
  const pages = { Ann: A, Bob: B, Cat: C, Dan: D };
  try {
    // 2 v 2 on the landing page (8-ball and 9-ball, not 3-cushion).
    await A.goto(base + '/');
    await A.click('#landingOptsBtn');
    await A.click('#landingMode [data-mode="3cushion"]');
    if (await A.isVisible('#landingPlayersRow')) fail('2 v 2 offered for 3-cushion');
    await A.click('#landingMode [data-mode="9ball"]');
    if (!(await A.isVisible('#landingPlayersRow'))) fail('no 2 v 2 for 9-ball');
    await A.click('#landingMode [data-mode="8ball"]');
    await A.click('#landingPlayers [data-players="4"]');
    if (!(await text(A, '#landingOptsSum')).startsWith('2v2')) fail(`summary ${await text(A, '#landingOptsSum')}`);
    await A.fill('#name', 'Ann');
    await A.click('#create');
    await A.waitForFunction(() => document.getElementById('landing').hidden && S.size === 4);
    const code = await A.textContent('#roomCode');
    if (!(await A.isVisible('#lobbySeats'))) fail('no team picker in the lobby');

    const enter = async (page, name) => {
      await page.goto(`${base}/?room=${code}`);
      await page.fill('#name', name);
      await page.click('#join');
      await page.waitForFunction(() => document.getElementById('landing').hidden && S.seat >= 0);
    };
    await enter(B, 'Bob');
    await enter(C, 'Cat');
    // Cat moves over to Bob's side (seat 3); Dan then takes Ann's side.
    if (await C.evaluate(() => S.seat) !== 2) fail('Cat did not get seat 2');
    await C.click('#lobbySeats [data-seat="3"]');
    await C.waitForFunction(() => S.seat === 3 && S.players[2].name === '');
    await enter(D, 'Dan');
    if (await D.evaluate(() => S.seat) !== 2) fail('Dan did not get seat 2');
    await A.waitForFunction(() => S.players.map((p) => p.name).join() === 'Ann,Bob,Dan,Cat');
    const lobby = await text(A, '#lobbySeats');
    if (!/Team A\s*You\s*Dan/.test(lobby) || !/Team B\s*Bob\s*Cat/.test(lobby)) fail(`lobby teams: ${lobby}`);
    await A.screenshot({ path: path.join(shots, 'team-lobby.png') });

    // The room list says 2v2 and is full.
    const L = await mk({ width: 1100, height: 700 });
    await L.goto(base + '/');
    await L.waitForFunction((c) => !!document.querySelector(`#roomList li.room-row[data-code="${c}"]`), code);
    const row = await L.evaluate((c) => {
      const li = document.querySelector(`#roomList li.room-row[data-code="${c}"]`);
      return { meta: li.querySelector('.room-row__meta').textContent, who: li.querySelector('.room-row__who').textContent, join: li.querySelector('.room-row__join').textContent };
    }, code);
    if (!row.meta.includes('2v2') || !row.who.includes('Ann & Dan') || !row.who.includes('Bob & Cat') || row.join !== 'Full') fail(`room row ${JSON.stringify(row)}`);
    await L.close();
    console.log('2v2 room, teams and room list ok');

    for (const p of [A, B, C, D]) await p.click('#ready');
    // the server picks the breaking side; its first player breaks
    for (const p of [A, B, C, D]) await p.waitForFunction(() => S.phase === 'breaking' && (S.turn === 0 || S.turn === 1));
    const header = await text(A, '#top');
    if (!['Ann', 'Dan', 'Bob', 'Cat'].every((n) => header.includes(n === 'Ann' ? 'You' : n) || header.includes(n))) fail(`header ${header}`);
    await A.screenshot({ path: path.join(shots, 'team-break-A.png') });
    await B.screenshot({ path: path.join(shots, 'team-break-B.png') });

    // Shots: the breaker breaks; after that each shooter misses everything (a foul,
    // so the turn crosses every time). The rotation must hold.
    const all = [A, B, C, D];
    const seatPage = async (seat) => {
      for (const p of all) if (!p.isClosed() && await p.evaluate((s) => S.seat === s, seat)) return p;
      return null;
    };
    // settle waits until the shot is over on every page: the turn changed
    // (a miss is a foul: it always crosses), a decision is up, or the break
    // is done.
    const settle = async (prev) => {
      for (const p of all) {
        if (!p.isClosed()) await p.waitForFunction((t) => !S.moving && (S.turn !== t || S.decision || S.phase !== 'breaking' && t === null), prev, { timeout: 20000 });
      }
    };
    const decide = async () => {
      const d = await A.evaluate(() => S.decision);
      if (!d) return false;
      const p = await seatPage(d.seat);
      await p.evaluate((o) => send({ type: 'choose', option: o }), d.options[0]);
      for (const q of all) if (!q.isClosed()) await q.waitForFunction(() => !S.decision);
      return true;
    };
    const missAway = () => {
      // aim away from every ball, barely: no contact is a foul
      const c = S.balls.get(0);
      let best = null;
      for (const [id, b] of S.balls) if (id && (!best || Math.hypot(b.x - c.x, b.y - c.y) < Math.hypot(best.x - c.x, best.y - c.y))) best = b;
      setAngle(Math.atan2(c.y - best.y, c.x - best.x));
      setPower(0.02);
      shoot();
    };
    let next = [0, 1]; // each side's next seat
    let cur = await A.evaluate(() => S.turn);
    const seen = new Set();
    const step = async (label) => {
      const t = await A.evaluate(() => S.turn);
      if (t % 2 === cur % 2) { if (t !== cur) fail(`${label}: same side, but seat ${t} after ${cur}`); }
      else {
        if (t !== next[t % 2]) fail(`${label}: seat ${t} shoots, want ${next[t % 2]} (after ${cur})`);
        next[cur % 2] = cur ^ 2; // the side that had the turn moves on
      }
      cur = t;
      seen.add(t);
      // every page agrees; only the shooter has the shot
      for (const p of all) {
        if (p.isClosed()) continue;
        const v = await p.evaluate(() => ({ turn: S.turn, mine: isMyShot(), seat: S.seat, on: document.querySelector('#top .seat__line.is-on .seat__name')?.textContent }));
        if (v.turn !== t || v.mine !== (v.seat === t)) fail(`${label}: page of seat ${v.seat} sees ${JSON.stringify(v)}`);
        if (v.seat !== t && !v.on) fail(`${label}: no cue in the header on seat ${v.seat}`);
      }
      const mate = await seatPage(t ^ 2);
      if (mate && await mate.isVisible('#waitPanel')) {
        const w = await text(mate, '#waitText');
        if (!w.includes('(your team)')) fail(`${label}: teammate's wait panel ${w}`);
      }
    };
    await (await seatPage(cur)).evaluate(() => { setAngle(S.balls.get(0).x < 1.27 ? 0 : Math.PI); setPower(1); shoot(); });
    await settle(null);
    while (await decide()) await A.waitForTimeout(300);
    await step('after the break');
    for (let i = 0; i < 8 && seen.size < 4; i++) {
      const p = await seatPage(cur);
      await p.evaluate(missAway);
      await settle(cur);
      while (await decide()) await A.waitForTimeout(300);
      if (await A.evaluate(() => S.phase === 'game_over')) fail('the rack ended on a soft miss');
      await step(`shot ${i + 1}`);
    }
    if (seen.size < 4) fail(`only seats ${[...seen]} shot`);
    await A.screenshot({ path: path.join(shots, 'team-rotation-A.png') });
    await B.screenshot({ path: path.join(shots, 'team-rotation-B.png') });
    console.log('rotation ok:', [...seen].join(' '));

    // Dan leaves: the match goes on, Ann plays every turn of side A.
    await D.click('#leaveBtn');
    await D.waitForFunction(() => !document.getElementById('leaveConfirm').hidden);
    if (!(await text(D, '#leaveText')).includes('Ann plays on alone')) fail(`leave text ${await text(D, '#leaveText')}`);
    await D.click('#leaveForfeit');
    await D.waitForFunction(() => !document.getElementById('landing').hidden);
    await D.close();
    await A.waitForFunction(() => S.players[2].name === '' && S.phase !== 'lobby');
    all.splice(all.indexOf(D), 1);
    next[0] = 0;
    if (cur === 2) cur = 0; // Dan's turn passed to Ann
    for (let i = 0; i < 4; i++) {
      const t = await A.evaluate(() => S.turn);
      if (t === 2) fail('the empty seat has the turn');
      const p = await seatPage(t);
      await p.evaluate(missAway);
      await settle(t);
      while (await decide()) await A.waitForTimeout(300);
      const now = await A.evaluate(() => S.turn);
      if (now % 2 === 0 && now !== 0) fail(`side A's turn went to seat ${now}`);
    }
    await A.screenshot({ path: path.join(shots, 'team-alone-A.png') });
    console.log('a player left, the match went on ok');
    for (const p of [A, B, C]) await p.context().close();

    // 9-ball doubles: scotch doubles.
    const N = [];
    for (let i = 0; i < 4; i++) N.push(await mk({ width: 1000, height: 680 }));
    await N[0].goto(base + '/');
    await N[0].click('#landingOptsBtn');
    await N[0].click('#landingMode [data-mode="9ball"]');
    await N[0].click('#landingPlayers [data-players="4"]');
    await N[0].fill('#name', 'Ann');
    await N[0].click('#create');
    await N[0].waitForFunction(() => document.getElementById('landing').hidden && S.size === 4 && S.mode === '9ball');
    const code9 = await N[0].textContent('#roomCode');
    for (const [i, name] of [[1, 'Bob'], [2, 'Cat'], [3, 'Dan']]) {
      await N[i].goto(`${base}/?room=${code9}`);
      await N[i].fill('#name', name);
      await N[i].click('#join');
      await N[i].waitForFunction((s) => S.seat === s, i);
    }
    for (const p of N) await p.click('#ready');
    for (const p of N) await p.waitForFunction(() => S.phase === 'breaking');
    const brk = await N[0].evaluate(() => S.turn);
    await N[brk].evaluate(() => { setAngle(0); setPower(1); shoot(); });
    for (const p of N) await p.waitForFunction(() => S.phase !== 'breaking' && !S.moving, null, { timeout: 20000 });
    if (await N[0].evaluate(() => S.phase === 'game_over')) {
      console.log('the 9 dropped on the break: scotch doubles not played out');
    } else {
      const t = await N[0].evaluate(() => S.turn);
      const want = t % 2 === brk % 2 ? brk ^ 2 : 1 - brk; // the breaker's partner, or the other side's first
      if (t !== want) fail(`after the break seat ${t} shoots, want ${want}`);
      if (!(await text(N[t ^ 2], '#waitText')).includes('(your team)')) fail(`partner's wait panel: ${await text(N[t ^ 2], '#waitText')}`);
      await N[t].click('#pushOut');
      await N[t].evaluate(() => { setPower(0.02); shoot(); });
      await N[0].waitForFunction(() => !!S.decision && !S.moving, null, { timeout: 15000 });
      const decider = await N[0].evaluate(() => S.decision.seat);
      if (decider % 2 === t % 2) fail(`seat ${decider} decides its own side's push out`);
      await N[decider].waitForFunction(() => !document.getElementById('decision').hidden);
      await N[decider].click('.option:has-text("Pass it back")');
      for (const p of N) await p.waitForFunction((s) => S.turn === s && !S.decision, t ^ 2, { timeout: 5000 });
      await N[t ^ 2].waitForFunction(() => !document.getElementById('shotPanel').hidden);
      const call = await text(N[t ^ 2], '#callText');
      if (!call.includes('Partners alternate every shot')) fail(`scotch call line: ${call}`);
      if (!(await text(N[t], '#waitText')).includes('(your team)')) fail(`pusher's wait panel: ${await text(N[t], '#waitText')}`);
      await N[t ^ 2].screenshot({ path: path.join(shots, 'team-nine.png') });
      console.log(`scotch doubles ok: ${brk} broke, ${t} pushed out, ${decider} passed back, ${t ^ 2} shoots`);
    }
    if (errors.length) fail(`page errors: ${errors.join('; ')}`);
    console.log('OK');
  } finally {
    await browser.close();
  }
})().catch((e) => { if (!process.exitCode) { console.error(e); process.exitCode = 1; } });
