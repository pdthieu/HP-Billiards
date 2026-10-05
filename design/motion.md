# Motion sheet

Rules: nothing longer than 600 ms; the your-turn pulse is the only loop;
table effects use only scale, alpha and position. Durations and easings come
from `tokens.css` (`--dur-1` 120 · `--dur-2` 160 · `--dur-3` 200 · `--dur-4` 240 ·
`--dur-5` 320 · `--dur-6` 450 · `--dur-7` 600 · `--dur-pulse` 2000).
Keyframes live in `components.css`. The interactive version is the
“9 · Motion” page of the design canvas.

| Name | Trigger | Properties | Time · easing · delay | Reduced motion |
|---|---|---|---|---|
| Landing card enter | landing shown | opacity 0 → 1, translateY 8px → 0 | 240 ms · out | opacity only, instant |
| Room row stagger | poll returns a code not on screen | opacity, translateY 6px → 0. Key rows by room code; unchanged rows are never re-rendered. Removed rows fade 160 ms ease-in, then collapse 200 ms | 240 ms · out · 40 ms × index among **new** rows | none |
| Name field shake | create/join with empty name | translateX 0 −6 5 −3 2 0 px; border → `--foul` | 300 ms · out · once | border only |
| Your-turn pulse | my turn, balls stopped | box-shadow ring 0 → 8px, α .55 → 0 | 2000 ms · in-out · infinite; `.is-moving` pauses it | static 3px ring |
| Score tick | score digit changes | old digit translateY 0 → −100% + fade; new 100% → 0; digit brass for 1.2 s | 240 ms · spring | swap |
| Seat offline | opponent drops | dashed border (instant), saturate 1 → .25, background → transparent | 320 ms · out | instant |
| Panel cross-fade | panel slot content changes | old α → 0 (120 ms in), new α 0 → 1; slot height fixed | 200 ms · out | instant |
| Call line change | call set or cleared | translateY 4px → 0, α 0 → 1 | 200 ms · out | instant |
| Safety fill | Safety on | `::before` scaleX 0 → 1 from the left; off: → 0, 120 ms in | 160 ms · out | instant |
| Spin dot drag | pointer moves on the pad | left/top = pointer, clamped | none | same |
| Spin reset | Reset | left/top → 50% | 200 ms · spring | instant |
| Status cross-fade | status sentence changes | both in one grid cell; old α → 0 (in), new α 0 → 1 (out) | 200 ms | instant |
| Power fill | dragging | fill height = pull; colour = ramp at the edge | none | same |
| Shoot flash | release below the cancel zone | track ring 0 → 3px → 0; fill → 0 | 150 ms · in | fill jumps |
| Cancel spring | release in the top 8% | fill → 0 with 4% overshoot | 250 ms · spring | fill jumps |
| Cue strike (canvas) | shot sent | tip → ball 80 ms in; cue α → 0 200 ms out; ring R → R+40 150 ms out | 80 + 200 ms | hide cue |
| Pocket drop (canvas) | ball disappears | scale 1 → .6, 35% toward pocket, α → 0 last 60 ms; rim flash 120 ms out | 180 ms · spring | α → 0 in a frame |
| Contact glint (canvas) | contact | specular α .7 → 1 → .7; ≤ 1 per ball per 100 ms; skip if > 8 per frame | 100 ms · out | none |
| Cue ball lift (canvas) | press on cue ball in hand | scale 1.05, shadow × 1.8; settle 150 ms out | 120 ms · out | shadow only |
| Aim guide fade (canvas) | turn becomes mine, balls stopped | α 0 → 1 | 200 ms · out | instant |
| Decision dialog | illegal break / 8 on the break | scrim fade 200 ms; dialog scale .96 → 1 + α; options rise | 240 ms · out · options +40 ms each | fade only |
| Game-over sweep | I win the rack | banner fade 240 ms; light band sweeps once | 600 ms · in-out · 200 ms delay | no sweep |
| Toast enter | toast shown | translateY 12px → 0, α 0 → 1 | 200 ms · out | instant |
| Toast exit | 3.5 s, or dismissed (errors 6 s) | α → 0, translateY 8px; the rest slide 320 ms out | 160 ms · in | instant |
| Reconnect card | socket closed > 300 ms | scrim fade; card scale .96 → 1; exit α → 0 200 ms in | 240 ms · out | fade only |
| Reconnected toast | rejoin succeeds | toast enter; auto-dismiss 2 s | 200 ms · out | instant |
| Rejoin splash | reload inside a room | appears only after 150 ms; fade in | 200 ms · out · 150 ms delay | appears at 150 ms |
