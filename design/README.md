# Pool redesign — “Night hall”

A calm pool hall at night: a deep charcoal-blue room, brass for whatever
matters right now, real cloth on the table. Dark theme by default, light theme
as token overrides. Built for the plain HTML/CSS/vanilla-JS app in `web/`.

The interactive design canvas (one page per prompt, private to its owner):
https://claude.ai/artifact/E8yiMbv2xfkbPmMnxNDDrf

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

## Screens

| Prompt | Files |
|---|---|
| 0 · Foundation | token sheet and style tile → `canvas-source/Main.dc.html`, `canvas-source/StyleTile.dc.html`, values in `tokens.css` |
| 1 · Landing | `screens/01-landing/` desktop home, room limit, invited; phone home, empty list + name error, invited |
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
