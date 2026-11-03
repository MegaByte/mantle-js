#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// lbCanonicalHashesSmoke — multi-frame hash must match per-frame lbCanonicalHash.
import { lbCanonicalFrame, lbCanonicalHash, lbCanonicalHashes } from '../src/renderer/lbPack.js';
import { SEG_LINE, SEG_QUAD } from '../src/primitives/seg.js';

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL', msg);
    process.exit(1);
  }
}
function ok(msg) {
  console.log('ok', msg);
}

const square = [
  [
    { type: SEG_LINE, p1: [0, 0], p2: [10, 0] },
    { type: SEG_LINE, p1: [10, 0], p2: [10, 10] },
    { type: SEG_LINE, p1: [10, 10], p2: [0, 10] },
    { type: SEG_LINE, p1: [0, 10], p2: [0, 0] },
  ],
];

const fr = lbCanonicalFrame(square);
assert(fr, 'frame for square');
const solo = lbCanonicalHash(square, fr);
const multi = lbCanonicalHashes(square, [fr]);
assert(multi[0] === solo, 'single-frame hashes match (' + solo + ')');
ok('single frame');

if (fr.cands && fr.cands.length) {
  const frames = [fr, ...fr.cands];
  const keys = lbCanonicalHashes(square, frames);
  for (let i = 0; i < frames.length; i++) {
    const expect = lbCanonicalHash(square, frames[i]);
    assert(keys[i] === expect, 'cand ' + i + ' match');
  }
  ok('cands (' + fr.cands.length + ')');
} else {
  // Force a near-rect with multiple farthest points so cands fire.
  const nearRect = [
    [
      { type: SEG_LINE, p1: [0, 0], p2: [100, 0] },
      { type: SEG_LINE, p1: [100, 0], p2: [100, 50] },
      { type: SEG_LINE, p1: [100, 50], p2: [0, 50] },
      { type: SEG_LINE, p1: [0, 50], p2: [0, 0] },
    ],
  ];
  const fr2 = lbCanonicalFrame(nearRect);
  assert(fr2, 'near-rect frame');
  const frames = fr2.cands ? [fr2, ...fr2.cands] : [fr2];
  const keys = lbCanonicalHashes(nearRect, frames);
  for (let i = 0; i < frames.length; i++) {
    assert(keys[i] === lbCanonicalHash(nearRect, frames[i]), 'near-rect cand ' + i);
  }
  ok('near-rect (' + frames.length + ' frames)');
}

const curved = [
  [
    { type: SEG_QUAD, p1: [0, 0], p2: [5, 8], p3: [10, 0] },
    { type: SEG_LINE, p1: [10, 0], p2: [0, 0] },
  ],
];
const fr3 = lbCanonicalFrame(curved);
assert(fr3, 'curved frame');
assert(lbCanonicalHashes(curved, [fr3])[0] === lbCanonicalHash(curved, fr3), 'curved match');
ok('curved');

console.log('LB-CANONICAL-HASHES PASS');
