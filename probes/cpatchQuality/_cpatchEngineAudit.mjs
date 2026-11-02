// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchEngineAudit — CPatch's coverage scored exactly as the Loop-Blinn AA audit scores Loop-Blinn's. NO GPU.
//
//   node probes/cpatchQuality/_cpatchEngineAudit.mjs OUT.json FILE.svg [--companion]      CANVAS=512 SLICES=64 PAD=2
//
// The Loop-Blinn side is probes/lbAccuracy/_lbAaAudit.mjs, run as
//   CANVAS=512 node probes/lbAccuracy/_lbAaAudit.mjs OUT.json FILE.svg
// and this is its CPatch twin: the same fit (the bundle's globalBBox, as mantle.vert maps em to the window), the same
// CANVAS x CANVAS raster, every shape scored SOLO against the same reference (exact in x from rowSpans, SLICES slices
// in y), and the same numbers -- AA error over the path's partial pixels, miss over its full ones, stray over its empty
// ones, pixels off by more than 32/255, jaggies on both axes. The model is the float32 twin of the package kernel
// (test/_glslEmu.mjs) on every fragment of every CPatch cover triangle, the patches OVER-composited per shape.
//
// MEASURED against Loop-Blinn, the PICTURE only (filled shapes neither engine
// declined), 512 px unless named; AA error per edge pixel in 255ths, then pixels off by more than 32/255:
//
//                   Loop-Blinn        CPatch           CPatch + companion
//   illustration A  5.97  3348        3.83  1560       3.30  1350     CPatch better
//   landscape       3.04   324        1.63   125       1.33    97     CPatch better
//   line art        0.52    19        0.33     0       0.33     0     CPatch better (lines only)
//   illustration B  1.96   376        2.08   306       1.58   195     companion better
//   tiger           5.18  2358        6.99  4473       4.99  3029     mixed
//   tiger @128      8.09   975       14.39  2083      10.67  1484     LB better
//   illustration C  0.97   107        2.47   295       1.82   210     LB better
//   cubic onion     0.93   368        2.43   667       2.06   559     LB better
//   cubic star      2.73   369       16.14  2858      14.55  2559     LB better (6x)
//   TrueType text   2.91   494        6.62  1159       5.20   832     LB better
//   TrueType @128   14.76  583       17.41   596      15.92   560     tie
//   text12          4.99  1674        8.56  2965       6.86  2139     LB better
//   landscape B     4.17   888       11.43  3517       7.56  2357     LB better, and CPatch paints 103 px solid OUTSIDE
//   toothpaste1     0.44    80        0.99   113       0.96   111     LB better
//   prim_sheet      (CPatch declines 402 of 412 shapes)
//
// Landscape B's spill is shape 155 (91 px) and 70 (12 px): three small contours nested in a large one of the opposite
// orientation, nonzero, so they are holes (winding 0) -- which CPatch fills. A plain square with two reversed inner
// contours is filled correctly, so it is this nesting, not the rule.
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const [OUT, FILE] = argv.filter((a) => !a.startsWith('--'));
if (!OUT || !FILE) {
  console.error('usage: _cpatchEngineAudit.mjs OUT.json FILE.svg [--companion]');
  process.exit(2);
}
if (argv.includes('--companion')) {
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__CP_COMP_ON = 1;
}
const CANVAS = +(process.env.CANVAS || 512),
  SLICES = +(process.env.SLICES || 64),
  PAD = +(process.env.PAD || 2);
console.warn = () => {};
const { default: importSvg } = await import(path.join(ROOT, 'src/svg/importer.js'));
const CB = await import(path.join(ROOT, 'src/renderer/cpatchBuild.js'));
const { rowSpans } = await import(path.join(ROOT, 'src/renderer/cpatchConvert.js'));
const { segPt } = await import(path.join(ROOT, 'src/geom/cpatchImplicit.js'));
const { curveRangeToContours } = await import(path.join(ROOT, 'src/geom/lbContour.js'));
const { LB_STRIDE } = await import(path.join(ROOT, 'src/renderer/cpatchPack.js'));
const E = await import(path.join(ROOT, 'test/_glslEmu.mjs'));
const svg = readFileSync(path.resolve(FILE), 'utf8');

// ---- the reference side: _lbRaster's shapesOf / viewOf and _lbAaRef's exactCov, restated --------------------------------
const ref = await importSvg(svg);
const meta = ref.metaFloats || new Float32Array(ref.meta, 32); // the meta buffer carries a 32-byte header
const st = ref.metaFloatsPerShape | 0;
const cfRef = new Float32Array(ref.curves);
const shapes = [];
for (let s = 0; s < ref.numShapes; s++) {
  const r = ref.curveRangesByShape && ref.curveRangesByShape[s];
  if (!r || r.end <= r.begin) continue;
  let cs = null;
  try {
    cs = curveRangeToContours(cfRef, r.begin, r.end);
  } catch {
    cs = null;
  }
  if (!cs || !cs.length) continue;
  shapes.push({
    s,
    contours: cs,
    evenOdd: meta[s * st + 13] > 0.5,
    noFill: !(meta[s * st + 7] > 0),
  });
}
const g = ref.globalBBox;
const ext = Math.max(g[2], g[3]),
  basePx = ext / CANVAS;
const view = {
  basePx,
  ox: g[0] + g[2] / 2 - (CANVAS / 2) * basePx,
  oy: g[1] + g[3] / 2 - (CANVAS / 2) * basePx,
};
const emX = (i) => view.ox + (i + 0.5) * basePx,
  emY = (j) => view.oy + (j + 0.5) * basePx;
/// An open subpath is filled as if closed; rowSpans over the raw segments would find no interior.
const closed = (contours) => {
  const o = [];
  for (const q of contours) {
    if (!q.length) continue;
    for (const sg of q) o.push(sg);
    const a = segPt(q[0], 0),
      b = segPt(q[q.length - 1], 1);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9)
      o.push({
        t: 'line',
        P: [
          [b[0], b[1]],
          [a[0], a[1]],
        ],
      });
  }
  return o;
};
function exactCov(curves, i, j, evenOdd, rowCache) {
  let a = 0;
  const x0 = view.ox + i * basePx,
    x1 = x0 + basePx,
    y0 = view.oy + j * basePx;
  for (let s = 0; s < SLICES; s++) {
    let sp = rowCache.get(s);
    if (!sp) {
      sp = rowSpans(curves, y0 + (basePx * (s + 0.5)) / SLICES, evenOdd);
      rowCache.set(s, sp);
    }
    for (const q of sp) {
      const lo = Math.max(q[0], x0),
        hi = Math.min(q[1], x1);
      if (hi > lo) a += hi - lo;
    }
  }
  return a / (basePx * SLICES);
}
function featureWidthPx(curves, i, j, evenOdd) {
  const sp = rowSpans(curves, emY(j), evenOdd);
  if (!sp.length) return Infinity;
  const cx = emX(i);
  let best = Infinity,
    bestD = Infinity;
  for (const q of sp) {
    const w = (q[1] - q[0]) / basePx,
      d = cx < q[0] ? q[0] - cx : cx > q[1] ? cx - q[1] : 0;
    if (d < bestD - 1e-12 || (Math.abs(d - bestD) <= 1e-12 && w < best)) {
      bestD = d;
      best = w;
    }
  }
  return best;
}

// ---- the model side: the CPatch bundle of the same file -----------------------------------------------------------------
const b = CB.headlessCPatchBundle(await importSvg(svg));
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
CB.buildCPatchBundle(gl, b, { pool: false });
const A = b.curveRangesByShape,
  R = ref.curveRangesByShape;
if (A.length !== R.length || A.some((r, k) => r.end - r.begin !== R[k].end - R[k].begin))
  throw new Error('the two bundles order shapes differently');
const emu = E.buildGlslEmu(ROOT, { cpatch: true });
const S = LB_STRIDE,
  T32 = 32 / 255,
  FINE = [1, 2, 4, Infinity],
  rows = [];
for (const sh of shapes) {
  const m = (b._lbMeshes || [])[sh.s];
  if (!m || !m.cpatch) {
    rows.push({ file: FILE, shape: sh.s, declined: true, noFill: sh.noFill });
    continue;
  }
  const qs = [],
    pix = [];
  for (let tri = 0; (tri + 1) * 3 * S <= m.verts.length; tri++) {
    const vs = [0, 1, 2].map((k) => m.verts.subarray((tri * 3 + k) * S, (tri * 3 + k + 1) * S));
    const q = vs.map((v) => [
      v[0] + v[17] + v[2] * 1.5 * basePx,
      v[1] + v[18] + v[3] * 1.5 * basePx,
    ]); // the vertex stage's dilation
    let area =
      (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
    if (!(Math.abs(area) > 0)) continue;
    const o = area > 0 ? [0, 1, 2] : [0, 2, 1],
      Q = o.map((k) => q[k]),
      Wv = o.map((k) => vs[k]);
    area = Math.abs(area);
    const edge = (a, c, p) => (c[0] - a[0]) * (p[1] - a[1]) - (c[1] - a[1]) * (p[0] - a[0]);
    const inE = (w, a, c) =>
      w > 0 || (w === 0 && (c[1] - a[1] < 0 || (c[1] === a[1] && c[0] > a[0]))); // top-left rule
    const xs = Q.map((p) => p[0]),
      ys = Q.map((p) => p[1]);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - view.ox) / basePx - 0.5)),
      i1 = Math.min(CANVAS - 1, Math.ceil((Math.max(...xs) - view.ox) / basePx));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - view.oy) / basePx - 0.5)),
      j1 = Math.min(CANVAS - 1, Math.ceil((Math.max(...ys) - view.oy) / basePx));
    const f = Wv[2];
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const p = [emX(i), emY(j)];
        const w0 = edge(Q[1], Q[2], p),
          w1 = edge(Q[2], Q[0], p),
          w2 = edge(Q[0], Q[1], p);
        if (!(inE(w0, Q[1], Q[2]) && inE(w1, Q[2], Q[0]) && inE(w2, Q[0], Q[1]))) continue;
        const tc = [2, 3, 4].map((c) => (w0 * Wv[0][c] + w1 * Wv[1][c] + w2 * Wv[2][c]) / area);
        qs.push({
          k: E.K_CPATCH_COV,
          GD: [f[7], f[8], f[9], f[10]],
          bb: [f[11], f[12], f[13], f[14]],
          c: [p[0] - f[17], p[1] - f[18]],
          ePx: [f[19], f[20]],
          ex: [tc[0], tc[1], tc[2], f[15], f[16], basePx],
        });
        pix.push(j * CANVAS + i);
      }
  }
  const cov = qs.length ? emu.run(new Float32Array(4), gl.plane, qs) : [];
  const acc = new Map();
  for (let k = 0; k < pix.length; k++)
    acc.set(pix[k], 1 - (1 - (acc.get(pix[k]) ?? 0)) * (1 - Math.max(0, Math.min(1, cov[k]))));
  // _lbAaAudit's scoring window: the shape's control box plus PAD; anything painted beyond it is stray
  const cv = CB.contoursToConverter(sh.contours, null);
  if (!cv) continue;
  const curves = closed(cv);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const sg of curves)
    for (const p of sg.P) {
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
  const i0 = Math.max(0, Math.floor((x0 - view.ox) / basePx) - PAD),
    i1 = Math.min(CANVAS - 1, Math.ceil((x1 - view.ox) / basePx) + PAD);
  const j0 = Math.max(0, Math.floor((y0 - view.oy) / basePx) - PAD),
    j1 = Math.min(CANVAS - 1, Math.ceil((y1 - view.oy) / basePx) + PAD);
  if (i1 < i0 || j1 < j0) continue;
  let outside = 0;
  for (const [px, v] of acc) {
    const i = px % CANVAS,
      j = (px - i) / CANVAS;
    if (i < i0 || i > i1 || j < j0 || j > j1) outside += v;
  }
  const W = i1 - i0 + 1,
    sgn = new Float64Array(W * (j1 - j0 + 1));
  let err = outside,
    aaErr = 0,
    aaN = 0,
    miss = 0,
    missN = 0,
    stray = outside,
    strayN = 0,
    off32 = 0,
    over32 = 0,
    lostIn = 0;
  const fineErr = [0, 0, 0, 0],
    fineN = [0, 0, 0, 0];
  const rowCache = new Map();
  let ri = 0;
  for (let j = j0; j <= j1; j++) {
    rowCache.clear();
    const cRow = rowSpans(curves, emY(j), sh.evenOdd);
    for (let i = i0; i <= i1; i++, ri++) {
      const ex = exactCov(curves, i, j, sh.evenOdd, rowCache),
        mo = acc.get(j * CANVAS + i) ?? 0,
        d = mo - ex;
      sgn[ri] = d;
      if (Math.abs(d) > T32) {
        off32++;
        if (d > 0) over32++;
        else if (cRow.some((q) => emX(i) >= q[0] && emX(i) < q[1])) lostIn++;
      }
      if (ex > 1e-6 && ex < 1 - 1e-6) {
        aaN++;
        aaErr += Math.abs(d);
        const w = featureWidthPx(curves, i, j, sh.evenOdd);
        let k = 0;
        while (k < 3 && w > FINE[k]) k++;
        fineErr[k] += Math.abs(d);
        fineN[k]++;
      } else if (ex >= 1 - 1e-6) {
        if (mo < 1) {
          miss += 1 - mo;
          if (1 - mo > 0.5) missN++;
        }
      } else if (mo > 0) {
        stray += mo;
        if (mo > 0.5) strayN++;
      }
      err += Math.abs(d);
    }
  }
  let jaggy = 0;
  const at = (i, j) => sgn[(j - j0) * W + (i - i0)];
  for (let j = j0 + 1; j < j1; j++)
    for (let i = i0 + 1; i < i1; i++) {
      const c = at(i, j);
      const hx =
        (c - at(i - 1, j) > 0.25 && c - at(i + 1, j) > 0.25) ||
        (at(i - 1, j) - c > 0.25 && at(i + 1, j) - c > 0.25);
      const hy =
        (c - at(i, j - 1) > 0.25 && c - at(i, j + 1) > 0.25) ||
        (at(i, j - 1) - c > 0.25 && at(i, j + 1) - c > 0.25);
      if (hx || hy) jaggy++;
    }
  rows.push({
    file: FILE,
    shape: sh.s,
    noFill: sh.noFill,
    err,
    aaErr,
    aaN,
    miss,
    missN,
    stray,
    strayN,
    off32,
    over32,
    lostIn,
    jaggy,
    fineErr,
    fineN,
    frags: qs.length,
  });
}
writeFileSync(OUT, JSON.stringify({ canvas: CANVAS, slices: SLICES, rows }));
const pic = rows.filter((r) => !r.declined && !r.noFill),
  sum = (k) => pic.reduce((s, r) => s + r[k], 0);
console.log(
  `${path.basename(FILE)}: ${rows.length} shapes, ${rows.filter((r) => r.declined).length} declined; PICTURE ${pic.length} filled shapes: ` +
    `AA ${sum('aaErr').toFixed(2)} px^2 over ${sum('aaN')} edge px (${((255 * sum('aaErr')) / Math.max(1, sum('aaN'))).toFixed(3)}/255), ` +
    `miss ${sum('miss').toFixed(2)} over ${sum('missN')} px, stray ${sum('stray').toFixed(2)} over ${sum('strayN')} px, ` +
    `off>32/255 ${sum('off32')} (over ${sum('over32')}), lost inside ${sum('lostIn')}, jaggy ${sum('jaggy')}`,
);
