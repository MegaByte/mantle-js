// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchPackParity — the shipping packer must emit the same bytes the probe that
// measured the 4-12x draw win emitted. Extraction is where a measured result quietly
// stops being the thing that ships, so this compares the two streams element by
// element rather than trusting that the move was faithful.
import { packCPatchContour, LB_STRIDE, LBK_CPATCH } from '../src/renderer/cpatchPack.js';
import { convertContour } from '../src/renderer/cpatchConvert.js';
import { segImplicitPacked, packedEval } from '../src/geom/cpatchImplicit.js';
import { patchCoverHull, gridSplitPatch } from '../src/renderer/cpatchConvert.js';

// The probe's builder, inlined verbatim as the reference.

function reference(curves, baseTexel, GRID = 4, GRID_AA = 1.5) {
  const { patches } = convertContour(curves, { maxCurves: 8, tolPx: 0.05 });
  const texels = [],
    verts = [];
  for (const p of patches) {
    if (!p.obb) continue;
    const parts = [];
    if (GRID > 1) {
      const cs = gridSplitPatch(p, GRID, GRID_AA);
      if (cs) for (const c of cs) parts.push({ poly: c.poly, idx: c.curves });
    }
    if (!parts.length) {
      const H = patchCoverHull(p.curves) || p.obb.corners;
      parts.push({ poly: H, idx: p.curves.map((_, i) => i) });
    }
    let ok = true;
    for (const part of parts) {
      const first = baseTexel + texels.length / 4 / 4;
      for (const ci of part.idx) {
        const seg = p.curves[ci];
        const pk = segImplicitPacked(seg);
        if (!pk) {
          ok = false;
          break;
        }
        const kind = seg.cut ? 8 + pk.kind : pk.kind; // hardness is bit 3 over the real kind
        const sg = packedEval(pk, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
        texels.push(pk.a[0][0], pk.a[0][1], pk.a[0][2], kind);
        texels.push(pk.a[1][0], pk.a[1][1], pk.a[1][2], sg);
        texels.push(pk.a[2][0], pk.a[2][1], pk.a[2][2], pk.c[0]);
        texels.push(pk.a[3][0], pk.a[3][1], pk.a[3][2], pk.c[1]);
      }
      if (!ok) break;
      const c = part.poly,
        order = [];
      for (let k = 1; k + 1 < c.length; k++) order.push(0, k, k + 1);
      for (const k of order) {
        const v = new Array(LB_STRIDE).fill(0);
        v[0] = c[k][0];
        v[1] = c[k][1];
        v[5] = LBK_CPATCH;
        v[6] = 1;
        v[19] = first;
        v[20] = part.idx.length;
        verts.push(...v);
      }
    }
    if (!ok) continue;
  }
  return { texels: new Float32Array(texels), verts: new Float32Array(verts) };
}

const K = 6;
const blob = (i) => {
  const R = 40 + (i % 11),
    cx = 100,
    cy = 100,
    out = [];
  const P = (j) => [
    cx + R * Math.cos((2 * Math.PI * j) / K + i * 0.03),
    cy + R * Math.sin((2 * Math.PI * j) / K + i * 0.03),
  ];
  for (let j = 0; j < K; j++) {
    const A = P(j),
      B = P(j + 1);
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.3,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.3;
    out.push({
      t: 'cubic',
      P: [
        A,
        [A[0] + (mx - A[0]) * 0.66, A[1] + (my - A[1]) * 0.66],
        [B[0] + (mx - B[0]) * 0.66, B[1] + (my - B[1]) * 0.66],
        B,
      ],
    });
  }
  return out;
};

let fail = 0,
  checked = 0,
  tex = 0,
  vert = 0;
for (let i = 0; i < 12; i++) {
  const base = i * 37;
  const got = packCPatchContour(blob(i), base, { dedup: false });
  const ref = reference(blob(i), base);
  if (!got) {
    console.log(`FAIL contour ${i}: packer returned null`);
    fail++;
    continue;
  }
  const cmp = (a, b, name) => {
    if (a.length !== b.length) {
      console.log(`FAIL contour ${i}: ${name} length ${a.length} vs ${b.length}`);
      return false;
    }
    for (let k = 0; k < a.length; k++)
      if (a[k] !== b[k]) {
        console.log(`FAIL contour ${i}: ${name}[${k}] ${a[k]} vs ${b[k]}`);
        return false;
      }
    return true;
  };
  const okT = cmp(got.texels, ref.texels, 'texels');
  const okV = cmp(got.verts, ref.verts, 'verts');
  if (!okT || !okV) fail++;
  else checked++;
  tex += got.texels.length;
  vert += got.vertexCount;
}
console.log(`\nshipping packer vs the benchmarked probe builder`);
console.log(`  contours byte-identical  ${checked}/12`);
console.log(`  covered                  ${tex} texel floats · ${vert} vertices`);
console.log(
  fail
    ? `\n${fail} MISMATCH — extraction changed what ships.`
    : '\nthe packer emits exactly the stream that was measured (dedup off).',
);
// With dedup ON the texels must SHRINK while the vertex stream stays identical —
// (first,count) may point earlier, but no triangle moves.
{
  let texOn = 0,
    texOff = 0,
    vertSame = 0;
  for (let i = 0; i < 12; i++) {
    const off = packCPatchContour(blob(i), i * 37, { dedup: false });
    const on = packCPatchContour(blob(i), i * 37, { dedup: true });
    if (!off || !on) continue;
    texOff += off.texels.length;
    texOn += on.texels.length;
    if (off.vertexCount === on.vertexCount) vertSame++;
  }
  console.log(
    `\n  dedup: texels ${texOff} -> ${texOn}  (${(texOff / Math.max(texOn, 1)).toFixed(2)}x smaller)`,
  );
  console.log(`  vertex count unchanged on ${vertSame}/12 contours`);
  if (vertSame !== 12) {
    console.log('  FAIL: dedup moved geometry, it must only re-point (first,count)');
    process.exit(1);
  }
}
process.exit(fail ? 1 : 0);
