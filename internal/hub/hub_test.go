package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"billiards/internal/game"
)

const readTimeout = 10 * time.Second

// fastOptions makes shots settle in well under a second, seat 0 break and
// held seats expire quickly.
func fastOptions() Options {
	opts := DefaultOptions()
	opts.Game.SlidingFriction = 2
	opts.Game.RollingFriction = 0.6
	opts.Breaker = func() int { return 0 }
	opts.ReconnectGrace = 500 * time.Millisecond
	opts.AbandonTimeout = 1500 * time.Millisecond
	return opts
}

// startGameWithTokens is startGame that also returns both seat tokens.
func startGameWithTokens(t *testing.T, srv *httptest.Server) (c0, c1 *testClient, code string, tokens [2]string) {
	t.Helper()
	code = createRoom(t, srv)
	c0, c1 = dial(t, srv), dial(t, srv)
	w0, _ := c0.join(code, "Ann")
	w1, _ := c1.join(code, "Bob")
	c0.expect("player")
	c0.send(msg{"type": "ready"})
	c1.send(msg{"type": "ready"})
	for _, c := range []*testClient{c0, c1} {
		c.waitFor("room_state")
	}
	return c0, c1, code, [2]string{w0["token"].(string), w1["token"].(string)}
}

// rejoin dials and reclaims a seat with its token, returning the room_state.
func rejoin(t *testing.T, srv *httptest.Server, code, token string) (*testClient, msg, msg) {
	t.Helper()
	c := dial(t, srv)
	c.send(msg{"type": "join", "roomCode": code, "token": token})
	w := c.expect("welcome")
	return c, w, c.expect("room_state")
}

func newServer(t *testing.T, opts Options) (*Hub, *httptest.Server) {
	t.Helper()
	h := New(opts)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/rooms", h.HandleCreateRoom)
	mux.HandleFunc("GET /api/rooms", h.HandleListRooms)
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
	h := New(Options{MaxRooms: 200})
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		code, err := h.CreateRoom(RoomSettings{})
		if err != nil {
			t.Fatal(err)
		}
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
	if _, err := h.CreateRoom(RoomSettings{}); err != ErrRoomLimit {
		t.Errorf("201st room: err = %v, want ErrRoomLimit", err)
	}
}

func TestRoomListAndLimit(t *testing.T) {
	opts := fastOptions()
	opts.MaxRooms = 2
	h, srv := newServer(t, opts)

	list := func() RoomList {
		t.Helper()
		res, err := http.Get(srv.URL + "/api/rooms")
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var l RoomList
		if err := json.NewDecoder(res.Body).Decode(&l); err != nil {
			t.Fatal(err)
		}
		return l
	}
	if l := list(); len(l.Rooms) != 0 || l.Max != 2 {
		t.Fatalf("empty hub list = %+v", l)
	}

	code1 := createRoom(t, srv)
	c0 := dial(t, srv)
	c0.join(code1, "Ann")
	code2 := createRoom(t, srv)

	// Third room: 409 with a JSON error.
	res, err := http.Post(srv.URL+"/api/rooms", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]string
	json.NewDecoder(res.Body).Decode(&body)
	res.Body.Close()
	if res.StatusCode != http.StatusConflict || body["error"] != "room_limit" || body["message"] == "" {
		t.Errorf("third room: status %d body %v", res.StatusCode, body)
	}

	// The list reflects who is seated and the phase; summaries are updated
	// by the room goroutine so give it a moment.
	deadline := time.Now().Add(2 * time.Second)
	var l RoomList
	for {
		l = list()
		byCode := map[string]RoomInfo{}
		for _, r := range l.Rooms {
			byCode[r.RoomCode] = r
		}
		if r1 := byCode[code1]; r1.Seated == 1 && r1.Players[0] == "Ann" && r1.Phase == game.PhaseLobby && byCode[code2].Seated == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("room list = %+v", l)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if h.RoomCount() != 2 {
		t.Errorf("RoomCount = %d", h.RoomCount())
	}
	// Codes are sorted so the list is stable.
	if len(l.Rooms) == 2 && l.Rooms[0].RoomCode > l.Rooms[1].RoomCode {
		t.Errorf("rooms not sorted: %+v", l.Rooms)
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
				x := b.(msg)["x"].(float64) * 10000
				if math.Abs(x-math.Round(x)) > 1e-6 {
					t.Fatalf("snapshot x=%v is not rounded to 0.1 mm", b.(msg)["x"])
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

	// A shot after the break needs no call (only the 8-ball does).
	if m["decision"] == nil {
		shooter := []*testClient{c0, c1}[int(m["turn"].(float64))]
		shooter.send(msg{"type": "shoot", "angle": 0, "power": 0.5})
		shooter.expect("snapshot")
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

func TestJumpShot(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	c0, c1, _ := startGame(t, srv)

	c0.send(msg{"type": "aim", "angle": 0, "power": 0.4, "elevation": 0.5})
	if a := c1.expect("aim"); a["elevation"] != 0.5 {
		t.Errorf("relayed aim = %v, want elevation 0.5", a)
	}
	c0.send(msg{"type": "aim", "angle": 0, "power": 0.4, "elevation": 3})
	if a := c1.expect("aim"); a["elevation"] != game.MaxElevation {
		t.Errorf("relayed aim = %v, want the elevation clamped to %v", a, game.MaxElevation)
	}
	c0.send(msg{"type": "aim", "angle": 0, "power": 0.4})
	if raw, _ := c1.read(); strings.Contains(string(raw), "elevation") {
		t.Errorf("level aim %s carries an elevation", raw)
	}

	// A jump at the rack: the cue ball shows up in the air.
	c0.send(msg{"type": "shoot", "angle": 0, "power": 0.4, "elevation": 0.8})
	for {
		_, m := c1.read()
		if m["type"] == "settled" {
			t.Fatal("shot settled without a snapshot of the cue ball in the air")
		}
		if m["type"] != "snapshot" {
			continue
		}
		cue := m["balls"].([]any)[0].(map[string]any) // sorted by id
		if z, _ := cue["z"].(float64); cue["id"] == 0.0 && z > 0 {
			break
		}
	}
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

func TestLeavingHoldsTheSeatThenAbandonsTheGame(t *testing.T) {
	h, srv := newServer(t, fastOptions())
	c0, c1, code := startGame(t, srv)

	// First the seat is only held: the name stays, the game goes on.
	left := time.Now()
	c1.conn.Close(websocket.StatusNormalClosure, "")
	if p := c0.expect("player"); p["seat"] != 1.0 || p["connected"] != false || p["name"] != "Bob" || p["ready"] != true {
		t.Errorf("disconnect announcement = %v", p)
	}
	third := dial(t, srv)
	third.send(msg{"type": "join", "roomCode": code, "name": "Cat"})
	third.expectError("room_full")

	// Then the grace runs out: the seat is freed and the game abandoned.
	if p := c0.expect("player"); p["seat"] != 1.0 || p["connected"] != false || p["name"] != "" {
		t.Errorf("leave announcement = %v", p)
	}
	if held := time.Since(left); held < fastOptions().ReconnectGrace/2 {
		t.Errorf("seat was freed after %v, want about %v", held, fastOptions().ReconnectGrace)
	}
	st := c0.expect("room_state")
	if st["phase"] != "lobby" || players(st)[0].(msg)["ready"] != false || players(st)[1].(msg)["name"] != "" {
		t.Errorf("state after the opponent left: %v", st)
	}
	// Not coming back in time forfeits the match.
	if m := matchOf(t, st); m["winner"] != 0.0 || len(m["racks"].([]any)) != 1 || m["racks"].([]any)[0].(msg)["end"] != "forfeit" {
		t.Errorf("match after the hold ran out = %v", m)
	}

	// The seat is free again, and the new player starts a new match.
	c2 := dial(t, srv)
	if w, st := c2.join(code, "Cat"); w["seat"] != 1.0 || matchOf(t, st)["winner"] != nil || len(matchOf(t, st)["racks"].([]any)) != 0 {
		t.Errorf("new player got seat %v, match %v", w["seat"], st["match"])
	}
	if h.RoomCount() != 1 {
		t.Errorf("RoomCount = %d, want 1", h.RoomCount())
	}
}

func TestLeavingTheLobbyFreesTheSeatAtOnce(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	code := createRoom(t, srv)
	c0, c1 := dial(t, srv), dial(t, srv)
	c0.join(code, "Ann")
	c1.join(code, "Bob")
	c0.expect("player")

	c1.conn.Close(websocket.StatusNormalClosure, "")
	if p := c0.expect("player"); p["seat"] != 1.0 || p["connected"] != false || p["name"] != "" {
		t.Errorf("leave announcement = %v", p)
	}
	if w, _ := dial(t, srv).join(code, "Cat"); w["seat"] != 1.0 {
		t.Errorf("new player got seat %v, want 1", w["seat"])
	}
}

func TestReconnectWithToken(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	code := createRoom(t, srv)
	c0, c1 := dial(t, srv), dial(t, srv)
	c0.join(code, "Ann")
	w1, _ := c1.join(code, "Bob")
	c0.expect("player")
	c0.send(msg{"type": "ready"})
	c1.send(msg{"type": "ready"})
	for _, c := range []*testClient{c0, c1} {
		c.waitFor("room_state")
	}
	// Move the cue ball so the reconnecting player must see non-rack state.
	c0.send(msg{"type": "place_cue", "x": 0.3, "y": 0.4})
	c0.expect("room_state")
	c1.expect("room_state")

	c1.conn.Close(websocket.StatusNormalClosure, "")
	if p := c0.expect("player"); p["connected"] != false || p["name"] != "Bob" {
		t.Fatalf("disconnect announcement = %v", p)
	}

	// Back with the token: same seat, same id, same token, current state.
	c1b := dial(t, srv)
	c1b.send(msg{"type": "join", "roomCode": code, "name": "Someone Else", "token": w1["token"]})
	w := c1b.expect("welcome")
	if w["seat"] != 1.0 || w["playerId"] != w1["playerId"] || w["token"] != w1["token"] {
		t.Errorf("reconnect welcome = %v, want the original seat", w)
	}
	st := c1b.expect("room_state")
	if st["phase"] != "breaking" {
		t.Errorf("phase after reconnect = %v, want breaking", st["phase"])
	}
	if cue := st["balls"].([]any)[0].(msg); cue["x"] != 0.3 || cue["y"] != 0.4 {
		t.Errorf("cue ball after reconnect = %v, want (0.3, 0.4)", cue)
	}
	if p := players(st)[1].(msg); p["name"] != "Bob" || p["connected"] != true || p["ready"] != true {
		t.Errorf("own seat after reconnect = %v", p)
	}
	if p := c0.expect("player"); p["seat"] != 1.0 || p["connected"] != true || p["name"] != "Bob" {
		t.Errorf("reconnect announcement = %v", p)
	}

	// The grace timer of the old disconnect must not fire later.
	time.Sleep(2 * fastOptions().ReconnectGrace)
	c0.send(msg{"type": "shoot", "angle": 0, "power": 1})
	var settled [2][]byte
	for i, c := range []*testClient{c0, c1b} {
		settled[i], _ = c.waitFor("settled")
	}
	if !bytes.Equal(settled[0], settled[1]) {
		t.Fatalf("settled payloads differ after a reconnect:\n%s\n%s", settled[0], settled[1])
	}
}

func TestBothGoneKeepsTheGameUntilTheAbandonTimeout(t *testing.T) {
	opts := fastOptions()
	_, srv := newServer(t, opts)
	c0, c1, code, tokens := startGameWithTokens(t, srv)

	c0.conn.Close(websocket.StatusNormalClosure, "")
	c1.expect("player")
	c1.conn.Close(websocket.StatusNormalClosure, "")

	// Well past the single-player grace, the game is still there for a
	// returning player because nobody was waiting.
	time.Sleep(2 * opts.ReconnectGrace)
	c1b, w, st := rejoin(t, srv, code, tokens[1])
	if w["seat"] != 1.0 || st["phase"] != "breaking" {
		t.Fatalf("after both left for %v: welcome %v, state %v", 2*opts.ReconnectGrace, w, st)
	}
	if p := players(st)[0].(msg); p["name"] != "Ann" || p["connected"] != false {
		t.Errorf("seat 0 should still be held: %v", p)
	}

	// Now one player is waiting again: the other's grace starts from here.
	start := time.Now()
	if p := c1b.expect("player"); p["seat"] != 0.0 || p["name"] != "" {
		t.Errorf("expected seat 0 to expire, got %v", p)
	}
	if since := time.Since(start); since < opts.ReconnectGrace/2 {
		t.Errorf("seat 0 expired after %v, want about %v after the reconnect", since, opts.ReconnectGrace)
	}
	if st := c1b.expect("room_state"); st["phase"] != "lobby" {
		t.Errorf("state after the hold expired: %v", st)
	}
}

func TestBothGoneAbandonsAfterTheTimeout(t *testing.T) {
	opts := fastOptions()
	h, srv := newServer(t, opts)
	c0, c1, code, tokens := startGameWithTokens(t, srv)

	c0.conn.Close(websocket.StatusNormalClosure, "")
	c1.expect("player")
	c1.conn.Close(websocket.StatusNormalClosure, "")
	time.Sleep(opts.AbandonTimeout + opts.ReconnectGrace)

	// The room still exists (idle timeout is long) but the game is gone and
	// the old token no longer names a seat: this is a plain join.
	if h.RoomCount() != 1 {
		t.Fatalf("RoomCount = %d, want 1", h.RoomCount())
	}
	_, w, st := rejoin(t, srv, code, tokens[1])
	if w["seat"] != 0.0 || w["token"] == tokens[1] || st["phase"] != "lobby" {
		t.Errorf("after the abandon timeout: welcome %v, state %v", w, st)
	}
	for i, p := range players(st) {
		if p.(msg)["ready"] != false || (i == 1 && p.(msg)["name"] != "") {
			t.Errorf("seat %d after abandon = %v", i, p)
		}
	}
}

func TestReconnectReplacesALiveSocket(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	code := createRoom(t, srv)
	c0 := dial(t, srv)
	w0, _ := c0.join(code, "Ann")

	// Same token from a second socket while the first is still open.
	c0b := dial(t, srv)
	c0b.send(msg{"type": "join", "roomCode": code, "token": w0["token"]})
	if w := c0b.expect("welcome"); w["seat"] != 0.0 || w["playerId"] != w0["playerId"] {
		t.Errorf("welcome on the new socket = %v", w)
	}
	c0b.expect("room_state")

	// The old socket is closed by the server.
	ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
	defer cancel()
	_, _, err := c0.conn.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("old socket read = %v, want a policy-violation close", err)
	}

	// The room still has one occupied seat and one free seat; the old
	// socket's departure must not have vacated the reclaimed seat.
	c1 := dial(t, srv)
	_, st := c1.join(code, "Bob")
	if p := players(st)[0].(msg); p["name"] != "Ann" || p["connected"] != true {
		t.Errorf("seat 0 after replacement = %v", p)
	}
	c0b.expect("player")
}

func TestUnknownTokenJoinsNormally(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	code := createRoom(t, srv)
	c := dial(t, srv)
	c.send(msg{"type": "join", "roomCode": code, "name": "Ann", "token": strings.Repeat("ab", 16)})
	w := c.expect("welcome")
	if w["seat"] != 0.0 || w["token"] == strings.Repeat("ab", 16) {
		t.Errorf("welcome with a bogus token = %v", w)
	}
}

func TestPingPong(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	code := createRoom(t, srv)
	c := dial(t, srv)
	c.send(msg{"type": "ping"}) // allowed before join
	c.expect("pong")
	c.join(code, "Ann")
	c.send(msg{"type": "ping"})
	c.expect("pong")
}

func TestDeadPeerIsDisconnectedByPing(t *testing.T) {
	opts := fastOptions()
	opts.WS.PingInterval = 50 * time.Millisecond
	opts.WS.PingTimeout = 100 * time.Millisecond
	_, srv := newServer(t, opts)
	code := createRoom(t, srv)
	c0, c1 := dial(t, srv), dial(t, srv)
	c0.join(code, "Ann")
	c1.join(code, "Bob")
	c0.expect("player")

	// c1 never reads, so it never answers pings (pongs are handled by the
	// reader); the server must notice and free the seat.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if p := c0.expect("player"); p["seat"] == 1.0 && p["connected"] == false {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("unresponsive peer was not disconnected")
		}
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

// clockOf returns the clock of a room_state or settled message, failing if
// there is none.
func clockOf(t *testing.T, m msg) msg {
	t.Helper()
	c, ok := m["clock"].(msg)
	if !ok {
		t.Fatalf("no clock in %v", m)
	}
	return c
}

func TestShotClockFoulExtensionAndLongClockAfterTheBreak(t *testing.T) {
	opts := fastOptions()
	// Slow enough cloth for a break that settles in a few seconds and still
	// sends six or seven balls to a rail.
	opts.Game.SlidingFriction = 0.3
	opts.Game.RollingFriction = 0.08
	opts.ShotClock = 300 * time.Millisecond
	opts.LongShotClock = 2 * time.Second
	_, srv := newServer(t, opts)
	code := createRoom(t, srv)
	c0, c1 := dial(t, srv), dial(t, srv)
	c0.join(code, "Ann")
	c1.join(code, "Bob")
	c0.send(msg{"type": "ready"})
	c1.send(msg{"type": "ready"})
	_, st := c1.waitFor("room_state")
	if c := clockOf(t, st); c["seat"] != 0.0 || c["limit"] != 300.0 || c["paused"] != false {
		t.Fatalf("clock at the start = %v", c)
	}

	// The breaker lets the clock run out: Bob breaks instead.
	for _, c := range []*testClient{c0, c1} {
		_, out := c.waitFor("timeout")
		if out["seat"] != 0.0 || out["option"] != nil {
			t.Errorf("timeout = %v", out)
		}
		st := c.expect("room_state")
		if st["phase"] != "breaking" || st["turn"] != 1.0 || st["ballInHand"] != true || st["kitchen"] != true {
			t.Errorf("state after the time foul: %v", st)
		}
		if ck := clockOf(t, st); ck["seat"] != 1.0 || ck["limit"] != 300.0 {
			t.Errorf("clock after the time foul = %v", ck)
		}
	}

	c0.send(msg{"type": "extend"})
	c0.expectError("not_your_turn")
	c1.send(msg{"type": "extend"})
	for _, c := range []*testClient{c0, c1} {
		ck := c.expect("clock")
		ext := ck["extensions"].([]any)
		if ck["seat"] != 1.0 || ck["limit"] != 2000.0 || ck["left"].(float64) < 1900 || ext[0] != true || ext[1] != false {
			t.Errorf("clock after the extension = %v", ck)
		}
	}
	c1.send(msg{"type": "extend"})
	c1.expectError("no_extension")

	// The first shot after the break gets the long clock.
	c1.send(msg{"type": "shoot", "angle": 0, "power": 1})
	_, settled := c1.waitFor("settled")
	if settled["decision"] != nil || settled["phase"] != "open" {
		t.Fatalf("the break did not leave an open table: %v", settled)
	}
	if ck := clockOf(t, settled); ck["seat"] != settled["turn"] || ck["limit"] != 2000.0 {
		t.Errorf("clock after the break = %v", ck)
	}
}

func TestShotClockWaitsForAnOfflineShooter(t *testing.T) {
	opts := fastOptions()
	opts.ShotClock = 300 * time.Millisecond
	opts.ReconnectGrace = 5 * time.Second
	_, srv := newServer(t, opts)
	c0, c1, code, tokens := startGameWithTokens(t, srv)

	c0.conn.CloseNow()
	c1.expect("player")
	if ck := c1.expect("clock"); ck["seat"] != 0.0 || ck["paused"] != true {
		t.Fatalf("clock after the shooter left = %v", ck)
	}
	time.Sleep(2 * opts.ShotClock) // no timeout while they are away

	c0, _, st := rejoin(t, srv, code, tokens[0])
	if ck := clockOf(t, st); ck["paused"] != false || ck["left"].(float64) <= 0 {
		t.Errorf("clock on rejoin = %v", ck)
	}
	c1.expect("player")
	if ck := c1.expect("clock"); ck["paused"] != false {
		t.Errorf("clock after the shooter came back = %v", ck)
	}
	if _, out := c0.waitFor("timeout"); out["seat"] != 0.0 {
		t.Errorf("timeout = %v", out)
	}
}

func TestShotClockDecidesForASlowChooser(t *testing.T) {
	opts := fastOptions()
	opts.ShotClock = 500 * time.Millisecond
	opts.LongShotClock = 2 * time.Second
	_, srv := newServer(t, opts)
	c0, c1, _ := startGame(t, srv)

	c0.send(msg{"type": "shoot", "angle": 0, "power": 0.3}) // illegal break
	_, settled := c1.waitFor("settled")
	if ck := clockOf(t, settled); ck["seat"] != 1.0 || ck["limit"] != 500.0 {
		t.Fatalf("clock for the decision = %v", ck)
	}
	_, out := c1.waitFor("timeout")
	if out["seat"] != 1.0 || out["option"] != "accept_table" {
		t.Errorf("timeout = %v", out)
	}
	st := c1.expect("room_state")
	if st["phase"] != "open" || st["turn"] != 1.0 || st["decision"] != nil {
		t.Errorf("state after the timed-out decision: %v", st)
	}
	if ck := clockOf(t, st); ck["seat"] != 1.0 || ck["limit"] != 2000.0 {
		t.Errorf("clock after the timed-out decision = %v", ck)
	}
}

func TestShotClockCanBeTurnedOff(t *testing.T) {
	opts := fastOptions()
	opts.ShotClock = -1
	_, srv := newServer(t, opts)
	code := createRoom(t, srv)
	c0, c1 := dial(t, srv), dial(t, srv)
	c0.join(code, "Ann")
	c1.join(code, "Bob")
	c0.send(msg{"type": "ready"})
	c1.send(msg{"type": "ready"})
	_, st := c1.waitFor("room_state")
	if st["clock"] != nil {
		t.Errorf("clock = %v, want none", st["clock"])
	}
	c1.send(msg{"type": "extend"})
	c1.expectError("wrong_phase")
}

// createRoomMode creates a room for mode and returns the response status
// and code.
func createRoomMode(t *testing.T, srv *httptest.Server, mode string) (int, string) {
	t.Helper()
	res, err := http.Post(srv.URL+"/api/rooms", "application/json", strings.NewReader(`{"mode":"`+mode+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body struct{ RoomCode string }
	json.NewDecoder(res.Body).Decode(&body)
	return res.StatusCode, body.RoomCode
}

func TestNineBallRoomAndModeSwitch(t *testing.T) {
	h, srv := newServer(t, fastOptions())
	if status, _ := createRoomMode(t, srv, "snooker"); status != http.StatusBadRequest {
		t.Errorf("unknown mode: status %d, want 400", status)
	}
	_, code := createRoomMode(t, srv, "9ball")
	if list := h.Rooms(); len(list.Rooms) != 1 || list.Rooms[0].Mode != game.ModeNine {
		t.Fatalf("room list = %+v", list)
	}

	c0, c1 := dial(t, srv), dial(t, srv)
	if _, st := c0.join(code, "Ann"); st["mode"] != "9ball" || len(st["balls"].([]any)) != 10 {
		t.Fatalf("lobby of a 9-ball room: %v", st)
	}
	c1.join(code, "Bob")
	c0.expect("player")
	c0.send(msg{"type": "ready"})
	c0.expect("player")
	c1.expect("player")

	// Switching the game in the lobby makes both players ready again.
	c1.send(msg{"type": "set_mode", "mode": "8ball"})
	for _, c := range []*testClient{c0, c1} {
		st := c.expect("room_state")
		if st["mode"] != "8ball" || players(st)[0].(msg)["ready"] != false || len(st["balls"].([]any)) != game.NumBalls {
			t.Errorf("after set_mode: %v", st)
		}
	}
	c1.send(msg{"type": "set_mode", "mode": "pool"})
	c1.expectError("bad_mode")
	c1.send(msg{"type": "set_mode", "mode": "9ball"})
	c0.expect("room_state")
	c1.expect("room_state")

	c0.send(msg{"type": "ready"})
	c1.send(msg{"type": "ready"})
	for _, c := range []*testClient{c0, c1} {
		_, st := c.waitFor("room_state")
		if st["phase"] != "breaking" || st["mode"] != "9ball" || len(st["balls"].([]any)) != 10 || st["pushOut"] != false {
			t.Errorf("9-ball rack: %v", st)
		}
	}
	c0.send(msg{"type": "set_mode", "mode": "8ball"})
	c0.expectError("wrong_phase")
	c0.send(msg{"type": "shoot", "angle": 0, "power": 1, "call": msg{"pushOut": true}})
	c0.expectError("bad_call") // no push out on the break
}

func TestNineBallPushOut(t *testing.T) {
	opts := fastOptions()
	opts.Game.SlidingFriction = 0.6 // a break that reaches the rails
	opts.Game.RollingFriction = 0.15
	_, srv := newServer(t, opts)
	_, code := createRoomMode(t, srv, "9ball")
	c := [2]*testClient{dial(t, srv), dial(t, srv)}
	c[0].join(code, "Ann")
	c[1].join(code, "Bob")
	c[0].send(msg{"type": "ready"})
	c[1].send(msg{"type": "ready"})
	c[1].waitFor("room_state")

	c[0].send(msg{"type": "shoot", "angle": 0, "power": 1})
	c[0].waitFor("settled")
	_, settled := c[1].waitFor("settled")
	if settled["phase"] != "open" || settled["pushOut"] != true {
		t.Fatalf("after the break: %v", settled)
	}
	shooter := int(settled["turn"].(float64))
	other := 1 - shooter

	c[shooter].send(msg{"type": "shoot", "angle": math.Pi / 2, "power": 0.05, "call": msg{"pushOut": true}})
	_, settled = c[other].waitFor("settled")
	d, _ := settled["decision"].(msg)
	if settled["pushedOut"] != true || settled["foul"] != nil || d == nil || d["seat"] != float64(other) {
		t.Fatalf("after the push out: %v", settled)
	}
	if ck := clockOf(t, settled); ck["seat"] != float64(other) {
		t.Errorf("clock for the decision = %v", ck)
	}

	c[other].send(msg{"type": "choose", "option": "pass_back"})
	st := c[other].expect("room_state")
	if st["turn"] != float64(shooter) || st["decision"] != nil || st["pushOut"] != false {
		t.Errorf("after pass_back: %v", st)
	}
	if ck := clockOf(t, st); ck["seat"] != float64(shooter) || ck["limit"] != 30000.0 {
		t.Errorf("clock after a push out decision = %v, want the normal clock", ck)
	}
}

func TestWelcomeCarriesTheAimLine(t *testing.T) {
	for _, tt := range []struct {
		aim  float64
		want float64
	}{{0, 100}, {0.25, 250}, {-1, 0}} {
		opts := fastOptions()
		opts.AimLine = tt.aim
		_, srv := newServer(t, opts)
		w, _ := dial(t, srv).join(createRoom(t, srv), "Ann")
		if w["aimLine"] != tt.want {
			t.Errorf("AimLine %v: welcome aimLine = %v, want %v", tt.aim, w["aimLine"], tt.want)
		}
	}
}

// createPractice creates a practice room for mode and returns its code.
func createPractice(t *testing.T, srv *httptest.Server, mode string) string {
	t.Helper()
	res, err := http.Post(srv.URL+"/api/rooms", "application/json", strings.NewReader(`{"mode":"`+mode+`","practice":true}`))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body struct{ RoomCode string }
	json.NewDecoder(res.Body).Decode(&body)
	return body.RoomCode
}

// joinPractice joins a practice room and returns the client and the state
// of the rack it starts at once.
func joinPractice(t *testing.T, srv *httptest.Server, code string) (*testClient, msg) {
	t.Helper()
	c := dial(t, srv)
	c.join(code, "Ann")
	return c, c.expect("room_state")
}

func TestPracticeRoomIsPrivateAndStartsAtOnce(t *testing.T) {
	h, srv := newServer(t, fastOptions())
	code := createPractice(t, srv, "9ball")
	if list := h.Rooms(); len(list.Rooms) != 0 || list.Used != 1 {
		t.Errorf("room list = %+v, want no rooms listed and one used", list)
	}
	c, st := joinPractice(t, srv, code)
	if st["practice"] != true || st["phase"] != "open" || st["mode"] != "9ball" || st["clock"] != nil || st["ballInHand"] != false {
		t.Errorf("practice rack: %v", st)
	}
	p := players(st)
	if p[1].(msg)["name"] != "Ann" || p[1].(msg)["connected"] != true {
		t.Errorf("the player should sit on both sides: %v", p)
	}

	other := dial(t, srv)
	other.send(msg{"type": "join", "roomCode": code, "name": "Bob"})
	other.expectError("room_full")

	c.send(msg{"type": "extend"})
	c.expectError("wrong_phase")
}

// Practice is free play: whatever drops stays down, nothing is a foul, the
// player keeps the table and the rack never ends.
func TestPracticeIsFreePlay(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	c, _ := joinPractice(t, srv, createPractice(t, srv, "8ball"))

	// The 8-ball first thing, into the top-left corner, the cue ball after it.
	c.send(msg{"type": "place_cue", "x": 0.35, "y": 0.35})
	c.expect("room_state")
	c.send(msg{"type": "place_ball", "id": 8, "x": 0.2, "y": 0.2})
	c.expect("room_state")
	c.send(msg{"type": "shoot", "angle": -3 * math.Pi / 4, "power": 0.8, "call": msg{"pocket": 3}})
	_, settled := c.waitFor("settled")
	pocketed := settled["pocketed"].([]any)
	if !slices.Contains(pocketed, 8.0) {
		t.Fatalf("the 8 did not drop: %v", settled)
	}
	if settled["foul"] != nil || settled["phase"] != "open" || settled["turn"] != 0.0 || settled["winner"] != nil || settled["decision"] != nil {
		t.Errorf("free play settled as %v", settled)
	}
	onTable := false
	for _, b := range settled["balls"].([]any) {
		onTable = onTable || b.(msg)["id"] == 0.0
	}
	if !onTable {
		t.Errorf("the cue ball is not back on the table: %v", settled["balls"])
	}

	// A miss is no foul either, and the same player shoots again.
	c.send(msg{"type": "shoot", "angle": math.Pi / 2, "power": 0.05})
	if _, settled := c.waitFor("settled"); settled["foul"] != nil || settled["turn"] != 0.0 || settled["ballInHand"] != false {
		t.Errorf("a miss settled as %v", settled)
	}
}

func TestPracticeUndoPlaceAndRerack(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	c, start := joinPractice(t, srv, createPractice(t, srv, "8ball"))

	c.send(msg{"type": "undo"})
	c.expectError("no_undo")

	// Set up a position: the cue ball and the 5 anywhere, outside ball in hand rules.
	c.send(msg{"type": "place_cue", "x": 1.0, "y": 0.4})
	c.expect("room_state")
	c.send(msg{"type": "place_ball", "id": 5, "x": 1.4, "y": 0.5})
	st := c.expect("room_state")
	for _, b := range st["balls"].([]any) {
		if b := b.(msg); b["id"] == 5.0 && (b["x"] != 1.4 || b["y"] != 0.5) {
			t.Errorf("5-ball at %v", b)
		}
	}
	c.send(msg{"type": "place_ball", "id": 5, "x": 1.0, "y": 0.4})
	c.expectError("bad_placement") // on the cue ball

	c.send(msg{"type": "shoot", "angle": 0.2, "power": 0.6})
	if _, settled := c.waitFor("settled"); settled["undos"] != 1.0 {
		t.Errorf("undos after a shot = %v", settled["undos"])
	}
	c.send(msg{"type": "undo"})
	back := c.expect("room_state")
	if back["undos"] != 0.0 {
		t.Errorf("undos after undo = %v", back["undos"])
	}
	if !sameBalls(back["balls"], st["balls"]) || back["turn"] != st["turn"] || back["phase"] != st["phase"] {
		t.Errorf("after undo:\n%v\nwant\n%v", back, st)
	}
	c.send(msg{"type": "undo"})
	c.expectError("no_undo")

	c.send(msg{"type": "rerack", "mode": "9ball"})
	st = c.expect("room_state")
	if st["mode"] != "9ball" || st["phase"] != "open" || len(st["balls"].([]any)) != 10 {
		t.Errorf("after rerack: %v", st)
	}
	c.send(msg{"type": "rerack", "mode": "snooker"})
	c.expectError("bad_mode")
	c.send(msg{"type": "rerack"})
	if st := c.expect("room_state"); st["mode"] != "9ball" || len(start["balls"].([]any)) != game.NumBalls {
		t.Errorf("rerack without a mode: %v", st)
	}
}

// sameBalls compares two ball lists from JSON.
func sameBalls(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

func TestPracticeMessagesOutsidePractice(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	c0, _, _ := startGame(t, srv)
	for _, m := range []msg{
		{"type": "place_ball", "id": 3, "x": 1, "y": 1},
		{"type": "undo"},
		{"type": "rerack"},
	} {
		c0.send(m)
		c0.expectError("not_practice")
	}
}

func TestShotImpactsAreSentOnceInOrder(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	c0, _, _ := startGame(t, srv)
	c0.send(msg{"type": "shoot", "angle": 0, "power": 1})
	var got []msg
	for {
		_, m := c0.read()
		if im, ok := m["impacts"].([]any); ok {
			for _, x := range im {
				got = append(got, x.(msg))
			}
		}
		if m["type"] == "settled" {
			break
		}
	}
	if len(got) < 10 {
		t.Fatalf("only %d impacts for a break", len(got))
	}
	last := -1.0
	for _, im := range got {
		if im["t"].(float64) < last {
			t.Fatalf("impacts out of order: %v", got)
		}
		last = im["t"].(float64)
		if k := im["k"]; k != "ball" && k != "rail" && k != "pocket" {
			t.Errorf("impact kind %v", k)
		}
	}
	if got[0]["k"] != "ball" || got[0]["v"].(float64) < 5 {
		t.Errorf("first impact %v, want the cue ball into the rack", got[0])
	}
}

func matchOf(t *testing.T, m msg) msg {
	t.Helper()
	mt, ok := m["match"].(msg)
	if !ok {
		t.Fatalf("no match in %v", m)
	}
	return mt
}

// waitState skips messages until a room_state or settled satisfies ok.
func (c *testClient) waitState(ok func(msg) bool) msg {
	c.t.Helper()
	for {
		_, m := c.read()
		if (m["type"] == "room_state" || m["type"] == "settled") && ok(m) {
			return m
		}
	}
}

func phaseIs(p string) func(msg) bool { return func(m msg) bool { return m["phase"] == p } }

// clockMatchOptions make 9-ball racks end by themselves: after the break
// nobody shoots, and the third foul on the clock loses.
func clockMatchOptions() Options {
	opts := fastOptions()
	opts.ShotClock = 150 * time.Millisecond
	opts.LongShotClock = 200 * time.Millisecond
	return opts
}

// startMatch creates a room with body, seats Ann and Bob and readies both.
func startMatch(t *testing.T, srv *httptest.Server, body string) (c0, c1 *testClient, code string) {
	t.Helper()
	res, err := http.Post(srv.URL+"/api/rooms", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var created struct{ RoomCode string }
	json.NewDecoder(res.Body).Decode(&created)
	code = created.RoomCode
	c0, c1 = dial(t, srv), dial(t, srv)
	c0.join(code, "Ann")
	c1.join(code, "Bob")
	c0.send(msg{"type": "ready"})
	c1.send(msg{"type": "ready"})
	return c0, c1, code
}

// playRackByClock breaks (st is the state at the start of the rack) and lets
// the clock foul both players until the rack is lost; it returns the final
// state as seen by c0 and c1.
func playRackByClock(t *testing.T, c0, c1 *testClient, st msg) [2]msg {
	t.Helper()
	breaker := []*testClient{c0, c1}[int(st["turn"].(float64))]
	breaker.send(msg{"type": "shoot", "angle": 0, "power": 1})
	return [2]msg{c0.waitState(phaseIs("game_over")), c1.waitState(phaseIs("game_over"))}
}

func TestRaceMatchWithAlternatingBreaks(t *testing.T) {
	_, srv := newServer(t, clockMatchOptions())
	c0, c1, _ := startMatch(t, srv, `{"mode":"9ball","race":2}`)
	st := c0.waitState(phaseIs("breaking"))
	c1.waitState(phaseIs("breaking"))
	if m := matchOf(t, st); m["race"] != 2.0 || m["breaks"] != "alternate" || m["winner"] != nil || st["race"] != 2.0 {
		t.Fatalf("match at the start = %v", m)
	}

	var m msg
	for rack := 0; ; rack++ {
		if rack > 2 {
			t.Fatal("a race to 2 took more than 3 racks")
		}
		if st["turn"] != float64(rack%2) {
			t.Fatalf("rack %d broken by %v, want %d (alternating)", rack+1, st["turn"], rack%2)
		}
		end := playRackByClock(t, c0, c1, st)
		m = matchOf(t, end[0])
		racks := m["racks"].([]any)
		last := racks[len(racks)-1].(msg)
		score := m["score"].([]any)
		if len(racks) != rack+1 || last["end"] != "three_fouls" || last["breaker"] != float64(rack%2) ||
			score[0].(float64)+score[1].(float64) != float64(rack+1) || last["winner"] != end[0]["winner"] {
			t.Fatalf("match after rack %d = %v", rack+1, m)
		}
		if m["winner"] != nil {
			break
		}
		// Between racks the settings are locked.
		c0.send(msg{"type": "set_mode", "mode": "8ball"})
		c0.expectError("wrong_phase")
		c0.send(msg{"type": "set_match", "race": 5})
		c0.expectError("wrong_phase")
		c1.send(msg{"type": "rematch"})
		st = c0.waitState(phaseIs("breaking"))
		c1.waitState(phaseIs("breaking"))
	}
	w := int(m["winner"].(float64))
	if m["score"].([]any)[w] != 2.0 {
		t.Errorf("match winner %d with score %v", w, m["score"])
	}

	// After the match: new settings, kept apart from the finished match.
	c0.send(msg{"type": "set_match", "race": 26})
	c0.expectError("bad_race")
	c0.send(msg{"type": "set_match", "race": 3, "breaks": "winner"})
	for _, c := range []*testClient{c0, c1} {
		st := c.waitState(phaseIs("game_over"))
		if st["race"] != 3.0 || st["breaks"] != "winner" || matchOf(t, st)["race"] != 2.0 || matchOf(t, st)["winner"] != m["winner"] {
			t.Errorf("state after set_match = %v", st)
		}
	}
	// A new match: the other player opens, the score is clear.
	c0.send(msg{"type": "rematch"})
	st = c1.waitState(phaseIs("breaking"))
	if nm := matchOf(t, st); st["turn"] != 1.0 || nm["race"] != 3.0 || nm["breaks"] != "winner" || nm["winner"] != nil || len(nm["racks"].([]any)) != 0 {
		t.Errorf("new match: turn %v, match %v", st["turn"], nm)
	}
}

func TestWinnerBreaks(t *testing.T) {
	_, srv := newServer(t, clockMatchOptions())
	c0, c1, _ := startMatch(t, srv, `{"mode":"9ball","race":3,"breaks":"winner"}`)
	st := c0.waitState(phaseIs("breaking"))
	c1.waitState(phaseIs("breaking"))
	end := playRackByClock(t, c0, c1, st)
	won := end[0]["winner"]
	c0.send(msg{"type": "rematch"})
	st = c0.waitState(phaseIs("breaking"))
	if st["turn"] != won {
		t.Errorf("rack 2 broken by %v, want the winner of rack 1, %v", st["turn"], won)
	}
}

func TestLeaveForfeitsTheMatch(t *testing.T) {
	h, srv := newServer(t, fastOptions())
	c0, c1, code := startMatch(t, srv, `{"race":3}`)
	c0.waitState(phaseIs("breaking"))
	c1.waitState(phaseIs("breaking"))

	c1.send(msg{"type": "leave"})
	if p := c0.expect("player"); p["seat"] != 1.0 || p["name"] != "" {
		t.Errorf("leave announcement = %v", p)
	}
	st := c0.expect("room_state")
	m := matchOf(t, st)
	if st["phase"] != "lobby" || m["winner"] != 0.0 || m["score"].([]any)[0] != 0.0 || len(m["racks"].([]any)) != 1 {
		t.Fatalf("state after the opponent left = %v", st)
	}
	if r := m["racks"].([]any)[0].(msg); r["end"] != "forfeit" || r["winner"] != 0.0 || r["breaker"] != 0.0 {
		t.Errorf("forfeited rack = %v", r)
	}
	// The leaver's socket is closed and the seat is free at once.
	ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
	defer cancel()
	if _, _, err := c1.conn.Read(ctx); websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Errorf("leaver's socket: %v", err)
	}
	if l := h.Rooms(); len(l.Rooms) != 1 || l.Rooms[0].Seated != 1 || l.Rooms[0].Race != 3 {
		t.Errorf("room list after leaving = %+v", l)
	}

	// Leaving the lobby forfeits nothing.
	c2 := dial(t, srv)
	c2.join(code, "Cat")
	c0.expect("player")
	c2.send(msg{"type": "leave"})
	c0.expect("player")
	c0.send(msg{"type": "ready"})
	c0.expect("player")
	c3 := dial(t, srv)
	if _, st := c3.join(code, "Dan"); matchOf(t, st)["winner"] != nil || st["phase"] != "lobby" {
		t.Errorf("state for a new player = %v", st)
	}
}

func TestCreateRoomRejectsABadRace(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	for _, body := range []string{`{"race":0.5}`, `{"race":26}`, `{"race":-1}`, `{"breaks":"loser"}`} {
		res, err := http.Post(srv.URL+"/api/rooms", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		var out map[string]string
		json.NewDecoder(res.Body).Decode(&out)
		res.Body.Close()
		if body == `{"race":0.5}` {
			continue // not an integer: a bad body, the defaults
		}
		if res.StatusCode != http.StatusBadRequest || out["error"] != "bad_race" {
			t.Errorf("%s: %d %v", body, res.StatusCode, out)
		}
	}
}

// The break rule decides who breaks the next rack, whoever broke the last.
func TestNextBreakerFollowsTheRule(t *testing.T) {
	for _, tc := range []struct {
		rule game.BreakRule
		want int
	}{{game.BreakAlternate, 1}, {game.BreakWinner, 0}} {
		r := newRoom(New(fastOptions()), "TEST", RoomSettings{Mode: game.ModeEight, Race: 3, Breaks: tc.rule})
		r.startRack(0)
		r.game.Rules.Phase, r.game.Rules.Winner = game.PhaseGameOver, 0
		r.endRack(game.FoulNone)
		if err := r.handleRematch(); err != nil {
			t.Fatal(err)
		}
		if r.game.Rules.Turn != tc.want || r.match.Score != [2]int{1, 0} {
			t.Errorf("%s: rack 2 broken by %d (want %d), score %v", tc.rule, r.game.Rules.Turn, tc.want, r.match.Score)
		}
		r.stopClock()
	}
}
