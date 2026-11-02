// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cornerFrameProof — the curve band's corner-combine frame. Intersecting the band's own plane (window frame, from the vTC
// derivatives) with the neighbour's EM-space plane combines a y-mirrored pair, and under a world matrix a rotated one;
// the kernel maps the em planes (the neighbour's, and a wedge's osculating line) into the window frame through
// dFdx/dFdy(vEm).
//
// Two generated fragment texts (before = em-space planes, after = window-frame planes) through the whole-LB-pipeline
// emulator (test/_lbPipeEmu.mjs, FINE derivatives, as ANGLE on Metal takes them), on one scene: every fragment compared
// bit for bit, by kind and by whether it ran the wedge or a corner combine (the only places the frame matters); then, at every pixel where a fragment moved, the
// shape's composited coverage before and after against the exact box coverage of the shape (_lbAaRef, 64 slices) --
// under a world matrix, of the shape mapped into the pixel frame, so the pixel box is the device pixel's.
//
//   node probes/lbAccuracy/_cornerFrameProof.mjs before.frag after.frag [svg]     CANVAS=512 WORLD=rot  (logs: probes/_lbPipeOut)
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { lbScene, renderScene } from '../../test/_lbPipeScene.mjs';
import { refKit, exactCov } from './_lbAaRef.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [FA, FB] = process.argv.slice(2);
const FILE = process.argv[4] || path.join(ROOT, 'examples/tiger.svg');
const N = +(process.env.CANVAS || 512);
const ROT = process.env.WORLD === 'rot';
const t0 = Date.now();
const lap = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)} s] ${m}`);
console.warn = () => {};
// A conformal world matrix: 25 degrees, scale 0.85, a small translation (uWorldM, column-major, acting on clip space).
const th = (25 * Math.PI) / 180,
  sc0 = 0.85;
const WORLD = ROT
  ? [
      Math.cos(th) * sc0,
      Math.sin(th) * sc0,
      0,
      -Math.sin(th) * sc0,
      Math.cos(th) * sc0,
      0,
      0.05,
      -0.03,
      1,
    ]
  : null;
// Mark the wedge (bit 0) and the corner combines (bit 1) in the AFTER text, so a moved fragment can be placed.
const mark = (t) => {
  let s = t;
  const rep = (a, b) => {
    if (s.split(a).length !== 2) throw new Error('hinge: ' + a.slice(0, 60));
    s = s.replace(a, b);
  };
  rep(
    '    if (wgA || wgB) {\n      vec2 nOw = wgA ? nOA : nOB;',
    '    if (wgA || wgB) {\n      LBPIPE_FLAG(0);\n      vec2 nOw = wgA ? nOA : nOB;',
  );
  rep(
    '    if (cnA && LB_CORNER_GATE(gA12)) {\n',
    '    if (cnA && LB_CORNER_GATE(gA12)) {\n      LBPIPE_FLAG(1);\n',
  );
  rep(
    '    if (cnB && LB_CORNER_GATE(gB12)) {\n',
    '    if (cnB && LB_CORNER_GATE(gB12)) {\n      LBPIPE_FLAG(1);\n',
  );
  return s;
};
const svg = readFileSync(FILE, 'utf8');
const VT = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.vert.glsl'), 'utf8');
const fa = readFileSync(FA, 'utf8'),
  fb = mark(readFileSync(FB, 'utf8'));
// Fill rows only: the fill pass's own draw, stroke rows left out (they are cover quads the frame never touches).
const scene = await lbScene(svg, {
  N,
  world: WORLD,
  rows: (s, stroke) => (stroke ? 'skip' : undefined),
});
const A = renderScene(scene, VT, fa),
  B = renderScene(scene, VT, fb);
lap(
  `${path.basename(FILE)} @ ${N} px${ROT ? ', world: rotate 25, scale 0.85' : ''}: ${A.recs.length / 9} fragments`,
);
if (A.recs.length !== B.recs.length)
  throw new Error('the two texts rasterized different fragment sets');
const ko = A.vert.outOff[A.vert.io.outs.findIndex((o) => o.name === 'vKind')];
const kindOf = (t) => Math.floor(A.vOut[(t * 3 + 2) * A.vert.outN + ko] + 1e-4);
const ua = new Uint32Array(A.recs.buffer),
  ub = new Uint32Array(B.recs.buffer);
const stat = {};
const moved = new Map(); // pixel -> set of shapes
let other = 0;
for (let q = 0; q < A.recs.length / 9; q++) {
  let same = true;
  for (let c = 3; c < 8; c++) if (ua[q * 9 + c] !== ub[q * 9 + c]) same = false;
  if (same) continue;
  const t = A.recs[q * 9] | 0,
    k = kindOf(t),
    flags = B.recs[q * 9 + 8] | 0;
  const site =
    k !== 12
      ? `kind ${k}`
      : flags & 2
        ? 'band: corner combine'
        : flags & 1
          ? 'band: wedge'
          : 'band: neither';
  if (k !== 12 || !(flags & 3)) other++;
  const da = A.recs[q * 9 + 7] ? 0 : A.recs[q * 9 + 6],
    db = B.recs[q * 9 + 7] ? 0 : B.recs[q * 9 + 6],
    d = Math.abs(da - db) * 255;
  const e = stat[site] || (stat[site] = { n: 0, vis: 0, max: 0 });
  e.n++;
  if (d > 4) e.vis++;
  if (d > e.max) e.max = d;
  if (d > 1) {
    const px = (A.recs[q * 9 + 2] | 0) * N + (A.recs[q * 9 + 1] | 0),
      sh = scene.entries[scene.entryOfTri[t]].shapeIdx;
    (moved.get(px) || moved.set(px, new Set()).get(px)).add(sh);
  }
}
console.log('fragments that moved, by where:');
for (const [k, e] of Object.entries(stat))
  console.log(
    `  ${k.padEnd(22)} ${String(e.n).padStart(6)}   more than 4/255: ${String(e.vis).padStart(4)}   max ${e.max.toFixed(1)}/255`,
  );
console.log(`  outside the wedge and the corner combines: ${other}`);

// Per shape, at every pixel where one of its fragments moved by more than 1/255: composited coverage before and after
// against the exact coverage of that shape.
const { rowSpans, contoursToConverter, closed } = await refKit();
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const cf = new Float32Array(scene.sec.curves);
const M = scene.pm.metaFloats,
  S = scene.pm.floatsPerShape,
  g = scene.gbb,
  AR = [0, 0];
{
  const cAR = 1,
    sAR = g[2] / g[3];
  if (sAR > cAR) {
    AR[0] = 1;
    AR[1] = cAR / sAR;
  } else {
    AR[0] = sAR / cAR;
    AR[1] = 1;
  }
}
// em -> top-down pixel, exactly as mantle.vert maps it (and the world matrix, when one is bound).
const toPx = (p) => {
  const px = (((p[0] - g[0]) / g[2]) * 2 - 1) * AR[0],
    py = (((p[1] - g[1]) / g[3]) * 2 - 1) * AR[1];
  let cx = px,
    cy = -py,
    cw = 1;
  if (WORLD) {
    const W = WORLD;
    const x = W[0] * px + W[3] * -py + W[6],
      y = W[1] * px + W[4] * -py + W[7];
    cw = W[2] * px + W[5] * -py + W[8];
    cx = x;
    cy = y;
  }
  return [((cx / cw + 1) / 2) * N, N - ((cy / cw + 1) / 2) * N];
};
const idView = { ox: 0, oy: 0, basePx: 1 };
const exactOf = new Map();
const shapeExact = (s) => {
  if (exactOf.has(s)) return exactOf.get(s);
  const r = scene.sec.curveRangesByShape[s];
  const cs = curveRangeToContours(cf, r.begin, r.end).map((c) =>
    c.map((q) => ({
      ...q,
      p1: q.p1 && toPx(q.p1),
      p2: q.p2 && toPx(q.p2),
      p3: q.p3 && toPx(q.p3),
      p4: q.p4 && toPx(q.p4),
    })),
  );
  const v = {
    curves: closed(contoursToConverter(cs, null)),
    evenOdd: M[s * S + 13] > 0.5,
    cache: new Map(),
  };
  exactOf.set(s, v);
  return v;
};
const shapeCov = (R, s, px) => {
  let open = 1;
  for (let q = 0; q < R.recs.length / 9; q++) {
    if (R.recs[q * 9 + 7] === 1) continue;
    if ((R.recs[q * 9 + 2] | 0) * N + (R.recs[q * 9 + 1] | 0) !== px) continue;
    const e = scene.entries[scene.entryOfTri[R.recs[q * 9] | 0]];
    if (e.shapeIdx === s) open *= 1 - Math.min(1, Math.max(0, R.recs[q * 9 + 6]));
  }
  return 1 - open;
};
let n = 0,
  worse = 0,
  better = 0,
  sa = 0,
  sb = 0,
  ma = 0,
  mb = 0;
const rows = [];
for (const [px, shapes] of moved)
  for (const s of shapes) {
    const ex = shapeExact(s),
      i = px % N,
      j = (px / N) | 0;
    const e = exactCov(rowSpans, ex.curves, i, j, idView, 64, ex.evenOdd, ex.cache);
    const ca = shapeCov(A, s, px),
      cb = shapeCov(B, s, px);
    const ea = Math.abs(ca - e) * 255,
      eb = Math.abs(cb - e) * 255;
    n++;
    sa += ea;
    sb += eb;
    ma = Math.max(ma, ea);
    mb = Math.max(mb, eb);
    if (eb > ea + 0.5) worse++;
    else if (ea > eb + 0.5) better++;
    rows.push([
      Math.abs(ea - eb),
      `  shape ${s} (${i},${j}): exact ${(e * 255).toFixed(1)}  before ${(ca * 255).toFixed(1)} (off ${ea.toFixed(1)})  after ${(cb * 255).toFixed(1)} (off ${eb.toFixed(1)})`,
    ]);
  }
console.log(
  `\n${n} shape-pixels where a fragment moved by more than 1/255, against the exact area of the shape:`,
);
console.log(
  `  |before - exact| mean ${(sa / Math.max(n, 1)).toFixed(2)}/255, max ${ma.toFixed(1)}`,
);
console.log(
  `  |after  - exact| mean ${(sb / Math.max(n, 1)).toFixed(2)}/255, max ${mb.toFixed(1)}`,
);
console.log(`  after is nearer on ${better}, further on ${worse}`);
console.log(
  rows
    .sort((x, y) => y[0] - x[0])
    .slice(0, 24)
    .map((x) => x[1])
    .join('\n'),
);
lap('done');
