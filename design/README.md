# Pool redesign — “Night hall”

A calm pool hall at night: a deep charcoal-blue room, brass for whatever
matters right now, real cloth on the table. Dark theme by default, light theme
as token overrides. Built for the plain HTML/CSS/vanilla-JS app in `web/`.

The interactive design canvas (one page per prompt, private to its owner):
https://claude.ai/artifact/E8yiMbv2xfkbPmMnxNDDrf

The home page, the game screen and Settings were redesigned in October 2026
(Home, In game and Settings below) on their own canvas, also private to its
owner, a page each:
https://claude.ai/artifact/828DdhzY4KrhRDNhRaHtH1

New screens follow **Rules for every screen** at the end of this file.

## What is here

| Path | What it is |
|---|---|
| `tokens.css` | All custom properties: colour (dark on `:root`, light on `[data-theme="light"]` and `prefers-color-scheme`), type, space, radius, motion, z-index, table and ball colours |
| `components.css` | Flat BEM components: buttons, inputs, tags, toasts, cards, landing, header/seats/score, panels, spin pad, power bar, dialogs, result banner, connectivity, phone shells, keyframes. The last block (“Mockup only”) is not shipped |
| `canvas-spec.md` | Table, balls, cue, aim guide, highlights and canvas motion, in table millimetres and hex |
| `motion.md` | Every animation: trigger, properties, timing, reduced-motion fallback |
| `MIGRATION.md` | Screen-by-screen checklist for moving `web/` over |
| `img/` | Reference renders of the table generated from the app's own geometry (`aim-*` my turn, `opp-*` opponent preview, `hand-*` ball in hand, `rack-*` racked, `plain-*` no overlays; `-L` landscape, `-Ls` small landscape, `-P` portrait) and spec close-ups (`spec-*`) |
| `screens/` | Static HTML of every mock-up. Open any file in a browser; they share `tokens.css` and `components.css` |
| `canvas-source/` | The `.dc.html` sources and `canvas.json` of the design canvas, including the four sheets that only render there: token sheet (`Main`), style tile (`StyleTile`), table spec (`T-Spec`) and motion sheet (`M-Sheet`) |
| `home/` | The `.dc.html` sources and `canvas.json` of the home page canvas: `Main` (desktop, a fluid page), `Phone-Portrait` (390 × 844) and `Phone-Landscape` (844 × 390). Like `canvas-source/`, they render only on a canvas (they load its `support.js`) |
| `game/`, `settings/` | The same canvas's In game and Settings pages as built (`Game-*-Proposal` and `Settings-*-Proposal`, named as on the canvas: `Desktop` 1440 × 900, `Portrait` 390 × 844, `Landscape` 844 × 390). The canvas keeps the screens as they were before under them; `home/canvas.json` lays out all three pages |

## Screens

| Prompt | Files |
|---|---|
| 0 · Foundation | token sheet and style tile → `canvas-source/Main.dc.html`, `canvas-source/StyleTile.dc.html`, values in `tokens.css` |
| 1 · Landing | `screens/01-landing/` desktop home, room limit, invited; phone home, empty list + name error, invited. Superseded by the home page (`home/`, Home below): kept as the record of the first design, they no longer match `components.css` |
| 2 · Header | `screens/02-header/` desktop and phone: lobby, my turn, balls moving, their turn, opponent offline, score tick |
| 3 · Table | `screens/03-table/` landscape 1100 × 560 and portrait 360 × 720; spec in `canvas-spec.md` |
| 4 · Shot panel | `screens/04-shot-panel/` my turn (desktop, phone) and every panel-slot state |
| 5 · Power bar | `screens/05-power-bar/` nine states, pulling on a phone, left-handed + needs-a-call |
| 6 · Dialogs & status | `screens/06-dialogs-status/` decision dialog, waiting banner, win, loss, status tones, toasts |
| 7 · Connectivity | `screens/07-connectivity/` connection lost, seat taken over, rejoin splash, opponent offline, hold expired |
| 8 · Phone | `screens/08-phone/` portrait 390 × 844, short 390 × 660, landscape 844 × 390, touch behaviours |
| 9 · Motion | `motion.md`; interactive sheet in `canvas-source/M-Sheet.dc.html` |
| 10 · Handoff | `screens/10-handoff/handoff.html`, `MIGRATION.md` |

## Decisions worth knowing

- Fonts: Source Sans 3 (UI) and Barlow Semi Condensed (room codes, score). Both have Vietnamese subsets.
- `--accent-text` now means brass used as text; the old meaning (text on the brass button) is `--on-accent`.
- On a 390 × 844 phone the rotated table is about 261 px wide, so balls draw at ~10 px: below 15 px the number disc is dropped and the stripe band is widened to ±0.58 R so solids and stripes stay distinct.
- The panel slot and the status line have fixed heights, so the table never jumps when panels swap or a status sentence wraps.
- One 240 ms step covers card/dialog entry and the score tick (the prompts mentioned both 220 and 240 ms).

## Home (10/2026)

The landing became a home page of its own, opaque over the game. Its idea:
the table is the hero. The **hall** shows the table of the room about to be
made, under its lamp on the 3D arena's carpet (the brass line, the LED type
of the boards), racked for the game, and redraws with every pick; the rest
of the page is the picks, the rooms and the buttons.

**Shapes** (the app's breakpoints, `web/style.css`):

| Shape | When | Layout |
|---|---|---|
| Desktop, tablet | wider than 600 px and taller than 500 px | A bar (wordmark, a *Rooms* pill that jumps to the rooms, the gear). The hall beside the *New room* card from 960 px, one column below. The rooms below them, as cards, with *Join by code* on their title line |
| Phone held upright | 600 px wide or less | The name as a chip in the top bar; the hall on top; *New room* and *Rooms* as two tabs; their buttons docked at the foot (*Create a room* + *Practice alone*, or the code + *Join*). The page scrolls, the dock stays |
| Phone on its side | 500 px tall or less | Two columns: the bar, the hall and the two buttons on the left, the hall's table as big as the height allows (it shrinks rather than push the buttons off); the tabs on the right over a pane that scrolls, *Join by code* pinned at its foot |
| Invite (`/?room=CODE`) | any | One column (520 px at most): the room's own table in the hall once the room list names it, then "Join room CODE", the host, the name and *Join* |

**Pieces** (all in `components.css` unless noted):

- `.hall` (+ `__lamp`, `__head`, `__names`, `__title`, `__sub`, `__stage`), `.led` with `.led__sep`, `.specs` / `.spec` (`dl`). Colours come from the hall tokens (`--hall`, `--hall-text`, `--hall-muted`, `--hall-faint`, `--hall-line`, `--hall-carpet`, `--hall-lamp`, `--led`, `--led-glow`), identical in both themes: the hall stays dark on the light theme, as the arena does.
- `.tbl`, the table from above: `__body` (the rail gradient of the table's `LOOKS`), `__grain` (wooden rails), `__gloss` (glossy ones), `__trim` (Rasson, Acurra), `__cushion`, `__bed` (the cloth, lit in the middle by `clothShades`), `__pocket` (sized from the table's mouths; Predator's silver rims), `__sight`, `__glow` (the light under Predator), and DOM `.ball`s as `.tbl__ball`, sized in `cqw` of the bed (true size on a desktop, 1.25 × on a phone). The frame is 2880 × 1610 mm round the 2540 × 1270 mm bed; every position is in % of it.
- `.pill` (+ `__dot`, `__n`), `.mini` + `.mini__bed` (a room's table and cloth), `.room-row` as a card (`mini code chip / mini meta / who / watching actions`), turned into a row a room by a container query where the list is narrower than 560 px (`style.css`).
- In `style.css`: `.home` and its areas, `.game-pick` (a card per game with its rack), `.table-pick__finish`, `.seg__n` (a count in a tab), the name chip and the dock.

**Data**: everything shown is real. Tables, finishes and cloths are the app's `TABLES`, `LOOKS` and `CLOTHS`; the room list is `GET /api/rooms`, which carries the match `score` for the cards (PROTOCOL.md). The app's ids stay as they were (`#name`, `#create`, `#practice`, `#join`, `#code`, `#roomList li.room-row`, `#landingMode [data-mode]`, `#landingTable [data-table]`, `#landingCloth [data-cloth]`, `#landingOpts`), so the e2e scenarios drive the page as before; the room's game, race and table are in `.room-row__meta`, its state in `.chip__text`.

## In game (10/2026)

The game screen is the arena's hall: the table under its lamp, the
scoreboard over it, the controls in a dock under it. Its idea: nothing but
the table is big, and nothing lies on the felt that can sit beside it.

- **The scoreboard** (`.hdr`, dark in both themes): the room in LED type on
  the left (`#roomEyebrow` · `#roomCode`), the two seats either side of the
  score in equal columns so the score keeps the middle (`.seat--right`
  mirrors the second one, so both clock rings sit by the score), the race
  in LED brass under it, and the room's buttons on the right (2D/3D,
  Settings, full screen, Leave). Seats are hall chips (`--hall-chip`,
  `--hall-chip-line`); your seat on turn is brass.
- **The band** (`#status`, 46 px; 40 px on a phone held upright) over the
  table: the status pill, the chat button at its start, the replay at its
  end. A phone on its side keeps the status over the felt's lower edge: a
  band there would cost the table about 8 % of its size.
- **The stage**: the table and the power bar (32 px on a phone held
  upright), nothing else around it. There are no trays: the seats' ball
  dots show what is down; 3-cushion's lines (points, innings, average, best
  run) are in the match dialog.
- **The dock** (`#controls`, one `.panel` card with `--r-xl`, the same
  height for every panel: 100 px on a desktop, two rows in 188 px on a
  tablet, 80 to 128 px on a phone): what to hit and its toggles (and the
  keyboard hint beside them from 1400 px), the aim, the spin, the jump.
- **Colour**: the hall, the scoreboard, the band, the stage and the practice
  tools are dark in both themes (`.on-hall`, in `tokens.css`, takes the dark
  values back for them); the dock and the dialogs follow the theme.

What it gives the table while a rack is played: at 1440 × 900 it goes from
1103 × 592 to 1237 × 664 (the trays are gone and the dock is 24 px
shorter); on a 390 × 844 phone from 312 × 582 to 330 × 614 (no trays, a
40 px band, a 32 px power bar).

## Settings (10/2026)

A sheet in four tabs (`#settingsTabs`, `.seg--tabs`), opened from the
scoreboard's gear or the home page's:

- **This room** (in a room, not in practice) only lets others in: the
  room's card as the room list draws it (`.room-row--card`: its table and
  cloth in miniature, the code, the game, the race and the table, who
  watches) with *Copy invite link* (*Share invite link* on a phone with a
  share sheet), *Spectators* (the players' pick), and a line saying the
  game, the table, the cloth and the race stay as the room was made.
  Nothing of the match is changed in Settings.
- **Table** (view, graphics, theme), **Controls**, **Sound & chat**.

**Shapes.** Desktop and tablet: 380 px on the right, under the scoreboard.
Phone held upright: up from the bottom (at most 520 px, with a grab bar),
under the scoreboard and a strip of the hall where the table lies across,
whole. Phone on its side: a 344 px card in the side column, the scoreboard
folded to one line over it. In a room the hall gives way to the sheet
instead of hiding under it: the table shrinks and stays in view, out of
reach until Done (`main.game` is inert, the game keys wait), and the dock,
the practice tools and the power bar step aside. Over the home page it
lies on a scrim. `e2e/devices.js` checks that it fits at 1100 × 700,
393 × 670, 844 × 390 and 844 × 340 with the table beside or above it.

## Rules for every screen

Whatever comes next (a new screen, a dialog, a second language) keeps to
these, so it looks like the rest without a new design pass:

1. **Tokens only.** Colours, radii, type, spacing and motion come from `tokens.css`; a new value goes there first, in both themes (dark on `:root`, light as overrides), unless it is like the table or the hall, the same in both. What sits in the hall gets `.on-hall` and so the dark values in either theme. Edit `design/` first, then copy `tokens.css` and `components.css` into `web/` (without the “Mockup only” block).
2. **Two faces, two weights.** Source Sans 3 for the UI, Barlow Semi Condensed for codes, scores, the wordmark and LED type. Brass (`--accent`) marks the one thing that matters now: the primary button, the pick, your seat.
3. **Three shapes.** Desktop/tablet (> 600 px wide and > 500 px tall), phone upright (≤ 600 px wide), phone on its side (≤ 500 px tall), with the same media queries as `style.css`. A page that works as a fluid page at 1440 px also has to work at 320 px.
4. **Only vertical scroll.** Nothing is ever wider than the screen and nothing scrolls sideways: no carousels or swipe strips (wrap them into a grid), roots are `box-sizing: border-box` too, panes that scroll get `overflow-x: hidden` and `touch-action: pan-y`, and hit areas grow up and down, never past an edge. Hiding the overflow is not a fix; make the layout fit. `e2e/landing.js` checks the home page at 1440 × 900, 1024 × 768, 390 × 844, 360 × 640, 844 × 390 and 844 × 340, and `e2e/devices.js` the game screen with Settings open; a new screen adds itself to a check like them.
5. **Phones.** Touch targets of at least 44 px (a pseudo-element may enlarge a smaller control vertically); the main buttons in reach of a thumb (a dock on a phone upright, under the table on its side); a phone on its side shrinks the picture before the controls. A sheet or a panel makes room beside the table rather than lie over it.
6. **Built in code.** Pictures are drawn from the app's own data (the hall's table, the room miniatures, the game glyphs), with inline stroke SVG for icons: no downloaded images, no emoji.
7. **Accessible as drawn.** Real buttons, inputs and labels; `aria-pressed` on picks, `aria-label` on icon buttons, `role="img"` with a label on pictures that carry meaning; text at 4.5:1 (3:1 from 24 px).
