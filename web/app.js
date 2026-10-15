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

// The language (i18n.js): the page's own words are read in English first,
// before anything here writes to it, then shown in the language picked.
LANG = detectLang();
document.documentElement.lang = LANG;
collectStatic();
applyStatic();

// ---------------------------------------------------------------------------
// 1. constants and state

const DEG = Math.PI / 180;
// The table follows the room's game (setTable): a 9 ft pool table, or a
// carom table for 3-cushion (game.CaromConfig on the server).
let W = 2.54;              // playing surface, meters
let H = 1.27;
let R = 0.028575;          // ball radius
let HEAD = W / 4;          // head string; the kitchen is x <= HEAD
let FOOT = { x: W * 3 / 4, y: H / 2 };
const RAIL = 0.1;          // drawn wooden rail width beyond the cushions
const CUSHION = 0.045;     // drawn cushion depth behind the nose line
const RAIL_TOP = 0.044;    // the rail's top above the bed in 3D (view3d.js RAIL_H)
const FLOOR_DROP = 0.78;   // the floor below the bed in 3D (view3d.js FLOOR)
// The 3D arena's LED boards stand round the floor of play this far beyond
// the rails, at the ends and along the sides (arena3d.js), BOARD_TOP high
// above the bed: a ball rolling off the table bounces back off them.
const BOARDS_END = 2.4, BOARDS_SIDE = 2.0, BOARD_TOP = 1.0 - FLOOR_DROP;
const boardsRect = () => ({ x0: -RAIL - BOARDS_END, x1: W + RAIL + BOARDS_END, y0: -RAIL - BOARDS_SIDE, y1: H + RAIL + BOARDS_SIDE });
const INCH = 0.0254;
// TABLES: the pool tables a room can play on (PROTOCOL.md, "Tables"), by
// their pockets, which are all that differs: the mouths between the cushion
// noses, the cuts (degrees) and the shelves. Keep in sync with game.Tables
// on the server. How each looks is in LOOKS.
const TABLES = {
  diamond: { name: 'Diamond Pro-Am', corner: 4.5 * INCH, side: 5 * INCH, cornerJaw: 141, sideJaw: 102, cornerShelf: 0.0316, sideShelf: 0.25 * INCH },
  predator: { name: 'Predator Apex', corner: 0.108, side: 0.125, cornerJaw: 142, sideJaw: 104, cornerShelf: 1.75 * INCH, sideShelf: 0.25 * INCH },
  rasson: { name: 'Rasson Victory II', corner: 4.25 * INCH, side: 5 * INCH, cornerJaw: 142, sideJaw: 104, cornerShelf: 0.0212, sideShelf: 0.25 * INCH },
  acurra: { name: 'Mr-Sung Acurra', corner: 4 * INCH, side: 4.5 * INCH, cornerJaw: 142, sideJaw: 104, cornerShelf: 1.75 * INCH, sideShelf: 0.25 * INCH },
};
const DEFAULT_TABLE = 'diamond';
let SPEC = TABLES[DEFAULT_TABLE]; // the pool table's pockets (setTable)

// LOOKS: how each table is finished (CLIENT.md, "Tables"): its rail from the
// top edge to the foot (2D draws the three as a gradient, 3D the middle one,
// glossy or matte), the cabinet under it, its legs (view3d.js), a metal trim
// along the rail, the sights and a metal rim round the pockets. The carom
// table keeps the wood the game was drawn with.
const LOOKS = {
  // Diamond: Dymondwood rails (walnut) on a black cabinet, tapered legs
  diamond: { railTop: '#6A4428', rail: '#4C2F1B', railBottom: '#341F10', gloss: true, cabinet: '#18181B', legs: 'tapered', trim: null, sight: '#E6D7B4', rim: null },
  // Predator Apex: all black, matte, light in the legs, flush silver rims
  predator: { railTop: '#2E3035', rail: '#1C1D21', railBottom: '#111215', gloss: false, cabinet: '#131417', legs: 'led', trim: null, sight: '#C9CED4', rim: '#C3C8CE', led: '#57B2FF' },
  // Rasson Victory II: black, glossy, with a silver trim, on V legs
  rasson: { railTop: '#36383D', rail: '#202226', railBottom: '#131417', gloss: true, cabinet: '#16171A', legs: 'v', trim: '#B8BDC3', sight: '#E9E6DE', rim: null },
  // Mr-Sung Acurra: grey wood (Sarum Strand) with aluminium strips, A legs
  acurra: { railTop: '#8C8E91', rail: '#6F7174', railBottom: '#4C4E51', gloss: false, cabinet: '#5F6164', legs: 'a', trim: '#C8CCD1', sight: '#EDEAE2', rim: null },
  carom: { railTop: '#6A4428', rail: '#4C2F1B', railBottom: '#341F10', gloss: true, cabinet: '#341F10', legs: 'tapered', trim: null, sight: '#E6D7B4', rim: null },
};
const look = () => LOOKS[tableKey] || LOOKS[DEFAULT_TABLE];

// CLOTHS: the cloth colours a room can pick (PROTOCOL.md, "Tables"), under
// Simonis's names. No maker publishes colour values: these are matched to
// their swatches by eye. clothShades lights the middle of the table and
// shades its edge; the cushions wear the same cloth, darker.
const CLOTHS = {
  'tournament-blue': { name: 'Tournament Blue', felt: '#1F5C9E' },
  'electric-blue': { name: 'Electric Blue', felt: '#1C74BA' },
  'blue-green': { name: 'Blue Green', felt: '#1D6966' },
  spruce: { name: 'Spruce', felt: '#2A5A61' },
  'simonis-green': { name: 'Simonis Green', felt: '#2F7A40' },
  'english-green': { name: 'English Green', felt: '#20563A' },
  'slate-grey': { name: 'Slate Grey', felt: '#56606A' },
  burgundy: { name: 'Burgundy', felt: '#6C2131' },
};
const DEFAULT_CLOTH = 'tournament-blue';
const shade = (hex, k) => `#${[1, 3, 5].map((i) => Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * k)).toString(16).padStart(2, '0')).join('')}`;
function clothShades(id) {
  const felt = (CLOTHS[id] || CLOTHS[DEFAULT_CLOTH]).felt;
  return { center: shade(felt, 1.2), felt, edge: shade(felt, 0.62), cushion: shade(felt, 0.74) };
}

let TABLE = buildTable();
let POCKETS = TABLE.pockets; // {x, y}: middle of each mouth, pocket-index order; none on a carom table
const BALL_COLORS = { // design tokens --ball-1 … --ball-8
  1: '#F2C12E', 2: '#1F4FB4', 3: '#CC3326', 4: '#5B3592', 5: '#EC7623', 6: '#128A4C', 7: '#7E2232', 8: '#111316',
};
// 3-cushion: the white (the breaker's), the yellow and the red, by id, and
// the colour of the dots that show them turning.
const CAROM_COLORS = { 0: '#F4EFE2', 1: '#F2C12E', 2: '#CC3326' };
const CAROM_DOTS = { 0: '#B4322A', 1: '#B4322A', 2: '#F4EFE2' };
const CAROM_NAMES = { 0: N('white'), 1: N('yellow'), 2: N('red') };
const caromName = (id) => tr(CAROM_NAMES[id]);
const RENDER_DELAY_MS = 100;  // how far behind the newest snapshot we draw
const AIM_SEND_MS = 100;      // at most 10 aim messages per second
const STRIKE_MS = 280;        // the cue's strike: forward to the ball, then fading
const STRIKE_HIT_MS = 80;     // when in it the tip meets the ball
const STRIKE_WAIT_MS = 2000;  // how long a released cue waits for its shot to start
const PING_EVERY_MS = 15000;  // heartbeat; the server answers with pong
const PONG_TIMEOUT_MS = 10000;
const RECONNECT_MAX_MS = 8000;
const SEAT_HOLD_S = 60;       // how long the server holds a seat (PROTOCOL.md)
const CLOCK_LOW_S = 10;       // the shot clock turns red and warns from here
const CLOCK_HURRY_S = 5;      // ...and from here counts down over the table
const ROOMS_POLL_MS = 3000;

// buildTable lays out cushions and pockets like Table.buildRails on the server.
// A carom table has four cushions meeting in the corners: their "jaws" are
// the mitred ends, at 135°.
function buildTable(carom) {
  if (carom) {
    const t = 135 * DEG;
    const end = (ux, uy, inx, iny) => ({ x: ux * Math.cos(t) - inx * Math.sin(t), y: uy * Math.cos(t) - iny * Math.sin(t) });
    const cushions = [];
    const add = (from, to, inward) => {
      const len = Math.hypot(to.x - from.x, to.y - from.y);
      const ux = (to.x - from.x) / len, uy = (to.y - from.y) / len;
      cushions.push({ from, to, inward, jawFrom: end(ux, uy, inward.x, inward.y), jawTo: end(-ux, -uy, inward.x, inward.y) });
    };
    add({ x: 0, y: 0 }, { x: W, y: 0 }, { x: 0, y: 1 });
    add({ x: 0, y: H }, { x: W, y: H }, { x: 0, y: -1 });
    add({ x: 0, y: 0 }, { x: 0, y: H }, { x: 1, y: 0 });
    add({ x: W, y: 0 }, { x: W, y: H }, { x: -1, y: 0 });
    return { pockets: [], cushions };
  }
  const a = SPEC.corner / Math.SQRT2; // corner noses sit this far from the corner along each rail
  const s = SPEC.side / 2;
  const d = 1 / Math.SQRT2;
  const pockets = [
    { x: a / 2, y: a / 2, ax: -d, ay: -d, half: SPEC.corner / 2, shelf: SPEC.cornerShelf },
    { x: W / 2, y: 0, ax: 0, ay: -1, half: s, shelf: SPEC.sideShelf, side: true },
    { x: W - a / 2, y: a / 2, ax: d, ay: -d, half: SPEC.corner / 2, shelf: SPEC.cornerShelf },
    { x: a / 2, y: H - a / 2, ax: -d, ay: d, half: SPEC.corner / 2, shelf: SPEC.cornerShelf },
    { x: W / 2, y: H, ax: 0, ay: 1, half: s, shelf: SPEC.sideShelf, side: true },
    { x: W - a / 2, y: H - a / 2, ax: d, ay: d, half: SPEC.corner / 2, shelf: SPEC.cornerShelf },
  ];
  // jaw direction from a nose: the cushion direction (away from the pocket)
  // rotated by the jaw angle away from the playing surface
  const jaw = (ux, uy, inx, iny, corner) => {
    const t = (corner ? SPEC.cornerJaw : SPEC.sideJaw) * DEG;
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

// setTable sizes the table for mode, if it is not already: the carom table
// for 3-cushion, otherwise the pool table id (TABLES). The drawn table and
// the 3D view are rebuilt.
let tableKey = DEFAULT_TABLE; // 'carom' or a TABLES key: the table laid out
function setTable(mode, id = S.table) {
  const carom = mode === '3cushion';
  const key = carom ? 'carom' : TABLES[id] ? id : DEFAULT_TABLE;
  if (key === tableKey) return;
  tableKey = key;
  if (!carom) SPEC = TABLES[key];
  W = carom ? 2.84 : 2.54;
  H = carom ? 1.42 : 1.27;
  R = carom ? 0.0615 / 2 : 0.028575;
  HEAD = W / 4;
  FOOT = { x: W * 3 / 4, y: H / 2 };
  NOSE_H = 2 * R * (carom ? 0.6 : 0.635);
  TABLE = buildTable(carom);
  POCKETS = TABLE.pockets;
  resetOrientations();
  if (v3) { stop3d(); start3d(); } else if (view.cssW) resize();
}

// setCloth dresses the table in cloth c (CLOTHS): the flat table is drawn
// again, the 3D cloth and cushions repainted in place.
function setCloth(c) {
  if (!CLOTHS[c] || c === S.cloth) return;
  S.cloth = c;
  if (v3) v3.setCloth(feltCanvas(), clothShades(c).cushion);
  else renderTableCache();
}

// optionText returns [title, consequence] for a post-break option; opp is
// the other player's name.
function optionText(opt, opp) {
  switch (opt) {
    case 'accept_table': return [T`Play from here`, T`Accept the balls where they lie. You shoot next.`];
    case 'rerack_break': return [T`Re-rack, I break`, T`Start the rack again with your break.`];
    case 'rerack_opponent_breaks': return [T`Re-rack, ${opp} breaks again`, T`They get another try at a legal break.`];
    case 'spot_eight': return [T`Spot the 8-ball`, T`Put the 8 back on the foot spot and play on.`];
    case 'rebreak': return [T`Re-rack, I break`, T`Start the rack again with your break.`];
    case 'take_shot': return [T`Take the shot`, T`Play from where the balls lie.`];
    case 'pass_back': return [T`Pass it back`, T`${opp} shoots again from here.`];
    default: return [opt, ''];
  }
}
const CAROM_FOUL_TEXT = {
  no_contact: N('the break touched no ball'),
  wrong_ball: N('the break must hit the red first'),
  off_table: N('a ball left the table'),
};
const FOUL_TEXT = {
  scratch: N('scratch'),
  no_contact: N('no ball contacted'),
  wrong_ball: N('wrong ball hit first'),
  kitchen: N('illegal shot from the kitchen'),
  no_rail: N('no rail after contact'),
  bad_break: N('fewer than four balls reached a rail'),
  off_table: N('a ball left the table'),
};
// foulText names a foul in the language shown.
const foulText = (f, carom) => tr((carom && CAROM_FOUL_TEXT[f]) || FOUL_TEXT[f]) || f;
const MODE_NAME = { '8ball': '8-ball', '9ball': '9-ball', '3cushion': '3-cushion' };

// Graphics (Settings): 'auto' starts sharp and steps down when frames come
// late (checkPace, and checkSpeed in 3D); the others are fixed and never
// step. QUALITY_DPR caps the flat table's pixel ratio; view3d.js has the 3D
// side (LEVELS). Low also draws at most 30 frames a second (LOW_FRAME_MS).
const QUALITY_DPR = { high: 3, medium: 2, low: 1 };
const QUALITY_NOTES = {
  auto: N('Sharp, and lowered by itself when the frames judder.'),
  high: N('The sharpest picture and the softest shadows, at every frame. Needs a strong device.'),
  medium: N('A little less sharp. Runs cooler on most phones.'),
  low: N('Plain and 30 frames a second: saves the battery on an old or slow phone.'),
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
  size: 2,               // seats: 2, or 4 in a 2v2 room (isTeams)
  phase: 'lobby',
  turn: 0,
  mode: '8ball',         // the room's game: '8ball', '9ball' or '3cushion'
  table: DEFAULT_TABLE,  // the room's pool table (TABLES); 3-cushion has its own
  cloth: DEFAULT_CLOTH,  // the colour of its cloth (CLOTHS), the same for everyone in the room
  carom: null,           // 3-cushion: the score, {points, innings, highRun, run, cue, breaker, equalizing}
  target: 0,             // 3-cushion: the points the game is played to (0 in practice)
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
  rec: null,             // the shot being recorded for a replay: {snaps, impacts}
  lastShot: null,        // the last shot, recorded whole: {snaps, impacts}
  replay: null,          // the replay being played, see startReplay

  // view
  view: '2d',            // '2d' from above, or '3d' (view3d.js); see initialView
  quality: QUALITY_NOTES[readSetting('pool:quality')] ? readSetting('pool:quality') : 'auto', // Settings → Graphics; see QUALITY_DPR
  camTop: false,         // 3D: look straight down instead of from behind the cue
  aimDrag: null,         // the pointer turning the aim: {x} in 3D behind the cue, {a} for a finger in 2D (see leverAim)

  // my shot
  angle: 0,
  power: 0.3,            // fraction of MAX_CUE_SPEED sent with the shot; the bar maps to it quadratically
  spin: { x: 0, y: 0 },  // cue tip offset, unit disc; y > 0 is top spin
  elev: 0,               // cue elevation in whole degrees, 0 (level) to ELEV_MAX: raised, the cue ball jumps; steep, with english, it curves
  powerDrag: false,      // the power bar is being pulled
  powerBefore: 0.3,      // power before the current pull, restored on cancel
  lastPower: 0,          // power of the last shot, shown faintly in the bar
  lefty: false,          // power bar on the left
  aimFront: readSetting('pool:aim') === 'front', // aim by pointing at the target, not by the butt of the cue
  nextBall: readSetting('pool:pointer') !== 'off', // point at the ball to shoot next (pointerBall)
  pointerAt: 0,          // performance.now() the turn began: the pointer bounces for a moment
  hoverBall: null,       // ball under the mouse, for its label
  call: null,            // {pocket} for the 8-ball, {safety: true}, or {pushOut: true} in 9-ball
  roomsTimer: 0,
  aiming: false,
  pointer: null,         // the pointerId the table follows while it aims or carries a ball; other fingers are ignored
  pointerType: '',       // 'mouse', 'touch' or 'pen': that pointer's kind
  fingerAt: null,        // {x, y} in canvas px: where that finger is, for the loupe to keep clear of it
  powerPointer: null,    // the pointerId pulling the power bar
  powerType: '',         // and its kind
  powerStep: 0,          // the quarter of the bar the pull is in (powerStep), for the haptic ticks
  powerY: 0,             // clientY of that pull, for the loupe to keep clear of the hand
  haptics: readSetting('pool:haptics') !== 'off', // vibrate on the power bar's steps and the shot (Android)
  drag: null,            // {id, x, y} while a ball is carried: the cue ball in hand, any ball in practice; in 3D also at and raw (see carry)
  tap: null,             // press on a ball or pocket awaiting release: {id, pocket, x, y, t, type}
  placedAt: null,        // {id, x, y}: last placement we sent, kept until the server confirms
  lastAimSent: 0,
  aimTimer: 0,

  oppAim: null,          // {angle, power, elev}; elev in radians
  heldStrike: null,      // our cue's strike fx, drawn back from the release until the shot starts (strikeAt)
  lastDecisionReason: '',
  offlineSince: [0, 0],  // performance.now() when a seat dropped, per seat; 0 = unknown
  holdTimer: 0,
  clock: null,           // the server's shot clock plus at: performance.now() when it arrived
  clockTimer: 0,
  clockWarned: false,    // the low-time toast was shown for this clock
  clockTick: 0,          // the last whole second ticked for this clock
  turnCued: false,       // it is my move, and the cue for it was given

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

  // spectators and comments
  spectator: false,      // watching: no seat (S.seat is -1); may only comment and leave
  wantWatch: false,      // the join in flight is a watch
  audience: { names: [], max: 0 }, // who watches the room, how many may
  chat: [],              // the room's comments, oldest first: {from, seat, text, at}
  chatUnread: 0,
  chatReadyAt: 0,        // performance.now() when the next comment may be sent

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
  const data = S.spectator ? { watch: true, name: S.name } : { token: S.token, name: S.name };
  try { sessionStorage.setItem(sessionKey(S.roomCode), JSON.stringify(data)); } catch { /* unavailable */ }
}

// inRoom: seated or watching.
const inRoom = () => S.seat >= 0 || S.spectator;
function clearSession(roomCode) {
  try { sessionStorage.removeItem(sessionKey(roomCode)); } catch { /* unavailable */ }
}

function connectAndJoin(roomCode, name, token, watch) {
  if (S.ws) { S.intentionalClose = true; S.ws.close(); }
  S.intentionalClose = false;
  clearTimeout(S.reconnectTimer);
  S.reconnectTimer = 0;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  S.ws = ws;
  S.roomCode = roomCode;
  S.name = name;
  S.wantWatch = !!watch;
  ws.onopen = () => {
    const join = { type: 'join', roomCode, name };
    if (token) join.token = token;
    if (watch) join.watch = true;
    send(join);
    startHeartbeat();
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    wakeDraw();
    handle(msg);
  };
  ws.onclose = (e) => {
    if (ws !== S.ws) return;
    S.ws = null;
    stopHeartbeat();
    if (S.intentionalClose) return;
    if (!inRoom()) {
      showLanding(T`Could not join: ${closeReason(e.reason) || T`connection closed`}`);
      return;
    }
    if (S.spectator && /room closed/.test(e.reason)) {
      clearSession(S.roomCode);
      resetToLanding(T`The room closed.`);
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
    if (!inRoom() || S.ws) return;
    connectAndJoin(S.roomCode, S.name, S.token, S.spectator);
  }, delay);
}

// showConn shows the connectivity card: 'lost' (retrying with a backoff) or
// 'taken' (another connection holds the seat; no automatic retry).
function showConn(kind) {
  hideSplash();
  const taken = kind === 'taken';
  $('connIconLost').hidden = taken;
  $('connIconTaken').hidden = !taken;
  $('connTitle').textContent = taken ? T`Playing somewhere else?` : T`Connection lost`;
  $('disconnectedText').textContent = taken
    ? T`This seat was taken over by another connection, probably another tab or device. Only one can hold a seat.`
    : S.spectator ? T`Reconnecting…` : T`Reconnecting… Your seat is held for ${SEAT_HOLD_S} seconds.`;
  $('retry').hidden = taken;
  $('connNote').hidden = !taken;
  $('rejoin').className = taken ? 'btn btn--primary' : 'btn btn--secondary';
  $('rejoin').lastElementChild.textContent = taken ? T`Play here` : T`Retry now`;
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
  $('retryTry').textContent = S.ws ? T`Try ${attempt} · connecting…` : T`Try ${attempt} · next in ${next.toFixed(1)} s`;
  const held = Math.max(0, SEAT_HOLD_S - (now - S.discSince) / 1000);
  $('retryHold').textContent = S.spectator ? '' : T`Seat held ${Math.ceil(held)} s`;
}

// The splash covers a reload inside a room: shown only after 150 ms so an
// instant rejoin never flashes it, replaced by the card after 4 s.
function showSplash(code) {
  $('splashCode').textContent = code;
  clearTimeout(S.splashTimer);
  clearTimeout(S.splashFallback);
  S.splashTimer = setTimeout(() => { S.splashTimer = 0; $('splash').hidden = false; }, 150);
  S.splashFallback = setTimeout(() => { if (!$('splash').hidden && inRoom()) { S.reconnectAttempt = Math.max(1, S.reconnectAttempt); showConn('lost'); } }, 4000);
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
        S.oppAim = { angle: msg.angle, power: msg.power, elev: msg.elevation || 0 };
      }
      break;
    case 'player': onPlayer(msg); break;
    case 'clock': setClock(msg); refreshPanels(); break;
    case 'timeout': onTimeout(msg); break;
    case 'pong': clearTimeout(S.pongTimer); S.pongTimer = 0; break;
    case 'error': onError(msg); break;
    case 'chat': onChat(msg); break;
    case 'chat_log': S.chat = msg.messages || []; renderChat(); break;
    case 'audience': S.audience = { names: msg.names || [], max: msg.max || 0 }; renderChatHead(); renderAudienceSetting(); break;
  }
}

function onWelcome(msg) {
  const reconnected = inRoom() && S.reconnectAttempt > 0;
  // the same seat token in the same room: a move to another seat (sit),
  // which keeps the thread; otherwise chat_log follows when there is any
  const moved = inRoom() && msg.token && msg.token === S.token && msg.roomCode === S.roomCode && S.reconnectAttempt === 0;
  S.seat = msg.seat;
  S.spectator = !!msg.spectator;
  if (!moved) {
    S.chat = [];
    renderChat();
  }
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
  keepAwake(true);
  if (reconnected) toast(T`Reconnected`);
}

function applyRules(msg) {
  const turnChanged = msg.turn !== S.turn || msg.phase !== S.phase;
  S.phase = msg.phase;
  S.turn = msg.turn;
  // settled carries no mode, table or cloth: they cannot change mid-game
  if (TABLES[msg.table]) S.table = msg.table;
  if (msg.cloth) setCloth(msg.cloth);
  if (msg.mode) { S.mode = msg.mode; setTable(msg.mode); }
  S.carom = msg.carom || null;
  S.target = msg.target || 0;
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
  S.audience = { names: msg.spectators || [], max: msg.maxSpectators || 0 };
  renderChatHead();
  S.players = msg.players;
  S.size = msg.size || msg.players.length;
  S.moving = msg.moving;
  setBalls(msg.balls);
  S.snaps = []; // a shot in progress resumes from the next snapshot
  S.pendingDrops = [];
  S.rec = null;
  if (S.lastShot && !sameObjectBalls(S.lastShot.snaps[S.lastShot.snaps.length - 1].balls, S.balls)) {
    // re-racked, taken back or set up anew: the last shot is history
    stopReplay();
    S.lastShot = null;
  }
  const hadDecision = !!S.decision;
  const turnChanged = applyRules(msg);
  setClock(msg.clock);
  S.placedAt = null;
  S.drag = null;
  if (turnChanged || (hadDecision && !S.decision)) newTurn();
  if (msg.phase === 'breaking' && !msg.decision) S.lastBreaker = sideOf(msg.turn);
  if (msg.phase === 'breaking' && prevPhase !== 'breaking') {
    resetOrientations(); // a fresh rack
    if (S.practice) S.rackMode = msg.mode; // the Rack picker starts on the game being played
  }
  if (prevPhase !== 'game_over' && prevPhase !== 'lobby' && msg.phase === 'game_over' && isCarom()) {
    // Not by a shot: the equalizing inning ran out of time.
    S.resultReason = caromReason();
    setStatus(`${S.resultReason}. ${winnerTitle()}.`, 'foul');
  } else if (prevPhase !== 'game_over' && prevPhase !== 'lobby' && msg.phase === 'game_over' && S.winner !== null) {
    // Not by a shot (that comes as settled): a third foul on the clock.
    const loser = 1 - S.winner;
    S.resultReason = T`${teamName(loser)} fouled three times in a row`;
    setStatus(`${S.resultReason}. ${winLine(S.winner)}`, 'foul');
  } else if (prevPhase !== 'lobby' && msg.phase === 'lobby') {
    const m = S.match;
    const last = m && m.racks.length ? m.racks[m.racks.length - 1] : null;
    const who = isTeams() ? T`The other team` : S.lastOppName || T`Your opponent`;
    if (last && last.end === 'forfeit' && isMySide(m.winner)) {
      const [a, b] = [m.score[mySide()], m.score[1 - mySide()]];
      setStatus(S.oppLeft
        ? (isTeams() ? T`${who} left. Your team wins the match ${a}–${b}.` : T`${who} left. You win the match ${a}–${b}.`)
        : (isTeams() ? T`${who} didn’t come back. Your team wins the match ${a}–${b}.` : T`${who} didn’t come back. You win the match ${a}–${b}.`));
      S.lobbyNote = S.oppLeft ? T`${who} left the room.` : T`${who} didn’t come back in time.`;
    } else {
      setStatus(T`The game was abandoned.`, 'foul');
      const gone = !isTeams() && S.players[1 - S.seat];
      if (gone && !gone.name && S.lastOppName) S.lobbyNote = T`${S.lastOppName} didn’t come back in time.`;
    }
  } else if (msg.phase === 'breaking' && prevPhase !== 'breaking') {
    const who = nameOf(msg.turn);
    setStatus(isCarom()
      ? (isMe(msg.turn) ? T`You break with the white: the red first.` : T`${who} breaks with the white: the red first.`)
      : (isMe(msg.turn) ? T`You break. Place the cue ball in the kitchen and shoot.` : T`${who} breaks. Place the cue ball in the kitchen and shoot.`));
  } else if (msg.phase === 'lobby') {
    setStatus('');
  }
  refreshPanels();
  showMatchIfWon(0);
}

// sameObjectBalls: the same object balls in the same places (the cue
// ball may have been placed since).
function sameObjectBalls(a, b) {
  for (const [id, p] of a) {
    if (id === 0) continue;
    const q = b.get(id);
    if (!q || Math.hypot(q.x - p.x, q.y - p.y) > 1e-4) return false;
  }
  for (const id of b.keys()) if (id !== 0 && !a.has(id)) return false;
  return true;
}

function onSnapshot(msg) {
  const balls = new Map(msg.balls.map((b) => [b.id, b.z ? { x: b.x, y: b.y, z: b.z } : { x: b.x, y: b.y }]));
  if (msg.t > 0 && S.moving && S.snaps.length) {
    // A ball missing from this snapshot was pocketed: animate it dropping
    // once the render clock reaches this snapshot.
    const prev = S.snaps[S.snaps.length - 1], before = S.snaps[S.snaps.length - 2];
    for (const [id, p] of prev.balls) if (!balls.has(id)) queueDrop(id, p, msg.t, ballVel(before, prev, id));
  }
  if (msg.t === 0 || !S.moving || S.snaps.length === 0) {
    // A new shot, or joining one midway (reconnect): align our clock to it.
    const elev = msg.t === 0 ? strikeAt(balls.get(cueId())) : 0;
    stopReplay();
    S.rec = msg.t === 0 ? { snaps: [], impacts: [], elev, cue: cueId() } : null; // a shot joined midway is not replayed
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
  if (S.rec) {
    S.rec.snaps.push({ t: msg.t, balls });
    if (msg.impacts) S.rec.impacts.push(...msg.impacts);
  }
  playImpacts(msg.impacts);
  refreshPanels();
}

function onSettled(msg) {
  // Anything still on the table in our last snapshot but gone now drops, and
  // so does a ball driven off the table that is back on it (the cue ball, a
  // spotted ball); queued drops start at once.
  const n = S.snaps.length;
  const last = n ? S.snaps[n - 1].balls : S.balls;
  const now = new Set(msg.balls.map((b) => b.id));
  const off = new Set(msg.offTable || []);
  const queued = new Set(S.pendingDrops.map((d) => d.id));
  for (const d of S.pendingDrops) startDrop(d.id, d.from, d.vel, off.has(d.id));
  S.pendingDrops = [];
  for (const [id, p] of last) {
    if ((now.has(id) && !(n && off.has(id))) || queued.has(id)) continue;
    startDrop(id, p, n ? ballVel(S.snaps[n - 2], S.snaps[n - 1], id) : null, off.has(id));
  }
  playImpacts(msg.impacts);
  S.moving = false;
  S.snaps = [];
  setBalls(msg.balls);
  const rec = S.rec;
  S.rec = null;
  if (rec && rec.snaps.length) {
    if (msg.impacts) rec.impacts.push(...msg.impacts);
    rec.snaps.push({ t: rec.snaps[rec.snaps.length - 1].t + 50, balls: new Map(S.balls) });
    rec.offTable = msg.offTable || [];
    S.lastShot = rec;
  } else {
    S.lastShot = null; // joined midway: no replay, and an older shot is not this one
  }
  S.oppAim = null;
  applyRules(msg);
  setClock(msg.clock);
  newTurn();
  describeShot(msg);
  holdStatus();
  voiceFor(msg);
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
      toast(was.name ? T`${msg.name} is back` : T`${msg.name} joined`);
    } else if (!msg.connected && was.connected && msg.name) {
      toast(T`${msg.name} lost connection`);
      setStatus(T`${msg.name} lost connection. Their seat is held for ${SEAT_HOLD_S} seconds.`, 'foul');
    } else if (!msg.connected && !msg.name && was.name) {
      S.oppLeft = was.connected; // still connected: they pressed Leave
      toast(T`${was.name} left`);
    }
  }
  refreshPanels();
}

// The server's errors and close reasons are English; another language says
// them from the code (PROTOCOL.md, "error").
const ERR_TEXT = {
  bad_message: N('The server did not understand that.'),
  not_joined: N('Join a room first.'),
  room_not_found: N('There is no such room.'),
  room_full: N('The room is full.'),
  wrong_phase: N('Not now.'),
  balls_moving: N('The balls are still rolling.'),
  not_your_turn: N('It is not your turn.'),
  no_ball_in_hand: N('You do not have ball in hand.'),
  bad_placement: N('The cue ball cannot go there.'),
  bad_input: N('That shot is not valid.'),
  bad_call: N('Call a pocket for the 8-ball first.'),
  no_decision: N('There is nothing to decide.'),
  bad_option: N('That option is not offered.'),
  no_extension: N('You have already used your extension this game.'),
  bad_mode: N('Unknown game.'),
  no_undo: N('There is no shot to take back.'),
  not_practice: N('Only in practice.'),
  bad_race: N('The race must be 1 to 25 racks (3-cushion: 1 to 50 points).'),
  audience_full: N('No more spectators can watch this room.'),
  spectator: N('Spectators can only chat.'),
  bad_spectators: N('That many spectators are not allowed here.'),
  bad_table: N('Unknown table or cloth.'),
  seat_taken: N('That seat is taken.'),
  bad_players: N('2 v 2 is for 8-ball and 9-ball.'),
  room_limit: N('All rooms are in use. Join one of them, or try again in a moment.'),
};
const errText = (code, message) => (LANG !== 'en' && ERR_TEXT[code] ? tr(ERR_TEXT[code]) : message || code);
const CLOSE_TEXT = {
  'left the room': N('left the room'),
  'room closed': N('room closed'),
  'replaced by a new connection': N('replaced by a new connection'),
  'ping timeout': N('ping timeout'),
  'write failed': N('write failed'),
  'outbound buffer full': N('outbound buffer full'),
};
const closeReason = (r) => (r && CLOSE_TEXT[r] ? tr(CLOSE_TEXT[r]) : r);

function onError(msg) {
  if (msg.code === 'chat_cooldown') {
    S.chatReadyAt = performance.now() + (msg.retryMs || CHAT_COOLDOWN_MS);
    renderChatSend();
    return;
  }
  dropHeldStrike(); // a refused shot does not start
  toast(errText(msg.code, msg.message), true);
  if (msg.code === 'bad_placement' || msg.code === 'no_ball_in_hand' || msg.code === 'balls_moving') {
    S.drag = null;
    S.placedAt = null;
  }
  if (msg.code === 'room_not_found' || msg.code === 'room_full' || msg.code === 'audience_full') {
    // The join failed: the room is gone or our held seat expired and was
    // taken. Nothing to come back to.
    S.intentionalClose = true;
    if (S.ws) S.ws.close();
    S.ws = null;
    stopHeartbeat();
    clearSession(S.roomCode);
    resetToLanding(errText(msg.code, msg.message));
  }
}

// setClock takes the shot clock from the server (null: nobody has to act).
// Its time is counted from arrival, so the two machines' clocks never mix.
function setClock(c) {
  if (!c) { S.clock = null; setHurry(0); return; }
  if (!S.clock || c.seat !== S.clock.seat || c.left > CLOCK_LOW_S * 1000) { S.clockWarned = false; S.clockTick = 0; }
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
  const oSide = 1 - sideOf(msg.seat);
  const other = teamName(oSide);
  let text = isMe(msg.seat) ? T`You ran out of time` : T`${who} ran out of time`;
  if (msg.option) {
    text += T`; “${optionText(msg.option, other)[0]}” was chosen.`;
  } else if (isCarom() && S.phase !== 'breaking') {
    text += S.carom && S.carom.equalizing && msg.seat !== S.carom.breaker ? T`: the equalizing inning is over.` : isMySide(oSide) ? T`. Your turn.` : T`. ${other}’s turn.`;
  } else if (S.phase === 'breaking') {
    text += T`. ${sideDoes(oSide, 'break')} instead.`;
  } else if (isNine() && S.fouls[sideOf(msg.seat)] + 1 >= 3) {
    text += T`: a third foul in a row.`; // the room_state that follows ends the rack
  } else {
    text += T`. ${sideDoes(oSide, 'have')} ball in hand.`;
    if (isNine() && S.fouls[sideOf(msg.seat)] + 1 === 2) text += isMe(msg.seat) ? T` You are on two fouls.` : T` ${who} is on two fouls.`;
  }
  S.clock = null;
  toast(text, isMe(msg.seat));
  setStatus(text, 'foul');
  holdStatus();
  speak('timeout', seeded(JSON.stringify([S.roomCode, 'timeout', msg])));
}

// resetToLanding forgets the room and shows the landing form.
function resetToLanding(error) {
  clearTimeout(S.reconnectTimer);
  S.reconnectTimer = 0;
  S.reconnectAttempt = 0;
  hideConn();
  hideSplash();
  S.seat = -1;
  S.spectator = false;
  S.wantWatch = false;
  S.token = '';
  S.chat = [];
  S.chatUnread = 0;
  S.audience = { names: [], max: 0 };
  closeChat();
  renderChat();
  S.phase = 'lobby';
  S.moving = false;
  S.snaps = [];
  stopReplay();
  S.rec = null;
  S.lastShot = null;
  S.decision = null;
  S.clock = null;
  S.mode = '8ball';
  S.carom = null;
  S.target = 0;
  S.practice = false;
  S.undos = 0;
  S.moveTool = false;
  S.fouls = [0, 0];
  S.pushOut = false;
  S.lastBreaker = -1;
  S.match = null;
  S.shownScore = null;
  S.oppLeft = false;
  keepAwake(false);
  closeSettings();
  for (const id of ['matchDialog', 'leaveConfirm']) $(id).hidden = true;
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
  S.pointerAt = S.aimShownAt;
  wakeDraw(); // full frame rate while the pointer bounces
  S.call = null;
  S.aiming = false;
  S.drag = null;
  S.placedAt = null;
  S.spin = { x: 0, y: 0 };
  setElev(0);
  if (isMyShot()) {
    const cue = S.balls.get(cueId());
    const targets = legalTargets();
    let best = null;
    if (cue) {
      for (const id of (targets.size ? targets : S.balls.keys())) {
        if (id === cueId()) continue;
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
  if (isCarom()) { describeCaromShot(msg); return; }
  if (S.practice) { describeFreeShot(msg); return; }
  const parts = [];
  const who = nameOf(msg.shooter);
  const me = isMe(msg.shooter);
  const made = msg.pocketed.filter((id) => id !== 0);
  const off = msg.offTable || [];
  const over = msg.winner !== undefined && msg.winner !== null;
  const nine = isNine();
  if (msg.illegalBreak && !nine) parts.push(me ? T`You broke illegally.` : T`Illegal break by ${who}.`);
  if (msg.pushedOut) parts.push(me ? T`You pushed out.` : T`${who} pushed out.`);
  if (msg.foul) parts.push(me ? T`Your foul: ${foulText(msg.foul)}.` : T`Foul by ${who}: ${foulText(msg.foul)}.`);
  if (made.length) parts.push(T`Pocketed ${made.map(ballName).join(', ')}.`);
  if (off.length) parts.push(T`Off the table: ${off.map(offName).join(', ')}.`);
  if (nine && !over && (made.includes(9) || off.includes(9))) parts.push(T`The 9 goes back on the foot spot.`);
  if (!nine && !over && off.includes(8)) parts.push(T`The 8 goes back on the foot spot.`);
  if (nine && !over && msg.foul && msg.fouls && msg.fouls[sideOf(msg.shooter)] === 2) {
    parts.push(me ? T`You are on two fouls: a third loses the rack.` : T`${who} is on two fouls: a third loses the rack.`);
  }
  if (over) {
    parts.push(winLine(msg.winner));
    S.resultReason = nine ? nineResultReason(msg, who) : eightResultReason(msg, who, made);
  } else if (msg.decision) {
    parts.push(isMe(msg.decision.seat) ? T`You choose how to continue.` : T`${nameOf(msg.decision.seat)} chooses how to continue.`);
  } else {
    let t = turnName(msg.turn);
    if (msg.ballInHand) t += msg.kitchen ? T`, ball in hand in the kitchen` : T`, ball in hand`;
    if (msg.pushOut) t += isMe(msg.turn) ? T`; you may push out` : T`; they may push out`;
    parts.push(t + '.');
  }
  if (msg.pushedOut && msg.decision) {
    S.lastDecisionReason = me ? T`You pushed out. Take the shot from here, or pass it back.` : T`${who} pushed out. Take the shot from here, or pass it back.`;
  } else if (msg.illegalBreak) {
    S.lastDecisionReason = me ? T`You broke illegally: nothing pocketed and fewer than four balls reached a rail.` : T`${who} broke illegally: nothing pocketed and fewer than four balls reached a rail.`;
  } else if (msg.decision) {
    S.lastDecisionReason = me ? T`You pocketed the 8-ball on the break.` : T`${who} pocketed the 8-ball on the break.`;
  }
  setStatus(parts.join(' '), msg.foul ? 'foul' : (msg.made ? 'good' : ''));
}

// describeFreeShot says what a practice shot did: no fouls, no turns.
function describeFreeShot(msg) {
  const made = msg.pocketed.filter((id) => id !== 0);
  const off = (msg.offTable || []).filter((id) => id !== 0);
  const parts = [];
  if (made.length) parts.push(T`Pocketed ${made.map(ballName).join(', ')}.`);
  if (off.length) parts.push(T`Off the table: ${off.map(ballName).join(', ')}.`);
  if (msg.pocketed.includes(0)) parts.push(T`The cue ball dropped; it is back on the head spot.`);
  else if ((msg.offTable || []).includes(0)) parts.push(T`The cue ball left the table; it is back on the head spot.`);
  if (![...S.balls.keys()].some((id) => id > 0)) parts.push(T`Table cleared! Rack again for more.`);
  setStatus(parts.join(' ') || T`Nothing dropped.`, made.length ? 'good' : '');
}

// cushions says "3 cushions", points "15 points".
const cushions = (n) => (n === 1 ? T`${n} cushion` : T`${n} cushions`);
const points = (n) => (n === 1 ? T`${n} point` : T`${n} points`);
// capFirst starts a sentence with a capital: "The red goes back…"
const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// describeCaromShot says what a 3-cushion shot did: a point and how many
// cushions, or why not; balls put back on their spots; then whose turn, or
// how the game ended.
function describeCaromShot(msg) {
  const parts = [];
  const who = nameOf(msg.shooter);
  const me = isMe(msg.shooter);
  const c = msg.carom || S.carom;
  const n = msg.cushions || 0;
  if (msg.foul) {
    const f = foulText(msg.foul, true);
    parts.push(S.practice ? T`Foul: ${f}.` : me ? T`Your foul: ${f}.` : T`Foul by ${who}: ${f}.`);
  } else if (msg.made) {
    parts.push(!S.practice && c && c.run > 1 ? T`Point! ${cushions(n)}, a run of ${c.run}.` : T`Point! ${cushions(n)}.`);
  } else {
    const touched = msg.touched || 0;
    const why = touched === 0 ? T`both balls missed` : touched === 1 ? T`the second ball missed` : T`only ${cushions(n)} before the second ball`;
    parts.push(T`No point: ${why}.`);
  }
  const spotted = msg.spotted || [];
  if (msg.frozen) parts.push(T`The balls were touching: back on their spots.`);
  else if (spotted.length > 1) parts.push(capFirst(T`${spotted.map(ballName).join(T` and `)} go back on their spots.`));
  else if (spotted.length) parts.push(capFirst(T`${ballName(spotted[0])} goes back on its spot.`));
  if (S.practice) {
    setStatus(parts.join(' '), msg.made ? 'good' : '');
    return;
  }
  if (msg.phase === 'game_over') {
    S.resultReason = caromReason();
    parts.push(winnerTitle() + (isMe(msg.winner) ? '!' : '.'));
  } else if (c && c.equalizing && msg.turn !== c.breaker) {
    const pts = points(S.target);
    const reached = isMe(c.breaker) ? T`You have ${pts}` : T`${nameOf(c.breaker)} has ${pts}`;
    parts.push(isMe(msg.turn) ? T`${reached}: you have one inning to draw level.` : T`${reached}: ${nameOf(msg.turn)} has one inning to draw level.`);
  } else {
    parts.push(`${turnName(msg.turn)}.`);
  }
  setStatus(parts.join(' '), msg.foul ? 'foul' : (msg.made ? 'good' : ''));
}

// caromReason sums up a finished 3-cushion game: the points and innings.
function caromReason() {
  const c = S.carom;
  if (!c) return '';
  const inn = Math.max(c.innings[0], c.innings[1]);
  return inn === 1 ? T`${c.points[0]}–${c.points[1]} in ${inn} inning` : T`${c.points[0]}–${c.points[1]} in ${inn} innings`;
}

// offName names a ball that left the table.
const offName = (id) => (id === 0 && !isCarom() ? T`the cue ball` : ballName(id));

// nineResultReason says why a 9-ball rack ended with this shot.
function nineResultReason(msg, who) {
  if (msg.winner !== sideOf(msg.shooter)) return T`${who} fouled three times in a row`;
  return S.shotWasBreak ? T`9-ball pocketed on the break` : T`9-ball pocketed`;
}

// eightResultReason says why an 8-ball rack ended with this shot.
function eightResultReason(msg, who, made) {
  const g = S.groups[sideOf(msg.shooter)];
  const early = !g || remaining(g) > 0 || made.some((id) => groupOf(id) === g);
  if (msg.winner === sideOf(msg.shooter)) return T`8-ball pocketed in the called pocket`;
  if ((msg.offTable || []).includes(8)) return T`${who} jumped the 8-ball off the table`;
  if (msg.foul) return T`${who} fouled on the 8-ball: ${foulText(msg.foul)}`;
  return early ? T`${who} pocketed the 8-ball early` : T`${who} pocketed the 8-ball in the wrong pocket`;
}

// ---------------------------------------------------------------------------
// 3. shot logic

const isMe = (seat) => seat === S.seat;
const sideName = (seat) => (seat ? T`Side B` : T`Side A`);
const nameOf = (seat) => (isMe(seat) ? T`You` : S.practice ? sideName(seat) : (S.players[seat].name || T`Player ${seat + 1}`));
// turnName: "Your turn", "Bob's turn", "Cat's turn (your team)".
function turnName(seat) {
  if (isMe(seat)) return T`Your turn`;
  return isTeams() && isMySide(sideOf(seat)) ? T`${nameOf(seat)}'s turn (your team)` : T`${nameOf(seat)}'s turn`;
}

// Teams (2v2, PROTOCOL.md "Teams"): seats 0 and 2 against 1 and 3. Who
// acts is a seat (S.turn, decision.seat, clock.seat, settled.shooter);
// what a team owns is by side, seat % 2 (S.groups, S.fouls, S.winner, the
// match score). In a room of two the seat is the side, so every helper
// below says what it said before.
const isTeams = () => S.size > 2;
const sideOf = (seat) => (seat >= 0 ? seat % 2 : -1);
const mySide = () => sideOf(S.seat);
const isMySide = (side) => side !== null && side !== undefined && side >= 0 && side === mySide();
// teamNames are the names seated on side, in seat order.
const teamNames = (side) => S.players.filter((p) => p.seat % 2 === side && p.name).map((p) => p.name);
// teamName names side: the player in a room of two ("You" for me), the
// team in 2v2 ("Your team", "Bob & Dan").
function teamName(side) {
  if (!isTeams()) return nameOf(side);
  if (isMySide(side)) return T`Your team`;
  return teamNames(side).join(' & ') || (side ? T`Team B` : T`Team A`);
}
// sideDoes puts a verb after teamName: "You win", "Bob wins", "Your team
// wins", "Bob & Dan win" (break and have likewise).
function sideDoes(side, verb) {
  const plural = isTeams() ? !isMySide(side) && teamNames(side).length !== 1 : isMySide(side);
  const n = teamName(side);
  switch (verb) {
    case 'win': return plural ? T`${n} win` : T`${n} wins`;
    case 'break': return plural ? T`${n} break` : T`${n} breaks`;
    case 'have': return plural ? T`${n} have` : T`${n} has`;
  }
  return n;
}
const winLine = (side) => `${sideDoes(side, 'win')}${isMySide(side) ? '!' : '.'}`;
// oppName names the other side for the decision texts.
const oppName = () => (isTeams() ? teamName(1 - mySide()) : S.players[1 - S.seat].name || 'your opponent');
const groupOf = (id) => (id >= 1 && id <= 7 ? 'solids' : id >= 9 && id <= 15 ? 'stripes' : '');
// groupName shows a group ('solids', 'stripes') in the language shown.
const groupName = (g) => (g === 'solids' ? T`solids` : g === 'stripes' ? T`stripes` : g);
const isNine = () => S.mode === '9ball';
const isCarom = () => S.mode === '3cushion';
// cueId is the ball the player on turn strikes: their own in 3-cushion,
// the cue ball otherwise.
const cueId = () => (isCarom() && S.carom ? S.carom.cue[S.turn] : 0);
const ballName = (id) => (isCarom() ? T`the ${caromName(id)}` : id === 8 && !isNine() ? T`the 8-ball` : id === 9 && isNine() ? T`the 9-ball` : T`the ${id}`);
const inPlay = () => !S.decision && (S.phase === 'breaking' || S.phase === 'open' || S.phase === 'assigned');
const isMyShot = () => S.seat >= 0 && inPlay() && !S.moving && S.turn === S.seat;
const canCall = () => !S.practice && S.mode === '8ball' && S.phase !== 'breaking'; // a safety may be declared (8-ball)
const canPushOut = () => isNine() && S.pushOut && isMyShot();
// eightOn mirrors Rules.eightOn: the 8-ball is my legal target, so it needs
// a called pocket.
function eightOn() {
  if (S.practice || S.mode !== '8ball') return false; // practice calls nothing
  if (S.phase === 'open') return remaining('solids') === 0 || remaining('stripes') === 0;
  if (S.phase === 'assigned') return remaining(S.groups[mySide()]) === 0;
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
  if (isCarom()) {
    if (S.phase === 'breaking') out.add(2); // the break hits the red first
    return out;
  }
  if (isNine()) {
    const low = lowestBall();
    if (low !== null) out.add(low);
    return out;
  }
  if (S.phase === 'breaking') return out;
  const mine = S.groups[mySide()];
  const eight = eightOn();
  for (const id of S.balls.keys()) {
    if (id === 0) continue;
    if (S.phase === 'open' && (id !== 8 || eight)) out.add(id);
    else if (S.phase === 'assigned' && (eight ? id === 8 : groupOf(id) === mine)) out.add(id);
  }
  return out;
}

// lowestBall mirrors Rules.lowest: the 9-ball shooter's legal first contact.
// pointerBall is the ball to shoot next, pointed at for the shooter alone
// (Settings → Table → Next-ball pointer): in 9-ball the lowest, in 8-ball the
// nearest ball of my group to the cue ball, or the 8 once the group is
// cleared. None on the break, on an open table or in practice, where any
// ball will do. newTurn has aimed the cue at the same ball.
function pointerBall(balls = S.balls) {
  if (!S.nextBall || !isMyShot() || S.replay || S.practice || S.phase === 'breaking') return null;
  if (isNine()) return lowestBall();
  if (S.mode !== '8ball' || S.phase !== 'assigned') return null;
  if (eightOn()) return balls.has(8) ? 8 : null;
  const cue = balls.get(0);
  if (!cue) return null;
  let best = null, bestD = Infinity;
  for (const id of legalTargets()) {
    const b = balls.get(id);
    if (!b) continue;
    const d = Math.hypot(b.x - cue.x, b.y - cue.y);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

function lowestBall() {
  let low = null;
  for (const id of S.balls.keys()) if (id > 0 && (low === null || id < low)) low = id;
  return low;
}

// Jump shots and massés, as the server works them out (Table.ShootElevated,
// land, integrate): mirrors of game.DefaultConfig.
const SLATE_E = 0.5, CLOTH_MU = 0.2, TIP_OFFSET = 0.5, GRAVITY = 9.81;
let NOSE_H = 2 * R * 0.635; // the cushion nose above the slate: a ball whose bottom is higher flies over (setTable)
const PIN_ELEV = 60 * DEG;    // steeper, the cue's follow-through keeps the ball down (game.pinElevation)

// strikeBounce is how fast a cue raised elev (radians) sends the cue ball up
// off the slate when it drives it down at down m/s.
function strikeBounce(elev, down) {
  let vz = SLATE_E * down;
  if (elev > PIN_ELEV) vz *= (Math.PI / 2 - elev) / (Math.PI / 2 - PIN_ELEV);
  return vz < 0.1 ? 0 : vz;
}

// jumpFlight predicts the cue ball's first hop off a raised cue: its speed
// along the table once it has bounced off the slate, how fast it rises, and
// so where it comes down (land, metres from the cue ball) and how high its
// bottom is on the way (z(s)). null for a level cue or a hop too small to
// leave the cloth. Later, lower hops are left out.
function jumpFlight(power, spinY, elev) {
  if (!elev) return null;
  const speed = power * MAX_CUE_SPEED;
  const ahead = speed * Math.cos(elev), down = speed * Math.sin(elev);
  const slip = ahead - 2.5 * TIP_OFFSET * spinY * speed;
  const v = ahead - Math.sign(slip) * 2 / 7 * Math.min(Math.abs(slip), 3.5 * CLOTH_MU * (1 + SLATE_E) * down);
  const vz = strikeBounce(elev, down);
  if (!vz || v <= 1e-3) return null;
  const land = v * 2 * vz / GRAVITY;
  return { land, z: (s) => (s >= land ? 0 : vz * (s / v) - GRAVITY / 2 * (s / v) ** 2) };
}

// massePath follows a cue ball struck with english off a raised cue, which
// curves toward the english until it rolls (a massé). It steps the cue
// ball alone as the server does and returns its course in the shot's frame
// (s along the aim, l to the shooter's right, z its height) up to where it
// rolls, the direction it then rolls on (dir, also in that frame), and
// whether that is still moving. null when the shot would not curve.
function massePath(power, spin, elev) {
  if (!elev || !spin.x || !power) return null;
  const k = 2.5 * TIP_OFFSET;
  const speed = power * MAX_CUE_SPEED;
  const ahead = speed * Math.cos(elev), down = speed * Math.sin(elev);
  const b = { s: 0, l: 0, z: 0, vs: ahead, vl: 0, rs: k * spin.y * speed, rl: 0, vz: 0 };
  // slide closes up to d of the slip between speed and roll, as cloth
  // friction does (integrate, land)
  const slide = (d) => {
    const ss = b.vs - b.rs, sl = b.vl - b.rl, n = Math.hypot(ss, sl);
    if (!n) return;
    d = Math.min(n, d);
    b.vs -= ss / n * 2 / 7 * d; b.vl -= sl / n * 2 / 7 * d;
    if (d === n) { b.rs = b.vs; b.rl = b.vl; } else { b.rs += ss / n * 5 / 7 * d; b.rl += sl / n * 5 / 7 * d; }
  };
  const land = (vn) => {
    slide(3.5 * CLOTH_MU * (1 + SLATE_E) * vn);
    b.z = 0; b.vz = SLATE_E * vn < 0.1 ? 0 : SLATE_E * vn;
  };
  if (down > 0) { slide(3.5 * CLOTH_MU * (1 + SLATE_E) * down); b.vz = strikeBounce(elev, down); }
  b.rl = k * spin.x * down;
  const dt = 1 / 600;
  const pts = [{ s: 0, l: 0, z: 0 }];
  for (let i = 0; i < 6 / dt; i++) {
    if (b.z > 0 || b.vz) {
      b.s += b.vs * dt; b.l += b.vl * dt;
      b.z += b.vz * dt - GRAVITY / 2 * dt * dt;
      b.vz -= GRAVITY * dt;
      if (b.z <= 0) land(-b.vz);
    } else {
      if (b.vs === b.rs && b.vl === b.rl) break;
      slide(3.5 * CLOTH_MU * GRAVITY * dt);
      b.s += b.vs * dt; b.l += b.vl * dt;
    }
    pts.push({ s: b.s, l: b.l, z: b.z });
  }
  const v = Math.hypot(b.vs, b.vl);
  return { pts, dir: v ? { s: b.vs / v, l: b.vl / v } : null };
}

// castAim finds where the cue ball, sent along angle, first touches a ball or
// a cushion. Returns the ghost-ball position plus, for a ball, its direction.
// With a flight (jumpFlight) it passes over what it clears: balls, and a
// cushion it is higher than, which sends it off the table (offTable); land
// is where it first comes down, if before that.
function castAim(balls, cue, angle, flight) {
  const d = { x: Math.cos(angle), y: Math.sin(angle) };
  let t = Infinity;
  let hit = null;
  const own = cueId();
  for (const [id, b] of balls) {
    if (id === own) continue;
    const fx = cue.x - b.x, fy = cue.y - b.y;
    const bq = 2 * (fx * d.x + fy * d.y);
    const c = fx * fx + fy * fy - 4 * R * R;
    const disc = bq * bq - 4 * c;
    if (disc < 0) continue;
    let tt = (-bq - Math.sqrt(disc)) / 2;
    if (flight && tt < flight.land) {
      // in the air: the first point of the pass where the balls touch
      const t2 = (-bq + Math.sqrt(disc)) / 2;
      const h2 = (s) => s * s + bq * s + c + 4 * R * R; // squared distance across the table
      tt = Infinity;
      for (let s = Math.max(0, (-bq - Math.sqrt(disc)) / 2); s <= t2; s += R / 8) {
        const z = flight.z(s);
        if (h2(s) + z * z < 4 * R * R) { tt = s; break; }
      }
      if (tt === Infinity && flight.land < t2) tt = flight.land; // comes down on it
    }
    if (tt > 1e-6 && tt < t) { t = tt; hit = id; }
  }
  const tx = d.x > 1e-9 ? (W - R - cue.x) / d.x : d.x < -1e-9 ? (R - cue.x) / d.x : Infinity;
  const ty = d.y > 1e-9 ? (H - R - cue.y) / d.y : d.y < -1e-9 ? (R - cue.y) / d.y : Infinity;
  const tc = Math.max(0, Math.min(tx, ty));
  let offTable = false;
  if (tc < t) {
    t = tc; hit = null;
    // over the cushion: the cue ball goes on past the rail and is gone
    if (flight && flight.z(tc) >= NOSE_H) { offTable = true; t = tc + 2 * R; }
  }
  const ghost = { x: cue.x + d.x * t, y: cue.y + d.y * t };
  const land = flight && flight.land < t ? { x: cue.x + d.x * flight.land, y: cue.y + d.y * flight.land } : null;
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
  return { ghost, hit, dir: d, objDir, cueDir, land, offTable, flight: !!flight };
}

// castMasse is castAim along a massé's curve (massePath): where the cue
// ball first touches a ball or a cushion, the curve up to there (curve, in
// table metres, each point with its height) and, once it rolls straight,
// the rest as castAim finds it. dir is the way the cue ball is going when
// it gets there.
function castMasse(balls, cue, angle, path) {
  const d = { x: Math.cos(angle), y: Math.sin(angle) }, r = { x: -d.y, y: d.x };
  const at = (p) => ({ x: cue.x + d.x * p.s + r.x * p.l, y: cue.y + d.y * p.s + r.y * p.l, z: p.z });
  const curve = [at(path.pts[0])];
  let land = null;
  const touches = (p, b) => (p.x - b.x) ** 2 + (p.y - b.y) ** 2 + p.z * p.z < 4 * R * R;
  const off = (p) => p.x < R || p.x > W - R || p.y < R || p.y > H - R;
  for (let i = 1; i < path.pts.length; i++) {
    const a = curve[curve.length - 1], p = at(path.pts[i]);
    if (!land && a.z > 0 && p.z <= 0) land = { x: p.x, y: p.y };
    let hit = null;
    for (const [id, b] of balls) if (id !== cueId() && touches(p, b)) { hit = id; break; }
    if (hit === null && !off(p)) { curve.push(p); continue; }
    // between a and p: halve down to where it first touches
    const mix = (f) => ({ x: a.x + (p.x - a.x) * f, y: a.y + (p.y - a.y) * f, z: a.z + (p.z - a.z) * f });
    const hits = (q) => (hit !== null ? touches(q, balls.get(hit)) : off(q));
    let lo = 0, hi = 1;
    for (let n = 0; n < 12; n++) { const m = (lo + hi) / 2; if (hits(mix(m))) hi = m; else lo = m; }
    const ghost = mix(lo);
    curve.push(ghost);
    const len = Math.hypot(p.x - a.x, p.y - a.y) || 1;
    const dir = { x: (p.x - a.x) / len, y: (p.y - a.y) / len };
    const offTable = hit === null && ghost.z >= NOSE_H;
    let objDir = null, cueDir = null;
    if (hit !== null) {
      const b = balls.get(hit);
      const n = { x: b.x - ghost.x, y: b.y - ghost.y };
      const nl = Math.hypot(n.x, n.y) || 1;
      objDir = { x: n.x / nl, y: n.y / nl };
      const dot = dir.x * objDir.x + dir.y * objDir.y;
      cueDir = { x: dir.x - dot * objDir.x, y: dir.y - dot * objDir.y };
      const cl = Math.hypot(cueDir.x, cueDir.y);
      cueDir = cl > 1e-6 ? { x: cueDir.x / cl, y: cueDir.y / cl } : null;
    }
    return { ghost: { x: ghost.x, y: ghost.y }, hit, dir, objDir, cueDir, land, offTable, flight: true, curve, onCurve: true };
  }
  const end = curve[curve.length - 1];
  if (!path.dir) return { ghost: { x: end.x, y: end.y }, hit: null, dir: d, objDir: null, cueDir: null, land, offTable: false, flight: true, curve, onCurve: true };
  // rolling straight from here on
  const rest = castAim(balls, end, Math.atan2(d.y * path.dir.s + r.y * path.dir.l, d.x * path.dir.s + r.x * path.dir.l), null);
  return { ...rest, land, flight: true, curve };
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
  if (S.elev) msg.elevation = S.elev * DEG;
  closeSpinPop();
  if (send(msg)) {
    // The cue stays drawn back until the server's first snapshot says when
    // the cue ball moves; strikeAt then strikes it.
    dropHeldStrike();
    const cue = displayBalls().get(cueId()) || { x: 0, y: 0 };
    const dir = { x: Math.cos(S.angle), y: Math.sin(S.angle) };
    const f = addFx({ type: 'strike', layer: 'cue', dur: STRIKE_MS, delay: Infinity, cue: { ...cue }, dir, power: S.power, elev: S.elev * DEG });
    S.heldStrike = f;
    setTimeout(() => { if (S.heldStrike === f) dropHeldStrike(); }, STRIKE_WAIT_MS);
  }
}

// strikeAt lines the cue's strike up with the cue ball's first move, which
// the frame shows RENDER_DELAY_MS after the shot's first snapshot: the tip
// meets the ball then and the strike sounds then, however long the network
// took. Before, the click and the tip came at the release and the ball a
// round trip and RENDER_DELAY_MS later (about 0.25 s on a phone's 4G). Our
// own shot's cue has been held drawn back since the release; somebody
// else's strikes from their last aim. Returns the cue's elevation, for the
// replay.
function strikeAt(cueBall) {
  const now = performance.now();
  let f = S.heldStrike;
  S.heldStrike = null;
  if (!f && S.oppAim && cueBall) {
    const a = oppAimAngle(now);
    f = addFx({ type: 'strike', layer: 'cue', dur: STRIKE_MS, cue: { ...cueBall }, dir: { x: Math.cos(a), y: Math.sin(a) }, power: S.oppAim.power, elev: S.oppAim.elev });
  }
  playStrike(f ? f.power : 0.4, RENDER_DELAY_MS);
  if (!f) return 0;
  f.t0 = now;
  f.delay = Math.max(0, RENDER_DELAY_MS - STRIKE_HIT_MS);
  addFx({ type: 'ring', layer: 'top', dur: 150, t0: now, delay: RENDER_DELAY_MS, at: { ...f.cue } });
  return f.elev || 0;
}

// dropHeldStrike takes away a cue still waiting for its shot to start: the
// server refused the shot, or never answered.
function dropHeldStrike() {
  const f = S.heldStrike;
  S.heldStrike = null;
  const i = fx.indexOf(f);
  if (i >= 0) fx.splice(i, 1);
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
    readout.textContent = cancel ? T`Cancel` : `${(S.power * MAX_CUE_SPEED).toFixed(1)} m/s`;
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

// The pull is felt as well as seen on a phone that vibrates: a tick at each
// quarter of the bar, a longer one entering the cancel zone and on the shot.
const canVibrate = typeof navigator.vibrate === 'function';
const POWER_STEPS = 4;
function buzz(ms) {
  if (!S.haptics || !canVibrate || S.powerType === 'mouse') return;
  try { navigator.vibrate(ms); } catch { /* not allowed */ }
}
// powerStep is the part of the bar f is in: -1 the cancel zone, then 0 to 3.
const powerStep = (f) => (f <= CANCEL_ZONE ? -1 : Math.min(POWER_STEPS - 1, Math.floor(f * POWER_STEPS)));

powerBar.addEventListener('pointerdown', (e) => {
  if (!isMyShot() || S.powerDrag) return; // a second finger does not take the bar over
  e.preventDefault();
  powerBar.setPointerCapture(e.pointerId);
  S.powerDrag = true;
  S.powerPointer = e.pointerId;
  S.powerType = e.pointerType;
  S.powerBefore = S.power;
  powerClasses('pbar--drag');
  const f = barPower(e);
  S.powerStep = powerStep(f);
  S.powerY = e.clientY;
  setPower(barToPower(f), true);
});
powerBar.addEventListener('pointermove', (e) => {
  if (!S.powerDrag || e.pointerId !== S.powerPointer) return;
  const f = barPower(e);
  const step = powerStep(f);
  if (step !== S.powerStep) buzz(step < 0 ? 18 : 8);
  S.powerStep = step;
  S.powerY = e.clientY;
  setPower(barToPower(f), true);
});
// endPowerDrag finishes a pull: a release below the cancel zone shoots (if a
// call has been made), anything else restores the previous power.
function endPowerDrag(e, fire) {
  if (!S.powerDrag || (e && e.pointerId !== S.powerPointer)) return;
  S.powerDrag = false;
  S.powerPointer = null;
  const f = e ? barPower(e) : 0;
  if (fire && f > CANCEL_ZONE) {
    setPower(barToPower(f));
    if (canShoot()) {
      buzz(25);
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
  S.powerPointer = null;
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
  tip.textContent = needsPocket() && !S.call ? T`Call a pocket for the 8-ball: tap it.` : T`Cannot shoot now.`;
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
  if (S.spin.y > 0.15) parts.push(T`top`); else if (S.spin.y < -0.15) parts.push(T`draw`);
  if (S.spin.x > 0.15) parts.push(T`right`); else if (S.spin.x < -0.15) parts.push(T`left`);
  return parts.length ? parts.join(' + ') : T`centre`;
}

function renderSpin(spring) {
  const dot = $('spinDot');
  dot.classList.toggle('spin__dot--reset', !!spring);
  dot.style.left = `${50 + S.spin.x * SPIN_RANGE}%`;
  dot.style.top = `${50 - S.spin.y * SPIN_RANGE}%`;
  const atLimit = Math.hypot(S.spin.x, S.spin.y) >= 0.999;
  $('spinLimit').classList.toggle('spin__limit--max', atLimit);
  const words = spinWords();
  $('spinText').textContent = words;
  $('spinNote').classList.toggle('is-on', atLimit);
  spinPad.setAttribute('aria-valuetext', atLimit ? T`${words}, at the limit` : words);
  $('spinReset').disabled = !S.spin.x && !S.spin.y;
  // the phone's options button is a small cue ball showing the same spin
  const mini = $('optsDot');
  mini.style.left = `${50 + S.spin.x * SPIN_RANGE}%`;
  mini.style.top = `${50 - S.spin.y * SPIN_RANGE}%`;
  renderOptsBtn();
}

// renderOptsBtn names the spin the phone's cue-ball button shows; a brass
// ring round it says the cue is raised.
function renderOptsBtn() {
  const btn = $('optionsBtn');
  btn.setAttribute('aria-label', T`Spin: ${spinWords()}`);
  btn.classList.toggle('opts-btn--jump', S.elev > 0);
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

// --- jump: how far the butt of the cue is raised ---------------------------
//
// A raised cue drives the cue ball down into the slate and it bounces up off
// it: a jump shot (the server's Table.ShootElevated). Stood up past
// PIN_ELEV the cue keeps the ball down instead, and with english the ball
// curves: a massé, which the label then names. The slider sets the angle
// above the horizontal; the cue in the picture beside it tilts to match.
// Every new turn starts level.

const ELEV_MAX = 85; // degrees; mirrors game.MaxElevation
const elevRange = $('elevRange');
const elevBox = document.querySelector('#shotPanel .elev');

function setElev(deg) {
  const v = Math.max(0, Math.min(ELEV_MAX, Math.round(deg) || 0));
  const changed = v !== S.elev;
  S.elev = v;
  elevRange.value = String(v);
  elevRange.setAttribute('aria-valuetext', v ? T`${v} degrees` : T`level`);
  $('elevText').textContent = v ? `${v}°` : T`level`;
  $('elevLabel').textContent = v > Math.round(PIN_ELEV / DEG) ? T`Massé` : T`Jump`;
  $('elevCue').style.transform = `rotate(${v}deg)`;
  elevBox.classList.toggle('elev--on', v > 0);
  renderOptsBtn();
  if (changed) queueAim();
}
elevRange.addEventListener('input', () => setElev(Number(elevRange.value)));

// --- spin picker (phones) ----------------------------------------------------
//
// On a phone the shot panel holds what to hit, the situational toggles, the
// fine aim wheel, the jump slider and a small cue ball showing the spin. A
// drag on the small cue ball moves the tip's spot, as on the big pad; a tap
// opens the spin pad as a big cue ball in the middle of the screen over the
// dimmed table, so the spot is picked precisely; Done, a tap beside it or
// Escape puts it away.

const compactLayout = matchMedia('(max-width: 600px), (orientation: landscape) and (max-height: 500px)');
const spinBox = document.querySelector('#shotPanel .spin');
const spinHome = document.createComment('');
spinBox.before(spinHome);
const portraitPhone = matchMedia('(max-width: 600px) and (orientation: portrait), (max-width: 600px) and (min-height: 501px)');
const elevHome = document.createComment('');
elevBox.before(elevHome);
// Held upright in a rack the phone lays the shot's pieces out round the
// table in one of two ways (phoneMode): under it in a dock, or beside it in
// a column either side. What to hit and the shot's toggles go on the band
// over the table either way (statusCall). The pieces move there and back.
const callBox = document.querySelector('#shotPanel .call');
const callHome = document.createComment('');
callBox.before(callHome);
const angleBox = document.querySelector('#shotPanel .angle');
const angleHome = document.createComment('');
angleBox.before(angleHome);
const optsHome = document.createComment('');
$('optionsBtn').before(optsHome);
const trayHome = document.createComment('');
$('trayL').before(trayHome);
const chatHome = document.createComment('');
$('chatBtn').before(chatHome);
const replayHome = document.createComment('');
$('replayBtn').before(replayHome);
const phoneLayout = () => compactLayout.matches && portraitPhone.matches;

// phoneMode is the layout of a phone held upright for a rack, whichever
// leaves the table bigger (design/README.md, "In game"):
// - 'dock', a tall screen: only the 16 px power bar stands beside the
//   table. The fine aim wheel, the jump and the cue ball sit in a dock
//   under it; the balls each side still needs ride in the scoreboard, a
//   second row under the players.
// - 'side', a short screen (Safari with its bars): height runs out first,
//   so the scoreboard keeps to one row, and the balls and the tools stand in
//   a column either side: yours over the power bar, the opponent's over the
//   cue ball, the jump and the fine aim wheel, upright.
// - 'land', a phone on its side (design/README.md, "In game"): the 16 px
//   power bar at the left edge, the table, and one column on the right with
//   the room's buttons, the score with each side's balls, what to hit, and
//   at its foot the fine aim wheel, the cue ball and the jump.
// It is worked out from the screen alone, so neither Settings nor a panel
// coming and going swaps it. PHONE_DOCK and PHONE_SIDE are what each takes
// round the table, as style.css lays them out: across, the stage's padding,
// the columns and their gaps; down, the scoreboard, the band, the dock and
// the stage's padding.
const PHONE_DOCK = { w: 4 + 16 + 6 + 4, h: 60 + 28 + 76 + 8 };
const PHONE_SIDE = { w: 4 + 22 + 4 + 4 + 40 + 4, h: 40 + 28 + 8 };
function phoneMode() {
  if (!phoneLayout()) return compactLayout.matches ? 'land' : '';
  const cs = getComputedStyle(document.body);
  const w = document.documentElement.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const h = innerHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const across = (H + 2 * RAIL) / (W + 2 * RAIL); // the upright table's width for each unit of its height
  const dock = Math.min(w - PHONE_DOCK.w, (h - PHONE_DOCK.h) * across);
  const side = Math.min(w - PHONE_SIDE.w, (h - PHONE_SIDE.h) * across);
  return dock >= side ? 'dock' : 'side';
}

// applyPhoneMode sets body.phone-dock or body.phone-side (style.css lays a
// rack out by them) and moves the pieces when that changes. resize() calls
// it first, so the table is measured in the layout it ends up in.
let phoneSet = null, phoneKey = '';
function applyPhoneMode() {
  const key = `${phoneLayout()} ${compactLayout.matches} ${innerWidth}x${innerHeight} ${W}`;
  if (key === phoneKey) return;
  phoneKey = key;
  const mode = phoneMode();
  document.body.classList.toggle('phone-dock', mode === 'dock');
  document.body.classList.toggle('phone-side', mode === 'side');
  document.body.classList.toggle('phone-land', mode === 'land');
  if (mode !== phoneSet) { phoneSet = mode; placeShotOptions(); }
}

// placeShotOptions puts the spin pad in the picker on a phone and, held
// upright, the shot's other pieces where phoneMode lays them out; back in
// the shot panel elsewhere.
function placeShotOptions() {
  if (compactLayout.matches) {
    $('spinPopBody').append(spinBox);
  } else {
    spinHome.after(spinBox);
    closeSpinPop();
  }
  const mode = phoneSet || '';
  if (mode) $('status').append(callBox);
  else callHome.after(callBox);
  if (mode === 'side') {
    $('sideTools').append($('optionsBtn'), elevBox, angleBox);
  } else {
    angleHome.after(angleBox);
    elevHome.after(elevBox);
    optsHome.after($('optionsBtn'));
  }
  if (mode === 'dock' || mode === 'land') $('top').append($('trayL'), $('trayR'));
  else trayHome.after($('trayL'), $('trayR'));
  if (mode === 'land') $('top').append($('chatBtn'), $('replayBtn'));
  else { chatHome.after($('chatBtn')); replayHome.after($('replayBtn')); }
  $('aimJog').classList.toggle('jog--v', mode === 'side');
  // held upright the bar stands on the left: the switch takes it right
  $('leftyToggle').querySelector('.toggle__title').textContent = mode ? T`Power bar on the right` : T`Power bar on the left`;
}

function openSpinPop() {
  if (!compactLayout.matches || !isMyShot()) return;
  $('spinPop').hidden = false;
  $('optionsBtn').setAttribute('aria-expanded', 'true');
  spinPad.focus({ preventScroll: true });
}

function closeSpinPop() {
  if ($('spinPop').hidden) return;
  $('spinPop').hidden = true;
  $('optionsBtn').setAttribute('aria-expanded', 'false');
}

// The small cue ball is a spin pad too: a finger dragged on it carries the
// dot along (its travel to the limit is the dot's), from where the spin
// was, so it never jumps to the finger; a tap opens the big pad.
const optsBtn = $('optionsBtn');
let optsDrag = null, optsDragged = false;
optsBtn.addEventListener('pointerdown', (e) => {
  optsDragged = false;
  if (!isMyShot() || optsDrag) return;
  optsDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, spin: { ...S.spin }, moved: false };
  optsBtn.setPointerCapture(e.pointerId);
});
optsBtn.addEventListener('pointermove', (e) => {
  if (!optsDrag || e.pointerId !== optsDrag.id) return;
  const dx = e.clientX - optsDrag.x, dy = e.clientY - optsDrag.y;
  if (!optsDrag.moved && Math.hypot(dx, dy) < 6) return; // a tap may wobble
  if (!optsDrag.moved) { optsDrag.moved = true; optsBtn.classList.add('opts-btn--drag'); }
  const full = optsBtn.getBoundingClientRect().width / 2 * SPIN_LIMIT; // px from the centre to the limit
  setSpin(optsDrag.spin.x + dx / full, optsDrag.spin.y - dy / full);
});
const endOptsDrag = (e) => {
  if (!optsDrag || e.pointerId !== optsDrag.id) return;
  optsDragged = e.type === 'pointerup' && optsDrag.moved;
  optsDrag = null;
  optsBtn.classList.remove('opts-btn--drag');
};
optsBtn.addEventListener('pointerup', endOptsDrag);
optsBtn.addEventListener('pointercancel', endOptsDrag);
optsBtn.onclick = () => {
  if (optsDragged) { optsDragged = false; return; } // the end of a drag, not a tap
  if ($('spinPop').hidden) openSpinPop(); else closeSpinPop();
};
$('spinPopDone').onclick = () => { closeSpinPop(); $('optionsBtn').focus({ preventScroll: true }); };
// a tap on the dimmed table beside the card puts it away
$('spinPop').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSpinPop(); });
$('spinPop').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSpinPop(); $('optionsBtn').focus({ preventScroll: true }); }
  e.stopPropagation(); // the game's keys (aim, shoot) wait while it is open
});
portraitPhone.addEventListener('change', () => { applyPhoneMode(); placeShotOptions(); });
compactLayout.addEventListener('change', () => {
  applyPhoneMode();
  placeShotOptions();
  refreshPanels();
  if (!readSetting('pool:view')) setView(initialView(), false);
});
applyPhoneMode();
placeShotOptions();

function queueAim() {
  if (!isMyShot()) return;
  const now = performance.now();
  const due = S.lastAimSent + AIM_SEND_MS - now;
  if (due <= 0) {
    S.lastAimSent = now;
    const msg = { type: 'aim', angle: S.angle, power: S.power };
    if (S.elev) msg.elevation = S.elev * DEG;
    send(msg);
  } else if (!S.aimTimer) {
    S.aimTimer = setTimeout(() => { S.aimTimer = 0; queueAim(); }, due);
  }
}

function setAngle(a) {
  S.angle = Math.atan2(Math.sin(a), Math.cos(a));
  // two decimals: the fine aim wheel turns by hundredths
  $('angleText').textContent = `${((S.angle / DEG + 360) % 360).toFixed(2).replace(/^360\.00$/, '0.00')}°`;
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
  railLip: '#FFE2B4',
  ivory: '#F4EFE2', disc: '#FAF7EF', ink: '#111316',
  brass: '#D9A441', brassLine: '#E3B25C', ok: '#71C99D', oppAim: '#A9C1DD', warn: '#E0614F',
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
  const e = { t0: performance.now(), delay: 0, ...f, dur: reduceMotion.matches ? 0 : f.dur };
  fx.push(e);
  return e;
}
// fxProgress is how far f has run at now, null before it starts; a strike
// shows its first pose, the cue drawn back, while it waits.
function fxProgress(f, now) {
  const el = now - f.t0 - f.delay;
  if (el < 0) return f.type === 'strike' ? 0 : null;
  return f.dur > 0 ? clamp01(el / f.dur) : 1;
}
function drawFx(layer, now) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i];
    if (f.layer !== layer) continue;
    const p = fxProgress(f, now);
    if (p === null) continue;
    FX[f.type](f, p);
    if (p >= 1) fx.splice(i, 1);
  }
}
const FX = {
  // the cue advances to the ball, then fades
  strike(f, p) {
    const { back, alpha } = strikePose(f.power, p, f.dur);
    drawCue(f.cue, f.dir, back, alpha, f.elev);
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
  // a ball that flew off the table falls out of sight beyond the rail (in
  // 3D, f.path takes it to the floor: see draw3d)
  gone(f, p) {
    if (f.path) return;
    const e = EASE.in(p);
    const x = f.from.x + f.dir.x * 0.06 * e, y = f.from.y + f.dir.y * 0.06 * e;
    drawBall(f.id, { x, y }, { scale: heightScale(f.from) * (1 - 0.3 * e), alpha: 1 - p });
  },
  rim(f, p) {
    const e = EASE.out(p);
    ctx.strokeStyle = rgba(PAL.flash, 0.5 * (1 - e));
    ctx.lineWidth = 0.006;
    tracePocket(f.pk);
    ctx.stroke();
  },
};

// strikePose: where the cue's tip is (back, metres behind the ball's
// centre) and how visible, p of the way through a strike lasting dur ms.
function strikePose(power, p, dur) {
  const hit = STRIKE_HIT_MS / Math.max(dur, STRIKE_HIT_MS);
  if (p < hit) return { back: R + (0.02 + powerToBar(power) * 0.12) * (1 - EASE.in(p / hit)), alpha: 1 };
  return { back: R, alpha: 1 - EASE.out((p - hit) / (1 - hit)) };
}

// pocketHole is the dark drop of a pocket as a circle: where the drop
// animation sinks a ball, where the rim flashes and what a pocket call rings.
// A corner pocket is a round hole whose near edge is the shelf (a ball drops
// once its centre is past it, so the felt shows up to 6 mm before); a side
// pocket has no shelf to speak of: straight jaws for 20 mm from the noses,
// then a half circle, see tracePocket.
function pocketHole(pk) {
  if (pk.side) {
    const d = 0.02;
    const r = pk.half + d * Math.tan(SPEC.sideJaw * DEG - Math.PI / 2);
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
// vel is how fast it was going when last seen, or null.
function queueDrop(id, from, t, vel) {
  S.pendingDrops.push({ id, from, t, vel });
}
// ballVel is ball id's velocity (m/s, z up) between snapshots a and b, or
// null when either is missing or lacks it.
function ballVel(a, b, id) {
  const p = a && a.balls.get(id), q = b && b.balls.get(id);
  const dt = a && b ? (b.t - a.t) / 1000 : 0;
  if (!p || !q || dt <= 0) return null;
  return { x: (q.x - p.x) / dt, y: (q.y - p.y) / dt, z: ((q.z || 0) - (p.z || 0)) / dt };
}
// startDrop animates a ball leaving play from where it was last seen: into
// the nearest pocket, or, when it was last seen over a rail and away from
// every pocket, or when off says it left the table, falling off the table
// (it jumped). In 3D a ball off the table goes down to the floor, bounces and
// rolls until it stops.
function startDrop(id, from, vel, off) {
  const { d, pk, hole } = nearestPocket(from) || { d: Infinity }; // a carom table has no pockets
  if (off || !pk || (offTheBed(from) && d > hole.r + 2 * R)) {
    if (!offTheBed(from)) [from, vel] = flyOff(from, vel);
    const cx = Math.max(0, Math.min(W, from.x)), cy = Math.max(0, Math.min(H, from.y));
    const l = Math.hypot(from.x - cx, from.y - cy) || 1;
    const dir = { x: (from.x - cx) / l, y: (from.y - cy) / l };
    if (!v3) { addFx({ type: 'gone', layer: 'balls', dur: 240, id, from, dir }); return; }
    const path = fallPath(from, vel, dir, l);
    addFx({
      type: 'gone', layer: 'balls', dur: path.length * FALL_STEP_MS + FALL_HOLD_MS, id, from, dir, path,
      o: Float64Array.from(orientationOf(id)), last: from, replay: !!S.replay,
    });
    return;
  }
  addFx({ type: 'drop', layer: 'balls', dur: v3 ? 360 : 180, id, from, to: hole });
  addFx({ type: 'rim', layer: 'top', dur: 120, pk });
}

// flyOff carries a ball that left the table but was last seen over the bed
// on at vel to where it crosses a cushion nose (or straight to the nearest
// one), and returns that point and its velocity there.
function flyOff(p, vel) {
  const z0 = p.z || 0;
  if (vel) {
    for (let t = 0.005; t < 0.5; t += 0.005) {
      const q = { x: p.x + vel.x * t, y: p.y + vel.y * t, z: Math.max(0, z0 + vel.z * t - GRAVITY * t * t / 2) };
      if (offTheBed(q)) return [q, { x: vel.x, y: vel.y, z: vel.z - GRAVITY * t }];
    }
  }
  const sides = [[p.x, { x: -1e-3, y: p.y }], [W - p.x, { x: W + 1e-3, y: p.y }], [p.y, { x: p.x, y: -1e-3 }], [H - p.y, { x: p.x, y: H + 1e-3 }]];
  sides.sort((a, b) => a[0] - b[0]);
  return [{ ...sides[0][1], z: z0 }, vel];
}
// fallPath works out a ball's way from where it left the table in 3D to
// where it comes to rest on the floor: a point {x, y, z} (z the ball's bottom
// above the bed) every FALL_STEP_MS. Over the rail it comes down onto it,
// rolls over its outer edge and drops; the floor takes some of each bounce,
// then it rolls, slowing, until it stops, back off the arena's boards if it
// reaches them. It leaves going outward, however slowly it was last seen.
const FALL_STEP_MS = 1000 / 120;
const FALL_HOLD_MS = 900; // it lies on the floor this long, then is gone
const FLOOR_BOUNCE = 0.45, RAIL_BOUNCE = 0.3; // what a bounce keeps of the speed into it
const FLOOR_SKID = 0.6; // what a bounce on the floor keeps of the speed along it
const FLOOR_ROLL = 2.5; // m/s², how fast it slows rolling on the floor
const BOARD_BOUNCE = 0.4; // what a bounce off the arena's boards keeps
function fallPath(from, vel, dir, out) {
  const dt = FALL_STEP_MS / 1000;
  const ex = from.x - dir.x * out, ey = from.y - dir.y * out; // the edge of the bed
  const outOf = (x, y) => (x - ex) * dir.x + (y - ey) * dir.y;
  // the rail's top, then round its outer edge as the ball rolls over it
  const railAt = (o) => (o < RAIL ? RAIL_TOP : o < RAIL + R ? RAIL_TOP + Math.sqrt(R * R - (o - RAIL) ** 2) - R : -Infinity);
  let x = from.x, y = from.y, z = from.z || 0;
  let vx = vel ? vel.x : 0, vy = vel ? vel.y : 0, vz = vel ? vel.z : 0;
  const vn = vx * dir.x + vy * dir.y;
  if (vn < 0.5) { vx += (0.5 - vn) * dir.x; vy += (0.5 - vn) * dir.y; }
  const sp = Math.hypot(vx, vy);
  if (sp > 3) { vx *= 3 / sp; vy *= 3 / sp; }
  if (outOf(x, y) < RAIL && z < RAIL_TOP) { z = RAIL_TOP; vz = Math.max(0, vz); }
  const floor = -FLOOR_DROP;
  const b = boardsRect();
  const pts = [];
  for (let i = 0; i < 1200; i++) {
    pts.push({ x, y, z });
    const rolling = z === floor && vz === 0;
    if (rolling) {
      const s = Math.hypot(vx, vy), left = s - FLOOR_ROLL * dt;
      if (left <= 0.002) break;
      vx *= left / s; vy *= left / s;
    } else vz -= GRAVITY * dt;
    const zWas = z, railWas = railAt(outOf(x, y));
    x += vx * dt; y += vy * dt; z += vz * dt;
    const rail = railAt(outOf(x, y));
    if (z < rail && zWas >= railWas - 1e-4) {
      z = rail;
      vz = vz < -0.4 ? -vz * RAIL_BOUNCE : 0;
    } else if (z < floor) {
      z = floor;
      if (vz < -0.3) {
        vz = -vz * FLOOR_BOUNCE;
        vx *= FLOOR_SKID; vy *= FLOOR_SKID;
      } else vz = 0;
    }
    if (z < BOARD_TOP) {
      if (x < b.x0 + R || x > b.x1 - R) { x = Math.max(b.x0 + R, Math.min(b.x1 - R, x)); vx = -vx * BOARD_BOUNCE; }
      if (y < b.y0 + R || y > b.y1 - R) { y = Math.max(b.y0 + R, Math.min(b.y1 - R, y)); vy = -vy * BOARD_BOUNCE; }
    }
  }
  return pts;
}
// fallAt is where the falling ball of fx f is p of the way through it.
function fallAt(f, p) {
  const i = Math.min(f.path.length - 1, (p * f.dur) / FALL_STEP_MS);
  const a = f.path[Math.floor(i)], b = f.path[Math.min(f.path.length - 1, Math.floor(i) + 1)], u = i - Math.floor(i);
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u };
}
// offTheBed: a ball at p has its centre beyond a cushion nose.
const offTheBed = (p) => p.x < 0 || p.x > W || p.y < 0 || p.y > H;
// heightScale is how much bigger a ball in the air looks from above.
const heightScale = (p) => 1 + Math.min(1, 2.2 * (p.z || 0));

// --- 3D view ----------------------------------------------------------------
// view3d.js draws the table in 3D (CLIENT.md, "3D view"). It is loaded the
// first time 3D is turned on; the 2D canvas then lies over it, transparent,
// for the labels and the pointer, and toTable/toScreen go through the 3D
// camera so the input code is the same in both views.

let v3 = null;       // the 3D view while it is on
let canvas3d = null; // its canvas, under the 2D one
let v3Loading = false;

// initialView: the stored choice, else 3D on a desktop and 2D on a phone,
// where the flat table aims more precisely and spares the battery.
function initialView() {
  const v = readSetting('pool:view');
  return v === '2d' || v === '3d' ? v : compactLayout.matches ? '2d' : '3d';
}

function setQuality(q) {
  S.quality = q;
  writeSetting('pool:quality', q === 'auto' ? null : q);
  pace.cap = 3; // a fresh start for Auto too
  if (v3) v3.setLevel(q);
  resize();
  renderSettings();
}

function setView(v, save) {
  if (save) writeSetting('pool:view', v);
  if (v === '3d' && S.view !== '3d') S.camTop = false; // turned on, 3D starts from behind the cue
  S.view = v;
  if (v === '3d' && !v3 && !v3Loading) start3d();
  if (v === '2d' && v3) stop3d();
  renderViewControls();
}

function start3d() {
  const c = document.createElement('canvas');
  c.className = 'stage__table3d';
  c.setAttribute('aria-hidden', 'true');
  // No WebGL: say so without downloading the library.
  const gl = c.getContext('webgl2', { antialias: true, powerPreference: 'high-performance' });
  if (!gl) { no3d(); return; }
  v3Loading = true;
  import('/view3d.js').then((m) => {
    v3Loading = false;
    if (S.view !== '3d') { letGo(gl); return; }
    canvas.before(c);
    try {
      v3 = m.createView3D(c, view3dKit(() => lost3d(c)));
    } catch (err) {
      c.remove();
      letGo(gl);
      throw err;
    }
    canvas3d = c;
    document.body.classList.add('is-3d');
    resize();
    renderViewControls();
  }).catch((err) => {
    // a fault of ours, not of the device: say so in the console (the e2e
    // scenarios fail on it), then fall back to the flat table
    if (err && !/import|fetch|module/i.test(String(err.message))) console.error('3D failed:', err);
    v3Loading = false;
    letGo(gl);
    no3d();
  });
}
// letGo hands a WebGL context back at once: a page holds only so many
// (16 in Chrome), and past that the browser takes the oldest away.
function letGo(gl) {
  const ext = gl.isContextLost() ? null : gl.getExtension('WEBGL_lose_context');
  if (ext) ext.loseContext();
}

function no3d() {
  S.view = '2d';
  if (!no3d.said) toast(T`3D is not available here. Showing the table from above.`); // once a visit
  no3d.said = true;
  renderViewControls();
}

function stop3d() {
  v3.dispose();
  drop3d();
}
// drop3d takes the 3D canvas away and lays the flat table out again.
function drop3d() {
  canvas3d.remove();
  v3 = null;
  canvas3d = null;
  document.body.classList.remove('is-3d');
  resize();
}

// lost3d: the GPU took the 3D view's context away (a driver reset, a phone
// reclaiming memory in the background). The table shows flat meanwhile and
// 3D is built again once the page is in sight; a second loss within a
// minute gives up, back to 2D with a notice.
let lostAt = -Infinity;
function lost3d(c) {
  if (!v3 || canvas3d !== c) return;
  v3.dispose();
  drop3d();
  const now = performance.now();
  const again = now - lostAt < 60000;
  lostAt = now;
  if (again) no3d();
  else rebuild3d();
}
function rebuild3d() {
  if (S.view !== '3d' || v3 || v3Loading) return;
  if (document.hidden) { document.addEventListener('visibilitychange', rebuild3d, { once: true }); return; }
  start3d();
}

// view3dKit is what the 3D view needs to know about the table; onLost is
// called if the GPU takes its context away.
function view3dKit(onLost) {
  return {
    W, H, R, RAIL, CUSHION, HEAD,
    cushions: TABLE.cushions,
    holes: POCKETS.map(pocketHole),
    felt: feltCanvas(),
    colors: {
      rail: look().rail, railBottom: look().railBottom, cushion: clothShades(S.cloth).cushion, sight: look().sight,
      ivory: PAL.ivory, disc: PAL.disc, ink: PAL.ink, ok: PAL.ok,
    },
    ballColors: BALL_COLORS,
    carom: isCarom() ? { colors: CAROM_COLORS, dots: CAROM_DOTS } : null, // plain balls with six dots, no numbers
    cueSegments: CUE_SEGMENTS,
    cueLength: CUE_LEN,
    look: look(),
    boards: boardsRect(),
    info: arenaInfo(),
    reduceMotion: () => reduceMotion.matches,
    level: S.quality,
    onLost,
  };
}

// arenaInfo is what the arena's LED boards show (arena3d.js): the game, the
// players with the match score, and the room.
function arenaInfo() {
  const m = S.practice ? null : S.match;
  return {
    mode: S.mode, practice: S.practice, room: S.roomCode, table: isCarom() ? '' : SPEC.name,
    names: isTeams() ? [0, 1].map((sd) => teamNames(sd).join(' & ')) : S.players.map((p) => p.name || ''),
    score: m ? m.score : null, race: m ? m.race : 0,
    // the boards' words, in the language shown (arena3d.js upper-cases them)
    words: {
      practice: T`PRACTICE`, room: T`ROOM`,
      goal: !m || !m.race ? '' : isCarom() ? T`${m.race} POINTS` : T`RACE TO ${m.race}`,
      slogan: isCarom() ? T`THREE CUSHIONS` : isNine() ? T`LOWEST BALL FIRST` : T`CALL YOUR SHOT`,
    },
  };
}

// feltCanvas draws the 2D table from above, unrotated, as the 3D cloth.
function feltCanvas() {
  const PX = 800; // per metre
  const off = document.createElement('canvas');
  off.width = Math.round((W + 2 * RAIL) * PX);
  off.height = Math.round((H + 2 * RAIL) * PX);
  const live = ctx;
  ctx = off.getContext('2d');
  ctx.setTransform(PX, 0, 0, PX, RAIL * PX, RAIL * PX);
  drawTableStatic();
  ctx = live;
  return off;
}

function toggleCamTop() {
  S.camTop = !S.camTop;
  renderViewControls();
}

// behindCue: the 3D camera is behind the cue, where a sideways drag turns
// the aim (turnAim) rather than pointing on the table.
const behindCue = () => !!v3 && v3.mode === 'aim';

function renderViewControls() {
  const three = S.view === '3d';
  const vb = $('viewBtn');
  vb.querySelector('.view-btn__text').textContent = three ? '2D' : '3D';
  vb.setAttribute('aria-label', three ? T`Show the table from above` : T`Show the table in 3D`);
  vb.title = `${three ? T`Show the table from above` : T`Show the table in 3D`} (V)`;
  $('camTopBtn').hidden = !v3;
  $('camTopBtn').setAttribute('aria-pressed', String(S.camTop));
  for (const b of $('viewSeg').querySelectorAll('.seg__btn')) b.setAttribute('aria-pressed', String(b.dataset.view === S.view));
}

// --- geometry helpers -------------------------------------------------------

function resize() {
  applyPhoneMode();
  const wrap = $('tableWrap');
  const cs = getComputedStyle(wrap);
  const bar = $('powerBar');
  const gap = parseFloat(cs.columnGap || cs.gap || '12') || 0;
  const barW = bar.hidden ? 0 : bar.getBoundingClientRect().width + gap || 0;
  const room = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  // a phone held upright in a rack: the table's column of the grid
  const cols = cs.display === 'grid' ? cs.gridTemplateColumns.split(' ').map(parseFloat) : null;
  const availW = cols && cols.length === 3 ? Math.max(100, cols[1]) : Math.max(100, room - barW);
  const availH = Math.max(100, wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
  const dpr = Math.min(S.quality === 'auto' ? pace.cap : QUALITY_DPR[S.quality], window.devicePixelRatio || 1);
  pace.times = [];
  pace.skip = 10;
  wakeDraw();
  if (v3) {
    // 3D fills the stage; the 2D canvas lies over it for labels and input
    view.rotated = false;
    view.cssW = Math.floor(availW);
    view.cssH = Math.floor(availH);
    view.dpr = dpr;
    canvas.width = Math.round(view.cssW * dpr);
    canvas.height = Math.round(view.cssH * dpr);
    canvas.style.width = `${view.cssW}px`;
    canvas.style.height = `${view.cssH}px`;
    canvas3d.style.width = `${view.cssW}px`;
    canvas3d.style.height = `${view.cssH}px`;
    canvas3d.style.left = `${canvas.offsetLeft}px`;
    canvas3d.style.top = `${canvas.offsetTop}px`;
    v3.resize(view.cssW, view.cssH, dpr);
    view.s = v3.pxPerM({ x: W / 2, y: H / 2 });
    const top = $('camTopBtn');
    top.style.left = `${canvas.offsetLeft + view.cssW - 52}px`;
    top.style.top = `${canvas.offsetTop + 8}px`;
    placeGlow();
    tableCache = null;
    return;
  }
  const fullW = W + 2 * RAIL, fullH = H + 2 * RAIL;
  const sLand = Math.min(availW / fullW, availH / fullH);
  const sPort = Math.min(availW / fullH, availH / fullW);
  // A portrait screen gets the table upright unless lying down is clearly
  // bigger (5 %): a tablet held upright, where the two come out about even,
  // keeps it upright like a phone, without bands of nothing over and under
  // it. Elsewhere only rotate when it is clearly better.
  // The way round is chosen as if the power bar were there: it comes and
  // goes with the rack, and the table must not turn with it (a tablet held
  // upright turned it sideways for the lobby and the game over).
  const turnW = cols && cols.length === 3 ? availW : Math.max(100, room - (bar.hidden ? (parseFloat(getComputedStyle(bar).width) || 40) + gap : barW));
  const tLand = Math.min(turnW / fullW, availH / fullH), tPort = Math.min(turnW / fullH, availH / fullW);
  const portrait = window.innerHeight > window.innerWidth;
  view.rotated = portrait ? tPort >= tLand * 0.95 : tPort > tLand * 1.15;
  view.s = view.rotated ? sPort : sLand;
  view.cssW = Math.floor(view.rotated ? fullH * view.s : fullW * view.s);
  view.cssH = Math.floor(view.rotated ? fullW * view.s : fullH * view.s);
  view.ox = RAIL * view.s;
  view.oy = RAIL * view.s;
  canvas.width = Math.round(view.cssW * dpr);
  canvas.height = Math.round(view.cssH * dpr);
  canvas.style.width = `${view.cssW}px`;
  canvas.style.height = `${view.cssH}px`;
  view.dpr = dpr;
  placeGlow();
  renderTableCache();
}

// placeGlow lays the your-move light over the table canvas.
function placeGlow() {
  const g = $('turnGlow').style;
  g.left = `${canvas.offsetLeft}px`;
  g.top = `${canvas.offsetTop}px`;
  g.width = `${view.cssW}px`;
  g.height = `${view.cssH}px`;
}

// toTable converts a pointer position (CSS px within the canvas) to meters.
function toTable(px, py) {
  if (v3) return v3.pick(px, py);
  if (!view.rotated) return { x: (px - view.ox) / view.s, y: (py - view.oy) / view.s };
  return { x: W - (py - view.oy) / view.s, y: (px - view.ox) / view.s };
}
// toScreen is the inverse: meters to CSS px within the canvas.
function toScreen(p) {
  if (v3) return v3.project(p);
  if (!view.rotated) return { x: view.ox + p.x * view.s, y: view.oy + p.y * view.s };
  return { x: view.ox + p.y * view.s, y: view.oy + (W - p.x) * view.s };
}

// pxPerM is how many CSS px a metre spans at p: the same everywhere from
// above, smaller far away in 3D.
function pxPerM(p) { return v3 && p ? v3.pxPerM(p) : view.s; }

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
  if (S.replay) return interpSnaps(S.replay.shot.snaps, replayClock());
  if (S.snaps.length === 0) {
    const held = S.drag || S.placedAt;
    if (held) {
      const m = new Map(S.balls);
      m.set(held.id, { x: held.x, y: held.y });
      return m;
    }
    return S.balls;
  }
  return interpSnaps(S.snaps, renderClock());
}
// interpSnaps places the balls at shot time t between two snapshots.
function interpSnaps(snaps, t) {
  if (t <= snaps[0].t) return snaps[0].balls;
  let i = snaps.length - 1;
  while (i > 0 && snaps[i].t > t) i--;
  if (i >= snaps.length - 1) return snaps[snaps.length - 1].balls;
  const a = snaps[i], b = snaps[i + 1];
  const f = (t - a.t) / Math.max(1, b.t - a.t);
  const out = new Map();
  for (const [id, pa] of a.balls) {
    const pb = b.balls.get(id);
    if (!pb) { out.set(id, pa); continue; }
    const p = { x: pa.x + (pb.x - pa.x) * f, y: pa.y + (pb.y - pa.y) * f };
    if (pa.z || pb.z) p.z = (pa.z || 0) + ((pb.z || 0) - (pa.z || 0)) * f;
    out.set(id, p);
  }
  return out;
}
function renderClock() { return performance.now() - S.shotWall0 - RENDER_DELAY_MS; }

// --- the frame --------------------------------------------------------------

function draw() {
  requestAnimationFrame(draw);
  if (!view.cssW) return;
  const now = performance.now();
  if (skipFrame(now)) return;

  // pending pocket drops whose snapshot time has been reached
  if (S.pendingDrops.length) {
    const t = renderClock();
    while (S.pendingDrops.length && S.pendingDrops[0].t <= t) {
      const d = S.pendingDrops.shift();
      startDrop(d.id, d.from, d.vel);
    }
  }
  if (S.replay) tickReplay(now);

  const balls = displayBalls();
  const myShot = isMyShot() && !S.replay;
  const cue = balls.get(cueId());
  const placingInKitchen = myShot && S.ballInHand && S.kitchen;
  const striking = fx.some((f) => f.type === 'strike');
  let aim = null; // {angle, power, mine, alpha}
  if (cue && myShot && !S.drag) {
    const a = S.aimShownAt ? EASE.out(clamp01((now - S.aimShownAt) / 200)) : 1;
    aim = { angle: S.angle, power: S.power, elev: S.elev * DEG, mine: true, alpha: reduceMotion.matches ? 1 : a };
  } else if (cue && S.oppAim && inPlay() && !S.moving && !S.replay && S.turn !== S.seat) {
    aim = { angle: oppAimAngle(now), power: S.oppAim.power, elev: S.oppAim.elev, mine: false, alpha: 1 };
  }
  const lifted = S.drag ? S.drag.id : -1;
  const lift = S.drag ? liftAmount(now) : 0;
  for (const [id, p] of balls) rollBall(id, p);
  if (v3) {
    draw3d(now, balls, { aim, myShot, cue, placingInKitchen, striking, lifted, lift });
    return;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (tableCache) ctx.drawImage(tableCache, 0, 0);
  applyTableTransform();
  if (placingInKitchen) drawKitchenWash();

  // aim guide goes under the balls
  const cast = aim ? drawAim(balls, cue, aim, aim.alpha) : null;

  // shadows, then bodies, a ball in the air over the ones on the cloth
  for (const [id, p] of balls) drawBallShadow(p, id === lifted ? lift : 0);
  const order = [...balls].sort((a, b) => (a[1].z || 0) - (b[1].z || 0));
  for (const [id, p] of order) {
    const scale = (id === lifted ? 1 + 0.05 * lift : 1) * heightScale(p);
    drawBall(id, p, scale !== 1 ? { scale } : undefined);
  }
  drawFx('balls', now);

  // cue stick above the balls
  if (aim && !striking) {
    const dir = { x: Math.cos(aim.angle), y: Math.sin(aim.angle) };
    drawCue(cue, dir, R + 0.02 + powerToBar(aim.power) * 0.12, aim.mine ? aim.alpha : 0.4 * aim.alpha, aim.elev);
  }
  const rc = S.replay && replayCue(now);
  if (rc) drawCue(rc, rc.dir, rc.back, rc.alpha, rc.elev);
  drawFx('cue', now);

  // rings
  if (myShot && canCall()) {
    for (const id of legalTargets()) {
      const p = balls.get(id);
      if (p) ring(p, R + 0.010, rgba('#FFFFFF', 0.55), 0.003);
    }
  }
  const next = pointerBall(balls);
  if (next !== null && balls.has(next)) ring(balls.get(next), R + 0.016, PAL.brass, 0.004);
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

  drawLabels(balls, cast, aim, cue, now);
  drawFx('top', now);
  drawLoupe(aim && aim.mine ? cast : null, balls);
  checkPace(performance.now() - now);
}

// --- pace ----------------------------------------------------------------------
//
// A slow device (an old phone, a browser drawing without the GPU) spends
// long on each frame of the flat table at a pixel ratio of 3. checkPace
// times the drawing itself, not the gap between frames, which a phone in low
// power mode stretches to 33 ms on its own: when the median of a window of
// 60 frames is over 8 ms, the ratio steps down by half, to 1 at least. It
// never steps back up, so the picture does not pump. The first frames after
// a resize (the cached table is redrawn) are not counted.

const PACE_FRAMES = 60;
const PACE_SLOW_MS = 8;
const pace = { cap: 3, times: [], skip: 10 };

function checkPace(ms) {
  if (S.quality !== 'auto') return;
  if (pace.skip > 0) { pace.skip--; return; }
  if (view.dpr <= 1) return;
  pace.times.push(ms);
  if (pace.times.length < PACE_FRAMES) return;
  const sorted = pace.times.sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  pace.times = [];
  if (median <= PACE_SLOW_MS) return;
  pace.cap = Math.max(1, view.dpr - 0.5);
  resize();
}

// --- rest --------------------------------------------------------------------
//
// Nothing on the flat table moves by itself: a shot, a replay, an effect, a
// carried ball or the opponent's aim each come from a message or a finger.
// So while none of those is under way and no input or message has come for
// REST_AFTER_MS, the frame is drawn only every REST_FRAME_MS. A phone
// waiting for the opponent then barely draws, which saves the battery and
// keeps it cool. The first touch, key or message draws at full rate again;
// the slow frames are only a safety net. 3D keeps every frame: its camera
// glides on its own. Graphics → Low spaces every frame LOW_FRAME_MS apart,
// about 30 a second, in 2D and 3D. Behind the landing, where the table only
// shows blurred or not at all, either is drawn every LANDING_FRAME_MS.

const REST_AFTER_MS = 3000;
const REST_FRAME_MS = 250;
const LOW_FRAME_MS = 30; // under 33 ms: a 60 Hz screen draws every other refresh
// over 500 ms, a gap the 3D view's checkSpeed takes for a stall, not for a
// slow device
const LANDING_FRAME_MS = 600;
const rest = { hotUntil: 0, last: 0 };

function wakeDraw() { rest.hotUntil = performance.now() + REST_AFTER_MS; }
for (const t of ['pointerdown', 'pointermove', 'keydown', 'wheel']) window.addEventListener(t, wakeDraw, { capture: true, passive: true });
document.addEventListener('visibilitychange', wakeDraw);

// skipFrame reports whether this frame may be skipped.
function skipFrame(now) {
  const resting = !v3 && now >= rest.hotUntil &&
    !(S.moving || S.snaps.length || S.replay || S.pendingDrops.length || fx.length || S.drag || S.pointer !== null);
  const gap = !$('landing').hidden ? LANDING_FRAME_MS : resting ? REST_FRAME_MS : S.quality === 'low' ? LOW_FRAME_MS : 0;
  if (now - rest.last < gap) return true;
  rest.last = now;
  return false;
}

// --- loupe -------------------------------------------------------------------
//
// On a phone the balls are about 10 px across and the finger covers the
// cue's end of the line, so while a finger aims (on the felt, the fine aim
// wheel or the power bar) a circle in a corner shows the contact magnified:
// the ghost ball and the ball it hits. The corner is the one clear of the
// contact and of the hand; it changes only when the one in use gets in the
// way. A copy of the frame just drawn, so it costs one drawImage.

const LOUPE_PX = 54;     // radius on screen
const LOUPE_ZOOM = 3;
const LOUPE_BALL_PX = 18; // only for balls smaller than this across
const loupe = { canvas: null, corner: -1, shown: null };

// loupeFinger is where the hand is, in canvas px, while a finger aims; null
// when none does.
function loupeFinger() {
  if (S.aiming && S.pointerType !== 'mouse' && S.pointer !== null) return S.fingerAt || { x: view.cssW / 2, y: view.cssH };
  const rect = canvas.getBoundingClientRect();
  if (S.powerDrag && S.powerType !== 'mouse') return { x: S.lefty ? 0 : view.cssW, y: S.powerY - rect.top };
  if (jogFrom !== null && jogType !== 'mouse') return { x: view.cssW / 2, y: view.cssH };
  return null;
}

function drawLoupe(cast, balls) {
  loupe.shown = null;
  const finger = cast && loupeFinger();
  if (!finger || !cast.hit || 2 * R * view.s >= LOUPE_BALL_PX) { loupe.corner = -1; return; }
  const at = toScreen(cast.ghost);
  const m = LOUPE_PX + 8;
  const corners = [[m, m], [view.cssW - m, m], [m, view.cssH - m], [view.cssW - m, view.cssH - m]];
  // clear: how far a corner's circle is from the contact and the finger
  const clear = ([x, y]) => Math.min(Math.hypot(x - at.x, y - at.y), Math.hypot(x - finger.x, y - finger.y)) - LOUPE_PX;
  if (loupe.corner < 0 || clear(corners[loupe.corner]) < LOUPE_PX * 0.5) {
    let best = 0;
    for (let i = 1; i < 4; i++) if (clear(corners[i]) > clear(corners[best])) best = i;
    loupe.corner = best;
  }
  const [cx, cy] = corners[loupe.corner];
  const dpr = view.dpr;
  const src = LOUPE_PX / LOUPE_ZOOM;
  const size = Math.ceil(2 * src * dpr);
  if (!loupe.canvas) loupe.canvas = document.createElement('canvas');
  const lc = loupe.canvas;
  if (lc.width !== size) { lc.width = size; lc.height = size; }
  const lx = lc.getContext('2d');
  lx.fillStyle = look().railBottom;
  lx.fillRect(0, 0, size, size); // beyond the canvas edge
  lx.drawImage(canvas, (at.x - src) * dpr, (at.y - src) * dpr, size, size, 0, 0, size, size);
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.beginPath();
  ctx.arc(cx, cy, LOUPE_PX, 0, Math.PI * 2);
  ctx.save();
  ctx.clip();
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(lc, cx - LOUPE_PX, cy - LOUPE_PX, 2 * LOUPE_PX, 2 * LOUPE_PX);
  ctx.restore();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(13,18,24,.6)';
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = rgba(PAL.labelText, 0.9);
  ctx.stroke();
  ctx.restore();
  loupe.shown = { x: cx, y: cy, hit: cast.hit };
}

// drawLabels names balls: the one under the pointer (or touched), and on
// small tables the one the aim hits first, so a cut is never played on the
// wrong ball.
function drawLabels(balls, cast, aim, cue, now) {
  if (S.hoverUntil && now > S.hoverUntil) { S.hoverBall = null; S.hoverUntil = 0; }
  const target = cast && aim.mine && !S.drag && cast.hit;
  if (target && target !== S.hoverBall && balls.has(target) && 2 * R * pxPerM(balls.get(target)) < 16) {
    const a = toScreen(cue), b = toScreen({ x: cue.x + 0.1 * Math.cos(S.angle), y: cue.y + 0.1 * Math.sin(S.angle) });
    drawBallLabel(target, balls.get(target), { x: b.x - a.x, y: b.y - a.y });
  }
  if (S.hoverBall !== null && balls.has(S.hoverBall)) drawBallLabel(S.hoverBall, balls.get(S.hoverBall));
  const next = pointerBall(balls);
  if (next !== null && balls.has(next) && !S.drag) drawPointer(balls.get(next), now);
}

// POINTER_BOUNCE_MS: how long the pointer bounces once a turn begins; then
// it stands still, so a table left alone does not keep drawing.
const POINTER_BOUNCE_MS = 2500;

// drawPointer draws the next-ball arrow over p, in screen pixels so it keeps
// its size and stays upright in 2D (turned or not) and in 3D.
function drawPointer(p, now) {
  const r = R * pxPerM(p);
  const top = v3 ? v3.project(p, 2 * R) : (() => { const c = toScreen(p); return { x: c.x, y: c.y - r }; })();
  const t = now - S.pointerAt;
  const bounce = reduceMotion.matches || t > POINTER_BOUNCE_MS ? 0 : 4 * Math.abs(Math.sin(t / 170));
  const tip = top.y - 5 - bounce, w = 8, h = 12;
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.beginPath();
  ctx.moveTo(top.x, tip);
  ctx.lineTo(top.x - w, tip - h);
  ctx.lineTo(top.x + w, tip - h);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2;
  ctx.strokeStyle = rgba(PAL.labelBg, 0.7);
  ctx.stroke();
  ctx.fillStyle = PAL.brass;
  ctx.fill();
  applyTableTransform();
}

// draw3d hands the frame to the 3D view, then draws the labels on the 2D
// canvas lying over it.
function draw3d(now, balls, st) {
  const { aim, myShot, cue, placingInKitchen, striking, lifted, lift } = st;
  const guide = aim ? aimGuide(balls, cue, aim) : null;
  if (guide) guide.alpha *= aim.alpha;
  const rings = [];
  const drops = [];
  let stick = null;
  if (aim && !striking) {
    // seen from behind, a raised cue stands in front of the shot: see through it
    const see = aim.elev > 10 * DEG ? 0.5 : 1;
    stick = { x: cue.x, y: cue.y, dir: { x: Math.cos(aim.angle), y: Math.sin(aim.angle) },
      back: R + 0.02 + powerToBar(aim.power) * 0.12, alpha: (aim.mine ? aim.alpha : 0.4 * aim.alpha) * see, elev: aim.elev };
  }
  for (const { f, p } of takeFx(now)) {
    const e = EASE.out(p);
    if (f.type === 'strike') stick = { ...f.cue, dir: f.dir, ...strikePose(f.power, p, f.dur), elev: f.elev };
    else if (f.type === 'gone' && f.path) {
      // down to the floor and rolling to a stop (fallPath), turning as it goes
      const at = fallAt(f, p);
      turnBall(f.o, at.x - f.last.x, at.y - f.last.y);
      f.last = at;
      drops.push({ id: f.id, x: at.x, y: at.y, sink: -at.z, alpha: p < 1 ? 1 : 0, off: true, o: f.o });
    }
    else if (f.type === 'ring') rings.push({ ball: true, x: f.at.x, y: f.at.y, r: R + 0.04 * e, w: 0.003 - 0.002 * e, color: '#FFFFFF', alpha: 0.6 * (1 - e) });
    else if (f.type === 'rim') { const h = pocketHole(f.pk); rings.push({ x: h.x, y: h.y, r: h.r, w: 0.006, color: PAL.flash, alpha: 0.5 * (1 - e) }); }
    else if (f.type === 'drop') {
      // the ball runs into the hole and sinks
      drops.push({ id: f.id, x: f.from.x + (f.to.x - f.from.x) * e, y: f.from.y + (f.to.y - f.from.y) * e, sink: 0.08 * EASE.in(p), alpha: p < 1 ? 1 : 0 });
    }
  }
  const rc = S.replay && replayCue(now);
  if (rc) stick = rc;
  if (myShot && canCall()) {
    for (const id of legalTargets()) {
      const p = balls.get(id);
      if (p) rings.push({ ball: true, x: p.x, y: p.y, r: R + 0.010, w: 0.003, color: '#FFFFFF', alpha: 0.55 });
    }
  }
  const next = pointerBall(balls);
  if (next !== null && balls.has(next)) { const p = balls.get(next); rings.push({ ball: true, x: p.x, y: p.y, r: R + 0.016, w: 0.004, color: PAL.brass, alpha: 1 }); }
  if (myShot && needsPocket()) {
    for (let n = 0; n < POCKETS.length; n++) {
      const h = pocketHole(POCKETS[n]);
      const called = S.call && S.call.pocket === n;
      if (called) rings.push({ x: h.x, y: h.y, r: h.r, w: 0.016, color: PAL.brass, alpha: 0.22 });
      rings.push({ x: h.x, y: h.y, r: h.r, w: called ? 0.006 : 0.003, color: called ? PAL.brass : '#FFFFFF', alpha: called ? 1 : 0.45 });
    }
  }
  if (S.drag && balls.has(S.drag.id)) { const p = balls.get(S.drag.id); rings.push({ ball: true, x: p.x, y: p.y, r: 1.05 * R + 0.014, w: 0.005, color: '#FFFFFF', alpha: 1 }); }
  else if (myShot && S.ballInHand && cue) rings.push({ ball: true, x: cue.x, y: cue.y, r: R + 0.014, w: 0.004, color: PAL.ok, alpha: 1 });
  v3.render({
    balls, orient: orientationOf, lifted: lifted >= 0 ? { id: lifted, lift } : null, drops, cue: stick, guide, rings,
    kitchenLine: placingInKitchen, cam: cameraFor(balls, aim),
  }, now);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawLabels(balls, guide && guide.cast, aim, cue, now);
}

// takeFx steps the transient effects for the 3D view: each running one
// with its progress, finished ones removed.
function takeFx(now) {
  const out = [];
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i];
    const p = fxProgress(f, now);
    if (p === null) continue;
    out.push({ f, p });
    if (p >= 1) fx.splice(i, 1);
  }
  return out;
}

// cameraFor picks the 3D camera: behind the cue to aim, with ball in hand
// too, high over the balls while they run, straight down while a ball is
// carried (quickly there: see carry).
let camAngle = 0; // the heading of the last aim seen
function cameraFor(balls, aim) {
  const fall = !S.camTop && !S.drag && !S.aiming && fallWatched(performance.now());
  if (fall) return fall;
  if (S.replay) return replayCamera(balls);
  const cue = balls.get(cueId());
  if (S.drag) return { mode: 'top', quick: true };
  if (S.camTop || (S.practice && S.moveTool)) return { mode: 'top' };
  if (S.moving && S.snaps.length) return { mode: 'follow', box: actionBox(balls, S.snaps[0].balls), angle: camAngle };
  if (cue && inPlay()) {
    if (aim) camAngle = aim.angle;
    return { mode: 'aim', cue, angle: camAngle };
  }
  if (S.phase === 'lobby' || S.phase === 'game_over') return { mode: 'arena', angle: arenaAngle(performance.now()) };
  return { mode: 'overview' };
}
// arenaAngle turns the camera round the arena in the lobby and at a game's
// end: once in two minutes, from the near side toward the foot end, after
// any other camera from the start; still with reduced motion.
const orbit = { from: 0, last: 0 };
function arenaAngle(now) {
  if (now - orbit.last > 250) orbit.from = now;
  orbit.last = now;
  return Math.PI / 2 - 0.45 - (reduceMotion.matches ? 0 : (now - orbit.from) * Math.PI * 2 / 120000);
}
// fallWatched is the camera on a ball falling off the table, the latest one,
// until a moment after it has come to rest on the floor; else null.
function fallWatched(now) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i];
    if (f.type !== 'gone' || !f.path) continue;
    const p = fxProgress(f, now);
    if (p === null || p * f.dur > f.path.length * FALL_STEP_MS + FALL_HOLD_MS / 2) continue;
    const at = fallAt(f, p);
    const out = (at.x - Math.max(0, Math.min(W, f.from.x))) * f.dir.x + (at.y - Math.max(0, Math.min(H, f.from.y))) * f.dir.y;
    // from the side of where it left that is nearer the middle of the table
    const side = (W / 2 - f.from.x) * -f.dir.y + (H / 2 - f.from.y) * f.dir.x < 0 ? -1 : 1;
    return { mode: 'fall', p: at, dir: f.dir, out, side };
  }
  return null;
}
// actionBox bounds the balls that have moved since the shot began.
function actionBox(balls, start) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [id, p] of balls) {
    const s0 = start.get(id);
    if (id !== cueId() && s0 && Math.hypot(p.x - s0.x, p.y - s0.y) < 1e-3) continue;
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return x0 <= x1 ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: W, y1: H };
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
  // rail, and the trim along its edge
  const carom = isCarom(), lk = look(), cloth = clothShades(S.cloth);
  const railG = ctx.createLinearGradient(0, -RAIL, 0, H + RAIL);
  railG.addColorStop(0, lk.railTop);
  railG.addColorStop(0.5, lk.rail);
  railG.addColorStop(1, lk.railBottom);
  roundRect(-RAIL, -RAIL, W + 2 * RAIL, H + 2 * RAIL, 0.06);
  ctx.fillStyle = railG;
  ctx.fill();
  ctx.strokeStyle = lk.trim ? rgba(lk.trim, 0.85) : rgba('#000000', 0.55);
  ctx.lineWidth = lk.trim ? 0.005 : 0.003;
  ctx.stroke();
  // felt, running under the cushions and into the pocket mouths
  const feltG = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, 1.48);
  feltG.addColorStop(0, cloth.center);
  feltG.addColorStop(0.55, cloth.felt);
  feltG.addColorStop(1, cloth.edge);
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
  // a metal rim round each pocket, where it cuts the rail
  if (lk.rim) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(-RAIL, -RAIL, W + 2 * RAIL, H + 2 * RAIL);
    ctx.rect(-CUSHION, -CUSHION, W + 2 * CUSHION, H + 2 * CUSHION);
    ctx.clip('evenodd');
    ctx.strokeStyle = rgba(lk.rim, 0.9);
    ctx.lineWidth = 0.007;
    for (const pk of POCKETS) { tracePocket(pk); ctx.stroke(); }
    ctx.restore();
  }
  // cushions with their jaws, then the nose line
  ctx.fillStyle = cloth.cushion;
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
  ctx.fillStyle = rgba(lk.sight, 0.9);
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
  // a carom table has one in the middle of the long rails too, where pool has its side pockets
  for (const i of carom ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 5, 6, 7]) { sight(W / 8 * i, -0.0725, true); sight(W / 8 * i, H + 0.0725, true); }
  for (const i of [1, 2, 3]) { sight(-0.0725, H / 4 * i, false); sight(W + 0.0725, H / 4 * i, false); }
  // head string and spots; a carom table has no kitchen, but the starting
  // spot, the white's two beside it (182 mm), the centre and the top spot
  ctx.fillStyle = rgba('#FFFFFF', 0.35);
  if (!carom) {
    ctx.strokeStyle = rgba('#FFFFFF', 0.14);
    ctx.lineWidth = 0.002;
    ctx.beginPath();
    ctx.moveTo(HEAD, 0);
    ctx.lineTo(HEAD, H);
    ctx.stroke();
  }
  const spots = carom
    ? [{ x: HEAD, y: H / 2 }, { x: HEAD, y: H / 2 - 0.182 }, { x: HEAD, y: H / 2 + 0.182 }, { x: W / 2, y: H / 2 }, FOOT]
    : [{ x: HEAD, y: H / 2 }, FOOT];
  for (const p of spots) {
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
  turnBall(orientationOf(id), dx, dy);
  const tex = texCache.get(id);
  if (tex) tex.dirty = true;
}
// turnBall turns orientation m, in place, as the ball rolls by (dx, dy).
function turnBall(m, dx, dy) {
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return;
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
}
function resetOrientations() { orient.clear(); lastPos.clear(); texCache.clear(); }

// ballTexture returns the ball's markings for its current orientation as an
// n × n canvas (n device pixels across the ball), rasterised at 2× when small.
// A small ball (smallBall) gets bigger number discs, room for a number that
// can be read.
function ballTexture(id, n, small) {
  let tex = texCache.get(id);
  if (tex && !tex.dirty && tex.n === n && tex.small === !!small) return tex.canvas;
  if (!tex) { tex = { canvas: document.createElement('canvas'), n: 0, dirty: true }; texCache.set(id, tex); }
  const ss = n < 64 ? 2 : 1;
  const N = n * ss;
  tex.canvas.width = tex.canvas.height = N;
  tex.n = n;
  tex.small = !!small;
  tex.dirty = false;
  const m = orientationOf(id);
  const img = tex.canvas.getContext('2d').createImageData(N, N);
  const px = img.data;
  const carom = isCarom();
  const base = carom ? hexToRgb(CAROM_COLORS[id]) : id === 0 ? IVORY_RGB : id > 8 ? IVORY_RGB : BALL_RGB[id];
  const band = !carom && id > 8 ? BALL_RGB[id - 8] : null;
  const dots = carom ? hexToRgb(CAROM_DOTS[id]) : id === 0 ? DOT_RGB : null; // the cue ball's six dots
  const cosDisc = small ? 0.785 : 0.877, cosDot = 0.985; // disc r 0.48 R (0.62 R small), dot r 0.17 R
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
      if (dots) {
        if (Math.abs(lx) > cosDot || Math.abs(ly) > cosDot || Math.abs(lz) > cosDot) col = dots;
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
// the table frame (the context is translated to the ball's centre). On a
// small ball (smallBall) it writes it once, on the disc that faces up most,
// upright on the screen in the condensed face and as big as the disc holds:
// turned and foreshortened it would not be read at 12 px.
function drawBallNumbers(id, small) {
  const m = orientationOf(id);
  const stripe = id > 8;
  const discs = stripe ? [[1, 0, 0], [-1, 0, 0]] : [[0, 0, 1], [0, 0, -1]];
  const up = stripe ? [0, 0, -1] : [0, -1, 0];
  const world = (l) => [m[0] * l[0] + m[1] * l[1] + m[2] * l[2], m[3] * l[0] + m[4] * l[1] + m[5] * l[2], m[6] * l[0] + m[7] * l[1] + m[8] * l[2]];
  if (small) {
    const d = discs.map(world).reduce((a, b) => (b[2] < a[2] ? b : a)); // the one facing up most
    const f = -d[2];
    if (f < 0.45) return; // on the edge: the disc shows, its number would not fit
    const size = R * (id > 9 ? 0.92 : 1.02) * Math.min(1, 0.45 + 0.6 * f);
    ctx.save();
    ctx.translate(d[0] * R, d[1] * R);
    if (view.rotated) ctx.rotate(Math.PI / 2);
    ctx.fillStyle = PAL.ink;
    ctx.font = `600 ${size}px "Barlow Semi Condensed", "Arial Narrow", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(id), 0, size * 0.06);
    ctx.restore();
    return;
  }
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
  // a ball in the air: its shadow falls further off, bigger and fainter
  const z = p.z || 0;
  const k = 1 + 0.8 * lift + 40 * z;
  const o = screenOffset(0.006 * k, 0.009 * k);
  const r = R * 1.08 * (1 + 0.05 * lift + 3 * z);
  const a = 1 / (1 + 8 * z);
  const g = ctx.createRadialGradient(p.x + o.x, p.y + o.y, 0, p.x + o.x, p.y + o.y, r);
  g.addColorStop(0, rgba('#000000', 0.5 * a));
  g.addColorStop(0.7, rgba('#000000', 0.25 * a));
  g.addColorStop(1, rgba('#000000', 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(p.x + o.x, p.y + o.y, r, 0, Math.PI * 2);
  ctx.fill();
}

// A ball under SMALL_BALL_PX across (a phone either way up, a tablet held
// upright, a small window: 10 to 20 px) is drawn to be read, not only seen
// (design/canvas-spec.md, "Small balls"): bigger number discs with the number
// upright, a lighter shade at the edge so the colours stay apart (the red 3
// and the maroon 7, the blue 2 and the purple 4), and a rim of light on the
// lamp's side, so a dark ball stands off any cloth.
const SMALL_BALL_PX = 24;

// drawBall draws one ball: its markings in the table frame, as the ball
// has rolled, then the lighting in a screen-aligned frame so it reads the
// same way whether or not the table is rotated.
function drawBall(id, p, opts) {
  const scale = opts && opts.scale ? opts.scale : 1;
  const alpha = opts && opts.alpha !== undefined ? opts.alpha : 1;
  const carom = isCarom();
  const colour = carom ? CAROM_COLORS[id] : id === 0 ? PAL.ivory : BALL_COLORS[id > 8 ? id - 8 : id];
  const diamPx = 2 * R * view.s * scale;
  const small = diamPx < SMALL_BALL_PX;
  ctx.save();
  ctx.translate(p.x, p.y);
  if (scale !== 1) ctx.scale(scale, scale);
  ctx.globalAlpha = alpha;
  // body: a plain fill under the markings so the raster's edge never shows
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fillStyle = id > 8 && !carom ? PAL.ivory : colour;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.drawImage(ballTexture(id, Math.max(8, Math.ceil(diamPx * view.dpr)), small), -R, -R, 2 * R, 2 * R);
  ctx.restore();
  if (id !== 0 && !carom && diamPx >= (small ? 8 : 15)) drawBallNumbers(id, small);
  if (view.rotated) ctx.rotate(Math.PI / 2);
  // shade
  const g = ctx.createRadialGradient(-0.24 * R, -0.32 * R, 0, -0.24 * R, -0.32 * R, 1.56 * R);
  g.addColorStop(0, rgba('#FFFFFF', small ? 0.42 : 0.5));
  g.addColorStop(0.3, rgba('#FFFFFF', small ? 0.08 : 0.1));
  g.addColorStop(0.72, rgba('#000000', 0));
  g.addColorStop(1, rgba('#000000', small ? 0.2 : 0.4));
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
  // edge: on a small ball a rim of light, bright on the lamp's side
  if (small) {
    const px = 1 / (view.s * scale); // a screen pixel, in metres
    const rim = ctx.createLinearGradient(-0.7 * R, -0.7 * R, 0.7 * R, 0.7 * R);
    rim.addColorStop(0, rgba('#FFFFFF', 0.8));
    rim.addColorStop(0.55, rgba('#FFFFFF', 0.35));
    rim.addColorStop(1, rgba('#FFFFFF', 0.15));
    ctx.strokeStyle = rim;
    ctx.lineWidth = 1.1 * px;
    ctx.beginPath();
    ctx.arc(0, 0, R - 0.55 * px, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.strokeStyle = rgba('#000000', 0.35);
    ctx.lineWidth = 0.0015;
    ctx.beginPath();
    ctx.arc(0, 0, R - 0.00075, 0, Math.PI * 2);
    ctx.stroke();
  }
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
  const carom = isCarom();
  const text = carom ? (S.carom && S.seat >= 0 && !S.practice && S.carom.cue[S.seat] === id ? T`${caromName(id)} · yours` : caromName(id)) : id === 0 ? T`cue ball` : isNine() ? (id === 9 ? '9-ball' : String(id)) : id === 8 ? '8-ball' : `${id} · ${groupName(groupOf(id))}`;
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
  const rp = R * pxPerM(p); // the ball's radius on screen
  let x = sp.x, y = sp.y - rp - h / 2 - 10;
  if (aim) {
    if (Math.abs(aim.y) >= Math.abs(aim.x)) { x = sp.x + (sp.x > view.cssW / 2 ? -1 : 1) * (rp + w / 2 + 6); y = sp.y; }
    else { x = sp.x; y = sp.y + (sp.y > view.cssH / 2 ? -1 : 1) * (rp + h / 2 + 6); }
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
  const color = carom ? CAROM_COLORS[id] : id === 0 ? '#F4EFE2' : BALL_COLORS[id > 8 ? id - 8 : id];
  ctx.beginPath();
  ctx.arc(sx, cy, sw, 0, Math.PI * 2);
  ctx.fillStyle = id > 8 && !carom ? '#F4EFE2' : color;
  ctx.fill();
  if (id > 8 && !carom) {
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
// centre, pointing along dir; elev (radians) raises its butt, which from
// above shortens it.
function drawCue(cue, dir, back, alpha, elev = 0) {
  if (alpha <= 0) return;
  const c = Math.cos(elev);
  const u = { x: -dir.x * c, y: -dir.y * c }; // tip → butt, as seen from above
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

// aimGuide lays out the guide: the path to the ghost ball, the ghost ball,
// the object ball's direction with a chevron and the cue ball's deflection,
// as lines in table metres for either view. Its cast (castAim) names the
// ball the aim strikes first. A jump (aim.elev) dots the part of the path
// in the air and rings where the cue ball comes down; a path off the table
// is red, with no ghost ball.
function aimGuide(balls, cue, aim) {
  const { angle, mine } = aim;
  const path = mine ? massePath(aim.power, S.spin, aim.elev || 0) : null;
  const flight = path ? null : jumpFlight(aim.power, mine ? S.spin.y : 0, aim.elev || 0);
  const cast = path ? castMasse(balls, cue, angle, path) : castAim(balls, cue, angle, flight);
  const d = cast.dir;
  const line = cast.offTable ? PAL.warn : mine ? '#FFFFFF' : PAL.oppAim;
  const brass = mine ? PAL.brassLine : PAL.oppAim;
  const end = { x: cast.ghost.x - d.x * R, y: cast.ghost.y - d.y * R };
  const lines = [];
  if (cast.curve) {
    // a massé: the curve, then straight on once the cue ball rolls
    const c = cast.curve;
    let len = 0;
    for (let i = 1; i < c.length; i++) len += Math.hypot(c[i].x - c[i - 1].x, c[i].y - c[i - 1].y);
    lines.push(...curveLines(c, R, cast.onCurve ? len - R : len, line));
    const last = c[c.length - 1];
    if (!cast.onCurve && Math.hypot(end.x - last.x, end.y - last.y) > 1e-4) {
      lines.push({ a: { x: last.x, y: last.y }, b: end, w: 0.003, color: line, alpha: 0.78, dash: [0.020, 0.014] });
    }
  } else if (flight) {
    // dotted while the ball is in the air, then dashed as usual
    const up = cast.land || end;
    lines.push({ a: { x: cue.x + d.x * R, y: cue.y + d.y * R }, b: up, w: 0.003, color: line, alpha: 0.78, dash: [0.004, 0.012] });
    if (cast.land) lines.push({ a: cast.land, b: end, w: 0.003, color: line, alpha: 0.78, dash: [0.020, 0.014] });
  } else {
    lines.push({ a: { x: cue.x + d.x * R, y: cue.y + d.y * R }, b: end, w: 0.003, color: line, alpha: 0.78, dash: [0.020, 0.014] });
  }
  const marks = cast.land ? [{ x: cast.land.x, y: cast.land.y, r: 0.6 * R, color: line }] : [];
  if (cast.offTable) {
    return { cast, lines, marks, ghost: null, alpha: mine ? 1 : 0.5 };
  }
  // After contact: the object ball's path and the cue ball's deflection,
  // as long as the server's aimLine (the deflection half of it).
  const reach = S.aimLine;
  if (cast.objDir && reach > 0) {
    const b = balls.get(cast.hit);
    const od = cast.objDir;
    const x0 = b.x + od.x * R, y0 = b.y + od.y * R;
    const x1 = x0 + od.x * reach, y1 = y0 + od.y * reach;
    lines.push({ a: { x: x0, y: y0 }, b: { x: x1, y: y1 }, w: 0.004, color: brass, alpha: 0.95 });
    // chevron 18 × 24 at the end, smaller on a very short line
    const nx = -od.y, ny = od.x;
    const cl = Math.min(0.024, reach * 0.4), cw = cl * 0.375;
    lines.push({ a: { x: x1 - od.x * cl + nx * cw, y: y1 - od.y * cl + ny * cw }, b: { x: x1, y: y1 }, w: 0.004, color: brass, alpha: 0.95 });
    lines.push({ a: { x: x1, y: y1 }, b: { x: x1 - od.x * cl - nx * cw, y: y1 - od.y * cl - ny * cw }, w: 0.004, color: brass, alpha: 0.95 });
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
      lines.push({
        a: { x: cast.ghost.x + cd.x * R, y: cast.ghost.y + cd.y * R }, b: { x: cast.ghost.x + cd.x * (R + len), y: cast.ghost.y + cd.y * (R + len) },
        w: 0.003, color: line, alpha: 0.5, dash: [0.010, 0.010],
      });
    }
  }
  return { cast, lines, marks, ghost: { x: cast.ghost.x, y: cast.ghost.y, color: line }, alpha: mine ? 1 : 0.5 };
}

// curveLines lays the stretch of pts ({x, y, z}, table metres) from arc
// length from to to out as guide lines, dashed on the cloth and dotted in
// the air as a straight path is. The dashes follow the curve, so each one
// is a line of its own.
function curveLines(pts, from, to, color) {
  const lines = [];
  for (let i = 1, s = 0; i < pts.length && s < to; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const [on, gap] = a.z > 0 ? [0.004, 0.012] : [0.020, 0.014];
    const at = (u) => ({ x: a.x + (b.x - a.x) * u / len, y: a.y + (b.y - a.y) * u / len });
    for (let u = Math.max(0, from - s), stop = Math.min(len, to - s); u < stop;) {
      const ph = (s + u - from) % (on + gap);
      const next = Math.min(stop, u + (ph < on - 1e-9 ? on : on + gap) - ph);
      if (ph < on - 1e-9) lines.push({ a: at(u), b: at(next), w: 0.003, color, alpha: 0.78 });
      u = next;
    }
    s += len;
  }
  return lines;
}

// drawAim draws the guide on the 2D table and returns its cast.
function drawAim(balls, cue, aim, alpha) {
  const g = aimGuide(balls, cue, aim);
  ctx.save();
  ctx.globalAlpha = g.alpha * alpha;
  ctx.lineCap = 'round';
  const stroke = (l) => {
    ctx.strokeStyle = rgba(l.color, l.alpha);
    ctx.lineWidth = l.w;
    ctx.setLineDash(l.dash || []);
    ctx.beginPath();
    ctx.moveTo(l.a.x, l.a.y);
    ctx.lineTo(l.b.x, l.b.y);
    ctx.stroke();
  };
  for (const l of g.lines) stroke(l);
  ctx.setLineDash([]);
  for (const m of g.marks) {
    ctx.strokeStyle = rgba(m.color, 0.8);
    ctx.lineWidth = 0.003;
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (g.ghost) {
    ctx.strokeStyle = rgba(g.ghost.color, 0.78);
    ctx.lineWidth = 0.003;
    ctx.beginPath();
    ctx.arc(g.ghost.x, g.ghost.y, R, 0, Math.PI * 2);
    ctx.fillStyle = rgba(g.ghost.color, 0.06);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
  return g.cast;
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
  takes: { clack: [], cue: [], pocket: [] }, // decoded recordings, filled once loaded
  last: {},      // the take each kind played last, not to repeat it
  voice: readSetting('pool:voice') !== 'off',          // the commentator speaks
  strong: readSetting('pool:voice:strong') !== 'off',  // ...strong language too
  lines: [],     // web/voice/lines.json: {id, kind, text, strong?, clip?, by?, buf?}
  lastLine: '',  // the id spoken last
  spokeAt: -Infinity, // performance.now() of the last line
  quietUntil: -Infinity, // performance.now() when the line being said ends
  voices: 0,     // lines spoken so far, for tests
  chimes: 0,     // your-turn chimes so far, for tests
  ticks: 0,      // shot clock ticks so far, for tests
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
    loadVoices(ctx);
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

// A ball coming down from a jump: a short low knock on the slate through
// the cloth.
function knock(ctx, at, v) {
  const g = 0.7 * loudness(v, 3);
  burst(ctx, at, 'lowpass', 380, 0.8, 0.8 * g, 0.04);
  tone(ctx, at, 95 + 15 * Math.random(), 0.7 * g, 0.06);
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

// chime is the your-turn ding: two bright notes going up.
function chime() {
  const ctx = audio();
  if (!ctx) return;
  const at = ctx.currentTime + 0.02;
  tone(ctx, at, 880, 0.16, 0.5);
  tone(ctx, at + 0.12, 1318.5, 0.16, 0.7);
  SND.chimes++;
}

// clockTick is a shot clock second: a soft wooden tick, sharper and
// louder in the last five.
function clockTick(last) {
  const ctx = audio();
  if (!ctx) return;
  const at = ctx.currentTime + 0.01;
  tone(ctx, at, last ? 1568 : 1046.5, last ? 0.18 : 0.09, last ? 0.12 : 0.07);
  SND.ticks++;
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
    playImpact(ctx, ctx.currentTime + Math.max(0, due) / 1000, im);
  }
}
function playImpact(ctx, at, im) {
  if (im.k === 'ball') clack(ctx, at, im.v);
  else if (im.k === 'rail') thump(ctx, at, im.v);
  else if (im.k === 'pocket') drop(ctx, at, im.v);
  else if (im.k === 'slate') knock(ctx, at, im.v);
  SND.played++;
}

// --- replay -------------------------------------------------------------------
// Every shot is recorded from its first snapshot (not when joining one
// midway), and the last one can be played again, here only, at half speed:
// the cue draws back and strikes, then the balls run with their sounds. In
// 3D the camera chases the cue ball to its first contact, then the object
// ball that moves most. A press or a key ends it, as does a new shot.

const REPLAY_SPEED = 0.5;
const REPLAY_LEAD_MS = 700; // the cue's draw back and strike before the balls run
const REPLAY_HOLD_MS = 600; // the last frame stays this long

function canReplay() { return !!S.lastShot && !S.moving && !S.replay && inRoom(); }

function startReplay() {
  if (!canReplay()) return;
  const shot = S.lastShot;
  const snaps = shot.snaps;
  const t0 = snaps[0].t;
  const own = shot.cue || 0;
  const start = snaps[0].balls.get(own);
  if (!start) return;
  // the shot's direction and speed: where and how fast the cue ball first went
  let dir = { x: 1, y: 0 }, speed = 1;
  for (const sn of snaps) {
    const p = sn.balls.get(own);
    const d = p ? Math.hypot(p.x - start.x, p.y - start.y) : 0;
    if (d > 0.005) { dir = { x: (p.x - start.x) / d, y: (p.y - start.y) / d }; speed = d / Math.max(0.001, (sn.t - t0) / 1000); break; }
  }
  // balls that vanish between two snapshots drop into their pocket then, or
  // fall off the table; one back on it after the shot falls at the end
  const drops = [];
  const off = new Set(shot.offTable || []);
  for (let i = 1; i < snaps.length; i++) {
    for (const [id, p] of snaps[i - 1].balls) {
      if (!snaps[i].balls.has(id)) drops.push({ id, from: p, t: snaps[i].t, vel: ballVel(snaps[i - 2], snaps[i - 1], id), off: off.has(id) });
    }
  }
  const end = snaps.length - 1;
  for (const id of off) {
    const p = end > 0 && snaps[end - 1].balls.get(id);
    if (p && !drops.some((d) => d.id === id)) drops.push({ id, from: p, t: snaps[end].t, vel: ballVel(snaps[end - 2], snaps[end - 1], id), off: true });
  }
  // after the first contact the camera follows the object ball that moves
  // most in the next 0.4 s (or drops)
  const hits = shot.impacts.filter((im) => im.k === 'ball').map((im) => im.t);
  const firstHit = hits.length ? Math.min(...hits) : Infinity;
  let follow = 0;
  if (Number.isFinite(firstHit)) {
    const a = interpSnaps(snaps, firstHit), b = interpSnaps(snaps, firstHit + 400);
    let most = -1;
    for (const [id, p] of a) {
      if (id === own) continue;
      const q = b.get(id);
      const d = q ? Math.hypot(q.x - p.x, q.y - p.y) : 1;
      if (d > most) { most = d; follow = id; }
    }
  }
  const now = performance.now();
  const r = {
    shot, t0: now + REPLAY_LEAD_MS, start: now, dir, cue: start, drops, firstHit, follow,
    endAt: 0, timers: [], cam: { p: start, dir },
    saved: { orient: new Map([...orient].map(([id, m]) => [id, Float64Array.from(m)])), lastPos: new Map(lastPos) },
  };
  lastPos.clear(); // the jump back to where the shot began does not roll the balls
  S.replay = r;
  // sounds, on timers so that ending the replay silences the rest
  const power = Math.min(1, speed / MAX_CUE_SPEED);
  r.timers.push(setTimeout(() => playStrike(power), REPLAY_LEAD_MS));
  for (const im of shot.impacts.slice(0, 64)) {
    r.timers.push(setTimeout(() => { const c = audio(); if (c) playImpact(c, c.currentTime, im); }, REPLAY_LEAD_MS + (im.t - t0) / REPLAY_SPEED));
  }
  refreshReplay();
}

// replayClock is the shot time the replay shows now.
function replayClock() {
  const r = S.replay;
  return r.shot.snaps[0].t + (performance.now() - r.t0) * REPLAY_SPEED;
}

// tickReplay starts the replay's pocket drops and ends it after the last frame.
function tickReplay(now) {
  const r = S.replay;
  const t = replayClock();
  while (r.drops.length && r.drops[0].t <= t) {
    const d = r.drops.shift();
    startDrop(d.id, d.from, d.vel, d.off);
  }
  const snaps = r.shot.snaps;
  // it ends once the last frame has been shown and a ball it sent off the
  // table has come to rest on the floor
  if (t >= snaps[snaps.length - 1].t && !fx.some((f) => f.replay && f.path)) {
    if (!r.endAt) r.endAt = now;
    else if (now - r.endAt > REPLAY_HOLD_MS) stopReplay();
  }
}

function stopReplay() {
  const r = S.replay;
  if (!r) return;
  for (const id of r.timers) clearTimeout(id);
  orient.clear();
  for (const [id, m] of r.saved.orient) orient.set(id, m);
  lastPos.clear();
  for (const [id, p] of r.saved.lastPos) lastPos.set(id, p);
  texCache.clear();
  for (let i = fx.length - 1; i >= 0; i--) if (fx[i].type === 'drop' || fx[i].type === 'rim' || fx[i].replay) fx.splice(i, 1);
  S.replay = null;
  refreshReplay();
}

// replayCue is the cue in the replay's lead: drawn back, then the strike.
function replayCue(now) {
  const r = S.replay;
  const el = now - r.start;
  const pull = 0.02 + 0.1;
  let back, alpha = 1;
  if (el < REPLAY_LEAD_MS - 80) back = R + 0.02 + 0.1 * EASE.inout(clamp01(el / (REPLAY_LEAD_MS - 200)));
  else if (el < REPLAY_LEAD_MS) back = R + pull * (1 - EASE.in((el - REPLAY_LEAD_MS + 80) / 80));
  else { back = R; alpha = 1 - clamp01((el - REPLAY_LEAD_MS) / 200); }
  if (alpha <= 0) return null;
  return { x: r.cue.x, y: r.cue.y, dir: r.dir, back, alpha, elev: r.shot.elev || 0 };
}

// replayCamera: behind the cue for the strike, then chasing the cue ball
// to its first contact and the followed object ball after it.
function replayCamera(balls) {
  const r = S.replay;
  const t = replayClock();
  if (t <= r.shot.snaps[0].t) return { mode: 'aim', cue: r.cue, angle: Math.atan2(r.dir.y, r.dir.x) };
  const id = t < r.firstHit ? (r.shot.cue || 0) : r.follow;
  const p = balls.get(id);
  if (p) {
    const q = interpSnaps(r.shot.snaps, t + 80).get(id);
    const d = q ? Math.hypot(q.x - p.x, q.y - p.y) : 0;
    if (d > 2e-3) r.cam.dir = { x: (q.x - p.x) / d, y: (q.y - p.y) / d };
    r.cam.p = p;
  }
  return { mode: 'chase', p: r.cam.p, dir: r.cam.dir };
}

function refreshReplay() {
  const btn = $('replayBtn');
  btn.hidden = !canReplay();
  $('status').classList.toggle('has-replay', !btn.hidden);
  $('replayTag').hidden = !S.replay;
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

// --- the commentator -----------------------------------------------------------
// Short lines in Vietnamese on a great shot, a miss, a foul, a win or a loss
// (CLIENT.md, "Commentary"). web/voice/lines.json lists them; each is
// web/voice/<id>.m4a, recorded by scripts/make-voices.js and replaceable by
// a recording of your own under the same name. Lines marked strong use
// strong language; Settings → Sound can leave them out. Everyone in the
// room hears the same line: each machine draws it from a generator seeded
// by what it got from the server about the shot, which is the same for all.
// At most one line every 3 s, and never over one still being said (a few
// clips last up to 8 s), heard only: nothing is written on the table.

const VOICE_GAP_MS = 3000;
const VOICE_DELAY_MS = 250; // after the balls have had their say

function loadVoices(ctx) {
  fetch('/voice/lines.json')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .then((lines) => {
      SND.lines = lines;
      for (const line of lines) {
        fetch(`/voice/${line.id}.m4a`)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
          .then((data) => ctx.decodeAudioData(data))
          .then((buf) => { line.buf = buf; })
          .catch(() => { /* that line stays silent */ });
      }
    })
    .catch(() => { /* no commentator */ });
}

// seeded returns a generator of numbers in [0, 1) that is the same on every
// machine for the same text (FNV-1a, then mulberry32).
function seeded(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// pickLine draws a line of kind with rnd. Someone who leaves strong language
// out gets a clean line of the same kind in place of a strong one (drawn
// with the next number, so everyone's draws stay in step). A line not loaded
// yet still counts, silently, so the draws stay in step too.
function pickLine(kind, rnd) {
  const all = SND.lines.filter((l) => l.kind === kind);
  if (!all.length) return null;
  const line = all[Math.floor(rnd() * all.length)];
  const alt = rnd();
  if (!line.strong || SND.strong) return line;
  const clean = all.filter((l) => !l.strong);
  return clean.length ? clean[Math.floor(alt * clean.length)] : null;
}

function speak(kind, rnd) {
  if (!SND.voice || S.replay) return;
  const now = performance.now();
  if (now - SND.spokeAt < VOICE_GAP_MS || now < SND.quietUntil) return;
  const line = pickLine(kind, rnd);
  if (!line) return;
  SND.spokeAt = now;
  SND.lastLine = line.id;
  SND.voices++;
  const ctx = SND.on ? audio() : null;
  if (ctx && line.buf) {
    const src = ctx.createBufferSource();
    src.buffer = line.buf;
    const g = ctx.createGain();
    g.gain.value = 1.1;
    src.connect(g).connect(SND.master);
    src.start(ctx.currentTime + VOICE_DELAY_MS / 1000);
    // some clips run longer than VOICE_GAP_MS: the next line waits for the end
    SND.quietUntil = now + VOICE_DELAY_MS + line.buf.duration * 1000;
  }
}

// voiceFor picks what the commentator says about a settled shot. Every
// draw comes from the shot's seed, in the same order on every machine.
function voiceFor(msg) {
  const rnd = seeded(JSON.stringify([S.roomCode, msg.shooter, msg.pocketed, msg.balls]));
  const say = (kind) => speak(kind, rnd);
  const made = msg.pocketed.filter((id) => id !== 0);
  const scratch = msg.pocketed.includes(0) || msg.foul === 'scratch';
  const over = msg.winner !== undefined && msg.winner !== null;
  if (isCarom()) {
    if (!S.practice && msg.phase === 'game_over') { if (over) say(msg.winner === sideOf(msg.shooter) ? 'win' : 'lose'); return; }
    if (msg.foul) { say('foul'); return; }
    const chance = rnd();
    if (msg.made) {
      if (msg.cushions >= 5 || (!S.practice && msg.carom && msg.carom.run >= 3)) say('great');
      else if (chance < 0.35) say('nice');
      return;
    }
    if (!S.shotWasBreak && chance < 0.5) say('miss');
    return;
  }
  if (!S.practice) {
    if (over) { say(msg.winner === sideOf(msg.shooter) ? 'win' : 'lose'); return; }
    if (scratch) { say('scratch'); return; }
    if (msg.foul) { say('foul'); return; }
  } else if (scratch) { say('scratch'); return; }
  if (S.shotWasBreak) { if (made.length) say('break'); return; }
  if (made.length >= 2 || longPot(made)) { say('great'); return; }
  const chance = rnd();
  if (made.length === 1) { if (chance < 0.35) say('nice'); return; }
  if (!msg.safety && !msg.pushedOut && chance < 0.5) say('miss');
}

// longPot: one of the balls made travelled more than 1.2 m to its pocket.
function longPot(made) {
  const start = S.lastShot && S.lastShot.snaps[0].balls;
  if (!start) return false;
  return made.some((id) => {
    const p = start.get(id);
    return p && nearestPocket(p).d > 1.2;
  });
}

// ---------------------------------------------------------------------------
// 5. input

// canvasPoint is where pointer e is in CSS px within the canvas.
function canvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}
function pointerPos(e) {
  const at = canvasPoint(e);
  return toTable(at.x, at.y);
}

function hitBall(p, balls, skipCue, reach = R * 1.8) {
  let best = null;
  for (const [id, b] of balls) {
    if (skipCue && id === cueId()) continue;
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
const fingerReach = (p) => Math.max(R * 1.8, FINGER_PX / pxPerM(p));

// nameBall shows ball id's number over it for a moment (a touch has no hover).
function nameBall(id) {
  S.hoverBall = id;
  S.hoverUntil = performance.now() + 2000;
}

// otherPointer: a second finger while the first aims or carries a ball (a
// thumb resting on the felt, a palm on the rail). It does nothing.
const otherPointer = (e) => S.pointer !== null && e.pointerId !== S.pointer;

// followPointer makes the table follow pointer e until it lifts.
function followPointer(e) {
  S.pointer = e.pointerId;
  S.pointerType = e.pointerType;
  canvas.setPointerCapture(e.pointerId);
  trackFinger(e);
}
function trackFinger(e) {
  S.fingerAt = e.pointerType === 'mouse' ? null : canvasPoint(e);
}

canvas.addEventListener('pointerdown', (e) => {
  if (otherPointer(e)) { e.preventDefault(); return; }
  // A press during a replay only ends it.
  if (S.replay) { e.preventDefault(); stopReplay(); return; }
  if (!isMyShot()) {
    // Not my shot: a touch only names the ball under it.
    if (e.pointerType !== 'mouse') {
      const p = pointerPos(e);
      const id = hitBall(p, displayBalls(), false, fingerReach(p));
      if (id !== null) nameBall(id);
    }
    return;
  }
  e.preventDefault();
  const p = pointerPos(e);
  const balls = displayBalls();
  const cue = balls.get(cueId());

  const grab = grabbable(p, balls);
  if (grab !== null) {
    // in 3D the ball stays where it is until the pointer moves (see carry)
    S.drag = v3 ? { id: grab, ...clampBall(grab, balls.get(grab)), at: canvasPoint(e) } : { id: grab, ...clampBall(grab, p) };
    S.liftStart = performance.now();
    followPointer(e);
    return;
  }
  // A press on a pocket (when the 8-ball needs one) or, on touch, on a ball
  // (to name it) may be a tap or the start of an aiming drag; decide on
  // release, by distance and time.
  const pocket = needsPocket() ? hitPocket(p) : null;
  const id = pocket === null && e.pointerType !== 'mouse' ? hitBall(p, balls, true, fingerReach(p)) : null;
  S.tap = { id, pocket, x: e.clientX, y: e.clientY, t: performance.now(), type: e.pointerType };
  if (cue) {
    followPointer(e);
    if (id === null && pocket === null) {
      S.aiming = true;
      // Pointing aims at once; holding the butt waits for a move, so a
      // tap does not swing the cue around.
      if (behindCue()) S.aimDrag = { x: e.clientX };
      else if (S.aimFront) aimFrom(p, cue);
      else if (e.pointerType !== 'mouse') leverAim(p, cue);
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

// LEVER_HOLD_PX: a finger nearer the cue ball than this turns nothing.
const LEVER_HOLD_PX = 24;

// leverAim aims from a finger in 2D while it holds the butt: the cue turns
// by as much as the finger turns about the cue ball, as a lever would, but
// never jumps to the finger. So a new touch keeps the aim set so far, and a
// finger far from the cue ball turns it finely (300 px away, 0.2° per px).
// Near the cue ball the direction means nothing, so the aim holds there.
function leverAim(p, cue) {
  const dx = p.x - cue.x, dy = p.y - cue.y;
  if (Math.hypot(dx, dy) < Math.max(R * 1.5, LEVER_HOLD_PX / pxPerM(cue))) { S.aimDrag = { a: null }; return; }
  const a = Math.atan2(dy, dx);
  const was = S.aimDrag && S.aimDrag.a != null ? S.aimDrag.a : null; // not {x}: the camera may change mid-drag
  S.aimDrag = { a };
  if (was !== null) setAngle(S.angle + Math.atan2(Math.sin(a - was), Math.cos(a - was)));
}

// aimMove aims from a pointer moving across the table.
function aimMove(e, p, cue) {
  if (behindCue()) turnAim(e);
  else if (!cue) return;
  else if (e.pointerType !== 'mouse' && !S.aimFront) leverAim(p, cue);
  else aimFrom(p, cue);
}

// turnAim turns the aim by a sideways drag while the 3D camera is behind
// the cue: by default the finger holds the butt, so moving it right swings
// the shot left (S.aimFront: the other way). Lower on the screen, nearer
// the butt, the same drag turns it less: 0.3° per px at the top, 0.03° at
// the bottom.
function turnAim(e) {
  if (!S.aimDrag || S.aimDrag.x === undefined) { S.aimDrag = { x: e.clientX }; return; }
  const dx = e.clientX - S.aimDrag.x;
  S.aimDrag.x = e.clientX;
  const rect = canvas.getBoundingClientRect();
  const low = clamp01((e.clientY - rect.top) / rect.height);
  const rate = (0.3 - 0.27 * low) * DEG;
  setAngle(S.angle + (S.aimFront ? 1 : -1) * dx * rate);
}

// grabbable returns the ball a press at p picks up, or null: in practice
// with Move on any ball, otherwise the cue ball when it may be placed (ball
// in hand, or always in practice).
function grabbable(p, balls) {
  if (S.practice && S.moveTool) return hitBall(p, balls, false);
  const cue = balls.get(cueId());
  if ((S.ballInHand || S.practice) && cue && Math.hypot(cue.x - p.x, cue.y - p.y) < R * 2.5) return cueId();
  return null;
}

// hitPocket returns the index of the pocket under p, or null. The target is
// the hole plus a margin, at least 24 px across on screen.
function hitPocket(p) {
  const { d, pk, hole } = nearestPocket(p);
  return d <= Math.max(hole.r + 0.02, 24 / pxPerM(hole)) ? POCKETS.indexOf(pk) : null;
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
  if (pk.side) return view.rotated ? (left ? T`left side pocket` : T`right side pocket`) : (top ? T`top side pocket` : T`bottom side pocket`);
  return top ? (left ? T`top left pocket` : T`top right pocket`) : (left ? T`bottom left pocket` : T`bottom right pocket`);
}

canvas.addEventListener('pointermove', (e) => {
  const p = pointerPos(e);
  if (e.pointerType === 'mouse' && !S.drag && !S.aiming) {
    S.hoverBall = hitBall(p, displayBalls(), false);
  }
  if (!isMyShot() || otherPointer(e)) return;
  if (S.pointer !== null) trackFinger(e);
  if (S.drag) {
    carry(e, p);
  } else if (S.tap && (S.tap.id !== null || S.tap.pocket !== null) && !S.aiming) {
    // moved off the ball or pocket: this is an aim drag, not a tap
    if (Math.hypot(e.clientX - S.tap.x, e.clientY - S.tap.y) > 8) {
      S.tap = null;
      S.aiming = true;
      if (behindCue()) S.aimDrag = { x: e.clientX };
      else aimMove(e, p, displayBalls().get(cueId()));
    }
  } else if (S.aiming) {
    aimMove(e, p, displayBalls().get(cueId()));
  }
});

// carry moves the carried ball with pointer e, at table point p. From above
// it is under the pointer. In 3D the camera rises over the table as the
// ball is picked up, so the ball moves as far as the pointer does over the
// table, both ends seen through the camera as it is now (S.drag.at, the
// pointer's last place in canvas px; raw, the ball's place before it is
// kept on the table or in the kitchen); a ray past the horizon moves it
// nothing.
function carry(e, p) {
  const d = S.drag;
  if (!v3) { S.drag = { id: d.id, ...clampBall(d.id, p) }; return; }
  const at = canvasPoint(e);
  let raw = d.raw || { x: d.x, y: d.y };
  if (d.at) {
    const a = toTable(d.at.x, d.at.y);
    const dx = p.x - a.x, dy = p.y - a.y;
    if (Math.hypot(dx, dy) < 1) raw = { x: raw.x + dx, y: raw.y + dy };
  }
  S.drag = { id: d.id, ...clampBall(d.id, raw), raw, at };
}

function endPointer(e) {
  if (otherPointer(e)) return;
  S.pointer = null;
  S.fingerAt = null;
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
  S.aimDrag = null;
  if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
// A capture lost without a release (the browser took the touch) ends it too.
canvas.addEventListener('lostpointercapture', (e) => { if (e.pointerId === S.pointer) endPointer(e); });

// cancelGestures drops whatever a finger was doing, without a shot or a
// placement: turning the phone moves the table under it, so where it goes
// next means nothing. The carried ball goes back where it was.
function cancelGestures() {
  cancelPowerDrag();
  if (jogFrom !== null) endJog();
  const id = S.pointer;
  S.pointer = null;
  S.fingerAt = null;
  S.drag = null;
  S.tap = null;
  S.aiming = false;
  S.aimDrag = null;
  if (id !== null && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
}
matchMedia('(orientation: portrait)').addEventListener('change', cancelGestures);

// A mouse wheel, or two fingers on a trackpad, turns the cue finely: a notch
// 0.05°, 0.01° with Shift. Ctrl + wheel stays the browser's zoom.
const WHEEL_DEG = 0.05;
const WHEEL_DEG_FINE = 0.01;
// wheelNotches converts a wheel event to notches of 100 px; a trackpad sends
// many small ones. Shift turns the wheel sideways in some browsers.
function wheelNotches(e) {
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  return d * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1) / 100;
}
canvas.addEventListener('wheel', (e) => {
  if (e.ctrlKey || !isMyShot() || S.replay) return;
  e.preventDefault();
  setAngle(S.angle + wheelNotches(e) * (e.shiftKey ? WHEEL_DEG_FINE : WHEEL_DEG) * DEG);
}, { passive: false });
// A mouse leaving takes its hover label along; a finger lifting fires
// pointerleave too, but its label stays for its time (nameBall).
canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') S.hoverBall = null; });

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
  if (document.querySelector('.scrim:not([hidden])') || !$('settings').hidden) return; // keys belong to the dialog, or to Settings
  if (S.replay) { stopReplay(); e.preventDefault(); return; } // any key ends a replay
  if (!e.metaKey && !e.ctrlKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'v') { setView(S.view === '3d' ? '2d' : '3d', true); e.preventDefault(); return; }
    if (k === 't' && v3) { toggleCamTop(); e.preventDefault(); return; }
    if (k === 'r' && canReplay()) { startReplay(); e.preventDefault(); return; }
    if (k === 'f' && canFullscreen) { toggleFullscreen(); e.preventDefault(); return; }
    if (k === 'c' && inRoom() && !S.practice) { openChat(); e.preventDefault(); return; }
  }
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
    case 'j': setElev(S.elev + 5); break;
    case 'J': setElev(S.elev - 5); break;
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
// statusCall: on a phone, once a shot's result has been read
// (STATUS_HOLD_MS), the band over the table shows what to hit and the
// shot's toggles while it is my shot.
const STATUS_HOLD_MS = 2500;
function holdStatus() {
  S.statusHoldUntil = performance.now() + STATUS_HOLD_MS;
  clearTimeout(holdStatus.timer);
  holdStatus.timer = setTimeout(statusCall, STATUS_HOLD_MS + 20);
}
function statusCall() {
  const on = !!phoneSet && document.body.classList.contains('is-playing') && isMyShot() && !S.replay &&
    performance.now() >= (S.statusHoldUntil || 0);
  $('status').classList.toggle('status--call', on);
}

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
    close.setAttribute('aria-label', T`Dismiss`);
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
  renderLandingTable();
  document.body.classList.add('is-landing');
  syncThemeColor();
  setGameInert(true);
  hideConn();
  $('landing').scrollTop = 0;
  document.querySelector('.home__panel').scrollTop = 0; // the pane that scrolls on a phone on its side
  setLandingError(error);
  $('code').classList.remove('input--error');
  $('codeError').hidden = true;
  if (!$('name').value.trim()) $('name').value = rememberedName() || randomName();
  // An invite link opens straight onto "join this room": the name is the
  // only thing to fill in.
  const code = $('code').value.trim().toUpperCase();
  const invited = /^[A-Z]{5}$/.test(code) && !!new URLSearchParams(location.search).get('room');
  const form = $('landingForm');
  form.classList.toggle('landing--invited', invited);
  setHomeTab('new');
  // An invite shows the room's own table once the room list names it.
  $('hall').hidden = invited;
  if (!invited && hallReady) renderHall();
  $('landingInvite').hidden = !invited;
  $('landingCode').textContent = code;
  $('landingLead').textContent = T`Enter your name to take the free seat.`;
  $('createRow').hidden = invited;
  $('roomsBox').hidden = invited;
  $('code').hidden = invited;
  $('join').className = invited ? 'btn btn--primary btn--lg btn--block' : 'btn btn--secondary';
  $('switchMode').hidden = !invited;
  $('watchInvite').hidden = true; // describeInvite shows it for a full room
  $('name').enterKeyHint = invited ? 'go' : 'done';
  // A phone would open its keyboard over half the page: the name is
  // filled in already, so it is focused only where a key is at hand.
  if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => $('name').focus({ preventScroll: true }), 0);
  if (invited) { stopRoomsPoll(); describeInvite(code); } else startRoomsPoll();
}

// setLandingError shows (or with no message hides) the landing's error,
// scrolled into view.
function setLandingError(msg) {
  $('landingError').hidden = !msg;
  $('landingError').lastElementChild.textContent = msg || '';
  if (msg) $('landingError').scrollIntoView({ block: 'nearest' });
}

function hideLanding() {
  // A button inside the form may still hold focus; an Enter meant for the
  // game would otherwise resubmit the form.
  if ($('landing').contains(document.activeElement)) document.activeElement.blur();
  $('landing').hidden = true;
  document.body.classList.remove('is-landing');
  setGameInert(false);
  stopRoomsPoll();
  syncThemeColor();
}

// The bars round the page take the theme colour: a home-screen app's status
// bar, Android's, Safari's. On the home page that is the page's own surface
// (index.html, by the system's theme); in a room it is the hall's, so no
// lighter band hangs over the dark game.
const themeMetas = [...document.querySelectorAll('meta[name="theme-color"]')];
for (const m of themeMetas) m.dataset.home = m.content;
function syncThemeColor() {
  const hall = !document.body.classList.contains('is-landing') && getComputedStyle(document.body).getPropertyValue('--hall').trim();
  for (const m of themeMetas) m.content = hall || m.dataset.home;
}
// setGameInert keeps Tab and the screen reader out of the header and the
// game behind the landing page while it is open.
function setGameInert(on) {
  $('top').inert = on;
  document.querySelector('main.game').inert = on;
}

// describeInvite names the host in the invited lead, when the room is listed.
async function describeInvite(code) {
  try {
    const res = await fetch('/api/rooms');
    if (!res.ok) return;
    const list = await res.json();
    const room = list.rooms.find((r) => r.roomCode === code);
    if (!room || $('landingCode').textContent !== code) return;
    renderHall({ eyebrow: T`Room ${code}`, mode: room.mode, table: room.table, cloth: room.cloth, race: room.race, audience: room.maxSpectators });
    $('hall').hidden = false;
    const host = room.players.find(Boolean);
    const size = room.size || 2;
    if (room.seated >= size || (size > 2 && room.phase !== 'lobby')) {
      const canWatch = room.spectators < room.maxSpectators;
      $('landingLead').textContent = !canWatch ? T`This room is full right now.` : size > 2 ? T`The game is on. You can watch the game.` : T`Both seats are taken. You can watch the game.`;
      $('watchInvite').hidden = !canWatch;
    }
    else if (host && size > 2) {
      const free = size - room.seated;
      $('landingLead').textContent = free === 1 ? T`${host} is gathering a 2v2 game: ${free} seat is free.` : T`${host} is gathering a 2v2 game: ${free} seats are free.`;
    } else if (host) $('landingLead').textContent = T`${host} is at the table and waiting for an opponent.`;
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
// removed ones fade out. Each is a card (a row where the list is narrow):
// the room's table and cloth in miniature, its code, what is played, who
// plays and the score, who watches.
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
      `<p class="rooms__empty-title">${T`No rooms yet.`}</p><p class="caption">${T`Create one and send the link to a friend.`}</p>`;
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
      li.innerHTML = '<span class="mini" aria-hidden="true"><span class="mini__bed"></span></span><span class="room-row__code"></span><span class="room-row__meta"></span>' +
        '<span class="chip"><span class="chip__dot" aria-hidden="true"></span><span class="chip__text"></span></span><span class="room-row__who"></span>' +
        `<span class="room-row__watching">${EYE_SVG}<span class="room-row__watching-text"></span></span>` +
        `<div class="room-row__actions"><button class="btn btn--quiet btn--small room-row__watch" type="button" title="Watch">${EYE_SVG}<span class="room-row__watch-text">Watch</span></button><button class="btn btn--secondary btn--small room-row__join" type="button"></button></div>`;
      li.querySelector('.room-row__code').textContent = room.roomCode;
      li.querySelector('.room-row__join').onclick = () => {
        const name = landingName();
        if (name) connectAndJoin(li.dataset.code, name);
      };
      li.querySelector('.room-row__watch').onclick = () => {
        const name = landingName();
        if (name) connectAndJoin(li.dataset.code, name, null, true);
      };
      ul.append(li);
    }
    const carom = room.mode === '3cushion';
    const phase = room.phase === 'lobby' ? 'lobby' : room.phase === 'game_over' ? 'finished' : 'playing';
    li.querySelector('.mini').style.background = railGradient(carom ? LOOKS.carom : LOOKS[room.table] || LOOKS[DEFAULT_TABLE]);
    li.querySelector('.mini__bed').style.background = miniBed(room.cloth, !carom);
    const goal = carom ? T` · to ${room.race}` : room.race > 1 ? T` · race ${room.race}` : '';
    const table = carom ? T` · carom table` : TABLES[room.table] ? ` · ${TABLES[room.table].name}` : '';
    const size = room.size || 2;
    li.querySelector('.room-row__meta').textContent = `${MODE_NAME[room.mode] || '8-ball'}${size > 2 ? ' · 2v2' : ''}${goal}${table}`;
    li.querySelector('.chip').className = `chip chip--${phase}`;
    li.querySelector('.chip__text').textContent = phase === 'lobby' ? T`lobby` : phase === 'finished' ? T`finished` : T`playing`;
    // who: both names with the score between them once a match is on, the
    // one who waits for an opponent, or nobody
    const names = room.players.filter(Boolean);
    const part = (className, textContent) => Object.assign(document.createElement('span'), { className, textContent });
    const score = room.score || [0, 0];
    const who = li.querySelector('.room-row__who');
    const side = (sd) => room.players.filter((n, i) => n && i % 2 === sd).join(' & ');
    if (size > 2 && names.length) {
      const scored = phase !== 'lobby' || score[0] || score[1];
      who.replaceChildren(part('room-row__name', side(0) || '—'),
        scored ? part('room-row__score', `${score[0]} – ${score[1]}`) : part('room-row__vs', 'vs'), part('room-row__name', side(1) || '—'));
      if (room.seated < size) who.append(part('room-row__muted', T`${size - room.seated} free`));
    } else if (names.length === 2) {
      const scored = phase !== 'lobby' || score[0] || score[1];
      who.replaceChildren(part('room-row__name', room.players[0]),
        scored ? part('room-row__score', `${score[0]} – ${score[1]}`) : part('room-row__vs', 'vs'), part('room-row__name', room.players[1]));
    } else if (names.length) who.replaceChildren(part('room-row__name', names[0]), part('room-row__muted', T`waiting for an opponent`));
    else who.replaceChildren(part('room-row__muted', T`empty`));
    const max = room.maxSpectators || 0;
    li.querySelector('.room-row__watching-text').textContent = !max ? T`No spectators`
      : room.spectators ? T`${room.spectators} of ${max} watching` : T`Up to ${max} may watch`;
    const watch = li.querySelector('.room-row__watch');
    watch.hidden = !(room.spectators < room.maxSpectators);
    watch.setAttribute('aria-label', T`Watch room ${room.roomCode}`);
    watch.title = T`Watch`;
    watch.querySelector('.room-row__watch-text').textContent = T`Watch`;
    const btn = li.querySelector('.room-row__join');
    const open = room.seated < size && (size === 2 || room.phase === 'lobby');
    btn.textContent = open ? T`Join` : T`Full`;
    btn.disabled = !open;
  }
  for (const [code, li] of rows) {
    if (seen.has(code)) continue;
    li.classList.add('is-leaving');
    setTimeout(() => li.remove(), 160);
  }
  const used = list.used ?? list.rooms.length; // practice rooms are not listed but count
  $('roomsCount').textContent = T`${used} of ${list.max} in use`;
  $('roomsPillN').textContent = $('tabRoomsN').textContent = String(list.rooms.length);
  const full = used >= list.max;
  $('create').disabled = full;
  $('practice').disabled = full;
  $('createNote').hidden = !full;
  $('createNote').lastElementChild.textContent = full ? T`All ${list.max} rooms are in use. Join one of them, or try again in a moment.` : '';
}

const EYE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
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
  el.className = 'seat' + (seat === 1 ? ' seat--right' : '') + (compact ? ' seat--compact' : '');
  el.replaceChildren();
  if (!p.connected && !p.name) {
    el.classList.add('seat--empty');
    el.append(Object.assign(document.createElement('span'), { className: 'seat__name', textContent: T`Open seat` }));
    return;
  }
  const onTurn = (inPlay() || S.moving) && S.turn === seat;
  let state = '';
  if (onTurn && isMe(seat)) {
    el.classList.add('seat--turn');
    if (S.moving) el.classList.add('is-moving');
    el.insertAdjacentHTML('beforeend', CUE_SVG);
    state = S.moving ? T`rolling…` : T`your turn`;
  } else if (onTurn) {
    el.classList.add('seat--theirs');
    state = S.moving ? T`rolling…` : T`their turn`;
  }
  if (!p.connected) el.classList.add('seat--offline');

  el.append(avatar(seat));
  const body = document.createElement('div');
  body.className = 'seat__body';
  const line = document.createElement('div');
  line.className = 'seat__line';
  const name = document.createElement('span');
  name.className = 'seat__name';
  // On a phone the header is tight: my seat just says "You".
  const meShort = compact && isMe(seat) && !S.practice;
  name.textContent = meShort ? T`You` : p.name;
  name.title = p.name;
  line.append(name);
  if (isMe(seat) && !meShort && !(compactLayout.matches && S.practice)) line.append(tag(T`you`, 'you')); // practice: the only player
  if (!p.connected) line.append(tag(T`offline`, 'offline'));
  if (S.phase === 'lobby' && p.ready) line.append(tag(T`ready`, 'ready'));
  if (isNine() && S.fouls[seat] === 2 && S.phase !== 'game_over') {
    const t = tag(T`2 fouls`, 'foul');
    t.title = T`A third foul in a row loses the rack`;
    line.append(t);
  }
  body.append(line);
  if (isCarom() && S.carom && !S.practice && S.phase !== 'lobby') {
    const dots = document.createElement('div');
    dots.className = 'seat__dots';
    const id = S.carom.cue[seat];
    const dot = document.createElement('span');
    dot.className = 'ball';
    dot.style.setProperty('--c', CAROM_COLORS[id]);
    dots.append(dot);
    dots.setAttribute('aria-label', T`plays the ${caromName(id)}`);
    dots.title = T`Plays the ${caromName(id)}`;
    body.append(dots);
  }
  const g = S.groups[seat];
  if (g) body.append(groupDots(g));
  el.append(body);
  if (!p.connected) el.append(holdRing(seat));
  else if (state && !compact) {
    el.append(Object.assign(document.createElement('span'), { className: 'seat__state', textContent: state }));
  }
  if (p.connected && S.clock && S.clock.seat === seat) el.append(clockRing());
  seatScore(el, seat);
}

// seatScore gives a seat's card its side's score (racks; 3-cushion's
// points): a phone on its side stacks the cards, so each carries its own
// (CSS shows it only there).
function seatScore(el, side) {
  const m = S.seat >= 0 && !S.practice ? S.match : null;
  if (m) el.append(Object.assign(document.createElement('span'), { className: 'seat__score', textContent: String(m.score[side]) }));
}

// avatar is a player's initial in a disc of their side's colour: the face
// of the player cards on a phone held upright (CSS shows it only there).
function avatar(seat) {
  const p = S.players[seat] || { name: '' };
  const name = p.name;
  const el = Object.assign(document.createElement('span'), { className: `seat__avatar seat__avatar--p${seat % 2}` + (p.name ? '' : ' is-empty') });
  el.textContent = name ? [...name.trim()][0].toUpperCase() : '';
  el.setAttribute('aria-hidden', 'true');
  return el;
}

// groupDots shows a group's seven balls, dimmed as they are pocketed.
function groupDots(g) {
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
  return dots;
}

// renderTeamSeat draws one side of a 2v2 room in the header: both players
// (the cue by the one on turn, ready and offline tags), the side's group,
// and the shot clock while one of them must act.
function renderTeamSeat(side) {
  const el = $(`seat${side}`);
  el.hidden = false;
  const compact = compactMedia.matches;
  el.className = 'seat seat--team' + (side === 1 ? ' seat--right' : '') + (compact ? ' seat--compact' : '');
  el.replaceChildren();
  const live = inPlay() || S.moving;
  if (live && sideOf(S.turn) === side) {
    el.classList.add(isMe(S.turn) ? 'seat--turn' : 'seat--theirs');
    if (S.moving) el.classList.add('is-moving');
  }
  const faces = document.createElement('span');
  faces.className = 'seat__faces';
  faces.append(avatar(side), avatar(side + 2));
  el.append(faces);
  const body = document.createElement('div');
  body.className = 'seat__body';
  for (const s of [side, side + 2]) {
    const p = S.players[s] || { name: '' };
    const line = document.createElement('div');
    line.className = 'seat__line' + (live && S.turn === s ? ' is-on' : '');
    if (live && S.turn === s) line.insertAdjacentHTML('beforeend', CUE_SVG);
    const name = document.createElement('span');
    name.className = 'seat__name' + (p.name ? '' : ' seat__name--open');
    name.textContent = !p.name ? T`Open seat` : compact && isMe(s) ? T`You` : p.name;
    name.title = p.name || T`Open seat`;
    line.append(name);
    if (p.name && isMe(s) && !compact) line.append(tag(T`you`, 'you'));
    if (p.name && !p.connected) line.append(tag(T`offline`, 'offline'));
    if (S.phase === 'lobby' && p.ready) line.append(tag(T`ready`, 'ready'));
    body.append(line);
  }
  const g = S.groups[side];
  if (g) body.append(groupDots(g));
  el.append(body);
  if (S.clock && sideOf(S.clock.seat) === side && S.players[S.clock.seat].connected) el.append(clockRing());
  seatScore(el, side);
}

// renderTeamLobby fills the lobby of a 2v2 room: the two teams with a
// "Sit here" on each free seat (sit), and who is still missing.
function renderTeamLobby(me) {
  const box = $('lobbySeats');
  box.replaceChildren(...[0, 1].map((sd) => {
    const col = document.createElement('div');
    col.className = 'team-pick__side';
    col.append(Object.assign(document.createElement('span'), { className: 'team-pick__label', textContent: sd ? T`Team B` : T`Team A` }));
    for (const s of [sd, sd + 2]) {
      const p = S.players[s];
      if (p && p.name) {
        const chip = Object.assign(document.createElement('span'), { className: 'team-pick__seat' + (isMe(s) ? ' is-me' : '') + (p.ready ? ' is-ready' : ''), textContent: isMe(s) ? T`You` : p.name });
        chip.title = p.ready ? T`${p.name} is ready` : p.name;
        col.append(chip);
      } else {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn--secondary btn--small team-pick__sit', textContent: T`Sit here` });
        b.dataset.seat = String(s);
        b.setAttribute('aria-label', sd ? T`Sit in Team B` : T`Sit in Team A`);
        b.onclick = () => send({ type: 'sit', seat: s });
        col.append(b);
      }
    }
    return col;
  }));
  const missing = S.size - S.players.filter((p) => p.name).length;
  $('ready').hidden = missing > 0 || me.ready;
  $('lobbyCopy').hidden = missing === 0;
  if (missing) setPanelMsg('lobbyText', missing === 1 ? T`Waiting for <strong>${missing}</strong> more player.` : T`Waiting for <strong>${missing}</strong> more players.`);
  else if (me.ready) setPanelMsg('lobbyText', T`<strong>You’re ready.</strong> Waiting for the others…`);
  else setPanelMsg('lobbyText', T`<strong>All four are here.</strong> Ready when you are.`);
  $('lobbySub').textContent = T`Seats across the table play together: tap a free seat to switch teams.`;
}

// awaySeat is the seat the game waits for while its player is offline, or
// -1. In a room of two that is the opponent; in 2v2 whoever must act.
function awaySeat() {
  if (S.seat < 0) return -1;
  const s = isTeams() ? (S.decision ? S.decision.seat : S.turn) : 1 - S.seat;
  const p = S.players[s];
  return s !== S.seat && p && p.name && !p.connected ? s : -1;
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
  wrap.setAttribute('aria-label', S.clock.paused ? T`${Math.ceil(left)} seconds left, paused` : T`${Math.ceil(left)} seconds left`);
}

function tickClock() {
  const left = clockLeft();
  if (left === null) { clearInterval(S.clockTimer); S.clockTimer = 0; setHurry(0); return; }
  document.querySelectorAll('.hold--clock').forEach(updateClock);
  if (!$('decision').hidden) renderDecisionClock();
  const mine = isMe(S.clock.seat) && !S.clock.paused && left > 0;
  if (mine && left <= CLOCK_LOW_S && !S.clockWarned) {
    S.clockWarned = true;
    toast(canExtend() ? T`${CLOCK_LOW_S} seconds left · X extends` : T`${CLOCK_LOW_S} seconds left`, true);
  }
  hurry(mine ? left : null);
}

// --- your move -------------------------------------------------------------
// The player who has to act is told so beyond the seat's pulse: the table
// lights up, "Your turn" crosses it with a chime (and a buzz on a phone),
// and a tab in the background says so in its title. In the shot clock's
// last ten seconds the light turns red and each second ticks; in the last
// five it pulses faster, counts down over the table and the commentator
// hurries them along. Only the player who has to act gets any of this.

const BASE_TITLE = document.title;

// myMove: I have a shot or a choice to make.
const myMove = () => !S.practice && S.seat >= 0 && !S.moving && (isMyShot() || (!!S.decision && isMe(S.decision.seat)));

// renderTurn keeps the table lit while it is my move, and cues its start.
function renderTurn() {
  const mine = myMove();
  $('tableWrap').classList.toggle('is-my-turn', mine);
  if (mine && !S.turnCued) turnCue();
  S.turnCued = mine;
  if (!mine) { setHurry(0); setTitle(''); }
}

function turnCue() {
  const wrap = $('tableWrap');
  wrap.classList.remove('is-turn-start');
  void wrap.offsetWidth; // restart the flash
  wrap.classList.add('is-turn-start');
  const banner = $('turnBanner');
  banner.querySelector('.turn-banner__title').textContent = T`Your turn`;
  banner.querySelector('.turn-banner__sub').textContent = S.decision ? T`choose how to continue` : S.ballInHand ? T`ball in hand` : '';
  banner.hidden = false;
  banner.classList.remove('is-on');
  void banner.offsetWidth;
  banner.classList.add('is-on');
  clearTimeout(turnCue.timer);
  turnCue.timer = setTimeout(() => { banner.hidden = true; wrap.classList.remove('is-turn-start'); }, 1600);
  chime();
  nudge([40, 60, 40]);
  if (document.hidden) setTitle(T`● Your turn`);
}

// hurry follows my shot clock's last seconds (left: seconds, or null when
// it is not mine or not running).
function hurry(left) {
  if (left === null || left > CLOCK_LOW_S) { setHurry(0); return; }
  const sec = Math.ceil(left);
  setHurry(sec <= CLOCK_HURRY_S ? 2 : 1, sec);
  if (document.hidden) setTitle(T`⏰ ${sec}s · Your turn`);
  if (sec === S.clockTick) return;
  S.clockTick = sec;
  clockTick(sec <= CLOCK_HURRY_S);
  if (sec === CLOCK_LOW_S || sec === CLOCK_HURRY_S) nudge(sec === CLOCK_HURRY_S ? [80, 80, 80] : 80);
  if (sec === CLOCK_HURRY_S) speak('hurry', Math.random); // mine alone, so no shared seed
}

// setHurry shows level 0 (none), 1 (red light) or 2 (faster, with the
// countdown over the table).
function setHurry(level, sec) {
  const wrap = $('tableWrap');
  wrap.classList.toggle('is-hurry', level >= 1);
  wrap.classList.toggle('is-hurry-last', level === 2);
  const big = $('clockBig');
  big.hidden = level !== 2;
  if (level === 2 && big.textContent !== String(sec)) {
    big.textContent = String(sec);
    big.classList.remove('is-on');
    void big.offsetWidth;
    big.classList.add('is-on');
  }
}

// setTitle marks the tab's title while the page is in the background.
function setTitle(mark) {
  const t = mark ? `${mark} · ${BASE_TITLE}` : BASE_TITLE;
  if (document.title !== t) document.title = t;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTitle(''); });

// nudge vibrates a phone that can, unless haptics are off.
function nudge(pattern) {
  if (!S.haptics || !canVibrate) return;
  try { navigator.vibrate(pattern); } catch { /* not allowed */ }
}

const canExtend = () => !!S.clock && isMe(S.clock.seat) && S.clock.extensions[mySide()];

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
  const left = S.seat >= 0 && $('waitHold').dataset.seat ? holdRemaining(Number($('waitHold').dataset.seat)) : null;
  if (left !== null && !$('waitPanel').hidden && !$('waitHold').hidden) {
    $('waitSub').textContent = T`Their seat is held for ${Math.ceil(left)} more seconds.`;
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
  refreshReplay();
  if (v3) v3.setInfo(arenaInfo());
  renderModes();
  for (const sd of [0, 1]) { if (isTeams()) renderTeamSeat(sd); else renderSeat(sd); }
  renderScore();
  if (!$('matchDialog').hidden) renderMatchDialog();
  if (!$('settings').hidden) renderRoomSettings();
  if (document.querySelector('.seat .hold:not(.hold--clock)') && !S.holdTimer) S.holdTimer = setInterval(tickHolds, 1000);
  if (S.clock && !S.clockTimer) S.clockTimer = setInterval(tickClock, 200);
  renderTurn();
  const me = S.seat >= 0 ? S.players[S.seat] : null;
  const opp = S.seat >= 0 && !isTeams() ? S.players[1 - S.seat] : null;

  const myShot = isMyShot();
  const barHidden = S.phase === 'lobby' || S.phase === 'game_over' || S.seat < 0;
  if (powerBar.hidden !== barHidden) { powerBar.hidden = barHidden; resize(); }
  powerBar.classList.toggle('pbar--disabled', !myShot);
  powerTrack.tabIndex = myShot ? 0 : -1;
  if (!myShot && S.powerDrag) { S.powerDrag = false; powerClasses(); }
  if (!barHidden) renderPower();
  const panel = S.spectator ? 'waitPanel' : S.phase === 'lobby' && !S.practice ? 'lobbyPanel' : S.phase === 'game_over' ? 'overPanel' : myShot ? 'shotPanel' : 'waitPanel';
  renderPracticeBar();
  showPanel(panel);
  // On a phone the slot is one row while the rack is played; the table
  // resizes only when that changes (start and end of a rack).
  const playing = panel === 'shotPanel' || panel === 'waitPanel';
  if (document.body.classList.contains('is-playing') !== playing) {
    document.body.classList.toggle('is-playing', playing);
    resize();
  }
  if (!myShot) closeSpinPop();
  $('sideTools').classList.toggle('is-off', !myShot);
  renderTrays();
  statusCall();

  $('lobbySeats').hidden = !(panel === 'lobbyPanel' && me && isTeams());
  if (panel === 'lobbyPanel' && me && isTeams()) renderTeamLobby(me);
  else if (panel === 'lobbyPanel' && me) {
    const alone = !opp.connected && !opp.name;
    $('ready').hidden = alone || me.ready;
    $('lobbyCopy').hidden = !alone;
    if (alone) {
      setPanelMsg('lobbyText', S.lobbyNote ? esc(S.lobbyNote) : T`Waiting for an opponent.`);
      $('lobbySub').textContent = S.lobbyNote ? T`The room stays open. Send the link to someone else.` : T`Send the link; this room stays open while you are here.`;
    } else if (!opp.connected) {
      setPanelMsg('lobbyText', T`<strong>${esc(opp.name)}</strong> is offline.`);
      $('lobbySub').textContent = T`Their seat is held for a moment.`;
    } else if (me.ready) {
      setPanelMsg('lobbyText', T`<strong>You’re ready.</strong> Waiting for ${esc(opp.name)}…`);
      $('lobbySub').textContent = T`The match starts when both players are ready.`;
    } else {
      setPanelMsg('lobbyText', T`<strong>${esc(opp.name)} is here.</strong> Ready when you are.`);
      $('lobbySub').textContent = isCarom()
        ? T`3-cushion to ${points(S.race)}.`
        : (S.race === 1 ? T`${MODE_NAME[S.mode]} on a ${SPEC.name}, first to ${S.race} rack.` : T`${MODE_NAME[S.mode]} on a ${SPEC.name}, first to ${S.race} racks.`) + ` ${tr(BREAKS_TEXT[S.breaks])}`;
    }
  }
  if (panel === 'shotPanel') refreshShotPanel();
  if (panel === 'waitPanel') {
    const hold = $('waitHold');
    hold.hidden = true;
    let msg, sub = '';
    if (S.spectator && S.phase === 'lobby') {
      const seated = S.players.filter((p) => p.name).map((p) => `<strong>${esc(p.name)}</strong>`);
      const more = S.size - seated.length;
      if (!seated.length) msg = T`Nobody is at the table yet.`;
      else if (!more) msg = T`${seated.join(isTeams() ? ', ' : T` and `)} are getting ready.`;
      else if (!isTeams()) msg = T`${seated[0]} is waiting for an opponent.`;
      else msg = seated.length === 1 ? T`${seated[0]} is waiting for ${more} more.` : T`${seated.join(', ')} are waiting for ${more} more.`;
      sub = T`You are watching. Say something in the chat.`;
    } else if (S.spectator && S.phase === 'game_over') {
      msg = `<strong>${esc(winnerTitle())}</strong>`;
      sub = T`You are watching.`;
    } else if (S.moving) { msg = `<span class="muted">${T`Balls are rolling…`}</span>`; }
    else if (S.practice) { msg = `<span class="muted">${T`Setting up the table…`}</span>`; }
    else if (awaySeat() >= 0) {
      const away = awaySeat();
      msg = T`Waiting for <strong>${esc(S.players[away].name)}</strong> to reconnect…`;
      const left = holdRemaining(away);
      sub = left === null ? T`Their seat is held for a moment.` : T`Their seat is held for ${Math.ceil(left)} more seconds.`;
      hold.hidden = false;
      hold.replaceChildren(...holdRing(away).childNodes);
      hold.dataset.seat = String(away);
      if (!S.holdTimer) S.holdTimer = setInterval(tickHolds, 1000);
    } else if (S.decision) {
      msg = isMe(S.decision.seat) ? T`Your decision.` : T`Waiting for <strong>${esc(nameOf(S.decision.seat))}</strong> to decide.`;
      sub = S.lastDecisionReason;
    } else {
      const mate = isTeams() && isMySide(sideOf(S.turn)) ? ` <span class="muted">${T`(your team)`}</span>` : '';
      msg = `${T`<strong>${esc(nameOf(S.turn))}’s turn.</strong>`}${mate}${S.ballInHand ? T` Ball in hand.` : ''}`;
      sub = T`You see their aim as they line up.`;
    }
    setPanelMsg('waitText', msg);
    $('waitSub').textContent = sub;
  }
  if (panel === 'overPanel') renderOverPanel();
  refreshDecision();
}

// renderModes shows the room's game on the scoreboard.
function renderModes() {
  $('roomEyebrow').textContent = S.spectator ? T`Watching · ${MODE_NAME[S.mode]}` : S.seat < 0 ? T`Room` : S.practice ? T`Practice · ${MODE_NAME[S.mode]}` : T`${MODE_NAME[S.mode]} room`;
  $('leaveBtn').hidden = !inRoom() || S.practice;
  $('chatBtn').hidden = !inRoom() || S.practice;
  document.body.classList.toggle('is-watching', S.spectator);
  document.body.classList.toggle('is-practice', S.practice && S.seat >= 0);
}

function setSeg(seg, mode) {
  for (const b of seg.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
}

// The landing picker chooses the game of a new room (remembered); the room
// keeps it. The hall on the home page draws the picks once they are all read
// (hallReady, set where the spectator pick is).
let hallReady = false;
let landingMode = MODE_NAME[readSetting('pool:mode')] ? readSetting('pool:mode') : '8ball';
setSeg($('landingMode'), landingMode);
$('landingMode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  landingMode = b.dataset.mode;
  writeSetting('pool:mode', landingMode);
  setSeg($('landingMode'), landingMode);
  renderLandingMatch();
  renderLandingTable();
});

// The table and cloth pickers set up a new room on the landing (remembered)
// and dress the table behind it. A room keeps the table and the cloth it was
// made with: Settings → This room only shows them. The buttons are built
// from TABLES and CLOTHS.
const inches = (m) => `${Math.round(m / INCH * 100) / 100}″`;
function fillTablePick(el) {
  el.replaceChildren(...Object.entries(TABLES).map(([id, t]) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'table-pick__opt' });
    b.dataset.table = id;
    const name = Object.assign(document.createElement('span'), { className: 'table-pick__name' });
    const finish = Object.assign(document.createElement('span'), { className: 'table-pick__finish' });
    finish.style.background = railGradient(LOOKS[id]); // the rail, with its trim or rims
    finish.style.boxShadow = LOOKS[id].trim ? `inset 0 0 0 1.5px ${LOOKS[id].trim}` : `inset 0 0 0 1px ${LOOKS[id].rim || 'rgba(0, 0, 0, .35)'}`;
    finish.setAttribute('aria-hidden', 'true');
    name.append(finish, t.name);
    b.append(name, Object.assign(document.createElement('span'), { className: 'table-pick__pockets', textContent: T`corners ${inches(t.corner)} · sides ${inches(t.side)}` }));
    return b;
  }));
}
function fillClothPick(el) {
  el.replaceChildren(...Object.entries(CLOTHS).map(([id, c]) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'cloth-pick__swatch', title: c.name });
    b.dataset.cloth = id;
    b.style.setProperty('--swatch', c.felt);
    b.setAttribute('aria-label', c.name);
    return b;
  }));
}
// setPick presses the button of el whose data-key is value and enables or
// disables them all; a cloth picker's field names the cloth.
function setPick(el, key, value, disabled = false) {
  for (const b of el.children) {
    b.setAttribute('aria-pressed', String(b.dataset[key] === value));
    b.disabled = disabled;
  }
  const name = el.parentElement.querySelector('.js-cloth-name');
  if (name) name.textContent = CLOTHS[value] ? CLOTHS[value].name : '';
}
fillTablePick($('landingTable'));
fillClothPick($('landingCloth'));
let landingTable = TABLES[readSetting('pool:table')] ? readSetting('pool:table') : DEFAULT_TABLE;
let landingCloth = CLOTHS[readSetting('pool:cloth')] ? readSetting('pool:cloth') : DEFAULT_CLOTH;
function renderLandingTable() {
  setPick($('landingTable'), 'table', landingTable);
  setPick($('landingCloth'), 'cloth', landingCloth);
  $('landingTableField').hidden = landingMode === '3cushion'; // played on the carom table
  $('landingCaromNote').hidden = landingMode !== '3cushion';
  if (hallReady && !$('landingForm').classList.contains('landing--invited')) renderHall();
  if (!inRoom()) { // the table behind the landing shows the pick, empty
    const key = landingMode === '3cushion' ? 'carom' : landingTable;
    if (key !== tableKey) S.balls = new Map();
    S.mode = landingMode;
    S.table = landingTable;
    setCloth(landingCloth);
    setTable(landingMode);
  }
}
$('landingTable').addEventListener('click', (e) => {
  const b = e.target.closest('[data-table]');
  if (!b) return;
  landingTable = b.dataset.table;
  writeSetting('pool:table', landingTable);
  renderLandingTable();
});
$('landingCloth').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cloth]');
  if (!b) return;
  landingCloth = b.dataset.cloth;
  writeSetting('pool:cloth', landingCloth);
  renderLandingTable();
});
renderLandingTable();

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function setPanelMsg(id, html) { $(id).innerHTML = html; }

function refreshShotPanel() {
  const callEl = $('callText');
  let html, called = false;
  const opp = oppName();
  if (S.practice && isCarom()) {
    html = compactLayout.matches ? T`Free play: <span class="muted">both balls, three cushions before the second.</span>`
      : T`Free play: <span class="muted">both balls, three cushions before the second. Drag the white anywhere; Move sets up the others.</span>`;
    called = true;
  } else if (S.practice) {
    html = compactLayout.matches ? T`Free play: <span class="muted">any ball, any pocket.</span>`
      : T`Free play: <span class="muted">any ball, any pocket, no fouls. Drag the cue ball anywhere; Move sets up the others.</span>`;
    called = true;
  } else if (isCarom()) {
    const mine = caromName(cueId());
    called = true;
    if (S.phase === 'breaking') {
      html = compactLayout.matches ? T`Break with the ${mine}: <span class="muted">the red first.</span>` : T`Break with the ${mine}: <span class="muted">the red first, then three cushions and the yellow.</span>`;
    } else if (S.carom && S.carom.equalizing) {
      html = T`Last inning: <span class="muted">reach ${S.target} to draw the game.</span>`;
    } else {
      html = T`Your ball: <span class="call__value">${mine}</span> <span class="muted">· both balls, three cushions before the second.</span>`;
    }
  } else if (isNine()) {
    const low = lowestBall();
    called = true;
    if (S.phase === 'breaking') {
      html = S.ballInHand && !compactLayout.matches ? T`Break: <span class="muted">hit the 1 first, cue ball anywhere in the kitchen.</span>` : T`Break: <span class="muted">hit the 1 first.</span>`;
    } else if (S.call && S.call.pushOut) {
      html = T`Push out: <span class="muted">no contact needed; then ${esc(opp)} chooses who shoots.</span>`;
    } else {
      // scotch doubles: say so where there is room
      const scotch = isTeams() && !compactLayout.matches ? T` Partners alternate every shot.` : '';
      html = T`Hit the <span class="call__value">${low === 9 ? '9-ball' : low}</span> first <span class="muted">· any ball that drops counts; the 9 wins.${scotch}</span>`;
    }
  } else if (!canCall()) {
    // On a phone the "ball in hand · kitchen" tag beside it says the rest.
    html = S.ballInHand && !compactLayout.matches ? T`Break: <span class="muted">no call needed, drag the cue ball anywhere in the kitchen.</span>` : T`Break: <span class="muted">no call needed.</span>`;
    called = true;
  } else if (S.call && S.call.safety) {
    html = T`Safety: <span class="muted">the turn passes after the shot.</span>`;
    called = true;
  } else if (eightOn()) {
    if (S.call) {
      html = T`Called: <span class="call__value">${esc(pocketName(S.call.pocket))}</span>`;
      called = true;
    } else {
      html = S.ballInHand ? T`Ball in hand: place the cue ball, then tap a pocket for the 8.` : T`On the 8-ball: tap the pocket you are going for.`;
    }
  } else if (S.phase === 'open') {
    html = T`Open table: <span class="muted">any ball but the 8 counts.</span>`;
    called = true;
  } else {
    html = T`Your group: <span class="call__value">${esc(groupName(S.groups[mySide()]))}</span> <span class="muted">· any that drops counts.</span>`;
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
    ext.title = T`Extension: reset your clock to ${secs} seconds, once per game (X)`;
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
  $('handTag').textContent = S.kitchen ? T`ball in hand · kitchen` : T`ball in hand`;
  if (S.ballInHand && readSetting('pool:hint:hand') !== 'off') {
    writeSetting('pool:hint:hand', 'off');
    toast(S.kitchen ? T`Drag the cue ball anywhere in the kitchen, then pull the bar to shoot` : T`Drag the cue ball anywhere on the table`);
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
  renderBanner(d && !isMe(d.seat) && !S.moving ? T`Waiting for ${nameOf(d.seat)} to decide` : '');
  renderResult();
  if (!show) return;
  renderDecisionClock();
  if (wasShown && dlg.dataset.key === JSON.stringify(d) + LANG) return; // already built
  dlg.dataset.key = JSON.stringify(d) + LANG;
  const eight = d.options.includes('spot_eight');
  $('decisionTitle').textContent = d.options.includes('take_shot') ? T`Push out` : eight ? T`8-ball on the break` : T`Illegal break`;
  $('decisionText').textContent = S.lastDecisionReason || '';
  const box = $('decisionOptions');
  box.replaceChildren();
  const opp = oppName();
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
  const opp = oppName();
  const text = T`${Math.ceil(left)} s left, then “${optionText(S.decision.options[0], opp)[0]}” is chosen for you.`;
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
  $('menuBtn').hidden = !on;
  if (!on) { closePracticeMenu(); return; }
  $('undoBtn').disabled = S.undos === 0 || S.moving;
  $('undoBtn').title = S.undos ? T`Take back the last shot (Z) · ${S.undos} left` : T`Nothing to take back yet`;
  $('moveBtn').setAttribute('aria-pressed', String(S.moveTool));
  $('rackBtn').disabled = S.moving;
}

// On a phone held upright the practice tools open from the header's menu
// button as a small list (CSS), not as a row under the table.
function closePracticeMenu() {
  $('practiceBar').classList.remove('is-open');
  $('menuBtn').setAttribute('aria-expanded', 'false');
}
$('menuBtn').onclick = (e) => {
  e.stopPropagation();
  const open = !$('practiceBar').classList.contains('is-open');
  $('practiceBar').classList.toggle('is-open', open);
  $('menuBtn').setAttribute('aria-expanded', String(open));
};
document.addEventListener('click', (e) => { if (!e.target.closest('#practiceBar, #menuBtn')) closePracticeMenu(); });
$('practiceBar').addEventListener('click', (e) => { if (e.target.closest('button')) setTimeout(closePracticeMenu, 0); });

// renderTrays fills the columns beside the table on a phone held upright
// (8-ball, not practice): each side's seven balls, left side A, right side
// B, emptied as they drop; the 8 once a side's group is gone; empty slots
// before the groups are known. The side on turn is lit.
function renderTrays() {
  const show = !!phoneSet && S.mode === '8ball' && !S.practice && S.phase !== 'lobby';
  for (const side of [0, 1]) {
    const el = $(side ? 'trayR' : 'trayL');
    el.hidden = !show;
    if (!show) continue;
    const g = S.groups[side];
    const ids = !g ? [] : remaining(g) === 0 ? [8] : [...Array(7)].map((_, i) => (g === 'solids' ? i + 1 : i + 9));
    const key = `${g}|${ids.filter((id) => S.balls.has(id)).join()}`;
    el.classList.toggle('tray--on', (inPlay() || S.moving) && sideOf(S.turn) === side);
    if (el.dataset.key === key) continue;
    el.dataset.key = key;
    el.replaceChildren(...[...Array(7)].map((_, i) => {
      const slot = document.createElement('span');
      slot.className = 'tray__slot';
      const id = ids[i];
      if (id !== undefined && S.balls.has(id)) {
        const ball = document.createElement('span');
        ball.className = 'ball' + (id > 8 ? ' ball--stripe' : '');
        ball.style.setProperty('--c', `var(--ball-${id > 8 ? id - 8 : id})`);
        ball.append(Object.assign(document.createElement('span'), { className: 'ball__num', textContent: String(id) }));
        slot.append(ball);
      }
      return slot;
    }));
  }
}

function undo() {
  if (S.practice && S.undos > 0 && !S.moving) send({ type: 'undo' });
}

function toggleMoveTool() {
  S.moveTool = !S.moveTool;
  if (S.moveTool) toast(T`Move balls: drag any ball. Press M again to aim.`);
  refreshPanels();
}

// winnerTitle names the winner of the rack; in practice by side.
function winnerTitle() {
  if (isCarom() && !S.practice) {
    if (S.winner === null) return T`A draw`;
    return isMe(S.winner) ? T`You win the game` : T`${nameOf(S.winner)} wins the game`;
  }
  if (S.winner === null) return T`Game over`;
  if (S.practice) return T`${sideName(S.winner)} wins the rack`;
  return T`${sideDoes(S.winner, 'win')} the rack`;
}

function renderResult() {
  let el = $('tableWrap').querySelector('.result');
  const draw = isCarom() && !S.practice && S.winner === null;
  if (S.phase !== 'game_over' || (S.winner === null && !draw)) { if (el) el.remove(); return; }
  const win = isMySide(S.winner) && !S.practice;
  const m = S.practice ? null : S.match;
  const matchWon = m && m.race > 1 && m.winner !== null && !isCarom();
  const title = matchWon ? matchTitle(m) : winnerTitle();
  const score = m && m.race > 1 && m.racks.length && !isCarom() ? `${m.score[0]}–${m.score[1]}` : '';
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
const POINTS_MAX = 50; // 3-cushion: the race is in points (game.MaxCaromTarget)
const RACE_PICKS = [1, 3, 5, 7, 9];
const POINT_PICKS = [10, 15, 20, 25, 30, 40];
const raceMax = (mode) => (mode === '3cushion' ? POINTS_MAX : RACE_MAX);
const BREAKS_TEXT = { alternate: N('The break alternates.'), winner: N('The winner of a rack breaks the next.') };

// setMatch takes the match from the server and notes when it was just won.
function setMatch(m) {
  const prev = S.match;
  S.match = m || null;
  if (m && prev && prev.winner === null && m.winner !== null && m.racks.length > prev.racks.length) {
    const last = m.racks[m.racks.length - 1];
    S.matchJustWon = (m.race > 1 && !isCarom()) || last.end === 'forfeit'; // a race to 1 is just the rack, a 3-cushion match the game
  }
}

// matchLive reports whether leaving now forfeits a match.
function matchLive() {
  return !S.practice && S.seat >= 0 && !!S.match && S.match.winner === null && !S.match.draw && S.phase !== 'lobby';
}

// matchName names a side in the match history, even after its player left.
function matchName(seat) {
  if (isTeams()) return teamName(seat);
  if (isMe(seat)) return T`You`;
  return S.players[seat].name || S.lastOppName || T`Player ${seat + 1}`;
}

function matchTitle(m) {
  if (m.winner === null) return T`A draw`;
  return isTeams() ? T`${sideDoes(m.winner, 'win')} the match` : isMe(m.winner) ? T`You win the match` : T`${matchName(m.winner)} wins the match`;
}

// rackWhy says how a rack of the match ended.
function rackWhy(r) {
  const loser = matchName(1 - r.winner);
  switch (r.end) {
    case 'points': return T`${matchName(r.winner)} reached ${points(S.match ? S.match.race : 0)}`;
    case 'draw': return T`both reached the target in the same innings`;
    case 'made': return S.mode === '9ball' ? T`9-ball pocketed` : T`8-ball in the called pocket`;
    case 'eight_foul': return r.foul ? T`${loser} fouled on the 8-ball: ${foulText(r.foul)}` : T`${loser} fouled on the 8-ball`;
    case 'eight_early': return T`${loser} pocketed the 8-ball early`;
    case 'eight_pocket': return T`${loser} pocketed the 8-ball in the wrong pocket`;
    case 'eight_off': return T`${loser} jumped the 8-ball off the table`;
    case 'three_fouls': return T`${loser} fouled three times in a row`;
    case 'forfeit': return T`${loser} left the match`;
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
  el.dataset.mode = `${MODE_NAME[S.mode] || ''}${isTeams() ? ' · 2v2' : ''}`; // the phone's player cards name the game over the score
  const m = S.seat >= 0 && !S.practice ? S.match : null;
  const compact = compactLayout.matches ? ' score--compact' : '';
  el.disabled = !m;
  if (!m) {
    el.className = 'score score--empty' + compact;
    if (el.dataset.k !== 'vs' + LANG) {
      el.innerHTML = `<span class="score__vs">${T`vs`}</span>`;
      el.dataset.k = 'vs' + LANG;
      el.setAttribute('aria-label', T`No score yet`);
      el.removeAttribute('title');
    }
    S.shownScore = null;
    return;
  }
  const carom = isCarom();
  const goal = carom ? T`to ${m.race}` : T`race to ${m.race}`;
  el.className = 'score' + (m.racks.length || (carom && m.score[0] + m.score[1] > 0) ? '' : ' score--empty') + compact;
  el.setAttribute('aria-label', carom ? T`Score ${m.score[0]} to ${m.score[1]}, ${m.race} points to win. Show the game.` : T`Score ${m.score[0]} to ${m.score[1]}, race to ${m.race}. Show the racks.`);
  el.title = carom ? T`Show the game` : T`Show the racks`;
  const key = `${m.score[0]}-${m.score[1]}-${m.race}-${LANG}`;
  if (el.dataset.k === key) return;
  const old = S.shownScore;
  const tick = old && old.race === m.race && !reduceMotion.matches;
  const slot = (i) => {
    const n = m.score[i];
    if (tick && n > old.score[i]) return `<span class="score__slot"><span class="score__old">${old.score[i]}</span><span class="score__new">${n}</span></span>`;
    return `<span class="score__slot"><span>${n}</span></span>`;
  };
  el.innerHTML = `<span class="score__nums">${slot(0)}<span class="score__sep">–</span>${slot(1)}</span><span class="score__race">${goal}</span>`;
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
  const over = m.winner !== null || !!m.draw;
  const last = m.racks[m.racks.length - 1];
  const carom = isCarom();
  $('matchEyebrow').textContent = carom ? T`3-cushion · to ${points(m.race)}` : T`${MODE_NAME[S.mode]} · race to ${m.race}`;
  $('matchTitle').textContent = over ? matchTitle(m) : carom ? T`Game|match` : T`Match`;
  let text;
  if (carom && over && last.end !== 'forfeit') text = `${caromReason() || `${m.score[0]}–${m.score[1]}`}.`;
  else if (carom && !over) text = T`First to ${points(m.race)}. If the breaker gets there first, the other player has one more inning to draw level.`;
  else if (over && last.end === 'forfeit') {
    const to = isMySide(m.winner) ? (isTeams() ? T`your team` : T`you`) : matchName(m.winner);
    text = T`${matchName(1 - m.winner)} left the room, so the match goes to ${to}.`;
  } else if (over) {
    const [a, b, n] = [m.score[m.winner], m.score[1 - m.winner], m.racks.length];
    text = n === 1 ? T`${a}–${b} after ${n} rack.` : T`${a}–${b} after ${n} racks.`;
  } else text = (m.race === 1 ? T`First to ${m.race} rack wins.` : T`First to ${m.race} racks wins.`) + ` ${tr(BREAKS_TEXT[m.breaks])}`;
  $('matchText').textContent = text;
  $('matchName0').textContent = matchName(0);
  $('matchName1').textContent = matchName(1);
  $('matchNums').textContent = `${m.score[0]} – ${m.score[1]}`;
  renderCaromLines(carom);
  const list = $('matchRacks');
  list.replaceChildren();
  if (!m.racks.length) {
    list.append(Object.assign(document.createElement('li'), { className: 'racks__empty', textContent: T`No rack finished yet.` }));
    return;
  }
  const run = [0, 0];
  m.racks.forEach((r, i) => {
    if (r.end !== 'forfeit' && r.winner >= 0) run[r.winner]++;
    const li = document.createElement('li');
    li.className = 'rack';
    const n = Object.assign(document.createElement('span'), { className: 'rack__n', textContent: `#${i + 1}` });
    const who = Object.assign(document.createElement('span'), { className: 'rack__who' + (isMySide(r.winner) ? ' rack__who--me' : ''), textContent: r.winner < 0 ? T`Draw` : matchName(r.winner) });
    const sc = Object.assign(document.createElement('span'), { className: 'rack__score', textContent: carom ? `${m.score[0]}–${m.score[1]}` : `${run[0]}–${run[1]}` });
    const broke = isMySide(r.breaker) ? (isTeams() ? T`your team broke` : T`you broke`) : T`${matchName(r.breaker)} broke`;
    const why = Object.assign(document.createElement('span'), { className: 'rack__why', textContent: `${rackWhy(r)} · ${broke}` });
    li.append(n, who, sc, why);
    list.append(li);
  });
  list.lastElementChild.scrollIntoView({ block: 'nearest' });
}

// renderCaromLines gives each 3-cushion player's line in the match dialog:
// points of the target, innings, average and best run, and the run going on.
function renderCaromLines(carom) {
  const box = $('matchStats');
  box.hidden = !carom || !S.carom;
  if (box.hidden) return;
  const c = S.carom;
  box.replaceChildren(...[0, 1].map((seat) => {
    const inn = c.innings[seat];
    const avg = inn ? (c.points[seat] / inn).toFixed(3) : '0.000';
    const run = S.turn === seat && c.run > 0 && S.phase !== 'game_over' ? T` · run ${c.run}` : '';
    const row = Object.assign(document.createElement('div'), { className: 'match-stats__row' });
    row.title = T`${matchName(seat)}: ${c.points[seat]} of ${S.target} points, ${inn} innings, average ${avg}, high run ${c.highRun[seat]}`;
    row.append(Object.assign(document.createElement('dt'), { textContent: matchName(seat) }),
      Object.assign(document.createElement('dd'), { textContent: T`${c.points[seat]}/${S.target} · ${inn} inn · avg ${avg} · HR ${c.highRun[seat]}` + run }));
    return row;
  }));
}

function openLeaveConfirm() {
  const m = S.match;
  const opp = matchName(1 - mySide());
  const score = m.racks.length || isCarom() ? T`The score is ${m.score[mySide()]}–${m.score[1 - mySide()]} (you first). ` : '';
  const mate = isTeams() && S.players.find((p) => p.seat !== S.seat && p.seat % 2 === mySide() && p.name);
  $('leaveText').textContent = score + (mate ? T`${mate.name} plays on alone for your team.` : T`Leaving now gives ${opp} the match.`);
  $('leaveTitle').textContent = mate ? T`Leave the match?` : T`Leave and forfeit the match?`;
  $('leaveForfeit').textContent = mate ? T`Leave` : T`Leave and forfeit`;
  $('leaveConfirm').hidden = false;
  $('leaveStay').focus();
}

// renderOverPanel: between racks the next rack, after the match a new one,
// as the room was made.
function renderOverPanel() {
  const m = S.practice ? null : S.match;
  const live = matchLive();
  if (S.practice) {
    $('overText').textContent = winnerTitle();
    $('rematch').textContent = T`Rack again`;
    $('rematchNote').textContent = T`Next: ${MODE_NAME[S.mode]}. Undo takes the last shot back.`;
    return;
  }
  const breaks = (side) => sideDoes(side, 'break');
  if (live) {
    const next = m.breaks === 'winner' ? S.winner : 1 - S.lastBreaker;
    $('overText').textContent = winnerTitle();
    $('rematch').textContent = T`Next rack`;
    $('rematchNote').textContent = T`${m.score[0]}–${m.score[1]}, race to ${m.race}. ${breaks(next)} the next rack.`;
    return;
  }
  const opener = m && m.racks.length ? 1 - m.racks[0].breaker : -1;
  const long = m && m.race > 1 && !isCarom();
  if (long) { // the score never breaks over two lines
    const score = Object.assign(document.createElement('span'), { className: 'nowrap', textContent: `${m.score[m.winner]}–${m.score[1 - m.winner]}` });
    $('overText').replaceChildren(`${matchTitle(m)} `, score);
  } else $('overText').textContent = winnerTitle();
  $('rematch').textContent = long ? T`New match` : T`Rematch`;
  const goal = isCarom() ? T`to ${points(S.race)}` : T`race to ${S.race}`;
  $('rematchNote').textContent = T`Next: ${MODE_NAME[S.mode]}, ${goal}.` + (opener < 0 ? '' : T` ${breaks(opener)} first.`);
}

// Match pickers: race (quick picks or a number) and who breaks. In
// 3-cushion the race is the points of the one game, and the break rule
// does not apply.
function setMatchPick(root, race, breaks, mode) {
  const carom = mode === '3cushion';
  const seg = root.querySelector('.js-race');
  const kind = (carom ? 'points' : 'racks') + LANG; // labels are rebuilt in another language
  if (seg.dataset.kind !== kind) {
    seg.dataset.kind = kind;
    seg.replaceChildren(...(carom ? POINT_PICKS : RACE_PICKS).map((n) => Object.assign(document.createElement('button'), {
      type: 'button', className: 'seg__btn', textContent: String(n),
    })));
    for (const b of seg.children) b.dataset.race = b.textContent;
    seg.setAttribute('aria-label', carom ? T`Points to win` : T`Race to`);
    root.querySelector('.js-race-label').textContent = carom ? T`Points` : T`Race to`;
    const input = root.querySelector('.js-race-input');
    input.max = String(raceMax(mode));
    input.setAttribute('aria-label', carom ? T`Points to win, 1 to ${POINTS_MAX}` : T`Race to, 1 to ${RACE_MAX}`);
    root.querySelector('.js-breaks').closest('.match-pick__row').hidden = carom;
  }
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
    const { race, mode } = current();
    if (Number.isInteger(n) && n >= 1 && n <= raceMax(mode)) onChange({ race: n });
    else {
      toast(mode === '3cushion' ? T`A game is 1 to ${POINTS_MAX} points` : T`The race is 1 to ${RACE_MAX} racks`, true);
      input.value = String(race);
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
let landingPoints = Number(readSetting('pool:points')) || 15; // 3-cushion
if (!(landingPoints >= 1 && landingPoints <= POINTS_MAX)) landingPoints = 15;
let landingBreaks = readSetting('pool:breaks') === 'winner' ? 'winner' : 'alternate';
const landingGoal = () => (landingMode === '3cushion' ? landingPoints : landingRace);
let landingRulesReady = false; // once the spectator pick below is read
function renderLandingMatch() {
  setMatchPick($('landingMatch'), landingGoal(), landingBreaks, landingMode);
  renderLandingPlayers();
  if (landingRulesReady) renderLandingRules();
}
// Players: 1 v 1, or 2 v 2 (8-ball: whoever pockets shoots on; 9-ball:
// scotch doubles, partners alternate every shot). Not in 3-cushion.
let landingPlayers = readSetting('pool:players') === '4' ? 4 : 2;
const landingSize = () => (landingMode === '3cushion' ? 2 : landingPlayers);
function renderLandingPlayers() {
  $('landingPlayersRow').hidden = landingMode === '3cushion';
  for (const b of $('landingPlayers').querySelectorAll('.seg__btn')) b.setAttribute('aria-pressed', String(Number(b.dataset.players) === landingPlayers));
}
$('landingPlayers').addEventListener('click', (e) => {
  const b = e.target.closest('.seg__btn');
  if (!b) return;
  landingPlayers = Number(b.dataset.players);
  writeSetting('pool:players', landingPlayers === 4 ? '4' : null);
  renderLandingPlayers();
  renderLandingRules();
});

// On a phone the match rules fold away under a line that sums them up
// (CLIENT.md, "Landing"); a tap opens them.
function renderLandingRules() {
  const goal = landingMode === '3cushion' ? T`${landingPoints} points` : T`Race to ${landingRace}`;
  const breaks = landingMode === '3cushion' ? '' : landingBreaks === 'winner' ? T` · winner breaks` : T` · alternate breaks`;
  const watch = landingAudience ? T`${landingAudience} may watch` : T`no spectators`;
  $('landingOptsSum').textContent = `${landingSize() > 2 ? '2v2 · ' : ''}${goal}${breaks} · ${watch}`;
  if (hallReady && !$('landingForm').classList.contains('landing--invited')) renderHall();
}
$('landingOptsBtn').onclick = () => {
  const open = !$('landingOpts').classList.contains('is-open');
  $('landingOpts').classList.toggle('is-open', open);
  $('landingOptsBtn').setAttribute('aria-expanded', String(open));
};
renderLandingMatch();
wireMatchPick($('landingMatch'), () => ({ race: landingGoal(), mode: landingMode }), (c) => {
  if (c.race && landingMode === '3cushion') { landingPoints = c.race; writeSetting('pool:points', String(c.race)); }
  else if (c.race) { landingRace = c.race; writeSetting('pool:race', String(c.race)); }
  if (c.breaks) { landingBreaks = c.breaks; writeSetting('pool:breaks', c.breaks); }
  renderLandingMatch();
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
  setStatus(T`New ${MODE_NAME[S.mode]} rack. Free play.`);
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

// --- fine aim: a wheel dragged sideways ---------------------------------------
// 0.02° per px (100 px turn the cue 2°), without end; to the right turns
// clockwise, like +0.25°. Its ticks roll with the finger. Focused, the arrow
// keys turn 0.05° (Shift 0.01°) instead of the table's 0.5°.

const aimJog = $('aimJog');
const JOG_DEG_PER_PX = 0.02;
let jogFrom = null; // the pointer's x (y on the upright wheel) while dragging
let jogType = '';   // and its kind
let jogRolled = 0;  // px the ticks have rolled
function turnJog(px) {
  if (!isMyShot()) return;
  setAngle(S.angle + px * JOG_DEG_PER_PX * DEG);
  jogRolled += px;
  aimJog.style.setProperty('--jog-x', `${jogRolled}px`);
  aimJog.style.setProperty('--jog-y', `${jogRolled}px`);
  aimJog.setAttribute('aria-valuetext', $('angleText').textContent);
}
aimJog.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  aimJog.focus({ preventScroll: true }); // the arrows go on in its steps
  jogFrom = aimJog.classList.contains('jog--v') ? e.clientY : e.clientX;
  jogType = e.pointerType;
  aimJog.setPointerCapture(e.pointerId);
  aimJog.classList.add('jog--drag');
});
aimJog.addEventListener('pointermove', (e) => {
  if (jogFrom === null) return;
  // sideways to the right, or upright downwards, turns clockwise
  const at = aimJog.classList.contains('jog--v') ? e.clientY : e.clientX;
  const d = at - jogFrom;
  jogFrom = at;
  turnJog(d);
});
const endJog = () => { jogFrom = null; aimJog.classList.remove('jog--drag'); };
aimJog.addEventListener('pointerup', endJog);
aimJog.addEventListener('pointercancel', endJog);
aimJog.addEventListener('keydown', (e) => {
  const dir = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }[e.key];
  if (!dir) return;
  e.preventDefault();
  e.stopPropagation(); // not the table's 0.5° step
  turnJog(dir * (e.shiftKey ? 0.01 : 0.05) / JOG_DEG_PER_PX);
});
aimJog.addEventListener('wheel', (e) => {
  if (e.ctrlKey) return;
  e.preventDefault();
  turnJog(wheelNotches(e) * (e.shiftKey ? WHEEL_DEG_FINE : WHEEL_DEG) / JOG_DEG_PER_PX);
}, { passive: false });
// copyInvite shares (phones) or copies the room's invite link.
async function copyInvite() {
  const url = `${location.origin}/?room=${S.roomCode}`;
  if (navigator.share && compactMedia.matches) {
    try { await navigator.share({ title: 'Pool', text: T`Join my pool room ${S.roomCode}`, url }); return; } catch { /* cancelled or unsupported: fall back to copying */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast(T`Invite link copied`);
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
$('code').addEventListener('input', () => {
  $('code').classList.remove('input--error');
  $('code').removeAttribute('aria-invalid');
  $('codeError').hidden = true;
});
// Enter (a phone's Done) in the name field with no room code typed has
// nothing to join: it only puts the keyboard away. With a code, or on an
// invite, it joins.
$('name').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing || $('code').value.trim()) return;
  e.preventDefault();
  $('name').blur();
});
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
  setLandingError();
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(practice
        ? { mode: landingMode, table: landingTable, cloth: landingCloth, practice }
        : { mode: landingMode, table: landingTable, cloth: landingCloth, race: landingGoal(), breaks: landingBreaks, spectators: landingAudience, players: landingSize() }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errText(body.error, body.message || `HTTP ${res.status}`));
    const { roomCode } = body;
    $('code').value = roomCode;
    S.rackMode = landingMode;
    connectAndJoin(roomCode, name);
  } catch (err) {
    showLanding(T`Could not create a room: ${err.message}`);
  }
}
$('watchInvite').onclick = () => {
  const name = landingName();
  if (name) connectAndJoin($('code').value.trim().toUpperCase(), name, null, true);
};
$('create').onclick = () => createRoom(false);
$('practice').onclick = () => createRoom(true);
$('landingForm').onsubmit = (e) => {
  e.preventDefault();
  if ($('landing').hidden) return; // already in a room
  const code = $('code').value.trim().toUpperCase();
  const name = landingName();
  if (!name) return;
  if (code.length !== 5) {
    $('code').classList.add('input--error');
    $('code').setAttribute('aria-invalid', 'true');
    $('codeError').hidden = false;
    $('code').focus({ preventScroll: true });
    $('codeError').scrollIntoView({ block: 'nearest' });
    return;
  }
  connectAndJoin(code, name);
};
$('rejoin').onclick = () => {
  S.reconnectAttempt = 0; // "Retry now" restarts the backoff
  $('retryTry').textContent = T`Connecting…`;
  connectAndJoin(S.roomCode, S.name, S.token);
};
// --- chat ----------------------------------------------------------------------
// One thread for the room, players and spectators alike (PROTOCOL.md,
// "Spectators and chat"). The server lets each sender comment once every
// 5 s; the Send button counts that down. While the panel is closed, new
// comments float over the table for a moment (Settings → Chat turns that
// off) and the button counts them.

const CHAT_COOLDOWN_MS = 5000;
const CHAT_KEEP = 50;
let chatTicker = 0;

function onChat(msg) {
  S.chat.push(msg);
  if (S.chat.length > CHAT_KEEP) S.chat.splice(0, S.chat.length - CHAT_KEEP);
  appendChat(msg);
  if ($('chatPanel').hidden) {
    S.chatUnread++;
    renderChatBadge();
    chatBubble(msg);
  }
}

// chatLine builds one comment: the sender (a player's seat dot or a
// spectator's eye) and the text, never parsed as HTML.
function chatLine(m) {
  const li = document.createElement('li');
  li.className = 'chat__line';
  const who = document.createElement('span');
  who.className = `chat__from chat__from--${m.seat >= 0 ? `p${m.seat}` : 'watcher'}`;
  who.textContent = m.from;
  const text = document.createElement('span');
  text.className = 'chat__text';
  text.textContent = m.text;
  li.append(who, text);
  return li;
}
function renderChat() {
  $('chatList').replaceChildren(...S.chat.map(chatLine));
  scrollChat();
  renderChatHead();
}
function appendChat(m) {
  $('chatList').append(chatLine(m));
  while ($('chatList').children.length > CHAT_KEEP) $('chatList').firstElementChild.remove();
  scrollChat();
}
function scrollChat() { const l = $('chatList'); l.scrollTop = l.scrollHeight; }
function renderChatHead() {
  const n = S.audience.names.length;
  $('chatWho').textContent = !inRoom() || S.practice ? '' : n ? T`${n} watching: ${S.audience.names.join(', ')}` : T`Nobody watching`;
}
function renderChatBadge() {
  const b = $('chatBadge');
  b.hidden = !S.chatUnread;
  b.textContent = S.chatUnread > 9 ? '9+' : String(S.chatUnread);
  $('chatBtn').setAttribute('aria-label', S.chatUnread ? T`Chat, ${S.chatUnread} new` : T`Chat`);
}
// renderChatSend counts down the wait before the next comment.
function renderChatSend() {
  const left = S.chatReadyAt - performance.now();
  const btn = $('chatSend');
  btn.disabled = left > 0;
  btn.textContent = left > 0 ? `${Math.ceil(left / 1000)}s` : T`Send`;
  if (left > 0 && !chatTicker) chatTicker = setInterval(renderChatSend, 200);
  if (left <= 0 && chatTicker) { clearInterval(chatTicker); chatTicker = 0; }
}
function chatBubble(m) {
  if (readSetting('pool:bubbles') === 'off') return;
  const box = $('chatBubbles');
  const b = document.createElement('div');
  b.className = 'chat-bubble';
  b.append(...chatLine(m).childNodes);
  box.append(b);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => { b.classList.add('is-leaving'); setTimeout(() => b.remove(), 200); }, 4000);
}
function openChat() {
  if (!inRoom() || S.practice) return;
  closeSpinPop();
  $('chatPanel').hidden = false;
  $('chatBtn').setAttribute('aria-expanded', 'true');
  $('chatBubbles').replaceChildren();
  S.chatUnread = 0;
  renderChatBadge();
  renderChatHead();
  renderChatSend();
  scrollChat();
  $('chatInput').focus({ preventScroll: true });
}
function closeChat() {
  $('chatPanel').hidden = true;
  $('chatBtn').setAttribute('aria-expanded', 'false');
}
const toggleChat = () => ($('chatPanel').hidden ? openChat() : closeChat());
$('chatBtn').onclick = toggleChat;
$('chatClose').onclick = closeChat;
$('chatPanel').addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeChat(); e.stopPropagation(); } });
$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chatInput').value.replace(/\s+/g, ' ').trim();
  if (!text || performance.now() < S.chatReadyAt) return;
  if (!send({ type: 'chat', text })) return;
  $('chatInput').value = '';
  S.chatReadyAt = performance.now() + CHAT_COOLDOWN_MS;
  renderChatSend();
};

// --- spectators: how many may watch ------------------------------------------
// The landing picker sets it for a new room (remembered); the room's picker
// changes it for the room at once.
let landingAudience = Number(readSetting('pool:audience') ?? 3);
if (![0, 1, 3, 5, 10].includes(landingAudience)) landingAudience = 3;
function setAudiencePick(seg, n) {
  for (const b of seg.querySelectorAll('.seg__btn')) b.setAttribute('aria-pressed', String(Number(b.dataset.n) === n));
}
setAudiencePick($('landingAudience'), landingAudience);
landingRulesReady = true;
renderLandingRules();
$('landingAudience').addEventListener('click', (e) => {
  const b = e.target.closest('.seg__btn');
  if (!b) return;
  landingAudience = Number(b.dataset.n);
  writeSetting('pool:audience', String(landingAudience));
  setAudiencePick($('landingAudience'), landingAudience);
  renderLandingRules();
});
// renderAudienceSetting presses the room's spectator pick and says who
// watches on the room's card in Settings.
function renderAudienceSetting() {
  setAudiencePick($('roomAudience'), S.audience.max);
  const max = S.audience.max, n = S.audience.names.length;
  $('roomWatching').textContent = !max ? T`No spectators` : n ? T`${n} of ${max} watching` : T`Up to ${max} may watch`;
}
$('roomAudience').addEventListener('click', (e) => {
  const b = e.target.closest('.seg__btn');
  if (b && Number(b.dataset.n) !== S.audience.max) send({ type: 'set_audience', spectators: Number(b.dataset.n) });
});

// --- the home page: the hall and the tabs --------------------------------------
// The hall (design/README.md, "Home") shows the table of the room to be, as
// picked above, or on an invite the room's own table: the frame in its
// finish, the cloth lit in the middle, the pockets as cut, the game racked.
// It is drawn in CSS from TABLES, LOOKS and CLOTHS, in % of a 2880 x 1610 mm
// frame round the bed; the balls are DOM balls sized in cqw of the bed.
const phoneMedia = matchMedia('(max-width: 600px), (orientation: landscape) and (max-height: 500px)');
const PREVIEW_RACK = { '8ball': [[1], [10, 3], [12, 8, 5], [14, 2, 11, 6], [9, 4, 15, 13, 7]], '9ball': [[1], [6, 3], [4, 9, 7], [2, 5], [8]] };
const STRIPE_TURN = { 9: 18, 10: -34, 11: 50, 12: 4, 13: -40, 14: 30, 15: -12 };
const WOOD = new Set(['diamond', 'acurra', 'carom']); // rails that show a grain
let hallSpec = null;

function railGradient(look) { return `linear-gradient(165deg, ${look.railTop}, ${look.rail} 52%, ${look.railBottom})`; }
// miniBed is a room's cloth in the room list, with its six pockets.
function miniBed(clothId, pockets) {
  const c = clothShades(clothId);
  const bed = `radial-gradient(ellipse at 50% 50%, ${c.center}, ${c.felt} 60%, ${c.edge})`;
  if (!pockets) return bed;
  const hole = (at, r) => `radial-gradient(circle at ${at}, #05070A 0 ${r}px, transparent ${r + 0.6}px)`;
  return [hole('0 0', 2.4), hole('100% 0', 2.4), hole('0 100%', 2.4), hole('100% 100%', 2.4), hole('50% 0', 2), hole('50% 100%', 2), bed].join(', ');
}
function drawTablePreview(el, mode, tableId, clothId) {
  const carom = mode === '3cushion';
  const key = carom ? 'carom' : TABLES[tableId] ? tableId : DEFAULT_TABLE;
  const look = LOOKS[key];
  const cloth = clothShades(clothId);
  const span = (className, css) => {
    const s = document.createElement('span');
    s.className = className;
    if (css) s.style.cssText = css;
    return s;
  };
  const parts = [];
  if (look.led) parts.push(span('tbl__glow'));
  parts.push(span('tbl__body', `background: ${railGradient(look)}`));
  if (WOOD.has(key)) parts.push(span('tbl__grain'));
  if (look.gloss) parts.push(span('tbl__gloss'));
  if (look.trim) parts.push(span('tbl__trim', `border-color: ${look.trim}`));
  const cushion = span('tbl__cushion', `background: ${cloth.cushion}`);
  const bed = span('tbl__bed', `background: radial-gradient(ellipse 72% 78% at 50% 50%, ${cloth.center}, ${cloth.felt} 58%, ${cloth.edge})`);
  // The rack's apex on the foot spot and the cue ball in the kitchen; in
  // 3-cushion the red on the top spot, the yellow on the head spot and the
  // white beside it. A phone draws the balls a little larger than they are.
  const d = 2.25 * (phoneMedia.matches ? 1.25 : 1); // a ball, in % of the bed's width (57 of 2540 mm)
  const ball = (x, y, color, { stripe = false, number = false, turn = 0 } = {}) => {
    const b = span(`ball tbl__ball${stripe ? ' ball--stripe' : ''}`, `left: ${x.toFixed(2)}%; top: ${y.toFixed(2)}%; --size: ${d}cqw; --c: ${color}; --turn: ${turn}deg`);
    if (number) b.append(span('ball__num'));
    return b;
  };
  const balls = [];
  if (carom) balls.push(ball(75, 50, CAROM_COLORS[2]), ball(25, 50, CAROM_COLORS[1]), ball(25, 60.7, CAROM_COLORS[0]));
  else {
    const step = d * 0.866 * 1.03;
    PREVIEW_RACK[mode === '9ball' ? '9ball' : '8ball'].forEach((row, k) => row.forEach((n, j) => {
      balls.push(ball(75 + k * step, 50 + (j - (row.length - 1) / 2) * d * 2 * 1.03, BALL_COLORS[n > 8 ? n - 8 : n], { stripe: n > 8, number: true, turn: STRIPE_TURN[n] || 0 }));
    }));
    balls.push(ball(23, 57, CAROM_COLORS[0]));
  }
  bed.append(...balls);
  cushion.append(bed);
  parts.push(cushion);
  if (!carom) { // the mouths as cut, the corners a little wider for their jaws
    const t = TABLES[key];
    const corner = t.corner * 1.12 / 2.88 * 100, side = t.side * 1.02 / 2.88 * 100;
    const rim = look.rim ? `0 0 0 ${phoneMedia.matches ? 1.5 : 2}px ${look.rim}` : '0 0 0 1px rgba(0, 0, 0, .4)';
    for (const [x, y, w] of [[5.03, 9, corner], [50, 7.2, side], [94.97, 9, corner], [5.03, 91, corner], [50, 92.8, side], [94.97, 91, corner]]) {
      parts.push(span('tbl__pocket', `left: ${x}%; top: ${y}%; width: ${w.toFixed(2)}%; box-shadow: ${rim}`));
    }
  }
  // the sights: three a side between the pockets of each long rail (the
  // carom table has one at the middle too), three on each short rail
  for (let i = 1; i < 8; i++) {
    if (i === 4 && !carom) continue;
    const x = (5.903 + 88.194 * i / 8).toFixed(2);
    parts.push(span('tbl__sight', `left: ${x}%; top: 3.73%; background: ${look.sight}`), span('tbl__sight', `left: ${x}%; top: 96.27%; background: ${look.sight}`));
  }
  for (let j = 1; j < 4; j++) {
    const y = (10.559 + 78.882 * j / 4).toFixed(2);
    parts.push(span('tbl__sight', `left: 2.08%; top: ${y}%; background: ${look.sight}`), span('tbl__sight', `left: 97.92%; top: ${y}%; background: ${look.sight}`));
  }
  el.replaceChildren(...parts);
}
// renderHall writes the hall: which table, what is played on it, the
// table itself. spec is a new room's picks, or an invite's room.
function renderHall(spec = { eyebrow: T`Your table`, mode: landingMode, table: landingTable, cloth: landingCloth, race: landingGoal(), audience: landingAudience }) {
  hallSpec = spec;
  const carom = spec.mode === '3cushion';
  const t = TABLES[spec.table] || TABLES[DEFAULT_TABLE];
  const cloth = CLOTHS[spec.cloth] || CLOTHS[DEFAULT_CLOTH];
  const title = carom ? T`Carom table` : t.name;
  const game = MODE_NAME[spec.mode] || '8-ball';
  $('hallEyebrow').textContent = spec.eyebrow;
  $('hallTitle').textContent = title;
  $('hallCloth').textContent = T`${cloth.name} cloth`;
  $('hallPockets').textContent = carom ? T` · 2.84 × 1.42 m, no pockets` : T` · corners ${inches(t.corner)} · sides ${inches(t.side)}`;
  const sep = Object.assign(document.createElement('span'), { className: 'led__sep' });
  sep.setAttribute('aria-hidden', 'true');
  $('hallLed').replaceChildren(game, sep, carom ? T`to ${spec.race} points` : T`race to ${spec.race}`);
  const specs = carom
    ? [[T`Rules`, 'UMB'], [T`Playing area`, '2.84 × 1.42 m'], [T`Pockets`, T`None`]]
    : [[T`Rules`, 'WPA'], [T`Corner pockets`, inches(t.corner)], [T`Side pockets`, inches(t.side)]];
  specs.push([T`Spectators`, spec.audience ? T`Up to ${spec.audience}` : T`None`]);
  $('hallSpecs').replaceChildren(...specs.map(([k, v]) => {
    const row = Object.assign(document.createElement('div'), { className: 'spec' });
    row.append(Object.assign(document.createElement('dt'), { className: 'spec__k', textContent: k }),
      Object.assign(document.createElement('dd'), { className: 'spec__v', textContent: v }));
    return row;
  }));
  $('hallTable').setAttribute('aria-label', T`${title} with ${cloth.name} cloth, racked for ${game}`);
  drawTablePreview($('hallTable'), spec.mode, spec.table, spec.cloth);
}
// On a phone the home page shows New room or Rooms, one at a time; a
// desktop shows both and jumps to the rooms from the pill in its bar.
function setHomeTab(tab) {
  $('landingForm').dataset.tab = tab;
  $('tabNew').setAttribute('aria-pressed', String(tab === 'new'));
  $('tabRooms').setAttribute('aria-pressed', String(tab === 'rooms'));
}
$('tabNew').onclick = () => setHomeTab('new');
$('tabRooms').onclick = () => setHomeTab('rooms');
$('roomsPill').onclick = () => $('homeSide').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
phoneMedia.addEventListener('change', () => { if (hallSpec) drawTablePreview($('hallTable'), hallSpec.mode, hallSpec.table, hallSpec.cloth); });
hallReady = true;
renderHall();

// --- settings ----------------------------------------------------------------
function readSetting(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writeSetting(key, value) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* unavailable */ } }

// standalone: opened from the home screen, without browser bars.
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// --- the screen: kept awake, full screen -------------------------------------

// keepAwake holds a screen wake lock while the player is in a room, so the
// phone does not dim and sleep (and drop the socket) during the opponent's
// long think. The browser releases it when the tab is hidden; it is taken
// again when the tab shows.
const wake = { want: false, lock: null, pending: false };
function keepAwake(on) {
  wake.want = on;
  if (!navigator.wakeLock) return;
  if (!on) {
    if (wake.lock) wake.lock.release().catch(() => {});
    wake.lock = null;
    return;
  }
  if (wake.lock || wake.pending || document.visibilityState !== 'visible') return;
  wake.pending = true;
  navigator.wakeLock.request('screen').then((lock) => {
    wake.pending = false;
    if (!wake.want) { lock.release().catch(() => {}); return; }
    wake.lock = lock;
    lock.addEventListener('release', () => { if (wake.lock === lock) wake.lock = null; });
  }).catch(() => { wake.pending = false; });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && wake.want) keepAwake(true); });

// Full screen hides the browser's bars where the page may ask for it
// (Android, desktops; not an iPhone, where the home screen does it). On a
// phone it also holds the orientation it was entered in, so tilting the
// phone mid-shot does not turn the table.
const canFullscreen = !standalone && !!document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function';
const isFullscreen = () => !!document.fullscreenElement;
async function toggleFullscreen() {
  if (!canFullscreen) return;
  try {
    if (isFullscreen()) { await document.exitFullscreen(); return; }
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    const o = screen.orientation;
    if (o && o.lock && matchMedia('(pointer: coarse)').matches) {
      o.lock(o.type.startsWith('portrait') ? 'portrait' : 'landscape').catch(() => {});
    }
  } catch { /* refused: no gesture, or not allowed here */ }
}
function renderFullscreen() {
  const on = isFullscreen();
  const b = $('fullBtn');
  b.hidden = !canFullscreen;
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', on ? T`Leave full screen` : T`Full screen`);
  b.title = `${on ? T`Leave full screen` : T`Full screen`} (F)`;
  $('fullToggle').setAttribute('aria-pressed', String(on));
}
document.addEventListener('fullscreenchange', renderFullscreen);
$('fullBtn').onclick = toggleFullscreen;
$('fullToggle').onclick = toggleFullscreen;
renderFullscreen();

// renderRoomSettings fills This room for the room the player is in (not
// practice). Nothing of the match changes there: the game, the table, the
// cloth and the race stay as the room was made on the landing. It only lets
// others in: the room's card as the room list shows it, with the invite
// link, and how many may watch (the players' pick; a spectator only shares).
function renderRoomSettings() {
  const on = inRoom() && !S.practice;
  $('settingsTabs').querySelector('[data-tab="room"]').hidden = !on;
  if (!on) return;
  const carom = isCarom();
  $('roomSettings').querySelector('.mini').style.background = railGradient(carom ? LOOKS.carom : LOOKS[S.table] || LOOKS[DEFAULT_TABLE]);
  $('roomMiniBed').style.background = miniBed(S.cloth, !carom);
  $('inviteCode').textContent = S.roomCode;
  const goal = carom ? T` · to ${S.race}` : S.race > 1 ? T` · race ${S.race}` : '';
  const table = carom ? T` · carom table` : TABLES[S.table] ? ` · ${TABLES[S.table].name}` : '';
  $('roomMeta').textContent = `${MODE_NAME[S.mode]}${isTeams() ? ' · 2v2' : ''}${goal}${table}`;
  $('inviteCopyText').textContent = navigator.share && compactMedia.matches ? T`Share invite link` : T`Copy invite link`;
  $('settingsAudienceRow').hidden = S.seat < 0;
  renderAudienceSetting();
}

function renderSettings() {
  renderRoomSettings();
  for (const b of document.querySelectorAll('#langSeg .seg__btn, #langPick .seg__btn')) b.setAttribute('aria-pressed', String(b.dataset.lang === LANG));
  // Full screen: a switch where the page may ask for it, and on a phone the
  // home screen, which is the only way on an iPhone.
  const touchScreen = matchMedia('(pointer: coarse)').matches;
  $('fullToggle').hidden = !canFullscreen;
  $('installText').hidden = standalone || !touchScreen;
  $('installTip').hidden = $('fullToggle').hidden && $('installText').hidden;
  $('hapticsRow').hidden = !canVibrate || !touchScreen;
  $('hapticsToggle').setAttribute('aria-pressed', String(S.haptics));
  const theme = readSetting('pool:theme') || 'system';
  for (const b of $('themeSeg').querySelectorAll('.seg__btn')) b.setAttribute('aria-pressed', String(b.dataset.theme === theme));
  $('leftyToggle').setAttribute('aria-pressed', String(S.lefty));
  $('aimFrontToggle').setAttribute('aria-pressed', String(S.aimFront));
  $('pointerToggle').setAttribute('aria-pressed', String(S.nextBall));
  $('soundToggle').setAttribute('aria-pressed', String(SND.on));
  $('bubblesToggle').setAttribute('aria-pressed', String(readSetting('pool:bubbles') !== 'off'));
  renderViewControls();
  for (const b of $('qualitySeg').querySelectorAll('.seg__btn')) b.setAttribute('aria-pressed', String(b.dataset.quality === S.quality));
  $('qualityNote').textContent = tr(QUALITY_NOTES[S.quality]);
  $('voiceToggle').setAttribute('aria-pressed', String(SND.voice));
  $('strongToggle').setAttribute('aria-pressed', String(SND.strong));
  $('strongToggle').disabled = !SND.voice;
  $('volume').value = String(Math.round(SND.volume * 100));
  $('volume').disabled = !SND.on;
}
// Settings opens from the scoreboard in a room and from the landing page, as a
// sheet (design/README.md, "Settings"). In a room the hall gives way to it:
// the table shrinks and stays in view, out of reach until Done, and the dock
// and the power bar step aside. Over the landing it lies on a scrim. It
// opens on the tab picked last (else the first there is), at its top, with
// Done focused, and gives the focus back to the button that opened it.
let settingsOpener = null;
let settingsTab = null;
const settingsTabsOn = () => [...$('settingsTabs').querySelectorAll('.seg__btn')].filter((b) => !b.hidden).map((b) => b.dataset.tab);
function showSettingsTab(tab) {
  const on = settingsTabsOn();
  if (!on.includes(tab)) tab = on[0];
  for (const b of $('settingsTabs').querySelectorAll('.seg__btn')) b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
  for (const g of $('settingsBody').querySelectorAll('.settings__group')) g.hidden = g.dataset.tab !== tab;
  $('settingsBody').scrollTop = 0;
  return tab;
}
$('settingsTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.seg__btn');
  if (b) settingsTab = showSettingsTab(b.dataset.tab);
});
function openSettings(e) {
  renderSettings();
  settingsOpener = e && e.currentTarget;
  showSettingsTab(settingsTab);
  $('settings').hidden = false;
  $('settingsBody').scrollTop = 0;
  document.body.classList.add('is-settings');
  if (!document.body.classList.contains('is-landing')) document.querySelector('main.game').inert = true;
  $('settingsBtn').setAttribute('aria-expanded', 'true');
  $('settingsClose').focus({ preventScroll: true });
}
function closeSettings() {
  if ($('settings').hidden) return;
  $('settings').hidden = true;
  document.body.classList.remove('is-settings');
  if (!document.body.classList.contains('is-landing')) document.querySelector('main.game').inert = false;
  $('settingsBtn').setAttribute('aria-expanded', 'false');
  if (settingsOpener && settingsOpener.offsetParent) settingsOpener.focus({ preventScroll: true });
  settingsOpener = null;
}
$('settingsBtn').onclick = (e) => { if ($('settings').hidden) openSettings(e); else closeSettings(); };
$('landingSettings').onclick = openSettings;
$('settingsClose').onclick = closeSettings;
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) closeSettings(); });
$('settings').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });
// setLang shows the page in lang at once: its own words, then everything
// the code wrote, drawn again (CLIENT.md, "Languages"). The status band
// keeps what it said until the next event.
function setLang(lang) {
  if (lang !== 'en' && lang !== 'vi') return;
  LANG = lang;
  writeSetting('pool:lang', lang);
  document.documentElement.lang = lang;
  applyStatic();
  fillTablePick($('landingTable'));
  renderLandingTable();
  renderLandingMatch();
  renderLandingRules();
  if (!$('landing').hidden) {
    if ($('landingForm').classList.contains('landing--invited')) describeInvite($('landingCode').textContent);
    else if (hallReady) renderHall();
    refreshRooms();
  }
  renderViewControls();
  renderFullscreen();
  renderSpin();
  setElev(S.elev);
  renderChatHead();
  renderChatBadge();
  renderChatSend();
  if (inRoom()) refreshPanels();
  renderSettings();
}
for (const id of ['langSeg', 'langPick']) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('.seg__btn');
    if (b) setLang(b.dataset.lang);
  });
}
renderSettings();

$('themeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('.seg__btn');
  if (!b) return;
  const t = b.dataset.theme;
  writeSetting('pool:theme', t === 'system' ? null : t);
  applyTheme(t);
  renderSettings();
});
$('pointerToggle').onclick = () => {
  S.nextBall = !S.nextBall;
  writeSetting('pool:pointer', S.nextBall ? null : 'off');
  wakeDraw();
  renderSettings();
};
$('aimFrontToggle').onclick = () => {
  S.aimFront = !S.aimFront;
  writeSetting('pool:aim', S.aimFront ? 'front' : null);
  renderSettings();
};
$('viewSeg').addEventListener('click', (e) => {
  const b = e.target.closest('.seg__btn');
  if (b) setView(b.dataset.view, true);
});
$('qualitySeg').addEventListener('click', (e) => {
  const b = e.target.closest('.seg__btn');
  if (b && b.dataset.quality !== S.quality) setQuality(b.dataset.quality);
});
$('viewBtn').onclick = () => setView(S.view === '3d' ? '2d' : '3d', true);
$('camTopBtn').onclick = toggleCamTop;
$('replayBtn').onclick = startReplay;
$('bubblesToggle').onclick = () => {
  writeSetting('pool:bubbles', readSetting('pool:bubbles') === 'off' ? null : 'off');
  if (readSetting('pool:bubbles') === 'off') $('chatBubbles').replaceChildren();
  renderSettings();
};
$('leftyToggle').onclick = () => {
  applyLefty(!S.lefty);
  writeSetting('pool:lefty', S.lefty ? '1' : null);
  renderSettings();
};
$('soundToggle').onclick = () => { setSound(!SND.on); renderSettings(); };
$('hapticsToggle').onclick = () => {
  S.haptics = !S.haptics;
  writeSetting('pool:haptics', S.haptics ? null : 'off');
  if (S.haptics && canVibrate) try { navigator.vibrate(15); } catch { /* not allowed */ }
  renderSettings();
};
$('voiceToggle').onclick = () => {
  SND.voice = !SND.voice;
  writeSetting('pool:voice', SND.voice ? null : 'off');
  renderSettings();
};
$('strongToggle').onclick = () => {
  SND.strong = !SND.strong;
  writeSetting('pool:voice:strong', SND.strong ? null : 'off');
  renderSettings();
};
$('volume').addEventListener('input', () => setVolume(Number($('volume').value) / 100));
$('volume').addEventListener('change', () => { const ctx = audio(); if (ctx) { clack(ctx, ctx.currentTime, 2.5); } });
$('hintsReset').onclick = () => {
  writeSetting('pool:hint', null);
  writeSetting('pool:hint:hand', null);
  $('powerHint').hidden = false;
  toast(T`Hints will show again`);
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
  setView(initialView(), false);
  resize();
  refreshPanels();
  if (document.fonts && document.fonts.load) {
    document.fonts.load('600 13px "Source Sans 3"').then(() => renderTableCache()).catch(() => {});
  }
  requestAnimationFrame(draw);
  // A reloaded tab goes straight back to its seat.
  const saved = room ? loadSession(room) : null;
  if (saved && saved.watch) {
    hideLanding();
    showSplash(room);
    S.spectator = true; // a failed watch is handled as a lost connection
    connectAndJoin(room, saved.name || 'Guest', null, true);
  } else if (saved && saved.token) {
    hideLanding();
    showSplash(room);
    S.seat = 0; // pretend we are seated so a failed join is handled as a lost connection
    S.token = saved.token;
    connectAndJoin(room, saved.name || 'Player', saved.token);
  } else {
    showLanding();
  }
})();
