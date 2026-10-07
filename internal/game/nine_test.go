package game

import (
	"reflect"
	"testing"
)

// nineRules returns 9-ball rules at the break with seat to shoot.
func nineRules(seat int) *Rules {
	r := NewRules()
	r.Mode = ModeNine
	r.Start(seat)
	return r
}

// nineAfterBreak returns 9-ball rules after a dry legal break, seat to
// shoot, with the given balls already down and the push out spent.
func nineAfterBreak(seat int, down ...int) *Rules {
	r := nineRules(seat)
	r.Phase, r.BallInHand, r.Kitchen = PhaseOpen, false, false
	for _, id := range down {
		r.pocketed[id] = true
	}
	return r
}

var pushOut = Call{Pocket: AnyPocket, PushOut: true}

func TestNineBreak(t *testing.T) {
	tests := []struct {
		name      string
		shot      Shot
		foul      Foul
		turn      int
		inHand    bool
		winner    int
		respot    int
		illegal   bool
		gameOver  bool
		pushOutOK bool
	}{
		{name: "pocket a ball", shot: breakShot(0, 3), turn: 0, winner: NoWinner, pushOutOK: true},
		{name: "four rails", shot: breakShot(4), turn: 1, winner: NoWinner, pushOutOK: true},
		{name: "too few rails", shot: breakShot(3), foul: FoulBadBreak, illegal: true, turn: 1, inHand: true, winner: NoWinner, pushOutOK: true},
		{name: "9 on the break wins", shot: breakShot(0, 9), turn: 0, winner: 0, gameOver: true},
		{name: "9 and a scratch is spotted", shot: breakShot(0, 9, CueBall), foul: FoulScratch, turn: 1, inHand: true, winner: NoWinner, respot: 9, pushOutOK: true},
		{name: "1-ball not hit first", shot: Shot{Events: []Event{{Kind: FirstContact, Ball: 2}, {Kind: BallPocketed, Ball: 2}}}, foul: FoulWrongBall, turn: 1, inHand: true, winner: NoWinner, pushOutOK: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := nineRules(0)
			res := r.Resolve(tt.shot)
			if res.Foul != tt.foul || res.IllegalBreak != tt.illegal || res.Respot != tt.respot {
				t.Errorf("result %+v, want foul %q illegal %v respot %d", res, tt.foul, tt.illegal, tt.respot)
			}
			if r.Turn != tt.turn || r.BallInHand != tt.inHand || r.Kitchen || r.Winner != tt.winner ||
				(r.Phase == PhaseGameOver) != tt.gameOver || r.PushOut != tt.pushOutOK || r.Decision != nil {
				t.Errorf("rules %+v", r)
			}
		})
	}
}

func TestNineLowestBallFirst(t *testing.T) {
	r := nineAfterBreak(0, 1, 2)
	if !r.legalTarget(3) || r.legalTarget(4) || r.legalTarget(9) {
		t.Error("only the 3 should be a legal target with the 1 and 2 down")
	}
	res := r.Resolve(shot(noCall, 5, 5))
	if res.Foul != FoulWrongBall || r.Turn != 1 || !r.BallInHand || r.Kitchen || r.Fouls[0] != 1 {
		t.Errorf("hitting the 5 first: %+v, rules %+v", res, r)
	}
	if r.pocketed[5] != true {
		t.Error("a ball pocketed on a foul stays down")
	}
}

func TestNineAnyBallKeepsTheTurnAndTheNineWins(t *testing.T) {
	r := nineAfterBreak(0, 1, 2)
	if res := r.Resolve(shot(noCall, 3, 7)); res.Foul != FoulNone || !res.Made || r.Turn != 0 {
		t.Errorf("3 first, 7 down: %+v, turn %d", res, r.Turn)
	}
	if res := r.Resolve(shot(noCall, 3)); res.Made || r.Turn != 1 {
		t.Errorf("nothing down: %+v, turn %d", res, r.Turn)
	}
	// A combination on the 9 wins.
	if res := r.Resolve(shot(noCall, 3, 9)); !res.Made || r.Winner != 1 || r.Phase != PhaseGameOver || r.End != EndMade {
		t.Errorf("3 into the 9: %+v, rules %+v", res, r)
	}
}

func TestNineOnAFoulIsSpotted(t *testing.T) {
	r := nineAfterBreak(0, 1, 2)
	res := r.Resolve(shot(noCall, 4, 9))
	if res.Foul != FoulWrongBall || res.Respot != NineBall || r.Winner != NoWinner || r.Phase != PhaseOpen || r.Turn != 1 {
		t.Errorf("9 down on a foul: %+v, rules %+v", res, r)
	}
	if r.lowest() != 3 || r.pocketed[NineBall] {
		t.Error("the 9-ball must stay in play")
	}
}

func TestNinePushOut(t *testing.T) {
	r := nineRules(0)
	r.Resolve(breakShot(4)) // dry legal break: seat 1 may push out
	if !r.PushOut || r.Turn != 1 {
		t.Fatalf("after the break: %+v", r)
	}
	if err := r.CheckCall(pushOut); err != nil {
		t.Fatalf("push out refused: %v", err)
	}
	// No contact at all, and the 9 falls: not a foul, the 9 is spotted.
	res := r.Resolve(Shot{Call: pushOut, Events: []Event{{Kind: BallPocketed, Ball: 9}}})
	if res.Foul != FoulNone || !res.PushOut || res.Respot != NineBall || r.Winner != NoWinner {
		t.Errorf("push out: %+v", res)
	}
	want := &Decision{Seat: 0, Options: []Option{OptTakeShot, OptPassBack}}
	if !reflect.DeepEqual(r.Decision, want) || r.InPlay() || r.PushOut {
		t.Fatalf("decision after the push out: %+v", r)
	}
	if err := r.CheckCall(pushOut); err == nil {
		t.Error("a second push out was allowed")
	}

	if _, err := r.Choose(0, OptPassBack); err != nil || r.Turn != 1 || r.Decision != nil || r.BallInHand {
		t.Errorf("pass back: %v, rules %+v", err, r)
	}
	r.Decision = &Decision{Seat: 0, Options: []Option{OptTakeShot, OptPassBack}}
	if _, err := r.Choose(0, OptTakeShot); err != nil || r.Turn != 0 || r.Phase != PhaseOpen {
		t.Errorf("take the shot: %v, rules %+v", err, r)
	}
}

func TestNinePushOutScratchIsAFoul(t *testing.T) {
	r := nineRules(0)
	r.Resolve(breakShot(0, 3)) // the breaker keeps the table and may push out
	res := r.Resolve(shot(pushOut, -1, CueBall))
	if res.Foul != FoulScratch || r.Turn != 1 || !r.BallInHand || r.Decision != nil || r.PushOut {
		t.Errorf("scratch on a push out: %+v, rules %+v", res, r)
	}
}

func TestNinePushOutOnlyAfterTheBreak(t *testing.T) {
	r := nineAfterBreak(0)
	if err := r.CheckCall(pushOut); err != ErrNoPushOut {
		t.Errorf("push out later in the rack: %v", err)
	}
	if err := nineRules(0).CheckCall(pushOut); err != ErrNoPushOut {
		t.Errorf("push out on the break: %v", err)
	}
}

func TestNineThreeFoulsLose(t *testing.T) {
	r := nineAfterBreak(0)
	miss := shot(noCall, -1)
	r.Resolve(miss)               // 0: one foul
	r.Resolve(shot(noCall, 1, 1)) // 1 pots the 1
	r.Resolve(shot(noCall, 2))    // 1 misses legally
	r.Resolve(miss)               // 0: two fouls
	if r.Fouls != [2]int{2, 0} {
		t.Fatalf("fouls = %v", r.Fouls)
	}
	r.Resolve(shot(noCall, 2)) // 1
	r.TimeFoul()               // 0: third foul by the clock
	if r.Winner != 1 || r.Phase != PhaseGameOver || r.End != EndThreeFouls {
		t.Errorf("after three fouls: %+v", r)
	}

	// A legal shot in between starts the count again.
	r = nineAfterBreak(0)
	r.Resolve(miss)
	r.Resolve(shot(noCall, 1))
	r.Resolve(shot(noCall, 1)) // 0 hits the 1 legally
	if r.Fouls[0] != 0 {
		t.Errorf("fouls after a legal shot = %v", r.Fouls)
	}
}

func TestNineTimeFoulOnTheBreakIsNotCounted(t *testing.T) {
	r := nineRules(0)
	r.TimeFoul()
	if r.Fouls != [2]int{} || r.Phase != PhaseBreaking || r.Turn != 1 || !r.Kitchen {
		t.Errorf("time foul on the break: %+v", r)
	}
}

func TestRackNine(t *testing.T) {
	cfg := DefaultConfig()
	g := NewGame(cfg)
	g.Rules.Mode = ModeNine
	g.Start(0)
	balls := g.Table.Snapshot()
	if len(balls) != 10 {
		t.Fatalf("%d balls on the table, want 10", len(balls))
	}
	if got := g.Table.Balls[1].Pos; got != cfg.FootSpot() {
		t.Errorf("1-ball at %v, want the foot spot %v", got, cfg.FootSpot())
	}
	if got := g.Table.Balls[NineBall].Pos; got.Y != cfg.TableHeight/2 || got.X <= cfg.FootSpot().X {
		t.Errorf("9-ball at %v, want the centre of the diamond", got)
	}
	if st := g.State(); st.Mode != ModeNine || st.PushOut {
		t.Errorf("state %+v", st)
	}
	// The mode survives a rematch.
	g.Start(1)
	if len(g.Table.Snapshot()) != 10 {
		t.Error("the second rack is not a 9-ball rack")
	}
}
