// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// defaultIgnorableSmoke.mjs — Unicode Default_Ignorable_Code_Point glyphs
// must render as zero-advance, zero-ink (HarfBuzz parity), never as a
// `.notdef` tofu box.
//
// Asserts that inserting a variation selector / ZWSP / ZWJ / soft hyphen /
// word-joiner / BOM / TAG between two letters changes neither the emitted
// shape count nor the line advance versus the bare pair.
//
// Uses Arial (CI-portable). Skip when absent.

import { readFileSync, existsSync } from 'fs';
import { MantleFontAsset, buildTextRun } from '../../src/font/index.js';
import { isDefaultIgnorable } from '../../src/font/defaultIgnorable.js';

const fontPath = ['/System/Library/Fonts/Supplemental/Arial.ttf', process.env.MANTLE_FONT]
  .filter(Boolean)
  .find((p) => existsSync(p));
if (!fontPath) {
  console.log('Skip defaultIgnorable: no Arial');
  process.exit(0);
}
const font = new MantleFontAsset(new Uint8Array(readFileSync(fontPath)));

let failures = 0;
const fail = (m) => {
  console.error('FAIL', m);
  failures++;
};
const ok = (m) => console.log('ok', m);

// ---- T1: predicate covers the canonical members + rejects normal text ----
for (const cp of [0x00ad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfe0f, 0xfeff, 0xe0100, 0x180b]) {
  if (!isDefaultIgnorable(cp)) fail(`T1 U+${cp.toString(16)} should be default-ignorable`);
}
for (const cp of [0x41, 0x20, 0x2e, 0xfe10, 0x1f300]) {
  if (isDefaultIgnorable(cp)) fail(`T1 U+${cp.toString(16)} should NOT be default-ignorable`);
}
if (!failures) ok('T1 default-ignorable predicate membership');

// ---- T2: ignorables add no shape and no advance ----
const base = await buildTextRun('AB', font, [0, 0, 0, 1]);
const baseShapes = base.numShapes;
const baseAdv = base.lastLineAdvance;
const cases = {
  'VS16 U+FE0F': 'A️B',
  'ZWSP U+200B': 'A​B',
  'ZWJ U+200D': 'A‍B',
  'soft-hyphen U+00AD': 'A­B',
  'word-joiner U+2060': 'A⁠B',
  'BOM U+FEFF': 'A﻿B',
  'TAG U+E0041': 'A\u{E0041}B',
};
for (const [label, text] of Object.entries(cases)) {
  const b = await buildTextRun(text, font, [0, 0, 0, 1]);
  if (b.numShapes !== baseShapes)
    fail(`T2 ${label}: numShapes ${b.numShapes} != ${baseShapes} (tofu leaked?)`);
  else if (Math.abs(b.lastLineAdvance - baseAdv) > 1e-6)
    fail(`T2 ${label}: advance ${b.lastLineAdvance} != ${baseAdv}`);
  else ok(`T2 ${label}: hidden (shapes=${baseShapes}, advance unchanged)`);
}

console.log(failures ? `\nDEFAULT-IGNORABLE FAIL (${failures})` : '\nDEFAULT-IGNORABLE PASS');
process.exit(failures ? 1 : 0);
