// pt_lib — GLSL include: pathtracing_unit_flattened_ring_intersect
// Extracted from js/PathTracingCommon.js (original left untouched).
// Registers into pt_lib's own GLSL registry (PT_LIB.glsl), not Babylon's
// global shader stores, so scenes cannot clobber one another.

PT_LIB.defineInclude("pathtracing_unit_flattened_ring_intersect", `

float UnitFlattenedRingIntersect( vec3 ro, vec3 rd, float k, out vec3 n )
{
	k -= 0.01;
	vec3 hit;
	float t0, t1, c0, c1;

	// intersect unit outer-cylinder
	float a = (rd.x * rd.x + rd.z * rd.z);
    	float b = 2.0 * (rd.x * ro.x + rd.z * ro.z);
    	float c = (ro.x * ro.x + ro.z * ro.z) - 1.0; 
	solveQuadratic(a, b, c, t0, t1);
	hit = ro + rd * t0;
	if (t0 > 0.0 && abs(hit.y) <= 1.0)
	{
		n = vec3(2.0 * hit.x, 0.0, 2.0 * hit.z);
		return t0;
	}

	// intersect top unit radius disk (but if intersect point is in area of hole, it's a miss)
	float d0 = (ro.y - 1.0) / -rd.y;
	hit = ro + rd * d0;
	float x2z2 = hit.x * hit.x + hit.z * hit.z;
	if (rd.y < 0.0 && d0 > 0.0 && x2z2 <= 1.0 && x2z2 > k)
	{
		n = vec3(0, 1, 0);
		return d0;
	}
	// intersect bottom unit radius disk (but if intersect point is in area of hole, it's a miss)
	float d1 = (ro.y + 1.0) / -rd.y;
	hit = ro + rd * d1;
	x2z2 = hit.x * hit.x + hit.z * hit.z;
	if (rd.y > 0.0 && d1 > 0.0 && x2z2 <= 1.0 && x2z2 > k)
	{
		n = vec3(0, -1, 0);
		return d1;
	}

	// intersect k-sized radius inner-cylinder
	c = (ro.x * ro.x + ro.z * ro.z) - k;
	solveQuadratic(a, b, c, c0, c1);
	hit = ro + rd * c0;
	if (c0 > 0.0 && abs(hit.y) <= 1.0)
	{
		n = vec3(2.0 * hit.x, 0.0, 2.0 * hit.z);
		return c0;
	}
	// the rear of the k-sized radius inner cylinder
	hit = ro + rd * c1;
	if (c1 > 0.0 && abs(hit.y) <= 1.0)
	{
		n = vec3(2.0 * hit.x, 0.0, 2.0 * hit.z);
		return c1;
	}

	// the rear of the unit radius outer cylinder
	hit = ro + rd * t1;
	if (t1 > 0.0 && abs(hit.y) <= 1.0)
	{
		n = vec3(2.0 * hit.x, 0.0, 2.0 * hit.z);
		return t1;
	}
	// top disk (with hole cut out) from inside
	hit = ro + rd * d0;
	x2z2 = hit.x * hit.x + hit.z * hit.z;
	if (rd.y > 0.0 && d0 > 0.0 && x2z2 <= 1.0 && x2z2 > k)
	{
		n = vec3(0, 1, 0);
		return d0;
	}
	// bottom disk (with hole cut out) from inside
	hit = ro + rd * d1;
	x2z2 = hit.x * hit.x + hit.z * hit.z;
	if (rd.y < 0.0 && d1 > 0.0 && x2z2 <= 1.0 && x2z2 > k)
	{
		n = vec3(0, -1, 0);
		return d1;
	}

	return INFINITY;
}

`);
