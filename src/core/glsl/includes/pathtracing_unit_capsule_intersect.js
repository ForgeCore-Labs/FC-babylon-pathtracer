// pt_lib — GLSL include: pathtracing_unit_capsule_intersect
// Extracted from js/PathTracingCommon.js (original left untouched).
// Registers into pt_lib's own GLSL registry (PT_LIB.glsl), not Babylon's
// global shader stores, so scenes cannot clobber one another.

PT_LIB.defineInclude("pathtracing_unit_capsule_intersect", `

float UnitCapsuleIntersect( vec3 ro, vec3 rd, float k, out vec3 n )
{
	k += 0.25;

	vec3 hit;
	float t, t0, t1;
	float s0t0, s0t1, s1t0, s1t1;
	// first test if any of the first intersections (t0's) of both sphere caps and cylinder are valid - if so, return that t0
	
	// intersect unit-radius sphere cap located at top opening of cylinder
	vec3 s0pos = vec3(0, k, 0);
	vec3 L = ro - s0pos;
	float a = dot(rd, rd);
	float b = 2.0 * dot(rd, L);
	float c = dot(L, L) - 1.0;
	solveQuadratic(a, b, c, s0t0, s0t1);
	hit = ro + rd * s0t0;
	if (s0t0 > 0.0 && hit.y >= k)
	{
		n = vec3(2.0 * hit.x, 2.0 * (hit.y - k), 2.0 * hit.z);
		return s0t0;
	}
	
	// intersect unit-radius sphere cap located at bottom opening of cylinder
	vec3 s1pos = vec3(0, -k, 0);
	L = ro - s1pos;
	a = dot(rd, rd);
	b = 2.0 * dot(rd, L);
	c = dot(L, L) - 1.0;
	solveQuadratic(a, b, c, s1t0, s1t1);
	hit = ro + rd * s1t0;
	if (s1t0 > 0.0 && hit.y <= -k)
	{
		n = vec3(2.0 * hit.x, 2.0 * (hit.y + k), 2.0 * hit.z);
		return s1t0;
	}
	
	// intersect unit cylinder
	a = (rd.x * rd.x + rd.z * rd.z);
    	b = 2.0 * (rd.x * ro.x + rd.z * ro.z);
    	c = (ro.x * ro.x + ro.z * ro.z) - 1.0;
	solveQuadratic(a, b, c, t0, t1);
	hit = ro + rd * t0;
	if (t0 > 0.0 && abs(hit.y) <= k)
	{
		n = vec3(2.0 * hit.x, 0.0, 2.0 * hit.z);
		return t0;
	}

	// lastly, test if any of the 2nd intersections (t1's) of both sphere caps and cylinder are valid - if so, return that t1 
	hit = ro + rd * s0t1;
	if (s0t1 > 0.0 && hit.y >= k)
	{
		n = vec3(2.0 * hit.x, 2.0 * (hit.y - k), 2.0 * hit.z);
		return s0t1;
	}

	hit = ro + rd * s1t1;
	if (s1t1 > 0.0 && hit.y <= -k)
	{
		n = vec3(2.0 * hit.x, 2.0 * (hit.y + k), 2.0 * hit.z);
		return s1t1;
	}

	hit = ro + rd * t1;
	if (t1 > 0.0 && abs(hit.y) <= k)
	{
		n = vec3(2.0 * hit.x, 0.0, 2.0 * hit.z);
		return t1;
	}
	
	return INFINITY;
}

`);
