// inject.js: the players in the game's own 3D view, for pictures. Loaded
// into the running game before its 3D view: it catches the table's scene
// on its first frame and adds the two players to it; each frame the shooter
// takes up the stance the game's cue asks for and the other waits in a chair.
import * as THREE from '/vendor/three-r186/three.min.js';
import { createPlayer, stand, sit, stance, makeCue, BED } from '/chars/rig.js';
import { MAN, WOMAN } from '/chars/body.js';

const W = 2.54, H = 1.27, RAIL = 0.1, R = 0.028575, FLOOR = -0.78;
const st = { scene: null, cueMesh: null, shooter: null, waiter: null, mode: 'auto', fp: null, chairs: [], seat: 1, standAt: null };
window.__chars = st;

// the arena's chairs (arena3d.js layout): two opposite corners
for (const s of [-1, 1]) {
  const x = W / 2 + s * (W / 2 + RAIL + 0.95), z = H / 2 - s * (H / 2 + RAIL + 0.95);
  st.chairs.push({ x, z, face: Math.atan2(W / 2 - x, H / 2 - z) });
}

function findCue(scene) {
  let found = null;
  scene.traverse((o) => { if (!found && o.isMesh && o.geometry && o.geometry.type === 'CylinderGeometry' && Math.abs(o.geometry.parameters.radiusTop - 0.0065) < 1e-6) found = o; });
  return found;
}

function setup(scene, cueMesh) {
  st.scene = scene;
  st.cueMesh = cueMesh;
  const t0 = performance.now();
  const mk = (look) => { const p = createPlayer(look, { coarse: Number(window.__charsCoarse || 1) }); p.setRoomLight(Number(window.__charsLight || 2.2)); scene.add(p.root); const cue = makeCue(); p.root.add(cue); return { p, cue }; };
  st.shooter = mk(window.__charsShooter === 'woman' ? WOMAN : MAN);
  st.waiter = mk(window.__charsShooter === 'woman' ? MAN : WOMAN);
  st.built = Math.round(performance.now() - t0);
}

const tmp = new THREE.Vector3(), tipDir = new THREE.Vector3(), q = new THREE.Quaternion();
let lastStance = null;
function update(camera) {
  const S0 = st.shooter, S1 = st.waiter;
  // the one waiting sits in a chair, hidden like the chair when the camera
  // comes close
  const c = st.chairs[st.seat];
  S1.p.root.position.set(c.x + Math.sin(c.face) * 0.05, FLOOR, c.z + Math.cos(c.face) * 0.05);
  S1.p.root.rotation.y = c.face;
  if (!S1.seated) { sit(S1.p, S1.cue); S1.seated = true; }
  S1.p.root.visible = camera.position.distanceTo(tmp.set(c.x, FLOOR + 0.6, c.z)) > 0.6;

  if (st.mode === 'stand') {
    // both up, by the chairs
    for (const [pl, i] of [[S0, 1 - st.seat], [S1, st.seat]]) {
      const ch = st.chairs[i];
      const off = st.standAt ? st.standAt[i] : [0.62, 0.62];
      const fx = Math.sin(ch.face), fz = Math.cos(ch.face);
      pl.p.root.position.set(ch.x + fx * off[1] + fz * off[0], FLOOR, ch.z + fz * off[1] - fx * off[0]);
      pl.p.root.rotation.y = ch.face;
      if (pl.posed !== 'stand') { stand(pl.p, pl.cue); pl.cue.visible = true; pl.posed = 'stand'; pl.p.firstPerson(false); }
      pl.p.root.visible = true;
    }
    return;
  }
  S1.posed = 'sit';
  // the shooter: down on the game's cue while it shows
  const cm = st.cueMesh;
  if (cm.visible && cm.material.opacity > 0.05) {
    cm.updateMatrixWorld(true);
    tipDir.set(0, 1, 0).applyQuaternion(cm.getWorldQuaternion(q)).normalize();
    const tip = cm.getWorldPosition(new THREE.Vector3()).add(tipDir.clone().multiplyScalar(cm.geometry.parameters.height / 2));
    const balls = typeof displayBalls === 'function' ? displayBalls() : null;
    const id = typeof cueId === 'function' ? cueId() : 0;
    const b = balls && balls.get(id);
    if (b) {
      const ball = new THREE.Vector3(b.x, R + (b.z || 0), b.y);
      const f = new THREE.Vector3(tipDir.x, 0, tipDir.z).normalize();
      const yaw = Math.atan2(f.x, f.z);
      const pull = Math.max(0, ball.distanceTo(tip) - R);
      const elev = Math.asin(Math.min(1, Math.max(-1, -tipDir.y))) - 6 * Math.PI / 180;
      lastStance = { ball, yaw, pull, elev };
    }
  }
  if (lastStance) {
    const { ball, yaw, pull, elev } = lastStance;
    S0.p.root.rotation.y = yaw;
    S0.p.root.position.set(ball.x - Math.sin(yaw) * 1.0, FLOOR, ball.z - Math.cos(yaw) * 1.0);
    S0.p.root.updateMatrixWorld(true);
    stance(S0.p, null, { ball: new THREE.Vector3(0, BED + R, 1.0), pull: cm.visible && cm.material.opacity > 0.05 ? pull : 0.0, elev: Math.max(0, elev) });
    S0.cue.visible = !(cm.visible && cm.material.opacity > 0.05);
    if (S0.cue.visible) { // after the stroke: the cue held through the ball
      const back = new THREE.Vector3(0, Math.sin(elev + 6 * Math.PI / 180), -Math.cos(elev + 6 * Math.PI / 180));
      S0.cue.position.set(0, BED + R, 1.0).add(back.clone().multiplyScalar(R - 0.05));
      S0.cue.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), back.clone().negate());
    }
    S0.posed = 'stance';
    // through the shooter's eyes only the bridge arm shows
    S0.p.bones.head.getWorldPosition(tmp);
    const fp = st.fp !== null ? st.fp : camera.position.distanceTo(tmp) < 0.75;
    S0.p.firstPerson(fp);
    S0.p.root.visible = true;
  } else S0.p.root.visible = false;
}

// the renderer's render() is its own (not the prototype's), but it calls
// each scene's onBeforeRender first
const before = THREE.Scene.prototype.onBeforeRender;
THREE.Scene.prototype.onBeforeRender = function (renderer, scene, camera, target) {
  if (!st.scene && !this.background && this.environment) {
    const cue = findCue(this);
    if (cue) setup(this, cue);
  }
  if (this === st.scene) { try { update(camera); } catch (e) { console.error('chars', e && e.stack || e); } }
  return before.call(this, renderer, scene, camera, target);
};
window.__charsReady = true;
