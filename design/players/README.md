# Players in 3D: the prototype

The two players on the canvas's "Players (3D)" page come from this folder. It is a prototype for review, not part of the game: nothing in `web/` loads it.

- `sdf.js`: solids as signed distance functions, blended like clay, and a mesher (surface nets) that turns them into triangles.
- `body.js`: the two looks (`MAN`, `WOMAN`): the bones, and the solids of the body and clothes, the head and hair, the hands (relaxed, bridge, grip), the shoes, cuffs and collar.
- `rig.js`: the Three.js side: meshes on a skeleton (skin weights from the bones), the materials (the clothes' and face's edges drawn in the shader from masks), and the poses: `stand`, `sit` (the arena's chair), `stance` (solved from the cue: bridge, grip, head over the cue), `firstPerson` (only the bridge arm).
- `sheet.html`, `sheet.js`: a stage to look at them: `?scene=sheet|face|stance|hands`.
- `inject.js`: puts them into the running game's 3D view without changing it, for pictures.

To take the pictures (Playwright from `e2e/node_modules`):

```bash
node design/players/shoot.js out.png "scene=stance&view=side&w=1400&h=930"
```

The looping stroke, as JPEG frames in a folder:

```bash
node design/players/anim.js design/players/out/stroke "scene=stance&view=side&frames=24"
```

```bash
node design/players/ingame.js aim lobby phone land
```

`ingame.js` needs the dev server on port 8093 and writes to `design/players/out/`, which git ignores.
