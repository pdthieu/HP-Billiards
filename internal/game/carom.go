package game

import "math/rand/v2"

// Three-cushion follows the UMB rules (Règlement des jeux de billard,
// three-cushion articles), on a table without pockets (CaromConfig):
//
//   - Each player strikes their own cue ball, the breaker the white, the
//     other the yellow; the red belongs to nobody.
//   - The break is played from the opening position (Table.RackCarom) and
//     must hit the red first.
//   - A point is scored when the cue ball touches both other balls and has
//     touched cushions at least three times before it touches the second one.
//     The cushions may come before the first ball, between the two, or both;
//     the same cushion may count more than once.
//   - A point keeps the inning going; a miss or a foul ends it. A foul
//     scores nothing and the next player plays the balls where they lie.
//   - A ball driven off the table is a foul; it is put back on its spot.
//   - The incoming player's cue ball frozen against another ball: the balls
//     in contact go back on their spots (UMB 27.3 b).
//   - The game goes to Rules.Target points. When the breaker gets there the
//     other player has an equalizing inning: reaching the target in it too
//     draws the game, falling short loses it.
//
// Rules that need a referee or a physical table (lag, push shots, touching
// a ball, foot on the floor) do not apply. The hub's shot clock stands in
// for the time limit; running out ends the inning.

// CaromScore is the scoreboard of a carom game.
type CaromScore struct {
	Points  [2]int `json:"points"`  // by seat
	Innings [2]int `json:"innings"` // innings started, by seat
	HighRun [2]int `json:"highRun"` // the best run of the game, by seat
	Run     int    `json:"run"`     // points of the inning in progress
	// Cue is each seat's cue ball: CaromWhite for the breaker, CaromYellow
	// for the other player.
	Cue     [2]int `json:"cue"`
	Breaker int    `json:"breaker"`
	// Equalizing: the breaker has reached the target and the inning in
	// progress is the other player's last.
	Equalizing bool `json:"equalizing,omitempty"`
}

// MaxCaromTarget is the longest carom game, in points.
const MaxCaromTarget = 50

// DefaultCaromTarget is the points of a carom game when none is chosen.
const DefaultCaromTarget = 15

// startCarom sets up a carom game with breaker shooting the white.
func (r *Rules) startCarom(breaker int) {
	r.BallInHand, r.Kitchen = false, false
	r.Carom = CaromScore{Breaker: breaker}
	r.Carom.Cue[breaker], r.Carom.Cue[1-breaker] = CaromWhite, CaromYellow
	r.Carom.Innings[breaker] = 1
}

// CueBall is the ball the current shooter strikes: their own in carom, the
// cue ball otherwise.
func (r *Rules) CueBall() int {
	if r.Mode == ModeCarom {
		return r.Carom.Cue[r.Turn]
	}
	return CueBall
}

// caromPlay is what a carom shot did, read from its events.
type caromPlay struct {
	first    int  // the first ball the cue ball touched, or -1
	touched  int  // how many of the other two balls it touched
	point    bool // both balls, with three cushions before the second
	cushions int  // the cue ball's cushions before the second ball, or in all
	offTable []int
}

// readCarom walks a shot's events for cue, the ball that was struck. One
// cushion touched twice with nothing in between is one contact (a ball
// running along a rail can graze it again); a corner is two.
func readCarom(events []Event, cue int) caromPlay {
	p := caromPlay{first: -1}
	var touched [NumBalls]bool
	balls, lastRail := 0, -1
	for _, e := range events {
		switch e.Kind {
		case CushionHit:
			if e.Ball == cue && balls < 2 && e.Rail != lastRail {
				p.cushions++
				lastRail = e.Rail
			}
		case BallContact:
			lastRail = -1
			if touched[e.Ball] {
				continue
			}
			touched[e.Ball] = true
			balls++
			p.touched = balls
			if balls == 1 {
				p.first = e.Ball
			} else if balls == 2 {
				p.point = p.cushions >= 3
			}
		case BallOffTable:
			p.offTable = append(p.offTable, e.Ball)
		}
	}
	return p
}

// resolveCarom is Resolve for three-cushion.
func (r *Rules) resolveCarom(s Shot) ShotResult {
	shooter := r.Turn
	res := ShotResult{Shooter: shooter}
	p := readCarom(s.Events, r.Carom.Cue[shooter])
	res.OffTable, res.Cushions, res.Touched = p.offTable, p.cushions, p.touched
	res.CuePocketed = false // nothing drops; a ball off the table is spotted

	switch {
	case len(p.offTable) > 0:
		res.Foul = FoulOffTable
	case r.Phase == PhaseBreaking && p.first < 0:
		res.Foul = FoulNoContact
	case r.Phase == PhaseBreaking && p.first != CaromRed:
		res.Foul = FoulWrongBall
	}
	r.Phase = PhaseOpen
	c := &r.Carom
	if res.Foul != FoulNone || !p.point {
		r.endInning()
		return res
	}

	res.Made = true
	c.Points[shooter]++
	c.Run++
	c.HighRun[shooter] = max(c.HighRun[shooter], c.Run)
	if r.Target <= 0 || c.Points[shooter] < r.Target {
		return res
	}
	switch {
	case c.Equalizing:
		r.over(NoWinner, EndDraw)
	case shooter == c.Breaker:
		// The other player has one inning to draw level.
		c.Equalizing = true
		r.endInning()
	default:
		r.over(shooter, EndPoints)
	}
	return res
}

// endInning hands the table to the other player, or ends the game when the
// inning that ended was the equalizing one: the breaker, already at the
// target, wins.
func (r *Rules) endInning() {
	c := &r.Carom
	if c.Equalizing && r.Turn != c.Breaker {
		r.over(c.Breaker, EndPoints)
		return
	}
	c.Run = 0
	r.Turn = 1 - r.Turn
	c.Innings[r.Turn]++
}

// over ends the game: winner (NoWinner for a draw) and why.
func (r *Rules) over(winner int, end End) {
	r.Winner, r.End, r.Phase = winner, end, PhaseGameOver
}

// resolveCaromFree judges a practice shot like a game one, for the feedback,
// but the same player always plays on with the same ball.
func (r *Rules) resolveCaromFree(s Shot) ShotResult {
	p := readCarom(s.Events, r.Carom.Cue[r.Turn])
	res := ShotResult{Shooter: r.Turn, OffTable: p.offTable, Cushions: p.cushions, Touched: p.touched, Made: p.point}
	if len(p.offTable) > 0 {
		res.Foul = FoulOffTable
	}
	return res
}

// timeFoulCarom ends the inning of a shooter who let the shot clock run out.
// On the break nothing has moved yet: the other player breaks instead, with
// the white.
func (r *Rules) timeFoulCarom() {
	if r.Phase == PhaseBreaking {
		r.Start(1 - r.Turn)
		return
	}
	r.endInning()
}

// rackCarom sets up the opening position, the white on a random side of
// the yellow.
func (g *Game) rackCarom() {
	side := 1.0
	if rand.IntN(2) == 0 {
		side = -1
	}
	g.Table.RackCarom(side)
}

// frozenGap is how close two resting balls must be to count as touching.
const frozenGap = 0.0002 // m

// spotCarom puts back on their spots the balls the shot drove off the table
// and, when the incoming player's cue ball rests against another ball, the
// balls in contact (UMB 27.3 b). It records them in res.Spotted.
//
// The spots are the top spot (the foot spot) for the red, the starting spot
// (the head spot) for the incoming player's ball and the centre spot for
// the other cue ball. A ball whose spot is taken goes on the spot of the
// ball that is in the way.
func (g *Game) spotCarom(res *ShotResult) {
	t := g.Table
	next := g.Rules.Carom.Cue[g.Rules.Turn]
	var spot [NumBalls]bool
	for _, id := range res.OffTable {
		spot[id] = true
	}
	// Once the game is over nobody plays on: only a ball off the table
	// comes back, so that all three are seen.
	if cue := &t.Balls[next]; !cue.Pocketed && g.Rules.Phase != PhaseGameOver {
		for i := CaromWhite; i <= CaromRed; i++ {
			if b := &t.Balls[i]; i != next && !b.Pocketed && b.Pos.Dist(cue.Pos) < 2*t.Cfg.BallRadius+frozenGap {
				spot[i], spot[next] = true, true
				res.Frozen = true
			}
		}
	}
	spotOf := func(id int) Vec {
		switch id {
		case CaromRed:
			return t.Cfg.FootSpot()
		case next:
			return t.Cfg.HeadSpot()
		}
		return t.Cfg.CenterSpot()
	}
	for i := CaromWhite; i <= CaromRed; i++ {
		if spot[i] {
			t.Balls[i] = Ball{ID: i, Pocketed: true} // off, so they do not block each other's spots
		}
	}
	// The red first: its spot is the one the rules name for it.
	for _, id := range [3]int{CaromRed, next, 3 - CaromRed - next} {
		if !spot[id] {
			continue
		}
		res.Spotted = append(res.Spotted, id)
		want := spotOf(id)
		for range 3 {
			blocker := t.ballAt(want)
			if blocker < 0 {
				break
			}
			want = spotOf(blocker)
		}
		t.Spot(id, want, 1)
	}
}

// ballAt returns the ball on the table that a ball placed at pos would
// touch, or -1.
func (t *Table) ballAt(pos Vec) int {
	for i := range t.Balls {
		if b := &t.Balls[i]; !b.Pocketed && b.Pos.Dist(pos) < 2*t.Cfg.BallRadius {
			return i
		}
	}
	return -1
}
