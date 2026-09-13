// pt_lib — GLSL include: pathtracing_unit_hyperboloid_intersect
// Extracted from js/PathTracingCommon.js (original left untouched).
// Registers into pt_lib's own GLSL registry (PT_LIB.glsl), not Babylon's
// global shader stores, so scenes cannot clobber one another.

PT_LIB.defineInclude("pathtracing_unit_hyperboloid_intersect", `

float UnitHyperboloidIntersect( vec3 ro, vec3 rd, float k, out vec3 n )
{
	vec3 hit;
	float t0, t1;
	// k initially comes in as a value between 0.01 and 1.0
	k = k * k * k * k + 0.0012;
	k *= 1000.0; // conservative range of k for the hyperboloid: 0.001 to 1000
	float j = k - 1.0;
	float a = k * rd.x * rd.x + k * rd.z * rd.z - j * rd.y * rd.y;
	float b = 2.0 * (k * rd.x * ro.x + k * rd.z * ro.z - j * rd.y * ro.y);
	float c = (k * ro.x * ro.x + k * ro.z * ro.z - j * ro.y * ro.y) - 1.0;
	solveQuadratic(a, b, c, t0, t1);

	hit = ro + rd * t0;
	if (t0 > 0.0 && abs(hit.y) <= 1.0)
	{
		n = vec3(2.0 * hit.x * k, 2.0 * -hit.y * j, 2.0 * hit.z * k);
		return t0;
	}
	hit = ro + rd * t1;
	if (t1 > 0.0 && abs(hit.y) <= 1.0)
	{
		n = vec3(2.0 * hit.x * k, 2.0 * -hit.y * j, 2.0 * hit.z * k);
		return t1;
	}
	return INFINITY;
}

`);
