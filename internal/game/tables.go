package game

import "math"

// TableID names a pool table a room can play on (Tables).
type TableID string

const (
	TableDiamond  TableID = "diamond"  // Diamond Pro-Am
	TablePredator TableID = "predator" // Predator Apex 9 ft Pro
	TableRasson   TableID = "rasson"   // Rasson Victory II
	TableAcurra   TableID = "acurra"   // Rasson Mr-Sung Acurra, Matchroom pockets
)

// DefaultTable is the table a room plays on unless it picks another.
const DefaultTable = TableDiamond

// TableSpec is a real 9 ft table, by its pockets: the rest is the same on
// every table (DefaultConfig: the WPA playing surface, cushion height and
// cloth). Each figure is the maker's where it publishes one, otherwise a
// measured one (the source is noted), otherwise the middle of the WPA range
// that DefaultConfig keeps.
type TableSpec struct {
	Name           string  // maker and model, as the players see it
	CornerMouth    float64 // see Config
	SideMouth      float64
	CornerJawAngle float64
	SideJawAngle   float64
	CornerShelf    float64
	SideShelf      float64
}

const deg = math.Pi / 180

// Tables are the pool tables a room can pick (docs/PROTOCOL.md, "Tables").
var Tables = map[TableID]TableSpec{
	// The US Open's table for many years, and the Hanoi Open's in 2025.
	// Diamond's "pro cut": 4½ in corners and 5 in sides; the cuts and the
	// corner shelf as measured on one (AZBilliards forum: 141° and 102°
	// cuts by Diamond's technician, a 31.6 mm shelf against a Rasson's).
	TableDiamond: {
		Name:        "Diamond Pro-Am",
		CornerMouth: 4.5 * inch, SideMouth: 5 * inch,
		CornerJawAngle: 141 * deg, SideJawAngle: 102 * deg,
		CornerShelf: 0.0316, SideShelf: 0.25 * inch,
	},
	// The Predator Pro Billiard Series' table: Predator gives the pockets as
	// 108 mm and 125 mm.
	TablePredator: {
		Name:        "Predator Apex",
		CornerMouth: 0.108, SideMouth: 0.125,
		CornerJawAngle: 142 * deg, SideJawAngle: 104 * deg,
		CornerShelf: 1.75 * inch, SideShelf: 0.25 * inch,
	},
	// Matchroom's table since 2016 (Mosconi Cup, World Cup of Pool), with
	// the pockets Rasson cut for the Mosconi Cup at the organiser's request:
	// 4¼ in corners, 5 in sides, and a corner shelf of 21.2 mm, measured
	// against a Diamond's (AZBilliards forum).
	TableRasson: {
		Name:        "Rasson Victory II",
		CornerMouth: 4.25 * inch, SideMouth: 5 * inch,
		CornerJawAngle: 142 * deg, SideJawAngle: 104 * deg,
		CornerShelf: 0.0212, SideShelf: 0.25 * inch,
	},
	// Rasson's Mr-Sung line, played at Premier League Pool, with the
	// dealer's "Matchroom" pockets: 4 in corners, 4½ in sides.
	TableAcurra: {
		Name:        "Mr-Sung Acurra",
		CornerMouth: 4 * inch, SideMouth: 4.5 * inch,
		CornerJawAngle: 142 * deg, SideJawAngle: 104 * deg,
		CornerShelf: 1.75 * inch, SideShelf: 0.25 * inch,
	},
}

// Valid reports whether t is one of Tables.
func (t TableID) Valid() bool {
	_, ok := Tables[t]
	return ok
}

// Apply returns cfg with the table's pockets.
func (s TableSpec) Apply(cfg Config) Config {
	cfg.CornerMouth, cfg.SideMouth = s.CornerMouth, s.SideMouth
	cfg.CornerJawAngle, cfg.SideJawAngle = s.CornerJawAngle, s.SideJawAngle
	cfg.CornerShelf, cfg.SideShelf = s.CornerShelf, s.SideShelf
	return cfg
}
