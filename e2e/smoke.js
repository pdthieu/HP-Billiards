// End-to-end smoke test of the pool client against a running server.
// Usage: PLAYWRIGHT_BROWSERS_PATH=... node smoke.js http://127.0.0.1:18080
const { chromium } = require('playwright');
const flat = require('./flat');
const path = require('path');

const base = process.argv[2] || 'http://127.0.0.1:18080';
const shots = path.join(__dirname, 'shots');
require('fs').mkdirSync(shots, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }

// Table meters -> page coordinates of the canvas.
async function tablePoint(page, x, y) {
  return page.evaluate(([x, y]) => {
    const rect = canvas.getBoundingClientRect();
    let px, py;
    if (!view.rotated) { px = view.ox + x * view.s; py = view.oy + y * view.s; }
    else { px = view.ox + y * view.s; py = view.oy + (W - x) * view.s; }
    return { x: rect.left + px, y: rect.top + py };
  }, [x, y]);
}

async function state(page) {
  return page.evaluate(() => ({
    seat: S.seat, phase: S.phase, turn: S.turn, moving: S.moving, ballInHand: S.ballInHand,
    kitchen: S.kitchen, decision: S.decision, call: S.call,
    balls: [...S.balls.entries()].map(([id, p]) => ({ id, ...p })),
    status: document.getElementById('status').textContent,
    callText: document.getElementById('callText').textContent,
    shotVisible: !document.getElementById('shotPanel').hidden,
    rotated: view.rotated,
  }));
}

async function waitFor(page, pred, what, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await state(page);
    if (pred(s)) return s;
    await sleep(50);
  }
  fail(`timeout waiting for ${what}: ${JSON.stringify(await state(page))}`);
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const mk = async (viewport) => {
    const ctx = await flat(browser, { viewport });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${viewport.width}x${viewport.height}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    return page;
  };
  const A = await mk({ width: 1100, height: 700 });
  const B = await mk({ width: 390, height: 800 }); // phone portrait: table should rotate

  // A creates a room
  await A.goto(base + '/');
  await A.fill('#name', 'Ann');
  await A.click('#create');
  await A.waitForFunction(() => document.getElementById('landing').hidden);
  const code = await A.textContent('#roomCode');
  if (!/^[A-HJ-NP-Z]{5}$/.test(code)) fail(`bad room code ${code}`);
  console.log('room', code);

  // the landing page of a newcomer lists the room with one seat taken
  const L = await mk({ width: 800, height: 700 });
  await L.goto(base + '/');
  await L.waitForFunction((c) => !!document.querySelector(`#roomList li.room-row[data-code="${c}"]`), code);
  const row = await L.evaluate((c) => {
    const li = document.querySelector(`#roomList li.room-row[data-code="${c}"]`);
    return { who: li.querySelector('.room-row__who').textContent, btn: li.querySelector('.room-row__join').textContent };
  }, code);
  if (!row.who.includes('Ann') || row.btn !== 'Join') fail(`room row: ${JSON.stringify(row)}`);
  const suggested = await L.inputValue('#name');
  if (!/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(suggested)) fail(`no random name suggested: ${suggested}`);
  await L.screenshot({ path: path.join(shots, '0-landing-rooms.png') });
  await L.close();

  // B joins by link
  await B.goto(`${base}/?room=${code}`);
  if ((await B.inputValue('#code')) !== code) fail('room code not prefilled from URL');
  await B.fill('#name', 'Bob');
  await B.click('#join');
  await B.waitForFunction(() => document.getElementById('landing').hidden);
  await waitFor(A, (s) => s.phase === 'lobby', 'A lobby');
  await A.waitForFunction(() => document.getElementById('seat1').textContent.includes('Bob'));
  await A.screenshot({ path: path.join(shots, '1-lobby-A.png') });

  // ready
  await A.click('#ready');
  await B.click('#ready');
  const sa = await waitFor(A, (s) => s.phase === 'breaking', 'breaking on A');
  const sb = await waitFor(B, (s) => s.phase === 'breaking', 'breaking on B');
  if (!sb.rotated) fail('phone portrait should rotate the table');
  console.log('breaker seat', sa.turn, 'A seat', sa.seat, 'B seat', sb.seat);
  const breaker = sa.turn === sa.seat ? A : B;
  const other = breaker === A ? B : A;
  await waitFor(breaker, (s) => s.shotVisible, 'shot panel for breaker');
  await sleep(300); // let the layout (trays, panel) settle so table coordinates are final
  if (!(await state(breaker)).callText.startsWith('Break')) fail('break should need no call');

  // place the cue ball in the kitchen by dragging it
  let cue = (await state(breaker)).balls.find((b) => b.id === 0);
  let from = await tablePoint(breaker, cue.x, cue.y);
  let to = await tablePoint(breaker, 0.5, 0.5);
  await breaker.mouse.move(from.x, from.y);
  await breaker.mouse.down();
  await breaker.mouse.move(to.x, to.y, { steps: 5 });
  await breaker.mouse.up();
  await waitFor(breaker, (s) => {
    const c = s.balls.find((b) => b.id === 0);
    return Math.abs(c.x - 0.5) < 1e-6 && Math.abs(c.y - 0.5) < 1e-6;
  }, 'place_cue confirmed by room_state');
  // the other player sees the new position too
  await waitFor(other, (s) => Math.abs(s.balls.find((b) => b.id === 0).x - 0.5) < 1e-6, 'cue moved on other');

  // placing outside the kitchen is refused by the server and reverted
  cue = (await state(breaker)).balls.find((b) => b.id === 0);
  from = await tablePoint(breaker, cue.x, cue.y);
  to = await tablePoint(breaker, 1.5, 0.3); // the client clamps to the head string; so the server accepts it
  await breaker.mouse.move(from.x, from.y);
  await breaker.mouse.down();
  await breaker.mouse.move(to.x, to.y, { steps: 5 });
  await breaker.mouse.up();
  await waitFor(breaker, (s) => Math.abs(s.balls.find((b) => b.id === 0).x - 0.635) < 1e-6, 'clamped to the head string');

  // aim by holding the butt of the cue: drag behind the cue ball, away from
  // the rack, and the shot points at the rack
  cue = (await state(breaker)).balls.find((b) => b.id === 0);
  const want = Math.atan2(0.635 - cue.y, 1.905 - cue.x);
  from = await tablePoint(breaker, 0.3, 1.0);
  to = await tablePoint(breaker, cue.x - 0.4 * Math.cos(want), cue.y - 0.4 * Math.sin(want));
  await breaker.mouse.move(from.x, from.y);
  await breaker.mouse.down();
  await breaker.mouse.move(to.x, to.y, { steps: 3 });
  await breaker.mouse.up();
  let angle = await breaker.evaluate(() => S.angle);
  if (Math.abs(angle - want) > 1e-3) fail(`aim angle ${angle} want ${want} (dragging the butt)`);
  // the other way, from Settings: point at the target
  await breaker.evaluate(() => { S.aimFront = true; });
  from = await tablePoint(breaker, 1.2, 0.9);
  to = await tablePoint(breaker, 1.905, 0.635);
  await breaker.mouse.move(from.x, from.y);
  await breaker.mouse.down();
  await breaker.mouse.move(to.x, to.y, { steps: 3 });
  await breaker.mouse.up();
  angle = await breaker.evaluate(() => S.angle);
  await breaker.evaluate(() => { S.aimFront = false; });
  if (Math.abs(angle - want) > 1e-3) fail(`aim angle ${angle} want ${want} (pointing)`);
  // the opponent gets the aim preview
  await other.waitForFunction(() => S.oppAim !== null);
  await breaker.screenshot({ path: path.join(shots, '2-aim-breaker.png') });
  await other.screenshot({ path: path.join(shots, '2-aim-other.png') });

  // break by pulling the power bar down and releasing
  const bar = await breaker.locator('#powerBar').boundingBox();
  await breaker.mouse.move(bar.x + bar.width / 2, bar.y + 2);
  await breaker.mouse.down();
  await breaker.mouse.move(bar.x + bar.width / 2, bar.y + bar.height * 0.5, { steps: 4 });
  if (!(await breaker.evaluate(() => S.powerDrag))) fail('power drag not started');
  await breaker.mouse.move(bar.x + bar.width / 2, bar.y + bar.height * 0.97, { steps: 4 });
  const pulled = await breaker.evaluate(() => S.power);
  if (pulled < 0.9) fail(`pulled power ${pulled}`);
  await breaker.mouse.up();
  await waitFor(breaker, (s) => s.moving, 'moving after break');
  await sleep(600);
  await breaker.screenshot({ path: path.join(shots, '3-rolling.png') });
  const s1 = await waitFor(A, (s) => !s.moving && s.phase !== 'breaking', 'break settled', 30000);
  await waitFor(B, (s) => !s.moving && s.phase !== 'breaking', 'break settled on B', 5000);
  console.log('after break:', s1.phase, 'turn', s1.turn, 'status:', s1.status);
  // both clients agree on the positions
  const ba = (await state(A)).balls, bb = (await state(B)).balls;
  if (JSON.stringify(ba) !== JSON.stringify(bb)) fail('clients disagree on positions');
  if (s1.phase === 'open' && ba.length < 16) console.log('pocketed on break:', 16 - ba.length);

  if (s1.decision) {
    // illegal break or 8 on the break: the chooser gets a dialog
    const chooser = s1.decision.seat === (await state(A)).seat ? A : B;
    await chooser.waitForSelector('#decision:not([hidden])');
    await chooser.screenshot({ path: path.join(shots, '4-decision.png') });
    await chooser.click('#decisionOptions button:first-child');
    await waitFor(chooser, (s) => !s.decision, 'decision resolved');
  }

  // next shooter: no call is needed for object balls
  let st = await state(A);
  let shooter = st.turn === st.seat ? A : B;
  let watcher = shooter === A ? B : A;
  st = await waitFor(shooter, (s) => s.shotVisible, 'shot panel for next shooter');
  await sleep(300);
  st = await state(shooter);
  if (!/^(Open table|Your group|Ball in hand)/.test(st.callText)) fail(`unexpected call text ${st.callText}`);
  const legal = await shooter.evaluate(() => [...legalTargets()]);
  if (!legal.length) fail('no legal targets');
  const id = legal[0];
  const ball = st.balls.find((b) => b.id === id);
  const pt = await tablePoint(shooter, ball.x, ball.y);
  // hovering a ball names it
  await shooter.mouse.move(pt.x, pt.y);
  await sleep(50);
  if ((await shooter.evaluate(() => S.hoverBall)) !== id) fail('hover label not set');
  await shooter.screenshot({ path: path.join(shots, '4b-hover.png') });
  // tapping a ball is not a call any more
  await shooter.mouse.click(pt.x, pt.y);
  if ((await state(shooter)).call !== null) fail('a ball tap set a call');

  // On the 8-ball a pocket must be called: pretend to be there for a moment.
  await shooter.evaluate(() => {
    window.__saved = { balls: S.balls, phase: S.phase, groups: S.groups.slice() };
    S.groups = S.seat === 0 ? ['solids', 'stripes'] : ['stripes', 'solids'];
    S.phase = 'assigned';
    S.balls = new Map([[0, S.balls.get(0)], [8, S.balls.get(8) || { x: 1.9, y: 0.6 }]]);
    refreshShotPanel();
  });
  st = await state(shooter);
  if (!st.callText.startsWith('On the 8-ball')) fail(`on the 8 text: ${st.callText}`);
  // releasing the power bar without a pocket is refused
  const bar2 = await shooter.locator('#powerBar').boundingBox();
  await shooter.mouse.move(bar2.x + bar2.width / 2, bar2.y + 2);
  await shooter.mouse.down();
  await shooter.mouse.move(bar2.x + bar2.width / 2, bar2.y + bar2.height * 0.6, { steps: 3 });
  await shooter.mouse.up();
  await sleep(200);
  if ((await state(shooter)).moving) fail('shot at the 8 fired without a pocket');
  if (!(await shooter.locator('#tableWrap .tip').count())) fail('no tip after the refused release');
  // tap the top-right pocket (index 2)
  const hole = await shooter.evaluate(() => pocketHole(POCKETS[2]));
  const pp = await tablePoint(shooter, hole.x, hole.y);
  await shooter.mouse.click(pp.x, pp.y);
  st = await state(shooter);
  if (!st.call || st.call.pocket !== 2) fail(`pocket call not set: ${JSON.stringify(st.call)}`);
  if (!/^Called: .*pocket/.test(st.callText)) fail(`call text: ${st.callText}`);
  await shooter.screenshot({ path: path.join(shots, '5-called-pocket.png') });
  // back to the real table
  await shooter.evaluate(() => {
    S.balls = window.__saved.balls; S.phase = window.__saved.phase; S.groups = window.__saved.groups; S.call = null;
    refreshShotPanel();
  });

  // keyboard: S toggles safety, arrows nudge, Enter shoots
  await shooter.keyboard.press('s');
  if (!(await state(shooter)).call.safety) fail('S did not set safety');
  await shooter.keyboard.press('s');
  if ((await state(shooter)).call !== null) fail('S did not clear safety');
  const a0 = await shooter.evaluate(() => S.angle);
  await shooter.keyboard.press('ArrowRight');
  const a1 = await shooter.evaluate(() => S.angle);
  if (Math.abs(a1 - a0 - Math.PI / 360) > 1e-9) fail('ArrowRight should add 0.5°');
  // a bit of draw via the spin pad (on a phone it is in the options sheet),
  // then shoot with the keyboard
  const phone = await shooter.evaluate(() => compactLayout.matches);
  if (phone) await shooter.click('#optionsBtn');
  const pad = await shooter.locator('#spinPad').boundingBox();
  await shooter.mouse.click(pad.x + pad.width / 2, pad.y + pad.height * 0.72);
  const spin = await shooter.evaluate(() => S.spin);
  if (!(spin.y < -0.3 && Math.abs(spin.x) < 0.1)) fail(`spin ${JSON.stringify(spin)}`);
  await shooter.screenshot({ path: path.join(shots, '5b-spin.png') });
  if (phone) await shooter.click('#sheetClose');
  await shooter.evaluate(() => setPower(0.3));
  await shooter.keyboard.press('Enter');
  await waitFor(shooter, (s) => s.moving, 'shooter sees the shot');
  await waitFor(watcher, (s) => s.moving, 'watcher sees the shot');
  const s2 = await waitFor(shooter, (s) => !s.moving, 'second shot settled', 30000);
  await waitFor(watcher, (s) => !s.moving, 'second shot settled on watcher', 5000);
  console.log('after shot 2:', s2.phase, 'turn', s2.turn, 'status:', s2.status);
  await shooter.screenshot({ path: path.join(shots, '6-after-shot.png') });
  await watcher.screenshot({ path: path.join(shots, '6-after-shot-watcher.png') });

  // game over: either player can ask for a rematch and the break alternates
  st = await state(A);
  if (st.phase === 'game_over') {
    await A.waitForSelector('#overPanel:not([hidden])');
    await A.screenshot({ path: path.join(shots, '6b-game-over.png') });
    const firstBreaker = sa.turn;
    await B.click('#rematch');
    const r = await waitFor(A, (s) => s.phase === 'breaking', 'rematch starts a rack');
    if (r.turn !== 1 - firstBreaker) fail(`break should alternate: was ${firstBreaker}, now ${r.turn}`);
    await waitFor(B, (s) => s.phase === 'breaking', 'rematch on B');
    console.log('rematch ok, breaker now', r.turn);
  }

  // safety shot by whoever is on (not possible on a break)
  st = await state(A);
  shooter = st.turn === st.seat ? A : B;
  if (st.phase !== 'breaking' && !(await state(shooter)).decision) {
    await waitFor(shooter, (s) => s.shotVisible, 'shot panel for safety');
    await shooter.click('#safety');
    if (!(await state(shooter)).call.safety) fail('safety button');
    if ((await shooter.evaluate(() => S.spin)).y !== 0) fail('spin not reset on a new turn');
    await shooter.evaluate(() => setPower(0.4));
    await shooter.keyboard.press(' ');
    await waitFor(shooter, (s) => s.moving, 'safety shot started');
    const s3 = await waitFor(shooter, (s) => !s.moving, 'safety settled', 30000);
    if (s3.turn === st.turn && !s3.decision && s3.phase !== 'game_over') fail('turn should pass after a safety');
    console.log('after safety:', s3.status);
  }

  // closing the tab mid-game holds the seat: the game is not abandoned yet
  await B.close();
  const s4 = await waitFor(A, (s) => s.status.includes('lost connection'), 'A sees Bob offline');
  if (s4.phase === 'lobby') fail('game abandoned immediately instead of holding the seat');
  await A.screenshot({ path: path.join(shots, '7-opponent-dropped.png') });

  if (errors.length) fail('page errors:\n' + errors.join('\n'));
  console.log('OK');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
