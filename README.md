# babylon-pathtracer

A **Cycles-style progressive GPU path tracer** for Babylon.js — scene-agnostic
ingestion, first-hit AOVs, firefly clamping, GPU a-trous denoise, reproducible
sampling and PNG export.

Build a scene the normal Babylon way (`MeshBuilder`, `PBRMaterial`, lights,
glTF, `scene.environmentTexture`), hand it to the library, and it path-traces it
on the GPU with progressive sample accumulation.

Usage guide and settings reference: **[`USAGE.md`](./USAGE.md)**.

---

## Requirements

- **Node ≥ 18** — only for the local demo server and the build. There is
  **nothing to `npm install`** to build, test, or run the demo.
- **A browser with WebGL2** and float render targets (WebGL1 is not supported).
- **Internet access for the demo** — it loads Babylon from a CDN.

---

## Start here

### 1. Run the demo

Serve the **repo root** over HTTP, then open the demo page:

```sh
npx serve .                    # or: python -m http.server 3000
```

Open **<http://localhost:3000/exmaples/test.html>**.

You get a procedural scene (ground, a row of spheres, coloured lights) with a
live control panel: view modes, AOVs, a-trous denoise, firefly clamp,
seed, material edits, light toggles, post-process and PNG export. The tracer's
one asset — the blue-noise texture — is read from `textures/`.

> Serve over **HTTP, not `file://`**. On `file://` the texture fetch fails and
> the geometry Web Worker is blocked.

### 2. Build and test

```sh
npm run build     # -> dist/pt_lib.core.js, dist/pt_lib.esm.js, dist/pt_lib.iife.js
npm test          # seven headless suites (Babylon is mocked)
```

Two things worth knowing:

- It is **`npm run build`**, not `npm build`. `build` is a script in
  `package.json`; npm only maps a handful of names (`test`, `start`, …) to bare
  commands. `npm run` on its own lists every available script.
- **`dist/` is committed on purpose**, so `<script>` / CDN users get a working
  bundle. Rebuild after editing anything in `src/` and commit the regenerated
  `dist/` in the same commit.

---

## Use it in your project

The package is **not on the npm registry yet**. Until the first publish, consume
it one of three ways:

**a) A `file:` dependency** (best while developing against it)

```sh
npm install @babylonjs/core
npm install /path/to/babylon-pathtracer
```

**b) A packed tarball**

```sh
npm pack                       # in this repo -> babylon-pathtracer-0.1.0.tgz
npm install /path/to/babylon-pathtracer-0.1.0.tgz
```

**c) The IIFE bundle, no install at all** — see *Script tag* below.

`@babylonjs/core` is a peer dependency. The package is **ESM-only** (there is no
CommonJS build); use the IIFE bundle for classic `<script>` usage.

### ESM

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

// optional: GPU denoise (ships with the library)
app.pathTracer.setDenoise(PT_LIB.denoise.aTrous({ iterations: 3 }));

// optional: reproducibility + a still
app.pathTracer.setSeed(7);
await app.pathTracer.exportImage({ download: true, aovs: true });
```

The library also attaches to the global as `PT_LIB` (and `BABYLON.PathTracer`),
which is why the snippet above can keep using `BABYLON.*`. Prefer explicit
imports? The ESM entry also re-exports `PathTracer`, `scenes`, `denoise`,
`glsl`, `ingestScene` and `buildScenePrelude`.

### Script tag (IIFE)

The IIFE bundle contains everything — GLSL, the BVH, ingestion, both denoisers
and the inlined worker sources — so it is the only library script you need:

```html
<script src="https://cdn.babylonjs.com/babylon.max.js"></script>
<script src="dist/pt_lib.iife.js"></script>
<script>
  const app = PT_LIB.scenes.universal.create(canvas, { /* ... */ });
</script>
```

It needs a global `BABYLON` (load Babylon first) and exposes `window.PT_LIB`.

---

## What you get

| | |
|---|---|
| **Ingestion** | Ordinary Babylon meshes / `PBRMaterial` / `StandardMaterial` / lights / `environmentTexture` — no hardcoded scene content. A Web Worker does the packing + BVH build by default. |
| **Render** | Progressive accumulation, `imageProcessingConfiguration` tonemap, a post-process chain after the tonemap. |
| **Quality** | Specular NEE, IBL, `fireflyClamp`, reproducible `seed`. |
| **Denoise** | `PT_LIB.denoise.aTrous()` — a GPU edge-aware filter over the AOVs, zero readback, live-tunable. |
| **Output** | `exportImage()` → PNG of beauty ± the albedo / normal / depth AOVs. |

## Denoise

```js
// GPU a-trous: works immediately, live-tunable
const atrous = PT_LIB.denoise.aTrous({ iterations: 3, phiNormal: 128 });
pt.setDenoise(atrous);
atrous.setParams({ iterations: 4, phiDepth: 8 });
```

## Repository layout

```
dist/       prebuilt bundles (committed): esm, iife, core, hand-written .d.ts
src/        the library source (PathTracer, core ingestion/BVH/GLSL, denoise, scenes)
tools/      build + headless test scripts (plain Node)
exmaples/   the runnable demo (test.html + GUI.js + demo.css)
textures/   the demo's assets — blue-noise texture, HDR environment, test.glb
```

## Licensing

CC0-1.0 — see [`LICENSE`](./LICENSE) and [`CREDITS.md`](./CREDITS.md). The
library is a port of an existing Babylon.js path tracer; upstream is CC0 with
Shadertoy-derived snippets credited in `CREDITS.md`.

If you are republishing, confirm the upstream terms in `CREDITS.md` first.
