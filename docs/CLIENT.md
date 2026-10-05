# Web client

The client is `web/index.html`, `web/style.css` and `web/app.js`: plain HTML,
CSS and JavaScript with no build step, embedded into the server binary by
`web/embed.go`. Rebuild the server after editing them.

`web/debug.html` is a separate raw-protocol page for poking the server by hand.

## Flow

1. **Landing**: the name field is prefilled with the last name used (kept in
   `localStorage`) or, the first time, a random one such as "Brisk Otter".
   Below it the live room list (`GET /api/rooms`, refreshed every 3 s while
   the landing is open) offers *Join* on rooms with a free seat and shows the
   others as full. *Create a room* is disabled with a note once the server's
   limit (3) is reached. Opening `/?room=CODE` turns the landing into a "Join
   room CODE" form; after joining, the URL is rewritten to that form so *Copy
   link* gives an invite.
2. **Lobby**: both seats shown in the header; the rack starts when both press
   *I'm ready*.
3. **Your shot** (shot panel visible):
   - *Ball in hand*: drag the cue ball. The kitchen is highlighted when
     placement is limited to it and the drag is clamped there. The position is
     sent as `place_cue` on release and shown until the server confirms it.
   - *Call* (every shot but the break): tap a legal ball (ringed in white);
     no pocket is called, the ball counts wherever it drops. *Safety* (or the
     `S` key) declares a safety instead. *Clear* starts over.
   - *Aim*: drag on the felt; the cue points from the cue ball toward the
     pointer. The guide shows the ghost ball at first contact, the object
     ball's line and the cue ball's deflection. Arrow keys nudge the angle
     (0.5°, Shift for 0.05°) and power; the `«‹›»` buttons nudge by 5° and
     0.25°.
   - *Power and shooting*: the bar beside the table. Press it, pull down to
     set the power (the cue draws back on the table) and release to shoot;
     releasing in the top 8 % cancels. Arrow up/down also change the power
     and Enter or Space shoots with it. A shot that still needs a call is
     refused with a hint.
   - *Spin*: the small cue ball in the shot panel. Tap or drag where the tip
     should strike (limited to the dashed circle, the no-miscue zone); above
     centre is top spin, below is draw, left and right are english. Reset
     returns to a centre hit, and every new turn starts centred. Sent as
     `spin` with the shot.
   - Hovering a ball with the mouse shows its number and group above it.
   - Aim changes are relayed to the opponent as `aim` at most every 100 ms.
4. **Opponent's shot**: their aim is drawn translucent. During a shot the
   wait panel reads "Balls are rolling…".
5. **Decisions** after the break (illegal break, 8-ball on the break) open a
   dialog for the choosing player; the other sees "Waiting for … to decide".
6. **Game over**: banner plus *Rematch* (either player).
7. **Disconnect**: the client reconnects by itself with the seat token from
   `welcome` (300 ms, then 1 s, 2 s, 4 s, 8 s, 8 s, …) and shows an overlay
   with *Retry now* and *Leave* meanwhile. The server holds the seat for 60 s
   during a game, so the rack continues where it was. The token lives in
   `sessionStorage` per room: reloading the tab rejoins the same seat at once,
   a second tab does not steal it. A `ping` every 15 s without a `pong` within
   10 s closes the socket so a dead connection is noticed quickly. If the
   socket is closed with reason `replaced by a new connection` (the token was
   used elsewhere) the client does not reconnect automatically. *Leave*
   forgets the token and returns to the landing page.
8. **Opponent offline**: their seat shows an *offline* tag, the status line
   says the seat is held, and the wait panel reads "Waiting for … to
   reconnect…". If the hold expires the server abandons the game.

## Rendering

- The table is drawn in meters on a canvas scaled to fit; on a portrait
  screen it is rotated 90° (`view.rotated`), and pointer coordinates are mapped
  back through the same transform. Ball numbers and labels are counter-rotated.
  Cushions and pocket jaws are drawn from the same WPA dimensions the server
  simulates (constants at the top of `app.js`; keep them in sync with
  `game.DefaultConfig`).
- While a shot runs, `snapshot`s are kept in arrival order and the frame drawn
  is `RENDER_DELAY_MS` (100 ms) behind the newest one, interpolating between
  the two surrounding snapshots. A ball missing from the later snapshot stays
  at its earlier position until that snapshot's time passes, then disappears.
  `settled` replaces everything with exact positions. After a reconnect in
  the middle of a shot the clock is re-aligned to the first snapshot received.
- Legal call targets are computed client-side with the same rule as the
  server (`legalTargets` mirrors `Rules.legalTarget`); the server still
  validates every call.
