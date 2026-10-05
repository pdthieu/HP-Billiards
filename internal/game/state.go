// Package game contains the pool simulation and rules. It is pure Go and has
// no knowledge of networking.
package game

import (
	"errors"
	"math"
)

const (
	// NumBalls is the cue ball plus object balls 1–15.
	NumBalls = 16
	// CueBall is the id of the cue ball.
	CueBall = 0
	// EightBall is the id of the 8-ball.
	EightBall = 8
	// NumPockets is the number of pockets. Pocket indices run 0–5: top-left,
	// top-middle, top-right, bottom-left, bottom-middle, bottom-right.
	NumPockets = 6
)

// Vec is a 2D vector in meters (or meters/second for velocities).
type Vec struct {
	X, Y float64
}

func (a Vec) Add(b Vec) Vec       { return Vec{a.X + b.X, a.Y + b.Y} }
func (a Vec) Sub(b Vec) Vec       { return Vec{a.X - b.X, a.Y - b.Y} }
func (a Vec) Scale(s float64) Vec { return Vec{a.X * s, a.Y * s} }
func (a Vec) Dot(b Vec) float64   { return a.X*b.X + a.Y*b.Y }
func (a Vec) Len() float64        { return math.Hypot(a.X, a.Y) }
func (a Vec) Dist(b Vec) float64  { return a.Sub(b).Len() }

// Ball is one ball's physical state. A pocketed ball is out of play and is
// ignored by the simulation.
type Ball struct {
	ID       int
	Pos      Vec
	Vel      Vec
	Pocketed bool
}

// EventKind identifies what happened in an Event.
type EventKind int

const (
	// BallPocketed: Ball dropped into a pocket.
	BallPocketed EventKind = iota
	// FirstContact: Ball is the first object ball the cue ball touched this shot.
	FirstContact
	// CushionHit: Ball bounced off a rail.
	CushionHit
	// HeadStringCrossed: the cue ball rolled out of the kitchen, across the
	// head string. Recorded at most once per shot.
	HeadStringCrossed
)

func (k EventKind) String() string {
	switch k {
	case BallPocketed:
		return "BallPocketed"
	case FirstContact:
		return "FirstContact"
	case CushionHit:
		return "CushionHit"
	case HeadStringCrossed:
		return "HeadStringCrossed"
	}
	return "Unknown"
}

// Event is something the rules may care about, recorded by Table.Step.
type Event struct {
	Kind EventKind
	Ball int
	// Pocket is the pocket index of a BallPocketed event.
	Pocket int
	// InKitchen is set on FirstContact when the contacted ball was above the
	// head string (a ball resting on the head string is not).
	InKitchen bool
}

// BallState is the JSON-serializable position of a ball that is on the table.
type BallState struct {
	ID int     `json:"id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
}

// Config holds every tunable constant of the simulation. Units are meters and
// seconds. The origin is the top-left corner of the playing surface, y down.
type Config struct {
	TableWidth  float64 // playing surface, long axis (x)
	TableHeight float64 // playing surface, short axis (y)
	BallRadius  float64

	// MaxCueSpeed is the cue ball speed of a power-1 shot.
	MaxCueSpeed float64
	// Dt is the fixed physics timestep. Keep MaxCueSpeed*Dt <= BallRadius/2
	// so a ball can never tunnel through another one.
	Dt float64
	// Substeps is how many Dt steps make up one server tick.
	Substeps int

	BallRestitution    float64 // ball–ball
	CushionRestitution float64 // ball–rail, applied to the normal component

	CornerCaptureRadius float64 // pocketed when the center is this close to a corner
	SideCaptureRadius   float64 // same, for the two side pockets

	RollingDecel float64 // constant rolling deceleration, m/s²
	StopSpeed    float64 // a ball slower than this is stopped dead

	// RackGap is the space left between neighbouring balls in the rack so a
	// resting rack never registers as overlapping.
	RackGap float64
}

// DefaultConfig returns the standard table: 9 ft playing surface, 600 Hz
// physics, 60 Hz ticks.
func DefaultConfig() Config {
	return Config{
		TableWidth:          2.54,
		TableHeight:         1.27,
		BallRadius:          0.028575,
		MaxCueSpeed:         8,
		Dt:                  1.0 / 600,
		Substeps:            10,
		BallRestitution:     0.95,
		CushionRestitution:  0.8,
		CornerCaptureRadius: 0.06,
		SideCaptureRadius:   0.055,
		RollingDecel:        0.4,
		StopSpeed:           0.01,
		RackGap:             0.0005,
	}
}

// HeadString is the x coordinate of the head string. The kitchen, the area
// "above the head string", is x <= HeadString(): unlike on a real table a cue
// ball centered exactly on the line counts as inside.
func (c Config) HeadString() float64 { return c.TableWidth / 4 }

// HeadSpot is where the cue ball starts, in the middle of the head string.
func (c Config) HeadSpot() Vec { return Vec{c.HeadString(), c.TableHeight / 2} }

// FootSpot is where the apex ball of the rack sits.
func (c Config) FootSpot() Vec { return Vec{c.TableWidth * 3 / 4, c.TableHeight / 2} }

// State is the JSON-serializable full state of a game.
type State struct {
	Balls      []BallState `json:"balls"`
	Phase      Phase       `json:"phase"`
	Turn       int         `json:"turn"`
	Groups     [2]Group    `json:"groups"`     // by seat; "" until assigned
	BallInHand bool        `json:"ballInHand"` // applies to Turn
	Kitchen    bool        `json:"kitchen"`    // ball in hand is limited to above the head string
	Decision   *Decision   `json:"decision"`   // pending post-break choice, or null
	Winner     int         `json:"winner"`     // seat, or -1
}

// Errors returned by Game and Rules when an action is not allowed.
var (
	ErrWrongPhase   = errors.New("the game is not in play")
	ErrBallsMoving  = errors.New("balls are still moving")
	ErrNotYourTurn  = errors.New("not your turn")
	ErrNoBallInHand = errors.New("you do not have ball in hand")
	ErrBadPlacement = errors.New("the cue ball cannot be placed there")
	ErrBadInput     = errors.New("invalid angle or power")
	ErrBadCall      = errors.New("you must call a legal ball and a pocket, or a safety")
	ErrNoDecision   = errors.New("there is no decision to make")
	ErrBadOption    = errors.New("that option is not available")
)

// Game ties the physics table to the rules. Like Table it must be driven by a
// single goroutine.
type Game struct {
	Table *Table
	Rules *Rules

	shooting bool // a shot is in progress and has not been resolved yet
	shot     Shot // the shot in progress
	// cueInKitchen: the cue ball sits where kitchen ball-in-hand put it, so
	// the next shot is "played from above the head string" (WPA 3.11).
	cueInKitchen bool
}

// NewGame returns a game waiting in the lobby phase.
func NewGame(cfg Config) *Game {
	return &Game{Table: NewTable(cfg), Rules: NewRules()}
}

// Start racks the balls and begins a new game with breaker to shoot first.
func (g *Game) Start(breaker int) {
	g.Rules.Start(breaker)
	g.rack()
}

func (g *Game) rack() {
	g.Table.Rack()
	g.shooting = false
	g.cueInKitchen = true
}

// Moving reports whether a shot is in progress, i.e. Tick has work to do.
func (g *Game) Moving() bool { return g.shooting }

func (g *Game) checkTurn(seat int) error {
	switch {
	case !g.Rules.InPlay():
		return ErrWrongPhase
	case g.shooting:
		return ErrBallsMoving
	case seat != g.Rules.Turn:
		return ErrNotYourTurn
	}
	return nil
}

// Shoot strikes the cue ball for seat. power is clamped to [0,1]. call is the
// called ball and pocket (or safety); it is ignored on the break.
func (g *Game) Shoot(seat int, angle, power float64, call Call) error {
	if err := g.checkTurn(seat); err != nil {
		return err
	}
	if math.IsNaN(angle) || math.IsInf(angle, 0) || math.IsNaN(power) {
		return ErrBadInput
	}
	if err := g.Rules.CheckCall(call); err != nil {
		return err
	}
	g.shot = Shot{Call: call, FromKitchen: g.Rules.BallInHand && g.Rules.Kitchen && g.cueInKitchen}
	g.Table.Shoot(angle, power)
	g.shooting = true
	return nil
}

// PlaceCue moves the cue ball for seat, who must have ball in hand. While the
// kitchen restriction applies, pos must be above the head string.
func (g *Game) PlaceCue(seat int, pos Vec) error {
	if err := g.checkTurn(seat); err != nil {
		return err
	}
	if !g.Rules.BallInHand {
		return ErrNoBallInHand
	}
	if g.Rules.Kitchen && !(pos.X <= g.Table.Cfg.HeadString()) {
		return ErrBadPlacement
	}
	if !g.Table.PlaceCue(pos) {
		return ErrBadPlacement
	}
	g.cueInKitchen = g.Rules.Kitchen
	return nil
}

// Choose answers the pending post-break decision for seat.
func (g *Game) Choose(seat int, opt Option) error {
	res, err := g.Rules.Choose(seat, opt)
	if err != nil {
		return err
	}
	switch {
	case res.Rerack:
		g.rack()
	case res.RespotEight:
		g.Table.Spot(EightBall, g.Table.Cfg.FootSpot(), 1)
	}
	return nil
}

// Tick advances a shot in progress by one server tick (Cfg.Substeps physics
// steps). When the table settles it resolves the shot with the rules and
// returns the result; otherwise it returns nil.
func (g *Game) Tick() *ShotResult {
	if !g.shooting {
		return nil
	}
	for i := 0; i < g.Table.Cfg.Substeps && !g.Table.Settled(); i++ {
		g.Table.Step(g.Table.Cfg.Dt)
	}
	if !g.Table.Settled() {
		return nil
	}
	g.shooting = false
	g.shot.Events = g.Table.Events
	res := g.Rules.Resolve(g.shot)
	g.cueInKitchen = false
	if res.CuePocketed && g.Rules.Phase != PhaseGameOver {
		// The incoming player has ball in hand; the head spot is only a
		// default. It is inside the kitchen, which every scratch on the
		// break leads to.
		g.Table.Spot(CueBall, g.Table.Cfg.HeadSpot(), -1)
		g.cueInKitchen = true
	}
	return &res
}

// State returns the full serializable state.
func (g *Game) State() State {
	return State{
		Balls:      g.Table.Snapshot(),
		Phase:      g.Rules.Phase,
		Turn:       g.Rules.Turn,
		Groups:     g.Rules.Groups,
		BallInHand: g.Rules.BallInHand,
		Kitchen:    g.Rules.Kitchen,
		Decision:   g.Rules.Decision,
		Winner:     g.Rules.Winner,
	}
}
