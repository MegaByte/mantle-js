// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// rimChainIdentity — the correct fast build's chain builder (lbFastResolve rimChainsFromTris) against the general
// one it specialises (lbFastMesh interiorChainsFromTris): the same chain faces, float for float, on every input
// the correct build hands it, and what each costs.
//
// Inputs are the correct build's own (buildLoopBlinnMesh with `correct`, steps replicated below: resolve, rims,
// rim dedupe, layout, flip triangulation, the flat interior): every shape of MantleSamples/Assets/Mantle and
// fixtures/svg that takes the chain route, as authored and under a 0.1% coherent warp, under its own fill
// rule; and the stream fixtures (lbStreamStaticParitySmoke's road bands and CDT-class shapes, 24 scrolling bands).
// Both builders run on the same arrays, interleaved, so the times compare within one run.
//
//   node probes/lbBuildPaths/rimChainIdentity.mjs          only=substr   LIMIT=n
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS = path.resolve(HERE, '../..');
const REPO = path.resolve(JS, '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { default: importSvg } = await import(path.join(JS, 'src/svg/importer.js'));
const { parseMetaBin } = await import(path.join(JS, 'src/renderer/bundle.js'));
const { buildRims, layoutRims, triangulateLayoutFlip, interiorChainsFromTris, resolveSelfOverlap } =
  await import(path.join(JS, 'src/renderer/lbFastMesh.js'));
const { buildLoopBlinnMesh } = await import(path.join(JS, 'src/renderer/loopBlinn.js'));
const { resolveFastContours, rimChainsFromTris } = await import(
  path.join(JS, 'src/renderer/lbFastResolve.js')
);
const { curveRangeToContours, contoursFromSegs, _setKeyOrigin } = await import(
  path.join(JS, 'src/geom/lbContour.js')
);
const { mkLine, mkQuad, mkCubic } = await import(path.join(JS, 'src/primitives/seg.js'));

/// The correct build's chain-builder input for `contours`, or null where the build does not take the chain route.
function chainInput(contours, fillRule) {
  const m = buildLoopBlinnMesh(contours, true, fillRule, false, true);
  if (!m || (m.fallback && m.fallback.length) || !m.interiorChainA) return null;
  _setKeyOrigin(contours);
  let rs = resolveFastContours(contours, fillRule, true);
  if (rs.decline) {
    const c2 = resolveSelfOverlap(contours, fillRule);
    if (!c2) return null;
    rs = resolveFastContours(c2, fillRule, true, true);
  }
  if (rs.decline) return null;
  const r = buildRims(rs.contours, true, { sides: rs.sides, inFill: rs.inFill });
  r.rims = r.rims.map((rim) =>
    rim.length < 2
      ? rim
      : rim.filter((p, i) => {
          const q = rim[(i + rim.length - 1) % rim.length];
          return p[0] !== q[0] || p[1] !== q[1];
        }),
  );
  const { coords, spans } = layoutRims(r.rims);
  const tris = triangulateLayoutFlip(coords, spans);
  const cc = [],
    tt = [];
  for (const i of tris) {
    const p = coords[i];
    cc.push([Math.fround(p[0]), Math.fround(p[1])]);
    tt.push(tt.length);
  }
  return { contours, cc, tt, edges: r.chainEdges };
}
const same = (a, b) => {
  for (const k of ['chainA', 'chainB', 'chainC', 'chainD', 'chainE']) {
    const x = a[k],
      y = b[k];
    if (x.length !== y.length) return k;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return k;
  }
  if (a.incomplete !== b.incomplete || a.hasChain2 !== b.hasChain2) return 'flags';
  for (let i = 0; i < a.badFaces.length; i++)
    if (a.badFaces[i] !== b.badFaces[i]) return 'badFaces';
  return null;
};
const T = {};
function compare(set, input) {
  const t = T[set] || (T[set] = { n: 0, faces: 0, differ: 0, gen: [], rim: [], ex: [] });
  _setKeyOrigin(input.contours);
  const t0 = performance.now();
  const a = interiorChainsFromTris(input.cc, input.tt, input.edges);
  const t1 = performance.now();
  const b = rimChainsFromTris(input.cc, input.tt, input.edges);
  const t2 = performance.now();
  t.n++;
  t.faces += input.tt.length / 3;
  t.gen.push(t1 - t0);
  t.rim.push(t2 - t1);
  const d = same(a, b);
  if (d) {
    t.differ++;
    if (t.ex.length < 5) t.ex.push(`${input.id} (${d})`);
  }
}
// ---- corpus ----
const files = [];
for (const d of [path.join(REPO, 'MantleSamples/Assets/Mantle'), path.join(REPO, 'fixtures/svg')]) {
  try {
    for (const f of readdirSync(d)) if (f.endsWith('.svg')) files.push(path.join(d, f));
  } catch {
    /* */
  }
}
files.sort();
const list = process.env.ONLY ? files.filter((f) => f.includes(process.env.ONLY)) : files;
let count = 0;
for (const f of list) {
  let sec, pm;
  try {
    sec = await importSvg(readFileSync(f, 'utf8'), { preserveViewport: true });
    pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  } catch {
    continue;
  }
  const gbb = sec.globalBBox;
  if (!gbb || !(gbb[2] > 0)) continue;
  const ext = Math.max(gbb[2], gbb[3]),
    amount = 0.001 * ext,
    k = (2 * Math.PI) / ext,
    curves = new Float32Array(sec.curves);
  for (let s = 0; s < sec.numShapes; s++) {
    if (process.env.LIMIT && count >= +process.env.LIMIT) break;
    const r = sec.curveRangesByShape[s];
    let cs = null;
    try {
      cs = curveRangeToContours(curves, r.begin, r.end);
    } catch {
      cs = null;
    }
    if (!cs || !cs.length) continue;
    const fr = pm.metaFloats[s * (pm.floatsPerShape | 0) + 13] > 0.5 ? 'evenodd' : 'nonzero';
    for (const warp of [false, true]) {
      const c0 = !warp
        ? cs
        : cs.map((c) =>
            c.map((sg, i) => {
              const o = { ...sg };
              delete o.circle;
              if (i === 0) o.subStart = true;
              for (const kk of ['p1', 'p2', 'p3', 'p4']) {
                const p = sg[kk];
                if (Array.isArray(p))
                  o[kk] = [p[0] + amount * Math.sin(p[1] * k), p[1] + amount * Math.cos(p[0] * k)];
              }
              return o;
            }),
          );
      let inp = null;
      try {
        inp = chainInput(c0, fr);
      } catch {
        inp = null;
      }
      if (!inp) continue;
      inp.id = `${path.basename(f)}#${s}${warp ? ' warped' : ''}`;
      compare(warp ? 'corpus warp' : 'corpus', inp);
      count++;
    }
  }
}
// ---- stream fixtures ----
{
  const f32 = (p) => [Math.fround(p[0]), Math.fround(p[1])];
  const L = (a, b) => mkLine(f32(a), f32(b)),
    Q = (a, c, b) => mkQuad(f32(a), f32(c), f32(b)),
    C = (a, c1, c2, b) => mkCubic(f32(a), f32(c1), f32(c2), f32(b));
  const quadEdge = (n, m, f) =>
    Q(n, [2 * m[0] - (n[0] + f[0]) / 2, 2 * m[1] - (n[1] + f[1]) / 2], f);
  const band = (nL, mL, fL, nR, mR, fR) => [
    quadEdge(nL, mL, fL),
    Q(fL, fL, fR),
    quadEdge(fR, mR, nR),
    Q(nR, nR, nL),
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
  const blob = (cx, cy, r, kk) => [
    Q([cx - r, cy], [cx - r, cy - r - kk], [cx, cy - r]),
    Q([cx, cy - r], [cx + r + kk, cy - r], [cx + r, cy]),
    Q([cx + r, cy], [cx + r, cy + r + kk], [cx, cy + r]),
    Q([cx, cy + r], [cx - r - kk, cy + r], [cx - r, cy]),
  ];
  const sq = (x, y, s) => [
    L([x, y], [x + s, y]),
    L([x + s, y], [x + s, y + s]),
    L([x + s, y + s], [x, y + s]),
    L([x, y + s], [x, y]),
  ];
  const shapes = [
    mk(180, 60, 70, 12, 40),
    mk(180, 60, 70, 12, -40),
    mk(120, 55, 30, 10, 45),
    mk(120, 55, 30, 10, -45),
    mk(190, 40, 80, 6, 55),
    mk(190, 40, 80, 6, -55),
    mk(175, 150, 64, 40, 30),
  ];
  for (let t = 0; t < 6; t++)
    for (let kq = 0; kq < 4; kq++) {
      const yN = 190 - kq * 35 - t * 3;
      shapes.push(mk(yN, yN - 30, 70 - kq * 14, 62 - kq * 14, 10 * Math.sin(0.7 * t + kq)));
    }
  for (let t = 0; t < 5; t++) {
    const w = 3 * Math.sin(t),
      v = 2 * Math.cos(1.3 * t);
    shapes.push(
      [
        Q([20, 20 + v], [70 + w, 10], [120, 20]),
        L([120, 20], [120, 40]),
        Q([120, 40], [70 - w, 25 + v], [20, 40]),
        L([20, 40], [20, 20 + v]),
      ],
      [...blob(40 + w, 90, 15, 4), ...blob(95, 90 + v, 12, 3)],
      [
        C([150, 60], [150 + w, 20], [210, 20], [210, 60]),
        C([210, 60], [210, 110 + v], [150, 95], [150, 60]),
      ],
      blob(170 + v, 150, 20, 6 + w),
      [...sq(20 + w, 130, 60), ...sq(35, 145 + v, 30)],
    );
  }
  for (let t = 0; t < 40; t++)
    for (let kq = 0; kq < 24; kq++) {
      const yN = 190 - kq * 7 - t * 0.3;
      shapes.push(mk(yN, yN - 7, 70 - kq * 2.5, 68 - kq * 2.5, 10 * Math.sin(0.07 * t + kq * 0.3)));
    }
  shapes.forEach((segs, i) => {
    const cs = contoursFromSegs(segs);
    const inp = cs && chainInput(cs, 'nonzero');
    if (inp) {
      inp.id = `stream #${i}`;
      compare('stream fixtures', inp);
    }
  });
}
const med = (x) => x.slice().sort((p, q) => p - q)[x.length >> 1] || 0,
  sum = (x) => x.reduce((p, q) => p + q, 0);
for (const [set, t] of Object.entries(T)) {
  console.log(
    `${set.padEnd(16)} ${String(t.n).padStart(5)} meshes ${String(t.faces).padStart(7)} faces  differ ${t.differ}${t.ex.length ? ' -- ' + t.ex.join(', ') : ''}` +
      `  | chain build total ${sum(t.gen).toFixed(0)} ms general, ${sum(t.rim).toFixed(0)} ms specialised (median ${med(t.gen).toFixed(3)} / ${med(t.rim).toFixed(3)} ms)`,
  );
}
process.exit(Object.values(T).some((t) => t.differ) ? 1 : 0);
