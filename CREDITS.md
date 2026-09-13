# Credits

This library is a reorganisation and extension of existing work. Nothing in
`pt_lib/` is third-party code shipped as a binary; the credits below are for the
algorithms and sources the code derives from.

## Upstream

- **Babylon.js Path Tracing Renderer** — Erich Loftis (erichlof). The original
  path tracer this library is ported from (`js/` in this repo is the untouched
  reference copy). `js/PathTracingCommon.js` was split into
  `src/core/glsl/` by `tools/split-glsl.mjs`.
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
- **Intel Open Image Denoise (OIDN)** — *optional*, **not bundled**. The OIDN
  backend drives a caller-supplied WebAssembly build of OIDN through its C API;
  see `vendor/README.md`. OIDN is licensed separately by Intel.

## Assets

- Demo blue-noise texture (`textures/BlueNoise_RGBA256.png`), models and
  environment maps live outside `pt_lib/` and are not part of the package.

---

**Before publishing:** verify each upstream licence (the roadmap records the
upstream as CC0, with Shadertoy snippets credited above) and confirm the
repository's `LICENSE` choice matches it.
