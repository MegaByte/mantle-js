// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// IT MEASURES THE CONVERTER, NOT THE RENDERER, AND THE DIFFERENCE IS LARGE. This probe drives
// convertContour directly, which skips the pack-level self-overlap RETRY that cpatchPack performs
// before it declines. So a contour that self-intersects is converted raw here and can report a
// large miss that the shipping route does not have. Worked example, the worst file in the corpus:
// _curvemiter2.svg reports 17.585% missing ink here (1034 of 5880 px, both contours flagged
// self-intersecting) and renders with MISSING 0 / EXTRA 0 / AA mean 0.0005 through the real route
// (probes/_cpatchWrongWhere.mjs SVGFILE=...). Check a finding from this probe against a RENDER
// before treating it as a defect.
//
// It also exhausts a 4GB heap on the full corpus in one process (~13 min in, during sweeping).
// Run it per file -- it takes filenames as argv -- and aggregate.
// _cpatchRealCorpus — how much REAL artwork the CPatch converter can actually handle.
//
// WHAT this PROBE IS FOR. Its cost columns price CPatch against the Loop-Blinn fill with a
// geometric proxy — IMPLICIT EVALUATIONS PER INK PIXEL — by which CPatch loses by 28-40x. THE
// PROXY IS NOT A SPEED RANKING. Drawn on the GPU (probes/_cpatchDrawSpeed.mjs), CPatch is 4-12x
// FASTER than Loop-Blinn per pixel and 5-9x more accurate. The proxy counts ALU while the
// hardware is bound by memory traffic: an LB
// fragment fetches its curve data from a texture, a CPatch fragment reads uniforms, and one
// fetch costs more than N implicits. A cost metric that has not been drawn decides nothing.
//
// The cost columns below are unweighted and clearly labeled, because they still say
// something true and narrow — how much area each engine's cover geometry shades, and how many
// half-space tests that implies. They are NOT a speed ranking. Read _cpatchDrawSpeed.mjs for
// speed.
//
// What this probe measures that no GPU timing can:
//
//   COVERAGE   what fraction of real contours convert to patches this converter can PROVE
//              valid, by exact predicates (not sampling). That is the blocker.
//   BUILD      conversion time per contour.
//
// RESULT (274 contours, 1839 curves: tiger plus the fixture corpus)
//
//   fully validated      76 of 274 contours (27.7%), holding 50.2% of the ink
//   fill error on those  0.011%
//   conversion           130 ms per contour (CPU prototype, unoptimized)
//   rejected outright    47 self-intersecting, 11 paths with native arcs
//
// So three quarters of real contours fall back, and the blocker is over-claim, not
// extension: on tiger the defect count runs 902 leak to 100 clip. CPatch is a fast path with
// Loop-Blinn underneath it, and the work that raises its share is
// converter work — self-intersection resolution, hole nesting, better cuts for leaks.
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parsePathD } from '../src/svg/path.js';
import {
  convertContour,
  inPatch,
  patchBBox,
  patchOBB,
  rowSpans,
} from '../src/renderer/cpatchConvert.js';
import { segPt, affEval, arcToRQuads } from '../src/geom/cpatchImplicit.js';
import { cubicInflections, cubicLoopCuts, cubicSlice } from '../src/geom/lbCubicMath.js';
// The renderer's own self-overlap resolver, used by the Loop-Blinn build for exactly this.
// It carries an exact intersection kernel for every type pair rather than a flattened
// approximation, and returns null when the boolean cannot resolve the outline.
import { resolveSelfOverlap } from '../src/renderer/lbFastMesh.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RES = 128;
// Effectively no cap: a small cap (40, or even 200) hides contours from the coverage number
// this probe exists to report. A cap on the measurement is a cap on the answer.
const CURVE_CAP = +(process.env.CURVE_CAP || 100000);

/// Same pre-split Loop-Blinn applies: inflections and the in-span double point. Without it a
/// cubic's control hull holds more than one arc of its own algebraic curve, which breaks the
/// implicit for both engines — this is not a CPatch concession, it is the shared precondition.
function splitCubic(P) {
  const ts = cubicInflections(P)
    .concat(cubicLoopCuts(P))
    .sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const t of ts) {
    if (t - prev > 1e-4) {
      out.push(cubicSlice(P, prev, t));
      prev = t;
    }
  }
  out.push(cubicSlice(P, prev, 1));
  return out;
}

/// SVG `d` strings → closed contours of converter segments. Degenerate-length segments are
/// dropped; a contour that does not close is closed with a line, as the fill rule requires.
let arcSkipped = 0,
  selfResolved = 0,
  selfUnresolvable = 0,
  selfSplit = 0;

/// Renderer-format segments -> converter segments. Shared by the raw parse and by anything
/// coming back out of resolveSelfOverlap, so a resolved outline re-enters on the same path.
function toConverterSegs(segs) {
  const out = [];
  for (const s of segs) {
    if (s.type === 0 && s.p1 && s.p2) out.push({ t: 'line', P: [s.p1, s.p2] });
    else if (s.type === 1 && s.p3) out.push({ t: 'quad', P: [s.p1, s.p2, s.p3] });
    else if (s.type === 2 && s.p4)
      for (const P of splitCubic([s.p1, s.p2, s.p3, s.p4])) out.push({ t: 'cubic', P });
    else if (s.type === 3) {
      const qs = arcToRQuads(s);
      if (!qs.length) return null;
      for (const q of qs) out.push(q);
    } else return null;
  }
  return out;
}

const closeUp = (f) => {
  const g = f.filter((sg) => {
    let L = 0;
    for (let i = 0; i + 1 < sg.P.length; i++)
      L += Math.hypot(sg.P[i + 1][0] - sg.P[i][0], sg.P[i + 1][1] - sg.P[i][1]);
    return L > 1e-7;
  });
  if (g.length < 2) return null;
  const a = g[0].P[0],
    b = g[g.length - 1].P[g[g.length - 1].P.length - 1];
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6) g.push({ t: 'line', P: [b, a] });
  return g.length >= 2 ? g : null;
};

function contoursOf(d) {
  let segs;
  try {
    segs = parsePathD(d);
  } catch {
    return [];
  }
  const raw = [];
  let cur = null;
  for (const s of segs) {
    if (s.subStart && cur && cur.length) {
      raw.push(cur);
      cur = null;
    }
    if (!cur) cur = [];
    cur.push(s);
  }
  if (cur && cur.length) raw.push(cur);

  const out = [];
  for (const rc of raw) {
    const conv = toConverterSegs(rc);
    if (!conv) {
      arcSkipped++;
      continue;
    }
    const closed = closeUp(conv);
    if (!closed) continue;
    // THE exact KERNEL DECIDES whether a contour self-intersects, not a polyline test.
    // resolveSelfOverlap returns its input array UNCHANGED when its own exact intersection
    // kernel finds no crossing, so that return IS the oracle. The probe's flattened
    // selfIntersects disagrees with it on most such contours — false positives from chords that
    // merely touch — and would route every one into the "could not resolve" bucket as a
    // coverage failure it is not.
    let res = null,
      threw = false;
    try {
      res = resolveSelfOverlap([rc], 'nonzero');
    } catch {
      threw = true;
    }
    if (threw || (res && res.length === 1 && res[0] === rc)) {
      out.push(closed);
      continue;
    }
    if (res && res.length) {
      if (res.length > 1) selfSplit++;
      selfResolved++;
      for (const c2 of res) {
        const cv = toConverterSegs(c2);
        const cl = cv && closeUp(cv);
        // PROVENANCE. A resolution that splits into several contours may be emitting a HOLE,
        // and a union of patches cannot express one — it would fill it. Tag them so the fill
        // error can be attributed instead of averaged away.
        if (cl) {
          if (res.length > 1) cl._split = true;
          out.push(cl);
        }
      }
      continue;
    }
    // Genuinely unresolvable. Convert the raw outline rather than drop it: a union of patches
    // is a union, and a nonzero-winding outline covers its union too, so the two often agree.
    selfUnresolvable++;
    out.push(closed);
  }
  return out;
}

const polyOf = (s) => {
  if (s.t === 'line') return s.P;
  const K = 64,
    o = [];
  for (let i = 0; i <= K; i++) o.push(segPt(s, i / K));
  return o;
};

/// A contour whose own edges cross is outside this converter's scope (it needs a prior
/// self-intersection resolution stage, which the renderer already has as resolveSelfOverlap).
/// Counted rather than silently mis-filled — the fraction of real artwork this rejects is one
/// of the numbers being measured.
function selfIntersects(curves) {
  const polys = curves.map(polyOf);
  const segsOf = (p) => {
    const o = [];
    for (let i = 0; i + 1 < p.length; i++) o.push([p[i], p[i + 1]]);
    return o;
  };
  const E = polys.flatMap(segsOf);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  for (let i = 0; i < E.length; i++)
    for (let j = i + 2; j < E.length; j++) {
      if (i === 0 && j === E.length - 1) continue;
      const [a, b] = E[i],
        [c, d] = E[j];
      const d1 = cross(a, b, c),
        d2 = cross(a, b, d),
        d3 = cross(c, d, a),
        d4 = cross(c, d, b);
      if (d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0) return true;
    }
  return false;
}

const why = {};
const bail = (r) => {
  why[r] = (why[r] || 0) + 1;
  return null;
};

function measure(curves) {
  const bb = patchBBox(curves);
  const w = bb[2] - bb[0],
    h = bb[3] - bb[1];
  if (!(w > 0) || !(h > 0)) return bail('zero-area bbox');
  const pad = 0.04 * Math.max(w, h);
  const X0 = bb[0] - pad,
    Y0 = bb[1] - pad,
    S = (Math.max(w, h) + 2 * pad) / RES;
  const px = (c) => X0 + (c + 0.5) * S,
    py = (r) => Y0 + (r + 0.5) * S;

  const t0 = process.hrtime.bigint();
  const { patches, stats } = convertContour(curves, { maxCurves: 8, tolPx: 0.05 * S });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (!patches.length) return bail('no patches');

  // Reference: exact spans of the true curves on each sample row.
  let ink = 0,
    miss = 0,
    extra = 0;
  const ref = new Uint8Array(RES * RES);
  for (let r = 0; r < RES; r++) {
    const spans = rowSpans(curves, py(r));
    for (let c = 0; c < RES; c++) {
      const x = px(c);
      let v = 0;
      for (const [a, b] of spans)
        if (x >= a && x <= b) {
          v = 1;
          break;
        }
      ref[r * RES + c] = v;
      if (v) ink++;
    }
  }
  if (!ink) return bail('no ink at 128px');
  const boxes = patches.map((p) => p.bbox);
  let cpTests = 0;
  for (let r = 0; r < RES; r++)
    for (let c = 0; c < RES; c++) {
      const x = px(c),
        y = py(r);
      let hit = 0;
      for (let k = 0; k < patches.length; k++) {
        const b = boxes[k];
        if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
        // The drawn quad is the ORIENTED box, so only fragments inside it are shaded — that is
        // what a fragment costs, and an axis-aligned reject would over-count a diagonal patch.
        const o = patches[k].obb;
        if (o) {
          let out = false;
          for (const h of o.lines)
            if (affEval(h, x, y) < 0) {
              out = true;
              break;
            }
          if (out) continue;
        }
        cpTests += patches[k].impls.length;
        if (inPatch(patches[k], x, y)) hit = 1;
      }
      const v = ref[r * RES + c];
      if (v && !hit) miss++;
      else if (!v && hit) extra++;
    }
  // The FLOOR any CPatch implementation must pay, converter quality aside: one patch for the
  // whole contour, N = its curve count, over its own oriented box. No decomposition can beat
  // it — fewer patches is impossible and more only adds boxes — so if this loses to Loop-Blinn
  // the formulation loses, not this converter.
  let idealTests = 0;
  const cob = patchOBB(curves);
  if (cob)
    for (let r = 0; r < RES; r++)
      for (let c = 0; c < RES; c++) {
        const x = px(c),
          y = py(r);
        let out = false;
        for (const h of cob.lines)
          if (affEval(h, x, y) < 0) {
            out = true;
            break;
          }
        if (!out) idealTests += curves.length;
      }

  // Loop-Blinn: fragments inside each curve's control hull pay exactly one implicit.
  let lbTests = 0,
    curved = 0;
  for (const s of curves) {
    if (s.t === 'line') continue;
    curved++;
    const hb = patchBBox([s]);
    const hull = s.P;
    for (let r = 0; r < RES; r++) {
      const y = py(r);
      if (y < hb[1] || y > hb[3]) continue;
      for (let c = 0; c < RES; c++) {
        const x = px(c);
        if (x < hb[0] || x > hb[2]) continue;
        // point-in-convex-hull of the control points
        let inside = true,
          sgn = 0;
        const H = convexHull(hull);
        for (let i = 0; i < H.length; i++) {
          const a = H[i],
            b = H[(i + 1) % H.length];
          const cr = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
          if (Math.abs(cr) < 1e-12) continue;
          const t = cr > 0 ? 1 : -1;
          if (sgn === 0) sgn = t;
          else if (t !== sgn) {
            inside = false;
            break;
          }
        }
        if (inside) lbTests++;
      }
    }
  }
  return {
    patches: patches.length,
    stats,
    ms,
    ink,
    miss,
    extra,
    clean: stats.unresolved === 0,
    cp: cpTests / ink,
    lb: lbTests / ink,
    ideal: idealTests / ink,
    curved,
    curves: curves.length,
  };
}

const _hullCache = new Map();
function convexHull(pts) {
  const key = pts.map((p) => p.join()).join(';');
  if (_hullCache.has(key)) return _hullCache.get(key);
  const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [],
    up = [];
  for (const p of P) {
    while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i];
    while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop();
    up.push(p);
  }
  lo.pop();
  up.pop();
  const h = lo.concat(up);
  _hullCache.set(key, h);
  return h;
}

// ---- corpus ---------------------------------------------------------------------
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'examples/tiger.svg',
      ...readdirSync(path.join(ROOT, '../fixtures/svg'))
        .filter((f) => f.endsWith('.svg'))
        .map((f) => '../fixtures/svg/' + f),
    ];

// Contours the converter could NOT fully validate are tracked apart. A real engine hands those
// to Loop-Blinn, so folding their fill error into a headline number would price a configuration
// nobody would ship; and folding their cost in would price patches an engine would not draw.
const agg = {
  contours: 0,
  skipped: 0,
  selfInt: 0,
  degen: 0,
  patches: 0,
  curves: 0,
  ms: 0,
  cp: 0,
  lb: 0,
  ink: 0,
  miss: 0,
  extra: 0,
  unresolved: 0,
  worstMiss: null,
  bigN: 0,
  dirty: 0,
  dirtyInk: 0,
  cCp: 0,
  cLb: 0,
  cInk: 0,
  cMiss: 0,
  cExtra: 0,
  cPatches: 0,
  cCurves: 0,
  cIdeal: 0,
  ideal: 0,
  splitInk: 0,
  splitExtra: 0,
  splitMiss: 0,
  splitN: 0,
};
const perFile = [];
for (const f of files) {
  let txt;
  try {
    txt = readFileSync(path.join(ROOT, f), 'utf8');
  } catch {
    continue;
  }
  const ds = [...txt.matchAll(/\sd\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  let n = 0,
    pat = 0,
    cp = 0,
    lb = 0,
    ms = 0,
    ink = 0,
    miss = 0,
    extra = 0;
  for (const d of ds)
    for (const curves of contoursOf(d)) {
      if (curves.length > CURVE_CAP) {
        agg.skipped++;
        continue;
      }
      // NO second self-intersection skip here. contoursOf already resolves what the boolean can
      // and converts the rest raw; re-testing at this level would silently drop exactly the
      // contours that were just admitted, so the coverage number would never move.
      if (selfIntersects(curves)) agg.selfInt++;
      let m;
      try {
        m = measure(curves);
      } catch (e) {
        m = null;
        bail('threw: ' + String(e.message).slice(0, 40));
      }
      if (m && curves._split) {
        agg.splitInk += m.ink;
        agg.splitExtra += m.extra;
        agg.splitMiss += m.miss;
        agg.splitN++;
      }
      if (!m) {
        agg.degen++;
        continue;
      }
      agg.ideal += m.ideal * m.ink;
      if (m.clean) {
        agg.cIdeal += m.ideal * m.ink;
        agg.cCp += m.cp * m.ink;
        agg.cLb += m.lb * m.ink;
        agg.cInk += m.ink;
        agg.cMiss += m.miss;
        agg.cExtra += m.extra;
        agg.cPatches += m.patches;
        agg.cCurves += m.curves;
      } else {
        agg.dirty++;
        agg.dirtyInk += m.ink;
      }
      n++;
      pat += m.patches;
      cp += m.cp * m.ink;
      lb += m.lb * m.ink;
      ms += m.ms;
      ink += m.ink;
      miss += m.miss;
      extra += m.extra;
      agg.unresolved += m.stats.unresolved;
      agg.curves += m.curves;
      if (m.patches > 8) agg.bigN++;
      const bad = (m.miss + m.extra) / m.ink;
      if (!agg.worstMiss || bad > agg.worstMiss.bad)
        agg.worstMiss = { bad, file: f, curves: m.curves, patches: m.patches };
    }
  if (!n) continue;
  agg.contours += n;
  agg.patches += pat;
  agg.cp += cp;
  agg.lb += lb;
  agg.ms += ms;
  agg.ink += ink;
  agg.miss += miss;
  agg.extra += extra;
  perFile.push({
    f: path.basename(f),
    n,
    pat,
    cp: cp / ink,
    lb: lb / ink,
    ms,
    err: (miss + extra) / ink,
  });
}

perFile.sort((a, b) => b.n - a.n);
console.log(
  'file                     contours  patches  CPatch impl/px  LB impl/px   ratio   err%   convert',
);
for (const r of perFile.slice(0, 14))
  console.log(
    `${r.f.padEnd(24)} ${String(r.n).padStart(8)} ${String(r.pat).padStart(8)} ` +
      `${r.cp.toFixed(2).padStart(14)} ${r.lb.toFixed(2).padStart(11)} ${(r.lb > 1e-6 ? (r.cp / r.lb).toFixed(2) + 'x' : 'LB=0').padStart(8)}` +
      ` ${(100 * r.err).toFixed(3).padStart(6)} ${(r.ms / r.n).toFixed(2).padStart(7)}ms`,
  );

console.log('\n---- rejections');
for (const [k, v] of Object.entries(why).sort((a, b) => b[1] - a[1]))
  console.log(`  ${String(v).padStart(5)}  ${k}`);
console.log('\n---- corpus totals');
console.log(
  `paths with arcs      ${arcSkipped} still unsupported (arcs now convert as rational quadratics)`,
);
console.log(
  `contours converted   ${agg.contours}   (skipped: ${agg.skipped} over ${CURVE_CAP} curves, ` +
    `${agg.selfInt} still self-intersecting, ${agg.degen} degenerate)`,
);
console.log(
  `self-overlap         ${selfResolved} contour(s) resolved (${selfSplit} split into several), ` +
    `${selfUnresolvable} the boolean could not resolve (converted raw)`,
);
console.log(
  `curves in            ${agg.curves}      patches out ${agg.patches}   (${(agg.patches / agg.contours).toFixed(2)} per contour)`,
);
console.log(`CPatch implicits/px  ${(agg.cp / agg.ink).toFixed(2)}`);
console.log(`LB     implicits/px  ${(agg.lb / agg.ink).toFixed(2)}`);
console.log(
  `ideal CPatch floor   ${(agg.ideal / agg.ink).toFixed(2)} implicits/px = ${(agg.ideal / agg.lb).toFixed(2)}x LB`,
);
console.log(
  `CPatch / LB          ${(agg.cp / agg.lb).toFixed(2)}x   (shaded-area ratio, NOT speed)`,
);
console.log(
  `conversion           ${(agg.ms / agg.contours).toFixed(2)} ms per contour, ${agg.ms.toFixed(0)} ms total`,
);
console.log(
  `fill error           missing ${agg.miss}, extra ${agg.extra}, of ${agg.ink} ink px ` +
    `(${((100 * (agg.miss + agg.extra)) / agg.ink).toFixed(4)}%)   unresolved patches ${agg.unresolved}`,
);
console.log(
  '\n---- contours the converter fully validated (what an engine would actually draw as CPatches)',
);
console.log(
  `clean contours       ${agg.contours - agg.dirty} of ${agg.contours} ` +
    `(${((100 * (agg.contours - agg.dirty)) / agg.contours).toFixed(1)}%), holding ` +
    `${((100 * (agg.ink - agg.dirtyInk)) / agg.ink).toFixed(1)}% of the ink`,
);
if (agg.cInk) {
  console.log(
    `curves in            ${agg.cCurves}      patches out ${agg.cPatches}   ` +
      `(${(agg.cPatches / agg.cCurves).toFixed(2)} patches per input curve)`,
  );
  console.log(`CPatch implicits/px  ${(agg.cCp / agg.cInk).toFixed(2)}`);
  console.log(`LB     implicits/px  ${(agg.cLb / agg.cInk).toFixed(2)}`);
  console.log(
    `CPatch / LB          ${(agg.cCp / agg.cLb).toFixed(2)}x  (SHADED-AREA ratio, NOT speed — see _cpatchDrawSpeed.mjs)`,
  );
  console.log(
    `ideal CPatch floor   ${(agg.cIdeal / agg.cInk).toFixed(2)} implicits/px ` +
      `= ${(agg.cIdeal / agg.cLb).toFixed(2)}x LB   (one patch per contour, its own oriented box)`,
  );
  console.log(
    `fill error           ${((100 * (agg.cMiss + agg.cExtra)) / agg.cInk).toFixed(4)}% ` +
      `(missing ${agg.cMiss}, extra ${agg.cExtra} of ${agg.cInk})`,
  );
}
console.log(
  `from split resolutions  ${agg.splitN} contour(s): extra ${agg.splitExtra}, missing ${agg.splitMiss} of ${agg.splitInk} ink px`,
);
if (agg.worstMiss)
  console.log(
    `\nworst contour overall          ${(100 * agg.worstMiss.bad).toFixed(2)}% in ${agg.worstMiss.file} ` +
      `(${agg.worstMiss.curves} curves -> ${agg.worstMiss.patches} patches)`,
  );
