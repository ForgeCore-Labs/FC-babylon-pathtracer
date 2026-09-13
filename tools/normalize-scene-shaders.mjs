// Normalizes the copied scene shader files so they register into pt_lib's own
// GLSL registry instead of Babylon's global ShadersStore.
//
//   BABYLON.Effect.ShadersStore["pathTracingFragmentShader"] = `...`;
//     ->
//   PT_LIB.defineSceneShader("<scene>", `...`);
//
// The scene name is taken from the parent folder (gltf, gltf-hdri, ...).
// Idempotent: already-normalized files are skipped.
//
// Usage:  node pt_lib/tools/normalize-scene-shaders.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, ".."); // pt_lib/
const scenesRoot = path.join(root, "src", "scenes");

const ASSIGN_RE =
  /BABYLON\.Effect\.ShadersStore\[\s*(['"])pathTracingFragmentShader\1\s*\]\s*=\s*(`[\s\S]*?`|"(?:[^"\\]|\\.)*")\s*;/;

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

let changed = 0;
let scanned = 0;

for (const file of walk(scenesRoot)) {
  scanned++;
  const text = fs.readFileSync(file, "utf8");
  const match = ASSIGN_RE.exec(text);
  if (!match) {
    continue;
  }

  const sceneName = path.basename(path.dirname(file));
  const literal = match[2];

  const header = [
    "// pt_lib — scene shader: " + sceneName,
    "// Extracted from js/. Registers into pt_lib's own GLSL registry",
    "// (PT_LIB.defineSceneShader), not Babylon's global ShadersStore.",
    "",
    "",
  ].join("\n");

  const replacement =
    header +
    "PT_LIB.defineSceneShader(" +
    JSON.stringify(sceneName) +
    ", " +
    literal +
    ");\n";

  const next =
    text.slice(0, match.index) +
    replacement +
    text.slice(match.index + match[0].length);

  fs.writeFileSync(file, next, "utf8");
  changed++;
  console.log(
    '  registered scene shader "' +
      sceneName +
      '"  <-  ' +
      path.relative(root, file).replace(/\\/g, "/")
  );
}

console.log("Scanned " + scanned + " file(s); registered " + changed + " scene shader(s).");
