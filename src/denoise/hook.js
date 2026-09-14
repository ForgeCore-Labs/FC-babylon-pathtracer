// pt_lib — denoise: the generic one-shot denoise hook.
//
// The PathTracer denoise contract is `options.denoise(ctx) -> texture |
// Promise<texture>`, run between resolve and tonemap on LINEAR HDR values, with
// `ctx.albedo` / `ctx.normal` / `ctx.depth` available as float render targets.
//
// This file wraps an arbitrary CPU/WASM `denoiser` into such a hook:
//
//   * one-shot: it waits for `ctx.converged`, reads beauty + the auxiliary AOVs
//     back ONCE, runs the filter, and caches the result for that accumulation.
//     No per-frame readback.
//   * identity on failure, and it does not retry the same accumulation.
//
// The `denoiser` interface is deliberately tiny so any backend can be plugged
// in (the bundled GPU a-trous filter in atrous.js is one):
//   denoiser.denoise({ color, albedo, normal, depth, width, height })
//     -> Promise<Float32Array> | Float32Array   // RGB, width*height*3
//   denoiser.dispose?()
//
// Classic-script module: attaches PT_LIB.denoise.hook.

(function (root) {
	'use strict';

	var PT_LIB = (root.PT_LIB = root.PT_LIB || {});
	var denoise = (PT_LIB.denoise = PT_LIB.denoise || {});

	// Turns a `denoiser` into a PathTracer denoise hook.
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

	denoise.hook = hook;
})(typeof window !== 'undefined' ? window : globalThis);
