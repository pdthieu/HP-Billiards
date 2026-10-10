package game

import (
	"math"
	"testing"
)

// Every table is named, has the WPA playing surface with only its pockets
// changed, side pockets wider than its corners and cuts within a few
// degrees of WPA's.
func TestTables(t *testing.T) {
	if !DefaultTable.Valid() || TableID("snooker").Valid() {
		t.Fatal("DefaultTable is not a table, or snooker is")
	}
	base := DefaultConfig()
	for id, spec := range Tables {
		cfg := spec.Apply(base)
		if spec.Name == "" {
			t.Errorf("%s has no name", id)
		}
		if cfg.CornerMouth < 1.75*2*base.BallRadius || cfg.SideMouth <= cfg.CornerMouth {
			t.Errorf("%s: corners %.1f mm, sides %.1f mm", id, cfg.CornerMouth*1000, cfg.SideMouth*1000)
		}
		if math.Abs(cfg.CornerJawAngle-142*deg) > 2*deg || math.Abs(cfg.SideJawAngle-104*deg) > 3*deg {
			t.Errorf("%s: cuts %.0f° and %.0f°", id, cfg.CornerJawAngle/deg, cfg.SideJawAngle/deg)
		}
		back := cfg
		back.CornerMouth, back.SideMouth = base.CornerMouth, base.SideMouth
		back.CornerJawAngle, back.SideJawAngle = base.CornerJawAngle, base.SideJawAngle
		back.CornerShelf, back.SideShelf = base.CornerShelf, base.SideShelf
		if back != base {
			t.Errorf("%s changes more than the pockets", id)
		}
	}
}

// cornerAcceptance is how far, in mm, a ball may run beside the line into
// the top-left corner pocket, parallel to it at a medium pace from 0.5 m
// out, and still drop: the scan stops at the first miss.
func cornerAcceptance(tb testing.TB, cfg Config) float64 {
	tb.Helper()
	axis := Vec{-1, -1}.Scale(1 / math.Sqrt2) // into the pocket
	across := Vec{1, -1}.Scale(1 / math.Sqrt2)
	mouth := Vec{cfg.CornerMouth / math.Sqrt2 / 2, cfg.CornerMouth / math.Sqrt2 / 2}
	for mm := 0; mm < 80; mm++ {
		tbl := emptyTable(cfg)
		start := mouth.Sub(axis.Scale(0.5)).Add(across.Scale(float64(mm) / 1000))
		tbl.place(3, start, axis.Scale(1.5))
		runUntilSettled(tb, tbl, 30)
		if !tbl.Balls[3].Pocketed {
			return float64(mm - 1)
		}
	}
	tb.Fatal("every offset dropped")
	return 0
}

// The tighter the pockets, the less room a ball has: a Diamond takes a
// ball further off the line than a Predator, a Predator than an Acurra
// with its Matchroom pockets; a ball on the line drops on every table.
func TestTighterPocketsTakeLess(t *testing.T) {
	base := DefaultConfig()
	got := map[TableID]float64{}
	for id, spec := range Tables {
		got[id] = cornerAcceptance(t, spec.Apply(base))
		if got[id] < 0 {
			t.Errorf("%s: a ball on the line did not drop", id)
		}
	}
	t.Logf("corner acceptance, mm off the line: %v", got)
	if !(got[TableDiamond] > got[TablePredator] && got[TablePredator] > got[TableAcurra]) {
		t.Errorf("acceptance does not narrow with the pockets: %v", got)
	}
}

// A new table changes a lobby's table at once and is racked; later it
// waits for the next Start.
func TestSetConfigRebuildsTheTable(t *testing.T) {
	g := NewGame(Tables[TableDiamond].Apply(DefaultConfig()))
	g.SetMode(ModeEight)
	acurra := Tables[TableAcurra].Apply(DefaultConfig())
	g.SetConfig(acurra)
	if g.Table.Cfg.CornerMouth != acurra.CornerMouth || len(g.Table.Snapshot()) != NumBalls {
		t.Fatalf("lobby table: corners %.1f mm, %d balls", g.Table.Cfg.CornerMouth*1000, len(g.Table.Snapshot()))
	}
	g.Start(0)
	predator := Tables[TablePredator].Apply(DefaultConfig())
	g.SetConfig(predator)
	if g.Table.Cfg.CornerMouth != acurra.CornerMouth {
		t.Error("the table changed in the middle of a rack")
	}
	g.Start(1)
	if g.Table.Cfg.CornerMouth != predator.CornerMouth {
		t.Error("the next rack is not on the new table")
	}
}
