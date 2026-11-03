// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// FOUR CLOCKS, AND THE ONE this SCORES ON. Three instrument traps move engine thresholds; what
// follows is each trap and how this file measures around it, because the thresholds it produces
// are only worth their instrument.
//
//   1. The TIME_ELAPSED timer is not the score. It agrees with elapsed time on draws with no
//      render-target pass (a constant +0.024..0.028ms apart at 512 and 1024) and OVER-REPORTS BY
//      2.5..3.8x on anything that runs one. Engines differ in exactly that -- the LB and CPatch
//      morph routes and filters run pre-passes, Slug does not -- so it would charge some arms for
//      stalls that consume no elapsed time and score them against arms it does not charge.
//
//   2. `wall` times a batch ending in gl.finish(), and GL.FINISH() DOES NOT SYNC HERE: wall
//      comes out identical to the submit time sampled before it, while a
//      gl.readPixels(0,0,1,1) after the same batch is 5..12x larger. It is submit time wearing
//      a frame-cost label. `sync` terminates every measurement with that readPixels, and is
//      what `score` reads. cpu/wall/gpu are still recorded -- as evidence, and so those two
//      claims stay checkable rather than becoming folklore.
//
//   3. Load equalisation: this GPU changes speed with load, so the HEAVIER arm can finish
//      FASTER in elapsed time (22% at N=1024) because it drove the clock up. Engines differ in
//      weight by construction -- that IS the comparison -- so BALLAST=n draws n identical
//      full-screen ALU passes in every arm every rep, pinning the clock where all arms see the
//      same one. It cancels in the comparison. BALLAST=0 turns the ballast off.
//
// Arm order is rotated per case (`rot`), so no engine permanently pays for the caches the rest
// find warm.
//
// Real-GPU fill-engine balance benchmark.
//
// Accuracy is checked against Slug after expanding its visible color edges by
// two pixels. Differences in that AA band are scored, but allowed; differences
// in stable interiors are structural failures. Hard fill is only measured when
// the shipping no-AA selector proves an opaque stroke covers the fill edge.
//
//   GPU=1 PROFILE=calibration node probes/_balanceBench.mjs
//   GPU=1 PROFILE=full REAL=1 CORPUS_ROOT=/path/to/svg/corpus REPS=7 node probes/_balanceBench.mjs
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser as launchIsolatedChrome } from '../test/_launch.mjs';

const HERE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.MANTLE_ROOT ? path.resolve(process.env.MANTLE_ROOT) : HERE_ROOT;
const CORPUS_ROOT = process.env.CORPUS_ROOT ? path.resolve(process.env.CORPUS_ROOT) : null;
const PROFILE = process.env.PROFILE || 'calibration';
const FULL = PROFILE === 'full';
const QUICK = PROFILE === 'quick';
const SIZES = (
  process.env.SIZES || (FULL ? '128,256,512,1024' : QUICK ? '256,512' : '256,512,1024')
)
  .split(',')
  .map(Number)
  .filter(Boolean);
const DRAWS = (process.env.DRAWS || '1,8,32').split(',').map(Number).filter(Boolean);
const REPS = +(process.env.REPS || (FULL ? 7 : QUICK ? 7 : 11));
const REAL_N = +(process.env.REAL_N || (FULL ? 48 : QUICK ? 12 : 24));
const CASE_LIMIT = +(process.env.CASE_LIMIT || 0);
// Supersample factor for the coverage reference. 4 gives 16 subsamples per pixel, so coverage is
// exact to 1/16 -- enough to separate "solid" and "empty" from "edge" with no threshold.
const SS = +(process.env.SS || 4);
const AXES = process.env.AXIS ? new Set(process.env.AXIS.split(',')) : null;
const DISABLE_WORKERS = process.env.DISABLE_WORKERS === '1';
// Ballast draws to pin the GPU clock. DEFAULT OFF, and off until proven harmless on a given
// setup: it draws with its own program into the same context the renderer owns, and a benchmark
// that perturbs what it is measuring is worse than one with a noisier clock. Verify with
// BALLAST=n that the completed-case count and the per-case ink are unchanged before trusting a
// run that uses it.
// On this setup BALLAST=8 leaves every case's ink
// bit-identical to a BALLAST=0 run (64/64 comparisons). Re-verify that way after touching it --
// a benchmark that perturbs what it measures is worse than one with a noisier clock.
const BALLAST = +(process.env.BALLAST == null ? 8 : process.env.BALLAST);
const NOSDF = process.env.NOSDF === '1'; // rank fill, not circle/ellipse/annulus recognition
const REAL = process.env.REAL === '1' && CORPUS_ROOT && existsSync(CORPUS_ROOT);
const OUT = process.env.OUT || path.join(ROOT, 'probes', '_balanceBenchOut-v2.json');
const REPORT = process.env.REPORT || path.join(ROOT, 'probes', '_balanceBenchReport-v2.md');

const fmt = (n) => (Number.isFinite(n) ? +n.toFixed(6) : null);
const polar = (cx, cy, r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
function pathFor(family, cx, cy, r, segments, subtype, rot = 0) {
  if (subtype) {
    const P = {
      convex: [
        [0, 0.8],
        [0.2, -0.2],
        [0.8, -0.2],
        [1, 0.8],
      ],
      serpentine: [
        [0, 0.5],
        [-0.27, 0.3],
        [0.78, 0.92],
        [1, 0.5],
      ],
      loop: [
        [0, 0.5],
        [-0.01, 1.01],
        [-0.12, -0.49],
        [1, 0.5],
      ],
      cusp: [
        [0, 0.5],
        [0.6403966051, -0.4145369838],
        [-0.380674997, -0.4661355019],
        [1, 0.5],
      ],
    }[subtype];
    const q = P.map(([x, y]) => [cx + (x - 0.5) * r * 1.6, cy + (y - 0.5) * r * 1.6]);
    return `M${q[0][0]} ${q[0][1]} C${q[1][0]} ${q[1][1]} ${q[2][0]} ${q[2][1]} ${q[3][0]} ${q[3][1]} L${cx + r * 0.7} ${cy + r} L${cx - r * 0.7} ${cy + r} Z`;
  }
  const n = Math.max(family === 'line' ? 3 : 4, segments | 0);
  // `rot` turns the ring without changing its topology, which is what a MORPH needs: two poses
  // whose segments correspond one-to-one, differing in where the points are rather than how many.
  const pts = Array.from({ length: n }, (_, i) =>
    polar(cx, cy, r, -Math.PI / 2 + rot + (i * Math.PI * 2) / n),
  );
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + rot + (i * Math.PI * 2) / n;
    const b = a + (Math.PI * 2) / n;
    const p = pts[(i + 1) % n];
    if (family === 'line') d += ` L${p[0]} ${p[1]}`;
    else if (family === 'arc') d += ` A${r} ${r} 0 0 1 ${p[0]} ${p[1]}`;
    else if (family === 'quad') {
      const cr = r / Math.cos((b - a) / 2),
        c = polar(cx, cy, cr, (a + b) / 2);
      d += ` Q${c[0]} ${c[1]} ${p[0]} ${p[1]}`;
    } else {
      const k = (4 / 3) * Math.tan((b - a) / 4) * r;
      const p0 = pts[i],
        c1 = [p0[0] - Math.sin(a) * k, p0[1] + Math.cos(a) * k];
      const c2 = [p[0] + Math.sin(b) * k, p[1] - Math.cos(b) * k];
      d += ` C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p[0]} ${p[1]}`;
    }
  }
  return d + ' Z';
}

function syntheticSvg({
  family,
  shapes,
  segments,
  subtype,
  hardSafe,
  strokeFrac = 0.08,
  poseR = 0.38,
  poseRot = 0,
}) {
  const side = Math.ceil(Math.sqrt(shapes)),
    cell = 120 / side;
  let body = '';
  for (let i = 0; i < shapes; i++) {
    const cx = ((i % side) + 0.5) * cell + 4,
      cy = (((i / side) | 0) + 0.5) * cell + 4;
    const r = cell * poseR;
    const stroke = hardSafe
      ? ` stroke="#265b9b" stroke-width="${Math.max(0.05, cell * strokeFrac)}" stroke-linejoin="round"`
      : '';
    body += `<path d="${pathFor(family, cx, cy, r, segments, subtype, poseRot)}" fill="#265b9b"${stroke}/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${body}</svg>`;
}

function syntheticCases() {
  const out = [],
    families = ['line', 'quad', 'cubic', 'arc'];
  const add = (axis, spec) => {
    const coverage = spec.coverage == null ? 0.72 : spec.coverage;
    const name = [
      axis,
      spec.family,
      spec.subtype || '',
      'n' + spec.shapes,
      's' + spec.segments,
      'c' + coverage,
      spec.hardSafe ? 'w' + spec.strokeFrac : '',
    ]
      .filter(Boolean)
      .join('_');
    out.push({ name, axis, coverage, real: false, ...spec, svg: syntheticSvg(spec) });
  };
  // MORPH CASES. A morph is a different regime, not a heavier static draw: the pose changes every
  // frame, so the engine re-derives per-frame state (coefficient uploads, pre-passes, a rebuilt
  // plan) that a static bundle pays once at build. Ranking the two together hides exactly the
  // cost that decides whether an engine can be used for animation at all.
  //
  // The two poses share topology -- same family, same segment count, differing in radius and
  // ring rotation -- because a morph needs its segments to correspond one to one.
  const morphAdd = (spec) => {
    const coverage = spec.coverage == null ? 0.72 : spec.coverage;
    const name = [
      'morph',
      spec.family,
      'n' + spec.shapes,
      's' + spec.segments,
      'c' + coverage,
    ].join('_');
    out.push({
      name,
      axis: 'morph',
      coverage,
      real: false,
      morph: true,
      ...spec,
      svg: syntheticSvg({ ...spec, poseR: 0.4, poseRot: 0 }),
      svgB: syntheticSvg({ ...spec, poseR: 0.26, poseRot: 0.55 }),
    });
  };
  for (const family of families)
    for (const segments of QUICK ? [8] : [8, 32])
      morphAdd({ family, shapes: 1, segments, coverage: 0.72 });

  for (const family of families)
    for (const shapes of QUICK ? [1, 32] : [1, 16, 128])
      add('count', { family, shapes, segments: 16, coverage: 0.72 });
  for (const family of families)
    for (const segments of QUICK ? [4, 32] : [4, 16, 64, 192])
      add('segments', { family, shapes: 1, segments, coverage: 0.72 });
  for (const family of families)
    for (const coverage of QUICK ? [0.12, 0.8] : [0.08, 0.28, 0.58, 0.9])
      add('coverage', { family, shapes: 16, segments: 16, coverage });
  for (const subtype of ['convex', 'serpentine', 'loop', 'cusp'])
    for (const shapes of QUICK ? [1] : [1, 32])
      add('cubic-subtype', { family: 'cubic', subtype, shapes, segments: 1, coverage: 0.72 });
  for (const family of families)
    for (const strokeFrac of QUICK ? [0.08] : [0.02, 0.06, 0.16])
      add('hard-gate', {
        family,
        shapes: 16,
        segments: 16,
        coverage: 0.82,
        hardSafe: true,
        strokeFrac,
      });
  for (const runs of QUICK ? [2, 8] : [1, 2, 4, 8, 12]) {
    let body = '';
    for (let i = 0; i < runs * 2; i++) {
      const dx = Math.sin(i * 1.7) * 8,
        dy = Math.cos(i * 1.3) * 8;
      // Alternate a clean analytic square with the audited concave C-shape from
      // lbHoleParitySmoke's lbConcaveCubicParity case. The latter is a known Slug sentinel because one
      // cubic piece paints air, so this axis measures genuine mixed-route runs.
      const d =
        i & 1
          ? 'M150 50 C80 20 40 60 40 100 C40 140 80 180 150 150 L150 120 C100 145 70 130 70 100 C70 70 100 55 150 80 Z'
          : 'M45 45 L155 45 L155 155 L45 155 Z';
      body += `<path d="${d}" transform="translate(${dx} ${dy})" fill="${i & 1 ? '#9b3151' : '#265b9b'}"/>`;
    }
    out.push({
      name: 'sentinel_runs_' + runs,
      axis: 'sentinel-runs',
      family: 'mixed',
      shapes: runs * 2,
      segments: 2,
      coverage: 0.82,
      real: false,
      occlusionCull: false,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${body}</svg>`,
    });
  }
  // SHAPES THAT ARE NOT CIRCLES.
  //
  // Every family above except `line` builds a polar ring, and a polar ring of exact arcs, kappa
  // cubics or circumscribed quadratics IS a circle — shapeRecognize collapses all three to one
  // six-vertex SDF disc, so those rows rank RECOGNITION and not fill. Measured on a 16-segment
  // ring: lb 6 verts for quad, cubic and arc; 768 for line.
  //
  // These do not collapse. Each stresses something a ring cannot:
  //
  //   star      self-INTERSECTING under even-odd — the fill rule decides the center, and the
  //             self-overlap resolver runs
  //   roundrect straight edges meeting cubic corners — mixed segment types in one contour
  //   counter   a HOLE (a glyph's counter) — both contours are wound the same way, so it is a
  //             hole only under even-odd, which also exercises the rule end to end
  //   comb      thin fingers ~1.5px wide — narrow negative space, where a dilated cover closes gaps
  //   blob      concave serpentine cubics — the case that mis-threads an earcut rim
  const SHAPE_D = {
    star: (r) => {
      let d = '';
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
        d +=
          (i ? ' L' : 'M') +
          (64 + r * Math.cos(a)).toFixed(3) +
          ' ' +
          (64 + r * Math.sin(a)).toFixed(3);
      }
      return d + ' Z';
    },
    roundrect: (r) => {
      const k = r * 0.42,
        x0 = 64 - r,
        x1 = 64 + r,
        y0 = 64 - r,
        y1 = 64 + r;
      return (
        `M${x0 + k} ${y0} L${x1 - k} ${y0} C${x1 - k / 2} ${y0} ${x1} ${y0 + k / 2} ${x1} ${y0 + k}` +
        ` L${x1} ${y1 - k} C${x1} ${y1 - k / 2} ${x1 - k / 2} ${y1} ${x1 - k} ${y1}` +
        ` L${x0 + k} ${y1} C${x0 + k / 2} ${y1} ${x0} ${y1 - k / 2} ${x0} ${y1 - k}` +
        ` L${x0} ${y0 + k} C${x0} ${y0 + k / 2} ${x0 + k / 2} ${y0} ${x0 + k} ${y0} Z`
      );
    },
    counter: (r) => {
      const o = SHAPE_D.roundrect(r),
        i = SHAPE_D.roundrect(r * 0.55);
      return o + ' ' + i;
    },
    comb: (r) => {
      const n = 7,
        w = (2 * r) / (2 * n + 1);
      let d = `M${64 - r} ${64 + r} L${64 - r} ${64 - r}`;
      for (let i = 0; i < n; i++) {
        const x1 = (64 - r + (2 * i + 1) * w).toFixed(3),
          x2 = (64 - r + (2 * i + 2) * w).toFixed(3),
          yb = (64 + r * 0.55).toFixed(3);
        d += ` L${x1} ${64 - r} L${x1} ${yb} L${x2} ${yb} L${x2} ${64 - r}`;
      }
      return d + ` L${64 + r} ${64 - r} L${64 + r} ${64 + r} Z`;
    },
    // Four points at radius r with each side bowed INWARD — concave lobes, and simple: control
    // points at 0.45r near the side's midpoint never cross. The first attempt pulled them to
    // 1.4r, which loops each cubic and self-intersects the contour (1 contour -> 2 cycles), so it
    // was declined rather than drawn and measured nothing.
    blob: (r) => {
      const P = [
        [64 + r, 64],
        [64, 64 + r],
        [64 - r, 64],
        [64, 64 - r],
      ];
      let d = `M${P[0][0]} ${P[0][1]}`;
      for (let i = 0; i < 4; i++) {
        const p = P[i],
          q = P[(i + 1) % 4];
        const mx = (p[0] + q[0]) / 2 - 64,
          my = (p[1] + q[1]) / 2 - 64;
        const L = Math.hypot(mx, my) || 1,
          cx2 = 64 + (mx / L) * r * 0.45,
          cy2 = 64 + (my / L) * r * 0.45;
        d +=
          ` C${(p[0] + (cx2 - p[0]) * 0.8).toFixed(3)} ${(p[1] + (cy2 - p[1]) * 0.8).toFixed(3)}` +
          ` ${(q[0] + (cx2 - q[0]) * 0.8).toFixed(3)} ${(q[1] + (cy2 - q[1]) * 0.8).toFixed(3)}` +
          ` ${q[0]} ${q[1]}`;
      }
      return d + ' Z';
    },
  };
  for (const name of Object.keys(SHAPE_D))
    for (const shapes of QUICK ? [1] : [1, 16]) {
      const side = Math.ceil(Math.sqrt(shapes)),
        cell = 120 / side;
      let body = '';
      for (let i = 0; i < shapes; i++) {
        const cx = ((i % side) + 0.5) * cell + 4,
          cy = (((i / side) | 0) + 0.5) * cell + 4,
          r = cell * 0.38;
        const d = SHAPE_D[name](r).replace(
          /(-?\d+\.?\d*) (-?\d+\.?\d*)/g,
          (m, a, b) => `${(+a - 64 + cx).toFixed(3)} ${(+b - 64 + cy).toFixed(3)}`,
        );
        body += `<path d="${d}" fill="#265b9b" fill-rule="${name === 'star' || name === 'counter' ? 'evenodd' : 'nonzero'}"/>`;
      }
      out.push({
        name: 'shape_' + name + '_n' + shapes,
        axis: 'shape',
        family: name,
        shapes,
        segments: 4,
        coverage: 0.72,
        real: false,
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${body}</svg>`,
      });
    }
  return out;
}

function allSvgFiles(root) {
  const out = [],
    stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && ent.name.toLowerCase().endsWith('.svg')) out.push(p);
    }
  }
  return out;
}

function realCases(limit) {
  if (!REAL) return [];
  const groups = new Map();
  for (const file of allSvgFiles(CORPUS_ROOT)) {
    let size;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size < 80 || size > 600000) continue;
    const rel = path.relative(CORPUS_ROOT, file),
      parts = rel.split(path.sep);
    const group = parts
      .slice(0, Math.min(parts[0] === 'packages' ? 3 : 2, parts.length - 1))
      .join('/');
    let svg;
    try {
      svg = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const curves = (svg.match(/[CQASTLHVcqastlhv](?=[\s,\-+.0-9])/g) || []).length;
    const paths = (svg.match(/<(path|circle|ellipse|rect|polygon|polyline)\b/gi) || []).length;
    const item = { file, rel, svg, score: curves + paths * 3 + Math.log2(size + 1) };
    let g = groups.get(group);
    if (!g) groups.set(group, (g = []));
    g.push(item);
  }
  for (const g of groups.values())
    g.sort((a, b) => a.score - b.score || a.rel.localeCompare(b.rel));
  const keys = [...groups.keys()].sort(),
    picked = [];
  let round = 0;
  while (picked.length < limit && keys.length) {
    let progress = false;
    for (const key of keys) {
      const g = groups.get(key);
      if (!g.length || picked.length >= limit) continue;
      const q = [0, 0.5, 1, 0.25, 0.75][round % 5];
      const idx = Math.min(g.length - 1, Math.round((g.length - 1) * q));
      const [item] = g.splice(idx, 1);
      picked.push(item);
      progress = true;
    }
    if (!progress) break;
    round++;
  }
  return picked.map((x, i) => ({
    name: 'real_' + i + '_' + path.basename(x.file, '.svg').slice(0, 36),
    family: 'real',
    axis: 'real',
    shapes: 0,
    segments: 0,
    coverage: 0.82,
    real: true,
    source: x.rel,
    svg: x.svg,
  }));
}

const ALL_CASES = [...syntheticCases(), ...realCases(REAL_N)].filter(
  (c) => !AXES || AXES.has(c.axis),
);
const CASES = CASE_LIMIT > 0 ? ALL_CASES.slice(0, CASE_LIMIT) : ALL_CASES;
// DRY=1 sizes a run before committing the machine to it. A full sweep drives a real GPU hard
// for a long time, and this one has taken a machine down before; knowing the shape first is
// cheaper than discovering it at minute forty.
if (process.env.DRY === '1') {
  const byAxis = {};
  for (const c of CASES) byAxis[c.axis] = (byAxis[c.axis] || 0) + 1;
  const cells = CASES.length * SIZES.length * DRAWS.length;
  console.log(`\n  profile ${PROFILE}: ${CASES.length} cases  ${JSON.stringify(byAxis)}`);
  console.log(
    `  sizes ${SIZES.join(',')}   draws ${DRAWS.join(',')}   reps ${REPS}   ballast ${BALLAST}`,
  );
  console.log(`  => ${cells} (case,size,draws) cells, each timing every engine arm`);
  console.log(`  real corpus: ${REAL ? CORPUS_ROOT + ' (' + REAL_N + ' assets)' : 'OFF'}\n`);
  process.exit(0);
}
const CONFIG = {
  profile: PROFILE,
  sizes: SIZES,
  draws: DRAWS,
  reps: REPS,
  real: REAL,
  realN: REAL_N,
  disableWorkers: DISABLE_WORKERS,
};

const PAGE = (N) => `<!doctype html><html><head><style>
html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:#232c36}
canvas{position:absolute;inset:0;width:100%;height:100%;display:none}
</style></head><body><div id="root"></div><script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
import { noteExternalGlWrite } from '/src/core/glEpoch.js';
if (${DISABLE_WORKERS}) globalThis.Worker = undefined;
// NOSDF=1 — turn the SDF primitives off so the ranking compares FILL, not RECOGNITION. A circle
// collapses to six vertices in Loop-Blinn (kind-7 disc) and to a full decomposition in every engine
// without a disc primitive, so any family whose shapes are exactly circles ranks recognition
// instead. The arc family is exactly that: its arcs are exact, so each ring IS a circle. Measured
// on a 192-segment ring: lb 6 verts with the primitives on, 1725 with them off, against CPatch's
// 1206 either way — the comparison inverts.
if (${NOSDF ? 'true' : 'false'}) globalThis.__MANTLE_DEBUG__ = globalThis.__MANTLE_NO_SDF_PRIMS = true;
const LB_DEPTH_AB=${JSON.stringify(!!process.env.LB_DEPTH_AB)};
const N=${N}, REPS=${REPS}, DRAWS=${JSON.stringify(DRAWS)}, BALLAST=${BALLAST};
const CLEAR=[.137,.173,.211,1], CLEAR8=[35,44,54,255];
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const SS=${SS};
const CPDEFS=${JSON.stringify(process.env.CPDEFS ? process.env.CPDEFS.split(',') : null)};
const NODEPTH=${JSON.stringify(process.env.NODEPTH === '1')};
const CPOPTS=${JSON.stringify(
  Object.assign(
    {},
    process.env.CPGRID ? { grid: +process.env.CPGRID } : {},
    process.env.CPMAXC ? { maxCurves: +process.env.CPMAXC } : {},
  ),
)};
const SPECS={
  ref:[{},'off'],   // Slug at SSxSS: the coverage reference, never timed
  slug:[{},'off'], aac:[{aacFill:true},'off'], lb:[{},'on'], cpatch:[{cpatchFill:true,cpatchOpts:CPOPTS,...(NODEPTH?{unifiedFillDepthClaim:false}:{}),...(CPDEFS?{fillDefines:CPDEFS}:{})},'on'],
  // A/B the unified draw's depth claim (it clears + tests depth per draw, so it
  // is not free at high resolution / high draw counts).
  lbNoDepth:[{unifiedFillDepthClaim:false},'on'],
  gate:[{aacFill:'auto'},'off'], auto:[{aacFill:'auto'},'auto'],
  // THE THREE NO-AA KERNELS. All are admitted only where the selector proves an opaque stroke
  // covers the fill edge, so they compete with EACH OTHER, not with the antialiasing engines.
  hardBand:[{fillDefines:['MANTLE_HARD','MANTLE_GWN']},'off'],
  hardTree:[{fillDefines:['MANTLE_HARD','MANTLE_GWN','MANTLE_HARD_TREE']},'off'],
  hardCpatch:[{cpatchFill:true,fillDefines:['MANTLE_CPATCH','MANTLE_CPATCH_HARD']},'on'],
};
if(!LB_DEPTH_AB) delete SPECS.lbNoDepth;
const states={};
for(const [name,[opts,mode]] of Object.entries(SPECS)){
  const sz=(name==='ref')?N*SS:N;
  const c=document.createElement('canvas'); c.width=sz; c.height=sz; document.getElementById('root').appendChild(c);
  const gl=c.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true,depth:true,stencil:true});
  if(!gl) throw new Error('WebGL2 unavailable for '+name);
  const r=createRenderer(gl,shaders,{...opts,precompileFillsBudgetMs:5000}); await r.ready; r.setViewport(sz,sz); r.setLoopBlinnFill(mode);
  states[name]={name,c,gl,r,mode,timer:gl.getExtension('EXT_disjoint_timer_query_webgl2'),ballast:makeBallast(gl,N,BALLAST)};
}
function gpuInfo(gl){const d=gl.getExtension('WEBGL_debug_renderer_info');return {vendor:d?gl.getParameter(d.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),renderer:d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),version:gl.getParameter(gl.VERSION),timer:!!gl.getExtension('EXT_disjoint_timer_query_webgl2')};}
const GPU=gpuInfo(states.slug.gl);
const sleep=(ms)=>new Promise(q=>setTimeout(q,ms));
function configure(active){for(const s of Object.values(states)){s.r.setLoopBlinnFill('off');s.c.style.display=s.name===active?'block':'none';}states[active].r.setLoopBlinnFill(states[active].mode);}
// uWorldM operates on normalized clip coordinates, not asset coordinates. A zero-
// translation uniform scale therefore stays centered; sqrt maps requested area
// coverage to the matrix's linear scale.
function drawOpts(b,cov){const s=Math.sqrt(Math.max(0,Math.min(1,cov)));return {worldMatrix:[s,0,0,0,s,0,0,0,1]};}
let _mk=0;
// THE PIXEL CAPTURE MUST BE AT THE SAME POSE FOR EVERY ARM. _mk advances once per frame and is
// shared by all of them, so each engine reached read() at a different t and the accuracy
// comparison was between DIFFERENT POSES -- which reported morph rows as structurally wrong when
// the only thing that differed was where in the animation they were sampled. _fixT pins the pose
// while the reference image is taken; the timed loop still sweeps t, which is the cost that matters.
let _fixT=null;
// A MORPH MOVES. Holding t still measures a static draw wearing a morph's name -- setT returns
// early and none of the per-frame machinery runs -- so t sweeps a real range every frame, which
// is the thing that costs.
function frame(s,b,o,D,morph){
  if(morph){
    if(_fixT!=null){morph.setT(_fixT);}else{_mk=(_mk+1)&1023;morph.setT(0.15+0.7*(_mk/1023));}
    // prepareBundle is what re-derives the pose's per-frame state; a morph that never asks for
    // it draws whatever the last prepare left behind.
    if(s.r.prepareBundle){try{s.r.prepareBundle(b);}catch{}}
  }
  // DRAW THE MORPH, NOT ITS BUNDLE. drawBundle(bundle) on a morph renders a pose without taking
  // the morph route at all -- every engine then reported a static draw under a morph heading,
  // and LB reported "not routed" because it genuinely was not.
  s.r.beginFrame(CLEAR);for(let i=0;i<D;i++)s.r.drawBundle(morph||b,o);s.r.endFrame();
}
function read(gl,n){n=n||N;const p=new Uint8Array(n*n*4);gl.readPixels(0,0,n,n,gl.RGBA,gl.UNSIGNED_BYTE,p);return p;}
function inkPixels(px){let n=0;for(let p=0;p<px.length;p+=4)if(Math.max(Math.abs(px[p]-CLEAR8[0]),Math.abs(px[p+1]-CLEAR8[1]),Math.abs(px[p+2]-CLEAR8[2]),Math.abs(px[p+3]-CLEAR8[3]))>2)n++;return n;}
function median(a){a.sort((x,y)=>x-y);return a[(a.length/2)|0];}
async function waitBackground(b,timeout=60000){const t=performance.now();while(b._occupancyBuildPending||b._occlusionCullPending){if(performance.now()-t>timeout)return false;await sleep(4);}return true;}
function hasRealLb(b){return Array.isArray(b._lbMeshes)&&b._lbMeshes.some(m=>m&&!m.slug&&(m.vertexCount|0)>0);}
function memory(b,s){const seen=new Set();let cpu=0;const add=v=>{if(!v||!ArrayBuffer.isView(v)||seen.has(v.buffer))return;seen.add(v.buffer);cpu+=v.buffer.byteLength;};for(const v of Object.values(b))add(v);for(const m of b._lbMeshes||[])if(m&&m.verts)add(m.verts);return {cpu,gpu:s.r.gpuMemoryEstimate()+(b._lbMemBytes||0),lb:b._lbMemBytes||0};}
async function firstPaint(s,b,o,morph){configure(s.name);const before=hasRealLb(b),c0=s.r.debugStats.loopBlinnRouteCount,t0=performance.now();frame(s,b,o,1,morph);s.gl.finish();return {wall:performance.now()-t0,lbReadyBefore:before,lbRoute:s.r.debugStats.loopBlinnRouteCount-c0,pick:s.r.debugStats.autoEngine||null};}
async function setup(name,sections,cov,sectionsB=null){const s=states[name];configure(name);let morph=null,b;if(sectionsB){morph=createShapeMorph(s.gl,createBundle(s.gl,sections),createBundle(s.gl,sectionsB));b=morph.bundle||morph;}else{b=createBundle(s.gl,sections);}const o=drawOpts(b,cov);
// PREPARE BEFORE THE FIRST DRAW. The CPatch build is gated on _lbGen !== _geomGen, and the first
// DRAW builds LB meshes and stamps _lbGen -- so preparing after it finds the gate already closed
// and CPatch never runs at all (_cpatchConv stayed 'none' on 60 of 76 rows). Same shape of bug as
// the pooled build's: a fallback closing the gate the real engine needed.
if(s.r.prepareBundle){try{s.r.prepareBundle(b);}catch{}}
if(b._cpatchConv==='pending'){for(let i=0;i<600&&b._cpatchConv==='pending';i++)await sleep(5);
  if(s.r.prepareBundle){try{s.r.prepareBundle(b);}catch{}}}
// AND THE MORPH PLAN, which is a different asynchronous build with a different field. Certifying
// a decomposition across a continuum of poses runs off-thread; without waiting, the CPatch arm
// draws morphs through whatever route is ready -- which is LB -- and the timings get filed under
// CPatch. That is how "CPatch is 15x Slug on curve morphs" was measured; it was LB.
if(morph){
  for(let i=0;i<1200&&b._cpatchMorphPlan==='pending';i++)await sleep(5);
  if(s.r.prepareBundle){try{s.r.prepareBundle(b);}catch{}}
  for(let i=0;i<1200&&b._cpatchMorphPlan==='pending';i++)await sleep(5);
}
const first=await firstPaint(s,b,o,morph);s.r.prewarmBundle(b);const tw=performance.now();let lbReady=false;// CPATCH RIDES THE SAME UNIFIED ROUTE and needs the same variant warm. Without this its first
// bundle after a morph batch drew through an unready variant and came back BLANK -- ink 217
// against Slug's 36452, with cpatchBuilt=1 and two unified draws recorded, so every counter said
// the engine had run.
// ONE READINESS CALL PER ENGINE. awaitLbReady covers the static conversion but NOT the morph
// plan, which resolves on a different field (_cpatchMorphPlan) -- so on every morph row the plan
// was still 'pending' when timing began, the draw fell through to LB, and LB's number was filed
// under CPatch. That is the whole reason this run showed CPatch "disqualified across morph" and
// slower than it is. awaitEngine knows all of an engine's builds; ask it, not the LB-shaped one.
if(name==='cpatch'||name==='hardCpatch')lbReady=await s.r.awaitEngine(b,'cpatch',60000);
else if(name==='lb'||name==='auto')lbReady=await s.r.awaitLbReady(b,60000);
await waitBackground(b);
// PREPARE IS WHERE CPATCH IS BUILT. prewarmBundle is not prepareBundle, and this harness only
// ever called the former -- so for static bundles the CPatch build never ran at all and every
// "cpatch" row was the ordinary fill pass under CPatch's name. LB was unaffected because
// awaitLbReady drives its build; CPatch had no equivalent here.
if(s.r.prepareBundle){try{s.r.prepareBundle(b);}catch{}}
// WAIT FOR THE POOLED CPATCH CONVERSION. buildCPatchBundle reports nothing built while its
// contours convert on the worker pool, and the retry only happens on a LATER prepare -- so a
// caller that prepares once and starts timing measures whatever the fill pass picked instead,
// under CPatch's name. This benchmark did exactly that and reported 4 of 4 cases as CPatch
// while CPatch had built zero shapes.
if(b._cpatchConv!==undefined){for(let i=0;i<600&&b._cpatchConv==='pending';i++)await sleep(5);
  if(s.r.prepareBundle){try{s.r.prepareBundle(b);}catch{}}}
s.r.precompileFills();configure(name);for(let i=0;i<10;i++)frame(s,b,o,1,morph);for(let i=0;i<2;i++)frame(s,b,o,DRAWS[DRAWS.length-1],morph);s.gl.finish();const c0=s.r.debugStats.loopBlinnRouteCount,m0=s.r.debugStats.loopBlinnMorphRouteCount|0,u0=s.r.debugStats.unifiedFillDraws|0,w0=s.r.debugStats.unifiedWarmFallbacks|0,eng0=Object.assign({},(s.r.debugStats.engines||{}).draws||{});_fixT=0.5;frame(s,b,o,1,morph);frame(s,b,o,1,morph);s.gl.finish();
// A MORPH'S LB ROUTE IS COUNTED SEPARATELY. Reading only loopBlinnRouteCount reported every
// morph row as "not routed" and dropped LB out of the morph comparison entirely -- an engine
// missing from a table reads as an engine that lost, which is a different claim.
const route=(s.r.debugStats.loopBlinnRouteCount-c0)+((s.r.debugStats.loopBlinnMorphRouteCount|0)-m0),uni=(s.r.debugStats.unifiedFillDraws|0)-u0,px=(()=>{const q=read(s.gl,s.name==='ref'?N*SS:N);_fixT=null;return q;})(),ds=s.r.debugStats,lbm=b._lbMeshes||[];let lbVerts=0,lbChainVerts=0,lbConicVerts=0,lbFull=false;for(const m of lbm){if(!m||m.slug||!m.verts)continue;lbVerts+=m.vertexCount|0;lbFull=lbFull||!!m.hasBezout;for(let v=0;v<(m.vertexCount|0);v++){const p=v*24;if(m.verts[p+5]<0.5&&m.verts[p+2]>1.5){lbChainVerts++;if(m.verts[p+2]>2.5)lbConicVerts++;}}}return {s,b,o,morph,px,ink:inkPixels(px),first,route,uni,cpDrop:b._cpatchDropped|0,kindMask:b._lbKindMask|0,cpCells:b._cpatchCells|0,combined:!!b._lbCombined,cpUnres:b._cpatchUnresolved|0,cpConv:(b._cpatchConv===undefined?'none':(b._cpatchConv==='pending'?'pending':'map')),warmFb:(s.r.debugStats.unifiedWarmFallbacks|0)-w0,cpatchBuilt:b._cpatchBuilt|0,cpMorph:!!(b._cpatchMorphPlan&&b._cpatchMorphPlan!=='pending'),lbReady,lbReal:lbm.filter(m=>m&&!m.slug&&(m.vertexCount|0)>0).length,lbSentinel:lbm.filter(m=>m&&m.slug).length,lbVerts,lbChainVerts,lbConicVerts,lbFull,buildWait:performance.now()-tw,pick:ds.autoEngine||null,px2:ds.autoMeanShapePx2||0,px2seg:ds.lbAutoPx2PerSeg||ds.autoPx2PerSeg||0,bytesPerSeg:ds.lbAutoBytesPerSeg||0,segTypeMask:b.segTypeMask|0,occ:!!b.hasOccupancy,mem:memory(b,s),shapes:b.numShapes|0,segs:b.meanSegsPerShape||0,noAaFill:!!b.noAaFill,noAaTree:!!b.noAaTree,engines:(()=>{const E=s.r.debugStats.engines;if(!E)return null;const d={};for(const k of Object.keys(E.draws||{}))d[k]=(E.draws[k]|0)-((eng0[k]|0));return {last:E.last,draws:d,declines:E.declines};})()};}
// ---- ballast: identical work in every arm, so the GPU's clock state is not part of the result --
// This GPU changes speed with load, and engines differ in weight BY CONSTRUCTION -- that is the
// comparison. Without ballast the heavier arm can finish faster in elapsed time (measured at 22%
// on N=1024), because it drove the clock up. Every arm draws the same ballast every rep, so it
// cancels out of the comparison while pinning the clock where all arms see the same one.
function makeBallast(gl,S,n){
  if(!(n>0))return null;
  const sh=(t,src)=>{const o=gl.createShader(t);gl.shaderSource(o,src);gl.compileShader(o);
    if(!gl.getShaderParameter(o,gl.COMPILE_STATUS))throw new Error('ballast: '+gl.getShaderInfoLog(o));return o;};
  const prog=gl.createProgram();
  gl.attachShader(prog,sh(gl.VERTEX_SHADER,'#version 300 es\\nlayout(location=0) in vec2 a; void main(){ gl_Position=vec4(a,0.0,1.0); }'));
  // Dependent on gl_FragCoord so it cannot be folded to a constant, and enough ALU to be real.
  gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,'#version 300 es\\nprecision highp float; uniform float uK; out vec4 o; void main(){'
    +' float v=uK+gl_FragCoord.x*1e-4+gl_FragCoord.y*1e-4;'
    +' for(int i=0;i<64;i++) v=fract(sin(v*12.9898+float(i))*43758.5453);'
    +' o=vec4(v,v,v,1.0); }'));
  gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog,gl.LINK_STATUS))throw new Error('ballast link: '+gl.getProgramInfoLog(prog));
  const vao=gl.createVertexArray(),vb=gl.createBuffer();
  gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,vb);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  gl.bindVertexArray(null);
  // THE ARRAY_BUFFER BINDING IS NOT VAO STATE and survives unbinding the VAO. Left bound, the
  // renderer's next vertex upload lands in the ballast's buffer -- which is how this drew a thin
  // line around the polygon interior and rendered 12 of 16 cases blank the first time.
  gl.bindBuffer(gl.ARRAY_BUFFER,null);
  const uK=gl.getUniformLocation(prog,'uK');let k=0;
  return ()=>{
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,S,S);
    gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(prog);gl.bindVertexArray(vao);
    for(let i=0;i<n;i++){gl.uniform1f(uK,(k=(k+1)&1023)/1024);gl.drawArrays(gl.TRIANGLES,0,3);}
    gl.bindVertexArray(null);gl.useProgram(null);gl.bindBuffer(gl.ARRAY_BUFFER,null);
    // And tell the renderer its state shadows are stale, or it will keep drawing against the
    // program, VAO and enables it thinks are still bound.
    noteExternalGlWrite();
  };
}
const SYNC_PX=new Uint8Array(4);
// A REAL SYNC POINT. gl.finish() does not sync on this setup -- the wall clock taken after it
// comes out identical to the submit time taken before it. readPixels cannot be deferred, so it
// is the only one of these that measures elapsed frame cost.
function syncPoint(gl){gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,SYNC_PX);}
async function timed(x,D){const {s,b,o,morph}=x,gl=s.gl,ext=s.timer,wall=[],gpu=[],sync=[],cpu=[];configure(s.name);// AMORTISE THE SYNC ROUND TRIP. readPixels is ~1ms on this setup and a frame at these sizes is
// 0.2-0.5ms, so charged once per rep the round trip is most of what gets measured and the
// engines differ inside its noise. Grow the batch until the batch itself is large against it;
// the per-frame number then converges on the frame. This is the difference between a benchmark
// that can rank engines and one that reports its own readPixels cost four times.
let batch=1;for(;batch<256;batch*=2){const tp=performance.now();for(let f=0;f<batch;f++)frame(s,b,o,D,morph);syncPoint(gl);if(performance.now()-tp>=8)break;}for(let k=0;k<REPS;k++){if(s.ballast)s.ballast();let q=null;if(ext){q=gl.createQuery();gl.beginQuery(ext.TIME_ELAPSED_EXT,q);}const t=performance.now();for(let f=0;f<batch;f++)frame(s,b,o,D,morph);const cpuMs=(performance.now()-t)/batch;if(ext)gl.endQuery(ext.TIME_ELAPSED_EXT);gl.finish();const wallMs=(performance.now()-t)/batch;syncPoint(gl);const syncMs=(performance.now()-t)/batch;if(q){for(let p=0;p<1000&&!gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE);p++)await sleep(0);const ns=gl.getQueryParameter(q,gl.QUERY_RESULT);if(!gl.getParameter(ext.GPU_DISJOINT_EXT))gpu.push(ns/1e6/batch);gl.deleteQuery(q);}cpu.push(cpuMs);wall.push(wallMs);sync.push(syncMs);}const srt=(a)=>a.slice().sort((p,q)=>p-q);const S2=srt(sync);return {sync:median(sync),cpu:median(cpu),wall:median(wall),gpu:gpu.length?median(gpu):null,p10:S2[Math.floor(S2.length*.1)],p90:S2[Math.min(S2.length-1,Math.floor(S2.length*.9))],batch};}
function edgeMask(ref){const m=new Uint8Array(N*N),out=new Uint8Array(N*N);const delta=(a,b)=>Math.max(Math.abs(ref[a]-ref[b]),Math.abs(ref[a+1]-ref[b+1]),Math.abs(ref[a+2]-ref[b+2]),Math.abs(ref[a+3]-ref[b+3]));for(let y=0;y<N;y++)for(let x=0;x<N;x++){const i=y*N+x,p=i*4;if(x+1<N&&delta(p,p+4)>6)m[i]=1;if(y+1<N&&delta(p,p+N*4)>6)m[i]=1;}for(let y=0;y<N;y++)for(let x=0;x<N;x++)if(m[y*N+x])for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const xx=x+dx,yy=y+dy;if(xx>=0&&yy>=0&&xx<N&&yy<N)out[yy*N+xx]=1;}return out;}
// ---- COVERAGE-EXACT ACCURACY -------------------------------------------------------------
// The colour metric (acc.structural) guesses at the antialiasing band: mark Slug's colour steps,
// dilate 2px, and call anything outside it with a >24/255 difference "structural". Both numbers
// are arbitrary, and the dilation can make a genuinely correct engine show a 1-pixel failure.
//
// This asks the question properly. The reference is rendered SUPERSAMPLED and box-downsampled,
// which yields each pixel's true COVERAGE rather than its colour, and coverage classifies the
// pixel with no threshold at all:
//
//   cov == 0   exterior  -- any ink here is a WRONG PIXEL
//   cov == 1   interior  -- any missing ink here is a WRONG PIXEL
//   0 < cov < 1  edge    -- the only place an engine is allowed to differ, and the difference
//                          is an AA error measured against the true coverage
//
// WRONG PIXELS MUST BE ZERO. They are the engine painting a different shape. AA error is a
// quality number and never disqualifies.
//
// Coverage of a rendered pixel is recovered by projecting it onto the clear->fill axis, which is
// exact for the single-colour synthetic corpus. Real multi-colour assets keep the colour metric.
function coverageOf(px, i, fill) {
  const dx = px[i] - CLEAR8[0], dy = px[i + 1] - CLEAR8[1], dz = px[i + 2] - CLEAR8[2];
  const fx = fill[0] - CLEAR8[0], fy = fill[1] - CLEAR8[1], fz = fill[2] - CLEAR8[2];
  const d2 = fx * fx + fy * fy + fz * fz;
  return d2 > 0 ? Math.max(0, Math.min(1, (dx * fx + dy * fy + dz * fz) / d2)) : 0;
}
/// Box-downsample a SS x SS supersampled render to per-pixel coverage in [0,1].
function refCoverage(px, n, ss, fill) {
  const cov = new Float32Array(n * n), w = n * ss;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++)
      a += coverageOf(px, ((y * ss + sy) * w + (x * ss + sx)) * 4, fill);
    cov[y * n + x] = a / (ss * ss);
  }
  return cov;
}
/// Engine render vs true coverage. tol is the coverage slack allowed on a solid pixel before
/// it counts as wrong -- one 255th, i.e. the smallest difference the framebuffer can represent.
function accuracyCov(cov, got, n, fill) {
  let wrong = 0, soft = 0, aaSum = 0, aaN = 0, aaMax = 0, worstX = -1, worstY = -1;
  // A WHOLE WRONG PIXEL, literally: the reference says this pixel is entirely covered and the
  // engine has it more off than on, or the reference says entirely empty and the engine has it
  // more on than off. That is a different SHAPE and nothing else -- half a pixel of slack is far
  // outside any rounding, and the reference's own 1x render scores 0 by it.
  //
  // soft counts the smaller disagreements on those same solid/empty pixels. They are not shape
  // errors (a solid pixel at 0.99 is rounding) but they are not antialiasing either, so they are
  // reported rather than folded into the AA number.
  for (let i = 0; i < n * n; i++) {
    const c = cov[i], g = coverageOf(got, i * 4, fill);
    if (c <= 0) {
      if (g > 0.5) { wrong++; if (worstX < 0) { worstX = i % n; worstY = (i / n) | 0; } }
      else if (g > 1.5 / 255) soft++;
    } else if (c >= 1) {
      if (g < 0.5) { wrong++; if (worstX < 0) { worstX = i % n; worstY = (i / n) | 0; } }
      else if (g < 1 - 1.5 / 255) soft++;
    } else { const d = Math.abs(g - c); aaSum += d; aaN++; if (d > aaMax) aaMax = d; }
  }
  return { wrong, soft, aaMean: aaN ? aaSum / aaN : 0, aaMax, aaN, worst: [worstX, worstY] };
}

function accuracy(ref,got,edge){let structural=0,edgeSum=0,edgeN=0,edgeMax=0,diff=0;for(let i=0;i<N*N;i++){const p=i*4,d=Math.max(Math.abs(ref[p]-got[p]),Math.abs(ref[p+1]-got[p+1]),Math.abs(ref[p+2]-got[p+2]),Math.abs(ref[p+3]-got[p+3]));if(d>0)diff++;if(edge[i]){edgeSum+=d;edgeN++;if(d>edgeMax)edgeMax=d;}else if(d>24)structural++;}return {structural,edgeMean:edgeN?edgeSum/edgeN:0,edgeMax,diff};}
window.__bench=async(svg,meta,index)=>{let sections,sectionsB=null;try{sections=await importSvg(svg,{occupancyGrid:true,gwnTree:true,occlusionCull:meta.occlusionCull!==false});if(meta.svgB)sectionsB=await importSvg(meta.svgB,{occupancyGrid:true,gwnTree:true,occlusionCull:meta.occlusionCull!==false});}catch(e){return {err:'import: '+e.message};}const built={};built.ref=await setup('ref',sections,meta.coverage,sectionsB);for(const name of ['slug','aac','cpatch'])built[name]=await setup(name,sections,meta.coverage,sectionsB);built.lb=await setup('lb',sections,meta.coverage,sectionsB);
if(LB_DEPTH_AB)built.lbNoDepth=await setup('lbNoDepth',sections,meta.coverage);built.gate=await setup('gate',sections,meta.coverage,sectionsB);const hardPick=(built.gate.pick==='hard-tree')?'hardTree':(built.gate.pick==='hard-band')?'hardBand':null;
if(hardPick){for(const hn of ['hardBand','hardTree','hardCpatch'])built[hn]=await setup(hn,sections,meta.coverage,sectionsB);built.hard=built[hardPick];}built.auto=await setup('auto',sections,meta.coverage,sectionsB);if(!meta.real&&built.slug.ink===0){for(const x of Object.values(built))x.b.dispose();return {err:'blank synthetic render'};}const order=['slug','aac','cpatch','lb',...(built.lbNoDepth?['lbNoDepth']:[]),...(built.hardBand?['hardBand','hardTree','hardCpatch']:[]),'gate','auto'];const rot=index%order.length,run=order.slice(rot).concat(order.slice(0,rot));for(const name of run){built[name].ms={};for(const D of DRAWS)built[name].ms[D]=await timed(built[name],D);}const edge=edgeMask(built.slug.px),out={gpu:GPU,hardPick};
// TRUE COVERAGE from the supersampled reference. Only for the single-colour synthetic corpus --
// projecting a pixel onto the clear->fill axis is exact there and meaningless for multi-colour
// real art, which keeps the older edge-band metric.
const FILL8=[38,91,155];
const covRef = meta.real ? null : refCoverage(built.ref.px, N, SS, FILL8);for(const [name,x] of Object.entries(built)){out[name]={ink:x.ink,first:x.first,route:x.route,uni:x.uni,cpDrop:x.cpDrop|0,kindMask:x.kindMask|0,cpCells:x.cpCells|0,combined:x.combined,cpUnres:x.cpUnres|0,cpConv:x.cpConv,warmFb:x.warmFb|0,cpatchBuilt:x.cpatchBuilt|0,cpMorph:!!x.cpMorph,lbReady:x.lbReady,lbReal:x.lbReal,lbSentinel:x.lbSentinel,lbVerts:x.lbVerts,lbChainVerts:x.lbChainVerts,lbConicVerts:x.lbConicVerts,lbFull:x.lbFull,buildWait:x.buildWait,pick:x.pick,px2:x.px2,px2seg:x.px2seg,bytesPerSeg:x.bytesPerSeg,segTypeMask:x.segTypeMask,occ:x.occ,mem:x.mem,shapes:x.shapes,segs:x.segs,noAaFill:x.noAaFill,noAaTree:x.noAaTree,ms:x.ms,engines:x.engines,acc:accuracy(built.slug.px,x.px,edge),cov:(covRef&&name!=='ref')?accuracyCov(covRef,x.px,N,FILL8):null};x.b.dispose();}return out;};window.__ready=true;window.__gpu=GPU;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/') {
      const n = +(new URL(req.url, 'http://x').searchParams.get('N') || 512);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE(n));
      return;
    }
    const file = path.resolve(ROOT, '.' + u);
    if (!file.startsWith(ROOT + path.sep)) throw new Error('bad path');
    res.writeHead(200, { 'content-type': u.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(file));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const windowN = Math.max(...SIZES);
// HEADLESS EVEN ON THE GPU. Headless Chrome reaches the real GPU: ANGLE (Apple, ANGLE Metal
// Renderer) reports and TIMES the same headless or headful.
// A window is not free to the person running this: macOS CLAMPS --window-position (measured:
// screenX/Y 83,65 whatever you pass), so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const launchBrowser = () =>
  launchIsolatedChrome(
    process.env.GPU === '1'
      ? {
          headless: 'new',
          protocolTimeout: 900000,
          defaultViewport: { width: windowN, height: windowN, deviceScaleFactor: 1 },
          args: [
            '--no-sandbox',
            '--use-angle=metal',
            '--use-gl=angle',
            '--enable-gpu',
            `--window-size=${windowN + 32},${windowN + 120}`,
          ],
        }
      : {
          headless: 'new',
          protocolTimeout: 900000,
          args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
        },
  );
let browser = await launchBrowser();

async function freshPage(N) {
  const page = await browser.newPage();
  // KEEP the page's own error, do not just log it. When the page fails to initialize, the only
  // symptom otherwise is waitForFunction timing out 120s later with a stack that points at this
  // function and says nothing about the cause -- while the real message (a syntax error in the
  // page, say) scrolled past as one line of [page] output. A backtick pasted into the page
  // template does exactly this, and has three times in this file's history.
  let pageErr = null;
  page.on('pageerror', (e) => {
    if (!pageErr) pageErr = e.message;
    console.error('[page]', e.message);
  });
  await page.setViewport({ width: N, height: N, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:' + port + '/?N=' + N, { waitUntil: 'load', timeout: 120000 });
  try {
    await page.waitForFunction('window.__ready===true', { timeout: 120000 });
  } catch (e) {
    throw new Error(
      'the benchmark page never became ready' +
        (pageErr
          ? ' — the page reported: ' + pageErr
          : ' — and reported no error, so suspect a hang') +
        '. NOTE: ' +
        OUT +
        ' has NOT been updated and still holds the previous run.',
    );
  }
  return page;
}

// A RUN THAT DIES MUST NOT LEAVE THE LAST RUN'S ANSWERS LYING AROUND. The output is rewritten
// after every case, so a crash mid-run leaves a file that looks finished -- and a crash BEFORE
// the first case leaves the PREVIOUS run's file untouched, config and all. Reading that back is
// indistinguishable from a successful run unless you notice the config no longer matches the
// flags you passed; a page-side syntax error is enough to do it.
//
// So the file is stamped incomplete up front and only marked complete when the loop finishes.
writeFileSync(OUT, JSON.stringify({ complete: false, config: CONFIG, gpu: null, rows: [] }));
const rows = [];
let gpu = null,
  index = 0;
for (const N of SIZES) {
  let page = await freshPage(N);
  gpu = await page.evaluate(() => window.__gpu);
  if (process.env.GPU === '1' && /swiftshader|llvmpipe|software/i.test(gpu.renderer || ''))
    throw new Error('GPU=1 requested but browser reports ' + gpu.renderer);
  for (const c of CASES) {
    if (c.real && N !== SIZES[SIZES.length - 1] && N !== SIZES[Math.max(0, SIZES.length - 2)])
      continue;
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await page.evaluate(
          (svg, meta, i) => window.__bench(svg, meta, i),
          c.svg,
          c,
          index,
        );
        break;
      } catch (e) {
        result = { err: 'page: ' + e.message };
        try {
          await page.close();
        } catch {}
        const connected =
          typeof browser.isConnected === 'function' ? browser.isConnected() : browser.connected;
        if (!connected) browser = await launchBrowser();
        page = await freshPage(N);
      }
    }
    rows.push({ ...c, svg: undefined, N, result });
    index++;
    writeFileSync(OUT, JSON.stringify({ complete: false, config: CONFIG, gpu, rows }));
    process.stderr.write(result && result.err ? 'x' : '.');
  }
  process.stderr.write(' N=' + N + '\n');
  try {
    await page.close();
  } catch {}
}
try {
  await browser.close();
} catch {}
server.close();

writeFileSync(OUT, JSON.stringify({ complete: true, config: CONFIG, gpu, rows }));
const PRIMARY_DRAWS = DRAWS[DRAWS.length - 1],
  validRows = rows.filter((r) => r.result && !r.result.err);
// SCORE ON THE SYNC CLOCK. It is the only one here that measures elapsed frame cost: the
// TIME_ELAPSED timer over-reports by 2.5-3.8x on any arm that runs a render-target pass (and
// engines differ in exactly that), and `wall` is submit time wearing a frame-cost label because
// gl.finish() does not sync here. gpu/cpu/wall are still recorded, as evidence and as the way
// those two claims stay checkable.
const score = (x) =>
  x.ms[PRIMARY_DRAWS].sync ?? x.ms[PRIMARY_DRAWS].gpu ?? x.ms[PRIMARY_DRAWS].wall;
// GENERAL-PURPOSE ENGINES only. `hard` is NOT one of them: it is the no-AA kernel, admitted
// only where the shipping selector proves an opaque stroke covers the fill edge, so ranking it
// against engines that are always available answers a question nobody can act on. It gets its
// own section, scored only against the rows it is actually allowed on.
const GENERAL = ['slug', 'aac', 'lb', 'cpatch'];
// AN ARM only COUNTS IF ITS own ENGINE DREW IT. When LB cannot serve a bundle it returns false
// and the ordinary fill pass picks an engine -- so the frame is timed, looks plausible, and is
// Slug or AAC wearing LB's name. Same for CPatch: cpatchFill:true is a request, not a guarantee.
// Every one of these is a route fact, not a heuristic, so a row that fails them is dropped rather
// than quietly averaged in.
const usable = (row, name) => {
  const x = row.result[name];
  if (!x) return null;
  // WRONG PIXELS DISQUALIFY. Where the supersampled reference says a pixel is solid or empty,
  // an engine that disagrees painted a different shape. Where it says the pixel is partial, the
  // engine may differ and that is antialiasing, not error. Real multi-color assets have no
  // coverage reference and fall back to the older edge-band structural count.
  if (x.cov ? x.cov.wrong : x.acc.structural) return null;
  if (!row.real && !x.ink) return null;
  // DID this ENGINE PAINT? One rule, every engine. A per-engine proxy -- a route counter, a build
  // flag that differs between the static and morph regimes, a warm-fallback count -- answers a
  // DIFFERENT question from "did it draw". A build flag says an engine was prepared; it drew only
  // if the draw site says so. Getting that wrong is not a reporting slip, it files one engine's
  // numbers under another (another engine's morph timings, or Slug's antialiasing when a variant
  // fails to compile, filed under the requested engine).
  //
  // renderer.debugStats.engines is written where geometry is submitted (see engineLedger.js), so
  // it is the only thing here that cannot be fooled by a fallback.
  const drew = x.engines && x.engines.draws ? x.engines.draws[name] | 0 : null;
  if (drew !== null) return drew > 0 ? x : null;
  // Result files without engine ledger data fall back to the proxies; keep them readable rather than silently empty.
  if (name === 'lb' && !(x.lbReady && x.route)) return null;
  if (x.warmFb | 0) return null;
  if (name === 'cpatch' && !row.morph && !(x.cpatchBuilt | 0)) return null;
  if (name === 'cpatch' && row.morph && !x.cpMorph) return null;
  return x;
};
const winnerOf = (row) => {
  const cand = [];
  for (const name of GENERAL) {
    const x = usable(row, name);
    if (x) cand.push([name, score(x)]);
  }
  cand.sort((a, b) => a[1] - b[1]);
  return cand;
};
const tally = new Map(),
  misses = [],
  lbBins = new Map(),
  aacBins = new Map();
const bins = [0, 50, 100, 150, 300, 600, 1200, Infinity];
const binOf = (v) => {
  for (let i = 1; i < bins.length; i++)
    if (v < bins[i]) return bins[i - 1] + '-' + (bins[i] === Infinity ? 'inf' : bins[i]);
  return 'inf';
};
for (const row of validRows) {
  const cand = winnerOf(row);
  if (!cand.length) continue;
  const win = cand[0][0],
    key = row.real ? 'real' : row.family;
  const t = tally.get(key) || {};
  t[win] = (t[win] || 0) + 1;
  tally.set(key, t);
  const lbk = binOf(row.result.auto.px2seg || 0),
    lbt = lbBins.get(lbk) || {};
  lbt[win] = (lbt[win] || 0) + 1;
  lbBins.set(lbk, lbt);
  const ack = row.family + ':' + binOf(row.result.gate.px2 || 0),
    act = aacBins.get(ack) || {};
  act[win] = (act[win] || 0) + 1;
  aacBins.set(ack, act);
  const auto = row.result.auto,
    autoPick = auto.lbReady && auto.route ? 'lb' : auto.pick;
  if (auto.acc.structural || (autoPick !== win && score(auto) > cand[0][1] * 1.15))
    misses.push({
      case: row.name,
      N: row.N,
      win,
      winMs: cand[0][1],
      auto: autoPick,
      autoMs: score(auto),
      structural: auto.acc.structural,
    });
}
const table = (m) =>
  [...m]
    .map(
      ([k, v]) =>
        '| ' +
        k +
        ' | ' +
        Object.entries(v)
          .sort((a, b) => b[1] - a[1])
          .map(([e, n]) => e + ':' + n)
          .join(' ') +
        ' |',
    )
    .join('\n');

// ---- ACTUAL TIMINGS, BY SIZE. A win count says an engine was ahead and hides both by how much
// and whether that survives a change of resolution -- and these engines are separated by
// resolution more than by anything else, because they trade per-draw fixed cost against
// per-fragment cost. The tables below are medians of the sync clock in MILLISECONDS PER FRAME,
// one row per engine, one column per size, so the crossover is visible rather than inferred.
const med2 = (a) => {
  a = a.filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : null;
};
const cell = (v) => (v == null ? '  —  ' : v.toFixed(4));
// `regime` splits the corpus into the groups worth reading separately.
const regimeOf = (r) => (r.real ? 'real assets' : r.family);
function timingTable(rowsIn, engines, drawsN) {
  const regimes = [...new Set(rowsIn.map(regimeOf))].sort();
  const out = [];
  for (const rg of regimes) {
    const mine = rowsIn.filter((r) => regimeOf(r) === rg);
    const sizes = [...new Set(mine.map((r) => r.N))].sort((a, b) => a - b);
    out.push(
      '',
      '### ' + rg + '  (' + mine.length + ' rows)',
      '',
      '| engine | ' + sizes.map((n) => n + 'px').join(' | ') + ' | notes |',
      '|---|' + sizes.map(() => '---:').join('|') + '|---|',
    );
    for (const e of engines) {
      const cells = sizes.map((n) => {
        const v = mine
          .filter((r) => r.N === n)
          .map((r) => {
            const x = usable(r, e);
            return x ? score(x) : null;
          });
        return cell(med2(v));
      });
      // Why an engine is absent from a size is as informative as its number.
      const all = mine.map((r) => r.result[e]).filter(Boolean);
      const notes = [];
      {
        const w = all.filter((x) => (x.cov ? x.cov.wrong : x.acc && x.acc.structural)).length;
        if (w) notes.push(w + ' wrong-pixel');
      }
      if (e === 'lb') {
        const nr = all.filter((x) => !(x.lbReady && x.route)).length;
        if (nr) notes.push(nr + ' not routed');
      }
      // A ROW THAT IS really A RECOGNIZED PRIMITIVE SAYS SO. A circle, ellipse or annulus collapses
      // to one six-vertex SDF disc, so the row is ranking RECOGNITION, not this engine's fill, and
      // an engine without a primitive is doing the whole job in the row beside it. Three of the
      // four synthetic families are circles (quad, cubic and arc all build polar rings of exact
      // arcs, kappa cubics or circumscribed quadratics), so this is most of the table.
      {
        const nsdf = all.filter(
          (x) => x.engines && x.engines.draws && (x.engines.draws.sdf | 0) > 0,
        ).length;
        if (nsdf) notes.push(nsdf + ' via SDF primitive — recognition, not fill');
      }
      {
        const w = all.filter((x) => x.warmFb | 0).length;
        if (w) notes.push(w + ' warm-fallback');
      }
      if (e === 'cpatch') {
        const nb = rowsIn.filter(
          (r) => !r.morph && r.result[e] && !(r.result[e].cpatchBuilt | 0),
        ).length;
        const nm = rowsIn.filter((r) => r.morph && r.result[e] && !r.result[e].cpMorph).length;
        if (nb) notes.push(nb + ' no cpatch shapes');
        if (nm) notes.push(nm + ' no cpatch morph plan');
      }
      if (!all.length) notes.push('not built');
      out.push('| ' + e + ' | ' + cells.join(' | ') + ' | ' + (notes.join(', ') || '') + ' |');
    }
    // The ratio that actually decides a gate: how each engine compares to the best at each size.
    const best = sizes.map((n) =>
      med2(
        engines
          .map((e) => {
            const v = mine
              .filter((r) => r.N === n)
              .map((r) => {
                const x = usable(r, e);
                return x ? score(x) : null;
              })
              .filter(Number.isFinite);
            return v.length ? med2(v) : null;
          })
          .filter(Number.isFinite)
          .sort((a, b) => a - b)
          .slice(0, 1),
      ),
    );
    out.push(
      '| **best** | ' + best.map(cell).join(' | ') + ' | ms/frame at ' + drawsN + ' draws |',
    );
  }
  return out.join('\n');
}
const staticRows = validRows.filter((r) => !r.morph);
// STATIC AND MORPH ARE DIFFERENT REGIMES, not one corpus with heavier members. A static bundle
// pays its per-pose work once at build; a morph re-derives it every frame -- coefficient
// uploads, pre-passes, in some engines a re-planned decomposition. An engine can be the right
// choice for one and unusable for the other, and averaging them together hides precisely that.
const morphRows = validRows.filter((r) => r.morph);
const HARDS = ['hardBand', 'hardTree', 'hardCpatch'];
const hardRows = staticRows.filter((r) => r.result.hardBand);
const hardWins = hardRows.filter((r) => winnerOf(r)[0] && winnerOf(r)[0][0] === 'hard').length;
const med = (a) => {
  a = a.filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : 0;
};
const routeRows = ['slug', 'aac', 'cpatch', 'lb', 'gate', 'auto']
  .map((name) => {
    const x = validRows.map((r) => r.result[name]).filter(Boolean);
    const sum = (f) => x.reduce((a, v) => a + (f(v) | 0), 0);
    return `| ${name} | ${x.length} | ${sum((v) => v.uni)} | ${sum((v) => v.route)} |`;
  })
  .join('\n');
const memRows = ['slug', 'aac', 'cpatch', 'lb', 'gate', 'auto']
  .map((name) => {
    const x = validRows.map((r) => r.result[name]).filter(Boolean);
    return `| ${name} | ${Math.round(med(x.map((v) => v.mem.cpu)))} | ${Math.max(0, ...x.map((v) => v.mem.cpu))} | ${Math.round(med(x.map((v) => v.mem.gpu)))} | ${Math.max(0, ...x.map((v) => v.mem.gpu))} | ${Math.max(0, ...x.map((v) => v.mem.lb))} | ${fmt(med(x.map((v) => v.first.wall)))} |`;
  })
  .join('\n');
const covAgg = new Map();
for (const row of validRows)
  for (const [name, x] of Object.entries(row.result)) {
    if (!x || !x.cov || name === 'ref') continue;
    const a = covAgg.get(name) || { rows: 0, wr: 0, wpx: 0, soft: 0, aa: 0, aaMax: 0 };
    a.rows++;
    if (x.cov.wrong) {
      a.wr++;
      a.wpx += x.cov.wrong;
    }
    a.soft += x.cov.soft | 0;
    a.aa += x.cov.aaMean;
    if (x.cov.aaMax > a.aaMax) a.aaMax = x.cov.aaMax;
    covAgg.set(name, a);
  }
const covRows = [...covAgg]
  .map(
    ([n, a]) =>
      `| ${n} | ${a.rows} | ${a.wr} | **${a.wpx}** | ${a.soft} | ${(a.aa / a.rows).toFixed(4)} | ${a.aaMax.toFixed(3)} |`,
  )
  .join('\n');
const realAssets = new Set(validRows.filter((r) => r.real).map((r) => r.source)).size;
const md = `# Mantle fill-engine balance (${new Date().toISOString()})

- GPU: ${gpu.vendor} / ${gpu.renderer}
- WebGL: ${gpu.version}; timer query: ${gpu.timer}
- SDF primitives: ${NOSDF ? 'DISABLED (NOSDF=1) — circles/ellipses/annuli decompose in every engine' : 'enabled (default)'}\n- Profile: ${PROFILE}; sizes: ${SIZES.join(', ')}; draws/frame: ${DRAWS.join(', ')}; samples: ${REPS}; ballast: ${BALLAST}
- Cases: ${validRows.length} completed, ${rows.length - validRows.length} failed; unique external assets: ${realAssets}
- Primary ranking: median SYNC time at ${PRIMARY_DRAWS} draws/frame — a batch terminated by gl.readPixels, which is the only clock here that measures elapsed frame cost. cpu/wall/gpu medians are retained beside it: wall ends in gl.finish() and comes back equal to cpu on this setup, which is the standing evidence that finish() does not sync; the GPU timer over-reports 2.5–3.8x on any arm running a render-target pass.
- Ballast: ${BALLAST} full-screen ALU passes per arm per sample, to pin the GPU clock so a heavier arm cannot finish faster by driving it up. ${BALLAST ? 'Verified not to change what is drawn (per-case ink identical to a BALLAST=0 run).' : 'DISABLED — this run is subject to the load-dependent clock.'}
- Accuracy — what STRUCTURAL means. Slug is the reference. Every pixel where Slug's image has a colour step over 6 between neighbours is marked, and that mask is dilated 2px: that is the antialiasing band, where engines are ALLOWED to differ (reported as edgeMean/edgeMax). Outside it, a pixel differing from Slug by more than 24/255 in any channel is STRUCTURAL — the engine painted a different shape, not different antialiasing — and disqualifies the engine for that row, which is why a disqualified engine shows a dash rather than a fast time. A single-pixel structural count is usually the 2px dilation being one pixel too narrow rather than a defect.

## STATIC — ms per frame, by size

General-purpose engines only. Every one of these is available for any shape, so they can be
read against each other. Medians of the sync clock at ${PRIMARY_DRAWS} draws/frame; a dash means
the engine produced nothing usable at that size (see notes).
${staticRows.length ? timingTable(staticRows, GENERAL, PRIMARY_DRAWS) : '\nNo static rows in this run.\n'}

## MORPH — ms per frame, by size

The same engines drawing a pose that MOVES every frame. This is the regime a static number
cannot stand in for: t advances each frame, so whatever an engine re-derives per pose it pays
here and not above. ${morphRows.length} rows.
${morphRows.length ? timingTable(morphRows, GENERAL, PRIMARY_DRAWS) : '\nNo morph rows in this run (AXIS=morph, or a profile that includes it).\n'}

## HARD — the no-AA kernel, scored only where it is allowed

These are NOT alternatives to the engines above and are not ranked with them. The shipping
selector admits a no-AA kernel only where an opaque stroke is proven to cover the fill edge;
outside that such a kernel is not merely slower, it is the wrong picture. It admitted
${hardRows.length} of ${staticRows.length} static rows.

All THREE no-AA kernels are measured on those rows, because the question there is which of them is
cheapest, not whether no-AA beats antialiasing: **hardBand** (GWN crossing-count), **hardTree**
(GWN with the tree accelerator) and **hardCpatch** (CPatch thresholded). (Loop-Blinn thresholded
was a fourth, and lost to hardBand at both sizes it was timed at.) The general engines are repeated underneath for scale.
${hardRows.length ? timingTable(hardRows, [...HARDS, ...GENERAL], PRIMARY_DRAWS) : '\nNo row met the gate in this run, so there is nothing to compare.\n'}

## ACCURACY — whole wrong pixels vs antialiasing error

The reference is the same content rendered SUPERSAMPLED (${SS}x${SS}) and box-downsampled, which
gives each pixel its true COVERAGE rather than a colour. That classifies every pixel with no
threshold: coverage 0 is exterior, 1 is interior, anything between is an edge pixel.

- **WRONG** — the reference says the pixel is entirely covered and the engine has it more off
  than on, or entirely empty and the engine has it more on than off. A different SHAPE. Must be
  zero; a non-zero count disqualifies the engine for that row, which is why it shows a dash in
  the timing tables above rather than a fast number.
- **soft** — the same solid/empty pixels differing by LESS than half. Not a shape error and not
  antialiasing either (a solid pixel at 0.99 is rounding), so it is reported separately.
- **AA err** — mean and max coverage error on edge pixels only. This is where an engine is
  ALLOWED to differ, and it never disqualifies.

| engine | rows | rows with wrong px | WRONG px | soft px | mean AA err | max AA err |
|---|---:|---:|---:|---:|---:|---:|
${covRows}

## Winner counts (secondary)

Counts, for orientation only — they say who was ahead and not by how much, and the tables above
are what a gate should be set from.

| Regime | Accuracy-gated fastest |
|---|---|
${table(tally)}

| px2/segment (LB bins) | Winners |
|---|---|
${table(lbBins)}

| Family: mean shape px2 (AAC bins) | Winners |
|---|---|
${table(aacBins)}

## Memory and first paint

Bytes are per measured bundle. GPU estimates include renderer-owned resources; LB is the bundle's analytic mesh bytes. First paint is completion-wall time before worker/prewarm readiness.

| Engine | median CPU | max CPU | median GPU | max GPU | max LB | median first ms |
|---|---:|---:|---:|---:|---:|---:|
${memRows}

## Route check

Which route actually produced the LB rows. loopBlinnRouteCount is bumped by EVERY
LB route, so it cannot tell them apart; unifiedFillDraws is bumped at the unified
drawArrays itself and can. If this reads 0 for lb, the timings below are the
classic per-shape / coverage-RT route and say nothing about the unified one.

| Engine | cases | unifiedFillDraws | loopBlinnRouteCount |
|---|---:|---:|---:|
${routeRows}

## Shipping gate misses (>15% or structural)

${
  misses.length
    ? misses
        .slice(0, 80)
        .map(
          (m) =>
            `- ${m.case}@${m.N}: auto=${m.auto} ${fmt(m.autoMs)} ms, best=${m.win} ${fmt(m.winMs)} ms, structural=${m.structural}`,
        )
        .join('\n')
    : 'None.'
}

Raw per-case accuracy, CPU/GPU memory, first-paint route, worker wait, wall timing, and GPU timing: ${path.basename(OUT)}
`;
writeFileSync(REPORT, md);
console.log(md);
console.log('Wrote ' + OUT + ' and ' + REPORT);
