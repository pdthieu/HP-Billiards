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
	addr := flag.String("addr", ":8080", "listen address")
	flag.Parse()

	h := hub.New(hub.DefaultOptions())

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/rooms", h.HandleCreateRoom)
	mux.HandleFunc("GET /ws", h.ServeWS)
	mux.Handle("GET /", noCache(http.FileServerFS(web.Files)))

	srv := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("listening on %s", *addr)
	log.Fatal(srv.ListenAndServe())
}

// noCache makes browsers revalidate static files so a restarted server is
// never played with a stale client.
func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		next.ServeHTTP(w, r)
	})
}
