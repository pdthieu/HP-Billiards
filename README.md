# Pool

Two-player online 8-ball (WPA rules) in Go: server-side physics and rules,
WebSocket protocol, plain HTML/JS client embedded in one binary.

- `internal/game` physics and rules (pure Go), `cmd/simulate` headless runner
- `internal/hub` rooms and the WebSocket endpoint, `internal/ws` connections
- `internal/protocol` the wire messages, documented in [docs/PROTOCOL.md](docs/PROTOCOL.md)
- `web` the client, documented in [docs/CLIENT.md](docs/CLIENT.md)
- what comes next: [docs/ROADMAP.md](docs/ROADMAP.md)

## Run locally

```sh
go run ./cmd/server -addr :8080
```

Open <http://localhost:8080>, keep or change the suggested name and *Create a
room*, then open the invite link (*Copy link*, or
`http://localhost:8080/?room=CODE`) in a second browser window and *Join*.
The landing page also lists the open rooms, so the second player can simply
pick the room there. Use a private window or another
browser for the second player: the seat token is kept per tab, so two normal
tabs of the same window work too, but a reloaded tab always goes back to its
own seat.

To play from a phone on the same Wi-Fi, use the machine's LAN address, for
example `http://192.168.1.20:8080/?room=CODE`.

`http://localhost:8080/debug.html` sends raw protocol messages and shows what
comes back.

### Timers

The defaults are production values; shorten them to try the edge cases:

```sh
go run ./cmd/server -hold 10s -abandon 30s -idle 1m
```

| flag | default | meaning |
|---|---|---|
| `-hold` | `60s` | a player drops out while the other is connected: how long their seat is held before the game is abandoned |
| `-abandon` | `5m` | both players gone: how long the game survives before it is cancelled and both seats freed |
| `-idle` | `10m` | no connected player: how long the room is kept |
| `-max-rooms` | `3` | how many rooms may exist at once |

Things to try: reload a tab mid-game (it rejoins its seat), close one tab and
watch the other see "offline" then, after `-hold`, the lobby; close both tabs,
reopen one link within `-abandon` (the game is still there), or after it (a
fresh lobby).

## Test

```sh
go vet ./... && go test -race ./...
```

The client has no automated tests in the repo; `go test ./web` only checks the
files are embedded.
