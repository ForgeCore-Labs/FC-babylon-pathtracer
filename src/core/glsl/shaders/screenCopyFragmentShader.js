// pt_lib — GLSL fragment shader: screenCopyFragmentShader
// Extracted from js/PathTracingCommon.js (original left untouched).
// Registers into pt_lib's own GLSL registry (PT_LIB.glsl), not Babylon's
// global shader stores, so scenes cannot clobber one another.

PT_LIB.defineShader("screenCopyFragmentShader", `
#version 300 es

precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D pathTracedImageBuffer;

out vec4 glFragColor;

void main(void)
{
	glFragColor = texelFetch(pathTracedImageBuffer, ivec2(gl_FragCoord.xy), 0);
}
`);
