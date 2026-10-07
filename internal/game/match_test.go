package game

import "testing"

func TestMatchRaceAndScore(t *testing.T) {
	m := NewMatch(2, BreakAlternate)
	m.Record(Rack{Winner: 0, Breaker: 1, End: EndMade})
	if m.Over() || m.Score != [2]int{1, 0} {
		t.Fatalf("after one rack: %+v", m)
	}
	m.Record(Rack{Winner: 1, Breaker: 0, End: EndEightEarly})
	m.Record(Rack{Winner: 0, Breaker: 1, End: EndThreeFouls})
	if !m.Over() || m.Winner != 0 || m.Score != [2]int{2, 1} || len(m.Racks) != 3 {
		t.Fatalf("after the race: %+v", m)
	}
	m.Record(Rack{Winner: 1}) // ignored once over
	if m.Score != [2]int{2, 1} {
		t.Errorf("a rack after the match counted: %+v", m)
	}
	m.Reset()
	if m.Over() || m.Started() || m.Score != [2]int{} || m.Race != 2 {
		t.Errorf("after reset: %+v", m)
	}
}

func TestRaceToOneIsOneRack(t *testing.T) {
	m := NewMatch(1, BreakAlternate)
	m.Record(Rack{Winner: 1, Breaker: 0, End: EndMade})
	if !m.Over() || m.Winner != 1 {
		t.Errorf("race to 1 not over after a rack: %+v", m)
	}
}

func TestMatchBreakers(t *testing.T) {
	alt := NewMatch(5, BreakAlternate)
	alt.Record(Rack{Winner: 0, Breaker: 0})
	if got := alt.NextBreaker(); got != 1 {
		t.Errorf("alternate after seat 0 broke: %d", got)
	}
	win := NewMatch(5, BreakWinner)
	win.Record(Rack{Winner: 0, Breaker: 0})
	if got := win.NextBreaker(); got != 0 {
		t.Errorf("winner breaks after seat 0 won: %d", got)
	}
	win.Record(Rack{Winner: 1, Breaker: 0})
	if got := win.NextBreaker(); got != 1 {
		t.Errorf("winner breaks after seat 1 won: %d", got)
	}
	if got := win.Opener(0); got != 1 {
		t.Errorf("next match opener after seat 0 opened: %d", got)
	}
	if got := NewMatch(3, BreakWinner).Opener(1); got != 1 {
		t.Errorf("opener of a match with no racks: %d", got)
	}
}

func TestMatchForfeit(t *testing.T) {
	m := NewMatch(3, BreakAlternate)
	m.Record(Rack{Winner: 1, Breaker: 0, End: EndMade})
	m.Forfeit(1, 1)
	if !m.Over() || m.Winner != 0 || m.Score != [2]int{0, 1} {
		t.Fatalf("after forfeit: %+v", m)
	}
	if last := m.Racks[len(m.Racks)-1]; last != (Rack{Winner: 0, Breaker: 1, End: EndForfeit}) {
		t.Errorf("forfeit rack = %+v", last)
	}
}

func TestValidRaceAndRule(t *testing.T) {
	for _, r := range []int{1, 7, MaxRace} {
		if !ValidRace(r) {
			t.Errorf("race %d rejected", r)
		}
	}
	for _, r := range []int{0, -1, MaxRace + 1} {
		if ValidRace(r) {
			t.Errorf("race %d accepted", r)
		}
	}
	if !BreakWinner.Valid() || BreakRule("loser").Valid() {
		t.Error("BreakRule.Valid")
	}
}
