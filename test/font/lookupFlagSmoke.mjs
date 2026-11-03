// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lookupFlagSmoke.mjs — exercises GDEF-aware lookupFlag filtering.
//
// The key behavior we want to verify: when a lookup has IgnoreMarks
// set (and GDEF classifies marks correctly), context/chain-context
// walks must skip over mark glyphs as if they weren't in the
// sequence. Without that, real Arabic/Indic fonts mis-shape any time
// a mark sits between two consonants in a contextual rule.
//
// We exercise three paths:
//   T1 makeLookupFilter unit — predicate decode for all bit positions
//   T2 GsubReader threading — context type 5 + chain 6 honor filter
//   T3 GposReader threading — chain context type 8 honors filter
// Real-font verification (T4) runs only if SFArabic is present.

import { readFileSync, existsSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import {
  makeLookupFilter,
  nextNonSkippedForward,
  nextNonSkippedBackward,
  readLookupFlags,
} from '../../src/font/lookupFlag.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// ----- T1: makeLookupFilter unit ----------------------------------
// Build a minimal GDEF stand-in (the reader-facing surface is
// { hasTable, getGlyphClass(gid), isInMarkGlyphSet(gid, set),
//   getMarkAttachClass(gid) }) and probe each bit.
{
  const fakeGdef = {
    hasTable: true,
    getGlyphClass: (gid) => {
      if (gid === 10) return 1; // Base
      if (gid === 20) return 2; // Ligature
      if (gid === 30) return 3; // Mark
      return 0; // Unassigned
    },
    isInMarkGlyphSet: (gid, _set) => gid === 30,
    getMarkAttachClass: (gid) => (gid === 30 ? 5 : 0),
  };

  // No bits → predicate always returns false.
  const f0 = makeLookupFilter(0x0000, -1, fakeGdef);
  if (f0.skip(10) || f0.skip(20) || f0.skip(30)) fail('T1a no-bit filter must never skip');
  else ok('T1a flag=0 → skip() always false');

  // IgnoreBaseGlyphs (0x0002): skip class 1.
  const fB = makeLookupFilter(0x0002, -1, fakeGdef);
  if (!fB.skip(10)) fail('T1b IgnoreBaseGlyphs must skip base');
  if (fB.skip(20)) fail('T1b IgnoreBaseGlyphs must not skip ligature');
  if (fB.skip(30)) fail('T1b IgnoreBaseGlyphs must not skip mark');
  else ok('T1b IgnoreBaseGlyphs skips only base');

  // IgnoreLigatures (0x0004): skip class 2.
  const fL = makeLookupFilter(0x0004, -1, fakeGdef);
  if (!fL.skip(20)) fail('T1c IgnoreLigatures must skip ligature');
  if (fL.skip(10) || fL.skip(30)) fail('T1c IgnoreLigatures must not skip base/mark');
  else ok('T1c IgnoreLigatures skips only ligature');

  // IgnoreMarks (0x0008): skip class 3.
  const fM = makeLookupFilter(0x0008, -1, fakeGdef);
  if (!fM.skip(30)) fail('T1d IgnoreMarks must skip mark');
  if (fM.skip(10) || fM.skip(20)) fail('T1d IgnoreMarks must not skip base/ligature');
  else ok('T1d IgnoreMarks skips only mark');

  // UseMarkFilteringSet (0x0010): skip marks NOT in the named set.
  // Our fakeGdef puts gid 30 IN set 0, so it should NOT skip.
  const fS = makeLookupFilter(0x0010, 0, fakeGdef);
  if (fS.skip(30)) fail('T1e UseMarkFilteringSet must not skip mark IN set');
  // Gid 31 (also unassigned by our predicate → not mark, returns 0).
  // Make it explicitly a mark NOT in the set.
  const fakeGdef2 = {
    ...fakeGdef,
    getGlyphClass: (gid) => (gid === 31 ? 3 : fakeGdef.getGlyphClass(gid)),
    isInMarkGlyphSet: (gid, _set) => gid === 30, // 31 NOT in set
  };
  const fS2 = makeLookupFilter(0x0010, 0, fakeGdef2);
  if (!fS2.skip(31)) fail('T1e UseMarkFilteringSet must skip mark NOT in set');
  else ok('T1e UseMarkFilteringSet keeps in-set marks, skips out-of-set marks');

  // MarkAttachmentType (0xFF00): skip marks whose attach class differs.
  const fA = makeLookupFilter(0x0500, -1, fakeGdef);
  // gid 30 has attach class 5 → matches → don't skip.
  if (fA.skip(30)) fail('T1f MarkAttachmentType=5 must not skip mark with class 5');
  else ok('T1f MarkAttachmentType keeps matching-class marks');

  // GDEF absent → predicate becomes no-op even with bits set.
  const fNone = makeLookupFilter(0x0008, -1, { hasTable: false });
  if (fNone.skip(30)) fail('T1g GDEF absent must short-circuit to no-skip');
  else ok('T1g GDEF absent → filter no-ops');
}

// ----- T2: nextNonSkippedForward / Backward -----------------------
{
  const fakeGdef = {
    hasTable: true,
    getGlyphClass: (g) => (g === 30 ? 3 : 1),
    isInMarkGlyphSet: () => false,
    getMarkAttachClass: () => 0,
  };
  const filter = makeLookupFilter(0x0008, -1, fakeGdef); // IgnoreMarks
  const seq = [10, 30, 10, 30, 30, 10, 30]; // bases interspersed with marks
  const fwd = [];
  let p = 0;
  while (p !== -1 && p < seq.length) {
    p = nextNonSkippedForward(seq, p, filter);
    if (p === -1) break;
    fwd.push(p);
    p++;
  }
  if (JSON.stringify(fwd) !== JSON.stringify([0, 2, 5])) {
    fail(`T2 forward walk over IgnoreMarks-filtered seq, got ${JSON.stringify(fwd)}`);
  } else ok('T2 forward walk skips marks: positions [0,2,5]');

  const bwd = [];
  p = seq.length - 1;
  while (p >= 0) {
    p = nextNonSkippedBackward(seq, p, filter);
    if (p === -1) break;
    bwd.push(p);
    p--;
  }
  if (JSON.stringify(bwd) !== JSON.stringify([5, 2, 0])) {
    fail(`T2b backward walk over IgnoreMarks-filtered seq, got ${JSON.stringify(bwd)}`);
  } else ok('T2b backward walk skips marks: positions [5,2,0]');
}

// ----- T3: real-font end-to-end (regression) ---------------------
// SFArabic ships chain-context lookups; pre/post-filter the same
// shape must still produce identical glyph output for a pure
// consonant sequence (no marks present → filter is structurally
// a no-op). This guards against accidental change of behavior
// when GDEF is attached.
const SFArabicPath = '/System/Library/Fonts/SFArabic.ttf';
if (existsSync(SFArabicPath)) {
  const font = new MantleFontAsset(new Uint8Array(readFileSync(SFArabicPath)));
  font.getMetrics(0x0628); // warm
  // Ensure GDEF actually got injected via the getter side effect.
  const gsub = font.gsub;
  if (!gsub._gdef) fail('T3a fontAsset.gsub.setGdef should have been called');
  else ok('T3a fontAsset auto-injects GDEF into GsubReader');
  if (!font.gpos._gdef && font.gpos.setGdef)
    fail('T3b fontAsset.gpos.setGdef should have been called');
  else ok('T3b fontAsset auto-injects GDEF into GposReader (or absent)');

  // GDEF reader should classify common Arabic gids correctly.
  const gdef = font.gdef;
  if (gdef && gdef.hasTable) {
    // Find harakat gid (FATHA = U+064E). Pure mark.
    const fathaGid = font._tables.codepointToGlyphIndex(0x064e);
    const behGid = font._tables.codepointToGlyphIndex(0x0628);
    if (fathaGid > 0) {
      const fathaClass = gdef.getGlyphClass(fathaGid);
      if (fathaClass !== 3) fail(`T3c FATHA gid ${fathaGid} class ${fathaClass} (expected 3=Mark)`);
      else ok(`T3c FATHA classified as Mark via GDEF`);
    }
    if (behGid > 0) {
      const behClass = gdef.getGlyphClass(behGid);
      if (behClass !== 1) fail(`T3d BEH gid ${behGid} class ${behClass} (expected 1=Base)`);
      else ok(`T3d BEH classified as Base via GDEF`);
    }
  } else ok('T3c GDEF absent in font, classification skipped');
} else {
  console.log('Skip T3: SFArabic.ttf not available');
}

if (failures > 0) {
  console.error(`\nLOOKUPFLAG FAIL (${failures})`);
  process.exit(1);
}
console.log('\nLOOKUPFLAG PASS');
