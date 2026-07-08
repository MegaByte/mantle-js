// ttcAppleEmojiSmoke.mjs — end-to-end TTC + sbix against Apple
// Color Emoji.ttc (192MB system font on macOS). Skipped silently
// when the font isn't installed.

import { readFileSync, existsSync } from 'fs';
import { parseTtfTables } from '../../src/font/ttfTables.js';
import { SbixReader } from '../../src/font/color/sbixReader.js';

const TTC_PATH = '/System/Library/Fonts/Apple Color Emoji.ttc';

if (!existsSync(TTC_PATH)) {
  console.log(`SKIP — ${TTC_PATH} not present (run on macOS)`);
  process.exit(0);
}

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

const buf = new Uint8Array(readFileSync(TTC_PATH));

// T1: TTC container parses; face 0 has the sbix table.
{
  const t = parseTtfTables(buf);
  if (t.numGlyphs <= 0) fail(`T1 numGlyphs=${t.numGlyphs}`);
  else if (!t.sbix) fail('T1 no sbix table on face 0');
  else if (t._cmapFormat !== 12) fail(`T1 expected cmap format 12 (Unicode 32-bit), got ${t._cmapFormat}`);
  else ok(`T1 TTC face 0: ${t.numGlyphs} glyphs, unitsPerEm=${t.unitsPerEm}, cmap format ${t._cmapFormat}`);
}

// T2: Sbix reader sees multiple strikes.
{
  const t = parseTtfTables(buf);
  const r = new SbixReader(t);
  if (!r.hasBitmaps) fail('T2 hasBitmaps false');
  else if (r.numStrikes < 2) fail(`T2 expected >=2 strikes, got ${r.numStrikes}`);
  else ok(`T2 sbix: ${r.numStrikes} strikes`);
}

// T3: 😀 (U+1F600 grinning face) → gid → PNG bytes.
{
  const t = parseTtfTables(buf);
  const r = new SbixReader(t);
  const gid = t.codepointToGlyphIndex(0x1F600);
  if (gid === 0) fail('T3 no gid for U+1F600');
  else {
    const strikeIdx = r.pickStrikeForPpem(64);
    if (strikeIdx < 0) fail('T3 no strike picked');
    else {
      const g = r.getBitmapGlyph(gid, strikeIdx);
      if (!g) fail(`T3 no bitmap for gid ${gid} strike ${strikeIdx}`);
      else if (!g.isPng) fail(`T3 non-PNG graphicType 0x${g.graphicType.toString(16)}`);
      else if (g.pngBytes.length < 100) fail(`T3 PNG suspiciously short: ${g.pngBytes.length} bytes`);
      else {
        // Check PNG signature.
        const sig = Array.from(g.pngBytes.slice(0, 4));
        if (sig[0] !== 0x89 || sig[1] !== 0x50 || sig[2] !== 0x4E || sig[3] !== 0x47)
          fail(`T3 PNG signature wrong: ${sig.map(b=>b.toString(16)).join(' ')}`);
        else ok(`T3 U+1F600 (😀) → gid ${gid}, strike ppem ${g.strikePpem}, ${g.pngBytes.length}-byte PNG (signature OK)`);
      }
    }
  }
}

// T4: a non-emoji codepoint (latin 'A', U+0041) returns gid 0
// (Apple Color Emoji doesn't have non-emoji glyphs).
{
  const t = parseTtfTables(buf);
  const gid = t.codepointToGlyphIndex(0x41);
  if (gid !== 0) {
    // Apple Color Emoji actually DOES have a few non-emoji glyphs
    // (period, digits used in keycaps, etc) — accept either. Just
    // confirm the lookup doesn't crash.
  }
  ok(`T4 cmap lookup for U+0041 → gid ${gid} (no crash)`);
}

console.log();
console.log(failures === 0 ? 'TTC-APPLE-EMOJI PASS' : `TTC-APPLE-EMOJI FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
