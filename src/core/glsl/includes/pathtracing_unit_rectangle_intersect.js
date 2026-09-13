// pt_lib — GLSL include: pathtracing_unit_rectangle_intersect
// Extracted from js/PathTracingCommon.js (original left untouched).
// Registers into pt_lib's own GLSL registry (PT_LIB.glsl), not Babylon's
// global shader stores, so scenes cannot clobber one another.

PT_LIB.defineInclude("pathtracing_unit_rectangle_intersect", `

float UnitRectangleIntersect( vec3 ro, vec3 rd )
{
	float t0 = (ro.y + 0.0) / -rd.y;
	vec3 hit = ro + rd * t0;
	return (t0 > 0.0 && abs(hit.x) <= 1.0 && abs(hit.z) <= 1.0) ? t0 : INFINITY; // rectangle with unit radius
}

`);
