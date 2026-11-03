// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// CPatch conversion and packing preserve the decomposition under exactly
// representable translations and power-of-two scales. Rendering-model coverage
// checks live in cpatchFrameCoverageDiagnostic.mjs.
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
  console.log(
    `  at the origin: ${refC && refC.patches.length} patches converted, ${refPk.length} packed`,
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
  }
}

console.log(
  fail ? `\ncpatchFrameInvarianceSmoke FAIL (${fail})` : '\ncpatchFrameInvarianceSmoke PASS',
);
process.exit(fail ? 1 : 0);
