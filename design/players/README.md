# Players in 3D: the prototype

The players on the canvas's "Players (3D)" page come from this folder. It is a prototype for review, not part of the game: nothing in `web/` loads it.

- `sdf.js`: solids as signed distance functions, blended like clay, and a mesher (surface nets) that turns them into triangles.
- `body.js`: a player's look and its solids.
  - `makeLook()` takes a few choices and fills in the rest: the body (`man`, `woman`), the skin, the hair (`short`, `quiff`, `buzz`, `pony`, `bun`) and its colour, the eyes' colour, the face's measures (`FACE`: width, jaw, chin, cheeks, the eyes' size and gap, nose, mouth, lips, brows, beard) and the side, whose colour the waistcoat takes. These are what a photo could set. `MAN` and `WOMAN` are the two defaults.
  - The bones, and the solids of the body and clothes, the head, the hair, the hands (relaxed, bridge, grip), the shoes, cuffs and collar.
- `rig.js`: the Three.js side.
  - Meshes on a skeleton (skin weights from the bones) and the materials. The face's shader draws the brows, lash lines, lips and blush from the head's measures, crisp at any distance; the hair's adds a highlight along the strands.
  - The poses: `stand`, `sit` (the arena's chair), `stance` (solved from the cue: the bridge, the grip under the elbow, the head over the cue), `idle` (nothing in the hands, for the player's own screen) and `firstPerson` (only the bridge arm, its sleeve fading out above the elbow).
  - `createPlayer(look, { coarse })` meshes at that many times the parts' own steps. 2.2 is the game's weight: on a desktop about 0.7 s and 160k triangles a player, against 3.5 s and 800k at 1.
- `sheet.html`, `sheet.js`: a stage to look at them: `?scene=sheet|face|heads|stance|hands|variety`, with `&coarse=2.2` for the game's weight. `?scene=portrait&look={…}&view=head|bust|full&bg=none` draws any look (the JSON `makeLook()` takes) on a clear background, for pictures laid over the app's own; `shoot.js` keeps the clear background in its PNG.
- `inject.js`: puts them into the running game's 3D view without changing it, for pictures.

To take the pictures (Playwright from `e2e/node_modules`):

```bash
node design/players/shoot.js out.png "scene=stance&view=side&w=1400&h=930"
```

The looping stroke, as JPEG frames in a folder:

```bash
node design/players/anim.js design/players/out/stroke "scene=stance&view=side&frames=24"
```

In the running game, meshed at the game's weight:

```bash
COARSE=2.2 node design/players/ingame.js aim lobby phone land
```

`ingame.js` needs a dev server (`BASE`, by default port 8093) and writes to `design/players/out/`, which git ignores. Each picture opens a room, so a server started with a small `-max-rooms` soon refuses more.
