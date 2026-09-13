// pt_lib — automatic uniform binding.
//
// Discovers `uniform` and sampler declarations from GLSL source so binding
// lists never have to be maintained by hand. In the original code those lists
// were written out manually per scene, and a mismatch failed silently (a
// uniform simply never got bound).
//
// Classic-script module: attaches to the global PT_LIB namespace.

(function (root) {
	'use strict';

	var PT_LIB = (root.PT_LIB = root.PT_LIB || {});

	var SAMPLER_TYPES = {
		sampler2D: true,
		samplerCube: true,
		sampler3D: true,
		sampler2DArray: true,
		sampler2DShadow: true,
		samplerCubeShadow: true,
		sampler2DArrayShadow: true,
		isampler2D: true,
		usampler2D: true
	};

	function isSamplerType(type) {
		return SAMPLER_TYPES[type] === true;
	}

	function stripComments(glsl) {
		// Block comments first, then line comments. Good enough for GLSL; it
		// deliberately does not try to be a full lexer.
		return glsl.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
	}

	// uniform [precision] <type> <name>[<length>];
	var UNIFORM_RE =
		/\buniform\s+(?:(?:lowp|mediump|highp)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[\s*([A-Za-z0-9_]+)\s*\])?\s*;/g;

	// Returns { uniforms: [names], samplers: [names], all: [{name,type,isSampler,arrayLength}] }
	function parseUniforms(glsl) {
		var source = stripComments(glsl || '');
		var uniforms = [];
		var samplers = [];
		var all = [];
		var seen = Object.create(null);
		var m;

		UNIFORM_RE.lastIndex = 0;
		while ((m = UNIFORM_RE.exec(source)) !== null) {
			var type = m[1];
			var name = m[2];

			if (seen[name] === true) {
				continue;
			}
			seen[name] = true;

			var isSampler = isSamplerType(type);
			all.push({
				name: name,
				type: type,
				isSampler: isSampler,
				arrayLength: m[3] ? m[3] : null
			});

			if (isSampler) {
				samplers.push(name);
			} else {
				uniforms.push(name);
			}
		}

		return { uniforms: uniforms, samplers: samplers, all: all };
	}

	PT_LIB.parseUniforms = parseUniforms;
	PT_LIB.isSamplerType = isSamplerType;
	PT_LIB.stripComments = stripComments;

	if (typeof BABYLON !== 'undefined') {
		BABYLON.PathTracerInternal = BABYLON.PathTracerInternal || {};
		BABYLON.PathTracerInternal.parseUniforms = parseUniforms;
	}
})(typeof window !== 'undefined' ? window : globalThis);
