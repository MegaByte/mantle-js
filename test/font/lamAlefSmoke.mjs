// lamAlefSmoke.mjs — verifies that 'rlig' / 'liga' ligature collapse
// fires for the canonical Arabic lam-alef pair. After form
// substitution promotes them to Init(lam) + Fina(alef), the ligature
// pass should collapse them into a single lam-alef glyph.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';
import { ArabicForm } from '../../src/font/scripts/arabicJoining.js';
import { registerArabicShaping } from '../../src/font/scripts/arabic.js';
registerArabicShaping();

const font = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/SFArabic.ttf'))
);
font.getMetrics(0x41);

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

// ----- T1: SFArabic exposes 'rlig' or 'liga' for Arabic ------------
{
  if (!font.gsub.hasLigatures) fail('T1 SFArabic has no ligature feature');
  else ok(`T1 SFArabic has ligatures (rlig or liga)`);
}

// ----- T2: SFArabic has 'ccmp' (or not) — capability bit ------------
{
  ok(`T2 SFArabic.hasCcmp = ${font.gsub.hasCcmp}`);
}

// ----- T3: 'لا' (lam-alef) should collapse to 1 glyph ----------------
{
  // Logical: lam (0x0644) + alef (0x0627).
  // Joining: lam = D (Dual), alef = R (Right):
  //   lam.next = alef (R causes joining)        → lam.joinsLeft = true
  //   lam.prev = none                            → lam.joinsRight = false
  //   ⇒ lam = Init
  //   alef.prev = lam (D causes)                 → alef.joinsRight = true
  //   alef.next = none + alef cannot join next   → alef.joinsLeft = false
  //   ⇒ alef = Fina
  // After form substitution: Init(lam) + Fina(alef).
  // The ligature pass should then collapse the two into the lam-alef
  // ligature glyph.
  const { glyphs } = buildSvgTextGlyphs('لا', font, 0, 0, 100);
  if (glyphs.length === 1) ok(`T3 'لا' collapsed to 1 glyph (lam-alef ligature fired)`);
  else if (glyphs.length === 2) {
    fail(`T3 'لا' NOT collapsed — got 2 glyphs (gid+cp: ${glyphs.map(g=>g.codepoint.toString(16)).join(',')}). Lam-alef ligature missing.`);
  } else fail(`T3 'لا' produced ${glyphs.length} glyphs (expected 1)`);
}

// ----- T4: 'بلاد' (bilad — countries) should produce 3 glyphs ------
{
  // Logical: beh + lam + alef + dal.
  // Joining: beh = D, lam = D, alef = R, dal = R.
  //   beh.prev = none, beh.next = lam (D, causes)            → beh = Init
  //   lam.prev = beh (D, causes), lam.next = alef (R, causes) → lam = Medi
  //   alef.prev = lam (D, causes), alef.next = dal (R, NOT D/L/C → does not cause from left side)
  //                                                          → alef = Fina
  //   dal.prev = alef (R; R ∉ {D,L,C} → not causing), dal.next = none
  //                                                          → dal = Isol
  // After form sub: Init(beh), Medi(lam), Fina(alef), Isol(dal).
  // The ligature pass should collapse Medi-lam + Fina-alef into a
  // single lam-alef MEDIAL ligature, OR if the font has no medial
  // lam-alef ligature, fall through and keep them separate.
  // Either way visual count: 3 OR 4.
  const { glyphs } = buildSvgTextGlyphs('بلاد', font, 0, 0, 100);
  if (glyphs.length === 3 || glyphs.length === 4) {
    ok(`T4 'بلاد' produced ${glyphs.length} glyphs (3=ligature applied, 4=not)`);
  } else fail(`T4 'بلاد' produced ${glyphs.length} glyphs (expected 3 or 4)`);
}

console.log();
console.log(failures === 0 ? 'LAM-ALEF PASS' : `LAM-ALEF FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
