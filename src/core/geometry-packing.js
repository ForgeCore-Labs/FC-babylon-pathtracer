// pt_lib — geometry packing.
//
// This is the expensive half of scene ingestion: world-space transform, the
// per-triangle tangent frame, the packed triangle / AABB float arrays and the
// BVH build. It works on plain data (typed arrays + a world matrix) so the very
// same code can run on the main thread or inside the geometry Web Worker
// (src/core/geometry-worker.js), which is why it lives in its own file.
//
// It depends on:
//   * BABYLON.Vector3 — the real Babylon type on the main thread, a minimal
//     shim inside the worker. Only set / copyFrom / copyFromFloats /
//     normalize / lengthSquared / subtractToRef and the static
//     TransformCoordinates / TransformNormal / CrossToRef are used.
//   * the BVH builder global (BVH_Build_Iterative) from pt_lib.core.js.
//
// meshData is one entry per traceable mesh:
//   { positions, normals|null, uvs|null, indices|null, matrix, materialIndex,
//     triangleCount }
// `matrix` may be a Babylon Matrix or anything with an `m` field (the worker
// gets a Float32Array copy).

(function (root) {
	'use strict';

	var TEXTURE_WIDTH = 2048;
	var FLOATS_PER_TRIANGLE = 32; // 8 rgba texels
	var FLOATS_PER_AABB = 9;
	var BVH_FLOATS_PER_TRIANGLE = 16; // at most 2 BVH nodes per triangle, 8 floats each

	// Returns { triangleArray, aabbArray, totalWork }. `onProgress` is optional
	// and receives { phase: 'pack' | 'bvh', done, total }.
	function packGeometry(meshData, totalTriangles, rows, onProgress) {
		var vector = BABYLON.Vector3;

		var triangleArray = new Float32Array(rows.triangleRows * TEXTURE_WIDTH * 4);
		var aabbArray = new Float32Array(rows.bvhRows * TEXTURE_WIDTH * 4);
		var totalWork = new Uint32Array(totalTriangles);

		var packStart = Date.now();

		var write = 0; // triangle write cursor
		var v0 = new vector();
		var v1 = new vector();
		var v2 = new vector();
		var n0 = new vector();
		var n1 = new vector();
		var n2 = new vector();
		var bbMin = new vector();
		var bbMax = new vector();
		var centroid = new vector();
		var faceNormal = new vector();
		var e1 = new vector();
		var e2 = new vector();

		function putTriangle(ax, ay, az, bx, by, bz, cx, cy, cz, nax, nay, naz, nbx, nby, nbz, ncx, ncy, ncz, u0, u1, u2, u3, u4, u5, tx, ty, tz, hand, matIndex) {
			var base = FLOATS_PER_TRIANGLE * write;

			// slots 0-1: the three positions (deterministic triangle winding)
			triangleArray[base + 0] = ax;
			triangleArray[base + 1] = ay;
			triangleArray[base + 2] = az;
			triangleArray[base + 3] = bx;
			triangleArray[base + 4] = by;
			triangleArray[base + 5] = bz;
			triangleArray[base + 6] = cx;
			triangleArray[base + 7] = cy;
			// slot 2
			triangleArray[base + 8] = cz;
			triangleArray[base + 9] = nax;
			triangleArray[base + 10] = nay;
			triangleArray[base + 11] = naz;
			// slot 3
			triangleArray[base + 12] = nbx;
			triangleArray[base + 13] = nby;
			triangleArray[base + 14] = nbz;
			triangleArray[base + 15] = ncx;
			// slot 4
			triangleArray[base + 16] = ncy;
			triangleArray[base + 17] = ncz;
			triangleArray[base + 18] = u0;
			triangleArray[base + 19] = u1;
			// slot 5
			triangleArray[base + 20] = u2;
			triangleArray[base + 21] = u3;
			triangleArray[base + 22] = u4;
			triangleArray[base + 23] = u5;
			// slot 6: material index + per-triangle tangent (xyz), for normal maps
			triangleArray[base + 24] = matIndex;
			triangleArray[base + 25] = tx;
			triangleArray[base + 26] = ty;
			triangleArray[base + 27] = tz;
			// slot 7: tangent handedness, rest reserved
			triangleArray[base + 28] = hand;
			triangleArray[base + 29] = 0;
			triangleArray[base + 30] = 0;
			triangleArray[base + 31] = 0;

			// per-triangle AABB
			bbMin.set(
				Math.min(ax, bx, cx),
				Math.min(ay, by, cy),
				Math.min(az, bz, cz)
			);
			bbMax.set(
				Math.max(ax, bx, cx),
				Math.max(ay, by, cy),
				Math.max(az, bz, cz)
			);
			centroid.set(
				(bbMin.x + bbMax.x) * 0.5,
				(bbMin.y + bbMax.y) * 0.5,
				(bbMin.z + bbMax.z) * 0.5
			);

			var aabbBase = FLOATS_PER_AABB * write;
			aabbArray[aabbBase + 0] = bbMin.x;
			aabbArray[aabbBase + 1] = bbMin.y;
			aabbArray[aabbBase + 2] = bbMin.z;
			aabbArray[aabbBase + 3] = bbMax.x;
			aabbArray[aabbBase + 4] = bbMax.y;
			aabbArray[aabbBase + 5] = bbMax.z;
			aabbArray[aabbBase + 6] = centroid.x;
			aabbArray[aabbBase + 7] = centroid.y;
			aabbArray[aabbBase + 8] = centroid.z;

			totalWork[write] = write;
			write++;
		}

		// ---- bake world-space triangles --------------------------------
		var processed = 0;
		for (var m = 0; m < meshData.length; m++) {
			var mesh = meshData[m];
			var world = mesh.matrix;
			var positions = mesh.positions;
			var normals = mesh.normals;
			var uvs = mesh.uvs;
			var indices = mesh.indices;
			var triCount = mesh.triangleCount;
			var matIndex = mesh.materialIndex;

			var hasNormals = !!normals;
			var hasUVs = !!uvs;

			for (var t = 0; t < triCount; t++) {
				var i0, i1, i2;
				if (indices && indices.length) {
					i0 = indices[3 * t];
					i1 = indices[3 * t + 1];
					i2 = indices[3 * t + 2];
				} else {
					i0 = 3 * t;
					i1 = 3 * t + 1;
					i2 = 3 * t + 2;
				}

				v0.copyFromFloats(
					positions[3 * i0], positions[3 * i0 + 1], positions[3 * i0 + 2]
				);
				v1.copyFromFloats(
					positions[3 * i1], positions[3 * i1 + 1], positions[3 * i1 + 2]
				);
				v2.copyFromFloats(
					positions[3 * i2], positions[3 * i2 + 1], positions[3 * i2 + 2]
				);
				v0 = vector.TransformCoordinates(v0, world);
				v1 = vector.TransformCoordinates(v1, world);
				v2 = vector.TransformCoordinates(v2, world);

				if (hasNormals) {
					n0.copyFromFloats(
						normals[3 * i0], normals[3 * i0 + 1], normals[3 * i0 + 2]
					);
					n1.copyFromFloats(
						normals[3 * i1], normals[3 * i1 + 1], normals[3 * i1 + 2]
					);
					n2.copyFromFloats(
						normals[3 * i2], normals[3 * i2 + 1], normals[3 * i2 + 2]
					);
					n0 = vector.TransformNormal(n0, world);
					n1 = vector.TransformNormal(n1, world);
					n2 = vector.TransformNormal(n2, world);
					n0.normalize();
					n1.normalize();
					n2.normalize();
				} else {
					v1.subtractToRef(v0, e1);
					v2.subtractToRef(v0, e2);
					vector.CrossToRef(e1, e2, faceNormal);
					faceNormal.normalize();
					n0.copyFrom(faceNormal);
					n1.copyFrom(faceNormal);
					n2.copyFrom(faceNormal);
				}

				var uv0 = -1, uv1 = -1, uv2 = -1, uv3 = -1, uv4 = -1, uv5 = -1;
				if (hasUVs) {
					uv0 = uvs[2 * i0];
					uv1 = uvs[2 * i0 + 1];
					uv2 = uvs[2 * i1];
					uv3 = uvs[2 * i1 + 1];
					uv4 = uvs[2 * i2];
					uv5 = uvs[2 * i2 + 1];
				}

				// per-triangle tangent frame so bump maps can be oriented. It is flat
				// within the triangle (no per-vertex tangents in the packed data).
				v1.subtractToRef(v0, e1);
				v2.subtractToRef(v0, e2);
				vector.CrossToRef(e1, e2, faceNormal);
				if (faceNormal.lengthSquared() > 1e-12) {
					faceNormal.normalize();
				} else {
					faceNormal.set(0, 1, 0);
				}

				var tx, ty, tz, hand = 1;
				if (hasUVs) {
					var du1 = uv2 - uv0, dv1 = uv3 - uv1;
					var du2 = uv4 - uv0, dv2 = uv5 - uv1;
					var det = du1 * dv2 - du2 * dv1;
					if (Math.abs(det) > 1e-12) {
						var invDet = 1.0 / det;
						tx = (e1.x * dv2 - e2.x * dv1) * invDet;
						ty = (e1.y * dv2 - e2.y * dv1) * invDet;
						tz = (e1.z * dv2 - e2.z * dv1) * invDet;
						var bitX = (e2.x * du1 - e1.x * du2) * invDet;
						var bitY = (e2.y * du1 - e1.y * du2) * invDet;
						var bitZ = (e2.z * du1 - e1.z * du2) * invDet;
						// handedness = sign(dot(cross(N, T), B))
						var ntx = faceNormal.y * tz - faceNormal.z * ty;
						var nty = faceNormal.z * tx - faceNormal.x * tz;
						var ntz = faceNormal.x * ty - faceNormal.y * tx;
						hand = ntx * bitX + nty * bitY + ntz * bitZ < 0 ? -1 : 1;
					}
				}
				if (tx === undefined || (tx === 0 && ty === 0 && tz === 0)) {
					// no / degenerate UVs: pick any tangent orthogonal to the normal
					var useX = Math.abs(faceNormal.x) < 0.9;
					tx = useX ? 1 : 0;
					ty = useX ? 0 : 1;
					tz = 0;
					var proj = tx * faceNormal.x + ty * faceNormal.y + tz * faceNormal.z;
					tx -= proj * faceNormal.x;
					ty -= proj * faceNormal.y;
					tz -= proj * faceNormal.z;
					var tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);
					if (tLen > 1e-12) {
						tx /= tLen;
						ty /= tLen;
						tz /= tLen;
					} else {
						tx = 1; ty = 0; tz = 0;
					}
					hand = 1;
				}

				putTriangle(
					v0.x, v0.y, v0.z,
					v1.x, v1.y, v1.z,
					v2.x, v2.y, v2.z,
					n0.x, n0.y, n0.z,
					n1.x, n1.y, n1.z,
					n2.x, n2.y, n2.z,
					uv0, uv1, uv2, uv3, uv4, uv5,
					tx, ty, tz, hand,
					matIndex
				);
			}

			processed += triCount;
			if (onProgress) {
				onProgress({ phase: 'pack', done: processed, total: totalTriangles });
			}
		}

		// ---- BVH -------------------------------------------------------
		var bvhStart = Date.now();
		if (onProgress) {
			onProgress({ phase: 'bvh', done: 0, total: 1 });
		}
		if (totalTriangles > 0) {
			BVH_Build_Iterative(totalWork, aabbArray);
		}
		if (onProgress) {
			onProgress({ phase: 'bvh', done: 1, total: 1 });
		}
		console.log(
			'[pt_lib] ingest timing — pack ' + (bvhStart - packStart) +
			' ms, bvh ' + (Date.now() - bvhStart) +
			' ms (' + totalTriangles + ' triangles)'
		);

		return {
			triangleArray: triangleArray,
			aabbArray: aabbArray,
			totalWork: totalWork
		};
	}

	root.PT_PackGeometry = packGeometry;
})(typeof window !== 'undefined' ? window : globalThis);
