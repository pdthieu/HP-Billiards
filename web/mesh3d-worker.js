// mesh3d-worker.js: meshes a player's look off the page's thread for
// players3d.js (body3d.js meshLook), and hands the arrays back without a
// copy.
import { meshLook, transfers } from '/body3d.js';

self.onmessage = (e) => {
  const { id, look, coarse } = e.data;
  try {
    const data = meshLook(look, coarse);
    self.postMessage({ id, data }, transfers(data));
  } catch (err) {
    self.postMessage({ id, error: String((err && err.stack) || err) });
  }
};
