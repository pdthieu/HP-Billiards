# Web client

The client is plain HTML, CSS and JavaScript with no build step, embedded
into the server binary by `web/embed.go`. Rebuild the server after editing it.

- `web/index.html`, `web/app.js`: markup and all behaviour.
- `web/tokens.css`, `web/components.css`: the "Night hall" design system,
  copied from `design/` (see `design/README.md`); edit them there first.
- `web/style.css`: app glue only (page layout, overlays made `fixed`, the
  live table stage, phone and landscape media queries).
- `web/fonts.css` + `web/fonts/*.woff2`: Source Sans 3 and Barlow Semi
  Condensed, self-hosted (latin, latin-ext, vietnamese), served from `/fonts/`
  with an immutable cache.
- The canvas follows `design/canvas-spec.md`; motion follows `design/motion.md`.

`web/debug.html` is a separate raw-protocol page for poking the server by hand.

## Flow

1. **Landing**: the name field is prefilled with the last name used (kept in
   `localStorage`) or, the first time, a random one such as "Brisk Otter"; a
   shuffle button suggests another. The live room list (`GET /api/rooms`,
   refreshed every 3 s while the landing is open) keeps rows keyed by room
   code, offers *Join* on rooms with a free seat and shows the others as
   full; *Create a room* is disabled with a note once the server's limit (3)
   is reached. Opening `/?room=CODE` turns the landing into a "Join room
   CODE" form that names the host; after joining, the URL is rewritten to
   that form so the invite button gives a link (it shares on phones).
2. **Lobby**: both seats shown in the header; the rack starts when both press
   *I'm ready*. Once groups are assigned a seat shows seven dots for the
   player's balls, dimmed as they are pocketed; the seat on turn pulses
   (paused while balls roll); an offline seat shows the 60 s hold ring.
3. **Your shot** (shot panel visible):
   - *Ball in hand*: drag the cue ball. The kitchen is highlighted when
     placement is limited to it and the drag is clamped there. The position is
     sent as `place_cue` on release and shown until the server confirms it.
   - *Call*: object balls are not called; the line above the panel says
     whose group you shoot (legal first-contact balls are ringed in white).
     Once the 8-ball is your target the pockets light up: tap the one you
     are going for (a press that moves more than 8 px or lasts over 250 ms
     aims instead); the called pocket is ringed in brass and named in the
     line. *Safety* (or the `S` key) declares a safety instead. *Clear*
     starts over.
   - *Aim*: drag on the felt; the cue points from the cue ball toward the
     pointer. The guide shows the ghost ball at first contact, the object
     ball's line and the cue ball's deflection. Arrow keys nudge the angle
     (0.5°, Shift for 0.05°) and power; the `«‹›»` buttons nudge by 5° and
     0.25°.
   - *Power and shooting*: the bar beside the table. Press it, pull down to
     set the power (the cue draws back on the table) and release to shoot;
     releasing in the top 8 % cancels. Arrow up/down also change the power
     and Enter or Space shoots with it. A shot at the 8-ball without a
     called pocket is refused with a hint.
   - *Spin*: the small cue ball in the shot panel. Tap or drag where the tip
     should strike (limited to the dashed circle, the no-miscue zone); above
     centre is top spin, below is draw, left and right are english. Reset
     returns to a centre hit, and every new turn starts centred. Sent as
     `spin` with the shot.
   - Hovering a ball with the mouse shows its number and group above it; on
     touch the label shows for 1.5 s after a tap.
   - The panel slot and the status line have fixed heights, so the table
     never jumps when panels swap or a sentence wraps; both cross-fade.
   - *Settings* (gear in the header): theme (system, dark, light), power bar
     on the left for left-handed play, and "show hints again". Stored in
     `localStorage` under `pool:*`.
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
8. **Opponent offline**: their seat shows an *offline* tag and a hold ring,
   the status line says the seat is held, and the wait panel counts down
   "Their seat is held for N more seconds". If the hold expires the server
   abandons the game and the lobby says the opponent did not come back.
9. **Phones**: portrait rotates the table and stacks the shot panel in two
   rows; screens under 700 px tall drop the trays; landscape phones show the
   shot panel as a sidebar with the status floating over the table. The
   connection card appears only after 300 ms offline, with the retry backoff
   drawn as steps; a reload inside a room shows a splash after 150 ms.

## Rendering

- The table is drawn in meters on a canvas scaled to fit; on a portrait
  screen it is rotated 90° (`view.rotated`), and pointer coordinates are mapped
  back through the same transform. Labels are counter-rotated; ball markings
  are not: each ball keeps an orientation that rolls with its movement (see
  `rollBall`), its stripe, discs and numbers are drawn from that, and only the
  lighting is screen-aligned.
  Cushions and pocket jaws are drawn from the same WPA dimensions the server
  simulates (constants at the top of `app.js`; keep them in sync with
  `game.DefaultConfig`).
- While a shot runs, `snapshot`s are kept in arrival order and the frame drawn
  is `RENDER_DELAY_MS` (100 ms) behind the newest one, interpolating between
  the two surrounding snapshots. A ball missing from the later snapshot stays
  at its earlier position until that snapshot's time passes, then disappears.
  `settled` replaces everything with exact positions. After a reconnect in
  the middle of a shot the clock is re-aligned to the first snapshot received.
- Legal first-contact balls and whether the 8-ball is on are computed
  client-side with the same rules as the server (`legalTargets` and
  `eightOn` mirror `Rules.legalTarget` and `Rules.eightOn`); the server still
  validates every shot.
