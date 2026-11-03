// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cornerPlaneProof — the shared corner plane. Two edge strips meeting at a line-line corner split its wedge at the bisector;
// if each decides its side from its own interpolated em position and its own normal, a pixel center ON the bisector (a
// symmetric corner puts one there exactly) is painted by both strips or by neither -- squares 1.5 px: 41.1/255 on a
// float emulator (twice), 0 on the GPU (neither) against an exact 8.6-25.5. Packing one plane per corner, mapping it
// into canvas pixels in the vertex stage and testing the exact center (gl_FragCoord) against it gives one number, one owner.
//
// Two builds (before = without the shared plane, after = with it) of the generated vertex AND fragment texts through the
// whole-LB-pipeline emulator (test/_lbPipeEmu.mjs, FINE derivatives) on one scene -- built by the current packer, whose
// kind-10 aC1/aC2 a text without the plane never reads -- unsnapped and with the GPU's 1/256 vertex snap. Every fragment compared bit for bit, by kind and
// by whether it took the shared test; kind-10 double claims (two strips of one shape painting one pixel) counted in
// both; and at every pixel where a fragment moved, the shape's composited coverage before and after against the exact
// box coverage (_lbAaRef, 64 slices).
//
//   node probes/lbAccuracy/_cornerPlaneProof.mjs before.vert before.frag after.vert after.frag <gpu_*.json | svg> ...
//        CANVAS=256 (svg only) SNAPS=0,256 WORLD=rot PIXELS=x,y;x,y (logs: probes/_lbPipeOut)
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { lbScene, renderScene } from '../../test/_lbPipeScene.mjs';
import { refKit, exactCov } from './_lbAaRef.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [VA, FA, VB, FB, ...INPUTS] = process.argv.slice(2);
const SNAPS = (process.env.SNAPS || '0,256').split(',').map(Number);
const ROT = process.env.WORLD === 'rot';
const PIXELS = (process.env.PIXELS || '')
  .split(';')
  .filter(Boolean)
  .map((s) => s.split(',').map(Number));
const t0 = Date.now();
const lap = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)} s] ${m}`);
console.warn = () => {};
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
// Mark the shared tests in the AFTER text: bit 0 = end A's, bit 1 = end B's.
const mark = (t) => {
  let s = t;
  const rep = (a, b) => {
    if (s.split(a).length !== 2) throw new Error('hinge: ' + a.slice(0, 60));
    s = s.replace(a, b);
  };
  rep('if (shA10) {\n', 'if (shA10) {\n          LBPIPE_FLAG(0);\n');
  rep('else if (shB10) {\n', 'else if (shB10) {\n        LBPIPE_FLAG(1);\n');
  return s;
};
const vta = readFileSync(VA, 'utf8'),
  fta = readFileSync(FA, 'utf8'),
  vtb = readFileSync(VB, 'utf8'),
  ftb = mark(readFileSync(FB, 'utf8'));
const { rowSpans, contoursToConverter, closed } = await refKit();
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const total = { moved: 0, nearer: 0, further: 0, same: 0, dblA: 0, dblB: 0 };

for (const input of INPUTS) {
  let name, svg, N;
  if (/\.json$/.test(input)) {
    const d = JSON.parse(readFileSync(input, 'utf8'));
    name = d.name;
    svg = d.svg;
    N = d.N;
  } else {
    name = path.basename(input);
    svg = readFileSync(input, 'utf8');
    N = +(process.env.CANVAS || 256);
  }
  const scene = await lbScene(svg, {
    N,
    world: WORLD,
    rows: (s, stroke) => (stroke ? 'skip' : undefined),
  });
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
  const exactAt = (s, i, j) => {
    const ex = shapeExact(s);
    return exactCov(
      rowSpans,
      ex.curves,
      i,
      j,
      { ox: 0, oy: 0, basePx: 1 },
      64,
      ex.evenOdd,
      ex.cache,
    );
  };
  for (const snap of SNAPS) {
    const A = renderScene(scene, vta, fta, [], { snap }),
      B = renderScene(scene, vtb, ftb, [], { snap });
    const tag = `${name} @ ${N} px${snap ? `, snapped 1/${snap}` : ', unsnapped'}${ROT ? ', world: rotate 25, scale 0.85' : ''}`;
    if (A.recs.length !== B.recs.length)
      throw new Error(`${tag}: the two builds rasterized different fragment sets`);
    const ko = A.vert.outOff[A.vert.io.outs.findIndex((o) => o.name === 'vKind')];
    const kindOf = (t) => Math.floor(A.vOut[(t * 3 + 2) * A.vert.outN + ko] + 1e-4);
    const ua = new Uint32Array(A.recs.buffer),
      ub = new Uint32Array(B.recs.buffer);
    const stat = {},
      moved = new Map();
    let shared = 0;
    // Kind-10 claims per (shape, pixel): a pixel two strips of one shape both paint.
    const claimsA = new Map(),
      claimsB = new Map();
    for (let q = 0; q < A.recs.length / 9; q++) {
      const t = A.recs[q * 9] | 0,
        k = kindOf(t),
        flags = B.recs[q * 9 + 8] | 0;
      if (flags & 3) shared++;
      const sh = scene.entries[scene.entryOfTri[t]].shapeIdx,
        px = (A.recs[q * 9 + 2] | 0) * N + (A.recs[q * 9 + 1] | 0);
      if (k === 10) {
        const key = sh * N * N + px;
        if (!A.recs[q * 9 + 7] && A.recs[q * 9 + 6] > 0)
          claimsA.set(key, (claimsA.get(key) || 0) + 1);
        if (!B.recs[q * 9 + 7] && B.recs[q * 9 + 6] > 0)
          claimsB.set(key, (claimsB.get(key) || 0) + 1);
      }
      let same = true;
      for (let c = 3; c < 8; c++) if (ua[q * 9 + c] !== ub[q * 9 + c]) same = false;
      if (same) continue;
      const site = `kind ${k}${k === 10 ? (flags & 3 ? ', shared plane' : ', own plane') : ''}`;
      const da = A.recs[q * 9 + 7] ? 0 : A.recs[q * 9 + 6],
        db = B.recs[q * 9 + 7] ? 0 : B.recs[q * 9 + 6],
        d = Math.abs(da - db) * 255;
      const e = stat[site] || (stat[site] = { n: 0, vis: 0, max: 0 });
      e.n++;
      if (d > 4) e.vis++;
      if (d > e.max) e.max = d;
      (moved.get(px) || moved.set(px, new Set()).get(px)).add(sh);
    }
    const dbl = (m) => {
      let n = 0;
      for (const c of m.values()) if (c > 1) n++;
      return n;
    };
    const dA = dbl(claimsA),
      dB = dbl(claimsB);
    total.dblA += dA;
    total.dblB += dB;
    lap(
      `${tag}: ${A.recs.length / 9} fragments, ${shared} took a shared corner plane; kind-10 double claims ${dA} -> ${dB}`,
    );
    for (const [k, e] of Object.entries(stat))
      console.log(
        `  moved: ${k.padEnd(24)} ${String(e.n).padStart(6)}   more than 4/255: ${String(e.vis).padStart(4)}   max ${e.max.toFixed(1)}/255`,
      );
    const shapeCov = (R, s, px) => {
      let open = 1;
      for (let q = 0; q < R.recs.length / 9; q++) {
        if (R.recs[q * 9 + 7] === 1) continue;
        if ((R.recs[q * 9 + 2] | 0) * N + (R.recs[q * 9 + 1] | 0) !== px) continue;
        if (scene.entries[scene.entryOfTri[R.recs[q * 9] | 0]].shapeIdx === s)
          open *= 1 - Math.min(1, Math.max(0, R.recs[q * 9 + 6]));
      }
      return 1 - open;
    };
    let n = 0,
      worse = 0,
      better = 0,
      sa = 0,
      sb = 0;
    const rows = [];
    for (const [px, shapes] of moved)
      for (const s of shapes) {
        const i = px % N,
          j = (px / N) | 0,
          e = exactAt(s, i, j);
        const ca = shapeCov(A, s, px),
          cb = shapeCov(B, s, px);
        const ea = Math.abs(ca - e) * 255,
          eb = Math.abs(cb - e) * 255;
        n++;
        sa += ea;
        sb += eb;
        if (eb > ea + 0.5) worse++;
        else if (ea > eb + 0.5) better++;
        rows.push([
          Math.abs(ea - eb),
          `    shape ${s} (${i},${j}): exact ${(e * 255).toFixed(1)}  before ${(ca * 255).toFixed(1)} (off ${ea.toFixed(1)})  after ${(cb * 255).toFixed(1)} (off ${eb.toFixed(1)})`,
        ]);
      }
    total.moved += n;
    total.nearer += better;
    total.further += worse;
    total.same += n - better - worse;
    if (n) {
      console.log(
        `  ${n} shape-pixels moved: |before - exact| mean ${(sa / n).toFixed(2)}/255, |after - exact| mean ${(sb / n).toFixed(2)}/255; nearer ${better}, further ${worse}, within 0.5 ${n - better - worse}`,
      );
      console.log(
        rows
          .sort((x, y) => y[0] - x[0])
          .slice(0, 16)
          .map((x) => x[1])
          .join('\n'),
      );
    } else console.log('  bit-identical');
    for (const [i, j] of PIXELS) {
      const px = j * N + i,
        shs = new Set();
      for (let q = 0; q < A.recs.length / 9; q++)
        if ((A.recs[q * 9 + 2] | 0) * N + (A.recs[q * 9 + 1] | 0) === px)
          shs.add(scene.entries[scene.entryOfTri[A.recs[q * 9] | 0]].shapeIdx);
      for (const s of shs)
        console.log(
          `  pixel (${i},${j}) shape ${s}: exact ${(exactAt(s, i, j) * 255).toFixed(1)}  before ${(shapeCov(A, s, px) * 255).toFixed(1)}  after ${(shapeCov(B, s, px) * 255).toFixed(1)}`,
        );
    }
  }
}
console.log(
  `\nALL: ${total.moved} shape-pixels moved -- nearer ${total.nearer}, further ${total.further}, within 0.5/255 ${total.same}; kind-10 double claims ${total.dblA} -> ${total.dblB}`,
);
lap('done');
