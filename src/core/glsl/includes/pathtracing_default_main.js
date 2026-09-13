// pt_lib — GLSL include: pathtracing_default_main
// Extracted from js/PathTracingCommon.js (original left untouched).
// Registers into pt_lib's own GLSL registry (PT_LIB.glsl), not Babylon's
// global shader stores, so scenes cannot clobber one another.

PT_LIB.defineInclude("pathtracing_default_main", `

// Final Pixel Color, required out vec4 by WebGL 2.0
out vec4 glFragColor;

// Firefly / outlier clamp for the beauty accumulate (M5). Linear luminance
// ceiling for a single sample; <= 0 disables it. Bound by PathTracer from
// options.fireflyClamp.
uniform float uFireflyClamp;

// Camera ray generation, shared by the beauty entry and the AOV entry: pixel
// jitter, depth of field, and the rayOrigin / rayDirection globals. SetupScene()
// is the caller's job, since only the beauty entry needs the accumulation state.
void ptCameraRay()
{
	vec3 camRight       = vec3( uCameraMatrix[0][0], uCameraMatrix[0][1], uCameraMatrix[0][2]);
	vec3 camUp          = vec3( uCameraMatrix[1][0], uCameraMatrix[1][1], uCameraMatrix[1][2]);
	vec3 camForward     = vec3( uCameraMatrix[2][0], uCameraMatrix[2][1], uCameraMatrix[2][2]);
	vec3 cameraPosition = vec3( uCameraMatrix[3][0], uCameraMatrix[3][1], uCameraMatrix[3][2]);

	// calculate unique seed for rng() function (a high-quality pseudo-random number generator for the GPU by 'iq' on ShaderToy)
	seed = uvec2(uFrameCounter, uFrameCounter + 1.0) * uvec2(gl_FragCoord);

	// initialize variables for my custom blueNoise_rand() function (alternative to the rng() function mentioned above), which instead samples from the provided RGBA blueNoiseTexture to generate pseudo-random numbers.
	// note: its main use is for diffuse/dielectric surface convergence speed and shadow noise reduction, but it is inferior to iq's rng() function for generating pure non-repeating random numbers between 0.0-1.0 : use at your discretion
	counter = -1.0; // will get incremented by 1 on each call to blueNoise_rand()
	channel = 0; // the final selected color channel to use for blueNoise_rand() calc (range: 0 to 3, corresponds to R,G,B, or A)
	randNumber = 0.0; // the final randomly-generated number (range: 0.0 to 1.0)
	randVec4 = vec4(0); // on each animation frame, it samples and holds the RGBA blueNoise texture value for this pixel 
	randVec4 = texelFetch(blueNoiseTexture, ivec2(mod(gl_FragCoord.xy + floor(uRandomVec2 * 256.0), 256.0)), 0);

	// blueNoise_rand() produces higher FPS and almost immediate convergence, but may have very slight jagged diagonal edges on higher frequency color patterns, i.e. checkerboards.
	// rng() has a little less FPS on mobile, and a little more noisy initially, but eventually converges on perfect anti-aliased edges - use this if 'beauty-render' is desired.
	vec2 pixelOffset = uFrameCounter < 150.0 ? vec2( tentFilter(blueNoise_rand()), tentFilter(blueNoise_rand()) ) :
					      	   vec2( tentFilter(rng()), tentFilter(rng()) );

	// we must map pixelPos into the range -1.0 to +1.0
	vec2 pixelPos = ((gl_FragCoord.xy + pixelOffset) / uResolution) * 2.0 - 1.0;

	vec3 rayDir = normalize( pixelPos.x * camRight * uULen + pixelPos.y * camUp * uVLen + camForward );

	// depth of field
	vec3 focalPoint = uFocusDistance * rayDir;
	float randomAngle = rng() * TWO_PI; // pick random point on aperture
	float randomRadius = rng() * uApertureSize;
	vec3  randomAperturePos = ( cos(randomAngle) * camRight + sin(randomAngle) * camUp ) * sqrt(randomRadius);
	// point on aperture to focal point
	vec3 finalRayDir = normalize(focalPoint - randomAperturePos);

	rayOrigin = cameraPosition + randomAperturePos;
	rayDirection = finalRayDir;
}

#ifdef PT_AOV_PASS
// ---- first-hit AOV entry (M5) ---------------------------------------
// One primary ray per pixel, no bounces, no accumulation. uAovChannel selects
// which AOV this pass writes: 0 albedo, 1 shading normal, 2 linear hit distance.
// A scene that includes this file under the universal/gltf adapters fills the
// ptFirstHit* globals in CalculateRadiance at bounce 0 (see PT_AOV_ONLY).
uniform int uAovChannel;

void main(void)
{
	ptCameraRay();
	SetupScene();

	vec3 aovNormal = vec3(0.0);
	vec3 aovAlbedo = vec3(0.0);
	float aovID = -INFINITY;
	float aovSharpness = 0.0;
	CalculateRadiance(aovNormal, aovAlbedo, aovID, aovSharpness);

	if (uAovChannel == 1)
	{
		glFragColor = vec4(ptFirstHitNormal, 1.0);
	}
	else if (uAovChannel == 2)
	{
		// r = linear hit distance; INFINITY (1e6) when the ray escaped.
		glFragColor = vec4(ptFirstHitDepth, 0.0, 0.0, 1.0);
	}
	else
	{
		glFragColor = vec4(ptFirstHitAlbedo, 1.0);
	}
}
#else
void main(void) // if the scene is static and doesn't have any special requirements, this main() can be used
{
	ptCameraRay();

	SetupScene();

	// Edge Detection variables - don't want to blur edges where either surface normals change abruptly (i.e. room wall corners), objects overlap each other (i.e. edge of a foreground sphere in front of another sphere right behind it),
	// or an abrupt color variation on the same smooth surface, even if it has similar surface normals (i.e. checkerboard pattern). Want to keep all of these cases as sharp as possible - no blur filter will be applied.
	vec3 objectNormal = vec3(0);
	vec3 objectColor = vec3(0);
	float objectID = -INFINITY;
	float pixelSharpness = 0.0;

	// perform path tracing and get resulting pixel color
	vec4 currentPixel = vec4( vec3(CalculateRadiance(objectNormal, objectColor, objectID, pixelSharpness)), 0.0 );

	// Firefly / outlier clamp: cap this sample's luminance before it joins the
	// accumulation, preserving hue. High-variance specular hits (near-mirror NEE)
	// are the usual source of the bright sparkles this removes. 0 = disabled.
	if (uFireflyClamp > 0.0)
	{
		float fireflyLum = dot(currentPixel.rgb, vec3(0.2126, 0.7152, 0.0722));
		if (fireflyLum > uFireflyClamp)
		{
			currentPixel.rgb *= uFireflyClamp / fireflyLum;
		}
	}
	// if difference between normals of neighboring pixels is less than the first edge0 threshold, the white edge line effect is considered off (0.0)
	float edge0 = 0.2; // edge0 is the minimum difference required between normals of neighboring pixels to start becoming a white edge line
	// any difference between normals of neighboring pixels that is between edge0 and edge1 smoothly ramps up the white edge line brightness (smoothstep 0.0-1.0)
	float edge1 = 0.6; // once the difference between normals of neighboring pixels is >= this edge1 threshold, the white edge line is considered fully bright (1.0)
	float difference_Nx = fwidth(objectNormal.x);
	float difference_Ny = fwidth(objectNormal.y);
	float difference_Nz = fwidth(objectNormal.z);
	float normalDifference = smoothstep(edge0, edge1, difference_Nx) + smoothstep(edge0, edge1, difference_Ny) + smoothstep(edge0, edge1, difference_Nz);
	edge0 = 0.0;
	edge1 = 0.5;
	float difference_obj = abs(dFdx(objectID)) > 0.0 ? 1.0 : 0.0;
	difference_obj += abs(dFdy(objectID)) > 0.0 ? 1.0 : 0.0;
	float objectDifference = smoothstep(edge0, edge1, difference_obj);
	float difference_col = length(dFdx(objectColor)) > 0.0 ? 1.0 : 0.0;
	difference_col += length(dFdy(objectColor)) > 0.0 ? 1.0 : 0.0;
	float colorDifference = smoothstep(edge0, edge1, difference_col);
	// edge detector (normal and object differences) white-line debug visualization
	//currentPixel.rgb += 1.0 * vec3(max(normalDifference, objectDifference));
	// edge detector (color difference) white-line debug visualization
	//currentPixel.rgb += 1.0 * vec3(colorDifference);
	
	vec4 previousPixel = texelFetch(previousBuffer, ivec2(gl_FragCoord.xy), 0);

	if (uFrameCounter == 1.0) // camera just moved after being still
	{
		previousPixel.rgb *= (1.0 / uPreviousSampleCount) * 0.5; // essentially previousPixel *= 0.5, like below
		previousPixel.a = 0.0;
		currentPixel.rgb *= 0.5;
	}
	else if (uCameraIsMoving) // camera is currently moving
	{
		previousPixel.rgb *= 0.5; // motion-blur trail amount (old image)
		previousPixel.a = 0.0;
		currentPixel.rgb *= 0.5; // brightness of new image (noisy)
	}

	// if current raytraced pixel didn't return any color value, just use the previous frame's pixel color
	if (currentPixel.rgb == vec3(0.0))
	{
		currentPixel.rgb = previousPixel.rgb;
		previousPixel.rgb *= 0.5;
		currentPixel.rgb *= 0.5;
	}


	if (colorDifference >= 1.0 || normalDifference >= 1.0 || objectDifference >= 1.0)
		pixelSharpness = 1.01;


	currentPixel.a = pixelSharpness;

	// Eventually, all edge-containing pixels' .a (alpha channel) values will converge to 1.01, which keeps them from getting blurred by the box-blur filter, thus retaining sharpness.
	if (previousPixel.a == 1.01)
		currentPixel.a = 1.01;


	glFragColor = vec4(previousPixel.rgb + currentPixel.rgb, currentPixel.a);
}
#endif
`);
