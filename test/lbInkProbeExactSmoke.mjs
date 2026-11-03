// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbInkProbeExactSmoke — the Loop-Blinn builder's ink probe is an exact side test.
//
// The partition builder decides which side of every curve piece is ink with a winding probe a hair off the arc: 0.01 of
// the piece's chord. A winding taken on a ray cast 1e-5 of the SHAPE's extent above the probe point (so that no ray runs
// through a vertex) fails on a piece under a thousandth of its shape: the nudge is longer than the probe's offset, the ray
// crosses the piece's own arc, and the probe reads the far side, so the piece's side, its crescent's sign and its chain
// all come out reversed. Tiger has such pieces.
//
// So the probe takes the winding at the point itself, for a ray infinitesimally above it (lbContour.js
// raySegCrossExact): a symbolic perturbation that decides the ties the nudge existed for -- a vertex, a horizontal run or
// an extremum at the ray's height -- with exact comparisons, and no length anywhere.
//
// No GPU:
//   - the exact side test agrees with a ray walk at every probe the walk can decide (two ray directions agreeing), on
//     random closed contours of every segment type, and at probes level with a vertex, where the unnudged walk ties;
//   - it gives the same answers at 2^-20, 1 and 2^20;
//   - a half-unit bump on a 1000-unit square reads its ink side right, keeps its crescent, and builds the same at the
//     three scales -- a nudged probe reads the bump's side reversed and drops both of its crescent faces;
//   - on tiger, every cubic piece whose side the exact winding can decide (three ray directions agreeing, either side of
//     its arc) carries that side.
import { readFileSync } from 'fs';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const C = await import('../src/geom/lbContour.js');
const { mkLine, mkQuad, mkCubic, mkRQuad } = await import('../src/primitives/seg.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};
const exact = typeof C.rayWindingExact === 'function' ? C.rayWindingExact : null;
ok(!!exact, 'lbContour exports the exact side test (rayWindingExact)');

// ── the side test against a ray walk, and across scales ───────────────────────────────────────────
if (exact) {
  let seed = 7;
  const r = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  const contour = (s) => {
    const k = 3 + Math.floor(r() * 4),
      pts = Array.from({ length: k }, () => [r() * 10, r() * 10]);
    const P = (p) => [p[0] * s, p[1] * s],
      c = () => [r() * 10, r() * 10];
    return {
      pts,
      segs: pts.map((p, i) => {
        const q = pts[(i + 1) % k],
          t = r();
        return t < 0.25
          ? mkLine(P(p), P(q))
          : t < 0.5
            ? mkQuad(P(p), P(c()), P(q))
            : t < 0.75
              ? mkCubic(P(p), P(c()), P(c()), P(q))
              : mkRQuad(P(p), P(c()), P(q), 0.3 + r() * 2);
      }),
    };
  };
  let n = 0,
    bad = 0,
    nV = 0,
    badV = 0;
  for (let it = 0; it < 1500; it++) {
    const { pts, segs } = contour(1);
    for (let j = 0; j < 10; j++) {
      const x = r() * 12 - 1,
        y = r() * 12 - 1,
        a = C.rayWinding(segs, x, y + 1e-9),
        b = C.rayWindingDir(segs, x, y + 1e-9, 0.6, 0.8);
      if (a === b) {
        n++;
        if (exact(segs, x, y) !== a) bad++;
      }
      const v = pts[Math.floor(r() * pts.length)],
        xv = v[0] - 1 - r() * 3; // level with a vertex, left of it
      const av = C.rayWinding(segs, xv, v[1] + 1e-9),
        bv = C.rayWindingDir(segs, xv, v[1] + 1e-9, 0.6, 0.8);
      if (av === bv) {
        nV++;
        if (exact(segs, xv, v[1]) !== av) badV++;
      }
    }
  }
  ok(
    bad === 0 && badV === 0 && n > 10000 && nV > 10000,
    `it agrees with the ray walk: ${bad} of ${n} generic probes and ${badV} of ${nV} level with a vertex differ`,
  );
  let sBad = 0,
    sN = 0;
  for (let it = 0; it < 400; it++) {
    const save = seed,
      A = contour(1);
    for (let j = 0; j < 5; j++) {
      const v = A.pts[j % A.pts.length],
        x = j & 1 ? r() * 12 - 1 : v[0] - 2,
        y = j & 1 ? r() * 12 - 1 : v[1];
      const w = [2 ** -20, 1, 2 ** 20].map((s) => {
        const after = seed;
        seed = save;
        const B = contour(s);
        seed = after;
        return exact(B.segs, x * s, y * s);
      });
      sN++;
      if (w[0] !== w[1] || w[1] !== w[2]) sBad++;
    }
  }
  ok(sBad === 0, `the same answers at 2^-20, 1 and 2^20 (${sBad} of ${sN} probes differ)`);
}

// ── a half-unit bump on a 1000-unit square ────────────────────────────────────────────────────────
// The square's top edge runs +x at y = 0 with its ink below (+y); the bump bows to -y, into the air, so its control side
// is air. A nudged probe stands 0.005 above the bump's arc and casts its ray 0.01 below that: inside the square.
{
  const at = [];
  for (const k of [-20, 0, 20]) {
    const s = 2 ** k,
      P = (x, y) => [x * s, y * s];
    const Cs = [
      [
        mkLine(P(0, 0), P(400, 0)),
        mkCubic(P(400, 0), P(400.1, -0.08), P(400.4, -0.08), P(400.5, 0)),
        mkLine(P(400.5, 0), P(1000, 0)),
        mkLine(P(1000, 0), P(1000, 1000)),
        mkLine(P(1000, 1000), P(0, 1000)),
        mkLine(P(0, 1000), P(0, 0)),
      ],
    ];
    const b = buildLbShape(Cs, false, false),
      recs = (b && b.raw && b.raw.cubicRecs9) || [];
    at.push({
      k,
      sides: recs.map((q) => q.inkLeft9).join(','),
      signs: recs.map((q) => q.sign).join(','),
      faces: b ? b.raw.cubics.length : 0,
    });
  }
  const one = at[1];
  ok(
    one.sides.length > 0 && one.sides.split(',').every((v) => v === 'true') && one.faces > 0,
    `the bump reads its ink on its left (sides ${one.sides}), and keeps its crescent (${one.faces} faces, signs ${one.signs})`,
  );
  ok(
    at.every((a) => a.sides === one.sides && a.signs === one.signs && a.faces === one.faces),
    `...the same at 2^-20, 1 and 2^20 (${at.map((a) => `2^${a.k}: ${a.sides} / ${a.faces} faces`).join('; ')})`,
  );
}

// ── tiger: every cubic piece whose side the winding can decide carries it ───────────────────────────
{
  const B3 = (P, t) => {
    const u = 1 - t;
    return [0, 1].map(
      (k) =>
        u * u * u * P[0][k] +
        3 * u * u * t * P[1][k] +
        3 * u * t * t * P[2][k] +
        t * t * t * P[3][k],
    );
  };
  const D3 = (P, t) => {
    const u = 1 - t;
    return [0, 1].map(
      (k) =>
        3 *
        (u * u * (P[1][k] - P[0][k]) +
          2 * u * t * (P[2][k] - P[1][k]) +
          t * t * (P[3][k] - P[2][k])),
    );
  };
  const bun = await importSvg(
    readFileSync(new URL('../examples/tiger.svg', import.meta.url), 'utf8'),
  );
  const pm = parseMetaBin(bun.meta, bun.metaFloatsPerShape),
    mst = pm.floatsPerShape,
    meta = pm.metaFloats,
    cf = new Float32Array(bun.curves);
  let pieces = 0,
    wrong = 0,
    small = 0,
    open = 0;
  for (let s = 0; s < bun.numShapes; s++) {
    const r = bun.curveRangesByShape[s];
    let Cs;
    try {
      Cs = C.curveRangeToContours(cf, r.begin, r.end);
    } catch {
      continue;
    }
    const eo = meta[s * mst + 13] > 0.5;
    let b = null;
    try {
      b = buildLbShape(Cs, false, eo);
    } catch {
      b = null;
    }
    if (!b || !b.raw || !b.raw.cubicRecs9) continue;
    const segs = (C.closeOpenContours ? C.closeOpenContours(Cs) : Cs).flat(); // the builder fills the path closed
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (const g of segs)
      for (const q of [g.p1, g.p2, g.p3, g.p4])
        if (q) {
          x0 = Math.min(x0, q[0]);
          x1 = Math.max(x1, q[0]);
          y0 = Math.min(y0, q[1]);
          y1 = Math.max(y1, q[1]);
        }
    const ext = Math.max(x1 - x0, y1 - y0),
      seen = new Set();
    for (const q of b.raw.cubicRecs9) {
      if (seen.has(q.pid) || q.inkLeft9 == null || q.invis9) continue;
      seen.add(q.pid);
      const cp = q.cp,
        m = B3(cp, 0.5),
        T = D3(cp, 0.5),
        L = Math.hypot(T[0], T[1]),
        ch = Math.hypot(cp[3][0] - cp[0][0], cp[3][1] - cp[0][1]);
      if (!(L > 0 && ch > 0)) continue;
      const ink = (f, dx, dy) => {
        const w = C.rayWindingDir(
          segs,
          m[0] - (T[1] / L) * f * ch,
          m[1] + (T[0] / L) * f * ch,
          dx,
          dy,
        );
        return eo ? (w & 1) === 1 : w !== 0;
      };
      const l = [ink(0.01, 0.6, 0.8), ink(0.01, -0.8, 0.6), ink(0.01, 1, 0)],
        rr = [ink(-0.01, 0.6, 0.8), ink(-0.01, -0.8, 0.6), ink(-0.01, 1, 0)];
      // An OPEN contour's winding depends on the ray, and a feature thinner than the probe reads ink on both sides: no truth.
      if (l.some((v) => v !== l[0]) || rr.some((v) => v !== rr[0]) || l[0] === rr[0]) {
        open++;
        continue;
      }
      pieces++;
      if (0.01 * ch < 1e-5 * ext) small++;
      if (q.inkLeft9 !== l[0]) wrong++;
    }
  }
  ok(
    pieces > 4000 && wrong === 0,
    `tiger: ${wrong} of ${pieces} cubic pieces read their ink side reversed (${small} of them under a thousandth of ` +
      `their shape, where a nudge would outrun the probe; ${open} with no determinate side)`,
  );
}

console.warn = warn;
console.log(fail ? `LB-INK-PROBE-EXACT FAIL (${fail})` : 'LB-INK-PROBE-EXACT PASS');
process.exit(fail ? 1 : 0);
