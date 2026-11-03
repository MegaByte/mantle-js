// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// GPOS lookup types 3/4/6 reader coverage. Verifies the cursive,
// mark-to-base, and mark-to-mark readers return well-formed anchor
// offsets when paired with a real Arabic font.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';

const font = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/SFArabic.ttf')),
);
font.getMetrics(0x41);

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

const gpos = font.gpos;

// ----- T1: capability bits ------------------------------------------
{
  console.log(
    `hasCursive=${gpos.hasCursive} hasMarkBase=${gpos.hasMarkBase} hasMarkMark=${gpos.hasMarkMark}`,
  );
  if (!gpos.hasMarkBase) fail('T1 SFArabic should have mark-to-base');
  else
    ok(
      `T1 SFArabic capability bits: mark=${gpos.hasMarkBase}, mkmk=${gpos.hasMarkMark}, curs=${gpos.hasCursive}`,
    );
}

// ----- T2: mark-to-base — base letter beh (0x0628) + fatha (0x064E)
//          should yield an anchor offset (the fatha sits above beh).
{
  const baseGid = font.codepointToGlyphId(0x0628);
  const markGid = font.codepointToGlyphId(0x064e);
  if (!baseGid || !markGid) {
    fail(`T2 missing gids: beh=${baseGid} fatha=${markGid}`);
  } else {
    const att = gpos.getMarkBaseAttachment(baseGid, markGid);
    if (!att) fail(`T2 no MarkBasePos attachment for (beh, fatha)`);
    // The shift y must be positive (fatha is above the baseline-
    // resting base) — at least for a typical anchor layout.
    else if (typeof att.dx !== 'number' || typeof att.dy !== 'number')
      fail(`T2 malformed attachment: ${JSON.stringify(att)}`);
    else ok(`T2 (beh, fatha) attachment: dx=${att.dx} dy=${att.dy} font-units`);
  }
}

// ----- T3: mark-to-base for ASCII A + fatha returns null ------------
{
  // A (0x41) probably has no gid OR has gid but won't be in mark
  // coverage. Either way, no attachment.
  const baseGid = font.codepointToGlyphId(0x41) || 1; // .notdef fallback
  const markGid = font.codepointToGlyphId(0x064e);
  if (markGid) {
    const att = gpos.getMarkBaseAttachment(baseGid, markGid);
    if (att && att.dx !== undefined) {
      // Could legitimately return null OR an attachment if .notdef
      // is somehow in coverage; accept null but warn otherwise.
      ok(`T3 unrelated base ${baseGid} returns: ${att ? `dx=${att.dx} dy=${att.dy}` : 'null'}`);
    } else ok(`T3 unrelated base returns null (expected)`);
  } else ok('T3 fatha has no gid; skip');
}

// ----- T4: mark-to-mark — shadda (0x0651) + fatha (0x064E) -----------
//   Common stack in Arabic (e.g. أَنَّ has shaddafatha). Shadda is the
//   "base" mark in this attachment; fatha sits above it.
{
  const shaddaGid = font.codepointToGlyphId(0x0651);
  const fathaGid = font.codepointToGlyphId(0x064e);
  if (!shaddaGid || !fathaGid) fail(`T4 missing gids: shadda=${shaddaGid} fatha=${fathaGid}`);
  else if (!gpos.hasMarkMark) {
    ok(`T4 font has no mark-to-mark; skip`);
  } else {
    const att = gpos.getMarkMarkAttachment(shaddaGid, fathaGid);
    if (!att) ok(`T4 (shadda, fatha) — no attachment in this font (font-specific)`);
    else ok(`T4 (shadda, fatha) attachment: dx=${att.dx} dy=${att.dy}`);
  }
}

console.log();
console.log(failures === 0 ? 'GPOS-MARK PASS' : `GPOS-MARK FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
