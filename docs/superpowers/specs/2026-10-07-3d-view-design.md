# 3D view, automatic camera and shot replay

## Goal

The table can be shown in 3D as well as from above: a table that looks like
a real one, aiming from behind the cue, and a replay of the last shot with a
moving camera. The 2D view stays, for devices without WebGL and as the
default on phones.

## Choices

- Real 3D with Three.js, vendored under `web/vendor/three-r<N>/` and loaded
  only when 3D is turned on. The server does not change rules, physics or
  protocol; it gzips text files and caches the versioned library for a year.
- Default view: 3D on desktops, 2D on phones (`compactLayout`). The choice is
  kept in Settings (`pool:view`); a header button switches at any time.
- No WebGL, or the library fails to load: back to 2D with a notice.

## Architecture

- `web/view3d.js` is an ES module that only draws. `app.js` imports it on
  demand and hands it a frame each animation frame: ball positions and
  orientations, aim and cast, rings, effects, and the camera mode. It knows
  nothing about rules or the server.
- `app.js` keeps all state and computation (rules, `castAim`, rolling
  `orient`, interpolation in `displayBalls`). In 3D the 2D canvas becomes a
  transparent overlay that takes the pointer and draws ball labels;
  `toTable`/`toScreen` go through the 3D view's `pick`/`project`, so the
  existing input code (aim by the butt, ball in hand, pocket taps, ball
  names) works unchanged.
- Axes: table x → world x, table y → world z, into the slate → world −y. A
  ball's world rotation is `M·O·Mᵀ` of its 2D orientation, so a ball shows
  the same face in both views.

## Camera

- `aim`: behind the cue ball, low, looking along the aim; the opponent's
  turn uses their aim. Dragging sideways turns the aim, finer near the
  bottom of the screen (the cue's butt); the ±0.25°/±5° buttons and arrows
  still work.
- `follow`: high and oblique, framing the moving balls, while a shot runs.
- `top`: straight down, by a button or automatically with ball in hand,
  while dragging a ball, or with the practice Move tool. Aiming here is the
  2D drag.
- `overview`: a three-quarter view in the lobby and after a rack.
- Moves ease over about 0.6 s; with reduced motion they cut.

## Replay

- Each shot's snapshots are recorded from `t = 0` (not when joining mid-shot)
  and kept when the balls settle.
- A Replay button beside the status line (and `R`) plays the last shot at
  0.5×: the cue draws back and strikes, then the balls run with their
  sounds and pocket drops. Local only; the opponent never waits.
- A touch or a key ends it, as does a new shot. When it is my turn, the
  first touch only ends the replay.
- In 3D the camera chases the cue ball to its first contact, then the
  fastest object ball until it drops or stops, holds 0.5 s and returns. In
  2D the balls replay on the flat table.

## Testing

- Existing e2e scenarios pin 2D. A new `view3d` scenario runs Chromium with
  SwiftShader WebGL: default view per device, pick/project (tap a ball to
  name it), aiming from behind, camera modes, top view placement, replay in
  3D and 2D, the no-WebGL fallback.
- Go tests for gzip and the embedded vendor files.
