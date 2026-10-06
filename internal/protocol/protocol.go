// Package protocol defines the JSON messages exchanged over the WebSocket.
// Every message is an object with a "type" field. Keep docs/PROTOCOL.md in
// sync with this file.
package protocol

import "billiards/internal/game"

// Version is carried by the welcome message as "v".
const Version = 1

// Message types, client → server.
const (
	TypeJoin     = "join"
	TypeReady    = "ready"
	TypeShoot    = "shoot"
	TypePlaceCue = "place_cue"
	TypeChoose   = "choose"
	TypeRematch  = "rematch"
	// TypeExtend uses the sender's one extension of the game: their running
	// shot clock is set back to the long limit.
	TypeExtend = "extend"
	// TypeSetMode changes the game played, in the lobby or after a game.
	TypeSetMode = "set_mode"
	// TypePing may be sent at any time, even before join; the server answers
	// with TypePong. Lets a client notice a dead connection quickly.
	TypePing = "ping"
)

// Message types, server → client. TypeAim travels in both directions.
const (
	TypeWelcome   = "welcome"
	TypeRoomState = "room_state"
	TypeSnapshot  = "snapshot"
	TypeSettled   = "settled"
	TypeAim       = "aim"
	TypePlayer    = "player"
	TypeError     = "error"
	TypePong      = "pong"
	TypeClock     = "clock"   // the shot clock changed: extension, pause or resume
	TypeTimeout   = "timeout" // a player's shot clock ran out
)

// Error codes carried by the error message.
const (
	ErrBadMessage   = "bad_message"    // not JSON, unknown type or missing fields
	ErrNotJoined    = "not_joined"     // anything but join before a successful join
	ErrRoomNotFound = "room_not_found" // join with an unknown room code
	ErrRoomFull     = "room_full"      // both seats are taken
	ErrWrongPhase   = "wrong_phase"    // the action is not allowed in this phase
	ErrBallsMoving  = "balls_moving"   // a shot is still in progress
	ErrNotYourTurn  = "not_your_turn"
	ErrNoBallInHand = "no_ball_in_hand"
	ErrBadPlacement = "bad_placement" // place_cue off the table, on a ball or outside the kitchen
	ErrBadInput     = "bad_input"     // angle or power is not a finite number
	ErrBadCall      = "bad_call"      // shoot at the 8-ball without a pocket, a pocket outside 0–5, or a push out that is not allowed
	ErrNoDecision   = "no_decision"   // choose with nothing to decide
	ErrBadOption    = "bad_option"    // choose with an option that was not offered
	ErrNoExtension  = "no_extension"  // extend after the sender used their extension this game
	ErrBadMode      = "bad_mode"      // set_mode (or room creation) with an unknown mode
)

// ClientMessage is any client → server message; only the fields of its Type
// are meaningful.
type ClientMessage struct {
	Type string `json:"type"`

	// join. Token, when it matches a seat of the room, reclaims that seat
	// (reconnect) instead of taking a free one.
	RoomCode string `json:"roomCode"`
	Token    string `json:"token"`
	Name     string `json:"name"`

	// aim, shoot
	Angle float64 `json:"angle"` // radians, 0 = +x, y down
	Power float64 `json:"power"` // clamped to [0,1]
	// shoot: optional; required (a pocket) when the 8-ball is the target
	Call *Call `json:"call"`
	// shoot: optional english, see Spin
	Spin *Spin `json:"spin"`

	// place_cue
	X float64 `json:"x"`
	Y float64 `json:"y"`

	// choose
	Option game.Option `json:"option"`

	// set_mode
	Mode game.Mode `json:"mode"`
}

// Spin is where the cue tip strikes the cue ball, as an offset from its
// centre in units of the usable radius: X > 0 right (as the shooter sees
// it), Y > 0 above centre (top spin). The server clamps it to the unit disc.
type Spin struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// Vec converts the wire spin to the rules' representation; nil is no spin.
func (s *Spin) Vec() game.Vec {
	if s == nil {
		return game.Vec{}
	}
	return game.Vec{X: s.X, Y: s.Y}
}

// Call is the shooter's declaration. 8-ball: a safety, or the pocket the
// 8-ball is going to; object balls are not called, a shooter whose target is
// the 8-ball must name a pocket. 9-ball: nothing is called, but the shot
// right after the break may be a push out.
type Call struct {
	Safety  bool `json:"safety,omitempty"`
	Pocket  *int `json:"pocket,omitempty"`
	PushOut bool `json:"pushOut,omitempty"`
}

// Game converts the wire call to the rules' representation; nil is no call.
func (c *Call) Game() game.Call {
	out := game.Call{Pocket: game.AnyPocket}
	if c == nil {
		return out
	}
	out.Safety = c.Safety
	out.PushOut = c.PushOut
	if c.Pocket != nil {
		out.Pocket = *c.Pocket
	}
	return out
}

// Clock is the shot clock of the player who must act next: shoot (placing
// the cue ball first if they have ball in hand) or answer a decision. When it
// runs out a shooter commits a foul and a decision takes its first option;
// see Timeout.
type Clock struct {
	Seat   int  `json:"seat"`
	Left   int  `json:"left"`   // milliseconds left when the message was sent
	Limit  int  `json:"limit"`  // milliseconds the clock was last set to
	Paused bool `json:"paused"` // the player is offline; the clock waits for them
	// Extension is what an extension sets the clock to, in milliseconds.
	Extension int `json:"extension"`
	// Extensions by seat: whether that player may still extend this game.
	Extensions [2]bool `json:"extensions"`
}

// ClockUpdate announces a change to the running clock outside room_state
// and settled.
type ClockUpdate struct {
	Type string `json:"type"`
	Clock
}

// Timeout says that Seat let the shot clock run out. A room_state follows.
type Timeout struct {
	Type string `json:"type"`
	Seat int    `json:"seat"`
	// Option is the choice made for Seat when they ran out of time on a
	// decision; absent when they ran out of time on a shot, which is a foul
	// giving the opponent ball in hand.
	Option game.Option `json:"option,omitempty"`
}

// Welcome answers a successful join.
type Welcome struct {
	Type     string `json:"type"`
	V        int    `json:"v"`
	PlayerID string `json:"playerId"`
	Seat     int    `json:"seat"`
	Token    string `json:"token"`
	RoomCode string `json:"roomCode"`
}

// PlayerInfo describes one seat. A seat with a Name but Connected false is
// held for a player who dropped out mid-game and may reconnect; Name "" is an
// empty seat.
type PlayerInfo struct {
	Seat      int    `json:"seat"`
	Name      string `json:"name"`
	Connected bool   `json:"connected"`
	Ready     bool   `json:"ready"`
}

// Player announces a change to one seat.
type Player struct {
	Type string `json:"type"`
	PlayerInfo
}

// RoomState is the full state of a room. It is sent after welcome and
// whenever the state changes other than by a shot settling.
type RoomState struct {
	Type       string           `json:"type"`
	Mode       game.Mode        `json:"mode"`
	Balls      []game.BallState `json:"balls"` // balls on the table
	Players    [2]PlayerInfo    `json:"players"`
	Phase      game.Phase       `json:"phase"`
	Turn       int              `json:"turn"`
	Groups     [2]game.Group    `json:"groups"`     // by seat, "" until assigned
	BallInHand bool             `json:"ballInHand"` // Turn may place the cue ball
	Kitchen    bool             `json:"kitchen"`    // ...only above the head string
	Decision   *game.Decision   `json:"decision"`   // pending post-break choice or null
	Winner     *int             `json:"winner"`     // seat or null
	Moving     bool             `json:"moving"`     // a shot is in progress
	Clock      *Clock           `json:"clock"`      // null while nobody has to act
	Fouls      [2]int           `json:"fouls"`      // 9-ball: consecutive fouls by seat
	PushOut    bool             `json:"pushOut"`    // 9-ball: turn may push out on this shot
}

// Snapshot carries ball positions while a shot is in progress.
type Snapshot struct {
	Type  string           `json:"type"`
	T     int              `json:"t"`     // milliseconds of simulated time since the shot
	Balls []game.BallState `json:"balls"` // rounded to 0.1 mm
}

// Settled ends a shot: exact positions plus what the rules decided.
type Settled struct {
	Type         string           `json:"type"`
	Balls        []game.BallState `json:"balls"`
	Shooter      int              `json:"shooter"`
	Pocketed     []int            `json:"pocketed"` // ids in order, cue ball (0) included
	Foul         game.Foul        `json:"foul,omitempty"`
	Made         bool             `json:"made"`
	IllegalBreak bool             `json:"illegalBreak"`
	PushedOut    bool             `json:"pushedOut"` // 9-ball: this shot was a push out
	Phase        game.Phase       `json:"phase"`
	Turn         int              `json:"turn"`
	Groups       [2]game.Group    `json:"groups"`
	BallInHand   bool             `json:"ballInHand"`
	Kitchen      bool             `json:"kitchen"`
	Decision     *game.Decision   `json:"decision"`
	Winner       *int             `json:"winner,omitempty"`
	Clock        *Clock           `json:"clock"`
	Fouls        [2]int           `json:"fouls"`
	PushOut      bool             `json:"pushOut"`
}

// Aim relays the shooter's aim to the other player.
type Aim struct {
	Type  string  `json:"type"`
	Seat  int     `json:"seat"`
	Angle float64 `json:"angle"`
	Power float64 `json:"power"`
}

// Pong answers a ping.
type Pong struct {
	Type string `json:"type"`
}

// Error reports a rejected message.
type Error struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// NewError builds an error message.
func NewError(code, message string) Error {
	return Error{Type: TypeError, Code: code, Message: message}
}
