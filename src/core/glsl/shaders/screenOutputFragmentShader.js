// pt_lib — GLSL fragment shader: screenOutputFragmentShader
//
// Second half of the old screenOutputFragmentShader: exposure / contrast, the
// image-processing tone curve and gamma correction, applied to the already
// resolved (and possibly denoised) LINEAR HDR buffer produced by
// screenResolveFragmentShader.
//
// Split out so a denoise hook can run between resolve and tonemap on linear
// values. The tone-mapping stage is otherwise unchanged.
//
// Registers into pt_lib's own GLSL registry (PT_LIB.glsl), not Babylon's
// global shader stores, so scenes cannot clobber one another.

PT_LIB.defineShader("screenOutputFragmentShader", `
#version 300 es

precision highp float;
precision highp int;
precision highp sampler2D;

// Resolved linear HDR beauty (screenResolveFragmentShader output), optionally
// filtered by the denoise hook first.
uniform sampler2D resolvedBuffer;
uniform float uToneMappingExposure;
// scene.imageProcessingConfiguration (bound by PathTracer): exposure / contrast
// and the tone-mapping curve. These are uniforms, not #defines, so retuning the
// camera's image processing never recompiles this shader.
uniform float uExposure;
uniform float uContrast;
uniform int uToneMappingEnabled;
uniform int uToneMappingType; // 0 standard, 1 ACES, 2 Khronos PBR Neutral

out vec4 glFragColor;

// source: https://www.cs.utah.edu/~reinhard/cdrom/
vec3 ReinhardToneMapping(vec3 color) 
{
	return clamp(color / (vec3(1) + color), 0.0, 1.0);
}

// ACES filmic curve (Narkowicz 2015 approximation).
vec3 ACESToneMapping(vec3 color)
{
	const float a = 2.51;
	const float b = 0.03;
	const float c = 2.43;
	const float d = 0.59;
	const float e = 0.14;
	return clamp((color * (a * color + b)) / (color * (c * color + d) + e), 0.0, 1.0);
}

// Khronos PBR Neutral tone mapper (2024); the curve Babylon exposes as
// TONEMAPPING_KHR_PBR_NEUTRAL.
vec3 KhronosPBRNeutralToneMapping(vec3 color)
{
	const float startCompression = 0.8 - 0.04;
	const float desaturation = 0.15;
	float x = min(color.r, min(color.g, color.b));
	float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
	color -= offset;
	float peak = max(color.r, max(color.g, color.b));
	if (peak < startCompression)
	{
		return color;
	}
	float d = 1.0 - startCompression;
	float newPeak = 1.0 - d * d / (peak + d - startCompression);
	color *= newPeak / peak;
	float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
	return mix(color, vec3(newPeak), g);
}

// The resolved buffer is unbounded HDR, so a display transform is always
// needed. When the config enables tone mapping we use its curve; otherwise we
// keep the tracer's previous Reinhard curve (which is also Babylon's
// TONEMAPPING_STANDARD), so default scenes look exactly as before.
vec3 applyToneMapping(vec3 color)
{
	if (uToneMappingEnabled == 1)
	{
		if (uToneMappingType == 1) { return ACESToneMapping(color); }
		if (uToneMappingType == 2) { return KhronosPBRNeutralToneMapping(color); }
	}
	return ReinhardToneMapping(color);
}

void main(void)
{
	vec3 filteredPixelColor = texelFetch(resolvedBuffer, ivec2(gl_FragCoord.xy), 0).rgb;

	// scene.imageProcessingConfiguration: exposure, then contrast, then the
	// tone-mapping curve (same order as Babylon's image processing).
	filteredPixelColor *= uToneMappingExposure * uExposure;
	filteredPixelColor = (filteredPixelColor - 0.5) * uContrast + 0.5;
	filteredPixelColor = applyToneMapping(filteredPixelColor);
	
	// lastly, apply gamma correction (gives more intensity/brightness range where it's needed)
	glFragColor = clamp(vec4( pow(filteredPixelColor, vec3(0.4545)), 1.0 ), 0.0, 1.0);
}
`);
