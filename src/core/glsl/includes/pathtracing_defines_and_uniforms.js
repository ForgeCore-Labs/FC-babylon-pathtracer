// pt_lib — GLSL include: pathtracing_defines_and_uniforms
// Extracted from js/PathTracingCommon.js (original left untouched).
// Registers into pt_lib's own GLSL registry (PT_LIB.glsl), not Babylon's
// global shader stores, so scenes cannot clobber one another.

PT_LIB.defineInclude("pathtracing_defines_and_uniforms", `

// common Defines for all scenes
#define PI               3.14159265358979323
#define TWO_PI           6.28318530717958648
#define FOUR_PI          12.5663706143591729
#define ONE_OVER_PI      0.31830988618379067
#define ONE_OVER_TWO_PI  0.15915494309
#define ONE_OVER_FOUR_PI 0.07957747154594767
#define PI_OVER_TWO      1.57079632679489662
#define ONE_OVER_THREE   0.33333333333333333
#define E                2.71828182845904524
#define INFINITY         1000000.0
#define SPOT_LIGHT -2
#define POINT_LIGHT -1
#define LIGHT 0
#define DIFFUSE 1
#define TRANSPARENT 2
#define METAL 3
#define CLEARCOAT_DIFFUSE 4
#define CARCOAT 5
#define TRANSLUCENT 6
#define SPECSUB 7
#define CHECK 8
#define WATER 9
#define PBR_MATERIAL 10
#define WOOD 11
#define SEAFLOOR 12
#define TERRAIN 13
#define CLOTH 14
#define LIGHTWOOD 15
#define DARKWOOD 16
#define PAINTING 17
#define METALCOAT 18

// Samplers
uniform sampler2D previousBuffer;
uniform sampler2D blueNoiseTexture;

// common Uniforms for all scenes
uniform mat4 uCameraMatrix;
uniform vec2 uResolution;
uniform vec2 uRandomVec2;
uniform float uULen;
uniform float uVLen;
uniform float uTime;
uniform float uFrameCounter;
uniform float uSampleCounter;
uniform float uPreviousSampleCount;
uniform float uEPS_intersect;
uniform float uApertureSize;
uniform float uFocusDistance;
uniform bool uCameraIsMoving;

// First-hit AOVs (M5). A scene's CalculateRadiance fills these at bounce 0; the
// AOV pass (pathtracing_default_main under PT_AOV_PASS) reads them. The values
// describe a ray that hit nothing, so an escaped ray keeps them.
vec3 ptFirstHitAlbedo = vec3(0.0);
vec3 ptFirstHitNormal = vec3(0.0);
float ptFirstHitDepth = INFINITY;
`);
