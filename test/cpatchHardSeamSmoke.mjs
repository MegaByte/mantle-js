// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchHardSeamSmoke — owned seams paint what the shape covers there.
//
// A SEAM (owned on every draw) gives a pixel to the one patch whose side of the seam its center is on, and that patch
// paints the shape's whole coverage of the pixel. Three things can keep that from being true, and the second and third
// are wrong for any seam; owned seams are just where nothing hides them:
//   HULL   the hull plane only ever decides the AA band beside the patch's own arc -- ownership is the seam's -- so a
//          stepped hull plane takes the band off the outline (the star at 512 px: 462 pixels whose fragments are all
//          hull-rejected). It ramps beside the arc, as under relaxed seams.
//   SPAN   a seam's step is its implicit's sign, and the zero set runs on past the seam's ends -- as the very outline the
//          seam meets, where a curve is split into a seam piece and an outline piece. Past the filter's reach of the
//          seam's own bound it does not step (otherwise ~1000 pixels of a corpus asset at 512 px go unowned).
//   SIDE   a curved seam's implicit is the whole algebraic curve, t outside [0, 1] included, and that curve can pass between
//          the arc and a fragment the patch owns and flip f's sign: tiger's shape 4 below, a nearly straight seam whose far
//          branch runs a pixel from it. Where the implicit rejects, the arc decides.
//
// CHECKED through the SHIPPED kernel text in float32 (test/_glslEmu.mjs), every CPatch cover fragment rasterized as the
// vertex stage dilates it and OVER-composited, against 12x12-sample exact coverage (the shape's own fill rule): pixels off
// by more than 32/255 (relaxed seams in brackets) --
//   (a) HULL: the star at 512 px, 73 [76];
//   (b) SIDE: tiger's shape 4 on tiger's 512 px grid, 1 [2], and the pixel behind the far branch painted as the shape
//       covers it (0.194; with only the hull and the span, 0);
//   (c) SPAN: tiger's shape 100 on the same grid, 16 [13] (with the hull ramp alone 39);
//   (d) all three at 2^-20 of their size: the same counts as at 1, shape 100 included, and its pixel (190, 122) the same value
//       (0.246 against 0.188 exact). The Newton step of the curve kernel floors |grad|^2 at float32's smallest normal number,
//       not an absolute length: the Bezout form's |grad|^2 goes as the tenth power of the shape's size, so a floor of 1e-30
//       would catch shape 100 at 1 (0.444 there: one seam's half-coverage ramp painted where the patch is not the owner) and
//       not at 2^-20;
//   (f) all three at 2^20: the same counts as at 1, within one pixel for shape 100 (the Bezout form's f goes as the size to
//       the sixth power, so this is the float32-overflow guard).
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
console.warn = () => {};
// The seam path is what this smoke exists for: a shape this simple is one complete paint with no seams, unless the hook says otherwise.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__CP_NO_AREA = 1;
const { default: importSvg } = await import('../src/svg/importer.js');
const CB = await import('../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { LB_STRIDE } = await import('../src/renderer/cpatchPack.js');
const { segPt } = await import('../src/geom/cpatchImplicit.js');

const STAR = readFileSync(
  path.join(ROOT, 'examples/smoke/engineDeclineIsolation__STAR.svg'),
  'utf8',
);
// tiger's shape 4, stroke-stripped, in tiger's em, and tiger's own 512 px grid: its bounding box's longer side over 512,
// framed 4 px out
const SHAPE4 =
  'M163.731903 473.225646 C163.731903 473.225646 166.6205 474.920667 165.790647 476.121306 C165.655539 476.313498 163.250861 475.877945 159.245998 475.152556 C138.599996 471.413008 75.4268048 459.970636 61.4374191 487.121283 C61.4374191 487.121283 67.9349975 453.768224 163.731903 473.225646 Z';
// ...and its shape 100, whose seams' implicits run on past their ends through its own skirts
const SHAPE100 =
  'M341.758488 198.339236 C341.624516 198.517866 341.536701 198.92186 341.490421 199.525298 C340.775506 208.846969 349.972058 265.761856 352.041612 274.729924 C354.245139 284.278539 349.838086 328.34907 349.838086 328.34907 C371.725221 321.627379 376.350449 318.352559 377.826803 317.307249 C378.518993 316.817154 378.518993 316.817154 379.281344 317.181783 C380.754116 317.886204 385.072109 319.951483 402.722724 322.472999 C412.595844 323.883391 422.301711 322.284659 431.490803 318.739683 C465.371458 305.669172 492.226902 266.140737 494.538097 253.429167 C497.476132 237.268206 480.582429 217.436467 480.582429 217.436467 C482.785955 212.294905 474.706358 188.790621 465.892251 173.365935 C458.404686 160.262695 438.123148 159.464145 414.237277 158.52368 C410.005518 158.357062 405.660627 158.185989 401.253706 157.941249 C376.613024 156.572322 348.145375 190.283922 342.597393 197.261608 C342.191744 197.771791 341.908625 198.139054 341.758488 198.339236 L341.758488 198.339236 Z';
const TIGER_EPP = 1.828058841019734,
  TIGER_O = [-7.160399323078969, -25.0921916861828];

function glStub() {
  const g = {
    TEXTURE_2D: 1,
    RGBA32F: 2,
    RGBA: 3,
    FLOAT: 4,
    TEXTURE_MIN_FILTER: 5,
    TEXTURE_MAG_FILTER: 6,
    TEXTURE_WRAP_S: 7,
    TEXTURE_WRAP_T: 8,
    NEAREST: 9,
    CLAMP_TO_EDGE: 10,
    plane: null,
  };
  g.bindTexture = () => {};
  g.texParameteri = () => {};
  g.texSubImage2D = () => {};
  g.deleteTexture = () => {};
  g.createTexture = () => ({});
  g.texImage2D = (...a) => {
    g.plane = a[8];
  };
  return g;
}
const scaled = (svg, S) =>
  svg.replace(
    /(d="|viewBox="|width="|height=")([^"]*)"/g,
    (m, k, v) => `${k}${v.replace(/-?\d+(\.\d+)?(e-?\d+)?/g, (n) => String(Number(n) * S))}"`,
  );

/// Every CPatch shape of the SVG on the grid (origin O, epp): its fragments through each kernel, OVER-composited per
/// shape, against exact coverage. Returns, per kernel, the pixels off by more than 32/255, and the coverage map.
async function frame(svg, emus, O, epp) {
  const b = CB.headlessCPatchBundle(await importSvg(svg, { preserveViewport: true })),
    gl = glStub();
  CB.buildCPatchBundle(gl, b, { pool: false });
  const cf = CB.cpatchCurvePlane(b),
    St = LB_STRIDE;
  const off = emus.map(() => 0),
    covs = emus.map(() => new Map());
  let shapes = 0,
    px = 0;
  for (let s = 0; s < b.curveRangesByShape.length; s++) {
    const m = (b._lbMeshes || [])[s];
    if (!m || !m.cpatch) continue;
    shapes++;
    const qs = [],
      pix = [];
    for (let tri = 0; (tri + 1) * 3 * St <= m.verts.length; tri++) {
      const vs = [0, 1, 2].map((k) => m.verts.subarray((tri * 3 + k) * St, (tri * 3 + k + 1) * St));
      const q = vs.map((v) => [v[0] + v[17] + v[2] * 1.5 * epp, v[1] + v[18] + v[3] * 1.5 * epp]);
      let area =
        (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
      if (!(Math.abs(area) > 0)) continue;
      const o = area > 0 ? [0, 1, 2] : [0, 2, 1],
        Q = o.map((k) => q[k]),
        W = o.map((k) => vs[k]);
      area = Math.abs(area);
      const edge = (a, c, p) => (c[0] - a[0]) * (p[1] - a[1]) - (c[1] - a[1]) * (p[0] - a[0]);
      const inE = (w, a, c) =>
        w > 0 || (w === 0 && (c[1] - a[1] < 0 || (c[1] === a[1] && c[0] > a[0])));
      const xs = Q.map((p) => p[0]),
        ys = Q.map((p) => p[1]),
        f = W[2];
      for (
        let j = Math.floor((Math.min(...ys) - O[1]) / epp - 0.5);
        j <= Math.ceil((Math.max(...ys) - O[1]) / epp);
        j++
      )
        for (
          let i = Math.floor((Math.min(...xs) - O[0]) / epp - 0.5);
          i <= Math.ceil((Math.max(...xs) - O[0]) / epp);
          i++
        ) {
          const p = [O[0] + (i + 0.5) * epp, O[1] + (j + 0.5) * epp];
          const w0 = edge(Q[1], Q[2], p),
            w1 = edge(Q[2], Q[0], p),
            w2 = edge(Q[0], Q[1], p);
          if (!(inE(w0, Q[1], Q[2]) && inE(w1, Q[2], Q[0]) && inE(w2, Q[0], Q[1]))) continue;
          const tc = [2, 3, 4].map((c) => (w0 * W[0][c] + w1 * W[1][c] + w2 * W[2][c]) / area);
          qs.push({
            k: K_CPATCH_COV,
            GD: [f[7], f[8], f[9], f[10]],
            bb: [f[11], f[12], f[13], f[14]],
            c: [p[0] - f[17], p[1] - f[18]],
            ePx: [f[19], f[20]],
            ex: [tc[0], tc[1], tc[2], f[15], f[16], epp],
          });
          pix.push(`${i},${j}`);
        }
    }
    // exact: the outline flattened finely, the shape's own fill rule per sample
    const cs = CB.contoursToConverter(
      curveRangeToContours(cf, b.curveRangesByShape[s].begin, b.curveRangesByShape[s].end),
      null,
    );
    const eo = CB.shapeEvenOdd(b, s),
      segs = [];
    for (const c of cs) {
      const a = c[0].P[0],
        z = c[c.length - 1].P[c[c.length - 1].P.length - 1];
      for (const g of a[0] === z[0] && a[1] === z[1] ? c : [...c, { t: 'line', P: [z, a] }]) {
        const n = g.P.length === 2 ? 1 : 128;
        let prev = g.P[0];
        for (let k = 1; k <= n; k++) {
          const q = k === n ? g.P[g.P.length - 1] : segPt(g, k / n);
          segs.push([prev[0], prev[1], q[0], q[1]]);
          prev = q;
        }
      }
    }
    // 12 x 12 samples a pixel, a scanline at a time over the shape's pixel box
    let bx0 = Infinity,
      by0 = Infinity,
      bx1 = -Infinity,
      by1 = -Infinity;
    for (const [xa, ya] of segs) {
      bx0 = Math.min(bx0, xa);
      bx1 = Math.max(bx1, xa);
      by0 = Math.min(by0, ya);
      by1 = Math.max(by1, ya);
    }
    const i0 = Math.floor((bx0 - O[0]) / epp) - 1,
      i1 = Math.ceil((bx1 - O[0]) / epp) + 1;
    const j0 = Math.floor((by0 - O[1]) / epp) - 1,
      j1 = Math.ceil((by1 - O[1]) / epp) + 1;
    const SS = 12,
      ex = new Map();
    for (let j = j0; j <= j1; j++)
      for (let sy = 0; sy < SS; sy++) {
        const y = O[1] + (j + (sy + 0.5) / SS) * epp,
          xs = [];
        for (const [xa, ya, xb, yb] of segs)
          if (ya <= y !== yb <= y)
            xs.push([xa + ((y - ya) / (yb - ya)) * (xb - xa), yb > ya ? 1 : -1]);
        if (!xs.length) continue;
        xs.sort((u, v) => u[0] - v[0]);
        let w = 0,
          k = 0;
        for (let i = i0; i <= i1; i++)
          for (let sx = 0; sx < SS; sx++) {
            const x = O[0] + (i + (sx + 0.5) / SS) * epp;
            while (k < xs.length && xs[k][0] <= x) w += xs[k++][1];
            if (eo ? w & 1 : w !== 0)
              ex.set(`${i},${j}`, (ex.get(`${i},${j}`) || 0) + 1 / (SS * SS));
          }
      }
    for (const k of pix) if (!ex.has(k)) ex.set(k, 0); // reached by a fragment, covered by nothing
    emus.forEach((emu, a) => {
      const out = emu.run(new Float32Array(4), gl.plane, qs),
        cov = new Map();
      out.forEach((v, k) =>
        cov.set(pix[k], 1 - (1 - (cov.get(pix[k]) ?? 0)) * (1 - Math.max(0, Math.min(1, v)))),
      );
      for (const [k, e] of ex) {
        const g = cov.get(k) ?? 0;
        if (Math.abs(g - e) > 32 / 255) off[a]++;
        covs[a].set(`${s}:${k}`, [g, e]);
      }
    });
    px += ex.size;
  }
  return { shapes, px, off, covs };
}

if (!hasCxx()) {
  console.log('  SKIPPED: no C++ compiler for the kernel emulation');
} else {
  const hard = buildGlslEmu(ROOT, { cpatch: true });
  const star = {},
    s4 = {},
    s100 = {};
  for (const k of [0, -20, -16, 16, 20]) {
    const S = 2 ** k;
    // the star: 512 px across its bounding box, framed 4 px out
    const sv = scaled(STAR, S);
    const b = CB.headlessCPatchBundle(await importSvg(sv, { preserveViewport: true }));
    const cf = CB.cpatchCurvePlane(b);
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const r of b.curveRangesByShape)
      for (const c of CB.contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null))
        for (const g of c)
          for (const q of g.P) {
            x0 = Math.min(x0, q[0]);
            x1 = Math.max(x1, q[0]);
            y0 = Math.min(y0, q[1]);
            y1 = Math.max(y1, q[1]);
          }
    const epp = Math.max(x1 - x0, y1 - y0) / 512;
    star[k] = await frame(sv, [hard], [x0 - 4 * epp, y0 - 4 * epp], epp);
    const svg4 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${900 * S} ${900 * S}"><path d="${SHAPE4.replace(/-?\d+(\.\d+)?/g, (n) => String(Number(n) * S))}"/></svg>`;
    s4[k] = await frame(svg4, [hard], [TIGER_O[0] * S, TIGER_O[1] * S], TIGER_EPP * S);
    const svg100 = svg4.replace(
      /d="[^"]*"/,
      `d="${SHAPE100.replace(/-?\d+(\.\d+)?/g, (n) => String(Number(n) * S))}"`,
    );
    s100[k] = await frame(svg100, [hard], [TIGER_O[0] * S, TIGER_O[1] * S], TIGER_EPP * S);
  }
  const r = star[0];
  ok(
    r.shapes > 0 && r.off[0] <= 73,
    `(a) the star at 512 px: ${r.off[0]} pixels off exact by more than 32/255 (bar 73; relaxed seams 76)`,
  );
  const t = s4[0];
  const far = t.covs[0].get('0:88,273') || [NaN, NaN];
  ok(
    t.shapes > 0 && t.off[0] <= 1 && Math.abs(far[0] - far[1]) <= 32 / 255,
    `(b) tiger's shape 4 on tiger's 512 px grid: ${t.off[0]} pixels off by more than 32/255 (bar 1; relaxed 2); the pixel behind the far branch, (88, 273), paints ${far[0].toFixed(3)} against ${far[1].toFixed(3)}`,
  );
  const u = s100[0];
  ok(
    u.shapes > 0 && u.off[0] <= 16,
    `(c) tiger's shape 100 on the same grid: ${u.off[0]} pixels off by more than 32/255 (bar 16; with the hull ramp alone 39; relaxed 13)`,
  );
  const px100 = (k) =>
    s100[k].covs[0].get('1:190,122') || s100[k].covs[0].get('0:190,122') || [NaN, NaN];
  for (const k of [-20, -16])
    ok(
      star[k].off[0] === r.off[0] &&
        s4[k].off[0] === t.off[0] &&
        s100[k].off[0] === u.off[0] &&
        Math.abs(px100(k)[0] - px100(0)[0]) <= 1e-6,
      `(d) at 2^${k}: star ${star[k].off[0]}, shape 4 ${s4[k].off[0]}, shape 100 ${s100[k].off[0]} and its pixel (190, 122) ${px100(k)[0].toFixed(4)}, as at 1 (${px100(0)[0].toFixed(4)}, exact ${px100(0)[1].toFixed(4)})`,
    );
  ok(
    px100(0)[0] <= px100(0)[1] + 32 / 255,
    `(e) shape 100 pixel (190, 122) at 1: ${px100(0)[0].toFixed(4)} against ${px100(0)[1].toFixed(4)} exact (a 1e-30 floor reads 0.444)`,
  );
  ok(
    star[20].off[0] === r.off[0] &&
      s4[20].off[0] === t.off[0] &&
      Math.abs(s100[20].off[0] - u.off[0]) <= 1,
    `(f) at 2^20 (the float32-overflow guard of the Bezout form): star ${star[20].off[0]}, shape 4 ${s4[20].off[0]}, shape 100 ${s100[20].off[0]}`,
  );
}
console.log(fail ? `cpatchHardSeamSmoke FAIL (${fail})` : 'cpatchHardSeamSmoke PASS');
process.exit(fail ? 1 : 0);
