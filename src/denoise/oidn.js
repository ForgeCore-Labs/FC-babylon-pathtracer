// pt_lib — denoise: OIDN (Open Image Denoise) integration for the M5 hook.
//
// The M5 contract is `options.denoise(ctx) -> texture | Promise<texture>`, run
// between resolve and tonemap on LINEAR HDR values, with `ctx.albedo` /
// `ctx.normal` / `ctx.depth` available as float render targets. This file turns
// OIDN into such a hook:
//
//   * one-shot: it waits for `ctx.converged`, then reads back beauty + the
//     auxiliary AOVs ONCE, runs the filter, and caches the result for that
//     accumulation. No per-frame readback.
//   * CPU / WASM: the model is caller-supplied. Nothing is vendored here — no
//     third-party assets ship in pt_lib.
//
// Three pieces:
//   PT_LIB.denoise.oidn(module, options)      -> a "denoiser" over OIDN's C API
//   PT_LIB.denoise.hook(denoiser, options)    -> the PathTracer denoise hook
//   PT_LIB.denoise.oidnHook(module, options)  -> the two composed
//
// The `denoiser` interface is deliberately tiny, so a custom backend (a GPU
// à-trous pass is the other planned one) can be swapped in:
//   denoiser.denoise({ color, albedo, normal, depth, width, height })
//     -> Promise<Float32Array> | Float32Array   // RGB, width*height*3
//   denoiser.dispose?()
//
// Classic-script module: attaches PT_LIB.denoise.

(function (root) {
	'use strict';

	var PT_LIB = (root.PT_LIB = root.PT_LIB || {});
	var denoise = (PT_LIB.denoise = PT_LIB.denoise || {});

	// OIDN C enums (stable public API).
	var OIDN_DEVICE_TYPE_CPU = 0;
	var OIDN_FORMAT_FLOAT = 1;
	var OIDN_FORMAT_FLOAT3 = 3;

	// cwrap fallbacks, used only when the module exposes cwrap() instead of the
	// exported `_oidn*` functions. `ret: null` means "void".
	var OIDN_FUNCS = {
		oidnNewDevice: { ret: 'number', args: ['number'] },
		oidnCommitDevice: { ret: null, args: ['number'] },
		oidnReleaseDevice: { ret: null, args: ['number'] },
		oidnNewFilter: { ret: 'number', args: ['number', 'string'] },
		oidnSetFilter1b: { ret: null, args: ['number', 'string', 'number'] },
		oidnSetSharedFilterImage: {
			ret: null,
			args: [
				'number', 'string', 'number', 'number', 'number',
				'number', 'number', 'number', 'number'
			]
		},
		oidnCommitFilter: { ret: null, args: ['number'] },
		oidnExecuteFilter: { ret: null, args: ['number'] },
		oidnReleaseFilter: { ret: null, args: ['number'] },
		oidnGetDeviceError: { ret: 'number', args: ['number', 'number'] }
	};

	function bindFunction(module, name) {
		if (typeof module['_' + name] === 'function') {
			return module['_' + name];
		}
		if (typeof module[name] === 'function') {
			return module[name];
		}
		var spec = OIDN_FUNCS[name];
		if (spec && typeof module.cwrap === 'function') {
			try {
				return module.cwrap(name, spec.ret, spec.args);
			} catch (e) {
				return null;
			}
		}
		return null;
	}

	function bindApi(module) {
		var api = {};
		for (var name in OIDN_FUNCS) {
			if (!Object.prototype.hasOwnProperty.call(OIDN_FUNCS, name)) continue;
			api[name] = bindFunction(module, name);
		}
		api.malloc =
			typeof module._malloc === 'function'
				? module._malloc
				: typeof module.malloc === 'function'
					? module.malloc
					: null;
		api.free =
			typeof module._free === 'function'
				? module._free
				: typeof module.free === 'function'
					? module.free
					: null;
		return api;
	}

	function throwOnDeviceError(api, device, where) {
		var code = api.oidnGetDeviceError(device, 0);
		if (code) {
			throw new Error('[pt_lib] OIDN error ' + code + ' at ' + where);
		}
	}

	// Re-read after any malloc: an Emscripten heap view can be replaced on growth.
	function floatView(module) {
		return module.HEAPF32 || (module.asm && module.asm.HEAPF32);
	}

	// Wraps an OIDN Emscripten module (or a factory returning one) in the tiny
	// `denoiser` interface above.
	//
	// options: { hdr? (default true), filterType? ("RT"), deviceType? (CPU),
	//            cleanAux? (false) }
	function oidn(moduleOrFactory, options) {
		options = options || {};
		var source =
			typeof moduleOrFactory === 'function' ? moduleOrFactory() : moduleOrFactory;
		var modulePromise = Promise.resolve(source);
		var state = null; // { api, device, filter, buffers }

		function init(mod) {
			var api = bindApi(mod);
			var missing = [];
			[
				'oidnNewDevice', 'oidnCommitDevice', 'oidnNewFilter',
				'oidnSetSharedFilterImage', 'oidnCommitFilter', 'oidnExecuteFilter',
				'oidnGetDeviceError'
			].forEach(function (name) {
				if (!api[name]) missing.push(name);
			});
			if (!api.malloc || !api.free) missing.push('_malloc/_free');
			if (missing.length) {
				throw new Error(
					'[pt_lib] OIDN module is missing ' + missing.join(', ') +
					'. Export the oidn* C API (see PT_README -> Denoise hook).'
				);
			}

			var device = api.oidnNewDevice(
				typeof options.deviceType === 'number'
					? options.deviceType
					: OIDN_DEVICE_TYPE_CPU
			);
			if (!device) {
				throw new Error('[pt_lib] oidnNewDevice returned null');
			}
			api.oidnCommitDevice(device);
			throwOnDeviceError(api, device, 'oidnNewDevice');

			var filter = api.oidnNewFilter(device, options.filterType || 'RT');
			if (!filter) {
				throw new Error('[pt_lib] oidnNewFilter returned null');
			}
			return {
				module: mod,
				api: api,
				device: device,
				filter: filter,
				buffers: null
			};
		}

		function freeBuffers(s) {
			var b = s.buffers;
			if (!b) return;
			[b.colorPtr, b.albedoPtr, b.normalPtr, b.depthPtr, b.outputPtr].forEach(
				function (ptr) {
					if (ptr) s.api.free(ptr);
				}
			);
			s.buffers = null;
		}

		function ensureBuffers(width, height, wantAlbedo, wantNormal, wantDepth) {
			var s = state;
			var need = width * height;
			if (
				s.buffers &&
				s.buffers.width === width &&
				s.buffers.height === height &&
				(!wantAlbedo || s.buffers.albedoPtr) &&
				(!wantNormal || s.buffers.normalPtr) &&
				(!wantDepth || s.buffers.depthPtr)
			) {
				return s.buffers;
			}
			if (s.buffers) freeBuffers(s);
			var bytesRGBA = need * 4 * 4;
			var bytesOut = need * 3 * 4;
			var b = {
				width: width,
				height: height,
				colorPtr: s.api.malloc(bytesRGBA),
				albedoPtr: wantAlbedo ? s.api.malloc(bytesRGBA) : 0,
				normalPtr: wantNormal ? s.api.malloc(bytesRGBA) : 0,
				depthPtr: wantDepth ? s.api.malloc(bytesRGBA) : 0,
				outputPtr: s.api.malloc(bytesOut)
			};
			if (!b.colorPtr || !b.outputPtr) {
				throw new Error('[pt_lib] OIDN buffer allocation failed');
			}
			s.buffers = b;
			return b;
		}

		return {
			name: 'oidn',
			denoise: function (input) {
				if (!input || !input.color) {
					return Promise.reject(
						new Error('[pt_lib] OIDN needs a color buffer')
					);
				}
				var width = input.width;
				var height = input.height;
				return modulePromise.then(function (mod) {
					if (!state) state = init(mod);
					var s = state;
					var b = ensureBuffers(
						width, height, !!input.albedo, !!input.normal, !!input.depth
					);
					var heap = floatView(mod);
					var hdr = options.hdr !== false;
					var setImage = s.api.oidnSetSharedFilterImage;

					heap.set(input.color, b.colorPtr >>> 2);
					setImage(
						s.filter, 'color', b.colorPtr, OIDN_FORMAT_FLOAT3,
						width, height, 0, 16, width * 16
					);
					if (input.albedo) {
						heap.set(input.albedo, b.albedoPtr >>> 2);
						setImage(
							s.filter, 'albedo', b.albedoPtr, OIDN_FORMAT_FLOAT3,
							width, height, 0, 16, width * 16
						);
					}
					if (input.normal) {
						heap.set(input.normal, b.normalPtr >>> 2);
						setImage(
							s.filter, 'normal', b.normalPtr, OIDN_FORMAT_FLOAT3,
							width, height, 0, 16, width * 16
						);
					}
					if (input.depth) {
						heap.set(input.depth, b.depthPtr >>> 2);
						// One float per pixel: the R channel of the RGBA readback.
						setImage(
							s.filter, 'depth', b.depthPtr, OIDN_FORMAT_FLOAT,
							width, height, 0, 16, width * 16
						);
					}
					setImage(
						s.filter, 'output', b.outputPtr, OIDN_FORMAT_FLOAT3,
						width, height, 0, 12, width * 12
					);

					if (s.api.oidnSetFilter1b) {
						s.api.oidnSetFilter1b(s.filter, 'HDR', hdr ? 1 : 0);
						if (options.cleanAux) {
							s.api.oidnSetFilter1b(s.filter, 'cleanAux', 1);
						}
					} else if (hdr) {
						throw new Error(
							'[pt_lib] OIDN module has no oidnSetFilter1b; cannot set HDR'
						);
					}

					s.api.oidnCommitFilter(s.filter);
					throwOnDeviceError(s.api, s.device, 'oidnCommitFilter');
					s.api.oidnExecuteFilter(s.filter);
					throwOnDeviceError(s.api, s.device, 'oidnExecuteFilter');

					heap = floatView(mod);
					var count = width * height * 3;
					var out = new Float32Array(count);
					out.set(
						heap.subarray(b.outputPtr >>> 2, (b.outputPtr >>> 2) + count)
					);
					return out;
				});
			},
			dispose: function () {
				if (!state) return;
				freeBuffers(state);
				if (state.api.oidnReleaseFilter && state.filter) {
					state.api.oidnReleaseFilter(state.filter);
				}
				if (state.api.oidnReleaseDevice && state.device) {
					state.api.oidnReleaseDevice(state.device);
				}
				state = null;
			}
		};
	}

	// Turns a `denoiser` into a PathTracer denoise hook (the M5 contract).
	//
	// options: { depth? (use the depth AOV), force? (run every frame instead of
	//            waiting for convergence) }
	function hook(denoiser, options) {
		options = options || {};
		if (!denoiser || typeof denoiser.denoise !== 'function') {
			throw new Error('[pt_lib] denoise.hook needs a denoiser with .denoise()');
		}

		var resultTexture = null;
		var resultToken = null;
		var pending = false;
		var failedToken = null;
		var warned = false;

		function readBack(ctx) {
			var pt = ctx.pathTracer;
			if (!pt || typeof pt.readTargetData !== 'function') {
				return Promise.reject(
					new Error('[pt_lib] ctx.pathTracer.readTargetData is required')
				);
			}
			var jobs = [ctx.beauty ? pt.readTargetData(ctx.beauty) : null];
			jobs.push(ctx.albedo ? pt.readTargetData(ctx.albedo) : null);
			jobs.push(ctx.normal ? pt.readTargetData(ctx.normal) : null);
			jobs.push(
				options.depth && ctx.depth ? pt.readTargetData(ctx.depth) : null
			);
			return Promise.all(jobs).then(function (buffers) {
				return {
					color: buffers[0],
					albedo: buffers[1],
					normal: buffers[2],
					depth: buffers[3],
					width: ctx.width,
					height: ctx.height
				};
			});
		}

		function upload(ctx, rgb) {
			var width = ctx.width;
			var height = ctx.height;
			var C = root.BABYLON && root.BABYLON.Constants;
			var rgba = new Float32Array(width * height * 4);
			for (
				var i = 0, src = 0, dst = 0;
				i < width * height;
				i++, src += 3, dst += 4
			) {
				rgba[dst] = rgb[src];
				rgba[dst + 1] = rgb[src + 1];
				rgba[dst + 2] = rgb[src + 2];
				rgba[dst + 3] = 1;
			}
			if (resultTexture && resultTexture.dispose) {
				resultTexture.dispose();
			}
			return new root.BABYLON.RawTexture(
				rgba,
				width,
				height,
				C.TEXTUREFORMAT_RGBA,
				ctx.scene,
				false,
				false,
				C.TEXTURE_NEAREST_SAMPLINGMODE,
				C.TEXTURETYPE_FLOAT
			);
		}

		function warnOnce(error) {
			if (warned) return;
			warned = true;
			console.error('[pt_lib] denoise failed:', error);
		}

		return function denoiseHook(ctx) {
			if (!ctx) return null;
			if (!options.force && !ctx.converged) {
				return null; // one-shot: wait for the accumulation to finish
			}
			var token = ctx.accumulationId;
			if (resultTexture && resultToken === token) {
				return resultTexture; // already denoised this accumulation
			}
			if (failedToken === token) {
				return null; // do not retry the same accumulation
			}
			if (pending) {
				return resultTexture; // keep showing the last adopted texture
			}

			pending = true;
			failedToken = null;
			return readBack(ctx)
				.then(function (input) {
					return denoiser.denoise(input);
				})
				.then(function (rgb) {
					pending = false;
					if (!rgb) return null;
					resultTexture = upload(ctx, rgb);
					resultToken = token;
					return resultTexture;
				})
				.catch(function (error) {
					pending = false;
					failedToken = token;
					warnOnce(error);
					return null;
				});
		};
	}

	function oidnHook(moduleOrFactory, options) {
		var d = oidn(moduleOrFactory, options);
		var h = hook(d, options);
		h.denoiser = d;
		h.dispose = function () {
			if (d.dispose) d.dispose();
		};
		return h;
	}

	denoise.oidn = oidn;
	denoise.hook = hook;
	denoise.oidnHook = oidnHook;
	denoise.constants = {
		OIDN_DEVICE_TYPE_CPU: OIDN_DEVICE_TYPE_CPU,
		OIDN_FORMAT_FLOAT: OIDN_FORMAT_FLOAT,
		OIDN_FORMAT_FLOAT3: OIDN_FORMAT_FLOAT3
	};
})(typeof window !== 'undefined' ? window : globalThis);
