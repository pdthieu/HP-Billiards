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

The game, 8-ball, 9-ball or 3-cushion, is picked with a three-button switch
above *Create a room* (remembered in `localStorage` as `pool:mode`); under
it the table and its cloth (see Tables).

Inside a room, Settings (the gear on the scoreboard) opens on its *This
room* tab, beside *Table*, *Controls* and *Sound & chat*. Nothing of the
match changes there: the game, the table, the cloth and the race stay as
the room was made on the landing, for every match in it. The tab only lets
others in:

- the room's card as the room list shows it (its table and cloth in
  miniature, the code, the game, the race and the table, who watches),
  with *Copy invite link* (*Share invite link* where a phone has a share
  sheet);
- *Spectators*, how many may watch and comment (the players' pick; a
  spectator only shares the link).

Practice has no *This room*. The lobby panel keeps *Copy invite link* while
the player waits alone. The server still takes `set_mode`, `set_table` and
`set_match` (PROTOCOL.md); the client no longer sends them.

## Tables

A room plays pool on one of four real tables, which differ in their pockets
(PROTOCOL.md, "Tables", has the figures and where they come from): *Diamond
Pro-Am* (corners 4.5″, sides 5″, the default), *Predator Apex* (108 mm,
125 mm), *Rasson Victory II* as cut for the Mosconi Cup (4.25″, 5″) and
*Mr-Sung Acurra* with its Matchroom pockets (4″, 4.5″). The picker shows
each with its pockets; the client lays them out from `TABLES` (in step
with the server's `game.Tables`), so the 2D table, the aim guide's pocket
calls and the 3D holes are the server's. 3-cushion is always on the carom
table: the picker hides there, and the room keeps its table for its pool
games.

Each table is drawn as it is finished (`LOOKS`): Diamond walnut rails on a
black cabinet and six tapered legs; Predator all matte black with flush
silver rims round the pockets and light inside its four legs; Rasson
glossy black with a silver trim along the rail, on a V under each end;
the Acurra grey wood with aluminium strips, on an A under each end. 2D
draws the rail's colours, the trim, the rims (where they cut the rail) and
the sights; 3D the rest. The carom table keeps the wood the game always
had.

The cloth (`CLOTHS`) is one of eight Simonis colours, the same for everyone
in the room: Tournament Blue (the default), Electric Blue, Blue Green,
Spruce, Simonis Green, English Green, Slate Grey and Burgundy, shown as
swatches with the picked one named. No maker publishes colour values, so
the shades are matched to the swatches by eye; the middle of the table is
drawn lighter and its edge and the cushions darker (`clothShades`). In 3D
the lamps light the cloth to two or three times its colour, so its
texture is darkened (`CLOTH_LIGHT`) to look like its swatch under them; a
new cloth repaints the 3D cloth in place (`v3.setCloth`), a new table
builds the view again.

On the landing both pickers are remembered (`pool:table`, `pool:cloth`);
the hall at the top of the home page draws the pick, racked, and the game
table behind the page takes it too, empty. Each room in the room list
shows its table and cloth in miniature and names the table, the lobby line says
"8-ball on a Predator Apex, first to 3 racks", and the arena's LED boards
name it in their small print.

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
- the seats carry no ball dots (both players shoot at the same balls): the
  table shows what is left, the call line what to hit.

In 3-cushion (eyebrow "3-cushion room") the table is the carom one: 2.84 ×
1.42 m of blue cloth, no pockets, a diamond in the middle of each long rail
too, and the starting, side, centre and top spots marked. `setTable` swaps
the geometry (`W`, `H`, `R`, the cushions, `NOSE_H`) when a `room_state`
brings another game, and rebuilds the 3D view. The balls are plain white,
yellow and red with six dots each (no numbers). Then:

- each player aims their own ball (`cueId()`: `carom.cue[turn]`), the
  breaker the white; a small dot of that colour sits on each seat, and the
  hover label says "yellow · yours";
- the call line says what the shot needs: the red first on the break, then
  "Your ball: yellow · both balls, three cushions before the second", and
  "Last inning: reach 15 to draw the game" in the equalizing inning;
- the status line says "Point! 4 cushions, a run of 3." or why not ("only
  2 cushions before the second ball", "the second ball missed"), and when
  balls went back on their spots;
- the match dialog (a tap on the score) has one line per player with their
  ball: points of the target, innings, average and high run, and the run
  in progress;
- the score on the scoreboard is the points ("7 – 5, to 15"); a drawn game
  reads "A draw".

Its race is in points: quick picks 10 · 15 · 20 · 25 · 30 · 40 or 1 to 50
in the field, remembered as `pool:points` (default 15); the break rule is
hidden, a match being one game.

Rooms play matches. The landing's match rules (folded under a line that
sums them up) have the race: quick picks 1 · 3 · 5 · 7 · 9 or any number
from 1 to 25 in the field next to them (Enter commits, never submits the
form). Below it is the break rule, *Alternate* or *Winner breaks*. Both are remembered as `pool:race`
(default 3) and `pool:breaks`. The room list chip adds "race 5".

- **The next match** is the room's own, as it was made: Settings does not
  change it. The lobby line and the game-over note say what it is.
- **The score** on the scoreboard, between the seats, reads "2 – 1, race
  to 5" (the race in LED brass) and is a button.
  - A digit that goes up ticks: the old digit slides out, the new one
    springs in and stays brass for 1.2 s.
  - Clicking the score opens the match dialog: the score, and one row per
    finished rack with its number, winner, the running score, why it ended
    and who broke.
  - The dialog opens by itself when the match is won, after the result
    banner, or at once on a forfeit. A race to 1 does not open it.
- **Game-over panel.**
  - Between racks: "You win the rack", the score and who breaks next, and
    *Next rack*.
  - After the match: "You win the match 5–3", the next match (the room's
    game and race, who breaks first) and *New match*. A race to 1 keeps
    *Rematch*.
- **Leaving.** The scoreboard has a Leave button (an exit icon) after
  Settings.
  - During a match it asks first: "Leave and forfeit the match?", showing
    the score, with *Stay* and *Leave and forfeit*.
  - Otherwise it leaves at once.
  - Leaving sends `leave`, so the seat is freed immediately. The player
    who stays gets "Ann left. You win the match 2–1." and the match dialog,
    and waits in the lobby: "Ann left the room."
- **The scoreboard** (design/README.md, "In game") is dark in both themes,
  as the hall round the table is: the room in LED type on the left ("8-BALL
  ROOM · QXRTA"), the two seats either side of the score (the second one
  mirrored, so each clock ring sits by the score), the 2D/3D switch,
  Settings, full screen and Leave on the right.
- **Phones.** Held upright, the scoreboard holds the seats either side of
  the score with Settings and Leave at its end, and in the lobby the room
  code at its start; while a rack is played the code steps aside (Settings
  → This room has it) and Leave starts the row, so the seats have the
  width (see **Phones** below). The 2D/3D switch sits by Settings, except
  on a 340 px phone or narrower, where Settings → Table alone has it. On a
  320 px phone the seat on turn shows it by its brass alone.
- **Tablets and narrow windows** (601 to 1099 px wide): one row cannot hold
  what to hit, the aim, the spin and the jump, so the dock takes two rows
  (what to hit and its buttons over the aim, the spin and the jump) in a
  188 px slot, the same for every panel. Up to 959 px the scoreboard shows
  the code without the room's name and leaves out the "your turn" words
  (the seat's brass says it) and full screen (Settings has it). The
  keyboard hint shows from 1400 px, beside the call's toggles.

*Practice alone* on the landing page opens a private practice room of the
picked game, on the picked table and cloth. It is free play, without the tournament rules:

- no fouls, turns, calls or end;
- every ball that drops stays down, and a scratched cue ball comes back to
  the head spot;
- the call line reads "Free play: any ball, any pocket";
- the status says what dropped, or "Table cleared!";
- the header shows the one player, with no score and no second seat;
- there is no shot clock.

A toolbar
between the table and the dock (at the head of the side column on
landscape phones, icons only on phones) has:

- *Undo* (`Z`): take back the last shot, up to 20;
- *Move balls* (`M`): while on, dragging any ball moves it instead of
  aiming; with it off the cue ball can still be dragged anywhere at any
  time;
- *Rack*: a fresh rack of the same game (another game is a new practice
  from the landing);
- *Leave*.

1. **Landing**: the name field is prefilled with the last name used (kept in
   `localStorage`) or, the first time, a random one such as "Brisk Otter"; a
   shuffle button suggests another. The live room list (`GET /api/rooms`,
   refreshed every 3 s while the landing is open) keeps rows keyed by room
   code, offers *Join* on rooms with a free seat and *Watch* (an eye on a
   narrow list) while spectators fit, and shows the others as full; *Create
   a room* is disabled with a note once the server's limit is reached.
   Opening `/?room=CODE` turns the landing into a "Join room CODE" form that
   names the host; after joining, the URL is rewritten to that form so the
   invite button gives a link (it shares on phones). The gear at the top
   right opens Settings before any room is joined.

   The landing is the **home page** (design: `design/README.md`, "Home";
   sources in `design/home/`), a page of its own over the game, opaque, so
   the header and the table behind it are hidden. It only ever scrolls up
   and down: nothing in it is wider than the screen (`landing.js` checks the
   three shapes).
   - *The hall* (`renderHall`, `drawTablePreview`): the table of the room
     to be, under its lamp on the arena's carpet, dark in both themes. Its
     name, the cloth and the pockets; an LED line with the game and the
     race ("8-ball · race to 3"); the table itself, drawn in CSS from
     `TABLES`, `LOOKS` and `CLOTHS` (rails in their finish, Rasson's trim,
     Predator's rims and the light under it, the cloth lit in the middle,
     the pockets as cut, the sights) and racked for the game; on a desktop
     a line of specs (rules, corner and side pockets, spectators). Every
     pick redraws it. On an invite it shows the room's own table, once the
     room list names it.
   - *Shapes.* On a desktop or a tablet (wider than 600 px and taller than
     500 px): a bar (the wordmark, a *Rooms* pill that jumps to the rooms,
     the gear), the hall beside the *New room* card (from 960 px; one
     column below), the rooms below them as cards with *Join by code* on
     their title line. On a phone held upright (600 px or narrower): the
     name rides in the top bar as a chip, the hall sits on top, *New room*
     and *Rooms* are two tabs (`setHomeTab`, `data-tab` on the form) and
     their buttons dock at the foot of the screen (*Create a room* and
     *Practice alone*, or the code and *Join*). On a phone on its side (500
     px tall or less): the bar, the hall and the two buttons on the left,
     the hall's table as big as the height allows; the tabs on the right
     over a pane that scrolls, with *Join by code* pinned at its foot.
   - *Game, table and cloth.* A card per game with its rack in miniature
     and its rules (WPA, UMB), a card per table with its finish and its
     pockets (replaced by a note for 3-cushion) and a swatch per cloth (see
     Tables).
   - *Match rules.* The race, the break rule and the spectators fold under
     one line that sums them up ("Race to 3 · alternate breaks · 3 may
     watch"), on every screen, so *Create a room* stays in view under the
     table and the cloth; a tap opens them.
   - *The rooms.* Each room shows its table and cloth in miniature, its
     code, what is played ("8-ball · race 5 · Predator Apex"), its state
     (lobby, playing, finished), who plays with the score between them
     (`score` in the room list) or who waits, and how many watch. Cards on
     a wide list; on a narrow one (a container query on the list's own
     width) a row a room, the code and the names on one line, the state
     and the game under them.
   - Enter in the name field joins on an invite or with a code typed;
     otherwise it only puts a phone's keyboard away. A code that is not 5
     letters is marked under its field. On a touch screen the name field is
     not focused by itself, so no keyboard covers the page.
2. **Lobby**: both seats shown in the header; the rack starts when both press
   *I'm ready*. Once groups are assigned a seat shows seven dots for the
   player's balls, dimmed as they are pocketed; the seat on turn pulses
   (paused while balls roll); an offline seat shows the 60 s hold ring.
   The player who must act has the shot clock beside their name, a brass
   ring with the seconds left that turns red for the last 10 s, when the
   shooter also gets a "10 seconds left" toast. The ring counts from the
   arrival of the server's `left`, so the two machines' clocks never mix.
   The decision dialog repeats the countdown and names the option taken
   when it runs out.

   **Your move** (`renderTurn`, `hurry`). The player who has to act, a shot
   or a decision, is told beyond the seat's pulse; the other player and
   spectators get none of this:
   - when it becomes their move the table gets a gold light (flashing,
     then steady for the whole turn), "Your turn" crosses the table for
     1.6 s (with "ball in hand" or "choose how to continue" under it), a
     two-note chime plays, a phone buzzes (Settings → *Haptics*), and a
     tab in the background is titled "● Your turn · Pool";
   - in the clock's last 10 s the light turns red and pulses, each second
     ticks and the phone buzzes once; a background tab counts the seconds
     in its title;
   - in the last 5 s the light pulses twice as fast, the ticks are higher
     and louder, the seconds count down in large type over the table, the
     phone buzzes again and the commentator hurries them (`hurry`).
   A paused clock is silent. With reduced motion the light only changes
   colour. A `timeout` is shown as a toast and in the status
   line ("Bob ran out of time. You have ball in hand.").
3. **Your shot** (shot panel visible):
   - *Ball in hand*: drag the cue ball. The kitchen is highlighted when
     placement is limited to it and the drag is clamped there. The position is
     sent as `place_cue` on release and shown until the server confirms it.
     In 3D the camera stays behind the cue; a press on the cue ball picks it
     up and looks down on the table while it is carried (see *3D view*).
   - *Call*: object balls are not called; the line above the panel says
     whose group you shoot (legal first-contact balls are ringed in white).
     Once the 8-ball is your target the pockets light up: tap the one you
     are going for (a press that moves more than 8 px or lasts over 250 ms
     aims instead); the called pocket is ringed in brass and named in the
     line. *Safety* (or the `S` key) declares a safety instead. *Clear*
     starts over. *+40s* (or the `X` key) spends the game's one extension
     and is hidden once used.
   - *Next ball*: a brass arrow bobs over the ball to shoot next, ringed in
     brass (`pointerBall`): in 9-ball the lowest ball, in 8-ball the ball
     of your group nearest the cue ball, or the 8 once your group is gone.
     There is none on the break, on an open table or in practice, and only
     the shooter sees it. The cue starts aimed at the same ball. It bobs for
     2.5 s as the turn begins, then holds still. Settings → Controls →
     *Next-ball pointer* turns it off (`pool:pointer`).
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
   - The game screen stands in the hall: the band with the status line
     over the table, the stage, the dock under it (one card, 100 px on a
     desktop, for every panel), all dark in both themes but the dock, which
     follows the theme (`.on-hall` in tokens.css takes the dark values back
     for the scoreboard, the band, the stage and the practice tools).
   - The dock and the band have fixed heights, so the table never jumps
     when panels swap or a sentence wraps; both cross-fade.
   - *Settings* (gear on the scoreboard, or on the landing page) is a sheet
     in four tabs: *This room* (in a room, not in practice), *Table* (view,
     graphics, theme), *Controls* and *Sound & chat*; *Done* stays at the
     top while the tab scrolls under it, and it opens on the tab picked
     last (else the first there is). In a room the hall gives way to it
     beside the table (380 px on a desktop or a tablet, a card of 344 px in
     a sideways phone's column) or under it (a phone held upright: up from
     the bottom, the table lying across the strip of hall left over it):
     the table shrinks and stays in view, out of reach (`main.game` is
     inert) and the game keys wait (`body.is-settings`), and the dock, the
     practice tools and the power bar step aside until *Done*, Escape or
     the gear again. Over the landing it lies on a scrim. Each on/off
     setting is a row with a switch at its end. Theme (system, dark,
     light), power bar on the left for left-handed play (on the right, held
     upright), vibration, full
     screen and "show hints again". Stored in `localStorage` under
     `pool:*`.
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
   - **Portrait.** The table stands upright unless lying down is 5 % bigger.
     Without a margin, Safari's bars growing or shrinking cannot flip it.
   - **The table first** while a rack is played (`body.is-playing`) on a
     phone held upright (`phoneLayout`). The four things a shot needs are
     always out, in reach of a thumb: the power bar, the fine aim wheel,
     the jump slider and the small cue ball for spin. `phoneMode` lays the
     rack out in whichever of two ways leaves the table bigger, worked out
     from the screen alone, so neither Settings nor a panel coming and
     going swaps it:
     - *A dock* (`body.phone-dock`, a tall screen: 390×800 and taller):
       only the 16 px power bar stands beside the table (360×671 px on
       390×844). Under it a 76 px dock holds the fine aim wheel over the
       jump slider, the angle and the jump's words before them, and a 62 px
       cue ball beside both; while it is not my shot it says whose shot it
       is. The scoreboard takes a second row: each side's seven balls
       (`#trayL`, `#trayR`, 18 px and numbered) under its player.
     - *Columns* (`body.phone-side`, a short screen such as Safari with its
       bars: 393×670): height runs out first. The scoreboard keeps to one
       row, and the stage is a grid with a column either side of the table
       (312×582 px on 390×664): side A's balls over the 16 px power bar on
       the left; side B's balls, the cue ball, the jump slider and the fine
       aim wheel, both upright, on the right (`jog--v`: dragging down turns
       clockwise, as right does lying down). The tools hide while it is
       not my shot.
     - The power bar's grip runs on to the screen's edge and over the
       table's wood. The balls drop out of their tray as they are pocketed,
       the 8 shows once the group is gone, and the tray of the side on turn
       is lit; trays show in 8-ball only.
     - Settings → *Power bar on the right* (lefty; it reads so held
       upright) moves the bar to the other side, and on a short screen the
       tools' column with it.
     - *The band over the table* shows the last shot's result for 2.5 s
       (`holdStatus`), then, while it is my shot, what to hit with the
       toggles (Safety, Push out, +40s, Clear; `statusCall`).
     - *The header* holds a card per player: the initial in a disc of the
       side's colour (two discs for a 2v2 side) and the name; the shot clock
       rings the disc, its seconds under the name. Leave starts the row,
       the 2D/3D switch and Settings end it, and the game and the score sit
       between the cards (on one row the game shares the race's line). The
       balls under the cards give a little on a narrow phone, so a 360 px
       screen still holds all seven.
     - *Practice*: Undo, Move balls, Rack and Leave open as a list from the
       menu button at the start of the header (`#menuBtn`).

     `placeShotOptions` moves the pieces (the call line into `#status`; on
     a short screen the cue ball, the jump slider and the wheel into
     `#sideTools`; over a dock the trays into the header) and back when the
     phone turns. Sideways, see *Landscape phones* below.

     A drag on the small cue ball carries the spin's dot with the finger,
     from where it was. A tap opens the spin picker (`#spinPop`): the spin
     pad as a big cue ball in the middle of the screen (up to 280 px) over
     the table, dimmed and lightly blurred, with the spin's words, Reset
     and Done. `placeShotOptions` moves the spin pad there from the panel
     whenever the phone layout applies. Done, Escape or a tap on the dimmed
     table beside it puts it away; that tap does not aim.
   - **Small balls.** A ball under 24 px across (every phone, a tablet
     held upright, a small window; design/canvas-spec.md, "Small balls") is
     drawn to be read: a bigger number disc whose number stands upright in
     the condensed face, a lighter shade at the edge so the colours stay
     apart (the 3 and the 7, the 2 and the 4), and a rim of light so a dark
     ball stands off the cloth.
   - **Naming balls.** A number on the ball's edge still does not read,
     so:
     - a touch within a fingertip (22 px) of a ball names it for 2 s, with
       a swatch of its colour, at any time, the other player's turn
       included;
     - while aiming, the ball the shot hits first carries a small tag
       beside it, across the line of the shot, so the cut is never played
       on the wrong ball.
   - **Lobby and game over** keep the 134 px slot, so the table resizes
     only at the start and end of a rack. On an iPhone in Safari
     (393 × 670) balls are about 10 px. Toasts drop from under the band,
     as they do on a desktop or a tablet (at the bottom they covered the
     dock).
   - **Dialogs** taller than the screen scroll, from their top.
   - **Landscape phones** (`body.phone-land`, `phoneMode`) play a rack with
     the table first too (design/README.md, "In game"):
     - the 16 px power bar at the left edge, under the left thumb (its grip
       runs to the edge and over the table's wood);
     - the table lying down, with nothing over it;
     - one 128 px column on the right, which holds, from the top:
       - the room's buttons: Leave, chat, replay, 2D/3D and Settings;
       - a card per side (the initial, the name, the side's score, the
         shot clock ringing the initial), each over its side's numbered
         balls;
       - the game and the race;
       - the band: the last shot's result, then what to hit with its
         chips (`statusCall`, as held upright);
       - at the foot, under the right thumb, the dock: the angle, the cue
         ball (a drag moves the spin's dot, a tap opens the big pad), the
         fine aim wheel and the jump. While it is not my shot the dock
         says whose shot it is.

     On 844 × 390 the table is 678 × 364, and inside an iPhone's safe area
     (about 750 × 369, from the home screen) 584 × 313. The column tightens
     at 380 px tall. At 360 px (Safari with its bars) it drops the trays:
     what to hit names the group.

     `main.game` steps aside (`display: contents`) and the page is the
     grid. `placeShotOptions` moves the call line into the band, and the
     trays and the band's chat and replay buttons into the header. Settings
     takes the column's place as a card, and the cards and the score fold
     to one line over it. In the lobby and at the game over the header is
     a 44 px row and the shot panel a sidebar, as before. A dialog is
     smaller there and the decision's options sit side by side. The spin
     picker lays the big cue ball beside its words and buttons.
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
     an iPhone): the scoreboard's button (not where it has no room: a
     phone held upright, a sideways one mid-rack, under 960 px wide),
     Settings or `F`. On a phone it also holds the
     orientation it was entered in.
   - **Home screen.** `manifest.webmanifest` and the icons in `web/icons`
     (`icon.svg`, rendered to 192, 512 and the 180 px apple-touch-icon) let
     a phone add Pool to its home screen. It then opens standalone, without
     browser bars. Settings explains how on touch devices that are not
     standalone yet; it is the only full screen an iPhone has. The theme
     colour, which the status bar there takes (and Android's, and
     Safari's bars), is the home page's own surface on the home page and
     the hall's in a room (`syncThemeColor`), so no lighter band hangs over
     the dark game. The
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
`web/voice/lines.json` (59 lines in 10 kinds), at most one every 3 s and
never over a line still being said. It is
only heard: nothing is written over the table. Replays stay quiet.

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
| `hurry` | 5 s left on your shot clock; only you hear it, so it is not seeded | always |

Practice has no fouls, wins or losses, so only the shot lines and `scratch`
play there.

- **The lines** are clips of the streamers Độ Mixi (11, `"clip": "mixi"`)
  and PewPew (17, `"clip": "pewpew"`), and 31 short comedy clips of other
  Vietnamese personalities (`"clip": "tiengdong"`, who says it in `by`). A
  kind with no line stays silent. Those marked `strong` use strong language. Settings → Sound → *Strong
  language* leaves them out; *Commentator* turns the voice off
  (`pool:voice:strong`, `pool:voice`).
- **The recordings.** Each line is `web/voice/<id>.m4a`, fetched and decoded
  once audio starts. The clips were downloaded from tiengdong.com (tag "Độ
  Mixi sound effects", "PewPew sound effects", "Câu nói Viral Việt Nam"),
  trimmed to the speech, faded in 10 ms and out 80 ms, evened out to about
  −17 LUFS, and saved as mono AAC 22.05 kHz, 40 kbit/s (about 1.2 MB in all;
  a clip longer than about 5 s keeps its first 5 s). They are their voices,
  used here for fun: ask their permission before using them in anything
  public or paid. A new line is one more entry in `lines.json` (`id`,
  `kind`, `text`, `strong`, `clip`) and its file.
- **Spoken lines.** A line without `clip` is spoken by macOS's Vietnamese
  voice "Linh" (`node scripts/make-voices.js`, personal non-commercial use
  under Apple's licence), in a style per kind (`STYLES`, `KIND_STYLE`; a
  line may name its own `style`). The script never records over a clip.

  | id | kind | clip (tiengdong.com title) |
  |---|---|---|
  | `great-15` | great | Ui Sợ quá sợ quá Phải band nó thôi |
  | `great-16` | great | Hoang đường Ảo tưởng Hư cấu Vô lý |
  | `great-17` | great | WOW, Amazing… (the first two words only) |
  | `nice-12` | nice | Bạn thì Kinh rồi |
  | `nice-13` | nice | Đúng này, Tất cả đều đúng, Hợp lý |
  | `nice-14` | nice | Ui Kinh thế, Hiểu biết thế |
  | `miss-14` | miss, strong | Meme Quê VL |
  | `foul-06` | foul | Tao lạy mày |
  | `scratch-05` | scratch | Tiếng Cười |
  | `lose-07` | lose | Cay ê Lêu lêu Cay |
  | `lose-08` | lose, strong | Dm Cay thế nhờ |

  | id | kind | PewPew clip (tiengdong.com title) |
  |---|---|---|
  | `break-05` | break | Ghê ghê ghê… (the first 4 s) |
  | `nice-15` | nice | Quá chuẩn luôn |
  | `great-18` | great | Nó ở cái tầm chất |
  | `great-19` | great | Xạo chó PewPew nói |
  | `great-20` | great, strong | Tin chứ, Tin thế đéo nào được |
  | `win-10` | win | Vỗ tay PewPew (the first 4 s) |
  | `win-11` | win | Quá tuyệt vời (the first 4 s) |
  | `lose-09` | lose | Lộn cái bàn, Ok |
  | `miss-15` | miss | Tiếng PewPew cười Hahaha (the first 3.6 s) |
  | `foul-07` | foul | Tao lạy mày – PewPew |
  | `foul-08` | foul | Mày bị điên à |
  | `scratch-06` | scratch | Tao là ai Đâu là đây |
  | `scratch-07` | scratch, strong | Thề luôn, Nhiều khi mình đéo thể hiểu được |
  | `timeout-04` | timeout | Hello bạn nhỏ, Lâu rồi mình không gặp nhau |
  | `timeout-05` | timeout | Hi chào cậu |
  | `hurry-10` | hurry, strong | Nói nghiêm túc Đéo đùa đâu |
  | `hurry-11` | hurry, strong | Pewpew bố mày nhờn với mày đấy à |

  | id | kind | who | clip |
  |---|---|---|---|
  | `break-06` | break | Bà Tân Vlog | Chạy đi các cháu ơi, nổ rồi! (the first 5 s of 25 s) |
  | `break-07` | break | Tiến Bịp | Trông khét đấy nhể! |
  | `nice-16` | nice | Tiến Bịp | Cũng ra gì đấy! |
  | `nice-17` | nice | Tiến Bịp | Nghe có vẻ sành sỏi quá nhỉ! |
  | `nice-18` | nice | Phú Lê | Được, hảo hán, hảo hán! |
  | `nice-19` | nice | Linda | Thả tim! |
  | `great-21` | great | Linda | Phong độ chỉ là nhất thời, đẳng cấp mãi mãi, cưng à! |
  | `great-22` | great | Huấn Hoa Hồng | Ối dồi ôi! |
  | `great-23` | great, strong | JVevermind | Đéo tin! |
  | `great-24` | great, strong | Bomman | Ui dời ơi, dễ vl! |
  | `miss-16` | miss | Linda | Rồi các bạn thấy quê không? |
  | `miss-17` | miss | Mimosa Chu | Thôi toang! |
  | `miss-18` | miss | Tiến Bịp | Còn cái nịt! |
  | `miss-19` | miss | Tiến Bịp | Không có đâu! |
  | `foul-09` | foul | Bác Gấu Vlog | Cái gì vậy trời! |
  | `foul-10` | foul | Tiến Bịp | Tham lam! |
  | `foul-11` | foul | meme | Đó là biểu hiện của sự lươn lẹo! |
  | `foul-12` | foul | Thy Thanh Phạm | Xảo trá! |
  | `scratch-08` | scratch | Linda | Áaaa… chết chị rồi em ơi! |
  | `scratch-09` | scratch | Linda | Cái gì vậy bà nội! |
  | `win-12` | win, strong | Bomman | Tao là bố chúng mày! |
  | `win-13` | win | Linda | Không có đủ level nói chuyện với chị đâu ha! |
  | `win-14` | win | Huấn Hoa Hồng | Có làm mới có ăn! (the first 5 s of 7 s) |
  | `lose-10` | lose | Rambo | Nói thế thì chịu rồi! |
  | `lose-11` | lose | Tiến Bịp | Xách ba lô và đi! (the first 5 s of 8.5 s) |
  | `lose-12` | lose | Linda | Em tha lỗi cho chị nha! |
  | `timeout-06` | timeout | Linda | Trời đất ơi, chị chờ cưng nãy giờ nè! |
  | `timeout-07` | timeout | Bác Gấu Vlog | Hello thằng em! |
  | `timeout-08` | timeout | Kenny Sang | Hello mấy cưng! |
  | `hurry-12` | hurry | meme | Rén rồi thì nói đi cưng! |
  | `hurry-13` | hurry | Zeros | Mày dậy mày múa nữa đi! (the first 5 s of 8.3 s) |

## Languages

The page speaks English or Vietnamese (`web/i18n.js`). The first visit
follows the browser (a `vi` language → Vietnamese, anything else English);
*EN · VI* in the home page's bar and Settings → Table → *Language* switch at
once, without a reload, and the choice is kept (`pool:lang`). Each player
reads their own language: two players in one room may differ.

- **The English text is the key.** A sentence in `app.js` is a tagged
  template, `` T`${who} breaks` ``, whose key is `"{0} breaks"`; `VI` maps it
  to `"{0} phá bi"` (values may move). English shows the code's own words,
  so the English page is unchanged by the translation. A sentence is whole:
  where English agrees a verb with its subject (`You break` / `Bob breaks`)
  both are keys, and Vietnamese says them alike. A string kept in a table is
  marked `N('...')` and shown with `tr()`. One English word with two
  meanings takes a context, `T`Game|match``, which English drops.
- **The page's own words** (index.html: text, `aria-label`, `title`,
  `placeholder`, `aria-valuetext`) are read in English once at start and set
  in the language shown (`collectStatic`, `applyStatic`); `translate="no"`
  keeps the wordmark. `setLang` sets them again and redraws what the code
  wrote (panels, header, room list, the hall, Settings, the 3D boards via
  `arenaInfo().words`). The status band keeps its line until the next event.
- **The server's words**: errors and close reasons are English on the wire;
  in Vietnamese the client says them from the code (`ERR_TEXT`,
  `CLOSE_TEXT`). Player names, table and cloth names (brands) and the game
  names (8-ball, 9-ball, 3-cushion) are not translated. Pool terms the
  players use stay as they are: Safety, Push out, Massé.
- **Adding a sentence**: write it with `` T`...` `` (or `N('...')`) and add
  its line to `VI`. `node e2e/i18n-keys.js` lists the keys `VI` lacks; the
  `i18n` scenario fails on any, on a line whose `{n}` values or tags differ
  from its key, and on a sentence shown without a line
  (`window.__i18nMissing`).

## Teams (2v2)

8-ball and 9-ball can be played two against two (PROTOCOL.md, "Teams"):
*Players → 2 v 2* under the match rules when creating a room (not for
3-cushion; remembered as `pool:players`). 9-ball doubles are scotch
doubles: partners alternate every shot, and the call line on a desktop says
so. Seats 0 and 2 are Team A, 1 and 3 Team B.

- **The lobby** shows both teams under the message (`#lobbySeats`), with
  *Sit here* on each free seat (`sit`): that is how players pick their
  team. *I'm ready* shows once all four are in; the rack starts when all
  four are ready. The invite stays on show until the room is full.
- **The header** keeps one cell per side (`#seat0`, `#seat1`,
  `renderTeamSeat`): both names, the cue by the one who shoots, the side's
  group and the shot clock. On a phone the names are smaller and the tags
  are left out.
- **Turns** go round A1 → B1 → A2 → B2. In 8-ball whoever pockets shoots
  on; in 9-ball the partner shoots next after every shot, and after a pass
  back the pusher's partner shoots. Only the
  player whose turn it is gets the shot panel, the power bar, the pointer
  and the "Your turn" cue; the teammate's waiting panel says "Bob's turn
  (your team)". Results name teams: "Your team wins the rack", "Bob & Dan
  win the match".
- **Leaving** while the teammate stays asks "Leave the match?": the teammate
  plays on alone for the side. A player who drops out has their seat held
  as in a room of two; the waiting panel counts it down when it is their
  turn.
- In code, who acts is a seat and what a team owns is by side
  (`sideOf`, `mySide`, `isMySide`, `teamName`, `sideDoes`); in a room of two
  the seat is the side, so 1v1 reads the same.

## Spectators and chat

- **Watching.** A room lets up to its number of spectators watch: 0, 1, 3
  (the default), 5 or 10, picked under *Spectators* when creating it and
  changed by either player in Settings → This room. The room list shows *Watch*
  while there is room, and "2 watching" in the chip; an invite link to a full
  room offers *Watch instead*.
- **A spectator** (`S.spectator`, seat -1) sees everything the players see,
  the shooter's aim and the 3D camera included, under "Watching · 8-ball".
  There is no power bar and no shot panel, only the waiting panel; the
  Leave button leaves. A reload watches again (the session keeps `watch`).
- **Chat.** One thread for the room. The button at the left of the band
  over the table (or `C`) opens it: who is watching, the last comments (players with
  their seat colour, spectators with an eye) and a field of 200 characters.
  After each comment Send counts down the 5 s the server makes everyone
  wait. While the chat is closed new comments float over the top left of the
  table for 4 s and the button counts them; Settings → Sound & chat turns
  the floating off (`pool:bubbles`). Comments are text only, never HTML.

## 3D view

The table can also be shown in 3D (`web/view3d.js`, Three.js r186). Settings →
*Table* → *View* chooses 2D or 3D (`pool:view`), and so do the scoreboard's 2D/3D button and
the `V` key. Without a stored choice a desktop opens in 3D and a phone
(`compactLayout`) in 2D, where the flat table aims more precisely and spares
the battery.

- **Loading.** `view3d.js` is an ES module that `app.js` imports the first
  time 3D is turned on; it imports `arena3d.js` (the arena, below) and
  `vendor/three-r186/three.min.js`, Three.js bundled into one minified
  module (esbuild, from the npm package's `build/three.module.js`; MIT, its
  licence beside it). The versioned path is cached for a year, and the
  server gzips text files (190 KB on the wire). No WebGL 2 or a failed load:
  back to 2D with a notice, without storing the choice.
- **Switching.** Each time 3D is turned on it gets a new canvas and WebGL
  context; turned off (or rebuilt for another table), the view gives the
  context back at once (`dispose`, `forceContextLoss`): a page holds only 16
  in Chrome, and past that the browser takes the oldest away, which could be
  the one showing. Turned on, 3D always starts from behind the cue, not
  from above. A context the GPU takes away (a driver reset, a phone
  reclaiming memory in the background) shows the flat table meanwhile and
  builds 3D again once the page is in sight (`lost3d`); a second loss within
  a minute gives up, back to 2D with the notice.
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
  liner hangs under each hole. Under the rail the apron, then the body, on
  six tapered legs to the floor 78 cm below the bed. Two spot lights cast
  the shadows. The table's scene has no background or fog of its own: it is
  drawn over the arena's.
- **Arena** (`arena3d.js`, `createArena`): a scene of its own, drawn first
  with its own lights (the table's lamps again for the floor round the
  table, a wash from high above over the floor of play, a light spilling
  onto the stands), then the table's scene over it without clearing, so the
  table keeps its look. Everything is Three.js shapes and canvas paint;
  nothing is downloaded.
  - *Floor of play*: a dark blue carpet (`paintCarpet`) with a lighter zone
    round the table, brass lines inside the boards, the game's mark at each
    end (POOL, or CAROM for 3-cushion) and soft shadows painted under the
    table, its legs and the furniture.
  - *LED boards*: 1 m high, 2.4 m beyond the rails at the ends and 2 m along
    the sides (`BOARDS_END`, `BOARDS_SIDE` in `app.js`), screens facing in.
    Both long boards show one picture, both ends another: four pages
    (`paintBoard`), each shown 9 s, then the next slides up (a cut with
    reduced motion): the match (the names either side of the score in a
    brass box, the game and the race beside them; practice, or a player
    waiting, says who is there), the game's mark, the room's code, and a
    word on the game ("CALL YOUR SHOT", "LOWEST BALL FIRST", "THREE
    CUSHIONS"). The main band sits in the upper part of the screen, which is
    what shows over the far rail from behind the cue; a line of small print
    runs under it. `app.js` hands the boards `arenaInfo()` on every
    `refreshPanels` (`v3.setInfo`, repainted only when it changes); they are
    painted again once their font has loaded.
  - *Corners*: in two opposite corners a player's chair and a small table
    beside it (water, a glass, a towel, chalk), in the other two a
    television camera on a tripod, its tally light red; all face the middle
    of the table. A piece the camera comes within reach of is hidden.
  - *Stands*: beyond a 1.4 m aisle behind each board, seven tiers of seats
    facing the table, a stairway every seven seats, the corners left open;
    dark, but for a blue line along each tier's edge and small warm lights
    on the stairways' steps. No one is in them yet. The tiers, the seats
    (instanced), the edge lights, the step lights and the rails are a draw
    each. *Low* graphics, or Auto finding the device slow, leave the stands
    out.
  - A ball off the table that rolls to a board bounces back off it
    (`fallPath`), and casts a soft shadow on the floor, darker and smaller
    as it comes down.
- **Players** (`players3d.js`, `createPlayers`): the room's players in the
  table's scene, in tournament dress, the waistcoat in their side's colour
  (gold for the first, blue for the second).
  - *Where*: in the lobby and at a game's end each stands by their side's
    chair; in play the one to play is down on the shot along the game's cue
    (the bridge hand on the cloth, the grip under the elbow, the stroke
    following the pull), held through the ball after it, and the other sits
    in their chair, hidden with it when the camera comes close. In a 2v2
    room the other side's next player sits; the rest stand by the chairs.
    In practice one plays with one's own look.
  - *Through the shooter's eyes* (the camera within 0.75 m of their head)
    only the bridge arm, its hand and cuff show, the sleeve fading out above
    the elbow.
  - *Looks*: each seat's comes with the room's state (PROTOCOL.md, Looks);
    one's own is `pool:look`, sent on `join`. A seat
    without one gets its side's default, a man for the first, a woman for
    the second.
  - *Built in code* (`body3d.js`): signed distance functions (`sdf3d.js`)
    meshed with surface nets, skinned to a 20-bone skeleton; the brows, lash
    lines, lips and blush are painted by the face's shader, the colours are
    the materials', so one mesh serves any colouring and either seat. The
    meshing runs in a module worker (`mesh3d-worker.js`, on the page when
    there is none), at a step of 2.2 (`playerDetail`: 1.8 on High, 3.2 on
    Low, 2.8 on a phone): about 0.7 s and 160k triangles a player on a
    desktop. A few looks' meshes are kept for the next game. `v3.players`
    tells the browser tests who is shown and how.
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
    their turn), with ball in hand too. A sideways drag turns the aim
    (`turnAim`): the finger holds the butt, so a drag to the right swings
    the shot left (pointing in Settings → *Aiming* reverses it), 0.3° per px
    at the top of the table down to 0.03° at the bottom, near the butt;
  - *follow*: high and oblique over the balls that have moved, while a shot
    runs;
  - *fall*: while a ball falls off the table to the floor and until a
    moment after it stops (even after the shot has settled, in a replay
    too, but not while the top view is chosen, a ball is carried or an aim
    is being dragged): from its side and well above the floor, looking down
    between it and the table's edge, far enough back to keep both in the
    picture, on a phone held upright too;
  - *top*: straight down, by the button at the stage's top right or `T`
    (turned off whenever 3D is turned on), with the practice Move tool, and
    while a ball is carried, getting there in about 0.2 s. The camera moves
    under a carried ball, so in 3D it does not jump to the pointer: it moves
    as far as the pointer does over the table, both ends seen through the
    camera as it is at that moment (`carry`). Aiming there is the 2D drag;
  - *arena*: in the lobby and at a game's end, slowly round the table, a
    turn in two minutes, high enough to have the arena about it (on a screen
    held upright, swaying either side of the head end); still with reduced
    motion;
  - *overview*: three quarters, while a decision is pending.
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
  screen it is rotated 90° unless lying down is 5 % bigger (a tablet held
  upright keeps it upright like a phone); elsewhere only when it is 15 %
  bigger (`view.rotated`). The way round is chosen as if the
  power bar were there, which it is not in the lobby and at the game over,
  and the row of pocketed balls keeps its room, unseen, before a rack; so
  a tablet held upright does not turn the table between the lobby and the
  rack. Pointer coordinates are mapped
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
  Behind the home page, where the table does not show at all, either view
  is drawn every 600 ms: over the 500 ms the 3D
  view's pace check takes for a stall, so it does not count those frames
  as slow ones.
- While a shot runs, `snapshot`s are kept in arrival order and the frame drawn
  is `RENDER_DELAY_MS` (100 ms) behind the newest one, interpolating between
  the two surrounding snapshots. A ball missing from the later snapshot stays
  at its earlier position until that snapshot's time passes, then disappears:
  into the nearest pocket, or, last seen past a cushion and away from every
  pocket, off the table. So does a ball in `settled`'s `offTable` that is
  back on the table (the cue ball, a spotted ball), from where it was last
  seen, carried on past the cushion if it was still over the bed. In 2D a
  ball off the table fades out beyond the rail. In 3D it goes on from where
  and how fast it was last seen (`fallPath`): onto the rail and over its
  outer edge if it is over it, down to the floor, a few bounces that each
  lose some speed, then a roll that slows to a stop, back off the arena's
  boards if it reaches them; it lies there a moment, then is gone. A copy
  of the ball falls, so the ball itself can already be back on the table.
  `settled` replaces everything with exact positions. After a reconnect in
  the middle of a shot the clock is re-aligned to the first snapshot received.
- A ball in the air (`z` in the snapshots, interpolated like `x` and `y`)
  is drawn over the others and bigger the higher it is, up to twice its
  size at 45 cm, its shadow falling further off, larger and fainter.
- Legal first-contact balls and whether the 8-ball is on are computed
  client-side with the same rules as the server (`legalTargets` and
  `eightOn` mirror `Rules.legalTarget` and `Rules.eightOn`); the server still
  validates every shot.
