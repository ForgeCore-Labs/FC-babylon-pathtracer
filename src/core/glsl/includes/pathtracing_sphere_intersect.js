// pt_lib — GLSL include: pathtracing_sphere_intersect
// Extracted from js/PathTracingCommon.js (original left untouched).
// Registers into pt_lib's own GLSL registry (PT_LIB.glsl), not Babylon's
// global shader stores, so scenes cannot clobber one another.

PT_LIB.defineInclude("pathtracing_sphere_intersect", `

float SphereIntersect( float rad, vec3 pos, vec3 rayOrigin, vec3 rayDirection )
{
	float t0, t1;
	vec3 L = rayOrigin - pos;
	float a = dot(rayDirection, rayDirection );
	float b = 2.0 * dot(rayDirection, L);
	float c = dot(L, L) - (rad * rad);
	solveQuadratic(a, b, c, t0, t1);
	return t0 > 0.0 ? t0 : t1 > 0.0 ? t1 : INFINITY;
}

`);
