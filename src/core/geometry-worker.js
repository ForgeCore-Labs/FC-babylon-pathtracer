// pt_lib — geometry Web Worker.
//
// Offloads the expensive half of scene ingestion (world-space packing + tangent
// frames + the BVH build) to a worker so a large scene does not freeze the main
// thread. The synchronous path stays the default and the reference
// implementation; this module is opt-in via `worker: true`.
//
// Design (option A — shim, no rewrite): the worker bootstrap defines a minimal
// `BABYLON.Vector3` covering exactly the methods the packing pass and the BVH
// builder use, then importScripts() those two existing sources verbatim. There
// is therefore one implementation of the geometry-critical code, not a second
// copy that can drift.
//
// Load order: after Babylon.js (main-thread path) and alongside
// src/core/geometry-packing.js. The BVH builder arrives with pt_lib.core.js.
//
// Browser-only: `new Worker(blobURL)` cannot run in the node test environment,
// so tools/test-worker.mjs exercises the pure packing + the shim instead.

(function (root) {
	'use strict';

	var PT_LIB = (root.PT_LIB = root.PT_LIB || {});

	// Absolute URL of this script, used to resolve the worker's importScripts
	// targets relative to it. Classic <script src> only; a bundler (or a page
	// that moved these files) can override with
	//   PT_LIB.geometryWorker.configure({ packing: url, bvh: url })
	var SELF_URL = '';
	if (
		typeof document !== 'undefined' &&
		document.currentScript &&
		document.currentScript.src
	) {
		SELF_URL = document.currentScript.src;
	}

	function resolveFromSelf(relative) {
		if (!SELF_URL) return '';
		try {
			return new URL(relative, SELF_URL).href;
		} catch (e) {
			return '';
		}
	}

	var scripts = {
		packing: resolveFromSelf('geometry-packing.js'),
		bvh: resolveFromSelf('bvh/BVH_SAH_Quality_Builder.js')
	};

	// Alternative to the URLs: the source text itself. A bundled build (ESM / IIFE)
	// has no sibling files to importScripts, so tools/build-dist.mjs inlines the
	// two sources here.
	var inline = { packing: '', bvh: '' };

	function hasSources() {
		return (
			(!!scripts.packing && !!scripts.bvh) ||
			(!!inline.packing && !!inline.bvh)
		);
	}

	// ---- minimal BABYLON.Vector3 for the worker -------------------------
	// Kept as real, callable code so tests can use it directly; the worker
	// bootstrap stringifies it. Must not reference anything outside itself.
	function installBabylonVectorShim(scope) {
		function Vector3(x, y, z) {
			this.x = x || 0;
			this.y = y || 0;
			this.z = z || 0;
		}

		Vector3.prototype.set = function (x, y, z) {
			this.x = x;
			this.y = y;
			this.z = z;
			return this;
		};
		Vector3.prototype.copyFrom = function (other) {
			this.x = other.x;
			this.y = other.y;
			this.z = other.z;
			return this;
		};
		Vector3.prototype.copyFromFloats = function (x, y, z) {
			this.x = x;
			this.y = y;
			this.z = z;
			return this;
		};
		Vector3.prototype.lengthSquared = function () {
			return this.x * this.x + this.y * this.y + this.z * this.z;
		};
		Vector3.prototype.normalize = function () {
			var len = Math.sqrt(
				this.x * this.x + this.y * this.y + this.z * this.z
			);
			if (len === 0) return this;
			var num = 1.0 / len;
			this.x *= num;
			this.y *= num;
			this.z *= num;
			return this;
		};
		Vector3.prototype.subtractToRef = function (other, result) {
			result.x = this.x - other.x;
			result.y = this.y - other.y;
			result.z = this.z - other.z;
			return this;
		};
		Vector3.prototype.minimizeInPlace = function (other) {
			if (other.x < this.x) this.x = other.x;
			if (other.y < this.y) this.y = other.y;
			if (other.z < this.z) this.z = other.z;
			return this;
		};
		Vector3.prototype.maximizeInPlace = function (other) {
			if (other.x > this.x) this.x = other.x;
			if (other.y > this.y) this.y = other.y;
			if (other.z > this.z) this.z = other.z;
			return this;
		};
		Vector3.prototype.addInPlace = function (other) {
			this.x += other.x;
			this.y += other.y;
			this.z += other.z;
			return this;
		};
		Vector3.prototype.scaleInPlace = function (scale) {
			this.x *= scale;
			this.y *= scale;
			this.z *= scale;
			return this;
		};

		// Same math and operation order as Babylon's Vector3 statics, so the
		// packed arrays are bit-identical to the main-thread path. `transformation`
		// is either a Babylon Matrix (has `.m`) or a plain 16-float array.
		Vector3.TransformCoordinates = function (vector, transformation) {
			var m = transformation.m || transformation;
			var x = vector.x * m[0] + vector.y * m[4] + vector.z * m[8] + m[12];
			var y = vector.x * m[1] + vector.y * m[5] + vector.z * m[9] + m[13];
			var z = vector.x * m[2] + vector.y * m[6] + vector.z * m[10] + m[14];
			var w = vector.x * m[3] + vector.y * m[7] + vector.z * m[11] + m[15];
			if (w !== 1) {
				x /= w;
				y /= w;
				z /= w;
			}
			return new Vector3(x, y, z);
		};
		Vector3.TransformNormal = function (vector, transformation) {
			var m = transformation.m || transformation;
			var x = vector.x * m[0] + vector.y * m[4] + vector.z * m[8];
			var y = vector.x * m[1] + vector.y * m[5] + vector.z * m[9];
			var z = vector.x * m[2] + vector.y * m[6] + vector.z * m[10];
			return new Vector3(x, y, z);
		};
		Vector3.CrossToRef = function (left, right, result) {
			var x = left.y * right.z - left.z * right.y;
			var y = left.z * right.x - left.x * right.z;
			var z = left.x * right.y - left.y * right.x;
			result.x = x;
			result.y = y;
			result.z = z;
			return result;
		};

		if (!scope.BABYLON) scope.BABYLON = {};
		scope.BABYLON.Vector3 = Vector3;
		return Vector3;
	}

	// ---- worker dispatcher ---------------------------------------------
	// Stringified into the worker after the shim + importScripts. Must not
	// reference anything outside itself.
	function geometryWorkerMain() {
		self.onmessage = function (event) {
			var msg = event.data;
			if (!msg || msg.type !== 'pack') return;
			try {
				var packed = self.PT_PackGeometry(
					msg.meshData,
					msg.totalTriangles,
					msg.rows,
					function (progress) {
						self.postMessage({
							type: 'progress',
							id: msg.id,
							progress: progress
						});
					}
				);
				self.postMessage(
					{
						type: 'done',
						id: msg.id,
						triangleArray: packed.triangleArray.buffer,
						aabbArray: packed.aabbArray.buffer
					},
					[packed.triangleArray.buffer, packed.aabbArray.buffer]
				);
			} catch (e) {
				self.postMessage({
					type: 'error',
					id: msg.id,
					message: e && e.message ? e.message : String(e)
				});
			}
		};
	}

	function buildWorkerSource() {
		var body = inline.packing && inline.bvh
			? [
				'// ---- src/core/geometry-packing.js (inlined by build-dist) ----',
				inline.packing,
				'// ---- src/core/bvh/BVH_SAH_Quality_Builder.js (inlined) ----',
				inline.bvh
			].join('\n')
			: 'importScripts(' +
				JSON.stringify(scripts.packing) + ', ' +
				JSON.stringify(scripts.bvh) +
			');';
		return [
			'// pt_lib geometry worker — GENERATED from src/core/geometry-worker.js.',
			'// Shim for the Babylon calls the packing + BVH sources make, then those',
			'// sources, then the message dispatcher.',
			'(' + installBabylonVectorShim.toString() + ')(self);',
			body,
			'(' + geometryWorkerMain.toString() + ')();'
		].join('\n');
	}

	// ---- main-thread bridge ---------------------------------------------

	var worker = null;
	var workerUrl = null;
	var workerFailed = false;
	var workerStartWarned = false;
	var nextId = 0;
	var pending = {};

	function workerAvailable() {
		return (
			typeof Worker === 'function' &&
			typeof Blob === 'function' &&
			typeof URL !== 'undefined' &&
			typeof URL.createObjectURL === 'function' &&
			hasSources()
		);
	}

	function failPending(message) {
		var ids = Object.keys(pending);
		for (var i = 0; i < ids.length; i++) {
			var entry = pending[ids[i]];
			delete pending[ids[i]];
			entry.reject(new Error(message));
		}
	}

	function ensureWorker() {
		if (worker) return worker;
		if (!workerAvailable()) {
			throw new Error('geometry worker is unavailable in this environment');
		}
		var blob = new Blob([buildWorkerSource()], { type: 'text/javascript' });
		workerUrl = URL.createObjectURL(blob);
		worker = new Worker(workerUrl);
		worker.onmessage = function (event) {
			handleMessage(event.data);
		};
		worker.onerror = function (event) {
			// A bad importScripts URL (or a syntax error in a source) kills the
			// worker for good. Surface it once and let callers fall back.
			workerFailed = true;
			var message =
				(event && event.message) || 'geometry worker failed to load';
			failPending(message);
			if (event && typeof event.preventDefault === 'function') {
				event.preventDefault();
			}
			console.error('[pt_lib] geometry worker:', message);
		};
		return worker;
	}

	function handleMessage(msg) {
		if (!msg) return;
		var entry = msg.id !== undefined ? pending[msg.id] : null;

		if (msg.type === 'progress') {
			if (entry && entry.onProgress) entry.onProgress(msg.progress);
			return;
		}
		if (!entry) return;
		delete pending[msg.id];

		if (msg.type === 'error') {
			entry.reject(new Error(msg.message));
			return;
		}
		if (msg.type === 'done') {
			entry.resolve({
				triangleArray: new Float32Array(msg.triangleArray),
				aabbArray: new Float32Array(msg.aabbArray)
			});
		}
	}

	// Packs on the worker, or synchronously when a worker is unavailable or has
	// failed. `meshData` is structured-cloned (not transferred), so a worker
	// failure can still fall back to the synchronous path with the data intact.
	function packGeometry(meshData, totalTriangles, rows, options) {
		options = options || {};
		var onProgress = options.onProgress || null;

		function runSync() {
			if (typeof PT_PackGeometry !== 'function') {
				throw new Error(
					'[pt_lib] Load src/core/geometry-packing.js for the packing path'
				);
			}
			return PT_PackGeometry(meshData, totalTriangles, rows, onProgress);
		}

		if (workerFailed || !workerAvailable()) {
			return Promise.resolve().then(runSync);
		}

		var id = ++nextId;
		return new Promise(function (resolve, reject) {
			var w;
			try {
				w = ensureWorker();
			} catch (e) {
				// Not a data problem: the worker cannot be constructed at all (e.g. a
				// file:// page, where a blob worker may not importScripts file URLs).
				if (!workerStartWarned) {
					workerStartWarned = true;
					console.warn(
						'[pt_lib] geometry worker could not start (' + e.message +
						'); using the synchronous path.'
					);
				}
				resolve(runSync());
				return;
			}
			pending[id] = {
				resolve: resolve,
				reject: reject,
				onProgress: onProgress
			};
			w.postMessage({
				type: 'pack',
				id: id,
				meshData: meshData,
				totalTriangles: totalTriangles,
				rows: rows
			});
		}).catch(function (error) {
			console.warn(
				'[pt_lib] geometry worker failed (' + error.message +
				'); using the synchronous path.'
			);
			workerFailed = true;
			if (worker) {
				worker.terminate();
				worker = null;
			}
			return runSync();
		});
	}

	function dispose() {
		if (worker) {
			worker.terminate();
			worker = null;
		}
		if (workerUrl) {
			URL.revokeObjectURL(workerUrl);
			workerUrl = null;
		}
		failPending('geometry worker disposed');
	}

	PT_LIB.geometryWorker = {
		// Resolved from this script's URL; override for bundlers / relocated files.
		scripts: scripts,
		configure: function (opts) {
			opts = opts || {};
			if (opts.packing) scripts.packing = opts.packing;
			if (opts.bvh) scripts.bvh = opts.bvh;
			if (opts.packingSource) inline.packing = String(opts.packingSource);
			if (opts.bvhSource) inline.bvh = String(opts.bvhSource);
			workerFailed = false;
			workerStartWarned = false;
		},
		// True when the worker bootstrap will inline the sources instead of
		// importScripts-ing sibling files (bundled builds).
		isInline: function () {
			return !!(inline.packing && inline.bvh);
		},
		// Exposed for tests and for inspecting the generated bootstrap.
		installBabylonVectorShim: installBabylonVectorShim,
		workerSource: buildWorkerSource,
		isAvailable: workerAvailable,
		packGeometry: packGeometry,
		dispose: dispose
	};
})(typeof window !== 'undefined' ? window : globalThis);
