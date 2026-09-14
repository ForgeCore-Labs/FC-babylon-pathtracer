# Credits

This library is a reorganisation and extension of existing work. Nothing here is
third-party code shipped as a binary; the credits below are for the algorithms
and sources the code derives from.

## Upstream

- **Three.js Path Tracing Renderer** — Erich ([@erichlof](https://github.com/erichlof)),
  the original renderer this library derives from. It was ported to Babylon.js by
  [@PichouPichou](https://github.com/PichouPichou) and contributors; that port's
  `PathTracingCommon.js` was split into `src/core/glsl/` by
  `tools/split-glsl.mjs`, and the rest was refactored into the modules under
  `src/`.
- **BVH (Surface Area Heuristic)** — `src/core/bvh/BVH_SAH_Quality_Builder.js`
  is a JavaScript port by Erich of a C++ builder inspired by Thanassis
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
- **`symmetrical_garden_2k.hdr`** — an open-source equirectangular environment
  map used for image-based lighting in the demo.
- **`test.glb`** — the demo's test model.

---

**Before publishing:** the upstream is CC0 and the Shadertoy snippets are
credited above — keep this file in sync when adding third-party code or assets.
