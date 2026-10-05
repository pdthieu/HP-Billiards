package hub

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf8"

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
)

// event is one input to a room's goroutine.
type event struct {
	kind   eventKind
	client *ws.Client
	msg    protocol.ClientMessage
	joined chan bool // evJoin: whether the client got a seat
}

type seat struct {
	client *ws.Client // nil while the seat is empty
	id     string
	token  string
	name   string
	ready  bool
}

// room is one table and its two seats. Everything below inbox is owned by the
// run goroutine and must not be touched from anywhere else.
type room struct {
	hub   *Hub
	code  string
	inbox chan event
	done  chan struct{} // closed when run exits

	game        *game.Game
	seats       [2]seat
	ticker      *time.Ticker // non-nil only while a shot is in progress
	ticks       int          // since the shot started
	lastBreaker int
}

func newRoom(h *Hub, code string) *room {
	return &room{
		hub:   h,
		code:  code,
		inbox: make(chan event, 16),
		done:  make(chan struct{}),
		game:  game.NewGame(h.opts.Game),
	}
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
	case evMessage:
		if s := r.seatOf(ev.client); s >= 0 {
			r.handleMessage(s, ev.msg)
		}
	}
}

func (r *room) handleJoin(c *ws.Client, msg protocol.ClientMessage) bool {
	s := -1
	for i := range r.seats {
		if r.seats[i].client == nil {
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
	return true
}

func (r *room) handleLeave(c *ws.Client) {
	s := r.seatOf(c)
	if s < 0 {
		return
	}
	r.seats[s] = seat{}
	r.sendTo(1-s, protocol.Player{Type: protocol.TypePlayer, PlayerInfo: r.playerInfo(s)})

	// A game cannot go on with an empty seat: back to the lobby.
	if r.game.Rules.Phase != game.PhaseLobby {
		r.stopTicker()
		r.game = game.NewGame(r.hub.opts.Game)
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
		if err = r.game.Choose(s, msg.Option); err == nil {
			r.noteRack()
			r.broadcast(r.roomState())
		}
	case protocol.TypeRematch:
		err = r.handleRematch()
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

func (r *room) startRack(breaker int) {
	r.game.Start(breaker)
	r.noteRack()
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
	r.sendTo(1-s, protocol.Aim{
		Type:  protocol.TypeAim,
		Seat:  s,
		Angle: msg.Angle,
		Power: math.Max(0, math.Min(1, msg.Power)),
	})
}

func (r *room) handleShoot(s int, msg protocol.ClientMessage) error {
	var call game.Call // the zero call is rejected on every shot but the break
	if msg.Call != nil {
		call = *msg.Call
	}
	if err := r.game.Shoot(s, msg.Angle, msg.Power, call); err != nil {
		return err
	}
	r.ticks = 0
	r.ticker = time.NewTicker(time.Second / tickRate)
	r.broadcast(r.snapshot())
	return nil
}

// tick advances the shot in progress by one server tick.
func (r *room) tick() {
	res := r.game.Tick()
	r.ticks++
	if res == nil {
		if r.ticks%snapshotEvery == 0 {
			r.broadcast(r.snapshot())
		}
		return
	}
	r.stopTicker()

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
		CalledMade:   res.CalledMade,
		IllegalBreak: res.IllegalBreak,
		Phase:        st.Phase,
		Turn:         st.Turn,
		Groups:       st.Groups,
		BallInHand:   st.BallInHand,
		Kitchen:      st.Kitchen,
		Decision:     st.Decision,
		Winner:       winner(st.Winner),
	})
}

func (r *room) stopTicker() {
	if r.ticker != nil {
		r.ticker.Stop()
		r.ticker = nil
	}
}

func (r *room) snapshot() protocol.Snapshot {
	balls := r.game.Table.Snapshot()
	for i := range balls {
		balls[i].X = round3(balls[i].X)
		balls[i].Y = round3(balls[i].Y)
	}
	return protocol.Snapshot{
		Type:  protocol.TypeSnapshot,
		T:     r.ticks * 1000 / tickRate,
		Balls: balls,
	}
}

func (r *room) roomState() protocol.RoomState {
	st := r.game.State()
	return protocol.RoomState{
		Type:       protocol.TypeRoomState,
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

func (r *room) sendTo(s int, msg any) {
	if c := r.seats[s].client; c != nil {
		c.SendJSON(msg)
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

func round3(v float64) float64 { return math.Round(v*1000) / 1000 }

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
	}
	return protocol.ErrBadMessage
}
