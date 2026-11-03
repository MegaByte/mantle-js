// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchHullSpanSmoke — a ramped hull plane off its span still ramps OUTSIDE.
//
// THE TRAP. A ramped hull plane (four to a kind-22 block) carries the span of the arc it runs along, and off
// that span answering step(0, a) -- 1 inside, 0 outside -- is right only inside: a fragment deep in a thin patch
// must not lose coverage to a wall it is nowhere near. Outside it is not: every hull edge's line supports the whole
// convex hull, so a fragment just outside it has part of its pixel inside, and wherever a patch is a sliver along
// a nearly straight curve, the next piece's hull edge runs through the AA band of the arc beside it and would zero
// it. Tiger at 512 px: 626 pixels drawn differently by the ramp, 580 nearer the exact coverage; off by more than
// 32/255 5263 -> 5017.
//
// PINNED, through the shipped kernel text in float32 (test/_glslEmu.mjs, cpatchCurveCov on one packed kind-22
// block): off the span, 0.1 px OUTSIDE the plane reads its box area and 0.1 px inside reads 1; on the span, both
// read the box area; and the mutation (the step outside) reads 0 outside.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, K_CPATCH_CURVE } from './_glslEmu.mjs';
import { exactBoxCov } from '../src/renderer/cpatchCov.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!hasCxx()) {
  console.log('  SKIP: no C++ compiler for the shader emulator');
  process.exit(0);
}

// One kind-22 block: plane 0 is y >= 0 (unit normal (0, 1)), carrying the span u in [0, 10] along its direction
// (-n.y, n.x) = (-1, 0), i.e. x in [-10, 0]; planes 1-3 repeat it (a short group pads with its last plane).
const n = [0, 1, 0],
  span = [0, 10];
const blk = new Float32Array(28);
blk.set([...n, 22], 0);
blk.set([...n, span[0]], 4);
blk.set([...n, span[1]], 8);
blk.set([...n, span[0]], 12);
blk.set([span[1], span[0], span[1], span[0]], 16);
blk.set([span[1], 0, 0, 0], 20);
const EPP = 1; // one em a pixel: `a` below is in pixels
const ask = (emu, x, y) =>
  emu.run(new Float32Array(4), blk, [
    { k: K_CPATCH_CURVE, GD: [0, 0, 0, 0], bb: [0, 0, 0, 0], c: [x, y], ex: [0, 0, 0, 0, 0, EPP] },
  ])[0];
const area = (a) => exactBoxCov(0, 1, a);
const text = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const emu = buildGlslEmu(ROOT, { cpatch: true });
// x = +5 is off the span (u = -5 < 0 - reach); x = -5 is on it
const offOut = ask(emu, 5, -0.1),
  offIn = ask(emu, 5, 0.1),
  onOut = ask(emu, -5, -0.1),
  onIn = ask(emu, -5, 0.1);
ok(
  Math.abs(offOut - area(-0.1)) < 1e-5,
  `off the span, 0.1 px outside: the plane's box area (${offOut.toFixed(4)}, expect ${area(-0.1).toFixed(4)})`,
);
ok(offIn === 1, `off the span, 0.1 px inside: 1 (${offIn})`);
ok(
  Math.abs(onOut - area(-0.1)) < 1e-5 && Math.abs(onIn - area(0.1)) < 1e-5,
  `on the span, both sides: the box area (${onOut.toFixed(4)}, ${onIn.toFixed(4)})`,
);
const mut = text.replace('return a >= 0.0 ? 1.0 : exactBoxCov(n, a);', 'return step(0.0, a);');
ok(mut !== text, 'the mutation applies to the shipped text');
const old = buildGlslEmu(ROOT, { cpatch: true, glsl: mut });
ok(
  ask(old, 5, -0.1) === 0,
  `mutation: with the step restored, 0.1 px outside off the span reads ${ask(old, 5, -0.1)}`,
);
console.log(fail ? `cpatchHullSpanSmoke FAIL (${fail})` : 'cpatchHullSpanSmoke PASS');
process.exit(fail ? 1 : 0);
