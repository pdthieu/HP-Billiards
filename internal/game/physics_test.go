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

// frictionless returns the default config with cloth friction disabled: balls
// neither slow down nor pick up roll, so velocities only change at impacts.
func frictionless() Config {
	cfg := DefaultConfig()
	cfg.SlidingFriction = 0
	cfg.RollingFriction = 0
	cfg.CushionFriction = 0
	cfg.StopSpeed = 0
	return cfg
}

// kineticEnergy is the translational plus rotational energy per unit mass:
// ½v² + ½·(2⁄5)·(Roll/R)²·R² = ½v² + Roll²/5. Cloth friction can turn spin
// back into speed, so only the sum is guaranteed not to rise.
func (t *Table) kineticEnergy() float64 {
	sum := 0.0
	for i := range t.Balls {
		if b := &t.Balls[i]; !b.Pocketed {
			sum += b.Vel.Dot(b.Vel)/2 + b.Roll.Dot(b.Roll)/5 + b.Spin*b.Spin/5
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
	tbl.place(CueBall, Vec{0.1, 0.635}, Vec{1, 0}) // 2.3 m of road ahead
	steps := runUntilSettled(t, tbl, 60)

	// Struck without spin the ball slides, losing 2/7 of its speed while the
	// slip closes at 7/2 μg, then rolls to a stop under rolling friction.
	v0 := 1.0
	t1 := v0 / (3.5 * cfg.SlidingFriction * gravity)
	d1 := v0*t1 - 0.5*cfg.SlidingFriction*gravity*t1*t1
	v1 := v0 * 5 / 7
	t2 := (v1 - cfg.StopSpeed) / (cfg.RollingFriction * gravity)
	d2 := v1 * v1 / (2 * cfg.RollingFriction * gravity)
	if got := float64(steps) * cfg.Dt; !near(got, t1+t2, 0.05) {
		t.Errorf("stopped after %.3f s, want ~%.2f s", got, t1+t2)
	}
	if got := tbl.Balls[CueBall].Pos.X - 0.1; !near(got, d1+d2, 0.01) {
		t.Errorf("travelled %.4f m, want ~%.3f m", got, d1+d2)
	}
	if b := tbl.Balls[CueBall]; b.Roll != (Vec{}) {
		t.Errorf("a stopped ball should not spin, got roll %v", b.Roll)
	}
}

func TestCushionScrubsRoll(t *testing.T) {
	// A naturally rolling ball rebounds with most of its roll scrubbed off
	// by the nose (friction allows μ(1+e)·v of it to go) and slides until
	// the cloth has turned it round: it comes back well under what the
	// cushion restitution alone would give.
	cfg := DefaultConfig()
	tbl := emptyTable(cfg)
	tbl.place(CueBall, Vec{cfg.TableWidth - 0.3, 0.635}, Vec{1, 0})
	tbl.Balls[CueBall].Roll = Vec{1, 0}
	var before float64
	for i := 0; i < 600 && countEvents(tbl.Events, CushionHit, CueBall) == 0; i++ {
		before = tbl.Balls[CueBall].Vel.X
		tbl.Step(cfg.Dt)
	}
	if countEvents(tbl.Events, CushionHit, CueBall) != 1 {
		t.Fatalf("events %v, want one cushion hit", tbl.Events)
	}
	for i := 0; i < 90; i++ { // 0.15 s: the slide takes about 0.12 s
		tbl.Step(cfg.Dt)
	}
	b := tbl.Balls[CueBall]
	if b.Vel != b.Roll {
		t.Errorf("should be rolling again, vel %v roll %v", b.Vel, b.Roll)
	}
	e := cfg.CushionRestitution
	cos := math.Sqrt(1 - math.Pow(2*cfg.CushionNose-1, 2))
	scrub := math.Min(before, 2.5*cos*cfg.CushionFriction*(1+e)*before) // roll removed by the nose
	rollAfter := before - scrub                                         // still into the rail
	want := -(5.0/7*e*before - 2.0/7*rollAfter)
	if !near(b.Vel.X, want, 0.02) || b.Vel.Y != 0 {
		t.Errorf("velocity after the rail %v, want about %.3f (restitution alone would give %.3f)", b.Vel, want, -e*before)
	}
}

func TestObliqueReboundLosesSpeedToCushionFriction(t *testing.T) {
	// A sliding ball at 45° keeps its tangential speed off a frictionless
	// rail but loses some of it to the nose on a real one, so it comes off
	// steeper and slower.
	run := func(cfg Config) Vec {
		tbl := emptyTable(cfg)
		tbl.place(5, Vec{0.6, 1.0}, Vec{2, 2})
		for i := 0; i < 120; i++ {
			tbl.Step(cfg.Dt)
		}
		return tbl.Balls[5].Vel
	}
	cfg := frictionless()
	cfg.CushionFriction = DefaultConfig().CushionFriction
	free, real := run(frictionless()), run(cfg)
	if !near(free.X, 2, 1e-9) {
		t.Fatalf("frictionless rail changed the tangential speed: %v", free)
	}
	// Stick needs 2/3.5 = 0.57 m/s; friction allows μ(1+e)·2 = 0.74: it sticks.
	if want := 2 - 2/3.5; !near(real.X, want, 1e-6) || !near(real.Y, free.Y, 1e-9) {
		t.Errorf("velocity off a real rail %v, want (%.3f, %.3f)", real, want, free.Y)
	}
}

func TestFollowAndDraw(t *testing.T) {
	const v = 2.0
	// run shoots a full ball 0.4 m away with the given top/bottom spin and
	// returns both velocities 0.4 s after the contact, when the cue ball has
	// finished sliding on whatever spin it kept.
	run := func(spinY float64) (cue, obj Vec) {
		cfg := DefaultConfig()
		tbl := emptyTable(cfg)
		tbl.place(CueBall, Vec{0.8, 0.6}, Vec{})
		tbl.place(1, Vec{1.2, 0.6}, Vec{})
		tbl.ShootSpin(0, v/cfg.MaxCueSpeed, Vec{0, spinY})
		for i := 0; i < 600 && countEvents(tbl.Events, FirstContact, 1) == 0; i++ {
			tbl.Step(cfg.Dt)
		}
		if countEvents(tbl.Events, FirstContact, 1) == 0 {
			t.Fatal("no contact")
		}
		for i := 0; i < 240; i++ {
			tbl.Step(cfg.Dt)
		}
		return tbl.Balls[CueBall].Vel, tbl.Balls[1].Vel
	}
	centre, obj := run(0)
	if obj.X < 0.5*v || centre.X < 0.05 || centre.X > 0.4 {
		// A centre hit picks up some roll on the way, so it drifts forward.
		t.Errorf("centre hit: cue %v should drift forward a little, object %v should go on", centre, obj)
	}
	if cue, obj := run(1); cue.X < centre.X+0.3 || obj.X < 0.5*v {
		t.Errorf("top spin: cue %v should follow well past %v, object %v should go on", cue, centre, obj)
	}
	if cue, obj := run(-1); cue.X > -0.2 || obj.X < 0.5*v {
		t.Errorf("bottom spin: cue %v should draw back, object %v should go on", cue, obj)
	}
	// A thin hit leaves the cue ball most of its speed and its spin.
	cfg := DefaultConfig()
	tbl := emptyTable(cfg)
	tbl.place(CueBall, Vec{0.8, 0.6}, Vec{})
	tbl.place(1, Vec{1.2, 0.6 + 1.9*cfg.BallRadius}, Vec{})
	tbl.ShootSpin(0, v/cfg.MaxCueSpeed, Vec{0, -1})
	for i := 0; i < 150; i++ {
		tbl.Step(cfg.Dt)
	}
	if cue := tbl.Balls[CueBall]; cue.Vel.X < 0.5*v || cue.Roll.X > -0.5 {
		t.Errorf("thin hit with draw: cue %v should stay mostly forward and keep its back spin %v", cue.Vel, cue.Roll)
	}
}

func TestSideSpinKicksOffTheCushion(t *testing.T) {
	run := func(spinX float64) Vec {
		cfg := frictionless()
		cfg.CushionFriction = DefaultConfig().CushionFriction
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

func TestSpinIsClampedAndSideFades(t *testing.T) {
	cfg := frictionless()
	tbl := emptyTable(cfg)
	tbl.place(CueBall, Vec{0.2, 0.6}, Vec{})
	tbl.ShootSpin(0, 1, Vec{3, 4}) // clamped to the unit disc: (0.6, 0.8)
	b := tbl.Balls[CueBall]
	wantRoll := 2.5 * cfg.TipOffset * 0.8 * cfg.MaxCueSpeed
	wantSpin := -2.5 * cfg.TipOffset * 0.6 * cfg.MaxCueSpeed // right english turns clockwise from above
	if !near(b.Spin, wantSpin, 1e-9) || !near(b.Roll.X, wantRoll, 1e-9) || b.Roll.Y != 0 {
		t.Fatalf("after clamping spin = %v roll = %v, want %.3f and (%.3f, 0)", b.Spin, b.Roll, wantSpin, wantRoll)
	}
	for i := 0; i < 60; i++ { // 0.1 s at 8 m/s: 0.8 m
		tbl.Step(cfg.Dt)
	}
	b = tbl.Balls[CueBall]
	if want := wantSpin * math.Exp(-0.8/(2*cfg.SpinDecayLength)); !near(b.Spin, want, 0.02*math.Abs(wantSpin)) {
		t.Errorf("side spin after 0.8 m = %v, want about %.3f", b.Spin, want)
	}
	if !near(b.Roll.X, wantRoll, 1e-9) {
		t.Errorf("without cloth friction the roll should not change, got %v", b.Roll)
	}
}

func TestImpactsAreRecordedInOrder(t *testing.T) {
	g := NewGame(DefaultConfig())
	g.Start(0)
	if err := g.Shoot(0, 0, 1, Call{Pocket: AnyPocket}); err != nil {
		t.Fatal(err)
	}
	for g.Moving() {
		g.Tick()
	}
	var kinds [3]int
	last := 0.0
	for _, im := range g.Table.Impacts {
		if im.T < last {
			t.Fatalf("impacts out of order: %v after %v", im.T, last)
		}
		last = im.T
		if im.Speed < minImpact {
			t.Errorf("inaudible impact recorded: %+v", im)
		}
		kinds[im.Kind]++
	}
	if kinds[ImpactBall] < 10 || kinds[ImpactCushion] < 4 {
		t.Errorf("a full break gave %d ball and %d cushion impacts", kinds[ImpactBall], kinds[ImpactCushion])
	}
	if first := g.Table.Impacts[0]; first.Kind != ImpactBall || first.Speed < 5 {
		t.Errorf("first impact %+v, want the cue ball into the rack at speed", first)
	}
	if last > g.Table.Clock {
		t.Errorf("an impact at %v after the clock %v", last, g.Table.Clock)
	}
}
