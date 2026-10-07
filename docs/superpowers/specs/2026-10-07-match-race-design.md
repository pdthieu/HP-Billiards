# Matches: race to N, scoreboard, leave button

## Goal

Two players play a match, not a single rack: the first to win `race` racks
wins. The score and every rack's result are on screen, and a player can
leave the room at any time (mid-match that forfeits the match).

## Settings

- Chosen when the room is created, changeable in the lobby and after a
  match (never during one):
  - game: 8-ball or 9-ball (as today);
  - race: 1–25, quick picks 1 · 3 · 5 · 7 · 9 plus a number field. Race 1
    is today's behaviour, one rack per match;
  - breaks: `alternate` (players take turns) or `winner` (the winner of a
    rack breaks the next).
- The room list shows them: "8-ball · race 5".
- Practice rooms have no match.

## Flow

- The first rack of a room's first match: random breaker (`Options.Breaker`).
- A later rack of the same match:
  - `alternate`: the other player from the one who broke the last rack;
  - `winner`: whoever won the last rack.
- The first rack of a new match: the player who did not break the previous
  match's first rack.
- A rack ends, match not won: the game-over panel shows the rack result and
  the score, and **Next rack** (either player, `rematch`) starts the next
  rack. The game cannot be changed between racks.
- A rack ends and its winner reaches `race`: the match is over. The
  match-summary dialog opens; the game-over panel offers the settings and
  **New match**.

## Scoreboard

- Header, between the seats: `3 – 2` over "Race to 5". A digit ticks when
  it changes (design/motion.md "score tick").
- Clicking the score opens the match dialog, at any time:
  - the score and, once decided, the winner;
  - one row per rack: number, winner, why, who broke.
- Why a rack ended (`end`):
  - `made`: the 8 or the 9 pocketed legally;
  - `eight_foul`: the loser fouled while pocketing the 8 (with the foul);
  - `eight_early`: the loser pocketed the 8 before clearing their group;
  - `eight_pocket`: the loser pocketed the 8 in an uncalled pocket, or on a
    safety;
  - `three_fouls`: 9-ball, the loser's third foul in a row;
  - `forfeit`: the loser left the room, or did not come back in time.

## Leaving

- A Leave button in the header, next to Settings (an icon only on phones),
  in every room. Practice keeps its own Leave button.
- Mid-match (a rack in progress or between racks), Leave asks first:
  "Leave and forfeit the match? (2–3)", with Stay and Leave and forfeit.
  In the lobby or after the match, it leaves at once.
- The client sends `leave`. The server:
  1. records a forfeit when a match is live: the other player wins the
     match, and the rack in progress is listed with `end: forfeit` (score
     unchanged);
  2. frees the seat at once;
  3. puts the room back in the lobby, keeping the finished match in
     `room_state.match` until a new player sits down;
  4. closes the socket.
- The player who stays sees the match dialog, "Bob left the room. You win
  the match 3–2", then waits in the lobby.
- A dropped player whose seat hold runs out forfeits the same way. If both
  players walk away (abandon), the match is cancelled.
- A new player taking a free seat clears the old match.

## Protocol

- `POST /api/rooms` body: `{mode, race, breaks, practice}`; a bad race
  answers 400 `bad_race`.
- `room_state.match` and `settled.match` (null in practice):
  `{race, breaks, score: [a, b], racks: [{winner, breaker, end, foul?}], winner: seat|null}`.
- New client messages:
  - `set_match {race?, breaks?}`: lobby or after the match;
  - `leave`.
- `rematch` means "Next rack" during a match and "New match" after it.
- `set_mode` is refused between racks of a match (`wrong_phase`).
- New error code: `bad_race`.
- The room list's RoomInfo gains `race` and `breaks`.

## Code

- `internal/game/match.go`: `Match`, holding the race, the break rule, the
  score, the racks and the winner, with these methods:
  - `Reset`;
  - `Record(rack)`;
  - `Forfeit(loser, breaker)`;
  - `Over`;
  - `NextBreaker`;
  - `Opener`.
- `Rules.End` holds why the rack ended, set where `Winner` is set.
- `room`:
  - holds a `game.Match`;
  - calls `endRack` when the phase becomes game over, after a shot or a
    clock foul;
  - forfeits in `vacate` while a match is live.

## Tests

- **Unit:** `Match`, and `Rules.End` for each way a rack ends.
- **Hub:**
  - a full race-2 match with both break rules;
  - `set_match` and `set_mode` refused between racks;
  - `leave` mid-match forfeits, frees the seat and keeps the result;
  - an expired seat hold forfeits;
  - a new player clears the match.
- **e2e:**
  - create a race-3 room and see the score;
  - open the match dialog;
  - leave mid-match through the confirmation, and the other player sees
    the forfeit win;
  - screenshots on desktop and phone.
