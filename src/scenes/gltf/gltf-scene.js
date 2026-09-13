// pt_lib — glTF scene adapter.
//
// Port of the scene-specific half of the original js/GLTF_Model_Path_Tracing.js:
// loads a glTF/glb model, packs its triangles + per-triangle AABBs into float
// textures, builds the BVH, and drives PT_LIB.PathTracer with the scene's
// uniforms and samplers.
//
// All generic work (render targets, passes, accumulation, loop) lives in
// PathTracer. This file only describes the scene.
//
// Usage (classic scripts, after PathTracer is loaded):
//   const app = PT_LIB.scenes.gltf.create(canvas, { modelFile: "polident.gltf" });

(function (root) {
	'use strict';

	var PT_LIB = (root.PT_LIB = root.PT_LIB || {});
	PT_LIB.scenes = PT_LIB.scenes || {};

	var DEFAULTS = {
		modelRoot: './model/box/',
		modelFile: 'polident.gltf',
		modelScale: 2,
		blueNoiseFile: './textures/BlueNoise_RGBA256.png',

		resolutionScale: 0.95,
		maxSamples: 0, // 0 = converge indefinitely

		cameraPosition: [0, -20, -120],
		focusDistance: 113.0,
		apertureSize: 0.0,

		epsIntersect: 0.01,
		quadLightPlaneSelectionNumber: 6,
		quadLightRadius: 50,
		modelMaterialType: 3, // 3 = METAL

		sphereRadius: 10,
		wallRadius: 50,

		sunRotateXDeg: 298,
		sunRotateYDeg: 318
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
		if (!PT_LIB.PathTracer) {
			throw new Error('[pt_lib] Load src/PathTracer.js before the scene adapter');
		}

		var opts = assign(assign({}, DEFAULTS), options || {});

		// ------------------------------------------------------------ engine
		var engine = new BABYLON.Engine(canvas, true);
		var scene = new BABYLON.Scene(engine);

		var camera = new BABYLON.UniversalCamera(
			'camera',
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
		var uULen = uVLen * (engine.getRenderWidth() / engine.getRenderHeight());

		// ------------------------------------------------------- scene state
		var state = {
			mesh: null,
			triangleCount: 0,
			aabbDataTexture: null,
			triangleDataTexture: null,
			albedoTexture: null,
			bumpTexture: null,
			metallicTexture: null,
			emissiveTexture: null,
			modelUsesAlbedo: false,
			isPrepared: false
		};

		// Transform nodes: the two analytic spheres are pure shader math (no
		// mesh), and the glTF model gets its own node.
		var sphereRadius = opts.sphereRadius;
		var wallRadius = opts.wallRadius;

		var leftSphereTransformNode = new BABYLON.TransformNode('leftSphere');
		var rightSphereTransformNode = new BABYLON.TransformNode('rightSphere');
		var gltfModelTransformNode = new BABYLON.TransformNode('gltfModel');
		var sunTransformNode = new BABYLON.TransformNode('sun');

		leftSphereTransformNode.position.set(
			-wallRadius * 0.45,
			-wallRadius + sphereRadius + 0.1,
			-wallRadius * 0.2
		);
		leftSphereTransformNode.scaling.set(sphereRadius, sphereRadius, sphereRadius);

		rightSphereTransformNode.position.set(
			wallRadius * 0.45,
			-wallRadius + sphereRadius + 0.1,
			-wallRadius * 0.2
		);
		rightSphereTransformNode.scaling.set(sphereRadius, sphereRadius, sphereRadius);

		var uLeftSphereInvMatrix = new BABYLON.Matrix();
		var uRightSphereInvMatrix = new BABYLON.Matrix();
		leftSphereTransformNode.computeWorldMatrix(true);
		uLeftSphereInvMatrix.copyFrom(leftSphereTransformNode.getWorldMatrix());
		uLeftSphereInvMatrix.invert();
		rightSphereTransformNode.computeWorldMatrix(true);
		uRightSphereInvMatrix.copyFrom(rightSphereTransformNode.getWorldMatrix());
		uRightSphereInvMatrix.invert();

		gltfModelTransformNode.scaling.set(0, 0, 0); // hidden until prepared
		gltfModelTransformNode.rotation.y = Math.PI * 1.5; // 270 degrees, as the demo

		sunTransformNode.rotation.set(
			opts.sunRotateXDeg * (Math.PI / 180),
			opts.sunRotateYDeg * (Math.PI / 180),
			0
		);

		// ----------------------------------------------------------- textures
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

		// 1x1 white fallback so material samplers are always bindable.
		var fallbackTexture = BABYLON.RawTexture.CreateRGBATexture(
			new Uint8Array([255, 255, 255, 255]),
			1,
			1,
			scene
		);

		// --------------------------------------------------------- path tracer
		var rawShader = PT_LIB.glsl && PT_LIB.glsl.scenes && PT_LIB.glsl.scenes['gltf'];
		if (!rawShader) {
			throw new Error(
				"[pt_lib] Scene shader 'gltf' is not registered. Load " +
					'src/scenes/gltf/GLTFModelPathTracing_FragmentShader.js first.'
			);
		}

		var pt = new PT_LIB.PathTracer('pathTracer', scene, {
			resolutionScale: opts.resolutionScale,
			maxSamples: opts.maxSamples,
			sceneIsDynamic: false,
			toneMappingExposure: 1.0
		});

		var modelInvMatrix = new BABYLON.Matrix();

		pt.setShader({
			source: rawShader,
			uniforms: {
				uULen: function () {
					return uULen;
				},
				uVLen: function () {
					return uVLen;
				},
				uEPS_intersect: opts.epsIntersect,
				uApertureSize: opts.apertureSize,
				uFocusDistance: opts.focusDistance,
				uQuadLightPlaneSelectionNumber: opts.quadLightPlaneSelectionNumber,
				uQuadLightRadius: opts.quadLightRadius,
				uModelMaterialType: opts.modelMaterialType,
				uLeftSphereInvMatrix: uLeftSphereInvMatrix,
				uRightSphereInvMatrix: uRightSphereInvMatrix,
				uGLTF_Model_InvMatrix: function () {
					gltfModelTransformNode.computeWorldMatrix(true);
					modelInvMatrix.copyFrom(gltfModelTransformNode.getWorldMatrix());
					modelInvMatrix.invert();
					return modelInvMatrix;
				},
				uModelUsesAlbedoTexture: function () {
					return state.modelUsesAlbedo;
				},
				uModelUsesBumpTexture: false,
				uModelUsesMetallicTexture: false,
				uModelUsesEmissiveTexture: false,
				uSunDirection: function () {
					return sunTransformNode.forward;
				}
			},
			samplers: {
				blueNoiseTexture: blueNoiseTexture,
				tAABBTexture: function () {
					return state.aabbDataTexture || fallbackTexture;
				},
				tTriangleTexture: function () {
					return state.triangleDataTexture || fallbackTexture;
				},
				tAlbedoTexture: function () {
					return state.albedoTexture || fallbackTexture;
				},
				tBumpTexture: function () {
					return state.bumpTexture || fallbackTexture;
				},
				tMetallicTexture: function () {
					return state.metallicTexture || fallbackTexture;
				},
				tEmissiveTexture: function () {
					return state.emissiveTexture || fallbackTexture;
				}
			}
		});

		// Keep uULen/uVLen in sync with the camera FOV.
		pt.options.onFrame = function () {
			var aspect = engine.getRenderWidth() / engine.getRenderHeight();
			var vLen = Math.tan(camera.fov * 0.5);
			if (vLen !== uVLen) {
				uVLen = vLen;
				uULen = uVLen * aspect;
			}
		};

		// ------------------------------------------------- geometry packing

		// Packs triangle vertex data (32 floats/triangle) and per-triangle AABBs
		// (9 floats/triangle) into Float32Arrays, then builds the BVH in place
		// and uploads both to 2048x2048 RGBA float textures.
		function prepareModelForPathTracing() {
			var mesh = state.mesh;
			var triangleCount = state.triangleCount;

			if (triangleCount * 32 > 2048 * 2048 * 4) {
				throw new Error(
					'[pt_lib] Model too large: ' +
						triangleCount +
						' triangles exceeds the geometry texture capacity.'
				);
			}

			var totalWork = new Uint32Array(triangleCount);
			var triangleArray = new Float32Array(2048 * 2048 * 4);
			var aabbArray = new Float32Array(2048 * 2048 * 4);

			var vp0 = new BABYLON.Vector3();
			var vp1 = new BABYLON.Vector3();
			var vp2 = new BABYLON.Vector3();
			var vn0 = new BABYLON.Vector3();
			var vn1 = new BABYLON.Vector3();
			var vn2 = new BABYLON.Vector3();
			var vt0 = new BABYLON.Vector2();
			var vt1 = new BABYLON.Vector2();
			var vt2 = new BABYLON.Vector2();

			var bbMin = new BABYLON.Vector3();
			var bbMax = new BABYLON.Vector3();
			var bbCentroid = new BABYLON.Vector3();

			var positions = new Float32Array(mesh.getVerticesData('position'));
			var normals = new Float32Array(mesh.getVerticesData('normal'));

			var uvs = null;
			var hasUVs = false;
			if (mesh.getVerticesDataKinds().length === 3) {
				uvs = new Float32Array(mesh.getVerticesData('uv'));
				hasUVs = true;
			}

			for (var i = 0; i < triangleCount; i++) {
				bbMin.set(Infinity, Infinity, Infinity);
				bbMax.set(-Infinity, -Infinity, -Infinity);

				if (hasUVs) {
					vt0.set(uvs[6 * i + 0], uvs[6 * i + 1]);
					vt2.set(uvs[6 * i + 2], uvs[6 * i + 3]);
					vt1.set(uvs[6 * i + 4], uvs[6 * i + 5]);
				} else {
					vt0.set(-1, -1);
					vt1.set(-1, -1);
					vt2.set(-1, -1);
				}

				vn0.set(normals[9 * i + 0], normals[9 * i + 1], normals[9 * i + 2]);
				vn2.set(normals[9 * i + 3], normals[9 * i + 4], normals[9 * i + 5]);
				vn1.set(normals[9 * i + 6], normals[9 * i + 7], normals[9 * i + 8]);

				vn0.x *= -1; vn0.z *= -1;
				vn1.x *= -1; vn1.z *= -1;
				vn2.x *= -1; vn2.z *= -1;
				vn0.normalize();
				vn1.normalize();
				vn2.normalize();

				vp0.set(positions[9 * i + 0], positions[9 * i + 1], positions[9 * i + 2]);
				vp2.set(positions[9 * i + 3], positions[9 * i + 4], positions[9 * i + 5]);
				vp1.set(positions[9 * i + 6], positions[9 * i + 7], positions[9 * i + 8]);

				vp0.x *= -1; vp0.z *= -1;
				vp1.x *= -1; vp1.z *= -1;
				vp2.x *= -1; vp2.z *= -1;

				vp0.scaleInPlace(opts.modelScale);
				vp1.scaleInPlace(opts.modelScale);
				vp2.scaleInPlace(opts.modelScale);

				// slot 0
				triangleArray[32 * i + 0] = vp0.x;
				triangleArray[32 * i + 1] = vp0.y;
				triangleArray[32 * i + 2] = vp0.z;
				triangleArray[32 * i + 3] = vp1.x;
				// slot 1
				triangleArray[32 * i + 4] = vp1.y;
				triangleArray[32 * i + 5] = vp1.z;
				triangleArray[32 * i + 6] = vp2.x;
				triangleArray[32 * i + 7] = vp2.y;
				// slot 2
				triangleArray[32 * i + 8] = vp2.z;
				triangleArray[32 * i + 9] = vn0.x;
				triangleArray[32 * i + 10] = vn0.y;
				triangleArray[32 * i + 11] = vn0.z;
				// slot 3
				triangleArray[32 * i + 12] = vn1.x;
				triangleArray[32 * i + 13] = vn1.y;
				triangleArray[32 * i + 14] = vn1.z;
				triangleArray[32 * i + 15] = vn2.x;
				// slot 4
				triangleArray[32 * i + 16] = vn2.y;
				triangleArray[32 * i + 17] = vn2.z;
				triangleArray[32 * i + 18] = vt0.x;
				triangleArray[32 * i + 19] = vt0.y;
				// slot 5
				triangleArray[32 * i + 20] = vt1.x;
				triangleArray[32 * i + 21] = vt1.y;
				triangleArray[32 * i + 22] = vt2.x;
				triangleArray[32 * i + 23] = vt2.y;

				bbMin.copyFrom(bbMin.minimizeInPlace(vp0));
				bbMax.copyFrom(bbMax.maximizeInPlace(vp0));
				bbMin.copyFrom(bbMin.minimizeInPlace(vp1));
				bbMax.copyFrom(bbMax.maximizeInPlace(vp1));
				bbMin.copyFrom(bbMin.minimizeInPlace(vp2));
				bbMax.copyFrom(bbMax.maximizeInPlace(vp2));

				bbCentroid.set(
					(bbMin.x + bbMax.x) * 0.5,
					(bbMin.y + bbMax.y) * 0.5,
					(bbMin.z + bbMax.z) * 0.5
				);

				aabbArray[9 * i + 0] = bbMin.x;
				aabbArray[9 * i + 1] = bbMin.y;
				aabbArray[9 * i + 2] = bbMin.z;
				aabbArray[9 * i + 3] = bbMax.x;
				aabbArray[9 * i + 4] = bbMax.y;
				aabbArray[9 * i + 5] = bbMax.z;
				aabbArray[9 * i + 6] = bbCentroid.x;
				aabbArray[9 * i + 7] = bbCentroid.y;
				aabbArray[9 * i + 8] = bbCentroid.z;

				totalWork[i] = i;
			}

			// Build the BVH; the builder rewrites aabbArray into its flat node layout.
			BVH_Build_Iterative(totalWork, aabbArray);

			state.aabbDataTexture = BABYLON.RawTexture.CreateRGBATexture(
				aabbArray, 2048, 2048, scene, false, false,
				BABYLON.Constants.TEXTURE_NEAREST_SAMPLINGMODE,
				BABYLON.Constants.TEXTURETYPE_FLOAT
			);

			state.triangleDataTexture = BABYLON.RawTexture.CreateRGBATexture(
				triangleArray, 2048, 2048, scene, false, false,
				BABYLON.Constants.TEXTURE_NEAREST_SAMPLINGMODE,
				BABYLON.Constants.TEXTURETYPE_FLOAT
			);

			gltfModelTransformNode.scaling.set(
				opts.modelScale,
				opts.modelScale,
				opts.modelScale
			);
			gltfModelTransformNode.position.z = 25;
			state.isPrepared = true;
		}

		function loadModel() {
			BABYLON.SceneLoader.LoadAssetContainer(
				opts.modelRoot,
				opts.modelFile,
				scene,
				function (container) {
					var geometryMeshes = [];
					for (var i = 0; i < container.meshes.length; i++) {
						if (container.meshes[i].geometry) {
							geometryMeshes.push(container.meshes[i]);
						}
					}

					var mesh;
					if (container.meshes.length > 1) {
						mesh = BABYLON.Mesh.MergeMeshes(geometryMeshes, true, true);
					} else {
						mesh = container.meshes[0];
					}

					mesh.isVisible = false;

					if (mesh.getTotalIndices() !== mesh.getTotalVertices()) {
						mesh.convertToUnIndexedMesh();
					}

					state.mesh = mesh;
					state.triangleCount = mesh.getTotalVertices() / 3;

					if (mesh.material && mesh.material.albedoTexture) {
						state.albedoTexture = mesh.material.albedoTexture;
						state.modelUsesAlbedo = true;
					}

					prepareModelForPathTracing();

					if (infoElement) {
						infoElement.innerHTML =
							'pt_lib — ' +
							state.triangleCount.toFixed(0) +
							' triangles<br>Samples: ' +
							pt.samples;
					}

					pt.start();
				},
				function (_scene, message) {
					if (pt.onErrorObservable) {
						pt.onErrorObservable.notifyObservers(message);
					}
					console.error('[pt_lib] glTF load failed: ' + message);
				}
			);
		}

		var infoElement = document.getElementById('info');

		pt.onProgressObservable.add(function (samples) {
			if (infoElement && state.isPrepared) {
				infoElement.innerHTML =
					'pt_lib — ' +
					state.triangleCount.toFixed(0) +
					' triangles<br>Samples: ' +
					samples;
			}
		});

		loadModel();

		return {
			engine: engine,
			scene: scene,
			camera: camera,
			pathTracer: pt,
			state: state,
			dispose: function () {
				pt.dispose();
				scene.dispose();
				engine.dispose();
			}
		};
	}

	PT_LIB.scenes.gltf = { create: create, DEFAULTS: DEFAULTS };
})(typeof window !== 'undefined' ? window : globalThis);
