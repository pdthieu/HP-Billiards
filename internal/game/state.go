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
	// NineBall is the id of the 9-ball, the last ball of a 9-ball rack.
	NineBall = 9
	// NumPockets is the number of pockets. Pocket indices run 0–5: top-left,
	// top-middle, top-right, bottom-left, bottom-middle, bottom-right.
	NumPockets = 6
)

// The three balls of a carom game (3-cushion). The other ids are out of
// play. Each player strikes their own cue ball: the breaker the white, the
// other player the yellow (UMB).
const (
	CaromWhite  = CueBall
	CaromYellow = 1
	CaromRed    = 2
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
	// Roll is the velocity the ball's spin about horizontal axes would give
	// it if it rolled without slipping: Roll == Vel is natural roll, Roll
	// ahead of Vel is top spin (follow), Roll behind or against Vel is back
	// spin (draw). While Roll != Vel the ball slides and cloth friction pulls
	// the two together; see Table.integrate.
	Roll Vec
	// Spin is the english about the vertical axis as the speed of the ball's
	// equator, R·ωz, positive for a counter-clockwise turn seen from above
	// in the table's frame (right english as the shooter sees it is
	// negative). It fades with the distance rolled and is partly spent
	// gripping a cushion; see Table.collideCushions.
	Spin float64
	// Z is how far the ball is off the slate (the height of its lowest
	// point, 0 on the cloth) and VZ its vertical velocity, up positive. A
	// ball with either set is in the air: it flies free of the cloth, clears
	// cushions and balls it passes above, and bounces when it comes down.
	// Only a jump shot (Table.ShootElevated) or a ball landing on another
	// puts a ball in the air.
	Z, VZ float64
}

// Airborne reports whether the ball is off the slate or about to leave it.
func (b *Ball) Airborne() bool { return b.Z > 0 || b.VZ != 0 }

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
	// BallOffTable: Ball flew over a cushion and left the table. It is out
	// of play like a pocketed ball.
	BallOffTable
	// BallContact: the cue ball touched Ball. Recorded for every contact,
	// the first one too (which also makes a FirstContact).
	BallContact
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
	case BallOffTable:
		return "BallOffTable"
	case BallContact:
		return "BallContact"
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
	// Rail is the cushion of a CushionHit on a table without pockets: 0 top,
	// 1 bottom, 2 left (the head rail), 3 right (the foot rail).
	Rail int
}

// ImpactKind says what made an Impact.
type ImpactKind uint8

const (
	ImpactBall    ImpactKind = iota // two balls
	ImpactCushion                   // a ball on a cushion or jaw
	ImpactPocket                    // a ball dropping into a pocket
	ImpactSlate                     // a ball in the air coming down on the cloth
)

// Impact is a contact loud enough to hear, for the clients' sound: when it
// happened (seconds since the shot was struck) and how hard (the closing
// speed along the contact normal, or the ball's speed into a pocket, m/s).
type Impact struct {
	T     float64
	Kind  ImpactKind
	Speed float64
}

// minImpact is the slowest contact recorded as an Impact; balls resting
// against each other or a cushion nudge at less than this.
const minImpact = 0.02 // m/s

// BallState is the JSON-serializable position of a ball that is on the table.
// Z is its height off the slate (Ball.Z), left out while it is on the cloth.
type BallState struct {
	ID int     `json:"id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
	Z  float64 `json:"z,omitempty"`
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

	BallRestitution float64 // ball–ball

	// Cushions (and pocket jaws). The normal speed rebounds with
	// CushionRestitution up to CushionFastSpeed and with CushionRestitutionFast
	// at MaxCueSpeed, linearly in between: rubber gives back less of a hard
	// hit (Han 2005; Mathavan 2010 only vouch for a rigid cushion below
	// 2.5 m/s). CushionFriction acts at the contact point, which sits
	// CushionNose ball diameters above the slate (WPA: 62.5–64.5 %), so it
	// throws a spinning ball along the rail and takes speed off an oblique
	// rebound.
	CushionRestitution     float64
	CushionRestitutionFast float64
	CushionFastSpeed       float64
	CushionFriction        float64
	CushionNose            float64

	// Pocket geometry, WPA equipment specifications. The playing surface is
	// measured between cushion noses; a pocket is the gap between two noses.
	CornerMouth    float64 // distance between the noses of a corner pocket
	SideMouth      float64 // same for a side pocket
	CornerJawAngle float64 // angle between a cushion and the jaw past its nose, radians
	SideJawAngle   float64
	CornerShelf    float64 // from the mouth line to where a ball drops, along the pocket axis
	SideShelf      float64

	// Cloth friction. A ball slides until its spin matches its speed and
	// then rolls: SlidingFriction (μ) decelerates a sliding ball at μg while
	// its spin catches up, RollingFriction a rolling one. A rolling ball
	// slower than StopSpeed is stopped dead.
	SlidingFriction float64
	RollingFriction float64
	StopSpeed       float64

	// Spin. TipOffset is where the rim of the client's spin pad lands on the
	// cue ball, as a fraction of the radius (the miscue limit is about ½ R);
	// a tip offset of b·R starts the ball with a surface speed 2.5·b times
	// its speed, as roll or as side spin. SpinDecayLength is the distance
	// over which side spin fades by a factor e. Side spin has no squirt,
	// swerve or throw.
	TipOffset       float64
	SpinDecayLength float64

	// Jumping. A ball driven into the slate, by an elevated cue or by coming
	// down from the air, bounces back up with SlateRestitution of its
	// speed into it; the cloth's SlidingFriction acts during the bounce.
	SlateRestitution float64

	// RackGap is the space left between neighbouring balls in the rack so a
	// resting rack never registers as overlapping.
	RackGap float64

	// NoPockets makes a carom table: four unbroken cushions and nothing to
	// drop into. See CaromConfig.
	NoPockets bool
}

const (
	inch    = 0.0254
	gravity = 9.81 // m/s²
)

// DefaultConfig returns a WPA-specification 9 ft table: 100 × 50 in playing
// surface between the cushion noses, 2¼ in balls, corner pockets 4 9⁄16 in
// wide with 142° jaws and a 1¾ in shelf, side pockets 5 1⁄16 in wide with
// 104° jaws and a ¼ in shelf (the middle of each permitted range). 600 Hz
// physics, 60 Hz ticks.
//
// Restitution and friction are not in the specification. The values are
// measured ones (Alciatore's property table, Mathavan 2010, pooltool): 0.95
// ball–ball (0.92–0.98), μ 0.2 sliding, 0.015 rolling (0.005–0.015: the
// slow end, like napped or worn cloth on a humid day, which is what players
// here are used to; fast worsted tournament cloth is nearer 0.01), and a
// cushion that, with μ 0.2 at the nose, sends a
// rolling ball back with about half its speed as high-speed video shows.
// A ball bounces off the slate with about half the speed it hits it with
// (Alciatore, jump shot analysis: 0.5).
func DefaultConfig() Config {
	return Config{
		TableWidth:      100 * inch,
		TableHeight:     50 * inch,
		BallRadius:      2.25 / 2 * inch,
		MaxCueSpeed:     8,
		Dt:              1.0 / 600,
		Substeps:        10,
		BallRestitution: 0.95,

		CushionRestitution:     0.78,
		CushionRestitutionFast: 0.6,
		CushionFastSpeed:       2.5,
		CushionFriction:        0.2,
		CushionNose:            0.635,

		CornerMouth:     4.5625 * inch,
		SideMouth:       5.0625 * inch,
		CornerJawAngle:  142 * math.Pi / 180,
		SideJawAngle:    104 * math.Pi / 180,
		CornerShelf:     1.75 * inch,
		SideShelf:       0.25 * inch,
		SlidingFriction: 0.2,
		RollingFriction: 0.015,
		StopSpeed:       0.01,
		TipOffset:       0.5,
		SpinDecayLength: 2.5,
		RackGap:         0.0005,

		SlateRestitution: 0.5,
	}
}

// CaromConfig returns the table a 3-cushion game is played on, built from
// base (whose physics tuning it keeps): a UMB match table, 2.84 × 1.42 m
// between the cushion noses, no pockets, 61.5 mm balls and cushions 37 mm
// high, about 60 % of the ball. Carom cloth is thin and the slate heated,
// so a ball rolls half as far again as on pool cloth: two thirds of base's
// rolling friction (0.01 from the default 0.015).
func CaromConfig(base Config) Config {
	c := base
	c.TableWidth, c.TableHeight = 2.84, 1.42
	c.BallRadius = 0.0615 / 2
	c.CushionNose = 0.6
	c.RollingFriction = base.RollingFriction * 2 / 3
	c.NoPockets = true
	return c
}

// CenterSpot is the middle of the table, the third carom spot.
func (c Config) CenterSpot() Vec { return Vec{c.TableWidth / 2, c.TableHeight / 2} }

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
	Decision   *Decision   `json:"decision"`   // pending choice, or null
	Winner     int         `json:"winner"`     // seat, or -1
	Mode       Mode        `json:"mode"`
	Fouls      [2]int      `json:"fouls"`   // 9-ball: consecutive fouls by seat
	PushOut    bool        `json:"pushOut"` // 9-ball: Turn may push out on this shot
	// Carom: the points the game is played to (0: no end) and the score;
	// nil in the other modes.
	Target int         `json:"target,omitempty"`
	Carom  *CaromScore `json:"carom,omitempty"`
}

// Errors returned by Game and Rules when an action is not allowed.
var (
	ErrWrongPhase   = errors.New("the game is not in play")
	ErrBallsMoving  = errors.New("balls are still moving")
	ErrNotYourTurn  = errors.New("not your turn")
	ErrNoBallInHand = errors.New("you do not have ball in hand")
	ErrBadPlacement = errors.New("the cue ball cannot be placed there")
	ErrBadInput     = errors.New("invalid angle or power")
	ErrBadCall      = errors.New("call a pocket for the 8-ball, or a safety")
	ErrNoDecision   = errors.New("there is no decision to make")
	ErrBadOption    = errors.New("that option is not available")
	ErrNoPushOut    = errors.New("a push out is only allowed on the shot right after the break")
)

// Game ties the physics table to the rules. Like Table it must be driven by a
// single goroutine.
type Game struct {
	Table *Table
	Rules *Rules

	cfg Config // the pool table; carom is played on CaromConfig(cfg)

	shooting bool // a shot is in progress and has not been resolved yet
	shot     Shot // the shot in progress
	// The first collision of the last Tick, for an extra snapshot: when it
	// happened (seconds into the tick) and where every ball was then.
	collisionT     float64
	collisionBalls []BallState
	// cueInKitchen: the cue ball sits where kitchen ball-in-hand put it, so
	// the next shot is "played from above the head string" (WPA 3.11).
	cueInKitchen bool
}

// NewGame returns a game waiting in the lobby phase.
func NewGame(cfg Config) *Game {
	return &Game{Table: NewTable(cfg), Rules: NewRules(), cfg: cfg}
}

// SetMode chooses the game the next Start begins. In the lobby the table is
// racked for it at once, so the players see what they are about to play. A
// change between pool and carom swaps the table, at once in the lobby and
// otherwise at the next Start.
func (g *Game) SetMode(m Mode) {
	g.Rules.Mode = m
	if g.Rules.Phase == PhaseLobby {
		g.rack()
	}
}

// SetTarget sets the points a carom game is played to, from the next Start;
// 0 plays without an end.
func (g *Game) SetTarget(points int) { g.Rules.Target = points }

// SetFree turns the rules off (practice) or back on, from the next Start.
func (g *Game) SetFree(free bool) { g.Rules.Free = free }

// Start racks the balls and begins a new game with breaker to shoot first.
func (g *Game) Start(breaker int) {
	g.Rules.Start(breaker)
	g.rack()
}

// rack sets up a fresh, randomly ordered rack for the mode, so every game
// starts from a different pattern.
func (g *Game) rack() {
	if carom := g.Rules.Mode == ModeCarom; carom != g.Table.Cfg.NoPockets {
		cfg := g.cfg
		if carom {
			cfg = CaromConfig(cfg)
		}
		g.Table = NewTable(cfg)
	}
	switch g.Rules.Mode {
	case ModeCarom:
		g.rackCarom()
	case ModeNine:
		g.Table.RackNineOrder(NineOrder())
	default:
		g.Table.RackEight(EightOrder())
	}
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

// Shoot strikes the cue ball for seat with a centre-ball hit. power is
// clamped to [0,1]. call is the called ball and pocket (or safety); it is
// ignored on the break.
func (g *Game) Shoot(seat int, angle, power float64, call Call) error {
	return g.ShootSpin(seat, angle, power, call, Vec{})
}

// ShootSpin is Shoot with english: spin is the cue tip offset, see Ball.Spin.
// It is clamped to the unit disc.
func (g *Game) ShootSpin(seat int, angle, power float64, call Call, spin Vec) error {
	return g.ShootElevated(seat, angle, power, call, spin, 0)
}

// ShootElevated is ShootSpin with the cue raised elevation radians above
// the horizontal, a jump shot; see Table.ShootElevated.
func (g *Game) ShootElevated(seat int, angle, power float64, call Call, spin Vec, elevation float64) error {
	if err := g.checkTurn(seat); err != nil {
		return err
	}
	if math.IsNaN(angle) || math.IsInf(angle, 0) || math.IsNaN(power) || math.IsNaN(elevation) ||
		math.IsNaN(spin.X) || math.IsInf(spin.X, 0) || math.IsNaN(spin.Y) || math.IsInf(spin.Y, 0) {
		return ErrBadInput
	}
	if err := g.Rules.CheckCall(call); err != nil {
		return err
	}
	g.shot = Shot{Call: call, FromKitchen: g.Rules.BallInHand && g.Rules.Kitchen && g.cueInKitchen}
	g.Table.Cue = g.Rules.CueBall()
	g.Table.ShootElevated(angle, power, spin, elevation)
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

// TimeFoul ends the turn of seat, the shooter, whose shot clock ran out. See
// Rules.TimeFoul.
func (g *Game) TimeFoul(seat int) error {
	if err := g.checkTurn(seat); err != nil {
		return err
	}
	g.Rules.TimeFoul()
	return nil
}

// PlaceFree moves ball id, which must be on the table, to pos for practice:
// the cue ball with or without ball in hand and anywhere, object balls to
// set up a position. The rules are untouched; a cue ball left above the head
// string while the kitchen restriction applies still counts as played from
// the kitchen.
func (g *Game) PlaceFree(id int, pos Vec) error {
	switch {
	case g.shooting:
		return ErrBallsMoving
	case g.Rules.Phase == PhaseLobby:
		return ErrWrongPhase
	case id < 0 || id >= NumBalls || g.Table.Balls[id].Pocketed:
		return ErrBadPlacement
	}
	if !g.Table.PlaceBall(id, pos) {
		return ErrBadPlacement
	}
	if id == CueBall {
		g.cueInKitchen = g.Rules.Kitchen && pos.X <= g.Table.Cfg.HeadString()
	}
	return nil
}

// Snapshot is a saved position: balls, rules and whose shot it is. Taken
// with Save between shots, it brings the game back with Restore.
type Snapshot struct {
	balls        [NumBalls]Ball
	rules        Rules
	cueInKitchen bool
}

// Save records the game as it stands; balls must not be moving.
func (g *Game) Save() Snapshot {
	s := Snapshot{balls: g.Table.Balls, rules: *g.Rules, cueInKitchen: g.cueInKitchen}
	if d := g.Rules.Decision; d != nil {
		s.rules.Decision = &Decision{Seat: d.Seat, Options: append([]Option(nil), d.Options...)}
	}
	return s
}

// Restore puts the game back where Save found it.
func (g *Game) Restore(s Snapshot) {
	g.Table.Balls = s.balls
	g.Table.ClearEvents()
	*g.Rules = s.rules
	if d := s.rules.Decision; d != nil {
		g.Rules.Decision = &Decision{Seat: d.Seat, Options: append([]Option(nil), d.Options...)}
	}
	g.cueInKitchen = s.cueInKitchen
	g.shooting = false
}

// Choose answers the pending decision for seat.
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
	g.collisionBalls = nil
	for i := 0; i < g.Table.Cfg.Substeps && !g.Table.Settled(); i++ {
		g.Table.Step(g.Table.Cfg.Dt)
		if g.Table.Collided && g.collisionBalls == nil {
			g.collisionT = float64(i+1) * g.Table.Cfg.Dt
			g.collisionBalls = g.Table.Snapshot()
		}
	}
	if !g.Table.Settled() {
		return nil
	}
	g.shooting = false
	g.shot.Events = g.Table.Events
	res := g.Rules.Resolve(g.shot)
	g.cueInKitchen = false
	if g.Rules.Mode == ModeCarom {
		g.spotCarom(&res)
		return &res
	}
	if res.Respot != 0 {
		g.Table.Spot(res.Respot, g.Table.Cfg.FootSpot(), 1)
	}
	if res.CuePocketed && g.Rules.Phase != PhaseGameOver {
		// The incoming player has ball in hand; the head spot is only a
		// default. It is inside the kitchen, which every scratch on the
		// break leads to.
		g.Table.Spot(CueBall, g.Table.Cfg.HeadSpot(), -1)
		g.cueInKitchen = true
	}
	return &res
}

// Collision returns the positions right after the first collision of the
// last Tick and when it happened, in seconds into that tick, or ok = false
// if nothing collided. Linear interpolation between regular snapshots would
// cut the corner of such a bounce; a snapshot at that moment keeps it.
func (g *Game) Collision() (t float64, balls []BallState, ok bool) {
	return g.collisionT, g.collisionBalls, g.collisionBalls != nil
}

// State returns the full serializable state.
func (g *Game) State() State {
	st := State{
		Balls:      g.Table.Snapshot(),
		Phase:      g.Rules.Phase,
		Turn:       g.Rules.Turn,
		Groups:     g.Rules.Groups,
		BallInHand: g.Rules.BallInHand,
		Kitchen:    g.Rules.Kitchen,
		Decision:   g.Rules.Decision,
		Winner:     g.Rules.Winner,
		Mode:       g.Rules.Mode,
		Fouls:      g.Rules.Fouls,
		PushOut:    g.Rules.PushOut,
	}
	if g.Rules.Mode == ModeCarom {
		st.Target = g.Rules.Target
		c := g.Rules.Carom
		st.Carom = &c
	}
	return st
}
