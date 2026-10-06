# Protocol (v1)

Source of truth: `internal/protocol/protocol.go`. Keep this file in sync with it.

## Transport

- `POST /api/rooms` creates a room and answers `{"roomCode": "ABCDE"}`. An optional JSON body `{"mode": "9ball"}` picks the game (`8ball`, the default, or `9ball`); an unknown mode answers `400 {"error": "bad_mode", ...}`. Codes are 5 uppercase letters without `I` and `O`. At most 3 rooms exist at once (`-max-rooms`); beyond that the answer is `409 {"error": "room_limit", "message": "..."}`.
- `GET /api/rooms` lists the live rooms: `{"rooms": [{"roomCode": "ABCDE", "mode": "8ball", "players": ["Ann", ""], "phase": "lobby", "seated": 1}], "max": 3}`. `players` are the seat names (`""` for an empty seat), `seated` counts taken seats including ones held for a reconnect; a room with `seated` < 2 can be joined. Sorted by code.
- `GET /ws` upgrades to a WebSocket. Every message is a JSON text frame holding an object with a `type` field. Inbound messages are limited to 4096 bytes.
- The first message on a socket must be `join`. Until a join succeeds, anything else is answered with `error` `not_joined`.

## Conventions

- **Units:** meters. The playing surface is 2.54 × 1.27, origin top-left, x along the long axis, y down. Ball radius is 0.028575.
- **Angles:** radians, 0 points along +x, positive turns toward +y (clockwise on screen).
- **Seats:** `0` and `1`.
- **Balls:** id `0` is the cue ball, `1`–`7` solids, `8` the 8-ball, `9`–`15` stripes. A 9-ball rack has only `1`–`9`. Ball lists contain only balls on the table, as `{id, x, y}`.
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
| `shoot` | `angle`, `power`, `call?`, `spin?` | `power` is clamped to [0,1]. `call` is optional; in 8-ball it is required, with a pocket, when the 8-ball is the shooter's legal target; in 9-ball it is only `{"pushOut": true}` (see 9-ball). `spin` is `{"x", "y"}`, the cue tip offset from the centre of the cue ball in units of the usable radius, clamped to the unit disc: `x` > 0 right english (as the shooter sees it), `y` > 0 top spin. Omitted means a centre hit. |
| `place_cue` | `x`, `y` | Only for the player to shoot while `ballInHand` is true. |
| `choose` | `option` | Answers a pending `decision`. |
| `rematch` | – | `game_over` only; either player. Starts a new rack, the break alternates. |
| `extend` | – | Only for the player the shot clock is running for, once per game: their clock is set back to the long limit (see Shot clock). |
| `set_mode` | `mode` | `lobby` or `game_over` only; either player. Changes the room's game (`8ball` or `9ball`) for the next rack; in the lobby both players must press ready again. Both get a `room_state`. |
| `ping` | – | Allowed at any time, even before `join`. Answered with `pong`. |

The rules below are 8-ball; see 9-ball for the other game. `call` is `{"pocket": 4}` or `{"safety": true}`. Object balls are not called (a house-rule relaxation of WPA 1.7): any ball of the shooter's group that drops counts, and on an open table the first object ball legally pocketed decides the groups. The 8-ball must go into the called pocket.

- The first ball the cue ball touches must still be a legal target: on an open table any ball but the 8; once groups are assigned a ball of the shooter's group, or the 8-ball when that group is cleared. On an open table the 8-ball becomes the target once either group is completely pocketed.
- A shooter whose target is the 8-ball must send a `pocket` (0–5) unless the shot is a safety; otherwise the shot is refused with `bad_call`. A pocket sent on any other shot is ignored.
- The shooter keeps the turn if a ball that counts for them drops on a shot without a foul. After a safety the turn always passes and whatever dropped stays down.
- Pocketing the 8-ball wins only when it was the shooter's legal target, it dropped in the called pocket and the shot was not a foul and not a safety; in every other case it loses the game.
- Balls slide, then roll: a ball keeps 5⁄7 of its speed once cloth friction has matched its spin to its velocity, and only then slows gently under rolling friction. Top/bottom spin sets the cue ball's initial roll, so follow and draw come out of the same model (a cue ball with draw slides on its back spin and comes back after a full hit; the longer the shot, the less draw is left). Cushions rebound the normal speed with a restitution of 0.78 that falls off for hard hits (a rolling ball comes back with about half its speed), and their nose has friction: it scrubs off the roll into the rail (a rolling ball dies after a rail), takes speed off an oblique rebound, and turns side spin into a throw along the rail (right english → toward the shooter's right), spending part of the spin. Side spin otherwise fades with the distance rolled. There is no squirt, swerve or throw off object balls.

`option` values:

| option | offered when | effect |
|---|---|---|
| `accept_table` | illegal break | Chooser plays the balls where they lie. |
| `rerack_break` | illegal break | Re-rack; the chooser breaks. |
| `rerack_opponent_breaks` | illegal break | Re-rack; the offender breaks again. |
| `spot_eight` | 8-ball pocketed on the break | 8-ball goes back on the foot spot; play continues. |
| `rebreak` | 8-ball pocketed on the break | Re-rack; the chooser breaks. |
| `take_shot` | 9-ball push out | The chooser shoots from where the balls lie. |
| `pass_back` | 9-ball push out | The player who pushed out shoots again. |

## 9-ball

WPA section 5. Balls `1`–`9` are racked in a diamond with the 1 on the foot spot and the 9 in the centre; phases are `breaking`, then `open` for the rest of the rack (`groups` stay empty).

- The cue ball must first hit the lowest-numbered ball on the table, the 1 on the break. Any ball pocketed on a legal shot keeps the turn; nothing is called and there is no safety.
- The 9-ball pocketed on a legal shot wins, also on the break or by combination. Pocketed on a foul or a push out, it goes back on the foot spot (`settled` lists it in `pocketed`, and it reappears in `balls`).
- A break must pocket a ball or drive at least four object balls to a rail; otherwise it is a foul `bad_break` (with `illegalBreak` true). There is no re-rack choice.
- Fouls (`scratch`, `no_contact`, `wrong_ball`, `no_rail`, `bad_break`, and running out of time) give the opponent ball in hand anywhere. Balls pocketed on a foul stay down, except the 9.
- **Push out:** the shot right after the break, whoever takes it, may be sent with `call: {"pushOut": true}` while `pushOut` is true. It needs no contact and no rail; a scratch is still a foul. Balls it pockets stay down (the 9 is spotted). The opponent then gets a `decision` with `take_shot` and `pass_back`. A push out at any other time is refused with `bad_call`.
- **Three fouls:** `fouls[seat]` counts each player's consecutive fouls, reset by a legal shot. The third in a row loses the rack. Time fouls count, except on the break, where the opponent simply breaks instead.

## Server → client

### `welcome`

`{type, v, playerId, seat, token, roomCode, aimLine}` — answers a successful `join`. `v` is the protocol version (1). `token` is a 128-bit secret for this seat; keep it to reconnect. `aimLine` is how long, in millimetres, the client draws the object ball's path after contact in the aim guide (100 by default, `-aim-line` / `AIM_LINE_MM`); `0` means the guide stops at the ghost ball.

### `room_state`

Full state. Sent right after `welcome`, and to both players whenever the state changes other than by a shot settling (game start, `place_cue`, `choose`, `rematch`, a `timeout`, a player leaving mid-game).

```json
{
  "type": "room_state",
  "mode": "8ball",
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
  "moving": false,
  "clock": {"seat": 0, "left": 29450, "limit": 30000, "paused": false, "extension": 40000, "extensions": [true, true]}
}
```

- `players[].connected` false with a non-empty `name` is a seat held for a player who dropped out (see Reconnecting); `name` `""` is an empty seat.
- `ballInHand`: the player in `turn` may send `place_cue`. `kitchen`: placement is limited to x ≤ 0.635 (break, and after a foul on the break).
- `decision`: `null`, or `{"seat": 1, "options": ["accept_table", "rerack_break", "rerack_opponent_breaks"]}`. No shot is accepted until that seat sends `choose`.
- `winner`: seat or `null`.
- `moving`: a shot is in progress; `snapshot`s and a `settled` will follow.
- `mode`: `8ball` or `9ball`.
- `fouls`: 9-ball consecutive fouls by seat (always `[0, 0]` in 8-ball). `pushOut`: 9-ball, the player in `turn` may push out on this shot.
- `clock`: the shot clock of the player who must act next (shoot, or answer the `decision`), or `null` while nobody has to (lobby, game over, balls moving, clock turned off). `left` is milliseconds left when the message was sent: count down from its arrival rather than comparing clocks. `limit` is what the clock was last set to, `paused` is true while that player is offline, `extension` is what an `extend` sets the clock to and `extensions[seat]` whether that seat may still extend.

### `snapshot`

`{type, t, balls}` — sent when a shot starts (`t` = 0), then at 20 Hz while balls move, plus one at the moment of the first bounce (ball or cushion) inside any 60 Hz server tick, so that interpolating clients do not cut the corner of a bounce. `t` is simulated milliseconds since the shot, strictly increasing but not evenly spaced; positions are rounded to 4 decimals (0.1 mm). Clients interpolate between snapshots.

### `settled`

Ends a shot. Positions are exact; clients snap to them.

```json
{
  "type": "settled",
  "balls": [{"id": 0, "x": 1.2034, "y": 0.4127}],
  "shooter": 0,
  "pocketed": [3],
  "foul": "scratch",
  "made": true,
  "illegalBreak": false,
  "phase": "open",
  "turn": 1,
  "groups": ["", ""],
  "ballInHand": true,
  "kitchen": false,
  "decision": null,
  "winner": 1,
  "clock": null
}
```

- `pocketed`: ids pocketed by this shot, in order; includes `0` for a scratch.
- `foul`: omitted for a legal shot, otherwise `scratch`, `no_contact`, `wrong_ball`, `kitchen` (cue ball in hand above the head string hit a ball there without crossing the head string first) or `no_rail` (nothing pocketed and no ball reached a rail after contact).
- `made`: a ball that counts for the shooter dropped: one of their group, any object ball on an open table, or the 8-ball in its called pocket.
- `illegalBreak`: break that pocketed nothing and drove fewer than four object balls to a rail; in 8-ball a `decision` for the opponent follows, in 9-ball it is the foul `bad_break`.
- `pushedOut`: 9-ball, this shot was a push out. `fouls` and `pushOut` as in `room_state`.
- `winner`: present only when the game is over.
- `clock`: as in `room_state`, started for whoever acts next.
- After a scratch the cue ball is back on the table (head spot by default) and the opponent has ball in hand.

### `aim`

`{type, seat, angle, power}` — the other player's aim preview.

### `player`

`{type, seat, name, connected, ready}` — a seat changed: someone joined, became ready, dropped out (`name` kept, `connected` false), came back (`connected` true again) or left for good (`name` `""`, `connected` false). When a seat is emptied during a game the game is abandoned and a `room_state` with phase `lobby` follows.

### `clock`

`{type, seat, left, limit, paused, extension, extensions}` — the running clock changed outside a `room_state` or `settled`: a player used their extension, or the player it counts for dropped out (`paused` true) or came back. Fields as in `room_state.clock`.

### `timeout`

`{type, seat, option?}` — `seat` let the shot clock run out. Without `option` it was a shot: a foul, the opponent has ball in hand (or, on the break, breaks instead). With `option` it was a decision, and that option was chosen for them. A `room_state` with the new turn and clock follows.

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
| `bad_call` | `shoot` at the 8-ball without a `pocket`, a `pocket` outside 0–5, or a 9-ball push out that is not allowed. |
| `bad_mode` | `set_mode` with a mode other than `8ball` or `9ball`. |
| `no_decision` | `choose` with nothing to decide. |
| `bad_option` | `choose` with an option that was not offered. |
| `no_extension` | `extend` after the sender already used their extension this game. |

## Shot clock

The player who must act has 30 seconds (`-shot-clock`) for each shot, ball-in-hand placement included, and for each post-break decision. The first shot after the break gets 40 seconds (`-shot-clock-long`), whoever takes it, and also when a decision leads to playing on.

- Each player has one extension per game: `extend` sets their running clock back to 40 seconds. Rematches give a new one.
- The clock stops while balls move and restarts for whoever acts next when the shot settles.
- It runs only while the player it counts for is connected. A dropped connection pauses it with the time left; it resumes on reconnect. The seat hold (see below) is what limits an absence.
- When it runs out (`timeout`):
  - on a shot: a standard foul, and the opponent gets ball in hand anywhere;
  - on the break: nothing has moved, so the opponent breaks instead, with ball in hand in the kitchen;
  - on a decision: its first option is taken (`accept_table`, `spot_eight` or `take_shot`, i.e. play on from the table as it lies).
- `-shot-clock 0` turns the clock off; `clock` is then always `null` and `extend` fails with `wrong_phase`.

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
