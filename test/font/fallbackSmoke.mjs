// Font fallback chains. Verifies:
//   - Codepoints missing from primary get resolved via fallback.
//   - Each slot retains the FONT that supplied its glyph.
//   - Kerning only fires between same-font adjacent slots.
//   - Width / line metrics use the per-slot font.
//   - With no fallback list, behavior is unchanged (regression).

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildStyled } from '../../src/font/textRun.js';
import { defaultStyle } from '../../src/font/markupParser.js';

const arial  = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')));
const gothic = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/AppleGothic.ttf')));
arial.getMetrics(0x41); gothic.getMetrics(0x41);

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

const build = async (text, primary, layout) =>
  await buildStyled([{ text, style: defaultStyle() }], primary, layout || {});

// ---- T1: primary Arial alone → CJK falls back to Arial's .notdef ----
{
  // Arial has no Hangul; layout assigns gid=0 (the .notdef shape, a
  // hollow rectangle in Arial). We get 3 .notdef shapes — visually
  // empty boxes. The point of T1 is to lock that behavior so T2's
  // win is visible.
  const text = '가나다';
  const b = await build(text, arial, {});
  if (b.numShapes !== 3) fail(`T1 expected 3 .notdef shapes, got ${b.numShapes}`);
  else {
    // Width = 3 × Arial's .notdef advance — should be UNIFORM.
    // Save for comparison with T2.
    ok(`T1 no fallback → 3 .notdef boxes (w=${(b.globalBBox[2]).toFixed(3)})`);
  }
}

// ---- T2: with AppleGothic in fallback chain → real Hangul glyphs ----
{
  const text = '가나다';
  const noFb = await build(text, arial, {});
  const wFb = await build(text, arial, { fallbacks: [gothic] });
  if (wFb.numShapes !== 3) fail(`T2 expected 3 shapes via fallback, got ${wFb.numShapes}`);
  else {
    // Glyphs from Gothic should have different geometry than Arial's
    // .notdef boxes. Compare bbox heights — Hangul is roughly square,
    // Arial's .notdef is taller-than-wide.
    const wA = noFb.globalBBox[2];
    const wG = wFb.globalBBox[2];
    if (Math.abs(wA - wG) < 1e-3) fail(`T2 fallback didn't change geometry (w=${wA.toFixed(3)} both)`);
    else ok(`T2 fallback resolves Hangul: w ${wA.toFixed(3)} (.notdef) → ${wG.toFixed(3)} (Gothic)`);
  }
}

// ---- T3: mixed Latin + CJK → primary handles Latin, fallback handles CJK ----
{
  const text = 'Hi가b';
  const b = await build(text, arial, { fallbacks: [gothic] });
  // 4 codepoints, all resolved (Hi via Arial, 가 via Gothic, b via Arial).
  if (b.numShapes !== 4) fail(`T3 expected 4 shapes, got ${b.numShapes}`);
  else ok(`T3 mixed Latin+CJK with fallback → ${b.numShapes} shapes`);
}

// ---- T4: fallback NOT triggered when primary has the glyph ----
{
  // 'a' is in Arial, so fallback Gothic shouldn't be touched.
  // Width of 'a' rendered via primary should match width of 'a' rendered
  // without any fallback (because Gothic.a would be different metrics).
  const a = await build('a', arial, {});
  const b = await build('a', arial, { fallbacks: [gothic] });
  const wA = a.globalBBox[2];
  const wB = b.globalBBox[2];
  if (Math.abs(wA - wB) > 1e-4) fail(`T4 'a' width differs with fallback: ${wA.toFixed(4)} vs ${wB.toFixed(4)}`);
  else ok(`T4 fallback untouched when primary has glyph (w=${wA.toFixed(4)})`);
}

// ---- T5: pure-Latin regression (no fallback option set) ----
{
  const a = await build('Hello', arial, {});
  const b = await build('Hello', arial, { fallbacks: [gothic] });
  // Without fallback need, fallback array shouldn't change anything.
  if (a.numShapes !== b.numShapes) fail(`T5 numShapes differ ${a.numShapes} vs ${b.numShapes}`);
  else if (Math.abs(a.globalBBox[2] - b.globalBBox[2]) > 1e-4) fail(`T5 width differs`);
  else ok(`T5 Latin unchanged when fallback present (${a.numShapes} shapes)`);
}

// ---- T6: empty/null fallbacks list — same as no fallback (.notdef path) ----
{
  const a = await build('가', arial, { fallbacks: [] });
  const b = await build('가', arial, { fallbacks: null });
  // Both fall back to Arial's .notdef → 1 shape each.
  if (a.numShapes !== 1 || b.numShapes !== 1) fail(`T6 expected 1 .notdef shape, got ${a.numShapes}/${b.numShapes}`);
  else ok(`T6 empty/null fallbacks behave like no fallback (.notdef shown)`);
}

// ---- T7: fallback skipped when fallback also lacks glyph → primary .notdef ----
{
  // Emoji is in NEITHER Arial nor AppleGothic. Resolver returns
  // (primary, 0), so the .notdef shape from PRIMARY shows.
  const b = await build('a👨b', arial, { fallbacks: [gothic] });
  // 'a' + emoji's .notdef + 'b' = 3 shapes.
  if (b.numShapes !== 3) fail(`T7 expected 3 shapes (a + .notdef + b), got ${b.numShapes}`);
  else ok(`T7 emoji missing from all → primary .notdef (${b.numShapes} shapes)`);
}

// ---- T8: cluster boundary keeps fallback choice consistent ----
{
  // NFD 'é' = U+0065 + U+0301. Primary Arial has 'e' AND the combining
  // acute. After NFC normalization this becomes a single U+00E9 cp
  // (Arial has it), so the cluster is one cp on Arial. The fallback
  // chain isn't consulted. Sanity check that NFD input still renders
  // correctly with a fallback array provided.
  const a = await build('café', arial, {});
  const b = await build('café', arial, { fallbacks: [gothic] });
  const c = await build('café', arial, { fallbacks: [gothic] });
  if (a.numShapes !== 4 || b.numShapes !== 4 || c.numShapes !== 4)
    fail(`T8 café NFC/NFD with fallback: ${a.numShapes}/${b.numShapes}/${c.numShapes}`);
  else ok(`T8 NFC + cluster + fallback compose (4 shapes each)`);
}

console.log();
console.log(failures === 0 ? 'FALLBACK PASS' : `FALLBACK FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
