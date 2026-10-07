package game

import (
	"reflect"
	"testing"
)

func TestSaveRestore(t *testing.T) {
	g := NewGame(DefaultConfig())
	g.Rules.Mode = ModeNine
	g.Start(0)
	before := g.Save()
	want, wantRules := g.Table.Snapshot(), *g.Rules

	if err := g.Shoot(0, 0, 1, Call{Pocket: AnyPocket}); err != nil {
		t.Fatal(err)
	}
	for g.Moving() {
		g.Tick()
	}
	if reflect.DeepEqual(g.Table.Snapshot(), want) {
		t.Fatal("the break moved nothing")
	}

	g.Restore(before)
	if got := g.Table.Snapshot(); !reflect.DeepEqual(got, want) {
		t.Errorf("balls after restore differ:\n%v\n%v", got, want)
	}
	if !reflect.DeepEqual(*g.Rules, wantRules) {
		t.Errorf("rules after restore = %+v, want %+v", *g.Rules, wantRules)
	}
	if g.Moving() {
		t.Error("still moving after restore")
	}
	// The restored game plays on.
	if err := g.Shoot(0, 0, 1, Call{Pocket: AnyPocket}); err != nil {
		t.Errorf("shoot after restore: %v", err)
	}
}

func TestSaveCopiesTheDecision(t *testing.T) {
	g := NewGame(DefaultConfig())
	g.Start(0)
	g.Rules.Decision = &Decision{Seat: 1, Options: []Option{OptAcceptTable}}
	s := g.Save()
	g.Rules.Decision.Options[0] = OptRebreak
	g.Restore(s)
	if g.Rules.Decision.Options[0] != OptAcceptTable {
		t.Error("the snapshot shares the decision with the game")
	}
}

func TestPlaceFree(t *testing.T) {
	g := NewGame(DefaultConfig())
	if err := g.PlaceFree(CueBall, Vec{1, 0.6}); err != ErrWrongPhase {
		t.Errorf("in the lobby: %v", err)
	}
	g.Start(0)
	g.Rules.Phase, g.Rules.BallInHand, g.Rules.Kitchen = PhaseOpen, false, false

	// The cue ball anywhere, without ball in hand.
	if err := g.PlaceFree(CueBall, Vec{1.2, 0.3}); err != nil || g.Table.Balls[CueBall].Pos != (Vec{1.2, 0.3}) {
		t.Errorf("cue ball: %v at %v", err, g.Table.Balls[CueBall].Pos)
	}
	// An object ball, set up for a cut.
	if err := g.PlaceFree(5, Vec{1.5, 0.9}); err != nil || g.Table.Balls[5].Pos != (Vec{1.5, 0.9}) {
		t.Errorf("5-ball: %v at %v", err, g.Table.Balls[5].Pos)
	}
	for _, tt := range []struct {
		id  int
		pos Vec
	}{
		{5, Vec{1.2, 0.3}},  // on the cue ball
		{5, Vec{0.01, 0.6}}, // off the table
		{5, Vec{0, 0}},      // in a corner pocket
		{16, Vec{1.0, 1.0}}, // no such ball
		{-1, Vec{1.0, 1.0}}, // no such ball
	} {
		if err := g.PlaceFree(tt.id, tt.pos); err != ErrBadPlacement {
			t.Errorf("ball %d at %v: %v, want ErrBadPlacement", tt.id, tt.pos, err)
		}
	}
	g.Table.Balls[7].Pocketed = true
	if err := g.PlaceFree(7, Vec{1.0, 1.0}); err != ErrBadPlacement {
		t.Errorf("a pocketed ball: %v", err)
	}
}

func TestPlaceFreeKeepsTheKitchen(t *testing.T) {
	g := NewGame(DefaultConfig())
	g.Start(0) // breaking: ball in hand in the kitchen
	g.PlaceFree(CueBall, Vec{0.4, 0.5})
	if !g.cueInKitchen {
		t.Error("a cue ball placed in the kitchen is not played from there")
	}
	g.PlaceFree(CueBall, Vec{1.0, 0.5})
	if g.cueInKitchen {
		t.Error("a cue ball placed outside the kitchen still counts as in it")
	}
}

// Free rules (practice) record what drops and nothing else.
func TestFreeRulesHaveNoFoulsTurnsOrEnd(t *testing.T) {
	for _, mode := range []Mode{ModeEight, ModeNine} {
		r := &Rules{Mode: mode, Free: true}
		r.Start(0)
		if r.Phase != PhaseOpen || r.BallInHand || r.Kitchen || !r.InPlay() {
			t.Fatalf("%s: free start %+v", mode, r)
		}
		for _, s := range []Shot{
			shot(noCall, -1),                        // no contact
			shot(noCall, 3, CueBall),                // scratch
			shot(noCall, 5, EightBall),              // the 8 early
			shot(noCall, 2, NineBall, 4),            // the 9 on a wrong first ball
			shot(Call{Pocket: 9, PushOut: true}, 1), // calls are ignored
		} {
			if err := r.CheckCall(s.Call); err != nil {
				t.Errorf("%s: call %+v refused: %v", mode, s.Call, err)
			}
			res := r.Resolve(s)
			if res.Foul != FoulNone || res.IllegalBreak || res.Respot != 0 || r.Turn != 0 || r.Phase != PhaseOpen ||
				r.Winner != NoWinner || r.Decision != nil || r.BallInHand {
				t.Errorf("%s: after %+v: result %+v, rules %+v", mode, s, res, r)
			}
		}
		if !r.pocketed[EightBall] || !r.pocketed[NineBall] || !r.pocketed[4] {
			t.Errorf("%s: dropped balls not recorded: %v", mode, r.pocketed)
		}
		r.Start(0)
		if !r.Free || r.pocketed[EightBall] {
			t.Errorf("%s: a new rack must stay free and clear: %+v", mode, r)
		}
	}
}
