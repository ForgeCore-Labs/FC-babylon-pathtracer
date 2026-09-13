// Capability detection tests for PathTracer.isSupported / supportIssues.
//
// The tracer compiles GLSL ES 3.00 and accumulates into FLOAT render targets,
// so the check must reject WebGL1 and engines without float render support —
// and explain why, since start() warns with that list.
//
// Usage:  node pt_lib/tools/test-support.mjs

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

// PathTracer.js is a classic script with no load-time BABYLON dependency.
new Function(fs.readFileSync(path.join(root, "src/PathTracer.js"), "utf8"))();
const PathTracer = globalThis.PT_LIB.PathTracer;

const caps = (over) =>
  Object.assign({ textureFloat: true, textureFloatRender: true }, over || {});
const gl2 = (over) => ({ webGLVersion: 2, getCaps: () => caps(over) });

console.log("Capability detection\n");

check("WebGL2 + float render targets is supported", PathTracer.isSupported(gl2()) === true);
check("WebGL1 is rejected",
  PathTracer.isSupported({ webGLVersion: 1, getCaps: () => caps() }) === false);
check("missing float textures is rejected",
  PathTracer.isSupported(gl2({ textureFloat: false })) === false);
check("missing float render targets is rejected",
  PathTracer.isSupported(gl2({ textureFloatRender: false, colorBufferFloat: false })) === false);
check("colorBufferFloat alone counts as float render support",
  PathTracer.isSupported(gl2({ textureFloatRender: false, colorBufferFloat: true })) === true);
check("WebGPU is supported", PathTracer.isSupported({ isWebGPU: true }) === true);
check("a null engine is rejected", PathTracer.isSupported(null) === false);

const issues = PathTracer.supportIssues({
  webGLVersion: 1,
  getCaps: () => caps({ textureFloat: false, textureFloatRender: false, colorBufferFloat: false }),
});
check("supportIssues lists every problem", issues.length === 3, issues.length + " issues");
check("supportIssues names the WebGL2 requirement",
  issues.some((s) => s.indexOf("WebGL2") !== -1));
check("supportIssues handles an engine with no getCaps",
  PathTracer.supportIssues({ webGLVersion: 2 }).length === 1);
check("supportIssues handles a null engine",
  PathTracer.supportIssues(null).length === 1);

console.log("\nIgnored image-processing features\n");

const ignored = globalThis.PT_LIB.ignoredImageProcessing;
check("nothing is reported for a default config", ignored({}).length === 0);
check("color curves and grading are reported",
  ignored({ colorCurvesEnabled: true, colorGradingEnabled: true }).length === 2);
check("a missing config is tolerated", ignored(null).length === 0);

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"));
process.exit(failures === 0 ? 0 : 1);
