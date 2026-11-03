// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _rowGateSpill — what the hull-row gate's decision costs in INK, per shape and per patch.
//
// WHAT IT MEASURES. One decomposition, two row sets. The gate never touches the search, so the
// patches are identical under any bar -- which makes this an exact A/B rather than a comparison of
// two different decompositions. For each arm the CPU kernel model (cpatchCov.patchCoverage, which
// composes _cpatchCoverage.glsl term for term: per-constraint AA, arc boxes, cut seams, the cover
// polygon dilated 1.5px, the patch's own oriented box dilated by the filter's reach, and the hull
// rows on the patches that kept them) is evaluated on a grid over the shape's box grown 15%, and
// two numbers come back:
//
//   SPILL  area the union of patches paints (painted > 0.5) that the contour does not cover
//   MISS   area inside the contour that no patch paints
//
// both in NOMINAL PIXELS SQUARED -- the shape laid out across 512 px, which is the scale these
// assets are authored and reviewed at and the same one coverageMiss uses. A sample within half a
// pixel of the outline is not counted either way: that band is the AA's business and both arms
// carry it identically.
//
// ARMS (`arm`): `gate` = the row set the packer chose; `all` = every patch fenced; `none` = no
// patch fenced; `flat` = the row set a FLAT bar chooses (the flat-bar gate, __CP_TOL_ABS units).
//
// CALIBRATION. --selftest runs the four checks, and the numbers are worth exactly what these are:
//   monotone   spill(none) >= spill(gate) >= spill(all) on every shape. A hull row is a min() of a
//              half-plane's coverage, so a fence can only take ink away; any other order means the
//              model is not reading the arms it claims to.
//   bounded    a second, AA-FREE count -- a point is painted when ONE patch's conjunction, its own
//              box and its dilated cover polygon all admit it -- is a LOWER bound on the model's,
//              which unions partial coverages across patches. They must not cross.
//   grid       spill at N and at N/2 agree. They do at the scale that matters and NOT at a sample
//              or two: with the rows on, what is left is the model's known over-report at a sharp
//              tip (see cpatchCov: three pixels on tiger's per-shape sweep that the GPU does not
//              paint), and one sample stands for (1.3 * 512 / N)^2 px^2 -- 12 px^2 at N=192. Read
//              the whole-shape arms at tens of px^2, and use --patches for anything finer.
//   A/A        the same arm twice is bit-identical.
//
//   node probes/cpatchGate/_rowGateSpill.mjs [--selftest] [file.svg[#shape] ...]
//   N=192 ARMS=gate,flat,none,all OUT=x.json
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const xd = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || xd.DOMParser;
globalThis.XMLSerializer = globalThis.XMLSerializer || xd.XMLSerializer;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { headlessCPatchBundle, contoursToConverter, shapeEvenOdd, cpatchCurvePlane } =
  await import('../../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { circleFromContours, ellipseFromContours } =
  await import('../../src/geom/shapeRecognize.js');
const { packCPatchShape, K_ROWS } = await import('../../src/renderer/cpatchPack.js');
const { patchCoverage, CP_AA_REACH } = await import('../../src/renderer/cpatchCov.js');
const { segPt } = await import('../../src/geom/cpatchImplicit.js');
const { patchLeaksInBox, rowSpans, inPatch, leakOfInner, CP_TOL_DEFAULT } =
  await import('../../src/renderer/cpatchConvert.js');

// This probe grades hull rows of seam patches, rather than complete-paint area.
if (process.argv.includes('--noarea')) {
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__CP_NO_AREA = 1;
}
const SELFTEST = process.argv.includes('--selftest');
const PATCHES = process.argv.includes('--patches');
const M = +(process.env.M || 256);
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const N = +(process.env.N || 192);
const ARMS = (process.env.ARMS || 'flat,gate,none,all').split(',');
/// The drawing's own extent, when the numbers should be read at the raster the ASSET is drawn at
/// rather than at one shape across 512px. See `measure`.
const RASTER = +(process.env.RASTER || 0);
const _w = console.warn;
console.warn = () => {};

// ---------------------------------------------------------------- the measure
/// Distance to the contour, as coverageMiss takes it: the AA band is nobody's spill.
function distToContour(curves, x, y) {
  let d2 = Infinity;
  for (const sg of curves) {
    const P = sg.P,
      n = P.length;
    for (let k = 0; k <= 24; k++) {
      const t = k / 24;
      const pts = [];
      for (let m = 0; m < n; m++) pts.push([P[m][0], P[m][1]]);
      for (let r = n - 1; r > 0; r--)
        for (let m = 0; m < r; m++) {
          pts[m][0] += (pts[m + 1][0] - pts[m][0]) * t;
          pts[m][1] += (pts[m + 1][1] - pts[m][1]) * t;
        }
      const dd = (pts[0][0] - x) ** 2 + (pts[0][1] - y) ** 2;
      if (dd < d2) d2 = dd;
    }
  }
  return Math.sqrt(d2);
}

/// THE FLAT-BAR GATE, REPRODUCED exactly, and not `patchLeaksInBox(p, 0.02)`. patchLeaksInBox
/// passes the MONOTONE ask whatever bar it is handed, so handing it 0.02 gives "the monotone
/// predicate at the flat bar" and the arm silently stops being a baseline. The flat-bar gate is the
/// SEARCH's ask at the flat bar, with the strict re-test.
const flatPreFix = (p) => {
  let lk = null;
  try {
    lk = leakOfInner(p, CP_TOL_DEFAULT, 0, { box: true });
  } catch {
    lk = { depth: Infinity };
  }
  return !!(lk && lk.depth > CP_TOL_DEFAULT);
};

/// THE FILL ORACLE HAS TO CLOSE WHAT THE PACKER CLOSES. An open subpath is filled as if closed
/// (cpatchBoundarySmoke pins it), and the tiger's whiskers are exactly that: two cubics with their
/// ends 113 units apart. rowSpans over the raw segments then finds no interior at all, and every
/// pixel the patches correctly paint reads as ink OUTSIDE the shape -- 114,805 px^2 of it over
/// tiger's 296 shapes, in seven shapes, at every arm including "fence every patch".
const closed = (contours) => {
  const out = [];
  for (const q of contours) {
    if (!q.length) continue;
    for (const sg of q) out.push(sg);
    const a = segPt(q[0], 0),
      b = segPt(q[q.length - 1], 1);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9)
      out.push({
        t: 'line',
        P: [
          [b[0], b[1]],
          [a[0], a[1]],
        ],
      });
  }
  return out;
};

/// One arm's ink, in nominal px^2. `hard` takes the AA-free predicate instead of the kernel model.
function measure(curves, patches, n, hard) {
  // EMPERPX is the raster, and which raster matters. By default a shape is laid out across 512px
  // on its own, which is how the CPatch probes have always read these numbers and the right frame
  // for comparing one patch's fence against another's. To predict what a whole ASSET's render will
  // show, set RASTER to the asset's own extent: a shape a tenth of the drawing across is then a
  // tenth of the canvas, and its ink scales with the square of that.
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of curves)
    for (const p of s.P) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  if (!(x1 > x0) || !(y1 > y0)) return { spill: 0, miss: 0, spillN: 0, missN: 0, cell: 0 };
  const emPerPx = (RASTER > 0 ? RASTER : Math.max(x1 - x0, y1 - y0)) / 512.0 || 1e-6;
  const gw = (x1 - x0) * 0.15,
    gh = (y1 - y0) * 0.15;
  x0 -= gw;
  x1 += gw;
  y0 -= gh;
  y1 += gh;
  const cell = (((x1 - x0) / n) * ((y1 - y0) / n)) / (emPerPx * emPerPx); // px^2 a sample stands for
  let spillN = 0,
    missN = 0;
  for (let j = 0; j < n; j++) {
    const y = y0 + ((y1 - y0) * (j + 0.5)) / n;
    const spans = rowSpans(curves, y);
    for (let i = 0; i < n; i++) {
      const x = x0 + ((x1 - x0) * (i + 0.5)) / n;
      let inR = false,
        edge = Infinity;
      for (const sp of spans) {
        if (x >= sp[0] && x <= sp[1]) {
          inR = true;
          edge = Math.min(x - sp[0], sp[1] - x);
          break;
        }
        edge = Math.min(edge, Math.min(Math.abs(x - sp[0]), Math.abs(x - sp[1])));
      }
      if (edge < 0.5 * emPerPx) continue;
      let painted = 0;
      if (hard) {
        for (const p of patches) {
          if (hardPaint(p, x, y, emPerPx)) {
            painted = 1;
            break;
          }
        }
      } else {
        let open = 1.0;
        for (const p of patches) {
          const c = patchCoverage(p, x, y, emPerPx);
          if (c <= 0) continue;
          open *= 1.0 - c;
          if (open <= 0.001) break;
        }
        painted = 1.0 - open;
      }
      const counts = inR ? painted < 0.5 : painted > 0.5;
      if (counts && distToContour(curves, x, y) < 0.5 * emPerPx) continue;
      if (inR) {
        if (painted < 0.5) missN++;
      } else if (painted > 0.5) spillN++;
    }
  }
  return { spill: spillN * cell, miss: missN * cell, spillN, missN, cell };
}

/// WHAT ONE PATCH'S ROWS ARE HOLDING IN, sampled over that patch alone.
///
/// The whole-shape grid above is the right ARM comparison and the wrong instrument for a single
/// row set: a patch is a small part of its shape, so its ink lands in a handful of samples and the
/// count wobbles by a sample or two between grid sizes. This asks the question locally instead --
/// over the patch's own box grown by two pixels, at `m` samples across it -- and asks it as the
/// difference the rows make, which is the only thing the gate decides:
///
///   held   area this patch paints with its rows OFF and not with them ON, OUTSIDE the contour:
///          the ink the fence exists to stop, and the number a dropped row has to be zero on
///   inner  the same difference INSIDE the contour, where the ink is the shape's own color and
///          costs nothing
///   orphan inner area that NO OTHER patch of the shape paints -- where fencing this patch would
///          leave a hole rather than tidy an overlap
///
/// ...AND ALL THREE ARE AREA, NOT A THRESHOLD CROSSING. An earlier version counted pixels where
/// the patch crossed 0.5 in one arm and not the other, and that is blind to exactly what a hull
/// row mostly does: attenuate a pixel from 1.0 to 0.7 without crossing anything. It reported
/// "0.0000 px^2 either sign" for engineDeclineIsolation__STAR's 86 new fences while the GPU moved
/// 115 pixels on that shape. The difference in COVERAGE is integrated instead, so a sub-threshold
/// change is worth what it is worth.
function patchRowInk(p, all, patches, m) {
  const b = p.bbox;
  if (!b) return { held: 0, inner: 0, orphan: 0, heldN: 0, touched: 0 };
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of all)
    for (const q of s.P) {
      if (q[0] < x0) x0 = q[0];
      if (q[0] > x1) x1 = q[0];
      if (q[1] < y0) y0 = q[1];
      if (q[1] > y1) y1 = q[1];
    }
  const emPerPx = (RASTER > 0 ? RASTER : Math.max(x1 - x0, y1 - y0)) / 512.0 || 1e-6;
  const pad = 2.0 * emPerPx;
  const bx0 = b[0] - pad,
    by0 = b[1] - pad,
    bx1 = b[2] + pad,
    by1 = b[3] + pad;
  const cell = (((bx1 - bx0) / m) * ((by1 - by0) / m)) / (emPerPx * emPerPx);
  const was = p[K_ROWS];
  // `touched` IS THE PREDICTION A GPU DIFF CAN BE GRADED AGAINST: the AREA, in device pixels, over
  // which this patch's rows move the coverage by at least one 8-bit step. It is accumulated as area
  // and not as a sample count, because the grid here is M across a patch's own box and that box is
  // a few device pixels wide -- counting samples answers in sample units and reads 1.4 million for
  // tiger. The px^2 above say how much ink moved; this says how many pixels carry it, and a hull
  // row's damage is mostly a small change over many pixels rather than the reverse.
  let held = 0,
    inner = 0,
    orphan = 0,
    heldN = 0,
    touched = 0;
  for (let j = 0; j < m; j++) {
    const y = by0 + ((by1 - by0) * (j + 0.5)) / m;
    const spans = rowSpans(all, y);
    for (let i = 0; i < m; i++) {
      const x = bx0 + ((bx1 - bx0) * (i + 0.5)) / m;
      p[K_ROWS] = true;
      const on = patchCoverage(p, x, y, emPerPx);
      p[K_ROWS] = false;
      const off = patchCoverage(p, x, y, emPerPx);
      const d = off - on; // what the rows take away
      if (Math.abs(d) >= 1 / 255) touched += cell; // AREA, so the answer is DEVICE pixels
      if (!(d > 1e-6)) continue;
      let inR = false;
      for (const sp of spans)
        if (x >= sp[0] && x <= sp[1]) {
          inR = true;
          break;
        }
      if (!inR) {
        held += d * cell;
        heldN++;
        continue;
      }
      inner += d * cell;
      // ORPHANED: how much of that interior nothing else is painting. Area again, so a pixel two
      // patches each cover 0.4 of counts for what is actually missing rather than for all or none.
      let other = 0;
      for (const q of patches) {
        if (q === p) continue;
        const c = patchCoverage(q, x, y, emPerPx);
        if (c > other) other = c;
        if (other >= 1) break;
      }
      orphan += Math.max(0, Math.min(d, 1 - other)) * cell;
    }
  }
  p[K_ROWS] = was;
  return { held, inner, orphan, heldN, touched };
}

/// THE SECOND PREDICATE, with no antialiasing in it at all: a point is painted if some patch's
/// half-spaces, its box and its dilated cover polygon all admit it, and its rows (when it has
/// them) do not reject it. Independent of patchCoverage's whole ramp machinery, so where the two
/// agree the number is a property of the geometry rather than of one implementation.
function hardPaint(p, x, y, emPerPx) {
  if (!inPatch(p, x, y)) return false;
  if (p.obb)
    for (const h of p.obb.lines)
      if ((h[0] * x + h[1] * y + h[2]) / emPerPx < -CP_AA_REACH) return false;
  if (p[K_ROWS] !== false && p.cover)
    for (const h of p.cover)
      if ((h[0] * x + h[1] * y + h[2]) / emPerPx < -CP_AA_REACH) return false;
  return true;
}

// ---------------------------------------------------------------- shapes
function setArm(patches, arm, flags) {
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    if (arm === 'all') p[K_ROWS] = true;
    else if (arm === 'none') p[K_ROWS] = false;
    else if (arm === 'flat') p[K_ROWS] = flags.flat[i];
    else p[K_ROWS] = flags.gate[i];
  }
}

const targets = [];
for (const a of args.length ? args : ['../MantleSamples/Assets/Mantle/tiger.svg']) {
  const [f, s] = a.split('#');
  targets.push({ file: f, shape: s != null ? +s : null });
}
const byFile = new Map();
for (const t of targets) {
  if (!byFile.has(t.file)) byFile.set(t.file, []);
  if (t.shape != null) byFile.get(t.file).push(t.shape);
}

const out = [];
for (const [file, shapes] of byFile) {
  const bundle = headlessCPatchBundle(
    await importSvg(readFileSync(path.resolve(ROOT, file), 'utf8')),
  );
  const cf = cpatchCurvePlane(bundle);
  const ranges = bundle.curveRangesByShape || [];
  const cycleCache = new Map();
  const list = shapes.length ? shapes : ranges.map((_, i) => i);
  for (const s of list) {
    const r = ranges[s];
    if (!r) continue;
    let contours = null;
    try {
      contours = curveRangeToContours(cf, r.begin, r.end);
    } catch {
      continue;
    }
    if (!contours || !contours.length) continue;
    if (circleFromContours(contours) || ellipseFromContours(contours)) continue;
    const cs = contoursToConverter(contours, null);
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
    // The two gate answers, on the same patches: the packer's (already stamped) and the flat bar's.
    const flags = {
      gate: patches.map((p) => p[K_ROWS] !== false),
      flat: [],
      tol: patches.map(
        (p) => Math.max(p.bbox[2] - p.bbox[0], p.bbox[3] - p.bbox[1]) * (0.02 / 256),
      ),
    };
    for (const p of patches) flags.flat.push(flatPreFix(p));
    const all = closed(cs);
    const row = {
      file,
      shape: s,
      patches: patches.length,
      rowsFlat: flags.flat.filter(Boolean).length,
      rowsGate: flags.gate.filter(Boolean).length,
      tol: flags.tol[0],
      arms: {},
    };
    for (const arm of ARMS) {
      setArm(patches, arm, flags);
      row.arms[arm] = measure(all, patches, N, false);
    }
    // every PATCH WHOSE ROW SET MOVED, measured on its own. `lost` is a patch the new bar exempts
    // and the flat one fenced -- the case that has to be shown harmless -- and `gained` the other
    // way, where the question is whether the new fence takes ink the shape needs.
    if (PATCHES) {
      setArm(patches, 'gate', flags);
      row.moved = [];
      for (let i = 0; i < patches.length; i++) {
        if (flags.flat[i] === flags.gate[i]) continue;
        const ink = patchRowInk(patches[i], all, patches, M);
        let depth = null;
        try {
          const lk = leakOfInner(patches[i], 1e-12, 0, { box: true });
          depth = lk ? lk.depth : null;
        } catch {
          depth = null;
        }
        row.moved.push({
          i,
          dir: flags.flat[i] ? 'lost' : 'gained',
          curves: patches[i].curves.length,
          bar: flags.tol[i],
          depth,
          ext: Math.max(
            patches[i].bbox[2] - patches[i].bbox[0],
            patches[i].bbox[3] - patches[i].bbox[1],
          ),
          ...ink,
        });
      }
    }
    if (SELFTEST) {
      setArm(patches, 'gate', flags);
      row.hard = measure(all, patches, N, true);
      row.half = (() => {
        setArm(patches, 'gate', flags);
        return measure(all, patches, Math.round(N / 2), false);
      })();
      row.aa = (() => {
        setArm(patches, 'gate', flags);
        return measure(all, patches, N, false);
      })();
    }
    setArm(patches, 'gate', flags);
    out.push(row);
  }
}
console.warn = _w;

const f3 = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(3));
let dSpill = 0,
  dMiss = 0,
  moved = 0;
console.log(
  `shape                              patches  rows flat->gate   spill px^2 flat->gate      miss px^2 flat->gate`,
);
for (const r of out) {
  const a = r.arms.flat,
    b = r.arms.gate;
  if (!a || !b) continue;
  if (r.rowsFlat !== r.rowsGate || a.spillN !== b.spillN) moved++;
  dSpill += b.spill - a.spill;
  dMiss += b.miss - a.miss;
  if (r.rowsFlat !== r.rowsGate || Math.abs(b.spill - a.spill) > 1e-9 || process.env.ALL)
    console.log(
      `${(r.file.split('/').pop() + ' #' + r.shape).padEnd(36)} ${String(r.patches).padStart(5)}  ${String(r.rowsFlat).padStart(5)} -> ${String(r.rowsGate).padEnd(5)}  ${f3(a.spill).padStart(10)} -> ${f3(b.spill).padEnd(10)}  ${f3(a.miss).padStart(10)} -> ${f3(b.miss).padEnd(10)}`,
    );
}
console.log(
  `${out.length} shapes, ${moved} with a different row set; total spill ${dSpill >= 0 ? '+' : ''}${dSpill.toFixed(3)} px^2, total miss ${dMiss >= 0 ? '+' : ''}${dMiss.toFixed(3)} px^2`,
);
if (PATCHES) {
  let lost = 0,
    gained = 0,
    held = 0,
    orphan = 0,
    guilty = 0;
  console.log('\npatches whose row set moved (M=' + M + ' over the patch box + 2px):');
  console.log(
    'shape                          patch  dir     curves     ext    held px^2  inner px^2  orphan px^2',
  );
  for (const r of out)
    for (const mv of r.moved || []) {
      if (mv.dir === 'lost') lost++;
      else gained++;
      held += mv.dir === 'lost' ? mv.held : 0;
      orphan += mv.dir === 'gained' ? mv.orphan : 0;
      if (mv.dir === 'lost' && mv.held > 0) guilty++;
      console.log(
        `${(r.file.split('/').pop() + ' #' + r.shape).padEnd(30)} ${String(mv.i).padStart(5)}  ${mv.dir.padEnd(7)} ${String(mv.curves).padStart(5)}  ${mv.ext.toFixed(2).padStart(8)}  ${mv.held.toFixed(4).padStart(10)}  ${mv.inner.toFixed(4).padStart(10)}  ${mv.orphan.toFixed(4).padStart(10)}  touched ${(mv.touched || 0).toFixed(1).padStart(7)}`,
      );
    }
  console.log(
    `${lost} patches lost their rows (${guilty} of them hold ink outside the contour, ${held.toFixed(4)} px^2 in total), ${gained} gained them (${orphan.toFixed(4)} px^2 of orphaned interior).`,
  );
  let tt = 0;
  for (const r of out) for (const mv of r.moved || []) tt += mv.touched || 0;
  console.log(
    `${tt.toFixed(1)} device pixels move by at least one 8-bit step (a pixel two patches both touch is counted twice).`,
  );
}
if (ARMS.includes('none') && ARMS.includes('all')) {
  const sum = (k) => out.reduce((t, r) => t + (r.arms[k] ? r.arms[k].spill : 0), 0);
  console.log(
    `arms: spill none ${sum('none').toFixed(2)}  flat ${sum('flat').toFixed(2)}  gate ${sum('gate').toFixed(2)}  all ${sum('all').toFixed(2)} px^2`,
  );
}
if (SELFTEST) {
  let bad = 0;
  for (const r of out) {
    const { none, gate, all } = r.arms;
    if (
      none &&
      gate &&
      all &&
      !(none.spill >= gate.spill - 1e-9 && gate.spill >= all.spill - 1e-9)
    ) {
      bad++;
      console.log(
        `  NOT MONOTONE ${r.file.split('/').pop()} #${r.shape}: none ${none.spill.toFixed(3)} gate ${gate.spill.toFixed(3)} all ${all.spill.toFixed(3)}`,
      );
    }
    if (
      r.aa &&
      r.arms.gate &&
      (r.aa.spillN !== r.arms.gate.spillN || r.aa.missN !== r.arms.gate.missN)
    ) {
      bad++;
      console.log(`  NOT DETERMINISTIC ${r.file.split('/').pop()} #${r.shape}`);
    }
    const g = r.arms.gate;
    if (r.half && g && Math.abs(r.half.spill - g.spill) > Math.max(0.05 * g.spill, 4 * g.cell)) {
      console.log(
        `  grid ${r.file.split('/').pop()} #${r.shape}: N/2 ${r.half.spill.toFixed(3)} vs N ${g.spill.toFixed(3)} px^2 (cell ${g.cell.toFixed(2)})`,
      );
    }
    if (r.hard && g && r.hard.spill > g.spill + 1e-9) {
      bad++;
      console.log(
        `  HARD ABOVE MODEL ${r.file.split('/').pop()} #${r.shape}: hard ${r.hard.spill.toFixed(3)} > model ${g.spill.toFixed(3)} px^2`,
      );
    }
  }
  const S = (k, f) => out.reduce((t, r) => t + (f(r) ? f(r)[k] : 0), 0);
  console.log(
    `selftest: ${bad} ordering/determinism failures; totals px^2 -- model ${S('spill', (r) => r.arms.gate).toFixed(2)}, hard ${S('spill', (r) => r.hard).toFixed(2)}, N/2 ${S('spill', (r) => r.half).toFixed(2)}`,
  );
}
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(out));
