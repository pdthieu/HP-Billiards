# Canvas visual spec (table, balls, cue)

Everything `app.js` draws on `<canvas id="table">`. Units are **table millimetres**
(the app's metres × 1000): playing surface 2540 × 1270, ball Ø 57.15, `R = 28.575`.
Origin is the playing surface's top-left. The rotated (portrait) view keeps using
`ctx.rotate(-Math.PI / 2)`; light always comes from the **screen's** top-left, so
screen offsets `(sx, sy)` become table offsets `(-sy, sx)` when rotated.

Reference renders: `img/aim-L.svg`, `img/aim-P.svg`, `img/opp-*.svg`, `img/hand-*.svg`,
`img/rack-*.svg`, and close-ups `img/spec-balls.svg`, `img/spec-cue.svg`,
`img/spec-aim.svg`, `img/spec-rings.svg`. They were generated from the same
geometry as `buildTable()`.

## Layer order (back to front)

1. Rail
2. Felt (runs under the cushions and into the pocket mouths)
3. Pocket holes
4. Cushions, then the nose line
5. Sights (diamonds)
6. Kitchen wash (only while placing in the kitchen)
7. Head string and spots
8. Aim guide (under the balls)
9. All ball shadows
10. Balls: body → markings (rolled: stripe band, discs, cue-ball dots) → numbers → shade → specular → edge
11. Cue stick (its shadow first) — above the balls
12. Rings: legal targets, called ball, ball in hand
13. Hover label
14. Transient effects: rim flash, strike ring, contact glints

## Table

| Element | Spec | Notes |
|---|---|---|
| Rail | `roundRect(-100, -100, 2740, 1470, 60)`, linear top→bottom `#6A4428` 0 · `#4C2F1B` .5 · `#341F10` 1 | Outer edge 3 mm `#000` α .55. Inner lip `roundRect(-52, -52, 2644, 1374, 10)` stroke 3 mm `#FFE2B4` α .12 |
| Felt | `rect(-45, -45, 2630, 1360)`, radial at (1270, 635) r 1480: `#36745C` 0 · `#2C614C` .55 · `#1B3F31` 1 | The radial falloff is the vignette; no overlay |
| Pocket hole | corner: circle r = half-mouth (57.9) whose near edge sits at `shelf − 6` past the mouth line, i.e. centre at `mouth + axis × (shelf − 6 + r)`; side: straight jaws for 20 mm from the noses, then a half circle (r = half-mouth + 20·tan 14° = 69.3) centred 20 mm behind the rail line. Radial `#000` 0 · `#06080A` .78 · `#1C1610` 1 | Rim stroke 4 mm `#000` α .6. The felt shows up to the hole: on a corner that is the shelf a ball can sit on; a side pocket starts at the nose line |
| Cushion | existing nose/jaw polygons, fill `#1F4B3A` | Nose line 2.5 mm `#FFF` α .10 from → to |
| Sights | rhombus 22 × 14 (long axis along the rail), `#E6D7B4` α .9 | Long rails x = W/8 × {1,2,3,5,6,7}, y = −72.5 / H + 72.5. Short rails y = H/4 × {1,2,3}, x = −72.5 / W + 72.5 |
| Head string | x = 635, 2 mm `#FFF` α .14 | During kitchen placement: 3 mm `#71C99D` α .75, dash 16 / 10 |
| Spots | (635, 635) and (1905, 635), r 4, `#FFF` α .35 | |

## Balls

| Part | Spec | Notes |
|---|---|---|
| Colours | 1 `#F2C12E` · 2 `#1F4FB4` · 3 `#CC3326` · 4 `#5B3592` · 5 `#EC7623` · 6 `#128A4C` · 7 `#7E2232` · 8 `#111316` · ivory `#F4EFE2` | Replaces `BALL_COLORS` |
| Shadow | circle at screen (+6, +9), r 1.08 R; radial `#000` α .5 0 · α .25 .7 · α 0 1 | Lifted cue ball: offset × 1.8, r × 1.05 |
| Body | circle r R; stripes and cue ball ivory | |
| Stripe band | the zone within ±0.58 R of the ball's own equator; horizontal **on screen** when racked, then it rolls with the ball (orientation integrated from the ball's movement, |Δp| / R about the horizontal axis) | Was ±0.55 R. Markings are rasterised per ball into a cached canvas; the cue ball carries six 0.17 R `#B4322A` dots |
| Number disc | r 0.48 R `#FAF7EF` at the ball's poles (solids) or on the band (stripes); text 700, 0.62 R, `#111316`, baseline +0.22 R, drawn on every disc that faces up more than 0.35, foreshortened with the disc | The number turns with the ball |
| Shade | radial in the ball's box, centre (.38, .34), r .78: `#FFF` α .5 0 · α .1 .3 · `#000` α 0 .72 · α .4 1 | Rotated: centre (.66, .38) |
| Specular | ellipse at screen (−.38 R, −.42 R), 0.2 R × 0.14 R, `#FFF` α .7 | |
| Edge | circle r R − .75, 1.5 mm `#000` α .35 | |
| Level of detail | diameter on screen < 15 px: skip the numbers; < 9 px: skip specular. Markings are rasterised at 2× below 64 device px | Phone portrait draws balls at ~10 px |

## Cue stick

- Tip at `cue − dir × (R + 20 + power × 120)`, length 1200 along `−dir`.
- Width tapers from 12 mm at the tip to 28 mm at the butt: draw each segment as a quad.
- Segments from the tip: tip 0–10 `#2F5F8A` · ferrule 10–30 `#F2EEE3` · shaft 30–720 linear `#EEE1C4 → #C9A56C` · joint 720–735 `#D8C59C` · forearm 735–900 `#6B4325` · wrap 900–1130 `#1C1916` · butt 1130–1200 `#2A1A0F`.
- Centre highlight 30–1120, 2 mm `#FFF` α .16.
- Shadow: the same outline at screen (+10, +14), `#000` α .28.

## Aim guide

| Part | Spec |
|---|---|
| Path | cue-ball edge → ghost edge, 3 mm `#FFF` α .78, dash 20 / 14, round caps |
| Ghost ball | r R, stroke 3 mm `#FFF` α .78, fill `#FFF` α .06 |
| Object direction | from the object ball's edge, `aimLine` from `welcome` (100 mm by default; none when 0), chevron shrinks to 0.4 × the line when shorter than 60 mm, 4 mm `#E3B25C` α .95, chevron 18 × 24 at the end |
| Cue deflection | from the ghost edge along the tangent, half the object direction, 3 mm `#FFF` α .5, dash 10 / 10 |
| Opponent preview | same geometry, colour `#A9C1DD`, group α .5, cue α .4, no brass |

## Highlights

| State | Spec |
|---|---|
| Legal target | ring r R + 10, 3 mm `#FFF` α .55 (only while a call is needed) |
| Called ball | ring r R + 12, 5 mm `#D9A441`, plus halo r R + 20, 8 mm `#D9A441` α .22 |
| Ball in hand | ring r R + 14, 4 mm `#71C99D` |
| Dragging the cue ball | scale 1.05, shadow × 1.8, ring r 1.05 R + 14, 5 mm `#FFF` |
| Kitchen wash | `rect(0, 0, 635, 1270)` `#FFF` α .06, plus the green head string |
| Hover label | pill h 52, r 26, `#0D1218` α .92, stroke 1.5 `#AABED7` α .22; text 600 30 mm Source Sans 3 `#E8ECF1`; centred R + 46 above the ball on screen. Text: “3 · solids”, “8-ball”, “cue ball”. On touch, shown for 1.5 s after a tap |

## Motion on the canvas

All of these interpolate only scale, alpha and position in the 60 fps loop.

| Effect | Trigger | Parameters | Reduced motion |
|---|---|---|---|
| Pocket drop | the server stops reporting a ball (keep its last position) | 180 ms, `--ease-spring`; scale 1 → .6; position 35 % toward the pocket centre; α → 0 over the last 60 ms | α 1 → 0 in one frame |
| Rim flash | same moment | 120 ms ease-out; pocket rim stroke 6 mm `#FFE2B4` α .5 → 0; one per ball | none |
| Cue strike | shot sent | tip → ball edge 80 ms ease-in; then cue α 1 → 0 over 200 ms ease-out | hide the cue |
| Strike ring | contact | 150 ms ease-out; ring r R → R + 40, width 3 → 1, `#FFF` α .6 → 0 | none |
| Contact glint (optional) | ball–ball / ball–cushion | 100 ms; specular α .7 → 1 → .7; max one per ball per 100 ms; skip when > 8 contacts in a frame | none |
| Cue ball lift / settle | press / release while in hand | 120 ms ease-out to scale 1.05 and shadow × 1.8; back in 150 ms ease-out | shadow only |
| Aim guide fade | balls stopped and the turn is mine | group α 0 → 1, 200 ms ease-out | instant |
| Opponent aim | each aim message (≤ 10 / s) | ease positions over 100 ms | jump |

Easings: out `cubic-bezier(.2,.8,.2,1)`, in `cubic-bezier(.4,0,1,1)`,
in-out `cubic-bezier(.45,0,.25,1)`, spring `cubic-bezier(.34,1.56,.64,1)`.
In JS a cubic-bezier can be evaluated with a small solver, or approximated:
out ≈ `1 - (1 - t) ** 3`, in ≈ `t ** 3`, spring ≈ `1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2`.
