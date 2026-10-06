// Command server runs the pool game: the static client, the room API and the
// WebSocket endpoint, all in one process with all state in memory.
package main

import (
	"flag"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"reflect"
	"strconv"
	"strings"
	"time"

	"billiards/internal/game"
	"billiards/internal/hub"
	"billiards/web"
)

func main() {
	def := hub.DefaultOptions()
	defAddr := ":8080"
	if port := os.Getenv("PORT"); port != "" { // Render, Cloud Run and friends
		defAddr = ":" + port
	}
	addr := flag.String("addr", defAddr, "listen address (defaults to :$PORT when PORT is set)")
	hold := flag.Duration("hold", def.ReconnectGrace, "how long a seat is held for a player who drops out while the other is connected")
	abandon := flag.Duration("abandon", def.AbandonTimeout, "how long a game survives with both players gone")
	idle := flag.Duration("idle", def.IdleTimeout, "how long an empty room is kept")
	maxRooms := flag.Int("max-rooms", def.MaxRooms, "how many rooms may exist at once")
	shotClock := flag.Duration("shot-clock", def.ShotClock, "time for each shot or decision; 0 turns the shot clock off")
	longClock := flag.Duration("shot-clock-long", def.LongShotClock, "time for the first shot after the break, and what a player's one extension per game resets the clock to")
	defAim := int(math.Round(def.AimLine * 1000))
	if v := os.Getenv("AIM_LINE_MM"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			log.Fatalf("AIM_LINE_MM=%q: want a whole number of millimetres, 0 or more", v)
		}
		defAim = n
	}
	aimLine := flag.Int("aim-line", defAim, "length in mm of the aim guide's object-ball line after contact, 0 hides it (default from $AIM_LINE_MM)")
	var physics physicsFlag
	if v := os.Getenv("PHYSICS"); v != "" {
		physics.Set(v) // applied first, so -physics on the command line wins
	}
	flag.Var(&physics, "physics", "override a physics constant, Name=value (repeatable, or comma-separated; also $PHYSICS); -physics list prints them")
	flag.Parse()

	opts := def
	opts.ReconnectGrace = *hold
	opts.AbandonTimeout = *abandon
	opts.IdleTimeout = *idle
	opts.MaxRooms = *maxRooms
	opts.ShotClock = *shotClock
	if *shotClock <= 0 {
		opts.ShotClock = -1 // off; zero would mean the default
	}
	opts.LongShotClock = *longClock
	opts.AimLine = float64(*aimLine) / 1000
	if *aimLine <= 0 {
		opts.AimLine = -1 // off; zero would mean the default
	}
	if err := physics.apply(&opts.Game); err != nil {
		log.Fatal(err)
	}
	h := hub.New(opts)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/rooms", h.HandleCreateRoom)
	mux.HandleFunc("GET /api/rooms", h.HandleListRooms)
	mux.HandleFunc("GET /ws", h.ServeWS)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprintln(w, "ok")
	})
	static := http.FileServerFS(web.Files)
	mux.Handle("GET /fonts/", immutable(static))
	mux.Handle("GET /", noCache(static))

	srv := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("listening on %s", *addr)
	log.Fatal(srv.ListenAndServe())
}

// immutable lets browsers keep the fonts: they never change without a new
// file name, and embed.FS gives the file server no validator to revalidate
// with, so no-cache would mean a full download on every visit.
func immutable(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		next.ServeHTTP(w, r)
	})
}

// noCache makes browsers revalidate static files so a restarted server is
// never played with a stale client.
func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		next.ServeHTTP(w, r)
	})
}

// physicsFlag collects -physics Name=value overrides for game.Config, so the
// feel of the table can be tuned without a rebuild (friction, cushions, cue
// speed...). Only float fields can be set; "list" prints them with their
// defaults and exits.
type physicsFlag struct{ sets []string }

func (f *physicsFlag) String() string { return strings.Join(f.sets, ",") }
func (f *physicsFlag) Set(v string) error {
	for _, part := range strings.Split(v, ",") {
		if part = strings.TrimSpace(part); part != "" {
			f.sets = append(f.sets, part)
		}
	}
	return nil
}

func (f *physicsFlag) apply(cfg *game.Config) error {
	v := reflect.ValueOf(cfg).Elem()
	for _, set := range f.sets {
		if set == "list" {
			def := reflect.ValueOf(game.DefaultConfig())
			for i := 0; i < v.NumField(); i++ {
				if fld := v.Type().Field(i); fld.Type.Kind() == reflect.Float64 {
					fmt.Printf("%-24s %g\n", fld.Name, def.Field(i).Float())
				}
			}
			os.Exit(0)
		}
		name, val, ok := strings.Cut(set, "=")
		fld := v.FieldByName(name)
		if !ok || !fld.IsValid() || fld.Kind() != reflect.Float64 {
			return fmt.Errorf("-physics %q: want Name=value with a float field of game.Config (try -physics list)", set)
		}
		x, err := strconv.ParseFloat(val, 64)
		if err != nil {
			return fmt.Errorf("-physics %q: %v", set, err)
		}
		fld.SetFloat(x)
		log.Printf("physics: %s = %g", name, x)
	}
	return nil
}
