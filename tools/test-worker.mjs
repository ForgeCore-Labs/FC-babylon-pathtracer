// Equivalence + unit tests for the geometry Web Worker path (M4).
//
// The worker cannot be instantiated in node (`new Worker(blobURL)` is
// browser-only), so this test exercises the two things that actually decide
// whether the worker is safe:
//
//   1. The worker's BABYLON.Vector3 shim is byte-for-byte faithful to Babylon's
//      transform math — the packed arrays must not change just because the
//      geometry was built off the main thread.
//   2. The main-thread path (PT_LIB.ingestScene) and the worker path
//      (PT_PackGeometry over buildSceneInput's transferable data) produce
//      byte-identical triangle and BVH arrays for the same scene.
//
// It also pins the shim's semantics, the generated bootstrap's shape, and the
// progress messages.
//
// Usage:  node pt_lib/tools/test-worker.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, ".."); // pt_lib/

let failures = 0;
function check(label, ok, detail) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const packingSource = read("src/core/geometry-packing.js");
const bvhSource = read("src/core/bvh/BVH_SAH_Quality_Builder.js");
const ingestSource = read("src/core/ingest.js");
const workerSourceFile = read("src/core/geometry-worker.js");

// ---------------------------------------------------------------------------
// The shim is real code in geometry-worker.js; load that file in its own
// context (no document / Worker there) and take the function.
// ---------------------------------------------------------------------------
const workerModuleSandbox = { console };
vm.createContext(workerModuleSandbox);
vm.runInContext(workerSourceFile, workerModuleSandbox, {
  filename: "geometry-worker.js"
});
const geometryWorker = workerModuleSandbox.PT_LIB.geometryWorker;
const shim = geometryWorker.installBabylonVectorShim;

// A reference Vector3, written independently of the shim, mirroring Babylon's
// documented transform math. If the shim drifts from this, the packed geometry
// drifts from the main-thread path.
function installReferenceVector3(scope) {
  class Vec3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }
    set(x, y, z) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
    copyFrom(o) {
      this.x = o.x;
      this.y = o.y;
      this.z = o.z;
      return this;
    }
    copyFromFloats(x, y, z) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
    lengthSquared() {
      return this.x * this.x + this.y * this.y + this.z * this.z;
    }
    normalize() {
      const len = Math.sqrt(this.lengthSquared());
      if (len === 0) return this;
      const inv = 1.0 / len;
      this.x *= inv;
      this.y *= inv;
      this.z *= inv;
      return this;
    }
    subtractToRef(o, r) {
      r.x = this.x - o.x;
      r.y = this.y - o.y;
      r.z = this.z - o.z;
      return this;
    }
    minimizeInPlace(o) {
      this.x = Math.min(this.x, o.x);
      this.y = Math.min(this.y, o.y);
      this.z = Math.min(this.z, o.z);
      return this;
    }
    maximizeInPlace(o) {
      this.x = Math.max(this.x, o.x);
      this.y = Math.max(this.y, o.y);
      this.z = Math.max(this.z, o.z);
      return this;
    }
    addInPlace(o) {
      this.x += o.x;
      this.y += o.y;
      this.z += o.z;
      return this;
    }
    scaleInPlace(s) {
      this.x *= s;
      this.y *= s;
      this.z *= s;
      return this;
    }
    static TransformCoordinates(v, t) {
      const m = t.m || t;
      let x = v.x * m[0] + v.y * m[4] + v.z * m[8] + m[12];
      let y = v.x * m[1] + v.y * m[5] + v.z * m[9] + m[13];
      let z = v.x * m[2] + v.y * m[6] + v.z * m[10] + m[14];
      const w = v.x * m[3] + v.y * m[7] + v.z * m[11] + m[15];
      if (w !== 1) {
        x /= w;
        y /= w;
        z /= w;
      }
      return new Vec3(x, y, z);
    }
    static TransformNormal(v, t) {
      const m = t.m || t;
      const x = v.x * m[0] + v.y * m[4] + v.z * m[8];
      const y = v.x * m[1] + v.y * m[5] + v.z * m[9];
      const z = v.x * m[2] + v.y * m[6] + v.z * m[10];
      return new Vec3(x, y, z);
    }
    static CrossToRef(l, r, out) {
      const x = l.y * r.z - l.z * r.y;
      const y = l.z * r.x - l.x * r.z;
      const z = l.x * r.y - l.y * r.x;
      return out.set(x, y, z);
    }
  }
  scope.BABYLON = { Vector3: Vec3 };
}

// The worker bootstrap, as the browser would execute it: the stringified shim
// bound to `self`, then the existing sources verbatim.
function makeWorkerContext() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(
    "var self = globalThis;\n" +
      "(" + shim.toString() + ")(self);\n" +
      bvhSource + "\n" +
      packingSource,
    sandbox,
    { filename: "geometry-worker-bootstrap.js" }
  );
  return sandbox;
}

// The main-thread context: an independent Vector3 plus the same sources and the
// real ingestion module.
function makeMainContext() {
  const sandbox = { console };
  vm.createContext(sandbox);
  installReferenceVector3(sandbox);
  vm.runInContext(
    bvhSource + "\n" + packingSource + "\n" + ingestSource,
    sandbox,
    { filename: "main-thread.js" }
  );
  return sandbox;
}

const bytes = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
const sameBytes = (a, b) => bytes(a).equals(bytes(b));
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ---------------------------------------------------------------------------
// Test scene data
// ---------------------------------------------------------------------------

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
// scale 2 + translate (3,4,5)
const SCALE_TRANSLATE = new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 3, 4, 5, 1]);
// w-divide matrix (m[15] = 2)
const W_DIVIDE = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2]);

function makeMeshes() {
  return [
    {
      // one triangle, identity, full attributes
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
      indices: null,
      matrix: { m: IDENTITY },
      materialIndex: 0,
      triangleCount: 1
    },
    {
      // indexed quad (2 triangles), scaled / translated
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0.5, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
      matrix: { m: SCALE_TRANSLATE },
      materialIndex: 2,
      triangleCount: 2
    },
    {
      // no normals, no uvs, w-divide matrix (face normal + fallback tangent)
      positions: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      normals: null,
      uvs: null,
      indices: null,
      matrix: { m: W_DIVIDE },
      materialIndex: 1,
      triangleCount: 1
    }
  ];
}

const totalTriangles = (meshes) =>
  meshes.reduce((sum, m) => sum + m.triangleCount, 0);

// Mirrors ingest.js's geometryTextureRows for the default constants.
function rowsFor(n) {
  const perRow = 2048 * 4;
  return {
    triangleRows: Math.max(1, Math.ceil((32 * n) / perRow)),
    bvhRows: Math.max(1, Math.ceil((16 * n) / perRow))
  };
}

// ---------------------------------------------------------------------------

console.log("Shim semantics\n");

const shimVector = makeWorkerContext().BABYLON.Vector3;
{
  const p = shimVector.TransformCoordinates(new shimVector(1, 2, 3), { m: IDENTITY });
  check("TransformCoordinates applies the identity", p.x === 1 && p.y === 2 && p.z === 3);

  const t = shimVector.TransformCoordinates(new shimVector(1, 2, 3), { m: SCALE_TRANSLATE });
  check("TransformCoordinates applies scale then translation",
    t.x === 5 && t.y === 8 && t.z === 11, `(${t.x},${t.y},${t.z})`);

  const w = shimVector.TransformCoordinates(new shimVector(1, 2, 3), { m: W_DIVIDE });
  check("TransformCoordinates divides through w when w !== 1",
    w.x === 0.5 && w.y === 1 && w.z === 1.5, `(${w.x},${w.y},${w.z})`);

  const n = shimVector.TransformNormal(new shimVector(1, 2, 3), { m: SCALE_TRANSLATE });
  check("TransformNormal ignores translation",
    n.x === 2 && n.y === 4 && n.z === 6, `(${n.x},${n.y},${n.z})`);

  const c = shimVector.CrossToRef(
    new shimVector(1, 0, 0), new shimVector(0, 1, 0), new shimVector()
  );
  check("CrossToRef is a right-handed cross",
    c.x === 0 && c.y === 0 && c.z === 1, `(${c.x},${c.y},${c.z})`);

  const len = new shimVector(3, 0, 4);
  len.normalize();
  check("normalize produces a unit vector", near(len.x, 0.6) && near(len.z, 0.8));

  const zero = new shimVector(0, 0, 0);
  zero.normalize();
  check("normalize(0) stays 0 instead of producing NaN",
    zero.x === 0 && zero.y === 0 && zero.z === 0);

  const box = new shimVector(5, 5, 5);
  box.minimizeInPlace(new shimVector(1, 9, 3));
  check("minimizeInPlace takes the component-wise min",
    box.x === 1 && box.y === 5 && box.z === 3);
  box.maximizeInPlace(new shimVector(4, 7, 8));
  check("maximizeInPlace takes the component-wise max",
    box.x === 4 && box.y === 7 && box.z === 8);
  box.addInPlace(new shimVector(1, 1, 1)).scaleInPlace(2);
  check("addInPlace / scaleInPlace chain",
    box.x === 10 && box.y === 16 && box.z === 18);

  const copied = new shimVector().copyFromFloats(7, 8, 9).copyFrom(new shimVector(9, 8, 7));
  check("copyFromFloats then copyFrom", copied.x === 9 && copied.y === 8 && copied.z === 7);
}

console.log("\nWorker bootstrap\n");

{
  const before = geometryWorker.isAvailable();
  check("no Worker / no script URLs -> not available headlessly", before === false);

  geometryWorker.configure({ packing: "http://x/geometry-packing.js", bvh: "http://x/BVH.js" });
  const source = geometryWorker.workerSource();
  check("bootstrap installs the Babylon shim", source.includes("installBabylonVectorShim"));
  check("bootstrap importScripts the two sources verbatim",
    source.includes('importScripts("http://x/geometry-packing.js", "http://x/BVH.js")'));
  check("bootstrap ends with the dispatcher", source.includes("geometryWorkerMain"));
  check("bootstrap references no DOM globals",
    !source.includes("document.") && !source.includes("window."));
}

console.log("\nPacking equivalence (shim vs reference Vector3)\n");

{
  const workerCtx = makeWorkerContext();
  const mainCtx = makeMainContext();
  const meshes = makeMeshes();
  const total = totalTriangles(meshes);
  const rows = rowsFor(total);

  const fromWorker = workerCtx.PT_PackGeometry(meshes, total, rows);
  const fromReference = mainCtx.PT_PackGeometry(meshes, total, rows);

  check("triangle arrays are byte-identical",
    sameBytes(fromWorker.triangleArray, fromReference.triangleArray),
    fromWorker.triangleArray.length + " floats");
  check("AABB / BVH arrays are byte-identical",
    sameBytes(fromWorker.aabbArray, fromReference.aabbArray),
    fromWorker.aabbArray.length + " floats");
  check("the BVH actually ran (root is an inner node)", fromWorker.aabbArray[0] === -1);
}

console.log("\nPacking oracle (one known triangle)\n");

{
  const workerCtx = makeWorkerContext();
  const mesh = makeMeshes()[0];
  const packed = workerCtx.PT_PackGeometry([mesh], 1, rowsFor(1));
  const tri = Array.from(packed.triangleArray.slice(0, 32));

  	const expected = [
  		0, 0, 0, /**/ 1, 0, 0, /**/ 0, 1, 0, // positions (three, packed across slots)
  		0, 0, 1, /**/ 0, 0, 1, /**/ 0, 0, 1, // normals
  		0, 0, /**/ 1, 0, /**/ 0, 1, // uvs
  		0, // material index
  		1, 0, 0, // tangent
  		1, 0, 0, 0 // handedness + reserved
  	];
  	const matches =
  		tri.length === expected.length && tri.every((v, i) => v === expected[i]);
  	check("the packed triangle matches the hand-computed layout", matches,
  		matches ? "" : "got [" + tri.join(",") + "]");

  	// The BVH build overwrites the AABB texture with nodes, so for a single
  	// triangle the first node is a leaf covering it: [primitive, min.xyz,
  	// rightChild, max.xyz].
  	check("the BVH leaf covers the triangle",
  		packed.aabbArray[0] === 0 && packed.aabbArray[4] === -1 &&
  		packed.aabbArray[1] === 0 && packed.aabbArray[2] === 0 && packed.aabbArray[3] === 0 &&
  		packed.aabbArray[5] === 1 && packed.aabbArray[6] === 1 && packed.aabbArray[7] === 0,
  		"[" + Array.from(packed.aabbArray.slice(0, 8)).join(",") + "]");
}

console.log("\nGenerated worker source (simulated dispatcher)\n");

{
	geometryWorker.configure({ packing: "http://x/geometry-packing.js", bvh: "http://x/BVH.js" });
	const posted = [];
	const sandbox = { console };
	vm.createContext(sandbox);

	// Execute the exact generated bootstrap, with the importScripts line swapped
	// for the real source text (the only browser-only step). This covers the
	// stringified shim + the dispatcher, not just the shim function.
	let source = geometryWorker.workerSource();
	const importLine = /^importScripts\(.*\);\s*$/m;
	check("generated source has the importScripts line", importLine.test(source));
	source =
		"var self = globalThis;\n" +
		source.replace(importLine, bvhSource + "\n" + packingSource);
	vm.runInContext(source, sandbox, { filename: "generated-geometry-worker.js" });
	sandbox.postMessage = function (msg) {
		posted.push(msg);
	};

	const meshes = makeMeshes();
	const total = totalTriangles(meshes);
	const rows = rowsFor(total);
	sandbox.onmessage({
		data: { type: "pack", id: 7, meshData: meshes, totalTriangles: total, rows: rows }
	});

	const done = posted.filter((m) => m.type === "done");
	const progress = posted.filter((m) => m.type === "progress");
	check("dispatcher replies with done", done.length === 1);
	check("dispatcher reports progress", progress.length > 0, progress.length + " messages");

	const reference = makeMainContext().PT_PackGeometry(makeMeshes(), total, rows);
	check("dispatcher output matches the main-thread packing",
		done.length === 1 &&
		sameBytes(new Float32Array(done[0].triangleArray), reference.triangleArray) &&
		sameBytes(new Float32Array(done[0].aabbArray), reference.aabbArray));

	sandbox.onmessage({
		data: { type: "pack", id: 8, meshData: null, totalTriangles: 1, rows: rowsFor(1) }
	});
	const failed = posted.filter((m) => m.type === "error");
	check("dispatcher turns a packing failure into an error message",
		failed.length === 1, failed[0] && failed[0].message);
}

console.log("\nMain-thread path vs worker path (real ingestScene)\n");

{
  const mainCtx = makeMainContext();
  const PL = mainCtx.PT_LIB;
  check("ingest.js exports the split ingestion API",
    typeof PL.buildSceneInput === "function" &&
    typeof PL.assembleIngested === "function" &&
    typeof PL.ingestSceneAsync === "function");

  const meshes = makeMeshes();
  const mockMeshes = meshes.map((m, index) => ({
    geometry: { id: index },
    isVisible: true,
    material: null,
    computeWorldMatrix() {},
    getWorldMatrix() {
      return { m: m.matrix.m };
    },
    getVerticesData(kind) {
      if (kind === "position") return m.positions;
      if (kind === "normal") return m.normals;
      if (kind === "uv") return m.uvs;
      return null;
    },
    getIndices() {
      return m.indices;
    }
  }));
  const scene = { meshes: mockMeshes, lights: [], environmentTexture: null };

  const progress = [];
  const synced = PL.ingestScene(scene, {
    onProgress(p) {
      progress.push(p);
    }
  });

  check("sync ingest reports the triangle count",
    synced.triangleCount === totalTriangles(meshes), "count=" + synced.triangleCount);
  check("progress covers every mesh plus the BVH",
    progress.filter((p) => p.phase === "pack").length === meshes.length &&
    progress.some((p) => p.phase === "bvh" && p.done === 1),
    progress.length + " events");

  // What the adapter hands the worker: copied, plain data.
  const input = PL.buildSceneInput(scene, {}, true);
  const workerCtx = makeWorkerContext();
  const fromWorker = workerCtx.PT_PackGeometry(
    input.meshData, input.totalTriangles, input.rows
  );

  check("worker triangle texture matches the sync path byte-for-byte",
    sameBytes(synced.triangleArray, fromWorker.triangleArray),
    synced.triangleArray.length + " floats");
  check("worker BVH texture matches the sync path byte-for-byte",
    sameBytes(synced.aabbArray, fromWorker.aabbArray),
    synced.aabbArray.length + " floats");
  check("the packed rows match the reported texture heights",
    input.rows.triangleRows === synced.triangleTextureHeight &&
    input.rows.bvhRows === synced.aabbTextureHeight);
}

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"));
process.exit(failures === 0 ? 0 : 1);
