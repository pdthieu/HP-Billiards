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
	tickRate      = 60  // server ticks per second while balls move
	snapshotEvery = 3   // ticks between snapshots: 20 Hz
	maxNameLength = 20  // runes
	maxChatLength = 200 // runes
	chatLogSize   = 30  // comments kept for whoever joins later
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
	// lastChat is when the player last commented (ChatCooldown).
	lastChat time.Time
}

func (s *seat) empty() bool { return s.name == "" }

// watcher is a spectator: a socket that sees everything the players see and
// may comment, without a seat. It does not survive its socket.
type watcher struct {
	client   *ws.Client
	name     string
	lastChat time.Time
}

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
	errNoExtension   = errors.New("you have already used your extension this game")
	errBadMode       = errors.New("unknown game mode")
	errNoUndo        = errors.New("there is no shot to take back")
	errNotPractice   = errors.New("only in a practice room")
	errBadRace       = errors.New("the race must be 1 to 25 (3-cushion: 1 to 50 points) and the breaks alternate or winner")
	errBadSpectators = errors.New("that many spectators are not allowed here")
	errBadTable      = errors.New("unknown table or cloth")
)

// maxUndo is how many shots a practice room can take back.
const maxUndo = 20

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

	mode game.Mode // the game played; can change between matches
	// table is the pool table and cloth its colour; both can change
	// between matches (set_table).
	table game.TableID
	cloth string
	// race and breaks are the settings of the next match; match is the
	// current one, or the last one until a new player sits down.
	race   int
	breaks game.BreakRule
	match  game.Match
	// practice: one player plays both seats, seat 0 holds the socket and
	// history the positions before the last shots, for undo.
	practice    bool
	history     []game.Snapshot
	game        *game.Game
	seats       [2]seat
	ticker      *time.Ticker // non-nil only while a shot is in progress
	ticks       int          // since the shot started
	lastSnapT   int          // simulated ms of the last snapshot sent
	impactsSent int          // Table.Impacts already sent this shot
	lastBreaker int
	clock       clock
	extended    [2]bool // by seat: the extension of this game is used
	breakShot   bool    // the shot in progress is the break
	// timerGen is bumped whenever the away-timers are re-armed; a timer
	// event carrying an older generation is stale and ignored.
	timerGen int
	// watchers are the spectators, in the order they came; at most
	// maxSpectators may join (set_audience). chatLog holds the last
	// comments.
	watchers      []*watcher
	maxSpectators int
	chatLog       []protocol.Chat
}

func newRoom(h *Hub, code string, settings RoomSettings) *room {
	r := &room{
		hub:      h,
		code:     code,
		inbox:    make(chan event, 16),
		done:     make(chan struct{}),
		mode:     settings.Mode,
		table:    settings.Table,
		cloth:    settings.Cloth,
		race:     settings.Race,
		breaks:   settings.Breaks,
		match:    game.NewMatch(settings.Race, settings.Breaks),
		practice: settings.Practice,
	}
	if settings.Spectators != nil && !settings.Practice {
		r.maxSpectators = *settings.Spectators
	}
	r.resetGame()
	r.publishInfo()
	return r
}

// resetGame puts a fresh game of the room's mode in the lobby.
func (r *room) resetGame() {
	r.game = game.NewGame(r.poolConfig())
	r.game.SetFree(r.practice) // practice is free play, without the rules
	r.game.SetMode(r.mode)
}

// poolConfig is the server's table with the room's pockets.
func (r *room) poolConfig() game.Config {
	return game.Tables[r.table].Apply(r.hub.opts.Game)
}

// publishInfo refreshes the room-list summary.
func (r *room) publishInfo() {
	info := &RoomInfo{
		RoomCode: r.code, Mode: r.mode, Race: r.race, Breaks: r.breaks, Table: r.table, Cloth: r.cloth,
		Phase: r.game.Rules.Phase, Practice: r.practice,
		Spectators: len(r.watchers), MaxSpectators: r.maxSpectators,
	}
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
	defer r.closeWatchers()
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

// watcherOf returns c's place among the spectators, or -1.
func (r *room) watcherOf(c *ws.Client) int {
	return slices.IndexFunc(r.watchers, func(w *watcher) bool { return w.client == c })
}

func (r *room) handle(ev event) {
	switch ev.kind {
	case evJoin:
		if ev.msg.Watch {
			ev.joined <- r.handleWatch(ev.client, ev.msg)
		} else {
			ev.joined <- r.handleJoin(ev.client, ev.msg)
		}
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
		} else if w := r.watcherOf(ev.client); w >= 0 {
			r.handleWatcherMessage(r.watchers[w], ev.msg)
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
			r.sendOthers(s, r.clockUpdate())
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
	if r.practice && s != 0 {
		s = -1 // a practice table has one player
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
	r.newMatch() // a new opponent: the last match is history
	r.welcome(c, s)
	if r.practice {
		r.startRack(0) // nobody to wait for
	}
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
		AimLine:  int(math.Round(max(0, r.hub.opts.AimLine) * 1000)),
	})
	c.SendJSON(r.roomState())
	r.sendChatLog(c)
	r.sendOthers(s, protocol.Player{Type: protocol.TypePlayer, PlayerInfo: r.playerInfo(s)})
}

// handleLeave runs when a socket closes. In the lobby the seat is freed at
// once; during a game it is held so the player can come back with their
// token (see rearmAwayTimers for how long).
func (r *room) handleLeave(c *ws.Client) {
	if w := r.watcherOf(c); w >= 0 {
		r.dropWatcher(w)
		return
	}
	s := r.seatOf(c)
	if s < 0 {
		return // not seated, or already replaced by a reconnect
	}
	if r.game.Rules.Phase == game.PhaseLobby {
		r.vacate(s)
		return
	}
	r.seats[s].client = nil
	r.sendOthers(s, protocol.Player{Type: protocol.TypePlayer, PlayerInfo: r.playerInfo(s)})
	if r.syncClock() {
		r.sendOthers(s, r.clockUpdate())
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
	r.newMatch()               // nobody won it
	r.broadcast(r.roomState()) // the spectators, if any, see the empty table
}

// vacate empties a seat and, if a game was on, abandons it. A player who
// leaves a match in progress, or does not come back to it in time, forfeits
// it.
func (r *room) vacate(s int) {
	if r.matchLive() {
		r.match.Forfeit(s, r.lastBreaker)
	}
	r.seats[s] = seat{}
	r.sendOthers(s, protocol.Player{Type: protocol.TypePlayer, PlayerInfo: r.playerInfo(s)})

	// A game cannot go on with an empty seat: back to the lobby.
	if r.game.Rules.Phase != game.PhaseLobby {
		r.stopTicker()
		r.stopClock()
		r.resetGame()
		r.seats[1-s].ready = false
		r.broadcast(r.roomState())
	}
}

// handleMessage applies a message from seat s. In a practice room the one
// player acts for whichever seat is to play (act); replies still go to s.
func (r *room) handleMessage(s int, msg protocol.ClientMessage) {
	act := s
	if r.practice {
		act = r.actor()
	}
	var err error
	switch msg.Type {
	case protocol.TypeReady:
		err = r.handleReady(s)
	case protocol.TypeAim:
		r.handleAim(act, msg)
	case protocol.TypeShoot:
		err = r.handleShoot(act, msg)
	case protocol.TypePlaceCue:
		if r.practice {
			err = r.placeFree(game.CueBall, msg)
		} else if err = r.game.PlaceCue(s, game.Vec{X: msg.X, Y: msg.Y}); err == nil {
			r.broadcast(r.roomState())
		}
	case protocol.TypeChoose:
		if err = r.choose(act, msg.Option); err == nil {
			r.broadcast(r.roomState())
		}
	case protocol.TypePlaceBall:
		err = r.placeFree(msg.ID, msg)
	case protocol.TypeUndo:
		err = r.handleUndo()
	case protocol.TypeRerack:
		err = r.handleRerack(msg.Mode)
	case protocol.TypeRematch:
		err = r.handleRematch()
	case protocol.TypeExtend:
		err = r.handleExtend(s)
	case protocol.TypeSetMode:
		err = r.handleSetMode(msg.Mode)
	case protocol.TypeSetTable:
		err = r.handleSetTable(msg.Table, msg.Cloth)
	case protocol.TypeSetMatch:
		err = r.handleSetMatch(msg.Race, msg.Breaks)
	case protocol.TypeLeave:
		r.handleQuit(s)
	case protocol.TypeChat:
		st := &r.seats[s]
		r.handleChat(st.client, st.name, s, &st.lastChat, msg.Text)
	case protocol.TypeSetAudience:
		err = r.handleSetAudience(msg.Spectators)
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
		r.newMatch()
		r.startRack(r.hub.opts.Breaker() & 1)
	}
	return nil
}

// handleRematch starts the next rack of the match, or a new match once it
// is over.
func (r *room) handleRematch() error {
	if r.game.Rules.Phase != game.PhaseGameOver {
		return game.ErrWrongPhase
	}
	switch {
	case r.practice:
		r.startRack(0)
	case r.match.Over():
		opener := r.match.Opener(1 - r.lastBreaker)
		r.newMatch()
		r.startRack(opener)
	default:
		r.startRack(r.match.NextBreaker())
	}
	return nil
}

// newMatch replaces the match with an unplayed one of the room's settings.
func (r *room) newMatch() {
	r.match = game.NewMatch(r.race, r.breaks)
}

// matchLive reports whether a match is being played: a rack is on, or one
// has ended and the race is not won yet.
func (r *room) matchLive() bool {
	return !r.practice && r.game.Rules.Phase != game.PhaseLobby && !r.match.Over()
}

// endRack records the rack in the match once the game is over; foul is the
// foul of the shot that ended it, if any.
func (r *room) endRack(foul game.Foul) {
	rules := r.game.Rules
	if r.practice || rules.Phase != game.PhaseGameOver {
		return
	}
	rack := game.Rack{Winner: rules.Winner, Breaker: r.lastBreaker, End: rules.End}
	if rules.End == game.EndEightFoul {
		rack.Foul = foul
	}
	if rules.Mode == game.ModeCarom {
		r.match.Final(rack, rules.Carom.Points)
		return
	}
	r.match.Record(rack)
}

// scorePoints copies a carom game's points into the match as they are
// made, so the scoreboard follows the game.
func (r *room) scorePoints() {
	if rules := r.game.Rules; !r.practice && rules.Mode == game.ModeCarom && !r.match.Over() {
		r.match.Score = rules.Carom.Points
	}
}

// handleSetMatch changes the race and the break rule (zero values keep
// them), between matches only. In the lobby both players must be ready
// again.
func (r *room) handleSetMatch(race int, breaks game.BreakRule) error {
	ph := r.game.Rules.Phase
	switch {
	case r.practice || r.matchLive():
		return game.ErrWrongPhase
	case race != 0 && !game.ValidRace(r.mode, race), breaks != "" && !breaks.Valid():
		return errBadRace
	case ph != game.PhaseLobby && ph != game.PhaseGameOver:
		return game.ErrWrongPhase
	}
	if race != 0 {
		r.race = race
	}
	if breaks != "" {
		r.breaks = breaks
	}
	if !r.match.Started() {
		r.newMatch()
	}
	if ph == game.PhaseLobby {
		for i := range r.seats {
			r.seats[i].ready = false
		}
	}
	r.broadcast(r.roomState())
	return nil
}

// handleQuit gives up seat s for good: a match in progress is forfeited
// (see vacate) and the socket is closed.
func (r *room) handleQuit(s int) {
	c := r.seats[s].client
	r.vacate(s)
	c.Close(websocket.StatusNormalClosure, "left the room")
}

// placeFree moves a ball anywhere it fits (practice only).
func (r *room) placeFree(id int, msg protocol.ClientMessage) error {
	if !r.practice {
		return errNotPractice
	}
	if err := r.game.PlaceFree(id, game.Vec{X: msg.X, Y: msg.Y}); err != nil {
		return err
	}
	r.broadcast(r.roomState())
	return nil
}

// handleUndo takes back the last shot of a practice room.
func (r *room) handleUndo() error {
	switch {
	case !r.practice:
		return errNotPractice
	case r.game.Moving():
		return game.ErrBallsMoving
	case len(r.history) == 0:
		return errNoUndo
	}
	last := len(r.history) - 1
	r.game.Restore(r.history[last])
	r.history = r.history[:last]
	r.broadcast(r.roomState())
	return nil
}

// handleRerack starts a fresh rack in a practice room, of mode if one is
// given.
func (r *room) handleRerack(mode game.Mode) error {
	switch {
	case !r.practice:
		return errNotPractice
	case r.game.Moving():
		return game.ErrBallsMoving
	case mode != "" && !mode.Valid():
		return errBadMode
	}
	if mode != "" {
		r.mode = mode
		r.game.SetMode(mode)
	}
	r.startRack(0)
	return nil
}

// handleSetMode changes the game played, between matches only. In the lobby
// both players must be ready again for the new game.
func (r *room) handleSetMode(mode game.Mode) error {
	ph := r.game.Rules.Phase
	switch {
	case !mode.Valid():
		return errBadMode
	case ph != game.PhaseLobby && ph != game.PhaseGameOver, r.matchLive():
		return game.ErrWrongPhase
	case mode == r.mode:
		return nil
	}
	if (mode == game.ModeCarom) != (r.mode == game.ModeCarom) {
		// Racks and points do not convert: the new game starts from its
		// default (a carom game to DefaultCaromTarget, a pool race to 1).
		r.race = 1
		if mode == game.ModeCarom {
			r.race = game.DefaultCaromTarget
		}
		if !r.match.Started() {
			r.newMatch()
		}
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

// handleSetTable changes the pool table and the cloth (an empty value keeps
// it), between matches only, or in practice while no shot runs. A new
// table racks again (practice) or, in the lobby, wants both players ready
// again; a new cloth changes nothing else.
func (r *room) handleSetTable(table game.TableID, cloth string) error {
	ph := r.game.Rules.Phase
	switch {
	case table != "" && !table.Valid(), cloth != "" && !Cloths[cloth]:
		return errBadTable
	case r.practice && r.game.Moving():
		return game.ErrBallsMoving
	case !r.practice && (ph != game.PhaseLobby && ph != game.PhaseGameOver || r.matchLive()):
		return game.ErrWrongPhase
	}
	if cloth != "" {
		r.cloth = cloth
	}
	if table != "" && table != r.table {
		r.table = table
		r.game.SetConfig(r.poolConfig())
		switch {
		case r.practice:
			r.startRack(0)
			return nil
		case ph == game.PhaseLobby:
			for i := range r.seats {
				r.seats[i].ready = false
			}
		}
	}
	r.broadcast(r.roomState())
	return nil
}

func (r *room) startRack(breaker int) {
	r.history = nil
	target := r.race // carom: the race is in points
	if r.practice {
		target = 0
	}
	r.game.SetTarget(target)
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

// handleAim relays the shooter's aim preview unchanged to the other player
// and the spectators.
// Aim from anyone else is dropped silently: it is only cosmetic.
func (r *room) handleAim(s int, msg protocol.ClientMessage) {
	if r.practice || !r.game.Rules.InPlay() || r.game.Moving() || r.game.Rules.Turn != s {
		return // nobody else to show it to in practice
	}
	if math.IsNaN(msg.Angle) || math.IsInf(msg.Angle, 0) || math.IsNaN(msg.Power) {
		return
	}
	if math.IsNaN(msg.Elevation) {
		msg.Elevation = 0
	}
	aim := protocol.Aim{
		Type:      protocol.TypeAim,
		Seat:      s,
		Angle:     msg.Angle,
		Power:     math.Max(0, math.Min(1, msg.Power)),
		Elevation: math.Max(0, math.Min(game.MaxElevation, msg.Elevation)),
	}
	r.sendDroppableTo(1-s, aim)
	if data, err := json.Marshal(aim); err == nil {
		for _, w := range r.watchers {
			w.client.SendDroppable(data)
		}
	}
}

func (r *room) handleShoot(s int, msg protocol.ClientMessage) error {
	breaking := r.game.Rules.Phase == game.PhaseBreaking
	var before game.Snapshot
	if r.practice {
		before = r.game.Save()
	}
	if err := r.game.ShootElevated(s, msg.Angle, msg.Power, msg.Call.Game(), msg.Spin.Vec(), msg.Elevation); err != nil {
		return err
	}
	r.breakShot = breaking
	if r.practice {
		r.history = append(r.history, before)
		if len(r.history) > maxUndo {
			r.history = r.history[1:]
		}
	}
	r.stopClock()
	r.ticks = 0
	r.lastSnapT = -1
	r.impactsSent = 0
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

	r.scorePoints()
	r.endRack(res.Foul)
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
		OffTable:     res.OffTable,
		Foul:         res.Foul,
		Made:         res.Made,
		IllegalBreak: res.IllegalBreak,
		Impacts:      r.newImpacts(),
		PushedOut:    res.PushOut,
		Safety:       res.Safety,
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
		Undos:        len(r.history),
		Match:        r.matchInfo(),
		Cushions:     res.Cushions,
		Touched:      res.Touched,
		Spotted:      res.Spotted,
		Frozen:       res.Frozen,
		Target:       st.Target,
		Carom:        st.Carom,
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
	if r.practice || r.hub.opts.ShotClock < 0 || r.game.Moving() || !(rules.InPlay() || rules.Decision != nil) {
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
		r.endRack(game.FoulNone) // a third foul in a row loses a 9-ball rack
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
		balls[i].Z = round4(balls[i].Z)
	}
	r.lastSnapT = ms
	return protocol.Snapshot{Type: protocol.TypeSnapshot, T: ms, Balls: balls, Impacts: r.newImpacts()}
}

// newImpacts returns the impacts of the shot not sent yet and marks them
// sent.
func (r *room) newImpacts() []protocol.Impact {
	all := r.game.Table.Impacts
	if r.impactsSent >= len(all) {
		return nil
	}
	out := make([]protocol.Impact, 0, len(all)-r.impactsSent)
	for _, im := range all[r.impactsSent:] {
		out = append(out, protocol.Impact{
			T: int(math.Round(im.T * 1000)),
			K: protocol.ImpactKinds[im.Kind],
			V: math.Round(im.Speed*100) / 100,
		})
	}
	r.impactsSent = len(all)
	return out
}

func (r *room) roomState() protocol.RoomState {
	st := r.game.State()
	return protocol.RoomState{
		Type:       protocol.TypeRoomState,
		Mode:       st.Mode,
		Table:      r.table,
		Cloth:      r.cloth,
		Practice:   r.practice,
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
		Undos:      len(r.history),
		Race:       r.race,
		Breaks:     r.breaks,
		Match:      r.matchInfo(),
		Target:     st.Target,
		Carom:      st.Carom,

		Spectators:    r.watcherNames(),
		MaxSpectators: r.maxSpectators,
	}
}

// matchInfo is the match as sent to the clients; nil in practice.
func (r *room) matchInfo() *protocol.Match {
	if r.practice {
		return nil
	}
	m := &r.match
	racks := m.Racks
	if racks == nil {
		racks = []game.Rack{}
	}
	return &protocol.Match{Race: m.Race, Breaks: m.Breaks, Score: m.Score, Racks: racks, Winner: winner(m.Winner), Draw: m.Draw}
}

func (r *room) playerInfo(s int) protocol.PlayerInfo {
	st := &r.seats[s]
	if r.practice {
		st = &r.seats[0] // the one player sits on both sides
	}
	return protocol.PlayerInfo{Seat: s, Name: st.name, Connected: st.client != nil, Ready: st.ready}
}

// broadcast encodes msg once and queues it for every connected player and
// every spectator.
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
	for _, w := range r.watchers {
		w.client.Send(data)
	}
}

// sendOthers queues msg for everyone but the player in seat s: the other
// player and the spectators.
func (r *room) sendOthers(s int, msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	if c := r.seats[1-s].client; c != nil {
		c.Send(data)
	}
	for _, w := range r.watchers {
		w.client.Send(data)
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
	for _, w := range r.watchers {
		w.client.SendDroppable(data)
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
	case errors.Is(err, errBadTable):
		return protocol.ErrBadTable
	case errors.Is(err, errNoUndo):
		return protocol.ErrNoUndo
	case errors.Is(err, errNotPractice):
		return protocol.ErrNotPractice
	case errors.Is(err, errBadRace):
		return protocol.ErrBadRace
	case errors.Is(err, errBadSpectators):
		return protocol.ErrBadSpectator
	case errors.Is(err, game.ErrNoPushOut):
		return protocol.ErrBadCall
	}
	return protocol.ErrBadMessage
}
