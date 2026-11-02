// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bidiBracketsSmoke -- what BidiCharacterTest.txt leaves open and BidiTest.txt catches, and every pair of BidiBrackets.txt: the rule N0
// pairing, read from the generated table, and rule L1 through the characters X9 removes.
import assert from 'node:assert/strict';
import { resolveLevels, BaseDirection } from '../../src/font/bidi.js';
import { bidiMaps } from '../../src/font/unicode/tables/bidiMaps.js';

// Alef, open, bet, close, a, in a left-to-right paragraph: paired, N0 gives the close the bet's direction; unpaired, it sits between R
// and L and takes the embedding. So the level of the close says whether the two paired.
const { bracketKeys, bracketPair, bracketType } = bidiMaps;
let pairs = 0;
for (let i = 0; i < bracketKeys.length; i++) {
  if (bracketType[i] !== 0) continue;
  const levels = resolveLevels(
    [0x5d0, bracketKeys[i], 0x5d1, bracketPair[i], 0x41],
    BaseDirection.Ltr,
  );
  assert.equal(
    levels[3],
    1,
    `U+${bracketKeys[i].toString(16)} pairs with U+${bracketPair[i].toString(16)}`,
  );
  pairs++;
}
assert.ok(pairs >= 64);
console.log('ok', pairs, 'bracket pairs');
const crossed = resolveLevels([0x5d0, 0x298d, 0x5d1, 0x298e, 0x41], BaseDirection.Ltr);
assert.equal(crossed[3], 0, 'U+298D does not pair with U+298E');
console.log('ok a look-alike closer does not pair');

// BidiTest.txt "LRE WS BN": the BN is gone by X9, so the space ends the line and takes the paragraph level.
const LRE = 0x202a,
  RLE = 0x202b,
  SHY = 0xad;
assert.equal(
  resolveLevels([LRE, 0x20, SHY], BaseDirection.Ltr)[1],
  0,
  'whitespace before a boundary neutral at the end of the line',
);
assert.equal(
  resolveLevels([RLE, 0x5d0, 0x20, SHY, 0x2029], BaseDirection.Ltr)[2],
  0,
  'and before a paragraph separator',
);
assert.equal(
  resolveLevels([0x5d0, SHY, 0x5d1], BaseDirection.Rtl)[1] & 1,
  1,
  'a boundary neutral inside the line is left alone',
);
console.log('ok L1 through X9 removals');
