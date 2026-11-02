// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbEmuPaint — probes/_zzEnginePaint.mjs's Loop-Blinn arm on the CPU: the whole-LB-pipeline emulator's frame
// (test/_lbPipeEmu.mjs: the generated vertex and fragment texts, a top-left rasterizer, fine 2x2-quad derivatives)
// composited premultiplied OVER in draw order, against the same exact reference _zzEnginePaint builds (each shape's exact
// row spans, Gauss-Legendre in y, composited in document order), with the same metrics: WRONG SOLID (an interior
// pixel -- the reference agrees with all 8 neighbours -- off by more than 24/255), AA > 0.3 / > 0.5 on edge pixels.
//
// So a GPU wrong-solid pixel can be taken apart without a GPU: every fragment that landed on it is listed with its
// triangle, shape, LB kind and alpha. Strokes are stripped as the GPU probe strips them, and the import keeps the
// viewBox (preserveViewport), so pixel (x, y) here is the GPU probe's pixel (x, N-1-y) -- this probe prints TOP-DOWN rows,
// _zzEnginePaint's component list BOTTOM-UP ones.
//
//   node probes/lbAccuracy/_lbEmuPaint.mjs            SVG=<path> N=1024 [WIN=x0,y0,x1,y1] [AT=x,y;x,y] [FRAG=..] [VERT=..]
//                                                     [TIE=bottomright] (the other raster tie convention, see _lbPipeEmu)
//                                                     [SNAP=256] (vertices snapped to a 1/SNAP subpixel grid, as a GPU does)
//   WIN: a top-down pixel window (inclusive), the raster's scissor; only shapes whose bbox reaches it are drawn -- a
//   window is cheap, a whole 1024 px tiger is a heavy job (minutes). AT: pixels to explain fragment by fragment.
//   SHAPES=<i,j,..>: draw only these rows. OFF=<n>: list every pixel off by more than n/255 (_offPixels' measure).
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../../src/svg/importer.js';
import { curveRangeToContours } from '../../src/geom/lbContour.js';
import { contoursToConverter } from '../../src/renderer/cpatchBuild.js';
import { rowSpans, rowCross } from '../../src/renderer/cpatchConvert.js';
import { parseMetaBin } from '../../src/core/metaBin.js';
import { lbScene, renderScene } from '../../test/_lbPipeScene.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const N = +(process.env.N || 1024);
const SVGP = process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg';
const SVG_RAW = readFileSync(path.isAbsolute(SVGP) ? SVGP : path.join(ROOT, SVGP), 'utf8');
// The GPU probe's fill-only rewrite, verbatim.
const SVG = SVG_RAW.replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '')
  .replace(/(^|[;{\s"'])stroke\s*:\s*[^;}"']+/g, '$1stroke:none');
const SOLID_BAD = +(process.env.SOLID_BAD || 24);
const WIN = process.env.WIN ? process.env.WIN.split(',').map(Number) : [0, 0, N - 1, N - 1];
const AT = process.env.AT ? process.env.AT.split(';').map((p) => p.split(',').map(Number)) : [];
const ONLY = process.env.SHAPES ? new Set(process.env.SHAPES.split(',').map(Number)) : null;
const VT = readFileSync(
  process.env.VERT || path.join(ROOT, 'src/shaders/generated/mantle.vert.glsl'),
  'utf8',
);
const FT = readFileSync(
  process.env.FRAG || path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'),
  'utf8',
);
console.warn = () => {};

// ---- the reference (as _zzEnginePaint) ----
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const MF = meta.metaFloats,
  ST = meta.floatsPerShape | 0;
const bb = meta.globalBBox;
const _sAR = bb[2] / bb[3];
const arX = _sAR > 1 ? 1 : _sAR,
  arY = _sAR > 1 ? 1 / _sAR : 1;
const emX = (i) => bb[0] + ((((2 * (i + 0.5)) / N - 1) / arX + 1) / 2) * bb[2];
const emY = (r) => bb[1] + ((1 - (1 - (2 * (r + 0.5)) / N) / arY) / 2) * bb[3]; // r top-down
const SCX = bb[2] / (arX * N),
  SCY = bb[3] / (arY * N),
  SC = Math.max(SCX, SCY);
const GL5 = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891],
];
const shapes = [];
for (let s = 0; s < meta.numShapes; s++) {
  const o = s * ST,
    r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(MF[o + 7] > 0)) {
    shapes.push(null);
    continue;
  }
  let cs = null;
  try {
    cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  } catch {
    cs = null;
  }
  if (!cs || !cs.length) {
    shapes.push(null);
    continue;
  }
  const all = [];
  for (const c of cs) for (const sg of c) all.push(sg);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const sg of all)
    for (const P of sg.P) {
      if (P[0] < x0) x0 = P[0];
      if (P[0] > x1) x1 = P[0];
      if (P[1] < y0) y0 = P[1];
      if (P[1] > y1) y1 = P[1];
    }
  shapes.push({
    i: s,
    segs: all,
    rgb: [MF[o + 4] * 255, MF[o + 5] * 255, MF[o + 6] * 255],
    a: MF[o + 7],
    evenOdd: MF[o + 13] > 0.5,
    bb: [x0, y0, x1, y1],
  });
}
const spansOf = (sh, y) => {
  if (!sh.evenOdd) return rowSpans(sh.segs, y) || [];
  const xs = [];
  for (const sg of sh.segs) rowCross(sg, y, (x) => xs.push(x));
  xs.sort((p, q) => p - q);
  const out = [];
  for (let k = 0; k + 1 < xs.length; k += 2)
    if (xs[k + 1] - xs[k] > 1e-9) out.push([xs[k], xs[k + 1]]);
  return out;
};
/// One shape's exact box coverage of pixel (i, r), as the reference integrates it.
const covAt = (sh, r, i) => {
  const cx = emX(i),
    cy = emY(r);
  let t = 0;
  for (const [q, w] of GL5) {
    const y = cy + 0.5 * SCY * q;
    let c2 = 0;
    for (const sp of spansOf(sh, y))
      c2 += Math.max(0, Math.min(cx + SCX / 2, sp[1]) - Math.max(cx - SCX / 2, sp[0]));
    t += (w * 0.5 * c2) / SCX;
  }
  return Math.min(1, Math.max(0, t));
};
// The window grown by one pixel (the flat test reads the neighbours) and by 3 px for the shapes that may paint in it.
const [wx0, wy0, wx1, wy1] = [
  Math.max(0, WIN[0] - 1),
  Math.max(0, WIN[1] - 1),
  Math.min(N - 1, WIN[2] + 1),
  Math.min(N - 1, WIN[3] + 1),
];
const emWin = [emX(wx0 - 3), emY(wy0 - 3), emX(wx1 + 3), emY(wy1 + 3)];
const reaches = (sh) =>
  sh &&
  sh.bb[0] <= Math.max(emWin[0], emWin[2]) &&
  sh.bb[2] >= Math.min(emWin[0], emWin[2]) &&
  sh.bb[1] <= Math.max(emWin[1], emWin[3]) &&
  sh.bb[3] >= Math.min(emWin[1], emWin[3]);
const drawn = new Set(
  shapes.filter((sh) => reaches(sh) && (!ONLY || ONLY.has(sh.i))).map((sh) => sh.i),
);
const W = wx1 - wx0 + 1,
  H = wy1 - wy0 + 1;
const ref = new Float64Array(W * H * 3),
  owner = new Int16Array(W * H).fill(-1);
for (let r = wy0; r <= wy1; r++) {
  const cy = emY(r);
  for (let i = wx0; i <= wx1; i++) {
    const cx = emX(i);
    let pr = 0,
      pg = 0,
      pb = 0,
      pa = 0;
    for (const sh of shapes) {
      if (!sh || !drawn.has(sh.i)) continue;
      if (cx < sh.bb[0] - SC || cx > sh.bb[2] + SC || cy < sh.bb[1] - SC || cy > sh.bb[3] + SC)
        continue;
      let t = 0;
      for (const [q, w] of GL5) {
        const y = cy + 0.5 * SCY * q;
        let c2 = 0;
        for (const sp of spansOf(sh, y))
          c2 += Math.max(0, Math.min(cx + SCX / 2, sp[1]) - Math.max(cx - SCX / 2, sp[0]));
        t += (w * 0.5 * c2) / SCX;
      }
      const a = Math.min(1, Math.max(0, t)) * sh.a;
      if (a <= 0) continue;
      pr = sh.rgb[0] * a + pr * (1 - a);
      pg = sh.rgb[1] * a + pg * (1 - a);
      pb = sh.rgb[2] * a + pb * (1 - a);
      pa = a + pa * (1 - a);
      if (a > 0.5) owner[(r - wy0) * W + (i - wx0)] = sh.i;
    }
    const k = ((r - wy0) * W + (i - wx0)) * 3;
    ref[k] = Math.round(pr + (1 - pa) * 255);
    ref[k + 1] = Math.round(pg + (1 - pa) * 255);
    ref[k + 2] = Math.round(pb + (1 - pa) * 255);
  }
}

// ---- the emulated frame ----
const t0 = Date.now();
const sc = await lbScene(SVG, {
  N,
  importOpts: { preserveViewport: true },
  rows: (s) => (drawn.has(s) ? undefined : 'skip'),
});
const rs = renderScene(sc, VT, FT, [], {
  scissor: [wx0, wy0, wx1, wy1],
  tie: process.env.TIE || undefined,
  snap: +(process.env.SNAP || 0),
});
const ko = rs.vert.outOff[rs.vert.io.outs.findIndex((o) => o.name === 'vKind')];
const kindOf = (t) => Math.floor(rs.vOut[(t * 3 + 2) * rs.vert.outN + ko] + 1e-4);
const recs = rs.recs,
  nRec = recs.length / 9;
const px = new Float64Array(W * H * 4); // premultiplied, 0..1, over transparent
const at = new Map(AT.map(([x, y]) => [y * N + x, []]));
for (let q = 0; q < nRec; q++) {
  const i = recs[q * 9 + 1] | 0,
    r = recs[q * 9 + 2] | 0;
  if (i < wx0 || i > wx1 || r < wy0 || r > wy1) continue;
  const disc = recs[q * 9 + 7] === 1,
    t = recs[q * 9] | 0;
  const e = sc.entries[sc.entryOfTri[t]];
  const list = at.get(r * N + i);
  if (list)
    list.push({
      tri: t,
      local: e ? t - e.vStart / 3 : -1,
      shape: e ? e.shapeIdx : -1,
      kind: kindOf(t),
      a: +recs[q * 9 + 6].toFixed(4),
      disc,
      flags: recs[q * 9 + 8],
    });
  if (disc) continue;
  const k = ((r - wy0) * W + (i - wx0)) * 4,
    a = recs[q * 9 + 6];
  for (let c = 0; c < 3; c++) px[k + c] = recs[q * 9 + 3 + c] + px[k + c] * (1 - a);
  px[k + 3] = a + px[k + 3] * (1 - a);
}
const got = (k) => [0, 1, 2].map((c) => Math.round(255 * (px[k * 4 + c] + (1 - px[k * 4 + 3]))));

// ---- the metrics, over the window proper ----
let bad = 0,
  aa30 = 0,
  aa50 = 0,
  nFlat = 0,
  nEdge = 0;
const badList = [],
  offList = [];
const OFF = process.env.OFF ? +process.env.OFF : 0;
for (let r = WIN[1]; r <= WIN[3]; r++)
  for (let i = WIN[0]; i <= WIN[2]; i++) {
    const kk = (r - wy0) * W + (i - wx0),
      k = kk * 3;
    let same = 1;
    for (let dj = -1; dj <= 1 && same; dj++)
      for (let di = -1; di <= 1; di++) {
        const rr = r + dj,
          ii = i + di;
        if (rr < 0 || rr >= N || ii < 0 || ii >= N) continue;
        const k2 = ((rr - wy0) * W + (ii - wx0)) * 3;
        if (
          Math.abs(ref[k] - ref[k2]) > 2 ||
          Math.abs(ref[k + 1] - ref[k2 + 1]) > 2 ||
          Math.abs(ref[k + 2] - ref[k2 + 2]) > 2
        ) {
          same = 0;
          break;
        }
      }
    const g = got(kk);
    const d = Math.max(
      Math.abs(g[0] - ref[k]),
      Math.abs(g[1] - ref[k + 1]),
      Math.abs(g[2] - ref[k + 2]),
    );
    if (OFF && d > OFF)
      offList.push({ x: i, y: r, d, own: owner[kk], g, ref: [ref[k], ref[k + 1], ref[k + 2]] });
    if (same) {
      nFlat++;
      if (d > SOLID_BAD) {
        bad++;
        badList.push({ x: i, y: r, d, own: owner[kk], g, ref: [ref[k], ref[k + 1], ref[k + 2]] });
      }
    } else {
      nEdge++;
      if (d > 0.3 * 255) {
        aa30++;
        if (d > 0.5 * 255) aa50++;
      }
    }
  }
console.log(
  `${path.basename(SVGP)} N=${N} window ${WIN.join(',')} (top-down): ${drawn.size} shapes drawn, ${nRec} fragments, ${((Date.now() - t0) / 1000).toFixed(1)} s`,
);
console.log(
  `  interior ${nFlat} px, edge ${nEdge} px   WRONG SOLID ${bad}   AA>0.3 ${aa30}  AA>0.5 ${aa50}`,
);
for (const b of badList.slice(0, 40))
  console.log(
    `  wrong @(${b.x},${b.y}) [bottom-up y ${N - 1 - b.y}] own s${b.own}  ref rgb(${b.ref.join(',')})  got rgb(${b.g.join(',')})  d ${b.d}`,
  );
if (OFF) {
  console.log(`  OFF by more than ${OFF}/255: ${offList.length} px`);
  for (const b of offList.slice(0, 60))
    console.log(`    @(${b.x},${b.y}) own s${b.own}  ref ${b.ref[0]}  got ${b.g[0]}  d ${b.d}`);
}
for (const [key, list] of at) {
  const x = key % N,
    y = (key / N) | 0,
    kk = (y - wy0) * W + (x - wx0);
  console.log(
    `  AT (${x},${y}) ref rgb(${[0, 1, 2].map((c) => ref[kk * 3 + c]).join(',')}) got rgb(${got(kk).join(',')}) own s${owner[kk]}`,
  );
  for (const f of list)
    console.log(
      `     tri ${f.tri} (s${f.shape} #${f.local}) kind ${f.kind} a ${f.a}${f.disc ? ' DISCARDED' : ''}${f.flags ? ' flags ' + f.flags : ''}` +
        `   (s${f.shape} exact ${shapes[f.shape] ? covAt(shapes[f.shape], y, x).toFixed(4) : '-'})`,
    );
}
