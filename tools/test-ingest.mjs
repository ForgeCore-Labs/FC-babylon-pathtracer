// Regression tests for scene ingestion material mapping.
//
// The bug these guard against: PBRMaterial defaults emissiveIntensity to 1 even
// with a black emissiveColor, so naively testing emissiveIntensity marked every
// PBR surface as an emitter.
//
// Usage:  node pt_lib/tools/test-ingest.mjs

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

new Function(fs.readFileSync(path.join(root, "src/core/ingest.js"), "utf8"))();
const PT_LIB = globalThis.PT_LIB;

const c3 = (r, g, b) => ({ r, g, b });
const near = (a, b) => Math.abs(a - b) < 1e-6;

console.log("Material mapping\n");

// The regression: a PBRMaterial exactly as Babylon creates it by default.
const pbr = PT_LIB.mapMaterial({
  albedoColor: c3(0.9, 0.1, 0.1),
  metallic: 1.0,
  roughness: 0.2,
  emissiveColor: c3(0, 0, 0),
  emissiveIntensity: 1.0,
});
check("PBR with black emissive is NOT an emitter",
  pbr.emissiveStrength === 0, "strength=" + pbr.emissiveStrength);
check("PBR albedo is read", near(pbr.albedo[0], 0.9), "r=" + pbr.albedo[0]);
check("PBR metallic / roughness are read",
  pbr.metallic === 1.0 && pbr.roughness === 0.2);
check("PBR emissive colour is black", pbr.emissive[0] === 0);

// A genuine emitter must keep its strength.
const lamp = PT_LIB.mapMaterial({
  albedoColor: c3(1, 1, 1),
  emissiveColor: c3(1, 1, 1),
  emissiveIntensity: 8.0,
});
check("emitter keeps its emissiveIntensity", lamp.emissiveStrength === 8.0,
  "strength=" + lamp.emissiveStrength);

// Emissive colour with no explicit intensity.
const em = PT_LIB.mapMaterial({ emissiveColor: c3(1, 0.5, 0) });
check("emissive colour without intensity defaults to 1", em.emissiveStrength === 1.0);

// StandardMaterial path.
const std = PT_LIB.mapMaterial({ diffuseColor: c3(0.75, 0.75, 0.78) });
check("StandardMaterial diffuseColor becomes albedo", near(std.albedo[2], 0.78));
check("StandardMaterial is not an emitter", std.emissiveStrength === 0);

// No material at all.
const none = PT_LIB.mapMaterial(null);
check("null material gives a neutral, non-emissive fallback",
  none.emissiveStrength === 0 && none.albedo[0] > 0 && none.metallic === 0);

console.log("\nTexture channels\n");

const bumpTex = { level: 0.4 };
const mrTex = {};
const emTex = {};
const tex = PT_LIB.mapMaterial({
  albedoColor: c3(1, 1, 1),
  albedoTexture: { id: "a" },
  diffuseTexture: { id: "d" },
  bumpTexture: bumpTex,
  metallicTexture: mrTex,
  emissiveTexture: emTex,
  useMetallnessFromMetallicTextureBlue: false,
  useRoughnessFromMetallicTextureGreen: false,
});
check("albedoTexture wins over diffuseTexture",
  !!tex.albedoTexture && tex.albedoTexture.id === "a");
check("bump / metallic / emissive textures are captured",
  tex.bumpTexture === bumpTex && tex.metallicTexture === mrTex && tex.emissiveTexture === emTex);
check("bump level is captured", tex.bumpLevel === 0.4, "level=" + tex.bumpLevel);
check("metallic / roughness channel flags are captured",
  tex.metallicFromBlue === false && tex.roughnessFromGreen === false);

// An emissive texture makes a material emissive even with a black emissiveColor
// (the shader multiplies the colour in; a black texture simply adds nothing).
const emTexOnly = PT_LIB.mapMaterial({ emissiveColor: c3(0, 0, 0), emissiveTexture: {} });
check("emissive texture marks the material emissive",
  emTexOnly.emissiveStrength === 1.0, "strength=" + emTexOnly.emissiveStrength);

// Without textures, channel defaults must not perturb the flat material.
const noTex = PT_LIB.mapMaterial({ albedoColor: c3(1, 1, 1) });
check("no textures -> null textures, level 1, flags on",
  noTex.bumpTexture === null && noTex.metallicTexture === null && noTex.emissiveTexture === null &&
  noTex.bumpLevel === 1.0 && noTex.metallicFromBlue === true && noTex.roughnessFromGreen === true);

console.log("\nGeometry capacity\n");

const cap = PT_LIB.geometryCapacity();
check("capacity is reported for both geometry textures",
  cap.maxTriangles > 0 &&
  cap.triangleTextureMaxTriangles === cap.maxTriangles &&
  cap.bvhTextureMaxTriangles > cap.maxTriangles,
  "maxTriangles=" + cap.maxTriangles);

const atCap = PT_LIB.checkGeometryCapacity(cap.maxTriangles);
check("a scene exactly at capacity fits",
  atCap.triangleRows === cap.textureHeight && atCap.bvhRows <= cap.textureHeight,
  "rows=" + atCap.triangleRows + "/" + atCap.bvhRows);

let overflow = "";
try {
  PT_LIB.checkGeometryCapacity(cap.maxTriangles + 1);
} catch (e) {
  overflow = e.message;
}
check("one triangle over capacity throws", overflow.indexOf("Geometry overflow") !== -1);
check("the overflow error is actionable",
  overflow.indexOf("Capacity is " + cap.maxTriangles + " triangles") !== -1 &&
  overflow.indexOf("triangle texture is the limit") !== -1 &&
  overflow.indexOf("Reduce the triangle count") !== -1);

console.log("\nIgnored input warnings\n");

const warnings = [];
const realWarn = console.warn;
console.warn = (m) => warnings.push(String(m));

PT_LIB.mapMaterial({ albedoColor: c3(1, 1, 1), invertNormalMapX: true });
PT_LIB.mapMaterial({ albedoColor: c3(1, 1, 1), invertNormalMapX: true });
PT_LIB.mapMaterial({ albedoColor: c3(1, 1, 1) });

console.warn = realWarn;

check("an ignored material input warns exactly once",
  warnings.length === 1 && /invertNormalMap/.test(warnings[0]),
  warnings.length + " warning(s)");

console.log("\nMulti-material meshes (multi-primitive glTF)\n");

// A glTF mesh with several primitives arrives as ONE Babylon mesh with submeshes
// and a MultiMaterial. Taking one material per mesh read that MultiMaterial,
// found no albedo/metallic/roughness, and flattened every primitive onto the
// fallback material (grey, non-metallic) — so no metal and no colour.
function fakeMesh(options) {
  const positions = new Float32Array(18); // 6 vertices
  const indices = new Uint16Array([0, 1, 2, 3, 4, 5]); // 2 triangles
  return Object.assign(
    {
      geometry: {},
      isVisible: true,
      isEnabled: () => true,
      computeWorldMatrix() {},
      getWorldMatrix: () => ({ m: new Array(16).fill(0) }),
      getVerticesData: (kind) => (kind === "position" ? positions : null),
      getIndices: () => indices,
      material: null,
      subMeshes: [],
    },
    options
  );
}

const metal = { albedoColor: c3(0.1, 0.8, 0.1), metallic: 0.95, roughness: 0.08 };
const plastic = { albedoColor: c3(0.8, 0.1, 0.1), metallic: 0.0, roughness: 0.8 };

const multi = fakeMesh({
  material: { subMaterials: [metal, plastic] },
  subMeshes: [
    { materialIndex: 0, indexStart: 0, indexCount: 3, verticesStart: 0, verticesCount: 3 },
    { materialIndex: 1, indexStart: 3, indexCount: 3, verticesStart: 3, verticesCount: 3 },
  ],
});

const input = PT_LIB.buildSceneInput({ meshes: [multi] }, {}, false);
check("a multi-material mesh splits into one entry per submesh",
  input.meshData.length === 2, "entries=" + input.meshData.length);
check("the split entries add up to the mesh triangle count",
  input.meshData.reduce((n, m) => n + m.triangleCount, 0) === 2);
check("submesh 0 resolves to its own (metal) material",
  input.materials[input.meshData[0].materialIndex].metallic === 0.95);
check("submesh 1 resolves to its own (plastic) material",
  input.materials[input.meshData[1].materialIndex].metallic === 0.0 &&
  input.materials[input.meshData[1].materialIndex].roughness === 0.8);
check("the entries slice the submesh index ranges",
  Array.from(input.meshData[0].indices).join(",") === "0,1,2" &&
  Array.from(input.meshData[1].indices).join(",") === "3,4,5");

// A plain single-material mesh must stay one entry (no behaviour change).
const single = fakeMesh({ material: metal });
const singleInput = PT_LIB.buildSceneInput({ meshes: [single] }, {}, false);
check("a single-material mesh stays one entry",
  singleInput.meshData.length === 1 &&
  singleInput.materials[singleInput.meshData[0].materialIndex].metallic === 0.95);

// If the submeshes do not cover the mesh, keep it whole rather than under-count.
const partial = fakeMesh({
  material: { subMaterials: [metal, plastic] },
  subMeshes: [{ materialIndex: 0, indexStart: 0, indexCount: 3 }],
});
const partialInput = PT_LIB.buildSceneInput({ meshes: [partial] }, {}, false);
check("a partial submesh split falls back to the whole mesh",
  partialInput.meshData.length === 1 && partialInput.meshData[0].triangleCount === 2);

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"));
process.exit(failures === 0 ? 0 : 1);
