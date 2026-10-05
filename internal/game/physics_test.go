package game

import (
	"math"
	"testing"
)

// emptyTable returns a table with every ball out of play.
func emptyTable(cfg Config) *Table {
	t := NewTable(cfg)
	for i := range t.Balls {
		t.Balls[i].Pocketed = true
	}
	return t
}

func (t *Table) place(id int, pos, vel Vec) {
	t.Balls[id] = Ball{ID: id, Pos: pos, Vel: vel}
}

// frictionless returns the default config with rolling friction disabled.
func frictionless() Config {
	cfg := DefaultConfig()
	cfg.RollingDecel = 0
	cfg.StopSpeed = 0
	return cfg
}

func (t *Table) kineticEnergy() float64 {
	sum := 0.0
	for i := range t.Balls {
		if b := &t.Balls[i]; !b.Pocketed {
			sum += b.Vel.Dot(b.Vel) / 2
		}
	}
	return sum
}

func (t *Table) momentum() Vec {
	var sum Vec
	for i := range t.Balls {
		if b := &t.Balls[i]; !b.Pocketed {
			sum = sum.Add(b.Vel)
		}
	}
	return sum
}

// runUntilSettled steps the table and fails the test if it does not settle.
func runUntilSettled(tb testing.TB, t *Table, maxSeconds float64) int {
	tb.Helper()
	steps := 0
	for limit := int(maxSeconds / t.Cfg.Dt); !t.Settled(); steps++ {
		if steps >= limit {
			tb.Fatalf("table did not settle within %.0f s", maxSeconds)
		}
		t.Step(t.Cfg.Dt)
	}
	return steps
}

func countEvents(events []Event, kind EventKind, ball int) int {
	n := 0
	for _, e := range events {
		if e.Kind == kind && e.Ball == ball {
			n++
		}
	}
	return n
}

func near(a, b, tol float64) bool { return math.Abs(a-b) <= tol }

func TestDefaultConfigTimestep(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.MaxCueSpeed*cfg.Dt > cfg.BallRadius/2 {
		t.Fatalf("MaxCueSpeed*Dt = %g exceeds radius/2 = %g", cfg.MaxCueSpeed*cfg.Dt, cfg.BallRadius/2)
	}
}

func TestRack(t *testing.T) {
	cfg := DefaultConfig()
	tbl := NewTable(cfg)
	r := cfg.BallRadius

	if got := tbl.Balls[CueBall].Pos; got != cfg.HeadSpot() {
		t.Errorf("cue ball at %v, want head spot %v", got, cfg.HeadSpot())
	}
	if got := tbl.Balls[1].Pos; got != cfg.FootSpot() {
		t.Errorf("apex ball at %v, want foot spot %v", got, cfg.FootSpot())
	}
	for i := range tbl.Balls {
		b := tbl.Balls[i]
		if b.ID != i || b.Pocketed {
			t.Errorf("ball %d: id=%d pocketed=%v", i, b.ID, b.Pocketed)
		}
		if b.Pos.X < r || b.Pos.X > cfg.TableWidth-r || b.Pos.Y < r || b.Pos.Y > cfg.TableHeight-r {
			t.Errorf("ball %d outside the rails at %v", i, b.Pos)
		}
		for j := i + 1; j < NumBalls; j++ {
			if d := b.Pos.Dist(tbl.Balls[j].Pos); d < 2*r {
				t.Errorf("balls %d and %d overlap (dist %g)", i, j, d)
			}
		}
	}

	// The 8-ball is the middle ball of the third row, on the long axis.
	rowDX := (2*r + cfg.RackGap) * math.Sqrt(3) / 2
	want := Vec{cfg.FootSpot().X + 2*rowDX, cfg.TableHeight / 2}
	if d := want.Dist(tbl.Balls[EightBall].Pos); d > 1e-9 {
		t.Errorf("8-ball at %v, want the middle of the third row %v", tbl.Balls[EightBall].Pos, want)
	}
	// Back corners hold one solid and one stripe.
	if tbl.Balls[6].Pos.X != tbl.Balls[15].Pos.X || tbl.Balls[6].Pos.X <= tbl.Balls[EightBall].Pos.X {
		t.Errorf("balls 6 and 15 should be the back corners, got %v and %v", tbl.Balls[6].Pos, tbl.Balls[15].Pos)
	}
	if len(tbl.Snapshot()) != NumBalls {
		t.Errorf("snapshot has %d balls, want %d", len(tbl.Snapshot()), NumBalls)
	}
}

func TestBallAtRestStaysAtRest(t *testing.T) {
	tbl := NewTable(DefaultConfig())
	before := tbl.Balls
	for i := 0; i < 1000; i++ {
		tbl.Step(tbl.Cfg.Dt)
	}
	if tbl.Balls != before {
		t.Error("balls moved on a table with no shot")
	}
	if len(tbl.Events) != 0 {
		t.Errorf("unexpected events: %v", tbl.Events)
	}
	if !tbl.Settled() {
		t.Error("resting table is not settled")
	}
}

func TestHeadOnCollision(t *testing.T) {
	const v = 2.0
	tests := []struct {
		name        string
		restitution float64
	}{
		{"elastic swaps velocities", 1},
		{"default restitution", DefaultConfig().BallRestitution},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := frictionless()
			cfg.BallRestitution = tc.restitution
			tbl := emptyTable(cfg)
			tbl.place(CueBall, Vec{0.8, 0.6}, Vec{v, 0})
			tbl.place(1, Vec{1.2, 0.6}, Vec{})
			for i := 0; i < 300; i++ { // 0.5 s: contact happens after ~0.17 s
				tbl.Step(cfg.Dt)
			}

			e := tc.restitution
			cue, obj := tbl.Balls[CueBall].Vel, tbl.Balls[1].Vel
			if !near(cue.X, v*(1-e)/2, 1e-9) || !near(cue.Y, 0, 1e-9) {
				t.Errorf("cue velocity %v, want (%g, 0)", cue, v*(1-e)/2)
			}
			if !near(obj.X, v*(1+e)/2, 1e-9) || !near(obj.Y, 0, 1e-9) {
				t.Errorf("object velocity %v, want (%g, 0)", obj, v*(1+e)/2)
			}
			if n := countEvents(tbl.Events, FirstContact, 1); n != 1 {
				t.Errorf("got %d FirstContact{1} events, want 1 (events: %v)", n, tbl.Events)
			}
		})
	}
}

func TestGlancingCollisionConservesMomentum(t *testing.T) {
	tests := []struct {
		name   string
		offset float64 // lateral offset of the object ball, in ball radii
	}{
		{"thick", 0.5},
		{"half ball", 1.0},
		{"thin", 1.8},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := frictionless()
			tbl := emptyTable(cfg)
			tbl.place(CueBall, Vec{0.8, 0.6}, Vec{2, 0})
			tbl.place(1, Vec{1.2, 0.6 + tc.offset*cfg.BallRadius}, Vec{})
			before := tbl.momentum()
			for i := 0; i < 240; i++ { // 0.4 s: past contact, before any rail
				tbl.Step(cfg.Dt)
			}

			if countEvents(tbl.Events, FirstContact, 1) != 1 {
				t.Fatalf("balls never collided (events: %v)", tbl.Events)
			}
			after := tbl.momentum()
			if !near(after.X, before.X, 1e-9) || !near(after.Y, before.Y, 1e-9) {
				t.Errorf("momentum %v -> %v", before, after)
			}
			if obj := tbl.Balls[1].Vel; obj.X <= 0 || obj.Y <= 0 {
				t.Errorf("object ball should be driven forward and sideways, got %v", obj)
			}
			if cue := tbl.Balls[CueBall].Vel; cue.Y >= 0 {
				t.Errorf("cue ball should deflect away from the object ball, got %v", cue)
			}
		})
	}
}

func TestBallAimedAtPocketIsPocketed(t *testing.T) {
	cfg := DefaultConfig()
	w, h := cfg.TableWidth, cfg.TableHeight
	diag := 0.4 / math.Sqrt2
	tests := []struct {
		name   string
		pocket Vec
		start  Vec
	}{
		{"top-left", Vec{0, 0}, Vec{diag, diag}},
		{"top-middle", Vec{w / 2, 0}, Vec{w / 2, 0.4}},
		{"top-right", Vec{w, 0}, Vec{w - diag, diag}},
		{"bottom-left", Vec{0, h}, Vec{diag, h - diag}},
		{"bottom-middle", Vec{w / 2, h}, Vec{w / 2, h - 0.4}},
		{"bottom-right", Vec{w, h}, Vec{w - diag, h - diag}},
	}
	for i, tc := range tests { // listed in pocket-index order
		t.Run(tc.name, func(t *testing.T) {
			tbl := emptyTable(cfg)
			dir := tc.pocket.Sub(tc.start)
			tbl.place(3, tc.start, dir.Scale(1.5/dir.Len()))
			runUntilSettled(t, tbl, 30)

			if !tbl.Balls[3].Pocketed {
				t.Fatalf("ball not pocketed, ended at %v", tbl.Balls[3].Pos)
			}
			if n := countEvents(tbl.Events, BallPocketed, 3); n != 1 {
				t.Errorf("got %d BallPocketed{3} events, want 1 (events: %v)", n, tbl.Events)
			}
			for _, e := range tbl.Events {
				if e.Kind == BallPocketed && e.Pocket != i {
					t.Errorf("pocket index = %d, want %d", e.Pocket, i)
				}
			}
			if len(tbl.Snapshot()) != 0 {
				t.Errorf("pocketed ball still in snapshot: %v", tbl.Snapshot())
			}
		})
	}
}

func TestCushionReflects(t *testing.T) {
	cfg := frictionless()
	tbl := emptyTable(cfg)
	// Aimed at the bottom rail between the corner and side pockets.
	tbl.place(5, Vec{0.6, 1.0}, Vec{0.5, 2})
	for i := 0; i < 120; i++ {
		tbl.Step(cfg.Dt)
	}

	vel := tbl.Balls[5].Vel
	if !near(vel.X, 0.5, 1e-9) || !near(vel.Y, -2*cfg.CushionRestitution, 1e-9) {
		t.Errorf("velocity after bounce %v, want (0.5, %g)", vel, -2*cfg.CushionRestitution)
	}
	if n := countEvents(tbl.Events, CushionHit, 5); n != 1 {
		t.Errorf("got %d CushionHit{5} events, want 1 (events: %v)", n, tbl.Events)
	}
	if tbl.Balls[5].Pos.Y > cfg.TableHeight-cfg.BallRadius {
		t.Errorf("ball is past the rail at %v", tbl.Balls[5].Pos)
	}
}

func TestFrictionStopsBall(t *testing.T) {
	cfg := DefaultConfig()
	tbl := emptyTable(cfg)
	tbl.place(CueBall, Vec{0.5, 0.635}, Vec{1, 0})
	steps := runUntilSettled(t, tbl, 30)

	// v/a = 2.5 s to stop, v²/2a = 1.25 m travelled.
	if got := float64(steps) * cfg.Dt; !near(got, 2.5, 0.05) {
		t.Errorf("stopped after %.3f s, want ~2.5 s", got)
	}
	if got := tbl.Balls[CueBall].Pos.X - 0.5; !near(got, 1.25, 0.01) {
		t.Errorf("travelled %.4f m, want ~1.25 m", got)
	}
}

func TestMaxSpeedDoesNotTunnel(t *testing.T) {
	cfg := DefaultConfig()
	tbl := emptyTable(cfg)
	tbl.place(CueBall, Vec{0.5, 0.635}, Vec{})
	tbl.place(1, Vec{1.5, 0.635}, Vec{})
	tbl.Shoot(0, 1)
	for i := 0; i < 300; i++ {
		tbl.Step(cfg.Dt)
	}
	if countEvents(tbl.Events, FirstContact, 1) != 1 {
		t.Fatalf("cue ball passed through the object ball (events: %v)", tbl.Events)
	}
	if tbl.Balls[CueBall].Pos.X >= tbl.Balls[1].Pos.X {
		t.Errorf("cue ball at %v ended up past object ball at %v", tbl.Balls[CueBall].Pos, tbl.Balls[1].Pos)
	}
}

func TestShootClampsPowerAndResetsEvents(t *testing.T) {
	cfg := DefaultConfig()
	tbl := NewTable(cfg)
	tbl.Events = append(tbl.Events, Event{Kind: CushionHit, Ball: 3})
	tbl.Shoot(math.Pi/2, 7)
	if len(tbl.Events) != 0 {
		t.Errorf("Shoot kept old events: %v", tbl.Events)
	}
	vel := tbl.Balls[CueBall].Vel
	if !near(vel.X, 0, 1e-9) || !near(vel.Y, cfg.MaxCueSpeed, 1e-9) {
		t.Errorf("cue velocity %v, want (0, %g)", vel, cfg.MaxCueSpeed)
	}
	tbl.Shoot(0, -1)
	if !tbl.Settled() {
		t.Errorf("negative power should clamp to 0, got velocity %v", tbl.Balls[CueBall].Vel)
	}
}

func TestBreakEnergyNeverIncreasesAndSettles(t *testing.T) {
	for _, power := range []float64{0.3, 0.7, 1} {
		tbl := NewTable(DefaultConfig())
		tbl.Shoot(0.02, power)
		prev := tbl.kineticEnergy()
		steps := 0
		for limit := int(120 / tbl.Cfg.Dt); !tbl.Settled(); steps++ {
			if steps >= limit {
				t.Fatalf("power %.1f: break did not settle within 120 s", power)
			}
			tbl.Step(tbl.Cfg.Dt)
			ke := tbl.kineticEnergy()
			if ke > prev+1e-12 {
				t.Fatalf("power %.1f: kinetic energy rose %g -> %g at step %d", power, prev, ke, steps)
			}
			prev = ke
		}

		if countEvents(tbl.Events, FirstContact, 1) != 1 {
			t.Errorf("power %.1f: expected first contact with the apex ball", power)
		}
		first := 0
		for _, e := range tbl.Events {
			if e.Kind == FirstContact {
				first++
			}
		}
		if first != 1 {
			t.Errorf("power %.1f: got %d FirstContact events, want exactly 1", power, first)
		}
		r := tbl.Cfg.BallRadius
		for _, b := range tbl.Balls {
			if b.Pocketed {
				continue
			}
			if b.Pos.X < r-1e-9 || b.Pos.X > tbl.Cfg.TableWidth-r+1e-9 ||
				b.Pos.Y < r-1e-9 || b.Pos.Y > tbl.Cfg.TableHeight-r+1e-9 {
				t.Errorf("power %.1f: ball %d ended outside the rails at %v", power, b.ID, b.Pos)
			}
		}
	}
}

func TestBreakIsDeterministic(t *testing.T) {
	run := func() [NumBalls]Ball {
		tbl := NewTable(DefaultConfig())
		tbl.Shoot(0.01, 0.9)
		runUntilSettled(t, tbl, 120)
		return tbl.Balls
	}
	if a, b := run(), run(); a != b {
		t.Error("two identical breaks produced different results")
	}
}

func TestHeadStringEvents(t *testing.T) {
	cfg := DefaultConfig()
	mid := cfg.TableHeight / 2
	tests := []struct {
		name          string
		cue, object   Vec
		wantInKitchen bool // the contacted ball is above the head string
		wantCrossed   bool // the cue ball crossed the head string before contact
	}{
		{"object ball in the kitchen", Vec{0.2, mid}, Vec{0.45, mid}, true, false},
		{"object ball past the head string", Vec{0.2, mid}, Vec{1.2, mid}, false, true},
		{"cue ball starting on the head string", cfg.HeadSpot(), Vec{1.2, mid}, false, true},
		{"cue ball starting past the head string", Vec{0.9, mid}, Vec{1.2, mid}, false, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tbl := emptyTable(cfg)
			tbl.place(CueBall, tc.cue, Vec{})
			tbl.place(4, tc.object, Vec{})
			tbl.Shoot(0, 0.6)
			runUntilSettled(t, tbl, 60)

			crossed, crossedAt, contactAt := 0, -1, -1
			for i, e := range tbl.Events {
				switch e.Kind {
				case HeadStringCrossed:
					crossed++
					crossedAt = i
				case FirstContact:
					contactAt = i
					if e.InKitchen != tc.wantInKitchen {
						t.Errorf("FirstContact.InKitchen = %v, want %v", e.InKitchen, tc.wantInKitchen)
					}
				}
			}
			if contactAt < 0 {
				t.Fatalf("no first contact (events: %v)", tbl.Events)
			}
			if crossed > 1 {
				t.Errorf("got %d HeadStringCrossed events, want at most 1", crossed)
			}
			if got := crossedAt >= 0 && crossedAt < contactAt; got != tc.wantCrossed {
				t.Errorf("crossed before contact = %v, want %v (events: %v)", got, tc.wantCrossed, tbl.Events)
			}
		})
	}
}

// TestSidePocketRejectsShallowAngles: a side pocket takes a ball coming in
// steeply and spits out one that arrives along the rail, which is what the
// noses and the near-vertical jaws of a real side pocket do.
func TestSidePocketRejectsShallowAngles(t *testing.T) {
	cfg := DefaultConfig()
	mouth := Vec{cfg.TableWidth / 2, 0}
	for _, tc := range []struct {
		deg  float64 // angle between the path and the top rail
		want bool
	}{
		{90, true}, {60, true}, {40, true}, {15, false}, {8, false},
	} {
		tbl := emptyTable(cfg)
		rad := tc.deg * math.Pi / 180
		dir := Vec{math.Cos(rad), -math.Sin(rad)}
		start := mouth.Sub(dir.Scale(0.5))
		tbl.place(3, start, dir.Scale(2))
		runUntilSettled(t, tbl, 30)
		if tbl.Balls[3].Pocketed != tc.want {
			t.Errorf("ball at %.0f° to the rail: pocketed=%v, want %v (ended at %v)", tc.deg, tbl.Balls[3].Pocketed, tc.want, tbl.Balls[3].Pos)
		}
	}
}

// TestCornerPocketAcceptsOffAxisBalls: corner pockets are forgiving; a ball
// entering well off the diagonal still drops.
func TestCornerPocketAcceptsOffAxisBalls(t *testing.T) {
	cfg := DefaultConfig()
	for _, deg := range []float64{45, 25, 65} {
		tbl := emptyTable(cfg)
		rad := deg * math.Pi / 180
		dir := Vec{-math.Cos(rad), -math.Sin(rad)} // toward the top-left corner
		a := cfg.CornerMouth / math.Sqrt2
		start := Vec{a / 2, a / 2}.Sub(dir.Scale(0.4))
		tbl.place(3, start, dir.Scale(2))
		runUntilSettled(t, tbl, 30)
		if !tbl.Balls[3].Pocketed {
			t.Errorf("ball entering the corner at %.0f°: not pocketed, ended at %v", deg, tbl.Balls[3].Pos)
		}
	}
}

func TestPocketGeometryMatchesSpec(t *testing.T) {
	cfg := DefaultConfig()
	tbl := NewTable(cfg)
	if got := cfg.TableWidth; !near(got, 2.54, 1e-9) {
		t.Errorf("playing surface length %v, want 2.54 m (100 in)", got)
	}
	if got := 2 * cfg.BallRadius; !near(got, 0.05715, 1e-9) {
		t.Errorf("ball diameter %v, want 57.15 mm", got)
	}
	// Corner noses are CornerMouth apart, side noses SideMouth apart.
	a := cfg.CornerMouth / math.Sqrt2
	if d := (Vec{a, 0}).Dist(Vec{0, a}); !near(d, cfg.CornerMouth, 1e-12) {
		t.Errorf("corner mouth %v, want %v", d, cfg.CornerMouth)
	}
	if len(tbl.segments) != 18 {
		t.Fatalf("got %d segments, want 6 cushions + 12 jaws", len(tbl.segments))
	}
	// Every jaw leaves room for a ball at its far end.
	for i := 0; i < len(tbl.segments); i += 3 {
		j1, j2 := tbl.segments[i+1], tbl.segments[i+2]
		_ = j2
		if l := j1.a.Dist(j1.b); l < cfg.BallRadius {
			t.Errorf("jaw %d is only %v long", i+1, l)
		}
	}
	mouths, axes := tbl.Pockets()
	if mouths[1] != (Vec{cfg.TableWidth / 2, 0}) || axes[1] != (Vec{0, -1}) {
		t.Errorf("top-middle pocket = %v %v", mouths[1], axes[1])
	}
	// A ball may rest near a pocket but not in its mouth.
	if !tbl.canPlace(CueBall, Vec{0.08, 0.08}) {
		t.Error("cannot place a ball near the corner pocket")
	}
	if tbl.canPlace(CueBall, Vec{0.03, 0.03}) {
		t.Error("placed a ball inside the corner pocket mouth")
	}
	if !tbl.canPlace(CueBall, Vec{cfg.TableWidth / 2, cfg.BallRadius}) {
		t.Error("cannot place a ball on the surface in front of the side pocket")
	}
	if tbl.canPlace(CueBall, Vec{cfg.TableWidth / 2, cfg.BallRadius / 2}) {
		t.Error("placed a ball hanging over the side pocket mouth")
	}
}

func TestFollowAndDraw(t *testing.T) {
	const v = 2.0
	run := func(spinY float64) (cue, obj Vec) {
		cfg := frictionless()
		tbl := emptyTable(cfg)
		tbl.place(CueBall, Vec{0.8, 0.6}, Vec{})
		tbl.place(1, Vec{1.2, 0.6}, Vec{})
		tbl.ShootSpin(0, v/cfg.MaxCueSpeed, Vec{0, spinY})
		for i := 0; i < 300; i++ {
			tbl.Step(cfg.Dt)
		}
		return tbl.Balls[CueBall].Vel, tbl.Balls[1].Vel
	}
	e := DefaultConfig().BallRestitution
	stun := v * (1 - e) / 2
	if cue, _ := run(0); !near(cue.X, stun, 1e-9) {
		t.Errorf("centre hit: cue velocity %v, want the stun %g", cue, stun)
	}
	if cue, obj := run(1); cue.X <= stun+0.3 || obj.X <= 0 {
		t.Errorf("top spin: cue %v should follow well past %g, object %v should go on", cue, stun, obj)
	}
	if cue, obj := run(-1); cue.X >= -0.3 || obj.X <= 0 {
		t.Errorf("bottom spin: cue %v should draw back, object %v should go on", cue, obj)
	}
	// A thin hit converts little spin: the cue ball keeps most of its speed
	// and gains little along its original line.
	cfg := frictionless()
	tbl := emptyTable(cfg)
	tbl.place(CueBall, Vec{0.8, 0.6}, Vec{})
	tbl.place(1, Vec{1.2, 0.6 + 1.9*cfg.BallRadius}, Vec{})
	tbl.ShootSpin(0, v/cfg.MaxCueSpeed, Vec{0, -1})
	for i := 0; i < 300; i++ {
		tbl.Step(cfg.Dt)
	}
	if cue := tbl.Balls[CueBall].Vel; cue.X < 0.5*v {
		t.Errorf("thin hit with draw: cue velocity %v should stay mostly forward", cue)
	}
	if sp := tbl.Balls[CueBall].Spin.Y; sp > -0.5 {
		t.Errorf("thin hit should keep most of the spin, got %v", sp)
	}
}

func TestSideSpinKicksOffTheCushion(t *testing.T) {
	run := func(spinX float64) Vec {
		cfg := frictionless()
		tbl := emptyTable(cfg)
		tbl.place(CueBall, Vec{1.0, 1.0}, Vec{})
		tbl.ShootSpin(math.Pi/2, 2/cfg.MaxCueSpeed, Vec{spinX, 0}) // straight down at the bottom rail
		for i := 0; i < 200; i++ {
			tbl.Step(cfg.Dt)
		}
		return tbl.Balls[CueBall].Vel
	}
	if v := run(0); !near(v.X, 0, 1e-9) || v.Y >= 0 {
		t.Errorf("no spin: velocity after the rail %v, want straight back", v)
	}
	// Moving down the screen the shooter's right is -x.
	if v := run(1); v.X >= -0.1 || v.Y >= 0 {
		t.Errorf("right english: velocity after the rail %v, want a kick toward -x", v)
	}
	if v := run(-1); v.X <= 0.1 || v.Y >= 0 {
		t.Errorf("left english: velocity after the rail %v, want a kick toward +x", v)
	}
}

func TestSpinFadesWithDistanceAndIsClamped(t *testing.T) {
	cfg := frictionless()
	tbl := emptyTable(cfg)
	tbl.place(CueBall, Vec{0.2, 0.6}, Vec{})
	tbl.ShootSpin(0, 1, Vec{3, 4}) // clamped to the unit disc
	if sp := tbl.Balls[CueBall].Spin; !near(sp.Len(), 1, 1e-9) || !near(sp.X/sp.Y, 0.75, 1e-9) {
		t.Fatalf("spin after clamping = %v, want (0.6, 0.8)", sp)
	}
	for i := 0; i < 60; i++ { // 0.1 s at 8 m/s: 0.8 m
		tbl.Step(cfg.Dt)
	}
	sp := tbl.Balls[CueBall].Spin
	wantY := 0.8 * math.Exp(-0.8/cfg.SpinDecayLength)
	wantX := 0.6 * math.Exp(-0.8/(2*cfg.SpinDecayLength))
	if !near(sp.Y, wantY, 0.02) || !near(sp.X, wantX, 0.02) {
		t.Errorf("spin after 0.8 m = %v, want about (%.3f, %.3f)", sp, wantX, wantY)
	}
}
