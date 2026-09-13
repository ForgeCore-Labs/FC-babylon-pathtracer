// Release-build test (M7).
//
// Builds dist/pt_lib.esm.js + dist/pt_lib.iife.js and verifies what can be
// checked without a browser:
//   * the bundles build and are non-trivial;
//   * the IIFE bundle evaluates under a minimal BABYLON global and exposes the
//     whole library (registry, ingestion, both denoise backends, scene adapters,
//     BABYLON.PathTracer);
//   * the bundled worker inlines its sources instead of importScripts;
//   * the ESM entry has the Babylon import + named exports.
//
// Usage:  node pt_lib/tools/test-dist.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, ".."); // pt_lib/

let failures = 0;
function check(label, ok, detail) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------- build
console.log("Build\n");
try {
  execFileSync(process.execPath, [path.join(here, "build-core.mjs")], {
    cwd: root,
    stdio: "pipe",
  });
  execFileSync(process.execPath, [path.join(here, "build-dist.mjs")], {
    cwd: root,
    stdio: "pipe",
  });
  check("build-core + build-dist succeed", true);
} catch (e) {
  check("build-core + build-dist succeed", false, String(e.stderr || e.message));
}

const esmPath = path.join(root, "dist", "pt_lib.esm.js");
const iifePath = path.join(root, "dist", "pt_lib.iife.js");
check("both bundles exist",
  fs.existsSync(esmPath) && fs.existsSync(iifePath));

const esmSrc = fs.readFileSync(esmPath, "utf8");
const iifeSrc = fs.readFileSync(iifePath, "utf8");
check("bundles are non-trivial",
  esmSrc.length > 150000 && iifeSrc.length > 150000,
  Math.round(esmSrc.length / 1024) + " KB / " + Math.round(iifeSrc.length / 1024) + " KB");

console.log("\nESM entry\n");
check("ESM imports the Babylon peer",
  /^import \* as BABYLON_NS from '@babylonjs\/core';$/m.test(esmSrc));
check("ESM copies BABYLON onto a writable object",
  /__ptGlobal\.BABYLON = Object\.assign\(\{\}, BABYLON_NS\)/.test(esmSrc));
check("ESM has named exports",
  /export const PathTracer = /.test(esmSrc) &&
  /export const PT_LIB = /.test(esmSrc) &&
  /export default /.test(esmSrc));
check("ESM has no CommonJS leftovers",
  !/module\.exports/.test(esmSrc) && !/\brequire\(/.test(esmSrc));

console.log("\nIIFE bundle\n");

// Minimal BABYLON for load: the module-scope `new BABYLON.Vector3()` in the BVH
// builder and the `BABYLON.PathTracer` attachment are the only load-time uses.
function Vector3(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
Vector3.prototype.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
Vector3.prototype.copyFrom = function (o) { this.x = o.x; this.y = o.y; this.z = o.z; return this; };
function Observable() { this._o = []; }
Observable.prototype.add = function (f) { this._o.push(f); return f; };
Observable.prototype.notifyObservers = function (v) { this._o.slice().forEach((f) => f(v)); };

const sandbox = {
  console,
  BABYLON: {
    Vector3,
    Observable,
    Constants: {
      TEXTURETYPE_FLOAT: 1,
      TEXTURETYPE_UNSIGNED_BYTE: 0,
      TEXTURE_NEAREST_SAMPLINGMODE: 2,
      TEXTUREFORMAT_RGBA: 3,
    },
    EffectWrapper: function () {},
    EffectRenderer: function () {},
    RenderTargetTexture: function () {},
    RawTexture: function () {},
  },
};
const context = vm.createContext(sandbox);
try {
  vm.runInContext(iifeSrc, context, { filename: "pt_lib.iife.js" });
} catch (e) {
  check("the IIFE bundle loads under a global BABYLON", false, e.message);
}

const PT = sandbox.PT_LIB;
check("the IIFE bundle loads under a global BABYLON", !!PT);
if (PT) {
  check("registry carries the shaders",
    typeof PT.glsl.shaders.screenResolveFragmentShader === "string" &&
    typeof PT.glsl.shaders.screenOutputFragmentShader === "string" &&
    typeof PT.glsl.includes.pathtracing_default_main === "string");
  check("PathTracer + ingestion are exported",
    typeof PT.PathTracer === "function" &&
    typeof PT.ingestScene === "function" &&
    typeof PT.ingestSceneAsync === "function" &&
    typeof PT.buildSceneInput === "function" &&
    typeof PT.assembleIngested === "function");
  check("scene adapters are exported",
    PT.scenes && typeof PT.scenes.universal.create === "function" &&
    typeof PT.scenes.gltf.create === "function");
  check("both denoise backends are exported",
    PT.denoise && typeof PT.denoise.aTrous === "function" &&
    typeof PT.denoise.oidn === "function" &&
    typeof PT.denoise.oidnHook === "function");
  check("it attaches BABYLON.PathTracer", sandbox.BABYLON.PathTracer === PT.PathTracer);

  const worker = PT.geometryWorker;
  check("the bundled worker inlines its sources", worker.isInline() === true);
  const workerSource = worker.workerSource();
  check("the inlined bootstrap carries both sources",
    /geometry-packing\.js \(inlined by build-dist\)/.test(workerSource) &&
    /BVH_SAH_Quality_Builder\.js \(inlined\)/.test(workerSource) &&
    /installBabylonVectorShim/.test(workerSource) &&
    !/importScripts\(/.test(workerSource));
}

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"));
process.exit(failures === 0 ? 0 : 1);
