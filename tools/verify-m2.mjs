// M2 verification — proves the composer and automatic uniform binding work on
// the real shaders, without a browser.
//
//   * loads src/core/composer.js and src/core/uniforms.js as classic scripts
//   * rebuilds the GLSL registry from the generated split files
//   * composes the glTF scene shader (resolving every #include)
//   * parses uniforms/samplers and checks them against the lists that were
//     hand-maintained in the original js/GLTF_Model_Path_Tracing.js
//
// Usage:  node pt_lib/tools/verify-m2.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, ".."); // pt_lib/

let failures = 0;
function check(label, ok, detail) {
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

// --- load the classic-script modules against globalThis -------------------
function loadClassicScript(rel) {
  const code = fs.readFileSync(path.join(root, rel), "utf8");
  new Function(code)();
}
loadClassicScript("src/core/composer.js");
loadClassicScript("src/core/uniforms.js");
const PT_LIB = globalThis.PT_LIB;

// --- helpers to pull a GLSL literal out of a generated/copied file ---------
const INCLUDE_ASSIGN_RE =
  /PT_LIB\.define(?:Include|Shader)\(\s*"([^"]+)"\s*,\s*(`[\s\S]*?`|"(?:[^"\\]|\\.)*")\s*\);/;

const SCENE_ASSIGN_RE =
  /PT_LIB\.defineSceneShader\(\s*"([^"]+)"\s*,\s*(`[\s\S]*?`|"(?:[^"\\]|\\.)*")\s*\);/;

function extractAssignment(rel, re, label) {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  const m = (re || INCLUDE_ASSIGN_RE).exec(text);
  if (!m) {
    throw new Error(
      "No " + (label || "shader") + " registration found in " + rel
    );
  }
  return {
    name: m[1],
    glsl: new Function("return (" + m[2] + ");")(),
  };
}

// --- build the registry from MANIFEST.json --------------------------------
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "src/core/glsl/MANIFEST.json"), "utf8")
);

const registry = Object.create(null);
for (const entry of manifest) {
  const a = extractAssignment(entry.file);
  registry[a.name] = a.glsl;
}

// --- compose the glTF scene shader ----------------------------------------
const scene = extractAssignment(
  "src/scenes/gltf/GLTFModelPathTracing_FragmentShader.js",
  SCENE_ASSIGN_RE,
  "scene shader"
);

const composed = PT_LIB.composeShader(scene.glsl, { registry });
const includeCount = (scene.glsl.match(/#include\s*</g) || []).length;

console.log("M2 verification\n");
console.log("Registry / composer");
check("registry has all manifest entries", Object.keys(registry).length === manifest.length,
  Object.keys(registry).length + " entries");
check("scene shader uses #include directives", includeCount > 0, includeCount + " found");
check("all includes resolved", composed.missingIncludes.length === 0,
  composed.resolvedIncludes + "/" + includeCount + " resolved");
check("no #include left in output", !/#include\s*</.test(composed.glsl));
check("composed output is larger than source", composed.glsl.length > scene.glsl.length,
  composed.glsl.length + " chars");

// --- uniform / sampler discovery ------------------------------------------
const info = PT_LIB.parseUniforms(composed.glsl);

// These are the lists the original scene wrote out by hand
// (js/GLTF_Model_Path_Tracing.js, pathTracingEffect EffectWrapper).
const hostUniforms = [
  "uResolution", "uRandomVec2", "uULen", "uVLen", "uTime", "uFrameCounter",
  "uSampleCounter", "uPreviousSampleCount", "uEPS_intersect", "uCameraMatrix",
  "uApertureSize", "uFocusDistance", "uCameraIsMoving",
  "uLeftSphereInvMatrix", "uRightSphereInvMatrix", "uGLTF_Model_InvMatrix",
  "uQuadLightPlaneSelectionNumber", "uQuadLightRadius", "uModelMaterialType",
  "uModelUsesAlbedoTexture", "uModelUsesBumpTexture",
  "uModelUsesMetallicTexture", "uModelUsesEmissiveTexture",
];

// Stale entries in the original hand list: names bound by the host that were
// never declared in this shader (left over from the HDRI/sky variants). They
// were harmless in the original because Babylon ignores unknown names in an
// EffectWrapper's list — and auto-discovery correctly omits them.
const staleHostUniforms = ["uSunDirection"];
const hostSamplers = [
  "previousBuffer", "tAABBTexture", "tTriangleTexture", "tAlbedoTexture",
  "tBumpTexture", "tMetallicTexture", "tEmissiveTexture",
];

const missingUniforms = hostUniforms.filter((n) => !info.uniforms.includes(n));
const missingSamplers = hostSamplers.filter((n) => !info.samplers.includes(n));

console.log("\nAutomatic uniform binding");
check("every hand-listed uniform is discovered", missingUniforms.length === 0,
  info.uniforms.length + " discovered" +
    (missingUniforms.length ? "; missing: " + missingUniforms.join(", ") : ""));
check("every hand-listed sampler is discovered", missingSamplers.length === 0,
  info.samplers.length + " discovered" +
    (missingSamplers.length ? "; missing: " + missingSamplers.join(", ") : ""));

const extraUniforms = info.uniforms.filter((n) => !hostUniforms.includes(n));
const extraSamplers = info.samplers.filter((n) => !hostSamplers.includes(n));
const discoveredStale = staleHostUniforms.filter((n) => info.uniforms.includes(n));

check("stale hand-list entries are correctly omitted", discoveredStale.length === 0,
  "phantom: " + staleHostUniforms.join(", "));
console.log("  info: hand list had " + hostUniforms.length + " uniforms, " +
  hostSamplers.length + " samplers");
console.log("  info: auto-discovery found " + info.uniforms.length + " uniforms, " +
  info.samplers.length + " samplers");
if (extraUniforms.length) {
  console.log("  info: extra uniforms discovered: " + extraUniforms.join(", "));
}
if (extraSamplers.length) {
  console.log("  info: extra samplers discovered: " + extraSamplers.join(", "));
}

// --- scene adapter coverage ------------------------------------------------
// Cross-check the glTF adapter's bindings against what the shader declares, so
// a runtime "declared but never bound" warning is caught here instead.
const adapterSrc = fs.readFileSync(
  path.join(root, "src/scenes/gltf/gltf-scene.js"),
  "utf8"
);
const adapterKeys = new Set();
{
  const re = /^\s*(u[A-Z][A-Za-z0-9_]*|t[A-Z][A-Za-z0-9_]*|blueNoiseTexture)\s*:/gm;
  let mm;
  while ((mm = re.exec(adapterSrc)) !== null) {
    adapterKeys.add(mm[1]);
  }
}

const internalUniforms = [
  "uResolution", "uRandomVec2", "uTime", "uFrameCounter", "uSampleCounter",
  "uPreviousSampleCount", "uCameraMatrix", "uCameraIsMoving", "uAovChannel",
  "uFireflyClamp",
];
const providedUniforms = new Set(internalUniforms.concat(Array.from(adapterKeys)));
const uncoveredUniforms = info.uniforms.filter((n) => !providedUniforms.has(n));
const uncoveredSamplers = info.samplers.filter(
  (n) => n !== "previousBuffer" && !adapterKeys.has(n)
);

console.log("\nScene adapter coverage");
check(
  "adapter + PathTracer internals cover every declared uniform",
  uncoveredUniforms.length === 0,
  uncoveredUniforms.join(", ") || "none uncovered"
);
check(
  "adapter + previousBuffer cover every declared sampler",
  uncoveredSamplers.length === 0,
  uncoveredSamplers.join(", ") || "none uncovered"
);

// --- universal (data-driven) scene shader ----------------------------------
loadClassicScript("src/core/ingest.js");
loadClassicScript("src/core/glsl/_registry.js");
loadClassicScript("src/scenes/universal/UniversalPathTracing_FragmentShader.js");

const universalGLSL = PT_LIB.glsl.scenes["universal"];
if (!universalGLSL) {
  throw new Error("universal scene shader did not register");
}

const fakeScene = {
  lights: [
    { type: 0, position: [1, 2, 3], color: [1, 1, 1], intensity: 10 },
    { type: 1, direction: [0, -1, 0], color: [1, 0.9, 0.8], intensity: 2 },
  ],
  materials: [
    { albedo: [0.8, 0.8, 0.8], metallic: 0, roughness: 1, emissive: [0, 0, 0], emissiveStrength: 0 },
    { albedo: [0.9, 0.2, 0.2], metallic: 1, roughness: 0.2, emissive: [0, 0, 0], emissiveStrength: 0 },
  ],
  ambient: [0.05, 0.05, 0.06],
  triangleCount: 1234,
};

const prelude = PT_LIB.buildScenePrelude(fakeScene);
const universalComposed = PT_LIB.composeShader(universalGLSL, { registry, prelude: prelude.glsl });

console.log("\nUniversal (data-driven) scene shader");
check("all includes resolved", universalComposed.missingIncludes.length === 0,
  universalComposed.resolvedIncludes + " resolved");
check("no #include left in output", !/#include\s*</.test(universalComposed.glsl));
check("prelude declares light count", /#define PT_LIGHT_COUNT 2/.test(universalComposed.glsl));
// lights are packed into a float texture, not baked as constants
const lightData = PT_LIB.buildLightData(fakeScene.lights);
check("light data packs pos+type / direction / colour+power",
  lightData.count === 2 && lightData.width === 2 && lightData.height === 4 &&
  lightData.array[0] === 1 && lightData.array[1] === 2 && lightData.array[2] === 3 &&
  lightData.array[3] === 0 &&
  lightData.array[4 + 3] === 1 &&
  lightData.array[16 + 3] === 10);
check("prelude no longer bakes light constants",
  !/PT_LIGHT_POS_TYPE/.test(universalComposed.glsl) &&
  !/PT_LIGHT_DIR_RADIUS/.test(universalComposed.glsl) &&
  !/PT_LIGHT_COLOR_POWER/.test(universalComposed.glsl) &&
  !/PT_LIGHT_EXTRA/.test(universalComposed.glsl));
check("universal shader reads lights from tLightData",
  /uniform sampler2D tLightData;/.test(universalGLSL) &&
  /vec4 ptLightPosType\(int i\)/.test(universalGLSL) &&
  /ptLightColorPower\(i\)\.rgb \* ptLightColorPower\(i\)\.w/.test(universalGLSL));
check("universal shader implements spot cones", /cosAngle < extra\.x/.test(universalGLSL));
check("direct lighting does specular NEE (GGX + Smith + Schlick)",
  /float ptD_GGX\(/.test(universalGLSL) &&
  /float ptG_Smith\(/.test(universalGLSL) &&
  /vec3 ptF_Schlick\(/.test(universalGLSL) &&
  /specularSum \+= power \* ndl \* ptSpecularBRDF/.test(universalGLSL));
check("direct lighting carries view dir + roughness and mixes F0",
  /vec3 directLighting\(vec3 x, vec3 nl, vec3 wo, vec3 albedo, float metallic, float roughness\)/.test(universalGLSL) &&
  /vec3 f0 = mix\(vec3\(0\.04\), albedo, metallic\)/.test(universalGLSL) &&
  /directLighting\(x, n, -rayDirection, albedo, metallic, roughness\)/.test(universalGLSL));
check("prelude no longer bakes material constants",
  !/PT_MAT_ALBEDO\[/.test(universalComposed.glsl) &&
  !/PT_MAT_PARAMS\[/.test(universalComposed.glsl) &&
  !/PT_MAT_EMISSIVE\[/.test(universalComposed.glsl));
check("universal shader reads materials from tMaterialData",
  /uniform sampler2D tMaterialData;/.test(universalComposed.glsl) &&
  /vec4 ptMatParams\(int i\)/.test(universalComposed.glsl) &&
  /ptMatEmissive\(mat\)\.rgb \* emissiveStrength/.test(universalGLSL));
check("prelude declares material count and material sampler",
  /#define PT_MATERIAL_COUNT 2/.test(universalComposed.glsl) &&
  /uniform sampler2D tMaterialData;/.test(universalComposed.glsl));
check("prelude declares triangle count", /PT_TRIANGLE_COUNT = 1234/.test(universalComposed.glsl));
check("no uniform arrays (scene data lives in textures)",
  !/uniform\s+vec4\s+\w+\s*\[/.test(universalComposed.glsl));
check("no hardcoded scene content",
  !/Cornell|wallRadius|uQuadLight|uLeftSphere|quads\[/.test(universalGLSL));

// textures: prelude must declare a sampler per distinct texture and generate
// the albedo lookup
check("prelude returns a samplers map", !!prelude.samplers);
check("prelude declares texture count", /#define PT_TEXTURE_COUNT 0/.test(universalComposed.glsl));
check("generated albedo lookup is present",
  /vec3 ptSampleAlbedo\(int mat, vec2 uv\)/.test(universalComposed.glsl));

const texturedScene = {
  lights: [],
  materials: [
    { albedo: [1, 1, 1], metallic: 0, roughness: 1, emissive: [0, 0, 0], emissiveStrength: 0,
      albedoSlot: 0, bumpSlot: 1, metallicSlot: 2, emissiveSlot: -1,
      bumpLevel: 0.5, metallicFromBlue: true, roughnessFromGreen: true },
    { albedo: [0.5, 0.5, 0.5], metallic: 0, roughness: 1, emissive: [0, 0, 0], emissiveStrength: 0,
      albedoSlot: -1, bumpSlot: -1, metallicSlot: -1, emissiveSlot: 2 },
  ],
  textures: [{ invertY: false }, { invertY: false }, { invertY: false }],
  ambient: [0, 0, 0],
  triangleCount: 3,
};
const texturedPrelude = PT_LIB.buildScenePrelude(texturedScene);
check("textured prelude declares a sampler per pooled texture",
  /uniform sampler2D PT_MAT_TEX_0;/.test(texturedPrelude.glsl) &&
  /uniform sampler2D PT_MAT_TEX_2;/.test(texturedPrelude.glsl));
check("textured prelude exposes the samplers",
  !!texturedPrelude.samplers.PT_MAT_TEX_0 && !!texturedPrelude.samplers.PT_MAT_TEX_2);
check("prelude maps albedo / bump / metallic / emissive slots",
  /int\(ptMatSlots\(mat\)\.x\)/.test(texturedPrelude.glsl) &&
  /int\(ptMatSlots\(mat\)\.y\)/.test(texturedPrelude.glsl) &&
  /int\(ptMatSlots\(mat\)\.z\)/.test(texturedPrelude.glsl) &&
  /int\(ptMatSlots\(mat\)\.w\)/.test(texturedPrelude.glsl));
check("prelude reads bump level and MR channel flags from the material texture",
  /nt\.xy \*= ptMatParams\(mat\)\.w/.test(texturedPrelude.glsl) &&
  /vec2 flags = ptMatFlags\(mat\)\.xy/.test(texturedPrelude.glsl));
check("generated bump / emissive / metallic-roughness lookups are present",
  /vec3 ptSampleEmissive\(int mat, vec2 uv\)/.test(texturedPrelude.glsl) &&
  /vec2 ptSampleMetallicRoughness\(int mat, vec2 uv\)/.test(texturedPrelude.glsl) &&
  /vec3 ptApplyBump\(int mat, vec3 n, vec3 tangent, float handedness, vec2 uv\)/.test(texturedPrelude.glsl));

// image-based lighting from scene.environmentTexture
const envBase = {
  lights: [],
  materials: [{ albedo: [1, 1, 1], metallic: 0, roughness: 1, emissive: [0, 0, 0], emissiveStrength: 0 }],
  textures: [],
  ambient: [0.05, 0.05, 0.06],
  triangleCount: 0,
};

check("no environment -> flat ambient fallback, no env sampler",
  !/tEnvironmentTexture/.test(PT_LIB.buildScenePrelude(envBase).glsl) &&
  /PT_ENV_MAX_LOD = 0.000000/.test(PT_LIB.buildScenePrelude(envBase).glsl));

const envCubePrelude = PT_LIB.buildScenePrelude(Object.assign({}, envBase, {
  environment: { texture: { id: "env" }, kind: 1, intensity: 0.5, maxLod: 8 },
}));
check("cube environment declares a samplerCube + define",
  /#define PT_ENV_CUBE 1/.test(envCubePrelude.glsl) &&
  /uniform samplerCube tEnvironmentTexture;/.test(envCubePrelude.glsl) &&
  !!envCubePrelude.samplers.tEnvironmentTexture);
check("environment intensity / max lod are baked",
  /PT_ENV_INTENSITY = 0.500000/.test(envCubePrelude.glsl) &&
  /PT_ENV_MAX_LOD = 8.000000/.test(envCubePrelude.glsl));

const env2dPrelude = PT_LIB.buildScenePrelude(Object.assign({}, envBase, {
  environment: { texture: { id: "equirect" }, kind: 2, intensity: 1, maxLod: 10 },
}));
check("equirect environment declares a sampler2D + define",
  /#define PT_ENV_2D 1/.test(env2dPrelude.glsl) &&
  /uniform sampler2D tEnvironmentTexture;/.test(env2dPrelude.glsl) &&
  !!env2dPrelude.samplers.tEnvironmentTexture);

check("universal shader samples the environment on escaped rays",
  /vec3 ptEnvironmentColor\(vec3 dir, float lod\)/.test(universalGLSL) &&
  /ptEnvironmentColor\(rayDirection, envLod\)/.test(universalGLSL));

// spot lights -> true cones (packed into the light texture)
const spotData = PT_LIB.buildLightData([{
  type: 3, position: [0, 3, 0], direction: [0, -1, 0], color: [1, 1, 1], intensity: 5,
  cosOuter: 0.5, cosInner: -2, exponent: 0,
}]);
check("spot light packs pos / direction / power / cone data",
  spotData.array[0] === 0 && spotData.array[1] === 3 && spotData.array[2] === 0 &&
  spotData.array[3] === 3 &&
  spotData.array[4 + 1] === -1 &&
  spotData.array[8 + 3] === 5 &&
  spotData.array[12] === 0.5 && spotData.array[13] === -2 && spotData.array[14] === 0);

// adapter: world-matrix tracking (moving a mesh re-ingests automatically)
const universalAdapterSrc = fs.readFileSync(
  path.join(root, "src/scenes/universal/universal-scene.js"),
  "utf8"
);
check("adapter exposes a transform-sync option (on by default)",
  /syncTransforms:\s*true/.test(universalAdapterSrc));
check("adapter polls a world-matrix signature",
  /function transformSignature\(\)/.test(universalAdapterSrc) &&
  /if \(opts\.syncTransforms\)/.test(universalAdapterSrc) &&
  /lastTransformSignature = xform/.test(universalAdapterSrc));
check("transform signature reads each mesh's world matrix",
  /node\.computeWorldMatrix\(\)/.test(universalAdapterSrc) &&
  /node\.getWorldMatrix\(\)/.test(universalAdapterSrc));
check("adapter syncs light values without re-ingesting",
  /syncLights:\s*true/.test(universalAdapterSrc) &&
  /updateLightData\(\)/.test(universalAdapterSrc) &&
  /lightDataTexture\.update\(array\)/.test(universalAdapterSrc) &&
  /tLightData: lightDataTexture/.test(universalAdapterSrc));
check("adapter syncs material values without re-ingesting",
  /syncMaterials:\s*true/.test(universalAdapterSrc) &&
  /updateMaterialData\(\)/.test(universalAdapterSrc) &&
  /materialDataTexture\.update\(array\)/.test(universalAdapterSrc) &&
  /PT_LIB\.refreshMaterialScalars\(lastMaterials\)/.test(universalAdapterSrc) &&
  /tMaterialData: materialDataTexture/.test(universalAdapterSrc));

// --- tonemap stage honors scene.imageProcessingConfiguration --------------
const screenOutputSrc = fs.readFileSync(
  path.join(root, "src/core/glsl/shaders/screenOutputFragmentShader.js"),
  "utf8"
);
const pathTracerSrc = fs.readFileSync(
  path.join(root, "src/PathTracer.js"),
  "utf8"
);
check("tonemap honors imageProcessingConfiguration (exposure / contrast / curves)",
  /uniform float uExposure;/.test(screenOutputSrc) &&
  /uniform float uContrast;/.test(screenOutputSrc) &&
  /uniform int uToneMappingEnabled;/.test(screenOutputSrc) &&
  /uniform int uToneMappingType;/.test(screenOutputSrc) &&
  /vec3 ACESToneMapping\(/.test(screenOutputSrc) &&
  /vec3 KhronosPBRNeutralToneMapping\(/.test(screenOutputSrc) &&
  /filteredPixelColor \*= uToneMappingExposure \* uExposure;/.test(screenOutputSrc) &&
  /filteredPixelColor = \(filteredPixelColor - 0.5\) \* uContrast \+ 0.5;/.test(screenOutputSrc) &&
  /applyToneMapping\(filteredPixelColor\)/.test(screenOutputSrc));
check("PathTracer binds scene.imageProcessingConfiguration",
  /scene\.imageProcessingConfiguration/.test(pathTracerSrc) &&
  /"uExposure"/.test(pathTracerSrc) &&
  /"uContrast"/.test(pathTracerSrc) &&
  /"uToneMappingEnabled"/.test(pathTracerSrc) &&
  /"uToneMappingType"/.test(pathTracerSrc) &&
  /TONEMAPPING_KHR_PBR_NEUTRAL/.test(pathTracerSrc));

// --- M5: resolve -> denoise hook -> tonemap split, and first-hit AOVs -------
const screenResolveSrc = fs.readFileSync(
  path.join(root, "src/core/glsl/shaders/screenResolveFragmentShader.js"),
  "utf8"
);
const defaultMainSrc = fs.readFileSync(
  path.join(root, "src/core/glsl/includes/pathtracing_default_main.js"),
  "utf8"
);
const universalShaderSrc = fs.readFileSync(
  path.join(root, "src/scenes/universal/UniversalPathTracing_FragmentShader.js"),
  "utf8"
);
check("the post stage is split (resolve outputs linear HDR, tonemap reads it)",
  /filteredPixelColor \*= uOneOverSampleCounter;/.test(screenResolveSrc) &&
  /uniform sampler2D resolvedBuffer;/.test(screenOutputSrc) &&
  /prototype\._applyDenoise/.test(pathTracerSrc) &&
  /prototype\._renderAovs/.test(pathTracerSrc));
check("the denoise hook accepts sync and async results",
  /typeof result\.then === 'function'/.test(pathTracerSrc) &&
  /denoise: null/.test(pathTracerSrc));
check("default main exposes the first-hit AOV entry",
  /#ifdef PT_AOV_PASS/.test(defaultMainSrc) &&
  /void ptCameraRay\(/.test(defaultMainSrc) &&
  /uniform int uAovChannel;/.test(defaultMainSrc) &&
  /ptFirstHitAlbedo/.test(defaultMainSrc));
check("firefly clamp caps a single sample's luminance",
  /uniform float uFireflyClamp;/.test(defaultMainSrc) &&
  /fireflyLum > uFireflyClamp/.test(defaultMainSrc) &&
  /fireflyClamp: 0/.test(pathTracerSrc) &&
  /"uFireflyClamp"/.test(pathTracerSrc));
check("the universal scene fills the first-hit AOVs",
  /ptFirstHitAlbedo = albedo;/.test(universalShaderSrc) &&
  /ptFirstHitNormal = n;/.test(universalShaderSrc) &&
  /ptFirstHitDepth = t;/.test(universalShaderSrc) &&
  /#ifdef PT_AOV_ONLY/.test(universalShaderSrc));
check("PathTracer composes the AOV pass from the scene source",
  /PT_AOV_PASS/.test(pathTracerSrc) &&
  /PT_AOV_ONLY/.test(pathTracerSrc) &&
  /spec\.aovs === true/.test(pathTracerSrc));
check("PathTracer exposes a post-process chain after the tonemap",
  /postProcesses:\s*null/.test(pathTracerSrc) &&
  /outputTarget:\s*null/.test(pathTracerSrc) &&
  /prototype\.addPostProcess/.test(pathTracerSrc) &&
  /prototype\.clearPostProcesses/.test(pathTracerSrc) &&
  /prototype\._createPostEffects/.test(pathTracerSrc) &&
  /prototype\._renderOutput/.test(pathTracerSrc) &&
  /prototype\._buildPostEffect/.test(pathTracerSrc) &&
  /this\._postRTs\[\(i \+ 1\) % 2\]/.test(pathTracerSrc));
check("post-process chain follows resize and dispose",
  /this\._postRTs\[i\]\.resize\(size\)/.test(pathTracerSrc) &&
  /prototype\._disposePostPasses/.test(pathTracerSrc) &&
  /this\._disposePostPasses\(\);/.test(pathTracerSrc));

// --- M4: capacity detection ----------------------------------------------
const ingestSrc = fs.readFileSync(
  path.join(root, "src/core/ingest.js"),
  "utf8"
);
check("ingest exposes geometry capacity helpers",
  /function geometryCapacity\(/.test(ingestSrc) &&
  /function checkGeometryCapacity\(/.test(ingestSrc) &&
  /PT_LIB\.geometryCapacity = geometryCapacity;/.test(ingestSrc) &&
  /PT_LIB\.checkGeometryCapacity = checkGeometryCapacity;/.test(ingestSrc));
check("ingest overflow error names the limit and the fix",
  /Geometry overflow/.test(ingestSrc) &&
  /texture is the limit/.test(ingestSrc) &&
  /Reduce the triangle count/.test(ingestSrc));
check("PathTracer exposes capability detection",
  /PathTracer\.isSupported = function/.test(pathTracerSrc) &&
  /PathTracer\.supportIssues = function/.test(pathTracerSrc) &&
  /warnOnUnsupported/.test(pathTracerSrc));
check("ingest warns once for ignored material inputs",
  /function warnIgnoredInput\(/.test(ingestSrc) &&
  /invertNormalMapX === true/.test(ingestSrc) &&
  /warnIgnoredInput\(/.test(ingestSrc) &&
  /'invertNormalMap'/.test(ingestSrc));
check("PathTracer warns once for ignored image-processing features",
  /function ignoredImageProcessing\(/.test(pathTracerSrc) &&
  /PT_LIB\.ignoredImageProcessing = ignoredImageProcessing;/.test(pathTracerSrc) &&
  /_warnIgnoredImageProcessing\(\);/.test(pathTracerSrc));

// --- negative tests --------------------------------------------------------
console.log("\nGuard rails");
let threw = false;
try {
  PT_LIB.composeShader("void main(){} #include<does_not_exist>", { registry });
} catch (e) {
  threw = true;
}
check("missing include throws instead of failing silently", threw);

const defined = PT_LIB.composeShader(
  "#version 300 es\nvoid main(){}",
  { registry, defines: { FEATURE_X: 1, FLAG: true } }
).glsl;
check("defines are injected after #version",
  defined.indexOf("#version 300 es\n") === 0 &&
    /#define FEATURE_X 1/.test(defined) &&
    /#define FLAG\b/.test(defined));

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"));
process.exit(failures === 0 ? 0 : 1);
