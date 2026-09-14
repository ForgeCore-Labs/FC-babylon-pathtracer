# Credits

This library is a reorganisation and extension of existing work. Nothing here is
third-party code shipped as a binary; the credits below are for the algorithms
and sources the code derives from.

## Upstream

- **Babylon.js Path Tracing Renderer** — Erich Loftis (erichlof). The original
  path tracer this library is ported from; its `PathTracingCommon.js` was split
  into `src/core/glsl/` by `tools/split-glsl.mjs`.
- **BVH (Surface Area Heuristic)** — `src/core/bvh/BVH_SAH_Quality_Builder.js`
  is a JavaScript port by Erich Loftis of a C++ builder inspired by Thanassis
  Tsiodras (ttsiodras), `renderer-cuda/src/BVH.cpp`.

## Shadertoy / snippets

- **`rng()`** — Inigo Quilez ("iq"), Shadertoy. Used for per-sample randomness
  (`pathtracing_random`).
- **Tone-mapping curves** — Reinhard (source noted in-shader as
  `cs.utah.edu/~reinhard/cdrom/`), the ACES Narkowicz 2015 approximation, and the
  Khronos PBR Neutral tone mapper (2024).

## Runtime dependencies

- **Babylon.js** — peer dependency; not bundled.

## Assets

The demo in `exmaples/` reads its assets from `textures/`. None of them are part
of the published package (`package.json` -> `files` excludes `exmaples/` and
`textures/`).

- **`BlueNoise_RGBA256.png`** — the tracer's required blue-noise texture.
- **`symmetrical_garden_2k.hdr`** — a third-party equirectangular environment
  map used for image-based lighting in the demo. **Confirm its source and licence
  before redistributing.**
- **`test.glb`** — the demo's test model.

---

**Before publishing:** verify each upstream licence (the roadmap records the
upstream as CC0, with Shadertoy snippets credited above) and confirm the
repository's `LICENSE` choice matches it.
