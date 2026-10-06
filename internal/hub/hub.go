// Package hub owns the rooms: creating them, routing WebSocket connections
// into them and deleting them when they go idle. Each room runs its own
// goroutine (see room.go) which is the only code touching that room's state.
package hub

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
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
	// MaxRooms caps how many rooms exist at once; CreateRoom fails beyond it.
	MaxRooms int
	// ReconnectGrace is how long a seat is held for a player who drops out
	// of a game in progress while the other player is still connected.
	ReconnectGrace time.Duration
	// AbandonTimeout is how long a game survives with both players gone
	// before it is cancelled and both seats are freed.
	AbandonTimeout time.Duration
	// ShotClock is how long a player has for each shot or post-break
	// decision. Negative turns the shot clock off.
	ShotClock time.Duration
	// LongShotClock is the time for the first shot after the break, and what
	// a player's one extension per game sets their clock back to.
	LongShotClock time.Duration
	// AimLine is how far, in meters, the aim guide draws the object ball's
	// path after contact (the cue ball's deflection gets half). Negative
	// hides both: players then judge the cut themselves.
	AimLine float64
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
		MaxRooms:       3,
		ReconnectGrace: 60 * time.Second,
		AbandonTimeout: 5 * time.Minute,
		ShotClock:      30 * time.Second,
		LongShotClock:  40 * time.Second,
		AimLine:        0.1,
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
	if opts.MaxRooms <= 0 {
		opts.MaxRooms = def.MaxRooms
	}
	if opts.ReconnectGrace <= 0 {
		opts.ReconnectGrace = def.ReconnectGrace
	}
	if opts.AbandonTimeout <= 0 {
		opts.AbandonTimeout = def.AbandonTimeout
	}
	if opts.ShotClock == 0 {
		opts.ShotClock = def.ShotClock
	}
	if opts.LongShotClock <= 0 {
		opts.LongShotClock = def.LongShotClock
	}
	if opts.AimLine == 0 {
		opts.AimLine = def.AimLine
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

// ErrRoomLimit is returned by CreateRoom when MaxRooms rooms already exist.
var ErrRoomLimit = errors.New("room limit reached")

// CreateRoom starts a new empty room and returns its code. It fails with
// ErrRoomLimit when MaxRooms rooms already exist.
func (h *Hub) CreateRoom(mode game.Mode) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.rooms) >= h.opts.MaxRooms {
		return "", ErrRoomLimit
	}
	for {
		code := newCode()
		if _, taken := h.rooms[code]; taken {
			continue
		}
		r := newRoom(h, code, mode)
		h.rooms[code] = r
		go r.run()
		return code, nil
	}
}

// RoomInfo is the public summary of a room, for the room list.
type RoomInfo struct {
	RoomCode string     `json:"roomCode"`
	Mode     game.Mode  `json:"mode"`
	Players  [2]string  `json:"players"` // names; "" for an empty seat
	Phase    game.Phase `json:"phase"`
	// Seated counts taken seats, including seats held for a reconnect;
	// a room with Seated < 2 can be joined.
	Seated int `json:"seated"`
}

// RoomList is the body of GET /api/rooms.
type RoomList struct {
	Rooms []RoomInfo `json:"rooms"`
	Max   int        `json:"max"`
}

// Rooms returns a summary of every live room, by code.
func (h *Hub) Rooms() RoomList {
	h.mu.Lock()
	rooms := make([]*room, 0, len(h.rooms))
	for _, r := range h.rooms {
		rooms = append(rooms, r)
	}
	h.mu.Unlock()
	list := RoomList{Rooms: make([]RoomInfo, 0, len(rooms)), Max: h.opts.MaxRooms}
	for _, r := range rooms {
		if info := r.info.Load(); info != nil {
			list.Rooms = append(list.Rooms, *info)
		}
	}
	sort.Slice(list.Rooms, func(i, j int) bool { return list.Rooms[i].RoomCode < list.Rooms[j].RoomCode })
	return list
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
// {"roomCode": "ABCDE"}, or 409 {"error": "room_limit", "message": ...} when
// MaxRooms rooms already exist. An optional JSON body {"mode": "9ball"}
// picks the game; 8-ball by default.
func (h *Hub) HandleCreateRoom(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	var body struct {
		Mode game.Mode `json:"mode"`
	}
	json.NewDecoder(http.MaxBytesReader(w, req.Body, 1<<10)).Decode(&body) // an empty or bad body is the default
	if body.Mode == "" {
		body.Mode = game.ModeEight
	}
	if !body.Mode.Valid() {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": protocol.ErrBadMode, "message": "unknown game mode"})
		return
	}
	code, err := h.CreateRoom(body.Mode)
	if err != nil {
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]string{
			"error":   "room_limit",
			"message": fmt.Sprintf("At most %d rooms can exist at once; join one of them instead.", h.opts.MaxRooms),
		})
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"roomCode": code})
}

// HandleListRooms is the GET handler that answers with a RoomList.
func (h *Hub) HandleListRooms(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(h.Rooms())
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
