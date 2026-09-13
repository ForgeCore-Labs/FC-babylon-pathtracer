// pt_lib — shader composer.
//
// Takes a raw GLSL source containing `#include<name>` directives and returns a
// single, fully-inlined GLSL string. The composed string is handed straight to
// a Babylon EffectWrapper, which means a scene shader no longer has to be
// registered under a global store key. In the original code two different
// scene shaders both wrote ShadersStore["pathTracingFragmentShader"]; whichever
// loaded last silently won.
//
// Classic-script module: attaches to the global PT_LIB namespace.

(function (root) {
	'use strict';

	var PT_LIB = (root.PT_LIB = root.PT_LIB || {});

	var INCLUDE_RE = /#include\s*<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>/g;

	// pt_lib's own registry, populated by the extracted GLSL files. Callers may
	// pass an explicit registry instead.
	function defaultRegistry() {
		if (PT_LIB.glsl && PT_LIB.glsl.includes) {
			return PT_LIB.glsl.includes;
		}
		return null;
	}

	// Injects a raw GLSL block right after the #version directive (or at the
	// very top if absent). Used to add generated declarations such as constant
	// arrays for a scene's materials and lights.
	function injectAfterVersion(glsl, block) {
		if (!block) {
			return glsl;
		}
		var text = String(block).replace(/\s*$/, '') + '\n';
		var version = /^[ \t]*#version[^\n]*\n/.exec(glsl);
		if (version) {
			return glsl.slice(0, version[0].length) + text + glsl.slice(version[0].length);
		}
		return text + glsl;
	}

	// Injects `#define`s right after the #version directive (required to be the
	// first non-comment line in GLSL ES 3.0), or at the very top if absent.
	function injectDefines(glsl, defines) {
		if (!defines) {
			return glsl;
		}

		var lines = [];
		for (var key in defines) {
			if (!Object.prototype.hasOwnProperty.call(defines, key)) {
				continue;
			}
			var value = defines[key];
			var literal =
				value === true || value === undefined || value === null
					? ''
					: ' ' + value;
			lines.push('#define ' + key + literal);
		}
		if (lines.length === 0) {
			return glsl;
		}

		var block = lines.join('\n') + '\n';
		var version = /^[ \t]*#version[^\n]*\n/.exec(glsl);
		if (version) {
			return glsl.slice(0, version[0].length) + block + glsl.slice(version[0].length);
		}
		return block + glsl;
	}

	function countIncludes(glsl) {
		var re = new RegExp(INCLUDE_RE.source, 'g');
		var n = 0;
		while (re.exec(glsl) !== null) {
			n++;
		}
		return n;
	}

	// composeShader(raw, opts) -> { glsl, resolvedIncludes, missingIncludes }
	// opts: { registry?, defines?, allowMissing?, skipValidate? }
	function composeShader(raw, opts) {
		opts = opts || {};

		if (typeof raw !== 'string') {
			throw new Error('[pt_lib] composeShader: source must be a string');
		}

		var registry = opts.registry || defaultRegistry();
		var missing = [];
		var resolved = 0;

		var out = raw.replace(INCLUDE_RE, function (whole, name) {
			var body = registry ? registry[name] : undefined;
			if (body === undefined || body === null) {
				missing.push(name);
				return whole;
			}
			resolved++;
			return body;
		});

		if (opts.prelude) {
			out = injectAfterVersion(out, opts.prelude);
		}

		if (opts.defines) {
			out = injectDefines(out, opts.defines);
		}

		if (missing.length > 0 && !opts.allowMissing) {
			throw new Error(
				'[pt_lib] Missing GLSL include(s): ' +
					missing.join(', ') +
					'. Register them before composing.'
			);
		}

		if (!opts.skipValidate && countIncludes(out) > 0) {
			throw new Error(
				'[pt_lib] Unresolved #include directive(s) remain after composition.'
			);
		}

		return {
			glsl: out,
			resolvedIncludes: resolved,
			missingIncludes: missing
		};
	}

	PT_LIB.composeShader = composeShader;
	PT_LIB.injectDefines = injectDefines;
	PT_LIB.injectAfterVersion = injectAfterVersion;

	if (typeof BABYLON !== 'undefined') {
		BABYLON.PathTracerInternal = BABYLON.PathTracerInternal || {};
		BABYLON.PathTracerInternal.composeShader = composeShader;
	}
})(typeof window !== 'undefined' ? window : globalThis);
