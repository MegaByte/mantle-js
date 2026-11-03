// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchSeamPartitionSmoke — a point on a seam inside the shape is covered, at every zoom.
//
// THE TRAP. A seam is shared by two patches, each keeping what is on its side. Allowing each a thousandth of a PIXEL
// past it does not cover what it has to: rounding of the POSITION -- two copies of one seam, interpolated from
// different triangles -- is a fraction of the coordinates, so a fixed fraction of a pixel stops covering it as the view
// zooms in; and a curved seam packing a different implicit on each side has roundings that differ at any zoom. On
// tiger, points on interior seams covered under half would be 0 / 1,634 / 6,350 at 512 px and 100x and 1000x in.
//
// THE RULE. A curved seam packs one implicit on both sides (cpatchPack), and a cut claims the position's own resolution,
// CP_POS_REL (|x| + |y|) in the contour's frame. Under it, a tie allowance only for a center exactly on the seam, CP_CUT_TIE (a pixel's thousandth): it is not what covers the position's
// rounding, which still grows with the zoom; the converter makes no seam cracks of its own -- both copies of a line seam end on the
// same points, every piece and reversal of a seam keeps the seam's implicit, and a cut steps on its zero set.
//
// CHECKED, through the SHIPPED kernel text in float32 (test/_glslEmu.mjs), on tiger's shape 35 (the fixture
// cpatchSeamCompanionSmoke uses): points one to seven eighths along each seam, inside the shape and three pixels or
// more from its outline, composed through every cover fragment at the point, at tiger@512's pixel size and 100x and
// 1000x in:
//   (a) no more than 2 are covered under half at any zoom (it reads 0 / 0 / 0; without the position's claim, 0 / 13 / 60);
//   (b) mutation: the kernel with the fixed thousandth in place of the position's claim leaves more open at 1000x.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, K_CPATCH_COV } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
// The seam path is what this smoke exists for: a shape this simple is one complete paint with no seams, unless the hook says otherwise.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__CP_NO_AREA = 1;
const { default: importSvg } = await import('../src/svg/importer.js');
const CB = await import('../src/renderer/cpatchBuild.js');
const I = await import('../src/geom/cpatchImplicit.js');
const { insideRule } = await import('../src/renderer/cpatchConvert.js');
const { LB_STRIDE } = await import('../src/renderer/cpatchPack.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');

// tiger's shape 35, stroke-stripped, in tiger's em; tiger at 512 px draws 1.7578125 em a pixel
const D =
  'M272.2909 561.525618 C272.2909 561.525618 298.422465 550.93174 369.048317 561.525618 C369.048317 561.525618 381.760971 562.231876 393.767366 546.694189 C405.773761 531.156501 453.093081 518.443848 464.393218 521.975141 L481.345188 533.275277 L482.757705 535.394052 C482.757705 535.394052 504.649953 553.756774 505.356212 567.175686 C506.06247 580.594598 479.932671 665.34562 462.980701 693.595961 C446.030496 721.846302 429.080292 743.740316 395.179883 739.502765 C395.179883 739.502765 358.45444 732.44018 313.253894 739.502765 C313.253894 739.502765 261.697022 736.677731 256.753213 722.55256 C251.809403 708.42739 276.528451 681.589566 276.528451 681.589566 C276.528451 681.589566 284.297295 666.758137 282.17852 641.33283 C281.631074 634.76348 281.272225 626.59105 280.894874 617.997232 C279.811766 593.330462 278.576219 565.192054 272.2909 561.525618 Z';
const EPP = 1.7578125;

async function holes(emu) {
  const sec = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 900"><path d="${D}"/></svg>`,
    { preserveViewport: true },
  );
  const b = CB.headlessCPatchBundle(sec);
  const gl = {
    TEXTURE_2D: 1,
    texImage2D(...a) {
      gl.plane = a[8];
    },
    bindTexture() {},
    texParameteri() {},
    texSubImage2D() {},
    deleteTexture() {},
    createTexture() {
      return {};
    },
  };
  const ps = [];
  CB.buildCPatchBundle(gl, b, { pool: false, onPatches: (a) => ps.push(...a) });
  const m = (b._lbMeshes || [])[0];
  if (!m || !m.cpatch) return null;
  const r = b.curveRangesByShape[0];
  const outline = [];
  for (const c of CB.contoursToConverter(
    curveRangeToContours(CB.cpatchCurvePlane(b), r.begin, r.end),
    null,
  ))
    for (const g of c) outline.push(g);
  // each seam once, whichever side it came from
  const seen = new Set(),
    pts = [];
  for (const p of ps)
    for (const c of p.curves)
      if (c.cut) {
        const k = [c.P, c.P.slice().reverse()]
          .map((P) => P.map((q) => q.join(',')).join(';'))
          .sort()[0];
        if (seen.has(k)) continue;
        seen.add(k);
        for (let i = 1; i < 8; i++) pts.push(I.segPt(c, i / 8));
      }
  const keep = pts.filter((x) => insideRule(outline, x[0], x[1], false));
  const dO = keep.map((x) => {
    let d = Infinity;
    for (const g of outline)
      for (let k = 0; k <= 64; k++) {
        const q = I.segPt(g, k / 64);
        d = Math.min(d, Math.hypot(q[0] - x[0], q[1] - x[1]));
      }
    return d;
  });
  const St = LB_STRIDE,
    tris = [];
  for (let tri = 0; (tri + 1) * 3 * St <= m.verts.length; tri++)
    tris.push([0, 1, 2].map((k) => m.verts.subarray((tri * 3 + k) * St, (tri * 3 + k + 1) * St)));
  const out = [];
  for (const epp of [EPP, EPP / 100, EPP / 1000]) {
    const qs = [],
      own = [];
    keep.forEach((x, pi) => {
      if (dO[pi] < 3 * epp) return;
      for (const vs of tris) {
        const q = vs.map((v) => [v[0] + v[17] + v[2] * 1.5 * epp, v[1] + v[18] + v[3] * 1.5 * epp]);
        let area =
          (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
        if (!(Math.abs(area) > 0)) continue;
        const sg = Math.sign(area),
          e = (a2, b2) =>
            sg * ((b2[0] - a2[0]) * (x[1] - a2[1]) - (b2[1] - a2[1]) * (x[0] - a2[0]));
        const w0 = e(q[1], q[2]),
          w1 = e(q[2], q[0]),
          w2 = e(q[0], q[1]);
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        area = Math.abs(area);
        const tc = [2, 3, 4].map((c) => (w0 * vs[0][c] + w1 * vs[1][c] + w2 * vs[2][c]) / area);
        const f = vs[2];
        qs.push({
          k: K_CPATCH_COV,
          GD: [f[7], f[8], f[9], f[10]],
          bb: [f[11], f[12], f[13], f[14]],
          c: [x[0] - f[17], x[1] - f[18]],
          ePx: [f[19], f[20]],
          ex: [tc[0], tc[1], tc[2], f[15], f[16], epp],
        });
        own.push(pi);
      }
    });
    const res = qs.length ? emu.run(new Float32Array(4), gl.plane, qs) : [];
    const cov = new Map();
    res.forEach((v, k) =>
      cov.set(own[k], 1 - (1 - (cov.get(own[k]) ?? 0)) * (1 - Math.max(0, Math.min(1, v)))),
    );
    let n = 0,
      h = 0;
    keep.forEach((x, pi) => {
      if (dO[pi] < 3 * epp) return;
      n++;
      if ((cov.get(pi) ?? 0) < 0.5) h++;
    });
    out.push([h, n]);
  }
  return out;
}

if (!hasCxx()) {
  console.log('  SKIPPED: no C++ compiler for the kernel emulation');
} else {
  const LBL = ['512 px', '100x in', '1000x in'];
  const r = await holes(buildGlslEmu(ROOT, { cpatch: true }));
  if (!r) ok(false, 'the shape builds as CPatch');
  else
    r.forEach(([h, n], i) =>
      ok(
        h <= 2,
        `(a) ${LBL[i]}: ${h} of ${n} interior seam points covered under half (bar 2; the previous tree 0 / 13 / 60)`,
      ),
    );
  // (b) the fixed thousandth restored
  const text = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
  const old = text.replace(
    /CP_POS_REL \* \(abs\(p\.x\) \+ abs\(p\.y\)\) \* invPx \+ CP_CUT_TIE/g,
    '0.001',
  ); // the whole allowance, or the tie stays beside it and the mutation is 0.002
  ok(old !== text, '(b) the mutation applies to the shipped text');
  const r0 = await holes(buildGlslEmu(ROOT, { cpatch: true, glsl: old }));
  ok(
    r && r0 && r0[2][0] > r[2][0],
    `(b) mutation: with the fixed thousandth in its place, ${r0 ? r0[2][0] : '?'} are open at 1000x in, against ${r ? r[2][0] : '?'}`,
  );
}
console.log(fail ? `cpatchSeamPartitionSmoke FAIL (${fail})` : 'cpatchSeamPartitionSmoke PASS');
process.exit(fail ? 1 : 0);
