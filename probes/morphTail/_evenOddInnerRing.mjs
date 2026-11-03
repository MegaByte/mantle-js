// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _evenOddInnerRing — the lbMorphEvenOdd over-paint at the INNER ring's extreme points,
// named face by face in the CPU LB draw model (test/_lbMorphDrawEmu.mjs).
//
//   node probes/morphTail/_evenOddInnerRing.mjs            (TS=0.03,0.04,... to choose frames)
//
// For every pixel the model paints more than 32 levels over exact even-odd coverage, it prints the
// triangle that claimed it (first fragment in primitive order: the depth claim), whether that face is
// an interior face in CHAIN mode, and the chain that runs along the inner ring. Then, for the worst
// pixel of each face, the kind-0 coverage min(chain 1, chain 2) as packed, and again with that chain's
// two points beside the ring's extreme point moved onto the arc's TANGENT there.
//
// WHAT IT SHOWS (t = 0.03 through 1): every over-painted pixel is claimed by one of eight interior
// faces, two per extreme point of the inner ring, each a triangle with an edge ALONG the ring's
// extreme tangent. They run in chain mode, and the chain that follows the inner ring (chain 1 on some,
// chain 2 on others) is the pair partition's piece CHORDS on either side of the extreme point -- e.g.
// (30.34, 13.66) -> (22, 10.21) -> (13.66, 13.66) at t = 0.03: 45 degrees of arc each, sagitta 0.9 em,
// 22.5 degrees off the tangent. A pixel straddling the tangent is wholly on the ink side of those
// chords, so the face paints it 1.000 where it is 0.813 covered; along the tangent the same clip
// gives 0.807. The chord stands in for the curve in the BUILDER's chain (lbFastMesh.js
// interiorChainsFromTris, fed the pair partition's piece edges), not in any kernel.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import(ROOT + '/src/svg/importer.js');
const { parseMetaBin } = await import(ROOT + '/src/core/metaBin.js');
const { curveRangeToContours, rayWinding } = await import(ROOT + '/src/geom/lbContour.js');
const { buildMorphBundle } = await import(ROOT + '/src/renderer/lbMorphCore.js');
const { chainBoxCov } = await import(ROOT + '/probes/lbAccuracy/_lbBoxCov.mjs');
const EMU = await import(ROOT + '/test/_lbMorphDrawEmu.mjs');
const warn = console.warn;
console.warn = () => {};

const S = readFileSync(path.join(ROOT, 'examples/smoke/lbMorphEvenOdd__SRC.svg'), 'utf8');
const D = readFileSync(path.join(ROOT, 'examples/smoke/lbMorphEvenOdd__DST.svg'), 'utf8');
const A = await importSvg(S, { preserveViewport: true }),
  B = await importSvg(D, { preserveViewport: true });
const pa = parseMetaBin(A.meta, A.metaFloatsPerShape),
  pb = parseMetaBin(B.meta, B.metaFloatsPerShape);
const input = {
  srcCurve: new Float32Array(A.curves),
  dstCurve: new Float32Array(B.curves),
  srcMeta: pa.metaFloats,
  dstMeta: pb.metaFloats,
  metaStride: pa.floatsPerShape,
  ranges: A.curveRangesByShape,
  numShapes: A.numShapes,
  bb: A.globalBBox,
};
const mesh = buildMorphBundle(input).meshes[0];
const sc = curveRangeToContours(
  input.srcCurve,
  A.curveRangesByShape[0].begin,
  A.curveRangesByShape[0].end,
);
const dc = curveRangeToContours(
  input.dstCurve,
  B.curveRangesByShape[0].begin,
  B.curveRangesByShape[0].end,
);
const N = 512,
  bb = Array.from(A.globalBBox),
  e = bb[2] / N,
  SS = 16;
const f4 = (p) => `(${p[0].toFixed(2)}, ${p[1].toFixed(2)})`;

for (const t of (process.env.TS || '0.03,0.04,0.09,0.25,1').split(',').map(Number)) {
  const segs = sc
    .map((c, ci) =>
      c.map((g, si) => {
        const d = dc[ci][si],
          lp = (p, q) => p && [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        return {
          type: g.type,
          p1: lp(g.p1, d.p1),
          p2: lp(g.p2, d.p2),
          p3: lp(g.p3, d.p3),
          p4: lp(g.p4, d.p4),
        };
      }),
    )
    .flat();
  const inside = (x, y) => (rayWinding(segs, bb[0] + x * e, bb[1] + y * e) & 1) !== 0;
  const pk = EMU.morphPacksAt(mesh, t),
    cov = EMU.render(pk, bb, N).cov;
  const faces = new Map();
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const v = Math.max(0, cov[y * N + x]),
        c = inside(x + 0.5, y + 0.5);
      if (
        (v === 0 || v === 1) &&
        (v === 1) === c &&
        [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ].every(([a, b]) => inside(x + a, y + b) === c)
      )
        continue;
      let n = 0;
      for (let a = 0; a < SS; a++)
        for (let b = 0; b < SS; b++) if (inside(x + (a + 0.5) / SS, y + (b + 0.5) / SS)) n++;
      const ex = n / SS / SS,
        over = Math.round((v - ex) * 255);
      if (over <= 32) continue;
      const watch = { px: [x, y], log: [] };
      EMU.render(pk, bb, N, { watch });
      const w = watch.log.find((l) => !l.claimed);
      if (!w) continue;
      const f = faces.get(w.tri) || { n: 0, worst: 0, at: null, w, ex: 0, got: 0 };
      f.n++;
      if (over > f.worst) {
        f.worst = over;
        f.at = [x, y];
        f.ex = ex;
        f.got = v;
      }
      faces.set(w.tri, f);
    }
  console.log(
    `t = ${t}: ${[...faces.values()].reduce((s, f) => s + f.n, 0)} px over exact by > 32 levels, claimed by ${faces.size} face(s)`,
  );
  for (const [tri, f] of faces) {
    const P = f.w.P;
    // The two chains as the provoking vertex carries them (_lbMorphDrawEmu's kind-0 branch).
    const ch1 = [
      [P.C3[0], P.C3[1]],
      [P.C3[2], P.C3[3]],
      [P.C0[0], P.C0[1]],
      [P.C0[2], P.C0[3]],
      [P.vtc[1], P.vtc[2]],
    ];
    const ch2 = [
      [P.C1[0], P.C1[1]],
      [P.C1[2], P.C1[3]],
      [P.C2[0], P.C2[1]],
      [P.C2[2], P.C2[3]],
    ];
    // Which chain runs along the INNER ring: a point on the circle of the pose's inner radius.
    const rIn = 12 - 7 * t,
      onInner = (q) => Math.abs(Math.hypot(q[0] - 22, q[1] - 22) - rIn) < 1e-3;
    const inner = ch1.slice(0, 4).some(onInner) ? 1 : ch2.some(onInner) ? 2 : 0;
    console.log(
      `  face ${tri}: kind ${f.w.kind}${f.w.chainMode ? ' (interior, chain mode)' : ''}, vertices ${f.w.em.map(f4).join(' ')}; ${f.n} px, worst +${f.worst} at (${f.at})`,
    );
    const chIn = inner === 1 ? ch1 : ch2;
    console.log(
      `    chain ${inner} runs along the inner ring: ${chIn.slice(0, 3).map(f4).join(' -> ')}`,
    );
    const [x, y] = f.at,
      ex0 = bb[0] + (x + 0.5) * e,
      ey0 = bb[1] + (y + 0.5) * e,
      cell = (q) => [(q[0] - ex0) / e, (q[1] - ey0) / e];
    // The same chain with the chords at its extreme-point vertex swapped for the arc's tangent there (the
    // ring's extreme tangents are axis-aligned, so the far point keeps its longer axis offset only).
    const vi = chIn.findIndex(
      (q) =>
        onInner(q) &&
        [
          [0, -1],
          [0, 1],
          [-1, 0],
          [1, 0],
        ].some(
          ([dx, dy]) =>
            Math.abs(q[0] - (22 + dx * rIn)) < 1e-3 && Math.abs(q[1] - (22 + dy * rIn)) < 1e-3,
        ),
    );
    const v = chIn[vi],
      tanOf = (q) => {
        const d = [q[0] - v[0], q[1] - v[1]];
        return Math.abs(d[0]) > Math.abs(d[1]) ? [q[0], v[1]] : [v[0], q[1]];
      };
    const fixed = chIn.map((q, i) => (vi >= 0 && Math.abs(i - vi) === 1 ? tanOf(q) : q));
    const covOf = (c1, c2) => {
      const a = c1.map(cell),
        b = c2.map(cell);
      return Math.min(
        chainBoxCov(a[0], a[1], a[2], a[3], a[4], 2.0),
        chainBoxCov(b[0], b[1], b[2], b[3], b[3], 1.0),
      );
    };
    const asPacked = covOf(ch1, ch2),
      tangent = inner === 1 ? covOf(fixed, ch2) : covOf(ch1, fixed);
    console.log(
      `    worst pixel: model ${f.got.toFixed(3)}, exact ${f.ex.toFixed(3)}; min(chain 1, chain 2) as packed ${asPacked.toFixed(3)}, with the inner chain along the arc's tangent ${tangent.toFixed(3)}`,
    );
  }
}
console.warn = warn;
