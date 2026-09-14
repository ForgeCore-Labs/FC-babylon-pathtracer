# babylon-pathtracer — usage

How to drive the addon: what it does at a high level, then the settings you
actually touch and how they behave.

Install / build / publish live in **[`README.md`](./README.md)**.
A runnable page is **[`exmaples/test.html`](./exmaples/test.html)**.

---

## 1. The big picture

Build a scene the normal Babylon way and hand it to the tracer. Nothing about
the scene is hardcoded in a shader: the library reads the live scene, packs it
into float textures and drives one data-driven fragment shader.

| Area | What the tracer does |
|---|---|
| **Ingestion** | `scene.meshes` become world-space triangles; `PBRMaterial` / `StandardMaterial` become a material table; lights become emitters; `scene.environmentTexture` drives image-based lighting. Material and light **values** live in float textures (`tMaterialData` / `tLightData`), so property edits upload without recompiling the shader. |
| **Geometry / BVH** | Triangles are packed into float textures and a bounding-volume hierarchy is built over them. Two interchangeable builders: **SAH Quality** (active; `src/core/bvh/BVH_SAH_Quality_Builder.js`) and a faster, lower-quality **Fast** one (`BVH_Fast_Builder.js`). Both run off the main thread in a Web Worker by default. |
| **Lighting** | `PointLight`, `DirectionalLight`, `SpotLight` (true cones) and `HemisphericLight` (folded into the ambient term). Direct light uses next-event estimation (NEE); metals get specular NEE. `scene.environmentTexture` (cube map or equirectangular) lights the scene and shows up in reflections. |
| **Materials** | `PBRMaterial` / `StandardMaterial`: albedo colour, metallic, roughness, emissive (colour x intensity), plus albedo / normal (bump) / metallic-roughness / emissive maps drawn from one shared texture pool. |
| **Camera** | Perspective from the active camera, plus `apertureSize` / `focusDistance` for depth of field. |
| **Progressive rendering** | Each frame adds roughly one sample per pixel; the image refines toward the converged result and stops at `maxSamples` (`0` = converge indefinitely). |
| **Quality knobs** | `fireflyClamp` (kill specular fireflies) and `seed` (reproducible sampling). |
| **AOVs** | First-hit albedo / normal / depth, kept as float render targets on the GPU. |
| **Denoise** | A GPU **a-trous** filter that reads the AOVs. Zero readback. |
| **Output** | The Babylon `imageProcessingConfiguration` tonemap (exposure, contrast, Standard / ACES / Khronos PBR Neutral curve), an optional post-process chain, and PNG export. |

---

## 2. Minimal setup

```js
const app = PT_LIB.scenes.universal.create(canvas, {
  resolutionScale: 1.0,
  maxSamples: 256,          // 0 = converge indefinitely
  cameraPosition: [0, 2, -9],
  blueNoiseFile: './textures/BlueNoise_RGBA256.png',

  setup: async (scene, camera) => {
    // build an ordinary Babylon scene here
    const ball = BABYLON.MeshBuilder.CreateSphere('ball', { diameter: 2 }, scene);
    ball.material = new BABYLON.PBRMaterial('m', scene);
    new BABYLON.PointLight('key', new BABYLON.Vector3(3, 6, -3), scene);
  }
});

const pt = app.pathTracer;   // the PathTracer instance
await app.ready;             // ingestion finished, rendering started
```

`setup` may be sync or async; ingestion runs after it settles. `app.ready`
resolves once rendering has started.

---

## 3. Controlling samples

Samples are the only thing that changes the image quality, so this is the main
dial.

```js
// at construction
const app = PT_LIB.scenes.universal.create(canvas, { maxSamples: 256 });

// at runtime
pt.setMaxSamples(512);   // stop after 512 samples per pixel
pt.setMaxSamples(0);     // 0 = never stop (converge indefinitely)
pt.reset();              // restart accumulation from sample 0
```

**Always `reset()` after a change that invalidates accumulation.** Accumulation
is an average, so mixing samples rendered under different settings produces a
wrong image. That covers:

- `setMaxSamples` / a new `fireflyClamp` / a new `seed`,
- camera moves (handled automatically), scene edits, `resolutionScale`.

**Watching progress:**

```js
pt.onProgressObservable.add((samples) => { /* called once per rendered frame */ });
pt.onConvergedObservable.add((samples) => { /* accumulation locked */ });
pt.onErrorObservable.add((err) => { /* ... */ });
```

`onProgressObservable` fires once per rendered frame and is **skipped on
sample-locked frames**, so it is safe to drive a UI spinner from it. Once
converged, `maxSamples` is locked: the tracer stops adding samples until the
camera moves or you call `reset()`.

**Speed vs quality:** `resolutionScale` (0 < scale <= 1) renders fewer pixels
and scales the result up. Change it and call `pt.resize()`:

```js
pt.options.resolutionScale = 0.5;
pt.resize();
pt.reset();
```

Note the defaults differ by entry point: the universal adapter starts at
`resolutionScale: 0.5` / `maxSamples: 128`, while the bare `PathTracer` defaults
to `1.0` / `0` (see the tables in section 7).

---

## 4. Controlling materials

Materials are read from the **live Babylon materials** at ingest. Edit the
material object you already have — there is no separate material API.

**What is consumed:** `PBRMaterial` and `StandardMaterial` — albedo
(`albedoColor` / `diffuseColor`), `metallic`, `roughness`, emissive
(`emissiveColor` x `emissiveIntensity`), and the `albedoTexture` /
`diffuseTexture`, `bumpTexture` (normal), `metallicTexture`
(metallic-roughness) and `emissiveTexture` maps.

**Scalar edits are live** (no re-ingest, no recompile): albedo, metallic,
roughness, emissive colour/intensity, bump level and the channel flags upload
into `tMaterialData` and re-accumulate on the next frame. This is on by default
(`syncMaterials: true`):

```js
myPbrMaterial.metallic = 0.2;
myPbrMaterial.roughness = 0.8;
// nothing else to call — the next frame re-accumulates with the new values
```

**Structural edits need a re-ingest** — adding/removing meshes or swapping a
texture reference changes the baked geometry or the sampler pool:

```js
await app.reingest();     // re-pack, rebuild the BVH, recompile if needed
```

`app.reingest()` (aliased `app.rebuild`) is also what you call after editing
things that are not covered by the sync paths. Setting `autoReingest: true`
makes the adapter poll for such changes and re-ingest for you (debounced by
`reingestDebounceMs`), at the cost of a BVH rebuild — so it is off by default.

**Not consumed:** the occlusion (R) channel of a glTF ORM metallic-roughness
map, and `invertNormalMapX` / `invertNormalMapY` (this warns once at ingest).

---

## 5. Adding AOVs

The first-hit AOVs are RGB **albedo**, RGB shading **normal** and **depth**
(`depth.r` = linear hit distance, `1e6` where the ray escaped).

They are produced only when something needs them:

```js
// a) implicitly, by installing a denoise hook (section 6), or
// b) explicitly, for PNG export:
const app = PT_LIB.scenes.universal.create(canvas, { aovs: true });
```

They cost one primary-ray pass per channel, and are **re-rendered only when the
first hit changes** (accumulation reset or camera move), so a still camera pays
nothing.

**Viewing them** — the adapter's `debugMode` swaps the shader's output channel:

| `app.debugMode` | View |
|---|---|
| `0` | beauty (default) |
| `1` | albedo |
| `2` | normals |
| `3` | direct light |
| `4` | depth |

```js
app.debugMode = 2;         // show shading normals
pt.reset();
```

`showLights` is the companion switch for the adapter's emissive light markers.

**Exporting them** as PNGs:

```js
await pt.exportImage({ download: true, aovs: true, filename: 'still' });
// -> { beauty } plus { albedo, normal, depth } when aovs: true
```

The beauty PNG is the tonemapped output (before the user post-process chain);
the AOV PNGs are display-normalized — albedo gamma-encoded, normal `* 0.5 + 0.5`,
depth `1 - d / aovDepthFar` (default `aovDepthFar: 50`).

---

## 6. Adding a-trous denoise

a-trous is a GPU edge-aware filter that runs on the AOVs — no readback, no
extra dependency. Install it as the denoise hook:

```js
pt.setDenoise(PT_LIB.denoise.aTrous({
  iterations: 3,     // 1..6, default 3
  phiNormal: 128,    // edge-strictness for the normal AOV
  phiAlbedo: 32,     // ... for albedo
  phiDepth: 32       // ... for depth
}));
```

It runs every frame while converging and **reuses its result once
`converged`**, so it costs nothing on a settled image. It needs the AOVs, which
installing the hook enables for you; with no AOVs available it degrades to a
plain Gaussian blur.

**Tuning is live** — the render targets and effect are reused, only the
parameters change, so this is safe to bind to sliders:

```js
const atrous = PT_LIB.denoise.aTrous({ iterations: 3 });
pt.setDenoise(atrous);

atrous.setParams({ phiNormal: 64, phiAlbedo: 16, phiDepth: 8, iterations: 4 });
atrous.params;   // the current values
```

- **Higher phi = stricter edges**: edges are protected, more grain survives.
- **Lower phi = smoother**: kills more noise, risks bleeding across edges.
- Changing parameters drops the cached converged result, so the next frame
  re-filters with the new settings.

**Turn it off** with `pt.setDenoise(null)` (the identity: the resolve output
feeds the tonemap directly).

**Custom backend:** `PT_LIB.denoise.hook(denoiser)` wraps any
`denoiser.denoise({ color, albedo, normal, depth, width, height }) ->
Float32Array` into the same one-shot hook.

---

## 7. Parameters

### 7a. `PathTracer` (`app.pathTracer`)

| Option | Default | Meaning |
|---|---|---|
| `resolutionScale` | `1.0` | Render resolution multiplier, 0 < scale <= 1. |
| `maxSamples` | `0` | Samples per pixel before locking. `0` = converge indefinitely. |
| `maxBounces` | `5` | Path depth passed to the shader adapter. |
| `toneMappingExposure` | `1.0` | Exposure into the tonemap. |
| `sceneIsDynamic` | `false` | Declare a scene that changes every frame. |
| `postProcesses` | `null` | Full-screen passes after the tonemap (section 8). |
| `outputTarget` | `null` | `null` = the canvas; or a `RenderTargetTexture` you present yourself. |
| `denoise` | `null` | The hook, `function (ctx) -> texture \| Promise<texture>`. |
| `aovs` | `false` | Emit first-hit AOVs even without a denoise hook. |
| `fireflyClamp` | `0` | Linear luminance ceiling for one sample. `0` = off. |
| `seed` | `0` | `0` = non-deterministic; `> 0` = reproducible sampling. |
| `aovDepthFar` | `50` | Far plane used only to normalize the depth AOV on export. |
| `warnOnUnsupported` | `true` | Warn at `start()` when the engine can't run the tracer. |
| `autoDetectCameraMove` | `true` | Reset accumulation when the camera moves. |
| `warnUnboundUniforms` | `true` | Warn about declared-but-unbound uniforms. |
| `edgeSharpenSpeed` | `0.05` | How fast the progressive box filter fades as samples accumulate. |
| `filterDecaySpeed` | `0.0002` | Progressive filter decay rate. |
| `onFrame` | `null` | `function (pathTracer, frame)` called each frame. |

Methods: `start()`, `stop()`, `reset()`, `dispose()`, `resize()`,
`setMaxSamples(n)`, `setSeed(n)`, `setDenoise(hookOrNull)`, `notifyChanged()`,
`exportImage(opts)`, `addPostProcess(spec)` / `removePostProcess(spec)` /
`clearPostProcesses()`, `readTargetData(rt)`.

### 7b. Universal adapter (`PT_LIB.scenes.universal.create`)

| Option | Default | Meaning |
|---|---|---|
| `setup(scene, camera)` | `null` | Build the scene here. May be async. |
| `cameraPosition` | `[0, 2, -8]` | Starting camera position. |
| `focusDistance` | `0` | `0` = derive from the camera origin distance. |
| `apertureSize` | `0.0` | Depth-of-field aperture. `0` = pinhole. |
| `epsIntersect` | `0.02` | Ray-epsilon offset. |
| `hideSceneMeshes` | `false` | Hide Babylon's raster meshes (the tracer still renders). |
| `showLights` | `true` | Draw glowing markers at point/spot light positions. |
| `autoReingest` | `false` | Poll for property changes and re-ingest automatically. |
| `syncVisibility` | `true` | Sync mesh enabled/visibility toggles. |
| `syncTransforms` | `true` | Sync mesh transforms (disable for animated scenes). |
| `syncLights` | `true` | Sync light property edits (no re-ingest). |
| `syncMaterials` | `true` | Sync material scalar edits (no re-ingest). |
| `reingestDebounceMs` | `150` | Debounce window for automatic re-ingest. |
| `blueNoiseFile` | `./textures/BlueNoise_RGBA256.png` | The one required asset. |
| `maxTextures` | `0` | Shared texture-pool size. `0` = derive from engine limits (up to 12). |
| `worker` | `true` | Pack + build the BVH in a Web Worker. |
| `workerScripts` | `null` | Override the worker's `importScripts` URLs. |
| `onIngestProgress` | `null` | `function ({ phase, done, total })` during a worker ingest. |

`create()` returns `app` with: `pathTracer`, `scene`, `camera`, `engine`,
`triangleCount`, `debugMode`, `showLights`, `ready`, `reingest()` (alias
`rebuild()`), and `setWorker(bool)`.

---

## 8. Post-process

`options.postProcesses` is a list of full-screen passes run **in order, after
the tonemap**, so each one works on display-referred pixels. The chain
ping-pongs through two internal targets; the last pass writes to
`options.outputTarget` (default: the canvas).

```js
const app = PT_LIB.scenes.universal.create(canvas, {
  postProcesses: [
    {
      name: 'grain',
      fragmentShader: GLSL_SOURCE,          // ES 3.00, its own `out`
      uniforms: { uAmount: 0.05 }           // literal, or (pt, frame) => value
    }
  ]
});

// at runtime
pt.addPostProcess(pass);
pt.removePostProcess(pass);
pt.clearPostProcesses();
```

- A pass is either a spec (`{ name, fragmentShader, uniforms, samplers }`) or a
  prebuilt `BABYLON.EffectWrapper` given as `{ effect, inputName }`. Effects you
  hand in are **never disposed** by the tracer.
- Uniforms and samplers are discovered from the GLSL (`PT_LIB.parseUniforms`)
  unless you pass `uniformNames` / `samplerNames`.
- Uniform values may be literals or `(pt, frame) => value` getters — that is how
  a slider stays live without rebuilding the pipeline.
- `inputName` (default `"textureSampler"`) is the sampler fed the previous
  stage. Sample it as the tracer's own passes do —
  `texelFetch(inputName, ivec2(gl_FragCoord.xy), 0)` — since no `vUV` varying is
  injected.
- Passes run in **display space**: never write their output back into the HDR
  accumulation buffer.
- To present the result yourself, set `options.outputTarget` to a
  `BABYLON.RenderTargetTexture`; the tracer then stops touching the canvas.

---

## 9. Supported subset and limits

**Renderer:** WebGL2 or WebGPU with float textures *and* float render targets.
Check ahead of time:

```js
PT_LIB.PathTracer.isSupported(engine);       // true / false
PT_LIB.PathTracer.supportIssues(engine);     // the reasons, as strings
```

**Geometry:** every enabled, visible mesh with a geometry — indexed or not,
multi-mesh. Built-in (`MeshBuilder`) and imported (glTF) meshes are just
triangles. There is a hard capacity of **524,288 triangles** by default; scenes
above it **throw** rather than fail silently, so check first:

```js
PT_LIB.geometryCapacity();   // triangles the geometry textures can hold
```

**Tonemap:** exposure, contrast and the Standard / ACES / Khronos PBR Neutral
curves from `scene.imageProcessingConfiguration`.

**Not consumed:** color curves and color grading (LUT) and the vignette from
`imageProcessingConfiguration` (curves and grading warn once at `start()`), the
occlusion channel of glTF ORM maps, normal-map axis inversion, and next-event
estimation toward the environment (diffuse surfaces receive environment light
through indirect bounces only).
