// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbRingInkSideSmoke — tiger at 1024 px on the Loop-Blinn route paints no wrong solid pixel at the rings' hard
// cases, checked with the whole-LB-pipeline emulator against the path's exact reference.
//
// With the ring reach at the box filter's and a Bezout ring carrying its arc, a ring can paint wrong solid pixels
// (_zzEnginePaint, fill-only). The emulator (probes/lbAccuracy/_lbEmuPaint.mjs) reproduces each such pixel, and names
// its painter:
//   * s214 at (412, 977) and (412, 978), s34 at (383, 897): a Bezout ARC RING built on a hull edge whose outside is its
//     own arc's INK side -- a piece at a hairpin, where the spike's other side runs between the edge and the arc. The
//     ring's coverage is the box's share of the arc's ink side, which there is air another boundary bounds: 0.65 and
//     0.95 over pixels the paths cover 0.04 and 0.02 of;
//   * s105 at (680, 192): a klm ring's implicit, whose second branch through the piece's singular end passes 0.25 px from
//     a pixel 2.24 px from the drawn arc (0.13 over s13's interior).
// Each window is drawn by every shape that reaches it, composited premultiplied OVER in draw order, and must hold no
// interior pixel off by more than 24/255 (the probe's WRONG SOLID). Rows are TOP-DOWN (the GPU probe prints bottom-up:
// 977 is its 46).
// SKIPs (exit 77) without a C++ compiler and clang, or without the tiger fixture.
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasLbPipeEmu } from './_lbPipeEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIGER = path.join(ROOT, 'examples/tiger.svg');
if (!hasLbPipeEmu()) {
  console.log('SKIP lbRingInkSideSmoke: needs a C++17 compiler and clang');
  process.exit(77);
}
if (!existsSync(TIGER)) {
  console.log('SKIP lbRingInkSideSmoke: examples/tiger.svg is absent (npm run fetch:fixtures)');
  process.exit(77);
}
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const WINDOWS = [
  ['s214 arc ring at a hairpin', '405,970,419,984'],
  ['s34 arc ring at a hairpin', '376,890,390,904'],
  ['s105 klm ring', '672,184,688,200'],
];
for (const [what, win] of WINDOWS) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'probes/lbAccuracy/_lbEmuPaint.mjs')], {
    env: { ...process.env, SVG: TIGER, N: '1024', WIN: win },
    encoding: 'utf8',
    timeout: 170000,
  });
  const m = /WRONG SOLID (\d+)/.exec(r.stdout || '');
  ok(
    !!m && +m[1] === 0,
    `${what}, window ${win}: WRONG SOLID ${m ? m[1] : '(no answer: ' + (r.stderr || '').slice(0, 200) + ')'}`,
  );
  if (m && +m[1] > 0) console.log((r.stdout.match(/^\s+wrong @.*$/gm) || []).join('\n'));
}
console.log(fail ? `lbRingInkSideSmoke: ${fail} FAILED` : 'lbRingInkSideSmoke: all passed');
process.exit(fail ? 1 : 0);
