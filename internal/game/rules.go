package game

import "slices"

// The rules follow the WPA "Rules of Play" for 8-ball (section 4, with the
// general rules and fouls of sections 1–3). Rules that need a referee or a
// physical table (lag, foot on floor, double hits, balls off the table, slow
// play, stalemate) do not apply to a simulated game.

// Phase is the stage of a game. Its values are the wire representation.
type Phase string

const (
	PhaseLobby    Phase = "lobby"
	PhaseBreaking Phase = "breaking"
	PhaseOpen     Phase = "open"     // after the break, no groups yet
	PhaseAssigned Phase = "assigned" // solids/stripes decided
	PhaseGameOver Phase = "game_over"
)

// Group is a set of object balls a player must clear before the 8-ball.
type Group string

const (
	GroupNone    Group = ""
	GroupSolids  Group = "solids"  // 1–7
	GroupStripes Group = "stripes" // 9–15
)

// GroupOf returns the group ball id belongs to; the cue ball and the 8-ball
// belong to none.
func GroupOf(id int) Group {
	switch {
	case id >= 1 && id <= 7:
		return GroupSolids
	case id >= 9 && id <= 15:
		return GroupStripes
	}
	return GroupNone
}

func (g Group) other() Group {
	switch g {
	case GroupSolids:
		return GroupStripes
	case GroupStripes:
		return GroupSolids
	}
	return GroupNone
}

// Foul says why a shot was a standard foul (WPA 4.9). Its values are the wire
// representation. If several fouls happen on one shot only one is reported.
type Foul string

const (
	FoulNone      Foul = ""
	FoulScratch   Foul = "scratch"    // 3.1: cue ball pocketed
	FoulNoContact Foul = "no_contact" // 3.3: cue ball touched nothing
	FoulWrongBall Foul = "wrong_ball" // 3.2: first contact was not a legal target
	FoulKitchen   Foul = "kitchen"    // 3.11: bad play from above the head string
	FoulNoRail    Foul = "no_rail"    // 3.3: nothing pocketed and no rail after contact
)

// Call is the shooter's declaration before a shot (WPA 1.7): one ball and the
// pocket it is meant for, or a safety. It is not used on the break.
type Call struct {
	Safety bool `json:"safety,omitempty"`
	Ball   int  `json:"ball"`
	Pocket int  `json:"pocket"`
}

// Shot is everything the rules need to judge one settled shot.
type Shot struct {
	Events []Event
	Call   Call
	// FromKitchen: the cue ball was in hand above the head string and was
	// played from there.
	FromKitchen bool
}

// Option is a choice offered to a player after the break (WPA 4.3). Its
// values are the wire representation.
type Option string

const (
	// OptSpotEight: the 8-ball went down on the break; spot it and play on.
	OptSpotEight Option = "spot_eight"
	// OptRebreak: the 8-ball went down on the break; re-rack, the chooser breaks.
	OptRebreak Option = "rebreak"
	// OptAcceptTable: illegal break; play the balls where they lie.
	OptAcceptTable Option = "accept_table"
	// OptRerackBreak: illegal break; re-rack and the chooser breaks.
	OptRerackBreak Option = "rerack_break"
	// OptRerackOpponentBreaks: illegal break; re-rack and the offender breaks again.
	OptRerackOpponentBreaks Option = "rerack_opponent_breaks"
)

// Decision is a pending choice. No shot is allowed until Seat has chosen.
type Decision struct {
	Seat    int      `json:"seat"`
	Options []Option `json:"options"`
}

// ChoiceResult tells the table what a choice requires.
type ChoiceResult struct {
	Rerack      bool // rack all balls again for a new break
	RespotEight bool // put the 8-ball back on the foot spot
}

// NoWinner is the value of Rules.Winner while the game is undecided.
const NoWinner = -1

// minBreakRails is how many object balls a break that pockets nothing must
// drive to a rail to be legal (WPA 4.3 d).
const minBreakRails = 4

// ShotResult is what Rules.Resolve decided about one shot.
type ShotResult struct {
	Shooter      int
	Foul         Foul
	Pocketed     []int // every ball pocketed this shot, in order, cue ball included
	CuePocketed  bool  // the cue ball must be put back on the table
	CalledMade   bool  // the called ball went into the called pocket
	IllegalBreak bool  // break shot that pocketed nothing and drove too few balls to a rail
}

// Rules is the 8-ball state machine. It consumes the physics event list of
// each shot once the table has settled and knows nothing about positions.
type Rules struct {
	Phase      Phase
	Turn       int       // seat (0 or 1) that shoots next
	Groups     [2]Group  // by seat; GroupNone until assigned
	BallInHand bool      // Turn may place the cue ball before shooting
	Kitchen    bool      // ...but only above the head string
	Decision   *Decision // pending post-break choice, if any
	Winner     int       // seat, or NoWinner

	pocketed     [NumBalls]bool // object balls that are permanently down
	decisionFoul bool           // the break awaiting a decision was a foul
}

// NewRules returns the rules in the lobby phase.
func NewRules() *Rules {
	return &Rules{Phase: PhaseLobby, Winner: NoWinner}
}

// Start begins a fresh rack with breaker to shoot the break. The cue ball is
// in hand above the head string (WPA 4.3 a).
func (r *Rules) Start(breaker int) {
	*r = Rules{Phase: PhaseBreaking, Turn: breaker, BallInHand: true, Kitchen: true, Winner: NoWinner}
}

// InPlay reports whether a shot is currently allowed.
func (r *Rules) InPlay() bool {
	if r.Decision != nil {
		return false
	}
	return r.Phase == PhaseBreaking || r.Phase == PhaseOpen || r.Phase == PhaseAssigned
}

// Remaining returns how many balls of group g are still on the table.
func (r *Rules) Remaining(g Group) int {
	n := 0
	for id := 1; id < NumBalls; id++ {
		if GroupOf(id) == g && !r.pocketed[id] {
			n++
		}
	}
	return n
}

// eightOn reports whether the 8-ball is seat's legal target: their group is
// cleared or, on an open table, either group is (WPA 4.4: the shooter may then
// claim that group and shoot the 8-ball).
func (r *Rules) eightOn(seat int) bool {
	switch r.Phase {
	case PhaseOpen:
		return r.Remaining(GroupSolids) == 0 || r.Remaining(GroupStripes) == 0
	case PhaseAssigned:
		return r.Remaining(r.Groups[seat]) == 0
	}
	return false
}

// legalTarget reports whether the current shooter may call ball and hit it
// first.
func (r *Rules) legalTarget(ball int) bool {
	if ball < 1 || ball >= NumBalls || r.pocketed[ball] {
		return false
	}
	eightOn := r.eightOn(r.Turn)
	switch r.Phase {
	case PhaseBreaking:
		return true
	case PhaseOpen:
		return ball != EightBall || eightOn
	case PhaseAssigned:
		if eightOn {
			return ball == EightBall
		}
		return GroupOf(ball) == r.Groups[r.Turn]
	}
	return false
}

// CheckCall validates the current shooter's call before the shot: a safety,
// or a legal target ball and an existing pocket. Nothing is called on the
// break.
func (r *Rules) CheckCall(c Call) error {
	if r.Phase == PhaseBreaking || c.Safety {
		return nil
	}
	if c.Pocket < 0 || c.Pocket >= NumPockets || !r.legalTarget(c.Ball) {
		return ErrBadCall
	}
	return nil
}

// Resolve applies one settled shot by the current Turn and updates phase,
// turn, groups, ball-in-hand, pending decision and winner.
func (r *Rules) Resolve(s Shot) ShotResult {
	shooter, opponent := r.Turn, 1-r.Turn
	res := ShotResult{Shooter: shooter}
	if !r.InPlay() {
		return res
	}
	breaking := r.Phase == PhaseBreaking

	// Legality is judged against the table as it was when the shot was struck,
	// so both are evaluated before this shot's pocketed balls are recorded.
	called := !breaking && !s.Call.Safety && r.CheckCall(s.Call) == nil
	first := -1
	firstLegal := false

	var (
		firstInKitchen bool
		crossedHead    bool // before the first contact
		railAfter      bool // a ball reached a rail after the first contact
		eightPocketed  bool
		objectPocketed bool // an object ball other than the 8
		toRail         [NumBalls]bool
	)
	for _, e := range s.Events {
		switch e.Kind {
		case HeadStringCrossed:
			crossedHead = crossedHead || first < 0
		case FirstContact:
			if first < 0 {
				first = e.Ball
				firstInKitchen = e.InKitchen
				firstLegal = r.legalTarget(e.Ball)
			}
		case CushionHit:
			railAfter = railAfter || first >= 0
			toRail[e.Ball] = true
		case BallPocketed:
			res.Pocketed = append(res.Pocketed, e.Ball)
			if called && e.Ball == s.Call.Ball && e.Pocket == s.Call.Pocket {
				res.CalledMade = true
			}
			switch e.Ball {
			case CueBall:
				res.CuePocketed = true
			case EightBall:
				eightPocketed = true
			default:
				objectPocketed = true
			}
		}
	}
	for _, id := range res.Pocketed {
		if id != CueBall && id != EightBall {
			r.pocketed[id] = true
		}
	}

	switch {
	case res.CuePocketed:
		res.Foul = FoulScratch
	case first < 0:
		res.Foul = FoulNoContact
	case !firstLegal:
		res.Foul = FoulWrongBall
	case s.FromKitchen && firstInKitchen && !crossedHead:
		res.Foul = FoulKitchen
	case len(res.Pocketed) == 0 && !railAfter:
		res.Foul = FoulNoRail
	}
	legal := res.Foul == FoulNone

	r.BallInHand, r.Kitchen = false, false

	if breaking {
		railed := 0
		for id := 1; id < NumBalls; id++ {
			if toRail[id] {
				railed++
			}
		}
		res.IllegalBreak = !eightPocketed && !objectPocketed && railed < minBreakRails

		switch {
		case eightPocketed:
			// 4.3 e/f: the breaker chooses after a legal break, the opponent
			// after a foul.
			seat := shooter
			if !legal {
				seat = opponent
			}
			r.Decision = &Decision{Seat: seat, Options: []Option{OptSpotEight, OptRebreak}}
			r.decisionFoul = !legal
		case res.IllegalBreak:
			// 4.3 d.
			r.Decision = &Decision{Seat: opponent, Options: []Option{OptAcceptTable, OptRerackBreak, OptRerackOpponentBreaks}}
			r.decisionFoul = !legal
		default:
			r.Phase = PhaseOpen
			if !legal {
				// 4.3 h: ball in hand above the head string.
				r.Turn, r.BallInHand, r.Kitchen = opponent, true, true
			} else if !objectPocketed {
				r.Turn = opponent
			}
		}
		return res
	}

	if eightPocketed {
		// 4.8: the 8-ball must be the called ball, in the called pocket, on a
		// shot without a foul. CalledMade implies it was a legal target.
		r.Winner = opponent
		if legal && res.CalledMade && s.Call.Ball == EightBall {
			r.Winner = shooter
		}
		r.Phase = PhaseGameOver
		return res
	}

	keepTurn := legal && res.CalledMade
	if keepTurn && r.Phase == PhaseOpen {
		// 4.4: legally pocketing the called ball decides the groups.
		r.Groups[shooter] = GroupOf(s.Call.Ball)
		r.Groups[opponent] = GroupOf(s.Call.Ball).other()
		r.Phase = PhaseAssigned
	}
	r.BallInHand = !legal
	if !keepTurn {
		r.Turn = opponent
	}
	return res
}

// Choose answers the pending decision for seat.
func (r *Rules) Choose(seat int, opt Option) (ChoiceResult, error) {
	d := r.Decision
	switch {
	case d == nil:
		return ChoiceResult{}, ErrNoDecision
	case seat != d.Seat:
		return ChoiceResult{}, ErrNotYourTurn
	case !slices.Contains(d.Options, opt):
		return ChoiceResult{}, ErrBadOption
	}
	foul := r.decisionFoul

	switch opt {
	case OptRebreak, OptRerackBreak:
		r.Start(seat)
		return ChoiceResult{Rerack: true}, nil
	case OptRerackOpponentBreaks:
		r.Start(1 - seat)
		return ChoiceResult{Rerack: true}, nil
	}
	// Spot the 8-ball or accept the table: the chooser plays the balls where
	// they lie, with ball in hand above the head string if the break was a
	// foul.
	r.Decision, r.decisionFoul = nil, false
	r.Phase = PhaseOpen
	r.Turn = seat
	r.BallInHand, r.Kitchen = foul, foul
	return ChoiceResult{RespotEight: opt == OptSpotEight}, nil
}
