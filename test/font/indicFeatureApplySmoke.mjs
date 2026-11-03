// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// indicFeatureApplySmoke.mjs — verifies GSUB Indic features fire end-
// to-end during textRun shaping. Loads Devanagari Sangam MN and emits
// strings that exercise rphf (reph), then checks the rendered glyph
// count + ids matches what the rphf lookup produces.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';
import { registerIndicShaping } from '../../src/font/scripts/indic.js';
registerIndicShaping();

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

let font = null;
try {
  font = new MantleFontAsset(
    new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Devanagari Sangam MN.ttc')),
  );
  font.getMetrics(0x0915);
} catch (e) {
  console.log('Skip:', e.message);
  process.exit(0);
}

// ----- T1: 'रक' (ra + halant + ka) — rphf collapses ra+halant into reph
// Expected behavior:
//   - rphf ligature fires on (ra, halant) → reph gid
//   - reorder moves the reph (now 1 glyph) to end of syllable
//   - Final glyph order: [ka, reph]
{
  // Use 'र्क' (ra + halant + ka) — full Devanagari reph syllable.
  const { glyphs } = buildSvgTextGlyphs('र्क', font, 0, 0, 100);
  // With rphf firing: 2 glyphs (ka + reph). Without: 3 glyphs (ra, halant, ka).
  if (glyphs.length === 2) {
    // glyph[0] should be ka (codepoint 0x0915), glyph[1] should be the
    // reph (codepoint stays at ra = 0x0930 since ligatures carry the
    // first cp). The order proves both rphf ligature + reorder fired.
    if (glyphs[0].codepoint !== 0x0915)
      fail(`T1 first cp=${glyphs[0].codepoint.toString(16)}, want 0915 (ka)`);
    else if (glyphs[1].codepoint !== 0x0930)
      fail(`T1 second cp=${glyphs[1].codepoint.toString(16)}, want 0930 (ra/reph)`);
    else ok(`T1 'र्क' (reph) → 2 glyphs [ka, reph] — rphf ligature fired + reorder`);
  } else if (glyphs.length === 3) {
    fail(`T1 'र्क' produced 3 glyphs — rphf ligature NOT applied (reorder-only)`);
  } else {
    fail(`T1 'र्क' produced ${glyphs.length} glyphs (unexpected)`);
  }
}

// ----- T2: regression — 'का' (ka + aa-matra) still works ----------
// post-reorder features shouldn't break the basic post-matra case.
{
  const { glyphs } = buildSvgTextGlyphs('का', font, 0, 0, 100);
  if (glyphs.length !== 2) fail(`T2 'का' expected 2 glyphs, got ${glyphs.length}`);
  else if (glyphs[0].codepoint !== 0x0915) fail(`T2 first cp not ka`);
  else if (glyphs[1].codepoint !== 0x093e) fail(`T2 second cp not aa-matra`);
  else ok(`T2 'का' regression: 2 glyphs [ka, aa-matra], identity order`);
}

// ----- T3: pre-base matra 'कि' — pre-reorder no-op + reorder ----
{
  const { glyphs } = buildSvgTextGlyphs('कि', font, 0, 0, 100);
  if (glyphs.length !== 2) fail(`T3 'कि' expected 2 glyphs, got ${glyphs.length}`);
  else if (glyphs[0].codepoint !== 0x093f) fail(`T3 first cp not i-matra`);
  else if (glyphs[1].codepoint !== 0x0915) fail(`T3 second cp not ka`);
  else ok(`T3 'कि' pre-matra: [i, ka] (reorder + pre/post feature pass)`);
}

// ----- T4: reph + pre-matra 'र्कि' (ra+halant+ka+i) ------------
//   Pre-reorder: rphf fires on ra+halant → reph; gid stream becomes
//   [reph, ka, i] (3 glyphs). Then reorder:
//     1. Pre-matra (i, idx 2) moves before base (ka, idx 1): [reph, i, ka]
//     2. Initial reph moves to end: [i, ka, reph]
//   Final visual order: i, ka, reph.
{
  const { glyphs } = buildSvgTextGlyphs('र्कि', font, 0, 0, 100);
  if (glyphs.length !== 3) fail(`T4 'र्कि' expected 3 glyphs (post-rphf), got ${glyphs.length}`);
  else {
    const cps = glyphs.map((g) => g.codepoint);
    if (cps[0] !== 0x093f) fail(`T4 first cp ${cps[0].toString(16)}, want 093f (i)`);
    else if (cps[1] !== 0x0915) fail(`T4 second cp ${cps[1].toString(16)}, want 0915 (ka)`);
    else if (cps[2] !== 0x0930)
      fail(`T4 third cp ${cps[2].toString(16)}, want 0930 (reph from ra)`);
    else ok(`T4 'र्कि' → [i, ka, reph]: pre-reorder rphf + pre-matra move + reph-to-end all fired`);
  }
}

console.log();
console.log(failures === 0 ? 'INDIC-FEATURE-APPLY PASS' : `INDIC-FEATURE-APPLY FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
