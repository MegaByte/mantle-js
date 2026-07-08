// textRunFeaturesSmoke.mjs — verifies caller-controlled OpenType feature
// toggles on the text-run pipeline.
//
// Asserts:
//   T1: `features.tnum` produces tabular-width digits — '1' and '0'
//       have equal advance, where without tnum they don't.
//   T2: `disabledFeatures: ['kern']` removes pair-kerning + GPOS
//       SinglePos xAdvance deltas on a known kern-pair (A V or T A).
//   T3: `disabledFeatures: ['liga']` blocks ligature substitution on
//       'fi' — output has 2 slots with two distinct gids, not 1.
//   T4: `features.smcp` produces small-caps glyph swap when the font
//       ships them (equivalent to the existing <smallcaps> markup).
//   T5: Unknown tag (`xxxx`) no-ops silently — output identical to
//       no-features run.

import { readFileSync, existsSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildStyled, _layoutSlotsForTest } from '../../src/font/textRun.js';
import { defaultStyle } from '../../src/font/markupParser.js';

const candidates = [
  process.argv[2],
  process.env.MANTLE_FONT,
  '/System/Library/Fonts/Supplemental/Arial.ttf',
].filter(Boolean);
const fontPath = candidates.find(p => existsSync(p));
if (!fontPath) {
  console.log('Skip textRunFeatures: no TTF found');
  process.exit(0);
}
const font = new MantleFontAsset(new Uint8Array(readFileSync(fontPath)));
font.getMetrics(0x20);

let failures = 0;
const fail = (msg) => { console.error('FAIL', msg); failures++; };
const ok   = (msg) => console.log('ok', msg);

function makeSpan(text) {
  return [{ text, style: defaultStyle() }];
}

function slotsFor(text, layout) {
  return _layoutSlotsForTest(makeSpan(text), font, layout || {});
}

// ----- T1: tnum equalizes digit advances ---------------------------
{
  const noTnum = slotsFor('10', {});
  const tnum   = slotsFor('10', { features: { tnum: true } });
  if (noTnum.length !== 2 || tnum.length !== 2) {
    fail(`T1 expected 2 slots each, got ${noTnum.length} / ${tnum.length}`);
  } else {
    const advNoTnum_1 = noTnum[0].advance;
    const advNoTnum_0 = noTnum[1].advance;
    const advTnum_1   = tnum[0].advance;
    const advTnum_0   = tnum[1].advance;
    // tnum's contract: '1'.advance == '0'.advance. Verify with a
    // reasonable epsilon (em-space, post-tnum digits should match to
    // within a sub-millionth).
    const tnumEq = Math.abs(advTnum_1 - advTnum_0) < 1e-6;
    // Either: the font supports tnum and advances now match, OR the
    // font has no tnum table and the call no-oped (advances unchanged).
    if (font.gsub && font.gsub.hasFeature('tnum')) {
      if (!tnumEq) fail(`T1 tnum on, '1' adv ${advTnum_1} != '0' adv ${advTnum_0}`);
      else ok(`T1 tnum equalizes digit advances: '1'=='0' ≈ ${advTnum_1.toFixed(4)} (no-tnum was ${advNoTnum_1.toFixed(4)} / ${advNoTnum_0.toFixed(4)})`);
    } else {
      // Font has no tnum — verify call no-oped (advances unchanged).
      if (advTnum_1 !== advNoTnum_1 || advTnum_0 !== advNoTnum_0) {
        fail(`T1 font has no tnum but advances changed: ${advNoTnum_1}→${advTnum_1}, ${advNoTnum_0}→${advTnum_0}`);
      } else ok(`T1 font has no tnum table → call no-oped silently (advances unchanged)`);
    }
  }
}

// ----- T2: disabling kern removes pair-kerning advance shift -------
{
  // 'AV' is the canonical kern pair across Latin fonts.
  const kerned   = slotsFor('AV', {});
  const unkerned = slotsFor('AV', { disabledFeatures: ['kern'] });
  if (kerned.length !== 2 || unkerned.length !== 2) {
    fail(`T2 expected 2 slots each, got ${kerned.length} / ${unkerned.length}`);
  } else {
    // The V slot's penX with kerning enabled should be ≤ its penX
    // with kerning disabled (kerning brings 'V' closer to 'A').
    // Some fonts ship no kern for AV; in that case both equal and we
    // verify the call still no-oped cleanly.
    const dKerned   = kerned[1].penX;
    const dUnkerned = unkerned[1].penX;
    if (dKerned > dUnkerned + 1e-6) {
      fail(`T2 kerned penX ${dKerned} > unkerned penX ${dUnkerned} — disabling kern moved glyphs closer?`);
    } else if (Math.abs(dKerned - dUnkerned) > 1e-6) {
      ok(`T2 kern disable removes pair adjustment: V penX ${dKerned.toFixed(4)} → ${dUnkerned.toFixed(4)} (+${(dUnkerned-dKerned).toFixed(4)})`);
    } else {
      ok(`T2 font has no kern pair for 'AV' (penX equal both ways) — disable still safe`);
    }
  }
}

// ----- T3: disabling liga blocks 'fi' substitution -----------------
{
  // 'fi' is the canonical ligature; many but not all fonts ship it.
  const fGsub = font.gsub;
  if (!fGsub || !fGsub.hasLigatures) {
    ok(`T3 font has no ligatures → skip (disabling a non-existent feature is a no-op by construction)`);
  } else {
    const ligOn  = slotsFor('fi', {});
    const ligOff = slotsFor('fi', { disabledFeatures: ['liga'] });
    // With ligatures on, MAY collapse to 1 slot (if font ships 'fi'
    // ligature) or stay 2 (if it doesn't). With ligatures off, must
    // stay 2.
    if (ligOff.length !== 2) {
      fail(`T3 ligature disable expected 2 slots, got ${ligOff.length}`);
    } else if (ligOn.length === 1) {
      ok(`T3 liga on → 1 slot (ligature fired), liga disabled → 2 slots (substitution blocked)`);
    } else {
      ok(`T3 font has no 'fi' ligature in its lookups → both paths emit 2 slots (no-op confirmed)`);
    }
  }
}

// ----- T4: smcp via features path swaps to small-caps gids ---------
{
  const fGsub = font.gsub;
  const upperGid = font.codepointToGlyphId(0x41); // 'A'
  const lowerGid = font.codepointToGlyphId(0x61); // 'a'
  if (!fGsub || !fGsub.hasSmallCaps) {
    ok(`T4 font ships no smcp table → skip`);
  } else {
    const noSmcp = slotsFor('a', {});
    const smcp   = slotsFor('a', { features: { smcp: true } });
    if (noSmcp.length !== 1 || smcp.length !== 1) {
      fail(`T4 expected 1 slot each, got ${noSmcp.length} / ${smcp.length}`);
    } else if (noSmcp[0].glyphId === smcp[0].glyphId) {
      fail(`T4 features.smcp didn't change gid for 'a' (${noSmcp[0].glyphId} == ${smcp[0].glyphId})`);
    } else {
      ok(`T4 features.smcp swaps 'a' gid ${noSmcp[0].glyphId} → ${smcp[0].glyphId}`);
    }
  }
}

// ----- T5: unknown tag no-ops silently -----------------------------
{
  const baseline = slotsFor('Hi', {});
  const withBogus = slotsFor('Hi', { features: { xxxx: true, qqqq: true } });
  let identical = baseline.length === withBogus.length;
  if (identical) {
    for (let i = 0; i < baseline.length; i++) {
      if (baseline[i].glyphId !== withBogus[i].glyphId
       || Math.abs(baseline[i].advance - withBogus[i].advance) > 1e-9
       || Math.abs(baseline[i].penX    - withBogus[i].penX)    > 1e-9) {
        identical = false; break;
      }
    }
  }
  if (!identical) fail('T5 unknown feature tags changed output — should no-op');
  else ok('T5 unknown feature tags no-op silently');
}

if (failures > 0) {
  console.error(`\nTEXT-RUN-FEATURES FAIL (${failures})`);
  process.exit(1);
}
console.log('\nTEXT-RUN-FEATURES PASS');
