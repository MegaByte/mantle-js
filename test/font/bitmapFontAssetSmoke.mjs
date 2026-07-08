// bitmapFontAssetSmoke.mjs — FontAsset.getBitmapGlyph dispatch.
// Exercises the sbix path against real Apple Color Emoji.ttc when
// installed; falls back to a SKIP otherwise.

import { readFileSync, existsSync } from 'fs';
import { registerColorEmojiReaders } from '../../src/font/color/index.js';
registerColorEmojiReaders();
import { MantleFontAsset } from '../../src/font/fontAsset.js';

const TTC_PATH = '/System/Library/Fonts/Apple Color Emoji.ttc';

if (!existsSync(TTC_PATH)) {
  console.log(`SKIP — ${TTC_PATH} not present (run on macOS)`);
  process.exit(0);
}

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

const font = new MantleFontAsset(new Uint8Array(readFileSync(TTC_PATH)));

// T1: Arial — no bitmaps. Capability returns false; getBitmapGlyph null.
{
  const arial = new MantleFontAsset(
    new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')));
  arial.getMetrics(0x41);  // force _ensure
  if (arial.hasBitmaps) fail('T1 Arial.hasBitmaps true');
  else if (arial.getBitmapGlyph(0x41, 32) !== null) fail('T1 Arial.getBitmapGlyph non-null');
  else ok('T1 Arial: no bitmaps');
}

// T2: Apple Color Emoji — hasBitmaps true (sbix path).
{
  font.getMetrics(0x41);
  if (!font.hasBitmaps) fail('T2 Apple Color Emoji hasBitmaps false');
  else if (!font.sbix.hasBitmaps) fail('T2 sbix.hasBitmaps false');
  else ok(`T2 Apple Color Emoji: hasBitmaps via ${font.sbix.numStrikes} sbix strikes`);
}

// T3: U+1F600 (😀) → bitmap glyph with PNG bytes + em-normalized advance.
{
  const g = font.getBitmapGlyph(0x1F600, 64);
  if (!g) fail('T3 no bitmap for 😀');
  else if (g.source !== 'sbix') fail(`T3 source=${g.source}`);
  else if (!g.pngBytes || g.pngBytes.length < 100) fail(`T3 pngBytes len=${g.pngBytes && g.pngBytes.length}`);
  else if (g.advanceEm <= 0) fail(`T3 advanceEm=${g.advanceEm}`);
  else if (g.strikePpem <= 0) fail(`T3 strikePpem=${g.strikePpem}`);
  else ok(`T3 😀 → ${g.pngBytes.length}-byte PNG, advance ${g.advanceEm.toFixed(3)} em, strike ppem ${g.strikePpem}`);
}

// T4: target ppem selects different strikes for different requests.
{
  const small = font.getBitmapGlyph(0x1F600, 20);
  const big   = font.getBitmapGlyph(0x1F600, 256);
  if (!small || !big) fail('T4 missing strikes');
  else if (small.strikePpem >= big.strikePpem)
    fail(`T4 strike selection broken: ppem 20→${small.strikePpem}, ppem 256→${big.strikePpem}`);
  else ok(`T4 strike selection: target ppem 20 → strike ${small.strikePpem}, target 256 → strike ${big.strikePpem}`);
}

// T5: non-emoji codepoint (latin 'A') — Apple Color Emoji has no glyph;
// getBitmapGlyph returns null (and doesn't throw).
{
  const g = font.getBitmapGlyph(0x41, 32);
  // gid 0 = .notdef returns null per spec. Don't enforce; just don't
  // crash. (Apple emoji actually maps some Latin to glyphs for digit
  // keycaps.)
  if (g !== null && (!g.pngBytes || g.pngBytes.length === 0))
    fail('T5 unmapped cp returned malformed glyph');
  ok(`T5 Latin 'A' lookup: ${g === null ? 'null' : 'glyph (font has it)'} — no crash`);
}

console.log();
console.log(failures === 0 ? 'BITMAP-FONTASSET PASS' : `BITMAP-FONTASSET FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
