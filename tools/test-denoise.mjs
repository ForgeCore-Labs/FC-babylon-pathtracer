// Headless tests for the denoise integration (src/denoise/).
//
// Covers the two pieces that can be checked without a browser:
//   1. the one-shot hook contract (src/denoise/hook.js) — runs on convergence,
//      cached per accumulation, re-run after reset, identity on error;
//   2. the GPU a-trous filter (src/denoise/atrous.js) — passes, ping-pong, AOV
//      binding, live setParams, converged caching.
//
// Usage:  node tools/test-denoise.mjs

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

// ---------------------------------------------------------------- mocks
function Observable() {
  this._obs = [];
}
Observable.prototype.add = function (fn) { this._obs.push(fn); return fn; };
Observable.prototype.notifyObservers = function (v) {
  this._obs.slice().forEach((fn) => fn(v));
};

function Effect() {
  this.calls = {};
}
Effect.prototype.setFloat = function (name, value) { this.calls[name] = value; };
Effect.prototype.setInt = Effect.prototype.setFloat;
Effect.prototype.setTexture = function (name, value) { this.calls[name] = value; };
Effect.prototype.setFloat2 = function (name, a, b) { this.calls[name] = [a, b]; };

function EffectWrapper(opts) {
  this.options = opts;
  this.effect = new Effect();
  this.onApplyObservable = new Observable();
  this.disposed = false;
}
EffectWrapper.prototype.dispose = function () { this.disposed = true; };

// Every renderer the code creates is recorded so tests can inspect the passes.
const effectRenderers = [];
function EffectRenderer() {
  this.renders = [];
  effectRenderers.push(this);
}
EffectRenderer.prototype.render = function (wrapper, target) {
  this.renders.push({ wrapper, target });
  wrapper.onApplyObservable.notifyObservers(wrapper);
};

function RenderTargetTexture(name, size) {
  this.name = name;
  this._size = { width: size.width, height: size.height };
  this.disposed = false;
}
RenderTargetTexture.prototype.getSize = function () { return this._size; };
RenderTargetTexture.prototype.resize = function (s) {
  this._size = { width: s.width, height: s.height };
};
RenderTargetTexture.prototype.dispose = function () { this.disposed = true; };

function RawTexture(data, width, height) {
  this.data = data;
  this.width = width;
  this.height = height;
  this.disposed = false;
}
RawTexture.prototype.dispose = function () { this.disposed = true; };

globalThis.BABYLON = {
  Constants: {
    TEXTUREFORMAT_RGBA: 3,
    TEXTURE_NEAREST_SAMPLINGMODE: 2,
    TEXTURETYPE_FLOAT: 4,
  },
  Observable,
  Effect,
  EffectWrapper,
  EffectRenderer,
  RenderTargetTexture,
  RawTexture,
};

function load(rel) {
  new Function(fs.readFileSync(path.join(root, rel), "utf8"))();
}
load("src/denoise/hook.js");
load("src/denoise/atrous.js");
const denoise = globalThis.PT_LIB.denoise;

const W = 2;
const H = 2;
const rgba = (fill) => new Float32Array(W * H * 4).fill(fill);
const fakePathTracer = {
  reads: [],
  readTargetData(target) {
    this.reads.push(target);
    return Promise.resolve(new Float32Array(W * H * 4).fill(target.fill));
  },
};
function makeCtx(overrides) {
  return Object.assign(
    {
      converged: true,
      accumulationId: 1,
      width: W,
      height: H,
      scene: {},
      beauty: { fill: 0.9 },
      albedo: { fill: 0.5 },
      normal: { fill: 0.1 },
      depth: { fill: 3 },
      pathTracer: fakePathTracer,
    },
    overrides || {}
  );
}

// ------------------------------------------------------------------- tests
console.log("Denoise hook (one-shot)\n");

{
  const stub = {
    calls: 0,
    lastInput: null,
    denoise(input) {
      this.calls++;
      this.lastInput = input;
      return Promise.resolve(new Float32Array(W * H * 3).fill(0.5));
    },
  };
  const hook = denoise.hook(stub);

  check("does nothing before convergence", hook(makeCtx({ converged: false })) === null &&
    stub.calls === 0);

  const first = hook(makeCtx({ accumulationId: 5 }));
  check("starts one run on convergence", !!first && typeof first.then === "function");
  const texture = await first;
  check("adopts an uploaded float RawTexture",
    texture instanceof RawTexture && texture.width === W && texture.height === H);
  check("RGB upload has alpha = 1",
    texture.data[3] === 1 && texture.data[7] === 1);
  check("the denoiser received the read-back buffers",
    stub.calls === 1 && stub.lastInput.color.length === W * H * 4 &&
    stub.lastInput.width === W && stub.lastInput.height === H);

  check("caches the result for the same accumulation",
    hook(makeCtx({ accumulationId: 5 })) === texture && stub.calls === 1);

  const second = await hook(makeCtx({ accumulationId: 6 }));
  check("re-runs for a new accumulation",
    stub.calls === 2 && second !== texture && texture.disposed === true);
}

{
  const readTargets = [];
  const pt = {
    readTargetData(target) {
      readTargets.push(target);
      return Promise.resolve(new Float32Array(W * H * 4));
    },
  };
  	const stub = { denoise: () => Promise.resolve(new Float32Array(W * H * 3)) };
  	const withDepth = denoise.hook(stub, { depth: true });
  	const depthCtx = makeCtx({ pathTracer: pt });
  	await withDepth(depthCtx);
  	check("the depth AOV is read only when asked",
  		readTargets.length === 4 && readTargets[3] === depthCtx.depth);
}

{
  const errors = [];
  const realError = console.error;
  console.error = (m) => errors.push(String(m));
  const failing = denoise.hook({
    denoise: () => Promise.reject(new Error("nope")),
  });
  const result = await failing(makeCtx({ accumulationId: 9 }));
  check("a failing denoiser falls back to identity (null)", result === null);
  check("it does not retry the same accumulation",
    failing(makeCtx({ accumulationId: 9 })) === null);
  await failing(makeCtx({ accumulationId: 10 }));
  console.error = realError;
  check("the failure is reported once", errors.length === 1, errors.length + " error(s)");
}

console.log("\nA-trous hook (GPU)\n");
{
  const hook = denoise.aTrous({ iterations: 2 });
  const beauty = { name: "beauty" };
  const ctx = {
    engine: {},
    scene: {},
    width: 4,
    height: 4,
    accumulationId: 1,
    converged: false,
    beauty,
    normal: { name: "normal" },
    albedo: { name: "albedo" },
    depth: { name: "depth" },
  };

  const result = hook(ctx);
  const renderer = effectRenderers[effectRenderers.length - 1];
  check("returns a float render target", result instanceof RenderTargetTexture);
  check("runs one pass per iteration", renderer.renders.length === 2,
    renderer.renders.length + " passes");
  check("ping-pongs between two targets",
    renderer.renders[0].target !== renderer.renders[1].target);
  check("the result is the last target", result === renderer.renders[1].target);
  check("the second pass reads the first pass output",
    renderer.renders[1].wrapper.effect.calls.colorTex === renderer.renders[0].target);
  check("the step doubles per pass and resolution is bound",
    renderer.renders[1].wrapper.effect.calls.uStep === 2 &&
    renderer.renders[1].wrapper.effect.calls.uResolution[0] === 4);
  check("AOV flags are on and bound",
    renderer.renders[1].wrapper.effect.calls.uHasNormal === 1 &&
    renderer.renders[1].wrapper.effect.calls.uHasAlbedo === 1 &&
    renderer.renders[1].wrapper.effect.calls.uHasDepth === 1 &&
    renderer.renders[1].wrapper.effect.calls.normalTex === ctx.normal);

  const converged = Object.assign({}, ctx, { converged: true, accumulationId: 2 });
  const filtered = hook(converged);
  const afterFirstConverged = renderer.renders.length;
  const again = hook(converged);
  check("reuses the filtered result once converged",
    again === filtered && renderer.renders.length === afterFirstConverged);
  const restarted = hook(Object.assign({}, converged, { accumulationId: 3 }));
  check("re-runs when the accumulation restarts",
    restarted instanceof RenderTargetTexture &&
    renderer.renders.length === afterFirstConverged + 2, 
    renderer.renders.length + " passes");

  const noAov = denoise.aTrous({ iterations: 1 });
  const plain = noAov({
    engine: {},
    scene: {},
    width: 2,
    height: 2,
    accumulationId: 1,
    converged: false,
    beauty: { name: "b" },
  });
  const plainRenderer = effectRenderers[effectRenderers.length - 1];
  check("works without AOVs (similarity weights disabled)",
    plain instanceof RenderTargetTexture &&
    plainRenderer.renders[0].wrapper.effect.calls.uHasNormal === 0 &&
    plainRenderer.renders[0].wrapper.effect.calls.normalTex === plainRenderer.renders[0].wrapper.effect.calls.colorTex);
  check("non-target input is rejected", noAov({ beauty: null }) === null);

  const tunable = denoise.aTrous({ iterations: 2, phiNormal: 128 });
  tunable(ctx);
  const tRenderer = effectRenderers[effectRenderers.length - 1];
  check("phi values are bound from the options",
    tRenderer.renders[0].wrapper.effect.calls.uPhiNormal === 128 &&
    tRenderer.renders[0].wrapper.effect.calls.uPhiDepth === 32);

  const firstTarget = tRenderer.renders[0].target;
  const beforeTune = tRenderer.renders.length;
  tunable.setParams({ phiNormal: 48, phiAlbedo: 16, phiDepth: 8, iterations: 1 });
  tunable(ctx);
  check("setParams applies live without rebuilding the pipeline",
    tRenderer.renders.length === beforeTune + 1 &&
    tRenderer.renders[beforeTune].wrapper.effect.calls.uPhiNormal === 48 &&
    tRenderer.renders[beforeTune].wrapper.effect.calls.uPhiDepth === 8 &&
    tRenderer.renders[beforeTune].target === firstTarget);
  check("params are exposed for inspection",
    tunable.params.iterations === 1 && tunable.params.phiNormal === 48);
  check("setParams returns the hook for chaining",
    tunable.setParams({}) === tunable);

  const convergedCtx = Object.assign({}, ctx, { converged: true, accumulationId: 42 });
  tunable(convergedCtx);
  const afterConverged = tRenderer.renders.length;
  tunable(convergedCtx);
  check("a converged result is cached", tRenderer.renders.length === afterConverged);
  tunable.setParams({ phiAlbedo: 4 });
  tunable(convergedCtx);
  check("setParams invalidates the cached result",
    tRenderer.renders.length > afterConverged);
  tunable.dispose();

  hook.dispose();
  check("dispose is exposed", typeof hook.dispose === "function");
}

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"));
process.exit(failures === 0 ? 0 : 1);
