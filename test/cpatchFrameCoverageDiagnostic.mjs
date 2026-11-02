// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Development coverage-model diagnostic for CPatch frame invariance.
// Compares sampled coverage error under exactly representable translations
// and power-of-two scales. This is not a GPU rendering validation.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__CP_NO_AREA = 1;
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { convertContour } = await import('../src/renderer/cpatchConvert.js');
const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
const { patchCoverage } = await import('../src/renderer/cpatchCov.js');
const { default: importSvg } = await import('../src/svg/importer.js');
const cb = await import('../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
console.warn = () => {};

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const Q = 2 ** 20;
const quant = (cs) =>
  cs.map((c) => {
    const o = { t: c.t, P: c.P.map((p) => [Math.round(p[0] * Q) / Q, Math.round(p[1] * Q) / Q]) };
    if (c.w !== undefined) o.w = c.w;
    return o;
  });
/// Every coordinate times s plus (tx, ty), refusing a placement that is not exact.
const place = (cs, s, tx, ty) =>
  cs.map((c) => {
    const o = {
      t: c.t,
      P: c.P.map((p) => {
        const q = [p[0] * s + tx, p[1] * s + ty];
        if ((q[0] - tx) / s !== p[0] || (q[1] - ty) / s !== p[1])
          throw new Error('inexact placement');
        return q;
      }),
    };
    if (c.w !== undefined) o.w = c.w;
    return o;
  });
const ulp = (x) => {
  const a = Math.abs(x);
  return a ? 2 ** (Math.floor(Math.log2(a)) - 52) : Number.MIN_VALUE;
};

/// Same patches under the placement: count, kinds, seams, control points within 4 ulps.
function samePatches(ref, got, s, tx, ty) {
  if (!ref || !got || ref.length !== got.length)
    return `count ${ref && ref.length} vs ${got && got.length}`;
  for (let i = 0; i < ref.length; i++) {
    const a = ref[i].curves,
      b = got[i].curves;
    if (a.length !== b.length) return `patch ${i}: ${a.length} vs ${b.length} curves`;
    for (let j = 0; j < a.length; j++) {
      if (a[j].t !== b[j].t || !!a[j].cut !== !!b[j].cut || a[j].w !== b[j].w)
        return `patch ${i} curve ${j}: ${a[j].t} vs ${b[j].t}`;
      for (let k = 0; k < a[j].P.length; k++)
        for (let d = 0; d < 2; d++) {
          const want = a[j].P[k][d] * s + (d ? ty : tx),
            have = b[j].P[k][d];
          if (!(Math.abs(have - want) <= 4 * ulp(Math.max(Math.abs(want), Math.abs(d ? ty : tx)))))
            return `patch ${i} curve ${j} point ${k}: ${have} vs ${want}`;
        }
    }
  }
  return null;
}

/// The contour's exact coverage (8x8 samples, nonzero) and the patches' drawn coverage (the CPU
/// kernel model, patches OVER-composited) on a grid of `N` pixels across the contour, placed with it.
function drawError(contour, patches, N = 64) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of contour)
    for (const p of c.P) {
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
  const epp = Math.max(x1 - x0, y1 - y0) / N,
    W = N + 4,
    gx = x0 - 2 * epp,
    gy = y0 - 2 * epp;
  const segs = [];
  for (const c of contour) {
    const at = (u) => {
      if (c.t === 'rquad') {
        const w = c.w,
          a = (1 - u) * (1 - u),
          b = 2 * u * (1 - u) * w,
          d = u * u,
          t = a + b + d;
        return [
          (a * c.P[0][0] + b * c.P[1][0] + d * c.P[2][0]) / t,
          (a * c.P[0][1] + b * c.P[1][1] + d * c.P[2][1]) / t,
        ];
      }
      let P = c.P.map((z) => z.slice());
      while (P.length > 1)
        P = P.slice(1).map((z, i) => [
          P[i][0] + (z[0] - P[i][0]) * u,
          P[i][1] + (z[1] - P[i][1]) * u,
        ]);
      return P[0];
    };
    const n = c.t === 'line' ? 1 : 64;
    let prev = c.P[0];
    for (let k = 1; k <= n; k++) {
      const q = k === n ? c.P[c.P.length - 1] : at(k / n);
      segs.push([prev, q]);
      prev = q;
    }
  }
  const SS = 8;
  let off32 = 0,
    offHalf = 0,
    sum = 0;
  for (let j = 0; j < W; j++)
    for (let i = 0; i < W; i++) {
      let inside = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const x = gx + (i + (sx + 0.5) / SS) * epp,
            y = gy + (j + (sy + 0.5) / SS) * epp;
          let w = 0;
          for (const [a, b] of segs) {
            if (a[1] <= y === b[1] <= y) continue;
            if (a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]) > x) w += b[1] > a[1] ? 1 : -1;
          }
          if (w !== 0) inside++;
        }
      const exact = inside / (SS * SS);
      const px = gx + (i + 0.5) * epp,
        py = gy + (j + 0.5) * epp;
      let miss = 1;
      for (const p of patches) miss *= 1 - Math.max(0, Math.min(1, patchCoverage(p, px, py, epp)));
      const e = Math.abs(1 - miss - exact);
      sum += e;
      if (e > 32 / 255) off32++;
      if (e >= 0.5) offHalf++;
    }
  return { off32, offHalf, sum };
}

// ---------------------------------------------------------------- the contours
const contours = [];
{
  // noAaArcRow__FAR's second ring: two elliptical arcs at 60 degrees, as eight rational quadratics,
  // moved to the origin (exactly: y - 1e5 at these magnitudes) and quantized.
  const sec = await importSvg(
    readFileSync(path.join(ROOT, 'examples/smoke/noAaArcRow__FAR.svg'), 'utf8'),
  );
  const b = cb.headlessCPatchBundle(sec),
    cf = cb.cpatchCurvePlane(b),
    r = b.curveRangesByShape[11];
  const cs = cb.contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null);
  const got = [];
  packCPatchShape(cs, 0, { evenOdd: cb.shapeEvenOdd(b, 11), collect: got });
  contours.push({
    name: "FAR's rotated ring",
    curves: quant(got[0].curves.map((c) => ({ ...c, P: c.P.map((p) => [p[0], p[1] - 1e5]) }))),
  });
}
{
  // A cubic blob (fillBezoutOmit__BLOB), about its own box corner.
  const sec = await importSvg(
    readFileSync(path.join(ROOT, 'examples/smoke/fillBezoutOmit__BLOB.svg'), 'utf8'),
  );
  const b = cb.headlessCPatchBundle(sec),
    cf = cb.cpatchCurvePlane(b),
    r = b.curveRangesByShape[0];
  const cs = cb.contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null);
  contours.push({ name: 'a cubic blob', curves: quant(cs[0]) });
}

const PLACES = [
  { name: 'at y = 1e5', s: 1, tx: 0, ty: 1e5 },
  { name: 'at y = 1e7', s: 1, tx: 0, ty: 1e7 },
  { name: 'at x = -1e5', s: 1, tx: -1e5, ty: 0 },
  { name: 'x 2^20', s: 2 ** 20, tx: 0, ty: 0 },
  { name: 'x 2^-20', s: 2 ** -20, tx: 0, ty: 0 },
];
const CO = { maxCurves: 8, search: 'full' };
for (const { name, curves } of contours) {
  console.log(`\n-- ${name} (${curves.length} curves) --`);
  const refC = convertContour(curves, CO);
  const refPk = [];
  packCPatchShape([curves], 0, {
    onPatches: (ps) => {
      for (const p of ps) refPk.push(p);
    },
  });
  const refD = drawError(curves, refPk);
  console.log(
    `  at the origin: ${refC && refC.patches.length} patches converted, ${refPk.length} packed; drawn off>32/255 ${refD.off32}, off>=0.5 ${refD.offHalf}, summed ${refD.sum.toFixed(4)}`,
  );
  for (const P of PLACES) {
    const moved = place(curves, P.s, P.tx, P.ty);
    const c = convertContour(moved, CO);
    const whyC = samePatches(refC && refC.patches, c && c.patches, P.s, P.tx, P.ty);
    ok(
      !whyC,
      `C. ${P.name}: the same ${refC && refC.patches.length} patches${whyC ? ' -- ' + whyC : ''}`,
    );
    const pk = [];
    packCPatchShape([moved], 0, {
      onPatches: (ps) => {
        for (const p of ps) pk.push(p);
      },
    });
    const whyP = samePatches(refPk, pk, P.s, P.tx, P.ty);
    ok(
      !whyP,
      `P. ${P.name}: packCPatchShape's ${refPk.length} patches likewise${whyP ? ' -- ' + whyP : ''}`,
    );
    const d = drawError(moved, pk);
    ok(
      d.off32 === refD.off32 &&
        d.offHalf === refD.offHalf &&
        Math.abs(d.sum - refD.sum) <= 1e-6 * (1 + refD.sum),
      `D. ${P.name}: drawn off>32/255 ${d.off32}, off>=0.5 ${d.offHalf}, summed ${d.sum.toFixed(4)}`,
    );
  }
}

console.log(
  fail ? `\ncpatchFrameCoverageDiagnostic FAIL (${fail})` : '\ncpatchFrameCoverageDiagnostic PASS',
);
process.exit(fail ? 1 : 0);
