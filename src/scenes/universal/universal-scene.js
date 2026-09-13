// pt_lib — universal scene adapter.
//
// Renders an ordinary Babylon scene with the path tracer. There is no
// hardcoded scene content anywhere: whatever meshes and lights the setup
// callback creates are ingested and drawn.
//
//   const app = PT_LIB.scenes.universal.create(canvas, {
//     setup: function (scene, camera) {
//       // normal Babylon: MeshBuilder, ImportMeshAsync, new PointLight(...)
//     }
//   });
//
// Native integration: structural Babylon observables mark the scene dirty, and
// Inspector eye / setEnabled and mesh transforms are polled cheaply (Babylon
// has no reliable "world matrix changed" observable). Visibility and transform
// sync are on by default; full material/light property sync stays behind
// autoReingest. `app.reingest()` still forces a refresh on demand.

(function (root) {
	'use strict';

	var PT_LIB = (root.PT_LIB = root.PT_LIB || {});
	PT_LIB.scenes = PT_LIB.scenes || {};

	var DEFAULTS = {
		resolutionScale: 0.5,
		maxSamples: 128, // 0 = converge indefinitely
		maxBounces: 4, // shader define; higher = slower

		cameraPosition: [0, 2, -8],
		focusDistance: 0, // 0 = derive from the camera origin distance
		apertureSize: 0.0,
		epsIntersect: 0.02,

		// keep Babylon's meshes renderable so the Inspector / Babylon view can
		// show them (costs some GPU, since the raster pass is then discarded)
		hideSceneMeshes: false,
		// draw glowing markers at light positions so point lights are visible
		showLights: true,

		// Automatic re-ingest when the Babylon scene changes.
		//
		// OFF by default for full property sync (materials/lights): re-ingesting is
		// heavy (BVH rebuild, texture upload, shader recompile), and doing it on
		// every Inspector slider tweak feels like a freeze.
		// Call app.reingest() to apply those edits, or set autoReingest: true.
		//
		// Visibility / enabled toggles (Inspector eye icon) DO sync by default —
		// that matches native Babylon. Debounced; still costs a BVH rebuild.
		autoReingest: false,
		syncVisibility: true,
		// Transforms are baked into the BVH, so a moved / rotated / scaled mesh
		// must re-ingest. Polled like visibility (Babylon has no dependable
		// per-node world-matrix observable). Turn off for animated scenes, which
		// would otherwise re-ingest — and restart accumulation — constantly.
		syncTransforms: true,
		// Light property edits (intensity / colour / position / direction /
		// cone) upload into the tLightData texture and re-accumulate — no BVH
		// rebuild, no shader recompile — so this is on by default. Adding or
		// removing a light changes the baked PT_LIGHT_COUNT and still re-ingests.
		syncLights: true,
		// Material property edits (albedo / metallic / roughness / emissive /
		// bump level / channel flags) upload into the tMaterialData texture the
		// same way. Swapping a texture reference changes the sampler pool and is
		// left to the re-ingest path.
		syncMaterials: true,
		reingestDebounceMs: 150,

		blueNoiseFile: './textures/BlueNoise_RGBA256.png',

		// Shared scene-texture pool size (albedo + bump + metallic-roughness +
		// emissive). 0 = derive from the engine's texture-unit count (up to 12).
		maxTextures: 0,

		// Firefly / outlier clamp for a single sample (linear luminance; 0 = off).
		fireflyClamp: 0,
		// 0 = non-deterministic. > 0 makes sampling reproducible.
		seed: 0,
		// Force first-hit AOVs on even without a denoise hook (for PNG export).
		aovs: false,

		// Offload world-space packing + the BVH build to a Web Worker so a large
		// scene does not freeze the main thread. Browser-verified; set false to
		// force the synchronous path (the reference implementation).
		worker: true,
		// Called with { phase: 'pack' | 'bvh', done, total } while a worker ingest
		// runs. The synchronous path cannot report mid-run progress.
		onIngestProgress: null,
		// Override the worker's importScripts URLs (bundlers / relocated files).
		workerScripts: null,

		setup: null // function (scene, camera) -> void | Promise
	};

	function assign(target, source) {
		for (var key in source) {
			if (Object.prototype.hasOwnProperty.call(source, key)) {
				target[key] = source[key];
			}
		}
		return target;
	}

	function create(canvas, options) {
		if (typeof BABYLON === 'undefined') {
			throw new Error('[pt_lib] BABYLON must be loaded first');
		}
		if (!PT_LIB.ingestScene || !PT_LIB.buildScenePrelude) {
			throw new Error('[pt_lib] Load src/core/ingest.js before the universal adapter');
		}

		var opts = assign(assign({}, DEFAULTS), options || {});

		var engine = new BABYLON.Engine(canvas, true);
		var scene = new BABYLON.Scene(engine);
		scene.clearColor = new BABYLON.Color4(0, 0, 0, 1);

		var camera = new BABYLON.UniversalCamera(
			'universalCamera',
			new BABYLON.Vector3(
				opts.cameraPosition[0],
				opts.cameraPosition[1],
				opts.cameraPosition[2]
			),
			scene
		);
		camera.attachControl(canvas, true);
		camera.inertia = 0;
		camera.angularSensibility = 500;

		var uVLen = Math.tan(camera.fov * 0.5);
		var lastAspect = engine.getRenderWidth() / engine.getRenderHeight();
		var uULenValue = uVLen * lastAspect;

		var focusDistance =
			opts.focusDistance > 0
				? opts.focusDistance
				: new BABYLON.Vector3(
						opts.cameraPosition[0],
						opts.cameraPosition[1],
						opts.cameraPosition[2]
					).length() || 8.0;

		var blueNoiseTexture = new BABYLON.Texture(
			opts.blueNoiseFile,
			scene,
			true,
			false,
			BABYLON.Constants.TEXTURE_NEAREST_SAMPLINGMODE,
			null,
			null,
			null,
			false,
			BABYLON.Constants.TEXTUREFORMAT_RGBA
		);

		var state = {
			engine: engine,
			scene: scene,
			camera: camera,
			pathTracer: null,
			ingested: null,
			triangleCount: 0,
			debugMode: 0, // 1 = albedo, 2 = normals, 3 = direct light, 4 = depth
			showLights: opts.showLights,
			ingestProgress: null,
			isReady: false
		};

		var geometryTextures = null;
		var lightDataTexture = null;
		var lastLightArray = null;
		var lightCount = 0;
		var materialDataTexture = null;
		var lastMaterialArray = null;
		var lastMaterials = null;
		var materialCount = 0;
		var rawShader = null;
		var dirty = false;
		var lastReingest = 0;
		var lastSignature = null;
		var lastSignatureCheck = 0;
		var watched = new WeakSet();
		var reingestQueued = false;

		function now() {
			return typeof performance !== 'undefined' && performance.now
				? performance.now()
				: Date.now();
		}

		// ---------------------------------------------------- ingest + apply

		function ingestAndApply() {
			var started = now();

			// Size the shared scene-texture pool to the device. Reserve 6 units for
			// previousBuffer, blueNoiseTexture, tAABBTexture, tTriangleTexture,
			// tLightData and tMaterialData.
			if (!opts.maxTextures) {
				var caps = typeof engine.getCaps === 'function' ? engine.getCaps() : null;
				var units = caps && caps.maxTexturesImageUnits ? caps.maxTexturesImageUnits : 16;
				opts.maxTextures = Math.max(1, Math.min(12, units - 6));
			}

			if (opts.workerScripts && PT_LIB.geometryWorker) {
				PT_LIB.geometryWorker.configure(opts.workerScripts);
			}

			// The worker path returns a promise; the sync path returns directly.
			if (opts.worker && PT_LIB.ingestSceneAsync && PT_LIB.geometryWorker) {
				return PT_LIB.ingestSceneAsync(scene, ingestOptions()).then(
					function (ingested) {
						return applyIngested(ingested, started);
					}
				);
			}
			return applyIngested(PT_LIB.ingestScene(scene, ingestOptions()), started);
		}

		function ingestOptions() {
			return assign(assign({}, opts), {
				onProgress: function (progress) {
					state.ingestProgress = progress;
					if (typeof opts.onIngestProgress === 'function') {
						opts.onIngestProgress(progress);
					}
				}
			});
		}

		function applyIngested(ingested, started) {
			state.ingested = ingested;
			state.triangleCount = ingested.triangleCount;

			var width = PT_LIB.ingestConstants.TEXTURE_WIDTH;

			// geometry data textures, sized to this scene rather than 2048x2048
			if (geometryTextures) {
				geometryTextures[0].dispose();
				geometryTextures[1].dispose();
			}
			var aabbDataTexture = BABYLON.RawTexture.CreateRGBATexture(
				ingested.aabbArray, width, ingested.aabbTextureHeight,
				scene, false, false,
				BABYLON.Constants.TEXTURE_NEAREST_SAMPLINGMODE,
				BABYLON.Constants.TEXTURETYPE_FLOAT
			);
			var triangleDataTexture = BABYLON.RawTexture.CreateRGBATexture(
				ingested.triangleArray, width, ingested.triangleTextureHeight,
				scene, false, false,
				BABYLON.Constants.TEXTURE_NEAREST_SAMPLINGMODE,
				BABYLON.Constants.TEXTURETYPE_FLOAT
			);
			geometryTextures = [aabbDataTexture, triangleDataTexture];

			// Lights go into a small float texture rather than baked constants, so
			// a property tweak can update them without recompiling the shader.
			if (lightDataTexture) {
				lightDataTexture.dispose();
			}
			var lightData = PT_LIB.buildLightData(ingested.lights);
			lightDataTexture = BABYLON.RawTexture.CreateRGBATexture(
				lightData.array, lightData.width, lightData.height,
				scene, false, false,
				BABYLON.Constants.TEXTURE_NEAREST_SAMPLINGMODE,
				BABYLON.Constants.TEXTURETYPE_FLOAT
			);
			lastLightArray = lightData.array;
			lightCount = lightData.count;

			// Material values go into their own small float texture, same idea as
			// lights: a property tweak can then upload new values without
			// recompiling the shader.
			if (materialDataTexture) {
				materialDataTexture.dispose();
			}
			var materialData = PT_LIB.buildMaterialData(ingested.materials);
			materialDataTexture = BABYLON.RawTexture.CreateRGBATexture(
				materialData.array, materialData.width, materialData.height,
				scene, false, false,
				BABYLON.Constants.TEXTURE_NEAREST_SAMPLINGMODE,
				BABYLON.Constants.TEXTURETYPE_FLOAT
			);
			lastMaterialArray = materialData.array;
			lastMaterials = ingested.materials;
			materialCount = materialData.count;

			if (opts.hideSceneMeshes) {
				for (var i = 0; i < scene.meshes.length; i++) {
					scene.meshes[i].isVisible = false;
				}
			}

			var prelude = PT_LIB.buildScenePrelude(ingested);

			if (!rawShader) {
				rawShader =
					PT_LIB.glsl && PT_LIB.glsl.scenes && PT_LIB.glsl.scenes['universal'];
				if (!rawShader) {
					throw new Error(
						"[pt_lib] Scene shader 'universal' is not registered. Load " +
							'src/scenes/universal/UniversalPathTracing_FragmentShader.js first.'
					);
				}
			}

			var spec = {
				source: rawShader,
				prelude: prelude.glsl,
				// This scene's CalculateRadiance fills the first-hit AOV globals, so
				// the tracer may build its AOV pass (albedo / normal / depth).
				aovs: true,
				defines: { PT_MAX_BOUNCES: opts.maxBounces },
				uniforms: {
					uDebugMode: function () { return state.debugMode; },
					uShowLights: function () { return state.showLights ? 1.0 : 0.0; },
					uULen: function () { return uULenValue; },
					uVLen: function () { return uVLen; },
					uEPS_intersect: opts.epsIntersect,
					uApertureSize: opts.apertureSize,
					uFocusDistance: focusDistance
				},
				samplers: assign(
					{
						blueNoiseTexture: blueNoiseTexture,
						tAABBTexture: aabbDataTexture,
						tTriangleTexture: triangleDataTexture,
						tLightData: lightDataTexture,
						tMaterialData: materialDataTexture
					},
					prelude.samplers
				)
			};

			if (!state.pathTracer) {
				var pt = new PT_LIB.PathTracer('pathTracer', scene, {
					resolutionScale: opts.resolutionScale,
					maxSamples: opts.maxSamples,
					toneMappingExposure: 1.0,
					fireflyClamp: opts.fireflyClamp,
					seed: opts.seed,
					aovs: opts.aovs
				});
				pt.setShader(spec);
				pt.options.onFrame = onFrame;
				state.pathTracer = pt;
				pt.start();
				state.isReady = true;
			} else {
				// Re-skin the SAME instance: keeps observables, UI bindings and
				// the render loop intact, only the shader/targets are rebuilt.
				state.pathTracer.setShader(spec);
				state.pathTracer.reset();
			}

			console.log(
				'[pt_lib] ingested in ' + Math.round(now() - started) + ' ms — triangles: ' +
				ingested.triangleCount +
				', materials: ' + ingested.materials.length +
				', textures: ' + ingested.textures.length +
				', env: ' + (ingested.environment && ingested.environment.texture
					? (ingested.environment.kind === 1 ? 'cube' : 'equirect')
					: 'none') +
				', lights: ' + ingested.lights.length
			);

			return state.pathTracer;
		}

		var lastVisibilitySignature = null;

		function visibilitySignature() {
			var parts = [];
			var i, node;
			for (i = 0; i < scene.meshes.length; i++) {
				node = scene.meshes[i];
				parts.push(
					node.uniqueId,
					node.isVisible === false ? 0 : 1,
					typeof node.isEnabled === 'function' && node.isEnabled() ? 1 : 0
				);
			}
			for (i = 0; i < scene.lights.length; i++) {
				node = scene.lights[i];
				parts.push(
					node.uniqueId,
					typeof node.isEnabled === 'function' && node.isEnabled() ? 1 : 0
				);
			}
			return parts.join('|');
		}

		// Mesh world matrices are baked into the BVH at ingest, so a moved /
		// rotated / scaled mesh needs a fresh ingest. Checked with the same
		// throttle as visibility; non-forced computeWorldMatrix() keeps the
		// matrix correct even when the mesh is hidden from the raster pass
		// (hideSceneMeshes / isVisible = false), and is cheap when clean.
		var lastTransformSignature = null;

		function transformSignature() {
			var parts = [];
			var i, node, m, k;
			for (i = 0; i < scene.meshes.length; i++) {
				node = scene.meshes[i];
				if (typeof node.computeWorldMatrix === 'function') {
					node.computeWorldMatrix();
				}
				if (typeof node.getWorldMatrix !== 'function') {
					continue;
				}
				m = node.getWorldMatrix();
				if (!m || !m.m) {
					continue;
				}
				parts.push(node.uniqueId);
				for (k = 0; k < 16; k++) {
					// quantised so float noise cannot trigger a spurious rebuild
					parts.push(Math.round(m.m[k] * 1e5) / 1e5);
				}
			}
			return parts.join(',');
		}

		// Light property edits are cheap: rebuild the packed light data, and only
		// upload + re-accumulate when a value actually changed. A count change is
		// structural (it changes PT_LIGHT_COUNT) and is left to the re-ingest path.
		function updateLightData() {
			if (!lightDataTexture || !lastLightArray) return;
			var info = PT_LIB.ingestLights(scene.lights || []);
			if (info.lights.length !== lightCount) return;

			var array = PT_LIB.buildLightData(info.lights).array;
			var k;
			for (k = 0; k < array.length; k++) {
				if (array[k] !== lastLightArray[k]) break;
			}
			if (k === array.length) return; // nothing changed

			lastLightArray = array;
			lightDataTexture.update(array);
			if (state.pathTracer) {
				state.pathTracer.notifyChanged();
			}
		}

		// Material property edits are cheap too: re-read the scalar fields from the
		// live Babylon materials, repack, and only upload + re-accumulate when a
		// value actually changed. A swapped texture reference changes the sampler
		// pool, so that case is left to the re-ingest path.
		function updateMaterialData() {
			if (!materialDataTexture || !lastMaterials) return;
			PT_LIB.refreshMaterialScalars(lastMaterials);
			var info = PT_LIB.buildMaterialData(lastMaterials);
			if (info.count !== materialCount) return;

			var array = info.array;
			var k;
			for (k = 0; k < array.length; k++) {
				if (array[k] !== lastMaterialArray[k]) break;
			}
			if (k === array.length) return; // nothing changed

			lastMaterialArray = array;
			materialDataTexture.update(array);
			if (state.pathTracer) {
				state.pathTracer.notifyChanged();
			}
		}

		function onFrame(pt, frame) {
			if (frame && frame.jsMs > 50) {
				console.log('[pt_lib] renderFrame JS ' + Math.round(frame.jsMs) + ' ms');
			}

			// keep the FOV uniforms in sync with the camera
			var aspect = engine.getRenderWidth() / engine.getRenderHeight();
			var vLen = Math.tan(camera.fov * 0.5);
			if (vLen !== uVLen || aspect !== lastAspect) {
				uVLen = vLen;
				uULenValue = uVLen * aspect;
				lastAspect = aspect;
			}

			var stampNow = now();
			if (stampNow - lastSignatureCheck >= 250) {
				lastSignatureCheck = stampNow;

				// Inspector eye / setEnabled — no Babylon observable for isVisible.
				if (opts.syncVisibility) {
					var vis = visibilitySignature();
					if (lastVisibilitySignature !== null && vis !== lastVisibilitySignature) {
						dirty = true;
					}
					lastVisibilitySignature = vis;
				}

				// Full property sync (materials, light intensity, etc.)
				if (opts.autoReingest) {
					var signature = sceneSignature();
					if (lastSignature !== null && signature !== lastSignature) {
						dirty = true;
					}
					lastSignature = signature;
				}

				// Mesh transforms are baked, so a moved mesh needs a re-ingest.
				if (opts.syncTransforms) {
					var xform = transformSignature();
					if (lastTransformSignature !== null && xform !== lastTransformSignature) {
						dirty = true;
					}
					lastTransformSignature = xform;
				}

				// Light values are a texture upload, not a re-ingest.
				if (opts.syncLights) {
					updateLightData();
				}

				// Material values are a texture upload too.
				if (opts.syncMaterials) {
					updateMaterialData();
				}
			}

			// debounced automatic re-ingest after a watched change
			if (!dirty || !(opts.autoReingest || opts.syncVisibility || opts.syncTransforms)) {
				return;
			}
			var stamp = now();
			if (stamp - lastReingest < opts.reingestDebounceMs) {
				return;
			}
			dirty = false;
			lastReingest = stamp;
			try {
				var applied = ingestAndApply();
				if (applied && typeof applied.then === 'function') {
					applied.catch(function (e) {
						console.error('[pt_lib] automatic re-ingest failed:', e);
					});
				}
			} catch (e) {
				console.error('[pt_lib] automatic re-ingest failed:', e);
			}
		}

		// ------------------------------------------- Babylon-native watching

		function watch(node) {
			if (!watched || !node || watched.has(node)) {
				return;
			}
			watched.add(node);
			if (node.onEnabledStateChangedObservable) {
				node.onEnabledStateChangedObservable.add(markDirty);
			}
		}

		function markDirty() {
			dirty = true;
		}

		// Babylon broadcasts structural changes (see the observables below) but
		// NOT property edits such as light.intensity, material.albedoColor or
		// mesh.isVisible — there is no observable for those. A cheap throttled
		// signature is what lets Inspector/property edits reach the tracer with
		// no glue in the page.
		function sceneSignature() {
			var parts = [];
			var i, node, mat, c, e;

			for (i = 0; i < scene.meshes.length; i++) {
				node = scene.meshes[i];
				parts.push(
					node.uniqueId,
					node.isVisible === false ? 0 : 1,
					typeof node.isEnabled === 'function' && node.isEnabled() ? 1 : 0,
					node.material ? node.material.uniqueId : -1
				);
			}
			for (i = 0; i < scene.lights.length; i++) {
				node = scene.lights[i];
				c = node.diffuse || node.diffuseColor;
				parts.push(
					node.uniqueId,
					typeof node.isEnabled === 'function' && node.isEnabled() ? 1 : 0,
					node.intensity,
					c ? c.r + ',' + c.g + ',' + c.b : '',
					node.position ? node.position.x + ',' + node.position.y + ',' + node.position.z : '',
					node.direction ? node.direction.x + ',' + node.direction.y + ',' + node.direction.z : ''
				);
			}
			for (i = 0; i < scene.materials.length; i++) {
				mat = scene.materials[i];
				c = mat.albedoColor || mat.diffuseColor;
				e = mat.emissiveColor;
				parts.push(
					mat.uniqueId,
					c ? c.r + ',' + c.g + ',' + c.b : '',
					mat.metallic,
					mat.roughness,
					mat.albedoTexture ? mat.albedoTexture.uniqueId
						: (mat.diffuseTexture ? mat.diffuseTexture.uniqueId : -1),
					e ? e.r + ',' + e.g + ',' + e.b : '',
					mat.emissiveIntensity,
					mat.bumpTexture ? mat.bumpTexture.uniqueId + ':' + mat.bumpTexture.level : -1,
					mat.metallicTexture ? mat.metallicTexture.uniqueId : -1,
					mat.emissiveTexture ? mat.emissiveTexture.uniqueId : -1,
					mat.useMetallnessFromMetallicTextureBlue === false ? 0 : 1,
					mat.useRoughnessFromMetallicTextureGreen === false ? 0 : 1
				);
			}
			parts.push(
				scene.environmentTexture ? scene.environmentTexture.uniqueId : -1,
				scene.environmentIntensity
			);

			return parts.join('|');
		}

		// Structural changes: everything here is a Babylon observable, so the
		// adapter reacts to the scene rather than polling it. Names were verified
		// against the Babylon build — note the `onNew*` prefix on the "added" ones.
		function on(observable, fn, label) {
			if (observable && typeof observable.add === 'function') {
				observable.add(fn);
				return;
			}
			console.warn('[pt_lib] Babylon observable not found: ' + label);
		}

		on(scene.onNewMeshAddedObservable, function (mesh) {
			watch(mesh);
			markDirty();
		}, 'scene.onNewMeshAddedObservable');
		on(scene.onMeshRemovedObservable, markDirty, 'scene.onMeshRemovedObservable');
		on(scene.onNewLightAddedObservable, function (light) {
			watch(light);
			markDirty();
		}, 'scene.onNewLightAddedObservable');
		on(scene.onLightRemovedObservable, markDirty, 'scene.onLightRemovedObservable');
		on(scene.onNewMaterialAddedObservable, markDirty, 'scene.onNewMaterialAddedObservable');
		on(scene.onMaterialRemovedObservable, markDirty, 'scene.onMaterialRemovedObservable');

		function watchExistingNodes() {
			var i;
			for (i = 0; i < scene.meshes.length; i++) watch(scene.meshes[i]);
			for (i = 0; i < scene.lights.length; i++) watch(scene.lights[i]);
		}

		// ----------------------------------------------------------- startup

		function finish() {
			watchExistingNodes();
			return ingestAndApply();
		}

		state.ready = (function () {
			var maybePromise = opts.setup ? opts.setup(scene, camera) : null;
			if (maybePromise && typeof maybePromise.then === 'function') {
				return maybePromise.then(finish);
			}
			return Promise.resolve(finish());
		})();

		// Force a refresh on demand. Structural changes, visibility and mesh
		// transforms are handled automatically; material/light property edits
		// need this unless autoReingest is on.
		state.reingest = function () {
			watchExistingNodes();
			dirty = false;
			return Promise.resolve(ingestAndApply());
		};
		state.rebuild = state.reingest;

		// Toggle the worker path at runtime (the demo uses this). The next ingest
		// picks it up; the current one finishes on whatever path it started.
		state.setWorker = function (on) {
			opts.worker = !!on;
		};

		state.dispose = function () {
			if (state.pathTracer) {
				state.pathTracer.dispose();
			}
			if (PT_LIB.geometryWorker) {
				PT_LIB.geometryWorker.dispose();
			}
			if (geometryTextures) {
				geometryTextures[0].dispose();
				geometryTextures[1].dispose();
			}
			if (lightDataTexture) {
				lightDataTexture.dispose();
				lightDataTexture = null;
			}
			if (materialDataTexture) {
				materialDataTexture.dispose();
				materialDataTexture = null;
			}
			scene.dispose();
			engine.dispose();
		};

		return state;
	}

	PT_LIB.scenes.universal = { create: create, DEFAULTS: DEFAULTS };
})(typeof window !== 'undefined' ? window : globalThis);
