package game

import (
	"math"
	"reflect"
	"testing"
)

// fly steps the table until it settles and returns the highest the given
// ball got off the slate.
func fly(tb testing.TB, t *Table, id int) (maxZ float64) {
	tb.Helper()
	for limit := int(30 / t.Cfg.Dt); !t.Settled(); limit-- {
		if limit == 0 {
			tb.Fatal("table did not settle within 30 s")
		}
		t.Step(t.Cfg.Dt)
		maxZ = math.Max(maxZ, t.Balls[id].Z)
	}
	return maxZ
}

func TestLevelCueStaysOnTheSlate(t *testing.T) {
	tb := emptyTable(DefaultConfig())
	tb.place(CueBall, Vec{0.5, 0.6}, Vec{})
	tb.place(3, Vec{0.8, 0.6}, Vec{})
	tb.ShootElevated(0, 1, Vec{}, 0)
	if z := fly(t, tb, CueBall); z != 0 {
		t.Errorf("a level cue lifted the cue ball %.4f m", z)
	}
	for _, im := range tb.Impacts {
		if im.Kind == ImpactSlate {
			t.Errorf("slate impact on a level shot: %+v", im)
		}
	}
}

func TestJumpClearsABlockingBall(t *testing.T) {
	// The blocker sits 15 cm in front of the cue ball, the target 45 cm
	// beyond it, all on one line.
	setup := func(elevation float64) *Table {
		tb := emptyTable(DefaultConfig())
		tb.place(CueBall, Vec{0.5, 0.6}, Vec{})
		tb.place(3, Vec{0.65, 0.6}, Vec{})
		tb.place(5, Vec{1.1, 0.6}, Vec{})
		tb.ShootElevated(0, 0.5, Vec{}, elevation)
		return tb
	}
	level := setup(0)
	runUntilSettled(t, level, 30)
	if first := firstContact(level.Events); first != 3 {
		t.Fatalf("level shot first hit ball %d, want the blocker", first)
	}

	jump := setup(45 * deg)
	maxZ := fly(t, jump, CueBall)
	if first := firstContact(jump.Events); first != 5 {
		t.Errorf("jump shot first hit ball %d, want 5 over the blocker; events %v", first, jump.Events)
	}
	if jump.Balls[3].Pos != (Vec{0.65, 0.6}) {
		t.Errorf("the jumped ball moved to %v", jump.Balls[3].Pos)
	}
	if maxZ < 2*jump.Cfg.BallRadius {
		t.Errorf("cue ball rose only %.3f m, not a ball's height", maxZ)
	}
	if maxZ > 0.25 {
		t.Errorf("cue ball rose %.3f m on a half-power jump", maxZ)
	}
}

func firstContact(events []Event) int {
	for _, e := range events {
		if e.Kind == FirstContact {
			return e.Ball
		}
	}
	return -1
}

func TestJumpBouncesLowerEachTimeAndSettles(t *testing.T) {
	tb := emptyTable(DefaultConfig())
	tb.place(CueBall, Vec{0.5, 0.6}, Vec{})
	tb.ShootElevated(0, 0.3, Vec{}, 50*deg)
	fly(t, tb, CueBall)

	var landings []float64
	for _, im := range tb.Impacts {
		if im.Kind == ImpactSlate {
			landings = append(landings, im.Speed)
		}
	}
	if len(landings) < 2 {
		t.Fatalf("landings %v, want the ball to bounce", landings)
	}
	for i := 1; i < len(landings); i++ {
		if landings[i] >= landings[i-1] {
			t.Errorf("landing %d at %.2f m/s, not slower than the one before (%.2f)", i, landings[i], landings[i-1])
		}
	}
	cue := tb.Balls[CueBall]
	if cue.Z != 0 || cue.VZ != 0 || cue.Pocketed {
		t.Errorf("cue ball did not come to rest on the cloth: %+v", cue)
	}
	if cue.Pos.X <= 0.5 {
		t.Errorf("cue ball ended at %v, behind where it started", cue.Pos)
	}
}

func TestElevationIsClamped(t *testing.T) {
	shoot := func(elevation float64) Ball {
		tb := emptyTable(DefaultConfig())
		tb.place(CueBall, Vec{0.5, 0.6}, Vec{})
		tb.ShootElevated(0, 0.5, Vec{}, elevation)
		return tb.Balls[CueBall]
	}
	if got, want := shoot(-1), shoot(0); got != want {
		t.Errorf("negative elevation: %+v, want a level shot %+v", got, want)
	}
	if got, want := shoot(2), shoot(MaxElevation); got != want {
		t.Errorf("elevation past the limit: %+v, want %+v", got, want)
	}
	if b := shoot(30 * deg); b.VZ <= 0 {
		t.Errorf("an elevated cue left the ball on the slate: %+v", b)
	}
}

func TestBallFliesOffTheTable(t *testing.T) {
	cfg := DefaultConfig()
	tb := emptyTable(cfg)
	tb.place(CueBall, Vec{1.0, 0.3}, Vec{})
	tb.ShootElevated(-math.Pi/2, 1, Vec{}, 45*deg) // straight at the top rail
	fly(t, tb, CueBall)
	if countEvents(tb.Events, BallOffTable, CueBall) != 1 {
		t.Fatalf("events %v, want the cue ball off the table", tb.Events)
	}
	if countEvents(tb.Events, CushionHit, CueBall) != 0 {
		t.Errorf("events %v: the cue ball flew over the cushion, it did not hit it", tb.Events)
	}
	if !tb.Balls[CueBall].Pocketed {
		t.Error("a ball off the table is still in play")
	}
}

func TestBallFlyingOverAPocketIsOffTheTable(t *testing.T) {
	cfg := DefaultConfig()
	// Straight over the side pocket: hard, it clears the pocket and comes
	// down beyond the table; gently, it drops in.
	for _, c := range []struct {
		power float64
		want  EventKind
	}{{1, BallOffTable}, {0.6, BallOffTable}, {0.3, BallPocketed}} {
		tb := emptyTable(cfg)
		tb.place(CueBall, Vec{cfg.TableWidth / 2, 0.4}, Vec{})
		tb.ShootElevated(-math.Pi/2, c.power, Vec{}, 45*deg)
		fly(t, tb, CueBall)
		if len(tb.Events) != 1 || tb.Events[0].Kind != c.want {
			t.Errorf("power %.1f: events %v, want %v", c.power, tb.Events, c.want)
		}
	}
}

func TestLowFlyingBallHitsTheCushion(t *testing.T) {
	cfg := DefaultConfig()
	tb := emptyTable(cfg)
	// Just above the cloth, well below the cushion nose, 2 cm from the top
	// rail and heading into it.
	tb.Balls[CueBall] = Ball{ID: CueBall, Pos: Vec{1.0, cfg.BallRadius + 0.02}, Vel: Vec{0, -2}, Z: 0.01}
	fly(t, tb, CueBall)
	if countEvents(tb.Events, CushionHit, CueBall) == 0 || countEvents(tb.Events, BallOffTable, CueBall) != 0 {
		t.Errorf("events %v, want a cushion hit and the ball kept on the table", tb.Events)
	}
}

func TestHighBallClearsTheCushionNose(t *testing.T) {
	cfg := DefaultConfig()
	tb := emptyTable(cfg)
	// Above the nose and rising: it crosses the rail line untouched.
	tb.Balls[CueBall] = Ball{ID: CueBall, Pos: Vec{1.0, cfg.BallRadius + 0.01}, Vel: Vec{0, -2}, Z: 0.05, VZ: 0.5}
	fly(t, tb, CueBall)
	if !reflect.DeepEqual(tb.Events, []Event{{Kind: BallOffTable, Ball: CueBall}}) {
		t.Errorf("events %v, want only the cue ball off the table", tb.Events)
	}
}

func TestFallingBallDrivesTheOneBelowIntoTheSlate(t *testing.T) {
	cfg := frictionless()
	tb := emptyTable(cfg)
	r := cfg.BallRadius
	// Ball 1 comes straight down onto ball 2, a little off its top.
	tb.place(2, Vec{1.0, 0.6}, Vec{})
	tb.Balls[1] = Ball{ID: 1, Pos: Vec{1.0 - r/2, 0.6}, Z: 2*r + 0.01, VZ: -1}
	before := tb.kineticEnergy() + 0.5*1*1
	var hit bool
	for i := 0; i < 600; i++ {
		tb.Step(cfg.Dt)
		if tb.Balls[2].Z < 0 || tb.Balls[1].Z < 0 {
			t.Fatalf("step %d: a ball sank into the slate: %+v %+v", i, tb.Balls[1], tb.Balls[2])
		}
		if tb.Balls[1].VZ > 0 && !hit {
			hit = true
			if tb.Balls[2].Vel.X <= 0 || tb.Balls[1].Vel.X >= 0 {
				t.Errorf("after contact: ball 1 vel %v, ball 2 vel %v; want them pushed apart", tb.Balls[1].Vel, tb.Balls[2].Vel)
			}
		}
	}
	if !hit {
		t.Fatal("the falling ball never bounced up off the other one")
	}
	if tb.Balls[2].Pocketed || tb.Balls[1].Pocketed {
		t.Error("a ball left play")
	}
	// Gravity adds energy as the ball falls; the bounces must not add more.
	after := 0.0
	for _, id := range []int{1, 2} {
		b := tb.Balls[id]
		after += b.Vel.Dot(b.Vel)/2 + b.VZ*b.VZ/2 + gravity*b.Z
	}
	if after > before+gravity*(2*r+0.01)+1e-9 {
		t.Errorf("energy %.4f after, more than %.4f before", after, before+gravity*(2*r+0.01))
	}
}

func TestSnapshotCarriesHeight(t *testing.T) {
	tb := emptyTable(DefaultConfig())
	tb.Balls[CueBall] = Ball{ID: CueBall, Pos: Vec{1, 0.6}, Z: 0.03}
	if got := tb.Snapshot(); len(got) != 1 || got[0].Z != 0.03 {
		t.Errorf("snapshot %+v, want the cue ball at height 0.03", got)
	}
	if tb.Settled() {
		t.Error("a ball in the air counts as settled")
	}
}

// offTable builds a shot whose first contact is first, with the given
// balls driven off the table.
func offTable(c Call, first int, off ...int) Shot {
	s := shot(c, first)
	for _, id := range off {
		s.Events = append(s.Events, Event{Kind: BallOffTable, Ball: id})
	}
	return s
}

func TestEightOffTheTable(t *testing.T) {
	t.Run("object ball is a foul and stays off", func(t *testing.T) {
		r := assignedRules(0)
		res := r.Resolve(offTable(noCall, 1, 2))
		if res.Foul != FoulOffTable || !reflect.DeepEqual(res.OffTable, []int{2}) || res.Made {
			t.Fatalf("result %+v, want an off-table foul", res)
		}
		if r.Turn != 1 || !r.BallInHand || r.Kitchen {
			t.Errorf("turn=%d ballInHand=%v kitchen=%v, want 1 true false", r.Turn, r.BallInHand, r.Kitchen)
		}
		if r.Remaining(GroupSolids) != 6 {
			t.Errorf("%d solids left, want the jumped one off for good", r.Remaining(GroupSolids))
		}
	})
	t.Run("cue ball is a foul and comes back", func(t *testing.T) {
		r := assignedRules(0)
		res := r.Resolve(offTable(noCall, 1, CueBall))
		if res.Foul != FoulOffTable || !res.CuePocketed || r.Turn != 1 || !r.BallInHand {
			t.Fatalf("result %+v turn %d bih %v, want an off-table foul with ball in hand", res, r.Turn, r.BallInHand)
		}
	})
	t.Run("8-ball loses", func(t *testing.T) {
		r := assignedRules(0, allSolids...)
		r.Resolve(offTable(into(pot), EightBall, EightBall))
		if r.Phase != PhaseGameOver || r.Winner != 1 || r.End != EndEightOff {
			t.Errorf("phase=%s winner=%d end=%s, want seat 1 to win by eight_off", r.Phase, r.Winner, r.End)
		}
	})
	t.Run("8-ball on the break is spotted", func(t *testing.T) {
		r := NewRules()
		r.Start(0)
		s := breakShot(5, 3)
		s.Events = append(s.Events, Event{Kind: BallOffTable, Ball: EightBall})
		res := r.Resolve(s)
		if r.Phase == PhaseGameOver || res.Respot != EightBall || res.Foul != FoulOffTable {
			t.Fatalf("result %+v phase %s, want a foul with the 8 spotted", res, r.Phase)
		}
		if r.Turn != 1 || !r.BallInHand || !r.Kitchen {
			t.Errorf("turn=%d ballInHand=%v kitchen=%v, want 1 true true", r.Turn, r.BallInHand, r.Kitchen)
		}
	})
}

func TestNineOffTheTable(t *testing.T) {
	r := nineAfterBreak(0)
	res := r.Resolve(offTable(noCall, 1, 4, NineBall))
	if res.Foul != FoulOffTable || res.Respot != NineBall || r.Winner != NoWinner {
		t.Fatalf("result %+v winner %d, want a foul with the 9 spotted", res, r.Winner)
	}
	if r.Turn != 1 || !r.BallInHand || r.Fouls[0] != 1 {
		t.Errorf("turn=%d ballInHand=%v fouls=%v, want 1 true [1 0]", r.Turn, r.BallInHand, r.Fouls)
	}
	if r.lowest() != 1 || !r.pocketed[4] || r.pocketed[NineBall] {
		t.Errorf("the 4 should stay off and the 9 come back")
	}

	push := nineRules(0)
	push.Resolve(breakShot(5, 2))
	if res := push.Resolve(offTable(pushOut, -1, CueBall)); res.Foul != FoulOffTable {
		t.Errorf("cue ball off the table on a push out: %+v, want a foul", res)
	}
}

func TestFreePlayOffTheTable(t *testing.T) {
	r := NewRules()
	r.Free = true
	r.Start(0)
	res := r.Resolve(offTable(noCall, 1, 3, CueBall))
	if res.Foul != FoulNone || !res.CuePocketed || res.Made || r.Turn != 0 {
		t.Errorf("result %+v turn %d, want no foul, the cue ball back and the same player", res, r.Turn)
	}
	if !r.pocketed[3] {
		t.Error("the jumped ball should stay off")
	}
}

func TestGameJumpOffTheTableRespotsTheCueBall(t *testing.T) {
	cfg := DefaultConfig()
	g := sparseGame(PhaseOpen, map[int]Vec{
		CueBall: {1.0, 0.3},
		1:       {2.0, 1.0},
	})
	if err := g.ShootElevated(0, up, 1, noCall, Vec{}, 45*deg); err != nil {
		t.Fatal(err)
	}
	res := tick(t, g)
	if res.Foul != FoulOffTable || !reflect.DeepEqual(res.OffTable, []int{CueBall}) {
		t.Fatalf("result %+v, want the cue ball off the table", res)
	}
	if cue := g.Table.Balls[CueBall]; cue.Pocketed || cue.Pos != cfg.HeadSpot() {
		t.Errorf("cue ball not back on the head spot: %+v", cue)
	}
	if g.Rules.Turn != 1 || !g.Rules.BallInHand {
		t.Errorf("turn=%d ballInHand=%v, want 1 true", g.Rules.Turn, g.Rules.BallInHand)
	}
	if err := g.ShootElevated(1, 0, 0.5, noCall, Vec{}, math.NaN()); err != ErrBadInput {
		t.Errorf("NaN elevation: %v, want ErrBadInput", err)
	}
}
