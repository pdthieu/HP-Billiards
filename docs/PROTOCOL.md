# Protocol (v1)

Source of truth: `internal/protocol/protocol.go`. Keep this file in sync with it.

## Transport

- `POST /api/rooms` creates a room and answers `{"roomCode": "ABCDE"}`. An optional JSON body `{"mode": "9ball", "race": 5, "breaks": "winner", "spectators": 3, "table": "predator", "cloth": "electric-blue", "practice": false}` picks the game (`8ball`, the default, `9ball` or `3cushion`), the race of its matches (1–25, default 1; in 3-cushion the points of the game, 1–50, default 15), who breaks after the first rack (`alternate`, the default, or `winner`; see Matches), how many spectators may watch (0 to the server's `-max-spectators`, 10 by default; default 3; see Spectators and chat), the table and its cloth (see Tables; default `diamond` and `tournament-blue`), or, with `practice`, makes a practice room (see Practice). An unknown mode answers `400 {"error": "bad_mode", ...}`, a bad race or break rule `400 {"error": "bad_race", ...}`, a bad number of spectators `400 {"error": "bad_spectators", ...}`, an unknown table or cloth `400 {"error": "bad_table", ...}`. Codes are 5 uppercase letters without `I` and `O`. At most 3 rooms exist at once (`-max-rooms`); beyond that the answer is `409 {"error": "room_limit", "message": "..."}`.
- `GET /api/rooms` lists the live rooms: `{"rooms": [{"roomCode": "ABCDE", "mode": "8ball", "table": "diamond", "cloth": "tournament-blue", "players": ["Ann", ""], "phase": "lobby", "seated": 1}], "used": 1, "max": 3}`. Practice rooms are not listed but count in `used`, the number of live rooms. `players` are the seat names (`""` for an empty seat), `seated` counts taken seats including ones held for a reconnect; a room with `seated` < 2 can be joined. `spectators` counts who watches and `maxSpectators` how many may; one more can watch while `spectators` < `maxSpectators`. Sorted by code.
- `GET /ws` upgrades to a WebSocket. Every message is a JSON text frame holding an object with a `type` field. Inbound messages are limited to 4096 bytes.
- The first message on a socket must be `join`. Until a join succeeds, anything else is answered with `error` `not_joined`.

## Conventions

- **Units:** meters. The playing surface is 2.54 × 1.27, origin top-left, x along the long axis, y down. Ball radius is 0.028575.
- **Angles:** radians, 0 points along +x, positive turns toward +y (clockwise on screen).
- **Seats:** `0` and `1`.
- **Balls:** id `0` is the cue ball, `1`–`7` solids, `8` the 8-ball, `9`–`15` stripes. A 9-ball rack has only `1`–`9`. 3-cushion has three: `0` the white, `1` the yellow, `2` the red. Ball lists contain only balls on the table, as `{id, x, y}`.
- **Pockets:** index `0` top-left, `1` top-middle, `2` top-right, `3` bottom-left, `4` bottom-middle, `5` bottom-right ("top" is y = 0). The table follows the WPA equipment specification: the surface is measured between the cushion noses; corner pockets are 4 9⁄16 in (0.1159 m) wide between noses that sit 0.0820 m from the corner along each rail, side pockets 5 1⁄16 in (0.1286 m) wide centred on the long rails. Jaws lead from the noses into the pocket at 142° (corner) and 104° (side); a ball drops once its centre is 1¾ in (corner) or ¼ in (side) past the mouth line. Ball centres can therefore be slightly outside the 2.54 × 1.27 rectangle while a ball is in a pocket mouth.
- **Head string:** x = 0.635. The kitchen is x ≤ 0.635.
- **Phases:** `lobby`, `breaking`, `open`, `assigned`, `game_over`.
- **Groups:** `""` (not assigned), `solids`, `stripes`.

## Client → server

| type | fields | notes |
|---|---|---|
| `join` | `roomCode`, `name`, `token?`, `watch?` | Takes a free seat. `name` is trimmed to 20 characters; empty becomes `Player N`. If `token` matches a seat of the room, that seat is reclaimed instead (see Reconnecting); otherwise it is ignored. With `watch` true the client watches instead (see Spectators and chat). |
| `ready` | – | Lobby only. The rack starts when both seated players are ready. |
| `aim` | `angle`, `power`, `elevation?` | Shooter only, at most ~10 Hz. Relayed to the other player; silently dropped when it is not the sender's turn. |
| `shoot` | `angle`, `power`, `call?`, `spin?`, `elevation?` | `power` is clamped to [0,1]. `call` is optional; in 8-ball it is required, with a pocket, when the 8-ball is the shooter's legal target; in 9-ball it is only `{"pushOut": true}` (see 9-ball). `spin` is `{"x", "y"}`, the cue tip offset from the centre of the cue ball in units of the usable radius, clamped to the unit disc: `x` > 0 right english (as the shooter sees it), `y` > 0 top spin. Omitted means a centre hit. `elevation` is how far the butt of the cue is raised, in radians above the horizontal, clamped to [0, 85°]; omitted or 0 is a level cue (see Jump shots and Massé). |
| `place_cue` | `x`, `y` | Only for the player to shoot while `ballInHand` is true. |
| `choose` | `option` | Answers a pending `decision`. |
| `rematch` | – | `game_over` only; either player. Starts the next rack of the match, or a new match once it is won (see Matches). |
| `extend` | – | Only for the player the shot clock is running for, once per game: their clock is set back to the long limit (see Shot clock). |
| `place_ball` | `id`, `x`, `y` | Practice only: moves a ball on the table, the cue ball included, wherever it fits. |
| `undo` | – | Practice only: puts the table, turn and rules back as they were before the last shot (up to 20 shots). |
| `rerack` | `mode?` | Practice only: a fresh rack, of `mode` if given. |
| `set_mode` | `mode` | Between matches only (`lobby`, or `game_over` once the match is won); either player. Changes the room's game (`8ball`, `9ball` or `3cushion`); in the lobby both players must press ready again. Between pool and 3-cushion the race goes back to the new game's default (1 rack, 15 points): racks are not points. Both get a `room_state`. |
| `set_match` | `race?`, `breaks?` | Between matches only, as `set_mode`. Sets the race (1–25; 3-cushion: points, 1–50) and the break rule of the next match; a field left out (or 0, `""`) is kept. Both get a `room_state`. |
| `set_table` | `table?`, `cloth?` | Between matches only, as `set_mode`; in a practice room whenever no shot runs. Changes the table and its cloth (see Tables); a field left out (or `""`) is kept. A new table is racked at once: in the lobby both players must press ready again, in practice it is a fresh rack. A new cloth changes nothing else. Everyone gets a `room_state`. |
| `leave` | – | Gives up the seat at once. During a match it forfeits the match (see Matches). The server closes the socket (1000, `left the room`). |
| `chat` | `text` | Anyone in the room, players and spectators: a comment of 1–200 characters (whitespace collapsed), relayed to everyone as `chat`. At most one per sender every 5 seconds (`-chat-cooldown`). |
| `set_audience` | `spectators` | Players only, at any time: how many spectators may watch, 0 to the server's limit. Lowering it sends nobody away. Everyone gets `audience`. |
| `ping` | – | Allowed at any time, even before `join`. Answered with `pong`. |

The rules below are 8-ball; see 9-ball for the other game. `call` is `{"pocket": 4}` or `{"safety": true}`. Object balls are not called (a house-rule relaxation of WPA 1.7): any ball of the shooter's group that drops counts, and on an open table the first object ball legally pocketed decides the groups. The 8-ball must go into the called pocket.

- The first ball the cue ball touches must still be a legal target: on an open table any ball but the 8; once groups are assigned a ball of the shooter's group, or the 8-ball when that group is cleared. On an open table the 8-ball becomes the target once either group is completely pocketed.
- A shooter whose target is the 8-ball must send a `pocket` (0–5) unless the shot is a safety; otherwise the shot is refused with `bad_call`. A pocket sent on any other shot is ignored.
- The shooter keeps the turn if a ball that counts for them drops on a shot without a foul. After a safety the turn always passes and whatever dropped stays down.
- Pocketing the 8-ball wins only when it was the shooter's legal target, it dropped in the called pocket and the shot was not a foul and not a safety; in every other case it loses the game.
- Balls slide, then roll: a ball keeps 5⁄7 of its speed once cloth friction has matched its spin to its velocity, and only then slows gently under rolling friction. Top/bottom spin sets the cue ball's initial roll, so follow and draw come out of the same model (a cue ball with draw slides on its back spin and comes back after a full hit; the longer the shot, the less draw is left). Cushions rebound the normal speed with a restitution of 0.78 that falls off for hard hits (a rolling ball comes back with about half its speed), and their nose has friction: it scrubs off the roll into the rail (a rolling ball dies after a rail), takes speed off an oblique rebound, and turns side spin into a throw along the rail (right english → toward the shooter's right), spending part of the spin. Side spin otherwise fades with the distance rolled. There is no squirt or throw off object balls; a raised cue with english curves the cue ball (see Massé).
- Jump shots and massés: see below.

## Jump shots

A shot with an `elevation` drives the cue ball along the cue, partly down into the slate. That part bounces it up with half its speed (the slate's restitution, `SlateRestitution`), the rest carries it forward, and the cloth's friction during the bounce turns some of the forward speed into roll. At 45° and half power the cue ball rises about 10 cm and comes down some 60 cm on.

- A ball in the air flies free of the cloth under gravity, keeps its spin and bounces each time it comes down, lower every time, until it rolls.
- It passes over balls it is clear of. Balls meet in three dimensions: one that comes down on another drives that ball into the slate, which bounces it, and goes back up itself.
- A ball lower than the cushion nose (63.5 % of a ball's height) bounces off the cushions as usual; a higher one flies over them and leaves the table (`BallOffTable`, `offTable` in `settled`) once it is lower than the nose again, on the rail or past it. A ball in the air drops into a pocket whose hole it is over (no more than a mouth's width past the shelf) once it is lower than a ball's height; further out it has flown over the pocket and is off the table like any other.
- A ball off the table is a foul, `off_table`, whatever else happened. The cue ball comes back as after a scratch. An object ball stays off (it counts as down), except: the 8-ball, which loses the game (`end` `eight_off`), but on the break is spotted; and the 9-ball, which is spotted. In practice a ball off the table stays off, and a cue ball comes back on the head spot.

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


## Massé

The tip offset in `spin` is taken square to the cue, so on a raised cue it tilts with it. Top and bottom spin still turn the cue ball about the horizontal axis across the shot (with the cue's full speed, not only the part along the table). English turns it about the cue's own axis: the upright part of that is side spin as on a level cue, and the part along the shot rolls the ball sideways. The cloth's friction on that sideways slip curves the cue ball, along a parabola, toward the side the tip struck (right english → to the shooter's right) until it rolls, and it then runs straight. The steeper the cue and the more english, the sharper the curve: at 80° with full right english and 40 % power the cue ball turns about 70° and goes round a ball 15 cm in front of it.

- Past 60° the cue stands over the cue ball and its follow-through keeps it down: the bounce off the strike shrinks in proportion, to nothing at 90°. A full-power massé at 85° hops about 2 cm.
- A level cue's english does not curve the ball.
## Practice

A practice room (`POST /api/rooms` with `"practice": true`) is private: it is not in the room list and a second `join` gets `room_full` (the player's own token still reconnects). It is free play, without the rules of the game; the game (`mode`) only decides the rack.

- The rack starts as soon as the player joins. There is no lobby, no ready and no shot clock: `clock` is always `null`, and `extend` fails with `wrong_phase`.
- `phase` stays `open` and `turn` stays 0. There are:
  - no fouls, no ball in hand and no kitchen;
  - no calls (a `call` sent is ignored) and no push out;
  - no `decision`, no `winner` and no `game_over`.
- Every ball that drops stays down (`pocketed` in `settled`). A cue ball that drops is put back on the head spot.
- `place_cue` works at any time between shots and anywhere on the table; `place_ball` moves any other ball. `players[1]` mirrors `players[0]`.
- `undo` takes back the last shot (`undos` in `room_state` and `settled` says how many can be); `rerack` starts a new rack, of `mode` if given, and clears that history.
- `place_ball`, `undo` and `rerack` in any other room fail with `not_practice`; `undo` with nothing to take back fails with `no_undo`.

## Matches

Two players play a match: the first to win `race` racks wins it. A race of 1 is one rack per match. A 3-cushion match is one game to `race` points (see 3-cushion): `score` is the points, and `racks` holds the game once it is over, with `winner` -1 for a draw.

- The first rack of a room's first match is broken by a random player. After that:
  - `alternate`: the player who did not break the last rack breaks;
  - `winner`: the winner of the last rack breaks.
- The first rack of a new match is broken by the player who did not break the first rack of the previous one.
- When a rack ends (`phase` `game_over`), it is added to `match.racks` and the winner's `score` goes up. Either player's `rematch` starts the next rack. The game and the race cannot change until the match is won (`set_mode` and `set_match` fail with `wrong_phase`).
- When a rack makes the race, `match.winner` is set; `rematch` then starts a new match (score 0–0, the room's current `race`, `breaks` and game).
- Each rack is `{"winner", "breaker", "end", "foul"?}`. `end` says why it ended:
  - `made`: the winner pocketed the 8-ball in its called pocket, or the 9-ball, legally;
  - `eight_foul`: the loser pocketed the 8-ball on a foul (`foul` says which);
  - `eight_early`: the loser pocketed the 8-ball before it was their target;
  - `eight_pocket`: the loser pocketed the 8-ball in another pocket than called, or on a safety;
  - `eight_off`: the loser drove the 8-ball off the table (see Jump shots);
  - `three_fouls`: 9-ball, the loser's third foul in a row;
  - `points`: 3-cushion, the winner reached the target;
  - `draw`: 3-cushion, both reached it in the same number of innings;
  - `forfeit`: the loser left (see below). The score does not change.
- Leaving forfeits a match in progress (`leave`, or a seat hold that runs out): the other player wins the match, the rack in progress is listed with `end` `forfeit`, and the room goes back to the lobby. That player gets `player` (the seat empty) and `room_state` with the finished `match`. The match stays in `room_state` until a new player takes the free seat, which starts a new one.

## 9-ball

WPA section 5. Balls `1`–`9` are racked in a diamond with the 1 on the foot spot and the 9 in the centre; phases are `breaking`, then `open` for the rest of the rack (`groups` stay empty).

- The cue ball must first hit the lowest-numbered ball on the table, the 1 on the break. Any ball pocketed on a legal shot keeps the turn; nothing is called and there is no safety.
- The 9-ball pocketed on a legal shot wins, also on the break or by combination. Pocketed on a foul or a push out, it goes back on the foot spot (`settled` lists it in `pocketed`, and it reappears in `balls`).
- A break must pocket a ball or drive at least four object balls to a rail; otherwise it is a foul `bad_break` (with `illegalBreak` true). There is no re-rack choice.
- Fouls (`scratch`, `no_contact`, `wrong_ball`, `no_rail`, `bad_break`, `off_table`, and running out of time) give the opponent ball in hand anywhere. Balls pocketed on a foul or driven off the table stay down, except the 9.
- **Push out:** the shot right after the break, whoever takes it, may be sent with `call: {"pushOut": true}` while `pushOut` is true. It needs no contact and no rail; a scratch is still a foul. Balls it pockets stay down (the 9 is spotted). The opponent then gets a `decision` with `take_shot` and `pass_back`. A push out at any other time is refused with `bad_call`.
- **Three fouls:** `fouls[seat]` counts each player's consecutive fouls, reset by a legal shot. The third in a row loses the rack. Time fouls count, except on the break, where the opponent simply breaks instead.

## Tables

A room plays pool on one of four real 9 ft tables (`table`), which differ only in their pockets: the playing surface (100 × 50 in), the cushion height (63.5 % of the ball) and the cloth's pace are the WPA ones on all of them. Each figure is the maker's where it publishes one, otherwise a measured one, otherwise the middle of the WPA range. The mouth is measured between the cushion noses, the cut is the angle between the cushion and the jaw, the shelf runs from the mouth line to where a ball drops.

| `table` | Table | Corner mouth | Side mouth | Cuts | Corner shelf |
|---|---|---|---|---|---|
| `diamond` (default) | Diamond Pro-Am | 4½ in (114.3 mm) | 5 in (127 mm) | 141°, 102° (measured) | 31.6 mm (measured) |
| `predator` | Predator Apex 9 ft Pro | 108 mm | 125 mm | 142°, 104° (WPA) | 1¾ in (WPA) |
| `rasson` | Rasson Victory II, as cut for the Mosconi Cup | 4¼ in (108 mm) | 5 in (127 mm) | 142°, 104° (WPA) | 21.2 mm (measured) |
| `acurra` | Rasson Mr-Sung Acurra, Matchroom pockets | 4 in (101.6 mm) | 4½ in (114.3 mm) | 142°, 104° (WPA) | 1¾ in (WPA) |

Side shelves are ¼ in on all four. 3-cushion is always played on the carom table (below), whatever `table` says; the room keeps it for its pool games.

`cloth` is the cloth's colour, the same for everyone in the room, under Simonis's names: `tournament-blue` (default), `electric-blue`, `blue-green`, `spruce`, `simonis-green`, `english-green`, `slate-grey` or `burgundy`. It does not change how the balls run.

## 3-cushion

UMB three-cushion carom, on a match table without pockets: 2.84 × 1.42 m between the cushion noses, 61.5 mm balls. A match is one game to `race` points (`target` in `room_state`); `match.score` is the points as they are made.

- Each player strikes their own ball: the breaker the white (`0`), the other player the yellow (`1`); `carom.cue[seat]` says which. The red (`2`) belongs to nobody. Nothing is called (`call` is ignored); there is no ball in hand, no kitchen and no decision.
- The break is played from the opening position: the red on the foot (top) spot, the yellow on the head (starting) spot, the white on the head string 182 mm to one side of it, either side at random. The break must hit the red first: missing every ball is the foul `no_contact`, the yellow first `wrong_ball`.
- A point (`made`) is scored when the cue ball touches both other balls and has touched cushions at least three times before it touches the second one. The cushions may come before the first ball, between the two, or both; the same cushion may count again, but touching it twice with nothing in between (running along it) counts once, and a ball driven into a corner touches two. The other balls' cushions do not count.
- A point keeps the inning going; a miss or a foul ends it and the other player plays the balls where they lie. A ball driven off the table is the foul `off_table` and scores nothing; it goes back on its spot.
- Spots: the red's is the top spot, the incoming player's ball's the head spot, the other cue ball's the centre spot. A ball whose spot is taken goes on the spot of the ball that is in the way.
- When the incoming player's ball rests against another ball, the balls in contact go back on their spots before the shot (`settled` `frozen`).
- The game ends when a player reaches the target. If the breaker gets there first, the other player has one more inning (`carom.equalizing`): reaching the target in it draws the game (`end` `draw`, no winner; `match.draw` is true), falling short loses it. Otherwise the game ends `points`.
- Running out of time ends the inning; on the break the other player breaks instead, with the white.

In practice (`rerack` with `3cushion`) the player always strikes the white; shots are judged for `made` and `cushions` but nothing is counted.

## Spectators and chat

A spectator joins with `{"type": "join", "roomCode", "name", "watch": true}`. It gets `welcome` with `seat` -1, `spectator` true and no token, then `room_state`, then `chat_log` if there are comments. From then on it gets what the players get: `room_state`, `snapshot`, `settled`, `player`, `clock`, `timeout`, and the shooter's `aim`.

- A room lets `maxSpectators` watch (chosen at creation, changed by either player with `set_audience`). Beyond that, in a room that allows none, and in practice rooms, `join` with `watch` fails with `audience_full`; the socket stays open for another try.
- A spectator may only send `chat` and `leave` (and `ping`); anything else fails with `spectator`. `leave` closes its socket (1000, `left the room`). It has no seat to hold: after a lost connection it simply watches again.
- Spectators do not keep a room alive: the idle timeout (see Lifetime) counts players only. When the room is deleted their sockets are closed (1001, `room closed`).
- Whenever someone starts or stops watching, or the limit changes, everyone gets `audience` `{names, max}`; `room_state` carries the same as `spectators` and `maxSpectators`.
- Comments are one thread for the whole room. A comment sooner than 5 seconds (`-chat-cooldown`) after the sender's previous one fails with `chat_cooldown`, whose `retryMs` says how long to wait. The last 30 comments are sent to whoever joins, players included, as `chat_log`.

## Server → client

### `chat`

`{type, from, seat, text, at}`: a comment, from a player (`seat` 0 or 1) or a spectator (`seat` -1); `at` is Unix milliseconds.

### `chat_log`

`{type, messages}`: the room's last comments, oldest first, as `chat` objects. Sent after `room_state` to whoever joins or reconnects, when there are any.

### `audience`

`{type, names, max}`: who is watching, in the order they came, and how many may.

### `welcome`

`{type, v, playerId, seat, token, roomCode, aimLine}` — answers a successful `join`. `v` is the protocol version (1). `token` is a 128-bit secret for this seat; keep it to reconnect. `aimLine` is how long, in millimetres, the client draws the object ball's path after contact in the aim guide (100 by default, `-aim-line` / `AIM_LINE_MM`); `0` means the guide stops at the ghost ball. A spectator's `welcome` has `seat` -1, `spectator` true and an empty `token`.

### `room_state`

Full state. Sent right after `welcome`, and to both players whenever the state changes other than by a shot settling (game start, `place_cue`, `choose`, `rematch`, a `timeout`, a player leaving mid-game).

```json
{
  "type": "room_state",
  "mode": "8ball",
  "table": "diamond",
  "cloth": "tournament-blue",
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
  "practice": false,
  "undos": 0,
  "clock": {"seat": 0, "left": 29450, "limit": 30000, "paused": false, "extension": 40000, "extensions": [true, true]},
  "race": 5,
  "breaks": "alternate",
  "match": {"race": 5, "breaks": "alternate", "score": [1, 0], "racks": [{"winner": 0, "breaker": 1, "end": "made"}], "winner": null}
}
```

- `players[].connected` false with a non-empty `name` is a seat held for a player who dropped out (see Reconnecting); `name` `""` is an empty seat.
- `ballInHand`: the player in `turn` may send `place_cue`. `kitchen`: placement is limited to x ≤ 0.635 (break, and after a foul on the break).
- `decision`: `null`, or `{"seat": 1, "options": ["accept_table", "rerack_break", "rerack_opponent_breaks"]}`. No shot is accepted until that seat sends `choose`.
- `winner`: seat or `null`.
- `moving`: a shot is in progress; `snapshot`s and a `settled` will follow.
- `mode`: `8ball`, `9ball` or `3cushion`. `table` and `cloth`: the room's table and the colour of its cloth (see Tables).
- `target` and `carom`: 3-cushion only (left out otherwise). `target` is the points the game is played to (0 in practice); `carom` is the score: `{"points": [7, 5], "innings": [12, 12], "highRun": [3, 2], "run": 1, "cue": [0, 1], "breaker": 0, "equalizing": false}` with each seat's points, innings started and best run, the points of the inning in progress, each seat's ball and who broke.
- `practice`: a practice room; `undos`: shots `undo` can take back there (always 0 elsewhere).
- `fouls`: 9-ball consecutive fouls by seat (always `[0, 0]` in 8-ball). `pushOut`: 9-ball, the player in `turn` may push out on this shot.
- `race`, `breaks`: the settings of the next match (`set_match`). `match`: the match being played, or the last one (see Matches); `null` in practice.
- `clock`: the shot clock of the player who must act next (shoot, or answer the `decision`), or `null` while nobody has to (lobby, game over, balls moving, clock turned off). `left` is milliseconds left when the message was sent: count down from its arrival rather than comparing clocks. `limit` is what the clock was last set to, `paused` is true while that player is offline, `extension` is what an `extend` sets the clock to and `extensions[seat]` whether that seat may still extend.

### `snapshot`

`{type, t, balls}` — sent when a shot starts (`t` = 0), then at 20 Hz while balls move, plus one at the moment of the first bounce (ball or cushion) inside any 60 Hz server tick, so that interpolating clients do not cut the corner of a bounce. `t` is simulated milliseconds since the shot, strictly increasing but not evenly spaced; positions are rounded to 4 decimals (0.1 mm). Clients interpolate between snapshots. A ball in the air (a jump shot) has `z`, the height of its lowest point above the slate in metres, left out while it is on the cloth.

`impacts` (omitted when empty) lists the contacts since the previous snapshot, for sound: `{"t": 412, "k": "ball", "v": 1.85}` with `t` on the same clock as the snapshot's, `k` one of `ball` (two balls), `rail` (a cushion or jaw), `pocket` (a ball dropping) or `slate` (a ball in the air coming down on the cloth), and `v` the closing speed along the contact normal (for `pocket`, the ball's speed) in m/s. Contacts slower than 0.02 m/s are left out. Each impact is sent once; those after the last snapshot come with `settled`. A dropped snapshot loses its impacts, which only costs a sound.

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
- `offTable`: ids driven off the table by this shot, in order, `0` included; omitted when none.
- `impacts`: the shot's last contacts, as in `snapshot`.
- `foul`: omitted for a legal shot, otherwise `scratch`, `no_contact`, `wrong_ball`, `kitchen` (cue ball in hand above the head string hit a ball there without crossing the head string first), `no_rail` (nothing pocketed and no ball reached a rail after contact) or `off_table` (a ball left the table).
- `made`: a ball that counts for the shooter dropped: one of their group, any object ball on an open table, or the 8-ball in its called pocket.
- `illegalBreak`: break that pocketed nothing and drove fewer than four object balls to a rail; in 8-ball a `decision` for the opponent follows, in 9-ball it is the foul `bad_break`.
- `pushedOut`: 9-ball, this shot was a push out. `fouls` and `pushOut` as in `room_state`.
- `safety`: present (true) when the shooter called a safety, so every client knows it.
- `winner`: present only when the game is over.
- `clock`: as in `room_state`, started for whoever acts next.
- `match`: as in `room_state`; a shot that ends a rack has it in `racks` already.
- After a scratch, or the cue ball off the table, the cue ball is back on the table (head spot by default) and the opponent has ball in hand.
- 3-cushion: `made` is a point. `cushions` is how many cushions the cue ball touched before the second ball (or in all, if it never got there) and `touched` how many of the other two balls it touched (both omitted when 0); `spotted` lists the balls put back on their spots, and `frozen` says that was because the incoming ball touched another. `target` and `carom` as in `room_state`.

### `aim`

`{type, seat, angle, power, elevation?}` — the other player's aim preview; `elevation` (radians, clamped as in `shoot`) only while their cue is raised.

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
| `bad_mode` | `set_mode` or `rerack` with a mode other than `8ball`, `9ball` or `3cushion`. |
| `bad_race` | `set_match` with a race outside 1–25 (3-cushion: 1–50 points) or a break rule other than `alternate` or `winner`. |
| `no_undo` | `undo` with no shot to take back. |
| `not_practice` | `place_ball`, `undo` or `rerack` outside a practice room. |
| `no_decision` | `choose` with nothing to decide. |
| `bad_option` | `choose` with an option that was not offered. |
| `no_extension` | `extend` after the sender already used their extension this game. |
| `audience_full` | `join` with `watch` when no more spectators may watch, or none may. |
| `spectator` | A spectator sent something other than `chat` or `leave`. |
| `chat_cooldown` | A comment within 5 seconds of the sender's last; `retryMs` says how long to wait. |
| `bad_spectators` | `set_audience` (or room creation) with a number outside 0 to the server's limit, or in a practice room. |
| `bad_table` | `set_table` (or room creation) with a table or cloth not listed under Tables. |

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
- If a single hold expires the seat is emptied (`player` with `name` `""`) and the game is abandoned (`room_state` with phase `lobby`). A match in progress is forfeited by the player who did not come back, as with `leave`; when both are gone until the abandon timeout, the match is cancelled.
- A `join` whose `token` matches nothing is treated as a plain join.

## Keepalive

- The server sends a WebSocket ping every 20 seconds and closes connections whose pong does not arrive within 10 seconds (status 1001, reason `ping timeout`). Browsers answer pings on their own.
- A client that wants to detect a dead connection itself sends `ping` and expects `pong`.

## Lifetime

- A room with no connected player for 10 minutes (`-idle`) is deleted. Held seats and spectators do not count as connected.
- Each client has an outbound queue of 32 messages. When it is full, the oldest queued `snapshot` or `aim` is discarded to make room (the next one supersedes it). If none can be discarded the client is disconnected with status 1008 and reason `outbound buffer full`.
