// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// wouldSubstituteSmoke — GsubReader.wouldSubstitute answers structural
// questions about a font without substituting anything.
//
// An Indic shaper has to know whether a consonant has a below-base ('blwf')
// or post-base ('pstf') form, and whether a Ra + Halant pair is really a reph
// ('rphf'), BEFORE any feature runs — so it cannot find out by applying one.
// HarfBuzz answers with a would-substitute probe and so does this.
//
// Three checks, strongest first:
//
//   T1 a differential oracle on the synthesized font, over every feature and
//      a few thousand candidate sequences. A true answer is a promise, so
//      applying the feature has to change something; a false answer is only
//      about the whole sequence, so any change applying makes has to be
//      explained by a sub-range the probe does accept. Nothing in T1 is a
//      hand-written expectation — it is the probe checked against the engine
//      that does the real work.
//   T2 directed near-misses on the same font: right glyphs but wrong length,
//      wrong glyph in the context, sequence reversed.
//   T3 real fonts, against what HarfBuzz actually does. Gurmukhi Sangam MN
//      carries no 'rphf' at all and Sinhala Sangam MN carries one that does
//      not cover Ra + Halant; HarfBuzz builds no reph in either, and the
//      probe has to say so. hasFeature cannot distinguish the Sinhala case —
//      that is the whole point of the probe.
import { readFileSync, statSync, existsSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { otScriptTagsForScript } from '../../src/font/otScriptTags.js';
import { SCRIPT } from '../../src/font/unicode/scripts.js';
import { buildIndicGsubFont, CP, GID } from './_indicGsubFixture.mjs';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

const TAGS = ['psts', 'pres', 'blws', 'abvs', 'haln', 'half', 'blwf'];

const font = new MantleFontAsset(buildIndicGsubFont());
const gsub = font.gsub;
gsub.setShapingScript(otScriptTagsForScript(SCRIPT.Devanagari), 0);

// ---- T1: differential oracle ----------------------------------------
{
  // Candidates: every single glyph in range, then every ordered pair and
  // triple over the glyphs the fixture's lookups actually mention, so the
  // interesting sequences are all covered without enumerating 64^3.
  const interesting = Object.values(GID).concat([20, 21, 22, 25, 27, 28, 29, 0]);
  const seqs = [];
  for (let g = 0; g < 32; g++) seqs.push([g]);
  for (const a of interesting) for (const b of interesting) seqs.push([a, b]);
  for (const a of interesting)
    for (const b of interesting) for (const c of interesting) seqs.push([a, b, c]);

  let claimed = 0,
    checked = 0,
    bad = 0;
  for (const tag of TAGS) {
    for (const seq of seqs) {
      checked++;
      const would = gsub.wouldSubstitute(tag, seq);
      const out = gsub.applyFeatureToSeq(tag, seq);
      const changed = out.join() !== seq.join();
      if (would) {
        claimed++;
        // A true answer is a promise: applying the feature must do something.
        if (!changed) {
          bad++;
          if (bad <= 5) fail(`T1 ${tag} [${seq}] claimed it would fire, applying changed nothing`);
        }
      } else if (changed) {
        // A false answer is only about the whole sequence: the probe asks
        // whether these glyphs, all of them, would be substituted. Applying
        // is under no such obligation — it can fire on a shorter prefix, or
        // further along. So the change is explained if any sub-range is one
        // the probe accepts. Context is allowed for those: applied to the
        // full sequence, a lookup really does have neighbours to match a
        // backtrack or lookahead against.
        let excused = false;
        for (let s = 0; s < seq.length && !excused; s++) {
          for (let L = 1; L <= seq.length - s && !excused; L++) {
            if (s === 0 && L === seq.length) continue; // that is the probe; it said no
            if (gsub.wouldSubstitute(tag, seq.slice(s, s + L), false)) excused = true;
          }
        }
        if (!excused) {
          bad++;
          if (bad <= 5) fail(`T1 ${tag} [${seq}] said no, but applying gave [${out}]`);
        }
      }
    }
  }
  if (!bad)
    ok(`T1 ${checked} feature/sequence pairs agree with applying the feature (${claimed} fire)`);
}

// ---- T2: directed near-misses ---------------------------------------
{
  // [label, tag, sequence, expected]. The fixture's contexts are disjoint,
  // so each false here is a specific way of being close but not right.
  const CASES = [
    // psts's rule needs a backtrack, so strict says no and loose says yes.
    ['type 6 fmt 3 with backtrack, strict', 'psts', [GID.AA], false],
    ['type 6 fmt 3, an uncovered glyph', 'psts', [GID.I], false],
    ['type 6 fmt 3, one glyph too many', 'psts', [GID.AA, GID.KA], false],
    ['type 6 fmt 1, exact input run', 'pres', [GID.I, GID.KA], true],
    ['type 6 fmt 1, wrong second glyph', 'pres', [GID.I, GID.TA], false],
    ['type 6 fmt 1, input truncated', 'pres', [GID.I], false],
    ['type 5 fmt 3, all three covered', 'blws', [GID.TA, GID.VIRAMA, GID.YA], true],
    ['type 5 fmt 3, reversed', 'blws', [GID.YA, GID.VIRAMA, GID.TA], false],
    ['type 5 fmt 3, one short', 'blws', [GID.TA, GID.VIRAMA], false],
    ['type 2 multiple', 'abvs', [GID.NA], true],
    ['type 2, a second glyph', 'abvs', [GID.NA, GID.KA], false],
    ['type 3 alternate', 'haln', [GID.SSA], true],
    ['type 3, uncovered', 'haln', [GID.KA], false],
    // half's rule needs a lookahead, so under HarfBuzz's zero-context rule a
    // bare probe cannot satisfy it; pass zeroContext=false and it can.
    ['type 6 with lookahead, strict', 'half', [GID.MA, GID.VIRAMA], false],
    // blwf's reverse chain needs a backtrack, so the same applies.
    ['type 8 with backtrack, strict', 'blwf', [GID.TA], false],
  ];
  let bad = 0;
  for (const [label, tag, seq, want] of CASES) {
    const got = gsub.wouldSubstitute(tag, seq);
    if (got !== want) {
      bad++;
      fail(`T2 ${label}: ${tag} [${seq}] gave ${got}, want ${want}`);
    }
  }
  // The same two, with the zero-context rule relaxed, match on input alone.
  if (gsub.wouldSubstitute('psts', [GID.AA], false) !== true) {
    bad++;
    fail('T2 psts with zeroContext=false should match its input sequence');
  }
  if (gsub.wouldSubstitute('half', [GID.MA, GID.VIRAMA], false) !== true) {
    bad++;
    fail('T2 half with zeroContext=false should match its input sequence');
  }
  if (gsub.wouldSubstitute('blwf', [GID.TA], false) !== true) {
    bad++;
    fail('T2 blwf with zeroContext=false should match its coverage');
  }
  if (!bad)
    ok(`T2 ${CASES.length + 3} directed cases, including near-misses and the zero-context rule`);
}

// ---- T3: real fonts, against HarfBuzz's own reph decision ------------
// [label, path, size, RA, VIRAMA, script, hasFeature, probe]
// `probe` is what HarfBuzz does: shaping RA+VIRAMA+KA, it builds a reph in
// the first four and leaves the Ra in place in the last three.
const REAL = [
  [
    'Devanagari Sangam MN',
    '/System/Library/Fonts/Supplemental/Devanagari Sangam MN.ttc',
    1021020,
    0x0930,
    0x094d,
    'Devanagari',
    true,
    true,
  ],
  [
    'ITF Devanagari',
    '/System/Library/Fonts/Supplemental/ITFDevanagari.ttc',
    800948,
    0x0930,
    0x094d,
    'Devanagari',
    true,
    true,
  ],
  [
    'Bangla Sangam MN',
    '/System/Library/Fonts/Supplemental/Bangla Sangam MN.ttc',
    435872,
    0x09b0,
    0x09cd,
    'Bengali',
    true,
    true,
  ],
  [
    'Kannada Sangam MN',
    '/System/Library/Fonts/Supplemental/Kannada Sangam MN.ttc',
    292540,
    0x0cb0,
    0x0ccd,
    'Kannada',
    true,
    true,
  ],
  // No 'rphf' under the run's language system at all.
  [
    'Gurmukhi Sangam MN',
    '/System/Library/Fonts/Supplemental/Gurmukhi Sangam MN.ttc',
    139016,
    0x0a30,
    0x0a4d,
    'Gurmukhi',
    false,
    false,
  ],
  [
    'Telugu Sangam MN',
    '/System/Library/Fonts/Supplemental/Telugu Sangam MN.ttc',
    303008,
    0x0c30,
    0x0c4d,
    'Telugu',
    false,
    false,
  ],
  // Carries 'rphf', but it does not cover this pair — hasFeature says true
  // and HarfBuzz still builds no reph. Only the probe gets this right.
  [
    'Sinhala Sangam MN',
    '/System/Library/Fonts/Supplemental/Sinhala Sangam MN.ttc',
    752820,
    0x0dbb,
    0x0dca,
    'Sinhala',
    true,
    false,
  ],
];
{
  let bad = 0,
    ran = 0;
  for (const [label, path, size, RA, VIR, script, wantFeature, wantProbe] of REAL) {
    if (!existsSync(path) || statSync(path).size !== size) {
      console.log(`skip ${label}: missing or not the recorded build`);
      continue;
    }
    ran++;
    const f = new MantleFontAsset(new Uint8Array(readFileSync(path)));
    const g = f.gsub;
    g.setShapingScript(otScriptTagsForScript(SCRIPT[script]), 0);
    const pair = [f.codepointToGlyphId(RA), f.codepointToGlyphId(VIR)];
    const hasF = g.hasFeature('rphf');
    const probe = g.wouldSubstitute('rphf', pair);
    if (hasF !== wantFeature) {
      bad++;
      fail(`T3 ${label} hasFeature('rphf') = ${hasF}, want ${wantFeature}`);
    }
    if (probe !== wantProbe) {
      bad++;
      fail(`T3 ${label} wouldSubstitute('rphf', [ra,halant]) = ${probe}, want ${wantProbe}`);
    }
  }
  if (!bad && ran) ok(`T3 ${ran} real fonts agree with HarfBuzz's reph decision`);
  else if (!ran) console.log('T3 skipped: no recorded font present');
}

// ---- T4: the consonant-form probe on real fonts ---------------------
// The question the base search will ask: does this consonant have a
// below-base ('blwf') or post-base ('pstf') form? HarfBuzz probes the pair
// both ways round, because old-spec fonts order it consonant + virama and
// new-spec fonts virama + consonant. Here the claim is checked against the
// engine: whenever the probe says a form exists, applying that feature to
// the same pair has to produce one. A false positive is the dangerous
// direction — it would give the base search a form that is not there.
{
  let bad = 0,
    ran = 0,
    forms = 0;
  for (const [label, path, size, , VIR, script] of REAL) {
    if (!existsSync(path) || statSync(path).size !== size) continue;
    ran++;
    const f = new MantleFontAsset(new Uint8Array(readFileSync(path)));
    const g = f.gsub;
    g.setShapingScript(otScriptTagsForScript(SCRIPT[script]), 0);
    const virama = f.codepointToGlyphId(VIR);
    // Every consonant in the script's block, by codepoint range around the
    // virama — enough to sweep the font without knowing its repertoire.
    for (let cp = VIR - 0x4d; cp <= VIR; cp++) {
      const c = f.codepointToGlyphId(cp);
      if (!c) continue;
      for (const tag of ['blwf', 'pstf', 'pref']) {
        for (const pair of [
          [virama, c],
          [c, virama],
        ]) {
          if (!g.wouldSubstitute(tag, pair, false)) continue;
          forms++;
          const out = g.applyFeatureToSeq(tag, pair);
          if (out.join() === pair.join()) {
            bad++;
            if (bad <= 5)
              fail(`T4 ${label} ${tag} [${pair}] claimed a form, applying changed nothing`);
          }
        }
      }
    }
  }
  if (!bad && ran)
    ok(`T4 ${forms} consonant forms claimed across ${ran} real fonts, every one borne out`);
  else if (!ran) console.log('T4 skipped: no recorded font present');
}

console.log();
console.log(failures ? `WOULD-SUBSTITUTE FAIL (${failures})` : 'WOULD-SUBSTITUTE PASS');
process.exitCode = failures ? 1 : 0;
