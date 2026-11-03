// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// The extrapolation bound, over every morph pair in the corpus.
//
// The tail defect is that a segment's DRAW range can lie outside its BUILD range, where the
// implicit is linearly extrapolated. `_tailWindow` shows the drift there is real (an oracle that
// saturates at a quarter chord cannot see it) and that a hard clamp trades a wild segment's error
// for a mild one's. This asks the only question that matters for a shipped rule: is there ONE
// bound that is never worse and usually much better, over every morph the corpus has?
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import(ROOT + '/src/svg/importer.js');
const { curveRangeToContours } = await import(ROOT + '/src/geom/lbContour.js');
const { segmentPartitionPairMorph } = await import(ROOT + '/src/renderer/loopBlinnMorph.js');
const { pairImplicitDrift } = await import(ROOT + '/src/renderer/lbPartitionPair.js');

async function contoursOf(file) {
  const b = await importSvg(readFileSync(path.join(ROOT, file), 'utf8'), {
    preserveViewport: true,
  });
  const c = new Float32Array(b.curves),
    out = [];
  for (let s = 0; s < b.numShapes; s++) {
    const r = b.curveRangesByShape[s];
    if (r) out.push(curveRangeToContours(c, r.begin, r.end));
  }
  return out;
}

const PAIRS = [];
for (const f of (await import('fs')).readdirSync(path.join(ROOT, 'examples/smoke'))) {
  const m = /^(.*)__SRC\.svg$/.exec(f) || /^(.*)__POSE_A\.svg$/.exec(f);
  if (!m) continue;
  const dst = f.includes('__SRC') ? f.replace('__SRC', '__DST') : f.replace('__POSE_A', '__POSE_B');
  if (existsSync(path.join(ROOT, 'examples/smoke', dst)))
    PAIRS.push([m[1], 'examples/smoke/' + f, 'examples/smoke/' + dst]);
}
const BOUNDS = [0, 0.05, 0.1, 0.15, 0.25, 0.5, 1, Infinity];
const WIDE = 16;
const tally = BOUNDS.map(() => ({ worst: 0, sum: 0, n: 0 }));
let segsSeen = 0,
  overSeen = 0,
  assets = 0,
  skipped = 0;
const perAsset = [];

for (const [name, sf, df] of PAIRS) {
  let SRC, DST;
  const RULE = /fill-rule\s*=\s*["']?evenodd/.test(readFileSync(path.join(ROOT, sf), 'utf8'))
    ? 'evenodd'
    : 'nonzero';
  try {
    SRC = await contoursOf(sf);
    DST = await contoursOf(df);
  } catch {
    skipped++;
    continue;
  }
  if (!SRC.length || SRC.length !== DST.length) {
    skipped++;
    continue;
  }
  let any = false;
  for (let si = 0; si < SRC.length; si++) {
    // THE ASSET'S own FILL RULE. Trying nonzero first and keeping whatever segments reads
    // lbMorphEvenOdd -- an even-odd fixture -- as nonzero, and gives a drift of 1.9e-1 against
    // the 3.5e-1 its real rule gives. A different rule is a different partition, so it is a
    // different measurement wearing the same asset's name.
    let segs = null;
    try {
      segs = segmentPartitionPairMorph(SRC[si], DST[si], RULE);
    } catch {
      segs = null;
    }
    // A morph that never flips gets no segmentation at all (`!flips.length` -> null): one pair
    // spans [0, 1], nothing is drawn outside a build range, and the tail cannot exist. Those are
    // not skips, they are the assets this defect does not reach.
    if (!segs) continue;
    any = true;
    segsSeen += segs.length;
    for (const g of segs) {
      const span = g.tHiB - g.tLoB;
      if (!(span > 1e-9)) continue;
      const o = Math.max(g.tLoB - g.tLo, 0) + Math.max(g.tHi - g.tHiB, 0);
      if (!(o > 1e-9)) continue;
      overSeen++;
      const uLo = (g.tLo - g.tLoB) / span,
        uHi = (g.tHi - g.tLoB) / span;
      BOUNDS.forEach((b, bi) => {
        const opt = Number.isFinite(b) ? { limFrac: WIDE, clamp: [-b, 1 + b] } : { limFrac: WIDE };
        let d = 0;
        try {
          d = pairImplicitDrift(g.pair.src, g.pair.dst, uLo, uHi, null, opt);
        } catch {
          d = 0;
        }
        const t = tally[bi];
        if (d > t.worst) t.worst = d;
        t.sum += d;
        t.n++;
      });
      perAsset.push({ name, uLo, uHi });
    }
  }
  if (any) assets++;
}

console.log(
  `morph pairs ${PAIRS.length}, of which FLIP (segmented) ${assets}, unreadable ${skipped}`,
);
console.log(
  'a morph with no flip has one pair over all of [0,1] and no tail — not a skip, just out of reach',
);
console.log(`segments ${segsSeen}, of which OVERSHOOTING ${overSeen}\n`);
if (!overSeen) {
  console.log('no overshooting segment in the corpus — nothing to bound');
  process.exit(0);
}
console.log('  bound |    worst drift |     mean drift');
BOUNDS.forEach((b, i) => {
  const t = tally[i];
  console.log(
    `  ${String(Number.isFinite(b) ? b : 'none').padStart(5)} | ${t.worst.toExponential(4).padStart(14)} | ${(t.sum / t.n).toExponential(4).padStart(14)}`,
  );
});
const fin = BOUNDS.map((b, i) => ({ b, ...tally[i] })).filter((r) => Number.isFinite(r.b));
const best = fin.slice().sort((a, b2) => a.worst - b2.worst)[0];
const none = tally[BOUNDS.length - 1];
console.log(
  `\n  BEST bound ${best.b}: worst ${best.worst.toExponential(3)} against unbounded ${none.worst.toExponential(3)} (${(none.worst / best.worst).toFixed(1)}x)`,
);
console.log(`  overshooting segments by asset:`);
const byA = {};
for (const r of perAsset) byA[r.name] = (byA[r.name] || 0) + 1;
for (const k of Object.keys(byA).sort()) console.log(`    ${k.padEnd(34)} ${byA[k]}`);
