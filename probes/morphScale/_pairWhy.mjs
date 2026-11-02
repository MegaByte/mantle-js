// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _pairWhy — WHICH `return null` in the morph-pair builder fired, per pair and per exponent.
//
// _zzMorphScale says a pair that built at scale 1 declined at 2^k. It cannot say WHICH test decided
// that, and on a builder with sixty bail-outs the difference between "the cubic hull guard" and "the
// klmn control-point match" is the difference between a diagnosis and a guess. This is _morphPairDiag's
// idiom widened to the scale corpus: a line-tagged copy of lbPartitionPair.js records the source line
// of every `return null` before taking it, so a decline is reported as a FILE:LINE.
//
// The tagged copy is written beside the original (so its relative imports resolve) and deleted on
// exit. It is a copy, so a bail inside a function the copy imports -- lbPartition's pair-side quad
// hull split, say -- is reported as the call site in this file, which is what the tally then says.
//
//   node probes/morphScale/_pairWhy.mjs        KS=-20,-16,...  KIND=self,selfMixed  STEP=4
//   PLAIN=1 (the { plainDstRows: true } attempt)   ROWS=60
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src/renderer/lbPartitionPair.js');
const TAGGED = path.resolve(HERE, '../../src/renderer/_zzTaggedPartitionPair.mjs');
writeFileSync(
  TAGGED,
  readFileSync(SRC, 'utf8')
    .split('\n')
    .map((l, i) => l.replace(/return null;/g, `return (globalThis.__pairWhy = ${i + 1}, null);`))
    .join('\n'),
);
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

const KS = (process.env.KS || '-20,-16,-12,-8,8,12,16,20').split(',').map(Number);
const KINDS = new Set((process.env.KIND || 'asset,synth,mixed,self,selfMixed').split(','));
const STEP = +(process.env.STEP || 4);
const SELF = process.env.SELF || '../MantleSamples/Assets/Mantle/tiger.svg';
const OPTS = process.env.PLAIN ? { plainDstRows: true } : undefined;
const _warn = console.warn;
console.warn = () => {};

const f32 = new Float32Array(1);
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

const run = (p, S) => {
  globalThis.__pairWhy = undefined;
  let v = null;
  try {
    v = buildLoopBlinnPartitionPair(
      scaleContours(p.src, S),
      scaleContours(p.dst, S),
      p.evenOdd ? 'evenodd' : 'nonzero',
      OPTS,
    );
  } catch (e) {
    return { why: 'THREW ' + String((e && e.message) || e).slice(0, 60) };
  }
  return v ? null : { why: 'lbPartitionPair.js:' + (globalThis.__pairWhy || '?') };
};

const tally = {}; // 'k|line' -> count
const at1 = {}; // the scale-1 decline histogram, for the scale-1 survey
const rows = [];
const base1 = [];
let base = 0;
for (const p of pairs) {
  const r1 = run(p, 1);
  if (r1) {
    base++;
    at1[r1.why] = (at1[r1.why] | 0) + 1;
    base1.push(`${p.kind}/${p.name} -> ${r1.why}`);
    continue;
  }
  for (const k of KS) {
    const r = run(p, 2 ** k);
    if (!r) continue;
    const key = k + '|' + r.why;
    tally[key] = (tally[key] | 0) + 1;
    rows.push(`2^${k} ${p.kind}/${p.name} -> ${r.why}`);
  }
}
console.warn = _warn;
console.log(`${pairs.length} pairs, ${base} declined at scale 1 (excluded)`);
console.log(`  scale-1 declines by site: ${JSON.stringify(at1)}`);
if (process.env.BASE1) {
  const { writeFileSync: W } = await import('fs');
  W(process.env.BASE1, base1.sort().join('\n') + '\n');
}
const byK = {};
for (const [key, n] of Object.entries(tally)) {
  const [k, why] = key.split('|');
  (byK[k] ||= {})[why] = n;
}
for (const k of KS) if (byK[k]) console.log(`  2^${k}: ${JSON.stringify(byK[k])}`);
for (const r of rows.slice(0, +(process.env.ROWS || 40))) console.log('    ' + r);
console.log(`${rows.length} scale-induced declines`);
if (f32) {
  /* keep the import used */
}
