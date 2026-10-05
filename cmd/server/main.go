// Command server runs the pool game: the static client, the room API and the
// WebSocket endpoint, all in one process with all state in memory.
package main

import (
	"flag"
	"log"
	"net/http"
	"time"

	"billiards/internal/hub"
	"billiards/web"
)

func main() {
	def := hub.DefaultOptions()
	addr := flag.String("addr", ":8080", "listen address")
	hold := flag.Duration("hold", def.ReconnectGrace, "how long a seat is held for a player who drops out while the other is connected")
	abandon := flag.Duration("abandon", def.AbandonTimeout, "how long a game survives with both players gone")
	idle := flag.Duration("idle", def.IdleTimeout, "how long an empty room is kept")
	maxRooms := flag.Int("max-rooms", def.MaxRooms, "how many rooms may exist at once")
	flag.Parse()

	opts := def
	opts.ReconnectGrace = *hold
	opts.AbandonTimeout = *abandon
	opts.IdleTimeout = *idle
	opts.MaxRooms = *maxRooms
	h := hub.New(opts)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/rooms", h.HandleCreateRoom)
	mux.HandleFunc("GET /api/rooms", h.HandleListRooms)
	mux.HandleFunc("GET /ws", h.ServeWS)
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
