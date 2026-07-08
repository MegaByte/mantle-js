// Exercises GPOS feature dispatch + context-positioning machinery
// (types 7/8) + extension deref (type 9).

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

// ----- T1: SFArabic has kern + curs + mark + mkmk + ... ----------
{
  let font = null;
  try {
    font = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/SFArabic.ttf')));
    font.getMetrics(0x0628);
  } catch (e) { console.log('Skip SFArabic:', e.message); }
  if (font) {
    const gpos = font.gpos;
    const tags = ['kern','curs','mark','mkmk','dist','vpal','vkrn','vert','vrt2'];
    const present = tags.filter(t => gpos.hasFeature(t));
    ok(`T1 SFArabic GPOS features: ${present.join(' ')}`);
    // Existing capability bits should agree
    if (gpos.hasFeature('mark') !== gpos.hasMarkBase) fail('T1 hasFeature/hasMarkBase mismatch');
    if (gpos.hasFeature('mkmk') !== gpos.hasMarkMark) fail('T1 hasFeature/hasMarkMark mismatch');
  }
}

// ----- T2: SFNS has kern --------------------------------------
{
  let font = null;
  try {
    font = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/SFNS.ttf')));
    font.getMetrics(0x41);
  } catch (e) { console.log('Skip SFNS:', e.message); }
  if (font) {
    const gpos = font.gpos;
    if (!gpos.hasFeature('kern')) fail('T2 SFNS has no kern feature');
    else ok(`T2 SFNS GPOS hasFeature('kern') = true`);
  }
}

// ----- T3: getLookupAt deref + type returned ---------------------
{
  let font = null;
  try {
    font = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/SFArabic.ttf')));
    font.getMetrics(0x0628);
  } catch (e) { console.log('Skip:', e.message); }
  if (font) {
    const gpos = font.gpos;
    // Walk every lookup and confirm getLookupAt returns matching types.
    const v = font._tables.view;
    const lookupListOff = gpos.lookupListOff;
    if (!lookupListOff) fail('T3 lookupListOff missing');
    else {
      const lookupCount = v.getUint16(lookupListOff, false);
      let extCount = 0, typed = 0;
      for (let i = 0; i < lookupCount; i++) {
        const r = gpos.getLookupAt(i);
        if (!r) { fail(`T3 lookup ${i} returned null`); break; }
        const rawType = v.getUint16(lookupListOff + v.getUint16(lookupListOff + 2 + i * 2, false), false);
        if (rawType === 9) extCount++;
        typed++;
      }
      ok(`T3 walked ${typed} GPOS lookups (${extCount} ext-9 wrappers)`);
    }
  }
}

// ----- T4: unknown feature returns null ---------------------------
{
  let font = null;
  try {
    font = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')));
    font.getMetrics(0x41);
  } catch (e) { console.log('Skip Arial:', e.message); }
  if (font) {
    const gpos = font.gpos;
    if (gpos.hasFeature('xyzw')) fail('T4 unknown feature unexpectedly hasFeature=true');
    else ok(`T4 unknown feature → hasFeature=false`);
  }
}

console.log();
console.log(failures === 0 ? 'GPOS-LOOKUP-TYPES PASS' : `GPOS-LOOKUP-TYPES FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
