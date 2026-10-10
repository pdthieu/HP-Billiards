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
	// MaxSpectators caps how many spectators a room may let watch; each
	// room picks its own number up to it. Negative allows none.
	MaxSpectators int
	// ChatCooldown is how long anyone must wait between two comments.
	// Negative turns the wait off.
	ChatCooldown time.Duration
	// WS tunes the connections (keepalive pings).
	WS ws.Options
	// Breaker picks the seat that breaks the first rack of a room's first
	// match. Later racks follow the room's break rule. Nil means random.
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
		MaxSpectators:  10,
		ChatCooldown:   5 * time.Second,
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
	if opts.MaxSpectators == 0 {
		opts.MaxSpectators = def.MaxSpectators
	}
	opts.MaxSpectators = max(0, opts.MaxSpectators)
	if opts.ChatCooldown == 0 {
		opts.ChatCooldown = def.ChatCooldown
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

// RoomSettings are what a room is created with: the game, the race and break
// rule of its matches, the table and its cloth (all changeable between
// matches), how many spectators may watch (changeable any time), or a
// practice table.
type RoomSettings struct {
	Mode     game.Mode      `json:"mode"`
	Race     int            `json:"race"`
	Breaks   game.BreakRule `json:"breaks"`
	Practice bool           `json:"practice"`
	// Spectators: nil is DefaultSpectators (or the server's limit if lower).
	Spectators *int `json:"spectators"`
	// Table is the pool table (game.Tables), Cloth its colour (Cloths);
	// "" is the default. 3-cushion is played on the carom table, in the
	// same cloth.
	Table game.TableID `json:"table"`
	Cloth string       `json:"cloth"`
}

// Cloths are the cloth colours a room can pick: Simonis's names for the
// colours played most (docs/PROTOCOL.md, "Tables"). How each looks is up to
// the client.
var Cloths = map[string]bool{
	"tournament-blue": true, "electric-blue": true, "blue-green": true, "spruce": true,
	"simonis-green": true, "english-green": true, "slate-grey": true, "burgundy": true,
}

// DefaultCloth is the cloth of a room that picks none.
const DefaultCloth = "tournament-blue"

// DefaultSpectators is how many spectators a room lets watch unless its
// creator picks another number.
const DefaultSpectators = 3

// fill sets the zero fields to their defaults: 8-ball, a race to 1 (one rack
// per match; a 3-cushion game to DefaultCaromTarget points), alternating
// breaks, DefaultSpectators up to limit. A practice
// table has no spectators.
func (s *RoomSettings) fill(limit int) {
	if s.Spectators == nil {
		n := min(DefaultSpectators, limit)
		s.Spectators = &n
	}
	if s.Practice {
		n := 0
		s.Spectators = &n
	}
	if s.Mode == "" {
		s.Mode = game.ModeEight
	}
	if s.Race == 0 {
		s.Race = 1
		if s.Mode == game.ModeCarom {
			s.Race = game.DefaultCaromTarget
		}
	}
	if s.Breaks == "" {
		s.Breaks = game.BreakAlternate
	}
	if s.Table == "" {
		s.Table = game.DefaultTable
	}
	if s.Cloth == "" {
		s.Cloth = DefaultCloth
	}
}

// CreateRoom starts a new empty room and returns its code. It fails with
// ErrRoomLimit when MaxRooms rooms already exist. Zero settings take their
// defaults; the others must be valid.
func (h *Hub) CreateRoom(settings RoomSettings) (string, error) {
	settings.fill(h.opts.MaxSpectators)
	if n := *settings.Spectators; n < 0 || n > h.opts.MaxSpectators {
		return "", errBadSpectators
	}
	if !settings.Table.Valid() || !Cloths[settings.Cloth] {
		return "", errBadTable
	}
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
		r := newRoom(h, code, settings)
		h.rooms[code] = r
		go r.run()
		return code, nil
	}
}

// RoomInfo is the public summary of a room, for the room list.
type RoomInfo struct {
	RoomCode string         `json:"roomCode"`
	Mode     game.Mode      `json:"mode"`
	Race     int            `json:"race"`
	Breaks   game.BreakRule `json:"breaks"`
	Table    game.TableID   `json:"table"`
	Cloth    string         `json:"cloth"`
	Players  [2]string      `json:"players"` // names; "" for an empty seat
	Phase    game.Phase     `json:"phase"`
	// Score is the match in play by seat: racks won, or a 3-cushion game's
	// points; 0–0 until a match starts.
	Score [2]int `json:"score"`
	// Seated counts taken seats, including seats held for a reconnect;
	// a room with Seated < 2 can be joined.
	Seated int `json:"seated"`
	// Spectators watch now; one more may join while it is below
	// MaxSpectators.
	Spectators    int `json:"spectators"`
	MaxSpectators int `json:"maxSpectators"`
	// Practice rooms are private: counted against MaxRooms, never listed.
	Practice bool `json:"-"`
}

// RoomList is the body of GET /api/rooms.
type RoomList struct {
	Rooms []RoomInfo `json:"rooms"`
	Used  int        `json:"used"` // live rooms, practice rooms included
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
	list := RoomList{Rooms: make([]RoomInfo, 0, len(rooms)), Used: len(rooms), Max: h.opts.MaxRooms}
	for _, r := range rooms {
		if info := r.info.Load(); info != nil && !info.Practice {
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
// MaxRooms rooms already exist. An optional JSON body, RoomSettings
// ({"mode": "9ball", "race": 5, "breaks": "winner", "spectators": 5,
// "table": "predator", "cloth": "electric-blue"} or {"practice": true}),
// picks the game (8-ball by default), the race (1), the break rule
// (alternate), how many may watch (3), the table (DefaultTable) and the
// cloth (DefaultCloth), or makes a private room for one player who plays
// both sides.
func (h *Hub) HandleCreateRoom(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	var body RoomSettings
	json.NewDecoder(http.MaxBytesReader(w, req.Body, 1<<10)).Decode(&body) // an empty or bad body is the default
	body.fill(h.opts.MaxSpectators)
	bad := func(code, message string) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": code, "message": message})
	}
	switch {
	case !body.Mode.Valid():
		bad(protocol.ErrBadMode, "unknown game mode")
		return
	case !game.ValidRace(body.Mode, body.Race) || !body.Breaks.Valid():
		bad(protocol.ErrBadRace, fmt.Sprintf("the race must be 1 to %d (3-cushion: 1 to %d points), the breaks alternate or winner", game.MaxRace, game.MaxCaromTarget))
		return
	case *body.Spectators < 0 || *body.Spectators > h.opts.MaxSpectators:
		bad(protocol.ErrBadSpectator, fmt.Sprintf("spectators must be 0 to %d", h.opts.MaxSpectators))
		return
	case !body.Table.Valid() || !Cloths[body.Cloth]:
		bad(protocol.ErrBadTable, "unknown table or cloth")
		return
	}
	code, err := h.CreateRoom(body)
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
