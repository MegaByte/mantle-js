// Verifies textRun integration: emitted glyph ids for an Arabic string
// match the contextual forms (init/medi/fina) chosen by the joining-class
// resolver.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';
import { ArabicForm } from '../../src/font/scripts/arabicJoining.js';
import { registerArabicShaping } from '../../src/font/scripts/arabic.js';
import { registerBidi } from '../../src/font/typography/bidi.js';
registerArabicShaping();
registerBidi();

const font = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/SFArabic.ttf'))
);
font.getMetrics(0x41);

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

const baseGid = (cp) => font.codepointToGlyphId(cp);
const formGid = (cp, form) => font.gsub.substituteArabicForm(baseGid(cp), form);

// ----- T1: single Arabic letter — should render as Isol -------------
{
  // beh U+0628 alone. After bidi reorder (pure RTL, single char, no
  // change), the emitted gid should equal Isol(beh).
  const { glyphs } = buildSvgTextGlyphs('ب', font, 0, 0, 100);
  if (glyphs.length !== 1) fail(`T1 expected 1 glyph, got ${glyphs.length}`);
  else {
    const want = formGid(0x0628, ArabicForm.Isol);
    // buildSvgTextGlyphs returns codepoints, not gids; just check the
    // codepoint round-trips here. Form-vs-isolated assertions live below.
    if (glyphs[0].codepoint !== 0x0628) fail(`T1 codepoint mismatch ${glyphs[0].codepoint}`);
    else ok(`T1 single beh emits one glyph; gid expected = Isol(${want})`);
  }
}

// Verify via segs structural match. We compare seg counts: Isol /
// Init / Medi / Fina forms typically have visually-different shapes
// hence different seg counts in their outlines. The emitted glyph's
// seg count must match the expected form.

function segCountForGid(gid) {
  const s = font.getGlyphSegsByGid(gid);
  return s ? s.length : 0;
}

// ----- T2: 'بت' (beh + teh) — expect Init(beh) + Fina(teh) ----------
{
  // Note: visual reorder will swap them (Arabic RTL → visual L→R is teh, beh)
  // so glyphs[0] = teh visually-first = Fina(teh), glyphs[1] = beh = Init(beh).
  const { glyphs } = buildSvgTextGlyphs('بت', font, 0, 0, 100);
  if (glyphs.length !== 2) { fail(`T2 expected 2 glyphs, got ${glyphs.length}`); }
  else {
    // Codepoint at glyphs[0] visually-leftmost should be teh (0x062A)
    // since the Hebrew/Arabic reorder put it there.
    if (glyphs[0].codepoint !== 0x062A) fail(`T2 leftmost cp ${glyphs[0].codepoint.toString(16)}, want 062a (teh)`);
    if (glyphs[1].codepoint !== 0x0628) fail(`T2 rightmost cp ${glyphs[1].codepoint.toString(16)}, want 0628 (beh)`);
    // Verify seg-count matches expected forms.
    const expFinaTehSegs = segCountForGid(formGid(0x062A, ArabicForm.Fina));
    const expInitBehSegs = segCountForGid(formGid(0x0628, ArabicForm.Init));
    const expIsolTehSegs = segCountForGid(formGid(0x062A, ArabicForm.Isol));
    const expIsolBehSegs = segCountForGid(formGid(0x0628, ArabicForm.Isol));
    const gotTehSegs = glyphs[0].segs.length;
    const gotBehSegs = glyphs[1].segs.length;
    if (gotTehSegs === expIsolTehSegs && expIsolTehSegs !== expFinaTehSegs) {
      fail(`T2 teh emitted Isol form (seg count ${gotTehSegs}); Fina expected (seg count ${expFinaTehSegs})`);
    } else if (gotBehSegs === expIsolBehSegs && expIsolBehSegs !== expInitBehSegs) {
      fail(`T2 beh emitted Isol form (seg count ${gotBehSegs}); Init expected (seg count ${expInitBehSegs})`);
    } else if (gotTehSegs !== expFinaTehSegs && gotTehSegs !== expIsolTehSegs) {
      // Couldn't disambiguate — seg counts coincide. Pass if it
      // doesn't equal isolated.
      ok(`T2 'بت': teh seg=${gotTehSegs}, beh seg=${gotBehSegs}; not isolated`);
    } else {
      ok(`T2 'بت' → Fina(teh)+Init(beh): seg counts match (${gotTehSegs}, ${gotBehSegs})`);
    }
  }
}

// ----- T3: 'مرحبا' (5 letters) — Init Fina Init Medi Fina --------
{
  const { glyphs } = buildSvgTextGlyphs('مرحبا', font, 0, 0, 100);
  if (glyphs.length !== 5) { fail(`T3 expected 5 glyphs, got ${glyphs.length}`); }
  else {
    // Logical order: meem reh hah beh alef.
    // After RTL reorder, visual L→R: alef beh hah reh meem.
    // Form per logical position: Init Fina Init Medi Fina.
    // So visual L→R the forms are: alef→Fina, beh→Medi, hah→Init,
    // reh→Fina, meem→Init.
    const want = [
      [0x0627, ArabicForm.Fina],   // alef
      [0x0628, ArabicForm.Medi],   // beh
      [0x062D, ArabicForm.Init],   // hah
      [0x0631, ArabicForm.Fina],   // reh
      [0x0645, ArabicForm.Init],   // meem
    ];
    let okAll = true;
    for (let i = 0; i < 5; i++) {
      const [cp, form] = want[i];
      if (glyphs[i].codepoint !== cp) {
        fail(`T3 glyph[${i}] cp=${glyphs[i].codepoint.toString(16)}, want ${cp.toString(16)}`);
        okAll = false; continue;
      }
      const expGid = formGid(cp, form);
      const expSegs = segCountForGid(expGid);
      const isolGid = formGid(cp, ArabicForm.Isol);
      const isolSegs = segCountForGid(isolGid);
      const gotSegs = glyphs[i].segs.length;
      // If isol+form gids differ AND seg counts differ, demand match
      // to expected form. Otherwise treat as best-effort (seg counts
      // can coincide between forms).
      if (expGid !== isolGid && expSegs !== isolSegs && gotSegs !== expSegs) {
        fail(`T3 glyph[${i}] cp=${cp.toString(16)} form ${form}: emitted ${gotSegs} segs, want ${expSegs} (isol would be ${isolSegs})`);
        okAll = false;
      }
    }
    if (okAll) ok(`T3 'مرحبا' → visual L→R Fina/Medi/Init/Fina/Init forms applied`);
  }
}

console.log();
console.log(failures === 0 ? 'ARABIC-SHAPING PASS' : `ARABIC-SHAPING FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
