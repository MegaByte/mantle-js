// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbCornerShareSmoke — two kind-10 edge strips meeting at a line-line corner split its wedge at ONE plane
// both of them hold bit for bit, so a pixel center on the bisector is painted exactly once.
//
// A plane each strip builds from its own interpolated vEm and its own normal is not enough. A grid of 1.5 px squares
// puts pixel centers exactly on corner bisectors, and there two such float32 tests disagree: unsnapped, a pixel is
// painted twice (41.1/255 against an exact 22.0); with the GPU's 1/256 vertex snap four such pixels are painted not at
// all (0 against 8.6-25.5), as ANGLE on Metal draws them. Through the whole-LB-pipeline emulator
// (test/_lbPipeEmu.mjs), unsnapped and snapped to 1/256:
//   (a) the corner planes ARE shared: every strip's end-A plane (vLB1, canvas pixels) equals, bit for bit, the end-B
//       plane (vLB2) of the strip before it -- and there are planes to share (not vacuous);
//   (b) no pixel is painted by two edge strips of one shape;
//   (c) the four bisector pixels read their exact box coverage to 1.5/255.
// Each fails with per-strip planes: (b) and (c) unsnapped, (c) snapped.
// SKIPs (exit 77) without a C++ compiler and clang.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasLbPipeEmu } from './_lbPipeEmu.mjs';
import { lbScene, renderScene } from './_lbPipeScene.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasLbPipeEmu()) {
  console.log('SKIP lbCornerShareSmoke: needs a C++17 compiler and clang');
  process.exit(77);
}
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const t0 = Date.now();
const warn = console.warn;
console.warn = () => {};
const VT = readFileSync(
  process.env.CORNER_SHARE_VERT || path.join(ROOT, 'src/shaders/generated/mantle.vert.glsl'),
  'utf8',
);
const FT = readFileSync(
  process.env.CORNER_SHARE_FRAG || path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'),
  'utf8',
);

// _gpuModelCheck's 'squares 1.5px' at 256 px: an 8x8 grid of 1.5 px squares on a 4.37 px pitch, and two corner dots
// pinning the content box the renderer fits.
const N = 256,
  PX = 100 / N;
let body =
  '<rect x="0" y="0" width="0.02" height="0.02" fill="#000"/><rect x="99.98" y="99.98" width="0.02" height="0.02" fill="#000"/>';
for (let i = 0; i < 8; i++)
  for (let j = 0; j < 8; j++) {
    const x = 10 + i * 4.37 * PX,
      y = 20 + j * 4.37 * PX,
      s = 1.5 * PX;
    body += `<path d="M${x} ${y} L${x + s} ${y} L${x + s} ${y + s} L${x} ${y + s} Z" fill="#000"/>`;
  }
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;
// The four bisector pixels (x, y top-down) and their exact coverage (_lbAaRef, 64 slices) x 255.
const PIX = [
  [53, 68, 25.5],
  [51, 70, 8.6],
  [40, 81, 10.9],
  [38, 83, 22.0],
];
const sc = await lbScene(svg, { N });
for (const snap of [0, 256]) {
  const tag = snap ? 'snapped to 1/256' : 'unsnapped';
  const r = renderScene(sc, VT, FT, [], { snap });
  const V = r.vert,
    O = r.vOut;
  const off = (n) => V.outOff[V.io.outs.findIndex((o) => o.name === n)];
  const oK = off('vKind'),
    o1 = off('vLB1'),
    o2 = off('vLB2');
  // (a) planes, from each kind-10 triangle's provoking (last) vertex.
  const f32 = new Float32Array(4),
    u32 = new Uint32Array(f32.buffer);
  const bits = (b, o) => {
    for (let c = 0; c < 4; c++) f32[c] = O[b + o + c];
    return Array.from(u32).join(',');
  };
  const endB = new Set(),
    endA = [];
  for (let t = 0; t < O.length / V.outN / 3; t++) {
    const b = (t * 3 + 2) * V.outN;
    if (Math.floor(O[b + oK] + 1e-4) !== 10) continue;
    if (O[b + o1 + 2] !== 0 || O[b + o1 + 3] !== 0) endA.push(bits(b, o1));
    if (O[b + o2 + 2] !== 0 || O[b + o2 + 3] !== 0) endB.add(bits(b, o2));
  }
  const matched = endA.filter((k) => endB.has(k)).length;
  ok(
    endA.length >= 64 * 4 && matched === endA.length,
    `(a) ${tag}: ${matched} of ${endA.length} strip-start corner planes equal, bit for bit, the previous strip's end plane`,
  );
  // (b) kind-10 claims per (shape, pixel).
  const claims = new Map();
  for (let q = 0; q < r.recs.length / 9; q++) {
    const t = r.recs[q * 9] | 0;
    if (
      Math.floor(O[(t * 3 + 2) * V.outN + oK] + 1e-4) !== 10 ||
      r.recs[q * 9 + 7] ||
      !(r.recs[q * 9 + 6] > 0)
    )
      continue;
    const key = `${sc.entries[sc.entryOfTri[t]].shapeIdx}:${r.recs[q * 9 + 1] | 0}:${r.recs[q * 9 + 2] | 0}`;
    claims.set(key, (claims.get(key) || 0) + 1);
  }
  const dbl = [...claims].filter(([, c]) => c > 1).map(([k]) => k);
  ok(
    dbl.length === 0,
    `(b) ${tag}: no pixel painted by two edge strips of one shape${dbl.length ? ` (${dbl.slice(0, 4).join(' ')})` : ''}`,
  );
  // (c) the four pixels: the composite of the fragments there (one square each) against exact.
  const cov = new Map();
  for (let q = 0; q < r.recs.length / 9; q++) {
    if (r.recs[q * 9 + 7]) continue;
    const k = `${r.recs[q * 9 + 1] | 0},${r.recs[q * 9 + 2] | 0}`;
    cov.set(k, 1 - (1 - (cov.get(k) || 0)) * (1 - Math.min(1, Math.max(0, r.recs[q * 9 + 6]))));
  }
  const rd = PIX.map(([x, y, e]) => [x, y, e, (cov.get(`${x},${y}`) || 0) * 255]);
  ok(
    rd.every(([, , e, c]) => Math.abs(c - e) <= 1.5),
    `(c) ${tag}: the bisector pixels read exact to 1.5/255 (${rd.map(([x, y, e, c]) => `(${x},${y}) ${c.toFixed(1)} vs ${e}`).join(', ')})`,
  );
}
console.warn = warn;
console.log(
  fail
    ? `lbCornerShareSmoke FAIL (${fail})`
    : `lbCornerShareSmoke: all checks passed (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
);
process.exit(fail ? 1 : 0);
