// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchSeamSplitSmoke — a seam that is partly outline is split, and its outline stretches get their AA band.
//
// The converter can run one straight cut along a line that the far side borders only in stretches. On a text glyph 'a'
// (below) a seam runs up x = 8.494 from y = 0.244 to 0.612, and the patches across it hold seams on [0.244, 0.393] and
// [0.44, 0.504] and nothing else: on (0.393, 0.44) and (0.504, 0.612) that "seam" is the glyph's outline. As a seam it
// would wear no skirt and its step would reject everything past it, so the pixels whose centers fall just outside it --
// which the glyph covers by up to a fifth -- would get no fragment at all. So splitPartialSeams (cpatchPack) splits each straight seam
// where the far side's collinear pieces end: a piece with a patch across stays a seam, a piece with only empty space
// across (asked of the shape's own fill) becomes outline, with its skirt and its ramp.
//
// ONE CONTOUR'S CUTS DO NOT SEE THE whole FAR SIDE: this glyph packs as two cycle groups, and the bowl's top -- across
// the seam on [0.44, 0.504] -- is the other group's. So a stretch is asked of the shape's fill piece by piece, cut at the
// shape's own vertices on the line; asked whole, [0.393, 0.612] reads "filled across" at its middle and stays a seam.
//
// CHECKED on the glyph at its page's scale (2100 px across the page, so 0.01568 em a pixel), at four sub-pixel phases,
// through the pack's own mesh: (a) the patch that holds x = 8.494 carries it as seam AND outline pieces; (b) every
// pixel within 1.5 px of that line that the glyph covers past 32/255 has a CPatch fragment (unsplit, 8 at one phase
// have none). (c) Anywhere on the glyph, too, which also needs the skirt squared at sharp corners (cpatchPack, part 3):
// a capped miter starves the band at two of them, the bowl's left extreme and the arch's inner curve, one pixel each.
import path from 'path';
import { fileURLToPath } from 'url';
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
console.warn = () => {};
// the seam path: a glyph this simple is a complete paint unless the hook says otherwise
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__CP_NO_AREA = 1;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { default: importSvg } = await import('../src/svg/importer.js');
const CB = await import('../src/renderer/cpatchBuild.js');
const { LB_STRIDE, packCPatchShape } = await import('../src/renderer/cpatchPack.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { segPt } = await import('../src/geom/cpatchImplicit.js');

const A =
  'M8.508301 0.760254 Q8.500488 0.744629 8.495605 0.70459 Q8.432617 0.77002 8.345215 0.77002 Q8.26709 0.77002 8.217041 0.72583 Q8.166992 0.681641 8.166992 0.61377 Q8.166992 0.53125 8.229736 0.485596 Q8.29248 0.439941 8.40625 0.439941 L8.494141 0.439941 L8.494141 0.398438 Q8.494141 0.351074 8.46582 0.322998 Q8.4375 0.294922 8.382324 0.294922 Q8.333984 0.294922 8.30127 0.319336 Q8.268555 0.34375 8.268555 0.378418 L8.177734 0.378418 Q8.177734 0.338867 8.205811 0.302002 Q8.233887 0.265137 8.281982 0.243652 Q8.330078 0.222168 8.387695 0.222168 Q8.479004 0.222168 8.530762 0.267822 Q8.58252 0.313477 8.584473 0.393555 L8.584473 0.636719 Q8.584473 0.709473 8.603027 0.752441 L8.603027 0.760254 L8.508301 0.760254 Z M8.358398 0.691406 Q8.400879 0.691406 8.438965 0.669434 Q8.477051 0.647461 8.494141 0.612305 L8.494141 0.503906 L8.42334 0.503906 Q8.257324 0.503906 8.257324 0.601074 Q8.257324 0.643555 8.285645 0.66748 Q8.313965 0.691406 8.358398 0.691406 Z';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="8 0 1 1"><path d="${A}"/></svg>`;
const b = CB.headlessCPatchBundle(await importSvg(svg, { preserveViewport: true }));
const cf = CB.cpatchCurvePlane(b),
  r = b.curveRangesByShape[0];
const cs = CB.contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null);

// (a) the patch on x = 8.494 holds seam and outline pieces of that line
{
  const ps = [];
  packCPatchShape(cs, 0, { evenOdd: CB.shapeEvenOdd(b, 0), onPatches: (a) => ps.push(...a) });
  const onLine = (c) =>
    c.P.length === 2 &&
    Math.abs(c.P[0][0] - 8.494141) < 1e-5 &&
    Math.abs(c.P[1][0] - 8.494141) < 1e-5;
  const mixed = ps.filter(
    (p) => p.curves.some((c) => onLine(c) && c.cut) && p.curves.some((c) => onLine(c) && !c.cut),
  );
  ok(
    mixed.length > 0,
    `(a) a patch carries x = 8.494 as seam and outline pieces (${mixed.length} such patch${mixed.length === 1 ? '' : 'es'})`,
  );
}
// (b) every pixel by the seam's line that the glyph covers past 32/255 has a fragment, at four phases of the page's 2100 px grid
{
  const gl = {
    TEXTURE_2D: 1,
    RGBA32F: 2,
    RGBA: 3,
    FLOAT: 4,
    plane: null,
    bindTexture() {},
    texParameteri() {},
    texSubImage2D() {},
    deleteTexture() {},
    createTexture() {
      return {};
    },
  };
  gl.texImage2D = (...a) => {
    gl.plane = a[8];
  };
  CB.buildCPatchBundle(gl, b, { pool: false });
  const m = b._lbMeshes[0];
  const epp = 32.92138671875 / 2100,
    segs = [];
  for (const c of cs) {
    const a0 = c[0].P[0],
      z = c[c.length - 1].P[c[c.length - 1].P.length - 1];
    for (const g of a0[0] === z[0] && a0[1] === z[1] ? c : [...c, { t: 'line', P: [z, a0] }]) {
      const n = g.P.length === 2 ? 1 : 64;
      let prev = g.P[0];
      for (let k = 1; k <= n; k++) {
        const q = k === n ? g.P[g.P.length - 1] : segPt(g, k / n);
        segs.push([prev, q]);
        prev = q;
      }
    }
  }
  for (const [px, py] of [
    [0, 0],
    [0.25, 0.5],
    [0.5, 0.25],
    [0.75, 0.75],
  ]) {
    const ox = 8.1 + px * epp,
      oy = 0.2 + py * epp,
      W = Math.ceil(0.55 / epp),
      H = Math.ceil(0.6 / epp);
    const reached = new Set();
    for (let tri = 0; (tri + 1) * 3 * LB_STRIDE <= m.verts.length; tri++) {
      const q = [0, 1, 2].map((k) => {
        const o = (tri * 3 + k) * LB_STRIDE,
          v = m.verts;
        return [
          v[o] + v[o + 17] + v[o + 2] * 1.5 * epp,
          v[o + 1] + v[o + 18] + v[o + 3] * 1.5 * epp,
        ];
      });
      const ar =
        (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
      if (!(Math.abs(ar) > 0)) continue;
      const Q = ar > 0 ? q : [q[0], q[2], q[1]];
      const e = (a, c, p) => (c[0] - a[0]) * (p[1] - a[1]) - (c[1] - a[1]) * (p[0] - a[0]);
      for (let j = 0; j < H; j++)
        for (let i = 0; i < W; i++) {
          const p = [ox + (i + 0.5) * epp, oy + (j + 0.5) * epp];
          if (e(Q[0], Q[1], p) >= 0 && e(Q[1], Q[2], p) >= 0 && e(Q[2], Q[0], p) >= 0)
            reached.add(j * W + i);
        }
    }
    let missed = 0,
      inked = 0,
      missedAll = 0,
      inkedAll = 0;
    const SS = 12;
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        let n = 0;
        for (let sy = 0; sy < SS; sy++) {
          const y = oy + (j + (sy + 0.5) / SS) * epp,
            xs = [];
          for (const [a0, c] of segs)
            if (a0[1] <= y !== c[1] <= y)
              xs.push([
                a0[0] + ((y - a0[1]) / (c[1] - a0[1])) * (c[0] - a0[0]),
                c[1] > a0[1] ? 1 : -1,
              ]);
          for (let sx = 0; sx < SS; sx++) {
            const x = ox + (i + (sx + 0.5) / SS) * epp;
            let w = 0;
            for (const [cx, dw] of xs) if (cx > x) w += dw;
            if (w !== 0) n++;
          }
        }
        if (!(n / (SS * SS) > 32 / 255)) continue;
        inkedAll++;
        if (!reached.has(j * W + i)) missedAll++;
        if (Math.abs(ox + (i + 0.5) * epp - 8.494141) < 1.5 * epp) {
          inked++;
          if (!reached.has(j * W + i)) missed++;
        }
      }
    ok(
      inked > 30 && missed === 0,
      `(b) phase (${px}, ${py}): ${missed} of ${inked} pixels by the seam's line the glyph covers past 32/255 have no fragment`,
    );
    ok(
      inkedAll > 400 && missedAll === 0,
      `(c) phase (${px}, ${py}): ${missedAll} of ${inkedAll} pixels anywhere the glyph covers past 32/255 have no fragment`,
    );
  }
}
console.log(fail ? `cpatchSeamSplitSmoke FAIL (${fail})` : 'cpatchSeamSplitSmoke PASS');
process.exit(fail ? 1 : 0);
