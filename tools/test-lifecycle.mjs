// Lifecycle smoke test for PT_LIB.PathTracer, headless.
//
// Provides a minimal mock of the Babylon surfaces PathTracer uses, then drives
// frames manually to assert the accumulation rules and the lifecycle:
// start / renderFrame / camera-move reset / maxSamples convergence / reset /
// resize / stop / dispose.
//
// Usage:  node pt_lib/tools/test-lifecycle.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, ".."); // pt_lib/

let failures = 0;
function check(label, ok, detail) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------- mock BABYLON
function Observable() {
  this._obs = [];
}
Observable.prototype.add = function (fn) {
  this._obs.push(fn);
  return fn;
};
Observable.prototype.remove = function (fn) {
  const i = this._obs.indexOf(fn);
  if (i !== -1) this._obs.splice(i, 1);
  return this;
};
Observable.prototype.notifyObservers = function (v) {
  this._obs.slice().forEach((fn) => fn(v));
};

function Matrix() {
  this.m = new Float32Array(16);
}
Matrix.prototype.copyFrom = function (o) {
  this.m.set(o.m);
  return this;
};
Matrix.prototype.equals = function (o) {
  if (!o) return false;
  for (let i = 0; i < 16; i++) if (this.m[i] !== o.m[i]) return false;
  return true;
};
Matrix.prototype.clone = function () {
  const r = new Matrix();
  r.copyFrom(this);
  return r;
};
Matrix.prototype.invert = function () {
  return this;
};

function Effect() {
  this.calls = {};
}
Effect.prototype.setFloat = function (n, v) { this.calls[n] = v; };
Effect.prototype.setInt = Effect.prototype.setFloat;
Effect.prototype.setBool = Effect.prototype.setFloat;
Effect.prototype.setTexture = function (n, t) { this.calls[n] = t; };
Effect.prototype.setMatrix = function (n, m) { this.calls[n] = m; };
Effect.prototype.setVector2 = function (n, v) { this.calls[n] = { x: v.x, y: v.y }; };
Effect.prototype.setVector3 = function (n, v) { this.calls[n] = { x: v.x, y: v.y, z: v.z }; };
Effect.prototype.setFloat2 = function (n, a, b) { this.calls[n] = [a, b]; };
Effect.prototype.setFloat3 = function (n, a, b, c) { this.calls[n] = [a, b, c]; };
Effect.prototype.setFloat4 = function (n, a, b, c, d) { this.calls[n] = [a, b, c, d]; };

function EffectWrapper(opts) {
  this.options = opts;
  this.effect = new Effect();
  this.onApplyObservable = new Observable();
  this.disposed = false;
}
EffectWrapper.prototype.dispose = function () { this.disposed = true; };

function EffectRenderer(engine) {
  this.engine = engine;
  this.renders = [];
}
EffectRenderer.prototype.render = function (wrapper, target) {
  this.renders.push({ wrapper: wrapper, target: target });
  wrapper.onApplyObservable.notifyObservers(wrapper); // emulate Babylon
};

function RenderTargetTexture(name, size) {
  this.name = name;
  this._size = { width: size.width, height: size.height };
  this.disposed = false;
}
RenderTargetTexture.prototype.getSize = function () { return this._size; };
RenderTargetTexture.prototype.resize = function (s) { this._size = { width: s.width, height: s.height }; };
RenderTargetTexture.prototype.dispose = function () { this.disposed = true; };

globalThis.BABYLON = {
  Observable,
  Matrix,
  Effect,
  EffectWrapper,
  EffectRenderer,
  RenderTargetTexture,
  Constants: {
    TEXTURETYPE_FLOAT: 1,
    TEXTURE_NEAREST_SAMPLINGMODE: 2,
    TEXTUREFORMAT_RGBA: 3,
  },
};

// -------------------------------------------------- load pt_lib classic scripts
function load(rel) {
  new Function(fs.readFileSync(path.join(root, rel), "utf8"))();
}
load("src/core/composer.js");
load("src/core/uniforms.js");
load("src/core/glsl/_registry.js"); // provides PT_LIB.defineShader / defineInclude
load("src/PathTracer.js");

const PT_LIB = globalThis.PT_LIB;

// shared post-process shaders live in the registry
PT_LIB.glsl.shaders.screenCopyFragmentShader = "// screenCopy";
PT_LIB.glsl.shaders.screenResolveFragmentShader = "// screenResolve";
PT_LIB.glsl.shaders.screenOutputFragmentShader = "// screenOutput";

// real include sources, so the first-hit AOV compose below is exercised
load("src/core/glsl/includes/pathtracing_defines_and_uniforms.js");
load("src/core/glsl/includes/pathtracing_default_main.js");

// ------------------------------------------------------------------- fixtures
function makeWorld() {
  const engine = {
    _loop: null,
    width: 800,
    height: 600,
    getRenderWidth() { return this.width; },
    getRenderHeight() { return this.height; },
    getDeltaTime() { return 16; },
    runRenderLoop(fn) { this._loop = fn; },
    stopRenderLoop(fn) { if (this._loop === fn) this._loop = null; },
    onResizeObservable: new Observable(),
  };

  const camera = { matrix: new Matrix(), getWorldMatrix() { return this.matrix; } };
  const scene = {
    renderCount: 0,
    render() { this.renderCount++; },
    activeCamera: camera,
    getEngine() { return engine; },
  };
  return { engine, camera, scene };
}

const TEST_SHADER = [
  "uniform float uFoo;",
  "uniform vec2 uResolution;",
  "uniform mat4 uCameraMatrix;",
  "uniform sampler2D previousBuffer;",
  "void main() {}",
  "",
].join("\n");

// A scene-shaped stub that uses the real pathtracing_default_main, so the AOV
// entry (PT_AOV_PASS) composes. GLSL is never compiled headlessly.
const TEST_SCENE_AOV = [
  "precision highp float;",
  "uniform sampler2D blueNoiseTexture;",
  "vec3 rayOrigin;",
  "vec3 rayDirection;",
  "void SetupScene() {}",
  "vec3 CalculateRadiance(out vec3 objectNormal, out vec3 objectColor, out float objectID, out float pixelSharpness) {",
  "  objectNormal = vec3(0.0); objectColor = vec3(0.0); objectID = 0.0; pixelSharpness = 0.0;",
  "  return vec3(0.0);",
  "}",
  "#include<pathtracing_default_main>",
  "",
].join("\n");

// ------------------------------------------------------------------- run tests
console.log("PathTracer lifecycle test\n");

const world = makeWorld();
const pt = new PT_LIB.PathTracer("t", world.scene, { maxSamples: 3 });

pt.setShader({ source: TEST_SHADER, uniforms: { uFoo: 42 } });

console.log("Construction");
check("path effect created", !!pt._pathEffect);
check("copy effect created", !!pt._copyEffect);
check("resolve effect created", !!pt._resolveEffect);
check("output effect created", !!pt._outputEffect);
check("uniformNames discovered", pt._pathEffect.options.uniformNames.includes("uFoo") &&
  pt._pathEffect.options.uniformNames.includes("uResolution"));
check("samplerNames discovered", pt._pathEffect.options.samplerNames.includes("previousBuffer"));

// A re-ingest that does not change the shader must reuse the compiled effects
// (disposing them mid-compile is what produced Babylon's "deleted object" spam).
const pathEffectBefore = pt._pathEffect;
pt.setShader({ source: TEST_SHADER, uniforms: { uFoo: 42 } });
check("unchanged shader reuses the compiled effects", pt._pathEffect === pathEffectBefore);

let progressEvents = 0;
let convergedEvents = 0;
pt.onProgressObservable.add(() => { progressEvents++; });
pt.onConvergedObservable.add(() => { convergedEvents++; });

console.log("\nStart / accumulation");
pt.start();
check("start attaches the render loop", world.engine._loop === pt._renderHandler);
check("isRunning is true", pt.isRunning === true);

pt.renderFrame();
check("frame 1: samples = 1", pt.samples === 1, "samples=" + pt.samples);
check("frame 1: frameCounter = 2", pt.frameCounter === 2, "frameCounter=" + pt.frameCounter);

pt.renderFrame();
check("frame 2: samples = 2", pt.samples === 2, "samples=" + pt.samples);

pt.renderFrame();
check("frame 3: samples = 3", pt.samples === 3, "samples=" + pt.samples);
check("frame 3: converged fired once (maxSamples=3)", convergedEvents === 1 && pt.isConverged);

pt.renderFrame();
check("frame 4: no second convergence", convergedEvents === 1);
check("converged locks the tracer (samples stop advancing)", pt.samples === 3,
  "samples=" + pt.samples);

pt.renderFrame();
check("still locked across further quiet frames", pt.samples === 3,
  "samples=" + pt.samples);

console.log("\nCamera move");
world.camera.matrix.m[12] = 5; // move camera -> matrix differs
pt.renderFrame();
check("move frame: samples restarts at 1", pt.samples === 1, "samples=" + pt.samples);
check("move frame: previousSampleCount stashes the locked count (3)", pt.previousSampleCount === 3,
  "previousSampleCount=" + pt.previousSampleCount);
check("move frame: lock released (no longer converged)", pt.isConverged === false);
check("move frame: frameCounter resets to 1", pt.frameCounter === 1, "frameCounter=" + pt.frameCounter);

pt.renderFrame();
check("still frame after move: samples = 2", pt.samples === 2, "samples=" + pt.samples);
check("still frame after move: frameCounter = 2", pt.frameCounter === 2);

console.log("\nBound values");
const calls = pt._pathEffect.effect.calls;
check("user uniform uFoo bound", calls.uFoo === 42, "uFoo=" + calls.uFoo);
check("internal uResolution bound as vec2", Array.isArray(calls.uResolution) &&
  calls.uResolution[0] === 800 && calls.uResolution[1] === 600);
check("previousBuffer wired to the copy target", calls.previousBuffer === pt._copyRT);
check("camera matrix bound", !!calls.uCameraMatrix);
check("progress observable fires once per rendered frame (locked frames skipped)",
  progressEvents === 5, progressEvents + " events");

console.log("\nResolve / denoise hook");
check("resolve reads the accumulation buffer",
  pt._resolveEffect.effect.calls.accumulationBuffer === pt._pathRT);
check("resolve divides by the sample count",
  pt._resolveEffect.effect.calls.uOneOverSampleCounter === 1 / pt.samples);
check("tonemap reads the resolve target by default",
  pt._outputEffect.effect.calls.resolvedBuffer === pt._resolveRT);

const fakeDenoised = { name: "fakeDenoised" };
pt.options.denoise = function () { return fakeDenoised; };
pt.renderFrame();
check("sync denoise hook becomes the tonemap input",
  pt._outputEffect.effect.calls.resolvedBuffer === fakeDenoised);

// Async hook (the one-shot readback shape): adopt the texture when it resolves.
// Clear the previous hook's result first, otherwise the pipeline would keep
// showing it while the new request is pending.
pt._denoiseResult = null;
pt._denoisePending = false;
let adopt = null;
pt.options.denoise = function () {
  return { then: function (onOk) { adopt = onOk; } };
};
pt.renderFrame();
check("async denoise keeps the resolve output until it resolves",
  pt._outputEffect.effect.calls.resolvedBuffer === pt._resolveRT && pt._denoisePending === true);
const asyncBeauty = { name: "asyncBeauty" };
adopt(asyncBeauty);
pt.renderFrame();
check("async denoise result is adopted",
  pt._outputEffect.effect.calls.resolvedBuffer === asyncBeauty && pt._denoisePending === true);

pt.options.denoise = function () { throw new Error("boom"); };
// Clear the previous async hook's in-flight state so this hook actually runs.
pt._denoisePending = false;
pt._denoiseResult = null;
pt.renderFrame();
check("a throwing hook falls back to the resolve output",
  pt._outputEffect.effect.calls.resolvedBuffer === pt._resolveRT);
pt.options.denoise = null;

console.log("\nReset / resize / stop / dispose");

pt.setMaxSamples(10);
check("setMaxSamples sets the cap", pt.options.maxSamples === 10);
pt.setMaxSamples(0);
check("setMaxSamples(0) removes the cap", pt.options.maxSamples === 0 && pt.isConverged === false);

pt.reset();
check("reset zeroes samples", pt.samples === 0 && pt.frameCounter === 1);
check("reset never leaves previousSampleCount at 0 (shader divides by it)",
  pt.previousSampleCount >= 1, "previousSampleCount=" + pt.previousSampleCount);

const convergedBefore = convergedEvents;
pt.renderFrame();
check("frame after reset does not produce a zero divisor",
  pt.previousSampleCount >= 1, "previousSampleCount=" + pt.previousSampleCount);
check("frame after reset did not newly report convergence",
  convergedEvents === convergedBefore);

world.engine.width = 400;
pt.resize();
check("resize follows engine size", pt._pathRT.getSize().width === 400,
  "width=" + pt._pathRT.getSize().width);

pt.stop();
check("stop detaches the render loop", world.engine._loop === null && pt.isRunning === false);

// capture before dispose(), which nulls the instance fields
const pathEffect = pt._pathEffect;
const pathRT = pt._pathRT;
const copyRT = pt._copyRT;
const resolveEffect = pt._resolveEffect;
const resolveRT = pt._resolveRT;

pt.dispose();
check("dispose closes effects", pathEffect.disposed === true && resolveEffect.disposed === true);
check("dispose closes render targets",
  pathRT.disposed === true && copyRT.disposed === true && resolveRT.disposed === true);
check("dispose marks the instance disposed", pt._disposed === true);
let threw = false;
try { pt.renderFrame(); } catch (e) { threw = true; }
check("renderFrame after dispose is a safe no-op", threw === false);

console.log("\nFirst-hit AOV pass");
{
  const aovWorld = makeWorld();
  const hookCtx = [];
  const aovPt = new PT_LIB.PathTracer("aov", aovWorld.scene, {
    warnUnboundUniforms: false,
    denoise: function (ctx) { hookCtx.push(ctx); return null; },
  });
  aovPt.setShader({ source: TEST_SCENE_AOV, aovs: true });

  check("AOV targets allocated when a hook and scene support exist",
    aovPt._aovEnabled === true &&
    !!aovPt._aovAlbedo && !!aovPt._aovNormal && !!aovPt._aovDepth);
  check("AOV effect composed from the scene source", !!aovPt._aovEffect);
  check("AOV effect reads the first-hit entry",
    aovPt._aovEffect.options.fragmentShader.includes("ptFirstHitAlbedo"));

  aovPt.start();
  aovPt._renderer.renders.length = 0;
  aovPt.renderFrame();
  const targets = aovPt._renderer.renders.map((r) => r.target);
  check("one AOV pass per channel",
    targets.includes(aovPt._aovAlbedo) &&
    targets.includes(aovPt._aovNormal) &&
    targets.includes(aovPt._aovDepth));
  check("uAovChannel advances with each pass",
    aovPt._aovEffect.effect.calls.uAovChannel === 2);
  check("AOVs are not re-rendered on a still frame", aovPt._aovDirty === false);
  check("the hook receives the AOV textures",
    hookCtx.length > 0 &&
    hookCtx[0].albedo === aovPt._aovAlbedo &&
    hookCtx[0].normal === aovPt._aovNormal &&
    hookCtx[0].depth === aovPt._aovDepth);

  check("firefly clamp is off by default",
    aovPt._pathEffect.effect.calls.uFireflyClamp === 0);
  aovPt.options.fireflyClamp = 6;
  aovPt.renderFrame();
  check("firefly clamp binds the option",
    aovPt._pathEffect.effect.calls.uFireflyClamp === 6);

  aovPt.reset();
  check("reset marks the AOVs dirty", aovPt._aovDirty === true);
  check("a scene without opt-in keeps AOVs off", pt._aovEnabled === false);

  aovPt.dispose();
}

console.log("\nSeed / reproducibility");
{
  const seedWorld = makeWorld();
  const seeded = new PT_LIB.PathTracer("seed", seedWorld.scene, {
    seed: 4242,
    warnUnboundUniforms: false,
  });
  seeded.setShader({ source: TEST_SHADER, uniforms: { uFoo: 42 } });
  seeded.start();

  const firstRun = [];
  for (let i = 0; i < 4; i++) {
    seeded.renderFrame();
    firstRun.push([seeded._randomVec2.x, seeded._randomVec2.y]);
  }
  seeded.reset();
  const secondRun = [];
  for (let i = 0; i < 4; i++) {
    seeded.renderFrame();
    secondRun.push([seeded._randomVec2.x, seeded._randomVec2.y]);
  }
  check("a fixed seed replays the same sample sequence after reset",
    JSON.stringify(firstRun) === JSON.stringify(secondRun));
  check("seeded samples differ from one another",
    firstRun[0][0] !== firstRun[1][0] || firstRun[0][1] !== firstRun[1][1]);

  const otherSeed = new PT_LIB.PathTracer("seed2", makeWorld().scene, {
    seed: 99,
    warnUnboundUniforms: false,
  });
  otherSeed.setShader({ source: TEST_SHADER, uniforms: { uFoo: 42 } });
  otherSeed.start();
  otherSeed.renderFrame();
  check("a different seed gives a different sequence",
    otherSeed._randomVec2.x !== firstRun[0][0] ||
    otherSeed._randomVec2.y !== firstRun[0][1]);
  otherSeed.dispose();

  seeded.setSeed(123);
  check("setSeed stores the value and resets",
    seeded.options.seed === 123 && seeded.samples === 0);
  seeded.dispose();
}

console.log("\nPNG export guard");
{
  let exportError = null;
  try {
    await pt.exportImage();
  } catch (e) {
    exportError = e.message;
  }
  check("exportImage rejects without a DOM (browser-only)",
    !!exportError && /DOM/.test(exportError));
}

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"));
process.exit(failures === 0 ? 0 : 1);
