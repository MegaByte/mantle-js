// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _budgetSweep — pick the chain's flatness budget by MEASURING the kernel, not the polyline.
//
// Sweeps the accuracy budget and, for each, reports the chain kernel's error against the truth
// (area(pixel box INTERSECT path)) over the pixels the chain faces own. The budget is a fraction of
// the shape's own extent, so every arm is scale-free; the sweep only chooses the coefficient. (A
// minimum piece length on top of it buys nothing -- 593 -> 587 pixels off by >0.05 on one asset,
// identical on four.) `abs` is the absolute-tolerance arm (0.00025 world units) shown for reference -- it
// is the one that is NOT scale-free.
//
//   node probes/lbEmTuned/_budgetSweep.mjs FILE.svg [FILE.svg ...]     N=512 S=8
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { curveRangeToContours, rayWinding } = await import('../../src/geom/lbContour.js');
const { buildLbShape } = await import('../../src/renderer/lbBuildCore.js');
const { chainBoxCov } = await import('./_chainKernel.mjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
console.warn = () => {};
const N = +(process.env.N || 512),
  S = +(process.env.S || 8);

const inTri = (px, py, t, I) => {
  const ax = I[t],
    ay = I[t + 1],
    bx = I[t + 2],
    by = I[t + 3],
    cx = I[t + 4],
    cy = I[t + 5];
  const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
};
function chainFaces(raw) {
  const I = raw.interior,
    A = raw.interiorChainA,
    B = raw.interiorChainB,
    C = raw.interiorChainC;
  const D = raw.interiorChainD,
    E = raw.interiorChainE;
  if (!I || !A) return [];
  const out = [];
  for (let f = 0; f * 6 + 5 < I.length; f++) {
    const t = f * 6,
      o = f * 12;
    if (!(C[o + 2] > 1.5) || C[o + 2] > 2.5) continue;
    const P = [
      [A[o], A[o + 1]],
      [A[o + 2], A[o + 3]],
      [B[o], B[o + 1]],
      [B[o + 2], B[o + 3]],
      [C[o], C[o + 1]],
    ];
    let P2 = null;
    if (
      D &&
      E &&
      (D[o] || D[o + 1] || D[o + 2] || D[o + 3] || E[o] || E[o + 1] || E[o + 2] || E[o + 3])
    )
      P2 = [
        [D[o], D[o + 1]],
        [D[o + 2], D[o + 3]],
        [E[o], E[o + 1]],
        [E[o + 2], E[o + 3]],
        [E[o + 2], E[o + 3]],
      ];
    const xs = [I[t], I[t + 2], I[t + 4]],
      ys = [I[t + 1], I[t + 3], I[t + 5]];
    out.push({
      t,
      P,
      P2,
      bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    });
  }
  return out;
}

const files = process.argv.slice(2);
const SHORT = !!process.env.SHORT; // just the three arms that decide it
const ARMS = SHORT
  ? [
      ['abs 0.00025 (absolute, NOT scale-free)', { tol: 0.00025 }],
      ['rel 2^-16 (the rendered budget)', { rel: 2 ** -16 }],
      ['rel 2^-12 (the default)', { rel: 2 ** -12 }],
    ]
  : [
      ['abs 0.00025 (absolute, NOT scale-free)', { tol: 0.00025 }],
      ['rel 2^-16', { rel: 2 ** -16 }],
      ['rel 2^-14', { rel: 2 ** -14 }],
      ['rel 2^-12', { rel: 2 ** -12 }],
    ];

for (const file of files) {
  const bundle = await importSvg(readFileSync(path.resolve(ROOT, file), 'utf8'));
  const meta = new Float32Array(bundle.meta, 32),
    mst = bundle.metaFloatsPerShape;
  const cf = new Float32Array(bundle.curves);
  const src = [];
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let s = 0; s < bundle.numShapes; s++) {
    const r = bundle.curveRangesByShape[s];
    if (!r || r.end <= r.begin) continue;
    const cs = curveRangeToContours(cf, r.begin, r.end);
    if (!cs) continue;
    for (const c of cs)
      for (const sg of c)
        for (const p of [sg.p1, sg.p2, sg.p3, sg.p4]) {
          if (!p) continue;
          if (p[0] < x0) x0 = p[0];
          if (p[0] > x1) x1 = p[0];
          if (p[1] < y0) y0 = p[1];
          if (p[1] > y1) y1 = p[1];
        }
    const bb = s * mst;
    src.push({
      cs,
      ts:
        meta[bb + 7] < 0.996 &&
        Math.floor(meta[bb + 28] + 0.5) === 0 &&
        (mst < 36 || Math.floor(meta[bb + 35] + 0.5) === 0),
      eo: meta[bb + 13] > 0.5,
    });
  }
  const ext = Math.max(x1 - x0, y1 - y0),
    emPerPx = ext / N;
  const cx0 = (x0 + x1) / 2 - (N / 2) * emPerPx,
    cy0 = (y0 + y1) / 2 - (N / 2) * emPerPx;
  console.log(`\n${file}`);
  console.log(
    '  arm                                      faces  chainpx   mean|err|      max   off>0.05  sub-px pieces',
  );
  for (const [name, o] of ARMS) {
    globalThis.__MANTLE_DEBUG__ = true; // the hull tolerances are test hooks, read only under it
    globalThis.__LB_HULL_TOL = o.tol;
    globalThis.__LB_HULL_TOL_REL = o.rel;
    let cnt = 0,
      sum = 0,
      mx = 0,
      bad = 0,
      nf = 0,
      subpx = 0,
      nseg = 0;
    for (const sh of src) {
      const b = buildLbShape(sh.cs, sh.ts, sh.eo);
      if (!b || !b.raw || !b.raw.interior) continue;
      const faces = chainFaces(b.raw);
      nf += faces.length;
      const wind = (x, y) => {
        let w = 0;
        for (const c of sh.cs) w += rayWinding(c, x, y);
        return sh.eo ? (w & 1) !== 0 : w !== 0;
      };
      for (const f of faces) {
        for (let i = 0; i + 1 < 5; i++) {
          const L = Math.hypot(f.P[i + 1][0] - f.P[i][0], f.P[i + 1][1] - f.P[i][1]);
          if (L > 0) {
            nseg++;
            if (L / emPerPx < 1) subpx++;
          }
        }
        const i0 = Math.max(0, Math.floor((f.bb[0] - cx0) / emPerPx)),
          i1 = Math.min(N - 1, Math.ceil((f.bb[2] - cx0) / emPerPx));
        const j0 = Math.max(0, Math.floor((f.bb[1] - cy0) / emPerPx)),
          j1 = Math.min(N - 1, Math.ceil((f.bb[3] - cy0) / emPerPx));
        for (let j = j0; j <= j1; j++) {
          const py = cy0 + (j + 0.5) * emPerPx;
          for (let i = i0; i <= i1; i++) {
            const px = cx0 + (i + 0.5) * emPerPx;
            if (!inTri(px, py, f.t, b.raw.interior)) continue;
            let cov = chainBoxCov(
              f.P.map((p) => [(p[0] - px) / emPerPx, (p[1] - py) / emPerPx]),
              2.0,
            );
            if (f.P2)
              cov = Math.min(
                cov,
                chainBoxCov(
                  f.P2.map((p) => [(p[0] - px) / emPerPx, (p[1] - py) / emPerPx]),
                  1.0,
                ),
              );
            let k = 0;
            for (let b2 = 0; b2 < S; b2++)
              for (let a2 = 0; a2 < S; a2++)
                if (
                  wind(px + ((a2 + 0.5) / S - 0.5) * emPerPx, py + ((b2 + 0.5) / S - 0.5) * emPerPx)
                )
                  k++;
            const e = Math.abs(cov - k / (S * S));
            cnt++;
            sum += e;
            if (e > mx) mx = e;
            if (e > 0.05) bad++;
          }
        }
      }
    }
    console.log(
      `  ${name.padEnd(40)} ${String(nf).padStart(4)} ${String(cnt).padStart(8)}  ${(sum / Math.max(1, cnt)).toFixed(5)}  ${mx.toFixed(4)}  ${String(bad).padStart(8)}  ${subpx}/${nseg}`,
    );
  }
  globalThis.__LB_HULL_TOL = undefined;
  globalThis.__LB_HULL_TOL_REL = undefined;
}
