package game

import (
	"math"
	"testing"
)

func TestMasseCurvesAroundABlockingBall(t *testing.T) {
	// The blocker sits 15 cm in front of the cue ball; the target is off to
	// the shooter's right, beyond it.
	setup := func(elevation float64) *Table {
		tb := emptyTable(DefaultConfig())
		tb.place(CueBall, Vec{0.6, 0.3}, Vec{})
		tb.place(3, Vec{0.75, 0.3}, Vec{})
		tb.place(5, Vec{0.9, 0.75}, Vec{})
		tb.ShootElevated(0, 0.4, Vec{1, 0}, elevation)
		return tb
	}
	level := setup(0)
	runUntilSettled(t, level, 30)
	if first := firstContact(level.Events); first != 3 {
		t.Fatalf("level shot with english first hit ball %d, want the blocker", first)
	}

	masse := setup(80 * deg)
	runUntilSettled(t, masse, 30)
	if first := firstContact(masse.Events); first != 5 {
		t.Errorf("massé first hit ball %d, want 5 round the blocker; events %v", first, masse.Events)
	}
	if masse.Balls[3].Pos != (Vec{0.75, 0.3}) {
		t.Errorf("the blocker moved to %v", masse.Balls[3].Pos)
	}
}

func TestMasseLeavesAlongTheAimAndCurvesToTheEnglish(t *testing.T) {
	// path returns where the cue ball has gone, along the aim and to the
	// shooter's right (+y for an aim along +x), when it has gone 5 cm and
	// when it starts to roll.
	path := func(english float64) (early, rolling Vec) {
		tb := emptyTable(DefaultConfig())
		start := Vec{0.6, 0.635}
		tb.place(CueBall, start, Vec{})
		tb.ShootElevated(0, 0.4, Vec{english, 0}, 80*deg)
		for limit := int(5 / tb.Cfg.Dt); limit > 0; limit-- {
			tb.Step(tb.Cfg.Dt)
			c := &tb.Balls[CueBall]
			d := c.Pos.Sub(start)
			if early == (Vec{}) && d.Len() >= 0.05 {
				early = d
			}
			if !c.Airborne() && c.Vel == c.Roll {
				return early, d
			}
		}
		t.Fatalf("english %v: the cue ball never rolled", english)
		return
	}
	early, right := path(1)
	if a := math.Atan2(early.Y, early.X); math.Abs(a) > 10*deg {
		t.Errorf("after 5 cm the cue ball is %.0f° off the aim, want it to leave along it", a/deg)
	}
	if a := math.Atan2(right.Y, right.X); a < 30*deg {
		t.Errorf("with right english the cue ball has turned %.0f° by the time it rolls, want it curved to the right", a/deg)
	}
	_, left := path(-1)
	if math.Abs(left.X-right.X) > 1e-9 || math.Abs(left.Y+right.Y) > 1e-9 {
		t.Errorf("left english went to %v, want the mirror of right english's %v", left, right)
	}
}

func TestSideSpinOnALevelCueRunsStraight(t *testing.T) {
	tb := emptyTable(DefaultConfig())
	tb.place(CueBall, Vec{0.6, 0.635}, Vec{})
	tb.ShootElevated(0, 0.4, Vec{1, 0}, 0)
	for i := 0; i < int(0.5/tb.Cfg.Dt); i++ {
		tb.Step(tb.Cfg.Dt)
	}
	if c := tb.Balls[CueBall]; c.Pos.Y != 0.635 {
		t.Errorf("a level cue with english went to %v, off the aim", c.Pos)
	}
}

func TestSteepCueKeepsTheBallDown(t *testing.T) {
	tb := emptyTable(DefaultConfig())
	tb.place(CueBall, Vec{0.6, 0.635}, Vec{})
	tb.ShootElevated(0, 1, Vec{1, 0}, MaxElevation)
	if z := fly(t, tb, CueBall); z > tb.Cfg.BallRadius {
		t.Errorf("a full-power massé at %.0f° hopped %.3f m, want the follow-through to keep it under a ball's radius", MaxElevation/deg, z)
	}
}
