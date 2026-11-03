// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _rowGateAaRef — how far a decomposition's ANTIALIASED coverage stands from the truth, per shape.
//
// WHY this EXISTS. _rowGateSpill.mjs thresholds at 0.5 and throws away every sample within half a
// pixel of the outline: it is a CONTAINMENT measure and it is deliberately blind to the AA band.
// That is the right instrument for the hull-row gate and the wrong one for a change that moves the
// decomposition, because a moved cut moves the band -- and the band is where a render's summed
// error against another engine lives. Asked with the containment measure, a decomposition change
// reads as "net better, six shapes worse, all of them the model's over-report at a tip"; asked on
// the GPU against Slug and AAC, the same change reads 0.7% WORSE on tiger. Both were true of what
// they measured. This measures the thing the GPU was measuring, against ground truth rather than
// against another engine.
//
// THE REFERENCE IS exact IN X AND SLICED IN Y, with no renderer in it at all. A pixel's true
// coverage is the area of (pixel box AND filled region); rowSpans -- the fill oracle every other
// CPatch measurement is scored against -- gives the filled spans of a scanline exactly, so the x
// integral of each slice is exact and only the y integral is quadrature. An open subpath is filled
// as if closed, the way the packer treats it.
//
// READ THE DELTA, NOT THE TOTAL. |model - exact| is not smooth in the reference, so the quadrature
// wobbles the TOTAL by about 1% and not monotonically: 40 shapes score 666.5 / 652.8 / 649.0 /
// 655.8 px^2 at 16 / 32 / 64 / 128 slices. Two arms scored against the same cached reference
// (REF=, below) cancel that exactly, and the delta is what this exists to report -- measured, the
// difference between two decompositions of 175 tiger shapes is -95.28 px^2 at 32 slices and -95.25
// at 64.
//
// THE MEASURE. Over each shape's own box grown two pixels, at the raster the whole DRAWING is
// rendered at (so a shape a tenth of the drawing across is a tenth of the canvas, as on screen):
//
//   err    sum over pixels of |model - exact|, in px^2 -- the same quantity as a render's summed
//          error against a reference, and directly comparable between two decompositions
//   over   the positive part (ink the engine has and the shape does not)
//   under  the negative part
//   worst  the largest single-pixel error
//
// `model` is cpatchCov.patchCoverage composed over the shape's patches exactly as the kernel
// composes it, with each patch's rows as the packer decided them.
//
//   node probes/cpatchGate/_rowGateAaRef.mjs OUT.json [file.svg[#shape] ...]
//   node probes/cpatchGate/_rowGateAaRef.mjs --diff A.json B.json
//   SLICES=64 CANVAS=512 SHAPES=a,b,c
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

// ---------------------------------------------------------------- diff mode
if (process.argv[2] === '--diff') {
  const A = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const B = JSON.parse(readFileSync(process.argv[4], 'utf8'));
  const key = (r) => r.file + '#' + r.shape;
  const m = new Map(A.rows.map((r) => [key(r), r]));
  const rows = [];
  let dErr = 0,
    dOver = 0,
    dUnder = 0,
    worse = 0,
    better = 0,
    same = 0,
    moved = 0;
  for (const b of B.rows) {
    const a = m.get(key(b));
    if (!a) continue;
    const d = b.err - a.err;
    dErr += d;
    dOver += b.over - a.over;
    dUnder += b.under - a.under;
    if (a.patches !== b.patches || a.hash !== b.hash) moved++;
    if (d > 1e-9) {
      worse++;
      rows.push([d, b, a]);
    } else if (d < -1e-9) {
      better++;
      rows.push([d, b, a]);
    } else same++;
  }
  rows.sort((x, y) => y[0] - x[0]);
  const lim = +(process.env.ROWS || 25);
  console.log('  delta err   err A -> B        over          under        patches   shape');
  for (const [d, b, a] of rows.slice(0, lim).concat(rows.slice(-lim).filter((r) => r[0] < 0))) {
    console.log(
      `  ${(d >= 0 ? '+' : '') + d.toFixed(3).padStart(9)}   ${a.err.toFixed(2).padStart(8)} -> ${b.err.toFixed(2).padEnd(8)}  ` +
        `${a.over.toFixed(2).padStart(7)} -> ${b.over.toFixed(2).padEnd(7)}  ${a.under.toFixed(2).padStart(7)} -> ${b.under.toFixed(2).padEnd(7)}  ` +
        `${String(a.patches).padStart(4)} -> ${String(b.patches).padEnd(4)}  ${b.file.split('/').pop()} #${b.shape}`,
    );
  }
  console.log(
    `\n  ${B.rows.length} shapes, ${moved} with a moved decomposition; ${worse} worse, ${better} better, ${same} unchanged`,
  );
  console.log(
    `  total err ${(dErr >= 0 ? '+' : '') + dErr.toFixed(3)} px^2   (over ${(dOver >= 0 ? '+' : '') + dOver.toFixed(3)}, under ${(dUnder >= 0 ? '+' : '') + dUnder.toFixed(3)})`,
  );
  process.exit(0);
}

const xd = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || xd.DOMParser;
globalThis.XMLSerializer = globalThis.XMLSerializer || xd.XMLSerializer;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { headlessCPatchBundle, contoursToConverter, shapeEvenOdd, cpatchCurvePlane } =
  await import('../../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { circleFromContours, ellipseFromContours } =
  await import('../../src/geom/shapeRecognize.js');
const { packCPatchShape } = await import('../../src/renderer/cpatchPack.js');
const { patchCoverage } = await import('../../src/renderer/cpatchCov.js');
const { rowSpans } = await import('../../src/renderer/cpatchConvert.js');
const { segPt } = await import('../../src/geom/cpatchImplicit.js');

const out = process.argv[2];
if (!out) {
  console.error('usage: _rowGateAaRef.mjs OUT.json [file.svg[#shape] ...] | --diff A.json B.json');
  process.exit(2);
}
const SLICES = +(process.env.SLICES || 64);
// THE REFERENCE IS THE CONTOUR'S, so it owes nothing to which decomposition is on disk. Computed
// once and cached, both arms are scored against the identical numbers -- and the quadrature, which
// is the expensive half, is paid once. REF=<file> turns it on; delete the file to recompute.
const REFFILE = process.env.REF || '';
const refCache = REFFILE && existsSync(REFFILE) ? JSON.parse(readFileSync(REFFILE, 'utf8')) : {};
let refDirty = false;
const CANVAS = +(process.env.CANVAS || 512);
const PAD = +(process.env.PAD || 2);
const _w = console.warn;
console.warn = () => {};

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

/// FNV-1a over a patch set's geometry, so a moved decomposition can be told from an unmoved one
/// without re-running the mesh count.
function hashPatches(patches) {
  let h = 0x811c9dc5 >>> 0;
  const mix = (v) => {
    const b = new Uint8Array(new Float64Array([v]).buffer);
    for (let i = 0; i < 8; i++) {
      h ^= b[i];
      h = Math.imul(h, 16777619) >>> 0;
    }
  };
  for (const p of patches)
    for (const c of p.curves)
      for (const q of c.P) {
        mix(q[0]);
        mix(q[1]);
      }
  return h.toString(16);
}

/// exact IN X, SLICED IN Y: the area of the pixel box [x, x+px] x [y, y+px] inside the contour.
function exactCov(curves, x, y, px, slices) {
  let a = 0;
  for (let s = 0; s < slices; s++) {
    const yy = y + (px * (s + 0.5)) / slices;
    const spans = rowSpans(curves, yy);
    for (const sp of spans) {
      const lo = Math.max(sp[0], x),
        hi = Math.min(sp[1], x + px);
      if (hi > lo) a += hi - lo;
    }
  }
  return a / (px * slices);
}

const targets = new Map();
for (const arg of process.argv.slice(3)) {
  const [f, s] = arg.split('#');
  if (!targets.has(f)) targets.set(f, []);
  if (s != null) targets.get(f).push(+s);
}
if (!targets.size) targets.set('../MantleSamples/Assets/Mantle/tiger.svg', []);

const rows = [];
for (const [file, want] of targets) {
  const bundle = headlessCPatchBundle(
    await importSvg(readFileSync(path.resolve(ROOT, file), 'utf8')),
  );
  const cf = cpatchCurvePlane(bundle);
  const ranges = bundle.curveRangesByShape || [];
  const cycleCache = new Map();
  // THE RASTER IS THE whole DRAWING'S, not each shape's. A shape measured on its own 512px raster
  // is being asked about a zoom nobody renders; the GPU numbers this exists to explain come from
  // one canvas holding the whole asset.
  let ax0 = Infinity,
    ay0 = Infinity,
    ax1 = -Infinity,
    ay1 = -Infinity;
  const contoursOf = (s) => {
    const r = ranges[s];
    if (!r) return null;
    let c = null;
    try {
      c = curveRangeToContours(cf, r.begin, r.end);
    } catch {
      return null;
    }
    if (!c || !c.length) return null;
    if (circleFromContours(c) || ellipseFromContours(c)) return null;
    return contoursToConverter(c, null);
  };
  for (let s = 0; s < ranges.length; s++) {
    const cs = contoursOf(s);
    if (!cs) continue;
    for (const q of cs)
      for (const sg of q)
        for (const p of sg.P) {
          if (p[0] < ax0) ax0 = p[0];
          if (p[0] > ax1) ax1 = p[0];
          if (p[1] < ay0) ay0 = p[1];
          if (p[1] > ay1) ay1 = p[1];
        }
  }
  const px = Math.max(ax1 - ax0, ay1 - ay0) / CANVAS; // one device pixel, in artwork units
  const list = want.length ? want : ranges.map((_, i) => i);
  for (const s of list) {
    const cs = contoursOf(s);
    if (!cs) continue;
    const patches = [];
    try {
      packCPatchShape(cs, 0, {
        evenOdd: shapeEvenOdd(bundle, s),
        cycleCache,
        search: 'full',
        onPatches: (a) => patches.push(...a),
      });
    } catch {
      continue;
    }
    if (!patches.length) continue;
    const all = closed(cs);
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const sg of all)
      for (const p of sg.P) {
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      }
    // Snap to the pixel grid so the two arms sample the same pixels: a bbox that moved with the
    // decomposition would compare two different rasters.
    const i0 = Math.floor((x0 - ax0) / px) - PAD,
      i1 = Math.ceil((x1 - ax0) / px) + PAD;
    const j0 = Math.floor((y0 - ay0) / px) - PAD,
      j1 = Math.ceil((y1 - ay0) / px) + PAD;
    let err = 0,
      over = 0,
      under = 0,
      worst = 0,
      n = 0;
    const rk = `${file}#${s}|${CANVAS}|${SLICES}|${PAD}`;
    let ref = refCache[rk];
    const have = Array.isArray(ref) && ref.length === (i1 - i0 + 1) * (j1 - j0 + 1);
    if (!have) {
      ref = new Array((i1 - i0 + 1) * (j1 - j0 + 1));
      refDirty = true;
    }
    let ri = 0;
    for (let j = j0; j <= j1; j++) {
      const py = ay0 + j * px;
      for (let i = i0; i <= i1; i++, ri++) {
        const pxx = ax0 + i * px;
        const ex = have ? ref[ri] : (ref[ri] = exactCov(all, pxx, py, px, SLICES));
        const cx = pxx + px / 2,
          cy = py + px / 2;
        let open = 1.0;
        for (const p of patches) {
          const c = patchCoverage(p, cx, cy, px);
          if (c <= 0) continue;
          open *= 1.0 - c;
          if (open <= 0.001) break;
        }
        const mo = 1.0 - open;
        const d = mo - ex;
        if (d === 0) {
          n++;
          continue;
        }
        err += Math.abs(d);
        if (d > 0) over += d;
        else under -= d;
        if (Math.abs(d) > worst) worst = Math.abs(d);
        n++;
      }
    }
    if (!have && REFFILE) refCache[rk] = ref;
    rows.push({
      file,
      shape: s,
      patches: patches.length,
      hash: hashPatches(patches),
      px: n,
      err,
      over,
      under,
      worst,
    });
  }
  console.error(`${file}: ${rows.length} shapes`);
}
console.warn = _w;
rows.sort((a, b) => b.err - a.err);
const T = rows.reduce((t, r) => t + r.err, 0);
console.log(`     err px^2      over     under     worst  patches  shape`);
for (const r of rows.slice(0, +(process.env.ROWS || 15)))
  console.log(
    `  ${r.err.toFixed(3).padStart(10)}  ${r.over.toFixed(2).padStart(8)}  ${r.under.toFixed(2).padStart(8)}  ${r.worst.toFixed(3).padStart(8)}  ${String(r.patches).padStart(6)}  ${r.file.split('/').pop()} #${r.shape}`,
  );
console.log(
  `  ${rows.length} shapes, total err ${T.toFixed(3)} px^2 (SLICES=${SLICES}, CANVAS=${CANVAS})`,
);
writeFileSync(out, JSON.stringify({ slices: SLICES, canvas: CANVAS, rows }));
if (REFFILE && refDirty) writeFileSync(REFFILE, JSON.stringify(refCache));
