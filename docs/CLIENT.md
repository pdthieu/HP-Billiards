# Web client

The client is `web/index.html`, `web/style.css` and `web/app.js`: plain HTML,
CSS and JavaScript with no build step, embedded into the server binary by
`web/embed.go`. Rebuild the server after editing them.

`web/debug.html` is a separate raw-protocol page for poking the server by hand.

## Flow

1. **Landing**: enter a name, then *Create a room* (`POST /api/rooms`, then
   `join`) or type a 5-letter code and *Join*. Opening `/?room=CODE` prefills
   the code; after joining, the URL is rewritten to that form so *Copy link*
   gives an invite.
2. **Lobby**: both seats shown in the header; the rack starts when both press
   *I'm ready*.
3. **Your shot** (shot panel visible):
   - *Ball in hand*: drag the cue ball. The kitchen is highlighted when
     placement is limited to it and the drag is clamped there. The position is
     sent as `place_cue` on release and shown until the server confirms it.
   - *Call* (every shot but the break): tap a legal ball (ringed in white),
     then a pocket (ringed and numbered 1–6). *Safety* (or the `S` key)
     declares a safety instead. *Clear* starts over.
   - *Aim*: drag on the felt; the cue points from the cue ball toward the
     pointer. The guide shows the ghost ball at first contact, the object
     ball's line and the cue ball's deflection. Arrow keys nudge the angle
     (0.5°, Shift for 0.05°) and power; the `«‹›»` buttons nudge by 5° and
     0.25°.
   - *Power*: slider, 5–100 %. *Shoot*, Enter or Space fires; the button is
     disabled until a call is made.
   - Aim changes are relayed to the opponent as `aim` at most every 100 ms.
4. **Opponent's shot**: their aim is drawn translucent. During a shot the
   wait panel reads "Balls are rolling…".
5. **Decisions** after the break (illegal break, 8-ball on the break) open a
   dialog for the choosing player; the other sees "Waiting for … to decide".
6. **Game over**: banner plus *Rematch* (either player).
7. **Disconnect**: an overlay offers *Rejoin* (takes a free seat; the game in
   progress has already been abandoned by the server) or *Leave*.

## Rendering

- The table is drawn in meters on a canvas scaled to fit; on a portrait
  screen it is rotated 90° (`view.rotated`), and pointer coordinates are mapped
  back through the same transform. Ball numbers and labels are counter-rotated.
- While a shot runs, `snapshot`s are kept in arrival order and the frame drawn
  is `RENDER_DELAY_MS` (100 ms) behind the newest one, interpolating between
  the two surrounding snapshots. A ball missing from the later snapshot stays
  at its earlier position until that snapshot's time passes, then disappears.
  `settled` replaces everything with exact positions.
- Legal call targets are computed client-side with the same rule as the
  server (`legalTargets` mirrors `Rules.legalTarget`); the server still
  validates every call.
