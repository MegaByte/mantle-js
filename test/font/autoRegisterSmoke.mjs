// autoRegisterSmoke.mjs — font/auto sniffs a font's tables + scripts and
// registers exactly the optional subsystems it needs, with no manual
// register*() calls. Validates the registry actually gets populated
// (glyphs come out non-blank) and that `registered` reflects the font.
//
// Uses real macOS system fonts; skips gracefully when a font is absent.

import { existsSync } from 'fs';
import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { autoRegisterForFont } from '../../src/font/auto.js';

let failures = 0;
const fail = (m) => { console.error('FAIL', m); failures++; };
const ok = (m) => console.log('ok', m);

const FONTS = {
  // A CFF/OTF font.
  cff: ['/System/Library/Fonts/Supplemental/STIXGeneral.otf'],
  // TrueType glyf Latin.
  glyf: ['/System/Library/Fonts/Supplemental/Arial.ttf',
         '/Library/Fonts/Arial.ttf'],
  // Arabic (RTL → should auto-pull bidi + arabic shaper).
  arabic: ['/System/Library/Fonts/GeezaPro.ttc',
           '/System/Library/Fonts/SFArabic.ttf'],
};

function firstExisting(paths) {
  for (const p of paths) if (existsSync(p)) return p;
  return null;
}

async function loadAuto(path) {
  const raw = new Uint8Array(readFileSync(path));
  const { bytes, registered } = await autoRegisterForFont(raw);
  const asset = new MantleFontAsset(bytes);
  return { asset, registered };
}

function firstGlyphSegs(asset, ch) {
  return asset.getGlyphSegs(ch.codePointAt(0));   // takes a codepoint
}

// ---- T1: CFF/OTF font → font/formats/cff auto-registered, glyphs non-blank.
{
  const p = firstExisting(FONTS.cff);
  if (!p) { console.log('SKIP T1 (no CFF/OTF system font)'); }
  else {
    const { asset, registered } = await loadAuto(p);
    if (!registered.includes('font/formats/cff'))
      fail(`T1 expected font/formats/cff in [${registered}]`);
    else {
      const segs = firstGlyphSegs(asset, 'A');
      if (!segs || segs.length === 0) fail('T1 CFF "A" produced no segs (reader not wired)');
      else ok(`T1 auto-registered CFF; "A" → ${segs.length} segs; registered=[${registered}]`);
    }
  }
}

// ---- T2: plain glyf TTF → CFF NOT pulled (stays lean).
{
  const p = firstExisting(FONTS.glyf);
  if (!p) { console.log('SKIP T2 (no glyf system font)'); }
  else {
    const { asset, registered } = await loadAuto(p);
    if (registered.includes('font/formats/cff'))
      fail(`T2 glyf font should NOT pull CFF; registered=[${registered}]`);
    else {
      const segs = firstGlyphSegs(asset, 'A');
      if (!segs || segs.length === 0) fail('T2 glyf "A" produced no segs');
      else ok(`T2 glyf stays lean (no CFF); "A" → ${segs.length} segs`);
    }
  }
}

// ---- T3: Arabic font → arabic shaper + bidi auto-pulled.
{
  const p = firstExisting(FONTS.arabic);
  if (!p) { console.log('SKIP T3 (no Arabic system font)'); }
  else {
    const { registered } = await loadAuto(p);
    const lp = p.toLowerCase();
    const isArabicFont = lp.includes('geeza') || lp.includes('arabic');
    if (isArabicFont) {
      // Shaping comes from EITHER the OT Arabic shaper (GSUB 'arab') OR
      // the AAT path (morx) for AAT fonts like GeezaPro. Either way, an
      // RTL Arabic font must auto-pull bidi (via OS/2 range coverage).
      const hasShaper = registered.includes('font/scripts/arabic') ||
                        registered.includes('font/typography/aat');
      if (!hasShaper)
        fail(`T3 expected an Arabic shaper (scripts/arabic or aat); registered=[${registered}]`);
      else if (!registered.includes('font/typography/bidi'))
        fail(`T3 expected font/typography/bidi for RTL; registered=[${registered}]`);
      else ok(`T3 Arabic font auto-pulled shaper+bidi; registered=[${registered}]`);
    } else {
      ok(`T3 SKIP-ish (non-Arabic fallback font ${p})`);
    }
  }
}

console.log(failures ? `\nAUTO-REGISTER FAIL (${failures})` : '\nAUTO-REGISTER PASS');
process.exit(failures ? 1 : 0);
