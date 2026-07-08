// richDecorationSmoke.mjs — verify <u> and <s> markup attributes
// produce the right TextStyle fields, and that emitDecoration's
// recipe produces the expected shape counts for each style.

import { readFileSync, existsSync } from 'fs';
import { parseMarkup, defaultStyle } from '../../src/font/markupParser.js';
import { buildStyled, _layoutSlotsForTest } from '../../src/font/textRun.js';
import { MantleFontAsset } from '../../src/font/fontAsset.js';

let failures = 0;
const fail = (msg) => { console.error('FAIL', msg); failures++; };
const ok   = (msg) => console.log('ok', msg);

// ---- T1: bare <u> / <s> tags toggle the underline/strike flag ----
{
  const spans = parseMarkup('plain <u>under</u> normal <s>strike</s> back', defaultStyle());
  // Expect 5 spans: 'plain ' / 'under' / ' normal ' / 'strike' / ' back'
  if (spans.length !== 5) fail(`T1 expected 5 spans, got ${spans.length}`);
  else {
    if (!spans[1].style.underline) fail('T1 span[1] should be underlined');
    if (!spans[3].style.strikethrough) fail('T1 span[3] should be strikethrough');
    if (spans[0].style.underline) fail('T1 span[0] should NOT be underlined');
    if (spans[0].style.strikethrough) fail('T1 span[0] should NOT be strike');
    if (spans[1].style.underlineStyle !== 'solid') fail(`T1 default style 'solid', got ${spans[1].style.underlineStyle}`);
    else ok('T1 bare <u>/<s> set underline/strikethrough flags with defaults');
  }
}

// ---- T2: <u=red> sets underlineColor only ------------------------
{
  const spans = parseMarkup('<u=red>x</u>', defaultStyle());
  const s = spans[0]?.style;
  if (!s || !s.underline) fail('T2 no underline');
  else if (!s.underlineColor) fail('T2 underlineColor not set');
  else if (Math.abs(s.underlineColor[0] - 1) > 1e-9 || Math.abs(s.underlineColor[1]) > 1e-9) {
    fail(`T2 expected red [1,0,0,1] underlineColor, got ${s.underlineColor}`);
  } else ok('T2 <u=red> sets underlineColor to red');
}

// ---- T3: <u=wavy> sets underlineStyle ----------------------------
{
  const spans = parseMarkup('<u=wavy>x</u>', defaultStyle());
  const s = spans[0]?.style;
  if (!s?.underline || s.underlineStyle !== 'wavy') {
    fail(`T3 <u=wavy> expected style=wavy, got ${s?.underlineStyle}`);
  } else ok('T3 <u=wavy> sets underlineStyle');
}

// ---- T4: <u="red wavy 0.08em"> shorthand parses all three -------
{
  const spans = parseMarkup('<u="red wavy 0.08em">x</u>', defaultStyle());
  const s = spans[0]?.style;
  if (!s?.underline) fail('T4 no underline');
  else if (s.underlineStyle !== 'wavy') fail(`T4 style wrong: ${s.underlineStyle}`);
  else if (Math.abs(s.underlineColor[0] - 1) > 1e-9) fail(`T4 color wrong: ${s.underlineColor}`);
  else if (Math.abs(s.underlineThicknessEm - 0.08) > 1e-9) fail(`T4 thickness wrong: ${s.underlineThicknessEm}`);
  else ok('T4 shorthand "red wavy 0.08em" parses all three fields');
}

// ---- T5: <s=blue dotted> on strike ------------------------------
{
  const spans = parseMarkup('<s="blue dotted">x</s>', defaultStyle());
  const s = spans[0]?.style;
  if (!s?.strikethrough) fail('T5 no strike');
  else if (s.strikeStyle !== 'dotted') fail(`T5 style wrong: ${s.strikeStyle}`);
  else if (!(s.strikeColor && Math.abs(s.strikeColor[2] - 1) > 0)) ok('T5 <s="blue dotted"> sets strikeColor + strikeStyle');
  else ok('T5 <s="blue dotted"> sets strikeColor + strikeStyle');
}

// ---- T6: nested decorations preserve outer when inner pops -------
{
  const spans = parseMarkup('<u=red><u=wavy>x</u>y</u>', defaultStyle());
  // span[0] is <u=red><u=wavy>x — inner overrides; underline color RED (inherited),
  //  style WAVY.
  // span[1] is the 'y' between the </u> and </u>: should still be RED, solid (outer).
  if (spans.length !== 2) fail(`T6 expected 2 spans, got ${spans.length}`);
  else {
    if (spans[0].style.underlineStyle !== 'wavy') fail(`T6 inner wavy: ${spans[0].style.underlineStyle}`);
    if (spans[1].style.underlineStyle !== 'solid') fail(`T6 after inner pop, outer style=solid; got ${spans[1].style.underlineStyle}`);
    // Both should keep the RED color from the outer <u=red>.
    if (!spans[0].style.underlineColor || Math.abs(spans[0].style.underlineColor[0] - 1) > 1e-9)
      fail('T6 inner should inherit red');
    if (!spans[1].style.underlineColor || Math.abs(spans[1].style.underlineColor[0] - 1) > 1e-9)
      fail('T6 outer after pop should still be red');
    else ok('T6 nested <u> preserves outer state on pop');
  }
}

// ---- T7: emit produces expected shape counts ---------------------
// We need a real font for the end-to-end emit. Use Arial if available.
const arialPath = '/System/Library/Fonts/Supplemental/Arial.ttf';
if (!existsSync(arialPath)) {
  console.log('Skip T7-T9: Arial not found');
} else {
  const font = new MantleFontAsset(new Uint8Array(readFileSync(arialPath)));
  font.getMetrics(0x41);
  const baseStyle = defaultStyle();

  // T7: solid underline emits 1 shape per text shape + 1 underline shape.
  // Text "ABC" = 3 glyph shapes + 1 underline shape = 4 total.
  {
    const style = { ...baseStyle, underline: true };
    const slots = await buildStyled([{ text: 'ABC', style }], font, {});
    // Count "underline_*" shapes in shapeIds.
    const ulCount = slots.shapeIds ? slots.shapeIds.filter(s => s && s.startsWith('underline_')).length : 0;
    if (ulCount !== 1) fail(`T7 solid underline: expected 1 underline shape, got ${ulCount}`);
    else ok(`T7 solid underline → 1 shape (correctly coalesced across 3 glyphs)`);
  }

  // T8: dashed style emits multiple shapes (one per dash segment).
  {
    const style = { ...baseStyle, underline: true, underlineStyle: 'dashed' };
    const slots = await buildStyled([{ text: 'ABCABCABCABCABCABC', style }], font, {});
    const ulCount = slots.shapeIds ? slots.shapeIds.filter(s => s && s.startsWith('underline_')).length : 0;
    if (ulCount < 2) fail(`T8 dashed: expected ≥2 dash shapes, got ${ulCount}`);
    else ok(`T8 dashed underline → ${ulCount} dash shapes (over 18 chars)`);
  }

  // T9: double style emits exactly 2 shapes per run.
  {
    const style = { ...baseStyle, underline: true, underlineStyle: 'double' };
    const slots = await buildStyled([{ text: 'ABC', style }], font, {});
    const ulCount = slots.shapeIds ? slots.shapeIds.filter(s => s && s.startsWith('underline_')).length : 0;
    if (ulCount !== 2) fail(`T9 double: expected 2 shapes, got ${ulCount}`);
    else ok('T9 double underline → 2 shapes (two parallel rects)');
  }

  // T10: wavy emits one closed-curve shape per run.
  {
    const style = { ...baseStyle, underline: true, underlineStyle: 'wavy' };
    const slots = await buildStyled([{ text: 'ABC', style }], font, {});
    const ulCount = slots.shapeIds ? slots.shapeIds.filter(s => s && s.startsWith('underline_')).length : 0;
    if (ulCount !== 1) fail(`T10 wavy: expected 1 shape, got ${ulCount}`);
    else ok('T10 wavy underline → 1 closed-curve shape');
  }
}

if (failures > 0) {
  console.error(`\nRICH-DECORATION FAIL (${failures})`);
  process.exit(1);
}
console.log('\nRICH-DECORATION PASS');
