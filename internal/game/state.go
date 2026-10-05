// Package game contains the pool simulation and rules. It is pure Go and has
// no knowledge of networking.
package game

import "math"

const (
	// NumBalls is the cue ball plus object balls 1–15.
	NumBalls = 16
	// CueBall is the id of the cue ball.
	CueBall = 0
	// EightBall is the id of the 8-ball.
	EightBall = 8
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
)

func (k EventKind) String() string {
	switch k {
	case BallPocketed:
		return "BallPocketed"
	case FirstContact:
		return "FirstContact"
	case CushionHit:
		return "CushionHit"
	}
	return "Unknown"
}

// Event is something the rules may care about, recorded by Table.Step.
type Event struct {
	Kind EventKind
	Ball int
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

// HeadSpot is where the cue ball starts.
func (c Config) HeadSpot() Vec { return Vec{c.TableWidth / 4, c.TableHeight / 2} }

// FootSpot is where the apex ball of the rack sits.
func (c Config) FootSpot() Vec { return Vec{c.TableWidth * 3 / 4, c.TableHeight / 2} }
