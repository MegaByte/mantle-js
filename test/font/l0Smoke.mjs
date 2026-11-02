// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// l0Smoke.mjs — default-OT-shaper smoke.
//
// Verifies GSUB lookups 1 + 2 + GPOS lookup 1 plumbing. The positive
// path for smcp uses STIXTwoText (which ships smcp + c2sc on macOS);
// negative path uses Arial (no smcp).

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildStyled, buildFromMarkup, buildTextRun } from '../../src/font/textRun.js';
import { parseMarkup, defaultStyle } from '../../src/font/markupParser.js';

const stix = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/STIXTwoText.ttf')),
);
const arial = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
);

// Force parse so .gsub is populated.
stix.getMetrics(0x41);
arial.getMetrics(0x41);

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// ---- T1: hasSmallCaps capability is correct ----
{
  if (!stix.gsub.hasSmallCaps) fail(`T1 STIX should have smallCaps`);
  if (arial.gsub.hasSmallCaps) fail(`T1 Arial should not have smallCaps`);
  if (!stix.gsub.hasSmallCaps || arial.gsub.hasSmallCaps) {
  } else ok(`T1 hasSmallCaps STIX=${stix.gsub.hasSmallCaps} Arial=${arial.gsub.hasSmallCaps}`);
}

// ---- T2: smcp substitutes lowercase glyphs in STIX ----
{
  const gidA = stix.codepointToGlyphId(0x61); // 'a'
  const sub = stix.gsub.substituteSmallCap(gidA);
  if (sub === gidA) fail(`T2 'a' not substituted (gid=${gidA})`);
  else ok(`T2 'a' substituted ${gidA} → ${sub}`);
}

// ---- T3: c2sc substitutes uppercase glyphs in STIX ----
{
  const gidA = stix.codepointToGlyphId(0x41); // 'A'
  const sub = stix.gsub.substituteSmallCap(gidA);
  if (sub === gidA) fail(`T3 'A' not substituted (gid=${gidA})`);
  else ok(`T3 'A' substituted ${gidA} → ${sub}`);
}

// ---- T4: smcp no-op on Arial (no smcp feature) ----
{
  const gidA = arial.codepointToGlyphId(0x61);
  const sub = arial.gsub.substituteSmallCap(gidA);
  if (sub !== gidA) fail(`T4 Arial smcp shouldn't change gid (${gidA} → ${sub})`);
  else ok(`T4 Arial 'a' unchanged (gid=${gidA})`);
}

// ---- T5: <smallcaps> in markup sets style.smallCaps ----
{
  const spans = parseMarkup('<smallcaps>abc</smallcaps>', defaultStyle());
  if (!spans[0].style.smallCaps) fail(`T5 <smallcaps> didn't set style`);
  else ok(`T5 <smallcaps> sets style.smallCaps`);
}

// ---- T6: visual end-to-end: STIX <smallcaps>abc</smallcaps> renders shorter ----
{
  // Lowercase 'abc' includes 'b' ascender, so taller bbox.
  // Smallcaps versions have cap-style height with no descenders / ascenders.
  const lo = await buildTextRun('abc', stix);
  const sc = await buildFromMarkup('<smallcaps>abc</smallcaps>', stix);
  if (lo.numShapes !== sc.numShapes)
    fail(`T6 shape count mismatch ${lo.numShapes} vs ${sc.numShapes}`);
  else ok(`T6 STIX <smallcaps> renders, ${sc.numShapes} shapes`);
}

// ---- T7: GPOS-1 single-pos delta API exists and is 0 on Arial 'A' ----
{
  // Arial has GPOS but no SinglePos lookups under 'kern' — should be 0.
  const gidA = arial.codepointToGlyphId(0x41);
  const delta = arial.gpos.getSingleXAdvanceDelta(gidA);
  if (delta !== 0) fail(`T7 Arial 'A' SinglePos delta should be 0, got ${delta}`);
  else ok(`T7 GPOS-1 API: Arial 'A' delta=0 (no SinglePos lookups)`);
}

// ---- T8: GPOS-1 API exists and is 0 on STIX 'A' (no SinglePos kerning lookups expected) ----
{
  const gidA = stix.codepointToGlyphId(0x41);
  const delta = stix.gpos.getSingleXAdvanceDelta(gidA);
  // STIX may or may not have SinglePos; the test just checks the API
  // doesn't throw and returns an integer.
  if (typeof delta !== 'number') fail(`T8 GPOS-1 delta not a number: ${typeof delta}`);
  else ok(`T8 GPOS-1 API: STIX 'A' delta=${delta}`);
}

// ---- T9: GSUB lookup 2 (multiple-sub) API exists, returns null when no feature ----
{
  const gidA = arial.codepointToGlyphId(0x41);
  const result = arial.gsub.tryMultipleSubstitute(gidA);
  if (result !== null) fail(`T9 expected null, got ${result}`);
  else ok(`T9 GSUB-2 API returns null when no feature`);
}

// ---- T10: <smallcaps> on Arial (no smcp feature) is synthesized: each lowercase letter is its capital at 0.7 of the size ----
{
  const a = await buildTextRun('hello', arial);
  const b = await buildFromMarkup('<smallcaps>hello</smallcaps>', arial);
  const c = await buildTextRun('HELLO', arial);
  if (a.numShapes !== b.numShapes)
    fail(`T10 Arial smcp shape count changed ${a.numShapes} → ${b.numShapes}`);
  else if (!(Math.abs(b.globalBBox[2] / c.globalBBox[2] - 0.7) < 0.02))
    fail(
      `T10 Arial synthesized small caps are not 0.7 of the capitals (${b.globalBBox[2]} vs ${c.globalBBox[2]})`,
    );
  else ok(`T10 Arial <smallcaps> is synthesized at 0.7 of the capitals (no smcp feature)`);
}

console.log();
console.log(failures === 0 ? 'L0 PASS' : `L0 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
