package game

import (
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"testing"
)

// In hand-built shots every pocketed ball drops into pot.
const pot = 2

// Object balls need no call; the 8-ball is shot into a named pocket.
var (
	noCall = Call{Pocket: AnyPocket}
	safety = Call{Safety: true}
)

// into names the pocket the 8-ball is shot into.
func into(n int) Call { return Call{Pocket: n} }

// shot builds a settled shot: the call, the first ball the cue ball touched
// (negative for none, followed by that ball reaching a rail) and the balls
// pocketed, in order.
func shot(c Call, first int, pocketed ...int) Shot {
	var events []Event
	if first >= 0 {
		events = append(events, Event{Kind: FirstContact, Ball: first}, Event{Kind: CushionHit, Ball: first})
	}
	for _, id := range pocketed {
		events = append(events, Event{Kind: BallPocketed, Ball: id, Pocket: pot})
	}
	return Shot{Events: events, Call: c}
}

// breakShot builds a break that hits the apex ball, drives object balls
// 1..railed to a rail and pockets the given balls.
func breakShot(railed int, pocketed ...int) Shot {
	events := []Event{{Kind: HeadStringCrossed}, {Kind: FirstContact, Ball: 1}}
	for id := 1; id <= railed; id++ {
		events = append(events, Event{Kind: CushionHit, Ball: id})
	}
	for _, id := range pocketed {
		events = append(events, Event{Kind: BallPocketed, Ball: id, Pocket: pot})
	}
	return Shot{Events: events, FromKitchen: true}
}

// openRules returns rules just after a dry legal break with seat to shoot.
func openRules(seat int, down ...int) *Rules {
	r := NewRules()
	r.Start(seat)
	r.Phase = PhaseOpen
	r.BallInHand, r.Kitchen = false, false
	for _, id := range down {
		r.pocketed[id] = true
	}
	return r
}

// assignedRules returns rules where seat shoots and owns solids, with the
// given object balls already pocketed.
func assignedRules(seat int, down ...int) *Rules {
	r := openRules(seat, down...)
	r.Phase = PhaseAssigned
	r.Groups[seat] = GroupSolids
	r.Groups[1-seat] = GroupStripes
	return r
}

var (
	allSolids  = []int{1, 2, 3, 4, 5, 6, 7}
	allStripes = []int{9, 10, 11, 12, 13, 14, 15}
)

func TestGroupOf(t *testing.T) {
	want := map[int]Group{0: GroupNone, 1: GroupSolids, 7: GroupSolids, 8: GroupNone, 9: GroupStripes, 15: GroupStripes}
	for id, g := range want {
		if got := GroupOf(id); got != g {
			t.Errorf("GroupOf(%d) = %q, want %q", id, got, g)
		}
	}
}

func TestFouls(t *testing.T) {
	contact := func(first int, inKitchen bool) Event {
		return Event{Kind: FirstContact, Ball: first, InKitchen: inKitchen}
	}
	rail := func(ball int) Event { return Event{Kind: CushionHit, Ball: ball} }
	crossed := Event{Kind: HeadStringCrossed}

	tests := []struct {
		name  string
		rules *Rules
		shot  Shot
		want  Foul
	}{
		{"scratch", openRules(0), shot(noCall, 3, CueBall), FoulScratch},
		{"scratch beats other fouls", assignedRules(0), shot(noCall, 9, CueBall), FoulScratch},
		{"no contact", openRules(0), shot(noCall, -1), FoulNoContact},
		{"wrong group first", assignedRules(0), shot(noCall, 9), FoulWrongBall},
		{"8-ball first on an open table", openRules(0), shot(noCall, EightBall), FoulWrongBall},
		{"8-ball first before clearing the group", assignedRules(0), shot(noCall, EightBall), FoulWrongBall},
		{"group ball first when on the 8", assignedRules(0, allSolids...), shot(into(pot), 9), FoulWrongBall},
		{"no rail after contact", assignedRules(0),
			Shot{Call: noCall, Events: []Event{contact(3, false)}}, FoulNoRail},
		{"rail only before contact", assignedRules(0),
			Shot{Call: noCall, Events: []Event{rail(CueBall), contact(3, false)}}, FoulNoRail},
		{"kitchen: ball above the head string hit directly", openRules(0),
			Shot{Call: noCall, FromKitchen: true, Events: []Event{contact(3, true), rail(3)}}, FoulKitchen},
		{"kitchen: crossing the head string after contact is too late", openRules(0),
			Shot{Call: noCall, FromKitchen: true, Events: []Event{contact(3, true), crossed, rail(3)}}, FoulKitchen},

		{"legal: own group first", assignedRules(0), shot(noCall, 3), FoulNone},
		{"legal: any group on an open table", openRules(0), shot(noCall, 12), FoulNone},
		{"legal: 8-ball first when on the 8", assignedRules(0, allSolids...), shot(into(pot), EightBall), FoulNone},
		{"legal: 8-ball first on an open table with a group cleared", openRules(0, allStripes...), shot(into(pot), EightBall), FoulNone},
		{"legal: opponent ball pocketed counts as a rail", assignedRules(0),
			Shot{Call: noCall, Events: []Event{contact(3, false), {Kind: BallPocketed, Ball: 12, Pocket: pot}}}, FoulNone},
		{"legal: kitchen shot crossing the head string first", openRules(0),
			Shot{Call: noCall, FromKitchen: true, Events: []Event{crossed, rail(CueBall), contact(3, true), rail(3)}}, FoulNone},
		{"legal: kitchen shot at a ball below the head string", openRules(0),
			Shot{Call: noCall, FromKitchen: true, Events: []Event{crossed, contact(3, false), rail(3)}}, FoulNone},
		{"legal: ball above the head string without ball in hand there", openRules(0),
			Shot{Call: noCall, Events: []Event{contact(3, true), rail(3)}}, FoulNone},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := tc.rules
			res := r.Resolve(tc.shot)
			if res.Foul != tc.want {
				t.Fatalf("foul = %q, want %q", res.Foul, tc.want)
			}
			if res.Shooter != 0 {
				t.Errorf("shooter = %d, want 0", res.Shooter)
			}
			fouled := tc.want != FoulNone
			if r.BallInHand != fouled {
				t.Errorf("ballInHand = %v, want %v", r.BallInHand, fouled)
			}
			if r.Kitchen {
				t.Error("ball in hand after a standard foul must not be limited to the kitchen")
			}
			// None of these shots pocket the called ball, so the turn passes
			// either way.
			if r.Turn != 1 {
				t.Errorf("turn = %d, want 1", r.Turn)
			}
			if r.Phase == PhaseGameOver {
				t.Error("game should not be over")
			}
		})
	}
}

func TestCheckCall(t *testing.T) {
	tests := []struct {
		name  string
		rules *Rules
		call  Call
		ok    bool
	}{
		{"open: no call", openRules(0), noCall, true},
		{"open: safety", openRules(0), safety, true},
		{"open: a pocket may be named anyway", openRules(0), into(3), true},
		{"open: pocket out of range", openRules(0), into(NumPockets), false},
		{"open: negative pocket", openRules(0), into(-2), false},
		{"open: on the 8 once a group is cleared, no pocket", openRules(0, allStripes...), noCall, false},
		{"open: on the 8 once a group is cleared, pocket", openRules(0, allStripes...), into(pot), true},
		{"assigned: no call", assignedRules(0), noCall, true},
		{"assigned: on the 8 without a pocket", assignedRules(0, allSolids...), noCall, false},
		{"assigned: on the 8 with a pocket", assignedRules(0, allSolids...), into(pot), true},
		{"assigned: safety when on the 8", assignedRules(0, allSolids...), safety, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.rules.CheckCall(tc.call)
			if tc.ok && err != nil {
				t.Errorf("rejected: %v", err)
			}
			if !tc.ok && !errors.Is(err, ErrBadCall) {
				t.Errorf("err = %v, want ErrBadCall", err)
			}
		})
	}

	breaking := NewRules()
	breaking.Start(0)
	if err := breaking.CheckCall(noCall); err != nil {
		t.Errorf("the break needs no call, got %v", err)
	}
}

func TestPocketingKeepsTheTurn(t *testing.T) {
	tests := []struct {
		name       string
		shot       Shot
		wantTurn   int
		wantMade   bool
		wantSolids int // solids left on the table
	}{
		{"own ball keeps the turn", shot(noCall, 3, 3), 0, true, 6},
		{"own ball plus an opponent ball keeps the turn", shot(noCall, 3, 12, 3), 0, true, 6},
		{"any ball of the group counts, in any pocket", shot(into(4), 3, 5), 0, true, 6},
		{"only an opponent ball passes the turn", shot(noCall, 3, 12), 1, false, 7},
		{"miss passes the turn", shot(noCall, 3), 1, false, 7},
		{"safety passes the turn and the ball stays down", shot(safety, 3, 3), 1, false, 6},
		{"own ball made on a foul passes the turn", shot(noCall, 12, 3), 1, true, 6},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := assignedRules(0)
			res := r.Resolve(tc.shot)
			if r.Turn != tc.wantTurn {
				t.Errorf("turn = %d, want %d", r.Turn, tc.wantTurn)
			}
			if res.Made != tc.wantMade {
				t.Errorf("made = %v, want %v", res.Made, tc.wantMade)
			}
			if got := r.Remaining(GroupSolids); got != tc.wantSolids {
				t.Errorf("solids remaining = %d, want %d", got, tc.wantSolids)
			}
		})
	}
}

func TestGroupAssignment(t *testing.T) {
	tests := []struct {
		name       string
		shot       Shot
		wantPhase  Phase
		wantGroups [2]Group // shooter is seat 1
		wantTurn   int
	}{
		{"solid made", shot(noCall, 3, 3), PhaseAssigned, [2]Group{GroupStripes, GroupSolids}, 1},
		{"stripe made", shot(noCall, 12, 12), PhaseAssigned, [2]Group{GroupSolids, GroupStripes}, 1},
		{"the first ball down decides", shot(noCall, 3, 11, 3), PhaseAssigned, [2]Group{GroupSolids, GroupStripes}, 1},
		{"hitting a stripe first to make a solid", shot(noCall, 12, 3), PhaseAssigned, [2]Group{GroupStripes, GroupSolids}, 1},
		{"miss leaves the table open", shot(noCall, 3), PhaseOpen, [2]Group{}, 0},
		{"safety leaves the table open", shot(safety, 3, 3), PhaseOpen, [2]Group{}, 0},
		{"a ball made on a foul does not assign", shot(noCall, 3, 3, CueBall), PhaseOpen, [2]Group{}, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := openRules(1)
			r.Resolve(tc.shot)
			if r.Phase != tc.wantPhase {
				t.Errorf("phase = %q, want %q", r.Phase, tc.wantPhase)
			}
			if r.Groups != tc.wantGroups {
				t.Errorf("groups = %v, want %v", r.Groups, tc.wantGroups)
			}
			if r.Turn != tc.wantTurn {
				t.Errorf("turn = %d, want %d", r.Turn, tc.wantTurn)
			}
		})
	}
}

func TestBallInHandTransfer(t *testing.T) {
	r := assignedRules(0)
	res := r.Resolve(shot(noCall, 1, CueBall))
	if !res.CuePocketed || r.Turn != 1 || !r.BallInHand || r.Kitchen {
		t.Fatalf("after scratch: cuePocketed=%v turn=%d ballInHand=%v kitchen=%v, want true 1 true false",
			res.CuePocketed, r.Turn, r.BallInHand, r.Kitchen)
	}

	// Seat 1 (stripes) plays a legal shot: ball in hand is used up.
	r.Resolve(shot(noCall, 9, 9))
	if r.Turn != 1 || r.BallInHand {
		t.Fatalf("after legal pot: turn=%d ballInHand=%v, want 1 false", r.Turn, r.BallInHand)
	}

	// Seat 1 fouls back: ball in hand goes to seat 0.
	r.Resolve(shot(noCall, -1))
	if r.Turn != 0 || !r.BallInHand {
		t.Fatalf("after foul: turn=%d ballInHand=%v, want 0 true", r.Turn, r.BallInHand)
	}
}

func TestEightBallEndsTheGame(t *testing.T) {
	onEight := func(seat int) *Rules { return assignedRules(seat, allSolids...) }
	tests := []struct {
		name       string
		rules      *Rules
		shot       Shot
		wantWinner int
	}{
		{"8-ball in the called pocket wins", onEight(0), shot(into(pot), EightBall, EightBall), 0},
		{"seat 1 wins the same way", onEight(1), shot(into(pot), EightBall, EightBall), 1},
		{"open table with a group cleared: 8-ball wins", openRules(0, allStripes...), shot(into(pot), EightBall, EightBall), 0},
		{"8-ball in the wrong pocket loses", onEight(0), shot(into(5), EightBall, EightBall), 1},
		{"8-ball on a safety loses", onEight(0), shot(safety, EightBall, EightBall), 1},
		{"8-ball and cue ball together lose", onEight(0), shot(into(pot), EightBall, EightBall, CueBall), 1},
		{"8-ball without contact loses", onEight(0), shot(into(pot), -1, EightBall), 1},
		{"early 8-ball loses", assignedRules(0, 1, 2), shot(noCall, 3, EightBall), 1},
		{"early 8-ball on an open table loses", openRules(0), shot(noCall, 3, EightBall), 1},
		{"last group ball and 8-ball in one shot lose", assignedRules(0, 1, 2, 3, 4, 5, 6), shot(noCall, 7, 7, EightBall), 1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := tc.rules
			r.Resolve(tc.shot)
			if r.Phase != PhaseGameOver {
				t.Fatalf("phase = %q, want game over", r.Phase)
			}
			if r.Winner != tc.wantWinner {
				t.Errorf("winner = %d, want %d", r.Winner, tc.wantWinner)
			}
			if r.BallInHand {
				t.Error("ball in hand set after the game ended")
			}

			// Nothing changes once the game is over.
			before := *r
			r.Resolve(shot(noCall, 3, 3))
			if *r != before {
				t.Error("Resolve changed a finished game")
			}
		})
	}
}

func TestFoulOnTheEightWithoutPocketingItIsNotALoss(t *testing.T) {
	r := assignedRules(0, allSolids...)
	res := r.Resolve(shot(into(pot), EightBall, CueBall))
	if res.Foul != FoulScratch || r.Phase != PhaseAssigned || r.Winner != NoWinner {
		t.Fatalf("foul=%q phase=%q winner=%d, want scratch, assigned, none", res.Foul, r.Phase, r.Winner)
	}
	if r.Turn != 1 || !r.BallInHand {
		t.Errorf("turn=%d ballInHand=%v, want 1 true", r.Turn, r.BallInHand)
	}
}

func TestBreakWithoutDecision(t *testing.T) {
	tests := []struct {
		name        string
		shot        Shot
		wantTurn    int
		wantFoul    Foul
		wantKitchen bool // opponent has ball in hand above the head string
	}{
		{"dry break with four balls to a rail passes the turn", breakShot(4), 1, FoulNone, false},
		{"pocketing a ball keeps the turn", breakShot(0, 11), 0, FoulNone, false},
		{"scratch gives ball in hand above the head string", breakShot(6, 11, CueBall), 1, FoulScratch, true},
		{"scratch on a dry but legal break", breakShot(4, CueBall), 1, FoulScratch, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := NewRules()
			r.Start(0)
			if r.Phase != PhaseBreaking || !r.BallInHand || !r.Kitchen {
				t.Fatalf("after Start: phase=%q ballInHand=%v kitchen=%v, want breaking with the cue ball in hand in the kitchen",
					r.Phase, r.BallInHand, r.Kitchen)
			}
			res := r.Resolve(tc.shot)
			if r.Phase != PhaseOpen {
				t.Errorf("phase = %q, want open (groups are never assigned on the break)", r.Phase)
			}
			if r.Groups != [2]Group{} || r.Winner != NoWinner || r.Decision != nil || res.IllegalBreak {
				t.Errorf("groups=%v winner=%d decision=%v illegal=%v", r.Groups, r.Winner, r.Decision, res.IllegalBreak)
			}
			if r.Turn != tc.wantTurn {
				t.Errorf("turn = %d, want %d", r.Turn, tc.wantTurn)
			}
			if res.Foul != tc.wantFoul {
				t.Errorf("foul = %q, want %q", res.Foul, tc.wantFoul)
			}
			if r.BallInHand != tc.wantKitchen || r.Kitchen != tc.wantKitchen {
				t.Errorf("ballInHand=%v kitchen=%v, want both %v", r.BallInHand, r.Kitchen, tc.wantKitchen)
			}
		})
	}
}

func TestBreakDecisions(t *testing.T) {
	illegalOpts := []Option{OptAcceptTable, OptRerackBreak, OptRerackOpponentBreaks}
	eightOpts := []Option{OptSpotEight, OptRebreak}
	cueRails := Shot{FromKitchen: true, Events: []Event{
		{Kind: FirstContact, Ball: 1},
		{Kind: CushionHit, Ball: CueBall}, {Kind: CushionHit, Ball: CueBall},
		{Kind: CushionHit, Ball: 1}, {Kind: CushionHit, Ball: 1}, {Kind: CushionHit, Ball: 2}, {Kind: CushionHit, Ball: 3},
	}}

	tests := []struct {
		name        string
		shot        Shot
		wantSeat    int
		wantOpts    []Option
		wantIllegal bool
		wantFoul    Foul
	}{
		{"three balls to a rail is an illegal break", breakShot(3), 1, illegalOpts, true, FoulNone},
		{"cue ball rails and repeat hits do not count", cueRails, 1, illegalOpts, true, FoulNone},
		{"missing the rack", Shot{FromKitchen: true}, 1, illegalOpts, true, FoulNoContact},
		{"illegal break with a scratch", breakShot(2, CueBall), 1, illegalOpts, true, FoulScratch},
		{"8-ball on a legal break: breaker chooses", breakShot(4, EightBall), 0, eightOpts, false, FoulNone},
		{"8-ball alone makes the break legal", breakShot(0, EightBall), 0, eightOpts, false, FoulNone},
		{"8-ball and a scratch: opponent chooses", breakShot(4, EightBall, CueBall), 1, eightOpts, false, FoulScratch},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := NewRules()
			r.Start(0)
			res := r.Resolve(tc.shot)
			if res.Foul != tc.wantFoul || res.IllegalBreak != tc.wantIllegal {
				t.Errorf("foul=%q illegalBreak=%v, want %q %v", res.Foul, res.IllegalBreak, tc.wantFoul, tc.wantIllegal)
			}
			if r.Decision == nil {
				t.Fatal("no decision pending")
			}
			if r.Decision.Seat != tc.wantSeat || !reflect.DeepEqual(r.Decision.Options, tc.wantOpts) {
				t.Errorf("decision = %+v, want seat %d options %v", *r.Decision, tc.wantSeat, tc.wantOpts)
			}
			if r.Phase != PhaseBreaking || r.Winner != NoWinner || r.InPlay() {
				t.Errorf("phase=%q winner=%d inPlay=%v, want breaking, none, false", r.Phase, r.Winner, r.InPlay())
			}

			// No shot counts while the decision is pending.
			before := *r
			r.Resolve(shot(noCall, 3, 3))
			if *r != before {
				t.Error("Resolve changed state while a decision was pending")
			}
		})
	}
}

func TestChoose(t *testing.T) {
	tests := []struct {
		name        string
		shot        Shot // break by seat 0
		seat        int
		opt         Option
		want        ChoiceResult
		wantPhase   Phase
		wantTurn    int
		wantInHand  bool // ball in hand, limited to the kitchen
		wantStripes int
	}{
		{"illegal break: accept the table", breakShot(3), 1, OptAcceptTable, ChoiceResult{}, PhaseOpen, 1, false, 7},
		{"illegal break with a foul: accept with ball in hand", breakShot(3, CueBall), 1, OptAcceptTable, ChoiceResult{}, PhaseOpen, 1, true, 7},
		{"illegal break: re-rack and break", breakShot(3), 1, OptRerackBreak, ChoiceResult{Rerack: true}, PhaseBreaking, 1, true, 7},
		{"illegal break: offender breaks again", breakShot(3), 1, OptRerackOpponentBreaks, ChoiceResult{Rerack: true}, PhaseBreaking, 0, true, 7},
		{"8-ball: spot it, breaker continues", breakShot(4, EightBall, 11), 0, OptSpotEight, ChoiceResult{RespotEight: true}, PhaseOpen, 0, false, 6},
		{"8-ball: breaker re-breaks", breakShot(4, EightBall, 11), 0, OptRebreak, ChoiceResult{Rerack: true}, PhaseBreaking, 0, true, 7},
		{"8-ball on a foul: spot it, opponent in hand", breakShot(4, EightBall, 11, CueBall), 1, OptSpotEight, ChoiceResult{RespotEight: true}, PhaseOpen, 1, true, 6},
		{"8-ball on a foul: opponent re-breaks", breakShot(4, EightBall, 11, CueBall), 1, OptRebreak, ChoiceResult{Rerack: true}, PhaseBreaking, 1, true, 7},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := NewRules()
			r.Start(0)
			r.Resolve(tc.shot)

			if _, err := r.Choose(1-tc.seat, tc.opt); !errors.Is(err, ErrNotYourTurn) {
				t.Errorf("choice by the wrong seat: %v, want ErrNotYourTurn", err)
			}
			if _, err := r.Choose(tc.seat, "nonsense"); !errors.Is(err, ErrBadOption) {
				t.Errorf("unknown option: %v, want ErrBadOption", err)
			}
			got, err := r.Choose(tc.seat, tc.opt)
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Errorf("result = %+v, want %+v", got, tc.want)
			}
			if r.Decision != nil || !r.InPlay() {
				t.Errorf("decision=%v inPlay=%v after choosing", r.Decision, r.InPlay())
			}
			if r.Phase != tc.wantPhase || r.Turn != tc.wantTurn {
				t.Errorf("phase=%q turn=%d, want %q %d", r.Phase, r.Turn, tc.wantPhase, tc.wantTurn)
			}
			if r.BallInHand != tc.wantInHand || r.Kitchen != tc.wantInHand {
				t.Errorf("ballInHand=%v kitchen=%v, want both %v", r.BallInHand, r.Kitchen, tc.wantInHand)
			}
			if n := r.Remaining(GroupStripes); n != tc.wantStripes {
				t.Errorf("stripes remaining = %d, want %d", n, tc.wantStripes)
			}
			if _, err := r.Choose(tc.seat, tc.opt); !errors.Is(err, ErrNoDecision) {
				t.Errorf("second choice: %v, want ErrNoDecision", err)
			}
		})
	}
}

func TestEightOptionsNotOfferedForIllegalBreak(t *testing.T) {
	r := NewRules()
	r.Start(0)
	r.Resolve(breakShot(3))
	if _, err := r.Choose(1, OptSpotEight); !errors.Is(err, ErrBadOption) {
		t.Errorf("err = %v, want ErrBadOption", err)
	}
}

func TestResolveOutsidePlayIsNoOp(t *testing.T) {
	r := NewRules()
	before := *r
	if res := r.Resolve(shot(noCall, 1, 1)); res.Foul != FoulNone || len(res.Pocketed) != 0 {
		t.Errorf("unexpected result in lobby: %+v", res)
	}
	if *r != before {
		t.Error("Resolve changed the lobby state")
	}
}

// --- Game: rules wired to the physics table ---

const up = -math.Pi / 2 // toward the top rail

// tick runs the game until the shot in progress is resolved.
func tick(t *testing.T, g *Game) *ShotResult {
	t.Helper()
	for i := 0; i < 60*120; i++ {
		if res := g.Tick(); res != nil {
			return res
		}
	}
	t.Fatal("shot did not settle within 120 s")
	return nil
}

// sparseGame returns a game in the given phase with seat 0 to shoot and only
// the given balls on the table.
func sparseGame(phase Phase, balls map[int]Vec) *Game {
	g := NewGame(DefaultConfig())
	g.Start(0)
	if phase != PhaseBreaking {
		g.Rules.Phase = phase
		g.Rules.BallInHand, g.Rules.Kitchen = false, false
		g.cueInKitchen = false
	}
	for i := range g.Table.Balls {
		g.Table.Balls[i].Pocketed = true
	}
	for id, pos := range balls {
		g.Table.Balls[id] = Ball{ID: id, Pos: pos}
	}
	return g
}

func TestGameActionValidation(t *testing.T) {
	cfg := DefaultConfig()
	g := NewGame(cfg)
	if err := g.Shoot(0, 0, 0.5, Call{}); !errors.Is(err, ErrWrongPhase) {
		t.Errorf("shoot in lobby: %v, want ErrWrongPhase", err)
	}
	if g.Tick() != nil {
		t.Error("Tick returned a result with no shot in progress")
	}

	g.Start(0)
	if err := g.Shoot(1, 0, 0.5, Call{}); !errors.Is(err, ErrNotYourTurn) {
		t.Errorf("shoot out of turn: %v, want ErrNotYourTurn", err)
	}
	if err := g.Shoot(0, math.NaN(), 0.5, Call{}); !errors.Is(err, ErrBadInput) {
		t.Errorf("NaN angle: %v, want ErrBadInput", err)
	}
	if err := g.Choose(0, OptRebreak); !errors.Is(err, ErrNoDecision) {
		t.Errorf("choose with nothing pending: %v, want ErrNoDecision", err)
	}

	// The break starts with the cue ball in hand above the head string.
	if err := g.PlaceCue(1, Vec{0.3, 0.3}); !errors.Is(err, ErrNotYourTurn) {
		t.Errorf("place by the wrong seat: %v, want ErrNotYourTurn", err)
	}
	if err := g.PlaceCue(0, Vec{cfg.HeadString() + 0.01, 0.3}); !errors.Is(err, ErrBadPlacement) {
		t.Errorf("place below the head string: %v, want ErrBadPlacement", err)
	}
	if err := g.PlaceCue(0, Vec{0.4, 0.5}); err != nil {
		t.Fatalf("place in the kitchen: %v", err)
	}

	if err := g.Shoot(0, math.Atan2(cfg.FootSpot().Y-0.5, cfg.FootSpot().X-0.4), 1, Call{}); err != nil {
		t.Fatalf("legal break rejected: %v", err)
	}
	if !g.Moving() {
		t.Error("game not moving after a shot")
	}
	if err := g.Shoot(0, 0, 0.6, Call{}); !errors.Is(err, ErrBallsMoving) {
		t.Errorf("shoot while moving: %v, want ErrBallsMoving", err)
	}
	if err := g.PlaceCue(0, Vec{0.4, 0.5}); !errors.Is(err, ErrBallsMoving) {
		t.Errorf("place while moving: %v, want ErrBallsMoving", err)
	}

	res := tick(t, g)
	if g.Moving() {
		t.Error("game still moving after the shot resolved")
	}
	if res.Shooter != 0 || res.Foul == FoulNoContact {
		t.Errorf("break result %+v, want a shot by seat 0 that hit the rack", res)
	}
	// Whatever the break produced, the state must be consistent with it.
	needsDecision := res.IllegalBreak || slicesContains(res.Pocketed, EightBall)
	if needsDecision != (g.Rules.Decision != nil) {
		t.Errorf("result %+v but decision = %v", res, g.Rules.Decision)
	}
	if !needsDecision && g.Rules.Phase != PhaseOpen {
		t.Errorf("phase after break = %q, want open", g.Rules.Phase)
	}
}

func slicesContains(s []int, v int) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func TestGameNeedsNoCallAfterTheBreak(t *testing.T) {
	cfg := DefaultConfig()
	g := sparseGame(PhaseOpen, map[int]Vec{
		CueBall: {cfg.TableWidth / 2, 0.32}, // close enough for a stun: the cue ball stays out of the pocket
		3:       {cfg.TableWidth / 2, 0.2},
		12:      {2.0, 1.0},
	})
	// The 3 straight up into the top-middle pocket, nothing called.
	if err := g.Shoot(0, up, 0.3, noCall); err != nil {
		t.Fatal(err)
	}
	res := tick(t, g)
	if res.Foul != FoulNone || !res.Made || !reflect.DeepEqual(res.Pocketed, []int{3}) {
		t.Fatalf("result %+v, want the 3 made", res)
	}
	if g.Rules.Phase != PhaseAssigned || g.Rules.Groups != [2]Group{GroupSolids, GroupStripes} || g.Rules.Turn != 0 {
		t.Errorf("phase=%q groups=%v turn=%d, want assigned, seat 0 solids, seat 0 to shoot",
			g.Rules.Phase, g.Rules.Groups, g.Rules.Turn)
	}
}

func TestGameEightNeedsItsPocket(t *testing.T) {
	cfg := DefaultConfig()
	onEight := func() *Game {
		g := sparseGame(PhaseAssigned, map[int]Vec{
			CueBall:   {cfg.TableWidth / 2, 0.32}, // close enough for a stun: the cue ball stays out of the pocket
			EightBall: {cfg.TableWidth / 2, 0.2},
			12:        {2.0, 1.0},
		})
		g.Rules.Groups = [2]Group{GroupSolids, GroupStripes}
		for _, id := range allSolids {
			g.Rules.pocketed[id] = true
		}
		return g
	}
	g := onEight()
	if err := g.Shoot(0, up, 0.3, noCall); !errors.Is(err, ErrBadCall) {
		t.Fatalf("shot at the 8-ball without a pocket: %v, want ErrBadCall", err)
	}
	if g.Moving() {
		t.Fatal("rejected shot moved the balls")
	}
	// The 8 drops in the top-middle pocket (1); pocket 4 was called: loss.
	if err := g.Shoot(0, up, 0.3, into(4)); err != nil {
		t.Fatal(err)
	}
	res := tick(t, g)
	if res.Foul != FoulNone || res.Made || g.Rules.Phase != PhaseGameOver || g.Rules.Winner != 1 {
		t.Fatalf("wrong pocket: result %+v phase %q winner %d, want a loss", res, g.Rules.Phase, g.Rules.Winner)
	}
	// Called correctly: win.
	g = onEight()
	if err := g.Shoot(0, up, 0.3, into(1)); err != nil {
		t.Fatal(err)
	}
	res = tick(t, g)
	if res.Foul != FoulNone || !res.Made || g.Rules.Phase != PhaseGameOver || g.Rules.Winner != 0 {
		t.Fatalf("called pocket: result %+v phase %q winner %d, want a win", res, g.Rules.Phase, g.Rules.Winner)
	}
}

func TestGameScratchGivesBallInHand(t *testing.T) {
	cfg := DefaultConfig()
	g := sparseGame(PhaseOpen, map[int]Vec{
		CueBall: {cfg.TableWidth / 2, 0.4},
		1:       {2.0, 1.0},
	})
	// Cue ball straight into the top side pocket.
	if err := g.Shoot(0, up, 0.3, noCall); err != nil {
		t.Fatal(err)
	}
	res := tick(t, g)

	if res.Foul != FoulScratch || !reflect.DeepEqual(res.Pocketed, []int{CueBall}) {
		t.Fatalf("result %+v, want a scratch", res)
	}
	if g.Rules.Turn != 1 || !g.Rules.BallInHand || g.Rules.Kitchen {
		t.Fatalf("turn=%d ballInHand=%v kitchen=%v, want 1 true false", g.Rules.Turn, g.Rules.BallInHand, g.Rules.Kitchen)
	}
	cue := g.Table.Balls[CueBall]
	if cue.Pocketed || cue.Pos != cfg.HeadSpot() {
		t.Errorf("cue ball not back on the head spot: %+v", cue)
	}

	// Seat 1 has ball in hand anywhere; placement is validated.
	if err := g.PlaceCue(0, Vec{0.5, 0.5}); !errors.Is(err, ErrNotYourTurn) {
		t.Errorf("place by the wrong seat: %v, want ErrNotYourTurn", err)
	}
	bad := map[string]Vec{
		"outside the table":      {-0.1, 0.5},
		"inside the rail":        {cfg.BallRadius / 2, 0.5},
		"in a pocket":            {cfg.BallRadius, cfg.BallRadius},
		"overlapping a ball":     g.Table.Balls[1].Pos.Add(Vec{cfg.BallRadius, 0}),
		"beyond the far cushion": {cfg.TableWidth, cfg.TableHeight},
		"not a number":           {math.NaN(), 0.5},
	}
	for name, pos := range bad {
		if err := g.PlaceCue(1, pos); !errors.Is(err, ErrBadPlacement) {
			t.Errorf("place %s: %v, want ErrBadPlacement", name, err)
		}
	}
	if g.Table.Balls[CueBall].Pos != cfg.HeadSpot() {
		t.Error("rejected placement moved the cue ball")
	}
	want := Vec{1.5, 0.3} // below the head string: allowed after a standard foul
	if err := g.PlaceCue(1, want); err != nil {
		t.Fatalf("legal placement rejected: %v", err)
	}
	if g.Table.Balls[CueBall].Pos != want {
		t.Errorf("cue ball at %v, want %v", g.Table.Balls[CueBall].Pos, want)
	}
}

func TestGameBreakScratchLimitsBallInHandToTheKitchen(t *testing.T) {
	cfg := DefaultConfig()
	g := NewGame(cfg)
	g.Start(0)
	// A hard break with the cue ball leaving toward a pocket is hard to stage,
	// so resolve a hand-built break scratch through the rules and check that
	// the game enforces the resulting restriction.
	g.Rules.Resolve(breakShot(5, 11, CueBall))
	if !g.Rules.Kitchen || g.Rules.Turn != 1 {
		t.Fatalf("kitchen=%v turn=%d, want true 1", g.Rules.Kitchen, g.Rules.Turn)
	}
	if err := g.PlaceCue(1, Vec{1.0, 0.3}); !errors.Is(err, ErrBadPlacement) {
		t.Errorf("place below the head string: %v, want ErrBadPlacement", err)
	}
	if err := g.PlaceCue(1, Vec{0.3, 0.3}); err != nil {
		t.Errorf("place in the kitchen: %v", err)
	}
}

func TestGameKitchenFoul(t *testing.T) {
	cfg := DefaultConfig()
	tests := []struct {
		name   string
		object Vec
		want   Foul
	}{
		{"object ball above the head string", Vec{0.5, cfg.TableHeight / 2}, FoulKitchen},
		{"object ball below the head string", Vec{1.2, cfg.TableHeight / 2}, FoulNone},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			g := sparseGame(PhaseOpen, map[int]Vec{CueBall: {1.5, 1.0}, 3: tc.object})
			g.Rules.BallInHand, g.Rules.Kitchen = true, true
			if err := g.PlaceCue(0, Vec{0.3, cfg.TableHeight / 2}); err != nil {
				t.Fatal(err)
			}
			if err := g.Shoot(0, 0, 0.5, noCall); err != nil {
				t.Fatal(err)
			}
			if res := tick(t, g); res.Foul != tc.want {
				t.Errorf("foul = %q, want %q (events: %v)", res.Foul, tc.want, g.Table.Events)
			}
		})
	}
}

func TestGameEightOnBreak(t *testing.T) {
	cfg := DefaultConfig()
	setup := func(t *testing.T) *Game {
		// Only the cue ball, the 8-ball in front of the top side pocket and a
		// ball sitting on the foot spot.
		g := sparseGame(PhaseBreaking, map[int]Vec{
			CueBall:   {cfg.TableWidth / 2, 0.32}, // close enough for a stun: the cue ball stays out of the pocket
			EightBall: {cfg.TableWidth / 2, 0.2},
			5:         cfg.FootSpot(),
		})
		if err := g.Shoot(0, up, 0.3, Call{}); err != nil {
			t.Fatal(err)
		}
		res := tick(t, g)
		if res.Foul != FoulNone || res.IllegalBreak {
			t.Fatalf("result %+v, want a legal break", res)
		}
		d := g.Rules.Decision
		if d == nil || d.Seat != 0 || !reflect.DeepEqual(d.Options, []Option{OptSpotEight, OptRebreak}) {
			t.Fatalf("decision = %+v, want seat 0 to choose spot_eight or rebreak", d)
		}
		if err := g.Shoot(0, 0, 0.5, Call{}); !errors.Is(err, ErrWrongPhase) {
			t.Errorf("shoot while a decision is pending: %v, want ErrWrongPhase", err)
		}
		if err := g.Choose(1, OptSpotEight); !errors.Is(err, ErrNotYourTurn) {
			t.Errorf("choice by the wrong seat: %v, want ErrNotYourTurn", err)
		}
		return g
	}

	t.Run("spot the 8-ball", func(t *testing.T) {
		g := setup(t)
		if err := g.Choose(0, OptSpotEight); err != nil {
			t.Fatal(err)
		}
		if g.Rules.Phase != PhaseOpen || g.Rules.Turn != 0 || g.Rules.Winner != NoWinner {
			t.Errorf("phase=%q turn=%d winner=%d, want open, 0, none", g.Rules.Phase, g.Rules.Turn, g.Rules.Winner)
		}
		eight := g.Table.Balls[EightBall]
		if eight.Pocketed {
			t.Fatal("8-ball still pocketed")
		}
		// The foot spot is taken, so it goes on the long string just behind
		// it, toward the foot rail (WPA 1.5).
		five := g.Table.Balls[5].Pos
		if eight.Pos.Y != five.Y || eight.Pos.X <= five.X {
			t.Errorf("8-ball at %v, want behind the foot spot %v on the long string", eight.Pos, five)
		}
		if d := eight.Pos.Dist(five); d < 2*cfg.BallRadius || d > 2.2*cfg.BallRadius {
			t.Errorf("8-ball is %g m from the ball on the foot spot, want nearly touching", d)
		}
	})

	t.Run("re-break", func(t *testing.T) {
		g := setup(t)
		if err := g.Choose(0, OptRebreak); err != nil {
			t.Fatal(err)
		}
		st := g.State()
		if st.Phase != PhaseBreaking || st.Turn != 0 || len(st.Balls) != NumBalls || !st.BallInHand || !st.Kitchen || st.Decision != nil {
			t.Errorf("state after re-break: %+v", st)
		}
		if g.Table.Balls[CueBall].Pos != cfg.HeadSpot() {
			t.Errorf("cue ball at %v, want the head spot", g.Table.Balls[CueBall].Pos)
		}
	})
}

func TestGameIllegalBreak(t *testing.T) {
	g := NewGame(DefaultConfig())
	g.Start(0)
	// A tap that barely reaches the rack drives nothing to a rail.
	if err := g.Shoot(0, 0, 0.12, Call{}); err != nil {
		t.Fatal(err)
	}
	res := tick(t, g)
	if !res.IllegalBreak {
		t.Fatalf("result %+v, want an illegal break", res)
	}
	d := g.Rules.Decision
	if d == nil || d.Seat != 1 {
		t.Fatalf("decision = %+v, want seat 1 to choose", d)
	}
	if err := g.Choose(1, OptRerackOpponentBreaks); err != nil {
		t.Fatal(err)
	}
	if st := g.State(); st.Phase != PhaseBreaking || st.Turn != 0 || len(st.Balls) != NumBalls {
		t.Errorf("state after re-rack: %+v", st)
	}
	if g.Table.Balls[1].Pos != g.Table.Cfg.FootSpot() {
		t.Error("balls were not racked again")
	}
}

func TestGameOverStopsPlay(t *testing.T) {
	cfg := DefaultConfig()
	g := sparseGame(PhaseOpen, map[int]Vec{
		CueBall:   {cfg.TableWidth / 2, 0.32}, // close enough for a stun: the cue ball stays out of the pocket
		EightBall: {cfg.TableWidth / 2, 0.2},
		3:         {2.0, 1.0},
	})
	// Seat 0 calls the 3 but sinks the 8-ball.
	if err := g.Shoot(0, up, 0.3, noCall); err != nil {
		t.Fatal(err)
	}
	tick(t, g)

	if g.Rules.Phase != PhaseGameOver || g.Rules.Winner != 1 {
		t.Fatalf("phase=%q winner=%d, want game over with seat 1 winning", g.Rules.Phase, g.Rules.Winner)
	}
	if err := g.Shoot(1, 0, 0.5, noCall); !errors.Is(err, ErrWrongPhase) {
		t.Errorf("shoot after game over: %v, want ErrWrongPhase", err)
	}

	// A rematch starts from a clean rack.
	g.Start(1)
	if st := g.State(); st.Phase != PhaseBreaking || st.Turn != 1 || len(st.Balls) != NumBalls || st.Winner != NoWinner {
		t.Errorf("state after restart: %+v", st)
	}
}

func TestGameLegalEightBallWin(t *testing.T) {
	cfg := DefaultConfig()
	g := sparseGame(PhaseAssigned, map[int]Vec{
		CueBall:   {cfg.TableWidth / 2, 0.32}, // close enough for a stun: the cue ball stays out of the pocket
		EightBall: {cfg.TableWidth / 2, 0.2},
		12:        {2.0, 1.0},
	})
	g.Rules.Groups = [2]Group{GroupSolids, GroupStripes}
	for _, id := range allSolids {
		g.Rules.pocketed[id] = true
	}
	if err := g.Shoot(0, up, 0.3, noCall); !errors.Is(err, ErrBadCall) {
		t.Errorf("shooting at the 8-ball without a pocket: %v, want ErrBadCall", err)
	}
	if err := g.Shoot(0, up, 0.3, into(1)); err != nil {
		t.Fatal(err)
	}
	tick(t, g)
	if g.Rules.Phase != PhaseGameOver || g.Rules.Winner != 0 {
		t.Fatalf("phase=%q winner=%d, want game over with seat 0 winning", g.Rules.Phase, g.Rules.Winner)
	}
}

func TestStateJSON(t *testing.T) {
	g := NewGame(DefaultConfig())
	g.Start(0)
	g.Rules.Resolve(breakShot(4, EightBall))
	raw, err := json.Marshal(g.State())
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"phase":      "breaking",
		"turn":       0.0,
		"groups":     []any{"", ""},
		"ballInHand": false,
		"kitchen":    false,
		"winner":     -1.0,
		"decision":   map[string]any{"seat": 0.0, "options": []any{"spot_eight", "rebreak"}},
	}
	for k, v := range want {
		if !reflect.DeepEqual(got[k], v) {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
	if balls, _ := got["balls"].([]any); len(balls) != NumBalls {
		t.Errorf("balls has %d entries, want %d", len(balls), NumBalls)
	}

	if err := g.Choose(0, OptSpotEight); err != nil {
		t.Fatal(err)
	}
	raw, _ = json.Marshal(g.State())
	got = nil
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got["decision"] != nil || got["phase"] != "open" {
		t.Errorf("after choosing: decision=%v phase=%v, want null and open", got["decision"], got["phase"])
	}

	raw, _ = json.Marshal(into(4))
	if string(raw) != `{"pocket":4}` {
		t.Errorf("call JSON = %s", raw)
	}
}

func TestNamedPocketIsIgnoredForObjectBalls(t *testing.T) {
	r := NewRules()
	r.Start(0)
	r.Phase = PhaseOpen
	// The 3 drops in pocket 5 although pocket 1 was named: still made.
	events := []Event{
		{Kind: FirstContact, Ball: 3},
		{Kind: BallPocketed, Ball: 3, Pocket: 5},
	}
	res := r.Resolve(Shot{Events: events, Call: into(1)})
	if !res.Made || res.Foul != FoulNone {
		t.Errorf("result = %+v, want made without a foul", res)
	}
	if r.Turn != 0 || r.Groups[0] != GroupSolids {
		t.Errorf("after the pot: turn %d groups %v", r.Turn, r.Groups)
	}
}

func TestTickReportsTheFirstCollision(t *testing.T) {
	cfg := DefaultConfig()
	g := sparseGame(PhaseOpen, map[int]Vec{
		CueBall: {0.5, 0.635},
		3:       {0.5 + 0.1, 0.635},
	})
	if err := g.Shoot(0, 0, 0.5, noCall); err != nil {
		t.Fatal(err)
	}
	// 4 m/s over 0.1 − 2R ≈ 43 mm: contact in the first tick, a few steps in.
	if g.Tick() != nil {
		t.Fatal("settled at once")
	}
	ct, balls, ok := g.Collision()
	if !ok {
		t.Fatal("no collision reported in the first tick")
	}
	if ct <= 0 || ct > float64(cfg.Substeps)*cfg.Dt {
		t.Errorf("collision at %.4f s, want within the tick", ct)
	}
	var cue, obj BallState
	for _, b := range balls {
		if b.ID == CueBall {
			cue = b
		} else if b.ID == 3 {
			obj = b
		}
	}
	if d := obj.X - cue.X; !near(d, 2*cfg.BallRadius, 0.005) {
		t.Errorf("snapshot taken %.4f m apart, want the balls touching (%.4f)", d, 2*cfg.BallRadius)
	}
	// Nothing collides in the next tick (the object ball is rolling away), so
	// no second extra snapshot is offered.
	g.Tick()
	if _, _, ok := g.Collision(); ok {
		t.Error("collision reported in a tick without one")
	}
}

func TestTimeFoul(t *testing.T) {
	// On the break the opponent breaks instead, from the kitchen.
	r := NewRules()
	r.Start(0)
	r.TimeFoul()
	if r.Phase != PhaseBreaking || r.Turn != 1 || !r.BallInHand || !r.Kitchen {
		t.Errorf("after a time foul on the break: %+v", r)
	}

	// Later it is a standard foul: ball in hand anywhere.
	r = openRules(1)
	r.TimeFoul()
	if r.Phase != PhaseOpen || r.Turn != 0 || !r.BallInHand || r.Kitchen {
		t.Errorf("after a time foul on an open table: %+v", r)
	}
}

func TestGameTimeFoulIsTheShootersOnly(t *testing.T) {
	g := NewGame(DefaultConfig())
	if err := g.TimeFoul(0); err != ErrWrongPhase {
		t.Errorf("time foul in the lobby: %v, want ErrWrongPhase", err)
	}
	g.Start(0)
	if err := g.TimeFoul(1); err != ErrNotYourTurn {
		t.Errorf("time foul by the waiting player: %v, want ErrNotYourTurn", err)
	}
	if err := g.TimeFoul(0); err != nil || g.Rules.Turn != 1 {
		t.Errorf("time foul by the breaker: %v, turn %d", err, g.Rules.Turn)
	}
}
