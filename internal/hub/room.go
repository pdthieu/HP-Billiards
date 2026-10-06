package hub

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	"billiards/internal/game"
	"billiards/internal/protocol"
	"billiards/internal/ws"
)

const (
	tickRate      = 60 // server ticks per second while balls move
	snapshotEvery = 3  // ticks between snapshots: 20 Hz
	maxNameLength = 20 // runes
)

type eventKind int

const (
	evJoin eventKind = iota
	evMessage
	evLeave
	evHoldExpired // the reconnect grace of a held seat ran out
	evAbandon     // both players have been gone for the abandon timeout
	evClock       // the shot clock ran out
)

// event is one input to a room's goroutine.
type event struct {
	kind   eventKind
	client *ws.Client
	msg    protocol.ClientMessage
	joined chan bool // evJoin: whether the client got a seat
	seat   int       // evHoldExpired
	gen    int       // evHoldExpired, evAbandon: see room.timerGen; evClock: clock.gen
}

// seat is one of the two places at the table. Empty: name == "". Held for a
// reconnect: name != "" and client == nil. Occupied: client != nil.
type seat struct {
	client *ws.Client
	id     string
	token  string
	name   string
	ready  bool
}

func (s *seat) empty() bool { return s.name == "" }

// clock is the shot clock of the player who must act next. It runs only
// while that player is connected.
type clock struct {
	on       bool
	seat     int
	limit    time.Duration // what it was last set to
	left     time.Duration // while paused
	deadline time.Time     // while running; zero while paused
	// gen is bumped on every change; an evClock carrying an older one is
	// stale and ignored.
	gen int
}

// errNoExtension rejects a second extend in one game; errBadMode an unknown
// mode.
var (
	errNoExtension = errors.New("you have already used your extension this game")
	errBadMode     = errors.New("unknown game mode")
)

// room is one table and its two seats. Everything below inbox is owned by the
// run goroutine and must not be touched from anywhere else.
type room struct {
	hub   *Hub
	code  string
	inbox chan event
	done  chan struct{} // closed when run exits
	// info is the summary shown in the room list. The run goroutine
	// republishes it after every event; anyone may Load it.
	info atomic.Pointer[RoomInfo]

	mode        game.Mode // the game played; can change between games
	game        *game.Game
	seats       [2]seat
	ticker      *time.Ticker // non-nil only while a shot is in progress
	ticks       int          // since the shot started
	lastSnapT   int          // simulated ms of the last snapshot sent
	lastBreaker int
	clock       clock
	extended    [2]bool // by seat: the extension of this game is used
	breakShot   bool    // the shot in progress is the break
	// timerGen is bumped whenever the away-timers are re-armed; a timer
	// event carrying an older generation is stale and ignored.
	timerGen int
}

func newRoom(h *Hub, code string, mode game.Mode) *room {
	r := &room{
		hub:   h,
		code:  code,
		inbox: make(chan event, 16),
		done:  make(chan struct{}),
		mode:  mode,
	}
	r.resetGame()
	r.publishInfo()
	return r
}

// resetGame puts a fresh game of the room's mode in the lobby.
func (r *room) resetGame() {
	r.game = game.NewGame(r.hub.opts.Game)
	r.game.SetMode(r.mode)
}

// publishInfo refreshes the room-list summary.
func (r *room) publishInfo() {
	info := &RoomInfo{RoomCode: r.code, Mode: r.mode, Phase: r.game.Rules.Phase}
	for i := range r.seats {
		info.Players[i] = r.seats[i].name
		if !r.seats[i].empty() {
			info.Seated++
		}
	}
	r.info.Store(info)
}

// post hands an event to the room. It reports false if the room is gone.
func (r *room) post(ev event) bool {
	select {
	case r.inbox <- ev:
		return true
	case <-r.done:
		return false
	}
}

// join asks the room for a seat and waits for the answer. On failure the
// room (or this function, if the room is gone) has told the client why.
func (r *room) join(c *ws.Client, msg protocol.ClientMessage) bool {
	ev := event{kind: evJoin, client: c, msg: msg, joined: make(chan bool, 1)}
	if r.post(ev) {
		select {
		case ok := <-ev.joined:
			return ok
		case <-r.done:
		}
	}
	c.SendJSON(protocol.NewError(protocol.ErrRoomNotFound, "no such room"))
	return false
}

// run is the room's actor loop. It ticks only while balls are moving and
// otherwise sleeps until an event arrives or the room has been empty for the
// idle timeout.
func (r *room) run() {
	defer close(r.done)
	timeout := r.hub.opts.IdleTimeout
	idle := time.NewTimer(timeout)
	defer idle.Stop()
	defer r.stopTicker()
	emptySince := time.Now()

	for {
		var tick <-chan time.Time
		if r.ticker != nil {
			tick = r.ticker.C
		}
		select {
		case ev := <-r.inbox:
			wasEmpty := r.connected() == 0
			r.handle(ev)
			r.publishInfo()
			if empty := r.connected() == 0; empty && !wasEmpty {
				emptySince = time.Now()
				idle.Reset(timeout)
			}
		case <-tick:
			r.tick()
		case <-idle.C:
			if r.connected() > 0 {
				continue
			}
			// The timer may have been armed for an earlier empty spell.
			if left := timeout - time.Since(emptySince); left > 0 {
				idle.Reset(left)
				continue
			}
			// Unregister first so no new join can find the room, then let
			// done (deferred) release anyone already waiting on it.
			r.hub.remove(r)
			return
		}
	}
}

func (r *room) connected() int {
	n := 0
	for i := range r.seats {
		if r.seats[i].client != nil {
			n++
		}
	}
	return n
}

func (r *room) seatOf(c *ws.Client) int {
	for i := range r.seats {
		if r.seats[i].client == c {
			return i
		}
	}
	return -1
}

func (r *room) handle(ev event) {
	switch ev.kind {
	case evJoin:
		ev.joined <- r.handleJoin(ev.client, ev.msg)
	case evLeave:
		r.handleLeave(ev.client)
	case evHoldExpired:
		r.handleHoldExpired(ev.seat, ev.gen)
	case evAbandon:
		r.handleAbandon(ev.gen)
	case evClock:
		r.handleClockExpired(ev.gen)
	case evMessage:
		if s := r.seatOf(ev.client); s >= 0 {
			r.handleMessage(s, ev.msg)
		}
	}
}

func (r *room) handleJoin(c *ws.Client, msg protocol.ClientMessage) bool {
	// A token that matches a seat reclaims it, whether the seat is held for
	// a reconnect or its old socket is still (nominally) open: a phone that
	// changed networks reconnects long before the dead socket is noticed.
	if s := r.seatByToken(msg.Token); s >= 0 {
		if old := r.seats[s].client; old != nil {
			old.Close(websocket.StatusPolicyViolation, "replaced by a new connection")
		}
		r.seats[s].client = c
		resumed := r.syncClock()
		r.welcome(c, s)
		if resumed {
			r.sendTo(1-s, r.clockUpdate())
		}
		if r.game.Rules.Phase != game.PhaseLobby {
			r.rearmAwayTimers()
		}
		return true
	}

	s := -1
	for i := range r.seats {
		if r.seats[i].empty() {
			s = i
			break
		}
	}
	if s < 0 {
		c.SendJSON(protocol.NewError(protocol.ErrRoomFull, "the room is full"))
		return false
	}
	r.seats[s] = seat{
		client: c,
		id:     randomHex(8),
		token:  randomHex(16), // 128 bits
		name:   cleanName(msg.Name, s),
	}
	r.welcome(c, s)
	return true
}

// seatByToken returns the seat whose token is tok, or -1.
func (r *room) seatByToken(tok string) int {
	if tok == "" {
		return -1
	}
	for i := range r.seats {
		st := &r.seats[i]
		if !st.empty() && subtle.ConstantTimeCompare([]byte(st.token), []byte(tok)) == 1 {
			return i
		}
	}
	return -1
}

// welcome tells c about its seat and the room, and the other player about c.
func (r *room) welcome(c *ws.Client, s int) {
	c.SendJSON(protocol.Welcome{
		Type:     protocol.TypeWelcome,
		V:        protocol.Version,
		PlayerID: r.seats[s].id,
		Seat:     s,
		Token:    r.seats[s].token,
		RoomCode: r.code,
	})
	c.SendJSON(r.roomState())
	r.sendTo(1-s, protocol.Player{Type: protocol.TypePlayer, PlayerInfo: r.playerInfo(s)})
}

// handleLeave runs when a socket closes. In the lobby the seat is freed at
// once; during a game it is held so the player can come back with their
// token (see rearmAwayTimers for how long).
func (r *room) handleLeave(c *ws.Client) {
	s := r.seatOf(c)
	if s < 0 {
		return // not seated, or already replaced by a reconnect
	}
	if r.game.Rules.Phase == game.PhaseLobby {
		r.vacate(s)
		return
	}
	r.seats[s].client = nil
	r.sendTo(1-s, protocol.Player{Type: protocol.TypePlayer, PlayerInfo: r.playerInfo(s)})
	if r.syncClock() {
		r.sendTo(1-s, r.clockUpdate())
	}
	r.rearmAwayTimers()
}

// rearmAwayTimers restarts the timers that end a game whose players are
// away, from who is connected right now. It runs after every connectivity
// change during a game.
//
//   - One player connected: the other's seat is held for ReconnectGrace;
//     someone is waiting, so the absence is short.
//   - Nobody connected: nobody is waiting; the game survives AbandonTimeout
//     and is then cancelled with both seats freed.
//   - Both connected: nothing pending.
//
// Earlier timers are not stopped; they become stale through timerGen.
func (r *room) rearmAwayTimers() {
	r.timerGen++
	gen := r.timerGen
	switch r.connected() {
	case 1:
		for i := range r.seats {
			if st := &r.seats[i]; st.client == nil && !st.empty() {
				r.after(r.hub.opts.ReconnectGrace, event{kind: evHoldExpired, seat: i, gen: gen})
			}
		}
	case 0:
		r.after(r.hub.opts.AbandonTimeout, event{kind: evAbandon, gen: gen})
	}
}

// after posts ev to the room once d has passed.
func (r *room) after(d time.Duration, ev event) {
	time.AfterFunc(d, func() { r.post(ev) })
}

func (r *room) handleHoldExpired(s, gen int) {
	st := &r.seats[s]
	if gen != r.timerGen || st.client != nil || st.empty() {
		return // re-armed since, reconnected, or already vacated
	}
	r.vacate(s)
}

// handleAbandon cancels a game both players walked away from.
func (r *room) handleAbandon(gen int) {
	if gen != r.timerGen || r.game.Rules.Phase == game.PhaseLobby || r.connected() > 0 {
		return
	}
	for i := range r.seats {
		r.seats[i] = seat{}
	}
	r.stopTicker()
	r.stopClock()
	r.resetGame()
}

// vacate empties a seat and, if a game was on, abandons it.
func (r *room) vacate(s int) {
	r.seats[s] = seat{}
	r.sendTo(1-s, protocol.Player{Type: protocol.TypePlayer, PlayerInfo: r.playerInfo(s)})

	// A game cannot go on with an empty seat: back to the lobby.
	if r.game.Rules.Phase != game.PhaseLobby {
		r.stopTicker()
		r.stopClock()
		r.resetGame()
		r.seats[1-s].ready = false
		r.broadcast(r.roomState())
	}
}

func (r *room) handleMessage(s int, msg protocol.ClientMessage) {
	var err error
	switch msg.Type {
	case protocol.TypeReady:
		err = r.handleReady(s)
	case protocol.TypeAim:
		r.handleAim(s, msg)
	case protocol.TypeShoot:
		err = r.handleShoot(s, msg)
	case protocol.TypePlaceCue:
		if err = r.game.PlaceCue(s, game.Vec{X: msg.X, Y: msg.Y}); err == nil {
			r.broadcast(r.roomState())
		}
	case protocol.TypeChoose:
		if err = r.choose(s, msg.Option); err == nil {
			r.broadcast(r.roomState())
		}
	case protocol.TypeRematch:
		err = r.handleRematch()
	case protocol.TypeExtend:
		err = r.handleExtend(s)
	case protocol.TypeSetMode:
		err = r.handleSetMode(msg.Mode)
	case protocol.TypeJoin:
		r.sendError(s, protocol.ErrBadMessage, "already joined")
	default:
		r.sendError(s, protocol.ErrBadMessage, fmt.Sprintf("unknown message type %q", msg.Type))
	}
	if err != nil {
		r.sendError(s, errorCode(err), err.Error())
	}
}

func (r *room) handleReady(s int) error {
	if r.game.Rules.Phase != game.PhaseLobby {
		return game.ErrWrongPhase
	}
	if r.seats[s].ready {
		return nil
	}
	r.seats[s].ready = true
	r.broadcast(protocol.Player{Type: protocol.TypePlayer, PlayerInfo: r.playerInfo(s)})

	other := &r.seats[1-s]
	if other.client != nil && other.ready {
		r.startRack(r.hub.opts.Breaker() & 1)
	}
	return nil
}

func (r *room) handleRematch() error {
	if r.game.Rules.Phase != game.PhaseGameOver {
		return game.ErrWrongPhase
	}
	r.startRack(1 - r.lastBreaker) // breaks alternate
	return nil
}

// handleSetMode changes the game played, between games only. In the lobby
// both players must be ready again for the new game.
func (r *room) handleSetMode(mode game.Mode) error {
	ph := r.game.Rules.Phase
	switch {
	case !mode.Valid():
		return errBadMode
	case ph != game.PhaseLobby && ph != game.PhaseGameOver:
		return game.ErrWrongPhase
	case mode == r.mode:
		return nil
	}
	r.mode = mode
	r.game.SetMode(mode)
	if ph == game.PhaseLobby {
		for i := range r.seats {
			r.seats[i].ready = false
		}
	}
	r.broadcast(r.roomState())
	return nil
}

func (r *room) startRack(breaker int) {
	r.game.Start(breaker)
	r.noteRack()
	r.extended = [2]bool{}
	r.startClock(r.hub.opts.ShotClock)
	r.broadcast(r.roomState())
}

// noteRack records who breaks whenever the game is at the start of a rack,
// including re-racks chosen after an illegal break.
func (r *room) noteRack() {
	if r.game.Rules.Phase == game.PhaseBreaking && r.game.Rules.Decision == nil {
		r.lastBreaker = r.game.Rules.Turn
	}
}

// handleAim relays the shooter's aim preview unchanged to the other player.
// Aim from anyone else is dropped silently: it is only cosmetic.
func (r *room) handleAim(s int, msg protocol.ClientMessage) {
	if !r.game.Rules.InPlay() || r.game.Moving() || r.game.Rules.Turn != s {
		return
	}
	if math.IsNaN(msg.Angle) || math.IsInf(msg.Angle, 0) || math.IsNaN(msg.Power) {
		return
	}
	r.sendDroppableTo(1-s, protocol.Aim{
		Type:  protocol.TypeAim,
		Seat:  s,
		Angle: msg.Angle,
		Power: math.Max(0, math.Min(1, msg.Power)),
	})
}

func (r *room) handleShoot(s int, msg protocol.ClientMessage) error {
	breaking := r.game.Rules.Phase == game.PhaseBreaking
	if err := r.game.ShootSpin(s, msg.Angle, msg.Power, msg.Call.Game(), msg.Spin.Vec()); err != nil {
		return err
	}
	r.breakShot = breaking
	r.stopClock()
	r.ticks = 0
	r.lastSnapT = -1
	r.ticker = time.NewTicker(time.Second / tickRate)
	r.broadcastDroppable(r.snapshot())
	return nil
}

// tick advances the shot in progress by one server tick.
func (r *room) tick() {
	res := r.game.Tick()
	r.ticks++
	if res == nil {
		// A bounce inside this tick gets its own snapshot, so the client
		// does not cut the corner; then the regular cadence.
		if t, balls, ok := r.game.Collision(); ok {
			ms := int(math.Round(float64(r.ticks-1)*1000/tickRate + t*1000))
			if ms > r.lastSnapT {
				r.broadcastDroppable(r.snapshotOf(balls, ms))
			}
		}
		if r.ticks%snapshotEvery == 0 {
			r.broadcastDroppable(r.snapshot())
		}
		return
	}
	r.stopTicker()
	r.publishInfo()
	limit := r.hub.opts.ShotClock
	if r.breakShot && r.game.Rules.Phase == game.PhaseOpen {
		limit = r.hub.opts.LongShotClock // the first shot after the break
	}
	r.startClock(limit)

	st := r.game.State()
	pocketed := res.Pocketed
	if pocketed == nil {
		pocketed = []int{}
	}
	r.broadcast(protocol.Settled{
		Type:         protocol.TypeSettled,
		Balls:        st.Balls,
		Shooter:      res.Shooter,
		Pocketed:     pocketed,
		Foul:         res.Foul,
		Made:         res.Made,
		IllegalBreak: res.IllegalBreak,
		PushedOut:    res.PushOut,
		Phase:        st.Phase,
		Turn:         st.Turn,
		Groups:       st.Groups,
		BallInHand:   st.BallInHand,
		Kitchen:      st.Kitchen,
		Decision:     st.Decision,
		Winner:       winner(st.Winner),
		Clock:        r.clockInfo(),
		Fouls:        st.Fouls,
		PushOut:      st.PushOut,
	})
}

// handleExtend spends seat s's extension: their running clock is set back to
// the long limit.
func (r *room) handleExtend(s int) error {
	switch {
	case !r.clock.on:
		return game.ErrWrongPhase
	case r.clock.seat != s:
		return game.ErrNotYourTurn
	case r.extended[s]:
		return errNoExtension
	}
	r.extended[s] = true
	r.startClock(r.hub.opts.LongShotClock)
	r.broadcast(r.clockUpdate())
	return nil
}

// actor is the seat that must act next: the one deciding, or the shooter.
func (r *room) actor() int {
	if d := r.game.Rules.Decision; d != nil {
		return d.Seat
	}
	return r.game.Rules.Turn
}

// startClock sets the shot clock to d for whoever must act now, or stops it
// when nobody has to (lobby, game over, balls moving, clock turned off).
func (r *room) startClock(d time.Duration) {
	rules := r.game.Rules
	if r.hub.opts.ShotClock < 0 || r.game.Moving() || !(rules.InPlay() || rules.Decision != nil) {
		r.stopClock()
		return
	}
	r.clock = clock{on: true, seat: r.actor(), limit: d, left: d, gen: r.clock.gen + 1}
	r.syncClock()
}

func (r *room) stopClock() {
	r.clock.on = false
	r.clock.gen++
}

// choose applies seat s's answer to the pending decision and starts the
// clock for the shot it leads to: the long one for the first shot after an
// 8-ball break, the normal one for a new break or a shot after a 9-ball
// push out.
func (r *room) choose(s int, opt game.Option) error {
	d := r.game.Rules.Decision
	afterPush := d != nil && slices.Contains(d.Options, game.OptTakeShot)
	if err := r.game.Choose(s, opt); err != nil {
		return err
	}
	r.noteRack()
	limit := r.hub.opts.LongShotClock
	if afterPush || r.game.Rules.Phase == game.PhaseBreaking {
		limit = r.hub.opts.ShotClock
	}
	r.startClock(limit)
	return nil
}

// syncClock runs the clock while the player it counts for is connected and
// pauses it while they are away, so nobody loses a turn to a dropped
// connection. It reports whether that changed anything.
func (r *room) syncClock() bool {
	c := &r.clock
	if !c.on {
		return false
	}
	running := !c.deadline.IsZero()
	online := r.seats[c.seat].client != nil
	switch {
	case online && !running:
		c.gen++
		c.deadline = time.Now().Add(c.left)
		r.after(c.left, event{kind: evClock, gen: c.gen})
	case !online && running:
		c.gen++
		c.left = max(0, time.Until(c.deadline))
		c.deadline = time.Time{}
	default:
		return false
	}
	return true
}

// handleClockExpired applies the penalty for running out of time: a shooter
// commits a foul, a decision takes its first option (play on from the
// table as it lies). The next player's clock starts.
func (r *room) handleClockExpired(gen int) {
	c := &r.clock
	if !c.on || gen != c.gen {
		return
	}
	s := c.seat
	out := protocol.Timeout{Type: protocol.TypeTimeout, Seat: s}
	if d := r.game.Rules.Decision; d != nil {
		out.Option = d.Options[0]
		if r.choose(s, out.Option) != nil {
			return
		}
	} else {
		if r.game.TimeFoul(s) != nil {
			return
		}
		r.startClock(r.hub.opts.ShotClock)
	}
	r.noteRack() // a time foul on the break hands the break over (a no-op after choose)
	r.broadcast(out)
	r.broadcast(r.roomState())
}

// clockInfo is the clock as sent to the clients, or nil when it is off.
func (r *room) clockInfo() *protocol.Clock {
	c := &r.clock
	if !c.on {
		return nil
	}
	left := c.left
	if !c.deadline.IsZero() {
		left = max(0, time.Until(c.deadline))
	}
	return &protocol.Clock{
		Seat:       c.seat,
		Left:       int(left / time.Millisecond),
		Limit:      int(c.limit / time.Millisecond),
		Paused:     c.deadline.IsZero(),
		Extension:  int(r.hub.opts.LongShotClock / time.Millisecond),
		Extensions: [2]bool{!r.extended[0], !r.extended[1]},
	}
}

// clockUpdate is the clock message; only call it while the clock is on.
func (r *room) clockUpdate() protocol.ClockUpdate {
	return protocol.ClockUpdate{Type: protocol.TypeClock, Clock: *r.clockInfo()}
}

func (r *room) stopTicker() {
	if r.ticker != nil {
		r.ticker.Stop()
		r.ticker = nil
	}
}

func (r *room) snapshot() protocol.Snapshot {
	return r.snapshotOf(r.game.Table.Snapshot(), r.ticks*1000/tickRate)
}

// snapshotOf wraps balls (modified in place) as the snapshot for simulated
// time ms.
func (r *room) snapshotOf(balls []game.BallState, ms int) protocol.Snapshot {
	for i := range balls {
		balls[i].X = round4(balls[i].X)
		balls[i].Y = round4(balls[i].Y)
	}
	r.lastSnapT = ms
	return protocol.Snapshot{Type: protocol.TypeSnapshot, T: ms, Balls: balls}
}

func (r *room) roomState() protocol.RoomState {
	st := r.game.State()
	return protocol.RoomState{
		Type:       protocol.TypeRoomState,
		Mode:       st.Mode,
		Balls:      st.Balls,
		Players:    [2]protocol.PlayerInfo{r.playerInfo(0), r.playerInfo(1)},
		Phase:      st.Phase,
		Turn:       st.Turn,
		Groups:     st.Groups,
		BallInHand: st.BallInHand,
		Kitchen:    st.Kitchen,
		Decision:   st.Decision,
		Winner:     winner(st.Winner),
		Moving:     r.game.Moving(),
		Clock:      r.clockInfo(),
		Fouls:      st.Fouls,
		PushOut:    st.PushOut,
	}
}

func (r *room) playerInfo(s int) protocol.PlayerInfo {
	st := &r.seats[s]
	return protocol.PlayerInfo{Seat: s, Name: st.name, Connected: st.client != nil, Ready: st.ready}
}

// broadcast encodes msg once and queues it for every connected player.
func (r *room) broadcast(msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	for i := range r.seats {
		if c := r.seats[i].client; c != nil {
			c.Send(data)
		}
	}
}

// broadcastDroppable is broadcast for messages a slow client may miss
// (snapshots): the next one supersedes them.
func (r *room) broadcastDroppable(msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	for i := range r.seats {
		if c := r.seats[i].client; c != nil {
			c.SendDroppable(data)
		}
	}
}

func (r *room) sendTo(s int, msg any) {
	if c := r.seats[s].client; c != nil {
		c.SendJSON(msg)
	}
}

func (r *room) sendDroppableTo(s int, msg any) {
	c := r.seats[s].client
	if c == nil {
		return
	}
	if data, err := json.Marshal(msg); err == nil {
		c.SendDroppable(data)
	}
}

func (r *room) sendError(s int, code, message string) {
	r.sendTo(s, protocol.NewError(code, message))
}

func winner(seat int) *int {
	if seat == game.NoWinner {
		return nil
	}
	return &seat
}

// round4 keeps 0.1 mm. Whole millimetres were visibly coarse: a ball
// creeping at 5 cm/s moves 2.5 mm between snapshots, so rounding each end
// made the interpolated speed jump by up to 40 % from one snapshot to the
// next.
func round4(v float64) float64 { return math.Round(v*10000) / 10000 }

// cleanName trims a player-supplied name to something safe to display.
func cleanName(name string, s int) string {
	name = strings.Join(strings.Fields(name), " ")
	if utf8.RuneCountInString(name) > maxNameLength {
		name = string([]rune(name)[:maxNameLength])
	}
	if name == "" || !utf8.ValidString(name) {
		return fmt.Sprintf("Player %d", s+1)
	}
	return name
}

func errorCode(err error) string {
	switch {
	case errors.Is(err, game.ErrWrongPhase):
		return protocol.ErrWrongPhase
	case errors.Is(err, game.ErrBallsMoving):
		return protocol.ErrBallsMoving
	case errors.Is(err, game.ErrNotYourTurn):
		return protocol.ErrNotYourTurn
	case errors.Is(err, game.ErrNoBallInHand):
		return protocol.ErrNoBallInHand
	case errors.Is(err, game.ErrBadPlacement):
		return protocol.ErrBadPlacement
	case errors.Is(err, game.ErrBadInput):
		return protocol.ErrBadInput
	case errors.Is(err, game.ErrBadCall):
		return protocol.ErrBadCall
	case errors.Is(err, game.ErrNoDecision):
		return protocol.ErrNoDecision
	case errors.Is(err, game.ErrBadOption):
		return protocol.ErrBadOption
	case errors.Is(err, errNoExtension):
		return protocol.ErrNoExtension
	case errors.Is(err, errBadMode):
		return protocol.ErrBadMode
	case errors.Is(err, game.ErrNoPushOut):
		return protocol.ErrBadCall
	}
	return protocol.ErrBadMessage
}
