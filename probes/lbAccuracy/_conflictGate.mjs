// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _conflictGate — what the curve band's near-zero CONFLICT GATE decides. The gate discards a band fragment whose
// center is on the exterior side of its own curve (fOwn12 >= 0), in span (not a wedge), with combined coverage under a
// fixed 0.12, when the center lies on the interior side of an end neighbour's LINEAR plane within that end's proximity
// gate (gA12/gB12 > 0). Its comment says the band's near-zero coverage "can still reject solid interior".
//
// Through the whole-LB-pipeline emulator (test/_lbPipeEmu.mjs): the current text with the gate marked (which end, the
// end's chain state, its packed corner type, and the corner's turn read off the normals), the same text with the gate
// removed, and optionally a candidate replacement (GATE=<file>: a GLSL block that replaces the gate verbatim). Every
// fragment the gate discards, with what it would have painted; per (shape, pixel): the center inside the fill or not
// (exact scanline spans), the exact box coverage, and the shape's coverage with and without the gate under both
// composites the unified route uses -- OVER (opaque) and the depth CLAIM (first fragment of the shape wins, translucent
// fills and morphs).
//
// The package kernel has no such gate (an inside test at unchained reflex ends takes its place), so the arms are built
// from a generated fragment text that still has it, FRAG (default probes/_lbPipeOut/pre_conflictGate.frag -- put a copy of such a
// text there); GATE=probes/lbAccuracy/_conflictGateInside.glsl is the package's inside test, verbatim.
//
//   node probes/lbAccuracy/_conflictGate.mjs <gpu_*.json | svg> ...     CANVAS=256 (svg only) SNAP=0 WORLD=rot GATE=file FRAG=file
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { lbScene, renderScene } from '../../test/_lbPipeScene.mjs';
import { refKit, exactCov } from './_lbAaRef.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INPUTS = process.argv.slice(2);
const SNAP = +(process.env.SNAP || 0);
const ROT = process.env.WORLD === 'rot';
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
const GATE = `    if (!wgA && !wgB && fOwn12 >= 0.0 && c12 < 0.12) {
      if (gA12 > 0.0 && dot(nA12, rA) < 0.0) discard;
      if (gB12 > 0.0 && dot(nB12, rB) < 0.0) discard;
    }
`;
const MARKED = `    if (!wgA && !wgB && fOwn12 >= 0.0 && c12 < 0.12) {
      if (gA12 > 0.0 && dot(nA12, rA) < 0.0 && LBPIPE_FLAG(2) && (cnA ? LBPIPE_FLAG(4) : true) && (tyA > 0.5 ? LBPIPE_FLAG(5) : true) && (dot(sA12, nA12) > 0.0 ? LBPIPE_FLAG(6) : true)) discard;
      if (gB12 > 0.0 && dot(nB12, rB) < 0.0 && LBPIPE_FLAG(3) && (cnB ? LBPIPE_FLAG(7) : true) && (tyB > 0.5 ? LBPIPE_FLAG(8) : true) && (dot(sB12, nB12) > 0.0 ? LBPIPE_FLAG(9) : true)) discard;
    }
`;
const FT = readFileSync(
  process.env.FRAG || path.join(ROOT, 'probes/_lbPipeOut/pre_conflictGate.frag'),
  'utf8',
);
const VT = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.vert.glsl'), 'utf8');
if (FT.split(GATE).length !== 2)
  throw new Error('the gate block is not in the generated text verbatim');
const texts = { gate: FT.replace(GATE, MARKED), none: FT.replace(GATE, '') };
if (process.env.GATE) texts.cand = FT.replace(GATE, readFileSync(process.env.GATE, 'utf8'));
const { rowSpans, contoursToConverter, closed } = await refKit();
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const ALL = {};

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
  const centerIn = (s, i, j) => {
    const ex = shapeExact(s);
    return rowSpans(ex.curves, j + 0.5, ex.evenOdd).some(
      (sp) => sp[0] <= i + 0.5 && i + 0.5 <= sp[1],
    );
  };
  const R = {};
  for (const [k, t] of Object.entries(texts))
    R[k] = renderScene(scene, VT, t, [], { snap: SNAP, kinds: null });
  const nq = R.gate.recs.length / 9;
  for (const k of Object.keys(R))
    if (R[k].recs.length / 9 !== nq) throw new Error('fragment sets differ');
  const shapeOf = (q) => scene.entries[scene.entryOfTri[R.gate.recs[q * 9] | 0]].shapeIdx;
  const pxOf = (q) => (R.gate.recs[q * 9 + 2] | 0) * N + (R.gate.recs[q * 9 + 1] | 0);
  const alphaOf = (rec, q) => (rec[q * 9 + 7] ? 0 : Math.min(1, Math.max(0, rec[q * 9 + 6])));
  // Per (shape, pixel): its fragments in primitive order.
  const byKey = new Map();
  for (let q = 0; q < nq; q++) {
    const key = shapeOf(q) * N * N + pxOf(q);
    (byKey.get(key) || byKey.set(key, []).get(key)).push(q);
  }
  const over = (rec, qs) => {
    let o = 1;
    for (const q of qs) o *= 1 - alphaOf(rec, q);
    return 1 - o;
  };
  const claim = (rec, qs) => {
    for (const q of qs) if (!rec[q * 9 + 7]) return alphaOf(rec, q);
    return 0;
  };
  const cls = {},
    rows = [];
  const fired = new Set();
  for (let q = 0; q < nq; q++) {
    const f = R.gate.recs[q * 9 + 8] | 0;
    if (!(f & 12)) continue;
    const end = f & 4 ? 'A' : 'B',
      b = end === 'A' ? [4, 5, 6] : [7, 8, 9];
    const chained = !!(f & (1 << b[0])),
      convexTy = !!(f & (1 << b[1])),
      reflexN = !!(f & (1 << b[2]));
    const s = shapeOf(q),
      px = pxOf(q),
      i = px % N,
      j = (px / N) | 0;
    const inside = centerIn(s, i, j);
    const key = `${chained ? `chained ${convexTy ? 'convex' : 'reflex'}` : 'unchained (a line, or a curve met near-straight)'}, turn ${reflexN ? 'reflex' : 'convex'}, centre ${inside ? 'INSIDE' : 'outside'}`;
    const c = cls[key] || (cls[key] = { n: 0, cmax: 0 });
    c.n++;
    c.cmax = Math.max(c.cmax, alphaOf(R.none.recs, q));
    fired.add(s * N * N + px);
    rows.push({ q, s, i, j, key, would: alphaOf(R.none.recs, q) });
  }
  console.log(
    `\n${name} @ ${N} px${SNAP ? `, snapped 1/${SNAP}` : ''}${ROT ? ', world: rotate 25, scale 0.85' : ''}: ${nq} fragments; the gate discards ${rows.length}`,
  );
  for (const [k, c] of Object.entries(cls))
    console.log(
      `  ${String(c.n).padStart(5)}  ${k}   (would paint up to ${(c.cmax * 255).toFixed(1)}/255)`,
    );
  // What the candidate discards that no gate would: center inside the fill (its job) or not.
  if (R.cand) {
    const cc = { inside: 0, outside: 0 };
    for (let q = 0; q < nq; q++)
      if (R.cand.recs[q * 9 + 7] && !R.none.recs[q * 9 + 7]) {
        const px = pxOf(q);
        cc[centerIn(shapeOf(q), px % N, (px / N) | 0) ? 'inside' : 'outside']++;
      }
    console.log(
      `  the candidate discards ${cc.inside + cc.outside}: center inside the fill ${cc.inside}, outside ${cc.outside}`,
    );
  }
  // Every (shape, pixel) whose fragments any arm changed: the gate's, and the candidate's.
  const touched = new Set(fired);
  if (R.cand)
    for (let q = 0; q < nq; q++) {
      let same = true;
      for (let c = 3; c < 8; c++)
        if (
          R.cand.recs[q * 9 + c] !== R.none.recs[q * 9 + c] &&
          R.cand.recs[q * 9 + c] !== R.gate.recs[q * 9 + c]
        )
          same = false;
      const dg = alphaOf(R.cand.recs, q) !== alphaOf(R.gate.recs, q);
      if (dg || !same) touched.add(shapeOf(q) * N * N + pxOf(q));
    }
  const arms = Object.keys(R);
  const err = {};
  for (const a of arms) err[a] = { over: 0, claim: 0 };
  let nT = 0;
  const detail = [];
  for (const key of touched) {
    const s = Math.floor(key / (N * N)),
      px = key % (N * N),
      i = px % N,
      j = (px / N) | 0;
    const qs = byKey.get(key),
      e = exactAt(s, i, j);
    nT++;
    const line = [
      `    shape ${s} (${i},${j}) centre ${centerIn(s, i, j) ? 'in ' : 'out'} exact ${(e * 255).toFixed(1)}`,
    ];
    for (const a of arms) {
      const o = over(R[a].recs, qs),
        cl = claim(R[a].recs, qs);
      err[a].over += Math.abs(o - e) * 255;
      err[a].claim += Math.abs(cl - e) * 255;
      line.push(`${a} ${(o * 255).toFixed(1)}/${(cl * 255).toFixed(1)}`);
    }
    detail.push(line.join('  '));
  }
  if (nT) {
    console.log(`  ${nT} shape-pixels touched; summed |coverage - exact| (/255), OVER / CLAIM:`);
    for (const a of arms)
      console.log(
        `    ${a.padEnd(5)} ${err[a].over.toFixed(1).padStart(8)} / ${err[a].claim.toFixed(1)}`,
      );
    console.log('  (per pixel: arm OVER/CLAIM)');
    console.log(detail.slice(0, +(process.env.SHOW || 40)).join('\n'));
  }
  ALL[name] = { fired: rows.length, cls, err };
}
lap('done');
