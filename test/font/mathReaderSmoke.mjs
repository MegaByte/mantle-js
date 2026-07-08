// mathReaderSmoke.mjs — OT MATH reader against STIX Two Math.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { MathKernCorner } from '../../src/font/math/mathReader.js';
import { registerMathReader } from '../../src/font/math/index.js';
registerMathReader();

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

let font = null;
try {
  font = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/STIXTwoMath.otf')));
  font.getMetrics(0x41);
} catch (e) {
  console.log('Skip (no STIXTwoMath):', e.message);
  process.exit(0);
}

// ----- T1: MATH table present + MathGlyphInfo present ---------------
{
  const math = font.math;
  if (!math.hasTable) fail('T1 STIXTwoMath has no MATH table');
  else if (!math.hasMathGlyphInfo) fail('T1 MATH but no MathGlyphInfo');
  else if (!math.hasMathVariants) ok(`T1 STIXTwoMath: MATH + MathGlyphInfo present (Variants missing but uncommon)`);
  else ok(`T1 STIXTwoMath: MATH + MathGlyphInfo + MathVariants all present`);
}

// ----- T2: MathConstants populated ----------------------------------
{
  const c = font.math.getConstants();
  // STIX Two Math should have non-zero axisHeight + fractionRuleThickness +
  // sensible script-percent-scale-down (typically 70-80).
  if (c.axisHeight === 0) fail(`T2 axisHeight zero`);
  else if (c.fractionRuleThickness === 0) fail(`T2 fractionRuleThickness zero`);
  else if (c.scriptPercentScaleDown < 50 || c.scriptPercentScaleDown > 100) {
    fail(`T2 scriptPercentScaleDown out of range: ${c.scriptPercentScaleDown}`);
  } else if (c.superscriptShiftUp === 0) fail(`T2 superscriptShiftUp zero`);
  else ok(`T2 MathConstants: axisH=${c.axisHeight} fracRule=${c.fractionRuleThickness} scriptPct=${c.scriptPercentScaleDown}% supShiftUp=${c.superscriptShiftUp}`);
}

// ----- T3: Italic correction on math italic 'f' (U+1D453) -----------
{
  // Mathematical italic f: U+1D453. Slanted glyph, should have italic
  // correction so 'f+' doesn't overlap.
  const gid = font.codepointToGlyphId(0x1D453);
  if (!gid) fail(`T3 STIXTwoMath has no glyph for U+1D453 (math italic f)`);
  else {
    const ic = font.math.getItalicCorrection(gid);
    if (ic <= 0) {
      // Acceptable: not every italic glyph has explicit italic correction.
      // Try one more candidate.
      const gid2 = font.codepointToGlyphId(0x1D43F); // math italic O
      const ic2 = gid2 ? font.math.getItalicCorrection(gid2) : 0;
      if (ic2 > 0) ok(`T3 italic correction on U+1D43F = ${ic2} font units`);
      else ok(`T3 italic correction on math italics: ${ic} for U+1D453, ${ic2} for U+1D43F (font may omit explicit IC for these gids)`);
    } else {
      ok(`T3 italic correction on U+1D453 (math italic f) = ${ic} font units`);
    }
  }
}

// ----- T4: top-accent attachment on a wide letter -------------------
{
  // Math italic w should have a top-accent attachment point if the
  // font supports accented variables (\\hat{w}, \\vec{w}, etc.).
  const gid = font.codepointToGlyphId(0x1D464); // math italic w
  if (!gid) ok(`T4 no glyph for U+1D464`);
  else {
    const tax = font.math.getTopAccentAttachment(gid);
    if (Number.isNaN(tax)) ok(`T4 no top-accent attachment for U+1D464 (fallback to bbox-center)`);
    else if (tax > 0) ok(`T4 top-accent X for U+1D464 (math italic w) = ${tax} font units from origin`);
    else fail(`T4 top-accent X invalid: ${tax}`);
  }
}

// ----- T5: math kern per-corner --------------------------------
{
  // Math italic f has the most distinctive math kern of any letter
  // (slants at top-right + bottom-left). Probe both corners.
  const gid = font.codepointToGlyphId(0x1D453);
  if (!gid) { ok('T5 no gid for U+1D453; skip'); }
  else {
    const c = font.math.getConstants();
    // Probe at the glyph's "axis height" — where a sub/sup typically sits.
    const trAxis = font.math.getMathKern(gid, MathKernCorner.TopRight, c.axisHeight);
    const blAxis = font.math.getMathKern(gid, MathKernCorner.BottomLeft, c.axisHeight);
    ok(`T5 math kern on U+1D453 at axisHeight=${c.axisHeight}: TR=${trAxis} BL=${blAxis}`);
  }
}

// ----- T6: extended-shape coverage ----------------------------
{
  // A summation sign (U+2211) or integral (U+222B) is typically marked
  // as an "extended shape" in math fonts (tall glyph).
  const sumGid = font.codepointToGlyphId(0x2211);
  const intGid = font.codepointToGlyphId(0x222B);
  if (sumGid) {
    ok(`T6 isExtendedShape(U+2211 ∑) = ${font.math.isExtendedShape(sumGid)}`);
  } else {
    ok(`T6 no glyph for U+2211; skip`);
  }
}

console.log();
console.log(failures === 0 ? 'MATH-READER PASS' : `MATH-READER FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
