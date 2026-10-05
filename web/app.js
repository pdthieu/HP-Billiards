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
const BALL_COLORS = {
  1: '#f2c230', 2: '#2457c5', 3: '#d8322c', 4: '#6b2fa0', 5: '#ee7b1d', 6: '#1f8a4c', 7: '#8b1a2b', 8: '#111',
};
const RENDER_DELAY_MS = 100;  // how far behind the newest snapshot we draw
const AIM_SEND_MS = 100;      // at most 10 aim messages per second
const PING_EVERY_MS = 15000;  // heartbeat; the server answers with pong
const PONG_TIMEOUT_MS = 10000;
const RECONNECT_MAX_MS = 8000;
const SEAT_HOLD_S = 60;       // how long the server holds a seat (PROTOCOL.md)
const ROOMS_POLL_MS = 3000;

// buildTable lays out cushions and pockets like Table.buildRails on the server.
function buildTable() {
  const a = CORNER_MOUTH / Math.SQRT2; // corner noses sit this far from the corner along each rail
  const s = SIDE_MOUTH / 2;
  const d = 1 / Math.SQRT2;
  const pockets = [
    { x: a / 2, y: a / 2, ax: -d, ay: -d, half: CORNER_MOUTH / 2, shelf: CORNER_SHELF },
    { x: W / 2, y: 0, ax: 0, ay: -1, half: s, shelf: SIDE_SHELF },
    { x: W - a / 2, y: a / 2, ax: d, ay: -d, half: CORNER_MOUTH / 2, shelf: CORNER_SHELF },
    { x: a / 2, y: H - a / 2, ax: -d, ay: d, half: CORNER_MOUTH / 2, shelf: CORNER_SHELF },
    { x: W / 2, y: H, ax: 0, ay: 1, half: s, shelf: SIDE_SHELF },
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

const OPTION_TEXT = {
  accept_table: ['Play from here', 'Accept the balls where they lie.'],
  rerack_break: ['Re-rack, I break', 'Rack again and take the break yourself.'],
  rerack_opponent_breaks: ['Re-rack, they break again', 'Rack again and make the opponent break once more.'],
  spot_eight: ['Spot the 8-ball', 'Put the 8 back on the foot spot and play on.'],
  rebreak: ['Re-rack, I break', 'Rack again and take the break yourself.'],
};
const FOUL_TEXT = {
  scratch: 'scratch',
  no_contact: 'no ball contacted',
  wrong_ball: 'wrong ball hit first',
  kitchen: 'illegal shot from the kitchen',
  no_rail: 'no rail after contact',
};

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
  pingTimer: 0,
  pongTimer: 0,

  // last room state from the server
  players: [
    { seat: 0, name: '', connected: false, ready: false },
    { seat: 1, name: '', connected: false, ready: false },
  ],
  phase: 'lobby',
  turn: 0,
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
  power: 0.6,
  spin: { x: 0, y: 0 },  // cue tip offset, unit disc; y > 0 is top spin
  powerDrag: false,      // the power bar is being pulled
  hoverBall: null,       // ball under the mouse, for its label
  call: null,            // {ball} or {safety: true}; no pocket is called
  roomsTimer: 0,
  aiming: false,
  dragCue: null,         // {x, y} while placing the cue ball
  cuePlacedAt: null,     // last place_cue we sent, kept until the server confirms
  lastAimSent: 0,
  aimTimer: 0,

  oppAim: null,          // {angle, power}
  lastDecisionReason: '',
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
      showDisconnected('This seat was taken over by another connection, probably another tab.', false);
      return;
    }
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  S.reconnectAttempt++;
  const delay = S.reconnectAttempt === 1 ? 300 : Math.min(RECONNECT_MAX_MS, 1000 * 2 ** (S.reconnectAttempt - 2));
  showDisconnected(
    `Connection lost. Reconnecting${S.reconnectAttempt > 1 ? ` (attempt ${S.reconnectAttempt})` : ''}… ` +
    `Your seat is held for ${SEAT_HOLD_S} seconds.`, true);
  clearTimeout(S.reconnectTimer);
  S.reconnectTimer = setTimeout(() => {
    S.reconnectTimer = 0;
    if (S.seat < 0 || S.ws) return;
    connectAndJoin(S.roomCode, S.name, S.token);
  }, delay);
}

function showDisconnected(text, retrying) {
  $('disconnectedText').textContent = text;
  $('rejoin').textContent = retrying ? 'Retry now' : 'Rejoin';
  $('disconnected').hidden = false;
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
    case 'aim': if (msg.seat !== S.seat) S.oppAim = { angle: msg.angle, power: msg.power }; break;
    case 'player': onPlayer(msg); break;
    case 'pong': clearTimeout(S.pongTimer); S.pongTimer = 0; break;
    case 'error': onError(msg); break;
  }
}

function onWelcome(msg) {
  const reconnected = S.seat >= 0 && S.reconnectAttempt > 0;
  S.seat = msg.seat;
  S.token = msg.token;
  S.roomCode = msg.roomCode;
  S.reconnectAttempt = 0;
  $('roomCode').textContent = msg.roomCode;
  history.replaceState(null, '', `/?room=${encodeURIComponent(msg.roomCode)}`);
  $('landing').hidden = true;
  $('disconnected').hidden = true;
  stopRoomsPoll();
  saveSession();
  if (reconnected) toast('Reconnected');
}

function applyRules(msg) {
  const turnChanged = msg.turn !== S.turn || msg.phase !== S.phase;
  S.phase = msg.phase;
  S.turn = msg.turn;
  S.groups = msg.groups;
  S.ballInHand = msg.ballInHand;
  S.kitchen = msg.kitchen;
  S.decision = msg.decision || null;
  S.winner = msg.winner === undefined ? null : msg.winner;
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
  const hadDecision = !!S.decision;
  const turnChanged = applyRules(msg);
  S.cuePlacedAt = null;
  S.dragCue = null;
  if (turnChanged || (hadDecision && !S.decision)) newTurn();
  if (prevPhase !== 'lobby' && msg.phase === 'lobby') {
    setStatus('The game was abandoned. Back to the lobby.', 'foul');
  } else if (msg.phase === 'breaking' && prevPhase !== 'breaking') {
    setStatus(`${nameOf(msg.turn)} ${isMe(msg.turn) ? 'break' : 'breaks'}. Place the cue ball in the kitchen and shoot.`);
  } else if (msg.phase === 'lobby') {
    setStatus('');
  }
  refreshPanels();
}

function onSnapshot(msg) {
  const balls = new Map(msg.balls.map((b) => [b.id, { x: b.x, y: b.y }]));
  if (msg.t === 0 || !S.moving || S.snaps.length === 0) {
    // A new shot, or joining one midway (reconnect): align our clock to it.
    S.snaps = [];
    S.shotWall0 = performance.now() - msg.t;
    S.moving = true;
    S.oppAim = null;
    S.aiming = false;
    S.dragCue = null;
    S.cuePlacedAt = null;
  }
  S.snaps.push({ t: msg.t, balls });
  refreshPanels();
}

function onSettled(msg) {
  S.moving = false;
  S.snaps = [];
  setBalls(msg.balls);
  S.oppAim = null;
  applyRules(msg);
  newTurn();
  describeShot(msg);
  refreshPanels();
}

function onPlayer(msg) {
  const was = S.players[msg.seat];
  S.players[msg.seat] = { seat: msg.seat, name: msg.name, connected: msg.connected, ready: msg.ready };
  if (msg.seat !== S.seat) {
    if (msg.connected && !was.connected) {
      toast(was.name ? `${msg.name} is back` : `${msg.name} joined`);
    } else if (!msg.connected && was.connected && msg.name) {
      toast(`${msg.name} lost connection`);
      setStatus(`${msg.name} lost connection. Their seat is held for ${SEAT_HOLD_S} seconds.`, 'foul');
    } else if (!msg.connected && !msg.name && was.name) {
      toast(`${was.name} left`);
    }
  }
  refreshPanels();
}

function onError(msg) {
  toast(msg.message || msg.code, true);
  if (msg.code === 'bad_placement' || msg.code === 'no_ball_in_hand') {
    S.dragCue = null;
    S.cuePlacedAt = null;
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

// resetToLanding forgets the room and shows the landing form.
function resetToLanding(error) {
  clearTimeout(S.reconnectTimer);
  S.reconnectTimer = 0;
  S.reconnectAttempt = 0;
  S.seat = -1;
  S.token = '';
  S.phase = 'lobby';
  S.moving = false;
  S.snaps = [];
  S.decision = null;
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
  S.call = null;
  S.aiming = false;
  S.dragCue = null;
  S.cuePlacedAt = null;
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
  const parts = [];
  const who = nameOf(msg.shooter);
  const made = msg.pocketed.filter((id) => id !== 0);
  if (msg.illegalBreak) parts.push(`Illegal break by ${who}.`);
  if (msg.foul) parts.push(`Foul by ${who}: ${FOUL_TEXT[msg.foul] || msg.foul}.`);
  if (made.length) parts.push(`Pocketed ${made.map(ballName).join(', ')}.`);
  if (msg.calledMade && !msg.foul) parts.push('Called shot made.');
  if (msg.winner !== undefined && msg.winner !== null) {
    parts.push(isMe(msg.winner) ? 'You win!' : `${nameOf(msg.winner)} wins.`);
  } else if (msg.decision) {
    parts.push(`${nameOf(msg.decision.seat)} ${isMe(msg.decision.seat) ? 'choose' : 'chooses'} how to continue.`);
  } else {
    let t = isMe(msg.turn) ? 'Your turn' : `${nameOf(msg.turn)}'s turn`;
    if (msg.ballInHand) t += msg.kitchen ? ', ball in hand in the kitchen' : ', ball in hand';
    parts.push(t + '.');
  }
  if (msg.illegalBreak) {
    S.lastDecisionReason = `${who} broke illegally: nothing pocketed and fewer than four balls reached a rail.`;
  } else if (msg.decision) {
    S.lastDecisionReason = `${who} pocketed the 8-ball on the break.`;
  }
  setStatus(parts.join(' '), msg.foul ? 'foul' : (msg.calledMade ? 'good' : ''));
}

// ---------------------------------------------------------------------------
// 3. shot logic

const isMe = (seat) => seat === S.seat;
const nameOf = (seat) => (isMe(seat) ? 'You' : (S.players[seat].name || `Player ${seat + 1}`));
const groupOf = (id) => (id >= 1 && id <= 7 ? 'solids' : id >= 9 && id <= 15 ? 'stripes' : '');
const ballName = (id) => (id === 8 ? 'the 8-ball' : `the ${id}`);
const inPlay = () => !S.decision && (S.phase === 'breaking' || S.phase === 'open' || S.phase === 'assigned');
const isMyShot = () => S.seat >= 0 && inPlay() && !S.moving && S.turn === S.seat;
const needsCall = () => S.phase !== 'breaking';

function remaining(group) {
  let n = 0;
  for (const id of S.balls.keys()) if (groupOf(id) === group) n++;
  return n;
}

// legalTargets mirrors Rules.legalTarget on the server for highlighting.
function legalTargets() {
  const out = new Set();
  if (S.phase === 'breaking') return out;
  const mine = S.groups[S.seat];
  let eightOn = false;
  if (S.phase === 'open') eightOn = remaining('solids') === 0 || remaining('stripes') === 0;
  else if (S.phase === 'assigned') eightOn = remaining(mine) === 0;
  for (const id of S.balls.keys()) {
    if (id === 0) continue;
    if (S.phase === 'open' && (id !== 8 || eightOn)) out.add(id);
    else if (S.phase === 'assigned' && (eightOn ? id === 8 : groupOf(id) === mine)) out.add(id);
  }
  return out;
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
  if (!isMyShot() || S.dragCue) return false;
  if (!needsCall()) return true;
  return S.call !== null;
}

function shoot() {
  if (!canShoot()) return;
  const msg = { type: 'shoot', angle: S.angle, power: S.power };
  if (needsCall()) msg.call = S.call.safety ? { safety: true } : { ball: S.call.ball };
  if (S.spin.x || S.spin.y) msg.spin = { x: S.spin.x, y: S.spin.y };
  send(msg);
}

// --- power bar: pull down, release to shoot -------------------------------

const powerBar = $('powerBar');

function renderPower() {
  $('powerFill').style.height = `${Math.round(S.power * 100)}%`;
  $('powerLabel').textContent = S.powerDrag ? `${Math.round(S.power * 100)}%` : `${Math.round(S.power * 100)}% · pull`;
}

function barPower(e) {
  const rect = powerBar.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
}

powerBar.addEventListener('pointerdown', (e) => {
  if (!isMyShot()) return;
  e.preventDefault();
  powerBar.setPointerCapture(e.pointerId);
  S.powerDrag = true;
  powerBar.classList.add('dragging');
  setPower(barPower(e), true);
});
powerBar.addEventListener('pointermove', (e) => {
  if (S.powerDrag) setPower(barPower(e), true);
});
function endPowerDrag(e, fire) {
  if (!S.powerDrag) return;
  S.powerDrag = false;
  powerBar.classList.remove('dragging');
  const p = barPower(e);
  if (fire && p >= 0.08) {
    setPower(p);
    if (canShoot()) shoot();
    else toast(needsCall() && !S.call ? 'Tap the ball you are going for first' : 'Cannot shoot now', true);
  } else {
    renderPower();
    if (fire) toast('Shot cancelled');
  }
}
powerBar.addEventListener('pointerup', (e) => endPowerDrag(e, true));
powerBar.addEventListener('pointercancel', (e) => endPowerDrag(e, false));

// --- spin pad: where the tip strikes the cue ball --------------------------

const spinCanvas = $('spinCanvas');
const SPIN_LIMIT = 0.72; // of the drawn ball radius: beyond this a real shot miscues

function renderSpin() {
  const c = spinCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const size = 72;
  if (spinCanvas.width !== size * dpr) { spinCanvas.width = size * dpr; spinCanvas.height = size * dpr; }
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2, r = size / 2 - 2;
  const g = c.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(1, '#cfc9b8');
  c.fillStyle = g;
  c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#00000033';
  c.setLineDash([3, 3]);
  c.beginPath(); c.arc(cx, cy, r * SPIN_LIMIT, 0, Math.PI * 2); c.stroke();
  c.setLineDash([]);
  c.beginPath(); c.moveTo(cx - r, cy); c.lineTo(cx + r, cy); c.moveTo(cx, cy - r); c.lineTo(cx, cy + r); c.stroke();
  const px = cx + S.spin.x * r * SPIN_LIMIT, py = cy - S.spin.y * r * SPIN_LIMIT;
  c.fillStyle = '#d8322c';
  c.beginPath(); c.arc(px, py, 5, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.stroke();
  const parts = [];
  if (S.spin.y > 0.15) parts.push('top'); else if (S.spin.y < -0.15) parts.push('draw');
  if (S.spin.x > 0.15) parts.push('right'); else if (S.spin.x < -0.15) parts.push('left');
  $('spinText').textContent = parts.length ? parts.join(' + ') : 'centre';
}

function setSpinFromEvent(e) {
  const rect = spinCanvas.getBoundingClientRect();
  const r = rect.width / 2;
  let x = (e.clientX - rect.left - r) / (r * SPIN_LIMIT);
  let y = -(e.clientY - rect.top - r) / (r * SPIN_LIMIT);
  const l = Math.hypot(x, y);
  if (l > 1) { x /= l; y /= l; }
  S.spin = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
  renderSpin();
}
let spinDrag = false;
spinCanvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  spinDrag = true;
  spinCanvas.setPointerCapture(e.pointerId);
  setSpinFromEvent(e);
});
spinCanvas.addEventListener('pointermove', (e) => { if (spinDrag) setSpinFromEvent(e); });
const endSpin = () => { spinDrag = false; };
spinCanvas.addEventListener('pointerup', endSpin);
spinCanvas.addEventListener('pointercancel', endSpin);
$('spinReset').onclick = () => { S.spin = { x: 0, y: 0 }; renderSpin(); };

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
  S.power = Math.max(0.05, Math.min(1, p));
  renderPower();
  queueAim();
}

// ---------------------------------------------------------------------------
// 4. rendering

const canvas = $('table');
const ctx = canvas.getContext('2d');
const view = { s: 1, ox: 0, oy: 0, rotated: false, cssW: 0, cssH: 0 };

function resize() {
  const wrap = $('tableWrap');
  const cs = getComputedStyle(wrap);
  const availW = Math.max(100, wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
  const availH = Math.max(100, wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
  const fullW = W + 2 * RAIL, fullH = H + 2 * RAIL;
  const sLand = Math.min(availW / fullW, availH / fullH);
  const sPort = Math.min(availW / fullH, availH / fullW);
  view.rotated = sPort > sLand * 1.15; // only rotate when it is clearly better
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
}

// toTable converts a pointer position (CSS px within the canvas) to meters.
function toTable(px, py) {
  if (!view.rotated) return { x: (px - view.ox) / view.s, y: (py - view.oy) / view.s };
  return { x: W - (py - view.oy) / view.s, y: (px - view.ox) / view.s };
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
    if (S.dragCue || S.cuePlacedAt) {
      const m = new Map(S.balls);
      m.set(0, S.dragCue || S.cuePlacedAt);
      return m;
    }
    return S.balls;
  }
  const t = performance.now() - S.shotWall0 - RENDER_DELAY_MS;
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

function draw() {
  requestAnimationFrame(draw);
  if (!view.cssW) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  applyTableTransform();

  drawTable();
  const balls = displayBalls();
  const myShot = isMyShot();
  const targets = myShot && needsCall() ? legalTargets() : null;

  // aim lines go under the balls
  const cue = balls.get(0);
  if (cue && myShot && !S.dragCue) drawAim(balls, cue, S.angle, S.power, true);
  else if (cue && S.oppAim && inPlay() && !S.moving && S.turn !== S.seat) {
    drawAim(balls, cue, S.oppAim.angle, S.oppAim.power, false);
  }

  for (const [id, p] of balls) drawBall(id, p);
  if (S.hoverBall !== null && balls.has(S.hoverBall)) drawBallLabel(S.hoverBall, balls.get(S.hoverBall));

  if (targets) {
    for (const id of targets) {
      const p = balls.get(id);
      if (!p) continue;
      ring(p, R + 0.012, S.call && S.call.ball === id ? '#f0b429' : '#ffffff88', 0.006);
    }
  }
  if (myShot && S.ballInHand && cue) {
    ring(cue, R + 0.016, S.dragCue ? '#ffffff' : '#4cc38a', 0.006);
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawTable() {
  // wooden rails
  roundRect(-RAIL, -RAIL, W + 2 * RAIL, H + 2 * RAIL, 0.06);
  ctx.fillStyle = '#5a3a1e';
  ctx.fill();
  // felt, running under the cushions and into the pocket mouths
  ctx.fillStyle = '#2b8a4a';
  ctx.fillRect(-CUSHION, -CUSHION, W + 2 * CUSHION, H + 2 * CUSHION);
  // pocket holes: a circle behind each mouth, reaching the drop line
  for (const pk of POCKETS) {
    const r = pk.half + 0.008;
    const depth = pk.shelf + 0.012;
    ctx.fillStyle = '#0b0b0b';
    ctx.beginPath();
    ctx.arc(pk.x + pk.ax * depth, pk.y + pk.ay * depth, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // cushions: the nose line, with the jaws angled into the pockets
  ctx.fillStyle = '#1e6b3a';
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
  // kitchen highlight while placing there
  if (isMyShot() && S.ballInHand && S.kitchen) {
    ctx.fillStyle = '#ffffff18';
    ctx.fillRect(0, 0, HEAD, H);
  }
  // head string and foot spot
  ctx.strokeStyle = '#ffffff40';
  ctx.lineWidth = 0.003;
  ctx.beginPath();
  ctx.moveTo(HEAD, 0);
  ctx.lineTo(HEAD, H);
  ctx.stroke();
  ctx.fillStyle = '#ffffff50';
  ctx.beginPath();
  ctx.arc(FOOT.x, FOOT.y, 0.006, 0, Math.PI * 2);
  ctx.fill();
}

function ring(p, r, color, width, label) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.stroke();
  if (label !== undefined) {
    ctx.save();
    ctx.translate(p.x, p.y);
    if (view.rotated) ctx.rotate(Math.PI / 2);
    ctx.fillStyle = color;
    ctx.font = `bold ${0.05}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(label + 1), 0, 0);
    ctx.restore();
  }
}

function drawBall(id, p) {
  const color = id === 0 ? '#f4f1e6' : BALL_COLORS[id > 8 ? id - 8 : id];
  ctx.save();
  ctx.translate(p.x, p.y);
  // shadow
  ctx.fillStyle = '#00000040';
  ctx.beginPath();
  ctx.arc(0.004, 0.005, R, 0, Math.PI * 2);
  ctx.fill();
  // body
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fillStyle = id > 8 ? '#f4f1e6' : color;
  ctx.fill();
  if (id > 8) {
    ctx.save();
    ctx.clip();
    if (view.rotated) ctx.rotate(Math.PI / 2);
    ctx.fillStyle = color;
    ctx.fillRect(-R, -R * 0.55, 2 * R, R * 1.1);
    ctx.restore();
  }
  // highlight
  const g = ctx.createRadialGradient(-R * 0.35, -R * 0.35, R * 0.1, 0, 0, R);
  g.addColorStop(0, '#ffffff66');
  g.addColorStop(0.5, '#ffffff10');
  g.addColorStop(1, '#00000033');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fill();
  // number
  if (id !== 0) {
    if (view.rotated) ctx.rotate(Math.PI / 2);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.font = `bold ${R * 0.7}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(id), 0, R * 0.03);
  }
  ctx.restore();
}

// drawBallLabel names the ball under the mouse, just above it.
function drawBallLabel(id, p) {
  const text = id === 0 ? 'cue ball' : id === 8 ? '8-ball' : `${id} · ${groupOf(id)}`;
  ctx.save();
  ctx.translate(p.x, p.y);
  if (view.rotated) ctx.rotate(Math.PI / 2);
  ctx.font = `600 ${0.038}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 0.03;
  const h = 0.055;
  const y = -(R + 0.05);
  roundRect(-w / 2, y - h / 2, w, h, 0.012);
  ctx.fillStyle = '#15181cee';
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(text, 0, y + 0.002);
  ctx.restore();
}

function drawAim(balls, cue, angle, power, mine) {
  const cast = castAim(balls, cue, angle);
  const alpha = mine ? 1 : 0.55;
  ctx.save();
  ctx.globalAlpha = alpha;
  // path to the ghost ball
  ctx.strokeStyle = '#ffffffcc';
  ctx.lineWidth = 0.004;
  ctx.setLineDash([0.02, 0.015]);
  ctx.beginPath();
  ctx.moveTo(cue.x, cue.y);
  ctx.lineTo(cast.ghost.x, cast.ghost.y);
  ctx.stroke();
  ctx.setLineDash([]);
  // ghost ball
  ctx.beginPath();
  ctx.arc(cast.ghost.x, cast.ghost.y, R, 0, Math.PI * 2);
  ctx.stroke();
  if (cast.objDir) {
    const b = balls.get(cast.hit);
    ctx.strokeStyle = '#f0b429cc';
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x + cast.objDir.x * 0.3, b.y + cast.objDir.y * 0.3);
    ctx.stroke();
    if (cast.cueDir) {
      ctx.strokeStyle = '#ffffff88';
      ctx.beginPath();
      ctx.moveTo(cast.ghost.x, cast.ghost.y);
      ctx.lineTo(cast.ghost.x + cast.cueDir.x * 0.15, cast.ghost.y + cast.cueDir.y * 0.15);
      ctx.stroke();
    }
  }
  // cue stick behind the cue ball, pulled back with power
  const back = R + 0.02 + power * 0.12;
  const len = 1.2;
  const d = cast.dir;
  const x0 = cue.x - d.x * back, y0 = cue.y - d.y * back;
  const x1 = cue.x - d.x * (back + len), y1 = cue.y - d.y * (back + len);
  const grad = ctx.createLinearGradient(x0, y0, x1, y1);
  grad.addColorStop(0, '#e8d7b0');
  grad.addColorStop(0.2, '#b07a3c');
  grad.addColorStop(1, '#3b2412');
  ctx.strokeStyle = grad;
  ctx.lineCap = 'round';
  ctx.lineWidth = 0.014;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 5. input

function pointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  return toTable(e.clientX - rect.left, e.clientY - rect.top);
}

function hitBall(p, balls, skipCue) {
  let best = null;
  for (const [id, b] of balls) {
    if (skipCue && id === 0) continue;
    const d = Math.hypot(b.x - p.x, b.y - p.y);
    if (d < R * 1.8 && (!best || d < best.d)) best = { id, d };
  }
  return best ? best.id : null;
}

function clampCue(p) {
  const maxX = S.kitchen ? HEAD : W - R;
  return {
    x: Math.min(maxX, Math.max(R, p.x)),
    y: Math.min(H - R, Math.max(R, p.y)),
  };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!isMyShot()) return;
  e.preventDefault();
  const p = pointerPos(e);
  const balls = displayBalls();
  const cue = balls.get(0);

  if (S.ballInHand && cue && Math.hypot(cue.x - p.x, cue.y - p.y) < R * 2.5) {
    S.dragCue = clampCue(p);
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (needsCall()) {
    const id = hitBall(p, balls, true);
    if (id !== null) {
      if (legalTargets().has(id)) {
        S.call = { ball: id };
        refreshShotPanel();
      } else {
        toast(`${ballName(id)[0].toUpperCase() + ballName(id).slice(1)} is not a legal target`, true);
      }
      return;
    }
  }
  if (cue) {
    S.aiming = true;
    canvas.setPointerCapture(e.pointerId);
    setAngle(Math.atan2(p.y - cue.y, p.x - cue.x));
  }
});

canvas.addEventListener('pointermove', (e) => {
  const p = pointerPos(e);
  if (e.pointerType === 'mouse' && !S.dragCue && !S.aiming) {
    S.hoverBall = hitBall(p, displayBalls(), false);
  }
  if (!isMyShot()) return;
  if (S.dragCue) {
    S.dragCue = clampCue(p);
  } else if (S.aiming) {
    const cue = displayBalls().get(0);
    if (cue) setAngle(Math.atan2(p.y - cue.y, p.x - cue.x));
  }
});

function endPointer(e) {
  if (S.dragCue) {
    const pos = S.dragCue;
    S.dragCue = null;
    S.cuePlacedAt = pos;
    send({ type: 'place_cue', x: pos.x, y: pos.y });
  }
  S.aiming = false;
  if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { S.hoverBall = null; });

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
  if (!isMyShot()) return;
  const step = e.shiftKey ? 0.05 * DEG : 0.5 * DEG;
  switch (e.key) {
    case 'ArrowLeft': setAngle(S.angle - step); break;
    case 'ArrowRight': setAngle(S.angle + step); break;
    case 'ArrowUp': setPower(S.power + 0.05); break;
    case 'ArrowDown': setPower(S.power - 0.05); break;
    case ' ': case 'Enter': if (canShoot()) shoot(); break;
    case 's': case 'S': if (needsCall()) toggleSafety(); break;
    default: return;
  }
  e.preventDefault();
});

// ---------------------------------------------------------------------------
// 6. panels

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = cls || '';
}

function toast(text, isError) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.remove(), 3600);
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
  $('disconnected').hidden = true;
  $('landingError').hidden = !error;
  $('landingError').textContent = error || '';
  if (!$('name').value.trim()) $('name').value = rememberedName() || randomName();
  // An invite link opens straight onto "join this room": the name is the
  // only thing to fill in.
  const code = $('code').value.trim().toUpperCase();
  const invited = /^[A-Z]{5}$/.test(code) && !!new URLSearchParams(location.search).get('room');
  $('landingTitle').textContent = invited ? `Join room ${code}` : '8-ball';
  $('landingLead').textContent = invited
    ? 'Enter your name to take the free seat.'
    : 'Two players, one table. WPA 8-ball rules: call your shots.';
  $('createRow').hidden = invited;
  $('roomsBox').hidden = invited;
  $('code').hidden = invited;
  $('join').classList.toggle('primary', invited);
  $('join').textContent = invited ? 'Join' : 'Join by code';
  $('switchMode').hidden = !invited;
  setTimeout(() => $('name').focus(), 0);
  if (!invited) startRoomsPoll(); else stopRoomsPoll();
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
function renderRooms(list) {
  const ul = $('roomList');
  ul.replaceChildren();
  if (!list.rooms.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = 'No rooms yet. Create one.';
    ul.append(li);
  }
  for (const room of list.rooms) {
    const li = document.createElement('li');
    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = room.roomCode;
    const who = document.createElement('span');
    who.className = 'who';
    const names = room.players.filter(Boolean);
    const phase = room.phase === 'lobby' ? 'in the lobby' : room.phase === 'game_over' ? 'finished a game' : 'playing';
    who.textContent = names.length ? `${names.join(' vs ')} · ${phase}` : 'empty';
    const btn = document.createElement('button');
    btn.className = 'btn btn--secondary btn--small';
    if (room.seated < 2) {
      btn.textContent = 'Join';
      btn.type = 'button';
      btn.onclick = () => {
        const name = landingName();
        if (!name) return;
        connectAndJoin(room.roomCode, name);
      };
    } else {
      btn.textContent = 'Full';
      btn.disabled = true;
    }
    li.append(code, who, btn);
    ul.append(li);
  }
  const full = list.rooms.length >= list.max;
  $('create').disabled = full;
  $('createNote').hidden = !full;
  $('createNote').textContent = full ? `All ${list.max} rooms are in use; join one below.` : '';
}

function renderSeat(seat) {
  const el = $(`seat${seat}`);
  const p = S.players[seat];
  el.className = 'seat';
  el.replaceChildren();
  if (!p.connected && !p.name) {
    el.classList.add('empty');
    el.append(Object.assign(document.createElement('span'), { className: 'name', textContent: 'waiting…' }));
    return;
  }
  if (!p.connected) el.classList.add('held');
  if ((inPlay() || S.moving) && S.turn === seat) el.classList.add('turn');
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = p.name;
  el.append(name);
  if (isMe(seat)) el.append(tag('you', 'you'));
  if (!p.connected) el.append(tag('offline', 'offline'));
  if (S.phase === 'lobby' && p.ready) el.append(tag('ready', 'ready'));
  const g = S.groups[seat];
  if (g) {
    const group = document.createElement('span');
    group.className = 'group';
    group.title = g;
    for (let i = 1; i <= 7; i++) {
      const id = g === 'solids' ? i : i + 8;
      const dot = document.createElement('i');
      dot.style.background = S.balls.has(id) ? BALL_COLORS[i] : '#0000';
      group.append(dot);
    }
    el.append(group);
  }
}

function tag(text, cls) {
  const t = document.createElement('span');
  t.className = `tag ${cls}`;
  t.textContent = text;
  return t;
}

function renderTrays() {
  for (const [elId, first] of [['traySolids', 1], ['trayStripes', 9]]) {
    const el = $(elId);
    el.replaceChildren();
    if (S.phase === 'lobby') continue;
    for (let id = first; id < first + 7; id++) {
      const i = document.createElement('i');
      const c = BALL_COLORS[id > 8 ? id - 8 : id];
      i.style.setProperty('--c', c);
      if (id > 8) i.classList.add('stripe'); else i.style.background = c;
      if (!S.balls.has(id)) i.classList.add('down');
      const n = document.createElement('span');
      n.textContent = id;
      i.append(n);
      el.append(i);
    }
  }
}

function refreshPanels() {
  renderSeat(0);
  renderSeat(1);
  renderTrays();
  const me = S.seat >= 0 ? S.players[S.seat] : null;
  const opp = S.seat >= 0 ? S.players[1 - S.seat] : null;

  $('lobbyPanel').hidden = S.phase !== 'lobby';
  $('overPanel').hidden = S.phase !== 'game_over';
  const myShot = isMyShot();
  $('shotPanel').hidden = !myShot;
  $('powerBar').hidden = !myShot;
  if (!myShot && S.powerDrag) { S.powerDrag = false; powerBar.classList.remove('dragging'); }
  $('waitPanel').hidden = S.phase === 'lobby' || S.phase === 'game_over' || myShot;

  if (S.phase === 'lobby' && me) {
    $('ready').disabled = me.ready;
    $('ready').textContent = me.ready ? 'Ready ✓' : "I'm ready";
    $('lobbyText').textContent = !opp.connected
      ? (opp.name ? `${opp.name} is offline; their seat is held for a moment.` : 'Waiting for an opponent. Share the room link.')
      : me.ready ? `Waiting for ${opp.name} to be ready.` : `${opp.name} is here. Ready when you are.`;
  }
  if (myShot) refreshShotPanel();
  if (!$('waitPanel').hidden) {
    let t;
    if (S.moving) t = 'Balls are rolling…';
    else if (opp && opp.name && !opp.connected) t = `Waiting for ${opp.name} to reconnect…`;
    else if (S.decision) t = isMe(S.decision.seat) ? 'Your decision.' : `Waiting for ${nameOf(S.decision.seat)} to decide.`;
    else t = `${nameOf(S.turn)}'s turn.${S.ballInHand ? ' Ball in hand.' : ''}`;
    $('waitText').textContent = t;
  }
  if (S.phase === 'game_over') {
    $('overText').textContent = S.winner === null ? 'Game over.' : (isMe(S.winner) ? 'You win! 🎉' : `${nameOf(S.winner)} wins.`);
    $('rematchNote').textContent = 'Either player can start the next rack; the break alternates.';
  }
  refreshDecision();
}

function refreshShotPanel() {
  const callEl = $('callText');
  callEl.classList.remove('set');
  $('clearCall').hidden = true;
  $('safety').hidden = !needsCall();
  $('safety').setAttribute('aria-pressed', String(!!(S.call && S.call.safety)));
  if (!needsCall()) {
    callEl.textContent = S.ballInHand ? 'Break: drag the cue ball to place it, drag on the felt to aim.' : 'Break: no call needed.';
  } else if (S.call && S.call.safety) {
    callEl.textContent = 'Safety: the turn passes after this shot.';
    callEl.classList.add('set');
    $('clearCall').hidden = false;
  } else if (S.call) {
    callEl.textContent = `Called: ${ballName(S.call.ball)}`;
    callEl.classList.add('set');
    $('clearCall').hidden = false;
  } else {
    callEl.textContent = S.ballInHand
      ? 'Ball in hand: drag the cue ball, then tap the ball you are going for.'
      : 'Tap the ball you are going for to call it.';
  }
  setAngle(S.angle);
  renderPower();
  renderSpin();
}

function toggleSafety() {
  S.call = S.call && S.call.safety ? null : { safety: true };
  refreshShotPanel();
}

function refreshDecision() {
  const d = S.decision;
  const show = d && isMe(d.seat) && !S.moving;
  $('decision').hidden = !show;
  if (!show) return;
  const eight = d.options.includes('spot_eight');
  $('decisionTitle').textContent = eight ? '8-ball on the break' : 'Illegal break';
  $('decisionText').textContent = S.lastDecisionReason || '';
  const box = $('decisionOptions');
  box.replaceChildren();
  for (const opt of d.options) {
    const [title, desc] = OPTION_TEXT[opt] || [opt, ''];
    const b = document.createElement('button');
    b.className = 'btn btn--secondary';
    b.append(title);
    if (desc) b.append(Object.assign(document.createElement('small'), { textContent: desc }));
    b.onclick = () => { send({ type: 'choose', option: opt }); $('decision').hidden = true; };
    box.append(b);
  }
}

// ---------------------------------------------------------------------------
// wiring

$('ready').onclick = () => send({ type: 'ready' });
$('rematch').onclick = () => send({ type: 'rematch' });
$('safety').onclick = toggleSafety;
$('clearCall').onclick = () => { S.call = null; refreshShotPanel(); };
for (const b of document.querySelectorAll('.nudge')) {
  b.onclick = () => setAngle(S.angle + Number(b.dataset.deg) * DEG);
}
$('copyLink').onclick = async () => {
  const url = `${location.origin}/?room=${S.roomCode}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied');
  } catch {
    toast(url);
  }
};

// landingName returns the typed name, or null (with an error shown) if it
// is empty.
function landingName() {
  const name = $('name').value.trim();
  if (!name) {
    showLanding('Please enter your name first.');
    $('name').focus();
    return null;
  }
  rememberName(name);
  return name;
}
$('create').onclick = async () => {
  const name = landingName();
  if (!name) return;
  $('landingError').hidden = true;
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
    const { roomCode } = body;
    $('code').value = roomCode;
    connectAndJoin(roomCode, name);
  } catch (err) {
    showLanding(`Could not create a room: ${err.message}`);
  }
};
$('landingForm').onsubmit = (e) => {
  e.preventDefault();
  const name = landingName();
  if (!name) return;
  const code = $('code').value.trim().toUpperCase();
  if (code.length !== 5) { showLanding('Room codes have 5 letters.'); return; }
  connectAndJoin(code, name);
};
$('rejoin').onclick = () => { $('disconnected').hidden = true; connectAndJoin(S.roomCode, S.name, S.token); };
$('leave').onclick = () => {
  S.intentionalClose = true;
  if (S.ws) S.ws.close();
  S.ws = null;
  stopHeartbeat();
  clearSession(S.roomCode);
  resetToLanding();
};

// Theme: 'dark' | 'light' forces one; anything else follows the system.
function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

// boot
(function init() {
  try { applyTheme(localStorage.getItem('pool:theme')); } catch { /* storage unavailable */ }
  $('name').value = rememberedName() || randomName();
  const room = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (room) $('code').value = room;
  new ResizeObserver(resize).observe($('tableWrap'));
  window.addEventListener('orientationchange', () => setTimeout(resize, 100));
  resize();
  refreshPanels();
  requestAnimationFrame(draw);
  // A reloaded tab goes straight back to its seat.
  const saved = room ? loadSession(room) : null;
  if (saved && saved.token) {
    $('landing').hidden = true;
    showDisconnected(`Rejoining room ${room}…`, true);
    S.seat = 0; // pretend we are seated so a failed join is handled as a lost connection
    S.token = saved.token;
    connectAndJoin(room, saved.name || 'Player', saved.token);
  } else {
    showLanding();
  }
})();
