// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _morphPairPointDiag.mjs — WHAT is the vertex a morph pair cannot map? No GPU.
//
// The partition pair maps every source vertex to the destination through points it registered (segment endpoints,
// control points, cubic piece points, crossing-splitter Steiner points). It declines at "clip/Steiner vertex" (interior
// map) and "clipped sub-verts" (cubic hull map) when a vertex is none of those. This runs a line-tagged copy of
// lbPartitionPair.js that also records every registered source point and the vertex that failed, and classifies the
// failure: registered after all (a quantization miss), a Steiner point, the midpoint of two mapped vertices, a point
// on a boundary segment at some parameter, or unexplained.
//
//   node probes/_morphPairPointDiag.mjs
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => pathToFileURL(path.join(ROOT, p)).href;
const PAIR_SRC = path.join(ROOT, 'src/renderer/lbPartitionPair.js');
const TAGGED = path.join(ROOT, 'src/renderer/_diagTaggedPartitionPairPt.mjs');
let code = readFileSync(PAIR_SRC, 'utf8');
// record every registered source point
code = code.replace(
  /map9\.set\(kOf\(([^,()]+(?:\[[^\]]*\])*), ([^()]+?(?:\[[^\]]*\])*)\), /g,
  '(globalThis.__reg9.push([$1, $2]), map9).set(kOf($1, $2), ',
);
// expose the source mesh and the point map once built
code = code.replace(
  'const mapPt = (x, y) => map9.get(kOf(x, y)) || null;',
  'const mapPt = (x, y) => map9.get(kOf(x, y)) || null; globalThis.__pairSrc = src; globalThis.__pairMapPt = mapPt;',
);
// capture the failing vertex at the two unmapped-vertex bails
code = code.replace(
  'const mp = mapPt(si[i], si[i + 1]);\n    if (!mp) return null;',
  'const mp = mapPt(si[i], si[i + 1]);\n    if (!mp) { globalThis.__pairWhyPt = [si[i], si[i + 1]]; return (globalThis.__pairWhy = "interior", null); }',
);
code = code.replace(
  'const mp = mapPt(H[2 * k], H[2 * k + 1]);\n      if (!mp) return null;',
  'const mp = mapPt(H[2 * k], H[2 * k + 1]);\n      if (!mp) { globalThis.__pairWhyPt = [H[2 * k], H[2 * k + 1]]; return (globalThis.__pairWhy = "cubicHull", null); }',
);
code = code
  .split('\n')
  .map((l, i) => l.replace(/return null;/g, `return (globalThis.__pairWhy = ${i + 1}, null);`))
  .join('\n');
if (
  !code.includes('"interior"') ||
  !code.includes('"cubicHull"') ||
  !code.includes('globalThis.__reg9.push')
) {
  console.error('instrumentation did not apply');
  process.exit(2);
}
writeFileSync(TAGGED, code);
process.on('exit', () => {
  try {
    unlinkSync(TAGGED);
  } catch {}
});

const { setSdfPrimitivesEnabled } = await import(R('src/geom/shapeRecognize.js'));
const { default: importSvg } = await import(R('src/svg/importer.js'));
const { curveRangeToContours } = await import(R('src/renderer/loopBlinn.js'));
const { cubicPt } = await import(R('src/geom/lbCubicMath.js'));
const { buildLoopBlinnPartitionPair } = await import(pathToFileURL(TAGGED).href);

const lerpContours = (sc, dc, t) => {
  if (t <= 0) return sc;
  if (t >= 1) return dc;
  const u = 1 - t,
    lp = (a, b) => [a[0] * u + b[0] * t, a[1] * u + b[1] * t];
  return sc.map((cs, ci) =>
    cs.map((ss, si) => {
      const ds = dc[ci][si],
        o = { type: ss.type, p1: lp(ss.p1, ds.p1) };
      if (ss.w != null) o.w = ss.w;
      if (ss.p2) o.p2 = lp(ss.p2, ds.p2);
      if (ss.p3) o.p3 = lp(ss.p3, ds.p3);
      if (ss.p4) o.p4 = lp(ss.p4, ds.p4);
      return o;
    }),
  );
};
const K = 0.5522847498;
const ellipsePath = (cx, cy, rx, ry) =>
  `M ${cx + rx} ${cy} ` +
  `C ${cx + rx} ${cy - K * ry} ${cx + K * rx} ${cy - ry} ${cx} ${cy - ry} ` +
  `C ${cx - K * rx} ${cy - ry} ${cx - rx} ${cy - K * ry} ${cx - rx} ${cy} ` +
  `C ${cx - rx} ${cy + K * ry} ${cx - K * rx} ${cy + ry} ${cx} ${cy + ry} ` +
  `C ${cx + K * rx} ${cy + ry} ${cx + rx} ${cy + K * ry} ${cx + rx} ${cy} Z`;
const svg = (vb, d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"><path d="${d}" fill="#3366cc"/></svg>`;
const A = 'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z';
const B = 'M20 8 C28 2 34 10 33 20 C32 30 28 34 20 33 C11 32 6 28 7 20 C8 10 12 2 20 8 Z';
const pose = async (s) => {
  const b = await importSvg(s, { preserveViewport: true });
  const cf = new Float32Array(b.curves),
    r = b.curveRangesByShape[0];
  return curveRangeToContours(cf, r.begin, r.end);
};

function classify(P, sc) {
  const reg = globalThis.__reg9 || [],
    src = globalThis.__pairSrc,
    mapPt = globalThis.__pairMapPt;
  const ext = (() => {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const c of sc)
      for (const g of c)
        for (const Q of [g.p1, g.p2, g.p3, g.p4])
          if (Q) {
            x0 = Math.min(x0, Q[0]);
            x1 = Math.max(x1, Q[0]);
            y0 = Math.min(y0, Q[1]);
            y1 = Math.max(y1, Q[1]);
          }
    return Math.max(x1 - x0, y1 - y0);
  })();
  const eps = 1e-6 * ext,
    near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps;
  const out = [];
  let best = Infinity;
  for (const Q of reg) best = Math.min(best, Math.hypot(Q[0] - P[0], Q[1] - P[1]));
  out.push(`nearest registered ${(best / ext).toExponential(2)} ext`);
  if (src && src.steiner9)
    for (const st of src.steiner9)
      if (near(st.pt, P))
        out.push(
          'a Steiner point (parents ' +
            ['pa', 'pb', 'pc', 'pd']
              .map((k) => (mapPt(st[k][0], st[k][1]) ? 'ok' : 'UNMAPPED'))
              .join('/') +
            ')',
        );
  // vertices the pair can map: registered points plus any mesh vertex mapPt resolves
  const mapped = reg.slice();
  if (src) {
    const I = src.interior || [];
    for (let i = 0; i < I.length; i += 2) if (mapPt(I[i], I[i + 1])) mapped.push([I[i], I[i + 1]]);
  }
  let mid = null;
  for (let i = 0; i < mapped.length && !mid; i++)
    for (let j = i + 1; j < mapped.length; j++) {
      if (near([(mapped[i][0] + mapped[j][0]) / 2, (mapped[i][1] + mapped[j][1]) / 2], P)) {
        mid = [mapped[i], mapped[j]];
        break;
      }
    }
  if (mid)
    out.push(
      `MIDPOINT of (${mid[0].map((v) => v.toFixed(3))}) and (${mid[1].map((v) => v.toFixed(3))})`,
    );
  // on a boundary segment?
  for (let c = 0; c < sc.length; c++)
    for (let i = 0; i < sc[c].length; i++) {
      const g = sc[c][i];
      const cp = g.p4
        ? [g.p1, g.p2, g.p3, g.p4]
        : g.p3
          ? [g.p1, g.p2, g.p2, g.p3]
          : [g.p1, g.p1, g.p2, g.p2];
      let bt = -1,
        bd = Infinity;
      for (let k = 0; k <= 400; k++) {
        const Q = cubicPt(cp, k / 400);
        const d = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
        if (d < bd) {
          bd = d;
          bt = k / 400;
        }
      }
      if (bd <= 2e-3 * ext)
        out.push(
          `near seg ${c}|${i} type ${g.type} at t~${bt.toFixed(3)} (d ${(bd / ext).toExponential(1)} ext)`,
        );
    }
  return out.join('; ');
}

const runOne = (label, sc, dc, opts) => {
  globalThis.__reg9 = [];
  globalThis.__pairWhy = undefined;
  globalThis.__pairWhyPt = undefined;
  globalThis.__pairSrc = null;
  let p = null;
  try {
    p = buildLoopBlinnPartitionPair(sc, dc, 'nonzero', opts);
  } catch (e) {
    console.log(`${label}: threw ${e.message}`);
    return;
  }
  if (p) {
    console.log(`${label}: pair ok`);
    return;
  }
  const why = globalThis.__pairWhy,
    P = globalThis.__pairWhyPt;
  console.log(
    `${label}: declined at ${why}${P && (why === 'interior' || why === 'cubicHull') ? ` vertex (${P[0].toFixed(4)}, ${P[1].toFixed(4)}) -> ${classify(P, sc)}` : ''}`,
  );
};

setSdfPrimitivesEnabled(true);
const F0 = await pose(svg('0 0 200 200', ellipsePath(100, 100, 60, 60))),
  F1 = await pose(svg('0 0 200 200', ellipsePath(100, 100, 80, 40)));
runOne('circle -> ellipse', F0, F1);
const S0 = await pose(svg('0 0 40 40', A)),
  S1 = await pose(svg('0 0 40 40', B));
for (const i of [0, 2, 8, 12, 21])
  runOne(`solid cell ${i}`, lerpContours(S0, S1, i / 24), lerpContours(S0, S1, (i + 1) / 24), {
    plainDstRows: true,
  });
