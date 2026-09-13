# babylon-pathtracer

A **Cycles-style progressive GPU path tracer** for Babylon.js — scene-agnostic
ingestion, first-hit AOVs, firefly clamping, GPU à-trous and OIDN denoise hooks,
reproducible sampling and PNG export.

Full documentation: **[`PT_README.md`](./PT_README.md)**.
Design + roadmap: **[`../develop.md`](../develop.md)**.
Resume notes: **[`../HANDOFF.md`](../HANDOFF.md)**.

## Install

```sh
npm install babylon-pathtracer @babylonjs/core
```

`@babylonjs/core` is a peer dependency. The package is **ESM-only** (there is no
CommonJS build) — use the IIFE bundle for classic `<script>` usage.

## Usage (ESM)

```js
import { PT_LIB } from "babylon-pathtracer";

const app = PT_LIB.scenes.universal.create(canvas, {
  resolutionScale: 1.0,
  maxSamples: 256,
  fireflyClamp: 8,          // 0 = off
  setup: async (scene, camera) => {
    const ball = BABYLON.MeshBuilder.CreateSphere("ball", { diameter: 2 }, scene);
    ball.material = new BABYLON.PBRMaterial("m", scene);
    new BABYLON.PointLight("key", new BABYLON.Vector3(3, 6, -3), scene);
  }
});

// optional: GPU denoise (no extra dependency)
app.pathTracer.setDenoise(PT_LIB.denoise.aTrous({ iterations: 3 }));

// optional: reproducibility + a still
app.pathTracer.setSeed(7);
await app.pathTracer.exportImage({ download: true, aovs: true });
```

The library attaches to the global as `PT_LIB` (and `BABYLON.PathTracer`), which
is why the example above can reference the `BABYLON` you imported globally. If
you prefer explicit imports, the ESM entry also re-exports `PathTracer`,
`scenes`, `denoise`, `glsl`, `ingestScene` and `buildScenePrelude`.

## Usage (script tag / IIFE)

```html
<script src="https://cdn.babylonjs.com/babylon.max.js"></script>
<script src="https://unpkg.com/babylon-pathtracer/dist/pt_lib.iife.js"></script>
<script>
  const app = PT_LIB.scenes.universal.create(canvas, { /* ... */ });
</script>
```

The IIFE build needs a global `BABYLON` (load Babylon first) and exposes
`window.PT_LIB`.

## What you get

| | |
|---|---|
| **Ingestion** | Ordinary Babylon meshes / `PBRMaterial` / `StandardMaterial` / lights / `environmentTexture` — no hardcoded scene content. A Web Worker does the packing + BVH build by default. |
| **Render** | Progressive accumulation, `imageProcessingConfiguration` tonemap, a post-process chain after the tonemap. |
| **Quality** | Specular NEE, IBL, `fireflyClamp`, reproducible `seed`. |
| **Denoise** | `PT_LIB.denoise.aTrous()` (GPU, zero readback) and an OIDN hook over a caller-supplied WASM module. |
| **Output** | `exportImage()` → PNG of beauty ± the albedo / normal / depth AOVs. |

## Denoise

```js
// GPU à-trous: works immediately, live-tunable
const atrous = PT_LIB.denoise.aTrous({ iterations: 3, phiNormal: 128 });
pt.setDenoise(atrous);
atrous.setParams({ iterations: 4, phiDepth: 8 });

// OIDN: needs a WASM build exporting the oidn* C API (not bundled)
// see vendor/README.md
pt.setDenoise(PT_LIB.denoise.oidnHook(oidnModule, { hdr: true }));
```

## Building

```sh
npm run build     # tools/build-core.mjs + tools/build-dist.mjs  -> dist/
npm test          # seven headless suites
```

`dist/` is generated: `pt_lib.core.js` (registry + GLSL + BVH),
`pt_lib.esm.js`, `pt_lib.iife.js`, and the hand-written `pt_lib.d.ts`.

## Licensing

CC0-1.0 — see [`LICENSE`](./LICENSE) and [`CREDITS.md`](./CREDITS.md). The
library is a port of an existing Babylon.js path tracer; upstream is CC0 with
Shadertoy-derived snippets credited in `CREDITS.md`. **Confirm the upstream
terms before publishing.**
