// pt_lib — Babylon scene ingestion.
//
// Turns an ordinary Babylon scene into the data the universal path tracing
// shader needs:
//   * every traceable mesh -> world-space triangles packed into a flat array
//     (with a per-triangle material index), then a BVH over their AABBs
//   * every light          -> a light table (sphere/point, directional, ambient)
//   * every material       -> a material table (albedo, metallic, roughness, emission,
//     plus albedo / bump / metallic-roughness / emissive texture slots)
//
// Nothing here is scene-specific: create meshes with MeshBuilder, import glTF,
// add any Babylon light, and it is all picked up automatically.
//
// Requires the BVH builder global (BVH_Build_Iterative) from pt_lib.core.js and
// PT_PackGeometry from src/core/geometry-packing.js (the worker path additionally
// needs src/core/geometry-worker.js).

(function (root) {
	'use strict';

	var PT_LIB = (root.PT_LIB = root.PT_LIB || {});

	var TEXTURE_WIDTH = 2048;
	var TEXTURE_HEIGHT = 2048;
	var FLOATS_PER_TRIANGLE = 32; // 8 rgba texels
	var FLOATS_PER_AABB = 9;
	var BVH_FLOATS_PER_TRIANGLE = 16; // at most 2 BVH nodes per triangle, 8 floats each

	// light types used by the universal shader
	var LIGHT_SPHERE = 0; // point-ish light with inverse-square falloff
	var LIGHT_DIRECTIONAL = 1;
	var LIGHT_AMBIENT = 2;
	var LIGHT_SPOT = 3; // cone around a direction

	// Inputs we knowingly ignore. Warned once per session: ingestion re-runs on
	// every scene edit, so a per-call warning would spam the console.
	var warnedInputs = Object.create(null);

	function warnIgnoredInput(key, message) {
		if (warnedInputs[key] === true) {
			return;
		}
		warnedInputs[key] = true;
		console.warn('[pt_lib] ' + message);
	}

	function colorToArray(color, fallback) {
		if (color && typeof color.r === 'number') {
			return [color.r, color.g, color.b];
		}
		return fallback ? fallback.slice() : [1, 1, 1];
	}

	function mapMaterial(material) {
		var albedo = [0.8, 0.8, 0.8];
		var metallic = 0.0;
		var roughness = 1.0;
		var emissive = [0, 0, 0];
		var emissiveStrength = 0.0;
		var albedoTexture = null;
		var bumpTexture = null;
		var metallicTexture = null;
		var emissiveTexture = null;
		var bumpLevel = 1.0;
		// Babylon packs metallic in the blue channel and roughness in the green
		// channel of metallicTexture (glTF ORM: R = occlusion, G = roughness,
		// B = metallic). Both can be disabled per material.
		var metallicFromBlue = true;
		var roughnessFromGreen = true;

		if (material) {
			// PBRMaterial uses albedoTexture, StandardMaterial uses diffuseTexture
			albedoTexture = material.albedoTexture || material.diffuseTexture || null;
			bumpTexture = material.bumpTexture || null;
			metallicTexture = material.metallicTexture || null;
			emissiveTexture = material.emissiveTexture || null;

			if (bumpTexture && typeof bumpTexture.level === 'number') {
				bumpLevel = bumpTexture.level;
			}
			// Normal-map axis inversion is not applied: the tangent frame is derived
			// from the geometry, and the map is used as authored.
			if (
				material.invertNormalMapX === true ||
				material.invertNormalMapY === true ||
				(bumpTexture &&
					(bumpTexture.invertNormalMapX === true ||
						bumpTexture.invertNormalMapY === true))
			) {
				warnIgnoredInput(
					'invertNormalMap',
					'invertNormalMapX/Y is ignored — bump / normal maps use the ' +
						'generated tangent frame as-is.'
				);
			}
			if (material.useMetallnessFromMetallicTextureBlue === false) {
				metallicFromBlue = false;
			}
			if (material.useRoughnessFromMetallicTextureGreen === false) {
				roughnessFromGreen = false;
			}

			if (material.albedoColor) {
				albedo = colorToArray(material.albedoColor, albedo);
			} else if (material.diffuseColor) {
				albedo = colorToArray(material.diffuseColor, albedo);
			}
			if (typeof material.metallic === 'number') {
				metallic = material.metallic;
			}
			if (typeof material.roughness === 'number') {
				roughness = material.roughness;
			}
			if (material.emissiveColor) {
				emissive = colorToArray(material.emissiveColor, emissive);
			}
			// Only emissive when the colour is actually non-black. PBRMaterial
			// defaults emissiveIntensity to 1 even with a black emissiveColor, so
			// testing emissiveIntensity alone would mark every PBR surface as an
			// emitter. An emissive texture is enough on its own (its colour is
			// multiplied in by the shader; a black texture just adds nothing).
			if (
				emissive[0] + emissive[1] + emissive[2] > 0 ||
				emissiveTexture
			) {
				emissiveStrength =
					typeof material.emissiveIntensity === 'number' &&
					material.emissiveIntensity > 0
						? material.emissiveIntensity
						: 1.0;
			}
		}

		return {
			// the live Babylon material, so the adapter can refresh the scalar
			// fields per-frame without re-ingesting the scene
			source: material || null,
			albedo: albedo,
			metallic: metallic,
			roughness: roughness,
			emissive: emissive,
			emissiveStrength: emissiveStrength,
			// texture objects, resolved to pool slots during ingestion
			albedoTexture: albedoTexture,
			bumpTexture: bumpTexture,
			metallicTexture: metallicTexture,
			emissiveTexture: emissiveTexture,
			bumpLevel: bumpLevel,
			metallicFromBlue: metallicFromBlue,
			roughnessFromGreen: roughnessFromGreen,
			// pool slots (-1 = no texture / flat value)
			albedoSlot: -1,
			bumpSlot: -1,
			metallicSlot: -1,
			emissiveSlot: -1
		};
	}

	// Re-reads the scalar fields of already-mapped material records from their
	// live Babylon materials, leaving the resolved texture pool slots intact.
	// The adapter calls this each frame so a property tweak (albedo colour,
	// metallic, roughness, emissive, bump level…) is a texture upload rather
	// than a re-ingest + shader recompile.
	function refreshMaterialScalars(mats) {
		for (var i = 0; i < mats.length; i++) {
			var rec = mats[i];
			var fresh = mapMaterial(rec.source || null);
			rec.albedo = fresh.albedo;
			rec.metallic = fresh.metallic;
			rec.roughness = fresh.roughness;
			rec.emissive = fresh.emissive;
			rec.emissiveStrength = fresh.emissiveStrength;
			rec.albedoTexture = fresh.albedoTexture;
			rec.bumpTexture = fresh.bumpTexture;
			rec.metallicTexture = fresh.metallicTexture;
			rec.emissiveTexture = fresh.emissiveTexture;
			rec.bumpLevel = fresh.bumpLevel;
			rec.metallicFromBlue = fresh.metallicFromBlue;
			rec.roughnessFromGreen = fresh.roughnessFromGreen;
		}
		return mats;
	}

	function isTraceable(mesh) {
		if (!mesh || !mesh.geometry) return false;
		if (mesh.metadata && mesh.metadata.ptIgnore === true) return false;
		if (mesh.isVisible === false) return false;
		if (typeof mesh.isEnabled === 'function' && !mesh.isEnabled()) return false;
		return true;
	}

	function triangleCountOf(mesh) {
		var indices = mesh.getIndices();
		if (indices && indices.length) return indices.length / 3;
		var positions = mesh.getVerticesData('position');
		return positions ? positions.length / 9 : 0;
	}

	// `scene.environmentTexture` -> the data the shader needs to use it for
	// image-based lighting. kind: 1 = cube map, 2 = equirectangular 2D, 0 = none.
	function classifyEnvironment(scene) {
		var tex = scene ? scene.environmentTexture : null;
		if (!tex) return { texture: null, kind: 0, intensity: 1, maxLod: 0 };

		var isCube =
			tex.isCube === true ||
			(typeof BABYLON !== 'undefined' &&
				BABYLON.CubeTexture &&
				tex instanceof BABYLON.CubeTexture);

		var size = null;
		try {
			size = typeof tex.getSize === 'function' ? tex.getSize() : null;
		} catch (e) {
			size = null;
		}
		var maxDimension = size ? Math.max(size.width || 0, size.height || 0) : 0;
		var maxLod = maxDimension > 1 ? Math.log2(maxDimension) : 6;

		var intensity =
			typeof scene.environmentIntensity === 'number' && scene.environmentIntensity >= 0
				? scene.environmentIntensity
				: 1;

		return {
			texture: tex,
			kind: isCube ? 1 : 2,
			intensity: intensity,
			maxLod: maxLod
		};
	}

	// ---- lights ------------------------------------------------------------
	// Convert Babylon lights into the flat records the shader's light texture
	// consumes. Shared by the initial ingest and the per-frame light sync, so a
	// property tweak (intensity, colour, position…) is picked up without a BVH
	// rebuild or a shader recompile.
	function ingestLights(sceneLights) {
		var vector = BABYLON.Vector3;
		var lights = [];
		var ambient = [0.05, 0.05, 0.06];
		var i;

		for (i = 0; i < sceneLights.length; i++) {
			var light = sceneLights[i];
			if (typeof light.isEnabled === 'function' && !light.isEnabled()) continue;

			var intensity = typeof light.intensity === 'number' ? light.intensity : 1;
			var diffuse = light.diffuse || light.diffuseColor;
			var color = colorToArray(diffuse, [1, 1, 1]);

			if (light instanceof BABYLON.HemisphericLight) {
				ambient = [
					color[0] * intensity,
					color[1] * intensity,
					color[2] * intensity
				];
			} else if (light instanceof BABYLON.DirectionalLight) {
				var dir = light.direction || new vector(0, -1, 0);
				lights.push({
					type: LIGHT_DIRECTIONAL,
					direction: [dir.x, dir.y, dir.z],
					color: color,
					intensity: intensity
				});
			} else {
				var pos =
					typeof light.getAbsolutePosition === 'function'
						? light.getAbsolutePosition()
						: light.position || new vector(0, 0, 0);

				// SpotLight -> a true cone: only points inside the cone are lit, with
				// Babylon's exponent falloff and optional inner-angle softening.
				if (
					typeof BABYLON !== 'undefined' &&
					BABYLON.SpotLight &&
					light instanceof BABYLON.SpotLight
				) {
					var spotDir = light.direction || new vector(0, -1, 0);
					var angle =
						typeof light.angle === 'number' && light.angle > 0
							? light.angle
							: Math.PI / 3;
					var innerAngle =
						typeof light.innerAngle === 'number' ? light.innerAngle : 0;
					lights.push({
						type: LIGHT_SPOT,
						position: [pos.x, pos.y, pos.z],
						direction: [spotDir.x, spotDir.y, spotDir.z],
						color: color,
						intensity: intensity,
						cosOuter: Math.cos(angle),
						cosInner: innerAngle > 0 ? Math.cos(innerAngle) : -2,
						exponent:
							typeof light.exponent === 'number' && light.exponent > 0
								? light.exponent
								: 0
					});
				} else {
					// PointLight -> inverse-square emitter at a position
					lights.push({
						type: LIGHT_SPHERE,
						position: [pos.x, pos.y, pos.z],
						color: color,
						intensity: intensity
					});
				}
			}
		}

		return { lights: lights, ambient: ambient };
	}

	// Packs the light records into the float texture the shader samples: one
	// column per light, four rows — pos.xyz + type, direction, colour + power,
	// spot cone data. Rows keep the width equal to the light count, so the
	// texture stays far under any max-size limit.
	var LIGHT_TEXTURE_ROWS = 4;

	function writeTexel(array, width, x, y, r, g, b, a) {
		var base = (y * width + x) * 4;
		array[base] = r;
		array[base + 1] = g;
		array[base + 2] = b;
		array[base + 3] = a;
	}

	function buildLightData(lights) {
		var count = lights.length;
		var width = count > 0 ? count : 1; // dummy column when there are no lights
		var array = new Float32Array(width * LIGHT_TEXTURE_ROWS * 4);
		var i, l, p, d, c;

		for (i = 0; i < count; i++) {
			l = lights[i];
			p = l.position || [0, 0, 0];
			d = l.direction || [0, 0, 0];
			c = l.color || [1, 1, 1];

			writeTexel(array, width, i, 0, p[0], p[1], p[2], l.type);
			writeTexel(array, width, i, 1, d[0], d[1], d[2], 0);
			writeTexel(array, width, i, 2, c[0], c[1], c[2], l.intensity);
			if (l.type === LIGHT_SPOT) {
				writeTexel(array, width, i, 3, l.cosOuter, l.cosInner, l.exponent, 0);
			}
		}

		return {
			array: array,
			count: count,
			width: width,
			height: LIGHT_TEXTURE_ROWS
		};
	}

	// Pack the material records into a float texture the shader samples: one
	// column per material, five rows — albedo / metallic+roughness+emission+bump
	// level / emissive / texture-pool slots / channel flags. Rows keep the width
	// equal to the material count, mirroring the light texture layout.
	var MATERIAL_TEXTURE_ROWS = 5;

	function matSlot(m, prop) {
		var s = m[prop];
		if (s === undefined) s = m.textureSlot; // legacy field name
		return s === undefined ? -1 : s;
	}

	function buildMaterialData(mats) {
		var count = mats ? mats.length : 0;
		var width = count > 0 ? count : 1; // dummy column when empty
		var array = new Float32Array(width * MATERIAL_TEXTURE_ROWS * 4);
		var i, m, a, e, metallic, roughness, strength;

		for (i = 0; i < count; i++) {
			m = mats[i];
			a = m.albedo || [1, 1, 1];
			e = m.emissive || [0, 0, 0];
			metallic = typeof m.metallic === 'number' ? m.metallic : 0.0;
			roughness = typeof m.roughness === 'number' ? m.roughness : 1.0;
			strength = typeof m.emissiveStrength === 'number' ? m.emissiveStrength : 0.0;

			writeTexel(array, width, i, 0, a[0], a[1], a[2], 1.0);
			writeTexel(
				array, width, i, 1, metallic, roughness, strength,
				typeof m.bumpLevel === 'number' ? m.bumpLevel : 1.0
			);
			writeTexel(array, width, i, 2, e[0], e[1], e[2], 0.0);
			writeTexel(
				array, width, i, 3,
				matSlot(m, 'albedoSlot'), matSlot(m, 'bumpSlot'),
				matSlot(m, 'metallicSlot'), matSlot(m, 'emissiveSlot')
			);
			writeTexel(
				array, width, i, 4,
				m.metallicFromBlue === false ? 0.0 : 1.0,
				m.roughnessFromGreen === false ? 0.0 : 1.0, 0.0, 0.0
			);
		}

		return {
			array: array,
			count: count,
			width: width,
			height: MATERIAL_TEXTURE_ROWS
		};
	}

	// ---- geometry texture capacity --------------------------------------
	// Geometry spans two float textures of TEXTURE_WIDTH x TEXTURE_HEIGHT texels,
	// four floats each. The triangle array costs FLOATS_PER_TRIANGLE per triangle
	// and the BVH BVH_FLOATS_PER_TRIANGLE, so the triangle texture is always the
	// tighter limit.
	function geometryCapacity() {
		var floats = TEXTURE_WIDTH * TEXTURE_HEIGHT * 4;
		var triangleTextureMax = Math.floor(floats / FLOATS_PER_TRIANGLE);
		var bvhTextureMax = Math.floor(floats / BVH_FLOATS_PER_TRIANGLE);
		return {
			maxTriangles: Math.min(triangleTextureMax, bvhTextureMax),
			triangleTextureMaxTriangles: triangleTextureMax,
			bvhTextureMaxTriangles: bvhTextureMax,
			textureWidth: TEXTURE_WIDTH,
			textureHeight: TEXTURE_HEIGHT
		};
	}

	function geometryTextureRows(triangleCount) {
		var perRow = TEXTURE_WIDTH * 4;
		return {
			triangleRows: Math.max(
				1,
				Math.ceil((FLOATS_PER_TRIANGLE * triangleCount) / perRow)
			),
			bvhRows: Math.max(
				1,
				Math.ceil((BVH_FLOATS_PER_TRIANGLE * triangleCount) / perRow)
			)
		};
	}

	// Returns the row counts when the scene fits, otherwise throws an error that
	// says which texture ran out and what to do about it.
	function checkGeometryCapacity(triangleCount) {
		var rows = geometryTextureRows(triangleCount);
		if (rows.triangleRows <= TEXTURE_HEIGHT && rows.bvhRows <= TEXTURE_HEIGHT) {
			return rows;
		}

		var cap = geometryCapacity();
		var limit = rows.triangleRows > TEXTURE_HEIGHT ? 'triangle' : 'BVH';
		throw new Error(
			'[pt_lib] Geometry overflow: ' +
				triangleCount +
				' triangles need ' +
				rows.triangleRows +
				' triangle rows and ' +
				rows.bvhRows +
				' BVH rows, but the ' +
				TEXTURE_WIDTH +
				'x' +
				TEXTURE_HEIGHT +
				' geometry textures hold ' +
				TEXTURE_HEIGHT +
				' rows each. Capacity is ' +
				cap.maxTriangles +
				' triangles (' +
				cap.triangleTextureMaxTriangles +
				' triangle-texture, ' +
				cap.bvhTextureMaxTriangles +
				' BVH); the ' +
				limit +
				' texture is the limit. Reduce the triangle count (decimate the meshes ' +
				'or split the scene) or raise TEXTURE_HEIGHT in src/core/ingest.js.'
		);
	}

	function buildSceneInput(scene, options, copyForTransfer) {
		options = options || {};

		var meshes = scene.meshes || [];

		// ---- material table (deduped by material identity) --------------
		var materials = [];
		var materialIndex = new Map();

		function materialIndexOf(material) {
			if (!material) return 0;
			if (materialIndex.has(material)) return materialIndex.get(material);
			var index = materials.length;
			materials.push(mapMaterial(material));
			materialIndex.set(material, index);
			return index;
		}

		// ---- first pass: count triangles -------------------------------
		var totalTriangles = 0;
		var i;
		for (i = 0; i < meshes.length; i++) {
			if (isTraceable(meshes[i])) {
				totalTriangles += triangleCountOf(meshes[i]);
			}
		}
		materialIndexOf(null); // index 0 is always the fallback material

		// Size the geometry textures to THIS scene rather than always allocating
		// the full 2048x2048 (~67 MB per array), which made every re-ingest
		// expensive. Width stays 2048 because the shader's texel math assumes it.
		// Throws a clear, actionable error when the scene does not fit.
		var rows = checkGeometryCapacity(totalTriangles);

		// ---- second pass: gather plain mesh data -----------------------
		// World matrices are baked into the triangles, so they are computed here.
		// Vertex data is copied when it is going to a worker: transferring a view
		// into a Babylon buffer would detach the scene's own geometry.
		var meshData = [];

		function pushMeshData(positions, normals, uvs, indices, world, material, triangleCount) {
			meshData.push({
				positions: copyForTransfer ? positions.slice() : positions,
				normals: copyForTransfer && normals ? normals.slice() : (normals || null),
				uvs: copyForTransfer && uvs ? uvs.slice() : (uvs || null),
				indices: indices && indices.length
					? (copyForTransfer ? indices.slice() : indices)
					: null,
				matrix: copyForTransfer ? { m: world.m.slice() } : world,
				materialIndex: materialIndexOf(material),
				triangleCount: triangleCount
			});
		}

		// A glTF mesh with several primitives arrives as ONE Babylon mesh with
		// submeshes and a MultiMaterial. Taking one material per mesh would read the
		// MultiMaterial (no albedo/metallic/roughness) and flatten every primitive
		// onto the fallback material, so split those meshes into one entry per
		// submesh, each carrying its own sub-material and index range.
		function subMeshRange(sub) {
			var indexed = typeof sub.indexCount === 'number' && sub.indexCount > 0;
			return indexed
				? { start: sub.indexStart, count: sub.indexCount }
				: { start: sub.verticesStart, count: sub.verticesCount };
		}
		function subMeshTriangles(sub) {
			return Math.floor(subMeshRange(sub).count / 3);
		}

		for (i = 0; i < meshes.length; i++) {
			var mesh = meshes[i];
			if (!isTraceable(mesh)) continue;

			mesh.computeWorldMatrix(true);
			var world = mesh.getWorldMatrix();
			var positions = mesh.getVerticesData('position');
			var normals = mesh.getVerticesData('normal');
			var uvs = mesh.getVerticesData('uv');
			var indices = mesh.getIndices();

			var subMaterials = mesh.material ? mesh.material.subMaterials : null;
			var subs =
				subMaterials && subMaterials.length > 1 ? mesh.subMeshes || null : null;

			if (subs && subs.length > 0) {
				// Only trust the split when the submeshes cover the whole mesh,
				// otherwise the sum would not match the counted `totalTriangles`.
				var sum = 0;
				var s;
				for (s = 0; s < subs.length; s++) sum += subMeshTriangles(subs[s]);
				if (sum !== triangleCountOf(mesh)) subs = null;
			}

			if (subs) {
				if (!indices || !indices.length) {
					// Non-indexed: synthesize vertex ids so a submesh range can slice.
					var vertexCount = positions.length / 3;
					indices =
						vertexCount > 65535
							? new Uint32Array(vertexCount)
							: new Uint16Array(vertexCount);
					for (var v = 0; v < vertexCount; v++) indices[v] = v;
				}
				for (var n = 0; n < subs.length; n++) {
					var sub = subs[n];
					var range = subMeshRange(sub);
					var subMaterial =
						subMaterials[Math.min(sub.materialIndex, subMaterials.length - 1)];
					pushMeshData(
						positions,
						normals,
						uvs,
						indices.slice(range.start, range.start + range.count),
						world,
						subMaterial,
						subMeshTriangles(sub)
					);
				}
				continue;
			}

			pushMeshData(
				positions, normals, uvs, indices, world, mesh.material, triangleCountOf(mesh)
			);
		}

		return {
			meshData: meshData,
			materials: materials,
			totalTriangles: totalTriangles,
			rows: rows
		};
	}

	// The Babylon-light half of ingestion: lights, the shared texture pool and the
	// return value the adapter consumes. The heavy packing + BVH half lives in
	// src/core/geometry-packing.js so the worker can importScripts it verbatim.
	function assembleIngested(scene, options, input, packed) {
		options = options || {};

		var triangleArray = packed.triangleArray;
		var aabbArray = packed.aabbArray;
		var rows = input.rows;
		var totalTriangles = input.totalTriangles;
		var materials = input.materials;
		var i;

		// ---- lights ----------------------------------------------------
		var lightInfo = ingestLights(scene.lights || []);
		var lights = lightInfo.lights;
		var ambient = lightInfo.ambient;

		// ---- scene textures, one shared pool referenced by material slots ------
		// GLSL ES 3.0 cannot dynamically index a sampler array and WebGL2 only
		// guarantees 16 fragment texture units, so albedo / bump / metallic-roughness
		// / emissive maps all draw from a single pool. Each material records the pool
		// slot per channel (-1 = no texture, use the flat value).
		var MAX_TEXTURES =
			options.maxTextures > 0 ? options.maxTextures : 12;
		var textures = [];
		var textureSlots = new Map();
		var textureOverflowWarned = false;

		function textureSlotOf(tex) {
			if (!tex) return -1;
			if (textureSlots.has(tex)) return textureSlots.get(tex);
			if (textures.length >= MAX_TEXTURES) {
				if (!textureOverflowWarned) {
					console.warn(
						'[pt_lib] more than ' + MAX_TEXTURES +
						' distinct scene textures; extras fall back to flat values.'
					);
					textureOverflowWarned = true;
				}
				return -1;
			}
			textures.push(tex);
			var slot = textures.length - 1;
			textureSlots.set(tex, slot);
			return slot;
		}

		for (i = 0; i < materials.length; i++) {
			var mat = materials[i];
			mat.albedoSlot = textureSlotOf(mat.albedoTexture);
			mat.bumpSlot = textureSlotOf(mat.bumpTexture);
			mat.metallicSlot = textureSlotOf(mat.metallicTexture);
			mat.emissiveSlot = textureSlotOf(mat.emissiveTexture);
		}

		return {
			triangleArray: triangleArray,
			aabbArray: aabbArray,
			triangleTextureWidth: TEXTURE_WIDTH,
			triangleTextureHeight: rows.triangleRows,
			aabbTextureWidth: TEXTURE_WIDTH,
			aabbTextureHeight: rows.bvhRows,
			triangleCount: totalTriangles,
			materials: materials,
			textures: textures,
			environment: classifyEnvironment(scene),
			lights: lights,
			ambient: ambient,
			lightTypes: {
				SPHERE: LIGHT_SPHERE,
				DIRECTIONAL: LIGHT_DIRECTIONAL,
				AMBIENT: LIGHT_AMBIENT,
				SPOT: LIGHT_SPOT
			}
		};
	}

	function packGeometrySync(input, onProgress) {
		if (typeof PT_PackGeometry !== 'function') {
			throw new Error(
				'[pt_lib] Load src/core/geometry-packing.js before src/core/ingest.js'
			);
		}
		return PT_PackGeometry(
			input.meshData,
			input.totalTriangles,
			input.rows,
			onProgress
		);
	}

	// Synchronous ingestion — the default and the reference implementation.
	function ingestScene(scene, options) {
		options = options || {};
		var input = buildSceneInput(scene, options, false);
		var packed = packGeometrySync(input, options.onProgress);
		return assembleIngested(scene, options, input, packed);
	}

	// Worker ingestion — gather on the main thread, pack + build the BVH off it.
	// Returns a promise for the same ingested object ingestScene produces.
	function ingestSceneAsync(scene, options) {
		options = options || {};
		var input = buildSceneInput(scene, options, true);
		if (!PT_LIB.geometryWorker) {
			return Promise.reject(
				new Error(
					'[pt_lib] Load src/core/geometry-worker.js for the worker path'
				)
			);
		}
		return PT_LIB.geometryWorker
			.packGeometry(input.meshData, input.totalTriangles, input.rows, {
				onProgress: options.onProgress
			})
			.then(function (packed) {
				return assembleIngested(scene, options, input, packed);
			});
	}

	// Builds the GLSL prelude for the scene: counts, ambient / environment
	// constants and the sampler pool. Material *values* are NOT baked any more —
	// the adapter packs them into the tMaterialData float texture (see
	// buildMaterialData), so a property tweak uploads new values instead of
	// recompiling the shader. Only counts and structural data stay here.
	function buildScenePrelude(ingested) {
		var lines = [];
		var samplers = {};
		var textures = ingested.textures || [];
		var f = function (n) {
			var s = Number(n).toFixed(6);
			return s.indexOf('.') === -1 ? s + '.0' : s;
		};

		lines.push('// generated by pt_lib scene ingestion — do not edit');
		lines.push('precision highp float;');
		lines.push('precision highp int;');
		lines.push('#define PT_LIGHT_COUNT ' + ingested.lights.length);
		lines.push('#define PT_MATERIAL_COUNT ' + ingested.materials.length);
		lines.push('#define PT_TEXTURE_COUNT ' + textures.length);

		// Lights are NOT baked as constants any more: the adapter packs them into
		// the tLightData float texture (see buildLightData), so a property tweak
		// uploads new values instead of recompiling this shader. Only the count
		// stays here, since it bounds the shader's light loops. A count change is
		// structural and re-ingests (and recompiles) anyway.

		// Material values live in the tMaterialData float texture (one column per
		// material, five rows). The adapter binds the sampler; these accessors keep
		// the generated lookups below readable.
		lines.push('uniform sampler2D tMaterialData;');
		lines.push('vec4 ptMatAlbedo(int i)   { return texelFetch(tMaterialData, ivec2(i, 0), 0); }');
		lines.push('vec4 ptMatParams(int i)   { return texelFetch(tMaterialData, ivec2(i, 1), 0); }');
		lines.push('vec4 ptMatEmissive(int i) { return texelFetch(tMaterialData, ivec2(i, 2), 0); }');
		lines.push('vec4 ptMatSlots(int i)    { return texelFetch(tMaterialData, ivec2(i, 3), 0); }');
		lines.push('vec4 ptMatFlags(int i)    { return texelFetch(tMaterialData, ivec2(i, 4), 0); }');
		lines.push(
			'const vec3 PT_AMBIENT = vec3(' +
				f(ingested.ambient[0]) + ',' + f(ingested.ambient[1]) + ',' + f(ingested.ambient[2]) +
				');'
		);

		// ---- image-based lighting -------------------------------------
		// `scene.environmentTexture` is sampled for escaped rays (background +
		// metal reflections). Cube maps use the world direction directly;
		// equirectangular 2D textures are mapped spherically. With no environment
		// the shader falls back to PT_AMBIENT.
		var env = ingested.environment || null;
		if (!env || !env.texture) env = null;
		lines.push('const float PT_ENV_INTENSITY = ' + f(env ? env.intensity : 1.0) + ';');
		lines.push('const float PT_ENV_MAX_LOD = ' + f(env ? env.maxLod : 0.0) + ';');
		if (env && env.kind === 1) {
			lines.push('#define PT_ENV_CUBE 1');
			lines.push('precision highp samplerCube;');
			lines.push('uniform samplerCube tEnvironmentTexture;');
			samplers.tEnvironmentTexture = env.texture;
		} else if (env && env.kind === 2) {
			lines.push('#define PT_ENV_2D 1');
			lines.push('uniform sampler2D tEnvironmentTexture;');
			samplers.tEnvironmentTexture = env.texture;
		}

		lines.push('const float PT_TRIANGLE_COUNT = ' + f(ingested.triangleCount) + ';');

		// ---- scene textures -------------------------------------------
		// All channels share one sampler pool (see ingestScene). The per-material
		// channel -> pool slot tables and the lookups are generated as if-chains,
		// because GLSL ES 3.0 cannot dynamically index a sampler array.
		for (var t = 0; t < textures.length; t++) {
			var samplerName = 'PT_MAT_TEX_' + t;
			lines.push('uniform sampler2D ' + samplerName + ';');
			samplers[samplerName] = textures[t];
		}

		if (textures.length) {
			lines.push(
				'const float PT_TEX_FLIP[' + textures.length + '] = float[' + textures.length + '](' +
					textures
						.map(function (tex) {
							return tex && tex.invertY === false ? '0.0' : '1.0';
						})
						.join(', ') +
					');'
			);
		} else {
			lines.push('const float PT_TEX_FLIP[1] = float[1](0.0);');
		}

		lines.push('bool ptHasUV(vec2 uv) { return !(uv.x < 0.0 && uv.y < 0.0); }');

		lines.push('vec4 ptFetchSceneTex(int slot, vec2 uv)');
		lines.push('{');
		for (var t2 = 0; t2 < textures.length; t2++) {
			lines.push(
				'\tif (slot == ' + t2 + ') { vec2 tuv = uv;' +
					' if (PT_TEX_FLIP[' + t2 + '] > 0.5) { tuv.y = 1.0 - tuv.y; }' +
					' return texture(PT_MAT_TEX_' + t2 + ', tuv); }'
			);
		}
		lines.push('\treturn vec4(0.0);');
		lines.push('}');

		lines.push('vec3 ptSampleAlbedo(int mat, vec2 uv)');
		lines.push('{');
		lines.push('\tint slot = int(ptMatSlots(mat).x);');
		lines.push('\tif (slot < 0 || !ptHasUV(uv)) { return ptMatAlbedo(mat).rgb; }');
		lines.push('\treturn ptFetchSceneTex(slot, uv).rgb;');
		lines.push('}');

		lines.push('vec3 ptSampleEmissive(int mat, vec2 uv)');
		lines.push('{');
		lines.push('\tint slot = int(ptMatSlots(mat).w);');
		lines.push('\tif (slot < 0 || !ptHasUV(uv)) { return vec3(1.0); }');
		lines.push('\treturn ptFetchSceneTex(slot, uv).rgb;');
		lines.push('}');

		// x = metallic, y = roughness; -1 means "keep the flat material value"
		lines.push('vec2 ptSampleMetallicRoughness(int mat, vec2 uv)');
		lines.push('{');
		lines.push('\tint slot = int(ptMatSlots(mat).z);');
		lines.push('\tif (slot < 0 || !ptHasUV(uv)) { return vec2(-1.0); }');
		lines.push('\tvec4 c = ptFetchSceneTex(slot, uv);');
		lines.push('\tvec2 flags = ptMatFlags(mat).xy;');
		lines.push('\treturn vec2(flags.x > 0.5 ? c.b : -1.0, flags.y > 0.5 ? c.g : -1.0);');
		lines.push('}');

		// Tangent-space normal mapped through a bump/normal texture. Returns the
		// geometric normal unchanged when the material has no bump map.
		lines.push('vec3 ptApplyBump(int mat, vec3 n, vec3 tangent, float handedness, vec2 uv)');
		lines.push('{');
		lines.push('\tint slot = int(ptMatSlots(mat).y);');
		lines.push('\tif (slot < 0 || !ptHasUV(uv)) { return n; }');
		lines.push('\tvec3 nt = ptFetchSceneTex(slot, uv).xyz * 2.0 - 1.0;');
		lines.push('\tnt.xy *= ptMatParams(mat).w;');
		lines.push('\tvec3 t = normalize(tangent - n * dot(n, tangent));');
		lines.push('\tvec3 b = cross(n, t) * handedness;');
		lines.push('\treturn normalize(t * nt.x + b * nt.y + n * nt.z);');
		lines.push('}');

		return { glsl: lines.join('\n'), samplers: samplers };
	}

	PT_LIB.ingestScene = ingestScene;
	PT_LIB.ingestSceneAsync = ingestSceneAsync;
	PT_LIB.buildSceneInput = buildSceneInput;
	PT_LIB.assembleIngested = assembleIngested;
	PT_LIB.ingestLights = ingestLights;
	PT_LIB.buildLightData = buildLightData;
	PT_LIB.buildMaterialData = buildMaterialData;
	PT_LIB.refreshMaterialScalars = refreshMaterialScalars;
	PT_LIB.buildScenePrelude = buildScenePrelude;
	PT_LIB.geometryCapacity = geometryCapacity;
	PT_LIB.checkGeometryCapacity = checkGeometryCapacity;
	PT_LIB.mapMaterial = mapMaterial;
	PT_LIB.ingestConstants = {
		TEXTURE_WIDTH: TEXTURE_WIDTH,
		TEXTURE_HEIGHT: TEXTURE_HEIGHT,
		FLOATS_PER_TRIANGLE: FLOATS_PER_TRIANGLE
	};
})(typeof window !== 'undefined' ? window : globalThis);
