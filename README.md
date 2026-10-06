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

The gear in the header opens settings: theme (system, dark, light), a
left-handed power bar, and "show hints again". Fonts are embedded in the
binary, so nothing is fetched from the Internet at runtime. The design
handoff the UI follows lives in [design/](design/).

### Timers

The defaults are production values; shorten them to try the edge cases:

```sh
go run ./cmd/server -hold 10s -abandon 30s -idle 1m -shot-clock 12s
```

| flag | default | meaning |
|---|---|---|
| `-hold` | `60s` | a player drops out while the other is connected: how long their seat is held before the game is abandoned |
| `-abandon` | `5m` | both players gone: how long the game survives before it is cancelled and both seats freed |
| `-idle` | `10m` | no connected player: how long the room is kept |
| `-max-rooms` | `3` | how many rooms may exist at once |
| `-shot-clock` | `30s` | time for each shot or decision; `0` turns the shot clock off |
| `-shot-clock-long` | `40s` | time for the first shot after the break, and what a player's one extension per game resets their clock to |
| `-physics` | – | override a physics constant, `Name=value`, repeatable or comma-separated (e.g. `-physics CushionRestitution=0.8,RollingFriction=0.012`); `-physics list` prints every tunable with its default |

Things to try: reload a tab mid-game (it rejoins its seat), close one tab and
watch the other see "offline" then, after `-hold`, the lobby; close both tabs,
reopen one link within `-abandon` (the game is still there), or after it (a
fresh lobby); let the shot clock run out (the opponent gets ball in hand) or
press *+40s* / `X` to extend it once.

## Deploy

`Dockerfile` builds an 8 MB image; `deploy/docker-compose.yml` adds Caddy for
HTTPS; `render.yaml` is a one-click Render blueprint. The server listens on
`:$PORT` when PORT is set and answers `GET /healthz`. Step-by-step options,
including which free tiers still work, are in [docs/DEPLOY.md](docs/DEPLOY.md).

## Test

```sh
make test   # gofmt check, go vet, go test -race ./...
make e2e    # browser scenarios against a freshly built server
```

The browser scenarios live in `e2e/` (plain Node scripts on Playwright, no
test framework): `landing` (invite mode, name validation, room limit), `smoke`
(a full game between a desktop and a phone-sized client), `decision` (illegal
break dialog) and `reconnect` (seat hold, mid-shot rejoin, takeover).
`e2e/run.js` builds the server, starts two instances on free ports (one with
`-max-rooms 1`) and runs every scenario, or only the ones named:
`cd e2e && node run.js smoke`. Install the dependencies once with
`make e2e-deps` (Node 20+). Screenshots land in `e2e/shots/`. `e2e/motion.js`
is a measuring tool, not a test: it records on-screen ball speed frame by
frame and snapshot timing for a shot of the given power.

CI (`.github/workflows/ci.yml`) runs both on every push and pull request.

To keep build caches off a small system disk, point the tools elsewhere before
running anything (a `.envrc` with [direnv](https://direnv.net) is convenient):

```sh
export GOCACHE=/Volumes/HieuPhan/.cache/be-billiards/go-build
export GOMODCACHE=/Volumes/HieuPhan/.cache/be-billiards/go-mod
export PLAYWRIGHT_BROWSERS_PATH=/Volumes/HieuPhan/.cache/be-billiards/playwright
export npm_config_cache=/Volumes/HieuPhan/.cache/be-billiards/npm
```
