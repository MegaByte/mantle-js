// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// shaderMinifySmoke.mjs — minifyGlsl() invariants. It must shrink GLSL without
// changing meaning: strip comments, collapse whitespace, drop blank lines —
// but KEEP preprocessor directives line-isolated and never merge adjacent
// tokens. Node-only (pure string function).
import { minifyGlsl } from '../src/shaders/index.js';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

const SRC = `#version 300 es
precision highp float;          // line comment
/* block
   comment */
#define K 4
uniform   sampler2D   uTex;     /* inline */ uniform float uA;
void main() {
    // body comment
    float  x  =  uA  *  2.0;

    gl_FragColor = vec4(x);
}`;

const out = minifyGlsl(SRC);
const lines = out.split('\n');

// 1. #version must be first line, untouched.
if (lines[0] === '#version 300 es') ok('#version stays on line 1');
else fail('line 1: ' + JSON.stringify(lines[0]));

// 2. No comments survive.
if (!out.includes('//') && !out.includes('/*') && !out.includes('*/')) ok('all comments stripped');
else fail('comment residue: ' + JSON.stringify(out));

// 3. Preprocessor directives stay line-isolated (own line, nothing merged onto them).
if (lines.includes('#define K 4')) ok('#define stays on its own line');
else fail('#define merged/missing: ' + JSON.stringify(lines));

// 4. No blank lines.
if (lines.every((l) => l.length > 0)) ok('no blank lines');
else fail('blank line present');

// 5. Whitespace collapsed (no double spaces, no leading indent).
if (!/  /.test(out) && !/\n /.test(out)) ok('whitespace collapsed (no double-space / indent)');
else fail('whitespace not collapsed');

// 6. Tokens NOT merged — "float x = uA * 2.0;" keeps its separators.
if (out.includes('float x = uA * 2.0;')) ok('tokens preserved (float x = uA * 2.0;)');
else fail('tokens mangled: ' + JSON.stringify(out));

// 7. Two declarations on one line (split by an inline block comment)
//    don't fuse into one identifier.
if (out.includes('uniform sampler2D uTex; uniform float uA;'))
  ok('inline-comment-split decls kept separable');
else fail('inline decls fused: ' + JSON.stringify(lines.find((l) => l.includes('uTex'))));

// 8. Idempotent.
if (minifyGlsl(out) === out) ok('idempotent');
else fail('not idempotent');

// 9. Actually smaller.
if (out.length < SRC.length) ok(`smaller: ${SRC.length} -> ${out.length} bytes`);
else fail('not smaller');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nSHADER-MINIFY PASS');
process.exit(failures ? 1 : 0);
