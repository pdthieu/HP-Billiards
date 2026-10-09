package game

import (
	"math"
	"slices"
	"testing"
)

// Hand-built carom shots: rail(k) is the cue ball (the white unless said
// otherwise) touching cushion k, hit(id) touching ball id.
func rail(k int) Event { return Event{Kind: CushionHit, Ball: CaromWhite, Rail: k} }
func hit(id int) Event { return Event{Kind: BallContact, Ball: id} }

func caromShot(events ...Event) Shot { return Shot{Events: events, Call: noCall} }

// caromRules returns three-cushion rules to target points after the break,
// seat 0 (the breaker, with the white) to shoot.
func caromRules(target int) *Rules {
	r := NewRules()
	r.Mode, r.Target = ModeCarom, target
	r.Start(0)
	r.Phase = PhaseOpen
	return r
}

func TestReadCarom(t *testing.T) {
	cases := []struct {
		name     string
		events   []Event
		point    bool
		cushions int
	}{
		{"three cushions first", []Event{rail(0), rail(3), rail(1), hit(CaromRed), hit(CaromYellow)}, true, 3},
		{"ball first, then three", []Event{hit(CaromRed), rail(0), rail(3), rail(1), hit(CaromYellow)}, true, 3},
		{"cushions either side of the first ball", []Event{rail(2), hit(CaromRed), rail(0), rail(3), hit(CaromYellow)}, true, 3},
		{"two cushions", []Event{hit(CaromRed), rail(0), rail(3), hit(CaromYellow)}, false, 2},
		{"third cushion after the second ball", []Event{hit(CaromRed), rail(0), rail(3), hit(CaromYellow), rail(1)}, false, 2},
		{"the first ball twice is not both", []Event{hit(CaromRed), rail(0), rail(3), rail(1), hit(CaromRed)}, false, 3},
		{"one cushion grazed twice counts once", []Event{hit(CaromRed), rail(0), rail(0), rail(3), hit(CaromYellow)}, false, 2},
		{"the same cushion twice around a kiss", []Event{rail(0), hit(CaromRed), rail(0), rail(3), hit(CaromYellow)}, true, 3},
		{"a corner is two cushions", []Event{hit(CaromRed), rail(0), rail(3), rail(1), rail(2), hit(CaromYellow)}, true, 4},
		{"the object balls' cushions do not count", []Event{hit(CaromRed), {Kind: CushionHit, Ball: CaromRed, Rail: 0},
			{Kind: CushionHit, Ball: CaromRed, Rail: 1}, {Kind: CushionHit, Ball: CaromRed, Rail: 3}, hit(CaromYellow)}, false, 0},
		{"missed everything", []Event{rail(0), rail(1), rail(2), rail(3)}, false, 4},
	}
	for _, c := range cases {
		p := readCarom(c.events, CaromWhite)
		if p.point != c.point || p.cushions != c.cushions {
			t.Errorf("%s: point %v with %d cushions, want %v with %d", c.name, p.point, p.cushions, c.point, c.cushions)
		}
	}
}

var point = caromShot(hit(CaromRed), rail(0), rail(3), rail(1), hit(CaromYellow))
var miss = caromShot(hit(CaromRed), rail(0), hit(CaromYellow))

func TestCaromStart(t *testing.T) {
	r := NewRules()
	r.Mode, r.Target = ModeCarom, 15
	r.Start(1)
	c := r.Carom
	if r.Phase != PhaseBreaking || r.Turn != 1 || r.BallInHand || r.Kitchen || r.Target != 15 {
		t.Fatalf("after Start(1): %+v", r)
	}
	if c.Cue != [2]int{CaromYellow, CaromWhite} || c.Breaker != 1 || c.Innings != [2]int{0, 1} {
		t.Errorf("score %+v: the breaker has the white and the first inning", c)
	}
	if r.CueBall() != CaromWhite {
		t.Errorf("the breaker strikes ball %d, want the white", r.CueBall())
	}
	if err := r.CheckCall(Call{Pocket: AnyPocket}); err != nil {
		t.Errorf("nothing is called in carom: %v", err)
	}
}

func TestCaromBreakMustHitRedFirst(t *testing.T) {
	for _, c := range []struct {
		name string
		shot Shot
		foul Foul
		made bool
	}{
		{"red first", point, FoulNone, true},
		{"yellow first", caromShot(hit(CaromYellow), rail(0), rail(3), rail(1), hit(CaromRed)), FoulWrongBall, false},
		{"nothing", caromShot(rail(0)), FoulNoContact, false},
	} {
		r := NewRules()
		r.Mode = ModeCarom
		r.Start(0)
		res := r.Resolve(c.shot)
		if res.Foul != c.foul || res.Made != c.made || r.Phase != PhaseOpen {
			t.Errorf("%s: foul %q made %v phase %s", c.name, res.Foul, res.Made, r.Phase)
		}
		if wantTurn := map[bool]int{true: 0, false: 1}[c.made]; r.Turn != wantTurn {
			t.Errorf("%s: turn %d, want %d", c.name, r.Turn, wantTurn)
		}
	}
}

func TestCaromInnings(t *testing.T) {
	r := caromRules(0)
	r.Resolve(point)
	r.Resolve(point)
	if r.Turn != 0 || r.Carom.Points != [2]int{2, 0} || r.Carom.Run != 2 {
		t.Fatalf("two points keep the inning: turn %d, %+v", r.Turn, r.Carom)
	}
	res := r.Resolve(miss)
	if res.Made || res.Foul != FoulNone || res.Cushions != 1 {
		t.Errorf("miss: %+v", res)
	}
	if r.Turn != 1 || r.Carom.Run != 0 || r.Carom.Innings != [2]int{1, 1} || r.Carom.HighRun != [2]int{2, 0} {
		t.Fatalf("a miss ends the inning: turn %d, %+v", r.Turn, r.Carom)
	}
	if r.CueBall() != CaromYellow {
		t.Errorf("the second player strikes %d, want the yellow", r.CueBall())
	}
	r.Resolve(caromShot(Event{Kind: CushionHit, Ball: CaromYellow, Rail: 0}, hit(CaromRed),
		Event{Kind: CushionHit, Ball: CaromYellow, Rail: 3}, Event{Kind: CushionHit, Ball: CaromYellow, Rail: 1}, hit(CaromWhite)))
	if r.Carom.Points != [2]int{2, 1} || r.Turn != 1 {
		t.Errorf("the yellow's point: %+v, turn %d", r.Carom, r.Turn)
	}
	// The white's cushions are not the yellow's.
	r.Resolve(caromShot(hit(CaromRed), rail(0), rail(1), rail(3), hit(CaromWhite)))
	if r.Carom.Points != [2]int{2, 1} || r.Turn != 0 {
		t.Errorf("cushions of another ball scored: %+v, turn %d", r.Carom, r.Turn)
	}
}

func TestCaromOffTableIsAFoul(t *testing.T) {
	r := caromRules(0)
	res := r.Resolve(caromShot(hit(CaromRed), rail(0), rail(3), rail(1), hit(CaromYellow), Event{Kind: BallOffTable, Ball: CaromRed}))
	if res.Foul != FoulOffTable || res.Made || r.Carom.Points != [2]int{} || r.Turn != 1 || r.BallInHand {
		t.Errorf("off the table: %+v, %+v, turn %d", res, r.Carom, r.Turn)
	}
}

func TestCaromTimeFoul(t *testing.T) {
	r := NewRules()
	r.Mode = ModeCarom
	r.Start(0)
	r.TimeFoul()
	if r.Phase != PhaseBreaking || r.Turn != 1 || r.Carom.Cue[1] != CaromWhite || r.Carom.Breaker != 1 {
		t.Errorf("time out on the break: the other player breaks with the white: %+v", r)
	}
	r = caromRules(0)
	r.TimeFoul()
	if r.Turn != 1 || r.BallInHand || r.Carom.Innings != [2]int{1, 1} {
		t.Errorf("time out: the inning ends: %+v", r)
	}
}

func TestCaromEqualizingInning(t *testing.T) {
	type step struct {
		shot   Shot
		turn   int
		winner int
		end    End
	}
	run := func(name string, r *Rules, steps []step) {
		t.Helper()
		for i, s := range steps {
			r.Resolve(s.shot)
			if r.Turn != s.turn || r.Winner != s.winner || r.End != s.end {
				t.Fatalf("%s, shot %d: turn %d winner %d end %q, want %d %d %q (%+v)", name, i, r.Turn, r.Winner, r.End, s.turn, s.winner, s.end, r.Carom)
			}
		}
	}
	yellowPoint := caromShot(hit(CaromRed), Event{Kind: CushionHit, Ball: CaromYellow, Rail: 0},
		Event{Kind: CushionHit, Ball: CaromYellow, Rail: 2}, Event{Kind: CushionHit, Ball: CaromYellow, Rail: 1}, hit(CaromWhite))

	// The breaker gets there: the other player has one inning.
	r := caromRules(2)
	run("breaker, then a miss", r, []step{
		{point, 0, NoWinner, ""},
		{point, 1, NoWinner, ""},
		{miss, 1, 0, EndPoints},
	})
	if !r.Carom.Equalizing || r.Phase != PhaseGameOver || r.Carom.Innings != [2]int{1, 1} {
		t.Errorf("after the equalizing inning: %+v", r.Carom)
	}
	run("breaker, then a draw", caromRules(2), []step{
		{point, 0, NoWinner, ""},
		{point, 1, NoWinner, ""},
		{yellowPoint, 1, NoWinner, ""},
		{yellowPoint, 1, NoWinner, EndDraw},
	})
	// The second player gets there first: no inning is owed.
	r = caromRules(1)
	run("second player", r, []step{
		{miss, 1, NoWinner, ""},
		{yellowPoint, 1, 1, EndPoints},
	})
	if r.Phase != PhaseGameOver || r.Resolve(point).Made {
		t.Error("the game is over")
	}
}

func TestCaromPractice(t *testing.T) {
	r := NewRules()
	r.Mode, r.Free = ModeCarom, true
	r.Start(0)
	for _, s := range []Shot{point, miss} {
		res := r.Resolve(s)
		if r.Turn != 0 || r.CueBall() != CaromWhite || r.Phase != PhaseOpen {
			t.Fatalf("practice: the same player plays on with the white: %+v", r)
		}
		if res.Made != (s.Events[len(s.Events)-2].Kind == CushionHit && len(s.Events) == 5) {
			t.Errorf("practice result %+v", res)
		}
	}
}

func TestCaromTable(t *testing.T) {
	g := NewGame(DefaultConfig())
	g.SetMode(ModeCarom)
	cfg := g.Table.Cfg
	if !cfg.NoPockets || cfg.TableWidth != 2.84 || len(g.Table.pockets) != 0 || len(g.Table.segments) != 4 {
		t.Fatalf("carom table: %+v, %d pockets, %d cushions", cfg, len(g.Table.pockets), len(g.Table.segments))
	}
	st := g.State()
	if len(st.Balls) != 3 || st.Carom == nil {
		t.Fatalf("carom lobby state: %+v", st)
	}
	head, foot := cfg.HeadSpot(), cfg.FootSpot()
	w, y, red := g.Table.Balls[CaromWhite].Pos, g.Table.Balls[CaromYellow].Pos, g.Table.Balls[CaromRed].Pos
	if y != head || red != foot || w.X != head.X || math.Abs(math.Abs(w.Y-head.Y)-0.182) > 1e-9 {
		t.Errorf("opening position: white %v yellow %v red %v", w, y, red)
	}
	g.SetMode(ModeEight)
	if g.Table.Cfg.NoPockets || len(g.Table.pockets) != NumPockets || len(g.State().Balls) != NumBalls {
		t.Error("back to 8-ball: the pool table")
	}
}

// caromTable returns a carom table with the three balls at the given spots.
func caromTable(white, yellow, red Vec) *Table {
	tb := NewTable(CaromConfig(DefaultConfig()))
	tb.Balls[CaromWhite].Pos, tb.Balls[CaromYellow].Pos, tb.Balls[CaromRed].Pos = white, yellow, red
	return tb
}

func settle(tb *Table) {
	for i := 0; i < 600*60 && !tb.Settled(); i++ {
		tb.Step(tb.Cfg.Dt)
	}
}

func TestCaromCushionsAndCorners(t *testing.T) {
	far := Vec{2.5, 1.2}
	// Straight into the top cushion: one hit, rail 0.
	tb := caromTable(Vec{1, 0.7}, far, Vec{2.5, 0.2})
	tb.ShootSpin(-math.Pi/2, 0.2, Vec{})
	settle(tb)
	if e := tb.Events; len(e) < 1 || e[0].Kind != CushionHit || e[0].Rail != 0 {
		t.Errorf("into the top cushion: %v", e)
	}
	// Into the top-left corner along the diagonal: both cushions count.
	tb = caromTable(Vec{0.3, 0.3}, far, Vec{2.5, 0.2})
	tb.ShootSpin(-3*math.Pi/4, 0.15, Vec{})
	tb.Step(tb.Cfg.Dt)
	for i := 0; i < 2000 && countEvents(tb.Events, CushionHit, CaromWhite) < 2; i++ {
		tb.Step(tb.Cfg.Dt)
	}
	p := readCarom(tb.Events, CaromWhite)
	if p.cushions != 2 {
		t.Errorf("a corner: %d cushions (events %v)", p.cushions, tb.Events)
	}
}

func TestCaromContactsOfEitherCueBall(t *testing.T) {
	// The yellow struck into the white: the cue ball has the higher id.
	tb := caromTable(Vec{1.2, 0.71}, Vec{0.8, 0.71}, Vec{2.5, 0.2})
	tb.Cue = CaromYellow
	tb.ShootSpin(0, 0.3, Vec{})
	settle(tb)
	if countEvents(tb.Events, FirstContact, CaromWhite) != 1 || countEvents(tb.Events, BallContact, CaromWhite) < 1 {
		t.Errorf("contacts of the yellow: %v", tb.Events)
	}
	if countEvents(tb.Events, BallContact, CaromYellow) != 0 {
		t.Errorf("the cue ball touched itself: %v", tb.Events)
	}
}

func TestCaromOffTableEscapes(t *testing.T) {
	tb := caromTable(Vec{1.4, 0.2}, Vec{0.3, 1.2}, Vec{2.5, 1.2})
	tb.ShootElevated(-math.Pi/2, 1, Vec{}, 30*math.Pi/180)
	settle(tb)
	if countEvents(tb.Events, BallOffTable, CaromWhite) != 1 {
		t.Errorf("a jump over the cushion leaves the table: %v", tb.Events)
	}
}

func TestSpotCarom(t *testing.T) {
	g := NewGame(DefaultConfig())
	g.SetMode(ModeCarom)
	g.Start(0)
	cfg := g.Table.Cfg
	r := cfg.BallRadius
	place := func(white, yellow, red Vec) {
		g.Table.Balls[CaromWhite] = Ball{ID: CaromWhite, Pos: white}
		g.Table.Balls[CaromYellow] = Ball{ID: CaromYellow, Pos: yellow}
		g.Table.Balls[CaromRed] = Ball{ID: CaromRed, Pos: red}
	}
	pos := func(id int) Vec { return g.Table.Balls[id].Pos }

	// The yellow, to play, frozen to the red: both go back on their spots.
	g.Rules.Turn = 1
	place(Vec{0.5, 0.5}, Vec{2, 1}, Vec{2 + 2*r, 1})
	var res ShotResult
	g.spotCarom(&res)
	if !res.Frozen || pos(CaromRed) != cfg.FootSpot() || pos(CaromYellow) != cfg.HeadSpot() || pos(CaromWhite) != (Vec{0.5, 0.5}) {
		t.Errorf("frozen: %+v, white %v yellow %v red %v", res, pos(0), pos(1), pos(2))
	}
	// Frozen balls that are not the incoming cue ball stay.
	place(Vec{0.5, 0.5}, Vec{2, 1}, Vec{2 + 2*r, 1})
	g.Rules.Turn = 0
	res = ShotResult{}
	g.spotCarom(&res)
	if res.Frozen || len(res.Spotted) != 0 {
		t.Errorf("object balls touching: %+v", res)
	}
	// The red off the table, its spot taken by the white: it goes on the
	// white's spot, the starting spot.
	place(cfg.FootSpot(), Vec{0.3, 0.3}, Vec{})
	g.Table.Balls[CaromRed].Pocketed = true
	res = ShotResult{OffTable: []int{CaromRed}}
	g.spotCarom(&res)
	if pos(CaromRed) != cfg.HeadSpot() || g.Table.Balls[CaromRed].Pocketed || !slices.Equal(res.Spotted, []int{CaromRed}) {
		t.Errorf("red on the starting spot: %v, %+v", pos(CaromRed), res)
	}
	// The other cue ball goes on the centre spot.
	place(Vec{0.4, 0.4}, Vec{}, Vec{2.5, 0.3})
	g.Table.Balls[CaromYellow].Pocketed = true
	res = ShotResult{OffTable: []int{CaromYellow}}
	g.spotCarom(&res)
	if pos(CaromYellow) != cfg.CenterSpot() {
		t.Errorf("yellow on the centre spot: %v", pos(CaromYellow))
	}
}

func TestCaromGame(t *testing.T) {
	g := NewGame(DefaultConfig())
	g.SetMode(ModeCarom)
	g.SetTarget(15)
	g.Start(1)
	if g.Rules.Target != 15 || g.Rules.CueBall() != CaromWhite {
		t.Fatalf("start: %+v", g.Rules)
	}
	// A soft shot along the table that touches nothing: a foul on the break.
	if err := g.Shoot(1, math.Pi, 0.05, noCall); err != nil {
		t.Fatal(err)
	}
	var res *ShotResult
	for res == nil {
		res = g.Tick()
	}
	if res.Foul != FoulNoContact || g.Rules.Turn != 0 || g.Rules.CueBall() != CaromYellow {
		t.Errorf("after a missed break: %+v, rules %+v", res, g.Rules)
	}
	st := g.State()
	if st.Carom == nil || st.Target != 15 || st.Carom.Innings != [2]int{1, 1} || len(st.Balls) != 3 {
		t.Errorf("state: %+v", st)
	}
	// The yellow is struck now.
	before := g.Table.Balls[CaromYellow].Pos
	if err := g.Shoot(0, math.Pi/2, 0.05, noCall); err != nil {
		t.Fatal(err)
	}
	for g.Tick() == nil {
	}
	if g.Table.Balls[CaromYellow].Pos == before {
		t.Error("the yellow did not move")
	}
}

func TestSpotCaromAtGameOver(t *testing.T) {
	g := NewGame(DefaultConfig())
	g.SetMode(ModeCarom)
	g.Start(0)
	g.Rules.Phase = PhaseGameOver
	r := g.Table.Cfg.BallRadius
	g.Table.Balls[CaromYellow].Pos = Vec{1, 1}
	g.Table.Balls[CaromWhite].Pos = Vec{1 + 2*r, 1} // frozen, but the game is over
	g.Table.Balls[CaromRed].Pocketed = true
	res := ShotResult{OffTable: []int{CaromRed}}
	g.spotCarom(&res)
	if res.Frozen || !slices.Equal(res.Spotted, []int{CaromRed}) || g.Table.Balls[CaromRed].Pocketed {
		t.Errorf("game over: %+v", res)
	}
}
