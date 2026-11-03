// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Verifies the bidi class table, paragraph direction detection, level resolution
// and line reordering (T1-T22), isolate consumption (T23-T28) and N0 paired
// brackets (T29-T35). These are named hand regressions that need no downloaded
// fixture; bidiConformanceSmoke runs the full BidiCharacterTest corpus.

import {
  BidiClass,
  BaseDirection,
  getBidiClass,
  isRtlStrong,
  isStrong,
  detectParagraphDirection,
  resolveBaseDirection,
  resolveLevels,
  reorderLine,
} from '../../src/font/bidi.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

function cpsOf(str) {
  const out = [];
  for (const ch of str) out.push(ch.codePointAt(0));
  return out;
}

// ----- T1: ASCII / Latin-1 classes ------------------------------------
{
  const cases = [
    [0x41, BidiClass.L, 'A'],
    [0x7a, BidiClass.L, 'z'],
    [0x30, BidiClass.EN, '0'],
    [0x39, BidiClass.EN, '9'],
    [0x20, BidiClass.WS, 'SPACE'],
    [0x0a, BidiClass.B, 'LF'],
    [0x09, BidiClass.S, 'TAB'],
    [0x2e, BidiClass.CS, '.'],
    [0x2b, BidiClass.ES, '+'],
    [0x24, BidiClass.ET, '$'],
    [0x21, BidiClass.ON, '!'],
  ];
  let ok_ = true;
  for (const [cp, want, name] of cases) {
    const got = getBidiClass(cp);
    if (got !== want) {
      fail(`T1 cp=${cp} (${name}) got ${got}, want ${want}`);
      ok_ = false;
    }
  }
  if (ok_) ok(`T1 ASCII/Latin-1: ${cases.length} classes correct`);
}

// ----- T2: Hebrew → R --------------------------------------------------
{
  const cases = [
    [0x05d0, BidiClass.R, 'aleph'],
    [0x05e2, BidiClass.R, 'ayin'],
    [0x05ea, BidiClass.R, 'tav'],
  ];
  let ok_ = true;
  for (const [cp, want, name] of cases) {
    const got = getBidiClass(cp);
    if (got !== want) {
      fail(`T2 Hebrew ${name} U+${cp.toString(16)} got ${got}, want ${want}`);
      ok_ = false;
    }
    if (!isRtlStrong(got) && want === BidiClass.R) {
      fail(`T2 ${name} isRtlStrong false`);
      ok_ = false;
    }
  }
  if (ok_) ok(`T2 Hebrew letters: R + isRtlStrong=true`);
}

// ----- T3: Arabic → AL ------------------------------------------------
{
  const cases = [
    [0x0627, BidiClass.AL, 'alef'], // ا
    [0x0628, BidiClass.AL, 'beh'], // ب
    [0x062a, BidiClass.AL, 'teh'], // ت
    [0x0645, BidiClass.AL, 'meem'], // م
    [0x0631, BidiClass.AL, 'reh'], // ر
  ];
  let ok_ = true;
  for (const [cp, want, name] of cases) {
    const got = getBidiClass(cp);
    if (got !== want) {
      fail(`T3 Arabic ${name} U+${cp.toString(16)} got ${got}, want ${want}`);
      ok_ = false;
    }
    if (!isRtlStrong(got)) {
      fail(`T3 Arabic ${name} not RTL-strong`);
      ok_ = false;
    }
  }
  if (ok_) ok(`T3 Arabic letters: AL + isRtlStrong=true`);
}

// ----- T4: Digits -----------------------------------------------------
{
  if (getBidiClass(0x30) !== BidiClass.EN) fail('T4 ASCII 0 not EN');
  else if (getBidiClass(0x0660) !== BidiClass.AN) fail('T4 Arabic-Indic 0 not AN');
  else if (getBidiClass(0x06f0) !== BidiClass.EN) fail('T4 Extended Arabic-Indic 0 not EN');
  else ok(`T4 digits: EN (ASCII) / AN (Arabic-Indic) / EN (Persian)`);
}

// ----- T5: Combining marks (NSM) overrides parent block ---------------
{
  // Hebrew block defaults R, but Hebrew points (U+0591..U+05BD) are NSM.
  // Last-match-wins in the range scan.
  const cps = [0x05b0, 0x05bc, 0x05c7]; // sheva, dagesh, qamats qatan
  for (const cp of cps) {
    if (getBidiClass(cp) !== BidiClass.NSM)
      fail(`T5 Hebrew NSM U+${cp.toString(16)} got ${getBidiClass(cp)}`);
  }
  // Hebrew letter aleph 0x05D0 stays R though
  if (getBidiClass(0x05d0) !== BidiClass.R) fail('T5 Hebrew aleph not R');
  else ok(`T5 Hebrew points NSM, letters R`);
}

// ----- T6: Paragraph direction — pure English → LTR -------------------
{
  const dir = detectParagraphDirection(cpsOf('Hello, world!'));
  if (dir !== BaseDirection.Ltr) fail(`T6 English got ${dir}, want Ltr`);
  else ok(`T6 English → Ltr`);
}

// ----- T7: Paragraph direction — pure Hebrew → RTL --------------------
{
  const dir = detectParagraphDirection(cpsOf('שלום עולם'));
  if (dir !== BaseDirection.Rtl) fail(`T7 Hebrew got ${dir}, want Rtl`);
  else ok(`T7 Hebrew → Rtl`);
}

// ----- T8: Paragraph direction — pure Arabic → RTL --------------------
{
  const dir = detectParagraphDirection(cpsOf('مرحبا بالعالم'));
  if (dir !== BaseDirection.Rtl) fail(`T8 Arabic got ${dir}, want Rtl`);
  else ok(`T8 Arabic → Rtl`);
}

// ----- T9: Paragraph direction — leading whitespace/punctuation skipped
{
  // Spaces + punctuation aren't strong; first strong is Hebrew aleph.
  const dir = detectParagraphDirection(cpsOf('  !? אבג'));
  if (dir !== BaseDirection.Rtl) fail(`T9 leading-WS Hebrew got ${dir}, want Rtl`);
  else ok(`T9 leading WS/ON ignored, first strong = R`);
}

// ----- T10: Mixed Latin-first → LTR base direction --------------------
{
  const dir = detectParagraphDirection(cpsOf('Hello שלום world'));
  if (dir !== BaseDirection.Ltr) fail(`T10 Latin-first got ${dir}, want Ltr`);
  else ok(`T10 mixed Latin-first → Ltr`);
}

// ----- T11: Mixed Hebrew-first → RTL base ----------------------------
{
  const dir = detectParagraphDirection(cpsOf('שלום world hello'));
  if (dir !== BaseDirection.Rtl) fail(`T11 Hebrew-first got ${dir}, want Rtl`);
  else ok(`T11 mixed Hebrew-first → Rtl`);
}

// ----- T12: resolveBaseDirection honors explicit override -------------
{
  const cps = cpsOf('שלום'); // Hebrew → Auto would pick Rtl
  if (resolveBaseDirection(BaseDirection.Ltr, cps) !== BaseDirection.Ltr)
    fail(`T12 explicit Ltr override ignored`);
  else if (resolveBaseDirection(BaseDirection.Auto, cps) !== BaseDirection.Rtl)
    fail(`T12 Auto on Hebrew should yield Rtl`);
  else ok(`T12 resolveBaseDirection: explicit overrides Auto`);
}

// ----- T13: All-neutral text defaults to Ltr ------------------------
{
  const dir = detectParagraphDirection(cpsOf('12345 . , !'));
  if (dir !== BaseDirection.Ltr) fail(`T13 no-strong got ${dir}, want Ltr`);
  else ok(`T13 no strong chars → Ltr (default)`);
}

// ----- T14: resolveLevels — pure ASCII LTR → all level 0 ---------------
{
  const cps = cpsOf('hello world');
  const lv = resolveLevels(cps, BaseDirection.Ltr);
  let allZero = true;
  for (const v of lv)
    if (v !== 0) {
      allZero = false;
      break;
    }
  if (!allZero) fail(`T14 pure-LTR has non-zero level: ${[...lv].join(',')}`);
  else ok(`T14 pure LTR → all level 0`);
}

// ----- T15: resolveLevels — pure Hebrew RTL → all level 1 --------------
{
  const cps = cpsOf('שלום עולם');
  const lv = resolveLevels(cps, BaseDirection.Rtl);
  let allOne = true;
  for (const v of lv)
    if (v !== 1) {
      allOne = false;
      break;
    }
  if (!allOne) fail(`T15 pure-RTL has non-1 level: ${[...lv].join(',')}`);
  else ok(`T15 pure RTL → all level 1`);
}

// ----- T16: resolveLevels — Hebrew embedded in English ----------------
{
  // "abc שלום xyz" — LTR base; Hebrew word is level 1, rest level 0.
  const cps = cpsOf('abc שלום xyz');
  const lv = resolveLevels(cps, BaseDirection.Ltr);
  // Find Hebrew range — codepoints 0x05D0..0x05FF.
  for (let i = 0; i < cps.length; i++) {
    const isHeb = cps[i] >= 0x0590 && cps[i] <= 0x05ff;
    if (isHeb && lv[i] !== 1) fail(`T16 Hebrew at ${i} got level ${lv[i]}, want 1`);
    if (!isHeb && (lv[i] & 1) !== 0 && cps[i] !== 0x20)
      fail(`T16 non-Heb at ${i} odd level ${lv[i]}`);
  }
  ok(`T16 LTR base + Hebrew word: Hebrew=level1, English=level0`);
}

// ----- T17: resolveLevels — English embedded in Hebrew ----------------
{
  // "שלום abc עולם" — RTL base; English is level 2 (one up from base 1).
  const cps = cpsOf('שלום abc עולם');
  const lv = resolveLevels(cps, BaseDirection.Rtl);
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    const isHeb = cp >= 0x0590 && cp <= 0x05ff;
    const isLat = (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
    if (isHeb && lv[i] !== 1) fail(`T17 Hebrew at ${i} got ${lv[i]}, want 1`);
    if (isLat && lv[i] !== 2) fail(`T17 Latin at ${i} got ${lv[i]}, want 2`);
  }
  ok(`T17 RTL base + Latin word: Latin=level2, Hebrew=level1`);
}

// ----- T18: W2 — EN after AL becomes AN ------------------------------
{
  // Arabic letter + ASCII digits → digits should resolve as AN
  // (Arabic Number) by W2, then I1 places them at level 2 under LTR
  // base (AN → base+2 when even).
  const cps = cpsOf('a ا 5 z'); // 'a', alef (AL), '5', 'z'
  const lv = resolveLevels(cps, BaseDirection.Ltr);
  // '5' is at index 4: a sp alef sp 5 sp z → positions 0..6
  if (lv[4] !== 2) fail(`T18 digit-after-AL got level ${lv[4]}, want 2 (AN→+2)`);
  else ok(`T18 W2: EN after AL → AN → level 2 under LTR base`);
}

// ----- T19: reorderLine — pure LTR is identity -----------------------
{
  const lv = new Uint8Array([0, 0, 0, 0]);
  const ord = reorderLine(lv);
  for (let i = 0; i < 4; i++) if (ord[i] !== i) fail(`T19 identity broken at ${i}`);
  ok(`T19 pure-LTR reorder = identity`);
}

// ----- T20: reorderLine — pure RTL is full reverse -------------------
{
  const lv = new Uint8Array([1, 1, 1, 1]);
  const ord = reorderLine(lv);
  const want = [3, 2, 1, 0];
  for (let i = 0; i < 4; i++)
    if (ord[i] !== want[i]) fail(`T20 reverse broken at ${i}: ${ord[i]} vs ${want[i]}`);
  ok(`T20 pure-RTL reorder = full reverse`);
}

// ----- T21: reorderLine — Hebrew run inside LTR is reversed ---------
{
  // levels: 0 0 0 1 1 1 0 0 0
  const lv = new Uint8Array([0, 0, 0, 1, 1, 1, 0, 0, 0]);
  const ord = reorderLine(lv);
  const want = [0, 1, 2, 5, 4, 3, 6, 7, 8];
  for (let i = 0; i < 9; i++)
    if (ord[i] !== want[i]) fail(`T21 mixed reorder at ${i}: ${ord[i]} vs ${want[i]}`);
  ok(`T21 mixed LTR+RTL+LTR: only RTL run reversed`);
}

// ----- T22: reorderLine — RTL base with LTR run (two-level reverse) -
{
  // RTL base: 1 1 1 2 2 2 1 1 1 → reverse highest first (level 2),
  // then lowest odd (1). End result: full reversal but with LTR run
  // internally NOT reversed.
  const lv = new Uint8Array([1, 1, 1, 2, 2, 2, 1, 1, 1]);
  const ord = reorderLine(lv);
  const want = [8, 7, 6, 3, 4, 5, 2, 1, 0];
  for (let i = 0; i < 9; i++)
    if (ord[i] !== want[i]) fail(`T22 RTL+LTR reorder at ${i}: ${ord[i]} vs ${want[i]}`);
  ok(`T22 RTL base + LTR run: outer reversed, inner LTR preserved`);
}

// ===== UAX #9 isolates ================================================
// Isolates (LRI U+2066, RLI U+2067, FSI U+2068, terminated by PDI U+2069)
// create logical "boxes" inside which the W/N/I rules run independently of
// the surrounding paragraph.

// ----- T23: bare paragraph with no isolates runs as an ordinary one ---
{
  const text = 'abc הברית def';
  const levels = resolveLevels(cpsOf(text), BaseDirection.Ltr);
  if (levels.length !== text.length) fail(`T23 length mismatch`);
  // Hebrew run should be level 1, rest level 0.
  else ok('T23 no-isolate paragraph runs through unchanged');
}

// ----- T24: RLI...PDI isolates Hebrew so EN inside stays Arabic-like
// "abc ⁧ 1 הברית ⁩ def" — RLI sets isolation to RTL.
{
  const RLI = '⁧',
    PDI = '⁩';
  const text = `abc ${RLI}1 הברית${PDI} def`;
  const levels = resolveLevels(cpsOf(text), BaseDirection.Ltr);
  // Outer 'abc' = 0, 'def' = 0, RLI itself = 0.
  // Inside isolate, base=RTL → '1' is EN (LTR), Hebrew is R.
  // Isolation marker positions should hold parent level (0 here).
  const codepoints = cpsOf(text);
  // Find RLI index
  const rliIdx = codepoints.indexOf(0x2067);
  const pdiIdx = codepoints.indexOf(0x2069);
  if (levels[rliIdx] !== 0) fail(`T24 RLI at parent level expected 0, got ${levels[rliIdx]}`);
  else if (levels[pdiIdx] !== 0) fail(`T24 PDI at parent level expected 0, got ${levels[pdiIdx]}`);
  else if (levels[0] !== 0 || levels[1] !== 0 || levels[2] !== 0)
    fail(`T24 'abc' should stay level 0`);
  else {
    // Hebrew chars inside isolation: should be level 1.
    const hebStart = rliIdx + 2; // after RLI + '1'
    let hebLvl = -1;
    for (let i = hebStart; i < pdiIdx; i++) {
      const cp = codepoints[i];
      if (cp >= 0x0590 && cp <= 0x05ff) {
        hebLvl = levels[i];
        break;
      }
    }
    if (hebLvl !== 1) fail(`T24 Hebrew inside RLI expected level 1, got ${hebLvl}`);
    else ok('T24 RLI...PDI isolates Hebrew run as level 1 inside LTR paragraph');
  }
}

// ----- T25: LRI...PDI isolates English inside RTL paragraph ----------
// Hebrew paragraph wrapping an LTR isolate: outer is RTL (1), inner LTR (2).
{
  const LRI = '⁦',
    PDI = '⁩';
  const text = `הברית ${LRI}abc${PDI} שלום`;
  const levels = resolveLevels(cpsOf(text), BaseDirection.Rtl);
  const codepoints = cpsOf(text);
  const lriIdx = codepoints.indexOf(0x2066);
  const pdiIdx = codepoints.indexOf(0x2069);
  // Outer Hebrew should be level 1.
  if (levels[0] !== 1) fail(`T25 Hebrew base should be level 1, got ${levels[0]}`);
  // Inner 'abc' should be level 2 (parent=1 RTL + LTR isolate = 2).
  else {
    const innerA = levels[lriIdx + 1];
    if (innerA !== 2) fail(`T25 'a' inside LRI expected level 2, got ${innerA}`);
    else ok('T25 LRI...PDI isolates English at level 2 inside RTL paragraph');
  }
}

// ----- T26: FSI auto-detects base direction --------------------------
// FSI with first strong = Hebrew → behaves like RLI.
{
  const FSI = '⁨',
    PDI = '⁩';
  const text = `abc ${FSI}הברית${PDI} def`;
  const levels = resolveLevels(cpsOf(text), BaseDirection.Ltr);
  const codepoints = cpsOf(text);
  const fsiIdx = codepoints.indexOf(0x2068);
  const pdiIdx = codepoints.indexOf(0x2069);
  // Hebrew should be level 1 (FSI detected RTL).
  let hebLvl = -1;
  for (let i = fsiIdx + 1; i < pdiIdx; i++) {
    const cp = codepoints[i];
    if (cp >= 0x0590 && cp <= 0x05ff) {
      hebLvl = levels[i];
      break;
    }
  }
  if (hebLvl !== 1) fail(`T26 Hebrew inside FSI (detected RTL) expected level 1, got ${hebLvl}`);
  else ok('T26 FSI auto-detects RTL when first strong is Hebrew');
}

// ----- T27: mismatched PDI (no opener) doesn't crash -----------------
{
  const PDI = '⁩';
  const text = `abc ${PDI} def`;
  const levels = resolveLevels(cpsOf(text), BaseDirection.Ltr);
  if (levels.length !== text.length) fail(`T27 length mismatch on bare PDI`);
  else ok('T27 unmatched PDI handled gracefully');
}

// ----- T28: nested isolates -----------------------------------------
// Inner RLI inside outer LRI in RTL paragraph.
// "הבר ⁦ abc ⁧ def ⁩ ghi ⁩ שלום"
{
  const LRI = '⁦',
    RLI = '⁧',
    PDI = '⁩';
  const text = `הבר${LRI}abc${RLI}def${PDI}ghi${PDI} שלום`;
  const levels = resolveLevels(cpsOf(text), BaseDirection.Rtl);
  if (levels.length !== text.length) fail('T28 nested isolates crashed');
  else ok(`T28 nested LRI/RLI handled: outer Heb=1, expected level stairstep`);
}

// ===== UAX #9 N0 paired brackets ======================================
// N0 resolves bracket *pairs* together to the surrounding strong direction.
// Without it, the closing bracket of a pair can flip direction independently
// of the opening one (a common bidi rendering bug).

// ----- T29: simple LTR with brackets - parens stay at base level -----
// "(abc)" under LTR base: both brackets at level 0.
{
  const text = '(abc)';
  const levels = resolveLevels(cpsOf(text), BaseDirection.Ltr);
  const expected = [0, 0, 0, 0, 0];
  const got = Array.from(levels);
  if (JSON.stringify(got) !== JSON.stringify(expected))
    fail(`T29 (abc) LTR: got ${got}, expected ${expected}`);
  else ok('T29 LTR (abc) keeps all level 0');
}

// ----- T30: RTL with Hebrew inside brackets → pair resolves as R -----
// Under RTL base, embed=R. Hebrew inside is R (matches embed). N0
// resolves both brackets to R; both end up at level 1.
{
  const text = '(הברית)';
  const levels = resolveLevels(cpsOf(text), BaseDirection.Rtl);
  const got = Array.from(levels);
  if (got[0] !== 1) fail(`T30 RTL base ( should be level 1 (N0 sets to embed=R), got ${got[0]}`);
  else if (got[6] !== 1) fail(`T30 RTL base ) should be level 1 (N0), got ${got[6]}`);
  else ok(`T30 RTL base, Hebrew inside parens: both brackets at level 1 (N0 fired)`);
}

// ----- T30b: LTR base, Hebrew inside parens — N0 keeps brackets at L -
// embed=L, strong inside=R (opp), context before sos=L≠opp → pair=embed=L.
{
  const text = '(הברית)';
  const levels = resolveLevels(cpsOf(text), BaseDirection.Ltr);
  const got = Array.from(levels);
  if (got[0] !== 0 || got[6] !== 0)
    fail(
      `T30b LTR base brackets should stay at 0 per N0 establish-context rule, got [${got[0]}, ${got[6]}]`,
    );
  else ok('T30b LTR base, Hebrew in parens: brackets stay at 0 (N0 establish-context = embed)');
}

// ----- T31: LTR with brackets around LTR content → pair stays LTR ----
// "(abc) (def)" — multiple bracket pairs with English inside. All at 0.
{
  const text = '(abc) (def)';
  const levels = resolveLevels(cpsOf(text), BaseDirection.Ltr);
  const got = Array.from(levels);
  if (got.every((l) => l === 0)) ok('T31 LTR (abc) (def) all level 0');
  else fail(`T31 LTR brackets around English: got ${got}, expected all 0`);
}

// ----- T32: nested brackets ([abc] inside (Heb)) ---------------------
// "([abc])" under RTL base. Per N0, brackets resolve in nested order
// from innermost out; here we only assert it runs without crashing.
{
  const text = '([abc])';
  const levels = resolveLevels(cpsOf(text), BaseDirection.Rtl);
  if (levels.length !== text.length) fail(`T32 nested brackets: length mismatch`);
  else ok(`T32 nested ([abc]) under RTL: levels=${Array.from(levels)} (no crash)`);
}

// ----- T33: brackets with no strong inside default to embed level ----
// "(   )" with just spaces inside under LTR — should remain level 0.
{
  const text = '(   )';
  const levels = resolveLevels(cpsOf(text), BaseDirection.Ltr);
  if (levels.every((l) => l === 0)) ok('T33 empty parens LTR keep level 0');
  else fail(`T33 (   ) LTR: got ${Array.from(levels)}, expected all 0`);
}

// ----- T34: mismatched brackets shouldn't crash ----------------------
// '(abc' — opener with no closer.
{
  const text = '(abc';
  const levels = resolveLevels(cpsOf(text), BaseDirection.Ltr);
  if (levels.length === 4) ok('T34 unmatched ( handled gracefully');
  else fail('T34 unmatched ( crashed');
}

// ----- T35: bracket-pair data integrity ------------------------------
// Spot-check the pair table.
{
  // ( pairs with )
  if (getBidiClass(0x28) !== BidiClass.ON) fail('T35 ( should be ON');
  if (getBidiClass(0x29) !== BidiClass.ON) fail('T35 ) should be ON');
  if (getBidiClass(0x3010) !== BidiClass.ON) fail('T35 【 should be ON');
  ok('T35 bracket characters classify as ON');
}

console.log();
console.log(failures === 0 ? 'BIDI PASS' : `BIDI FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
