// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// unifiedFillVertsSmoke.mjs — the interleaved cover-quad + Loop-Blinn vertex
// stream is laid out the way the shader reads it.
//
// This is the buffer that lets fills and strokes share ONE draw, which is what
// makes painter order fall out of primitive order instead of needing a depth
// buffer that AA fringes break. The layout is a contract between three places —
// this builder, UNIFIED_ATTRIBS, and mantle.vert's declarations — so it is
// asserted rather than trusted.
import {
  UNIFIED_STRIDE,
  UNIFIED_ATTRIBS,
  U_POS,
  U_NORMAL,
  U_EMCOORD,
  U_LBTC,
  U_LBMETA,
  U_SHAPEIDX,
  U_C0,
  buildUnifiedFillVerts,
  unifiedVertexCount,
} from '../src/renderer/unifiedFillVerts.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// Two cover-quad vertices (12 floats each) and one 3-vertex LB mesh (24 each).
const cover = new Float32Array(2 * 12);
for (let i = 0; i < 2; i++) {
  const o = i * 12;
  cover[o] = 10 + i;
  cover[o + 1] = 20 + i; // pos
  cover[o + 2] = 0.5;
  cover[o + 3] = -0.5; // normal
  cover[o + 4] = 30 + i;
  cover[o + 5] = 40 + i; // em coord
}
const shapeIdx = new Float32Array([7, 7]);

const lb = new Float32Array(3 * 24);
for (let i = 0; i < 3; i++) {
  const o = i * 24;
  lb[o] = 100 + i;
  lb[o + 1] = 200 + i; // pos
  lb[o + 2] = 1;
  lb[o + 3] = 2;
  lb[o + 4] = 3; // aTC
  lb[o + 5] = 4; // kind (4 = Bezout cubic)
  lb[o + 6] = -1; // sign
  for (let k = 0; k < 16; k++) lb[o + 7 + k] = 50 + k; // aC0..aC3
  lb[o + 23] = 9; // seamM
}

const entries = [
  { kind: 'cover', srcVert: 0, count: 2 },
  { kind: 'lb', verts: lb, vertexCount: 3, shapeIdx: 5 },
];
ok(unifiedVertexCount(entries) === 5, 'vertex count sums cover + LB');

const { verts, vertexCount } = buildUnifiedFillVerts(entries, cover, shapeIdx);
ok(vertexCount === 5, `assembled 5 vertices (got ${vertexCount})`);
ok(verts.length === 5 * UNIFIED_STRIDE, 'buffer is exactly stride x count');

// --- cover-quad vertex 0
const c0 = 0 * UNIFIED_STRIDE;
ok(verts[c0 + U_POS] === 10 && verts[c0 + U_POS + 1] === 20, 'cover position carried');
ok(verts[c0 + U_NORMAL] === 0.5, 'cover bisector normal carried');
ok(verts[c0 + U_EMCOORD] === 30, 'cover native em coord carried');
ok(verts[c0 + U_SHAPEIDX] === 7, 'cover shape index carried');
// The load-bearing one: an unbound attribute reads (0,0,0,1), so a cover quad
// MUST encode 0 here or it is mistaken for LB kind 0 and takes the wrong path.
ok(verts[c0 + U_LBMETA] === 0, 'cover quad encodes 0 in the kind field (= not LB)');

// --- LB vertex 0 (third vertex overall)
const l0 = 2 * UNIFIED_STRIDE;
ok(verts[l0 + U_POS] === 100 && verts[l0 + U_POS + 1] === 200, 'LB position carried');
ok(verts[l0 + U_LBTC] === 1 && verts[l0 + U_LBTC + 2] === 3, 'LB texcoord/klmn carried');
ok(verts[l0 + U_LBMETA] === 5, 'LB kind is BIASED by one (4 -> 5)');
ok(verts[l0 + U_LBMETA + 1] === -1, 'LB sign carried');
ok(verts[l0 + U_LBMETA + 2] === 9, 'LB seamM carried from the pad float');
ok(verts[l0 + U_SHAPEIDX] === 5, 'LB vertex stamped with its shape index');
let coeffOk = true;
for (let k = 0; k < 16; k++) if (verts[l0 + U_C0 + k] !== 50 + k) coeffOk = false;
ok(coeffOk, 'all 16 per-curve coefficients carried in order');

// --- painter order is positional, and it is the whole compositing argument
ok(
  verts[0 * UNIFIED_STRIDE + U_POS] === 10 && verts[2 * UNIFIED_STRIDE + U_POS] === 100,
  'entries land in the order given (painter order preserved)',
);

// --- the attribute table must describe exactly this layout
const byLoc = Object.fromEntries(UNIFIED_ATTRIBS.map(([l, s, o]) => [l, [s, o]]));
ok(byLoc[0][1] === U_POS * 4 && byLoc[0][0] === 2, 'attrib 0 = position');
ok(
  byLoc[15][1] === U_LBMETA * 4 && byLoc[15][0] === 3,
  'attrib 15 = LB meta (kind+1, sign, seamM)',
);
ok(
  byLoc[7][1] === U_SHAPEIDX * 4,
  'attrib 7 = shape index (same slot the ubershader already uses)',
);
const maxEnd = Math.max(...UNIFIED_ATTRIBS.map(([, s, o]) => o + s * 4));
ok(
  maxEnd <= UNIFIED_STRIDE * 4,
  `no attribute reads past the stride (${maxEnd} <= ${UNIFIED_STRIDE * 4})`,
);
const locs = UNIFIED_ATTRIBS.map(([l]) => l);
ok(new Set(locs).size === locs.length, 'no attribute location bound twice');
ok(
  locs.every((l) => l < 16),
  'every location inside the 16-attribute guarantee',
);

console.log(
  `\nunifiedFillVertsSmoke: ${fail ? 'FAIL' : 'PASS'} — cover quads and LB triangles share one stream`,
);
process.exit(fail ? 1 : 0);
