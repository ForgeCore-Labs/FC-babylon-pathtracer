// pt_lib — GLSL include: pathtracing_unit_box_intersect
// Extracted from js/PathTracingCommon.js (original left untouched).
// Registers into pt_lib's own GLSL registry (PT_LIB.glsl), not Babylon's
// global shader stores, so scenes cannot clobber one another.

PT_LIB.defineInclude("pathtracing_unit_box_intersect", `

float UnitBoxIntersect( vec3 ro, vec3 rd, out vec3 n )
{
	vec3 invDir = 1.0 / rd;
	vec3 near = (vec3(-1) - ro) * invDir; // unit radius box: vec3(-1,-1,-1) min corner
	vec3 far  = (vec3( 1) - ro) * invDir; // unit radius box: vec3(+1,+1,+1) max corner
	vec3 tmin = min(near, far);
	vec3 tmax = max(near, far);
	float t0 = max( max(tmin.x, tmin.y), tmin.z);
	float t1 = min( min(tmax.x, tmax.y), tmax.z);

	if (t0 < t1)
	{
		if (t0 > 0.0)
		{
			n = -sign(rd) * step(tmin.yzx, tmin) * step(tmin.zxy, tmin);
			return t0;
		}
		if (t1 > 0.0)
		{
			n = -sign(rd) * step(tmax, tmax.yzx) * step(tmax, tmax.zxy);
			return t1;
		}
	}

	return INFINITY;
}

`);
