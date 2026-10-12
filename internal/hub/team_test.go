package hub

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"billiards/internal/game"
)

var teamNames = [4]string{"Ann", "Bob", "Cat", "Dan"}

// postRoom creates a room with body and returns the status and the reply.
func postRoom(t *testing.T, srv *httptest.Server, body string) (int, msg) {
	t.Helper()
	res, err := http.Post(srv.URL+"/api/rooms", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out msg
	json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

// seatFour joins Ann, Bob, Cat and Dan to a 2v2 room, in seats 0 to 3, and
// reads what the ones already in heard of each newcomer. It returns the
// clients and their tokens.
func seatFour(t *testing.T, srv *httptest.Server, code string) ([4]*testClient, [4]string) {
	t.Helper()
	var cs [4]*testClient
	var tokens [4]string
	for i, name := range teamNames {
		cs[i] = dial(t, srv)
		w, st := cs[i].join(code, name)
		if w["seat"] != float64(i) || st["size"] != 4.0 || len(players(st)) != 4 {
			t.Fatalf("%s: welcome %v, room_state %v", name, w, st)
		}
		tokens[i] = w["token"].(string)
		for j := 0; j < i; j++ {
			if p := cs[j].expect("player"); p["seat"] != float64(i) {
				t.Fatalf("seat %d heard %v", j, p)
			}
		}
	}
	return cs, tokens
}

// startTeamGame seats four players in a new 2v2 room and readies them all;
// seat 0 breaks.
func startTeamGame(t *testing.T, srv *httptest.Server) ([4]*testClient, string, [4]string) {
	t.Helper()
	code := createWith(t, srv, `{"players":4}`)
	cs, tokens := seatFour(t, srv, code)
	for _, c := range cs {
		c.send(msg{"type": "ready"})
	}
	for _, c := range cs {
		_, st := c.waitFor("room_state")
		if st["phase"] != "breaking" || st["turn"] != 0.0 || len(st["groups"].([]any)) != 2 {
			t.Fatalf("state after all ready: %v", st)
		}
	}
	return cs, code, tokens
}

func TestCreateTeamRoom(t *testing.T) {
	opts := fastOptions()
	opts.MaxRooms = 10
	_, srv := newServer(t, opts)
	code := createWith(t, srv, `{"players":4}`)
	res, err := http.Get(srv.URL + "/api/rooms")
	if err != nil {
		t.Fatal(err)
	}
	var list RoomList
	json.NewDecoder(res.Body).Decode(&list)
	res.Body.Close()
	if len(list.Rooms) != 1 || list.Rooms[0].RoomCode != code || list.Rooms[0].Size != 4 || len(list.Rooms[0].Players) != 4 {
		t.Fatalf("room list %+v", list)
	}
	for _, body := range []string{`{"players":3}`, `{"players":4,"mode":"3cushion"}`} {
		if status, out := postRoom(t, srv, body); status != http.StatusBadRequest || out["error"] != "bad_players" {
			t.Errorf("%s: %d %v", body, status, out)
		}
	}
	createWith(t, srv, `{"players":4,"mode":"9ball"}`) // scotch doubles
	// practice is one player, whatever is asked
	practice := createWith(t, srv, `{"practice":true,"players":4}`)
	c := dial(t, srv)
	if _, st := c.join(practice, "Pho"); st["size"] != 2.0 {
		t.Errorf("practice room_state %v", st)
	}
	// a room of two says so too
	c2 := dial(t, srv)
	if _, st := c2.join(createRoom(t, srv), "Ann"); st["size"] != 2.0 || len(players(st)) != 2 {
		t.Errorf("1v1 room_state %v", st)
	}
}

func TestTeamLobbySit(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	code := createWith(t, srv, `{"players":4}`)
	cs, tokens := seatFour(t, srv, code)

	late := dial(t, srv)
	late.send(msg{"type": "join", "roomCode": code, "name": "Eve"})
	late.expectError("room_full")

	// Cat leaves; Dan takes her seat on Ann's side.
	cs[2].send(msg{"type": "leave"})
	for _, i := range []int{0, 1, 3} {
		if p := cs[i].expect("player"); p["seat"] != 2.0 || p["name"] != "" {
			t.Fatalf("seat %d heard %v", i, p)
		}
	}
	cs[3].send(msg{"type": "sit", "seat": 2})
	w := cs[3].expect("welcome")
	if w["seat"] != 2.0 || w["token"] != tokens[3] {
		t.Fatalf("welcome after sit %v", w)
	}
	for _, i := range []int{0, 1, 3} {
		st := cs[i].expect("room_state")
		ps := players(st)
		if ps[2].(msg)["name"] != "Dan" || ps[3].(msg)["name"] != "" {
			t.Fatalf("seat %d: players %v", i, ps)
		}
	}
	cs[3].send(msg{"type": "sit", "seat": 0})
	cs[3].expectError("seat_taken")
	cs[3].send(msg{"type": "sit", "seat": 7})
	cs[3].expectError("bad_input")

	// The token still holds: Dan's seat is now 2.
	cs[3].conn.CloseNow()
	time.Sleep(50 * time.Millisecond) // the close reaches the room first
	cs[0].waitFor("player")
	// in the lobby a closed socket frees the seat; a fresh join takes the
	// first free one
	c := dial(t, srv)
	if w, _ := c.join(code, "Eve"); w["seat"] != 2.0 {
		t.Fatalf("Eve got %v", w)
	}

	// No sitting during a game.
	c4 := dial(t, srv)
	c4.join(code, "Fay")
	for _, cl := range []*testClient{cs[0], cs[1], c, c4} {
		cl.send(msg{"type": "ready"})
	}
	_, st := cs[0].waitFor("room_state")
	if st["phase"] != "breaking" {
		t.Fatalf("not started: %v", st)
	}
	c.send(msg{"type": "sit", "seat": 3})
	_, e := c.waitFor("error")
	if e["code"] != "wrong_phase" {
		t.Fatalf("sit during the game: %v", e)
	}
}

func TestTeamGameNeedsAllFourReady(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	code := createWith(t, srv, `{"players":4}`)
	cs, _ := seatFour(t, srv, code)
	for _, c := range cs[:3] {
		c.send(msg{"type": "ready"})
	}
	// a comment goes through the room after the readies: nothing started
	cs[0].send(msg{"type": "chat", "text": "waiting for Dan"})
	for {
		raw, m := cs[0].read()
		if m["type"] == "room_state" {
			t.Fatalf("started with three ready: %s", raw)
		}
		if m["type"] == "chat" {
			break
		}
	}
	cs[3].send(msg{"type": "ready"})
	_, st := cs[0].waitFor("room_state")
	if st["phase"] != "breaking" || st["turn"] != 0.0 {
		t.Fatalf("state %v", st)
	}
}

func TestTeamRotationOnTimeFouls(t *testing.T) {
	_, srv := newServer(t, clockMatchOptions())
	cs, _, _ := startTeamGame(t, srv)
	// A1 → B1 → A2 → B2 → A1, each letting the clock run out.
	for i, want := range []int{0, 1, 2, 3, 0} {
		_, out := cs[1].waitFor("timeout")
		if out["seat"] != float64(want) {
			t.Fatalf("timeout %d: %v, want seat %d", i, out, want)
		}
		_, st := cs[1].waitFor("room_state")
		next := float64((want + 1) % 4)
		clock, _ := st["clock"].(msg)
		if st["turn"] != next || clock == nil || clock["seat"] != next {
			t.Fatalf("after seat %d's time foul: turn %v clock %v", want, st["turn"], clock)
		}
		if len(st["groups"].([]any)) != 2 || len(st["fouls"].([]any)) != 2 {
			t.Fatalf("per-side fields %v %v", st["groups"], st["fouls"])
		}
	}
}

func TestTeammateCannotActForTheShooter(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	cs, code, _ := startTeamGame(t, srv)
	spec := dial(t, srv)
	spec.watch(code, "Zed")
	for _, c := range append(cs[:], spec) {
		c.waitFor("audience")
	}

	cs[2].send(msg{"type": "shoot", "angle": 0, "power": 1})
	cs[2].expectError("not_your_turn")
	cs[2].send(msg{"type": "place_cue", "x": 0.4, "y": 0.6})
	cs[2].expectError("not_your_turn")
	cs[1].send(msg{"type": "shoot", "angle": 0, "power": 1})
	cs[1].expectError("not_your_turn")

	// The shooter's aim reaches the three others and the spectator; a
	// teammate's is dropped.
	cs[2].send(msg{"type": "aim", "angle": 1, "power": 0.5})
	cs[0].send(msg{"type": "aim", "angle": 0.5, "power": 0.4})
	for _, c := range []*testClient{cs[1], cs[2], cs[3], spec} {
		if a := c.expect("aim"); a["seat"] != 0.0 || a["angle"] != 0.5 {
			t.Fatalf("aim %v", a)
		}
	}
}

func TestTeamDecisionSeat(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	cs, _, _ := startTeamGame(t, srv)

	softBreak := func() {
		t.Helper()
		cs[0].send(msg{"type": "shoot", "angle": 0, "power": 0.3}) // drives nothing to a rail
		_, m := cs[0].waitFor("settled")
		d, _ := m["decision"].(msg)
		if m["illegalBreak"] != true || d == nil || d["seat"] != 1.0 || m["shooter"] != 0.0 {
			t.Fatalf("settled = %v, want B1 (seat 1) to decide", m)
		}
		clock, _ := m["clock"].(msg)
		if clock == nil || clock["seat"] != 1.0 {
			t.Fatalf("clock %v", clock)
		}
	}
	softBreak()
	cs[3].send(msg{"type": "choose", "option": "rerack_opponent_breaks"})
	if _, e := cs[3].waitFor("error"); e["code"] != "not_your_turn" {
		t.Fatalf("B2 chose for B1: %v", e)
	}
	cs[1].send(msg{"type": "choose", "option": "rerack_opponent_breaks"})
	if _, st := cs[0].waitFor("room_state"); st["turn"] != 0.0 || st["phase"] != "breaking" {
		t.Fatalf("A1 breaks again: %v", st)
	}
	softBreak() // B's rotation did not move: B1 decides again
	cs[1].send(msg{"type": "choose", "option": "accept_table"})
	if _, st := cs[0].waitFor("room_state"); st["turn"] != 1.0 {
		t.Fatalf("B1 shoots from the table: turn %v", st["turn"])
	}
}

func TestTeamExtensionIsPerTeam(t *testing.T) {
	opts := fastOptions()
	opts.ShotClock = 700 * time.Millisecond
	opts.LongShotClock = 900 * time.Millisecond
	_, srv := newServer(t, opts)
	cs, _, _ := startTeamGame(t, srv)

	cs[2].send(msg{"type": "extend"})
	cs[2].expectError("not_your_turn")
	cs[0].send(msg{"type": "extend"})
	_, cl := cs[0].waitFor("clock")
	if ext := cl["extensions"].([]any); ext[0] != false || ext[1] != true {
		t.Fatalf("extensions after A1's %v", ext)
	}
	// A1's clock runs out, then B1's: A2 has no extension left.
	turn := func(seat float64) {
		t.Helper()
		for {
			_, st := cs[0].waitFor("room_state")
			if st["turn"] == seat {
				return
			}
		}
	}
	turn(2)
	cs[2].send(msg{"type": "extend"})
	if _, e := cs[2].waitFor("error"); e["code"] != "no_extension" {
		t.Fatalf("A2's extend: %v", e)
	}
	turn(3)
	cs[3].send(msg{"type": "extend"})
	for cl["seat"] != 3.0 {
		_, cl = cs[3].waitFor("clock")
	}
	if ext := cl["extensions"].([]any); ext[0] != false || ext[1] != false || cl["seat"] != 3.0 {
		t.Fatalf("after B2's extend %v", cl)
	}
}

func TestTeammateDropsThenTheGameGoesOn(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	cs, _, _ := startTeamGame(t, srv)
	cs[2].conn.CloseNow()
	if p := cs[0].expect("player"); p["seat"] != 2.0 || p["connected"] != false || p["name"] != "Cat" {
		t.Fatalf("held %v", p)
	}
	// after the grace the seat is empty, the game still on
	if p := cs[0].expect("player"); p["seat"] != 2.0 || p["name"] != "" {
		t.Fatalf("vacated %v", p)
	}
	st := cs[0].expect("room_state")
	if st["phase"] != "breaking" || st["turn"] != 0.0 || st["match"].(msg)["winner"] != nil {
		t.Fatalf("state after Cat left %v", st)
	}
	// Ann shoots Cat's turns too: a time foul by Ann, then by Bob, hands
	// the turn back to Ann.
	cs[0].send(msg{"type": "shoot", "angle": 0, "power": 1})
	_, m := cs[0].waitFor("settled")
	if m["shooter"] != 0.0 {
		t.Fatalf("settled %v", m)
	}
}

func TestShooterDropsClockPausesThenTeammateTakesOver(t *testing.T) {
	opts := fastOptions()
	opts.ShotClock = 5 * time.Second
	_, srv := newServer(t, opts)
	cs, _, _ := startTeamGame(t, srv)
	cs[0].conn.CloseNow()
	cs[2].expect("player") // Ann held
	if _, cl := cs[2].waitFor("clock"); cl["paused"] != true || cl["seat"] != 0.0 {
		t.Fatalf("clock while Ann is away %v", cl)
	}
	// the teammate may not act while the seat is held
	cs[2].send(msg{"type": "shoot", "angle": 0, "power": 1})
	if _, e := cs[2].waitFor("error"); e["code"] != "not_your_turn" {
		t.Fatalf("Cat during the hold: %v", e)
	}
	_, st := cs[2].waitFor("room_state")
	cl, _ := st["clock"].(msg)
	if st["turn"] != 2.0 || cl == nil || cl["seat"] != 2.0 || cl["paused"] != false || st["phase"] != "breaking" {
		t.Fatalf("after the grace: turn %v clock %v phase %v", st["turn"], cl, st["phase"])
	}
	cs[2].send(msg{"type": "shoot", "angle": 0, "power": 1})
	if _, m := cs[2].waitFor("settled"); m["shooter"] != 2.0 {
		t.Fatalf("settled %v", m)
	}
}

func TestWholeTeamGoneForfeits(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	cs, code, _ := startTeamGame(t, srv)
	cs[0].conn.CloseNow()
	cs[2].conn.CloseNow()
	for {
		_, st := cs[1].waitFor("room_state")
		if st["phase"] != "lobby" {
			continue
		}
		m := st["match"].(msg)
		if m["winner"] != 1.0 {
			t.Fatalf("match %v", m)
		}
		for _, p := range players(st) {
			if p.(msg)["ready"] != false {
				t.Fatalf("still ready: %v", players(st))
			}
		}
		break
	}
	// back in the lobby the room takes players again
	c := dial(t, srv)
	if w, _ := c.join(code, "Eve"); w["seat"] != 0.0 {
		t.Fatalf("Eve got %v", w)
	}
}

func TestLeavingATeamGameGoesOnThenForfeits(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	cs, code, _ := startTeamGame(t, srv)
	cs[0].send(msg{"type": "leave"})
	_, st := cs[1].waitFor("room_state")
	if st["phase"] != "breaking" || st["turn"] != 2.0 {
		t.Fatalf("after Ann left: %v", st)
	}
	// nobody joins a 2v2 game on
	late := dial(t, srv)
	late.send(msg{"type": "join", "roomCode": code, "name": "Eve"})
	late.expectError("room_full")

	cs[2].send(msg{"type": "leave"})
	_, st = cs[1].waitFor("room_state")
	if st["phase"] != "lobby" || st["match"].(msg)["winner"] != 1.0 {
		t.Fatalf("after Cat left too: %v", st)
	}
}

func TestTeamSetModeIsLocked(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	code := createWith(t, srv, `{"players":4}`)
	c := dial(t, srv)
	c.join(code, "Ann")
	c.send(msg{"type": "set_mode", "mode": "3cushion"})
	c.expectError("bad_players")
	c.send(msg{"type": "set_mode", "mode": "9ball"})
	if st := c.expect("room_state"); st["mode"] != "9ball" {
		t.Fatalf("set_mode 9ball: %v", st)
	}
}

// TestScotchRotation drives 9-ball doubles directly: teammates alternate
// every shot, pocketing or not; a side keeps its place while the other
// plays; teammates take turns to break; an empty seat is skipped.
func TestScotchRotation(t *testing.T) {
	h := New(fastOptions())
	settings := RoomSettings{Players: 4, Mode: game.ModeNine}
	settings.fill(10)
	r := newRoom(h, "NINE", settings)
	for i, name := range teamNames {
		r.seats[i] = seat{name: name}
	}
	r.startRack(0)
	if r.shooter != 0 {
		t.Fatalf("breaker %d", r.shooter)
	}
	// shot by the shooter; then the turn is side's
	shot := func(side, want int) {
		t.Helper()
		r.shotBy = r.shooter
		r.shotDone(r.shotBy)
		r.game.Rules.Turn = side
		r.syncShooter()
		if r.shooter != want || r.actor() != want {
			t.Fatalf("after a shot, side %d: shooter %d, want %d", side, r.shooter, want)
		}
	}
	shot(0, 2) // Ann pocketed on the break: Cat shoots
	shot(0, 0) // Cat pocketed: Ann
	shot(1, 1) // Ann missed: Bob
	shot(1, 3) // Bob pocketed: Dan
	shot(0, 2) // Dan missed: A's next is Cat
	shot(1, 1) // Cat missed: B's next is Bob again

	// a push out by Bob: A's next (Ann) decides; a pass back leaves the
	// shot to Bob's partner
	shot(1, 3)
	r.game.Rules.Turn = 1
	r.game.Rules.Decision = &game.Decision{Seat: 0, Options: []game.Option{game.OptTakeShot, game.OptPassBack}}
	if a := r.actor(); a != 0 {
		t.Fatalf("decides after the push out: %d", a)
	}
	r.game.Rules.Decision = nil
	r.syncShooter()
	if r.shooter != 3 {
		t.Fatalf("after a pass back: %d", r.shooter)
	}

	// breaks: B first, then A's second player, then B's
	r.game.Rules.Phase = game.PhaseGameOver
	for _, c := range []struct{ side, want int }{{1, 1}, {0, 2}, {1, 3}, {0, 0}} {
		r.startRack(c.side)
		if r.shooter != c.want {
			t.Fatalf("side %d breaks with %d, want %d", c.side, r.shooter, c.want)
		}
	}

	r.seats[2] = seat{} // Cat is gone: Ann plays every shot of A
	r.startRack(0)
	shot(0, 0)
	shot(0, 0)

	// 8-ball keeps shooting on after a pot
	r.mode = game.ModeEight
	r.seats[2] = seat{name: "Cat"}
	r.newMatch()
	r.startRack(0)
	shot(0, 0)
}

// TestNineTeamPushOutPassBack: after the break the next player of the side
// may push out; the other side's next player decides, and a pass back gives
// the shot to the pusher's partner.
func TestNineTeamPushOutPassBack(t *testing.T) {
	_, srv := newServer(t, fastOptions())
	code := createWith(t, srv, `{"players":4,"mode":"9ball"}`)
	cs, _ := seatFour(t, srv, code)
	for _, c := range cs {
		c.send(msg{"type": "ready"})
	}
	for _, c := range cs {
		c.waitFor("room_state")
	}
	cs[0].send(msg{"type": "shoot", "angle": 0, "power": 1})
	_, m := cs[1].waitFor("settled")
	if m["phase"] == "game_over" {
		t.Skip("the 9 dropped on the break")
	}
	pusher := int(m["turn"].(float64))
	if pusher != 1 && pusher != 2 || m["pushOut"] != true {
		t.Fatalf("after Ann's break: turn %d pushOut %v (want Cat or Bob, a push out allowed)", pusher, m["pushOut"])
	}
	decider := 3 - pusher // Bob decides Cat's push out, Cat decides Bob's
	cs[pusher^2].send(msg{"type": "shoot", "angle": 1, "power": 0.02, "call": msg{"pushOut": true}})
	if _, e := cs[pusher^2].waitFor("error"); e["code"] != "not_your_turn" {
		t.Fatalf("the pusher's partner shot: %v", e)
	}
	cs[pusher].send(msg{"type": "shoot", "angle": 1, "power": 0.02, "call": msg{"pushOut": true}})
	_, m = cs[1].waitFor("settled")
	d, _ := m["decision"].(msg)
	if m["pushedOut"] != true || d == nil || d["seat"] != float64(decider) {
		t.Fatalf("after the push out: %v", m)
	}
	cs[decider].send(msg{"type": "choose", "option": "pass_back"})
	_, st := cs[1].waitFor("room_state")
	cl, _ := st["clock"].(msg)
	if st["turn"] != float64(pusher^2) || cl == nil || cl["seat"] != float64(pusher^2) {
		t.Fatalf("after the pass back: turn %v clock %v, want the pusher's partner %d", st["turn"], cl, pusher^2)
	}
}

// TestSyncShooterRotation drives the rotation directly: the turn's side
// changes, the seat follows A1 → B1 → A2 → B2, an empty seat is skipped and
// a decision is the deciding side's next player's.
func TestSyncShooterRotation(t *testing.T) {
	h := New(fastOptions())
	settings := RoomSettings{Players: 4}
	settings.fill(10)
	r := newRoom(h, "TEST", settings)
	for i, name := range teamNames {
		r.seats[i] = seat{name: name}
	}
	r.startRack(0)
	if r.shooter != 0 {
		t.Fatalf("breaker %d", r.shooter)
	}
	turn := func(side, want int) {
		t.Helper()
		r.game.Rules.Turn = side
		r.syncShooter()
		if r.shooter != want || r.turnSeat() != want || r.actor() != want {
			t.Fatalf("side %d: shooter %d, want %d", side, r.shooter, want)
		}
	}
	turn(1, 1)
	turn(0, 2)
	turn(0, 2) // pocketed: shoots on
	turn(1, 3)
	turn(0, 0)

	r.game.Rules.Decision = &game.Decision{Seat: 1, Options: []game.Option{game.OptAcceptTable}}
	if a := r.actor(); a != 1 {
		t.Fatalf("B decides: %d", a)
	}
	if d := r.wireDecision(r.game.Rules.Decision); d.Seat != 1 || r.game.Rules.Decision.Seat != 1 {
		t.Fatalf("wire decision %+v", d)
	}
	r.game.Rules.Decision = nil

	r.seats[2] = seat{} // Cat is gone: Ann plays both of A's turns
	turn(1, 1)
	turn(0, 0)
	turn(1, 3)
	turn(0, 0)

	// a new rack moves on the side of the last turn; a new match starts over
	r.game.Rules.Phase = game.PhaseGameOver
	r.startRack(1)
	if r.shooter != 1 {
		t.Fatalf("B breaks the next rack: %d", r.shooter)
	}
	r.newMatch()
	r.seats[2] = seat{name: "Cat"}
	r.startRack(0)
	if r.shooter != 0 || r.next != [2]int{} {
		t.Fatalf("new match: shooter %d next %v", r.shooter, r.next)
	}
}

// TestTwoSeatRoomsStayAsTheyWere: in a room of two the seat is the side.
func TestTwoSeatRoomsStayAsTheyWere(t *testing.T) {
	h := New(fastOptions())
	settings := RoomSettings{}
	settings.fill(10)
	r := newRoom(h, "DUOS", settings)
	r.seats[0], r.seats[1] = seat{name: "Ann"}, seat{name: "Bob"}
	r.startRack(1)
	for _, sd := range []int{0, 1, 1, 0} {
		r.game.Rules.Turn = sd
		r.syncShooter()
		if r.turnSeat() != sd || r.actor() != sd || r.teammateErr(1-sd) != nil {
			t.Fatalf("side %d: seat %d", sd, r.turnSeat())
		}
	}
}
