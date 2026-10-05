package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"billiards/internal/game"
)

const readTimeout = 10 * time.Second

// fastOptions makes shots settle in well under a second and seat 0 break.
func fastOptions() Options {
	opts := DefaultOptions()
	opts.Game.RollingDecel = 6
	opts.Breaker = func() int { return 0 }
	return opts
}

func newServer(t *testing.T, opts Options) (*Hub, *httptest.Server) {
	t.Helper()
	h := New(opts)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/rooms", h.HandleCreateRoom)
	mux.HandleFunc("GET /ws", h.ServeWS)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return h, srv
}

func createRoom(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	res, err := http.Post(srv.URL+"/api/rooms", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body struct{ RoomCode string }
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body.RoomCode
}

type msg = map[string]any

type testClient struct {
	t    *testing.T
	conn *websocket.Conn
}

func dial(t *testing.T, srv *httptest.Server) *testClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return &testClient{t: t, conn: conn}
}

func (c *testClient) send(v any) {
	c.t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		c.t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
	defer cancel()
	if err := c.conn.Write(ctx, websocket.MessageText, data); err != nil {
		c.t.Fatal(err)
	}
}

// read returns the next message, raw and decoded.
func (c *testClient) read() ([]byte, msg) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
	defer cancel()
	_, data, err := c.conn.Read(ctx)
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	var m msg
	if err := json.Unmarshal(data, &m); err != nil {
		c.t.Fatalf("bad JSON from server: %s", data)
	}
	return data, m
}

// expect reads the next message and fails unless it has the given type.
func (c *testClient) expect(typ string) msg {
	c.t.Helper()
	raw, m := c.read()
	if m["type"] != typ {
		c.t.Fatalf("got %s, want a %q message", raw, typ)
	}
	return m
}

// waitFor skips messages until one of the given type arrives.
func (c *testClient) waitFor(typ string) ([]byte, msg) {
	c.t.Helper()
	for {
		raw, m := c.read()
		if m["type"] == typ {
			return raw, m
		}
	}
}

func (c *testClient) expectError(code string) {
	c.t.Helper()
	if m := c.expect("error"); m["code"] != code {
		c.t.Fatalf("error code = %v, want %q (%v)", m["code"], code, m["message"])
	}
}

// join joins the room and consumes welcome and the initial room_state.
func (c *testClient) join(code, name string) (welcome, state msg) {
	c.t.Helper()
	c.send(msg{"type": "join", "roomCode": code, "name": name})
	return c.expect("welcome"), c.expect("room_state")
}

// startGame seats two players in a new room and readies both; seat 0 breaks.
func startGame(t *testing.T, srv *httptest.Server) (c0, c1 *testClient, code string) {
	t.Helper()
	code = createRoom(t, srv)
	c0, c1 = dial(t, srv), dial(t, srv)
	c0.join(code, "Ann")
	c1.join(code, "Bob")
	c0.send(msg{"type": "ready"})
	c1.send(msg{"type": "ready"})
	for _, c := range []*testClient{c0, c1} {
		_, st := c.waitFor("room_state")
		if st["phase"] != "breaking" || st["turn"] != 0.0 || st["ballInHand"] != true || st["kitchen"] != true {
			t.Fatalf("state after both ready: %v", st)
		}
	}
	return c0, c1, code
}

func players(st msg) []any { return st["players"].([]any) }

func TestRoomCodeFormat(t *testing.T) {
	h := New(Options{})
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		code := h.CreateRoom()
		if len(code) != 5 {
			t.Fatalf("code %q is not 5 letters", code)
		}
		for _, ch := range code {
			if ch < 'A' || ch > 'Z' || ch == 'I' || ch == 'O' {
				t.Fatalf("code %q contains %q", code, ch)
			}
		}
		if seen[code] {
			t.Fatalf("duplicate code %q", code)
		}
		seen[code] = true
	}
	if h.RoomCount() != 200 {
		t.Errorf("RoomCount = %d, want 200", h.RoomCount())
	}
}

func TestJoinAndLobby(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	code := createRoom(t, srv)

	c0 := dial(t, srv)
	w0, st0 := c0.join(strings.ToLower(code), "  Ann   Lee  ")
	if w0["seat"] != 0.0 || w0["v"] != 1.0 || w0["roomCode"] != code {
		t.Errorf("welcome = %v", w0)
	}
	if tok, _ := w0["token"].(string); len(tok) != 32 {
		t.Errorf("token %q is not 128 bits of hex", w0["token"])
	}
	if st0["phase"] != "lobby" || st0["winner"] != nil || st0["decision"] != nil || st0["moving"] != false {
		t.Errorf("initial state = %v", st0)
	}
	if p := players(st0)[0].(msg); p["name"] != "Ann Lee" || p["connected"] != true || p["ready"] != false {
		t.Errorf("seat 0 = %v", p)
	}
	if p := players(st0)[1].(msg); p["name"] != "" || p["connected"] != false {
		t.Errorf("seat 1 = %v", p)
	}

	c1 := dial(t, srv)
	w1, st1 := c1.join(code, "")
	if w1["seat"] != 1.0 || w1["token"] == w0["token"] || w1["playerId"] == w0["playerId"] {
		t.Errorf("second welcome = %v", w1)
	}
	if p := players(st1)[1].(msg); p["name"] != "Player 2" {
		t.Errorf("default name = %v", p["name"])
	}
	if p := c0.expect("player"); p["seat"] != 1.0 || p["name"] != "Player 2" || p["connected"] != true {
		t.Errorf("player announcement = %v", p)
	}

	// One ready player does not start the game.
	c0.send(msg{"type": "ready"})
	for _, c := range []*testClient{c0, c1} {
		if p := c.expect("player"); p["seat"] != 0.0 || p["ready"] != true {
			t.Errorf("ready announcement = %v", p)
		}
	}
	c0.send(msg{"type": "shoot", "angle": 0, "power": 1})
	c0.expectError("wrong_phase")
	c0.send(msg{"type": "rematch"})
	c0.expectError("wrong_phase")
}

func TestJoinErrors(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	code := createRoom(t, srv)

	c := dial(t, srv)
	c.send(msg{"type": "ready"})
	c.expectError("not_joined")
	c.send(msg{"type": "join", "roomCode": "ZZZZZ"})
	c.expectError("room_not_found")
	c.send("not an object")
	c.expectError("bad_message")
	c.send(msg{"hello": "world"})
	c.expectError("bad_message")

	// The same socket can still join after those errors.
	c.join(code, "Ann")
	c.send(msg{"type": "join", "roomCode": code})
	c.expectError("bad_message")
	c.send(msg{"type": "dance"})
	c.expectError("bad_message")

	dial(t, srv).join(code, "Bob")
	third := dial(t, srv)
	third.send(msg{"type": "join", "roomCode": code, "name": "Cat"})
	third.expectError("room_full")
}

func TestShotSettlesIdenticallyForBothPlayers(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	c0, c1, _ := startGame(t, srv)

	c1.send(msg{"type": "shoot", "angle": 0, "power": 1})
	c1.expectError("not_your_turn")

	c0.send(msg{"type": "shoot", "angle": 0, "power": 1})

	var settled [2][]byte
	for i, c := range []*testClient{c0, c1} {
		snapshots, lastT := 0, -1.0
		for {
			raw, m := c.read()
			if m["type"] == "settled" {
				settled[i] = raw
				break
			}
			if m["type"] != "snapshot" {
				t.Fatalf("client %d got %s during the shot", i, raw)
			}
			tm := m["t"].(float64)
			if snapshots == 0 && tm != 0 {
				t.Errorf("first snapshot has t=%v, want 0", tm)
			}
			if tm <= lastT {
				t.Errorf("snapshot times not increasing: %v after %v", tm, lastT)
			}
			lastT = tm
			snapshots++
			for _, b := range m["balls"].([]any) {
				x := b.(msg)["x"].(float64) * 1000
				if math.Abs(x-math.Round(x)) > 1e-6 {
					t.Fatalf("snapshot x=%v is not rounded to 3 decimals", b.(msg)["x"])
				}
			}
		}
		if snapshots < 3 {
			t.Errorf("client %d saw only %d snapshots", i, snapshots)
		}
	}
	if !bytes.Equal(settled[0], settled[1]) {
		t.Fatalf("settled payloads differ:\n%s\n%s", settled[0], settled[1])
	}

	var m msg
	json.Unmarshal(settled[0], &m)
	if m["shooter"] != 0.0 {
		t.Errorf("shooter = %v, want 0", m["shooter"])
	}
	if _, ok := m["pocketed"].([]any); !ok {
		t.Errorf("pocketed = %v, want an array", m["pocketed"])
	}
	if n := len(m["balls"].([]any)) + len(m["pocketed"].([]any)); n < game.NumBalls {
		t.Errorf("balls on the table plus pocketed = %d, want at least %d", n, game.NumBalls)
	}
	if _, has := m["winner"]; has {
		t.Errorf("winner present after the break: %v", m["winner"])
	}

	// A shot after the break needs a call.
	if m["decision"] == nil {
		shooter := []*testClient{c0, c1}[int(m["turn"].(float64))]
		shooter.send(msg{"type": "shoot", "angle": 0, "power": 0.5})
		shooter.expectError("bad_call")
	}
}

func TestAimIsRelayedToTheOtherPlayer(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	c0, c1, _ := startGame(t, srv)

	c1.send(msg{"type": "aim", "angle": 1, "power": 0.5}) // not the shooter: dropped
	c0.send(msg{"type": "aim", "angle": 0.25, "power": 7})
	if a := c1.expect("aim"); a["seat"] != 0.0 || a["angle"] != 0.25 || a["power"] != 1.0 {
		t.Errorf("relayed aim = %v", a)
	}
	// The shooter gets no echo: the next thing it hears is its own error.
	c0.send(msg{"type": "rematch"})
	c0.expectError("wrong_phase")
}

func TestPlaceCue(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	c0, c1, _ := startGame(t, srv)

	c1.send(msg{"type": "place_cue", "x": 0.3, "y": 0.3})
	c1.expectError("not_your_turn")
	c0.send(msg{"type": "place_cue", "x": 1.0, "y": 0.3}) // below the head string on the break
	c0.expectError("bad_placement")

	c0.send(msg{"type": "place_cue", "x": 0.3, "y": 0.4})
	for _, c := range []*testClient{c0, c1} {
		st := c.expect("room_state")
		cue := st["balls"].([]any)[0].(msg)
		if cue["id"] != 0.0 || cue["x"] != 0.3 || cue["y"] != 0.4 {
			t.Errorf("cue ball = %v, want (0.3, 0.4)", cue)
		}
	}
}

func TestIllegalBreakDecision(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	c0, c1, _ := startGame(t, srv)

	// A tap that drives nothing to a rail.
	c0.send(msg{"type": "shoot", "angle": 0, "power": 0.3})
	for _, c := range []*testClient{c0, c1} {
		_, m := c.waitFor("settled")
		d, _ := m["decision"].(msg)
		if m["illegalBreak"] != true || d == nil || d["seat"] != 1.0 {
			t.Fatalf("settled = %v, want an illegal break with a decision for seat 1", m)
		}
	}

	c0.send(msg{"type": "shoot", "angle": 0, "power": 1})
	c0.expectError("wrong_phase")
	c0.send(msg{"type": "choose", "option": "rerack_break"})
	c0.expectError("not_your_turn")
	c1.send(msg{"type": "choose", "option": "spot_eight"})
	c1.expectError("bad_option")

	c1.send(msg{"type": "choose", "option": "rerack_opponent_breaks"})
	for _, c := range []*testClient{c0, c1} {
		st := c.expect("room_state")
		if st["phase"] != "breaking" || st["turn"] != 0.0 || st["decision"] != nil || len(st["balls"].([]any)) != game.NumBalls {
			t.Errorf("state after re-rack: %v", st)
		}
	}
	c1.send(msg{"type": "choose", "option": "accept_table"})
	c1.expectError("no_decision")
}

func TestLeavingAbandonsTheGame(t *testing.T) {
	h, srv := newServer(t, fastOptions())
	c0, c1, code := startGame(t, srv)

	c1.conn.Close(websocket.StatusNormalClosure, "")
	if p := c0.expect("player"); p["seat"] != 1.0 || p["connected"] != false || p["name"] != "" {
		t.Errorf("leave announcement = %v", p)
	}
	st := c0.expect("room_state")
	if st["phase"] != "lobby" || players(st)[0].(msg)["ready"] != false {
		t.Errorf("state after the opponent left: %v", st)
	}

	// The seat is free again.
	c2 := dial(t, srv)
	if w, _ := c2.join(code, "Cat"); w["seat"] != 1.0 {
		t.Errorf("new player got seat %v, want 1", w["seat"])
	}
	if h.RoomCount() != 1 {
		t.Errorf("RoomCount = %d, want 1", h.RoomCount())
	}
}

func TestIdleRoomsAreDeleted(t *testing.T) {
	opts := fastOptions()
	opts.IdleTimeout = 100 * time.Millisecond
	h, srv := newServer(t, opts)

	waitForRooms := func(want int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for h.RoomCount() != want {
			if time.Now().After(deadline) {
				t.Fatalf("RoomCount = %d, want %d", h.RoomCount(), want)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}

	// A room nobody ever joins.
	stale := createRoom(t, srv)
	waitForRooms(0)
	c := dial(t, srv)
	c.send(msg{"type": "join", "roomCode": stale})
	c.expectError("room_not_found")

	// A room with a connected player outlives the timeout...
	code := createRoom(t, srv)
	c.join(code, "Ann")
	time.Sleep(3 * opts.IdleTimeout)
	if h.RoomCount() != 1 {
		t.Fatalf("occupied room was deleted")
	}
	// ...and goes away once that player has left.
	c.conn.Close(websocket.StatusNormalClosure, "")
	waitForRooms(0)
}
