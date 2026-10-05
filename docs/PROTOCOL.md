# Protocol (v1)

Source of truth: `internal/protocol/protocol.go`. Keep this file in sync with it.

## Transport

- `POST /api/rooms` creates a room and answers `{"roomCode": "ABCDE"}`. Codes are 5 uppercase letters without `I` and `O`. At most 3 rooms exist at once (`-max-rooms`); beyond that the answer is `409 {"error": "room_limit", "message": "..."}`.
- `GET /api/rooms` lists the live rooms: `{"rooms": [{"roomCode": "ABCDE", "players": ["Ann", ""], "phase": "lobby", "seated": 1}], "max": 3}`. `players` are the seat names (`""` for an empty seat), `seated` counts taken seats including ones held for a reconnect; a room with `seated` < 2 can be joined. Sorted by code.
- `GET /ws` upgrades to a WebSocket. Every message is a JSON text frame holding an object with a `type` field. Inbound messages are limited to 4096 bytes.
- The first message on a socket must be `join`. Until a join succeeds, anything else is answered with `error` `not_joined`.

## Conventions

- **Units:** meters. The playing surface is 2.54 × 1.27, origin top-left, x along the long axis, y down. Ball radius is 0.028575.
- **Angles:** radians, 0 points along +x, positive turns toward +y (clockwise on screen).
- **Seats:** `0` and `1`.
- **Balls:** id `0` is the cue ball, `1`–`7` solids, `8` the 8-ball, `9`–`15` stripes. Ball lists contain only balls on the table, as `{id, x, y}`.
- **Pockets:** index `0` top-left, `1` top-middle, `2` top-right, `3` bottom-left, `4` bottom-middle, `5` bottom-right ("top" is y = 0). The table follows the WPA equipment specification: the surface is measured between the cushion noses; corner pockets are 4 9⁄16 in (0.1159 m) wide between noses that sit 0.0820 m from the corner along each rail, side pockets 5 1⁄16 in (0.1286 m) wide centred on the long rails. Jaws lead from the noses into the pocket at 142° (corner) and 104° (side); a ball drops once its centre is 1¾ in (corner) or ¼ in (side) past the mouth line. Ball centres can therefore be slightly outside the 2.54 × 1.27 rectangle while a ball is in a pocket mouth.
- **Head string:** x = 0.635. The kitchen is x ≤ 0.635.
- **Phases:** `lobby`, `breaking`, `open`, `assigned`, `game_over`.
- **Groups:** `""` (not assigned), `solids`, `stripes`.

## Client → server

| type | fields | notes |
|---|---|---|
| `join` | `roomCode`, `name`, `token?` | Takes a free seat. `name` is trimmed to 20 characters; empty becomes `Player N`. If `token` matches a seat of the room, that seat is reclaimed instead (see Reconnecting); otherwise it is ignored. |
| `ready` | – | Lobby only. The rack starts when both seated players are ready. |
| `aim` | `angle`, `power` | Shooter only, at most ~10 Hz. Relayed to the other player; silently dropped when it is not the sender's turn. |
| `shoot` | `angle`, `power`, `call?`, `spin?` | `power` is clamped to [0,1]. `call` is required on every shot except the break. `spin` is `{"x", "y"}`, the cue tip offset from the centre of the cue ball in units of the usable radius, clamped to the unit disc: `x` > 0 right english (as the shooter sees it), `y` > 0 top spin. Omitted means a centre hit. |
| `place_cue` | `x`, `y` | Only for the player to shoot while `ballInHand` is true. |
| `choose` | `option` | Answers a pending `decision`. |
| `rematch` | – | `game_over` only; either player. Starts a new rack, the break alternates. |
| `ping` | – | Allowed at any time, even before `join`. Answered with `pong`. |

`call` is `{"ball": 3}`, `{"ball": 3, "pocket": 4}` or `{"safety": true}`. Without `pocket` the called ball counts in whichever pocket it drops (the shipped client never sends a pocket).

- The called ball must be a legal target: on an open table any ball but the 8; once groups are assigned a ball of the shooter's group, or the 8-ball when that group is cleared. On an open table the 8-ball may be called once either group is completely pocketed.
- Balls slide, then roll: a ball keeps 5⁄7 of its speed once cloth friction has matched its spin to its velocity, and only then slows gently under rolling friction. Top/bottom spin sets the cue ball's initial roll, so follow and draw come out of the same model (a cue ball with draw slides on its back spin and comes back after a full hit; the longer the shot, the less draw is left). A cushion scrubs off the spin along its normal, which is why a rolling ball dies after a rail. Side spin kicks the cue ball sideways when it rebounds off a cushion (right english → toward the shooter's right) and halves at each cushion; it fades with the distance rolled. There is no squirt, swerve or throw.
- The shooter keeps the turn only if the called ball drops (into the called pocket, if one was called) on a shot without a foul. After a safety the turn always passes.

`option` values:

| option | offered when | effect |
|---|---|---|
| `accept_table` | illegal break | Chooser plays the balls where they lie. |
| `rerack_break` | illegal break | Re-rack; the chooser breaks. |
| `rerack_opponent_breaks` | illegal break | Re-rack; the offender breaks again. |
| `spot_eight` | 8-ball pocketed on the break | 8-ball goes back on the foot spot; play continues. |
| `rebreak` | 8-ball pocketed on the break | Re-rack; the chooser breaks. |

## Server → client

### `welcome`

`{type, v, playerId, seat, token, roomCode}` — answers a successful `join`. `v` is the protocol version (1). `token` is a 128-bit secret for this seat; keep it to reconnect.

### `room_state`

Full state. Sent right after `welcome`, and to both players whenever the state changes other than by a shot settling (game start, `place_cue`, `choose`, `rematch`, a player leaving mid-game).

```json
{
  "type": "room_state",
  "balls": [{"id": 0, "x": 0.635, "y": 0.635}],
  "players": [
    {"seat": 0, "name": "Ann", "connected": true, "ready": true},
    {"seat": 1, "name": "", "connected": false, "ready": false}
  ],
  "phase": "breaking",
  "turn": 0,
  "groups": ["", ""],
  "ballInHand": true,
  "kitchen": true,
  "decision": null,
  "winner": null,
  "moving": false
}
```

- `players[].connected` false with a non-empty `name` is a seat held for a player who dropped out (see Reconnecting); `name` `""` is an empty seat.
- `ballInHand`: the player in `turn` may send `place_cue`. `kitchen`: placement is limited to x ≤ 0.635 (break, and after a foul on the break).
- `decision`: `null`, or `{"seat": 1, "options": ["accept_table", "rerack_break", "rerack_opponent_breaks"]}`. No shot is accepted until that seat sends `choose`.
- `winner`: seat or `null`.
- `moving`: a shot is in progress; `snapshot`s and a `settled` will follow.

### `snapshot`

`{type, t, balls}` — sent when a shot starts (`t` = 0) and then at 20 Hz while balls move. `t` is simulated milliseconds since the shot; positions are rounded to 4 decimals (0.1 mm). Clients interpolate between snapshots.

### `settled`

Ends a shot. Positions are exact; clients snap to them.

```json
{
  "type": "settled",
  "balls": [{"id": 0, "x": 1.2034, "y": 0.4127}],
  "shooter": 0,
  "pocketed": [3],
  "foul": "scratch",
  "calledMade": true,
  "illegalBreak": false,
  "phase": "open",
  "turn": 1,
  "groups": ["", ""],
  "ballInHand": true,
  "kitchen": false,
  "decision": null,
  "winner": 1
}
```

- `pocketed`: ids pocketed by this shot, in order; includes `0` for a scratch.
- `foul`: omitted for a legal shot, otherwise `scratch`, `no_contact`, `wrong_ball`, `kitchen` (cue ball in hand above the head string hit a ball there without crossing the head string first) or `no_rail` (nothing pocketed and no ball reached a rail after contact).
- `calledMade`: the called ball dropped (into the called pocket, if one was called).
- `illegalBreak`: break that pocketed nothing and drove fewer than four object balls to a rail; a `decision` for the opponent follows.
- `winner`: present only when the game is over.
- After a scratch the cue ball is back on the table (head spot by default) and the opponent has ball in hand.

### `aim`

`{type, seat, angle, power}` — the other player's aim preview.

### `player`

`{type, seat, name, connected, ready}` — a seat changed: someone joined, became ready, dropped out (`name` kept, `connected` false), came back (`connected` true again) or left for good (`name` `""`, `connected` false). When a seat is emptied during a game the game is abandoned and a `room_state` with phase `lobby` follows.

### `pong`

`{type}` — answers a `ping`.

### `error`

`{type, code, message}`. The rejected message had no effect.

| code | meaning |
|---|---|
| `bad_message` | Not JSON, no `type`, unknown `type`, or `join` when already joined. |
| `not_joined` | A message other than `join` before joining. |
| `room_not_found` | Unknown room code. |
| `room_full` | Both seats are taken. |
| `wrong_phase` | Not allowed in the current phase, or a decision is pending. |
| `balls_moving` | A shot is still in progress. |
| `not_your_turn` | It is the other player's turn or decision. |
| `no_ball_in_hand` | `place_cue` without ball in hand. |
| `bad_placement` | `place_cue` off the table, in a pocket, on another ball, or outside the kitchen while `kitchen` is true. |
| `bad_input` | `angle` or `power` is not a finite number. |
| `bad_call` | `shoot` without a legal `call` (illegal ball, or a `pocket` outside 0–5). |
| `no_decision` | `choose` with nothing to decide. |
| `bad_option` | `choose` with an option that was not offered. |

## Reconnecting

- When a socket closes **in the lobby**, its seat is freed immediately.
- When a socket closes **during a game** (any phase but `lobby`), the seat is held: the other player gets `player` with `connected` false and the name kept, the game state is untouched, and a third player is refused with `room_full`. A shot in progress keeps running; the absent player simply misses the snapshots and `settled`.
- How long a seat is held depends on who is still there, and is re-evaluated at every connect or disconnect during the game:
  - **One player connected**: the absent player's seat is held for 60 seconds (`-hold`), counted from the moment they became the only absent one.
  - **Nobody connected**: nobody is waiting, so the game survives 5 minutes (`-abandon`). If one player returns in that time the game continues and the other's 60 seconds start then. Otherwise the game is cancelled and both seats are freed; a later `join` with an old token is a plain join into the lobby (if the room still exists).
- `join` with the seat's `token` reclaims it at any time while it is held, **and also while its old socket is still open** (a phone that changed networks reconnects long before the dead socket is noticed). The old socket is closed with status 1008 and reason `replaced by a new connection`. The reconnecting client gets `welcome` (same `seat`, `playerId` and `token`; `name` in the join is ignored) and a fresh `room_state`; the other player gets `player` with `connected` true.
- If a single hold expires the seat is emptied (`player` with `name` `""`) and the game is abandoned (`room_state` with phase `lobby`).
- A `join` whose `token` matches nothing is treated as a plain join.

## Keepalive

- The server sends a WebSocket ping every 20 seconds and closes connections whose pong does not arrive within 10 seconds (status 1001, reason `ping timeout`). Browsers answer pings on their own.
- A client that wants to detect a dead connection itself sends `ping` and expects `pong`.

## Lifetime

- A room with no connected player for 10 minutes (`-idle`) is deleted. Held seats do not count as connected.
- Each client has an outbound queue of 32 messages. When it is full, the oldest queued `snapshot` or `aim` is discarded to make room (the next one supersedes it). If none can be discarded the client is disconnected with status 1008 and reason `outbound buffer full`.
