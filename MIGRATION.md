# Migration: finishing the new repo

You copied the contents of `pt_lib/` into a new folder. This file covers
everything left to do there. **Delete it once you're done.**

---

## 1. Layout

`package.json` must be at the **repo root** (that is what makes `npm install`,
`npm test`, `npm run build` and `npm publish` work). If your new folder looks
like `newrepo/pt_lib/package.json`, move the contents up one level.

Target:

```
<repo root>/
├─ package.json  README.md  PT_README.md  LICENSE  CREDITS.md  MIGRATION.md
├─ dist/            # generated, committed on purpose
│  ├─ pt_lib.core.js
│  ├─ pt_lib.esm.js
│  ├─ pt_lib.iife.js
│  └─ pt_lib.d.ts
├─ src/             # composer, uniforms, ingest, geometry-*, denoise, PathTracer, scenes
├─ tools/           # build + test scripts
├─ vendor/
│  └─ README.md     # OIDN contract (no binary ships)
├─ reference/       # optional, see §2
│  └─ PathTracingCommon.js
├─ textures/
│  └─ BlueNoise_RGBA256.png     # 524 KB — copy this from the old repo
├─ test.html        # see §5
└─ .gitignore
```

---

## 2. Fix the paths that pointed outside `pt_lib/`

Four kinds, all references to files that stayed behind in the old repo.

**a) `tools/split-glsl.mjs`** reads the upstream original:

```js
const srcFile = path.resolve(root, "..", "js", "PathTracingCommon.js");
```

Copy `js/PathTracingCommon.js` (≈60 KB) from the old repo to
`reference/PathTracingCommon.js`, then change that line to:

```js
const srcFile = path.resolve(root, "reference", "PathTracingCommon.js");
```

(It resolves `root` as the package root, so no other change is needed.)

**b) Doc links** in `README.md` and `PT_README.md`. Replace or delete:

| Current link | Fix |
|---|---|
| `../develop.md` | Copy the old repo's `develop.md` in as `docs/ROADMAP.md`, or delete the links |
| `../HANDOFF.md` | Old agent-workflow file — delete these links |
| `../pathtrace-universal.html` | `./test.html` (or delete) |
| `../pathtrace.html` | delete (needs a glTF model + loaders) |

The old `develop.md` / `HANDOFF.md` were never inside `pt_lib/`, so they are not
in your copy.

**c) `package.json`** — optionally add once the GitHub repo exists:

```json
"repository": { "type": "git", "url": "git+https://github.com/<you>/<repo>.git" },
```

**d) Rename check** — `package.json` `name` is `babylon-pathtracer`. If you pick
a different repo name, update `name` and the `import { PT_LIB } from
'babylon-pathtracer'` examples in `README.md`.

---

## 3. Assets

The tracer needs exactly one asset: the blue-noise texture.

```sh
# from the old repo, into the new repo root
cp textures/BlueNoise_RGBA256.png  <newrepo>/textures/
```

Do **not** copy `model/`, `models/`, other textures, `js/babylon.js` (4 MB) or
the `page*.html` originals — tens/hundreds of MB, and GitHub rejects >100 MB
files. The default demo (test.html below) is procedural and needs no model.

Optional IBL: drop a prefiltered cube map next to the texture
(`textures/environment.env`) and `test.html` picks it up if present.

---

## 4. First commit

Use GitHub's **Node** `.gitignore` template when you create the repo, then append
these (they cover the demo assets the template does not):

```
model/
models/
*.glb
*.gltf
*.bin
*.hdr
*.fbx
```

Note: `dist/` is **not** ignored — it is committed so script-tag/CDN users get a
working bundle. `package-lock.json` should also be committed.

```sh
git init
git add -A
git ls-files | wc -l                                     # count
git ls-files -z | xargs -0 du -h | sort -h | tail -10    # 10 biggest staged files
git commit -m "Import babylon-pathtracer"
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

If any staged file is >1–2 MB, stop and fix the ignore rules first.

Also ignore `vendor/*.js`, `vendor/*.wasm`, `vendor/*.data` if you ever drop an
OIDN build in there (`vendor/README.md` documents the contract; the binary is not
supposed to be committed).

---

## 5. `test.html` — minimal, self-contained page

Key point: **`dist/pt_lib.iife.js` contains everything** — GLSL, BVH, the
ingestion modules, both denoise backends, the scene adapters, and the worker
sources inlined. So this page needs just Babylon + one script tag. No
`pt_lib/src/...` tags, no shader tags, no separate worker file.

Save as `<repo root>/test.html`, next to `dist/` and `textures/`.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>babylon-pathtracer — test</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
  #renderCanvas { width: 100%; height: 100%; display: block; touch-action: none; outline: none; }
  #info { position: fixed; top: 8px; width: 100%; text-align: center;
          font: 13px monospace; color: #fff; text-shadow: 0 0 4px #000; pointer-events: none; }
  #ui { position: fixed; right: 10px; top: 10px; font: 12px monospace; color: #ddd;
        background: rgba(0,0,0,.55); border: 1px solid rgba(255,255,255,.15);
        border-radius: 6px; padding: 10px 12px; user-select: none; }
  #ui label { display: block; margin-bottom: 6px; }
  #ui input, #ui button { background: #111; color: #eee; border: 1px solid #444; font: inherit; }
</style>
</head>
<body>
<canvas id="renderCanvas" touch-action="none"></canvas>
<div id="info">loading…</div>

<div id="ui">
  <label>max samples <input id="samples" type="number" min="0" step="16" value="256" style="width:70px"></label>
  <label>firefly clamp <input id="firefly" type="range" min="0" max="50" step="1" value="8"></label>
  <label><input id="atrous" type="checkbox" checked> à-trous denoise</label>
  <label>à-trous passes <input id="passes" type="number" min="1" max="6" step="1" value="3" style="width:60px"></label>
  <button id="reset">reset</button>
  <button id="export">export PNG</button>
</div>

<!-- 1. Babylon first: the library reads the global BABYLON.
     The loaders script is only needed if you import a glTF model later. -->
<script src="https://cdn.babylonjs.com/babylon.max.js"></script>
<script src="https://cdn.babylonjs.com/loaders/babylonjs.loaders.min.js"></script>

<!-- 2. the whole library, one file -->
<script src="dist/pt_lib.iife.js"></script>

<script>
const canvas = document.getElementById('renderCanvas');
const info = document.getElementById('info');
const setStatus = (t) => { info.textContent = 'babylon-pathtracer — ' + t; };
window.addEventListener('error', (e) => setStatus('error: ' + (e.message || e)));
window.addEventListener('unhandledrejection', (e) =>
  setStatus('rejection: ' + ((e.reason && e.reason.message) || e.reason)));

const samples = document.getElementById('samples');
const firefly = document.getElementById('firefly');
const atrous  = document.getElementById('atrous');
const passes  = document.getElementById('passes');

// Values mirror the original universal demo, so the expected look matches.
const PALETTE = [
  { color: [0.95, 0.90, 0.80], metallic: 1.0, roughness: 0.05 }, // mirror
  { color: [0.92, 0.75, 0.25], metallic: 1.0, roughness: 0.30 }, // gold
  { color: [0.85, 0.12, 0.10], metallic: 0.0, roughness: 0.80 }, // red
  { color: [0.15, 0.40, 0.85], metallic: 0.0, roughness: 0.50 }, // blue
  { color: [0.20, 0.75, 0.30], metallic: 0.0, roughness: 0.90 }, // green
];

const app = PT_LIB.scenes.universal.create(canvas, {
  resolutionScale: 1.0,
  maxSamples: 256,
  cameraPosition: [0, 2, -9],
  fireflyClamp: 8,
  blueNoiseFile: './textures/BlueNoise_RGBA256.png',

  setup: async function (scene, camera) {
    camera.setTarget(new BABYLON.Vector3(0, 1, 0));

    // ground
    const ground = BABYLON.MeshBuilder.CreateBox('ground', {
      width: 24, height: 0.5, depth: 24
    }, scene);
    ground.position.y = -0.25;
    const groundMat = new BABYLON.StandardMaterial('groundMat', scene);
    groundMat.diffuseColor = new BABYLON.Color3(0.75, 0.75, 0.78);
    ground.material = groundMat;

    // a row of spheres, created the normal Babylon way
    PALETTE.forEach(function (entry, index) {
      const ball = BABYLON.MeshBuilder.CreateSphere('ball' + index, {
        diameter: 1.6, segments: 40
      }, scene);
      ball.position.set((index - 2) * 2.1, 0.8, 0);
      const mat = new BABYLON.PBRMaterial('ballMat' + index, scene);
      mat.albedoColor = new BABYLON.Color3(entry.color[0], entry.color[1], entry.color[2]);
      mat.metallic = entry.metallic;
      mat.roughness = entry.roughness;
      ball.material = mat;
    });

    // two coloured lights + a weak ambient (Babylon lights, not hardcoded)
    const key = new BABYLON.PointLight('key', new BABYLON.Vector3(-3, 6, -4), scene);
    key.intensity = 320;
    key.diffuse = new BABYLON.Color3(1.0, 0.85, 0.7);

    const fill = new BABYLON.PointLight('fill', new BABYLON.Vector3(4, 5, -2), scene);
    fill.intensity = 220;
    fill.diffuse = new BABYLON.Color3(0.4, 0.55, 1.0);

    const ambient = new BABYLON.HemisphericLight('ambient', new BABYLON.Vector3(0, 1, 0), scene);
    ambient.intensity = 0.25;

    // optional IBL: only if you dropped a prefiltered cube map in textures/
    try {
      scene.environmentTexture =
        BABYLON.CubeTexture.CreateFromPrefilteredData('./textures/environment.env', scene);
    } catch (e) {
      /* no environment.env in this repo — flat ambient is used instead */
    }
  },
});

const pt = () => app.pathTracer;

app.ready.then(function () {
  if (atrous.checked) {
    pt().setDenoise(PT_LIB.denoise.aTrous({ iterations: parseInt(passes.value, 10) || 3 }));
  }
  setStatus('ready — ' + app.triangleCount + ' triangles');
});

samples.addEventListener('change', function () {
  pt().setMaxSamples(parseInt(samples.value, 10) || 0);
  pt().reset();
});

firefly.addEventListener('input', function () {
  pt().options.fireflyClamp = parseFloat(firefly.value) || 0;
  pt().reset();   // clamped and unclamped samples must not mix
});

passes.addEventListener('change', function () {
  if (atrous.checked) {
    pt().setDenoise(PT_LIB.denoise.aTrous({ iterations: parseInt(passes.value, 10) || 3 }));
  }
});

atrous.addEventListener('change', function () {
  pt().setDenoise(
    atrous.checked
      ? PT_LIB.denoise.aTrous({ iterations: parseInt(passes.value, 10) || 3 })
      : null
  );
});

document.getElementById('reset').addEventListener('click', function () { pt().reset(); });

document.getElementById('export').addEventListener('click', function () {
  setStatus('exporting…');
  pt().exportImage({ download: true, filename: 'pathtrace', aovs: false })
    .then(function (images) { setStatus('exported ' + Object.keys(images).join(', ')); })
    .catch(function (e) { setStatus('export failed: ' + (e && e.message ? e.message : e)); });
});
</script>
</body>
</html>
```

### Serving it

Serve over HTTP — **not `file://`**:

```sh
npx serve .        # or: python -m http.server 5500
```

`file://` breaks the blue-noise texture fetch and usually blocks blob workers
(you would see a `[pt_lib] geometry worker could not start … using the
synchronous path` warning; it still runs, just on the main thread).

Expected: a noisy image that cleans up as samples accumulate; the mirror/gold
balls converge slowest, à-trous smooths the grain, and firefly clamp removes the
chrome-edge sparkles.

---

## 6. Verify the build

```sh
npm run build     # build-core + build-dist -> dist/
npm test          # 7 headless suites; no install needed (Babylon is mocked)
```

If `npm test` passes and `test.html` renders, the migration is done.

Optional CI (`.github/workflows/ci.yml`) — no `npm install` step is needed:

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: npm run build
      - run: npm test
      - run: git diff --exit-code -- dist   # committed bundles must be current
```

---

## 7. Building, testing and publishing

There is **no compiler and no build dependencies** — the build is plain Node
(≥ 18), so `npm install` is not needed for either command:

```sh
npm run build     # node tools/build-core.mjs && node tools/build-dist.mjs
npm test          # the seven headless suites (Babylon is mocked)
```

### What the build does

| Script | Reads | Writes |
|---|---|---|
| `tools/build-core.mjs` | `src/core/` | `dist/pt_lib.core.js` — GLSL registry + shader snippets + includes + BVH builders |
| `tools/build-dist.mjs` | `src/` (+ `dist/pt_lib.core.js`) | `dist/pt_lib.esm.js` (imports `@babylonjs/core`) and `dist/pt_lib.iife.js` (global `BABYLON`; exposes `window.PT_LIB` + `BABYLON.PathTracer`) |
| `tools/split-glsl.mjs` | `reference/PathTracingCommon.js` | `src/core/glsl/**` — only when the upstream GLSL changes |
| `tools/normalize-scene-shaders.mjs` | the scene shader files | rewrites them to `PT_LIB.defineSceneShader(...)` |

Two things to know:

- `build-dist` **inlines the geometry-worker sources** into the bundles. A bundle
  has no sibling files to `importScripts`, so this is why a page needs only the
  one `dist/pt_lib.iife.js` tag (and why you never ship a separate worker file).
- `dist/pt_lib.d.ts` is **hand-written**, not generated. Update it by hand when
  the public API changes.

### When to rebuild

After editing **anything under `src/`** (JS or GLSL), and before committing.
`dist/` is committed on purpose, so a `build` that changes it must land in the
same commit. The CI snippet in §6 enforces this with
`git diff --exit-code -- dist`.

### Inspect the package before publishing

```sh
npm pack --dry-run
```

Expected shape after the migration: ~310 KB tarball / ~1.3 MB unpacked / 59
files. The `files` field in `package.json` decides the contents; the legacy
`*_Path_Tracing.js` hosts are excluded with negation patterns. If the listing
shows `model/`, `models/`, `js/` or a `page*.html`, an ignore rule is wrong.

### Publishing

```sh
npm version patch            # or minor / major — bumps package.json, makes a tag
npm pack --dry-run           # last look at the exact tarball
npm publish --access public  # --access public is required for a scoped name
```

Before the first publish:

- Confirm the licence in `CREDITS.md` and that `LICENSE` matches it.
- Add `repository` / `homepage` / `bugs` to `package.json` once the GitHub repo
  exists (see §2c) — npm shows them on the package page.
- Rename check: the package name is `babylon-pathtracer`. The **npm name is the
  contract** `import ... from '...'` depends on, so it is usually worth keeping
  even if the GitHub repo is named differently. If you do change it, update
  `name`, the `import { PT_LIB } from 'babylon-pathtracer'` examples in
  `PT_README.md`, and the `unpkg.com/babylon-pathtracer/...` URL.

Editing scope: bump the version, commit, tag.

```sh
GIT_EDITOR=true git commit -am "Release v0.1.1"
git tag v0.1.1
git push --follow-tags
```

Until the first publish, `npm install babylon-pathtracer` from the registry
404s — use a `file:` dependency, `npm pack`, or the IIFE bundle.

---

## 8. Known gaps (not migration bugs)

- **OIDN** needs a caller-supplied WASM build (see `vendor/README.md`); the
  à-trous backend needs nothing and is on in `test.html`.
- **Golden-image tests** are not included — they need a browser/GPU (Playwright +
  headless Chrome). Parked.
- **No minified bundles** and **no CommonJS build**: the package is ESM (plus the
  IIFE). Both need tooling that was not available offline.
- **Confirm the licence** in `CREDITS.md` before `npm publish`.
