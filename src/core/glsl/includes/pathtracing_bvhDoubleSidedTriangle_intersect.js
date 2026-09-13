// pt_lib — GLSL include: pathtracing_bvhDoubleSidedTriangle_intersect
// Extracted from js/PathTracingCommon.js (original left untouched).
// Registers into pt_lib's own GLSL registry (PT_LIB.glsl), not Babylon's
// global shader stores, so scenes cannot clobber one another.

PT_LIB.defineInclude("pathtracing_bvhDoubleSidedTriangle_intersect", `

float BVH_DoubleSidedTriangleIntersect( vec3 v0, vec3 v1, vec3 v2, vec3 rayOrigin, vec3 rayDirection, out float u, out float v )
{
	vec3 edge1 = v1 - v0;
	vec3 edge2 = v2 - v0;
	vec3 pvec = cross(rayDirection, edge2);
	float det = 1.0 / dot(edge1, pvec);
	vec3 tvec = rayOrigin - v0;
	u = dot(tvec, pvec) * det;
	vec3 qvec = cross(tvec, edge1);
	v = dot(rayDirection, qvec) * det;
	float t = dot(edge2, qvec) * det;
	return (u < 0.0 || u > 1.0 || v < 0.0 || u + v > 1.0 || t <= 0.0) ? INFINITY : t;
}

`);
