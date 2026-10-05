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
	ErrBadCall      = "bad_call"      // shoot without a legal called ball and pocket (or safety)
	ErrNoDecision   = "no_decision"   // choose with nothing to decide
	ErrBadOption    = "bad_option"    // choose with an option that was not offered
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
	// shoot: required on every shot except the break
	Call *Call `json:"call"`
	// shoot: optional english, see Spin
	Spin *Spin `json:"spin"`

	// place_cue
	X float64 `json:"x"`
	Y float64 `json:"y"`

	// choose
	Option game.Option `json:"option"`
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

// Call is the shooter's declaration: a safety, or a ball and optionally the
// pocket. Without a pocket the ball counts wherever it drops.
type Call struct {
	Safety bool `json:"safety,omitempty"`
	Ball   int  `json:"ball"`
	Pocket *int `json:"pocket,omitempty"`
}

// Game converts the wire call to the rules' representation.
func (c *Call) Game() game.Call {
	if c == nil {
		return game.Call{} // rejected by the rules on every shot but the break
	}
	out := game.Call{Safety: c.Safety, Ball: c.Ball, Pocket: game.AnyPocket}
	if c.Pocket != nil {
		out.Pocket = *c.Pocket
	}
	return out
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
	CalledMade   bool             `json:"calledMade"`
	IllegalBreak bool             `json:"illegalBreak"`
	Phase        game.Phase       `json:"phase"`
	Turn         int              `json:"turn"`
	Groups       [2]game.Group    `json:"groups"`
	BallInHand   bool             `json:"ballInHand"`
	Kitchen      bool             `json:"kitchen"`
	Decision     *game.Decision   `json:"decision"`
	Winner       *int             `json:"winner,omitempty"`
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
