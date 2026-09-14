// Type declarations for babylon-pathtracer (dist/pt_lib.esm.js).
//
// Hand-written and pragmatic: the mainstream API is typed, and the deep
// ingested-scene structures are intentionally loose (`SceneData`), since they
// feed the generated GLSL rather than a public contract. @babylonjs/core is a
// peer dependency.

import type * as BABYLON from "@babylonjs/core";

/** Per-frame info handed to `options.onFrame` and to uniform/sampler getters. */
export interface Frame {
  deltaTime: number;
  timeSeconds: number;
  cameraMoved: boolean;
  jsMs: number;
}

/** A user full-screen pass appended after the tonemap. */
export interface PostProcessSpec {
  name?: string;
  fragmentShader?: string;
  uniforms?: Record<string, unknown>;
  samplers?: Record<string, unknown>;
  uniformNames?: string[];
  samplerNames?: string[];
  /** Sampler fed the previous stage. Default `"textureSampler"`. */
  inputName?: string;
  /** Prebuilt wrapper instead of a spec; the tracer never disposes it. */
  effect?: BABYLON.EffectWrapper;
}

/** A single sample's AOVs + the resolved beauty, handed to the denoise hook. */
export interface DenoiseContext {
  engine: BABYLON.AbstractEngine;
  scene: BABYLON.Scene;
  pathTracer: PathTracer;
  /** Resolved linear HDR beauty (RGBA float). */
  beauty: BABYLON.RenderTargetTexture;
  /** First-hit AOVs, or null when the scene does not provide them. */
  albedo: BABYLON.RenderTargetTexture | null;
  normal: BABYLON.RenderTargetTexture | null;
  /** `depth.r` = linear hit distance (1e6 where the ray escaped). */
  depth: BABYLON.RenderTargetTexture | null;
  samples: number;
  converged: boolean;
  /** Bumped whenever a new accumulation starts. */
  accumulationId: number;
  width: number;
  height: number;
}

/**
 * Between resolve and tonemap, on linear HDR. Return a texture to filter this
 * frame (GPU), a promise to adopt one when it resolves (one-shot readback), or
 * null for identity.
 */
export type DenoiseHook = (
  ctx: DenoiseContext
) => BABYLON.RenderTargetTexture | null | Promise<BABYLON.RenderTargetTexture | null>;

export interface ATroursParams {
  iterations: number;
  step: number;
  phiNormal: number;
  phiAlbedo: number;
  phiDepth: number;
}

/** GPU a-trous hook: zero readback, live-tunable. */
export interface ATroursHook {
  (ctx: DenoiseContext): BABYLON.RenderTargetTexture | null;
  setParams(next: Partial<ATroursParams>): ATroursHook;
  params: ATroursParams;
  dispose(): void;
}

/** A CPU/GPU-agnostic backend: RGB `width * height * 3`. */
export type Denoiser = (input: {
  color: Float32Array;
  albedo?: Float32Array | null;
  normal?: Float32Array | null;
  depth?: Float32Array | null;
  width: number;
  height: number;
}) => Float32Array | Promise<Float32Array>;

export interface ShaderSpec {
  /** Scene GLSL containing `#include<...>`. */
  source: string;
  defines?: Record<string, string | number | boolean> | null;
  prelude?: string | null;
  uniforms?: Record<string, unknown | ((pt: PathTracer, frame: Frame) => unknown)>;
  samplers?: Record<string, unknown | ((pt: PathTracer, frame: Frame) => unknown)>;
  screenCopy?: string | null;
  screenResolve?: string | null;
  screenOutput?: string | null;
  /** Scene opts into first-hit AOV support. */
  aovs?: boolean;
}

export interface PathTracerOptions {
  resolutionScale?: number;
  maxSamples?: number;
  maxBounces?: number;
  toneMappingExposure?: number;
  sceneIsDynamic?: boolean;
  /** Linear luminance ceiling for one sample; 0 = off. */
  fireflyClamp?: number;
  /** 0 = random; > 0 = reproducible sampling. */
  seed?: number;
  /** Force first-hit AOVs on. */
  aovs?: boolean;
  /** Far plane used to normalize the depth AOV for PNG export. */
  aovDepthFar?: number;
  postProcesses?: PostProcessSpec[] | null;
  outputTarget?: BABYLON.RenderTargetTexture | null;
  warnOnUnsupported?: boolean;
  autoDetectCameraMove?: boolean;
  warnUnboundUniforms?: boolean;
  edgeSharpenSpeed?: number;
  filterDecaySpeed?: number;
  denoise?: DenoiseHook | null;
  onFrame?: ((pt: PathTracer, frame: Frame) => void) | null;
}

/** Ingested scene data (feeds the generated GLSL). Deliberately loose. */
export interface SceneData {
  triangleArray: Float32Array;
  aabbArray: Float32Array;
  triangleTextureWidth: number;
  triangleTextureHeight: number;
  aabbTextureWidth: number;
  aabbTextureHeight: number;
  triangleCount: number;
  materials: unknown[];
  textures: unknown[];
  environment: unknown;
  lights: unknown[];
  ambient: number[];
  lightTypes: Record<string, number>;
}

export class PathTracer {
  constructor(name: string, scene: BABYLON.Scene, options?: PathTracerOptions);

  options: PathTracerOptions;
  samples: number;
  isConverged: boolean;
  isRunning: boolean;
  engine: BABYLON.AbstractEngine;
  scene: BABYLON.Scene;

  onProgressObservable: BABYLON.Observable<number>;
  onConvergedObservable: BABYLON.Observable<number>;
  onErrorObservable: BABYLON.Observable<unknown>;

  setShader(spec: ShaderSpec): this;
  start(): this;
  stop(): this;
  reset(): this;
  resize(): this;
  dispose(): void;

  notifyChanged(): this;
  setMaxSamples(maxSamples: number): this;
  setSeed(seed: number): this;
  /** Swap the denoise hook; rebuilds only the AOV pass. */
  setDenoise(fn: DenoiseHook | null): this;

  addPostProcess(spec: PostProcessSpec): this;
  removePostProcess(spec: PostProcessSpec): this;
  clearPostProcesses(): this;

  /** Renders the current image to PNG data URLs (browser only). */
  exportImage(options?: {
    aovs?: boolean;
    download?: boolean;
    filename?: string;
  }): Promise<Partial<Record<"beauty" | "albedo" | "normal" | "depth", string>>>;

  /** Float RGBA readback of a render target (row order as rendered). */
  readTargetData(target: BABYLON.RenderTargetTexture): Promise<Float32Array>;

  static isSupported(engine: BABYLON.AbstractEngine | null): boolean;
  static supportIssues(engine: BABYLON.AbstractEngine | null): string[];
}

export interface UniversalSceneOptions {
  resolutionScale?: number;
  maxSamples?: number;
  maxBounces?: number;
  cameraPosition?: [number, number, number];
  focusDistance?: number;
  apertureSize?: number;
  epsIntersect?: number;
  hideSceneMeshes?: boolean;
  showLights?: boolean;
  autoReingest?: boolean;
  syncVisibility?: boolean;
  syncTransforms?: boolean;
  syncLights?: boolean;
  syncMaterials?: boolean;
  reingestDebounceMs?: number;
  blueNoiseFile?: string;
  maxTextures?: number;
  /** Offload packing + BVH to the geometry worker (default true). */
  worker?: boolean;
  onIngestProgress?: (progress: { phase: string; done: number; total: number }) => void;
  /** Override the worker's importScripts URLs. */
  workerScripts?: { packing?: string; bvh?: string } | null;
  fireflyClamp?: number;
  seed?: number;
  aovs?: boolean;
  setup?: ((scene: BABYLON.Scene, camera: BABYLON.Camera) => void | Promise<void>) | null;
}

export interface UniversalApp {
  engine: BABYLON.AbstractEngine;
  scene: BABYLON.Scene;
  camera: BABYLON.Camera;
  /** The tracer instance — stable across re-ingests. */
  pathTracer: PathTracer;
  ingested: SceneData | null;
  triangleCount: number;
  debugMode: number;
  showLights: boolean;
  ingestProgress: unknown;
  isReady: boolean;
  /** Resolves once rendering has started. */
  ready: Promise<unknown>;
  reingest(): Promise<unknown>;
  rebuild(): Promise<unknown>;
  setWorker(on: boolean): void;
  dispose(): void;
}

export interface IngestProgress {
  phase: string;
  done: number;
  total: number;
}

/** The library namespace attached to the global as `PT_LIB`. */
export interface PtLib {
  PathTracer: typeof PathTracer;
  scenes: {
    universal: {
      create(canvas: HTMLCanvasElement, options?: UniversalSceneOptions): UniversalApp;
      DEFAULTS: UniversalSceneOptions;
    };
    [name: string]: { create: (...args: any[]) => any; DEFAULTS?: unknown };
  };
  denoise: {
    /** Wrap a denoiser as a one-shot PathTracer hook. */
    hook(denoiser: { denoise: Denoiser; dispose?(): void }, options?: { depth?: boolean; force?: boolean }): DenoiseHook;
    aTrous(options?: Partial<ATroursParams>): ATroursHook;
  };
  glsl: {
    shaders: Record<string, string>;
    includes: Record<string, string>;
    scenes: Record<string, string>;
  };
  ingestScene(scene: BABYLON.Scene, options?: Record<string, unknown>): SceneData;
  ingestSceneAsync(scene: BABYLON.Scene, options?: Record<string, unknown>): Promise<SceneData>;
  buildScenePrelude(ingested: SceneData): { glsl: string; samplers: Record<string, unknown> };
  checkGeometryCapacity(triangleCount: number): { triangleRows: number; bvhRows: number };
  geometryCapacity(): {
    maxTriangles: number;
    triangleTextureMaxTriangles: number;
    bvhTextureMaxTriangles: number;
    textureWidth: number;
    textureHeight: number;
  };
  geometryWorker?: {
    configure(opts: {
      packing?: string;
      bvh?: string;
      packingSource?: string;
      bvhSource?: string;
    }): void;
    isAvailable(): boolean;
    isInline(): boolean;
    dispose(): void;
  };
  [key: string]: any;
}

export const PT_LIB: PtLib;
export const scenes: PtLib["scenes"];
export const denoise: PtLib["denoise"];
export const glsl: PtLib["glsl"];
export const ingestScene: PtLib["ingestScene"];
export const ingestSceneAsync: PtLib["ingestSceneAsync"];
export const buildScenePrelude: PtLib["buildScenePrelude"];

export default PT_LIB;
