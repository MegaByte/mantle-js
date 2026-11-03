// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _denCensus — HOW DEGENERATE IS `den`? The two cross-product divisors of the morph pair.
//
// lbPartitionPair guards both with a bar, and the bar decides whether a morph keeps the analytic
// route or falls to Slug. `den` is a cross product of two edge vectors, so it is an AREA: written
// against a constant it is a different test at every drawing size.
//
// THE UNIT IS NOT THE SHAPE'S EXTENT. Measured against span^2 the dens run from 2^-8 down to
// 2^-64, because a fan triangle's corners are the control points of a CUBIC PIECE and a piece can
// be a thousandth of its shape. Dividing by span^2 therefore prices a small-but-healthy triangle
// as degenerate. What the divisor actually guards is the barycentric weights' conditioning, and
// that depends on the triangle's SHAPE, not its size: |den| = |B-A| |C-A| sin(t), the weights carry
// relative error about 2^-52 / sin(t), and sin(t) is DIMENSIONLESS -- so a bar on it is scale-free
// by construction rather than by calibration.
//
// This reports both: |den| over span^2 (the size reading) and over |B-A||C-A| (the conditioning
// reading), as the exponent e in value = 2^-e, so a bar can be read straight off the distribution.
//
//   node probes/morphScale/_denCensus.mjs        STEP=2  KIND=self,selfMixed,asset,synth,mixed
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src/renderer/lbPartitionPair.js');
const TAGGED = path.resolve(HERE, '../../src/renderer/_zzDenPartitionPair.mjs');
// Record and never bail, so one run sees every den the builder would have evaluated rather than
// only the ones before its first refusal. The two sites carry different edge vectors, so each gets
// its own normalizer; the bar's spelling differs between the trees, hence the alternation.
const BAR = '(1e-18|emD9\\.fuzz|denBar9\\([^)]*\\))';
let body = readFileSync(SRC, 'utf8')
  .replace(
    new RegExp(`if \\(Math\\.abs\\(den\\) < ${BAR}\\) return null;\\n(\\s*)const t = `),
    "if ((globalThis.__den9.push(['steiner', Math.abs(den), Math.hypot(rx, ry), Math.hypot(sx, sy)]), false)) return null;\n$2const t = ",
  )
  .replace(
    new RegExp(`if \\(Math\\.abs\\(den\\) < ${BAR}\\) return null;`),
    "if ((globalThis.__den9.push(['fanTri', Math.abs(den), Math.hypot(B9[0] - A9[0], B9[1] - A9[1]), Math.hypot(C9[0] - A9[0], C9[1] - A9[1])]), false)) return null;",
  );
if (body.includes('return null;\n      const rowsAt')) body = body; // (the fanTri site is the one before rowsAt)
writeFileSync(TAGGED, body);
process.on('exit', () => {
  try {
    unlinkSync(TAGGED);
  } catch {
    /* already gone */
  }
});

const { default: importSvg } = await import('../../src/svg/importer.js');
const { parseMetaBin } = await import('../../src/core/metaBin.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { SEG_LINE, SEG_QUAD, SEG_CUBIC, mkLine, mkQuad, mkCubic, mkRQuad } =
  await import('../../src/primitives/seg.js');
const { assetPairs, synthPairs, selfPairs } = await import('./_morphPairs.mjs');
const { buildLoopBlinnPartitionPair } = await import(pathToFileURL(TAGGED).href);

const KINDS = new Set((process.env.KIND || 'asset,synth,mixed,self,selfMixed').split(','));
const STEP = +(process.env.STEP || 2);
const SELF = process.env.SELF || '../MantleSamples/Assets/Mantle/tiger.svg';
const _warn = console.warn;
console.warn = () => {};

/// _setKeyOrigin's rule, read-only (lbContour's emUnitsOf, restated so this probe runs on both trees).
function spanOf(contours) {
  let ox = Infinity,
    oy = Infinity,
    ox1 = -Infinity,
    oy1 = -Infinity;
  for (const c of contours)
    for (const s of c) {
      if (!s) continue;
      for (const p of [s.p1, s.p2, s.p3, s.p4]) {
        if (!p) continue;
        if (p[0] < ox) ox = p[0];
        if (p[0] > ox1) ox1 = p[0];
        if (p[1] < oy) oy = p[1];
        if (p[1] > oy1) oy1 = p[1];
      }
    }
  const x0 = isFinite(ox) ? ox : 0,
    y0 = isFinite(oy) ? oy : 0;
  const diag = Math.hypot((isFinite(ox1) ? ox1 : 1) - x0, (isFinite(oy1) ? oy1 : 1) - y0);
  return 65536 / (diag > 0 ? Math.pow(2, Math.round(Math.log2(65536 / diag))) : 64);
}
const scaleContours = (cs, S) =>
  cs.map((c) =>
    c.map((sg) => {
      const P = (q) => q && [q[0] * S, q[1] * S];
      if (sg.type === SEG_LINE) return mkLine(P(sg.p1), P(sg.p2), sg.is_fill_only);
      if (sg.type === SEG_QUAD) return mkQuad(P(sg.p1), P(sg.p2), P(sg.p3));
      if (sg.type === SEG_CUBIC) return mkCubic(P(sg.p1), P(sg.p2), P(sg.p3), P(sg.p4));
      const c0 = sg.circle;
      return mkRQuad(
        P(sg.p1),
        P(sg.p2),
        P(sg.p3),
        sg.w,
        c0 ? { cx: c0.cx * S, cy: c0.cy * S, r: c0.r * S } : null,
      );
    }),
  );

const pairs = [
  ...(await assetPairs(importSvg, parseMetaBin, curveRangeToContours)),
  ...(await synthPairs(importSvg, parseMetaBin, curveRangeToContours)),
  ...(SELF !== 'none'
    ? await selfPairs(importSvg, parseMetaBin, curveRangeToContours, { file: SELF, step: STEP })
    : []),
].filter((p) => KINDS.has(p.kind));

const recs = []; // { site, den, L1, L2, span, pair }
for (const p of pairs) {
  globalThis.__den9 = [];
  try {
    buildLoopBlinnPartitionPair(
      scaleContours(p.src, 1),
      scaleContours(p.dst, 1),
      p.evenOdd ? 'evenodd' : 'nonzero',
    );
  } catch {
    /* the bail is what is being measured */
  }
  const span = spanOf(p.dst);
  for (const [site, den, L1, L2] of globalThis.__den9)
    recs.push({ site, den, L1, L2, span, pair: `${p.kind}/${p.name}` });
}
console.warn = _warn;
console.log(`${pairs.length} pairs, ${recs.length} dens evaluated`);
const e2 = (v) => (v > 0 ? Math.round(-Math.log2(v)) : 999);
for (const site of ['fanTri', 'steiner']) {
  const rs = recs.filter((r) => r.site === site);
  if (!rs.length) {
    console.log(`== ${site}: none ==`);
    continue;
  }
  console.log(`== ${site}: ${rs.length} ==`);
  for (const [label, f] of [
    ['|den| / span^2', (r) => r.den / (r.span * r.span)],
    ['sin(t) = |den| / (|B-A||C-A|)', (r) => (r.L1 > 0 && r.L2 > 0 ? r.den / (r.L1 * r.L2) : 0)],
  ]) {
    const h = new Map();
    for (const r of rs) {
      const e = e2(f(r));
      h.set(e, (h.get(e) | 0) + 1);
    }
    const es = [...h.keys()].sort((a, b) => a - b);
    console.log(`  -- ${label}: min 2^-${es[es.length - 1]}, max 2^-${es[0]}`);
    for (const bar of [26, 32, 40, 44, 48, 52, 56, 60, 64, 74]) {
      let below = 0;
      for (const e of es) if (e > bar) below += h.get(e);
      const pr = new Set(rs.filter((r) => e2(f(r)) > bar).map((r) => r.pair)).size;
      console.log(
        `       bar 2^-${String(bar).padStart(2)}: ${String(below).padStart(4)} dens / ${String(pr).padStart(3)} pairs below`,
      );
    }
  }
  const sorted = rs.slice().sort((a, b) => a.den / (a.L1 * a.L2) - b.den / (b.L1 * b.L2));
  console.log('  worst-conditioned:');
  for (const r of sorted.slice(0, 8))
    console.log(
      `     sin=2^-${e2(r.den / (r.L1 * r.L2))}  den/span^2=2^-${e2(r.den / (r.span * r.span))}  L=${r.L1.toExponential(2)},${r.L2.toExponential(2)}  ${r.pair}`,
    );
}
