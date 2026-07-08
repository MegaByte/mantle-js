// otTablesSmoke.mjs — readers for GDEF / VVAR / VORG / BASE / STAT.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { GdefClass } from '../../src/font/gdefReader.js';
import { BaselineTag } from '../../src/font/typography/baseReader.js';
import { registerVariableFontReaders } from '../../src/font/variations/index.js';
import { registerVerticalReader }      from '../../src/font/typography/vertical.js';
import { registerBaselineReader }      from '../../src/font/typography/baseline.js';
registerVariableFontReaders();
registerVerticalReader();
registerBaselineReader();

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

// ----- T1: GDEF — Arabic marks classified as Mark ---------------
{
  let font = null;
  try {
    font = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/SFArabic.ttf')));
    font.getMetrics(0x0628);
  } catch (e) { console.log('Skip SFArabic:', e.message); }
  if (font) {
    const gdef = font.gdef;
    if (!gdef.hasTable) fail('T1 SFArabic has no GDEF');
    else {
      const behGid = font.codepointToGlyphId(0x0628);     // base letter
      const fathaGid = font.codepointToGlyphId(0x064E);   // mark
      const behClass = gdef.getGlyphClass(behGid);
      const fathaClass = gdef.getGlyphClass(fathaGid);
      const baseClassName = ['?', 'Base', 'Ligature', 'Mark', 'Component'];
      if (behClass !== GdefClass.Base) fail(`T1 beh class ${behClass}, want Base`);
      else if (fathaClass !== GdefClass.Mark) fail(`T1 fatha class ${fathaClass}, want Mark`);
      else ok(`T1 SFArabic GDEF: beh=${baseClassName[behClass]} (gid ${behGid}), fatha=${baseClassName[fathaClass]} (gid ${fathaGid})`);
    }
  }
}

// ----- T2: GDEF mark-attachment class for harakat -----------------
{
  let font = null;
  try {
    font = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/SFArabic.ttf')));
    font.getMetrics(0x0628);
  } catch (e) { console.log('Skip:', e.message); }
  if (font) {
    const gdef = font.gdef;
    if (gdef.hasTable) {
      const fathaCls = gdef.getMarkAttachClass(font.codepointToGlyphId(0x064E));
      ok(`T2 fatha mark-attach class = ${fathaCls}`);
    }
  }
}

// ----- T3: ASCII font has GDEF with Base classification ----------
{
  let arial = null;
  try {
    arial = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')));
    arial.getMetrics(0x41);
  } catch (e) { console.log('Skip Arial:', e.message); }
  if (arial) {
    const gdef = arial.gdef;
    if (!gdef.hasTable) ok(`T3 Arial has no GDEF (acceptable for legacy fonts)`);
    else {
      const aClass = gdef.getGlyphClass(arial.codepointToGlyphId(0x41));
      if (aClass === GdefClass.Base) ok(`T3 Arial 'A' classified Base`);
      else if (aClass === GdefClass.Unassigned) ok(`T3 Arial GDEF present but 'A' unassigned`);
      else fail(`T3 Arial 'A' class ${aClass}`);
    }
  }
}

// ----- T4: VORG — Apple Color Emoji has it? -----------------
{
  // Apple Color Emoji uses sbix + has VORG. Other system fonts
  // may not. Just probe gracefully.
  const candidates = [
    '/System/Library/Fonts/Apple Color Emoji.ttc',
    '/System/Library/Fonts/SFNS.ttf',
  ];
  for (const path of candidates) {
    let font = null;
    try {
      font = new MantleFontAsset(new Uint8Array(readFileSync(path)));
      font.getMetrics(0x41);
    } catch (e) { continue; }
    if (font.vorg.hasTable) {
      ok(`T4 ${path.split('/').pop()} VORG present, defaultY=${font.vorg.defaultVertOriginY}`);
      break;
    }
  }
  // Not finding VORG is acceptable.
  ok(`T4 VORG probe complete`);
}

// ----- T5: STAT — variable fonts ship axis records ---------------
{
  // SFNS.ttf is a TTF variable font.
  let font = null;
  try {
    font = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/SFNS.ttf')));
    font.getMetrics(0x41);
  } catch (e) { console.log('Skip SFNS:', e.message); }
  if (font) {
    const stat = font.stat;
    if (!stat.hasTable) fail('T5 SFNS variable font has no STAT');
    else {
      const axes = stat.axes;
      const tags = axes.map(a => String.fromCharCode((a.tag>>24)&0xFF, (a.tag>>16)&0xFF, (a.tag>>8)&0xFF, a.tag&0xFF));
      ok(`T5 SFNS STAT axes: ${tags.join(' ')}`);
    }
  }
}

// ----- T6: BASE — fonts that ship it ----------------------
{
  const candidates = [
    '/System/Library/Fonts/SFNS.ttf',
    '/System/Library/Fonts/Supplemental/Times New Roman.ttf',
  ];
  let found = false;
  for (const path of candidates) {
    let font = null;
    try {
      font = new MantleFontAsset(new Uint8Array(readFileSync(path)));
      font.getMetrics(0x41);
    } catch (e) { continue; }
    if (font.base.hasTable) {
      const tags = font.base.getHorizontalBaselineTags();
      const tagsStr = tags.map(t => String.fromCharCode((t>>24)&0xFF, (t>>16)&0xFF, (t>>8)&0xFF, t&0xFF)).join(' ');
      ok(`T6 ${path.split('/').pop()} BASE present, h-axis tags: ${tagsStr}`);
      found = true;
      break;
    }
  }
  if (!found) ok(`T6 BASE absent in tested fonts (most don't ship it)`);
}

// ----- T7: VVAR — variable fonts that have vertical metric vars ----
{
  // Few fonts ship VVAR. Probe a couple of CJK candidates.
  const candidates = [
    '/System/Library/Fonts/NotoSansMyanmar.ttc',
    '/System/Library/Fonts/SFNS.ttf',
  ];
  for (const path of candidates) {
    let font = null;
    try {
      font = new MantleFontAsset(new Uint8Array(readFileSync(path)));
      font.getMetrics(0x41);
    } catch (e) { continue; }
    if (font.vvar.hasVvar) {
      ok(`T7 ${path.split('/').pop()} VVAR present`);
      break;
    }
  }
  ok(`T7 VVAR probe complete (most fonts don't ship VVAR)`);
}

console.log();
console.log(failures === 0 ? 'OT-TABLES PASS' : `OT-TABLES FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
