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
between the status and the panel (at the head of the side column on
landscape phones, icons only on phones) has:

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
   - *Aim*: drag on the felt. The pointer holds the butt of the cue: the
     cue lies between it and the cue ball, and the shot goes the other way,
     as with a real cue. The aim changes only once the pointer moves, not
     on the press. Within 1.5 radii of the cue ball the aim holds still.
     A finger (touch or pen, in 2D) works the cue as a lever instead
     (`leverAim`): the cue turns by as much as the finger turns about the
     cue ball, but never jumps to it. So a new touch keeps the aim set so
     far, even one from the fine aim wheel, and the farther from the cue
     ball the finger is, the finer it turns (300 px away, 0.2° per px).
     Within 24 px of the cue ball the aim holds still.
     Settings → *Aiming* switches to pointing (`pool:aim` = `front`): the
     shot goes toward the pointer, from the press on. In 3D, behind the cue,
     a sideways drag turns the aim instead (see *3D view*). The guide shows the ghost ball at first contact and, as far
     as the server's `aimLine` allows (100 mm by default, none at 0), the
     object ball's line and the cue ball's deflection: the tangent line for a
     stun shot, bent forward or back by the top or bottom spin set on the
     spin pad (a tendency, not a prediction). Arrow keys nudge the angle
     (0.5°, Shift for 0.05°) and power; the `«‹›»` buttons nudge by 5° and
     0.25°. Under them the fine aim wheel (`#aimJog`) turns the cue 0.02°
     per px dragged sideways (100 px = 2°), without end, clockwise to the
     right; its ticks roll with the finger, and focused, the arrow keys turn
     it 0.05° (Shift 0.01°). The readout shows hundredths. A mouse wheel
     (or two fingers on a trackpad) over the table or the wheel turns the
     cue 0.05° a notch, 0.01° with Shift; Ctrl + wheel stays the browser's
     zoom.
   - *One finger at a time.* The table follows the pointer that pressed
     first (`S.pointer`) until it lifts; a second finger (a thumb resting
     on the felt, a palm on the rail) neither aims nor carries a ball. The
     power bar likewise keeps the finger that took it.
   - *Loupe.* While a finger aims (on the felt, the fine aim wheel or the
     power bar) and the balls are under 18 px across, a circle of 54 px in
     a corner shows the contact three times larger: the ghost ball and the
     ball it hits. The corner is the one clear of the contact and of the
     hand, and changes only when the one in use gets in the way. It is a
     copy of the frame just drawn (`drawLoupe`), 2D only.
   - *Power and shooting*: the bar beside the table. Press it, pull down to
     set the power (the cue draws back on the table) and release to shoot;
     releasing in the top 8 % cancels. The bar is quadratic: a pull to f
     sends `power` f², so half the bar is about 2 m/s (a medium-firm shot),
     70 % about 4 m/s (a power shot) and the bottom is the 8 m/s break; the
     readout shows the speed. Arrow up/down move the bar by 5 % and Enter or
     Space shoots with it. A shot at the 8-ball without a called pocket is
     refused with a hint. On a phone that vibrates the pull ticks (8 ms) at
     each quarter of the bar, longer entering the cancel zone and on the
     shot; Settings → *Vibration* turns it off (`pool:haptics` = `off`).
   - *Spin*: the small cue ball in the shot panel. Tap or drag where the tip
     should strike (limited to the dashed circle, the no-miscue zone); above
     centre is top spin, below is draw, left and right are english. Reset
     returns to a centre hit, and every new turn starts centred. Sent as
     `spin` with the shot. The words beside it ("top + right") sit in a box
     of fixed size, with "at limit" on a line of its own that keeps its
     place while hidden, so nothing around them moves as the dot does.
   - *Jump*: the slider beside the spin raises the butt of the cue, 0°
     (level) to 85°, and the cue in the picture beside it tilts to match;
     past 60° the label reads *Massé*;
     `J` raises it 5°, Shift+`J` lowers it. Sent as `elevation` (radians)
     with the shot and the aim, and every new turn starts level. Below
     1200 px it is an upright slider without the picture. The guide follows
     the first hop as the server works it out (`jumpFlight`, mirroring
     `Table.ShootElevated`): dotted while the cue ball is in the air, a ring
     where it comes down, and it passes over the balls the cue ball clears
     (`castAim` checks the heights). A path over a cushion turns red and
     ends past the rail with no ghost ball: the cue ball would leave the
     table. Later, lower hops are not predicted. On the table a raised cue
     looks shorter from above.
   - *Massé*: with english on a raised cue the guide follows the curve
     (`massePath` steps the cue ball as the server does, `castMasse` casts
     along it, and `castAim` takes over once it rolls straight): dashed on
     the cloth, dotted in the air, and the ghost ball, the object ball's
     line and the cue ball's deflection where the curve meets a ball. The
     opponent's spin is not relayed, so their preview of a massé is
     straight.
   - Hovering a ball with the mouse shows its number and group above it; on
     touch the label shows for 1.5 s after a tap.
   - The panel slot and the status line have fixed heights, so the table
     never jumps when panels swap or a sentence wraps; both cross-fade.
   - *Settings* (gear in the header): theme (system, dark, light), power bar
     on the left for left-handed play, vibration, full screen and "show
     hints again". Stored in `localStorage` under `pool:*`.
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

     Tapping that cue ball opens the *Spin, jump and fine aim* sheet over
     the bottom of the screen: the spin pad, the angle readout, its four
     buttons, the fine aim wheel and the jump slider (a brass ring round the
     small cue ball says the cue is raised). `placeShotOptions` moves those nodes there from the panel
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
     and holds the header too (the code and its buttons, the seats, the
     score), then the practice tools, then the call, the toggles and the
     cue-ball button: the table gets the whole height. `main.game` steps
     aside (`display: contents`) and the page is the grid. In Safari with
     its bars (about 844 × 340) the height is what limits the table, which
     is 12 % bigger so. The sheet opens at the top right.
   - **Turning the phone** in the middle of an aim, a pull or a carried
     ball stops it (`cancelGestures`): no shot, no placement, the ball goes
     back. The table turns under the finger, so where it goes next means
     nothing.
   - **No pull to refresh.** `overscroll-behavior: none` on the page: a drag
     down from the header or a panel does not reload it.
   - **No zoom, no selection.** `touch-action: manipulation` on the page
     and its buttons: a quick second tap (−0.25°, +0.25°) does not zoom.
     The header and the game column take pans only (`pan-x pan-y`), so a
     pinch there does not zoom the page either; the landing and the dialogs
     still can be. A finger held on the power bar, a button or the header
     selects nothing and opens no callout (`-webkit-user-select`, which is
     the only one Safari knows, and `-webkit-touch-callout`).
   - **Awake.** In a room the page holds a screen wake lock, so the phone
     does not dim and sleep (and drop the socket) while the opponent
     thinks. The browser lets it go when the tab is hidden; it is taken
     again when the tab shows, and given back on leaving.
   - **Full screen** where the page may ask for it (Android, desktops, not
     an iPhone): the header button (not on portrait phones, where the
     header has no room), Settings or `F`. On a phone it also holds the
     orientation it was entered in.
   - **Home screen.** `manifest.webmanifest` and the icons in `web/icons`
     (`icon.svg`, rendered to 192, 512 and the 180 px apple-touch-icon) let
     a phone add Pool to its home screen. It then opens standalone, without
     browser bars. Settings explains how on touch devices that are not
     standalone yet; it is the only full screen an iPhone has. The
   connection card appears only after 300 ms offline, with the retry backoff
   drawn as steps; a reload inside a room shows a splash after 150 ms.

## Sound

Ball on ball, the cue and a pocket are recordings (`web/sounds`, about
200 KB of 16-bit mono WAV, fetched once audio starts); a cushion is a
synthesized thump, and a ball coming down from a jump (`slate`) a shorter,
lower knock.

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
  shows the contact. One that would play over 120 ms late is dropped.
- **The strike** (`strikeAt`). The cue ball first moves on screen
  `RENDER_DELAY_MS` after the shot's first snapshot, so a network round trip
  plus 100 ms after the release: about 0.25 s on a phone's 4G. The cue's tip
  meets the ball and the click sounds at that very moment, for both
  players. From the release until the first snapshot your own cue stays
  drawn back where the power bar left it (`S.heldStrike`, a strike fx with
  an infinite delay); then it strikes, `STRIKE_HIT_MS` (80 ms) to the ball.
  The other player sees the same stroke from your last aim. A refused shot,
  or none after 2 s, takes the cue away. Before this, the click and the tip
  came at the release and the ball up to a quarter of a second later.
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

### Commentary

A commentator says a short line in Vietnamese after some shots, picked from
`web/voice/lines.json` (69 lines in 9 kinds), at most one every 3 s. The line
also shows as a caption over the table, also with the sound off. Replays stay
quiet.

Everyone in the room, players and spectators, hears the same line. There is
no extra message for it: every client draws the line, and whether one is
said at all, from a generator seeded by the shot's `settled` message (room
code, shooter, pocketed balls, final positions), which is the same for all
(`seeded`, `voiceFor`). The shot clock's lines are seeded by the `timeout`
message. Someone who leaves strong language out hears a clean line of the
same kind instead of a strong one.

| kind | when | how often |
|---|---|---|
| `break` | the break pockets a ball | always |
| `great` | two balls or more drop, or one that travelled more than 1.2 m | always |
| `nice` | one ball drops | 35 % |
| `miss` | nothing drops, no foul, no safety called by you, not a push out | 50 % |
| `scratch` | the cue ball drops | always |
| `foul` | any other foul | always |
| `win` / `lose` | the rack ends: the shooter won it / lost it (8-ball early, on a foul…) | always |
| `timeout` | a shot clock runs out | always |

Practice has no fouls, wins or losses, so only the shot lines and `scratch`
play there.

- **The lines** are trending phrases ("Đỉnh nóc, kịch trần, bay phấp phới!",
  "Ảo ma Canada!", "Ét o ét!", "Gét gô!"…). Those marked `strong` use strong
  language ("Cái đéo má…"). Settings → Sound → *Strong language* leaves them
  out; *Commentator* turns the voice off (`pool:voice:strong`, `pool:voice`).
- **The voices.** To be funnier each kind has a style, set in
  `scripts/make-voices.js`: good news (`break`, `nice`, `great`, `win`)
  high and quick like a cartoon (played back 1.3× faster), bad news
  (`miss`, `foul`, `scratch`, `lose`) deep and slow (0.78×), the shot clock
  sleepy (0.7×). A line in `lines.json` may name its own `style`.
- **The recordings.** Each line is `web/voice/<id>.m4a` (AAC, 32 kbit/s, about
  580 KB in all), fetched and decoded once audio starts. They are spoken by
  macOS's Vietnamese voice "Linh" (`node scripts/make-voices.js`), which
  Apple's licence allows for personal, non-commercial use. To use your own
  voice, record a line and save it over the file with the same name; the
  script keeps existing files unless run with `--force`. A new line is one
  more entry in `lines.json` (`id`, `kind`, `text`, `strong`) and its file.

## Spectators and chat

- **Watching.** A room lets up to its number of spectators watch: 0, 1, 3
  (the default), 5 or 10, picked under *Spectators* when creating it and
  changed by either player in Settings → Room. The room list shows *Watch*
  while there is room, and "2 watching" in the chip; an invite link to a full
  room offers *Watch instead*.
- **A spectator** (`S.spectator`, seat -1) sees everything the players see,
  the shooter's aim and the 3D camera included, under "Watching · 8-ball".
  There is no power bar and no shot panel, only the waiting panel; the
  Leave button leaves. A reload watches again (the session keeps `watch`).
- **Chat.** One thread for the room. The button at the left of the status
  line (or `C`) opens it: who is watching, the last comments (players with
  their seat colour, spectators with an eye) and a field of 200 characters.
  After each comment Send counts down the 5 s the server makes everyone
  wait. While the chat is closed new comments float over the top left of the
  table for 4 s and the button counts them; Settings → Chat turns the
  floating off (`pool:bubbles`). Comments are text only, never HTML.

## 3D view

The table can also be shown in 3D (`web/view3d.js`, Three.js r186). Settings →
*View* chooses 2D or 3D (`pool:view`), and so do the header's 2D/3D button and
the `V` key. Without a stored choice a desktop opens in 3D and a phone
(`compactLayout`) in 2D, where the flat table aims more precisely and spares
the battery.

- **Loading.** `view3d.js` is an ES module that `app.js` imports the first
  time 3D is turned on; it imports `vendor/three-r186/three.min.js`, Three.js
  bundled into one minified module (esbuild, from the npm package's
  `build/three.module.js`; MIT, its licence beside it). The versioned path is
  cached for a year, and the server gzips text files (190 KB on the wire).
  No WebGL 2, a failed load or a lost context: back to 2D with a notice,
  without storing the choice.
- **Split of work.** `view3d.js` only draws. `app.js` keeps the state and
  computes everything as for 2D (positions from `displayBalls`, rolling in
  `orient`, the guide from `aimGuide`, rings, effects) and hands
  `v3.render(frame)` a frame each animation frame. The 2D canvas lies over the
  3D one, transparent: it takes the pointer and draws the ball labels.
  `toTable` and `toScreen` go through the camera (`v3.pick` onto the plane of
  the balls' centres, `v3.project`), and sizes in screen pixels use
  `pxPerM(p)`, so the input code is the same in both views.
- **Table.** The cloth is the 2D table from above (`feltCanvas`, drawn by
  `drawTableStatic`) on a bed with the pocket holes cut out; cushions are the
  2D cushion quads raised 40 mm, the rail goes round the pockets, and a dark
  liner hangs under each hole. Two spot lights cast the shadows.
- **Balls.** Each ball's markings are painted once on a sphere texture in its
  own frame; the mesh turns by the 2D orientation, so a ball shows the same
  face in both views (axes: table x → world x, table y → world z, into the
  slate → world −y). A ball in the air is raised by its `z`, and the lamps
  cast its shadow on the cloth.
- **Cue.** It lies at 6° as a cue resting on a bridge would, or at the jump
  elevation when that is steeper. Raised more than 10°, the cue stands in
  front of the shot as seen from behind it, so it is drawn half transparent.
- **Camera** (`cameraFor`), easing between poses over about 0.6 s, cutting
  with reduced motion:
  - *aim*: behind the cue ball, looking along the aim (the opponent's aim on
    their turn). A sideways drag turns the aim (`turnAim`): the finger holds
    the butt, so a drag to the right swings the shot left (pointing in
    Settings → *Aiming* reverses it), 0.3° per px at the top of the table
    down to 0.03° at the bottom, near the butt;
  - *follow*: high and oblique over the balls that have moved, while a shot
    runs;
  - *top*: straight down, by the button at the stage's top right or `T`, and
    by itself with ball in hand, while a ball is carried and with the
    practice Move tool; aiming there is the 2D drag;
  - *overview*: three quarters, in the lobby and after a rack.
- **Speed.** Pixel ratio at most 2, and lower where that would draw more
  than 3.5 million pixels (a laptop window at 2× is about 5 million). From
  the tenth frame (the first ones compile shaders) the pace is checked a
  window at a time (90 frames, or 2 s). A median over 25 ms makes the
  shadows hard and the pixel ratio 1, and stops the checks
  (`v3.lowQuality`). Otherwise, if over a fifth of the frames miss the
  screen's refresh (taken as their shortest tenth), the pixel ratio drops by
  0.25, down to 1. It never steps back up. That is *Auto*; see Graphics.

### Graphics

Settings → *Graphics* (`pool:quality`, `setQuality`) picks how much the
device draws. *Auto*, the default, is the behaviour above: sharp, stepped
down by `checkPace` and `checkSpeed` when frames come late. The other three
are fixed and never step:

| | 2D pixel ratio | 3D pixel ratio, pixels | 3D shadows | Frames |
|---|---|---|---|---|
| Auto | 3, stepped down | 2, 3.5 M, stepped down | soft, 1024 | every one |
| High | 3 | 2, 8.3 M | soft, 2048 | every one |
| Medium | 2 | 1.5, 2.5 M | soft, 1024 | every one |
| Low | 1 | 1, 2 M | hard, 512 | about 30 a second |

All capped by the screen's own ratio. `QUALITY_DPR` in `app.js` holds the
2D side, `LEVELS` in `view3d.js` the 3D side (`v3.setLevel`, read back by
`v3.quality`). Low spaces frames `LOW_FRAME_MS` apart in both views. A note
under the choice says what it does.

### Replay

Each shot is recorded from its first snapshot (`S.rec`; a shot joined midway
is not) and kept when it settles (`S.lastShot`). The replay button at the end
of the status line, or `R`, plays it again here only, in either view, at half
speed: the cue draws back and strikes, then the balls run with their sounds and
pocket drops. In 3D the camera chases the cue ball to its first contact, then
the object ball that moves most in the next 0.4 s. A press or a key ends it
(that press does nothing else), as does a new shot. The record is dropped when
the object balls change other than by a shot (a new rack, an undo, a ball
moved in practice).

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
- Pixel ratio up to 3. A slow device steps it down (`checkPace`): the
  drawing itself is timed, not the gap between frames (a phone in low power
  mode stretches that to 33 ms on its own), and when the median of 60
  frames is over 8 ms the ratio drops by half, to 1 at least, never back up.
- At rest the flat table is drawn four times a second (`skipFrame`):
  nothing on it moves by itself, so when no shot, replay, effect, drop,
  carried ball or finger is under way and no input or message has come for
  3 s, frames are skipped. A phone waiting for the opponent then spares its
  battery and stays cool. Any touch, key, wheel, message or resize draws
  every frame again at once. 3D draws every frame: its camera glides.
- While a shot runs, `snapshot`s are kept in arrival order and the frame drawn
  is `RENDER_DELAY_MS` (100 ms) behind the newest one, interpolating between
  the two surrounding snapshots. A ball missing from the later snapshot stays
  at its earlier position until that snapshot's time passes, then disappears:
  into the nearest pocket, or, last seen past a cushion and away from every
  pocket, off the table (in 2D it fades out beyond the rail; in 3D it
  comes down onto the rail, rolls off its outer edge and falls to the floor).
  `settled` replaces everything with exact positions. After a reconnect in
  the middle of a shot the clock is re-aligned to the first snapshot received.
- A ball in the air (`z` in the snapshots, interpolated like `x` and `y`)
  is drawn over the others and bigger the higher it is, up to twice its
  size at 45 cm, its shadow falling further off, larger and fainter.
- Legal first-contact balls and whether the 8-ball is on are computed
  client-side with the same rules as the server (`legalTargets` and
  `eightOn` mirror `Rules.legalTarget` and `Rules.eightOn`); the server still
  validates every shot.
