# Protocol (v1)

Source of truth: `internal/protocol/protocol.go`. Keep this file in sync with it.

## Transport

- `POST /api/rooms` creates a room and answers `{"roomCode": "ABCDE"}`. Codes are 5 uppercase letters without `I` and `O`.
- `GET /ws` upgrades to a WebSocket. Every message is a JSON text frame holding an object with a `type` field. Inbound messages are limited to 4096 bytes.
- The first message on a socket must be `join`. Until a join succeeds, anything else is answered with `error` `not_joined`.

## Conventions

- **Units:** meters. The playing surface is 2.54 × 1.27, origin top-left, x along the long axis, y down. Ball radius is 0.028575.
- **Angles:** radians, 0 points along +x, positive turns toward +y (clockwise on screen).
- **Seats:** `0` and `1`.
- **Balls:** id `0` is the cue ball, `1`–`7` solids, `8` the 8-ball, `9`–`15` stripes. Ball lists contain only balls on the table, as `{id, x, y}`.
- **Pockets:** index `0` top-left, `1` top-middle, `2` top-right, `3` bottom-left, `4` bottom-middle, `5` bottom-right ("top" is y = 0).
- **Head string:** x = 0.635. The kitchen is x ≤ 0.635.
- **Phases:** `lobby`, `breaking`, `open`, `assigned`, `game_over`.
- **Groups:** `""` (not assigned), `solids`, `stripes`.

## Client → server

| type | fields | notes |
|---|---|---|
| `join` | `roomCode`, `name`, `token?` | Takes a free seat. `name` is trimmed to 20 characters; empty becomes `Player N`. `token` is reserved for reconnecting. |
| `ready` | – | Lobby only. The rack starts when both seated players are ready. |
| `aim` | `angle`, `power` | Shooter only, at most ~10 Hz. Relayed to the other player; silently dropped when it is not the sender's turn. |
| `shoot` | `angle`, `power`, `call?` | `power` is clamped to [0,1]. `call` is required on every shot except the break. |
| `place_cue` | `x`, `y` | Only for the player to shoot while `ballInHand` is true. |
| `choose` | `option` | Answers a pending `decision`. |
| `rematch` | – | `game_over` only; either player. Starts a new rack, the break alternates. |

`call` is either `{"ball": 3, "pocket": 4}` or `{"safety": true}`.

- The called ball must be a legal target: on an open table any ball but the 8; once groups are assigned a ball of the shooter's group, or the 8-ball when that group is cleared. On an open table the 8-ball may be called once either group is completely pocketed.
- The shooter keeps the turn only if the called ball drops into the called pocket on a shot without a foul. After a safety the turn always passes.

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

`{type, v, playerId, seat, token, roomCode}` — answers a successful `join`. `v` is the protocol version (1). `token` is a 128-bit secret for this seat.

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

- `ballInHand`: the player in `turn` may send `place_cue`. `kitchen`: placement is limited to x ≤ 0.635 (break, and after a foul on the break).
- `decision`: `null`, or `{"seat": 1, "options": ["accept_table", "rerack_break", "rerack_opponent_breaks"]}`. No shot is accepted until that seat sends `choose`.
- `winner`: seat or `null`.
- `moving`: a shot is in progress; `snapshot`s and a `settled` will follow.

### `snapshot`

`{type, t, balls}` — sent when a shot starts (`t` = 0) and then at 20 Hz while balls move. `t` is simulated milliseconds since the shot; positions are rounded to 3 decimals. Clients interpolate between snapshots.

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
- `calledMade`: the called ball went into the called pocket.
- `illegalBreak`: break that pocketed nothing and drove fewer than four object balls to a rail; a `decision` for the opponent follows.
- `winner`: present only when the game is over.
- After a scratch the cue ball is back on the table (head spot by default) and the opponent has ball in hand.

### `aim`

`{type, seat, angle, power}` — the other player's aim preview.

### `player`

`{type, seat, name, connected, ready}` — a seat changed: someone joined, became ready, or left (`name` `""`, `connected` false). If a player leaves during a game the game is abandoned and a `room_state` with phase `lobby` follows.

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
| `bad_call` | `shoot` without a legal `call`. |
| `no_decision` | `choose` with nothing to decide. |
| `bad_option` | `choose` with an option that was not offered. |

## Lifetime

- A room with no connected player for 10 minutes is deleted.
- When a socket closes, its seat is freed immediately. (Reconnecting to a seat with `token` is not implemented yet.)
- A client whose outbound buffer (32 messages) overflows is disconnected.
