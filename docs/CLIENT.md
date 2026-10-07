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

The game, 8-ball or 9-ball, is picked with a two-button switch above
*Create a room* (remembered in `localStorage` as `pool:mode`).

Inside a room, Settings (the gear in the header) has a *Room* part at the
top, so that the screen around the table stays bare. It holds:

- the game switch;
- the next match's race and break rule;
- the room code with *Copy invite link* (a share sheet on phones).

Either player may change the game and the match settings in the lobby (both
press ready again) or once the match is won. While a match is played they
are disabled with a note. In practice only the game switch shows, and it
racks the table again. The lobby panel keeps *Copy invite link* while the
player waits alone.

The header
eyebrow reads "8-ball room" or "9-ball room" and the room list shows the
game in each row's chip. In 9-ball:

- the call line says which ball to hit first and the lowest ball gets the
  white ring; Safety and pocket calls do not exist;
- right after the break the shooter sees a *Push out* toggle (or `P`); the
  opponent then gets a "Push out" dialog: *Take the shot* or *Pass it
  back*;
- a player on two consecutive fouls gets a red "2 fouls" tag on their seat,
  and the status line warns that a third loses;
- the tray under the table is a single "Pocketed" row.

Rooms play matches. Under the game switch the landing page has the race:
quick picks 1 · 3 · 5 · 7 · 9 or any number from 1 to 25 in the field next
to them (Enter commits, never submits the form). Below it is the break
rule, *Alternate* or *Winner breaks*. Both are remembered as `pool:race`
(default 3) and `pool:breaks`. The room list chip adds "race 5".

- **Changing the settings.** Settings has the same pickers under *Next
  match*. Changes go to both players with `set_match`; in the lobby both
  press ready again. The lobby line and the game-over note say what the
  next match is and that Settings changes it.
- **Header score.** The score between the seats reads "2 – 1, race to 5"
  and is a button.
  - A digit that goes up ticks: the old digit slides out, the new one
    springs in and stays brass for 1.2 s.
  - Clicking the score opens the match dialog: the score, and one row per
    finished rack with its number, winner, the running score, why it ended
    and who broke.
  - The dialog opens by itself when the match is won, after the result
    banner, or at once on a forfeit. A race to 1 does not open it.
- **Game-over panel.**
  - Between racks: "You win the rack", the score and who breaks next, and
    *Next rack*. The game and race pickers are hidden.
  - After the match: "You win the match 5–3", the pickers for the next
    match and *New match*. A race to 1 keeps *Rematch*.
- **Leaving.** The header has a Leave button (an exit icon) next to
  Settings.
  - During a match it asks first: "Leave and forfeit the match?", showing
    the score, with *Stay* and *Leave and forfeit*.
  - Otherwise it leaves at once.
  - Leaving sends `leave`, so the seat is freed immediately. The player
    who stays gets "Ann left. You win the match 2–1." and the match dialog,
    and waits in the lobby: "Ann left the room."
- **Phones.** The header holds the code, Settings, Leave, the seats and the
  score. There is no invite button there, so the score always fits.

*Practice alone* on the landing page opens a private practice room of the
picked game. It is free play, without the tournament rules:

- no fouls, turns, calls or end;
- every ball that drops stays down, and a scratched cue ball comes back to
  the head spot;
- the call line reads "Free play: any ball, any pocket";
- the status says what dropped, or "Table cleared!";
- the header shows the one player, with no score and no second seat;
- there is no shot clock.

A toolbar
between the status and the panel (over the table's corner on landscape
phones, icons only on phones) has:

- *Undo* (`Z`): take back the last shot, up to 20;
- *Move balls* (`M`): while on, dragging any ball moves it instead of
  aiming; with it off the cue ball can still be dragged anywhere at any
  time;
- *Rack*: a fresh rack of the same game (Settings switches the game);
- *Leave*.

The tray row is hidden to make room.

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
   The player who must act has the shot clock beside their name, a brass
   ring with the seconds left that turns red for the last 10 s, when the
   shooter also gets a "10 seconds left" toast. The ring counts from the
   arrival of the server's `left`, so the two machines' clocks never mix.
   The decision dialog repeats the countdown and names the option taken
   when it runs out. A `timeout` is shown as a toast and in the status
   line ("Bob ran out of time. You have ball in hand.").
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
     starts over. *+40s* (or the `X` key) spends the game's one extension
     and is hidden once used.
   - *Aim*: drag on the felt; the cue points from the cue ball toward the
     pointer. The guide shows the ghost ball at first contact and, as far
     as the server's `aimLine` allows (100 mm by default, none at 0), the
     object ball's line and the cue ball's deflection: the tangent line for a
     stun shot, bent forward or back by the top or bottom spin set on the
     spin pad (a tendency, not a prediction). Arrow keys nudge the angle
     (0.5°, Shift for 0.05°) and power; the `«‹›»` buttons nudge by 5° and
     0.25°.
   - *Power and shooting*: the bar beside the table. Press it, pull down to
     set the power (the cue draws back on the table) and release to shoot;
     releasing in the top 8 % cancels. The bar is quadratic: a pull to f
     sends `power` f², so half the bar is about 2 m/s (a medium-firm shot),
     70 % about 4 m/s (a power shot) and the bottom is the 8 m/s break; the
     readout shows the speed. Arrow up/down move the bar by 5 % and Enter or
     Space shoots with it. A shot at the 8-ball without a called pocket is
     refused with a hint.
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
5. **Decisions** after the break (illegal break, 8-ball on the break) or a
   9-ball push out open a dialog for the choosing player; the other sees
   "Waiting for … to decide".
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
9. **Phones**:
   - **Portrait.** The table stands upright whenever that is not smaller.
     Without a margin, Safari's bars growing or shrinking cannot flip it.
   - **The shot panel is one row** while a rack is played (`body.is-playing`,
     a 64 px slot). The row holds:
     - the call line (two lines at most);
     - the situational toggles (Safety, Push out, +40s);
     - on the right, a small cue ball showing the spin (`#optionsBtn`).

     Tapping that cue ball opens the *Spin and fine aim* sheet over the
     bottom of the screen: the spin pad, the angle readout and its four
     buttons. `placeShotOptions` moves those nodes there from the panel
     whenever the phone layout applies. Done, Escape, a touch anywhere else
     or the shot closes the sheet; the table stays live above it.
   - **Naming balls.** The numbers on balls under 16 px across are too
     small to read, so:
     - a touch within a fingertip (22 px) of a ball names it for 2 s, with
       a swatch of its colour, at any time, the other player's turn
       included;
     - while aiming, the ball the shot hits first carries a small tag
       beside it, across the line of the shot, so the cut is never played
       on the wrong ball.
   - **Lobby and game over** keep the 134 px slot, so the table resizes
     only at the start and end of a rack. On an iPhone in Safari
     (393 × 670) balls are about 10 px. Toasts drop from under the header.
   - **Screens under 700 px tall** drop the trays.
   - **Landscape phones** show the shot panel as a sidebar, with the status
     floating over the table. While a rack is played the sidebar is 132 px
     (the call, the toggles and the cue-ball button), and the sheet opens
     at the top right.
   - **Home screen.** `manifest.webmanifest` and the icons in `web/icons`
     (`icon.svg`, rendered to 192, 512 and the 180 px apple-touch-icon) let
     a phone add Pool to its home screen. It then opens standalone, without
     browser bars. Settings explains how on touch devices that are not
     standalone yet. The
   connection card appears only after 300 ms offline, with the retry backoff
   drawn as steps; a reload inside a room shows a splash after 150 ms.

## Sound

Ball on ball, the cue and a pocket are recordings (`web/sounds`, about
200 KB of 16-bit mono WAV, fetched once audio starts); a cushion is a
synthesized thump.

- **What a real clack is.** Measured on the recordings, it falls 30 dB in
  3 to 8 ms, its energy around 2 to 3 kHz, because the balls touch for only
  about 0.2 ms. The old synthesized clack rang for 35 ms on three pure tones
  and sounded like a bell.
- **Variation.** Each contact plays one of the takes (7 clacks, 4 cue
  strikes, 1 pocket), never the same one twice in a row, 3 % up or down in
  pitch.
- **Speed.** Volume follows the closing speed the server reports in
  `impacts`. A low-pass filter also closes for soft contacts, which are
  duller as well as quieter.
- **Before loading.** Until the takes have decoded, short synthesized
  stand-ins play.
- **Timing.** Each sound is scheduled for the moment the render clock
  (100 ms behind the snapshots) reaches it, so it lands on the frame that
  shows the contact. One that would play over 120 ms late is dropped. The
  cue strike plays at once for your own shot and with the first snapshot
  for the other player's.
- **Limiter.** It keeps a break's pile of clacks from clipping.
- **Starting.** Browsers only start audio after a click or key press, so the
  context is created on the first one.
- **Settings.** *Sound effects* (on by default) and a volume slider are kept
  in `localStorage` as `pool:sound` and `pool:volume`.

The takes were cut from CC0 (public domain) recordings on Freesound. Each
was trimmed to start 1 ms before the hit, faded out, and evened out in
loudness within its kind:

| file | source |
|---|---|
| `clack-1` to `clack-4` | "Billiard Ball percussive hits" by Cymeon, freesound.org/s/245397 |
| `clack-5`, `clack-6` | "Pool balls" by bsumusictech, freesound.org/s/62331 |
| `clack-7` | "billiard ball clack" by Za-Games, freesound.org/s/539854 |
| `cue-1` to `cue-4` | "S02-22 Billiards cue stick hits ball" by craigsmith, freesound.org/s/675330 |
| `pocket-1` | "B_1 pool ball falling" by Yarmonics, freesound.org/s/441857 |

## Rendering

- The table is drawn in meters on a canvas scaled to fit. On a portrait
  screen it is rotated 90° whenever that is not smaller; elsewhere only when
  it is 15 % bigger (`view.rotated`), and pointer coordinates are mapped
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
