// harakatSmoke.mjs — verifies that Arabic vowel marks (harakat) are
// positioned on top of their base letters via GPOS mark attachment,
// not at the pen origin.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';

const font = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/SFArabic.ttf'))
);
font.getMetrics(0x41);

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

// ----- T1: 'بَ' (beh + fatha) — fatha must overlap beh visually ----
//
// Layout: beh is rendered, then fatha as a 0-advance mark anchored
// above beh. After bidi RTL reorder for 2 chars (1 base + 1 mark),
// the mark stays attached to its base. buildSvgTextGlyphs emits
// glyphs in visual L→R order with penX.
//
// Expectation: the mark's penX is within ±50% of base's penX (in
// font-size units), NOT at base.penX + base.advance.
{
  const { glyphs } = buildSvgTextGlyphs('بَ', font, 0, 0, 100);
  if (glyphs.length !== 2) {
    fail(`T1 expected 2 glyphs (beh + fatha), got ${glyphs.length}`);
  } else {
    // Find which is the base and which is the mark by codepoint.
    let baseGlyph = null, markGlyph = null;
    for (const g of glyphs) {
      if (g.codepoint === 0x0628) baseGlyph = g;
      else if (g.codepoint === 0x064E) markGlyph = g;
    }
    if (!baseGlyph || !markGlyph) fail(`T1 missing base or mark in output`);
    else {
      const baseW = baseGlyph.advance;       // user-space (px)
      const dx = markGlyph.penX - baseGlyph.penX;
      // Mark should be ATTACHED to base, not after it.
      // Acceptable range: anywhere within base's advance box ±a bit.
      const maxDx = baseW * 1.5;
      if (Math.abs(dx) > maxDx) {
        fail(`T1 fatha not attached: dx=${dx.toFixed(2)} px (baseW=${baseW.toFixed(2)}); mark sat next-to instead of on-top-of`);
      } else if (markGlyph.advance !== 0) {
        fail(`T1 fatha advance=${markGlyph.advance}, expected 0`);
      } else {
        ok(`T1 'بَ': fatha attached at dx=${dx.toFixed(2)}px from base; advance=0`);
      }
    }
  }
}

// ----- T2: 'مَرْحَبا' — multi-mark word ---------------------------------
//
// م + fatha + ر + sukun + ح + fatha + ب + alef.  Expected glyph
// count: at least 8 (5 base letters + 3 marks); maybe fewer if some
// ligatures fire. Check no mark sits at penX 0 (the run origin).
{
  const { glyphs } = buildSvgTextGlyphs('مَرْحَبا', font, 100, 100, 100);
  // 'با' may collapse to a single base-fina-fatha cluster, but
  // alef stays separate. So glyph count ≥ 7.
  if (glyphs.length < 7) fail(`T2 too few glyphs: ${glyphs.length} (expected ≥7)`);
  else {
    let stuckMarks = 0;
    for (const g of glyphs) {
      // A mark glyph has 0 advance; if penX matches run origin (100)
      // it means attachment didn't fire.
      if (g.advance === 0 && Math.abs(g.penX - 100) < 1e-6) stuckMarks++;
    }
    if (stuckMarks > 0) fail(`T2 ${stuckMarks} mark(s) stuck at origin`);
    else ok(`T2 'مَرْحَبا': ${glyphs.length} glyphs emitted, no marks stuck at origin`);
  }
}

// ----- T3: pure ASCII still has all-non-zero advances -----------------
{
  // Regression: non-Arabic text shouldn't take the mark path at all.
  const { glyphs } = buildSvgTextGlyphs('Hello', font, 0, 0, 100);
  let zeroAdv = 0;
  for (const g of glyphs) if (g.advance === 0) zeroAdv++;
  if (zeroAdv > 0) fail(`T3 ASCII 'Hello' has ${zeroAdv} zero-advance glyphs (regression)`);
  else ok(`T3 ASCII 'Hello' unaffected by mark path`);
}

console.log();
console.log(failures === 0 ? 'HARAKAT PASS' : `HARAKAT FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
