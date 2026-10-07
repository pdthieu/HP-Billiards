// Pool client. One file, no build step. Talks the protocol in docs/PROTOCOL.md.
//
// Layout of this file:
//   1. constants and state
//   2. networking (join, send, message handlers)
//   3. shot logic (legal targets, aim ray cast)
//   4. rendering (canvas, portrait rotation, interpolation)
//   5. pointer and keyboard input
//   6. panels (lobby, shot controls, decision, game over)
'use strict';

// ---------------------------------------------------------------------------
// 1. constants and state

const W = 2.54;            // playing surface, meters
const H = 1.27;
const R = 0.028575;        // ball radius
const HEAD = W / 4;        // head string; the kitchen is x <= HEAD
const FOOT = { x: W * 3 / 4, y: H / 2 };
const RAIL = 0.1;          // drawn wooden rail width beyond the cushions
const CUSHION = 0.045;     // drawn cushion depth behind the nose line
// Pocket geometry, WPA equipment specification; keep in sync with
// game.DefaultConfig on the server.
const INCH = 0.0254;
const CORNER_MOUTH = 4.5625 * INCH;
const SIDE_MOUTH = 5.0625 * INCH;
const CORNER_JAW = 142 * Math.PI / 180;
const SIDE_JAW = 104 * Math.PI / 180;
const CORNER_SHELF = 1.75 * INCH;
const SIDE_SHELF = 0.25 * INCH;
const TABLE = buildTable();
const POCKETS = TABLE.pockets; // {x, y}: middle of each mouth, pocket-index order
const BALL_COLORS = { // design tokens --ball-1 … --ball-8
  1: '#F2C12E', 2: '#1F4FB4', 3: '#CC3326', 4: '#5B3592', 5: '#EC7623', 6: '#128A4C', 7: '#7E2232', 8: '#111316',
};
const RENDER_DELAY_MS = 100;  // how far behind the newest snapshot we draw
const AIM_SEND_MS = 100;      // at most 10 aim messages per second
const PING_EVERY_MS = 15000;  // heartbeat; the server answers with pong
const PONG_TIMEOUT_MS = 10000;
const RECONNECT_MAX_MS = 8000;
const SEAT_HOLD_S = 60;       // how long the server holds a seat (PROTOCOL.md)
const CLOCK_LOW_S = 10;       // the shot clock turns red and warns from here
const ROOMS_POLL_MS = 3000;

// buildTable lays out cushions and pockets like Table.buildRails on the server.
function buildTable() {
  const a = CORNER_MOUTH / Math.SQRT2; // corner noses sit this far from the corner along each rail
  const s = SIDE_MOUTH / 2;
  const d = 1 / Math.SQRT2;
  const pockets = [
    { x: a / 2, y: a / 2, ax: -d, ay: -d, half: CORNER_MOUTH / 2, shelf: CORNER_SHELF },
    { x: W / 2, y: 0, ax: 0, ay: -1, half: s, shelf: SIDE_SHELF, side: true },
    { x: W - a / 2, y: a / 2, ax: d, ay: -d, half: CORNER_MOUTH / 2, shelf: CORNER_SHELF },
    { x: a / 2, y: H - a / 2, ax: -d, ay: d, half: CORNER_MOUTH / 2, shelf: CORNER_SHELF },
    { x: W / 2, y: H, ax: 0, ay: 1, half: s, shelf: SIDE_SHELF, side: true },
    { x: W - a / 2, y: H - a / 2, ax: d, ay: d, half: CORNER_MOUTH / 2, shelf: CORNER_SHELF },
  ];
  // jaw direction from a nose: the cushion direction (away from the pocket)
  // rotated by the jaw angle away from the playing surface
  const jaw = (ux, uy, inx, iny, corner) => {
    const t = corner ? CORNER_JAW : SIDE_JAW;
    return { x: ux * Math.cos(t) - inx * Math.sin(t), y: uy * Math.cos(t) - iny * Math.sin(t) };
  };
  const cushions = [];
  const add = (from, to, inward, fromCorner, toCorner) => {
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    const ux = (to.x - from.x) / len, uy = (to.y - from.y) / len;
    cushions.push({
      from, to, inward,
      jawFrom: jaw(ux, uy, inward.x, inward.y, fromCorner),
      jawTo: jaw(-ux, -uy, inward.x, inward.y, toCorner),
    });
  };
  add({ x: a, y: 0 }, { x: W / 2 - s, y: 0 }, { x: 0, y: 1 }, true, false);
  add({ x: W / 2 + s, y: 0 }, { x: W - a, y: 0 }, { x: 0, y: 1 }, false, true);
  add({ x: a, y: H }, { x: W / 2 - s, y: H }, { x: 0, y: -1 }, true, false);
  add({ x: W / 2 + s, y: H }, { x: W - a, y: H }, { x: 0, y: -1 }, false, true);
  add({ x: 0, y: a }, { x: 0, y: H - a }, { x: 1, y: 0 }, true, true);
  add({ x: W, y: a }, { x: W, y: H - a }, { x: -1, y: 0 }, true, true);
  return { pockets, cushions };
}
const DEG = Math.PI / 180;

// optionText returns [title, consequence] for a post-break option; opp is
// the other player's name.
function optionText(opt, opp) {
  switch (opt) {
    case 'accept_table': return ['Play from here', 'Accept the balls where they lie. You shoot next.'];
    case 'rerack_break': return ['Re-rack, I break', 'Start the rack again with your break.'];
    case 'rerack_opponent_breaks': return [`Re-rack, ${opp} breaks again`, 'They get another try at a legal break.'];
    case 'spot_eight': return ['Spot the 8-ball', 'Put the 8 back on the foot spot and play on.'];
    case 'rebreak': return ['Re-rack, I break', 'Start the rack again with your break.'];
    case 'take_shot': return ['Take the shot', 'Play from where the balls lie.'];
    case 'pass_back': return ['Pass it back', `${opp} shoots again from here.`];
    default: return [opt, ''];
  }
}
const FOUL_TEXT = {
  scratch: 'scratch',
  no_contact: 'no ball contacted',
  wrong_ball: 'wrong ball hit first',
  kitchen: 'illegal shot from the kitchen',
  no_rail: 'no rail after contact',
  bad_break: 'fewer than four balls reached a rail',
};
const MODE_NAME = { '8ball': '8-ball', '9ball': '9-ball' };

const $ = (id) => document.getElementById(id);

const S = {
  ws: null,
  intentionalClose: false,
  roomCode: '',
  name: '',
  seat: -1,
  token: '',
  reconnectAttempt: 0,
  reconnectTimer: 0,
  reconnectDue: 0,       // when the next attempt fires
  reconnectDelay: 0,
  discSince: 0,          // when our socket dropped (seat hold countdown)
  discTimer: 0,          // delayed display of the connection card
  retryTicker: 0,
  splashTimer: 0,
  splashFallback: 0,
  lobbyNote: '',         // one-off note for the lobby panel (e.g. the opponent did not come back)
  lastOppName: '',
  pingTimer: 0,
  pongTimer: 0,

  // last room state from the server
  players: [
    { seat: 0, name: '', connected: false, ready: false },
    { seat: 1, name: '', connected: false, ready: false },
  ],
  phase: 'lobby',
  turn: 0,
  mode: '8ball',         // the room's game: '8ball' or '9ball'
  fouls: [0, 0],         // 9-ball: consecutive fouls by seat
  pushOut: false,        // 9-ball: the player on turn may push out
  practice: false,       // one player plays both sides; S.seat follows the side to play
  undos: 0,              // practice: shots the server can take back
  moveTool: false,       // practice: dragging a ball moves it instead of aiming
  rackMode: '8ball',     // practice: the game the Rack button sets up
  groups: ['', ''],
  ballInHand: false,
  kitchen: false,
  decision: null,
  winner: null,
  moving: false,
  balls: new Map(),      // id -> {x, y}; authoritative positions

  // shot in progress
  snaps: [],             // [{t, balls: Map}] in arrival order
  shotWall0: 0,          // performance.now() when snapshot t=0 arrived

  // my shot
  angle: 0,
  power: 0.3,            // fraction of MAX_CUE_SPEED sent with the shot; the bar maps to it quadratically
  spin: { x: 0, y: 0 },  // cue tip offset, unit disc; y > 0 is top spin
  powerDrag: false,      // the power bar is being pulled
  powerBefore: 0.3,      // power before the current pull, restored on cancel
  lastPower: 0,          // power of the last shot, shown faintly in the bar
  lefty: false,          // power bar on the left
  aimFront: readSetting('pool:aim') === 'front', // aim by pointing at the target, not by the butt of the cue
  hoverBall: null,       // ball under the mouse, for its label
  call: null,            // {pocket} for the 8-ball, {safety: true}, or {pushOut: true} in 9-ball
  roomsTimer: 0,
  aiming: false,
  drag: null,            // {id, x, y} while a ball is carried: the cue ball in hand, any ball in practice
  tap: null,             // press on a ball or pocket awaiting release: {id, pocket, x, y, t, type}
  placedAt: null,        // {id, x, y}: last placement we sent, kept until the server confirms
  lastAimSent: 0,
  aimTimer: 0,

  oppAim: null,          // {angle, power}
  lastDecisionReason: '',
  offlineSince: [0, 0],  // performance.now() when a seat dropped, per seat; 0 = unknown
  holdTimer: 0,
  clock: null,           // the server's shot clock plus at: performance.now() when it arrived
  clockTimer: 0,
  clockWarned: false,    // the low-time toast was shown for this clock

  // canvas motion
  pendingDrops: [],      // balls that vanished from a snapshot, awaiting their drop animation
  liftStart: 0,          // when the carried ball was picked up
  aimShownAt: 0,         // when the aim guide started fading in
  oppAimPrev: null,      // previous opponent aim, eased toward S.oppAim
  oppAimAt: 0,
  hoverUntil: 0,         // touch: hide the hover label after this time
  statusTimer: 0,
  aimLine: 0.1,          // m of object-ball guide after contact, from welcome; 0 = none
  lastBreaker: -1,       // who broke the current rack, for the game-over note
  shotWasBreak: false,   // the shot in progress (or just settled) is a break
  resultReason: '',      // why the rack ended, for the result banner

  // match
  match: null,           // {race, breaks, score, racks, winner} from the server; null in practice
  race: 1,               // settings of the next match (set_match)
  breaks: 'alternate',
  shownScore: null,      // {score, race} last drawn in the header, for the tick
  matchJustWon: false,   // open the match dialog after this update
  oppLeft: false,        // the opponent left on purpose (not a lost connection)
};

// ---------------------------------------------------------------------------
// 2. networking

// Session storage keeps the seat token per room and per tab: reloading the
// tab reclaims the seat, a second tab does not steal it.
function sessionKey(roomCode) { return `pool:${roomCode}`; }
function loadSession(roomCode) {
  try { return JSON.parse(sessionStorage.getItem(sessionKey(roomCode))) || null; } catch { return null; }
}
function saveSession() {
  try { sessionStorage.setItem(sessionKey(S.roomCode), JSON.stringify({ token: S.token, name: S.name })); } catch { /* unavailable */ }
}
function clearSession(roomCode) {
  try { sessionStorage.removeItem(sessionKey(roomCode)); } catch { /* unavailable */ }
}

function connectAndJoin(roomCode, name, token) {
  if (S.ws) { S.intentionalClose = true; S.ws.close(); }
  S.intentionalClose = false;
  clearTimeout(S.reconnectTimer);
  S.reconnectTimer = 0;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  S.ws = ws;
  S.roomCode = roomCode;
  S.name = name;
  ws.onopen = () => {
    const join = { type: 'join', roomCode, name };
    if (token) join.token = token;
    send(join);
    startHeartbeat();
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handle(msg);
  };
  ws.onclose = (e) => {
    if (ws !== S.ws) return;
    S.ws = null;
    stopHeartbeat();
    if (S.intentionalClose) return;
    if (S.seat < 0) {
      showLanding(`Could not join: ${e.reason || 'connection closed'}`);
      return;
    }
    if (/replaced/.test(e.reason)) {
      // Another connection took this seat with our token; do not fight it.
      S.reconnectAttempt = 0;
      showConn('taken');
      return;
    }
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (!S.reconnectAttempt) S.discSince = performance.now();
  S.reconnectAttempt++;
  const delay = S.reconnectAttempt === 1 ? 300 : Math.min(RECONNECT_MAX_MS, 1000 * 2 ** (S.reconnectAttempt - 2));
  S.reconnectDelay = delay;
  S.reconnectDue = performance.now() + delay;
  // Show the card only once the drop has lasted a moment: most reconnects
  // succeed before anyone would have read it.
  if ($('disconnected').hidden && !S.discTimer) {
    S.discTimer = setTimeout(() => { S.discTimer = 0; if (S.reconnectAttempt) showConn('lost'); }, 300);
  } else if (!$('disconnected').hidden) {
    showConn('lost');
  }
  clearTimeout(S.reconnectTimer);
  S.reconnectTimer = setTimeout(() => {
    S.reconnectTimer = 0;
    if (S.seat < 0 || S.ws) return;
    connectAndJoin(S.roomCode, S.name, S.token);
  }, delay);
}

// showConn shows the connectivity card: 'lost' (retrying with a backoff) or
// 'taken' (another connection holds the seat; no automatic retry).
function showConn(kind) {
  hideSplash();
  const taken = kind === 'taken';
  $('connIconLost').hidden = taken;
  $('connIconTaken').hidden = !taken;
  $('connTitle').textContent = taken ? 'Playing somewhere else?' : 'Connection lost';
  $('disconnectedText').textContent = taken
    ? 'This seat was taken over by another connection, probably another tab or device. Only one can hold a seat.'
    : `Reconnecting… Your seat is held for ${SEAT_HOLD_S} seconds.`;
  $('retry').hidden = taken;
  $('connNote').hidden = !taken;
  $('rejoin').className = taken ? 'btn btn--primary' : 'btn btn--secondary';
  $('rejoin').lastElementChild.textContent = taken ? 'Play here' : 'Retry now';
  $('disconnected').hidden = false;
  if (!taken) startRetryTicker(); else stopRetryTicker();
}

function hideConn() {
  clearTimeout(S.discTimer);
  S.discTimer = 0;
  $('disconnected').hidden = true;
  stopRetryTicker();
}

// The retry strip: one step per attempt, the current one filling up until
// it fires; the meta line counts the next attempt and the seat hold.
function startRetryTicker() {
  stopRetryTicker();
  renderRetry();
  S.retryTicker = setInterval(renderRetry, 50);
}
function stopRetryTicker() {
  clearInterval(S.retryTicker);
  S.retryTicker = 0;
}
function renderRetry() {
  const steps = $('retry').querySelectorAll('.retry__step');
  const now = performance.now();
  const attempt = Math.max(1, S.reconnectAttempt);
  const idx = Math.min(attempt, steps.length) - 1;
  const p = S.reconnectDelay ? clamp01(1 - (S.reconnectDue - now) / S.reconnectDelay) : 1;
  steps.forEach((el, i) => {
    el.className = 'retry__step' + (i < idx ? ' retry__step--done' : i === idx ? ' retry__step--now' : '');
    if (i === idx) el.style.setProperty('--p', String(p));
  });
  const next = Math.max(0, (S.reconnectDue - now) / 1000);
  $('retryTry').textContent = S.ws ? `Try ${attempt} · connecting…` : `Try ${attempt} · next in ${next.toFixed(1)} s`;
  const held = Math.max(0, SEAT_HOLD_S - (now - S.discSince) / 1000);
  $('retryHold').textContent = `Seat held ${Math.ceil(held)} s`;
}

// The splash covers a reload inside a room: shown only after 150 ms so an
// instant rejoin never flashes it, replaced by the card after 4 s.
function showSplash(code) {
  $('splashCode').textContent = code;
  clearTimeout(S.splashTimer);
  clearTimeout(S.splashFallback);
  S.splashTimer = setTimeout(() => { S.splashTimer = 0; $('splash').hidden = false; }, 150);
  S.splashFallback = setTimeout(() => { if (!$('splash').hidden && S.seat >= 0) { S.reconnectAttempt = Math.max(1, S.reconnectAttempt); showConn('lost'); } }, 4000);
}
function hideSplash() {
  clearTimeout(S.splashTimer);
  clearTimeout(S.splashFallback);
  S.splashTimer = 0;
  $('splash').hidden = true;
}

// The browser only notices a dead socket when TCP gives up, which can take
// minutes. A ping without a pong closes it so the reconnect kicks in.
function startHeartbeat() {
  stopHeartbeat();
  S.pingTimer = setInterval(() => {
    if (!send({ type: 'ping' })) return;
    clearTimeout(S.pongTimer);
    S.pongTimer = setTimeout(() => {
      if (S.ws) S.ws.close(4000, 'pong timeout');
    }, PONG_TIMEOUT_MS);
  }, PING_EVERY_MS);
}

function stopHeartbeat() {
  clearInterval(S.pingTimer);
  clearTimeout(S.pongTimer);
  S.pingTimer = 0;
  S.pongTimer = 0;
}

function send(msg) {
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return false;
  S.ws.send(JSON.stringify(msg));
  return true;
}

function handle(msg) {
  switch (msg.type) {
    case 'welcome': onWelcome(msg); break;
    case 'room_state': onRoomState(msg); break;
    case 'snapshot': onSnapshot(msg); break;
    case 'settled': onSettled(msg); break;
    case 'aim':
      if (msg.seat !== S.seat) {
        S.oppAimPrev = S.oppAim;
        S.oppAimAt = performance.now();
        S.oppAim = { angle: msg.angle, power: msg.power };
      }
      break;
    case 'player': onPlayer(msg); break;
    case 'clock': setClock(msg); refreshPanels(); break;
    case 'timeout': onTimeout(msg); break;
    case 'pong': clearTimeout(S.pongTimer); S.pongTimer = 0; break;
    case 'error': onError(msg); break;
  }
}

function onWelcome(msg) {
  const reconnected = S.seat >= 0 && S.reconnectAttempt > 0;
  S.seat = msg.seat;
  if (typeof msg.aimLine === 'number') S.aimLine = msg.aimLine / 1000;
  S.token = msg.token;
  S.roomCode = msg.roomCode;
  S.reconnectAttempt = 0;
  $('roomCode').textContent = msg.roomCode;
  history.replaceState(null, '', `/?room=${encodeURIComponent(msg.roomCode)}`);
  hideLanding();
  hideConn();
  hideSplash();
  saveSession();
  if (reconnected) toast('Reconnected');
}

function applyRules(msg) {
  const turnChanged = msg.turn !== S.turn || msg.phase !== S.phase;
  S.phase = msg.phase;
  S.turn = msg.turn;
  if (msg.mode) S.mode = msg.mode; // settled carries no mode: it cannot change mid-game
  if (msg.practice !== undefined) S.practice = msg.practice; // likewise
  if (S.practice) S.seat = msg.decision ? msg.decision.seat : msg.turn; // play the side to play
  S.undos = msg.undos || 0;
  S.fouls = msg.fouls || [0, 0];
  S.pushOut = !!msg.pushOut;
  S.groups = msg.groups;
  S.ballInHand = msg.ballInHand;
  S.kitchen = msg.kitchen;
  S.decision = msg.decision || null;
  S.winner = msg.winner === undefined ? null : msg.winner;
  if (msg.race !== undefined) { S.race = msg.race; S.breaks = msg.breaks; } // room_state only
  if (msg.match !== undefined) setMatch(msg.match);
  return turnChanged;
}

function setBalls(list) {
  S.balls = new Map(list.map((b) => [b.id, { x: b.x, y: b.y }]));
}

function onRoomState(msg) {
  const prevPhase = S.phase;
  S.players = msg.players;
  S.moving = msg.moving;
  setBalls(msg.balls);
  S.snaps = []; // a shot in progress resumes from the next snapshot
  S.pendingDrops = [];
  const hadDecision = !!S.decision;
  const turnChanged = applyRules(msg);
  setClock(msg.clock);
  S.placedAt = null;
  S.drag = null;
  if (turnChanged || (hadDecision && !S.decision)) newTurn();
  if (msg.phase === 'breaking' && !msg.decision) S.lastBreaker = msg.turn;
  if (msg.phase === 'breaking' && prevPhase !== 'breaking') {
    resetOrientations(); // a fresh rack
    if (S.practice) S.rackMode = msg.mode; // the Rack picker starts on the game being played
  }
  if (prevPhase !== 'game_over' && prevPhase !== 'lobby' && msg.phase === 'game_over' && S.winner !== null) {
    // Not by a shot (that comes as settled): a third foul on the clock.
    const loser = 1 - S.winner;
    S.resultReason = `${nameOf(loser)} fouled three times in a row`;
    setStatus(`${S.resultReason}. ${isMe(S.winner) ? 'You win!' : `${nameOf(S.winner)} wins.`}`, 'foul');
  } else if (prevPhase !== 'lobby' && msg.phase === 'lobby') {
    const m = S.match;
    const last = m && m.racks.length ? m.racks[m.racks.length - 1] : null;
    const who = S.lastOppName || 'Your opponent';
    if (last && last.end === 'forfeit' && isMe(m.winner)) {
      setStatus(`${who} ${S.oppLeft ? 'left' : 'didn’t come back'}. You win the match ${m.score[S.seat]}–${m.score[1 - S.seat]}.`);
      S.lobbyNote = S.oppLeft ? `${who} left the room.` : `${who} didn’t come back in time.`;
    } else {
      setStatus('The game was abandoned.', 'foul');
      const gone = S.players[1 - S.seat];
      if (gone && !gone.name && S.lastOppName) S.lobbyNote = `${S.lastOppName} didn’t come back in time.`;
    }
  } else if (msg.phase === 'breaking' && prevPhase !== 'breaking') {
    setStatus(`${nameOf(msg.turn)} ${isMe(msg.turn) ? 'break' : 'breaks'}. Place the cue ball in the kitchen and shoot.`);
  } else if (msg.phase === 'lobby') {
    setStatus('');
  }
  refreshPanels();
  showMatchIfWon(0);
}

function onSnapshot(msg) {
  const balls = new Map(msg.balls.map((b) => [b.id, { x: b.x, y: b.y }]));
  if (msg.t > 0 && S.moving && S.snaps.length) {
    // A ball missing from this snapshot was pocketed: animate it dropping
    // once the render clock reaches this snapshot.
    const prev = S.snaps[S.snaps.length - 1];
    for (const [id, p] of prev.balls) if (!balls.has(id)) queueDrop(id, p, msg.t);
  }
  if (msg.t === 0 || !S.moving || S.snaps.length === 0) {
    // A new shot, or joining one midway (reconnect): align our clock to it.
    // Somebody else's shot gets its cue strike now, as the cue moves.
    if (msg.t === 0 && performance.now() - SND.ownStrike > 1500) {
      playStrike(S.oppAim ? S.oppAim.power : 0.4, RENDER_DELAY_MS);
    }
    S.snaps = [];
    S.pendingDrops = [];
    S.shotWall0 = performance.now() - msg.t;
    S.shotWasBreak = S.phase === 'breaking';
    S.moving = true;
    S.clock = null;
    S.oppAim = null;
    S.aiming = false;
    S.drag = null;
    S.placedAt = null;
  }
  S.snaps.push({ t: msg.t, balls });
  playImpacts(msg.impacts);
  refreshPanels();
}

function onSettled(msg) {
  // Anything still on the table in our last snapshot but gone now drops;
  // queued drops start at once.
  const last = S.snaps.length ? S.snaps[S.snaps.length - 1].balls : S.balls;
  const now = new Set(msg.balls.map((b) => b.id));
  const queued = new Set(S.pendingDrops.map((d) => d.id));
  for (const d of S.pendingDrops) startDrop(d.id, d.from);
  S.pendingDrops = [];
  for (const [id, p] of last) if (!now.has(id) && !queued.has(id)) startDrop(id, p);
  playImpacts(msg.impacts);
  S.moving = false;
  S.snaps = [];
  setBalls(msg.balls);
  S.oppAim = null;
  applyRules(msg);
  setClock(msg.clock);
  newTurn();
  describeShot(msg);
  refreshPanels();
  showMatchIfWon(1600); // after the result banner
}

function onPlayer(msg) {
  const was = S.players[msg.seat];
  if (msg.seat !== S.seat && msg.name) S.lastOppName = msg.name;
  S.players[msg.seat] = { seat: msg.seat, name: msg.name, connected: msg.connected, ready: msg.ready };
  S.offlineSince[msg.seat] = msg.name && !msg.connected ? performance.now() : 0;
  if (msg.seat !== S.seat) {
    if (msg.connected && !was.connected) {
      S.lobbyNote = '';
      if (!was.name && S.phase === 'lobby' && S.match && S.match.racks.length) {
        // The server clears the score for a new opponent.
        S.match = { race: S.race, breaks: S.breaks, score: [0, 0], racks: [], winner: null };
      }
      toast(was.name ? `${msg.name} is back` : `${msg.name} joined`);
    } else if (!msg.connected && was.connected && msg.name) {
      toast(`${msg.name} lost connection`);
      setStatus(`${msg.name} lost connection. Their seat is held for ${SEAT_HOLD_S} seconds.`, 'foul');
    } else if (!msg.connected && !msg.name && was.name) {
      S.oppLeft = was.connected; // still connected: they pressed Leave
      toast(`${was.name} left`);
    }
  }
  refreshPanels();
}

function onError(msg) {
  toast(msg.message || msg.code, true);
  if (msg.code === 'bad_placement' || msg.code === 'no_ball_in_hand' || msg.code === 'balls_moving') {
    S.drag = null;
    S.placedAt = null;
  }
  if (msg.code === 'room_not_found' || msg.code === 'room_full') {
    // The join failed: the room is gone or our held seat expired and was
    // taken. Nothing to come back to.
    S.intentionalClose = true;
    if (S.ws) S.ws.close();
    S.ws = null;
    stopHeartbeat();
    clearSession(S.roomCode);
    resetToLanding(msg.message);
  }
}

// setClock takes the shot clock from the server (null: nobody has to act).
// Its time is counted from arrival, so the two machines' clocks never mix.
function setClock(c) {
  if (!c) { S.clock = null; return; }
  if (!S.clock || c.seat !== S.clock.seat || c.left > CLOCK_LOW_S * 1000) S.clockWarned = false;
  S.clock = { ...c, at: performance.now() };
}

// clockLeft returns the seconds left on the shot clock, or null without one.
function clockLeft() {
  const c = S.clock;
  if (!c) return null;
  const ms = c.paused ? c.left : c.left - (performance.now() - c.at);
  return Math.max(0, ms / 1000);
}

function onTimeout(msg) {
  const who = nameOf(msg.seat);
  const other = nameOf(1 - msg.seat);
  let text = `${isMe(msg.seat) ? 'You' : who} ran out of time`;
  if (msg.option) {
    text += `; “${optionText(msg.option, other)[0]}” was chosen.`;
  } else if (S.phase === 'breaking') {
    text += `. ${other} ${isMe(1 - msg.seat) ? 'break' : 'breaks'} instead.`;
  } else if (isNine() && S.fouls[msg.seat] + 1 >= 3) {
    text += ': a third foul in a row.'; // the room_state that follows ends the rack
  } else {
    text += `. ${other} ${isMe(1 - msg.seat) ? 'have' : 'has'} ball in hand.`;
    if (isNine() && S.fouls[msg.seat] + 1 === 2) text += ` ${isMe(msg.seat) ? 'You are' : `${who} is`} on two fouls.`;
  }
  S.clock = null;
  toast(text, isMe(msg.seat));
  setStatus(text, 'foul');
}

// resetToLanding forgets the room and shows the landing form.
function resetToLanding(error) {
  clearTimeout(S.reconnectTimer);
  S.reconnectTimer = 0;
  S.reconnectAttempt = 0;
  hideConn();
  hideSplash();
  S.seat = -1;
  S.token = '';
  S.phase = 'lobby';
  S.moving = false;
  S.snaps = [];
  S.decision = null;
  S.clock = null;
  S.mode = '8ball';
  S.practice = false;
  S.undos = 0;
  S.moveTool = false;
  S.fouls = [0, 0];
  S.pushOut = false;
  S.lastBreaker = -1;
  S.match = null;
  S.shownScore = null;
  S.oppLeft = false;
  for (const id of ['matchDialog', 'settings', 'leaveConfirm']) $(id).hidden = true;
  S.players = [
    { seat: 0, name: '', connected: false, ready: false },
    { seat: 1, name: '', connected: false, ready: false },
  ];
  history.replaceState(null, '', '/');
  $('roomCode').textContent = '—';
  refreshPanels();
  showLanding(error);
}

// newTurn resets the per-shot UI when the shooter or phase changes.
function newTurn() {
  S.aimShownAt = performance.now();
  S.call = null;
  S.aiming = false;
  S.drag = null;
  S.placedAt = null;
  S.spin = { x: 0, y: 0 };
  if (isMyShot()) {
    const cue = S.balls.get(0);
    const targets = legalTargets();
    let best = null;
    if (cue) {
      for (const id of (targets.size ? targets : S.balls.keys())) {
        if (id === 0) continue;
        const b = S.balls.get(id);
        const d = Math.hypot(b.x - cue.x, b.y - cue.y);
        if (!best || d < best.d) best = { d, b };
      }
    }
    if (best) S.angle = Math.atan2(best.b.y - cue.y, best.b.x - cue.x);
    else S.angle = 0;
  }
}

function describeShot(msg) {
  if (S.practice) { describeFreeShot(msg); return; }
  const parts = [];
  const who = nameOf(msg.shooter);
  const me = isMe(msg.shooter);
  const made = msg.pocketed.filter((id) => id !== 0);
  const over = msg.winner !== undefined && msg.winner !== null;
  const nine = isNine();
  if (msg.illegalBreak && !nine) parts.push(me ? 'You broke illegally.' : `Illegal break by ${who}.`);
  if (msg.pushedOut) parts.push(me ? 'You pushed out.' : `${who} pushed out.`);
  if (msg.foul) parts.push(`${me ? 'Your foul' : `Foul by ${who}`}: ${FOUL_TEXT[msg.foul] || msg.foul}.`);
  if (made.length) parts.push(`Pocketed ${made.map(ballName).join(', ')}.`);
  if (nine && !over && made.includes(9)) parts.push('The 9 goes back on the foot spot.');
  if (nine && !over && msg.foul && msg.fouls && msg.fouls[msg.shooter] === 2) {
    parts.push(`${me ? 'You are' : `${who} is`} on two fouls: a third loses the rack.`);
  }
  if (over) {
    parts.push(isMe(msg.winner) ? 'You win!' : `${nameOf(msg.winner)} wins.`);
    S.resultReason = nine ? nineResultReason(msg, who) : eightResultReason(msg, who, made);
  } else if (msg.decision) {
    parts.push(`${nameOf(msg.decision.seat)} ${isMe(msg.decision.seat) ? 'choose' : 'chooses'} how to continue.`);
  } else {
    let t = isMe(msg.turn) ? 'Your turn' : `${nameOf(msg.turn)}'s turn`;
    if (msg.ballInHand) t += msg.kitchen ? ', ball in hand in the kitchen' : ', ball in hand';
    if (msg.pushOut) t += isMe(msg.turn) ? '; you may push out' : '; they may push out';
    parts.push(t + '.');
  }
  if (msg.pushedOut && msg.decision) {
    S.lastDecisionReason = `${me ? 'You' : who} pushed out. Take the shot from here, or pass it back.`;
  } else if (msg.illegalBreak) {
    S.lastDecisionReason = `${me ? 'You' : who} broke illegally: nothing pocketed and fewer than four balls reached a rail.`;
  } else if (msg.decision) {
    S.lastDecisionReason = `${me ? 'You' : who} pocketed the 8-ball on the break.`;
  }
  setStatus(parts.join(' '), msg.foul ? 'foul' : (msg.made ? 'good' : ''));
}

// describeFreeShot says what a practice shot did: no fouls, no turns.
function describeFreeShot(msg) {
  const made = msg.pocketed.filter((id) => id !== 0);
  const parts = [];
  if (made.length) parts.push(`Pocketed ${made.map(ballName).join(', ')}.`);
  if (msg.pocketed.includes(0)) parts.push('The cue ball dropped; it is back on the head spot.');
  if (![...S.balls.keys()].some((id) => id > 0)) parts.push('Table cleared! Rack again for more.');
  setStatus(parts.join(' ') || 'Nothing dropped.', made.length ? 'good' : '');
}

// nineResultReason says why a 9-ball rack ended with this shot.
function nineResultReason(msg, who) {
  if (msg.winner !== msg.shooter) return `${who} fouled three times in a row`;
  return S.shotWasBreak ? '9-ball pocketed on the break' : '9-ball pocketed';
}

// eightResultReason says why an 8-ball rack ended with this shot.
function eightResultReason(msg, who, made) {
  const g = S.groups[msg.shooter];
  const early = !g || remaining(g) > 0 || made.some((id) => groupOf(id) === g);
  if (msg.winner === msg.shooter) return '8-ball pocketed in the called pocket';
  if (msg.foul) return `${who} fouled on the 8-ball: ${FOUL_TEXT[msg.foul] || msg.foul}`;
  return early ? `${who} pocketed the 8-ball early` : `${who} pocketed the 8-ball in the wrong pocket`;
}

// ---------------------------------------------------------------------------
// 3. shot logic

const isMe = (seat) => seat === S.seat;
const sideName = (seat) => (seat ? 'Side B' : 'Side A');
const nameOf = (seat) => (isMe(seat) ? 'You' : S.practice ? sideName(seat) : (S.players[seat].name || `Player ${seat + 1}`));
const groupOf = (id) => (id >= 1 && id <= 7 ? 'solids' : id >= 9 && id <= 15 ? 'stripes' : '');
const isNine = () => S.mode === '9ball';
const ballName = (id) => (id === 8 && !isNine() ? 'the 8-ball' : id === 9 && isNine() ? 'the 9-ball' : `the ${id}`);
const inPlay = () => !S.decision && (S.phase === 'breaking' || S.phase === 'open' || S.phase === 'assigned');
const isMyShot = () => S.seat >= 0 && inPlay() && !S.moving && S.turn === S.seat;
const canCall = () => !S.practice && !isNine() && S.phase !== 'breaking'; // a safety may be declared (8-ball)
const canPushOut = () => isNine() && S.pushOut && isMyShot();
// eightOn mirrors Rules.eightOn: the 8-ball is my legal target, so it needs
// a called pocket.
function eightOn() {
  if (S.practice || isNine()) return false; // practice calls nothing
  if (S.phase === 'open') return remaining('solids') === 0 || remaining('stripes') === 0;
  if (S.phase === 'assigned') return remaining(S.groups[S.seat]) === 0;
  return false;
}
const needsPocket = () => eightOn() && !(S.call && S.call.safety);

function remaining(group) {
  let n = 0;
  for (const id of S.balls.keys()) if (groupOf(id) === group) n++;
  return n;
}

// legalTargets mirrors Rules.legalTarget on the server for highlighting.
function legalTargets() {
  const out = new Set();
  if (S.practice) return out; // free play: every ball is fair
  if (isNine()) {
    const low = lowestBall();
    if (low !== null) out.add(low);
    return out;
  }
  if (S.phase === 'breaking') return out;
  const mine = S.groups[S.seat];
  const eight = eightOn();
  for (const id of S.balls.keys()) {
    if (id === 0) continue;
    if (S.phase === 'open' && (id !== 8 || eight)) out.add(id);
    else if (S.phase === 'assigned' && (eight ? id === 8 : groupOf(id) === mine)) out.add(id);
  }
  return out;
}

// lowestBall mirrors Rules.lowest: the 9-ball shooter's legal first contact.
function lowestBall() {
  let low = null;
  for (const id of S.balls.keys()) if (id > 0 && (low === null || id < low)) low = id;
  return low;
}

// castAim finds where the cue ball, sent along angle, first touches a ball or
// a cushion. Returns the ghost-ball position plus, for a ball, its direction.
function castAim(balls, cue, angle) {
  const d = { x: Math.cos(angle), y: Math.sin(angle) };
  let t = Infinity;
  let hit = null;
  for (const [id, b] of balls) {
    if (id === 0) continue;
    const fx = cue.x - b.x, fy = cue.y - b.y;
    const bq = 2 * (fx * d.x + fy * d.y);
    const c = fx * fx + fy * fy - 4 * R * R;
    const disc = bq * bq - 4 * c;
    if (disc < 0) continue;
    const tt = (-bq - Math.sqrt(disc)) / 2;
    if (tt > 1e-6 && tt < t) { t = tt; hit = id; }
  }
  const tx = d.x > 1e-9 ? (W - R - cue.x) / d.x : d.x < -1e-9 ? (R - cue.x) / d.x : Infinity;
  const ty = d.y > 1e-9 ? (H - R - cue.y) / d.y : d.y < -1e-9 ? (R - cue.y) / d.y : Infinity;
  const tc = Math.max(0, Math.min(tx, ty));
  if (tc < t) { t = tc; hit = null; }
  const ghost = { x: cue.x + d.x * t, y: cue.y + d.y * t };
  let objDir = null, cueDir = null;
  if (hit !== null) {
    const b = balls.get(hit);
    const n = { x: b.x - ghost.x, y: b.y - ghost.y };
    const len = Math.hypot(n.x, n.y) || 1;
    objDir = { x: n.x / len, y: n.y / len };
    const dot = d.x * objDir.x + d.y * objDir.y;
    cueDir = { x: d.x - dot * objDir.x, y: d.y - dot * objDir.y };
    const cl = Math.hypot(cueDir.x, cueDir.y);
    cueDir = cl > 1e-6 ? { x: cueDir.x / cl, y: cueDir.y / cl } : null;
  }
  return { ghost, hit, dir: d, objDir, cueDir };
}

function canShoot() {
  if (!isMyShot() || S.drag) return false;
  return !needsPocket() || (S.call !== null && S.call.pocket !== undefined);
}

function shoot() {
  if (!canShoot()) return;
  const msg = { type: 'shoot', angle: S.angle, power: S.power };
  if (S.call && S.call.safety) msg.call = { safety: true };
  else if (S.call && S.call.pushOut) msg.call = { pushOut: true };
  else if (S.call && S.call.pocket !== undefined) msg.call = { pocket: S.call.pocket };
  if (S.spin.x || S.spin.y) msg.spin = { x: S.spin.x, y: S.spin.y };
  closeSheet();
  if (send(msg)) {
    playStrike(S.power);
    SND.ownStrike = performance.now();
    const cue = displayBalls().get(0);
    if (cue) {
      const dir = { x: Math.cos(S.angle), y: Math.sin(S.angle) };
      addFx({ type: 'strike', layer: 'cue', dur: 280, cue: { ...cue }, dir, power: S.power });
      addFx({ type: 'ring', layer: 'top', dur: 150, delay: 80, at: { ...cue } });
    }
  }
}

// --- power bar: pull down, release to shoot -------------------------------

const powerBar = $('powerBar');
const powerTrack = $('powerTrack');
const CANCEL_ZONE = 0.08;
// The bar is quadratic: pulling it to f gives power f², so the lower half of
// the bar covers the soft and medium shots that make up most of a game
// (under 2 m/s) and only the top end reaches break speed. See CLIENT.md.
const MAX_CUE_SPEED = 8; // m/s at power 1; mirrors game.DefaultConfig
const barToPower = (f) => f * f;
const powerToBar = (p) => Math.sqrt(p);

function renderPower() {
  const frac = powerToBar(S.power);
  const pct = Math.round(frac * 100);
  $('powerFill').style.setProperty('--fill', `${pct}%`);
  $('powerLast').style.height = `${Math.round(powerToBar(S.lastPower) * 100)}%`;
  powerTrack.setAttribute('aria-valuenow', String(pct));
  const readout = $('powerReadout');
  const cancel = S.powerDrag && frac <= CANCEL_ZONE;
  powerBar.classList.toggle('pbar--cancel', cancel);
  readout.hidden = !S.powerDrag;
  if (S.powerDrag) {
    readout.textContent = cancel ? 'Cancel' : `${(S.power * MAX_CUE_SPEED).toFixed(1)} m/s`;
    readout.style.top = `${Math.max(4, pct)}%`;
  }
}

function barPower(e) {
  const rect = powerTrack.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientY - rect.top) / (rect.height - 8))); // 100 % sits 8 px above the end
}

function powerClasses(...keep) {
  for (const c of ['pbar--drag', 'pbar--cancel', 'pbar--flash', 'pbar--settle', 'pbar--spring']) {
    powerBar.classList.toggle(c, keep.includes(c));
  }
}

powerBar.addEventListener('pointerdown', (e) => {
  if (!isMyShot()) return;
  e.preventDefault();
  powerBar.setPointerCapture(e.pointerId);
  S.powerDrag = true;
  S.powerBefore = S.power;
  powerClasses('pbar--drag');
  setPower(barToPower(barPower(e)), true);
});
powerBar.addEventListener('pointermove', (e) => {
  if (S.powerDrag) setPower(barToPower(barPower(e)), true);
});
// endPowerDrag finishes a pull: a release below the cancel zone shoots (if a
// call has been made), anything else restores the previous power.
function endPowerDrag(e, fire) {
  if (!S.powerDrag) return;
  S.powerDrag = false;
  const f = e ? barPower(e) : 0;
  if (fire && f > CANCEL_ZONE) {
    setPower(barToPower(f));
    if (canShoot()) {
      shoot();
      S.lastPower = S.power;
      powerClasses('pbar--flash', 'pbar--settle');
      setTimeout(() => powerClasses(), 160);
    } else {
      powerClasses();
      needsCallTip(e);
    }
  } else {
    S.power = S.powerBefore;
    powerClasses('pbar--spring');
    setTimeout(() => powerClasses(), 260);
    renderPower();
  }
}
powerBar.addEventListener('pointerup', (e) => endPowerDrag(e, true));
powerBar.addEventListener('pointercancel', (e) => endPowerDrag(e, false));

// cancelPowerDrag is Esc during a pull.
function cancelPowerDrag() {
  if (!S.powerDrag) return;
  S.powerDrag = false;
  S.power = S.powerBefore;
  powerClasses('pbar--spring');
  setTimeout(() => powerClasses(), 260);
  renderPower();
}

// needsCallTip explains a refused release beside the bar for two seconds and
// nudges the call line.
function needsCallTip(e) {
  const old = $('tableWrap').querySelector('.tip');
  if (old) old.remove();
  const tip = document.createElement('div');
  tip.className = 'tip' + (S.lefty ? ' tip--right' : '');
  tip.setAttribute('role', 'status');
  tip.textContent = needsPocket() && !S.call ? 'Call a pocket for the 8-ball: tap it.' : 'Cannot shoot now.';
  const wrap = $('tableWrap').getBoundingClientRect();
  tip.style.top = `${Math.max(8, (e ? e.clientY : wrap.top + wrap.height / 2) - wrap.top - 20)}px`;
  $('tableWrap').append(tip);
  setTimeout(() => tip.remove(), 2000);
  const line = $('callText');
  line.classList.remove('call__line--pulse');
  void line.offsetWidth;
  line.classList.add('call__line--pulse');
}

function applyLefty(on) {
  S.lefty = !!on;
  powerBar.classList.toggle('pbar--left', S.lefty);
  resize();
}

// --- spin pad: where the tip strikes the cue ball --------------------------

const spinPad = $('spinPad');
const SPIN_LIMIT = 0.72; // of the ball radius: beyond this a real shot miscues (.spin__limit inset 14%)
const SPIN_RANGE = 36;   // the dot travels ±36% of the pad for a full offset

function spinWords() {
  const parts = [];
  if (S.spin.y > 0.15) parts.push('top'); else if (S.spin.y < -0.15) parts.push('draw');
  if (S.spin.x > 0.15) parts.push('right'); else if (S.spin.x < -0.15) parts.push('left');
  return parts.length ? parts.join(' + ') : 'centre';
}

function renderSpin(spring) {
  const dot = $('spinDot');
  dot.classList.toggle('spin__dot--reset', !!spring);
  dot.style.left = `${50 + S.spin.x * SPIN_RANGE}%`;
  dot.style.top = `${50 - S.spin.y * SPIN_RANGE}%`;
  const atLimit = Math.hypot(S.spin.x, S.spin.y) >= 0.999;
  $('spinLimit').classList.toggle('spin__limit--max', atLimit);
  const words = spinWords();
  $('spinText').textContent = atLimit ? `${words} · at limit` : words;
  spinPad.setAttribute('aria-valuetext', words);
  $('spinReset').disabled = !S.spin.x && !S.spin.y;
  // the phone's options button is a small cue ball showing the same spin
  const mini = $('optsDot');
  mini.style.left = `${50 + S.spin.x * SPIN_RANGE}%`;
  mini.style.top = `${50 - S.spin.y * SPIN_RANGE}%`;
  $('optionsBtn').setAttribute('aria-label', `Spin and fine aim: ${words}`);
}

function setSpin(x, y, spring) {
  const l = Math.hypot(x, y);
  if (l > 1) { x /= l; y /= l; }
  S.spin = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
  renderSpin(spring);
}

function setSpinFromEvent(e) {
  const rect = spinPad.getBoundingClientRect();
  const r = rect.width / 2;
  setSpin((e.clientX - rect.left - r) / (r * SPIN_LIMIT), -(e.clientY - rect.top - r) / (r * SPIN_LIMIT));
}
let spinDrag = false;
spinPad.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  spinDrag = true;
  spinPad.setPointerCapture(e.pointerId);
  setSpinFromEvent(e);
});
spinPad.addEventListener('pointermove', (e) => { if (spinDrag) setSpinFromEvent(e); });
const endSpin = () => { spinDrag = false; };
spinPad.addEventListener('pointerup', endSpin);
spinPad.addEventListener('pointercancel', endSpin);
spinPad.addEventListener('keydown', (e) => {
  const step = 0.1;
  const k = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
  if (!k) return;
  e.preventDefault();
  e.stopPropagation();
  setSpin(S.spin.x + k[0], S.spin.y + k[1]);
});
$('spinReset').onclick = () => setSpin(0, 0, true);

// --- shot options sheet (phones) ---------------------------------------------
//
// On a phone the table gets the room: the shot panel is one row (what to
// hit, the situational toggles and a small cue ball showing the spin). The
// spin pad and the fine angle buttons move into a sheet that this button
// opens over the bottom of the screen; the table stays live above it.

const compactLayout = matchMedia('(max-width: 600px), (orientation: landscape) and (max-height: 500px)');
const shotOptions = [document.querySelector('#shotPanel .angle'), document.querySelector('#shotPanel .spin')];
const optionHomes = shotOptions.map((el) => { const mark = document.createComment(''); el.before(mark); return mark; });

// placeShotOptions puts the spin pad and the angle buttons in the sheet on
// a phone and back in the shot panel elsewhere.
function placeShotOptions() {
  if (compactLayout.matches) {
    $('sheetBody').append(...shotOptions);
  } else {
    shotOptions.forEach((el, i) => optionHomes[i].after(el));
    closeSheet();
  }
}

function openSheet() {
  if (!compactLayout.matches || !isMyShot()) return;
  $('shotSheet').hidden = false;
  $('optionsBtn').setAttribute('aria-expanded', 'true');
}

function closeSheet() {
  if ($('shotSheet').hidden) return;
  $('shotSheet').hidden = true;
  $('optionsBtn').setAttribute('aria-expanded', 'false');
}

$('optionsBtn').onclick = () => { if ($('shotSheet').hidden) openSheet(); else closeSheet(); };
$('sheetClose').onclick = closeSheet;
$('shotSheet').addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSheet(); $('optionsBtn').focus(); } });
// A touch anywhere else (aiming, the power bar) puts the sheet away.
document.addEventListener('pointerdown', (e) => {
  if (!$('shotSheet').hidden && !e.target.closest('#shotSheet, #optionsBtn')) closeSheet();
}, true);
compactLayout.addEventListener('change', () => { placeShotOptions(); refreshPanels(); });
placeShotOptions();

function queueAim() {
  if (!isMyShot()) return;
  const now = performance.now();
  const due = S.lastAimSent + AIM_SEND_MS - now;
  if (due <= 0) {
    S.lastAimSent = now;
    send({ type: 'aim', angle: S.angle, power: S.power });
  } else if (!S.aimTimer) {
    S.aimTimer = setTimeout(() => { S.aimTimer = 0; queueAim(); }, due);
  }
}

function setAngle(a) {
  S.angle = Math.atan2(Math.sin(a), Math.cos(a));
  $('angleText').textContent = `${((S.angle / DEG + 360) % 360).toFixed(1).replace(/^360\.0$/, '0.0')}°`;
  queueAim();
}

function setPower(p) {
  S.power = Math.max(0.02, Math.min(1, p)); // 0.02 is a 1.1 m/s touch
  renderPower();
  queueAim();
}

// ---------------------------------------------------------------------------
// 4. rendering
//
// Everything here follows design/canvas-spec.md. Units are table metres
// (the spec's millimetres / 1000). Static table layers are drawn once into
// tableCache on resize; balls, cue, guide, rings and effects every frame.

const canvas = $('table');
let ctx = canvas.getContext('2d');
let tableCache = null;
const view = { s: 1, ox: 0, oy: 0, rotated: false, cssW: 0, cssH: 0, dpr: 1 };

const PAL = {
  railTop: '#6A4428', rail: '#4C2F1B', railBottom: '#341F10', railLip: '#FFE2B4',
  feltCenter: '#36745C', felt: '#2C614C', feltEdge: '#1B3F31', cushion: '#1F4B3A',
  sight: '#E6D7B4', ivory: '#F4EFE2', disc: '#FAF7EF', ink: '#111316',
  brass: '#D9A441', brassLine: '#E3B25C', ok: '#71C99D', oppAim: '#A9C1DD',
  labelBg: '#0D1218', labelText: '#E8ECF1', labelStroke: '#AABED7', flash: '#FFE2B4',
};

// Easings from the spec (polynomial approximations of the CSS curves).
const EASE = {
  out: (t) => 1 - (1 - t) ** 3,
  in: (t) => t ** 3,
  inout: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  spring: (t) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2,
};
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;

// screenOffset converts an offset given in screen space (light from the
// screen's top-left) to table space, so shadows stay put when the table is
// rotated.
const screenOffset = (sx, sy) => (view.rotated ? { x: -sy, y: sx } : { x: sx, y: sy });

// --- transient effects ------------------------------------------------------
// fx entries: {type, layer: 'balls' | 'cue' | 'top', t0, delay, dur, ...}.
const fx = [];
function addFx(f) {
  fx.push({ t0: performance.now(), delay: 0, ...f, dur: reduceMotion.matches ? 0 : f.dur });
}
function drawFx(layer, now) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i];
    if (f.layer !== layer) continue;
    const el = now - f.t0 - f.delay;
    if (el < 0) continue;
    const p = f.dur > 0 ? clamp01(el / f.dur) : 1;
    FX[f.type](f, p);
    if (p >= 1) fx.splice(i, 1);
  }
}
const FX = {
  // the cue advances to the ball, then fades
  strike(f, p) {
    const hit = 80 / f.dur;
    let back, alpha;
    if (p < hit) { back = R + (0.02 + powerToBar(f.power) * 0.12) * (1 - EASE.in(p / hit)); alpha = 1; }
    else { back = R; alpha = 1 - EASE.out((p - hit) / (1 - hit)); }
    drawCue(f.cue, f.dir, back, alpha);
  },
  ring(f, p) {
    const e = EASE.out(p);
    ctx.strokeStyle = rgba('#FFFFFF', 0.6 * (1 - e));
    ctx.lineWidth = 0.003 - 0.002 * e;
    ctx.beginPath();
    ctx.arc(f.at.x, f.at.y, R + 0.04 * e, 0, Math.PI * 2);
    ctx.stroke();
  },
  // a pocketed ball sinks toward the pocket
  drop(f, p) {
    const e = EASE.spring(p);
    const x = f.from.x + (f.to.x - f.from.x) * 0.35 * e;
    const y = f.from.y + (f.to.y - f.from.y) * 0.35 * e;
    const fadeStart = 1 - 60 / Math.max(f.dur, 60);
    const alpha = p < fadeStart ? 1 : 1 - (p - fadeStart) / (1 - fadeStart);
    if (alpha <= 0) return;
    drawBall(f.id, { x, y }, { scale: 1 - 0.4 * e, alpha });
  },
  rim(f, p) {
    const e = EASE.out(p);
    ctx.strokeStyle = rgba(PAL.flash, 0.5 * (1 - e));
    ctx.lineWidth = 0.006;
    tracePocket(f.pk);
    ctx.stroke();
  },
};

// pocketHole is the dark drop of a pocket as a circle: where the drop
// animation sinks a ball, where the rim flashes and what a pocket call rings.
// A corner pocket is a round hole whose near edge is the shelf (a ball drops
// once its centre is past it, so the felt shows up to 6 mm before); a side
// pocket has no shelf to speak of: straight jaws for 20 mm from the noses,
// then a half circle, see tracePocket.
function pocketHole(pk) {
  if (pk.side) {
    const d = 0.02;
    const r = pk.half + d * Math.tan(SIDE_JAW - Math.PI / 2);
    return { x: pk.x + pk.ax * d, y: pk.y + pk.ay * d, r };
  }
  const r = pk.half;
  const front = Math.max(0, pk.shelf - 0.006);
  return { x: pk.x + pk.ax * (front + r), y: pk.y + pk.ay * (front + r), r };
}
// tracePocket begins a path outlining the hole of pocket pk and returns it.
function tracePocket(pk) {
  const h = pocketHole(pk);
  ctx.beginPath();
  if (!pk.side) {
    ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
    return h;
  }
  const px = -pk.ay, py = pk.ax; // across the mouth
  const a1 = Math.atan2(py, px);
  ctx.moveTo(pk.x + px * pk.half, pk.y + py * pk.half);
  ctx.lineTo(h.x + px * h.r, h.y + py * h.r);
  ctx.arc(h.x, h.y, h.r, a1, a1 - Math.PI, true);
  ctx.lineTo(pk.x - px * pk.half, pk.y - py * pk.half);
  ctx.closePath();
  return h;
}
function nearestPocket(p) {
  let best = null;
  for (const pk of POCKETS) {
    const h = pocketHole(pk);
    const d = Math.hypot(h.x - p.x, h.y - p.y);
    if (!best || d < best.d) best = { d, pk, hole: h };
  }
  return best;
}
// queueDrop schedules the pocket animation of a ball that disappeared
// between two snapshots; it starts when the render clock reaches that snapshot.
function queueDrop(id, from, t) {
  S.pendingDrops.push({ id, from, t });
}
function startDrop(id, from) {
  const { pk, hole } = nearestPocket(from);
  addFx({ type: 'drop', layer: 'balls', dur: 180, id, from, to: hole });
  addFx({ type: 'rim', layer: 'top', dur: 120, pk });
}

// --- geometry helpers -------------------------------------------------------

function resize() {
  const wrap = $('tableWrap');
  const cs = getComputedStyle(wrap);
  const bar = $('powerBar');
  const barW = bar.hidden ? 0 : bar.getBoundingClientRect().width + parseFloat(cs.columnGap || cs.gap || '12') || 0;
  const availW = Math.max(100, wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - barW);
  const availH = Math.max(100, wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
  const fullW = W + 2 * RAIL, fullH = H + 2 * RAIL;
  const sLand = Math.min(availW / fullW, availH / fullH);
  const sPort = Math.min(availW / fullH, availH / fullW);
  // A portrait screen gets the table upright whenever that is not smaller:
  // with a margin, the browser bars growing or shrinking on a phone would
  // flip it back and forth. Elsewhere only rotate when it is clearly better.
  const portrait = window.innerHeight > window.innerWidth;
  view.rotated = portrait ? sPort >= sLand : sPort > sLand * 1.15;
  view.s = view.rotated ? sPort : sLand;
  view.cssW = Math.floor(view.rotated ? fullH * view.s : fullW * view.s);
  view.cssH = Math.floor(view.rotated ? fullW * view.s : fullH * view.s);
  view.ox = RAIL * view.s;
  view.oy = RAIL * view.s;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(view.cssW * dpr);
  canvas.height = Math.round(view.cssH * dpr);
  canvas.style.width = `${view.cssW}px`;
  canvas.style.height = `${view.cssH}px`;
  view.dpr = dpr;
  renderTableCache();
}

// toTable converts a pointer position (CSS px within the canvas) to meters.
function toTable(px, py) {
  if (!view.rotated) return { x: (px - view.ox) / view.s, y: (py - view.oy) / view.s };
  return { x: W - (py - view.oy) / view.s, y: (px - view.ox) / view.s };
}
// toScreen is the inverse: meters to CSS px within the canvas.
function toScreen(p) {
  if (!view.rotated) return { x: view.ox + p.x * view.s, y: view.oy + p.y * view.s };
  return { x: view.ox + p.y * view.s, y: view.oy + (W - p.x) * view.s };
}

// applyTableTransform sets ctx so that drawing happens in meters.
function applyTableTransform() {
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.translate(view.ox, view.oy);
  if (view.rotated) {
    ctx.rotate(-Math.PI / 2);
    ctx.translate(-W * view.s, 0);
  }
  ctx.scale(view.s, view.s);
}

// displayBalls returns the positions to draw this frame.
function displayBalls() {
  if (S.snaps.length === 0) {
    const held = S.drag || S.placedAt;
    if (held) {
      const m = new Map(S.balls);
      m.set(held.id, { x: held.x, y: held.y });
      return m;
    }
    return S.balls;
  }
  const t = renderClock();
  const snaps = S.snaps;
  if (t <= snaps[0].t) return snaps[0].balls;
  let i = snaps.length - 1;
  while (i > 0 && snaps[i].t > t) i--;
  if (i >= snaps.length - 1) return snaps[snaps.length - 1].balls;
  const a = snaps[i], b = snaps[i + 1];
  const f = (t - a.t) / Math.max(1, b.t - a.t);
  const out = new Map();
  for (const [id, pa] of a.balls) {
    const pb = b.balls.get(id);
    out.set(id, pb ? { x: pa.x + (pb.x - pa.x) * f, y: pa.y + (pb.y - pa.y) * f } : pa);
  }
  return out;
}
function renderClock() { return performance.now() - S.shotWall0 - RENDER_DELAY_MS; }

// --- the frame --------------------------------------------------------------

function draw() {
  requestAnimationFrame(draw);
  if (!view.cssW) return;
  const now = performance.now();

  // pending pocket drops whose snapshot time has been reached
  if (S.pendingDrops.length) {
    const t = renderClock();
    while (S.pendingDrops.length && S.pendingDrops[0].t <= t) {
      const d = S.pendingDrops.shift();
      startDrop(d.id, d.from);
    }
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (tableCache) ctx.drawImage(tableCache, 0, 0);
  applyTableTransform();

  const balls = displayBalls();
  const myShot = isMyShot();
  const cue = balls.get(0);
  const placingInKitchen = myShot && S.ballInHand && S.kitchen;
  if (placingInKitchen) drawKitchenWash();

  // aim guide goes under the balls
  const striking = fx.some((f) => f.type === 'strike');
  let aim = null; // {angle, power, mine, alpha}
  if (cue && myShot && !S.drag) {
    const a = S.aimShownAt ? EASE.out(clamp01((now - S.aimShownAt) / 200)) : 1;
    aim = { angle: S.angle, power: S.power, mine: true, alpha: reduceMotion.matches ? 1 : a };
  } else if (cue && S.oppAim && inPlay() && !S.moving && S.turn !== S.seat) {
    aim = { angle: oppAimAngle(now), power: S.oppAim.power, mine: false, alpha: 1 };
  }
  const cast = aim ? drawAim(balls, cue, aim.angle, aim.mine, aim.alpha) : null;

  // shadows, then bodies
  const lifted = S.drag ? S.drag.id : -1;
  const lift = S.drag ? liftAmount(now) : 0;
  for (const [id, p] of balls) rollBall(id, p);
  for (const [id, p] of balls) drawBallShadow(p, id === lifted ? lift : 0);
  for (const [id, p] of balls) drawBall(id, p, id === lifted && lift ? { scale: 1 + 0.05 * lift } : undefined);
  drawFx('balls', now);

  // cue stick above the balls
  if (aim && !striking) {
    const dir = { x: Math.cos(aim.angle), y: Math.sin(aim.angle) };
    drawCue(cue, dir, R + 0.02 + powerToBar(aim.power) * 0.12, aim.mine ? aim.alpha : 0.4 * aim.alpha);
  }
  drawFx('cue', now);

  // rings
  if (myShot && canCall()) {
    for (const id of legalTargets()) {
      const p = balls.get(id);
      if (p) ring(p, R + 0.010, rgba('#FFFFFF', 0.55), 0.003);
    }
  }
  if (myShot && needsPocket()) {
    // the pockets are tappable; the called one is ringed in brass
    for (let n = 0; n < POCKETS.length; n++) {
      const called = S.call && S.call.pocket === n;
      if (called) {
        ctx.strokeStyle = rgba(PAL.brass, 0.22);
        ctx.lineWidth = 0.016;
        tracePocket(POCKETS[n]);
        ctx.stroke();
      }
      ctx.strokeStyle = called ? PAL.brass : rgba('#FFFFFF', 0.45);
      ctx.lineWidth = called ? 0.006 : 0.003;
      tracePocket(POCKETS[n]);
      ctx.stroke();
    }
  }
  if (S.drag && balls.has(S.drag.id)) ring(balls.get(S.drag.id), 1.05 * R + 0.014, '#FFFFFF', 0.005);
  else if (myShot && S.ballInHand && cue) ring(cue, R + 0.014, PAL.ok, 0.004);

  if (S.hoverUntil && now > S.hoverUntil) { S.hoverBall = null; S.hoverUntil = 0; }
  // Where the numbers on the balls are too small to read (phones), the ball
  // my aim hits first is named, so a cut is never played on the wrong ball.
  const target = cast && aim.mine && !S.drag && cast.hit;
  if (target && target !== S.hoverBall && 2 * R * view.s < 16 && balls.has(target)) {
    const a = toScreen(cue), b = toScreen({ x: cue.x + Math.cos(S.angle), y: cue.y + Math.sin(S.angle) });
    drawBallLabel(target, balls.get(target), { x: b.x - a.x, y: b.y - a.y });
  }
  if (S.hoverBall !== null && balls.has(S.hoverBall)) drawBallLabel(S.hoverBall, balls.get(S.hoverBall));
  drawFx('top', now);
}

// liftAmount eases the carried ball up over 120 ms.
function liftAmount(now) {
  if (reduceMotion.matches) return 1;
  return EASE.out(clamp01((now - S.liftStart) / 120));
}

// oppAimAngle eases the opponent's aim toward its latest value over 100 ms.
function oppAimAngle(now) {
  const cur = S.oppAim.angle;
  if (!S.oppAimPrev || reduceMotion.matches) return cur;
  const p = clamp01((now - S.oppAimAt) / 100);
  if (p >= 1) return cur;
  let d = cur - S.oppAimPrev.angle;
  d = Math.atan2(Math.sin(d), Math.cos(d)); // shortest arc
  return S.oppAimPrev.angle + d * EASE.out(p);
}

// --- static table -----------------------------------------------------------

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// renderTableCache draws the rails, felt, pockets, cushions, sights and
// markings once at the current size.
function renderTableCache() {
  if (!view.cssW) return;
  const off = document.createElement('canvas');
  off.width = canvas.width;
  off.height = canvas.height;
  const live = ctx;
  ctx = off.getContext('2d');
  applyTableTransform();
  drawTableStatic();
  ctx = live;
  tableCache = off;
}

function drawTableStatic() {
  // rail
  const railG = ctx.createLinearGradient(0, -RAIL, 0, H + RAIL);
  railG.addColorStop(0, PAL.railTop);
  railG.addColorStop(0.5, PAL.rail);
  railG.addColorStop(1, PAL.railBottom);
  roundRect(-RAIL, -RAIL, W + 2 * RAIL, H + 2 * RAIL, 0.06);
  ctx.fillStyle = railG;
  ctx.fill();
  ctx.strokeStyle = rgba('#000000', 0.55);
  ctx.lineWidth = 0.003;
  ctx.stroke();
  // felt, running under the cushions and into the pocket mouths
  const feltG = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, 1.48);
  feltG.addColorStop(0, PAL.feltCenter);
  feltG.addColorStop(0.55, PAL.felt);
  feltG.addColorStop(1, PAL.feltEdge);
  ctx.fillStyle = feltG;
  ctx.fillRect(-CUSHION, -CUSHION, W + 2 * CUSHION, H + 2 * CUSHION);
  // pocket holes
  for (const pk of POCKETS) {
    const h = tracePocket(pk);
    const g = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, h.r);
    g.addColorStop(0, '#000000');
    g.addColorStop(0.78, '#06080A');
    g.addColorStop(1, '#1C1610');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = rgba('#000000', 0.6);
    ctx.lineWidth = 0.004;
    ctx.stroke();
  }
  // cushions with their jaws, then the nose line
  ctx.fillStyle = PAL.cushion;
  for (const c of TABLE.cushions) {
    const lf = CUSHION / Math.abs(c.jawFrom.x * c.inward.x + c.jawFrom.y * c.inward.y);
    const lt = CUSHION / Math.abs(c.jawTo.x * c.inward.x + c.jawTo.y * c.inward.y);
    ctx.beginPath();
    ctx.moveTo(c.from.x, c.from.y);
    ctx.lineTo(c.to.x, c.to.y);
    ctx.lineTo(c.to.x + c.jawTo.x * lt, c.to.y + c.jawTo.y * lt);
    ctx.lineTo(c.from.x + c.jawFrom.x * lf, c.from.y + c.jawFrom.y * lf);
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = rgba('#FFFFFF', 0.10);
  ctx.lineWidth = 0.0025;
  for (const c of TABLE.cushions) {
    ctx.beginPath();
    ctx.moveTo(c.from.x, c.from.y);
    ctx.lineTo(c.to.x, c.to.y);
    ctx.stroke();
  }
  // inner lip of the rail
  roundRect(-0.052, -0.052, W + 0.104, H + 0.104, 0.01);
  ctx.strokeStyle = rgba(PAL.railLip, 0.12);
  ctx.lineWidth = 0.003;
  ctx.stroke();
  // sights
  ctx.fillStyle = rgba(PAL.sight, 0.9);
  const sight = (x, y, alongX) => {
    const a = alongX ? 0.011 : 0.007, b = alongX ? 0.007 : 0.011;
    ctx.beginPath();
    ctx.moveTo(x - a, y);
    ctx.lineTo(x, y - b);
    ctx.lineTo(x + a, y);
    ctx.lineTo(x, y + b);
    ctx.closePath();
    ctx.fill();
  };
  for (const i of [1, 2, 3, 5, 6, 7]) { sight(W / 8 * i, -0.0725, true); sight(W / 8 * i, H + 0.0725, true); }
  for (const i of [1, 2, 3]) { sight(-0.0725, H / 4 * i, false); sight(W + 0.0725, H / 4 * i, false); }
  // head string and spots
  ctx.strokeStyle = rgba('#FFFFFF', 0.14);
  ctx.lineWidth = 0.002;
  ctx.beginPath();
  ctx.moveTo(HEAD, 0);
  ctx.lineTo(HEAD, H);
  ctx.stroke();
  ctx.fillStyle = rgba('#FFFFFF', 0.35);
  for (const p of [{ x: HEAD, y: H / 2 }, FOOT]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 0.004, 0, Math.PI * 2);
    ctx.fill();
  }
}

// drawKitchenWash marks the kitchen while the cue ball must be placed there.
function drawKitchenWash() {
  ctx.fillStyle = rgba('#FFFFFF', 0.06);
  ctx.fillRect(0, 0, HEAD, H);
  ctx.strokeStyle = rgba(PAL.ok, 0.75);
  ctx.lineWidth = 0.003;
  ctx.setLineDash([0.016, 0.010]);
  ctx.beginPath();
  ctx.moveTo(HEAD, 0);
  ctx.lineTo(HEAD, H);
  ctx.stroke();
  ctx.setLineDash([]);
}

// --- balls ------------------------------------------------------------------

function ring(p, r, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.stroke();
}

// drawBallShadow: the contact shadow, offset toward the screen's bottom-right.
// --- rolling balls ----------------------------------------------------------
// Each ball carries a rotation matrix (table ← ball, row-major, its columns
// are the ball's own axes) in a right-handed table frame: x right, y down, z
// into the slate, so the viewer sees the z < 0 hemisphere. Rolling over Δp
// without slipping turns the ball by |Δp| / R about the horizontal axis
// (Δy, −Δx) / |Δp|. The markings (stripe band, number discs, the cue ball's
// six dots) are rasterised from that orientation into a small cached canvas;
// the numbers are drawn on whichever disc faces up, foreshortened.
const orient = new Map();   // id → Float64Array(9)
const lastPos = new Map();  // id → {x, y} seen last frame
const texCache = new Map(); // id → {canvas, n, dirty}
const BALL_RGB = Object.fromEntries(Object.entries(BALL_COLORS).map(([k, v]) => [k, hexToRgb(v)]));
const IVORY_RGB = hexToRgb(PAL.ivory), DISC_RGB = hexToRgb(PAL.disc), DOT_RGB = hexToRgb('#B4322A');
function hexToRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }

// restingOrientation lays a freshly racked ball like the mock-ups: a number
// facing up, the stripe band horizontal on screen.
function restingOrientation(id) {
  if (id <= 8) {
    // disc at the ball's −z faces the viewer; its "up" (−y) points up the
    // screen, which in the rotated view is table +x
    return view.rotated ? Float64Array.of(0, -1, 0, 1, 0, 0, 0, 0, 1) : Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
  }
  // discs at ±x (one faces the viewer), band around z, up is −z
  return view.rotated ? Float64Array.of(0, 0, -1, 0, -1, 0, -1, 0, 0) : Float64Array.of(0, -1, 0, 0, 0, 1, -1, 0, 0);
}
function orientationOf(id) {
  let m = orient.get(id);
  if (!m) { m = restingOrientation(id); orient.set(id, m); }
  return m;
}
// rollBall advances the ball's orientation by its movement since last frame.
function rollBall(id, p) {
  const last = lastPos.get(id);
  lastPos.set(id, { x: p.x, y: p.y });
  if (!last || (S.drag && S.drag.id === id)) return;
  const dx = p.x - last.x, dy = p.y - last.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6 || d > 0.3) return; // still, or moved by hand / respotted
  const m = orientationOf(id);
  const ax = dy / d, ay = -dx / d; // axis (horizontal)
  const th = d / R, c = Math.cos(th), sn = Math.sin(th), t = 1 - c;
  // Rodrigues with az = 0
  const r00 = c + ax * ax * t, r01 = ax * ay * t, r02 = ay * sn;
  const r10 = ax * ay * t, r11 = c + ay * ay * t, r12 = -ax * sn;
  const r20 = -ay * sn, r21 = ax * sn, r22 = c;
  const o = Float64Array.from(m);
  for (let j = 0; j < 3; j++) {
    const a = o[j], b = o[3 + j], e = o[6 + j];
    m[j] = r00 * a + r01 * b + r02 * e;
    m[3 + j] = r10 * a + r11 * b + r12 * e;
    m[6 + j] = r20 * a + r21 * b + r22 * e;
  }
  const tex = texCache.get(id);
  if (tex) tex.dirty = true;
}
function resetOrientations() { orient.clear(); lastPos.clear(); texCache.clear(); }

// ballTexture returns the ball's markings for its current orientation as an
// n × n canvas (n device pixels across the ball), rasterised at 2× when small.
function ballTexture(id, n) {
  let tex = texCache.get(id);
  if (tex && !tex.dirty && tex.n === n) return tex.canvas;
  if (!tex) { tex = { canvas: document.createElement('canvas'), n: 0, dirty: true }; texCache.set(id, tex); }
  const ss = n < 64 ? 2 : 1;
  const N = n * ss;
  tex.canvas.width = tex.canvas.height = N;
  tex.n = n;
  tex.dirty = false;
  const m = orientationOf(id);
  const img = tex.canvas.getContext('2d').createImageData(N, N);
  const px = img.data;
  const base = id === 0 ? IVORY_RGB : id > 8 ? IVORY_RGB : BALL_RGB[id];
  const band = id > 8 ? BALL_RGB[id - 8] : null;
  const cosDisc = 0.877, cosDot = 0.985; // disc r 0.48 R, dot r 0.17 R
  for (let j = 0; j < N; j++) {
    const ny = ((j + 0.5) / N) * 2 - 1;
    for (let i = 0; i < N; i++) {
      const nx = ((i + 0.5) / N) * 2 - 1;
      const rr = nx * nx + ny * ny;
      const k = (j * N + i) * 4;
      if (rr > 1) { px[k + 3] = 0; continue; }
      const nz = -Math.sqrt(1 - rr);
      // ball-local coordinates: dot with each column
      const lx = nx * m[0] + ny * m[3] + nz * m[6];
      const ly = nx * m[1] + ny * m[4] + nz * m[7];
      const lz = nx * m[2] + ny * m[5] + nz * m[8];
      let col = base;
      if (id === 0) {
        if (Math.abs(lx) > cosDot || Math.abs(ly) > cosDot || Math.abs(lz) > cosDot) col = DOT_RGB;
      } else if (band) {
        if (Math.abs(lz) <= 0.58) col = band;
        if (Math.abs(lx) > cosDisc) col = DISC_RGB;
      } else if (Math.abs(lz) > cosDisc) {
        col = DISC_RGB;
      }
      px[k] = col[0]; px[k + 1] = col[1]; px[k + 2] = col[2]; px[k + 3] = 255;
    }
  }
  tex.canvas.getContext('2d').putImageData(img, 0, 0);
  return tex.canvas;
}

// drawBallNumbers writes the number on each disc that faces the viewer, in
// the table frame (the context is translated to the ball's centre).
function drawBallNumbers(id) {
  const m = orientationOf(id);
  const stripe = id > 8;
  const discs = stripe ? [[1, 0, 0], [-1, 0, 0]] : [[0, 0, 1], [0, 0, -1]];
  const up = stripe ? [0, 0, -1] : [0, -1, 0];
  const world = (l) => [m[0] * l[0] + m[1] * l[1] + m[2] * l[2], m[3] * l[0] + m[4] * l[1] + m[5] * l[2], m[6] * l[0] + m[7] * l[1] + m[8] * l[2]];
  const u = world(up);
  ctx.fillStyle = PAL.ink;
  ctx.font = `700 ${R * 0.62}px "Source Sans 3", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (const dl of discs) {
    const d = world(dl);
    const f = -d[2]; // foreshortening: 1 facing the viewer, 0 edge on
    if (f < 0.35) continue;
    const phi = Math.atan2(d[1], d[0]);
    const c = Math.cos(phi), sn = Math.sin(phi);
    // the disc's up vector, with the foreshortening along the tilt undone
    const ux = (u[0] * c + u[1] * sn) / f, uy = -u[0] * sn + u[1] * c;
    ctx.save();
    ctx.translate(d[0] * R, d[1] * R);
    ctx.rotate(phi);
    ctx.scale(f, 1);
    ctx.rotate(Math.atan2(uy, ux) + Math.PI / 2);
    ctx.fillText(String(id), 0, R * 0.22);
    ctx.restore();
  }
}

function drawBallShadow(p, lift) {
  const k = 1 + 0.8 * lift;
  const o = screenOffset(0.006 * k, 0.009 * k);
  const r = R * 1.08 * (1 + 0.05 * lift);
  const g = ctx.createRadialGradient(p.x + o.x, p.y + o.y, 0, p.x + o.x, p.y + o.y, r);
  g.addColorStop(0, rgba('#000000', 0.5));
  g.addColorStop(0.7, rgba('#000000', 0.25));
  g.addColorStop(1, rgba('#000000', 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(p.x + o.x, p.y + o.y, r, 0, Math.PI * 2);
  ctx.fill();
}

// drawBall draws one ball: its markings in the table frame, as the ball
// has rolled, then the lighting in a screen-aligned frame so it reads the
// same way whether or not the table is rotated.
function drawBall(id, p, opts) {
  const scale = opts && opts.scale ? opts.scale : 1;
  const alpha = opts && opts.alpha !== undefined ? opts.alpha : 1;
  const colour = id === 0 ? PAL.ivory : BALL_COLORS[id > 8 ? id - 8 : id];
  const diamPx = 2 * R * view.s * scale;
  ctx.save();
  ctx.translate(p.x, p.y);
  if (scale !== 1) ctx.scale(scale, scale);
  ctx.globalAlpha = alpha;
  // body: a plain fill under the markings so the raster's edge never shows
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fillStyle = id > 8 ? PAL.ivory : colour;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.drawImage(ballTexture(id, Math.max(8, Math.ceil(diamPx * view.dpr))), -R, -R, 2 * R, 2 * R);
  ctx.restore();
  if (id !== 0 && diamPx >= 15) drawBallNumbers(id);
  if (view.rotated) ctx.rotate(Math.PI / 2);
  // shade
  const g = ctx.createRadialGradient(-0.24 * R, -0.32 * R, 0, -0.24 * R, -0.32 * R, 1.56 * R);
  g.addColorStop(0, rgba('#FFFFFF', 0.5));
  g.addColorStop(0.3, rgba('#FFFFFF', 0.1));
  g.addColorStop(0.72, rgba('#000000', 0));
  g.addColorStop(1, rgba('#000000', 0.4));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fill();
  // specular
  if (diamPx >= 9) {
    ctx.fillStyle = rgba('#FFFFFF', 0.7);
    ctx.beginPath();
    ctx.ellipse(-0.38 * R, -0.42 * R, 0.2 * R, 0.14 * R, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // edge
  ctx.strokeStyle = rgba('#000000', 0.35);
  ctx.lineWidth = 0.0015;
  ctx.beginPath();
  ctx.arc(0, 0, R - 0.00075, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// drawBallLabel names the ball under the pointer, in screen pixels so it
// stays readable at any table size.
// A swatch of the ball's colour leads the text (a stripe is a band on
// white), so the label reads even before the number does. aim (the screen
// direction of the shot) makes it the smaller tag of the ball the aim hits,
// set beside that ball across the line of the shot, toward the open table,
// so it hides neither the aim nor the balls beyond.
function drawBallLabel(id, p, aim) {
  const quiet = !!aim;
  const text = id === 0 ? 'cue ball' : isNine() ? (id === 9 ? '9-ball' : String(id)) : id === 8 ? '8-ball' : `${id} · ${groupOf(id)}`;
  const sp = toScreen(p);
  ctx.save();
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  if (quiet) ctx.globalAlpha = 0.88;
  ctx.font = `600 ${quiet ? 12 : 14}px "Source Sans 3", system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const sw = quiet ? 5 : 6; // swatch radius
  const tw = ctx.measureText(text).width;
  const w = tw + sw * 2 + (quiet ? 18 : 24);
  const h = quiet ? 22 : 28;
  let x = sp.x, y = sp.y - R * view.s - h / 2 - 10;
  if (aim) {
    if (Math.abs(aim.y) >= Math.abs(aim.x)) { x = sp.x + (sp.x > view.cssW / 2 ? -1 : 1) * (R * view.s + w / 2 + 6); y = sp.y; }
    else { x = sp.x; y = sp.y + (sp.y > view.cssH / 2 ? -1 : 1) * (R * view.s + h / 2 + 6); }
  }
  const cx = Math.max(w / 2 + 4, Math.min(view.cssW - w / 2 - 4, x));
  const cy = Math.max(h / 2 + 2, Math.min(view.cssH - h / 2 - 2, y));
  roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
  ctx.fillStyle = rgba(PAL.labelBg, 0.92);
  ctx.fill();
  ctx.strokeStyle = rgba(PAL.labelStroke, 0.22);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const sx = cx - w / 2 + (quiet ? 9 : 12) + sw;
  const color = id === 0 ? '#F4EFE2' : BALL_COLORS[id > 8 ? id - 8 : id];
  ctx.beginPath();
  ctx.arc(sx, cy, sw, 0, Math.PI * 2);
  ctx.fillStyle = id > 8 ? '#F4EFE2' : color;
  ctx.fill();
  if (id > 8) {
    ctx.save();
    ctx.clip();
    ctx.fillStyle = color;
    ctx.fillRect(sx - sw, cy - sw * 0.55, sw * 2, sw * 1.1);
    ctx.restore();
  }
  ctx.fillStyle = PAL.labelText;
  ctx.fillText(text, sx + sw + (quiet ? 5 : 7), cy + 1);
  ctx.restore();
  applyTableTransform();
}

// --- cue and guide ----------------------------------------------------------

const CUE_SEGMENTS = [
  [0, 0.010, '#2F5F8A'], [0.010, 0.030, '#F2EEE3'], [0.030, 0.720, ['#EEE1C4', '#C9A56C']],
  [0.720, 0.735, '#D8C59C'], [0.735, 0.900, '#6B4325'], [0.900, 1.130, '#1C1916'], [1.130, 1.200, '#2A1A0F'],
];
const CUE_LEN = 1.2;
const cueWidth = (t) => 0.012 + (0.028 - 0.012) * (t / CUE_LEN);

// drawCue draws the stick with its tip `back` metres behind the cue ball's
// centre, pointing along dir.
function drawCue(cue, dir, back, alpha) {
  if (alpha <= 0) return;
  const u = { x: -dir.x, y: -dir.y }; // tip → butt
  const n = { x: -u.y, y: u.x };
  const tip = { x: cue.x + u.x * back, y: cue.y + u.y * back };
  const at = (t, side) => ({ x: tip.x + u.x * t + n.x * side * cueWidth(t) / 2, y: tip.y + u.y * t + n.y * side * cueWidth(t) / 2 });
  const outline = () => {
    ctx.beginPath();
    const a0 = at(0, 1), a1 = at(CUE_LEN, 1), b1 = at(CUE_LEN, -1), b0 = at(0, -1);
    ctx.moveTo(a0.x, a0.y); ctx.lineTo(a1.x, a1.y); ctx.lineTo(b1.x, b1.y); ctx.lineTo(b0.x, b0.y);
    ctx.closePath();
  };
  ctx.save();
  ctx.globalAlpha = alpha;
  // shadow
  const o = screenOffset(0.010, 0.014);
  ctx.translate(o.x, o.y);
  outline();
  ctx.fillStyle = rgba('#000000', 0.28);
  ctx.fill();
  ctx.translate(-o.x, -o.y);
  // segments as tapered quads
  for (const [a, b, colour] of CUE_SEGMENTS) {
    const a0 = at(a, 1), a1 = at(b, 1), b1 = at(b, -1), b0 = at(a, -1);
    ctx.beginPath();
    ctx.moveTo(a0.x, a0.y); ctx.lineTo(a1.x, a1.y); ctx.lineTo(b1.x, b1.y); ctx.lineTo(b0.x, b0.y);
    ctx.closePath();
    if (Array.isArray(colour)) {
      const g = ctx.createLinearGradient(tip.x + u.x * a, tip.y + u.y * a, tip.x + u.x * b, tip.y + u.y * b);
      g.addColorStop(0, colour[0]);
      g.addColorStop(1, colour[1]);
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = colour;
    }
    ctx.fill();
  }
  // centre highlight
  ctx.strokeStyle = rgba('#FFFFFF', 0.16);
  ctx.lineWidth = 0.002;
  ctx.beginPath();
  ctx.moveTo(tip.x + u.x * 0.03, tip.y + u.y * 0.03);
  ctx.lineTo(tip.x + u.x * 1.12, tip.y + u.y * 1.12);
  ctx.stroke();
  ctx.restore();
}

// drawAim draws the guide: path to the ghost ball, the ghost ball, the
// object ball's direction and the cue ball's deflection. It returns the cast
// (castAim), whose hit names the ball the aim strikes first.
function drawAim(balls, cue, angle, mine, alpha) {
  const cast = castAim(balls, cue, angle);
  const d = cast.dir;
  const line = mine ? '#FFFFFF' : PAL.oppAim;
  const brass = mine ? PAL.brassLine : PAL.oppAim;
  ctx.save();
  ctx.globalAlpha = (mine ? 1 : 0.5) * alpha;
  ctx.lineCap = 'round';
  // path from the cue-ball edge to the ghost edge
  ctx.strokeStyle = rgba(line, 0.78);
  ctx.lineWidth = 0.003;
  ctx.setLineDash([0.020, 0.014]);
  ctx.beginPath();
  ctx.moveTo(cue.x + d.x * R, cue.y + d.y * R);
  ctx.lineTo(cast.ghost.x - d.x * R, cast.ghost.y - d.y * R);
  ctx.stroke();
  ctx.setLineDash([]);
  // ghost ball
  ctx.beginPath();
  ctx.arc(cast.ghost.x, cast.ghost.y, R, 0, Math.PI * 2);
  ctx.fillStyle = rgba(line, 0.06);
  ctx.fill();
  ctx.stroke();
  // After contact: the object ball's path and the cue ball's deflection,
  // as long as the server's aimLine (the deflection half of it).
  const reach = S.aimLine;
  if (cast.objDir && reach > 0) {
    const b = balls.get(cast.hit);
    const od = cast.objDir;
    const x0 = b.x + od.x * R, y0 = b.y + od.y * R;
    const x1 = x0 + od.x * reach, y1 = y0 + od.y * reach;
    ctx.strokeStyle = rgba(brass, 0.95);
    ctx.lineWidth = 0.004;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    // chevron 18 × 24 at the end, smaller on a very short line
    const nx = -od.y, ny = od.x;
    const cl = Math.min(0.024, reach * 0.4), cw = cl * 0.375;
    ctx.beginPath();
    ctx.moveTo(x1 - od.x * cl + nx * cw, y1 - od.y * cl + ny * cw);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x1 - od.x * cl - nx * cw, y1 - od.y * cl - ny * cw);
    ctx.stroke();
    // Where the cue ball goes next: the tangent line for a stun shot, bent
    // forward by top spin or back by draw (only a tendency: how much roll is
    // left at contact depends on speed and distance). The opponent's spin is
    // not relayed, so their preview shows the stun line.
    const f = mine ? S.spin.y : 0;
    let cd = cast.cueDir;
    if (cd && f) {
      cd = { x: cd.x + 0.8 * f * d.x, y: cd.y + 0.8 * f * d.y };
      const l = Math.hypot(cd.x, cd.y) || 1;
      cd = { x: cd.x / l, y: cd.y / l };
    } else if (!cd && Math.abs(f) > 0.05) {
      cd = { x: d.x * Math.sign(f), y: d.y * Math.sign(f) }; // full hit: follow or draw straight
    }
    if (cd) {
      const len = (cast.cueDir ? 0.5 : 0.2 + 0.3 * Math.abs(f)) * reach;
      ctx.strokeStyle = rgba(line, 0.5);
      ctx.lineWidth = 0.003;
      ctx.setLineDash([0.010, 0.010]);
      ctx.beginPath();
      ctx.moveTo(cast.ghost.x + cd.x * R, cast.ghost.y + cd.y * R);
      ctx.lineTo(cast.ghost.x + cd.x * (R + len), cast.ghost.y + cd.y * (R + len));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
  return cast;
}

// ---------------------------------------------------------------------------
// 4b. sound
//
// Recorded sounds (web/sounds, CC0 recordings from Freesound, see
// docs/CLIENT.md) for ball on ball, the cue and a pocket; a synthesized
// thump for a cushion. A real clack is a click of a few milliseconds, not a
// ringing tone: the contact lasts about 0.2 ms. Each contact picks one of
// several takes, a few percent off pitch, and a soft one is duller as well
// as quieter. The server sends each contact of a shot with its time and
// closing speed (snapshot.impacts); it is played when the render clock
// reaches it, so the sound lands on the frame that shows it. Until the
// recordings have loaded, a short synthesized stand-in plays.

const SND = {
  ctx: null,
  master: null,
  noise: null,
  on: readSetting('pool:sound') !== 'off',
  volume: Math.min(1, Math.max(0, Number(readSetting('pool:volume') ?? 0.8))),
  played: 0,     // sounds scheduled so far, for tests
  ownStrike: 0,  // when we last played our own cue strike
  takes: { clack: [], cue: [], pocket: [] }, // decoded recordings, filled once loaded
  last: {},      // the take each kind played last, not to repeat it
};

const SOUND_TAKES = { clack: 7, cue: 4, pocket: 1 };

// loadTakes fetches and decodes the recordings; a failure leaves the
// synthesized sounds in place.
function loadTakes(ctx) {
  for (const [kind, n] of Object.entries(SOUND_TAKES)) {
    for (let i = 1; i <= n; i++) {
      fetch(`/sounds/${kind}-${i}.wav`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
        .then((data) => ctx.decodeAudioData(data))
        .then((buf) => { SND.takes[kind].push(buf); })
        .catch(() => { /* keep the synthesized stand-in */ });
    }
  }
}

// playTake plays a recording of kind at time at, or reports false if none
// has loaded. gain 0..1; bright 0..1 opens the low-pass (a soft contact is
// duller); pitch shifts all takes.
function playTake(ctx, kind, at, gain, bright = 1, pitch = 1) {
  const takes = SND.takes[kind];
  if (!takes.length) return false;
  let i = Math.floor(Math.random() * takes.length);
  if (takes.length > 1 && i === SND.last[kind]) i = (i + 1) % takes.length;
  SND.last[kind] = i;
  const src = ctx.createBufferSource();
  src.buffer = takes[i];
  src.playbackRate.value = pitch * (0.97 + 0.06 * Math.random());
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1800 + 16000 * bright * bright;
  lp.Q.value = 0.5;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(lp).connect(g).connect(SND.master);
  src.start(at);
  return true;
}

// audio returns the running AudioContext, creating it on first use, or
// null when sound is off or unsupported. Browsers only let it start from a
// user gesture, hence the listeners below.
function audio() {
  if (!SND.on) return null;
  if (!SND.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    SND.master = ctx.createGain();
    SND.master.gain.value = SND.volume;
    // a gentle limiter: the clacks of a break pile up
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -12;
    limit.ratio.value = 8;
    SND.master.connect(limit).connect(ctx.destination);
    SND.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = SND.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    SND.ctx = ctx;
    loadTakes(ctx);
  }
  if (SND.ctx.state === 'suspended') SND.ctx.resume();
  return SND.ctx;
}
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => { audio(); }, { passive: true });

// tone is one decaying sine partial.
function tone(ctx, at, freq, gain, decay) {
  const o = ctx.createOscillator();
  o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, at);
  g.gain.exponentialRampToValueAtTime(1e-4, at + decay);
  o.connect(g).connect(SND.master);
  o.start(at);
  o.stop(at + decay + 0.02);
}

// burst is a filtered puff of noise: the contact transient.
function burst(ctx, at, type, freq, q, gain, decay) {
  const src = ctx.createBufferSource();
  src.buffer = SND.noise;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, at);
  g.gain.exponentialRampToValueAtTime(1e-4, at + decay);
  src.connect(f).connect(g).connect(SND.master);
  src.start(at, Math.random() * 0.8);
  src.stop(at + decay + 0.02);
}

// loudness maps a closing speed to a gain: a soft kiss is faint, a break
// shot near full, with a cube-root-ish curve like the ear's.
const loudness = (v, full) => Math.min(1, Math.pow(v / full, 0.6));

// Phenolic balls: a click of a few milliseconds, its energy around 2-3 kHz.
function clack(ctx, at, v) {
  const g = loudness(v, 4);
  if (playTake(ctx, 'clack', at, 0.9 * g, 0.25 + 0.75 * g)) return;
  burst(ctx, at, 'bandpass', 2800, 0.7, 0.9 * g, 0.006);
  tone(ctx, at, 2600 * (0.97 + 0.06 * Math.random()), 0.25 * g, 0.008);
}

// Rubber cushion behind cloth: a dull thump, a hint of the wooden rail.
function thump(ctx, at, v) {
  const g = loudness(v, 3);
  burst(ctx, at, 'lowpass', 520, 0.7, 0.9 * g, 0.07);
  tone(ctx, at, 130 + 20 * Math.random(), 0.6 * g, 0.09);
  tone(ctx, at, 950, 0.06 * g, 0.02);
}

// Into a pocket: a knock on the jaw, a low leather thud, a short rattle.
function drop(ctx, at, v) {
  const g = 0.35 + 0.65 * loudness(v, 3);
  if (playTake(ctx, 'pocket', at, 0.8 * g, 0.5 + 0.5 * g)) return;
  tone(ctx, at, 1900, 0.18 * g, 0.03);
  burst(ctx, at, 'lowpass', 1100, 0.8, 0.5 * g, 0.05);
  tone(ctx, at + 0.03, 170, 0.55 * g, 0.12);
  tone(ctx, at + 0.04, 92, 0.6 * g, 0.2);
  tone(ctx, at + 0.09, 2100, 0.08 * g, 0.02);
  tone(ctx, at + 0.15, 1800, 0.05 * g, 0.02);
}

// The tip on the cue ball: a woody tock, sharper for a hard stroke.
function tock(ctx, at, power) {
  const p = Math.max(0, Math.min(1, power));
  const g = 0.25 + 0.6 * Math.sqrt(p);
  if (playTake(ctx, 'cue', at, 0.9 * g, 0.45 + 0.55 * p, 0.98 + 0.05 * p)) return;
  tone(ctx, at, 1150, 0.35 * g, 0.025);
  tone(ctx, at, 520, 0.4 * g, 0.045);
  burst(ctx, at, 'bandpass', 2200, 0.9, 0.5 * g, 0.012);
}

// playStrike sounds the cue now, or delay ms from now.
function playStrike(power, delay = 0) {
  const ctx = audio();
  if (!ctx) return;
  tock(ctx, ctx.currentTime + delay / 1000, power);
  SND.played++;
}

// playImpacts schedules a shot's contacts at the moment the animation shows
// them; one that is already well past is skipped rather than played late.
function playImpacts(list) {
  const ctx = audio();
  if (!ctx || !list || !list.length) return;
  const now = performance.now();
  let n = 0;
  for (const im of list) {
    const due = S.shotWall0 + im.t + RENDER_DELAY_MS - now;
    if (due < -120) continue;
    if (++n > 48) break; // a break's first instants: enough is enough
    const at = ctx.currentTime + Math.max(0, due) / 1000;
    if (im.k === 'ball') clack(ctx, at, im.v);
    else if (im.k === 'rail') thump(ctx, at, im.v);
    else if (im.k === 'pocket') drop(ctx, at, im.v);
    SND.played++;
  }
}

function setSound(on) {
  SND.on = on;
  writeSetting('pool:sound', on ? null : 'off');
  if (!on && SND.ctx) SND.ctx.suspend();
  if (on) playStrike(0.4);
}

function setVolume(v) {
  SND.volume = v;
  writeSetting('pool:volume', String(v));
  if (SND.master) SND.master.gain.value = v;
}

// ---------------------------------------------------------------------------
// 5. input

function pointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  return toTable(e.clientX - rect.left, e.clientY - rect.top);
}

function hitBall(p, balls, skipCue, reach = R * 1.8) {
  let best = null;
  for (const [id, b] of balls) {
    if (skipCue && id === 0) continue;
    const d = Math.hypot(b.x - p.x, b.y - p.y);
    if (d < reach && (!best || d < best.d)) best = { id, d };
  }
  return best ? best.id : null;
}

// clampBall keeps a carried ball on the table, and the cue ball in the
// kitchen while ball in hand is limited to it (not in practice).
function clampBall(id, p) {
  const maxX = id === 0 && S.kitchen && !S.practice ? HEAD : W - R;
  return {
    x: Math.min(maxX, Math.max(R, p.x)),
    y: Math.min(H - R, Math.max(R, p.y)),
  };
}

// FINGER_PX is how close to a ball a touch must land to name it: a fingertip,
// not the ball, which is ~10 px across on a phone.
const FINGER_PX = 22;
const fingerReach = () => Math.max(R * 1.8, FINGER_PX / view.s);

// nameBall shows ball id's number over it for a moment (a touch has no hover).
function nameBall(id) {
  S.hoverBall = id;
  S.hoverUntil = performance.now() + 2000;
}

canvas.addEventListener('pointerdown', (e) => {
  if (!isMyShot()) {
    // Not my shot: a touch only names the ball under it.
    if (e.pointerType !== 'mouse') {
      const id = hitBall(pointerPos(e), displayBalls(), false, fingerReach());
      if (id !== null) nameBall(id);
    }
    return;
  }
  e.preventDefault();
  const p = pointerPos(e);
  const balls = displayBalls();
  const cue = balls.get(0);

  const grab = grabbable(p, balls);
  if (grab !== null) {
    S.drag = { id: grab, ...clampBall(grab, p) };
    S.liftStart = performance.now();
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  // A press on a pocket (when the 8-ball needs one) or, on touch, on a ball
  // (to name it) may be a tap or the start of an aiming drag; decide on
  // release, by distance and time.
  const pocket = needsPocket() ? hitPocket(p) : null;
  const id = pocket === null && e.pointerType !== 'mouse' ? hitBall(p, balls, true, fingerReach()) : null;
  S.tap = { id, pocket, x: e.clientX, y: e.clientY, t: performance.now(), type: e.pointerType };
  if (cue) {
    canvas.setPointerCapture(e.pointerId);
    if (id === null && pocket === null) {
      S.aiming = true;
      // Pointing aims at once; holding the butt waits for a move, so a
      // touch that only closes a sheet does not swing the cue around.
      if (S.aimFront) aimFrom(p, cue);
    }
  }
});

// aimFrom aims the shot from a pointer at p. By default the pointer holds
// the butt of the cue: the cue lies between it and the cue ball and the
// shot goes the other way, as with a real cue. With S.aimFront it points
// at where the cue ball should go. Right over the cue ball the direction
// means nothing, so the aim stays.
function aimFrom(p, cue) {
  const dx = p.x - cue.x, dy = p.y - cue.y;
  if (Math.hypot(dx, dy) < R * 1.5) return;
  setAngle(S.aimFront ? Math.atan2(dy, dx) : Math.atan2(-dy, -dx));
}

// grabbable returns the ball a press at p picks up, or null: in practice
// with Move on any ball, otherwise the cue ball when it may be placed (ball
// in hand, or always in practice).
function grabbable(p, balls) {
  if (S.practice && S.moveTool) return hitBall(p, balls, false);
  const cue = balls.get(0);
  if ((S.ballInHand || S.practice) && cue && Math.hypot(cue.x - p.x, cue.y - p.y) < R * 2.5) return 0;
  return null;
}

// hitPocket returns the index of the pocket under p, or null. The target is
// the hole plus a margin, at least 24 px across on screen.
function hitPocket(p) {
  const { d, pk, hole } = nearestPocket(p);
  return d <= Math.max(hole.r + 0.02, 24 / view.s) ? POCKETS.indexOf(pk) : null;
}

// callPocket names the pocket for the 8-ball.
function callPocket(n) {
  S.call = { pocket: n };
  refreshShotPanel();
}

// pocketName describes pocket n as it appears on screen.
function pocketName(n) {
  const pk = POCKETS[n];
  const sp = toScreen(pocketHole(pk));
  const left = sp.x < view.cssW / 2, top = sp.y < view.cssH / 2;
  if (pk.side) return view.rotated ? `${left ? 'left' : 'right'} side pocket` : `${top ? 'top' : 'bottom'} side pocket`;
  return `${top ? 'top' : 'bottom'} ${left ? 'left' : 'right'} pocket`;
}

canvas.addEventListener('pointermove', (e) => {
  const p = pointerPos(e);
  if (e.pointerType === 'mouse' && !S.drag && !S.aiming) {
    S.hoverBall = hitBall(p, displayBalls(), false);
  }
  if (!isMyShot()) return;
  if (S.drag) {
    S.drag = { id: S.drag.id, ...clampBall(S.drag.id, p) };
  } else if (S.tap && (S.tap.id !== null || S.tap.pocket !== null) && !S.aiming) {
    // moved off the ball or pocket: this is an aim drag, not a tap
    if (Math.hypot(e.clientX - S.tap.x, e.clientY - S.tap.y) > 8) {
      S.tap = null;
      S.aiming = true;
      const cue = displayBalls().get(0);
      if (cue) aimFrom(p, cue);
    }
  } else if (S.aiming) {
    const cue = displayBalls().get(0);
    if (cue) aimFrom(p, cue);
  }
});

function endPointer(e) {
  if (S.drag) {
    const d = S.drag;
    S.drag = null;
    S.placedAt = d;
    if (d.id === 0) send({ type: 'place_cue', x: d.x, y: d.y });
    else send({ type: 'place_ball', id: d.id, x: d.x, y: d.y });
  }
  const tap = S.tap;
  S.tap = null;
  if (tap && e.type === 'pointerup' && isMyShot() &&
      performance.now() - tap.t < 250 && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 8) {
    if (tap.pocket !== null) callPocket(tap.pocket);
    else if (tap.id !== null) nameBall(tap.id);
  }
  S.aiming = false;
  if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
// A mouse leaving takes its hover label along; a finger lifting fires
// pointerleave too, but its label stays for its time (nameBall).
canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') S.hoverBall = null; });

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
  if (document.querySelector('.scrim:not([hidden])')) return; // keys belong to the dialog
  if (S.practice && S.seat >= 0 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.key === 'z' || e.key === 'Z') { undo(); e.preventDefault(); return; }
    if (e.key === 'm' || e.key === 'M') { toggleMoveTool(); e.preventDefault(); return; }
  }
  if (!isMyShot()) return;
  const step = e.shiftKey ? 0.05 * DEG : 0.5 * DEG;
  switch (e.key) {
    case 'ArrowLeft': setAngle(S.angle - step); break;
    case 'ArrowRight': setAngle(S.angle + step); break;
    case 'ArrowUp': setPower(barToPower(powerToBar(S.power) + 0.05)); break;
    case 'ArrowDown': setPower(barToPower(powerToBar(S.power) - 0.05)); break;
    case 'Escape': if (S.powerDrag) cancelPowerDrag(); else return; break;
    case ' ': case 'Enter': if (canShoot()) { shoot(); S.lastPower = S.power; renderPower(); } break;
    case 's': case 'S': if (canCall()) toggleSafety(); else return; break;
    case 'p': case 'P': if (canPushOut()) togglePushOut(); else return; break;
    case 'x': case 'X': if (canExtend()) extend(); else return; break;
    default: return;
  }
  e.preventDefault();
});

// ---------------------------------------------------------------------------
// 6. panels

const STATUS_ICONS = {
  foul: '<svg class="status__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5"></path><path d="M12 16h.01"></path></svg>',
  ok: '<svg class="status__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>',
};

// setStatus cross-fades the status sentence: the new text goes into the
// inactive layer, the layers swap, and the old text is cleared once faded.
function setStatus(text, tone) {
  const [a, b] = $('status').querySelectorAll('.status__layer');
  const active = a.classList.contains('is-active') ? a : b;
  const next = active === a ? b : a;
  if (active.dataset.text === text && (active.dataset.tone || '') === (tone || '')) return;
  clearTimeout(S.statusTimer);
  next.innerHTML = (tone && STATUS_ICONS[tone]) || '';
  next.append(document.createTextNode(text));
  next.dataset.text = text;
  next.dataset.tone = tone || '';
  next.title = text;
  next.hidden = !text;
  next.classList.add('is-active');
  active.classList.remove('is-active');
  S.statusTimer = setTimeout(() => {
    if (!active.classList.contains('is-active')) { active.textContent = ''; active.dataset.text = ''; active.hidden = true; }
  }, reduceMotion.matches ? 0 : 200);
}

const TOAST_ICONS = {
  ok: '<svg class="toast__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>',
  error: '<svg class="toast__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5"></path><path d="M12 16h.01"></path></svg>',
  close: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>',
};

// toast shows a short notice at the bottom: at most three at a time, 3.5 s
// (errors 6 s, with a close button).
function toast(text, isError) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = `toast${isError ? ' toast--error' : ''}`;
  el.setAttribute('role', isError ? 'alert' : 'status');
  el.innerHTML = TOAST_ICONS[isError ? 'error' : 'ok'];
  el.append(Object.assign(document.createElement('span'), { textContent: text }));
  const dismiss = () => {
    if (el.classList.contains('is-leaving')) return;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), reduceMotion.matches ? 0 : 160);
  };
  if (isError) {
    const close = document.createElement('button');
    close.className = 'icon-btn toast__close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.innerHTML = TOAST_ICONS.close;
    close.onclick = dismiss;
    el.append(close);
  }
  box.append(el);
  const live = [...box.querySelectorAll('.toast:not(.is-leaving)')];
  if (live.length > 3) live[0].dispatchEvent(new Event('dismiss'));
  el.addEventListener('dismiss', dismiss);
  setTimeout(dismiss, isError ? 6000 : 3500);
}

// Names: the last one used is kept; the first time a random one is offered.
const ADJECTIVES = ['Brisk', 'Calm', 'Clever', 'Daring', 'Eager', 'Fancy', 'Gentle', 'Happy', 'Jolly', 'Keen', 'Lucky', 'Merry', 'Nimble', 'Proud', 'Quick', 'Rapid', 'Sharp', 'Swift', 'Witty', 'Zesty'];
const ANIMALS = ['Otter', 'Falcon', 'Badger', 'Heron', 'Lynx', 'Panda', 'Tiger', 'Walrus', 'Gecko', 'Koala', 'Marten', 'Osprey', 'Puffin', 'Raven', 'Shark', 'Stoat', 'Tapir', 'Viper', 'Whale', 'Yak'];
function randomName() {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}
function rememberedName() {
  try { return localStorage.getItem('poolName') || ''; } catch { return ''; }
}
function rememberName(name) {
  try { localStorage.setItem('poolName', name); } catch { /* storage unavailable */ }
}

function showLanding(error) {
  $('landing').hidden = false;
  document.body.classList.add('is-landing');
  hideConn();
  $('landingError').hidden = !error;
  $('landingError').lastElementChild.textContent = error || '';
  if (!$('name').value.trim()) $('name').value = rememberedName() || randomName();
  // An invite link opens straight onto "join this room": the name is the
  // only thing to fill in.
  const code = $('code').value.trim().toUpperCase();
  const invited = /^[A-Z]{5}$/.test(code) && !!new URLSearchParams(location.search).get('room');
  const form = $('landingForm');
  form.classList.toggle('landing--invited', invited);
  $('landingBrand').hidden = invited;
  $('landingInvite').hidden = !invited;
  $('landingCode').textContent = code;
  $('landingLead').textContent = 'Enter your name to take the free seat.';
  $('createRow').hidden = invited;
  $('roomsBox').hidden = invited;
  $('code').hidden = invited;
  $('join').className = invited ? 'btn btn--primary btn--lg btn--block' : 'btn btn--secondary';
  $('switchMode').hidden = !invited;
  setTimeout(() => $('name').focus(), 0);
  if (invited) { stopRoomsPoll(); describeInvite(code); } else startRoomsPoll();
}

function hideLanding() {
  // A button inside the form may still hold focus; an Enter meant for the
  // game would otherwise resubmit the form.
  if ($('landing').contains(document.activeElement)) document.activeElement.blur();
  $('landing').hidden = true;
  document.body.classList.remove('is-landing');
  stopRoomsPoll();
}

// describeInvite names the host in the invited lead, when the room is listed.
async function describeInvite(code) {
  try {
    const res = await fetch('/api/rooms');
    if (!res.ok) return;
    const list = await res.json();
    const room = list.rooms.find((r) => r.roomCode === code);
    if (!room || $('landingCode').textContent !== code) return;
    const host = room.players.find(Boolean);
    if (room.seated >= 2) $('landingLead').textContent = 'This room is full right now.';
    else if (host) $('landingLead').textContent = `${host} is at the table and waiting for an opponent.`;
  } catch { /* keep the generic lead */ }
}

// The room list is live while the landing page is open.
function startRoomsPoll() {
  stopRoomsPoll();
  refreshRooms();
  S.roomsTimer = setInterval(refreshRooms, ROOMS_POLL_MS);
}
function stopRoomsPoll() {
  clearInterval(S.roomsTimer);
  S.roomsTimer = 0;
}
async function refreshRooms() {
  if ($('landing').hidden) { stopRoomsPoll(); return; }
  let list;
  try {
    const res = await fetch('/api/rooms');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    list = await res.json();
  } catch {
    return; // keep the last list; the next poll may succeed
  }
  renderRooms(list);
}
// renderRooms keeps rows keyed by room code: existing rows are updated in
// place (so they never re-animate), new ones enter with a stagger and
// removed ones fade out.
function renderRooms(list) {
  const ul = $('roomList');
  const rows = new Map();
  for (const li of ul.querySelectorAll('li.room-row')) {
    if (!li.classList.contains('is-leaving')) rows.set(li.dataset.code, li);
  }
  let empty = ul.querySelector('.rooms__empty');
  if (!list.rooms.length && !empty) {
    empty = document.createElement('li');
    empty.className = 'rooms__empty';
    empty.innerHTML = '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true"><circle cx="20" cy="20" r="15" stroke="currentColor" stroke-opacity=".35" stroke-width="2" stroke-dasharray="4 5"></circle><circle cx="20" cy="20" r="5" fill="currentColor" fill-opacity=".35"></circle></svg>' +
      '<p class="rooms__empty-title">No rooms yet.</p><p class="caption">Create one and send the link to a friend.</p>';
    ul.append(empty);
  } else if (list.rooms.length && empty) {
    empty.remove();
  }
  let added = 0;
  const seen = new Set();
  for (const room of list.rooms) {
    seen.add(room.roomCode);
    let li = rows.get(room.roomCode);
    if (!li) {
      li = document.createElement('li');
      li.className = 'room-row';
      li.dataset.code = room.roomCode;
      li.style.animationDelay = `${40 * added++}ms`;
      li.innerHTML = '<span class="room-row__code"></span><div class="room-row__who"><span class="room-row__names"></span><span class="chip"><span class="chip__dot"></span><span class="chip__text"></span></span></div><button class="btn btn--secondary btn--small" type="button"></button>';
      li.querySelector('.room-row__code').textContent = room.roomCode;
      li.querySelector('button').onclick = () => {
        const name = landingName();
        if (name) connectAndJoin(li.dataset.code, name);
      };
      ul.append(li);
    }
    const names = room.players.filter(Boolean);
    const namesEl = li.querySelector('.room-row__names');
    namesEl.classList.toggle('room-row__names--empty', !names.length);
    namesEl.replaceChildren();
    if (!names.length) namesEl.textContent = 'empty';
    else names.forEach((n, i) => {
      if (i) namesEl.append(Object.assign(document.createElement('span'), { className: 'room-row__vs', textContent: ' vs ' }));
      namesEl.append(n);
    });
    const phase = room.phase === 'lobby' ? 'lobby' : room.phase === 'game_over' ? 'finished' : 'playing';
    const chip = li.querySelector('.chip');
    chip.className = `chip chip--${phase}`;
    chip.querySelector('.chip__text').textContent = `${MODE_NAME[room.mode] || '8-ball'}${room.race > 1 ? ` · race ${room.race}` : ''} · ${phase}`;
    const btn = li.querySelector('button');
    const open = room.seated < 2;
    btn.textContent = open ? 'Join' : 'Full';
    btn.disabled = !open;
  }
  for (const [code, li] of rows) {
    if (seen.has(code)) continue;
    li.classList.add('is-leaving');
    setTimeout(() => li.remove(), 160);
  }
  const used = list.used ?? list.rooms.length; // practice rooms are not listed but count
  $('roomsCount').textContent = `${used} of ${list.max} in use`;
  const full = used >= list.max;
  $('create').disabled = full;
  $('practice').disabled = full;
  $('createNote').hidden = !full;
  $('createNote').lastElementChild.textContent = full ? `All ${list.max} rooms are in use. Join one below.` : '';
}

const CUE_SVG = '<svg class="seat__cue" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M3 21 15 9"></path><circle cx="18.5" cy="5.5" r="2.5"></circle></svg>';
const compactMedia = matchMedia('(max-width: 600px)');
compactMedia.addEventListener('change', () => refreshPanels());

// renderSeat draws one header seat: name and tags, the remaining balls of
// the player's group, whose turn it is, and the hold ring while offline.
function renderSeat(seat) {
  const el = $(`seat${seat}`);
  el.hidden = S.practice && seat === 1; // practice: one player, no sides
  const p = S.players[seat];
  const compact = compactMedia.matches;
  el.className = 'seat' + (compact ? ' seat--compact' : '');
  el.replaceChildren();
  if (!p.connected && !p.name) {
    el.classList.add('seat--empty');
    el.append(Object.assign(document.createElement('span'), { className: 'seat__name', textContent: 'Open seat' }));
    return;
  }
  const onTurn = (inPlay() || S.moving) && S.turn === seat;
  let state = '';
  if (onTurn && isMe(seat)) {
    el.classList.add('seat--turn');
    if (S.moving) el.classList.add('is-moving');
    el.insertAdjacentHTML('beforeend', CUE_SVG);
    state = S.moving ? 'rolling…' : 'your turn';
  } else if (onTurn) {
    el.classList.add('seat--theirs');
    state = S.moving ? 'rolling…' : 'their turn';
  }
  if (!p.connected) el.classList.add('seat--offline');

  const body = document.createElement('div');
  body.className = 'seat__body';
  const line = document.createElement('div');
  line.className = 'seat__line';
  const name = document.createElement('span');
  name.className = 'seat__name';
  // On a phone the header is tight: my seat just says "You".
  const meShort = compact && isMe(seat) && !S.practice;
  name.textContent = meShort ? 'You' : p.name;
  name.title = p.name;
  line.append(name);
  if (isMe(seat) && !meShort) line.append(tag('you', 'you'));
  if (!p.connected) line.append(tag('offline', 'offline'));
  if (S.phase === 'lobby' && p.ready) line.append(tag('ready', 'ready'));
  if (isNine() && S.fouls[seat] === 2 && S.phase !== 'game_over') {
    const t = tag('2 fouls', 'foul');
    t.title = 'A third foul in a row loses the rack';
    line.append(t);
  }
  body.append(line);
  const g = S.groups[seat];
  if (g) {
    const dots = document.createElement('div');
    dots.className = 'seat__dots';
    const left = [];
    for (let i = 1; i <= 7; i++) {
      const id = g === 'solids' ? i : i + 8;
      const dot = document.createElement('span');
      dot.className = 'ball' + (g === 'stripes' ? ' ball--stripe' : '') + (S.balls.has(id) ? '' : ' ball--gone');
      dot.style.setProperty('--c', `var(--ball-${i})`);
      dots.append(dot);
      if (S.balls.has(id)) left.push(id);
    }
    dots.setAttribute('aria-label', `${g} left: ${left.join(', ') || 'none'}`);
    body.append(dots);
  }
  el.append(body);
  if (!p.connected) el.append(holdRing(seat));
  else if (state && !compact) {
    el.append(Object.assign(document.createElement('span'), { className: 'seat__state', textContent: state }));
  }
  if (p.connected && S.clock && S.clock.seat === seat) el.append(clockRing());
}

// clockRing shows the shot clock of the player who must act. It shares the
// hold ring's drawing; tickClock keeps it current.
function clockRing() {
  const wrap = document.createElement('span');
  wrap.className = 'hold hold--clock';
  wrap.setAttribute('role', 'timer');
  wrap.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="11" fill="none" stroke="var(--hairline-strong)" stroke-width="2"></circle><circle class="hold__arc" cx="13" cy="13" r="11" fill="none" stroke-width="2" stroke-linecap="round" stroke-dasharray="69.1" stroke-dashoffset="0"></circle></svg><span class="hold__num"></span>';
  updateClock(wrap);
  return wrap;
}

function updateClock(wrap) {
  const left = clockLeft();
  if (left === null) return;
  const low = left <= CLOCK_LOW_S;
  wrap.querySelector('.hold__arc').style.strokeDashoffset = String(69.1 * (1 - left / (S.clock.limit / 1000)));
  wrap.querySelector('.hold__num').textContent = String(Math.ceil(left));
  wrap.classList.toggle('hold--low', low);
  wrap.setAttribute('aria-label', `${Math.ceil(left)} seconds left${S.clock.paused ? ', paused' : ''}`);
}

function tickClock() {
  const left = clockLeft();
  if (left === null) { clearInterval(S.clockTimer); S.clockTimer = 0; return; }
  document.querySelectorAll('.hold--clock').forEach(updateClock);
  if (!$('decision').hidden) renderDecisionClock();
  if (isMe(S.clock.seat) && !S.clock.paused && left <= CLOCK_LOW_S && left > 0 && !S.clockWarned) {
    S.clockWarned = true;
    toast(`${CLOCK_LOW_S} seconds left` + (canExtend() ? ' · X extends' : ''), true);
  }
}

const canExtend = () => !!S.clock && isMe(S.clock.seat) && S.clock.extensions[S.seat];

// extend spends this game's extension: the server resets the clock.
function extend() {
  if (!canExtend()) return;
  send({ type: 'extend' });
}

function tag(text, cls) {
  const t = document.createElement('span');
  t.className = `tag tag--${cls}`;
  t.textContent = text;
  return t;
}

// holdRing shows how much of the 60 s seat hold is left. Without a known
// drop time (joined after the drop) the ring is shown without a number.
function holdRing(seat) {
  const wrap = document.createElement('span');
  wrap.className = 'hold';
  wrap.dataset.seat = seat;
  wrap.setAttribute('role', 'timer');
  wrap.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="11" fill="none" stroke="var(--hairline-strong)" stroke-width="2"></circle><circle class="hold__arc" cx="13" cy="13" r="11" fill="none" stroke="var(--foul)" stroke-width="2" stroke-linecap="round" stroke-dasharray="69.1" stroke-dashoffset="0"></circle></svg><span class="hold__num"></span>';
  updateHold(wrap);
  return wrap;
}

function holdRemaining(seat) {
  const since = S.offlineSince[seat];
  if (!since) return null;
  return Math.max(0, SEAT_HOLD_S - (performance.now() - since) / 1000);
}

function updateHold(wrap) {
  const arc = wrap.querySelector('.hold__arc');
  const num = wrap.querySelector('.hold__num');
  if (!arc || !num || wrap.hidden) return;
  const remaining = holdRemaining(Number(wrap.dataset.seat));
  if (remaining === null) { arc.style.strokeDashoffset = '0'; num.textContent = ''; return; }
  arc.style.strokeDashoffset = String(69.1 * (1 - remaining / SEAT_HOLD_S));
  num.textContent = String(Math.ceil(remaining));
}

function tickHolds() {
  const rings = [...document.querySelectorAll('.hold:not(.hold--clock)')].filter((r) => !r.hidden && r.querySelector('.hold__arc'));
  if (!rings.length) { clearInterval(S.holdTimer); S.holdTimer = 0; return; }
  rings.forEach(updateHold);
  // the waiting panel's sentence counts down too
  const left = S.seat >= 0 ? holdRemaining(1 - S.seat) : null;
  if (left !== null && !$('waitPanel').hidden && !$('waitHold').hidden) {
    $('waitSub').textContent = `Their seat is held for ${Math.ceil(left)} more seconds.`;
  }
}

// renderTrays lists the pocketed balls of each group under the table.
function renderTrays() {
  $('trays').hidden = S.phase === 'lobby';
  if (isNine()) {
    // one row: the balls down so far (the 9 only ever drops to end the rack)
    const el = $('traySolids');
    el.replaceChildren();
    $('trayStripes').replaceChildren();
    if (S.phase === 'lobby') return;
    const balls = [];
    for (let id = 1; id <= 9; id++) {
      if (S.balls.has(id)) continue;
      const b = document.createElement('span');
      b.className = 'ball' + (id === 9 ? ' ball--stripe' : '');
      b.style.setProperty('--c', `var(--ball-${id === 9 ? 1 : id})`);
      b.title = String(id);
      balls.push(b);
    }
    el.append(Object.assign(document.createElement('span'), { className: 'tray__label', textContent: 'Pocketed' }), ...balls);
    return;
  }
  for (const [elId, first, label] of [['traySolids', 1, 'Solids'], ['trayStripes', 9, 'Stripes']]) {
    const el = $(elId);
    el.replaceChildren();
    if (S.phase === 'lobby') continue;
    const balls = [];
    for (let id = first; id < first + 7; id++) {
      if (S.balls.has(id)) continue;
      const b = document.createElement('span');
      b.className = 'ball' + (id > 8 ? ' ball--stripe' : '');
      b.style.setProperty('--c', `var(--ball-${id > 8 ? id - 8 : id})`);
      b.title = String(id);
      balls.push(b);
    }
    const lab = Object.assign(document.createElement('span'), { className: 'tray__label', textContent: label });
    if (first === 1) el.append(lab, ...balls); else el.append(...balls, lab);
  }
}

// showPanel makes one panel of the slot visible and fades the others out.
function showPanel(id) {
  for (const sec of $('controls').children) {
    const on = sec.id === id;
    if (on) {
      sec.classList.remove('is-leaving');
      clearTimeout(sec._leave);
      sec.hidden = false;
    } else if (!sec.hidden && !sec.classList.contains('is-leaving')) {
      sec.classList.add('is-leaving');
      sec._leave = setTimeout(() => { sec.hidden = true; sec.classList.remove('is-leaving'); }, reduceMotion.matches ? 0 : 120);
    }
  }
}

function refreshPanels() {
  renderModes();
  renderSeat(0);
  renderSeat(1);
  renderScore();
  if (!$('matchDialog').hidden) renderMatchDialog();
  if (!$('settings').hidden) renderRoomSettings();
  if (document.querySelector('.seat .hold:not(.hold--clock)') && !S.holdTimer) S.holdTimer = setInterval(tickHolds, 1000);
  if (S.clock && !S.clockTimer) S.clockTimer = setInterval(tickClock, 200);
  renderTrays();
  const me = S.seat >= 0 ? S.players[S.seat] : null;
  const opp = S.seat >= 0 ? S.players[1 - S.seat] : null;

  const myShot = isMyShot();
  const barHidden = S.phase === 'lobby' || S.phase === 'game_over' || S.seat < 0;
  if (powerBar.hidden !== barHidden) { powerBar.hidden = barHidden; resize(); }
  powerBar.classList.toggle('pbar--disabled', !myShot);
  powerTrack.tabIndex = myShot ? 0 : -1;
  if (!myShot && S.powerDrag) { S.powerDrag = false; powerClasses(); }
  if (!barHidden) renderPower();
  const panel = S.phase === 'lobby' && !S.practice ? 'lobbyPanel' : S.phase === 'game_over' ? 'overPanel' : myShot ? 'shotPanel' : 'waitPanel';
  renderPracticeBar();
  showPanel(panel);
  // On a phone the slot is one row while the rack is played; the table
  // resizes only when that changes (start and end of a rack).
  const playing = panel === 'shotPanel' || panel === 'waitPanel';
  if (document.body.classList.contains('is-playing') !== playing) {
    document.body.classList.toggle('is-playing', playing);
    resize();
  }
  if (!myShot) closeSheet();

  if (panel === 'lobbyPanel' && me) {
    const alone = !opp.connected && !opp.name;
    $('ready').hidden = alone || me.ready;
    $('lobbyCopy').hidden = !alone;
    if (alone) {
      setPanelMsg('lobbyText', S.lobbyNote ? esc(S.lobbyNote) : 'Waiting for an opponent.');
      $('lobbySub').textContent = S.lobbyNote ? 'The room stays open. Send the link to someone else.' : 'Send the link; this room stays open while you are here.';
    } else if (!opp.connected) {
      setPanelMsg('lobbyText', `<strong>${esc(opp.name)}</strong> is offline.`);
      $('lobbySub').textContent = 'Their seat is held for a moment.';
    } else if (me.ready) {
      setPanelMsg('lobbyText', `<strong>You’re ready.</strong> Waiting for ${esc(opp.name)}…`);
      $('lobbySub').textContent = 'The match starts when both players are ready. Changing the game or the race makes you both ready again.';
    } else {
      setPanelMsg('lobbyText', `<strong>${esc(opp.name)} is here.</strong> Ready when you are.`);
      $('lobbySub').textContent = `${MODE_NAME[S.mode]}, first to ${S.race} ${S.race === 1 ? 'rack' : 'racks'}. ${BREAKS_TEXT[S.breaks]} Change it in Settings.`;
    }
  }
  if (panel === 'shotPanel') refreshShotPanel();
  if (panel === 'waitPanel') {
    const hold = $('waitHold');
    hold.hidden = true;
    let msg, sub = '';
    if (S.moving) { msg = '<span class="muted">Balls are rolling…</span>'; }
    else if (S.practice) { msg = '<span class="muted">Setting up the table…</span>'; }
    else if (opp && opp.name && !opp.connected) {
      msg = `Waiting for <strong>${esc(opp.name)}</strong> to reconnect…`;
      const left = holdRemaining(1 - S.seat);
      sub = left === null ? 'Their seat is held for a moment.' : `Their seat is held for ${Math.ceil(left)} more seconds.`;
      hold.hidden = false;
      hold.replaceChildren(...holdRing(1 - S.seat).childNodes);
      hold.dataset.seat = String(1 - S.seat);
      if (!S.holdTimer) S.holdTimer = setInterval(tickHolds, 1000);
    } else if (S.decision) {
      msg = isMe(S.decision.seat) ? 'Your decision.' : `Waiting for <strong>${esc(nameOf(S.decision.seat))}</strong> to decide.`;
      sub = S.lastDecisionReason;
    } else {
      msg = `<strong>${esc(nameOf(S.turn))}’s turn.</strong>${S.ballInHand ? ' Ball in hand.' : ''}`;
      sub = 'You see their aim as they line up.';
    }
    setPanelMsg('waitText', msg);
    $('waitSub').textContent = sub;
  }
  if (panel === 'overPanel') renderOverPanel();
  refreshDecision();
}

// renderModes shows the room's game in the header and on the lobby and
// game-over pickers.
function renderModes() {
  $('roomEyebrow').textContent = S.seat < 0 ? 'Room' : S.practice ? `Practice · ${MODE_NAME[S.mode]}` : `${MODE_NAME[S.mode]} room`;
  $('leaveBtn').hidden = S.seat < 0 || S.practice;
  document.body.classList.toggle('is-practice', S.practice && S.seat >= 0);
}

function setSeg(seg, mode) {
  for (const b of seg.querySelectorAll('.seg__btn')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
}

// The landing picker chooses the game of a new room (remembered); the
// lobby and game-over pickers change the room's game for both players.
let landingMode = readSetting('pool:mode') === '9ball' ? '9ball' : '8ball';
setSeg($('landingMode'), landingMode);
$('landingMode').addEventListener('click', (e) => {
  const b = e.target.closest('.seg__btn');
  if (!b) return;
  landingMode = b.dataset.mode;
  writeSetting('pool:mode', landingMode);
  setSeg($('landingMode'), landingMode);
});

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function setPanelMsg(id, html) { $(id).innerHTML = html; }

function refreshShotPanel() {
  const callEl = $('callText');
  let html, called = false;
  const opp = S.players[1 - S.seat].name || 'your opponent';
  if (S.practice) {
    html = 'Free play: <span class="muted">any ball, any pocket' + (compactMedia.matches ? '.' : ', no fouls. Drag the cue ball anywhere; Move sets up the others.') + '</span>';
    called = true;
  } else if (isNine()) {
    const low = lowestBall();
    called = true;
    if (S.phase === 'breaking') {
      html = 'Break: <span class="muted">hit the 1 first' + (S.ballInHand && !compactMedia.matches ? ', cue ball anywhere in the kitchen.' : '.') + '</span>';
    } else if (S.call && S.call.pushOut) {
      html = `Push out: <span class="muted">no contact needed; then ${esc(opp)} chooses who shoots.</span>`;
    } else {
      html = `Hit the <span class="call__value">${low === 9 ? '9-ball' : low}</span> first <span class="muted">· any ball that drops counts; the 9 wins.</span>`;
    }
  } else if (!canCall()) {
    // On a phone the "ball in hand · kitchen" tag beside it says the rest.
    html = 'Break: <span class="muted">no call needed' + (S.ballInHand && !compactMedia.matches ? ', drag the cue ball anywhere in the kitchen.' : '.') + '</span>';
    called = true;
  } else if (S.call && S.call.safety) {
    html = 'Safety: <span class="muted">the turn passes after the shot.</span>';
    called = true;
  } else if (eightOn()) {
    if (S.call) {
      html = `Called: <span class="call__value">${esc(pocketName(S.call.pocket))}</span>`;
      called = true;
    } else {
      html = S.ballInHand ? 'Ball in hand: place the cue ball, then tap a pocket for the 8.' : 'On the 8-ball: tap the pocket you are going for.';
    }
  } else if (S.phase === 'open') {
    html = 'Open table: <span class="muted">any ball but the 8 counts.</span>';
    called = true;
  } else {
    html = `Your group: <span class="call__value">${esc(S.groups[S.seat])}</span> <span class="muted">· any that drops counts.</span>`;
    called = true;
  }
  if (callEl.dataset.html !== html) {
    callEl.innerHTML = html;
    callEl.dataset.html = html;
    callEl.title = callEl.textContent;
    callEl.classList.remove('call__line--enter');
    void callEl.offsetWidth;
    callEl.classList.add('call__line--enter');
  }
  callEl.classList.toggle('call__line--called', called);
  $('clearCall').hidden = !S.call || !!S.call.pushOut; // the toggle undoes a push out
  const ext = $('extend');
  ext.hidden = !canExtend();
  if (!ext.hidden) {
    const secs = Math.round(S.clock.extension / 1000);
    ext.innerHTML = `${CLOCK_SVG}+${secs}s`;
    ext.title = `Extension: reset your clock to ${secs} seconds, once per game (X)`;
    ext.setAttribute('aria-label', ext.title);
  }
  $('safety').hidden = !canCall();
  $('pushOut').hidden = !canPushOut();
  $('pushOut').setAttribute('aria-pressed', String(!!(S.call && S.call.pushOut)));
  $('safety').setAttribute('aria-pressed', String(!!(S.call && S.call.safety)));
  for (const b of document.querySelectorAll('#shotPanel .nudge')) {
    const d = Number(b.dataset.deg);
    const sign = d < 0 ? '−' : '+';
    const mag = Math.abs(d);
    b.textContent = compactMedia.matches ? `${sign}${mag < 1 ? String(mag).slice(1) : mag}` : `${sign}${mag}°`;
  }
  $('handTag').hidden = !S.ballInHand;
  $('handTag').textContent = S.kitchen ? 'ball in hand · kitchen' : 'ball in hand';
  if (S.ballInHand && readSetting('pool:hint:hand') !== 'off') {
    writeSetting('pool:hint:hand', 'off');
    toast(S.kitchen ? 'Drag the cue ball anywhere in the kitchen, then pull the bar to shoot' : 'Drag the cue ball anywhere on the table');
  }
  setAngle(S.angle);
  renderPower();
  renderSpin();
}

function togglePushOut() {
  S.call = S.call && S.call.pushOut ? null : { pushOut: true };
  refreshShotPanel();
}

function toggleSafety() {
  S.call = S.call && S.call.safety ? null : { safety: true };
  refreshShotPanel();
}

const CHEV_SVG = '<svg class="option__chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>';
const CLOCK_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>';

function refreshDecision() {
  const d = S.decision;
  const show = d && isMe(d.seat) && !S.moving;
  const dlg = $('decision');
  const wasShown = !dlg.hidden;
  dlg.hidden = !show;
  renderBanner(d && !isMe(d.seat) && !S.moving ? `Waiting for ${nameOf(d.seat)} to decide` : '');
  renderResult();
  if (!show) return;
  renderDecisionClock();
  if (wasShown && dlg.dataset.key === JSON.stringify(d)) return; // already built
  dlg.dataset.key = JSON.stringify(d);
  const eight = d.options.includes('spot_eight');
  $('decisionTitle').textContent = d.options.includes('take_shot') ? 'Push out' : eight ? '8-ball on the break' : 'Illegal break';
  $('decisionText').textContent = S.lastDecisionReason || '';
  const box = $('decisionOptions');
  box.replaceChildren();
  const opp = S.players[1 - S.seat].name || 'your opponent';
  d.options.forEach((opt, i) => {
    const [title, desc] = optionText(opt, opp);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'option' + (i === 0 ? ' option--primary' : '');
    b.style.animationDelay = `${40 * i}ms`;
    b.innerHTML = `<span class="option__text"><span class="option__title"></span><span class="option__sub"></span></span>${CHEV_SVG}`;
    b.querySelector('.option__title').textContent = title;
    b.querySelector('.option__sub').textContent = desc;
    b.onclick = () => { send({ type: 'choose', option: opt }); dlg.hidden = true; };
    box.append(b);
  });
  setTimeout(() => { const first = box.querySelector('.option'); if (first) first.focus(); }, 0);
}
// renderDecisionClock says how long the chooser has and what happens then;
// the dialog's scrim hides the clock in the header.
function renderDecisionClock() {
  const el = $('decisionClock');
  const left = clockLeft();
  el.hidden = left === null || !S.decision || !isMe(S.clock.seat);
  if (el.hidden) return;
  const opp = S.players[1 - S.seat].name || 'your opponent';
  const text = `${Math.ceil(left)} s left, then “${optionText(S.decision.options[0], opp)[0]}” is chosen for you.`;
  if (el.dataset.text === text) return;
  el.dataset.text = text;
  el.innerHTML = `${CLOCK_SVG}<span></span>`;
  el.querySelector('span').textContent = text;
  el.classList.toggle('hint--low', left <= CLOCK_LOW_S);
}

// A choice is required: Tab stays inside the dialog and Esc does nothing.
$('decision').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const opts = [...$('decisionOptions').querySelectorAll('.option')];
  if (!opts.length) return;
  const i = opts.indexOf(document.activeElement);
  e.preventDefault();
  opts[(i + (e.shiftKey ? -1 : 1) + opts.length) % opts.length].focus();
});

// renderBanner shows a short notice over the table (or removes it).
function renderBanner(text) {
  let el = $('tableWrap').querySelector('.banner');
  if (!text) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.className = 'banner';
    el.setAttribute('role', 'status');
    $('tableWrap').append(el);
  }
  if (el.dataset.text !== text) {
    el.innerHTML = CLOCK_SVG;
    el.append(document.createTextNode(text));
    el.dataset.text = text;
  }
}

// renderResult shows who won the rack over the table while the game is over.
// renderPracticeBar shows the practice tools and their state.
function renderPracticeBar() {
  const bar = $('practiceBar');
  const on = S.practice && S.seat >= 0;
  if (bar.hidden === on) { bar.hidden = !on; resize(); }
  if (!on) return;
  $('undoBtn').disabled = S.undos === 0 || S.moving;
  $('undoBtn').title = S.undos ? `Take back the last shot (Z) · ${S.undos} left` : 'Nothing to take back yet';
  $('moveBtn').setAttribute('aria-pressed', String(S.moveTool));
  $('rackBtn').disabled = S.moving;
}

function undo() {
  if (S.practice && S.undos > 0 && !S.moving) send({ type: 'undo' });
}

function toggleMoveTool() {
  S.moveTool = !S.moveTool;
  if (S.moveTool) toast('Move balls: drag any ball. Press M again to aim.');
  refreshPanels();
}

// winnerTitle names the winner of the rack; in practice by side.
function winnerTitle() {
  if (S.winner === null) return 'Game over';
  if (S.practice) return `${sideName(S.winner)} wins the rack`;
  return isMe(S.winner) ? 'You win the rack' : `${nameOf(S.winner)} wins the rack`;
}

function renderResult() {
  let el = $('tableWrap').querySelector('.result');
  if (S.phase !== 'game_over' || S.winner === null) { if (el) el.remove(); return; }
  const win = isMe(S.winner) && !S.practice;
  const m = S.practice ? null : S.match;
  const matchWon = m && m.race > 1 && m.winner !== null;
  const title = matchWon ? matchTitle(m) : winnerTitle();
  const score = m && m.race > 1 && m.racks.length ? `${m.score[0]}–${m.score[1]}` : '';
  const reason = [S.resultReason, score].filter(Boolean).join(' · ');
  if (el && el.dataset.title === title + reason) return;
  if (el) el.remove();
  el = document.createElement('div');
  el.className = 'result' + (win ? ' result--win' : '');
  el.setAttribute('role', 'status');
  el.dataset.title = title + reason;
  el.innerHTML = '<p class="result__title"></p><p class="result__reason"></p>';
  el.querySelector('.result__title').textContent = title;
  el.querySelector('.result__reason').textContent = reason;
  $('tableWrap').append(el);
}

// ---------------------------------------------------------------------------
// match: race, score, rack history, leaving

const RACE_MAX = 25;
const BREAKS_TEXT = { alternate: 'The break alternates.', winner: 'The winner of a rack breaks the next.' };

// setMatch takes the match from the server and notes when it was just won.
function setMatch(m) {
  const prev = S.match;
  S.match = m || null;
  if (m && prev && prev.winner === null && m.winner !== null && m.racks.length > prev.racks.length) {
    const last = m.racks[m.racks.length - 1];
    S.matchJustWon = m.race > 1 || last.end === 'forfeit'; // a race to 1 is just the rack
  }
}

// matchLive reports whether leaving now forfeits a match.
function matchLive() {
  return !S.practice && S.seat >= 0 && !!S.match && S.match.winner === null && S.phase !== 'lobby';
}

// matchName names a seat in the match history, even after its player left.
function matchName(seat) {
  if (isMe(seat)) return 'You';
  return S.players[seat].name || S.lastOppName || `Player ${seat + 1}`;
}

function matchTitle(m) {
  return isMe(m.winner) ? 'You win the match' : `${matchName(m.winner)} wins the match`;
}

// rackWhy says how a rack of the match ended.
function rackWhy(r) {
  const loser = matchName(1 - r.winner);
  switch (r.end) {
    case 'made': return S.mode === '9ball' ? '9-ball pocketed' : '8-ball in the called pocket';
    case 'eight_foul': return `${loser} fouled on the 8-ball${r.foul ? `: ${FOUL_TEXT[r.foul] || r.foul}` : ''}`;
    case 'eight_early': return `${loser} pocketed the 8-ball early`;
    case 'eight_pocket': return `${loser} pocketed the 8-ball in the wrong pocket`;
    case 'three_fouls': return `${loser} fouled three times in a row`;
    case 'forfeit': return `${loser} left the match`;
  }
  return '';
}

function showMatchIfWon(delay) {
  if (!S.matchJustWon) return;
  S.matchJustWon = false;
  const last = S.match.racks[S.match.racks.length - 1];
  setTimeout(() => { if (S.seat >= 0 && S.match) openMatchDialog(); }, last.end === 'forfeit' ? 0 : delay);
}

// renderScore draws the header score; a digit that went up ticks.
function renderScore() {
  const el = $('score');
  el.hidden = S.practice;
  const m = S.seat >= 0 && !S.practice ? S.match : null;
  const compact = compactLayout.matches ? ' score--compact' : '';
  el.disabled = !m;
  if (!m) {
    el.className = 'score score--empty' + compact;
    if (el.dataset.k !== 'vs') {
      el.innerHTML = '<span class="score__vs">vs</span>';
      el.dataset.k = 'vs';
      el.setAttribute('aria-label', 'No score yet');
      el.removeAttribute('title');
    }
    S.shownScore = null;
    return;
  }
  el.className = 'score' + (m.racks.length ? '' : ' score--empty') + compact;
  el.setAttribute('aria-label', `Score ${m.score[0]} to ${m.score[1]}, race to ${m.race}. Show the racks.`);
  el.title = 'Show the racks';
  const key = `${m.score[0]}-${m.score[1]}-${m.race}`;
  if (el.dataset.k === key) return;
  const old = S.shownScore;
  const tick = old && old.race === m.race && !reduceMotion.matches;
  const slot = (i) => {
    const n = m.score[i];
    if (tick && n > old.score[i]) return `<span class="score__slot"><span class="score__old">${old.score[i]}</span><span class="score__new">${n}</span></span>`;
    return `<span class="score__slot"><span>${n}</span></span>`;
  };
  el.innerHTML = `<span class="score__nums">${slot(0)}<span class="score__sep">–</span>${slot(1)}</span><span class="score__race">race to ${m.race}</span>`;
  el.dataset.k = key;
  S.shownScore = { score: [...m.score], race: m.race };
}

function openMatchDialog() {
  if (!S.match) return;
  renderMatchDialog();
  $('matchDialog').hidden = false;
  $('matchClose').focus();
}

// renderMatchDialog fills the match dialog: score, result and every rack.
function renderMatchDialog() {
  const m = S.match;
  if (!m) { $('matchDialog').hidden = true; return; }
  const over = m.winner !== null;
  const last = m.racks[m.racks.length - 1];
  $('matchEyebrow').textContent = `${MODE_NAME[S.mode]} · race to ${m.race}`;
  $('matchTitle').textContent = over ? matchTitle(m) : 'Match';
  let text;
  if (over && last.end === 'forfeit') text = `${matchName(1 - m.winner)} left the room, so the match goes to ${isMe(m.winner) ? 'you' : matchName(m.winner)}.`;
  else if (over) text = `${m.score[m.winner]}–${m.score[1 - m.winner]} after ${m.racks.length} ${m.racks.length === 1 ? 'rack' : 'racks'}.`;
  else text = `First to ${m.race} ${m.race === 1 ? 'rack' : 'racks'} wins. ${BREAKS_TEXT[m.breaks]}`;
  $('matchText').textContent = text;
  $('matchName0').textContent = matchName(0);
  $('matchName1').textContent = matchName(1);
  $('matchNums').textContent = `${m.score[0]} – ${m.score[1]}`;
  const list = $('matchRacks');
  list.replaceChildren();
  if (!m.racks.length) {
    list.append(Object.assign(document.createElement('li'), { className: 'racks__empty', textContent: 'No rack finished yet.' }));
    return;
  }
  const run = [0, 0];
  m.racks.forEach((r, i) => {
    if (r.end !== 'forfeit') run[r.winner]++;
    const li = document.createElement('li');
    li.className = 'rack';
    const n = Object.assign(document.createElement('span'), { className: 'rack__n', textContent: `#${i + 1}` });
    const who = Object.assign(document.createElement('span'), { className: 'rack__who' + (isMe(r.winner) ? ' rack__who--me' : ''), textContent: matchName(r.winner) });
    const sc = Object.assign(document.createElement('span'), { className: 'rack__score', textContent: `${run[0]}–${run[1]}` });
    const broke = isMe(r.breaker) ? 'you broke' : `${matchName(r.breaker)} broke`;
    const why = Object.assign(document.createElement('span'), { className: 'rack__why', textContent: `${rackWhy(r)} · ${broke}` });
    li.append(n, who, sc, why);
    list.append(li);
  });
  list.lastElementChild.scrollIntoView({ block: 'nearest' });
}

function openLeaveConfirm() {
  const m = S.match;
  const opp = matchName(1 - S.seat);
  const score = m.racks.length ? `The score is ${m.score[S.seat]}–${m.score[1 - S.seat]} (you first). ` : '';
  $('leaveText').textContent = `${score}Leaving now gives ${opp} the match.`;
  $('leaveConfirm').hidden = false;
  $('leaveStay').focus();
}

// renderOverPanel: between racks the next rack, after the match a new one
// (the game and the race can change then).
function renderOverPanel() {
  const m = S.practice ? null : S.match;
  const live = matchLive();
  if (S.practice) {
    $('overText').textContent = winnerTitle();
    $('rematch').textContent = 'Rack again';
    $('rematchNote').textContent = `Next: ${MODE_NAME[S.mode]}. Undo takes the last shot back.`;
    return;
  }
  const breaks = (seat) => `${nameOf(seat)} ${isMe(seat) ? 'break' : 'breaks'}`;
  if (live) {
    const next = m.breaks === 'winner' ? S.winner : 1 - S.lastBreaker;
    $('overText').textContent = winnerTitle();
    $('rematch').textContent = 'Next rack';
    $('rematchNote').textContent = `${m.score[0]}–${m.score[1]}, race to ${m.race}. ${breaks(next)} the next rack.`;
    return;
  }
  const opener = m && m.racks.length ? 1 - m.racks[0].breaker : -1;
  const long = m && m.race > 1;
  $('overText').textContent = long ? `${matchTitle(m)} ${m.score[m.winner]}–${m.score[1 - m.winner]}` : winnerTitle();
  $('rematch').textContent = long ? 'New match' : 'Rematch';
  $('rematchNote').textContent = `Next: ${MODE_NAME[S.mode]}, race to ${S.race}.` + (opener < 0 ? '' : ` ${breaks(opener)} first.`) + ' Change them in Settings.';
}

// Match pickers: race (quick picks or a number) and who breaks.
function setMatchPick(root, race, breaks) {
  for (const b of root.querySelectorAll('.js-race .seg__btn')) b.setAttribute('aria-pressed', String(Number(b.dataset.race) === race));
  const input = root.querySelector('.js-race-input');
  if (document.activeElement !== input) input.value = String(race);
  for (const b of root.querySelectorAll('.js-breaks .seg__btn')) b.setAttribute('aria-pressed', String(b.dataset.breaks === breaks));
}

function wireMatchPick(root, current, onChange) {
  root.querySelector('.js-race').addEventListener('click', (e) => {
    const b = e.target.closest('.seg__btn');
    if (b) onChange({ race: Number(b.dataset.race) });
  });
  const input = root.querySelector('.js-race-input');
  input.addEventListener('change', () => {
    const n = Number(input.value);
    if (Number.isInteger(n) && n >= 1 && n <= RACE_MAX) onChange({ race: n });
    else {
      toast(`The race is 1 to ${RACE_MAX} racks`, true);
      input.value = String(current().race);
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); } // commit, never submit the form
  });
  root.querySelector('.js-breaks').addEventListener('click', (e) => {
    const b = e.target.closest('.seg__btn');
    if (b) onChange({ breaks: b.dataset.breaks });
  });
}

// The landing picker sets up a new room (remembered); the room's picker
// changes the next match for both players.
let landingRace = Number(readSetting('pool:race')) || 3;
if (!(landingRace >= 1 && landingRace <= RACE_MAX)) landingRace = 3;
let landingBreaks = readSetting('pool:breaks') === 'winner' ? 'winner' : 'alternate';
setMatchPick($('landingMatch'), landingRace, landingBreaks);
wireMatchPick($('landingMatch'), () => ({ race: landingRace }), (c) => {
  if (c.race) { landingRace = c.race; writeSetting('pool:race', String(c.race)); }
  if (c.breaks) { landingBreaks = c.breaks; writeSetting('pool:breaks', c.breaks); }
  setMatchPick($('landingMatch'), landingRace, landingBreaks);
});
wireMatchPick($('roomMatch'), () => ({ race: S.race }), (c) => {
  if ((c.race && c.race !== S.race) || (c.breaks && c.breaks !== S.breaks)) send({ type: 'set_match', ...c });
});


// closable wires a dialog's close button, backdrop and Escape.
function closable(scrimId, closeId) {
  const close = () => { $(scrimId).hidden = true; };
  $(closeId).onclick = close;
  $(scrimId).addEventListener('click', (e) => { if (e.target === $(scrimId)) close(); });
  $(scrimId).addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}
closable('matchDialog', 'matchClose');
closable('leaveConfirm', 'leaveStay');
$('score').onclick = openMatchDialog;
$('leaveForfeit').onclick = () => { $('leaveConfirm').hidden = true; leaveRoom(); };

// ---------------------------------------------------------------------------
// wiring

$('ready').onclick = () => send({ type: 'ready' });
$('undoBtn').onclick = undo;
$('moveBtn').onclick = toggleMoveTool;
$('rackBtn').onclick = () => {
  if (S.moving) return;
  resetOrientations();
  send({ type: 'rerack' });
  setStatus(`New ${MODE_NAME[S.mode]} rack. Free play.`);
};
$('practiceLeave').onclick = () => leaveRoom();
$('rematch').onclick = () => send({ type: 'rematch' });
$('safety').onclick = toggleSafety;
$('pushOut').onclick = togglePushOut;
$('clearCall').onclick = () => { S.call = null; refreshShotPanel(); };
$('extend').onclick = extend;
for (const b of document.querySelectorAll('.nudge')) {
  b.onclick = () => setAngle(S.angle + Number(b.dataset.deg) * DEG);
}
// copyInvite shares (phones) or copies the room's invite link.
async function copyInvite() {
  const url = `${location.origin}/?room=${S.roomCode}`;
  if (navigator.share && compactMedia.matches) {
    try { await navigator.share({ title: 'Pool', text: `Join my pool room ${S.roomCode}`, url }); return; } catch { /* cancelled or unsupported: fall back to copying */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied');
  } catch {
    toast(url);
  }
}
$('inviteCopy').onclick = copyInvite;

// landingName returns the typed name, or null (with the field marked) if it
// is empty.
function landingName() {
  const name = $('name').value.trim();
  if (!name) {
    const field = $('nameField');
    $('name').classList.add('input--error');
    $('name').setAttribute('aria-invalid', 'true');
    $('nameError').hidden = false;
    field.classList.remove('field--shake');
    void field.offsetWidth; // restart the animation
    field.classList.add('field--shake');
    $('name').focus();
    return null;
  }
  rememberName(name);
  return name;
}
$('nameField').addEventListener('animationend', () => $('nameField').classList.remove('field--shake'));
$('name').addEventListener('input', () => {
  $('name').classList.remove('input--error');
  $('name').removeAttribute('aria-invalid');
  $('nameError').hidden = true;
});
$('shuffleName').onclick = () => {
  $('name').value = randomName();
  $('name').dispatchEvent(new Event('input'));
  $('name').focus();
};
// createRoom asks for a room of the picked game and joins it; practice
// rooms are private and played alone.
async function createRoom(practice) {
  const name = landingName();
  if (!name) return;
  $('landingError').hidden = true;
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(practice ? { mode: landingMode, practice } : { mode: landingMode, race: landingRace, breaks: landingBreaks }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
    const { roomCode } = body;
    $('code').value = roomCode;
    S.rackMode = landingMode;
    connectAndJoin(roomCode, name);
  } catch (err) {
    showLanding(`Could not create a room: ${err.message}`);
  }
}
$('create').onclick = () => createRoom(false);
$('practice').onclick = () => createRoom(true);
$('landingForm').onsubmit = (e) => {
  e.preventDefault();
  if ($('landing').hidden) return; // already in a room
  const name = landingName();
  if (!name) return;
  const code = $('code').value.trim().toUpperCase();
  if (code.length !== 5) { showLanding('Room codes have 5 letters.'); return; }
  connectAndJoin(code, name);
};
$('rejoin').onclick = () => {
  S.reconnectAttempt = 0; // "Retry now" restarts the backoff
  $('retryTry').textContent = 'Connecting…';
  connectAndJoin(S.roomCode, S.name, S.token);
};
// --- settings ----------------------------------------------------------------
function readSetting(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writeSetting(key, value) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* unavailable */ } }

// standalone: opened from the home screen, without browser bars.
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// renderRoomSettings: the game, the next match and the invite link, for the
// room the player is in. They change only between matches.
function renderRoomSettings() {
  const inRoom = S.seat >= 0;
  $('roomSettings').hidden = !inRoom;
  if (!inRoom) return;
  $('settingsMatchRow').hidden = S.practice;
  $('settingsInviteRow').hidden = S.practice;
  const locked = !S.practice && (matchLive() || !(S.phase === 'lobby' || S.phase === 'game_over'));
  setSeg($('settingsMode'), S.mode);
  for (const b of $('roomSettings').querySelectorAll('#settingsMode .seg__btn, #roomMatch button, #roomMatch input')) b.disabled = locked;
  const note = $('settingsModeNote');
  note.hidden = !locked && !S.practice;
  note.textContent = locked ? 'Locked while a match is played: change them after it, or in the lobby.' : 'Changing the game racks the table again.';
  if (!S.practice) setMatchPick($('roomMatch'), S.race, S.breaks);
  $('inviteCode').textContent = S.roomCode;
}

$('settingsMode').addEventListener('click', (e) => {
  const b = e.target.closest('.seg__btn');
  if (!b || b.disabled || b.dataset.mode === S.mode) return;
  if (S.practice) {
    if (S.moving) return;
    resetOrientations();
    send({ type: 'rerack', mode: b.dataset.mode });
    setStatus(`New ${MODE_NAME[b.dataset.mode]} rack. Free play.`);
  } else {
    send({ type: 'set_mode', mode: b.dataset.mode });
  }
});

function renderSettings() {
  renderRoomSettings();
  $('installTip').hidden = standalone || !matchMedia('(pointer: coarse)').matches;
  const theme = readSetting('pool:theme') || 'system';
  for (const b of document.querySelectorAll('#settings .seg .toggle')) b.setAttribute('aria-pressed', String(b.dataset.theme === theme));
  $('leftyToggle').setAttribute('aria-pressed', String(S.lefty));
  $('aimFrontToggle').setAttribute('aria-pressed', String(S.aimFront));
  $('soundToggle').setAttribute('aria-pressed', String(SND.on));
  $('volume').value = String(Math.round(SND.volume * 100));
  $('volume').disabled = !SND.on;
}
$('settingsBtn').onclick = () => { renderSettings(); $('settings').hidden = false; $('settingsClose').focus(); };
$('settingsClose').onclick = () => { $('settings').hidden = true; };
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').hidden = true; });
$('settings').addEventListener('keydown', (e) => { if (e.key === 'Escape') $('settings').hidden = true; });
for (const b of document.querySelectorAll('#settings .seg .toggle')) {
  b.onclick = () => {
    const t = b.dataset.theme;
    writeSetting('pool:theme', t === 'system' ? null : t);
    applyTheme(t);
    renderSettings();
  };
}
$('aimFrontToggle').onclick = () => {
  S.aimFront = !S.aimFront;
  writeSetting('pool:aim', S.aimFront ? 'front' : null);
  renderSettings();
};
$('leftyToggle').onclick = () => {
  applyLefty(!S.lefty);
  writeSetting('pool:lefty', S.lefty ? '1' : null);
  renderSettings();
};
$('soundToggle').onclick = () => { setSound(!SND.on); renderSettings(); };
$('volume').addEventListener('input', () => setVolume(Number($('volume').value) / 100));
$('volume').addEventListener('change', () => { const ctx = audio(); if (ctx) { clack(ctx, ctx.currentTime, 2.5); } });
$('hintsReset').onclick = () => {
  writeSetting('pool:hint', null);
  writeSetting('pool:hint:hand', null);
  $('powerHint').hidden = false;
  toast('Hints will show again');
};

function leaveRoom() {
  send({ type: 'leave' }); // frees the seat now (and forfeits a match in progress)
  S.intentionalClose = true;
  if (S.ws) S.ws.close();
  S.ws = null;
  stopHeartbeat();
  clearSession(S.roomCode);
  resetToLanding();
}
$('leave').onclick = leaveRoom;
$('leaveBtn').onclick = () => { if (matchLive()) openLeaveConfirm(); else leaveRoom(); };
$('leaveGame').onclick = leaveRoom;
$('lobbyCopy').onclick = copyInvite;
$('hintClose').onclick = () => {
  $('powerHint').hidden = true;
  try { localStorage.setItem('pool:hint', 'off'); } catch { /* storage unavailable */ }
};
try { if (localStorage.getItem('pool:hint') === 'off') $('powerHint').hidden = true; } catch { /* storage unavailable */ }

// Theme: 'dark' | 'light' forces one; anything else follows the system.
function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

// boot
(function init() {
  try { applyTheme(localStorage.getItem('pool:theme')); } catch { /* storage unavailable */ }
  try { if (localStorage.getItem('pool:lefty') === '1') powerBar.classList.add('pbar--left'), S.lefty = true; } catch { /* storage unavailable */ }
  $('name').value = rememberedName() || randomName();
  const room = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (room) $('code').value = room;
  new ResizeObserver(resize).observe($('tableWrap'));
  window.addEventListener('orientationchange', () => setTimeout(resize, 100));
  resize();
  refreshPanels();
  if (document.fonts && document.fonts.load) {
    document.fonts.load('600 13px "Source Sans 3"').then(() => renderTableCache()).catch(() => {});
  }
  requestAnimationFrame(draw);
  // A reloaded tab goes straight back to its seat.
  const saved = room ? loadSession(room) : null;
  if (saved && saved.token) {
    hideLanding();
    showSplash(room);
    S.seat = 0; // pretend we are seated so a failed join is handled as a lost connection
    S.token = saved.token;
    connectAndJoin(room, saved.name || 'Player', saved.token);
  } else {
    showLanding();
  }
})();
