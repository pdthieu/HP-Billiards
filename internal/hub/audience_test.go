package hub

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// createWith creates a room with the given JSON body and returns its code.
func createWith(t *testing.T, srv *httptest.Server, body string) string {
	t.Helper()
	res, err := http.Post(srv.URL+"/api/rooms", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out struct{ RoomCode string }
	json.NewDecoder(res.Body).Decode(&out)
	if out.RoomCode == "" {
		t.Fatalf("no room created for %s: %d", body, res.StatusCode)
	}
	return out.RoomCode
}

// watch joins code as a spectator and returns the welcome and room_state.
func (c *testClient) watch(code, name string) (welcome, state msg) {
	c.t.Helper()
	c.send(msg{"type": "join", "roomCode": code, "name": name, "watch": true})
	return c.expect("welcome"), c.expect("room_state")
}

func names(v any) []string {
	var out []string
	for _, n := range v.([]any) {
		out = append(out, n.(string))
	}
	return out
}

// A spectator sees the game as the players do, including the shooter's
// aim, but may not play.
func TestSpectatorWatchesButCannotPlay(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	c0, c1, code := startGame(t, srv)
	s := dial(t, srv)
	w, st := s.watch(code, "  Chi  ")
	if w["spectator"] != true || w["seat"] != -1.0 || w["token"] != "" {
		t.Fatalf("welcome %v", w)
	}
	if st["phase"] != "breaking" || st["maxSpectators"] != 3.0 || strings.Join(names(st["spectators"]), ",") != "Chi" {
		t.Fatalf("room_state %v", st)
	}
	for _, c := range []*testClient{c0, c1, s} {
		if _, a := c.waitFor("audience"); strings.Join(names(a["names"]), ",") != "Chi" || a["max"] != 3.0 {
			t.Fatalf("audience %v", a)
		}
	}

	s.send(msg{"type": "shoot", "angle": 0, "power": 0.5})
	s.expectError("spectator")
	s.send(msg{"type": "ready"})
	s.expectError("spectator")

	c0.send(msg{"type": "aim", "angle": 0.25, "power": 0.4})
	if _, a := s.waitFor("aim"); a["seat"] != 0.0 || a["angle"] != 0.25 {
		t.Fatalf("aim %v", a)
	}
	c0.send(msg{"type": "shoot", "angle": 0, "power": 0.6})
	s.waitFor("snapshot")
	if _, set := s.waitFor("settled"); set["shooter"] != 0.0 {
		t.Fatalf("settled %v", set)
	}
}

// Comments reach everyone; each sender waits ChatCooldown between two.
func TestChatReachesEveryoneWithACooldown(t *testing.T) {
	opts := fastOptions()
	opts.ChatCooldown = 300 * time.Millisecond
	_, srv := newServer(t, opts)
	c0, c1, code := startGame(t, srv)
	s := dial(t, srv)
	s.watch(code, "Chi")

	s.send(msg{"type": "chat", "text": "  đỉnh   của chóp  "})
	for _, c := range []*testClient{c0, c1, s} {
		_, m := c.waitFor("chat")
		if m["from"] != "Chi" || m["seat"] != -1.0 || m["text"] != "đỉnh của chóp" || m["at"].(float64) <= 0 {
			t.Fatalf("chat %v", m)
		}
	}
	s.send(msg{"type": "chat", "text": "again"})
	_, e := s.waitFor("error")
	if e["code"] != "chat_cooldown" || e["retryMs"].(float64) <= 0 || e["retryMs"].(float64) > 300 {
		t.Fatalf("cooldown %v", e)
	}
	// a player's wait is their own
	c1.send(msg{"type": "chat", "text": "cảm ơn"})
	if _, m := s.waitFor("chat"); m["from"] != "Bob" || m["seat"] != 1.0 {
		t.Fatalf("player chat %v", m)
	}
	time.Sleep(350 * time.Millisecond)
	s.send(msg{"type": "chat", "text": "again"})
	if _, m := c0.waitFor("chat"); m["text"] != "again" {
		// c0 first sees Chi's and Bob's earlier comments
		if _, m = c0.waitFor("chat"); m["text"] != "again" {
			t.Fatalf("after the cooldown %v", m)
		}
	}

	for _, text := range []string{"   ", strings.Repeat("a", 201)} {
		c0.send(msg{"type": "chat", "text": text})
		_, e := c0.waitFor("error")
		if e["code"] != "bad_message" {
			t.Fatalf("%q: %v", text, e)
		}
	}

	// whoever comes later gets the recent comments
	late := dial(t, srv)
	late.watch(code, "Dan")
	_, log := late.waitFor("chat_log")
	if got := len(log["messages"].([]any)); got != 3 {
		t.Fatalf("chat_log has %d comments: %v", got, log)
	}
}

// A room lets at most its number of spectators watch; players change it.
func TestAudienceLimit(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	code := createWith(t, srv, `{"spectators":1}`)
	c0 := dial(t, srv)
	c0.join(code, "Ann")
	dial(t, srv).watch(code, "Chi")
	extra := dial(t, srv)
	extra.send(msg{"type": "join", "roomCode": code, "watch": true})
	extra.expectError("audience_full")

	var list RoomList
	res, _ := http.Get(srv.URL + "/api/rooms")
	json.NewDecoder(res.Body).Decode(&list)
	res.Body.Close()
	if len(list.Rooms) != 1 || list.Rooms[0].Spectators != 1 || list.Rooms[0].MaxSpectators != 1 {
		t.Fatalf("room list %+v", list)
	}

	c0.waitFor("audience") // Chi came
	c0.send(msg{"type": "set_audience", "spectators": 2})
	if _, a := c0.waitFor("audience"); a["max"] != 2.0 {
		t.Fatalf("audience %v", a)
	}
	extra.send(msg{"type": "join", "roomCode": code, "watch": true}) // the failed join left the socket open
	if w := extra.expect("welcome"); w["spectator"] != true {
		t.Fatalf("welcome %v", w)
	}
	c0.send(msg{"type": "set_audience", "spectators": 11})
	c0.waitFor("error") // over the server's limit

	none := createWith(t, srv, `{"spectators":0}`)
	x := dial(t, srv)
	x.send(msg{"type": "join", "roomCode": none, "watch": true})
	x.expectError("audience_full")

	practice := createPractice(t, srv, "8ball")
	x.send(msg{"type": "join", "roomCode": practice, "watch": true})
	x.expectError("audience_full")
}

func TestCreateRoomRejectsBadSpectators(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	for _, body := range []string{`{"spectators":-1}`, `{"spectators":11}`} {
		res, err := http.Post(srv.URL+"/api/rooms", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		var out map[string]string
		json.NewDecoder(res.Body).Decode(&out)
		res.Body.Close()
		if res.StatusCode != http.StatusBadRequest || out["error"] != "bad_spectators" {
			t.Errorf("%s: %d %v", body, res.StatusCode, out)
		}
	}
}

// A spectator leaving, by message or by closing, updates the audience; one
// that leaves keeps no place.
func TestSpectatorLeaves(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	code := createRoom(t, srv)
	c0 := dial(t, srv)
	c0.join(code, "Ann")
	a, b := dial(t, srv), dial(t, srv)
	a.watch(code, "Chi")
	b.watch(code, "Dan")
	c0.waitFor("audience")
	c0.waitFor("audience")

	a.send(msg{"type": "leave"})
	if _, m := c0.waitFor("audience"); strings.Join(names(m["names"]), ",") != "Dan" {
		t.Fatalf("after leave %v", m)
	}
	b.conn.CloseNow()
	if _, m := c0.waitFor("audience"); len(m["names"].([]any)) != 0 {
		t.Fatalf("after close %v", m)
	}
}
