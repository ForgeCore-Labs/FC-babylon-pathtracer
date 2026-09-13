// pt_lib — GLSL include: pathtracing_unit_cone_intersect
// Extracted from js/PathTracingCommon.js (original left untouched).
// Registers into pt_lib's own GLSL registry (PT_LIB.glsl), not Babylon's
// global shader stores, so scenes cannot clobber one another.

PT_LIB.defineInclude("pathtracing_unit_cone_intersect", `

float UnitConeIntersect( vec3 ro, vec3 rd, float k, out vec3 n )
{
	vec3 hit;
	float t0, t1;
	// valid range for k: 0.01 to 1.0 (1.0 being the default for cone with a sharp, pointed apex)
	k = clamp(k, 0.01, 1.0);
	
	float j = 1.0 / k;
	float h = j * 2.0 - 1.0;		   // (k * 0.25) makes the normal cone's bottom circular base have a unit radius of 1.0
	float a = j * rd.x * rd.x + j * rd.z * rd.z - (k * 0.25) * rd.y * rd.y;
    	float b = 2.0 * (j * rd.x * ro.x + j * rd.z * ro.z - (k * 0.25) * rd.y * (ro.y - h));
    	float c = j * ro.x * ro.x + j * ro.z * ro.z - (k * 0.25) * (ro.y - h) * (ro.y - h);
	solveQuadratic(a, b, c, t0, t1);

	hit = ro + rd * t0;
	if (t0 > 0.0 && abs(hit.y) <= 1.0)
	{
		n = vec3(2.0 * hit.x * j, 2.0 * (h - hit.y) * (k * 0.25), 2.0 * hit.z * j);
		return t0;
	}
	hit = ro + rd * t1;
	if (t1 > 0.0 && abs(hit.y) <= 1.0)
	{
		n = vec3(2.0 * hit.x * j, 2.0 * (h - hit.y) * (k * 0.25), 2.0 * hit.z * j);
		return t1;
	}
	return INFINITY;
}

`);
