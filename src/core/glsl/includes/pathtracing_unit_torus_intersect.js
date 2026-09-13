// pt_lib — GLSL include: pathtracing_unit_torus_intersect
// Extracted from js/PathTracingCommon.js (original left untouched).
// Registers into pt_lib's own GLSL registry (PT_LIB.glsl), not Babylon's
// global shader stores, so scenes cannot clobber one another.

PT_LIB.defineInclude("pathtracing_unit_torus_intersect", `

// The following Torus quartic solver algo/code is from https://www.shadertoy.com/view/ssc3Dn by Shadertoy user 'mla'

float sgn(float x) 
{
	return x < 0.0 ? - 1.0 : 1.0; // Return 1.0 for x == 0.0
}

float evalquadratic(float x, float A, float B, float C) 
{
	return (A * x + B) * x + C;
}

float evalcubic(float x, float A, float B, float C, float D) 
{
	return ((A * x + B) * x + C) * x + D;
}

// Quadratic solver from Kahan
int quadratic(float A, float B, float C, out vec2 res) 
{
	float b = - 0.5 * B, b2 = b * b;
	float q = b2 - A * C;
	if (q < 0.0) return 0;
	float r = b + sgn(b) * sqrt(q);
	if (r == 0.0) 
	{
		res[0] = C / A;
		res[1] = - res[0];
	} 
	else 
	{
		res[0] = C / r;
		res[1] = r / A;
	}

	return 2;
}

// Numerical Recipes algorithm for solving cubic equation
int cubic(float a, float b, float c, float d, out vec3 res) 
{
	if (a == 0.0) 
	{
		return quadratic(b, c, d, res.xy);
	}
	if (d == 0.0) 
	{
		res.x = 0.0;
		return 1 + quadratic(a, b, c, res.yz);
	}
	float tmp = a;
	a = b / tmp;
	b = c / tmp;
	c = d / tmp;
	// solve x^3 + ax^2 + bx + c = 0
	float Q = (a * a - 3.0 * b) / 9.0;
	float R = (2.0 * a * a * a - 9.0 * a * b + 27.0 * c) / 54.0;
	float R2 = R * R, Q3 = Q * Q * Q;
	if (R2 < Q3) 
	{
		float X = clamp(R / sqrt(Q3), - 1.0, 1.0);
		float theta = acos(X);
		float S = sqrt(Q); // Q must be positive since 0 <= R2 < Q3
		res[0] = - 2.0 * S * cos(theta / 3.0) - a / 3.0;
		res[1] = - 2.0 * S * cos((theta + 2.0 * PI) / 3.0) - a / 3.0;
		res[2] = - 2.0 * S * cos((theta + 4.0 * PI) / 3.0) - a / 3.0;
		return 3;
	} 
	else 
	{
		float alpha = - sgn(R) * pow(abs(R) + sqrt(R2 - Q3), 0.3333);
		float beta = alpha == 0.0 ? 0.0 : Q / alpha;
		res[0] = alpha + beta - a / 3.0;
		return 1;
	}
}

/* float qcubic(float B, float C, float D) {
  vec3 roots;
  int nroots = cubic(1.0,B,C,D,roots);
  // Sort into descending order
  if (nroots > 1 && roots.x < roots.y) roots.xy = roots.yx;
  if (nroots > 2) {
    if (roots.y < roots.z) roots.yz = roots.zy;
    if (roots.x < roots.y) roots.xy = roots.yx;
  }
  // And select the largest
  float psi = roots[0];
  psi = max(1e-6,psi);
  // and give a quick polish with Newton-Raphson
  for (int i = 0; i < 3; i++) {
    float delta = evalcubic(psi,1.0,B,C,D)/evalquadratic(psi,3.0,2.0*B,C);
    psi -= delta;
  }
  return psi;
} */

float qcubic(float B, float C, float D) 
{
	vec3 roots;
	int nroots = cubic(1.0, B, C, D, roots);
	// Select the largest
	float psi = roots[0];
	if (nroots > 1) psi = max(psi, roots[1]);
	if (nroots > 2) psi = max(psi, roots[2]);

	// Give a quick polish with Newton-Raphson
	float delta;
	delta = evalcubic(psi, 1.0, B, C, D) / evalquadratic(psi, 3.0, 2.0 * B, C);
	psi -= delta;
	delta = evalcubic(psi, 1.0, B, C, D) / evalquadratic(psi, 3.0, 2.0 * B, C);
	psi -= delta;

	return psi;
}

// The Lanczos quartic method
int lquartic(float c1, float c2, float c3, float c4, out vec4 res) 
{
	float alpha = 0.5 * c1;
	float A = c2 - alpha * alpha;
	float B = c3 - alpha * A;
	float a, b, beta, psi;
	psi = qcubic(2.0 * A - alpha * alpha, A * A + 2.0 * B * alpha - 4.0 * c4, - B * B);
	// There _should_ be a root >= 0, but sometimes the cubic
	// solver misses it (probably a double root around zero).
	psi = max(0.0, psi);
	a = sqrt(psi);
	beta = 0.5 * (A + psi);
	if (psi <= 0.0) 
	{
		b = sqrt(max(beta * beta - c4, 0.0));
	} 
	else 
	{
		b = 0.5 * a * (alpha - B / psi);
	}

	int resn = quadratic(1.0, alpha + a, beta + b, res.xy);
	vec2 tmp;
	if (quadratic(1.0, alpha - a, beta - b, tmp) != 0) 
	{
		res.zw = res.xy;
		res.xy = tmp;
		resn += 2;
	}

	return resn;
}

// Note: the parameter below is renamed '_E', because Euler's number 'E' is already defined in 'pathtracing_defines_and_uniforms'
int quartic(float A, float B, float C, float D, float _E, out vec4 roots) 
{
	int nroots;
	// Sometimes it's advantageous to solve for the reciprocal (if there are very large solutions)
	if (abs(B / A) < abs(D / _E)) 
	{
		nroots = lquartic(B / A, C / A, D / A, _E / A, roots);
	} 
	else 
	{
		nroots = lquartic(D / _E, C / _E, B / _E, A / _E, roots);
		for (int i = 0; i < nroots; i ++) 
		{
			roots[i] = 1.0 / roots[i];
		}
	}

	return nroots;
}

float UnitTorusIntersect(vec3 ro, vec3 rd, float k, out vec3 n) 
{
	// Note: the vec3 'rd' might not be normalized to unit length of 1, 
	//  in order to allow for inverse transform of intersecting rays into Torus' object space
	k = mix(0.5, 1.0, k);
	float torus_R = max(0.0, k); // outer extent of the entire torus/ring
	float torus_r = max(0.01, 1.0 - k); // thickness of circular 'tubing' part of torus/ring
	float torusR2 = torus_R * torus_R;
	float torusr2 = torus_r * torus_r;

	float U = dot(rd, rd);
	float V = 2.0 * dot(ro, rd);
	float W = dot(ro, ro) - (torusR2 + torusr2);
	// A*t^4 + B*t^3 + C*t^2 + D*t + _E = 0
	float A = U * U;
	float B = 2.0 * U * V;
	float C = V * V + 2.0 * U * W + 4.0 * torusR2 * rd.z * rd.z;
	float D = 2.0 * V * W + 8.0 * torusR2 * ro.z * rd.z;
// Note: the float below is renamed '_E', because Euler's number 'E' is already defined in 'pathtracing_defines_and_uniforms'
	float _E = W * W + 4.0 * torusR2 * (ro.z * ro.z - torusr2);

	vec4 res = vec4(0);
	int nr = quartic(A, B, C, D, _E, res);
	if (nr == 0) return INFINITY;
	// Sort the roots.
	if (res.x > res.y) res.xy = res.yx;
	if (nr > 2) 
	{
		if(res.y > res.z) res.yz = res.zy;
		if(res.x > res.y) res.xy = res.yx;
	}
	if (nr > 3) 
	{
		if(res.z > res.w) res.zw = res.wz;
		if(res.y > res.z) res.yz = res.zy;
		if(res.x > res.y) res.xy = res.yx;
	}

	float t = INFINITY;

	t = (res.w > 0.0) ? res.w : t;
	t = (res.z > 0.0) ? res.z : t;
	t = (res.y > 0.0) ? res.y : t;
	t = (res.x > 0.0) ? res.x : t;

	vec3 pos = ro + t * rd;
	//n = pos * (dot(pos, pos) - torusr2 - torusR2 * vec3(1, 1,-1));

	float kn = sqrt(torusR2 / dot(pos.xy, pos.xy));
	pos.xy -= kn * pos.xy;
	n = pos;

	return t;
}

`);
