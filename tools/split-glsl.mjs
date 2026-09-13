// One-time extraction tool for pt_lib.
//
// Splits the monolithic js/PathTracingCommon.js (1573 lines: two full fragment
// shaders + many GLSL includes, all registered into BABYLON shader stores)
// into one clean file per snippet under src/core/glsl/.
//
// The original js/ file is only read, never modified.
//
// Usage:  node pt_lib/tools/split-glsl.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, ".."); // pt_lib/
const srcFile = path.resolve(root, "..", "js", "PathTracingCommon.js");
const outRoot = path.join(root, "src", "core", "glsl");

const text = fs.readFileSync(srcFile, "utf8");

// Matches: BABYLON.Effect.<Store>['name'] = `...body...`;
const re =
  /BABYLON\.Effect\.(ShadersStore|IncludesShadersStore)\[\s*(['"])([^'"]+)\2\s*\]\s*=\s*`([\s\S]*?)`;/g;

const entries = [];
let m;
while ((m = re.exec(text)) !== null) {
  entries.push({
    store: m[1],
    quote: m[2],
    name: m[3],
    body: m[4],
  });
}

if (entries.length === 0) {
  console.error("No shader entries parsed from " + srcFile);
  process.exit(1);
}

fs.mkdirSync(path.join(outRoot, "shaders"), { recursive: true });
fs.mkdirSync(path.join(outRoot, "includes"), { recursive: true });

const manifest = [];

for (const e of entries) {
  const isShader = e.store === "ShadersStore";
  const dir = isShader ? "shaders" : "includes";

  // Re-emit the GLSL verbatim. A template literal keeps it readable; if the
  // body contains a backtick or ${ we fall back to JSON.stringify so the
  // emitted JavaScript cannot be misinterpreted.
  const literal =
    e.body.includes("`") || e.body.includes("${")
      ? JSON.stringify(e.body)
      : "`" + e.body + "`";

  const header = [
    "// pt_lib — GLSL " + (isShader ? "fragment shader" : "include") + ": " + e.name,
    "// Extracted from js/PathTracingCommon.js (original left untouched).",
    "// Registers into pt_lib's own GLSL registry (PT_LIB.glsl), not Babylon's",
    "// global shader stores, so scenes cannot clobber one another.",
    "",
    "",
  ].join("\n");

  const registerFn = isShader ? "PT_LIB.defineShader" : "PT_LIB.defineInclude";
  const code =
    header + registerFn + "(" + JSON.stringify(e.name) + ", " + literal + ");\n";

  fs.writeFileSync(path.join(outRoot, dir, e.name + ".js"), code, "utf8");

  manifest.push({
    order: manifest.length + 1,
    store: e.store,
    name: e.name,
    file: "src/core/glsl/" + dir + "/" + e.name + ".js",
  });
}

// Preserve hand-written manifest entries (e.g. the M5 resolve shader) that this
// one-time extraction tool does not generate, so re-running it cannot silently
// drop them from dist/pt_lib.core.js.
let existing = [];
try {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(outRoot, "MANIFEST.json"), "utf8")
  );
  if (Array.isArray(parsed)) existing = parsed;
} catch {
  existing = [];
}
const generatedFiles = new Set(manifest.map((e) => e.file));
for (const e of existing) {
  if (generatedFiles.has(e.file)) continue;
  if (!fs.existsSync(path.join(root, e.file))) continue;
  manifest.push(e);
}
manifest.forEach((e, i) => {
  e.order = i + 1;
});

fs.writeFileSync(
  path.join(outRoot, "MANIFEST.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  "utf8"
);

// Sanity check: any shader-store assignment we failed to parse?
const leftover = text.replace(re, "");
const strayStores = (leftover.match(/ShadersStore/g) || []).length;

console.log("Source:          " + srcFile);
console.log("Parsed entries:  " + entries.length);
console.log(
  "  full shaders:  " + manifest.filter((x) => x.store === "ShadersStore").length
);
console.log(
  "  includes:      " +
    manifest.filter((x) => x.store === "IncludesShadersStore").length
);
console.log("Stray store mentions outside parsed blocks: " + strayStores);
console.log("Output:          " + outRoot);
