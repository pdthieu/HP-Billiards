// Command simulate racks the table, breaks at the given power and prints how
// long the table took to settle and where every ball ended up. It is a
// headless tool for tuning game.Config.
package main

import (
	"flag"
	"fmt"
	"os"

	"billiards/internal/game"
)

func main() {
	power := flag.Float64("power", 0.8, "break power in [0,1]")
	angle := flag.Float64("angle", 0, "cue angle in radians (0 = straight at the rack)")
	maxTime := flag.Float64("max", 120, "give up after this many simulated seconds")
	flag.Parse()

	cfg := game.DefaultConfig()
	table := game.NewTable(cfg)
	table.Shoot(*angle, *power)
	fmt.Printf("break: power=%.2f angle=%.3f rad cue speed=%.2f m/s\n",
		*power, *angle, table.Balls[game.CueBall].Vel.Len())

	steps := 0
	for limit := int(*maxTime / cfg.Dt); !table.Settled(); steps++ {
		if steps >= limit {
			fmt.Printf("not settled after %.1f s\n", *maxTime)
			os.Exit(1)
		}
		table.Step(cfg.Dt)
	}
	fmt.Printf("settled after %.3f s (%d steps)\n", float64(steps)*cfg.Dt, steps)

	firstContact := "none"
	cushions := 0
	var pocketed []int
	for _, e := range table.Events {
		switch e.Kind {
		case game.FirstContact:
			firstContact = ballName(e.Ball)
		case game.CushionHit:
			cushions++
		case game.BallPocketed:
			pocketed = append(pocketed, e.Ball)
		}
	}
	fmt.Printf("first contact: %s, cushion hits: %d, pocketed: %v\n", firstContact, cushions, pocketed)

	fmt.Println("final positions (m):")
	for _, b := range table.Balls {
		if b.Pocketed {
			fmt.Printf("  %-4s pocketed\n", ballName(b.ID))
			continue
		}
		fmt.Printf("  %-4s x=%.4f y=%.4f\n", ballName(b.ID), b.Pos.X, b.Pos.Y)
	}
}

func ballName(id int) string {
	if id == game.CueBall {
		return "cue"
	}
	return fmt.Sprint(id)
}
