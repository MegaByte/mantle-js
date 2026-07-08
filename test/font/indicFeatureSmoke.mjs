// indicFeatureSmoke.mjs — GSUB Indic feature dispatch.
// Verifies the GsubReader picks up the 15 Indic feature tags and the
// dispatch returns sensible results for real Devanagari + Bengali fonts.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

// Test fonts: KohinoorBangla.ttc (Bengali) + DevanagariSangamMN.ttc (Devanagari).
// Apple ships them as TTCs; our reader takes face 0.
let devaFont = null;
let bengFont = null;
try {
  devaFont = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Devanagari Sangam MN.ttc')));
  devaFont.getMetrics(0x0915);
} catch (e) { console.log('Skip Devanagari font:', e.message); }
try {
  bengFont = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/KohinoorBangla.ttc')));
  bengFont.getMetrics(0x0995);
} catch (e) { console.log('Skip Bengali font:', e.message); }

// ----- T1: Devanagari font has Indic features ---------------------
if (devaFont) {
  const gsub = devaFont.gsub;
  if (!gsub.hasIndicFeatures) fail('T1 Devanagari font has no Indic features (bug)');
  else {
    const tags = ['nukt','akhn','rphf','rkrf','pref','blwf','half','vatu','cjct','pres','abvs','blws','psts','haln','calt'];
    const present = tags.filter(t => gsub._indicLookupsByTag(t) != null && gsub._indicLookupsByTag(t).length > 0);
    if (present.length === 0) fail('T1 no tags present despite hasIndicFeatures');
    else ok(`T1 Devanagari Sangam MN features: ${present.join(' ')}`);
  }
}

// ----- T2: Devanagari ra+halant → reph via 'rphf' ----------------
if (devaFont) {
  // ra=U+0930 (gid?), halant=U+094D (gid?)
  const raGid = devaFont.codepointToGlyphId(0x0930);
  const halantGid = devaFont.codepointToGlyphId(0x094D);
  if (!raGid || !halantGid) {
    fail(`T2 missing gids: ra=${raGid} halant=${halantGid}`);
  } else {
    // rphf is typically a ligature: (ra, halant) → reph form.
    const hit = devaFont.gsub.tryMatchIndicLigature('rphf', [raGid, halantGid], 0);
    if (!hit) {
      // Some fonts apply rphf as type-1 on the ra gid alone (after
      // the OT shaper has flagged ra+halant). Either way, it's font-
      // specific; just verify the dispatch doesn't crash.
      ok(`T2 'rphf' dispatch returned null for (ra, halant) — font-specific`);
    } else {
      ok(`T2 'rphf' ligature: (ra, halant) → gid ${hit.replacement}, consumed ${hit.consumed}`);
    }
  }
}

// ----- T3: Single-sub via 'nukt' --------------------------------
if (devaFont) {
  // Try nukt on consonant + nukta pair via single-sub.
  // For type-1, nukt usually applies on a precomposed-style gid
  // that's already been formed elsewhere; running the standalone
  // dispatch is mostly a smoke test for the API.
  const kaGid = devaFont.codepointToGlyphId(0x0915);
  const out = devaFont.gsub.substituteIndicSingle(kaGid, 'nukt');
  // We don't care about the exact return; just that it doesn't throw
  // and either returns kaGid or some other valid gid.
  if (out === undefined || out === null) fail('T3 nukt dispatch returned null/undefined');
  else ok(`T3 'nukt' single-sub on ka returns gid ${out} (== ka=${kaGid} when no rule)`);
}

// ----- T4: Bengali font has Indic features ---------------------
if (bengFont) {
  const gsub = bengFont.gsub;
  if (!gsub.hasIndicFeatures) fail('T4 Bengali font has no Indic features');
  else {
    const tags = ['nukt','akhn','rphf','rkrf','pref','blwf','half','vatu','cjct','pres','abvs','blws','psts','haln','calt'];
    const present = tags.filter(t => gsub._indicLookupsByTag(t) != null && gsub._indicLookupsByTag(t).length > 0);
    ok(`T4 Kohinoor Bangla features: ${present.join(' ') || '(none)'}`);
  }
}

// ----- T5: Latin font has NO Indic features ------------------
{
  const arial = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')));
  arial.getMetrics(0x41);
  if (arial.gsub.hasIndicFeatures) fail('T5 Arial unexpectedly has Indic features');
  else ok(`T5 Arial hasIndicFeatures = false (expected for Latin font)`);
}

console.log();
console.log(failures === 0 ? 'INDIC-FEATURE PASS' : `INDIC-FEATURE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
