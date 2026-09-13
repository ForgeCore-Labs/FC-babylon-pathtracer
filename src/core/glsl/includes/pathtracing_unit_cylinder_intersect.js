// pt_lib — GLSL include: pathtracing_unit_cylinder_intersect
// Extracted from js/PathTracingCommon.js (original left untouched).
// Registers into pt_lib's own GLSL registry (PT_LIB.glsl), not Babylon's
// global shader stores, so scenes cannot clobber one another.

PT_LIB.defineInclude("pathtracing_unit_cylinder_intersect", `

float UnitCylinderIntersect( vec3 ro, vec3 rd, out vec3 n )
{
	vec3 hit;
	float t0, t1;
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
	hit = ro + rd * t1;
	if (t1 > 0.0 && abs(hit.y) <= 1.0)
	{
		n = vec3(2.0 * hit.x, 0.0, 2.0 * hit.z);
		return t1;
	}
	return INFINITY;
}

`);
