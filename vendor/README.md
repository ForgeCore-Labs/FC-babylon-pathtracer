# pt_lib/vendor

Deliberately empty of binaries. `pt_lib` ships **no third-party assets**, so a
denoiser model is caller-supplied and loaded at runtime.

This file is the contract for the OIDN (M6) backend in `src/denoise/oidn.js`.
Nothing here is required for the library to work — the denoise hook is opt-in.

---

## What the demo needs

An **Open Image Denoise WebAssembly build** that exposes OIDN's C API. The
driver is agnostic about how you get it: pass a module object, or a factory that
returns one (a promise is fine).

```js
// either
pt.setDenoise(PT_LIB.denoise.oidnHook(module, { hdr: true }));
// or point the demo's "OIDN module url" field at a script that sets a global
// (createOIDN / OIDN / Module) and tick "OIDN denoise (one-shot)".
```

The URL does **not** have to live in this folder — any same-origin path or CDN
that serves it will do. Put it here only if you want it alongside the library.

## Required exports

Plain C-API functions, discovered as `Module._oidnXxx`, `Module.oidnXxx`, or via
`Module.cwrap("oidnXxx", ...)`:

| Export | Purpose |
|---|---|
| `oidnNewDevice` | create the device (the driver passes `OIDN_DEVICE_TYPE_CPU` = 0) |
| `oidnCommitDevice` | commit it |
| `oidnNewFilter` | create the filter (the driver passes `"RT"`) |
| `oidnSetSharedFilterImage` | bind `color` / `albedo` / `normal` / optional `depth` / `output` |
| `oidnSetFilter1b` | set `HDR` (required in HDR mode; also used for `cleanAux`) |
| `oidnCommitFilter` | commit |
| `oidnExecuteFilter` | run |
| `oidnGetDeviceError` | error-code check |
| `oidnReleaseFilter`, `oidnReleaseDevice` | optional, used by `dispose()` |

Plus `_malloc` / `_free` (Emscripten runtime).

The driver reads pixels through `Module.HEAPF32`, so memory growth must be
allowed and the heap view re-read after allocations (the driver does re-read; a
build with `-s ALLOW_MEMORY_GROWTH=1` avoids surprises).

`oidnSetSharedFilterImage` is called with formats/strides that match the tracer's
readback, so no repacking happens:

| Image | Format | byte pixel stride | byte row stride |
|---|---|---|---|
| `color`, `albedo`, `normal` | `OIDN_FORMAT_FLOAT3` (3) | 16 (RGBA readback) | `width * 16` |
| `depth` | `OIDN_FORMAT_FLOAT` (1) | 16 (reads the R channel) | `width * 16` |
| `output` | `OIDN_FORMAT_FLOAT3` (3) | 12 (packed RGB) | `width * 12` |

## Sketch of the Emscripten side

Approximate — OIDN's own build has to cooperate (its CPU kernels are normally
ISPC-generated and it leans on TBB):

```sh
emcmake cmake -DOIDN_DEVICE_CPU=ON ...   # portable/generic kernels, no ISPC
# then link the oidn API with, at minimum:
-s EXPORTED_FUNCTIONS='["_oidnNewDevice","_oidnCommitDevice","_oidnNewFilter",
  "_oidnSetSharedFilterImage","_oidnSetFilter1b","_oidnCommitFilter",
  "_oidnExecuteFilter","_oidnGetDeviceError","_oidnReleaseFilter",
  "_oidnReleaseDevice","_malloc","_free"]'
-s ALLOW_MEMORY_GROWTH=1
# classic script (sets a global) or MODULARIZE (exposes a factory)
```

## Verifying a candidate build

Load it, then in the console:

```js
Object.keys(Module || window).filter((k) => /oidn|_malloc|HEAPF32/.test(k))
```

You should see the names above. The driver also fails loudly if one is missing:

```
[pt_lib] OIDN module is missing oidnNewDevice, _malloc/_free. Export the oidn* C API ...
```

## If building OIDN is not worth it

Two alternatives, both fitting the same
`denoise(ctx) -> texture | Promise<texture>` hook, and neither needs an OIDN
build:

- **GPU à-trous** — already implemented, no build needed:
  `pt.setDenoise(PT_LIB.denoise.aTrous({ iterations: 3 }))`
  (`src/denoise/atrous.js`). Zero readback, edge-weighted by the AOVs, runs per
  frame while converging. Try this first to confirm the denoise plumbing.
- **onnxruntime-web + a denoiser model** — same seam via
  `PT_LIB.denoise.hook(denoiser)`, where
  `denoiser.denoise({ color, albedo, normal, depth, width, height })` returns
  `Float32Array` RGB.
