// pt_lib — GLSL include: pathtracing_pyramid_frustum_intersect
// Extracted from js/PathTracingCommon.js (original left untouched).
// Registers into pt_lib's own GLSL registry (PT_LIB.glsl), not Babylon's
// global shader stores, so scenes cannot clobber one another.

PT_LIB.defineInclude("pathtracing_pyramid_frustum_intersect", `

float PyramidFrustumIntersect( vec3 ro, vec3 rd, float k, out vec3 n )
{
	float xt0, xt1, zt0, zt1;
	float xt = INFINITY;
	float zt = INFINITY;
	vec3 hit0, hit1, xn, zn;
	// valid range for k: 0.01 to 1.0 (1.0 being the default for cone with a sharp, pointed apex)
	k = clamp(k, 0.01, 1.0);
	
	// first, intersect left and right sides of pyramid/frustum
	float j = 1.0 / k;
	float h = j * 2.0 - 1.0; // (k * 0.25) makes the normal cone's bottom circular base have a unit radius of 1.0
	float a = j * rd.x * rd.x - (k * 0.25) * rd.y * rd.y;
    	float b = 2.0 * (j * rd.x * ro.x - (k * 0.25) * rd.y * (ro.y - h));
    	float c = j * ro.x * ro.x - (k * 0.25) * (ro.y - h) * (ro.y - h);
	solveQuadratic(a, b, c, xt0, xt1);
	hit0 = ro + rd * xt0;
	hit1 = ro + rd * xt1;
	if (xt0 > 0.0 && abs(hit0.x) <= 1.0 && abs(hit0.z) <= 1.0 && hit0.y <= 1.0 && (j * hit0.z * hit0.z - k * 0.25 * (hit0.y - h) * (hit0.y - h)) <= 0.0)
	{
		xt = xt0;
		xn = vec3(2.0 * hit0.x * j, 2.0 * (hit0.y - h) * -(k * 0.25), 0.0);
	}
	else if (xt1 > 0.0 && abs(hit1.x) <= 1.0 && abs(hit1.z) <= 1.0 && hit1.y <= 1.0 && (j * hit1.z * hit1.z - k * 0.25 * (hit1.y - h) * (hit1.y - h)) <= 0.0)
	{
		xt = xt1;
		xn = vec3(2.0 * hit1.x * j, 2.0 * (hit1.y - h) * -(k * 0.25), 0.0);
	}
	
	// now intersect front and back sides of pyramid/frustum
	a = j * rd.z * rd.z - (k * 0.25) * rd.y * rd.y;
    	b = 2.0 * (j * rd.z * ro.z - (k * 0.25) * rd.y * (ro.y - h));
    	c = j * ro.z * ro.z - (k * 0.25) * (ro.y - h) * (ro.y - h);
	solveQuadratic(a, b, c, zt0, zt1);
	hit0 = ro + rd * zt0;
	hit1 = ro + rd * zt1;
	if (zt0 > 0.0 && abs(hit0.x) <= 1.0 && abs(hit0.z) <= 1.0 && hit0.y <= 1.0 && (j * hit0.x * hit0.x - k * 0.25 * (hit0.y - h) * (hit0.y - h)) <= 0.0)
	{
		zt = zt0;
		zn = vec3(0.0, 2.0 * (hit0.y - h) * -(k * 0.25), 2.0 * hit0.z * j);
	}
	else if (zt1 > 0.0 && abs(hit1.x) <= 1.0 && abs(hit1.z) <= 1.0 && hit1.y <= 1.0 && (j * hit1.x * hit1.x - k * 0.25 * (hit1.y - h) * (hit1.y - h)) <= 0.0)
	{
		zt = zt1;
		zn = vec3(0.0, 2.0 * (hit1.y - h) * -(k * 0.25), 2.0 * hit1.z * j);
	}
	
	if (xt <= zt)
	{
		n = xn;
		return xt;
	}
	else
	{
		n = zn;
		return zt;
	}
}

`);
