// Package hub owns the rooms: creating them, routing WebSocket connections
// into them and deleting them when they go idle. Each room runs its own
// goroutine (see room.go) which is the only code touching that room's state.
package hub

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"billiards/internal/game"
	"billiards/internal/protocol"
	"billiards/internal/ws"
)

// codeAlphabet is A–Z without I and O, which are easy to misread.
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ"

const codeLength = 5

// Options configures a Hub. Zero fields take the values of DefaultOptions.
type Options struct {
	Game game.Config
	// IdleTimeout is how long a room may have no connected player before it
	// is deleted.
	IdleTimeout time.Duration
	// ReconnectGrace is how long a seat is held for a player who drops out
	// of a game in progress.
	ReconnectGrace time.Duration
	// WS tunes the connections (keepalive pings).
	WS ws.Options
	// Breaker picks the seat that breaks a room's first rack. Later racks
	// alternate. Nil means random.
	Breaker func() int
}

// DefaultOptions returns the production settings.
func DefaultOptions() Options {
	return Options{
		Game:           game.DefaultConfig(),
		IdleTimeout:    10 * time.Minute,
		ReconnectGrace: 60 * time.Second,
		WS:             ws.DefaultOptions(),
	}
}

// Hub is the set of live rooms. Its mutex guards only the map; game state is
// owned by the room goroutines.
type Hub struct {
	opts Options

	mu    sync.Mutex
	rooms map[string]*room
}

// New returns an empty hub.
func New(opts Options) *Hub {
	def := DefaultOptions()
	if opts.Game == (game.Config{}) {
		opts.Game = def.Game
	}
	if opts.IdleTimeout <= 0 {
		opts.IdleTimeout = def.IdleTimeout
	}
	if opts.ReconnectGrace <= 0 {
		opts.ReconnectGrace = def.ReconnectGrace
	}
	if opts.WS == (ws.Options{}) {
		opts.WS = def.WS
	}
	if opts.Breaker == nil {
		opts.Breaker = func() int {
			var b [1]byte
			rand.Read(b[:])
			return int(b[0] & 1)
		}
	}
	return &Hub{opts: opts, rooms: make(map[string]*room)}
}

// CreateRoom starts a new empty room and returns its code.
func (h *Hub) CreateRoom() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	for {
		code := newCode()
		if _, taken := h.rooms[code]; taken {
			continue
		}
		r := newRoom(h, code)
		h.rooms[code] = r
		go r.run()
		return code
	}
}

// RoomCount returns the number of live rooms.
func (h *Hub) RoomCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.rooms)
}

func (h *Hub) lookup(code string) *room {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.rooms[strings.ToUpper(strings.TrimSpace(code))]
}

func (h *Hub) remove(r *room) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.rooms[r.code] == r {
		delete(h.rooms, r.code)
	}
}

// HandleCreateRoom is the POST handler that creates a room and answers
// {"roomCode": "ABCDE"}.
func (h *Hub) HandleCreateRoom(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"roomCode": h.CreateRoom()})
}

// ServeWS upgrades the request to a WebSocket and serves it until it closes.
// The first message must be a join; after that everything is forwarded to the
// joined room.
func (h *Hub) ServeWS(w http.ResponseWriter, req *http.Request) {
	conn, err := websocket.Accept(w, req, nil)
	if err != nil {
		return // Accept already wrote the HTTP error
	}
	client := ws.NewClient(conn, h.opts.WS)

	var joined *room // touched only by the read pump below
	client.Run(req.Context(), func(msg protocol.ClientMessage) {
		switch {
		case msg.Type == protocol.TypePing:
			client.SendJSON(protocol.Pong{Type: protocol.TypePong})
		case joined != nil:
			joined.post(event{kind: evMessage, client: client, msg: msg})
		case msg.Type != protocol.TypeJoin:
			client.SendJSON(protocol.NewError(protocol.ErrNotJoined, "send join first"))
		default:
			r := h.lookup(msg.RoomCode)
			if r == nil {
				client.SendJSON(protocol.NewError(protocol.ErrRoomNotFound, "no such room"))
				return
			}
			if r.join(client, msg) {
				joined = r
			}
		}
	})
	if joined != nil {
		joined.post(event{kind: evLeave, client: client})
	}
}

func newCode() string {
	var b [codeLength]byte
	rand.Read(b[:])
	for i := range b {
		// 256 is not a multiple of 24, so the first 16 letters are very
		// slightly more likely; codes are identifiers, not secrets.
		b[i] = codeAlphabet[int(b[i])%len(codeAlphabet)]
	}
	return string(b[:])
}

// randomHex returns n random bytes, hex encoded.
func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}
