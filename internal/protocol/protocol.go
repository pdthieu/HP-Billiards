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
	// TypeSetMode changes the game played, in the lobby or after a match.
	TypeSetMode = "set_mode"
	// TypeSetMatch changes the race and break rule, in the lobby or after a
	// match.
	TypeSetMatch = "set_match"
	// TypeSetTable changes the pool table and the cloth, in the lobby or
	// after a match.
	TypeSetTable = "set_table"
	// TypeLeave gives up the sender's seat at once; during a match it
	// forfeits the match.
	TypeLeave = "leave"
	// Practice rooms only: move a ball, take back the last shot, rack again.
	TypePlaceBall = "place_ball"
	TypeUndo      = "undo"
	TypeRerack    = "rerack"
	// TypeChat posts a comment to everyone in the room, players and
	// spectators alike; the server relays it as Chat. TypeSetAudience
	// changes how many spectators may watch (players only).
	TypeChat        = "chat"
	TypeSetAudience = "set_audience"
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
	TypeClock     = "clock"    // the shot clock changed: extension, pause or resume
	TypeTimeout   = "timeout"  // a player's shot clock ran out
	TypeChatLog   = "chat_log" // the room's recent comments, after welcome
	TypeAudience  = "audience" // who is watching changed, or how many may
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
	ErrBadPlacement = "bad_placement"  // place_cue off the table, on a ball or outside the kitchen
	ErrBadInput     = "bad_input"      // angle or power is not a finite number
	ErrBadCall      = "bad_call"       // shoot at the 8-ball without a pocket, a pocket outside 0–5, or a push out that is not allowed
	ErrNoDecision   = "no_decision"    // choose with nothing to decide
	ErrBadOption    = "bad_option"     // choose with an option that was not offered
	ErrNoExtension  = "no_extension"   // extend after the sender used their extension this game
	ErrBadMode      = "bad_mode"       // set_mode (or room creation) with an unknown mode
	ErrNoUndo       = "no_undo"        // undo with no shot to take back
	ErrNotPractice  = "not_practice"   // place_ball, undo or rerack outside a practice room
	ErrBadRace      = "bad_race"       // set_match (or room creation) with a race outside 1–25 or an unknown break rule
	ErrAudienceFull = "audience_full"  // join with watch when no more spectators may watch (or none at all)
	ErrSpectator    = "spectator"      // a spectator sent something other than chat or leave
	ErrChatCooldown = "chat_cooldown"  // a comment too soon after the sender's last; see Error.RetryMs
	ErrBadSpectator = "bad_spectators" // set_audience (or room creation) with a number outside 0 to the server's limit
	ErrBadTable     = "bad_table"      // set_table (or room creation) with an unknown table or cloth
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
	// join: watch, without a seat (see Welcome.Spectator)
	Watch bool `json:"watch"`

	// chat
	Text string `json:"text"`

	// set_audience
	Spectators *int `json:"spectators"`

	// aim, shoot
	Angle float64 `json:"angle"` // radians, 0 = +x, y down
	Power float64 `json:"power"` // clamped to [0,1]
	// shoot: optional; required (a pocket) when the 8-ball is the target
	Call *Call `json:"call"`
	// shoot: optional english, see Spin
	Spin *Spin `json:"spin"`
	// aim, shoot: optional, how far the butt of the cue is raised, in
	// radians above the horizontal; 0 is a level cue, more makes the cue
	// ball jump. The server clamps it to [0, game.MaxElevation].
	Elevation float64 `json:"elevation"`

	// place_cue, place_ball (ID is the ball)
	ID int     `json:"id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`

	// choose
	Option game.Option `json:"option"`

	// set_mode, rerack (optional there)
	Mode game.Mode `json:"mode"`

	// set_match: either may be left out (0, "") to keep it
	Race   int            `json:"race"`
	Breaks game.BreakRule `json:"breaks"`

	// set_table: either may be left out ("") to keep it
	Table game.TableID `json:"table"`
	Cloth string       `json:"cloth"`
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
	// AimLine is the length, in millimetres, of the aim guide's object-ball
	// line after contact; 0 means the guide stops at the ghost ball.
	AimLine int `json:"aimLine"`
	// Spectator: the client watches (Seat is -1, no token); it may only
	// chat and leave.
	Spectator bool `json:"spectator,omitempty"`
}

// Chat is one comment, relayed to everyone in the room.
type Chat struct {
	Type string `json:"type"`
	From string `json:"from"`
	Seat int    `json:"seat"` // the player's seat, -1 for a spectator
	Text string `json:"text"`
	At   int64  `json:"at"` // Unix milliseconds
}

// ChatLog carries the room's recent comments, oldest first.
type ChatLog struct {
	Type     string `json:"type"`
	Messages []Chat `json:"messages"`
}

// Audience says who is watching and how many may.
type Audience struct {
	Type  string   `json:"type"`
	Names []string `json:"names"`
	Max   int      `json:"max"`
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
	Table      game.TableID     `json:"table"`    // the pool table (set_table); carom has its own
	Cloth      string           `json:"cloth"`    // the cloth's colour (set_table)
	Practice   bool             `json:"practice"` // one player plays both seats
	Balls      []game.BallState `json:"balls"`    // balls on the table
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
	Undos      int              `json:"undos"`      // practice: shots undo can take back
	// Target and Carom: 3-cushion only, the points the game is played to
	// (0 in practice, which has no end) and the score.
	Target int              `json:"target,omitempty"`
	Carom  *game.CaromScore `json:"carom,omitempty"`
	// Race and Breaks are the settings of the next match (set_match);
	// Match is the one being played, or the last one.
	Race   int            `json:"race"`
	Breaks game.BreakRule `json:"breaks"`
	Match  *Match         `json:"match"` // null in practice
	// Spectators are the names of who is watching, in the order they came;
	// MaxSpectators how many may (set_audience).
	Spectators    []string `json:"spectators"`
	MaxSpectators int      `json:"maxSpectators"`
}

// Match is the race the two players are playing: the first to win Race
// racks wins. A finished match stays until the next one starts or a new
// player sits down.
//
// In 3-cushion a match is one game to Race points: Score is the points,
// Racks holds the game once it is over, and a game that ended level is a
// Draw (Winner stays null; the rack's winner is -1).
type Match struct {
	Race   int            `json:"race"`
	Breaks game.BreakRule `json:"breaks"`
	Score  [2]int         `json:"score"`  // racks won (3-cushion: points), by seat
	Racks  []game.Rack    `json:"racks"`  // every finished rack, in order
	Winner *int           `json:"winner"` // seat, or null while the match is on
	Draw   bool           `json:"draw,omitempty"`
}

// Snapshot carries ball positions while a shot is in progress.
type Snapshot struct {
	Type  string           `json:"type"`
	T     int              `json:"t"`     // milliseconds of simulated time since the shot
	Balls []game.BallState `json:"balls"` // rounded to 0.1 mm
	// Impacts since the previous snapshot, for sound; each is sent once.
	Impacts []Impact `json:"impacts,omitempty"`
}

// Impact is a contact for the client to play a sound for.
type Impact struct {
	T int     `json:"t"` // milliseconds since the shot, on the snapshot clock
	K string  `json:"k"` // "ball", "rail", "pocket" or "slate" (a ball coming down from a jump)
	V float64 `json:"v"` // closing speed, m/s
}

// ImpactKinds maps game.ImpactKind to Impact.K.
var ImpactKinds = [...]string{game.ImpactBall: "ball", game.ImpactCushion: "rail", game.ImpactPocket: "pocket", game.ImpactSlate: "slate"}

// Settled ends a shot: exact positions plus what the rules decided.
type Settled struct {
	Type         string           `json:"type"`
	Balls        []game.BallState `json:"balls"`
	Shooter      int              `json:"shooter"`
	Pocketed     []int            `json:"pocketed"`           // ids in order, cue ball (0) included
	OffTable     []int            `json:"offTable,omitempty"` // ids driven off the table, in order, cue ball included
	Foul         game.Foul        `json:"foul,omitempty"`
	Made         bool             `json:"made"`
	IllegalBreak bool             `json:"illegalBreak"`
	PushedOut    bool             `json:"pushedOut"`        // 9-ball: this shot was a push out
	Safety       bool             `json:"safety,omitempty"` // 8-ball: the shooter called a safety
	Phase        game.Phase       `json:"phase"`
	Turn         int              `json:"turn"`
	Groups       [2]game.Group    `json:"groups"`
	BallInHand   bool             `json:"ballInHand"`
	Kitchen      bool             `json:"kitchen"`
	Decision     *game.Decision   `json:"decision"`
	Winner       *int             `json:"winner,omitempty"`
	Impacts      []Impact         `json:"impacts,omitempty"` // the last ones of the shot
	Clock        *Clock           `json:"clock"`
	Fouls        [2]int           `json:"fouls"`
	PushOut      bool             `json:"pushOut"`
	Undos        int              `json:"undos"`
	Match        *Match           `json:"match"`
	// 3-cushion: the cue ball's cushions before it reached the second ball
	// (or in all), how many of the other two balls it touched, the balls
	// put back on their spots in order, Frozen when that was because the
	// incoming cue ball touched a ball, and the score after the shot.
	Cushions int              `json:"cushions,omitempty"`
	Touched  int              `json:"touched,omitempty"`
	Spotted  []int            `json:"spotted,omitempty"`
	Frozen   bool             `json:"frozen,omitempty"`
	Target   int              `json:"target,omitempty"`
	Carom    *game.CaromScore `json:"carom,omitempty"`
}

// Aim relays the shooter's aim to the other player.
type Aim struct {
	Type  string  `json:"type"`
	Seat  int     `json:"seat"`
	Angle float64 `json:"angle"`
	Power float64 `json:"power"`
	// Elevation of the cue in radians, left out while it is level.
	Elevation float64 `json:"elevation,omitempty"`
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
	// RetryMs: chat_cooldown only, how long until a comment is accepted.
	RetryMs int `json:"retryMs,omitempty"`
}

// NewError builds an error message.
func NewError(code, message string) Error {
	return Error{Type: TypeError, Code: code, Message: message}
}
