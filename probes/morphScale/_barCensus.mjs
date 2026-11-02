// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _barCensus — every GUARDED QUANTITY in the morph-pair builder, in its own natural unit.
//
// The morph-pair builder's five length/area sites (and the two `den` divisors beside them) each test a
// quantity against a bar. Replacing a constant is only half the job: the replacement has to be
// the unit the quantity is actually IN, and the coefficient has to be the one that keeps the decision
// the tuned size already made. This measures the distributions so both can be read off rather than
// guessed.
//
// Per site, the quantity and the unit it is measured in here:
//   fanTri   |den| of the dst fan triangle      sin(t) = |den| / (|B-A| |C-A|)   -- conditioning
//   steiner  |den| of two crossing dst edges    sin(t) = |den| / (|r| |s|)
//   crS/crD  chord x control-mid, per pose      sin(t) = |cr| / (|chord| |cm|)   -- sidedness
//   nlD      the dst piece's normal length      nlD / |chord| and nlD / dstSpan
//   chordD   the dst piece's chord              chordD / dstSpan
//   sagD     an invisible dst quad's sagitta    sagD / dstSpan
//   idxOf    |src control point - fan corner|   d / srcSpan
// A SIN IS DIMENSIONLESS, so a bar on it is scale-free with no calibration at all; a ratio to the
// pose's own span is scale-free too, and is what emEps/emFuzz already are.
//
//   node probes/morphScale/_barCensus.mjs       STEP=2  KIND=...
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src/renderer/lbPartitionPair.js');
const TAGGED = path.resolve(HERE, '../../src/renderer/_zzBarPartitionPair.mjs');
// The bar's spelling differs between an absolute-bar tree and this one, so each pattern accepts both.
const rec = (s) => `globalThis.__bar9.push(${s})`;
let body = readFileSync(SRC, 'utf8');
const sub = (re, to) => {
  const b = body.replace(re, to);
  if (b === body) console.error('MISS ' + re);
  body = b;
};
sub(
  /if \(Math\.abs\(den\) < [^)]*\)\) return null;\n(\s*)const t = /,
  `if ((${rec("['steiner', Math.abs(den), Math.hypot(rx, ry) * Math.hypot(sx, sy)]")}, false)) return null;\n$1const t = `,
);
sub(
  /if \(Math\.abs\(den\) < [^;]*\) return null;\n(\s*)const rowsAt/,
  `if ((${rec("['fanTri', Math.abs(den), Math.hypot(B9[0] - A9[0], B9[1] - A9[1]) * Math.hypot(C9[0] - A9[0], C9[1] - A9[1])]")}, false)) return null;\n$1const rowsAt`,
);
sub(
  /if \(nlD < [^;]*\|\| chordD < [^;]*\) return null;/,
  `if ((${rec("['invisNl', nlD, 1], ['invisChord', chordD, 1]")}, false)) return null;`,
);
sub(
  /if \(nlD < [^;]*\) return null;(\s*\/\/[^\n]*)?\n(\s*)const offD = 0\.25/,
  `if ((${rec("['sagD', nlD, 1]")}, false)) return null;\n$2const offD = 0.25`,
);
sub(
  /if \(Math\.abs\(crS\) > [^&]*&& Math\.abs\(crD\) > [^&]*&& \(crS > 0\) !== \(crD > 0\)\) return null;/,
  `if ((${rec("['crS', Math.abs(crS), Math.hypot(chSx, chSy) * Math.hypot(cmSx, cmSy)], ['crD', Math.abs(crD), Math.hypot(chDx, chDy) * Math.hypot(cmDx, cmDy)]")}, false)) return null;`,
);
sub(
  /if \(nlD > [^&]*&& chordD > [^)]*\) \{/,
  `if ((${rec("['visNl', nlD, 1], ['visChord', chordD, 1]")}, true)) {`,
);
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

const recs = [];
for (const p of pairs) {
  globalThis.__bar9 = [];
  try {
    buildLoopBlinnPartitionPair(
      scaleContours(p.src, 1),
      scaleContours(p.dst, 1),
      p.evenOdd ? 'evenodd' : 'nonzero',
    );
  } catch {
    /* the bail is what is measured */
  }
  const sS = spanOf(p.src),
    sD = spanOf(p.dst);
  for (const [site, v, norm] of globalThis.__bar9)
    recs.push({
      site,
      v,
      rel: norm === 1 ? v / sD : norm > 0 ? v / norm : 0,
      pair: `${p.kind}/${p.name}`,
    });
}
console.warn = _warn;
const e2 = (x) => (x > 0 ? Math.round(-Math.log2(x)) : 999);
console.log(`${pairs.length} pairs, ${recs.length} samples`);
for (const site of [
  'fanTri',
  'steiner',
  'crS',
  'crD',
  'invisNl',
  'invisChord',
  'visNl',
  'visChord',
  'sagD',
]) {
  const rs = recs.filter((r) => r.site === site);
  if (!rs.length) {
    console.log(`  ${site.padEnd(11)} none`);
    continue;
  }
  const h = new Map();
  for (const r of rs) {
    const e = e2(r.rel);
    h.set(e, (h.get(e) | 0) + 1);
  }
  const es = [...h.keys()].sort((a, b) => a - b);
  const bars = [16, 20, 24, 32, 40, 44, 48, 52].map((b) => {
    let below = 0;
    for (const e of es) if (e > b) below += h.get(e);
    return `2^-${b}:${below}`;
  });
  console.log(
    `  ${site.padEnd(11)} n=${String(rs.length).padStart(4)}  min 2^-${es[es.length - 1]}  max 2^-${es[0]}   below ${bars.join(' ')}`,
  );
}
