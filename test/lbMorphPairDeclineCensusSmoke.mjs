// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbMorphPairDeclineCensusSmoke — every morph pair decline names its CAUSE, and the dst-frame bail
// is not among the causes.
//
// `buildLoopBlinnPartitionPair` has FORTY `return null`s and every one of them looks the same from
// outside, so "the pair declined" names nothing without a cause. `SLUG_WHY` names the cause for the
// static route one level up (lbBuildCore.js); the pair stamps `lbPairDeclineWhy`. Without it a claim
// about which bail fires ("a dst cubic without a klmn frame abandons the pair") cannot be checked,
// and over the morph corpus that bail fires ZERO times.
//
// WHAT DOES decline those pairs, on this file's own corpus (assets + synthetic + tiger self-pairs
// where that artwork is present):
//
//     sign-flip            the dst cubic's classification differs from the src's
//     source-declined      the SOURCE partition never built, so there is no pair to derive
//     bulge-flip           the control mid crosses its chord between the poses
//     structure            contour / segment counts or types differ
//     steiner-parameter    a crossing-splitter insertion lands at an endpoint on the dst
//
// `unmapped-vertex` -- a source interior vertex the CLIP produced, with no registered destination --
// fires ZERO times: the pair's interior takes the static build's analytic CHAIN route, which re-cuts
// no face, so every interior vertex is a registered point.
//
// This pins the dst-frame causes and `unmapped-vertex` at zero and prints the causes it sees. It
// needs no GPU and no artwork beyond the smoke corpus.
import { buildLoopBlinnPartitionPair, lbPairDeclineWhy } from '../src/renderer/lbPartitionPair.js';
import * as PAIR from '../src/renderer/lbPartitionPair.js';

let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));
const warn = console.warn;
console.warn = () => {};

ok(typeof lbPairDeclineWhy !== 'undefined', 'lbPartitionPair exports lbPairDeclineWhy');

// ── 1. the stamp works, on a case built to decline ───────────────────────────────────────────
{
  const { mkLine, mkCubic } = await import('../src/primitives/seg.js');
  const box = (k) => [
    [
      mkLine([0, 0], [10 * k, 0]),
      mkLine([10 * k, 0], [10 * k, 10]),
      mkLine([10 * k, 10], [0, 10]),
      mkLine([0, 10], [0, 0]),
    ],
  ];
  // A structure mismatch: different segment counts is the one decline nothing can rescue.
  const three = [[mkLine([0, 0], [10, 0]), mkLine([10, 0], [10, 10]), mkLine([10, 10], [0, 0])]];
  const v = buildLoopBlinnPartitionPair(box(1), three, 'nonzero');
  ok(
    v === null && PAIR.lbPairDeclineWhy === 'structure',
    `a segment-count mismatch declines as 'structure' (got ${JSON.stringify(PAIR.lbPairDeclineWhy)})`,
  );
  // ...and a pair that BUILDS leaves no stale cause behind.
  const good = buildLoopBlinnPartitionPair(box(1), box(1.2), 'nonzero');
  ok(!!good, 'a matching pair builds');
  ok(
    PAIR.lbPairDeclineWhy === null,
    `...and reports no decline cause (got ${JSON.stringify(PAIR.lbPairDeclineWhy)})`,
  );
  // A cubic pair, so the dst-frame branch is at least reached by this file's corpus.
  const blob = (r) => [
    [
      mkCubic([100 + r, 100], [100 + r, 100 + 0.55 * r], [100 + 0.55 * r, 100 + r], [100, 100 + r]),
      mkCubic([100, 100 + r], [100 - 0.55 * r, 100 + r], [100 - r, 100 + 0.55 * r], [100 - r, 100]),
      mkCubic([100 - r, 100], [100 - r, 100 - 0.55 * r], [100 - 0.55 * r, 100 - r], [100, 100 - r]),
      mkCubic([100, 100 - r], [100 + 0.55 * r, 100 - r], [100 + r, 100 - 0.55 * r], [100 + r, 100]),
    ],
  ];
  const cub = buildLoopBlinnPartitionPair(blob(40), blob(55), 'nonzero');
  ok(
    !!cub ||
      (PAIR.lbPairDeclineWhy !== 'dst-klmn-frame' && PAIR.lbPairDeclineWhy !== 'dst-bezout-frame'),
    `a cubic blob pair does not decline on a dst frame (${cub ? 'built' : PAIR.lbPairDeclineWhy})`,
  );
}

// ── 2. THE CAUSES, over the morph corpus ─────────────────────────────────────────────────────
{
  const xd = await import('@xmldom/xmldom');
  globalThis.DOMParser = globalThis.DOMParser || xd.DOMParser;
  globalThis.XMLSerializer = globalThis.XMLSerializer || xd.XMLSerializer;
  const { default: importSvg } = await import('../src/svg/importer.js');
  const { parseMetaBin } = await import('../src/core/metaBin.js');
  const { curveRangeToContours } = await import('../src/geom/lbContour.js');
  const { assetPairs, synthPairs, selfPairs } =
    await import('../probes/morphScale/_morphPairs.mjs');
  const pairs = [
    ...(await assetPairs(importSvg, parseMetaBin, curveRangeToContours)),
    ...(await synthPairs(importSvg, parseMetaBin, curveRangeToContours)),
  ];
  // SELF-pairs (one asset against a rotated copy of itself) are where the clip's unmapped vertex
  // lives, and they need artwork the published package does not carry. Included when it is here,
  // and SAID when it is not — a count that silently drops its largest class is worse than none.
  const { existsSync } = await import('fs');
  const { fileURLToPath } = await import('url');
  const pathMod = await import('path');
  const TIGER = pathMod.resolve(
    pathMod.dirname(fileURLToPath(import.meta.url)),
    '../examples/tiger.svg',
  );
  let selfN = 0;
  if (existsSync(TIGER)) {
    // `selfPairs` joins its `file` onto the package ROOT, so it must be given the relative form.
    const sp = await selfPairs(importSvg, parseMetaBin, curveRangeToContours, {
      file: 'examples/tiger.svg',
      step: 4,
    });
    selfN = sp.length;
    pairs.push(...sp);
  } else {
    console.log(
      '  [note] examples/tiger.svg is absent — the SELF-pair class ' +
        '(where `unmapped-vertex` would live) is not in this run',
    );
  }
  ok(pairs.length > 40, `the morph corpus has ${pairs.length} pairs`);
  const census = new Map();
  let built = 0,
    declined = 0,
    unknown = 0;
  for (const p of pairs) {
    let v = null;
    try {
      v = buildLoopBlinnPartitionPair(p.src, p.dst, p.evenOdd ? 'evenodd' : 'nonzero');
    } catch {
      v = null;
    }
    if (v) {
      built++;
      continue;
    }
    declined++;
    const why = PAIR.lbPairDeclineWhy;
    if (!why) unknown++;
    const k = why || '(unstamped)';
    census.set(k, (census.get(k) | 0) + 1);
  }
  console.log(`  [causes] ${pairs.length} pairs: ${built} built, ${declined} declined`);
  for (const [k, n] of [...census].sort((a, b) => b[1] - a[1]))
    console.log(`             ${String(n).padStart(4)}  ${k}`);
  // every decline names itself. An unstamped one is the failure this file exists to catch.
  ok(unknown === 0, `every decline carries a cause (${unknown} unstamped)`);
  // The claim, as a number.
  const frameDeclines = (census.get('dst-klmn-frame') | 0) + (census.get('dst-bezout-frame') | 0);
  ok(
    frameDeclines === 0,
    `"a dst cubic without a klmn frame abandons the pair" fires ${frameDeclines} times`,
  );
  // ...and `unmapped-vertex`, where the corpus can reach it: a SOURCE interior vertex the clip
  // produced with no registered destination, which the chain route (re-cutting no face) does not
  // produce. Pinned only where self-pairs are present, since that is where it would live.
  const unmapped = census.get('unmapped-vertex') | 0;
  if (selfN) {
    ok(
      unmapped === 0,
      `the clip's unmapped vertex declines ${unmapped} of ${declined} pairs over ${selfN} self-pairs — none with the chain route`,
    );
  } else {
    console.log(
      `  [note] unmapped-vertex ${unmapped} of ${declined} declines — not asserted without self-pairs`,
    );
  }
}

console.warn = warn;
console.log(
  fail ? `LB-MORPH-PAIR-DECLINE-CENSUS FAIL (${fail})` : 'LB-MORPH-PAIR-DECLINE-CENSUS OK',
);
process.exit(fail ? 1 : 0);
