// pt_lib — GLSL include: pathtracing_unit_bounding_sphere_intersect
// Extracted from js/PathTracingCommon.js (original left untouched).
// Registers into pt_lib's own GLSL registry (PT_LIB.glsl), not Babylon's
// global shader stores, so scenes cannot clobber one another.

PT_LIB.defineInclude("pathtracing_unit_bounding_sphere_intersect", `

float UnitBoundingSphereIntersect( vec3 ro, vec3 rd, out bool insideSphere )
{
	float t0, t1;
	float a = dot(rd, rd);
	float b = 2.0 * dot(rd, ro);
	float c = dot(ro, ro) - (1.01 * 1.01); // - (rad * rad) = - (1.0 * 1.0) = - 1.0 
	solveQuadratic(a, b, c, t0, t1);
	if (t0 > 0.0)
	{
		insideSphere = false;
		return t0;
	}
	if (t1 > 0.0)
	{
		insideSphere = true;
		return t1;
	}

	return INFINITY;
}

`);
