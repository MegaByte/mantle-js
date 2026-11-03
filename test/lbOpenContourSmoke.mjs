// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbOpenContourSmoke — the Loop-Blinn fill builders close an open contour as SVG fills a path.
//
// The importer closes every subpath of a FILLED path. An open contour reaches the fill builders only from a row whose
// fill is none (the path of its stroke), and there a winding is not defined: it depends on the ray. The builder's ink
// probe and its winding tree (which reads a far contour as closed) can disagree, and so can three ray directions, so
// the pieces of such a row would take sides that no single reading of the path agrees with.
//
// CHOSEN: such a row's fill is the region SVG would fill -- the path closed by a straight line back to its start. It is
// the region an override that raised the row's fill opacity would paint, the same closure the importer applies to a
// filled path, and it is one answer for every ray. (A row with no fill is still built; whether it is painted is the
// paint's business, not the geometry's.)
//
// No GPU:
//   - closeOpenContours returns the same array for closed contours and appends the closing line to an open one;
//   - on rows with an open contour, every cubic piece reads the side the CLOSED path's winding
//     gives it (three ray directions agreeing either side of its arc).
//     The fetched fixture is always tried. Optional SVGs in examples/local/, or MANTLE_LOCAL_SVG, are
//     included when present.
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const LC = await import('../src/geom/lbContour.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { mkLine, mkCubic, SEG_LINE, SEG_CUBIC } = await import('../src/primitives/seg.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};

// the closure, written here independently of the one under test
const endOf = (g) => (g.type === SEG_LINE ? g.p2 : g.type === SEG_CUBIC ? g.p4 : g.p3);
const closeHere = (C) =>
  C.map((c) => {
    const a = c[0].p1,
      e = endOf(c[c.length - 1]);
    return a[0] === e[0] && a[1] === e[1] ? c : c.concat([mkLine(e, a)]);
  });

// ── closeOpenContours ─────────────────────────────────────────────────────────────────────────────
{
  const close = LC.closeOpenContours;
  ok(typeof close === 'function', 'lbContour exports closeOpenContours');
  if (typeof close === 'function') {
    const closed = [[mkLine([0, 0], [10, 0]), mkLine([10, 0], [10, 10]), mkLine([10, 10], [0, 0])]];
    const open = [[mkLine([0, 0], [10, 0]), mkCubic([10, 0], [12, 4], [8, 8], [5, 10])]];
    const c = close(open),
      last = c[0][c[0].length - 1];
    ok(
      close(closed) === closed &&
        c !== open &&
        c[0].length === 3 &&
        last.type === SEG_LINE &&
        last.p1[0] === 5 &&
        last.p1[1] === 10 &&
        last.p2[0] === 0 &&
        last.p2[1] === 0,
      'closed contours come back as the same array; an open one gains the line from its end to its start',
    );
  }
}

// ── the rows with an open contour ─────────────────────────────────────────────────────────────────
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
  let rows = 0,
    pieces = 0,
    wrong = 0;
  const files = [new URL('../examples/tiger.svg', import.meta.url)];
  const localDir = fileURLToPath(new URL('../examples/local/', import.meta.url));
  if (existsSync(localDir)) {
    for (const name of readdirSync(localDir)) {
      if (name.toLowerCase().endsWith('.svg')) files.push(path.join(localDir, name));
    }
  }
  if (process.env.MANTLE_LOCAL_SVG) files.push(process.env.MANTLE_LOCAL_SVG);
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const bun = await importSvg(text),
      pm = parseMetaBin(bun.meta, bun.metaFloatsPerShape),
      mst = pm.floatsPerShape,
      meta = pm.metaFloats;
    const cf = new Float32Array(bun.curves);
    for (let s = 0; s < bun.numShapes; s++) {
      const r = bun.curveRangesByShape[s];
      let Cs;
      try {
        Cs = LC.curveRangeToContours(cf, r.begin, r.end);
      } catch {
        continue;
      }
      const closed = closeHere(Cs);
      if (closed.every((c, i) => c === Cs[i])) continue;
      rows++;
      const eo = meta[s * mst + 13] > 0.5;
      let b = null;
      try {
        b = buildLbShape(Cs, false, eo);
      } catch {
        b = null;
      }
      if (!b || !b.raw || !b.raw.cubicRecs9) continue;
      const segs = closed.flat(),
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
          const w = LC.rayWindingDir(
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
        if (l.some((v) => v !== l[0]) || rr.some((v) => v !== rr[0]) || l[0] === rr[0]) continue;
        pieces++;
        if (q.inkLeft9 !== l[0]) wrong++;
      }
    }
  }
  ok(
    rows > 0 && pieces > 0 && wrong === 0,
    `${rows} rows with an open contour: ${wrong} of ${pieces} cubic pieces read their side reversed against the closed path`,
  );
}

console.warn = warn;
console.log(fail ? `LB-OPEN-CONTOUR FAIL (${fail})` : 'LB-OPEN-CONTOUR PASS');
process.exit(fail ? 1 : 0);
