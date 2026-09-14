// pt_lib — denoise: GPU a-trous (edge-avoiding wavelet) filter.
//
// A *hook*, not a `denoiser`: it is pure GPU, runs per frame while the image
// converges, and does zero readback.
//
//   pt.setDenoise(PT_LIB.denoise.aTrous({ iterations: 3 }));
//
// Each iteration is a 5x5 B3-spline pass whose taps are weighted by
// normal / albedo / depth similarity from the first-hit AOVs, so edges are
// preserved without an edge map. The step doubles per iteration, which is what
// makes a few passes behave like a wide kernel.
//
// Works without AOVs too (the similarity weights are then simply 1), in which
// case it degrades to a plain Gaussian blur — bind a scene whose shader supports
// AOVs (`spec.aovs: true`) for the edge-preserving behaviour.
//
// Classic-script module: adds PT_LIB.denoise.aTrous.

(function (root) {
	'use strict';

	var PT_LIB = (root.PT_LIB = root.PT_LIB || {});
	var denoise = (PT_LIB.denoise = PT_LIB.denoise || {});

	var GLSL = [
		'#version 300 es',
		'precision highp float;',
		'precision highp int;',
		'precision highp sampler2D;',
		'',
		'uniform sampler2D colorTex;',
		'uniform sampler2D normalTex;',
		'uniform sampler2D albedoTex;',
		'uniform sampler2D depthTex;',
		'uniform vec2 uResolution;',
		'uniform float uStep;',
		'uniform float uPhiNormal;',
		'uniform float uPhiAlbedo;',
		'uniform float uPhiDepth;',
		'uniform int uHasNormal;',
		'uniform int uHasAlbedo;',
		'uniform int uHasDepth;',
		'',
		'out vec4 glFragColor;',
		'',
		'// B3-spline (1 4 6 4 1) / 16',
		'const float K[5] = float[5](0.0625, 0.25, 0.375, 0.25, 0.0625);',
		'',
		'vec4 fetchClamped(sampler2D tex, ivec2 p)',
		'{',
		'	ivec2 maxC = ivec2(uResolution) - ivec2(1);',
		'	return texelFetch(tex, clamp(p, ivec2(0), maxC), 0);',
		'}',
		'',
		'void main(void)',
		'{',
		'	ivec2 p = ivec2(gl_FragCoord.xy);',
		'	int step = int(uStep);',
		'',
		'	vec3 c = fetchClamped(colorTex, p).rgb;',
		'	vec3 n = fetchClamped(normalTex, p).rgb;',
		'	vec3 a = fetchClamped(albedoTex, p).rgb;',
		'	float d = fetchClamped(depthTex, p).r;',
		'',
		'	vec3 sum = vec3(0.0);',
		'	float wsum = 0.0;',
		'',
		'	for (int oy = -2; oy <= 2; oy++)',
		'	{',
		'		for (int ox = -2; ox <= 2; ox++)',
		'		{',
		'			ivec2 q = p + ivec2(ox * step, oy * step);',
		'			vec3 co = fetchClamped(colorTex, q).rgb;',
		'			float w = K[ox + 2] * K[oy + 2];',
		'',
		'			if (uHasNormal > 0)',
		'			{',
		'				vec3 no = fetchClamped(normalTex, q).rgb;',
		'				w *= pow(max(dot(n, no), 0.0), uPhiNormal);',
		'			}',
		'			if (uHasAlbedo > 0)',
		'			{',
		'				vec3 ao = fetchClamped(albedoTex, q).rgb;',
		'				w *= pow(max(dot(normalize(a + 1e-4), normalize(ao + 1e-4)), 0.0), uPhiAlbedo);',
		'			}',
		'			if (uHasDepth > 0)',
		'			{',
		'				float dq = fetchClamped(depthTex, q).r;',
		'				float drel = abs(d - dq) / max(d, 1e-3);',
		'				w *= exp(-drel * uPhiDepth);',
		'			}',
		'',
		'			sum += co * w;',
		'			wsum += w;',
		'		}',
		'	}',
		'',
		'	glFragColor = vec4(sum / max(wsum, 1e-5), 1.0);',
		'}'
	].join('\n');

	var passCounter = 0;

	function numberOr(value, fallback) {
		return typeof value === 'number' && isFinite(value) ? value : fallback;
	}

	function createFloatTarget(name, width, height, scene) {
		var C = root.BABYLON.Constants;
		return new root.BABYLON.RenderTargetTexture(
			name,
			{ width: width, height: height },
			scene,
			false,
			false,
			C.TEXTURETYPE_FLOAT,
			false,
			C.TEXTURE_NEAREST_SAMPLINGMODE,
			false,
			false,
			false,
			C.TEXTUREFORMAT_RGBA
		);
	}

	// Returns a denoise hook (see USAGE.md -> "Adding a-trous denoise"). options:
	//   iterations? (1..6, default 3)   step? (first-pass step in pixels, default 1)
	//   phiNormal? (default 128)  phiAlbedo? (32)  phiDepth? (32)
	// All of them stay live-tunable through hook.setParams({...}).
	function aTrous(options) {
		options = options || {};

		function clampIterations(value) {
			return Math.max(1, Math.min(6, Math.round(numberOr(value, 3))));
		}

		// Read on every pass, so setParams() takes effect immediately.
		var params = {
			iterations: clampIterations(options.iterations),
			step: Math.max(1, numberOr(options.step, 1)),
			phiNormal: Math.max(0, numberOr(options.phiNormal, 128)),
			phiAlbedo: Math.max(0, numberOr(options.phiAlbedo, 32)),
			phiDepth: Math.max(0, numberOr(options.phiDepth, 32))
		};

		var engine = null;
		var renderer = null;
		var effect = null;
		var targets = [null, null];
		var width = 0;
		var height = 0;
		var warned = false;
		var cachedToken = null;
		var cachedTexture = null;

		// What onApply reads. Updated before each pass.
		var state = {
			input: null,
			normal: null,
			albedo: null,
			depth: null,
			step: 1
		};

		function disposePipeline() {
			if (effect) {
				effect.dispose();
				effect = null;
			}
			for (var i = 0; i < targets.length; i++) {
				if (targets[i]) {
					targets[i].dispose();
					targets[i] = null;
				}
			}
			renderer = null;
			engine = null;
			width = 0;
			height = 0;
			cachedToken = null;
			cachedTexture = null;
		}

		function ensure(ctx) {
			var scene = ctx.scene;
			var wantW = Math.max(1, Math.round(numberOr(ctx.width, 1)));
			var wantH = Math.max(1, Math.round(numberOr(ctx.height, 1)));

			if (engine && (ctx.engine !== engine || wantW !== width || wantH !== height)) {
				disposePipeline();
			}
			if (engine) {
				return;
			}

			var BABYLON = root.BABYLON;
			engine = ctx.engine;
			width = wantW;
			height = wantH;
			renderer = new BABYLON.EffectRenderer(engine);
			effect = new BABYLON.EffectWrapper({
				engine: engine,
				fragmentShader: GLSL,
				uniformNames: [
					'uResolution', 'uStep', 'uPhiNormal', 'uPhiAlbedo', 'uPhiDepth',
					'uHasNormal', 'uHasAlbedo', 'uHasDepth'
				],
				samplerNames: ['colorTex', 'normalTex', 'albedoTex', 'depthTex'],
				name: 'ptlib_aTrous#' + (++passCounter)
			});
			effect.onApplyObservable.add(function () {
				var e = effect.effect;
				e.setTexture('colorTex', state.input);
				// Bind the input to the AOV samplers when an AOV is absent; the
				// uHas* flags zero its weight.
				e.setTexture('normalTex', state.normal || state.input);
				e.setTexture('albedoTex', state.albedo || state.input);
				e.setTexture('depthTex', state.depth || state.input);
				e.setFloat2('uResolution', width, height);
				e.setFloat('uStep', state.step);
				e.setFloat('uPhiNormal', params.phiNormal);
				e.setFloat('uPhiAlbedo', params.phiAlbedo);
				e.setFloat('uPhiDepth', params.phiDepth);
				e.setInt('uHasNormal', state.normal ? 1 : 0);
				e.setInt('uHasAlbedo', state.albedo ? 1 : 0);
				e.setInt('uHasDepth', state.depth ? 1 : 0);
			});

			var name = 'ptlib_aTrous';
			targets[0] = createFloatTarget(name + '0', width, height, scene);
			targets[1] = createFloatTarget(name + '1', width, height, scene);
		}

		function hook(ctx) {
			if (!ctx || !ctx.beauty || !ctx.engine) {
				return null;
			}
			var token = ctx.accumulationId;
			// Once converged the input stops changing, so one filtered result can
			// be reused until the accumulation restarts.
			if (ctx.converged && cachedTexture && cachedToken === token) {
				return cachedTexture;
			}
			try {
				ensure(ctx);
				state.normal = ctx.normal || null;
				state.albedo = ctx.albedo || null;
				state.depth = ctx.depth || null;

				for (var i = 0; i < params.iterations; i++) {
					state.input = i === 0 ? ctx.beauty : targets[(i - 1) % 2];
					state.step = params.step * Math.pow(2, i);
					renderer.render(effect, targets[i % 2]);
				}

				var result = targets[(params.iterations - 1) % 2];
				if (ctx.converged) {
					cachedToken = token;
					cachedTexture = result;
				}
				return result;
			} catch (error) {
				if (!warned) {
					warned = true;
					console.error('[pt_lib] a-trous denoise failed:', error);
				}
				return null;
			}
		}

		// Live parameter tuning. The pipeline (targets / effect) is reused; only the
		// cached converged result is dropped, since it was filtered differently.
		hook.setParams = function (next) {
			if (!next) return hook;
			if (next.iterations !== undefined) {
				params.iterations = clampIterations(next.iterations);
			}
			if (next.step !== undefined) {
				params.step = Math.max(1, numberOr(next.step, params.step));
			}
			if (next.phiNormal !== undefined) {
				params.phiNormal = Math.max(0, numberOr(next.phiNormal, params.phiNormal));
			}
			if (next.phiAlbedo !== undefined) {
				params.phiAlbedo = Math.max(0, numberOr(next.phiAlbedo, params.phiAlbedo));
			}
			if (next.phiDepth !== undefined) {
				params.phiDepth = Math.max(0, numberOr(next.phiDepth, params.phiDepth));
			}
			cachedToken = null;
			cachedTexture = null;
			return hook;
		};
		hook.params = params;
		hook.dispose = disposePipeline;
		return hook;
	}

	denoise.aTrous = aTrous;
})(typeof window !== 'undefined' ? window : globalThis);
