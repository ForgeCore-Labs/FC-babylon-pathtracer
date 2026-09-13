// pt_lib — GLSL registry.
//
// Owns every GLSL string in the library. Replaces registering shaders and
// includes into Babylon's global BABYLON.Effect.* stores, so two scenes can no
// longer silently clobber each other (the original code had two different scene
// shaders both writing ShadersStore["pathTracingFragmentShader"]).
//
// Load this before any file that calls defineInclude / defineShader /
// defineSceneShader. It is the first section of dist/pt_lib.core.js.

(function (root) {
	'use strict';

	var PT_LIB = (root.PT_LIB = root.PT_LIB || {});
	var glsl = (PT_LIB.glsl = PT_LIB.glsl || {
		includes: {},
		shaders: {},
		scenes: {},
	});

	// Reusable GLSL snippets pulled in with #include<name>.
	PT_LIB.defineInclude = function (name, source) {
		glsl.includes[name] = source;
	};

	// Shared full-screen shaders (screenCopy, screenOutput).
	PT_LIB.defineShader = function (name, source) {
		glsl.shaders[name] = source;
	};

	// Scene-specific path tracing shaders. Namespaced per scene, so several can
	// be loaded side by side without colliding.
	PT_LIB.defineSceneShader = function (name, source) {
		glsl.scenes[name] = source;
	};

	PT_LIB.getInclude = function (name) {
		return glsl.includes[name];
	};
	PT_LIB.getShader = function (name) {
		return glsl.shaders[name];
	};
	PT_LIB.getSceneShader = function (name) {
		return glsl.scenes[name];
	};
})(typeof window !== 'undefined' ? window : globalThis);
