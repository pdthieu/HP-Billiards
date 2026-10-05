# Design prompts for Claude Design

Cách dùng: dán **Prompt 0** trước để Claude Design có bối cảnh và hệ thống
thiết kế, rồi dán từng prompt tiếp theo trong cùng phiên (hoặc dán lại Prompt 0
ở đầu mỗi phiên mới). Mỗi prompt yêu cầu đầu ra là HTML/CSS tĩnh có token màu
và mô tả animation, để ghép lại vào `web/` không cần framework.

Ràng buộc kỹ thuật chung (đã ghi trong Prompt 0): bàn và bi được vẽ bằng
canvas trong `app.js`, mọi thứ còn lại là HTML/CSS thường; không dùng React
hay Tailwind; chiều rộng tối thiểu 390 px; theme tối là mặc định.

---

## Prompt 0 · Bối cảnh và hệ thống thiết kế

```
You are designing the UI of "Pool", a two-player online 8-ball game played in
the browser (desktop and phone). Players create a room, share a link, and
play WPA 8-ball rules with called shots. The current UI is functional but
plain. I want a redesign that feels like a premium, calm pool hall at night:
confident, tactile, not cartoonish and not a casino.

Deliverables for every prompt in this session: a static HTML + CSS mockup
(no React, no Tailwind, no build step), using CSS custom properties for every
color, radius, shadow and motion token; a short list of the tokens you added;
and, where motion is involved, the animation written as CSS keyframes or a
precise description (property, duration, easing, trigger) that a developer
can implement in vanilla JS.

Hard constraints:
- The table, balls, cue, aim guide and pocket animations are drawn on a
  <canvas> by existing JavaScript. Design their look (colors, lighting,
  proportions, motion) as a visual spec, not as DOM.
- Everything else (header, panels, dialogs, landing page) is ordinary HTML.
- Minimum viewport width 390 px. On portrait phones the table is rotated 90°
  and becomes tall; the controls sit below it.
- Dark theme is the default; provide a light theme as token overrides only.
- Text is in English now and Vietnamese later: leave 30% slack in every label.
- Accessibility: contrast ≥ 4.5:1 for text, visible focus rings, hit targets
  ≥ 44 px on touch, motion respects prefers-reduced-motion.

Design system to establish now:
- Palette: a deep charcoal-blue background, one warm accent (brass/amber) for
  primary actions and the active player, a felt green that reads as real
  cloth (slightly desaturated, with a subtle vignette), a muted red for fouls
  and a soft green for success. Ball colors must stay the standard set
  (yellow, blue, red, purple, orange, green, maroon, black).
- Typography: one humanist sans for UI, tabular numerals for angles and
  scores, a slightly condensed display face only for room codes and the
  score.
- Shape: 12–16 px radii on panels, pill buttons, 1 px hairline borders at
  low alpha instead of heavy shadows.
- Motion principles: short (120–220 ms) for feedback, 300–450 ms for layout
  changes, ease-out for entering, ease-in for leaving, springy only for the
  pocket "drop" and the score tick. Nothing loops forever except a gentle
  pulse on "your turn".

Start by producing the token sheet and a one-screen style tile showing
buttons (primary, secondary, small, disabled), inputs, a tag/pill, a toast,
a card, and type scale, all in dark and light.
```

## Prompt 1 · Trang đầu: tạo phòng, danh sách phòng, join bằng link

```
Design the landing screen of Pool, in two states, desktop (1100×720) and
phone (390×800).

State A, "home": a name field prefilled with a suggested name (e.g. "Keen
Osprey") with a small "shuffle" affordance to get another; a primary button
"Create a room"; a section "Rooms" listing 0–3 live rooms, each row showing
the 5-letter code in the display face, the players' names ("Ann vs Bob",
"Ann", or "empty"), a status chip (lobby / playing / finished) and a Join
button that is disabled and reads "Full" when both seats are taken; a note
when the server's 3-room limit is reached ("All 3 rooms are in use; join one
below") with the create button disabled; and a secondary "Join by code"
input + button. Include the empty state ("No rooms yet. Create one.").

State B, "invited": the same card when the user opened an invite link. The
title becomes "Join room ABCDE", only the name field and a primary "Join"
remain, plus a quiet link "Create your own room instead".

The background is the dimmed table (it is already rendered behind the card
by the app); design the card and its backdrop treatment (blur/dim) so the
table is felt but not distracting.

Motion: the card enters with a 240 ms fade + 8 px rise; room rows animate in
with a 40 ms stagger when the list refreshes (it refreshes every 3 s, so
unchanged rows must not re-animate: specify how to key them by room code).
Validation error (empty name) shakes the field once, 300 ms.
```

## Prompt 2 · Header và hai ghế

```
Design the in-game header for Pool: left, the room label with the 5-letter
code and a "Copy link" / share button; right, the two seats.

A seat shows the player name (truncate at ~14 characters), tags ("you",
"ready" in the lobby, "offline" when the player dropped and the seat is being
held), and once groups are assigned, seven small dots in that player's ball
colors that go dark as the balls are pocketed. The active player's seat
must be unmistakable at a glance: design an "it's your turn" treatment
(accent ring + slow 2 s pulse, stop pulsing while balls are moving) and a
calmer "their turn" treatment. Also design the "offline" state: dashed
outline, desaturated, a small countdown ring or text "held 60 s".

Later we will add a score ("2 – 1", race to 5) between the seats: reserve
the space and design it now with the display face and a tick animation when
a number changes (old digit slides up and out, new slides in, 220 ms).

Provide desktop and 390 px variants; on the phone the "vs" and tags may
collapse into icons.
```

## Prompt 3 · Bàn, bi và cơ (visual spec cho canvas)

```
Produce a visual spec for the pool table that our JavaScript draws on a
canvas. Give exact colors (hex), gradients (stops and angles), stroke
widths in millimeters of table space (the table is 2540×1270 mm, ball
diameter 57.15 mm), and layering order.

Elements, with the geometry we already have:
- Wooden rails around the table (rounded corners), the cushions (a band
  ~45 mm wide inside the rails with angled jaws at each pocket), the felt
  (slightly vignetted toward the rails), six pocket openings drawn as dark
  circles behind the cushion gaps.
- Diamonds/sights on the rails (3 per long rail half, 3 per short rail).
- Head string (faint), foot spot and head spot (tiny dots).
- Balls: solids, stripes (a horizontal band on white), the 8-ball and the cue
  ball; a small white number disc; one soft specular highlight top-left and
  a contact shadow offset bottom-right. Make the stripes read clearly at
  12 px on a phone.
- Cue stick behind the cue ball: tip, ferrule, shaft gradient, wrap; it
  pulls back up to 120 mm with power.
- Aim guide: a dashed line from the cue ball to the ghost ball at first
  contact, the ghost ball outline, a short line for the object ball's
  direction and a shorter one for the cue ball's deflection. Give colors
  with alpha and dash patterns. Also a dimmer variant for the opponent's aim
  preview.
- Highlights: legal target balls (a thin ring), the called ball (accent
  ring), the cue ball while "ball in hand" (green ring and a translucent
  wash over the kitchen area when placement is restricted to it).
- Hover label above a ball ("3 · solids", "8-ball", "cue ball"): a small
  dark pill.

Motion spec (we interpolate ball positions at 60 fps from server data):
- Pocket drop: when a ball disappears into a pocket, 180 ms scale 1 → 0.6
  with a slight sink toward the pocket center and a 120 ms soft flash of
  the pocket rim.
- Cue strike: on shoot, the cue advances to the ball in 80 ms and fades out
  over 200 ms; a 150 ms ring expands from the cue ball.
- Ball-ball and ball-cushion contact: optional 100 ms tiny highlight; keep
  it subtle, there can be 20 contacts in a second on the break.
- Cue ball placement drag: the ball lifts (shadow grows, 1.05 scale) while
  dragged, settles on release in 150 ms.
- Turn change: the aim guide fades in over 200 ms for the new shooter.
Render a 1100×560 landscape mock and a 360×720 portrait (rotated) mock of
the same frame, mid-game, with the aim guide visible.
```

## Prompt 4 · Panel đánh: gọi bi, góc, xoáy

```
Design the shot panel shown below the table when it is my turn. Contents:
1. A call line: either an instruction ("Tap the ball you are going for") or
   the current call in the accent color ("Called: the 3"), with a "Safety"
   toggle and a "Clear" button. On the break it reads "Break: no call
   needed".
2. Angle controls: four nudge buttons (−5°, −0.25°, +0.25°, +5°) around a
   tabular readout like "321.7°".
3. The spin pad: a 72–96 px cue ball where the player taps or drags the
   contact point; a dashed inner circle marks the no-miscue limit; a red
   dot shows the tip; a label reads "centre" / "top" / "draw" / "left +
   top" etc.; a small "Reset". Design hover/pressed states and the dot's
   motion (follows the finger with no lag, snaps back to center on Reset
   with a 200 ms spring).
4. A one-line hint about the power bar and keyboard shortcuts, dismissible.

Also design the three sibling panels that occupy the same slot, same height
so the table never jumps: the lobby panel ("Bob is here. Ready when you are."
+ "I'm ready"), the waiting panel ("Ann's turn", "Balls are rolling…",
"Waiting for Bob to decide", "Waiting for Bob to reconnect…"), and the
game-over panel (big result line, "Rematch", a note that the break
alternates).

Provide desktop (1100 wide, single row where possible) and 390 px (two rows,
spin pad on the right) layouts. Motion: panels cross-fade in 200 ms; the
call line slides 4 px when it changes; the Safety toggle fills from the left
in 160 ms when active.
```

## Prompt 5 · Thanh kéo lực

```
Design the power bar: a vertical control beside the table (34–44 px wide,
full table height) that the player presses, pulls down to set power, and
releases to shoot. Releasing in the top 8% cancels.

States: idle (shows the last power as a faint fill and a vertical "pull"
label), pressed/dragging (fill grows from the top, color shifts green →
amber → red with power, a large percentage readout appears next to the bar
or follows the thumb), released-to-shoot (a 150 ms flash and the fill
collapses), cancelled (fill springs back, 250 ms), and disabled/hidden when
it is not my turn. Also a "needs a call" hint when the player releases
without having called a ball (tooltip anchored to the bar, 2 s).

Design it so the thumb is comfortable under a right or left thumb on a
phone held in portrait, and so a mouse user understands it is draggable
(cursor, subtle chevrons). Include a variant where the bar sits on the left
for left-handed players (a setting), and a reduced-motion variant.
```

## Prompt 6 · Hộp thoại lựa chọn và thông báo kết quả cú đánh

```
Design two overlays and the status line.

1. Decision dialog, shown to one player after a break: title ("Illegal
   break" or "8-ball on the break"), one sentence of context ("Bob broke
   illegally: nothing pocketed and fewer than four balls reached a rail."),
   and 2–3 large option buttons, each with a title and a one-line
   consequence ("Play from here — accept the balls where they lie", "Re-rack,
   I break", "Re-rack, they break again"). The other player sees a small
   non-modal banner "Waiting for Bob to decide". Motion: dialog scales from
   0.96 with a 220 ms ease-out; options stagger 40 ms.
2. Game over: a full-width banner over the table ("You win!" / "Bob wins")
   with the reason when relevant ("8-ball pocketed early", "scratch on the
   8"), confetti-free but celebratory (light sweep across the banner once,
   600 ms), then the panel with Rematch. Design both the winning and losing
   versions; losing should feel neutral, not punishing.
3. Status line under the table: one sentence after each shot, e.g.
   "Pocketed the 6, the 10. Your turn." / "Foul by Bob: scratch. Your turn,
   ball in hand." Design the neutral, foul (muted red) and success (soft
   green) treatments and a 200 ms crossfade when the text changes; it must
   not shift the layout when it wraps to two lines on a phone.
Also design the toast stack (bottom center, max 3, 3.5 s, error variant).
```

## Prompt 7 · Mất kết nối, reconnect, đối thủ offline

```
Design the connectivity states of Pool.

1. My connection dropped: a compact overlay card ("Connection lost.
   Reconnecting… Your seat is held for 60 seconds.") with a progress
   indicator that is honest about retry timing (attempts at 0.3 s, 1 s, 2 s,
   4 s, 8 s…), a "Retry now" button and a quiet "Leave". When it succeeds, a
   small "Reconnected" toast and the overlay fades out in 200 ms. Variant:
   "This seat was taken over by another connection" with Rejoin/Leave and no
   automatic retry.
2. Rejoining after a page reload: a brief full-screen "Rejoining room
   ABCDE…" splash (max 1 s typical) that must not flash if the join is
   instant: specify a 150 ms delay before it appears.
3. Opponent offline: their seat gets the offline treatment from the header
   design, the status line says "Bob lost connection. Their seat is held for
   60 seconds." and the waiting panel shows "Waiting for Bob to reconnect…"
   with a countdown. When the hold expires, the app returns to the lobby
   with a message "The game was abandoned."
Design the phone layout first; these states are mostly hit on phones.
```

## Prompt 8 · Bố cục điện thoại dọc và ngang

```
Produce the complete phone layout of the in-game screen for Pool at 390×844
(iPhone-class, with safe areas) in portrait, where the table is rotated 90°
and tall, and at 844×390 in landscape, where the table is wide and the
controls must fit beside or over it.

Portrait stack: header (48 px) → table (fills remaining height, keep ≥ 16 px
side gutters, power bar in the right gutter) → status line → shot panel
(two rows) → ball trays (pocketed balls per group). Show what collapses
first when the screen is short (e.g. 390×660).

Landscape: header shrinks to a thin strip; the shot panel becomes a right
sidebar (call, angle, spin pad stacked); the power bar sits at the far
right edge; status appears as a floating pill over the table's bottom edge.

Also specify the touch behaviors visually: tap a ball to call, drag on the
felt to aim, drag the cue ball when in hand, pull the power bar to shoot.
Include the ball-in-hand kitchen wash and a hint toast for first-time users.
```

## Prompt 9 · Micro-interactions tổng hợp (motion sheet)

```
Create a single motion sheet for Pool listing every animation with: name,
trigger, properties, duration, easing (cubic-bezier), delay/stagger, and the
reduced-motion fallback. Cover: landing card enter, room row stagger, name
field error shake, your-turn pulse, score tick, seat offline transition,
panel cross-fade, call line change, safety toggle fill, spin dot drag and
reset spring, power bar fill/flash/cancel, cue strike, pocket drop and rim
flash, ball placement lift, aim guide fade on turn change, decision dialog
enter, game-over banner sweep, status crossfade, toast enter/exit,
reconnect overlay enter/exit and the "Reconnected" toast.

Keep total motion restrained: no animation longer than 600 ms, no infinite
loops except the your-turn pulse, and everything in the table itself must
be implementable with simple interpolation in a 60 fps canvas loop
(scale, alpha, position only). Output as a table plus CSS keyframes for the
DOM ones.
```

## Prompt 10 · Chuyển giao cho lập trình

```
Package the designs from this session for implementation in a plain
HTML/CSS/vanilla-JS app:
1. tokens.css: all custom properties, dark as default on :root, light under
   :root[data-theme="light"] and prefers-color-scheme, including motion
   tokens (durations and easings) and z-index scale.
2. components.css: header/seats, panels, buttons, inputs, tags, toasts,
   dialogs, power bar, spin pad, room list, status line; BEM-style class
   names, no framework.
3. canvas-spec.md: the table/ball/cue/aim visual spec with exact numbers in
   table millimeters and hex colors, and the pocket-drop/cue-strike motion
   as parameter lists.
4. A checklist of what changed versus a plain functional UI so a developer
   can migrate screen by screen.
Keep selectors flat and avoid :has() and container queries unless they
degrade gracefully.
```

---

## Gợi ý cách làm việc

- Làm theo thứ tự 0 → 3 → 4 → 5 → 2 → 1 → 6 → 7 → 8 → 9 → 10. Bàn (3) và
  panel đánh (4) quyết định phần lớn cảm giác, nên chốt trước; trang đầu
  (1) dễ đổi sau.
- Sau mỗi prompt, lưu HTML/CSS Claude Design trả về vào `design/<tên>/` trong
  repo để tôi ghép vào `web/`. Phần canvas tôi sẽ chuyển từ spec sang hàm vẽ
  trong `app.js`.
- Nếu một màn không ưng, nói với Claude Design điều cụ thể không ưng (màu
  felt quá sáng, nút quá to) thay vì "làm đẹp hơn"; nó giữ token đã có và
  chỉ đổi phần đó.
