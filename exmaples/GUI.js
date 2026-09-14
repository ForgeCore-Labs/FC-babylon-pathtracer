// exmaples/GUI.js
//
// Everything DOM/UI for the demo lives here, so `test.html` stays a short
// "build a scene, hand it to the path tracer" page and nothing else.
//
// The module drives the library *only* through the object the universal adapter
// returns from `PT_LIB.scenes.universal.create(...)`:
//
//   app.pathTracer              the PathTracer instance (start/stop/reset,
//                               setDenoise, setSeed, setMaxSamples, resize,
//                               exportImage, add/removePostProcess, observables)
//   app.scene                   the Babylon scene
//   app.triangleCount           triangles ingested so far
//   app.debugMode               AOV view: 0 beauty · 1 albedo · 2 normals ·
//                               3 direct light · 4 depth
//   app.showLights              draw the emissive light markers? (adapter)
//   app.setWorker(bool)         re-pack on a Web Worker vs the main thread
//   app.reingest()              re-ingest after a scene change
//
// It reads two globals that the page's other <script> tags define:
//   PT_LIB   — the IIFE bundle
//   BABYLON  — the Babylon engine script
//
// It is an ES module (`<script type="module">`), which is why the page must be
// served over HTTP — `file://` blocks module loading.

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------
// `#info` shows "N triangles — <what is happening>". `getApp` is a getter
// rather than the app itself because the status line has to exist *before*
// create() runs (its onIngestProgress callback reports progress during the
// very first ingest, while `app` is still being built).
export function createStatus(info, getApp) {
	return {
		set: function (extra, isLocked) {
			const app = getApp();
			const tris = app && app.triangleCount ? app.triangleCount.toFixed(0) : '0';
			info.textContent =
				'babylon-pathtracer — ' + tris + ' triangles' + (extra ? ' — ' + extra : '');
			// Green = accumulation is locked (converged), white = still running.
			info.style.color = isLocked ? '#9be89b' : '#fff';
		}
	};
}

// ---------------------------------------------------------------------------
// Light-icon overlay
// ---------------------------------------------------------------------------
// The tracer's final pass blits the tonemapped image straight to the canvas
// *after* `scene.render()`, so a Babylon gizmo/mesh drawn in the scene would be
// painted over. This DOM layer is composited by the browser *above* the canvas,
// so the icons survive the blit. Each icon is simply the projection of a
// light's world position through the active camera.
//
// Mirrors ingest.js: only point and spot lights live at a position (directional
// and hemispheric lights are skipped).
export function createLightIcons(canvas, app) {
	const layer = document.getElementById('lightIcons');
	const icons = new Map(); // light.uniqueId -> element
	const identity = BABYLON.Matrix.Identity(); // the tracer works in world space
	let visible = true;

	function iconFor(light) {
		let el = icons.get(light.uniqueId);
		if (!el) {
			el = document.createElement('div');
			el.className = 'pt-light-icon';
			const label = document.createElement('span');
			label.className = 'pt-light-name';
			label.textContent = light.name || 'light';
			el.appendChild(label);
			layer.appendChild(el);
			icons.set(light.uniqueId, el);
		}
		return el;
	}

	function update() {
		if (!visible) {
			if (layer.style.display !== 'none') layer.style.display = 'none';
			return;
		}
		layer.style.display = '';

		const scene = app.scene;
		const camera = scene && scene.activeCamera;
		if (!camera) return;

		const rect = canvas.getBoundingClientRect();
		// Project into CSS pixels: the canvas may be scaled by devicePixelRatio or
		// resolutionScale, so the engine's render size is the wrong space here.
		const viewport = camera.viewport.toGlobal(
			canvas.clientWidth || rect.width,
			canvas.clientHeight || rect.height
		);
		const transform = scene.getTransformMatrix();

		const alive = new Set();
		for (let i = 0; i < scene.lights.length; i++) {
			const light = scene.lights[i];
			const hasPosition =
				light instanceof BABYLON.PointLight || light instanceof BABYLON.SpotLight;
			if (!hasPosition || !light.position) continue;
			if (typeof light.isEnabled === 'function' && !light.isEnabled()) continue;

			const el = iconFor(light);
			alive.add(light.uniqueId);

			const worldPos =
				typeof light.getAbsolutePosition === 'function'
					? light.getAbsolutePosition()
					: light.position;
			const p = BABYLON.Vector3.Project(worldPos, identity, transform, viewport);
			if (p.z < 0 || p.z > 1) { // behind the camera
				el.style.display = 'none';
				continue;
			}

			const c = light.diffuse || light.diffuseColor;
			if (c) {
				el.style.color = 'rgb(' +
					Math.round(Math.max(0, Math.min(1, c.r)) * 255) + ',' +
					Math.round(Math.max(0, Math.min(1, c.g)) * 255) + ',' +
					Math.round(Math.max(0, Math.min(1, c.b)) * 255) + ')';
			}
			el.style.display = 'block';
			el.style.left = (rect.left + p.x) + 'px';
			el.style.top = (rect.top + p.y) + 'px';
		}

		// Drop icons for lights that were removed from the scene.
		icons.forEach(function (el, id) {
			if (alive.has(id)) return;
			el.remove();
			icons.delete(id);
		});
	}

	return {
		update: update,
		setVisible: function (v) {
			visible = !!v;
			update();
		},
		isVisible: function () { return visible; }
	};
}

// ---------------------------------------------------------------------------
// Example post-process pass
// ---------------------------------------------------------------------------
// `options.postProcesses` / `addPostProcess` run *after* the tonemap, so a pass
// works in display space. A pass is a plain spec: a full-screen fragment shader
// with its own `out`, sampling the previous stage through `textureSampler`
// (no `vUV` varying is injected — fetch with gl_FragCoord).
//
// `uniforms` values may be literals or per-frame getters, which is how the
// strength slider stays live without rebuilding the pipeline. `uResolution`
// comes from the engine so the vignette is resolution-independent.
export function createVignettePass(strengthInput) {
	return {
		name: 'demoVignette',
		uniforms: {
			uAmount: function () {
				return parseFloat(strengthInput.value);
			},
			uResolution: function (pt) {
				return [pt.engine.getRenderWidth(), pt.engine.getRenderHeight()];
			}
		},
		fragmentShader: [
			'#version 300 es',
			'precision highp float;',
			'precision highp sampler2D;',
			'uniform sampler2D textureSampler;',
			'uniform float uAmount;',
			'uniform vec2 uResolution;',
			'out vec4 glFragColor;',
			'void main(void) {',
			'\tvec2 uv = gl_FragCoord.xy / uResolution;',
			'\tvec3 c = texture(textureSampler, uv).rgb;',
			'\tvec2 d = uv - 0.5;',
			'\tfloat v = clamp(1.0 - uAmount * dot(d, d) * 4.0, 0.0, 1.0);',
			'\tglFragColor = vec4(c * v, 1.0);',
			'}'
		].join('\n')
	};
}

// ---------------------------------------------------------------------------
// The control panel
// ---------------------------------------------------------------------------
// `createGUI` wires every control in `#ui` and returns the handful of methods
// the page calls once the tracer is ready:
//
//   applyUISettings()   push the panel's initial values into the adapter
//   attachStatus(pt)    mirror sample count / convergence into the status line
//   forceReingest()     re-ingest on demand ("apply changes")
//   updateLightIcons()  reproject the overlay (call it from onAfterRender)
//
// `options.getMaterials()` returns the demo's live PBRMaterial array (it is
// filled in during `setup`, after this module is created) and
// `options.setEnvironment(name)` swaps `scene.environmentTexture` — both are
// scene concerns the page owns, passed in as hooks.
export function createGUI(options) {
	const app = options.app;
	const canvas = options.canvas;
	const status = options.status;
	const getMaterials = options.getMaterials || function () { return []; };
	const setEnvironment = options.setEnvironment || function () {};

	const lightIcons = createLightIcons(canvas, app);

	// --- grab every control once ---
	const view = document.getElementById('uiView');
	const env = document.getElementById('uiEnv');
	const samples = document.getElementById('uiSamples');
	const firefly = document.getElementById('uiFirefly');
	const fireflyOut = document.getElementById('uiFireflyOut');
	const seed = document.getElementById('uiSeed');
	const atrousToggle = document.getElementById('uiAtrous');
	const atrousIters = document.getElementById('uiAtrousIters');
	const phiN = document.getElementById('uiPhiN');
	const phiA = document.getElementById('uiPhiA');
	const phiD = document.getElementById('uiPhiD');
	const phiNOut = document.getElementById('uiPhiNOut');
	const phiAOut = document.getElementById('uiPhiAOut');
	const phiDOut = document.getElementById('uiPhiDOut');
	const res = document.getElementById('uiRes');
	const lights = document.getElementById('uiLights');
	const icons = document.getElementById('uiLightIcons');
	const material = document.getElementById('uiMaterial');
	const metal = document.getElementById('uiMetal');
	const rough = document.getElementById('uiRough');
	const metalOut = document.getElementById('uiMetalOut');
	const roughOut = document.getElementById('uiRoughOut');
	const post = document.getElementById('uiPost');
	const postAmt = document.getElementById('uiPostAmt');
	const postOut = document.getElementById('uiPostOut');
	const workerToggle = document.getElementById('uiWorker');
	const aovsToggle = document.getElementById('uiAovs');

	const vignettePass = createVignettePass(postAmt);

	// --- live material editing ---------------------------------------------
	// These sliders edit a live Babylon PBRMaterial. The adapter's per-frame
	// updateMaterialData() notices the scalar change and re-accumulates — no
	// re-ingest, no shader recompile. That live update is exactly what the
	// tMaterialData texture exists for, so this is the direct browser test.
	function selectedMaterial() {
		const index = parseInt(material.value, 10) || 0;
		return getMaterials()[index] || null;
	}
	function showMaterialValues() {
		const m = selectedMaterial();
		if (!m) return;
		metal.value = m.metallic;
		rough.value = m.roughness;
		metalOut.textContent = Number(m.metallic).toFixed(2);
		roughOut.textContent = Number(m.roughness).toFixed(2);
	}
	function setMaterialValue(prop, value, out) {
		const m = selectedMaterial();
		if (!m) return;
		m[prop] = value;
		out.textContent = value.toFixed(2);
	}

	// --- a-trous (GPU denoise) ---------------------------------------------
	// The demo's one denoiser backend: no readback, it runs every frame while
	// converging and reuses its result once converged.
	let activeATrous = null;
	function readATrousParams() {
		return {
			iterations: Math.max(1, Math.min(6, parseInt(atrousIters.value, 10) || 3)),
			phiNormal: parseFloat(phiN.value) || 0,
			phiAlbedo: parseFloat(phiA.value) || 0,
			phiDepth: parseFloat(phiD.value) || 0
		};
	}
	function applyATrous() {
		const pt = app.pathTracer;
		if (!pt || !pt.setDenoise) return;
		if (!atrousToggle.checked) {
			pt.setDenoise(null);
			activeATrous = null;
			status.set('a-trous off');
			return;
		}
		if (!PT_LIB.denoise || !PT_LIB.denoise.aTrous) {
			status.set('the a-trous backend is not in this build');
			return;
		}
		const params = readATrousParams();
		activeATrous = PT_LIB.denoise.aTrous(params);
		pt.setDenoise(activeATrous);
		status.set('a-trous on (' + params.iterations + ' passes)');
	}
	// Sliders tune the live hook: the pipeline (render targets + effect) is
	// reused, only the parameters change. Higher φ = stricter edges, less
	// smoothing; lower φ = smoother, risk of bleeding.
	function tuneATrous() {
		phiNOut.textContent = phiN.value;
		phiAOut.textContent = phiA.value;
		phiDOut.textContent = phiD.value;
		if (activeATrous) activeATrous.setParams(readATrousParams());
	}

	// --- methods the page calls --------------------------------------------
	function applyUISettings() {
		const pt = app.pathTracer;
		if (!pt) return;
		app.debugMode = parseFloat(view.value) || 0;
		app.showLights = lights.checked;
		pt.setMaxSamples(parseInt(samples.value, 10) || 0);
		pt.options.resolutionScale = parseFloat(res.value) || 1;
		pt.resize();
		pt.reset();
	}

	function attachStatus(pt) {
		pt.onProgressObservable.add(function (samples) {
			const cap = pt.options.maxSamples;
			status.set('samples ' + samples + (cap > 0 ? ' / ' + cap : ''), false);
		});
		pt.onConvergedObservable.add(function (samples) {
			status.set(
				'converged at ' + samples +
				' — locked (move the camera or press reset)',
				true
			);
		});
	}

	// The tracer instance is stable, and the adapter listens to Babylon's own
	// observables, so scene edits (including from the Inspector) re-ingest
	// automatically. This only exists to force a refresh on demand.
	function forceReingest() {
		status.set('re-ingesting scene…');
		return app.reingest();
	}

	// --- wiring -------------------------------------------------------------
	lights.checked = !!app.showLights;
	icons.checked = lightIcons.isVisible();

	view.addEventListener('change', function () {
		app.debugMode = parseFloat(view.value) || 0;
		if (app.pathTracer) app.pathTracer.reset();
	});

	samples.addEventListener('change', function () {
		if (!app.pathTracer) return;
		app.pathTracer.setMaxSamples(parseInt(samples.value, 10) || 0);
		app.pathTracer.reset();
	});

	// A uniform, so it applies without a recompile; reset because samples
	// clamped differently must not mix with the old accumulation.
	firefly.addEventListener('input', function () {
		const v = parseFloat(firefly.value) || 0;
		fireflyOut.textContent = String(v);
		if (!app.pathTracer) return;
		app.pathTracer.options.fireflyClamp = v;
		app.pathTracer.reset();
	});

	// 0 = non-deterministic; a positive seed replays the same samples.
	seed.addEventListener('change', function () {
		if (!app.pathTracer || !app.pathTracer.setSeed) return;
		const v = parseInt(seed.value, 10) || 0;
		app.pathTracer.setSeed(v);
		status.set('seed ' + v + (v > 0 ? ' (reproducible)' : ' (random)'));
	});

	post.addEventListener('change', function () {
		if (!app.pathTracer) return;
		if (post.checked) {
			app.pathTracer.addPostProcess(vignettePass);
		} else {
			app.pathTracer.removePostProcess(vignettePass);
		}
	});
	postAmt.addEventListener('input', function () {
		postOut.textContent = parseFloat(postAmt.value).toFixed(2);
	});

	atrousToggle.addEventListener('change', applyATrous);
	atrousIters.addEventListener('change', tuneATrous);
	[phiN, phiA, phiD].forEach(function (el) {
		el.addEventListener('input', tuneATrous);
	});

	res.addEventListener('input', function () {
		if (!app.pathTracer) return;
		app.pathTracer.options.resolutionScale = parseFloat(res.value);
		app.pathTracer.resize();
		app.pathTracer.reset();
	});

	lights.addEventListener('change', function () {
		app.showLights = lights.checked;
		if (app.pathTracer) app.pathTracer.reset();
	});
	icons.addEventListener('change', function () {
		lightIcons.setVisible(icons.checked);
	});

	// Worker ingest is on by default; toggling re-ingests so the main-thread
	// watchdog in test.html shows the difference.
	workerToggle.addEventListener('change', function () {
		if (app.setWorker) app.setWorker(workerToggle.checked);
		forceReingest();
	});

	// Forces the first-hit AOV pass to compose and run with an identity denoise
	// hook: the image must stay identical, and any AOV shader compile error shows
	// up in the console.
	aovsToggle.addEventListener('change', function () {
		const pt = app.pathTracer;
		if (!pt || !pt.setDenoise) return;
		pt.setDenoise(aovsToggle.checked ? function () { return null; } : null);
		status.set(aovsToggle.checked ? 'AOVs on (identity denoise)' : 'AOVs off');
	});

	env.addEventListener('change', async function () {
		setEnvironment(env.value);
		await forceReingest();
	});

	material.addEventListener('change', showMaterialValues);
	metal.addEventListener('input', function () {
		setMaterialValue('metallic', parseFloat(metal.value), metalOut);
	});
	rough.addEventListener('input', function () {
		setMaterialValue('roughness', parseFloat(rough.value), roughOut);
	});
	showMaterialValues();

	document.getElementById('uiReset').addEventListener('click', function () {
		if (app.pathTracer) app.pathTracer.reset();
	});
	document.getElementById('uiRebuild').addEventListener('click', function () {
		forceReingest();
	});
	// Dumps the current image as PNG; includes the AOVs when the AOV test toggle
	// is on (which is what enables them).
	document.getElementById('uiExport').addEventListener('click', function () {
		const pt = app.pathTracer;
		if (!pt || !pt.exportImage) return;
		status.set('exporting PNG…');
		pt.exportImage({
			download: true,
			aovs: aovsToggle.checked,
			filename: 'pathtrace',
			aovDepthFar: 20
		}).then(function (images) {
			status.set('exported ' + Object.keys(images).join(', '));
		}).catch(function (e) {
			status.set('export failed: ' + (e && e.message ? e.message : e));
		});
	});

	return {
		applyUISettings: applyUISettings,
		attachStatus: attachStatus,
		forceReingest: forceReingest,
		updateLightIcons: lightIcons.update
	};
}
