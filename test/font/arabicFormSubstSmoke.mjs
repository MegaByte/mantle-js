// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Verifies GSUB init/medi/fina/isol form-feature dispatch.
//
// Loads SFArabic.ttf and checks the form variants are reachable and
// distinct for a representative dual-joining letter. Form-vs-isolated
// gids must differ for at least one form when the font ships the
// feature — otherwise the substitution lookup is broken.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { ArabicForm } from '../../src/font/scripts/arabicJoining.js';

const fontBytes = new Uint8Array(readFileSync('/System/Library/Fonts/SFArabic.ttf'));
const font = new MantleFontAsset(fontBytes);
font.getMetrics(0x41); // warm up the parser

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

const gsub = font.gsub;

// ----- T1: SFArabic exposes Arabic form features -------------------
{
  if (!gsub.hasArabicForms) fail('T1 SFArabic has no Arabic form features (init/medi/fina/isol)');
  else ok('T1 SFArabic exposes Arabic form features');
}

// ----- T2: beh's medial form differs from isolated -----------------
{
  // beh U+0628 — base glyph; should have all 4 forms in SFArabic.
  const baseGid = font.codepointToGlyphId(0x0628);
  if (!baseGid) fail('T2 beh has no gid');
  else {
    const isol = gsub.substituteArabicForm(baseGid, ArabicForm.Isol);
    const init = gsub.substituteArabicForm(baseGid, ArabicForm.Init);
    const medi = gsub.substituteArabicForm(baseGid, ArabicForm.Medi);
    const fina = gsub.substituteArabicForm(baseGid, ArabicForm.Fina);
    // Init/Medi/Fina should differ from the base (isolated) gid.
    if (init === baseGid && medi === baseGid && fina === baseGid) {
      fail(
        `T2 beh forms all identical to base (gid=${baseGid}): init=${init} medi=${medi} fina=${fina}`,
      );
    } else {
      // The four forms should be mutually distinct for beh
      // (which is heavily shape-shifted across positions).
      const distinct = new Set([isol, init, medi, fina]).size;
      if (distinct < 3)
        fail(`T2 beh forms only ${distinct} distinct (need ≥3): ${isol} ${init} ${medi} ${fina}`);
      else
        ok(
          `T2 beh forms: isol=${isol} init=${init} medi=${medi} fina=${fina} (${distinct} distinct)`,
        );
    }
  }
}

// ----- T3: non-Arabic gid passes through unchanged -----------------
{
  const aGid = font.codepointToGlyphId(0x41); // 'A'
  if (aGid) {
    const init = gsub.substituteArabicForm(aGid, ArabicForm.Init);
    if (init !== aGid) fail(`T3 ASCII 'A' was substituted under 'init': ${aGid} → ${init}`);
    else ok(`T3 ASCII 'A' passes through Init substitution unchanged (gid=${aGid})`);
  } else ok('T3 ASCII A has no gid in SFArabic; skip');
}

// ----- T4: invalid form code returns gid unchanged -----------------
{
  const gid = font.codepointToGlyphId(0x0628);
  const out = gsub.substituteArabicForm(gid, 99);
  if (out !== gid) fail(`T4 invalid form code mutated gid: ${gid} → ${out}`);
  else ok(`T4 invalid form code = no-op`);
}

console.log();
console.log(failures === 0 ? 'ARABIC-FORM-SUBST PASS' : `ARABIC-FORM-SUBST FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
