// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// glslEmuFlagDefineSmoke -- the CPU emulators keep a #define whose only use is a conditional. Dropped, `#ifdef FLAG` would take its other branch with no error:
// the COLR paint programs' premultiplied mix would never run on the CPU, so a comparison through it could not fail.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFragEmu, emulateCase, hasCxx } from './_fragEmu.mjs';
import { filtperfCases } from './_filtperfCases.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!hasCxx()) {
  console.error('glslEmuFlagDefineSmoke: no C++ compiler');
  process.exit(1);
}

const text = (flag) => `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
${flag ? '#define FLAG' : ''}
#ifdef FLAG
float pick() { return 1.0; }
#else
float pick() { return 0.0; }
#endif
void main() { fragColor = vec4(pick(), 0.0, 0.0, 1.0); }
`;
for (const flag of [true, false]) {
  const e = buildFragEmu(text(flag));
  const o = e.run({ uniforms: {}, textures: {}, frags: [{ vUV: [0.5, 0.5] }] });
  ok(o[0] === (flag ? 1 : 0), `${flag ? 'with' : 'without'} the flag: its branch runs (${o[0]})`);
}

// The real program: the default mix and the straight one read differently through a translucent ramp, and the straight one is still what the parity case compares.
const c = filtperfCases(['compositing']).find((x) => /translucent ramp, extend pad/.test(x.name));
const withMode = (v) => ({
  ...c,
  inputs: {
    ...c.inputs,
    new: { ...c.inputs.new, uniforms: { ...c.inputs.new.uniforms, uStopsChrome: v } },
  },
});
ok(
  emulateCase(root, withMode(1)).ch8 === 0,
  "uStopsChrome 1: the straight mix matches the case's reference",
);
const premul = emulateCase(root, withMode(0));
ok(
  premul.ch8 > 0,
  `uStopsChrome 0: the premultiplied branch runs (${premul.ch8} channels move, up to ${premul.mx}/255)`,
);
if (fail) {
  console.error(`\nGLSL-EMU-FLAG-DEFINE FAIL (${fail})`);
  process.exit(1);
}
console.log('\nGLSL-EMU-FLAG-DEFINE PASS');
