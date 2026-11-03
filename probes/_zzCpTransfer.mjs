// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzCpTransfer — the coverage transfer curve for CPatch, on the CPU. The GPU version lives in
// _zzLbSolo, but the kernel model matches the shader term for term, so a seam rule can be scored
// here in seconds and without a GPU.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
// the kernel model's knobs are test hooks, read only under __MANTLE_DEBUG__
if ((process.env.SET || '').split(',').some(Boolean)) globalThis.__MANTLE_DEBUG__ = true;
for (const kv of (process.env.SET || '').split(',').filter(Boolean)) {
  const [k, v] = kv.split('=');
  globalThis[k] = isNaN(+v) ? v : +v;
}
const importSvg = (await import('../src/svg/importer.js')).default;
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { contoursToConverter } = await import('../src/renderer/cpatchBuild.js');
const { rowSpans, rowCross } = await import('../src/renderer/cpatchConvert.js');
const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
const { patchCoverage } = await import('../src/renderer/cpatchCov.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const { evalBezout, bezoutCubicImplicit } = await import('../src/geom/lbCubicMath.js');
// PRE-SPLIT THE CURVES UNTIL THEIR BEZOUT IMPLICIT IS AN HONEST DISTANCE, the same cure the
// Loop-Blinn partition applies to its own crescents. CPatch builds its kind-4 constraint with the
// same bezoutCubicImplicit and 22.1% of them understate the distance to their own arc; it escapes
// that wherever the foot point is interior and pays for it at an arc END, where the implicit is
// deliberately kept to close a corner. SPLIT=1 asks what a faithful one would be worth.
const bezAt = (cp, t) => {
  const u = 1 - t;
  return [
    u * u * u * cp[0][0] +
      3 * u * u * t * cp[1][0] +
      3 * u * t * t * cp[2][0] +
      t * t * t * cp[3][0],
    u * u * u * cp[0][1] +
      3 * u * u * t * cp[1][1] +
      3 * u * t * t * cp[2][1] +
      t * t * t * cp[3][1],
  ];
};
const deCast = (cp, t) => {
  const L = (A, B) => [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t];
  const a = L(cp[0], cp[1]),
    b = L(cp[1], cp[2]),
    c = L(cp[2], cp[3]);
  const d = L(a, b),
    e = L(b, c),
    f = L(d, e);
  return [
    [cp[0], a, d, f],
    [f, e, c, cp[3]],
  ];
};
const unfaithful = (cp, frac) => {
  let F = null;
  try {
    F = bezoutCubicImplicit(cp);
  } catch {
    return false;
  }
  if (!F) return false;
  const ch = Math.hypot(cp[3][0] - cp[0][0], cp[3][1] - cp[0][1]);
  if (!(ch > 0)) return false;
  const h = 1e-5 * ch,
    lim = frac * ch,
    G = 6;
  const arc = [];
  for (let k = 0; k <= 16; k++) arc.push(bezAt(cp, k / 16));
  for (const tri of [
    [0, 1, 2],
    [0, 2, 3],
  ])
    for (let a = 0; a <= G; a++)
      for (let b = 0; a + b <= G; b++) {
        const wa = a / G,
          wb = b / G,
          wc = 1 - wa - wb;
        const x = wa * cp[tri[0]][0] + wb * cp[tri[1]][0] + wc * cp[tri[2]][0];
        const y = wa * cp[tri[0]][1] + wb * cp[tri[1]][1] + wc * cp[tri[2]][1];
        const f0 = evalBezout(F, x, y);
        const g = Math.hypot(
          (evalBezout(F, x + h, y) - evalBezout(F, x - h, y)) / (2 * h),
          (evalBezout(F, x, y + h) - evalBezout(F, x, y - h)) / (2 * h),
        );
        if (!(g > 0)) continue;
        let ad = Infinity;
        for (const P of arc) {
          const d2 = (P[0] - x) * (P[0] - x) + (P[1] - y) * (P[1] - y);
          if (d2 < ad) ad = d2;
        }
        if (Math.sqrt(ad) - Math.abs(f0) / g > lim) return true;
      }
  return false;
};
const splitContours = (cs2, frac, depth) =>
  cs2.map((c) => {
    const out = [];
    for (const sg of c) {
      if (sg.type !== 2) {
        out.push(sg);
        continue;
      }
      let queue = [[[sg.p1, sg.p2, sg.p3, sg.p4], 0]];
      const done = [];
      while (queue.length) {
        const [cp, d] = queue.shift();
        if (d < depth && unfaithful(cp, frac)) {
          const [h1, h2] = deCast(cp, 0.5);
          queue.push([h1, d + 1], [h2, d + 1]);
        } else done.push(cp);
      }
      for (const cp of done) out.push({ type: 2, p1: cp[0], p2: cp[1], p3: cp[2], p4: cp[3] });
    }
    return out;
  });
const N = +(process.env.N || 512);
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const emX = (i) => ((i + 0.5) / N) * 900,
  emY = (j) => (1 - (j + 0.5) / N) * 900;
const EPP = 900 / N;
const TRN = Array.from({ length: 10 }, () => ({ n: 0, sum: 0, zero: 0 }));
let spill = 0,
  spillMax = 0,
  spillAt = null,
  inShort = 0;
for (const s of (process.env.SHAPES || '12,105,66,96,116').split(',').map(Number)) {
  const r = sec.curveRangesByShape[s];
  if (!r) continue;
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  let raw = curveRangeToContours(cf, r.begin | 0, r.end | 0);
  if (process.env.SPLIT)
    raw = splitContours(raw, +(process.env.SPLIT_FRAC || 0.05), +(process.env.SPLIT_DEPTH || 2));
  const cs = contoursToConverter(raw, null);
  const patches = [];
  try {
    packCPatchShape(cs, 0, { evenOdd, onPatches: (a) => patches.push(...a) });
  } catch {
    continue;
  }
  const all = [];
  for (const c of cs) for (const sg of c) all.push(sg);
  let x0 = 1e9,
    y0 = 1e9,
    x1 = -1e9,
    y1 = -1e9;
  for (const sg of all)
    for (const P of sg.P) {
      x0 = Math.min(x0, P[0]);
      x1 = Math.max(x1, P[0]);
      y0 = Math.min(y0, P[1]);
      y1 = Math.max(y1, P[1]);
    }
  const i0 = Math.max(0, Math.floor((x0 / 900) * N) - 2),
    i1 = Math.min(N - 1, Math.ceil((x1 / 900) * N) + 2);
  const j0 = Math.max(0, Math.floor((1 - y1 / 900) * N) - 2),
    j1 = Math.min(N - 1, Math.ceil((1 - y0 / 900) * N) + 2);
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const x = emX(i),
        y = emY(j);
      let a = 0;
      const M = 9;
      for (let g = 0; g < M; g++) {
        const yy = y + EPP * ((g + 0.5) / M - 0.5);
        let spans;
        if (!evenOdd) spans = rowSpans(all, yy) || [];
        else {
          const xs = [];
          for (const sg of all) rowCross(sg, yy, (v) => xs.push(v));
          xs.sort((p, q) => p - q);
          spans = [];
          for (let z = 0; z + 1 < xs.length; z += 2) spans.push([xs[z], xs[z + 1]]);
        }
        let c3 = 0;
        for (const sp of spans)
          c3 += Math.max(0, Math.min(x + EPP / 2, sp[1]) - Math.max(x - EPP / 2, sp[0]));
        a += c3 / EPP / M;
      }
      let got = 0;
      for (const p of patches) got = Math.min(1, got + patchCoverage(p, x, y, EPP));
      if (a <= 1e-6) {
        if (got > 0.02) {
          spill++;
          if (got > spillMax) {
            spillMax = got;
            spillAt = [i, j, s];
          }
        }
        continue;
      }
      if (a >= 0.999) {
        if (got < 0.98) inShort++;
        continue;
      }
      const b = Math.min(9, Math.floor(a * 10));
      TRN[b].n++;
      TRN[b].sum += got;
      if (got < 0.02) TRN[b].zero++;
    }
}
console.log(`CPatch kernel model, ${process.env.SET || '(defaults)'}`);
for (let b = 0; b < 10; b++) {
  const t = TRN[b];
  console.log(
    `  path ${(b / 10).toFixed(1)}-${((b + 1) / 10).toFixed(1)}  n=${String(t.n).padStart(5)}  ` +
      `mean drawn ${t.n ? (t.sum / t.n).toFixed(3) : '  -  '}   drew NOTHING: ${t.n ? ((100 * t.zero) / t.n).toFixed(0) : '-'}%`,
  );
}
console.log(
  `  ink outside the path: ${spill} px (worst ${spillMax.toFixed(3)}${spillAt ? ` @(${spillAt[0]},${spillAt[1]})s${spillAt[2]}` : ''})` +
    `   interior px short of full: ${inShort}`,
);
