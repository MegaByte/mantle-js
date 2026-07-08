// Jamo dispatch + NFC modern Hangul.
//   T1: NFC pre-pass normalizes (L V T) jamo → precomposed syllable
//       BEFORE textRun's per-codepoint stream builds. Modern Korean
//       reaches the layout loop as single codepoints in U+AC00..U+D7A3.
//   T2: Capability bit hasHangulJamoForms is false for fonts without
//       ljmo/vjmo/tjmo features. Substitution is a no-op.
//   T3: textRun handles a precomposed Korean string end-to-end (via
//       cmap → glyph segs → bundle).

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

// AppleGothic.ttf is the canonical Korean font on macOS.
let font;
try {
  font = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/AppleGothic.ttf')));
  font.getMetrics(0xAC01);
} catch (e) {
  console.log('Skip (no AppleGothic):', e.message);
  process.exit(0);
}

// ----- T1: NFC composes 3-jamo at the source --------------------
{
  // Decomposed: L=ᄀ + V=ᅡ + T=ᆨ → precomposed 각 (U+AC01)
  const decomp = '각';
  const nfc = decomp.normalize('NFC');
  if (nfc.length !== 1) fail(`T1 NFC didn't compose: len=${nfc.length}`);
  else if (nfc.codePointAt(0) !== 0xAC01) fail(`T1 NFC wrong cp: U+${nfc.codePointAt(0).toString(16)}`);
  else ok(`T1 NFC composes (L,V,T) → U+AC01 (modern path)`);
}

// ----- T2: AppleGothic has no jamo features ----------------------
{
  const gsub = font.gsub;
  // AppleGothic has no GSUB at all; this is the normative "no
  // features" branch.
  const has = gsub.hasHangulJamoForms;
  // hasHangulJamoForms returns falsy when no lookup arrays exist.
  if (has) fail(`T2 AppleGothic unexpectedly has jamo features (got ${has})`);
  else {
    // substituteHangulJamo must no-op.
    const gid = font.codepointToGlyphId(0x1100);
    const subbed = gsub.substituteHangulJamo(gid, 0);
    if (subbed !== gid) fail(`T2 no-op broken: ${gid} → ${subbed}`);
    else ok(`T2 hasHangulJamoForms=false + substituteHangulJamo no-op`);
  }
}

// ----- T3: precomposed Korean renders end-to-end ----------------------
{
  // '한' (han) U+D55C. Should pull a glyph from cmap and emit
  // exactly 1 entry.
  const { glyphs } = buildSvgTextGlyphs('한', font, 0, 0, 100);
  if (glyphs.length !== 1) fail(`T3 '한' expected 1 glyph, got ${glyphs.length}`);
  else if (glyphs[0].codepoint !== 0xD55C) fail(`T3 cp ${glyphs[0].codepoint.toString(16)} != d55c`);
  else if (glyphs[0].segs.length === 0) fail(`T3 '한' produced 0 segs (cmap miss?)`);
  else ok(`T3 '한' precomposed: 1 glyph, ${glyphs[0].segs.length} segs, advance=${glyphs[0].advance.toFixed(2)}px`);
}

// ----- T4: jamo-only string (no NFC composition) lands as 3 cps ------
{
  // If a user feeds raw jamo without NFC normalization upstream,
  // textRun's normalize() inside the per-span loop catches it.
  // Verify the precomposed form still wins.
  const decomp = '각';  // ᄀ + ᅡ + ᆨ
  const { glyphs } = buildSvgTextGlyphs(decomp, font, 0, 0, 100);
  // After NFC, this becomes 1 codepoint U+AC01 → 1 glyph.
  if (glyphs.length !== 1) fail(`T4 decomp jamo expected 1 glyph (NFC composes), got ${glyphs.length}`);
  else if (glyphs[0].codepoint !== 0xAC01) fail(`T4 cp ${glyphs[0].codepoint.toString(16)} != ac01`);
  else ok(`T4 raw jamo (L+V+T) → NFC composes upstream → 1 precomposed glyph`);
}

console.log();
console.log(failures === 0 ? 'HANGUL-SHAPING PASS' : `HANGUL-SHAPING FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
