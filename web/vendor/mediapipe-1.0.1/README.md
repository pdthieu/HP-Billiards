# MediaPipe Tasks Vision 1.0.1

The face reader of "Your player" (web/face3d.js): it finds the face in a
photo, on the device, so a player can be made from it. Loaded only when a
player picks a photo.

- `vision_bundle.mjs`, `vision_wasm_internal.js`, `vision_wasm_internal.wasm`
  (the SIMD build): from the npm package `@mediapipe/tasks-vision` 1.0.1,
  https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-1.0.1.tgz
  (sha512-rvRE2FmAZ6ZxKSw7wq+e+jQDpN3t1B/tD2mJz9SmAzb1msoDkd4dMoE4wAh8Z30Um0PQwLiHr9QtomhmXk3aUQ==),
  unchanged.
- `face_landmarker.task` (float16, version 1): from
  https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
  (sha256 64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff).

Both are Copyright The MediaPipe Authors and licensed under the Apache
License, Version 2.0 (LICENSE, from https://www.apache.org/licenses/LICENSE-2.0.txt).
