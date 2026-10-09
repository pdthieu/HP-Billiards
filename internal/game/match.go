package game

// BreakRule says who breaks the racks of a match after the first.
type BreakRule string

const (
	BreakAlternate BreakRule = "alternate" // the players take turns
	BreakWinner    BreakRule = "winner"    // the winner of a rack breaks the next
)

// Valid reports whether b is a known break rule.
func (b BreakRule) Valid() bool { return b == BreakAlternate || b == BreakWinner }

// MaxRace is the longest race a match may be played to.
const MaxRace = 25

// ValidRace reports whether a match of mode may be played to race: racks
// in pool, up to MaxRace, or points in carom, up to MaxCaromTarget.
func ValidRace(mode Mode, race int) bool {
	if mode == ModeCarom {
		return race >= 1 && race <= MaxCaromTarget
	}
	return race >= 1 && race <= MaxRace
}

// Rack is how one rack of a match ended.
type Rack struct {
	Winner  int  `json:"winner"` // NoWinner for a drawn carom game
	Breaker int  `json:"breaker"`
	End     End  `json:"end"`
	Foul    Foul `json:"foul,omitempty"` // EndEightFoul: the foul
}

// Match is a race: the first player to win Race racks wins. It knows nothing
// about the racks themselves; the room records each one as it ends.
//
// A carom match is one game to Race points: Score holds the points, which
// the room keeps up to date, and Final ends it, possibly in a Draw.
type Match struct {
	Race   int
	Breaks BreakRule
	Score  [2]int
	Racks  []Rack
	Winner int  // seat, or NoWinner while the match is on
	Draw   bool // a carom game ended level
}

// NewMatch returns a match to race racks, broken by rule.
func NewMatch(race int, rule BreakRule) Match {
	return Match{Race: race, Breaks: rule, Winner: NoWinner}
}

// Reset clears the score for a new match with the same settings.
func (m *Match) Reset() {
	m.Score = [2]int{}
	m.Racks = nil
	m.Winner = NoWinner
	m.Draw = false
}

// Over reports whether the match has a winner or was drawn.
func (m Match) Over() bool { return m.Winner != NoWinner || m.Draw }

// Started reports whether any rack of the match has ended.
func (m Match) Started() bool { return len(m.Racks) > 0 }

// Record adds a finished rack, won by rack.Winner, and ends the match when
// that makes the race.
func (m *Match) Record(rack Rack) {
	if m.Over() {
		return
	}
	m.Racks = append(m.Racks, rack)
	m.Score[rack.Winner]++
	if m.Score[rack.Winner] >= m.Race {
		m.Winner = rack.Winner
	}
}

// Final ends a carom match with its one game, which finished at score.
func (m *Match) Final(game Rack, score [2]int) {
	if m.Over() {
		return
	}
	m.Racks = append(m.Racks, game)
	m.Score = score
	m.Winner = game.Winner
	m.Draw = game.Winner == NoWinner
}

// Forfeit ends the match: loser walked away during the rack broken by
// breaker. That rack is listed as a forfeit and the score stays as it was.
func (m *Match) Forfeit(loser, breaker int) {
	if m.Over() {
		return
	}
	m.Racks = append(m.Racks, Rack{Winner: 1 - loser, Breaker: breaker, End: EndForfeit})
	m.Winner = 1 - loser
}

// NextBreaker is who breaks the rack after the last one recorded.
func (m Match) NextBreaker() int {
	last := m.Racks[len(m.Racks)-1]
	if m.Breaks == BreakWinner {
		return last.Winner
	}
	return 1 - last.Breaker
}

// Opener is who breaks the first rack of the next match: whoever did not
// break the first rack of this one, or fallback when it had none.
func (m Match) Opener(fallback int) int {
	if len(m.Racks) == 0 {
		return fallback
	}
	return 1 - m.Racks[0].Breaker
}
