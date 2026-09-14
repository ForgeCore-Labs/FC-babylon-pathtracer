// pt_lib — PathTracer: a progressive GPU path tracer as a Babylon.js plugin.
//
// The class owns the generic half of the renderer:
//   * the render targets and the three full-screen passes
//   * progressive sample accumulation and convergence
//   * the render loop and lifecycle (start/stop/reset/dispose)
//   * observables for progress / convergence / errors
//
// The scene-specific half (the path tracing shader and its uniforms, textures
// and per-frame values) is supplied by a small adapter through setShader().
//
// Pass order per frame:
//   1. scene.render()                                  — update world state
//   2. pathTracing   -> pathTracingRT                   — one more sample (HDR sum)
//   3. screenCopy    -> screenCopyRT                    — snapshot (next frame's previousBuffer)
//   4. screenResolve -> resolveRT                       — spatial filter + divide by samples (linear HDR)
//   5. [AOV pass]     -> albedo / normal / depth RTs     — first hit only, on reset frames (optional)
//   6. [denoise hook] -> beauty texture                 — identity / GPU a-trous / one-shot WASM
//   7. screenOutput  -> null (canvas)                   — exposure / tonemap / gamma
//
// Classic-script module: attaches PT_LIB.PathTracer and BABYLON.PathTracer.

(function (root) {
	'use strict';

	var PT_LIB = (root.PT_LIB = root.PT_LIB || {});

	var DEFAULTS = {
		resolutionScale: 1.0, // 0 < scale <= 1
		maxSamples: 0, // 0 = converge indefinitely
		maxBounces: 5, // passed through for the shader adapter to use
		toneMappingExposure: 1.0,
		sceneIsDynamic: false,
		// Extra full-screen passes applied AFTER the tonemap, in order. Each entry is
		// either a spec — { name, fragmentShader, uniforms, samplers,
		// uniformNames?, samplerNames?, inputName? } — or a prebuilt
		// BABYLON.EffectWrapper given as { effect, inputName? }. The first pass
		// receives the tonemapped image and the last writes to `outputTarget`
		// (or the canvas). See PathTracer.addPostProcess().
		postProcesses: null,
		// Where the final image is written: null = the canvas, or a render target
		// (e.g. a BABYLON.RenderTargetTexture) for callers that present it
		// themselves. The non-linear output never feeds back into the HDR pass.
		outputTarget: null,
		// Warn at start() when the engine cannot support the tracer (see
		// PathTracer.isSupported). Set false to silence it.
		warnOnUnsupported: true,
		autoDetectCameraMove: true,
		warnUnboundUniforms: true,
		// progressive filter decay: the box blur must fade out as samples
		// accumulate, otherwise the image stays permanently soft.
		edgeSharpenSpeed: 0.05,
		filterDecaySpeed: 0.0002,
		// Optional denoise hook, run between resolve and tonemap on LINEAR HDR:
		//   function (ctx) -> texture | Promise<texture>
		// with ctx = { engine, scene, pathTracer, beauty, albedo, normal, depth,
		//              samples, converged, width, height }.
		// A returned texture filters this frame (GPU a-trous, no readback). A
		// A returned promise is adopted when it resolves — the one-shot readback
		// case. null = identity, no extra work.
		denoise: null,
		// Emit first-hit AOVs (albedo / normal / depth) as float render targets for
		// the denoise hook (implied by a hook) or for export. Costs a primary-ray
		// pass per AOV, re-run only when the first hit changes.
		aovs: false,
		// Firefly / outlier clamp: linear luminance ceiling for a single sample, so
		// one high-variance specular hit cannot punch a bright pixel into the
		// accumulation. 0 = off (the reference look).
		fireflyClamp: 0,
		// 0 = non-deterministic (Math.random). > 0 = reproducible sampling: the same
		// seed, camera and sample count produce the same image.
		seed: 0,
		// Far plane used only to normalize the depth AOV when exporting it to PNG.
		aovDepthFar: 50,
		onFrame: null // function (pathTracer, frame)
	};

	function assign(target, source) {
		for (var key in source) {
			if (Object.prototype.hasOwnProperty.call(source, key)) {
				target[key] = source[key];
			}
		}
		return target;
	}

	function value(arg, pathTracer, frame) {
		return typeof arg === 'function' ? arg(pathTracer, frame) : arg;
	}

	function nowMs() {
		return typeof performance !== 'undefined' && performance.now
			? performance.now()
			: Date.now();
	}

	// Small deterministic PRNG (mulberry32), used when options.seed > 0 so a run can
	// be replayed sample-for-sample.
	function mulberry32(seed) {
		var a = seed | 0;
		return function () {
			a = (a + 0x6d2b79f5) | 0;
			var t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	// Blit used only by exportImage() for the non-beauty AOVs: turns a float AOV
	// target into the display-referred bytes a PNG holds.
	var CAPTURE_GLSL = [
		'#version 300 es',
		'precision highp float;',
		'precision highp sampler2D;',
		'uniform sampler2D src;',
		'uniform int uMode;', // 1 albedo, 2 normal, 3 depth
		'uniform float uDepthFar;',
		'out vec4 glFragColor;',
		'void main(void)',
		'{',
		'\tvec4 c = texelFetch(src, ivec2(gl_FragCoord.xy), 0);',
		'\tif (uMode == 1) { glFragColor = vec4(pow(clamp(c.rgb, 0.0, 1.0), vec3(0.4545)), 1.0); }',
		'\telse if (uMode == 2) { glFragColor = vec4(c.rgb * 0.5 + 0.5, 1.0); }',
		'\telse if (uMode == 3) { glFragColor = vec4(vec3(1.0 - clamp(c.r / uDepthFar, 0.0, 1.0)), 1.0); }',
		'\telse { glFragColor = vec4(c.rgb, 1.0); }',
		'}'
	].join('\n');

	// readPixels is bottom-up; PNG/canvas rows are top-down.
	function pixelsToDataURL(pixels, width, height) {
		var canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		var context = canvas.getContext('2d');
		var image = context.createImageData(width, height);
		var source =
			pixels instanceof Uint8Array
				? pixels
				: new Uint8Array(pixels.buffer || pixels);
		var rowBytes = width * 4;
		for (var y = 0; y < height; y++) {
			var srcRow = (height - 1 - y) * rowBytes;
			var dstRow = y * rowBytes;
			for (var x = 0; x < rowBytes; x++) {
				image.data[dstRow + x] = source[srcRow + x];
			}
		}
		context.putImageData(image, 0, 0);
		return canvas.toDataURL('image/png');
	}

	function downloadDataURL(dataURL, filename) {
		var link = document.createElement('a');
		link.href = dataURL;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
	}

	function isNumericArray(v) {
		return (
			v &&
			typeof v === 'object' &&
			typeof v.length === 'number' &&
			!(typeof v.x === 'number' && typeof v.y === 'number')
		);
	}

	// Binds one uniform using the GLSL type discovered by parseUniforms().
	// Returns false for types it does not handle, so the caller can warn.
	function bindTyped(effect, name, type, val) {
		switch (type) {
			case 'float':
				effect.setFloat(name, val);
				return true;
			case 'int':
			case 'uint':
				effect.setInt(name, val | 0);
				return true;
			case 'bool':
				effect.setBool(name, !!val);
				return true;
			case 'mat4':
				effect.setMatrix(name, val);
				return true;
			case 'vec2':
				if (val && typeof val.x === 'number') {
					effect.setVector2(name, val);
					return true;
				}
				if (isNumericArray(val)) {
					effect.setFloat2(name, val[0], val[1]);
					return true;
				}
				return false;
			case 'vec3':
				if (val && typeof val.x === 'number') {
					effect.setVector3(name, val);
					return true;
				}
				if (isNumericArray(val)) {
					effect.setFloat3(name, val[0], val[1], val[2]);
					return true;
				}
				return false;
			case 'vec4':
				if (val && typeof val.x === 'number' && typeof val.w === 'number') {
					effect.setFloat4(name, val.x, val.y, val.z, val.w);
					return true;
				}
				if (val && typeof val.r === 'number') {
					effect.setFloat4(
						name,
						val.r,
						val.g,
						val.b,
						val.a === undefined ? 1 : val.a
					);
					return true;
				}
				if (isNumericArray(val)) {
					effect.setFloat4(name, val[0], val[1], val[2], val[3]);
					return true;
				}
				return false;
			default:
				return false;
		}
	}

	// Normalizes one entry of options.postProcesses into the shape the chain
	// builder expects. Returns null for an unusable entry (skipped, not fatal).
	function normalizePostSpec(spec, index) {
		if (!spec) {
			return null;
		}
		var name = spec.name || "postProcess" + index;
		var inputName = spec.inputName || "textureSampler";
		if (spec.effect) {
			return { name: name, effect: spec.effect, inputName: inputName };
		}
		if (!spec.fragmentShader) {
			return null;
		}
		return {
			name: name,
			fragmentShader: spec.fragmentShader,
			uniformNames: spec.uniformNames || null,
			samplerNames: spec.samplerNames || null,
			uniforms: spec.uniforms || null,
			samplers: spec.samplers || null,
			inputName: inputName
		};
	}

	// ---------------------------------------------------------------- class

	function PathTracer(name, scene, options) {
		if (!scene) {
			throw new Error('[pt_lib] PathTracer requires a BABYLON.Scene');
		}
		if (typeof BABYLON === 'undefined') {
			throw new Error('[pt_lib] BABYLON must be loaded before PathTracer');
		}

		this.name = name || 'pathTracer';
		this.scene = scene;
		this.engine = scene.getEngine();
		this.options = assign(assign({}, DEFAULTS), options || {});

		this.samples = 0;
		this.frameCounter = 1;
		this.previousSampleCount = 0;
		this.isRunning = false;
		this.isConverged = false;

		this.onProgressObservable = new BABYLON.Observable();
		this.onConvergedObservable = new BABYLON.Observable();
		this.onErrorObservable = new BABYLON.Observable();

		this._renderer = new BABYLON.EffectRenderer(this.engine);
		this._pathRT = null;
		this._copyRT = null;
		this._resolveRT = null;
		this._postRTs = []; // ping-pong targets for the user post-process chain
		this._postEffects = []; // chain order; one entry per built pass
		this._postOwned = []; // only the effects built here are disposed
		this._pathEffect = null;
		this._copyEffect = null;
		this._resolveEffect = null;
		this._outputEffect = null;
		// resolve -> tonemap hand-off, plus the denoise hook's current output
		this._beautyTexture = null;
		this._denoiseResult = null;
		this._denoisePending = false;
		this._denoiseWarned = false;
		// First-hit AOVs (M5): allocated only when a hook / options.aovs asks.
		this._aovEnabled = false;
		this._aovEffect = null;
		this._aovUniformInfo = null;
		this._aovUniformTypes = null;
		this._aovChannel = 0;
		this._aovDirty = true;
		this._aovWarned = false;
		this._aovAlbedo = null;
		this._aovNormal = null;
		this._aovDepth = null;
		this._aovTargets = null;
		this._passCounter = 0;
		this._captureRT = null;
		this._captureEffect = null;
		// Bumped whenever a new accumulation starts; the denoise hook uses it to
		// run once per accumulation instead of once per sample.
		this._accumulationId = 0;

		this._shaderSpec = null;
		this._composedGLSL = null;
		this._shaderSignature = null;
		this._uniformTypes = Object.create(null);
		this._uniformInfo = null;
		this._bufferNames = null;
		this._unboundWarned = Object.create(null);

		this._cameraIsMoving = false;
		this._cameraRecentlyMoving = false;
		this._prevCameraMatrix = null;
		this._timeSeconds = 0;
		this._randomVec2 = { x: 0.5, y: 0.5 };

		this._running = false;
		this._disposed = false;
		this._resizeObserver = null;

		var self = this;
		this._renderHandler = function () {
			self.renderFrame();
		};
	}

	PathTracer.prototype._renderWidth = function () {
		return Math.max(
			1,
			Math.floor(this.engine.getRenderWidth() * this.options.resolutionScale)
		);
	};

	PathTracer.prototype._renderHeight = function () {
		return Math.max(
			1,
			Math.floor(this.engine.getRenderHeight() * this.options.resolutionScale)
		);
	};

	// ----------------------------------------------------------- shader setup

	// spec = {
	//   source,                       // raw GLSL containing #include<...>
	//   defines?,                     // { FEATURE: 1 }
	//   uniforms?,                    // { name: value | (pt, frame) => value }
	//   samplers?,                    // { name: texture | (pt, frame) => texture }
	//   screenCopy?,                  // override post-process GLSL (optional)
	//   screenResolve?,               // override post-process GLSL (optional)
	//   screenOutput?                 // override post-process GLSL (optional)
	// }
	PathTracer.prototype.setShader = function (spec) {
		if (!spec || typeof spec.source !== 'string') {
			throw new Error('[pt_lib] setShader requires { source: "<glsl>" }');
		}

		this._shaderSpec = {
			source: spec.source,
			prelude: spec.prelude || null,
			// the scene opts in explicitly to first-hit AOV support
			aovs: spec.aovs === true,
			defines: spec.defines || null,
			uniforms: spec.uniforms || {},
			samplers: spec.samplers || {},
			screenCopy: spec.screenCopy || null,
			screenResolve: spec.screenResolve || null,
			screenOutput: spec.screenOutput || null
		};

		var composed = PT_LIB.composeShader(spec.source, {
			defines: spec.defines,
			prelude: spec.prelude
		});
		var info = PT_LIB.parseUniforms(composed.glsl);

		this._uniformInfo = info;
		this._uniformTypes = Object.create(null);
		for (var i = 0; i < info.all.length; i++) {
			this._uniformTypes[info.all[i].name] = info.all[i].type;
		}

		this._composedGLSL = composed.glsl;
		this._resolvedIncludes = composed.resolvedIncludes;

		// A re-ingest that did not change the shader (a visibility / transform sync,
		// for example) can keep the compiled effects and render targets. Rebuilding
		// would dispose effects that Babylon may still be compiling and recompile
		// identical programs.
		var signature =
			composed.glsl +
			"\u0000" + (this._shaderSpec.screenCopy || "") +
			"\u0000" + (this._shaderSpec.screenResolve || "") +
			"\u0000" + (this._shaderSpec.screenOutput || "") +
			"\u0000" + (this._shaderSpec.aovs ? "1" : "0");
		if (this._pathEffect && signature === this._shaderSignature) {
			return this;
		}
		this._shaderSignature = signature;

		this._disposePasses(); // safe to re-shader: drop any previous passes
		this._createTargets();
		this._createEffects();
		return this;
	};

	PathTracer.prototype._postShader = function (key, override) {
		if (override) {
			return override;
		}
		if (PT_LIB.glsl && PT_LIB.glsl.shaders) {
			return PT_LIB.glsl.shaders[key];
		}
		return null;
	};

	PathTracer.prototype._disposePasses = function () {
		if (this._pathEffect) { this._pathEffect.dispose(); this._pathEffect = null; }
		if (this._copyEffect) { this._copyEffect.dispose(); this._copyEffect = null; }
		if (this._resolveEffect) { this._resolveEffect.dispose(); this._resolveEffect = null; }
		if (this._outputEffect) { this._outputEffect.dispose(); this._outputEffect = null; }
		if (this._pathRT) { this._pathRT.dispose(); this._pathRT = null; }
		if (this._copyRT) { this._copyRT.dispose(); this._copyRT = null; }
		if (this._resolveRT) { this._resolveRT.dispose(); this._resolveRT = null; }
		this._disposeAovs();
		if (this._captureEffect) { this._captureEffect.dispose(); this._captureEffect = null; }
		if (this._captureRT) { this._captureRT.dispose(); this._captureRT = null; }
		this._beautyTexture = null;
		this._denoiseResult = null;
		this._denoisePending = false;
		this._disposePostPasses();
	};

	// Post-process chain teardown. Effects the caller built and handed to us are
	// dropped but never disposed — they own them.
	PathTracer.prototype._disposePostPasses = function () {
		var i;
		for (i = 0; i < this._postOwned.length; i++) {
			if (this._postOwned[i]) { this._postOwned[i].dispose(); }
		}
		for (i = 0; i < this._postRTs.length; i++) {
			if (this._postRTs[i]) { this._postRTs[i].dispose(); }
		}
		this._postOwned = [];
		this._postEffects = [];
		this._postRTs = [];
	};

	PathTracer.prototype._makeFloatRT = function (name, width, height) {
		var C = BABYLON.Constants;
		return new BABYLON.RenderTargetTexture(
			name,
			{ width: width, height: height },
			this.scene,
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
	};

	// Every pass effect gets a fresh name. Babylon caches compiled base shaders by
	// effect name, so reusing a name after disposing (a re-ingest rebuilds every
	// pass) can hand back a program whose shader was already deleted.
	PathTracer.prototype._nextPassName = function (base) {
		this._passCounter = (this._passCounter || 0) + 1;
		return base + "#" + this._passCounter;
	};

	// ------------------------------------------------------------------ AOVs
	// First-hit AOVs are implied by a denoise hook; options.aovs forces them on.
	PathTracer.prototype._aovWanted = function () {
		return !!(this.options.aovs || typeof this.options.denoise === 'function');
	};

	PathTracer.prototype._disposeAovs = function () {
		if (this._aovEffect) { this._aovEffect.dispose(); this._aovEffect = null; }
		if (this._aovAlbedo) { this._aovAlbedo.dispose(); this._aovAlbedo = null; }
		if (this._aovNormal) { this._aovNormal.dispose(); this._aovNormal = null; }
		if (this._aovDepth) { this._aovDepth.dispose(); this._aovDepth = null; }
		this._aovTargets = null;
		this._aovUniformInfo = null;
		this._aovUniformTypes = null;
		this._aovEnabled = false;
	};

	PathTracer.prototype._createAovTargets = function () {
		var wants = this._aovWanted();
		this._aovEnabled =
			wants &&
			this._shaderSpec.aovs === true &&
			typeof this._composedGLSL === 'string' &&
			this._composedGLSL.indexOf('ptCameraRay') !== -1;
		if (wants && !this._aovEnabled && !this._aovWarned) {
			this._aovWarned = true;
			console.warn(
				'[pt_lib] AOVs were requested but this scene cannot provide them; continuing without them.'
			);
		}
		this._aovDirty = true;
		if (!this._aovEnabled) {
			return;
		}
		var width = this._renderWidth();
		var height = this._renderHeight();
		this._aovAlbedo = this._makeFloatRT(this.name + "_aovAlbedoRT", width, height);
		this._aovNormal = this._makeFloatRT(this.name + "_aovNormalRT", width, height);
		this._aovDepth = this._makeFloatRT(this.name + "_aovDepthRT", width, height);
		this._aovTargets = [this._aovAlbedo, this._aovNormal, this._aovDepth];
	};

	// Builds the AOV effect from the scene source with PT_AOV_PASS (the AOV entry)
	// and PT_AOV_ONLY (CalculateRadiance returns after the first hit). Requires
	// _createAovTargets to have run.
	PathTracer.prototype._createAovEffect = function () {
		if (this._aovEffect) { this._aovEffect.dispose(); this._aovEffect = null; }
		this._aovUniformInfo = null;
		this._aovUniformTypes = null;
		if (!this._aovEnabled) {
			return;
		}
		var self = this;
		var aovDefines = assign(assign({}, this._shaderSpec.defines || {}), {
			PT_AOV_PASS: 1,
			PT_AOV_ONLY: 1
		});
		var aovComposed = PT_LIB.composeShader(this._shaderSpec.source, {
			defines: aovDefines,
			prelude: this._shaderSpec.prelude
		});
		var aovInfo = PT_LIB.parseUniforms(aovComposed.glsl);
		this._aovUniformInfo = aovInfo;
		this._aovUniformTypes = Object.create(null);
		for (var ai = 0; ai < aovInfo.all.length; ai++) {
			this._aovUniformTypes[aovInfo.all[ai].name] = aovInfo.all[ai].type;
		}
		this._aovEffect = new BABYLON.EffectWrapper({
			engine: this.engine,
			fragmentShader: aovComposed.glsl,
			uniformNames: aovInfo.uniforms.slice(),
			samplerNames: aovInfo.samplers.slice(),
			name: this._nextPassName(this.name + "_aov")
		});
		this._aovEffect.onApplyObservable.add(function () {
			self._applyPathBindings(
				self._aovEffect.effect,
				self._aovUniformInfo,
				self._aovUniformTypes
			);
		});
	};

	PathTracer.prototype._createTargets = function () {
		var width = this._renderWidth();
		var height = this._renderHeight();
		var C = BABYLON.Constants;

		this._pathRT = new BABYLON.RenderTargetTexture(
			this.name + "_pathTracingRT",
			{ width: width, height: height },
			this.scene,
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

		this._copyRT = new BABYLON.RenderTargetTexture(
			this.name + "_screenCopyRT",
			{ width: width, height: height },
			this.scene,
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

		// Linear HDR beauty between the resolve and tonemap passes; the denoise
		// hook (when set) reads this and produces the texture the tonemap reads.
		this._resolveRT = new BABYLON.RenderTargetTexture(
			this.name + "_resolveRT",
			{ width: width, height: height },
			this.scene,
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

		// First-hit AOVs: only when the caller asked (a denoise hook implies it)
		// AND the scene opts in AND its shader has the AOV entry.
		this._disposeAovs();
		this._createAovTargets();
	};

	// --------------------------------------------------------- post-process chain
	// Optional user passes applied after the tonemap. The chain ping-pongs through
	// two targets; the last pass writes to options.outputTarget (or the canvas).

	PathTracer.prototype._postSourceTexture = function (index) {
		return this._postRTs[index % 2];
	};

	PathTracer.prototype._ensurePostTargets = function () {
		if (this._postRTs.length) {
			return this._postRTs;
		}
		var self = this;
		var C = BABYLON.Constants;
		var width = this._renderWidth();
		var height = this._renderHeight();
		var create = function (index) {
			return new BABYLON.RenderTargetTexture(
				self.name + "_postRT" + index,
				{ width: width, height: height },
				self.scene,
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
		};
		this._postRTs = [create(0), create(1)];
		return this._postRTs;
	};

	// Builds one pass. A prebuilt EffectWrapper only gets its input bound; a spec
	// gets its uniforms/samplers discovered from the GLSL and bound on apply.
	PathTracer.prototype._buildPostEffect = function (spec, index) {
		var self = this;

		if (spec.effect) {
			var userEffect = spec.effect;
			userEffect.onApplyObservable.add(function () {
				userEffect.effect.setTexture(
					spec.inputName,
					self._postSourceTexture(index)
				);
			});
			return { wrapper: userEffect, owned: false };
		}

		var glsl = spec.fragmentShader;
		var info = PT_LIB.parseUniforms ? PT_LIB.parseUniforms(glsl) : null;
		var uniformNames = spec.uniformNames || (info ? info.uniforms.slice() : []);
		var samplerNames = spec.samplerNames || (info ? info.samplers.slice() : []);

		var types = Object.create(null);
		if (info) {
			for (var a = 0; a < info.all.length; a++) {
				types[info.all[a].name] = info.all[a].type;
			}
		}

		var wrapper = new BABYLON.EffectWrapper({
			engine: this.engine,
			fragmentShader: glsl,
			uniformNames: uniformNames,
			samplerNames: samplerNames,
			name: this.name + "_" + spec.name
		});

		wrapper.onApplyObservable.add(function () {
			var e = wrapper.effect;
			e.setTexture(spec.inputName, self._postSourceTexture(index));

			var n;
			if (spec.uniforms) {
				for (n in spec.uniforms) {
					if (!Object.prototype.hasOwnProperty.call(spec.uniforms, n)) { continue; }
					var v = spec.uniforms[n];
					if (typeof v === "function") { v = v(self, self._frame); }
					bindTyped(e, n, types[n] || "float", v);
				}
			}
			if (spec.samplers) {
				for (n in spec.samplers) {
					if (!Object.prototype.hasOwnProperty.call(spec.samplers, n)) { continue; }
					var tex = spec.samplers[n];
					if (typeof tex === "function") { tex = tex(self, self._frame); }
					e.setTexture(n, tex);
				}
			}
		});

		return { wrapper: wrapper, owned: true };
	};

	PathTracer.prototype._createPostEffects = function () {
		this._disposePostPasses();

		var specs = this.options.postProcesses;
		if (!specs || !specs.length) {
			return;
		}

		this._ensurePostTargets();

		for (var i = 0; i < specs.length; i++) {
			var spec = normalizePostSpec(specs[i], i);
			if (!spec) { continue; }
			var built = this._buildPostEffect(spec, this._postEffects.length);
			this._postEffects.push(built.wrapper);
			if (built.owned) { this._postOwned.push(built.wrapper); }
		}
	};

	// Presents the tonemapped image: straight to the target, or through the user
	// post-process chain when one is configured.
	PathTracer.prototype._renderOutput = function () {
		var target = this.options.outputTarget || null;

		// 1. resolve the accumulated HDR buffer into linear beauty
		this._renderer.render(this._resolveEffect, this._resolveRT);

		// 2. denoise hook (identity when none is configured)
		this._beautyTexture = this._applyDenoise();

		// 3. exposure / tonemap / gamma, then the optional user post chain
		if (!this._postEffects.length) {
			this._renderer.render(this._outputEffect, target);
			return;
		}

		this._renderer.render(this._outputEffect, this._postRTs[0]);
		for (var i = 0; i < this._postEffects.length; i++) {
			var last = i === this._postEffects.length - 1;
			this._renderer.render(
				this._postEffects[i],
				last ? target : this._postRTs[(i + 1) % 2]
			);
		}
	};

	// Runs options.denoise between resolve and tonemap. Returns the texture the
	// tonemap pass reads: the resolved beauty, a hook-provided texture, or the
	// last adopted async result while a new one is still pending.
	PathTracer.prototype._applyDenoise = function () {
		var beauty = this._resolveRT;
		if (typeof this.options.denoise !== 'function') {
			return beauty;
		}
		// An async hook is already running (one-shot readback / WASM); do not call
		// it again until it settles.
		if (this._denoisePending) {
			return this._denoiseResult || beauty;
		}

		var ctx = {
			engine: this.engine,
			scene: this.scene,
			pathTracer: this,
			beauty: beauty,
			albedo: this._aovAlbedo || null,
			normal: this._aovNormal || null,
			depth: this._aovDepth || null,
			samples: this.samples,
			converged: !!this.isConverged,
			accumulationId: this._accumulationId,
			width: this._renderWidth(),
			height: this._renderHeight()
		};

		var result;
		try {
			result = this.options.denoise(ctx);
		} catch (e) {
			if (!this._denoiseWarned) {
				this._denoiseWarned = true;
				console.warn('[pt_lib] denoise hook threw: ' + (e && e.message ? e.message : e));
			}
			return beauty;
		}

		// Async hook (e.g. the one-shot readback): adopt when it resolves,
		// keep showing the last result (or the raw resolve) meanwhile.
		if (result && typeof result.then === 'function') {
			var self = this;
			if (!this._denoisePending) {
				this._denoisePending = true;
				result.then(
					function (tex) {
						self._denoiseResult = tex || null;
						self._denoisePending = false;
					},
					function (e) {
						self._denoisePending = false;
						if (!self._denoiseWarned) {
							self._denoiseWarned = true;
							console.warn(
								'[pt_lib] denoise hook rejected: ' +
									(e && e.message ? e.message : e)
							);
						}
					}
				);
			}
			return this._denoiseResult || beauty;
		}

		this._denoiseResult = result || null;
		return this._denoiseResult || beauty;
	};

	// Renders the three first-hit AOV targets. They only change when the first
	// hit changes (accumulation reset, camera move), which the dirty flag tracks,
	// so this normally costs one primary-ray pass per AOV on a reset frame.
	PathTracer.prototype._renderAovs = function () {
		if (!this._aovEnabled || !this._aovEffect || !this._aovTargets) {
			this._aovDirty = false;
			return;
		}
		for (var ch = 0; ch < this._aovTargets.length; ch++) {
			this._aovChannel = ch;
			this._renderer.render(this._aovEffect, this._aovTargets[ch]);
		}
		this._aovDirty = false;
	};

	// ------------------------------------------------------------- PNG export
	// Byte target + blit used only while exporting.
	PathTracer.prototype._ensureCapture = function () {
		if (this._captureRT && this._captureEffect) {
			return;
		}
		var C = BABYLON.Constants;
		var width = this._renderWidth();
		var height = this._renderHeight();
		this._captureRT = new BABYLON.RenderTargetTexture(
			this.name + "_captureRT",
			{ width: width, height: height },
			this.scene,
			false,
			false,
			C.TEXTURETYPE_UNSIGNED_BYTE,
			false,
			C.TEXTURE_NEAREST_SAMPLINGMODE,
			false,
			false,
			false,
			C.TEXTUREFORMAT_RGBA
		);
		this._captureEffect = new BABYLON.EffectWrapper({
			engine: this.engine,
			fragmentShader: CAPTURE_GLSL,
			uniformNames: ["uMode", "uDepthFar"],
			samplerNames: ["src"],
			name: this._nextPassName(this.name + "_capture")
		});
	};

	PathTracer.prototype._renderCapture = function (job) {
		if (job.mode === 0) {
			// The tonemapped beauty, exactly what the canvas shows (before any user
			// post-process chain).
			this._renderer.render(this._outputEffect, this._captureRT);
			return;
		}
		var e = this._captureEffect.effect;
		e.setTexture("src", job.source);
		e.setInt("uMode", job.mode);
		e.setFloat(
			"uDepthFar",
			this.options.aovDepthFar > 0 ? this.options.aovDepthFar : 50
		);
		this._renderer.render(this._captureEffect, this._captureRT);
	};

	PathTracer.prototype._readCapture = function () {
		var size = this._captureRT.getSize();
		return this._captureRT.readPixels().then(function (pixels) {
			return pixelsToDataURL(pixels, size.width, size.height);
		});
	};

	// Reads a FLOAT render target into a Float32Array (RGBA, GL row order). The
	// denoise hook uses this to hand beauty + AOVs to a CPU denoiser.
	PathTracer.prototype.readTargetData = function (target) {
		if (!target || typeof target.readPixels !== 'function') {
			return Promise.reject(
				new Error('[pt_lib] readTargetData needs a render target')
			);
		}
		return Promise.resolve(target.readPixels()).then(function (pixels) {
			if (!pixels) {
				throw new Error('[pt_lib] readTargetData: no pixels returned');
			}
			if (pixels instanceof Float32Array) {
				return pixels;
			}
			// A byte readback would quantize HDR beauty, so surface it rather than
			// silently degrading the denoiser input.
			throw new Error(
				'[pt_lib] readTargetData: expected float pixels, got ' +
					(pixels.constructor && pixels.constructor.name) +
					' (float readback unavailable)'
			);
		});
	};

	// Renders the current image to a PNG data URL: { beauty } always, plus
	// { albedo, normal, depth } when options.aovs is set and AOVs are enabled.
	// options: { aovs?, download?, filename? }. Browser-only (needs a canvas).
	PathTracer.prototype.exportImage = function (options) {
		var self = this;
		options = options || {};
		if (typeof document === 'undefined') {
			return Promise.reject(
				new Error('[pt_lib] exportImage needs a DOM (browser only)')
			);
		}
		if (!this._outputEffect || !this._pathRT) {
			return Promise.reject(
				new Error('[pt_lib] call setShader() before exportImage()')
			);
		}
		this._ensureCapture();
		if (!this._frame) {
			this._frame = {
				deltaTime: 0,
				timeSeconds: this._timeSeconds,
				cameraMoved: false,
				jsMs: 0
			};
		}

		var jobs = [{ name: "beauty", mode: 0 }];
		if (options.aovs === true && this._aovEnabled && this._aovTargets) {
			// Refresh so the AOVs match the current camera / accumulation.
			this._aovDirty = true;
			this._renderAovs();
			jobs.push({ name: "albedo", mode: 1, source: this._aovAlbedo });
			jobs.push({ name: "normal", mode: 2, source: this._aovNormal });
			jobs.push({ name: "depth", mode: 3, source: this._aovDepth });
		}

		var results = {};
		var chain = Promise.resolve();
		jobs.forEach(function (job) {
			chain = chain
				.then(function () {
					self._renderCapture(job);
					return self._readCapture();
				})
				.then(function (dataURL) {
					results[job.name] = dataURL;
					if (options.download) {
						downloadDataURL(
							dataURL,
							(options.filename || "pathtrace") + "_" + job.name + ".png"
						);
					}
				});
		});
		return chain.then(function () {
			return results;
		});
	};

	// Appends a pass to the chain and rebuilds it. Returns `this`.
	PathTracer.prototype.addPostProcess = function (spec) {
		if (!this.options.postProcesses) {
			this.options.postProcesses = [];
		}
		this.options.postProcesses.push(spec);
		this._createPostEffects();
		return this;
	};

	PathTracer.prototype.removePostProcess = function (spec) {
		var list = this.options.postProcesses;
		if (list) {
			var index = list.indexOf(spec);
			if (index >= 0) { list.splice(index, 1); }
		}
		this._createPostEffects();
		return this;
	};

	PathTracer.prototype.clearPostProcesses = function () {
		this.options.postProcesses = null;
		this._createPostEffects();
		return this;
	};

	PathTracer.prototype._createEffects = function () {
		var self = this;

		this._pathEffect = new BABYLON.EffectWrapper({
			engine: this.engine,
			fragmentShader: this._composedGLSL,
			uniformNames: this._uniformInfo.uniforms.slice(),
			samplerNames: this._uniformInfo.samplers.slice(),
			name: this._nextPassName(this.name + "_pathTracing")
		});
		this._pathEffect.onApplyObservable.add(function () {
			self._applyPathBindings();
		});

		var copyGLSL = this._postShader(
			"screenCopyFragmentShader",
			this._shaderSpec.screenCopy
		);
		if (!copyGLSL) {
			throw new Error(
				"[pt_lib] Missing shared shader 'screenCopyFragmentShader'. Is pt_lib.core.js loaded?"
			);
		}
		this._copyEffect = new BABYLON.EffectWrapper({
			engine: this.engine,
			fragmentShader: copyGLSL,
			uniformNames: [],
			samplerNames: ["pathTracedImageBuffer"],
			name: this._nextPassName(this.name + "_screenCopy")
		});
		this._copyEffect.onApplyObservable.add(function () {
			self._copyEffect.effect.setTexture(
				"pathTracedImageBuffer",
				self._pathRT
			);
		});

		// Resolve: accumulation buffer -> linear HDR beauty (spatial filter +
		// divide by the sample count). Kept separate from the tonemap so the
		// denoise hook in between works on linear values.
		var resolveGLSL = this._postShader(
			"screenResolveFragmentShader",
			this._shaderSpec.screenResolve
		);
		if (!resolveGLSL) {
			throw new Error(
				"[pt_lib] Missing shared shader 'screenResolveFragmentShader'. Is pt_lib.core.js loaded?"
			);
		}
		this._resolveEffect = new BABYLON.EffectWrapper({
			engine: this.engine,
			fragmentShader: resolveGLSL,
			uniformNames: [
				"uSampleCounter",
				"uOneOverSampleCounter",
				"uPixelEdgeSharpness",
				"uEdgeSharpenSpeed",
				"uFilterDecaySpeed",
				"uSceneIsDynamic"
			],
			samplerNames: ["accumulationBuffer"],
			name: this._nextPassName(this.name + "_screenResolve")
		});
		this._resolveEffect.onApplyObservable.add(function () {
			var e = self._resolveEffect.effect;
			e.setTexture("accumulationBuffer", self._pathRT);
			e.setFloat("uSampleCounter", self.samples);
			e.setFloat(
				"uOneOverSampleCounter",
				self.samples > 0 ? 1 / self.samples : 0
			);
			e.setFloat("uPixelEdgeSharpness", 1.0);
			e.setFloat("uEdgeSharpenSpeed", self.options.edgeSharpenSpeed);
			e.setFloat("uFilterDecaySpeed", self.options.filterDecaySpeed);
			e.setBool("uSceneIsDynamic", !!self.options.sceneIsDynamic);
		});

		var outputGLSL = this._postShader(
			"screenOutputFragmentShader",
			this._shaderSpec.screenOutput
		);
		if (!outputGLSL) {
			throw new Error(
				"[pt_lib] Missing shared shader 'screenOutputFragmentShader'. Is pt_lib.core.js loaded?"
			);
		}
		this._outputEffect = new BABYLON.EffectWrapper({
			engine: this.engine,
			fragmentShader: outputGLSL,
			uniformNames: [
				"uToneMappingExposure",
				"uExposure",
				"uContrast",
				"uToneMappingEnabled",
				"uToneMappingType"
			],
			samplerNames: ["resolvedBuffer"],
			name: this._nextPassName(this.name + "_screenOutput")
		});
		this._outputEffect.onApplyObservable.add(function () {
			var e = self._outputEffect.effect;
			// Resolved (and possibly denoised) linear HDR beauty.
			e.setTexture(
				"resolvedBuffer",
				self._beautyTexture || self._resolveRT
			);
			e.setFloat(
				"uToneMappingExposure",
				self.options.toneMappingExposure
			);

			// Honor scene.imageProcessingConfiguration in the tonemap stage. Read
			// every frame so Inspector edits apply immediately; these are plain
			// uniforms, so a change never recompiles the effect.
			var ip = self.scene && self.scene.imageProcessingConfiguration;
			var tmClass =
				typeof BABYLON !== "undefined" && BABYLON.ImageProcessingConfiguration
					? BABYLON.ImageProcessingConfiguration
					: null;
			var toneMappingType = 0;
			if (ip && tmClass) {
				if (ip.toneMappingType === tmClass.TONEMAPPING_ACES) {
					toneMappingType = 1;
				} else if (
					ip.toneMappingType === tmClass.TONEMAPPING_KHR_PBR_NEUTRAL
				) {
					toneMappingType = 2;
				}
			}
			e.setFloat(
				"uExposure",
				ip && typeof ip.exposure === "number" ? ip.exposure : 1.0
			);
			e.setFloat(
				"uContrast",
				ip && typeof ip.contrast === "number" ? ip.contrast : 1.0
			);
			e.setInt("uToneMappingEnabled", ip && ip.toneMappingEnabled ? 1 : 0);
			e.setInt("uToneMappingType", toneMappingType);
		});

		// ---- first-hit AOV pass (M5) ------------------------------------
		this._createAovEffect();

		this._createPostEffects();
	};

	// ------------------------------------------------ per-frame uniform values

	PathTracer.prototype._internalUniform = function (name) {
		switch (name) {
			case "uResolution":
				var size = this._pathRT.getSize();
				return [size.width, size.height];
			case "uRandomVec2":
				return this._randomVec2;
			case "uTime":
				return this._timeSeconds;
			case "uFrameCounter":
				return this.frameCounter;
			case "uSampleCounter":
				return this.samples;
			case "uPreviousSampleCount":
				return this.previousSampleCount;
			case "uCameraMatrix":
				return this.scene.activeCamera
					? this.scene.activeCamera.getWorldMatrix()
					: null;
			case "uCameraIsMoving":
				return this._cameraIsMoving;
			case "uAovChannel":
				// which first-hit AOV the AOV pass writes (0 albedo, 1 normal, 2 depth)
				return this._aovChannel;
			case "uFireflyClamp":
				return this.options.fireflyClamp > 0
					? this.options.fireflyClamp
					: 0;
			default:
				return undefined;
		}
	};

	PathTracer.prototype._applyPathBindings = function (effectOverride, infoOverride, typesOverride) {
		var effect = effectOverride || this._pathEffect.effect;
		var self = this;
		var frame = this._frame;
		var spec = this._shaderSpec;

		var info = infoOverride || this._uniformInfo;
		var types = typesOverride || this._uniformTypes;
		var i, name;

		for (i = 0; i < info.uniforms.length; i++) {
			name = info.uniforms[i];

			var val;
			if (Object.prototype.hasOwnProperty.call(spec.uniforms, name)) {
				val = value(spec.uniforms[name], self, frame);
			} else {
				val = this._internalUniform(name);
			}

			if (val === undefined || val === null) {
				if (
					this.options.warnUnboundUniforms &&
					this._unboundWarned[name] !== true
				) {
					this._unboundWarned[name] = true;
					console.warn(
						"[pt_lib] uniform '" +
							name +
							"' (" +
							types[name] +
							") is declared but never bound."
					);
				}
				continue;
			}

			if (!bindTyped(effect, name, types[name], val)) {
				if (this._unboundWarned[name] !== true) {
					this._unboundWarned[name] = true;
					console.warn(
						"[pt_lib] uniform '" +
							name +
							"' has unsupported type '" +
							types[name] +
							"'."
					);
				}
			}
		}

		for (i = 0; i < info.samplers.length; i++) {
			name = info.samplers[i];
			var tex;
			if (name === "previousBuffer") {
				tex = this._copyRT; // snapshot from the previous frame
			} else if (Object.prototype.hasOwnProperty.call(spec.samplers, name)) {
				tex = value(spec.samplers[name], self, frame);
			} else {
				if (
					this.options.warnUnboundUniforms &&
					this._unboundWarned[name] !== true
				) {
					this._unboundWarned[name] = true;
					console.warn(
						"[pt_lib] sampler '" + name + "' is declared but never bound."
					);
				}
				continue;
			}
			effect.setTexture(name, tex);
		}
	};

	// ------------------------------------------------------------- lifecycle

	PathTracer.prototype.start = function () {
		if (this._disposed) {
			throw new Error("[pt_lib] PathTracer has been disposed");
		}
		if (this._running) {
			return this;
		}
		this._running = true;
		this.isRunning = true;

		// Capability check. Guarded on getCaps() so headless/stub engines stay
		// silent. Advisory only — we warn rather than throw.
		if (
			this.options.warnOnUnsupported !== false &&
			typeof this.engine.getCaps === "function"
		) {
			var issues = PathTracer.supportIssues(this.engine);
			if (issues.length) {
				console.warn(
					"[pt_lib] PathTracer may not render correctly: " +
						issues.join("; ") +
					". See USAGE.md (Supported subset)."
				);
			}
		}

		// Ignored image-processing features are worth surfacing too, but only once.
		this._warnIgnoredImageProcessing();

		var self = this;
		this.engine.runRenderLoop(this._renderHandler);

		if (this.engine.onResizeObservable) {
			this._resizeObserver = this.engine.onResizeObservable.add(function () {
				self.resize();
			});
		}
		return this;
	};

	PathTracer.prototype.stop = function () {
		if (!this._running) {
			return this;
		}
		this._running = false;
		this.isRunning = false;
		this.engine.stopRenderLoop(this._renderHandler);
		return this;
	};

	// Invalidates accumulated samples. Call whenever the camera, geometry,
	// materials, lights or environment change.
	PathTracer.prototype.reset = function () {
		this.samples = 0;
		this.frameCounter = 1;
		// Never 0 — the shader computes 1.0 / uPreviousSampleCount.
		this.previousSampleCount = 1;
		this.isConverged = false;
		this._cameraRecentlyMoving = false;
		this._cameraIsMoving = true;
		this._prevCameraMatrix = null;
		this._accumulationId += 1;
		// A denoised result belongs to the old accumulation; drop it.
		this._denoiseResult = null;
		this._denoisePending = false;
		this._aovDirty = true;
		return this;
	};

	// Sample-lock control. 0 = converge indefinitely.
	PathTracer.prototype.setMaxSamples = function (maxSamples) {
		this.options.maxSamples = maxSamples > 0 ? maxSamples : 0;
		if (this.options.maxSamples === 0 || this.samples < this.options.maxSamples) {
			this.isConverged = false;
		}
		return this;
	};

	// Marks the accumulated image as invalidated for the next frame. Scene
	// adapters call this when a non-camera value changes (a light, a material).
	PathTracer.prototype.notifyChanged = function () {
		this._cameraIsMoving = true;
		this._aovDirty = true;
		return this;
	};

	// Swap the denoise hook at runtime. AOVs are implied by a hook, so the passes
	// (including the AOV pass and its targets) are rebuilt.
	PathTracer.prototype.setSeed = function (seed) {
		this.options.seed = seed > 0 ? seed : 0;
		return this.reset();
	};

	PathTracer.prototype.setDenoise = function (fn) {
		this.options.denoise = typeof fn === 'function' ? fn : null;
		this._denoiseResult = null;
		this._denoisePending = false;
		if (this._shaderSpec) {
			// Only the AOV pass depends on the hook, so rebuild just that. Tearing
			// down the beauty passes would dispose effects that may still be
			// compiling (and racing Babylon's async shader compile).
			this._disposeAovs();
			this._createAovTargets();
			this._createAovEffect();
		}
		return this;
	};

	PathTracer.prototype.resize = function () {
		if (!this._pathRT) {
			return this;
		}
		var size = {
			width: this._renderWidth(),
			height: this._renderHeight()
		};
		this._pathRT.resize(size);
		this._copyRT.resize(size);
		this._resolveRT.resize(size);
		if (this._aovTargets) {
			for (var a = 0; a < this._aovTargets.length; a++) {
				this._aovTargets[a].resize(size);
			}
		}
		if (this._captureRT) {
			this._captureRT.resize(size);
		}
		this._aovDirty = true;
		for (var i = 0; i < this._postRTs.length; i++) {
			this._postRTs[i].resize(size);
		}
		return this;
	};

	PathTracer.prototype.renderFrame = function () {
		if (!this._pathEffect || this._disposed) {
			return;
		}

		var frameStart = nowMs();

		var engine = this.engine;
		var dt = engine.getDeltaTime() * 0.001;
		this._timeSeconds += dt;

		// Always run Babylon's native loop first. Camera inputs, animations,
		// and the Inspector all depend on scene.render(). Skipping it after
		// sample-lock made the scene look "frozen" (controls never applied).
		this.scene.render();

		var camera = this.scene.activeCamera;
		var cameraMoved = false;
		if (this.options.autoDetectCameraMove && camera) {
			var m = camera.getWorldMatrix();
			if (this._prevCameraMatrix && !m.equals(this._prevCameraMatrix)) {
				cameraMoved = true;
			}
			this._prevCameraMatrix = m.clone ? m.clone() : m;
		}

		if (cameraMoved) {
			this._cameraIsMoving = true;
		}

		var changed = cameraMoved || this._cameraIsMoving;
		if (changed) {
			// First hit may differ: the AOVs need re-rendering.
			this._aovDirty = true;
		}

		this._frame = {
			deltaTime: dt,
			timeSeconds: this._timeSeconds,
			cameraMoved: cameraMoved,
			jsMs: 0
		};

		// Sample lock: once maxSamples is reached, skip path-tracing GPU work
		// until something changes — but keep blitting the last beauty pass so
		// the rasterized scene.render() does not flash through, and keep
		// onFrame alive for adapters (Inspector / signature checks).
		if (this.isConverged && !changed) {
			if (this._aovEnabled && this._aovDirty) {
				this._renderAovs();
			}
			this._renderOutput();
			if (this.options.onFrame) {
				this._frame.jsMs = nowMs() - frameStart;
				this.lastFrameMs = this._frame.jsMs;
				this.options.onFrame(this, this._frame);
			}
			return;
		}

		if (this.isConverged && changed) {
			this.isConverged = false;
		}

		// Sample accumulation, matching the original renderer: while nothing
		// changes the sample counter climbs; when something changes the previous
		// count is stashed (so the shader can weight the stale accumulation) and
		// the counter restarts at 1 with a fresh noise seed.
		var moving = this._cameraIsMoving || cameraMoved;

		if (!moving) {
			this.samples = this.options.sceneIsDynamic ? 1 : this.samples + 1;
			this.frameCounter += 1;
			this._cameraRecentlyMoving = false;
		} else {
			this.frameCounter += 1;
			if (!this._cameraRecentlyMoving) {
				// Must stay >= 1: the shader divides by this value on the frame
				// where uFrameCounter restarts (1.0 / uPreviousSampleCount).
				this.previousSampleCount = Math.max(1, this.samples);
				this.frameCounter = 1;
				this._accumulationId += 1;
				this._cameraRecentlyMoving = true;
			}
			this.samples = 1;
			this.isConverged = false; // the target must be reached again
		}

		// Noise seed for this sample. With options.seed > 0 the sequence is keyed by
		// the sample index (not the frame counter), so reset() replays the same
		// samples and a converged image is reproducible. 0 = fresh noise each frame.
		if (this.options.seed > 0) {
			var nextRandom = mulberry32(
				(this.options.seed | 0) + this.samples * 2654435761
			);
			this._randomVec2.x = nextRandom();
			this._randomVec2.y = nextRandom();
		} else {
			this._randomVec2.x = Math.random();
			this._randomVec2.y = Math.random();
		}

		// Path tracing pass: one more sample per pixel
		this._renderer.render(this._pathEffect, this._pathRT);

		// Snapshot the freshly accumulated buffer; becomes previousBuffer next frame
		this._renderer.render(this._copyEffect, this._copyRT);

		// First-hit AOVs, before the denoise hook reads them.
		if (this._aovEnabled && this._aovDirty) {
			this._renderAovs();
		}

		// Tonemap + gamma straight to the canvas (null target, so the
		// non-linear output never pollutes the linear accumulation buffer)
		this._renderOutput();

		if (this.options.onFrame) {
			this._frame.jsMs = nowMs() - frameStart;
			this.lastFrameMs = this._frame.jsMs;
			this.options.onFrame(this, this._frame);
		}
		this.onProgressObservable.notifyObservers(this.samples);

		if (
			!this.isConverged &&
			this.options.maxSamples > 0 &&
			this.samples >= this.options.maxSamples
		) {
			this.isConverged = true;
			this.onConvergedObservable.notifyObservers(this.samples);
		}

		// The move flag only applies to the frame in which the move happened.
		this._cameraIsMoving = false;
	};

	PathTracer.prototype.dispose = function () {
		if (this._disposed) {
			return;
		}
		this.stop();

		if (this._resizeObserver && this.engine.onResizeObservable) {
			this.engine.onResizeObservable.remove(this._resizeObserver);
		}

		this._disposePasses();
		this._disposed = true;
	};

	// ------------------------------------------------- capability detection
	// The tracer compiles GLSL ES 3.00 and accumulates into FLOAT render targets,
	// so it needs WebGL2 (or WebGPU) with float render-target support. Returns a
	// list of readable problems; empty means supported.
	PathTracer.supportIssues = function (engine) {
		var issues = [];
		if (!engine) {
			issues.push("no engine");
			return issues;
		}
		if (engine.isWebGPU === true) {
			return issues; // float render targets are core in WebGPU
		}

		var version =
			typeof engine.webGLVersion === "number" ? engine.webGLVersion : 0;
		if (version < 2) {
			issues.push("needs WebGL2 or WebGPU (webGLVersion=" + version + ")");
		}

		var caps = typeof engine.getCaps === "function" ? engine.getCaps() : null;
		if (!caps) {
			issues.push("engine.getCaps() is unavailable");
			return issues;
		}
		if (caps.textureFloat !== true) {
			issues.push("no float textures (caps.textureFloat)");
		}
		if (caps.textureFloatRender !== true && caps.colorBufferFloat !== true) {
			issues.push(
				"no float render targets (caps.textureFloatRender / colorBufferFloat)"
			);
		}
		return issues;
	};

	PathTracer.isSupported = function (engine) {
		return PathTracer.supportIssues(engine).length === 0;
	};

	// Features of scene.imageProcessingConfiguration the tonemap does not apply,
	// so callers can warn once instead of ignoring them silently.
	function ignoredImageProcessing(ip) {
		var ignored = [];
		if (!ip) {
			return ignored;
		}
		if (ip.colorCurvesEnabled === true) {
			ignored.push("color curves");
		}
		if (ip.colorGradingEnabled === true) {
			ignored.push("color grading");
		}
		return ignored;
	}

	PathTracer.prototype._warnIgnoredImageProcessing = function () {
		if (this._warnedIgnoredInputs) {
			return;
		}
		this._warnedIgnoredInputs = true;
		var ignored = ignoredImageProcessing(
			this.scene && this.scene.imageProcessingConfiguration
		);
		if (ignored.length) {
			console.warn(
				"[pt_lib] scene.imageProcessingConfiguration: " +
					ignored.join(", ") +
					" are not applied to the tonemap (exposure, contrast and the " +
					"tone-mapping curve are). See USAGE.md (Supported subset)."
			);
		}
	};

	PT_LIB.ignoredImageProcessing = ignoredImageProcessing;
	PT_LIB.PathTracer = PathTracer;

	if (typeof BABYLON !== 'undefined') {
		BABYLON.PathTracer = PathTracer;
	}
})(typeof window !== 'undefined' ? window : globalThis);
