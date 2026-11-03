// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// streamDivergenceCost — what a FAST-BUILDER stream's mesh costs in pixels, what the static route
// costs, and what the CORRECT fast build costs, all scored against the shape's exact coverage.
//
// A fast-builder stream builds every moved shape with the fast earcut builder (buildLoopBlinnMesh with
// the crack-healing ramp, accepting a concave curve) on contours split by an absolute 1e-5, refreshing
// last frame's triangulation when it can. The lightweight stream uses buildLbShape, the static route,
// and asks it for `fastCorrect`, which puts the correct fast build (buildLoopBlinnMesh(..., correct =
// true), lbFastResolve.js) in front of the partition.
//
// Per shape-frame, every arm's mesh is drawn by the CPU Loop-Blinn draw model
// (probes/lbAccuracy/_lbStaticDrawEmu.mjs: every kind the builders pack, with the static composites)
// and scored against the exact coverage of the shape's own contours under its own fill rule. Arms:
//   fast-builder stream         the fast-builder stream, reproduced below
//   static route                buildLbShape
//   correct fast builder        buildLoopBlinnMesh(..., correct = true) for every shape, the static route
//                               where it declines (declines counted)
//   stream now (fastCorrect)    buildLbShape with `fastCorrect`: what the stream builds
// Reported per arm (see `score`): whole pixels wrong -- painted outside / ink lost inside, and those more
// than 1.5 px from any edge -- and edge pixels more than 32/255 off the exact area, with their mean error;
// plus the shapes where a mesh used a kernel feature the model does not model.
//
// Inputs:
//   fixtures   the frames of test/lbStreamStaticParitySmoke (road bands, CDT-class shapes), each
//              shape rendered over its own box at one pixel per unit (about 200 px across);
//   corpus     MantleSamples/Assets/Mantle + fixtures/svg (166 assets), every shape the
//              static build does NOT build with the fast builder (no `_topo`: the CDT/partition and
//              primitive class, 3,565 shapes), warped by a 0.1% COHERENT move of every control point
//              (`perturbContours`), rendered at the drawing's own scale (its globalBBox at
//              256 px) over the shape's own pixel box. ALL=1 takes the fast-built shapes too.
//
//   node probes/lbBuildPaths/streamDivergenceCost.mjs [corpus|fixtures|both]   LIMIT=n only=substr
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS = path.resolve(HERE, '../..');
const REPO = path.resolve(JS, '..');
const WHICH = process.argv[2] || 'both';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { default: importSvg } = await import(path.join(JS, 'src/svg/importer.js'));
const { parseMetaBin } = await import(path.join(JS, 'src/renderer/bundle.js'));
const { buildLbBundle, buildLbShape } = await import(path.join(JS, 'src/renderer/lbBuildCore.js'));
const { buildLoopBlinnMesh, refreshLoopBlinnMesh, packLoopBlinnMesh } = await import(
  path.join(JS, 'src/renderer/loopBlinn.js')
);
const { curveRangeToContours, contoursFromSegs, rayWinding } = await import(
  path.join(JS, 'src/geom/lbContour.js')
);
const { renderStatic } = await import(path.join(JS, 'probes/lbAccuracy/_lbStaticDrawEmu.mjs'));
const { mkLine, mkQuad, mkCubic, SEG_ARC, SEG_LINE, SEG_QUAD, SEG_CUBIC } = await import(
  path.join(JS, 'src/primitives/seg.js')
);
/// A point on a segment (line, quad, cubic, rational quad).
function segPt(sg, t) {
  const u = 1 - t,
    a = sg.p1;
  if (sg.type === SEG_LINE) return [a[0] + (sg.p2[0] - a[0]) * t, a[1] + (sg.p2[1] - a[1]) * t];
  if (sg.type === SEG_CUBIC) {
    const [b, c, d] = [sg.p2, sg.p3, sg.p4];
    const k0 = u * u * u,
      k1 = 3 * u * u * t,
      k2 = 3 * u * t * t,
      k3 = t * t * t;
    return [
      k0 * a[0] + k1 * b[0] + k2 * c[0] + k3 * d[0],
      k0 * a[1] + k1 * b[1] + k2 * c[1] + k3 * d[1],
    ];
  }
  const w = sg.type === SEG_QUAD ? 1 : sg.w || 1,
    b = sg.p2,
    c = sg.p3,
    k0 = u * u,
    k1 = 2 * u * t * w,
    k2 = t * t,
    den = k0 + k1 + k2;
  return [(k0 * a[0] + k1 * b[0] + k2 * c[0]) / den, (k0 * a[1] + k1 * b[1] + k2 * c[1]) / den];
}

// ---- the fast-builder stream's builder, an earlier streamGeometry.js reproduced verbatim -------
const _segEndPt = (s) => s.p4 || s.p3 || s.p2;
function oldSegsToContours(segs) {
  const contours = [];
  let cur = null;
  let px = NaN,
    py = NaN;
  for (const s of segs) {
    if (s.type === SEG_ARC) return null;
    const a = s.p1;
    if (cur === null || Math.abs(a[0] - px) > 1e-5 || Math.abs(a[1] - py) > 1e-5) {
      cur = [];
      contours.push(cur);
    }
    cur.push(s);
    const e = _segEndPt(s);
    px = e[0];
    py = e[1];
  }
  return contours.length ? contours : null;
}
function oldBuild(segs, evenodd, prev) {
  const contours = oldSegsToContours(segs);
  if (!contours) return null;
  let mesh = null;
  try {
    const fr = evenodd ? 'evenodd' : 'nonzero';
    mesh =
      prev && !prev.slug
        ? refreshLoopBlinnMesh(prev, contours, fr)
        : buildLoopBlinnMesh(contours, true, fr);
  } catch {
    mesh = null;
  }
  if (mesh && mesh.fallback.length) mesh = null;
  return mesh;
}
/// The CORRECT fast builder, as the stream is to use it: buildLoopBlinnMesh with `correct`, and the
/// static route for a shape it declines. Counts its declines.
const fastDeclines = {};
function fastcBuild(segs, transSolid, evenodd, prev) {
  const contours = contoursFromSegs(segs);
  if (!contours) return null;
  let m = null;
  try {
    m = buildLoopBlinnMesh(contours, true, evenodd ? 'evenodd' : 'nonzero', false, true);
  } catch {
    m = null;
  }
  if (m && !m.fallback.length) return m;
  const why = m ? m.declined || 'fallback' : 'null';
  fastDeclines[why] = (fastDeclines[why] | 0) + 1;
  let b = null;
  try {
    b = buildLbShape(contours, transSolid, evenodd, { prev });
  } catch {
    b = null;
  }
  return b ? b.raw : null;
}
function newBuild(segs, transSolid, evenodd, prev) {
  const contours = contoursFromSegs(segs);
  if (!contours) return null;
  let b = null;
  try {
    b = buildLbShape(contours, transSolid, evenodd, { prev });
  } catch {
    b = null;
  }
  return b ? b.raw : null;
}
/// What the stream builds now: the static route with its correct fast build in front (`fastCorrect`).
function streamBuild(segs, transSolid, evenodd, prev) {
  const contours = contoursFromSegs(segs);
  if (!contours) return null;
  let b = null;
  try {
    b = buildLbShape(contours, transSolid, evenodd, { prev, fastCorrect: true });
  } catch {
    b = null;
  }
  return b ? b.raw : null;
}

// ---- scoring --------------------------------------------------------------------------------------
// The model (_lbStaticDrawEmu) draws every kind the meshes pack, so both kinds of pixel are scored:
//   whole pixels -- no ink in the exact coverage (all 4 corners and, when disputed, all 12x12 samples outside)
//   or all ink:
//     paintOut  a no-ink pixel the mesh paints more than 32/255     (ink in the wrong place)
//     lostIn    an all-ink pixel the mesh paints less than 1 - 32/255 (a hole in the fill)
//     farOut / farIn  of those, the ones more than 1.5 px from any edge: not an antialiasing question
//   EDGE pixels -- the corners disagree -- against the exact area (8x8 samples):
//     aaBad     more than 32/255 off the exact area
//     aaErr     the summed absolute error (mean = aaErr / partial)
/// The exact reference for one shape: per pixel, 1 all-ink / 0 no-ink / -1 edge by its corners, the area of an
/// edge pixel, and the winding test and outline distance the scorer needs for disputed pixels.
function reference(segsFlat, bb, N, evenOdd) {
  const inside = (x, y) => {
    const w = rayWinding(segsFlat, bb[0] + (x / N) * bb[2], bb[1] + (y / N) * bb[3]);
    return evenOdd ? (w & 1) !== 0 : w !== 0;
  };
  const corner = new Uint8Array((N + 1) * (N + 1));
  for (let y = 0; y <= N; y++)
    for (let x = 0; x <= N; x++) corner[y * (N + 1) + x] = inside(x, y) ? 1 : 0;
  const cls = new Int8Array(N * N),
    area = new Float32Array(N * N),
    SA = 8;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const k = y * (N + 1) + x,
        s4 = corner[k] + corner[k + 1] + corner[k + N + 1] + corner[k + N + 2];
      if (s4 === 0 || s4 === 4) {
        cls[y * N + x] = s4 ? 1 : 0;
        continue;
      }
      cls[y * N + x] = -1;
      let n = 0;
      for (let a = 0; a < SA; a++)
        for (let b = 0; b < SA; b++) if (inside(x + (a + 0.5) / SA, y + (b + 0.5) / SA)) n++;
      area[y * N + x] = n / (SA * SA);
    }
  // Distance, in pixels, from a pixel center to the outline (sampled at 64 points a segment).
  const outline = [];
  for (const sg of segsFlat) for (let i = 0; i <= 64; i++) outline.push(segPt(sg, i / 64));
  const distPx = (x, y) => {
    const ex = bb[0] + (x / N) * bb[2],
      ey = bb[1] + (y / N) * bb[3];
    let d = Infinity;
    for (const q of outline) {
      const dd = Math.hypot(q[0] - ex, q[1] - ey);
      if (dd < d) d = dd;
    }
    return d / (bb[2] / N);
  };
  return { cls, area, inside, distPx, bb, N };
}
function score(mesh, ref, claim) {
  const { cls, area, inside, distPx, bb, N } = ref;
  let cov = null,
    unmodelled = [];
  if (mesh) {
    const pk = packLoopBlinnMesh(mesh);
    if (pk && pk.vertexCount > 0) {
      const r = renderStatic({ S: pk.verts, D: pk.verts, n: pk.vertexCount, lt: 0 }, bb, N, claim);
      cov = r.cov;
      unmodelled = r.unmodelled;
    }
  }
  const out = {
    off: 0,
    paintOut: 0,
    lostIn: 0,
    farOut: 0,
    farIn: 0,
    partial: 0,
    aaBad: 0,
    aaErr: 0,
    unmodelled,
    drawn: !!cov,
  };
  const SS = 12,
    TOL = 32 / 255;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x,
        got = cov ? Math.max(0, cov[i]) : 0,
        c = cls[i];
      if (c < 0) {
        out.partial++;
        const e = Math.abs(got - area[i]);
        out.aaErr += e;
        if (e > TOL) out.aaBad++;
        continue;
      }
      if (c ? got >= 1 - TOL : got <= TOL) continue; // agrees with the pixel's class at a glance
      let n = 0;
      for (let a = 0; a < SS; a++)
        for (let b = 0; b < SS; b++) if (inside(x + (a + 0.5) / SS, y + (b + 0.5) / SS)) n++;
      if (n === 0 && got > TOL) {
        out.paintOut++;
        out.off++;
        if (distPx(x + 0.5, y + 0.5) > 1.5) out.farOut++;
      } else if (n === SS * SS && got < 1 - TOL) {
        out.lostIn++;
        out.off++;
        if (distPx(x + 0.5, y + 0.5) > 1.5) out.farIn++;
      } else {
        out.partial++;
        const e = Math.abs(got - n / (SS * SS));
        out.aaErr += e;
        if (e > TOL) out.aaBad++;
      }
    }
  return out;
}
/// A square em box over `segs` at the given em-per-pixel, with a 2 px margin, and its pixel size.
function boxOf(segs, emPerPx) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of segs)
    for (const P of [s.p1, s.p2, s.p3, s.p4])
      if (P) {
        if (P[0] < x0) x0 = P[0];
        if (P[0] > x1) x1 = P[0];
        if (P[1] < y0) y0 = P[1];
        if (P[1] > y1) y1 = P[1];
      }
  const N = Math.max(4, Math.min(512, Math.ceil(Math.max(x1 - x0, y1 - y0) / emPerPx) + 4));
  return { bb: [x0 - 2 * emPerPx, y0 - 2 * emPerPx, N * emPerPx, N * emPerPx], N };
}

const tot = () => ({
  n: 0,
  off: 0,
  paintOut: 0,
  lostIn: 0,
  farOut: 0,
  farIn: 0,
  partial: 0,
  aaBad: 0,
  aaErr: 0,
  shapesOff: 0,
  shapesPaintOut: 0,
  shapesLostIn: 0,
  slug: 0,
  unmodelled: 0,
});
/// A shape with NO mesh still counts: a lightweight stream has no cover quads, so a sentinel section is
/// not drawn at all and its whole fill is ink lost.
const add = (T, s) => {
  T.n++;
  if (!s.drawn) T.slug++;
  if (s.unmodelled.length) T.unmodelled++;
  for (const k of ['off', 'paintOut', 'lostIn', 'farOut', 'farIn', 'partial', 'aaBad', 'aaErr'])
    T[k] += s[k];
  if (s.off) T.shapesOff++;
  if (s.paintOut) T.shapesPaintOut++;
  if (s.lostIn) T.shapesLostIn++;
};
const line = (name, T) =>
  `  ${name.padEnd(28)} ${String(T.n).padStart(6)} shape-frames  wrong whole px ${String(T.off).padStart(6)} (${T.shapesOff} shapes)` +
  `  paintedOutside ${String(T.paintOut).padStart(6)} px (${T.shapesPaintOut})  inkLostInside ${String(T.lostIn).padStart(6)} px (${T.shapesLostIn})` +
  `  | of those >1.5 px from any edge: outside ${T.farOut}, inside ${T.farIn}` +
  `  | edge px ${T.partial}: >32/255 off ${T.aaBad}, mean err ${(T.aaErr / Math.max(1, T.partial)).toFixed(4)}` +
  `  [no mesh ${T.slug}, unmodelled-kind shapes ${T.unmodelled}]`;

// ---- fixtures ------------------------------------------------------------------------------------
if (WHICH === 'fixtures' || WHICH === 'both') {
  const f32 = (p) => [Math.fround(p[0]), Math.fround(p[1])];
  const L = (a, b) => mkLine(f32(a), f32(b)),
    Q = (a, c, b) => mkQuad(f32(a), f32(c), f32(b)),
    C = (a, c1, c2, b) => mkCubic(f32(a), f32(c1), f32(c2), f32(b));
  const straightQ = (a, b) => Q(a, a, b);
  const quadEdge = (n, m, f) =>
    Q(n, [2 * m[0] - (n[0] + f[0]) / 2, 2 * m[1] - (n[1] + f[1]) / 2], f);
  const band = (nL, mL, fL, nR, mR, fR) => [
    quadEdge(nL, mL, fL),
    straightQ(fL, fR),
    quadEdge(fR, mR, nR),
    straightQ(nR, nL),
  ];
  const mk = (yN, yF, rwN, rwF, sway) => {
    const yM = (yN + yF) / 2,
      rwM = (rwN + rwF) / 2,
      cx = 100;
    return band(
      [cx - rwN, yN],
      [cx + sway - rwM, yM],
      [cx - rwF, yF],
      [cx + rwN, yN],
      [cx + sway + rwM, yM],
      [cx + rwF, yF],
    );
  };
  const blob = (cx, cy, r, k) => [
    Q([cx - r, cy], [cx - r, cy - r - k], [cx, cy - r]),
    Q([cx, cy - r], [cx + r + k, cy - r], [cx + r, cy]),
    Q([cx + r, cy], [cx + r, cy + r + k], [cx, cy + r]),
    Q([cx, cy + r], [cx - r - k, cy + r], [cx - r, cy]),
  ];
  const sq = (x, y, s) => [
    L([x, y], [x + s, y]),
    L([x + s, y], [x + s, y + s]),
    L([x + s, y + s], [x, y + s]),
    L([x, y + s], [x, y]),
  ];
  const seqs = [];
  seqs.push({
    name: 'teleporting road band',
    frames: [
      mk(180, 60, 70, 12, 40),
      mk(180, 60, 70, 12, -40),
      mk(120, 55, 30, 10, 45),
      mk(120, 55, 30, 10, -45),
      mk(190, 40, 80, 6, 55),
      mk(190, 40, 80, 6, -55),
      mk(175, 150, 64, 40, 30),
    ].map((s) => [{ segs: s, a: 1 }]),
  });
  {
    const fr = [];
    for (let t = 0; t < 6; t++) {
      const sh = [];
      for (let k = 0; k < 4; k++) {
        const yN = 190 - k * 35 - t * 3;
        sh.push({
          segs: mk(yN, yN - 30, 70 - k * 14, 62 - k * 14, 10 * Math.sin(0.7 * t + k)),
          a: 1,
        });
      }
      fr.push(sh);
    }
    seqs.push({ name: 'scrolling band set', frames: fr });
  }
  {
    const fr = [];
    for (let t = 0; t < 5; t++) {
      const w = 3 * Math.sin(t),
        v = 2 * Math.cos(1.3 * t);
      fr.push([
        {
          segs: [
            Q([20, 20 + v], [70 + w, 10], [120, 20]),
            L([120, 20], [120, 40]),
            Q([120, 40], [70 - w, 25 + v], [20, 40]),
            L([20, 40], [20, 20 + v]),
          ],
          a: 1,
        },
        { segs: [...blob(40 + w, 90, 15, 4), ...blob(95, 90 + v, 12, 3)], a: 1 },
        {
          segs: [
            C([150, 60], [150 + w, 20], [210, 20], [210, 60]),
            C([210, 60], [210, 110 + v], [150, 95], [150, 60]),
          ],
          a: 1,
        },
        { segs: blob(170 + v, 150, 20, 6 + w), a: 0.5 },
        { segs: [...sq(20 + w, 130, 60), ...sq(35, 145 + v, 30)], a: 1 },
      ]);
    }
    seqs.push({ name: 'CDT-class shapes', frames: fr });
  }
  const TO = tot(),
    TN = tot(),
    TF = tot(),
    TS = tot();
  for (const q of seqs) {
    const to = tot(),
      tn = tot(),
      tf = tot(),
      ts = tot();
    const prevO = [],
      prevN = [],
      prevF = [],
      prevS = [];
    for (const shapes of q.frames)
      shapes.forEach((sh, s) => {
        const mo = oldBuild(sh.segs, false, prevO[s]),
          mn = newBuild(sh.segs, sh.a < 0.996, false, prevN[s]);
        const mf = fastcBuild(sh.segs, sh.a < 0.996, false, prevF[s]),
          ms = streamBuild(sh.segs, sh.a < 0.996, false, prevS[s]);
        prevO[s] = mo;
        prevN[s] = mn;
        prevF[s] = mf;
        prevS[s] = ms;
        const { bb, N } = boxOf(sh.segs, 1); // the fixtures' own units are pixels
        const ref = reference(sh.segs, bb, N, false);
        add(to, score(mo, ref, sh.a < 0.996));
        add(tn, score(mn, ref, sh.a < 0.996));
        add(tf, score(mf, ref, sh.a < 0.996));
        add(ts, score(ms, ref, sh.a < 0.996));
      });
    console.log(`fixture: ${q.name}`);
    console.log(line('fast-builder stream      ', to));
    console.log(line('static route', tn));
    console.log(line('correct fast builder', tf));
    console.log(line('stream now (fastCorrect)', ts));
    for (const k of Object.keys(TO)) {
      TO[k] += to[k];
      TN[k] += tn[k];
      TF[k] += tf[k];
      TS[k] += ts[k];
    }
  }
  console.log('fixtures, all:');
  console.log(line('fast-builder stream      ', TO));
  console.log(line('static route', TN));
  console.log(line('correct fast builder', TF));
  console.log(line('stream now (fastCorrect)', TS));
  console.log(
    `  correct fast builder declined to the static route: ${JSON.stringify(fastDeclines)}`,
  );
}

// ---- corpus: the 0.1% coherent warp --------------------------------------------------------------
if (WHICH === 'corpus' || WHICH === 'both') {
  const files = [];
  for (const d of [
    path.join(REPO, 'MantleSamples/Assets/Mantle'),
    path.join(REPO, 'fixtures/svg'),
  ]) {
    try {
      for (const f of readdirSync(d)) if (f.endsWith('.svg')) files.push(path.join(d, f));
    } catch {
      /* */
    }
  }
  files.sort();
  const list = process.env.ONLY ? files.filter((f) => f.includes(process.env.ONLY)) : files;
  const LIMIT = +(process.env.LIMIT || 0);
  const TO = tot(),
    TN = tot(),
    TF = tot(),
    TS = tot();
  for (const k of Object.keys(fastDeclines)) delete fastDeclines[k];
  const worst = [];
  let assets = 0,
    shapes = 0,
    sameMesh = 0,
    oldFast = 0,
    prims = 0,
    noFill = 0;
  const t0 = Date.now();
  for (const f of list) {
    let sec, pm, a;
    try {
      sec = await importSvg(readFileSync(f, 'utf8'), { preserveViewport: true });
      pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
      a = buildLbBundle({
        curveFloats: new Float32Array(sec.curves),
        metaFloats: pm.metaFloats,
        metaFloatsPerShape: pm.floatsPerShape,
        ranges: sec.curveRangesByShape,
        numShapes: sec.numShapes,
      });
    } catch {
      continue;
    }
    const gbb = sec.globalBBox;
    if (!gbb || !(gbb[2] > 0)) continue;
    assets++;
    const ext = Math.max(gbb[2], gbb[3]),
      amount = 0.001 * ext,
      k = (2 * Math.PI) / ext,
      emPerPx = ext / 256;
    const curves = new Float32Array(sec.curves),
      st = pm.floatsPerShape | 0,
      M = pm.metaFloats;
    for (let s = 0; s < (sec.numShapes | 0); s++) {
      const ra = a.raw[s],
        pa = a.packed[s];
      if (!ra || ra.slug || !pa || pa.slug || !(pa.vertexCount | 0)) continue;
      if (ra._topo && !process.env.ALL) continue; // the CDT/partition/primitive class (ALL=1: every shape)
      if (pa.prim) {
        prims++;
        continue;
      } // a recognized primitive is one both builders make
      if (!(pm.metaFloats[s * (pm.floatsPerShape | 0) + 7] > 0.004)) {
        noFill++;
        continue;
      } // a fill nobody paints (a stroke-only row)
      if (LIMIT && shapes >= LIMIT) break;
      const r = sec.curveRangesByShape[s];
      let contours = null;
      try {
        contours = curveRangeToContours(curves, r.begin, r.end);
      } catch {
        contours = null;
      }
      if (!contours) continue;
      // The coherent warp, applied to the contours; a contour's first segment carries its subpath start.
      const moved = contours.map((c) =>
        c.map((sg, i) => {
          const o = { ...sg };
          for (const kk of ['p1', 'p2', 'p3', 'p4']) {
            const p = sg[kk];
            if (Array.isArray(p))
              o[kk] = [p[0] + amount * Math.sin(p[1] * k), p[1] + amount * Math.cos(p[0] * k)];
          }
          if (i === 0) o.subStart = true;
          delete o.circle; // a warped arc is no longer circular
          return o;
        }),
      );
      const segs = moved.flat();
      const b = s * st,
        evenodd = M[b + 13] > 0.5;
      const transSolid =
        M[b + 7] < 0.996 &&
        Math.floor(M[b + 28] + 0.5) === 0 &&
        (st < 36 || Math.floor(M[b + 35] + 0.5) === 0);
      shapes++;
      const mo = oldBuild(segs, evenodd, null),
        mn = newBuild(segs, transSolid, evenodd, null),
        mf = fastcBuild(segs, transSolid, evenodd, null);
      const ms = streamBuild(segs, transSolid, evenodd, null);
      if (mo && mo._topo) oldFast++;
      const { bb, N } = boxOf(segs, emPerPx);
      const claim = M[b + 7] > 0.004 && M[b + 7] < 0.996;
      const ref = reference(segs, bb, N, evenodd);
      const so = score(mo, ref, claim),
        sn = score(mn, ref, claim),
        sf = score(mf, ref, claim),
        ss = score(ms, ref, claim);
      add(TO, so);
      add(TN, sn);
      add(TF, sf);
      add(TS, ss);
      if (so.off === sn.off && so.paintOut === sn.paintOut && so.lostIn === sn.lostIn) sameMesh++;
      worst.push({ f: path.basename(f), s, N, o: so, n: sn, c: sf });
    }
    if (LIMIT && shapes >= LIMIT) break;
  }
  console.log(
    `\ncorpus: ${assets} assets, ${shapes} CDT-class shapes warped 0.1% coherent, rendered at 256 px over each drawing (${((Date.now() - t0) / 1000).toFixed(0)} s)`,
  );
  console.log(
    `  skipped: ${prims} recognized primitives (both builders make the primitive), ${noFill} rows with no fill paint; the fast-builder stream built ${oldFast} of the rest with the fast builder; ${sameMesh} score the same both ways`,
  );
  console.log(line('fast-builder stream      ', TO));
  console.log(line('static route', TN));
  console.log(line('correct fast builder', TF));
  console.log(line('stream now (fastCorrect)', TS));
  console.log(
    `  correct fast builder declined to the static route: ${JSON.stringify(fastDeclines)}`,
  );
  const cw = worst
    .filter((w) => w.c.farOut || w.c.farIn)
    .slice(0, 8)
    .map((w) => `${w.f}#${w.s} out ${w.c.farOut} in ${w.c.farIn}`)
    .join(', ');
  console.log(`  correct fast builder, shapes with an error >1.5 px from an edge: ${cw || 'none'}`);
  const cwe = worst
    .slice()
    .sort((p, q) => q.c.off - q.n.off - (p.c.off - p.n.off))
    .slice(0, 6)
    .map((w) => `${w.f}#${w.s} static ${w.n.off} fast ${w.c.off}`)
    .join(', ');
  console.log(`  where the correct fast builder is worse than static (whole px): ${cwe}`);
  const ewe = worst
    .slice()
    .sort((p, q) => q.c.aaBad - q.n.aaBad - (p.c.aaBad - p.n.aaBad))
    .slice(0, 8)
    .map((w) => `${w.f}#${w.s} static ${w.n.aaBad} fast ${w.c.aaBad}`)
    .join(', ');
  console.log(
    `  where the correct fast builder is worse than static (edge px >32/255 off): ${ewe}`,
  );
  const by = (key) =>
    worst
      .slice()
      .sort((p, q) => q.o[key] - q.n[key] - (p.o[key] - p.n[key]))
      .slice(0, 6)
      .map((w) => `${w.f}#${w.s} ${w.o[key]}->${w.n[key]}`)
      .join(', ');
  console.log(`  worst for the fast-builder stream, painted outside: ${by('paintOut')}`);
  console.log(`  worst for the fast-builder stream, ink lost inside: ${by('lostIn')}`);
  const nw = worst
    .slice()
    .sort((p, q) => q.n.off - q.o.off - (p.n.off - p.o.off))
    .slice(0, 6)
    .map((w) => `${w.f}#${w.s} ${w.o.off}->${w.n.off}`)
    .join(', ');
  console.log(`  where the new stream is worse (off): ${nw}`);
}
process.exit(0);
