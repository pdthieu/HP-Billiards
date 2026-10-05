# Migrating `web/` to the redesign

Work screen by screen; each step leaves the app working. Class names are in
`components.css`; values in `tokens.css`; canvas drawing in `canvas-spec.md`;
motion in `motion.md`. The mock-ups for each step are in `screens/` and on the
design canvas (one page per prompt).

## 0. Foundation

- [ ] Copy `tokens.css` and `components.css` into `web/` and link them before `style.css`.
- [ ] Add the fonts (Vietnamese subset included):
      `https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@500;600;700&family=Source+Sans+3:wght@400;600;700&display=swap`
- [ ] `<body class="pool-app">`. Drop `<meta name="color-scheme" content="dark">` (tokens set it per theme). Optional theme switch: `document.documentElement.dataset.theme = 'light' | 'dark'`.
- [ ] Map old variables, then delete the old `:root` block:
      `--panel → --surface-1`, `--panel-2 → --surface-2`, `--muted → --text-muted`,
      `--accent-text → --on-accent` (**renamed**: `--accent-text` now means brass *as text*),
      `--bad → --foul`, `--border → --hairline-strong`.
- [ ] Buttons: `button.primary → .btn.btn--primary`, plain `button → .btn.btn--secondary`,
      `button.small → .btn.btn--secondary.btn--small`, `.active → .toggle[aria-pressed]`.
- [ ] Delete the “Mockup only” section at the end of `components.css`.

## 1. Landing (`#landing`)

- [ ] `.overlay → .landing`, form `.card → .card.landing__card`.
- [ ] Backdrop: keep the table canvas behind; while the landing is open add a `.backdrop`-style blur + `--scrim` over it.
- [ ] Name field: `.field` + `.input-group` + shuffle `.icon-btn` (re-roll from `ADJECTIVES`/`ANIMALS`).
- [ ] Room list: `li.room-row[data-code]`. On each 3 s poll, diff by code: update text in place for existing rows, append new ones with `animation-delay: 40ms * i`, fade out removed ones. Status chip `.chip--lobby|playing|finished`; Join disabled + “Full” when both seats are taken.
- [ ] Limit reached: disable Create, show `.note` “All 3 rooms are in use. Join one below.”
- [ ] Empty state `.rooms__empty`.
- [ ] Invited mode: title “Join room ABCDE”, lead naming the host, primary Join, `.link` “Create your own room instead”.
- [ ] Empty name: `.input--error` + `.field__msg` + add/remove `.field--shake`.

## 2. Header (`#top`)

- [ ] `#top → .hdr`; room: `.eyebrow` + `.hdr__code` + Copy link `.btn--small` (phone: `.icon-btn` → `navigator.share` when available).
- [ ] Seats → `.seat` with `.seat__name` (max 14ch), `.tag--you|ready|offline`, `.seat__dots` of seven `.ball` (`.ball--stripe`, `.ball--gone` when pocketed).
- [ ] Active seat: `.seat--turn` when it is my turn (add `.is-moving` while balls roll), `.seat--theirs` when it is the opponent's. Offline: `.seat--offline` + `.hold` ring (`stroke-dashoffset = 69.1 × (1 − remaining / 60)`).
- [ ] Reserve the `.score` block between the seats (`.score--empty` until the race starts).
- [ ] ≤ 600 px wide: `.seat--compact`, `.score--compact`, tags become icons.

## 3. Table (canvas)

- [ ] Replace colours in `drawTable`, `drawBall`, `drawAim`, `ring`, `drawBallLabel` per `canvas-spec.md`; update `BALL_COLORS`.
- [ ] Add sights, felt radial gradient, rail gradient and lips, cushion nose line.
- [ ] Ball level of detail from `R * view.s * 2` (on-screen diameter).
- [ ] Cue drawn as tapered quads above the balls (move it out of `drawAim`).
- [ ] Opponent preview: cool colour, α .5.
- [ ] Add an effects list (`fx = [{type, t0, …}]`) drawn last; pocket drop, rim flash, strike ring, lift.

## 4. Status and panels

- [ ] `#status → .status` with `.status__pill`; `.status--foul|ok`; fixed min-height (48 desktop / 40 phone, two lines).
- [ ] `#controls → .slot` (fixed height 140 / 150) holding one `.panel` at a time.
- [ ] Shot panel: `.call` (line, Safety `.toggle`, Clear), `.angle` (four `.nudge`, `output.angle__readout`), `.spin` (`.spin__pad` DOM with `.spin__dot`, or keep the canvas but match its look), dismissible `.hint` (remember in `localStorage`).
- [ ] Lobby / waiting / game-over panels per the mock-ups; Rematch + “the break alternates” note; Leave.

## 5. Power bar

- [ ] `#powerBar → .pbar > .pbar__track` with `.pbar__last`, `.pbar__fill`, `.pbar__cancel`, `.pbar__label`; `.pbar__readout` as a sibling.
- [ ] States: `.pbar--drag`, `.pbar--cancel` (pointer in top 8 %), `.pbar--flash` (150 ms on release), `.pbar--disabled`.
- [ ] Fill background: `linear-gradient(180deg, var(--power-low) 0, var(--power-mid) 55% of track px, var(--power-high) track px)` so the edge colour matches the power.
- [ ] “Needs a call” `.tip` for 2 s when released without a call.
- [ ] Left-handed setting: put the bar first in the stage and add `.pbar--left`.
- [ ] Keyboard: ↓/↑ ±5 %, Enter shoots, Esc cancels.

## 6. Dialogs and results

- [ ] `#decision → .scrim > .dialog` with `.option` buttons (title + consequence); first option `.option--primary`; focus it on open; Esc does nothing (a choice is required).
- [ ] The other player gets `.banner` “Waiting for Bob to decide” over the stage.
- [ ] Game over: `.result` (`.result--win` adds the sweep) centred over the table; panel with Rematch.
- [ ] Toasts: `#toasts → .toasts`, max 3, 3.5 s (errors 6 s, `role=alert`), `.toast.is-leaving` before removal.

## 7. Connectivity

- [ ] `#disconnected → .scrim > .conn`; show only after the socket has been closed for 300 ms.
- [ ] `.retry__steps`: one step per backoff attempt (0.3, 1, 2, 4, 8 s); the current step fills via `--p`; meta shows the next attempt and the seat hold.
- [ ] “Retry now” resets the backoff; “Leave” returns to the landing.
- [ ] Taken-over variant: no auto retry, “Play here” / “Leave”.
- [ ] Reload inside a room: `.splash` with the 150 ms delay; after 4 s fall back to the `.conn` card.
- [ ] Opponent offline: seat + status + waiting panel countdown; on expiry return to the lobby with “The game was abandoned.”

## 8. Phone layouts

- [ ] Portrait (`max-width: 600px`): header 52 → table → status (2 lines) → panel (2 rows, spin pad right) → trays (22 px).
- [ ] Short (`max-height: 700px`): hide trays first, then the hint; the table shrinks to at least 340 px tall.
- [ ] Landscape (`orientation: landscape` and `max-height: 500px`): 36 px header strip, table | 220 px sidebar | power bar; status floats over the table's bottom edge.
- [ ] Respect `env(safe-area-inset-*)`.
- [ ] Touch: tap < 8 px and < 250 ms calls; longer drags aim by angle; in hand, a drag that starts on the cue ball moves it.
- [ ] First-run hints, once per device.

## 9. Checks

- [ ] Contrast ≥ 4.5:1 for text in both themes (token sheet lists the ratios).
- [ ] Visible `:focus-visible` rings everywhere; Tab order header → panel → power bar.
- [ ] Touch targets ≥ 44 px (small buttons and nudges extend their hit area).
- [ ] `prefers-reduced-motion` honoured, including canvas effects.
- [ ] Vietnamese strings fit (labels have ~30 % slack).
