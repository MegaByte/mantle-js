// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bidiN0Smoke.mjs — verifies UAX #9 N0 paired brackets resolution.
//
// N0 is the rule that resolves bracket *pairs* together to the
// surrounding strong direction. Without N0, the closing bracket of a
// pair can flip directions independently from the opening bracket
// (a common bidi rendering bug).

import { BidiClass, getBidiClass, resolveLevels, BaseDirection } from '../../src/font/bidi.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// Helper: build codepoints from a string.
const cps = (s) => Array.from(s).map((c) => c.codePointAt(0));

// ----- T1: simple LTR with brackets - parens stay at base level -----
// "(abc)" under LTR base: both brackets at level 0.
{
  const text = '(abc)';
  const levels = resolveLevels(cps(text), BaseDirection.Ltr);
  const expected = [0, 0, 0, 0, 0];
  const got = Array.from(levels);
  if (JSON.stringify(got) !== JSON.stringify(expected))
    fail(`T1 (abc) LTR: got ${got}, expected ${expected}`);
  else ok('T1 LTR (abc) keeps all level 0');
}

// ----- T2: RTL with Hebrew inside brackets → pair resolves as R -----
// Under RTL base, embed=R. Hebrew inside is R (matches embed). N0
// resolves both brackets to R; both end up at level 1.
{
  const text = '(הברית)';
  const levels = resolveLevels(cps(text), BaseDirection.Rtl);
  const got = Array.from(levels);
  if (got[0] !== 1) fail(`T2 RTL base ( should be level 1 (N0 sets to embed=R), got ${got[0]}`);
  else if (got[6] !== 1) fail(`T2 RTL base ) should be level 1 (N0), got ${got[6]}`);
  else ok(`T2 RTL base, Hebrew inside parens: both brackets at level 1 (N0 fired)`);
}

// ----- T2b: LTR base, Hebrew inside parens — N0 keeps brackets at L -
// embed=L, strong inside=R (opp), context before sos=L≠opp → pair=embed=L.
{
  const text = '(הברית)';
  const levels = resolveLevels(cps(text), BaseDirection.Ltr);
  const got = Array.from(levels);
  if (got[0] !== 0 || got[6] !== 0)
    fail(
      `T2b LTR base brackets should stay at 0 per N0 establish-context rule, got [${got[0]}, ${got[6]}]`,
    );
  else ok('T2b LTR base, Hebrew in parens: brackets stay at 0 (N0 establish-context = embed)');
}

// ----- T3: LTR with brackets around LTR content → pair stays LTR ----
// "(abc) (def)" — multiple bracket pairs with English inside. All at 0.
{
  const text = '(abc) (def)';
  const levels = resolveLevels(cps(text), BaseDirection.Ltr);
  const got = Array.from(levels);
  if (got.every((l) => l === 0)) ok('T3 LTR (abc) (def) all level 0');
  else fail(`T3 LTR brackets around English: got ${got}, expected all 0`);
}

// ----- T4: nested brackets ([abc] inside (Heb)) ---------------------
// "([abc])" under RTL base. Per N0, brackets resolve in nested order
// from innermost out; here we only assert it runs without crashing.
{
  const text = '([abc])';
  const levels = resolveLevels(cps(text), BaseDirection.Rtl);
  if (levels.length !== text.length) fail(`T4 nested brackets: length mismatch`);
  else ok(`T4 nested ([abc]) under RTL: levels=${Array.from(levels)} (no crash)`);
}

// ----- T5: brackets with no strong inside default to embed level ----
// "(   )" with just spaces inside under LTR — should remain level 0.
{
  const text = '(   )';
  const levels = resolveLevels(cps(text), BaseDirection.Ltr);
  if (levels.every((l) => l === 0)) ok('T5 empty parens LTR keep level 0');
  else fail(`T5 (   ) LTR: got ${Array.from(levels)}, expected all 0`);
}

// ----- T6: mismatched brackets shouldn't crash ----------------------
// '(abc' — opener with no closer.
{
  const text = '(abc';
  const levels = resolveLevels(cps(text), BaseDirection.Ltr);
  if (levels.length === 4) ok('T6 unmatched ( handled gracefully');
  else fail('T6 unmatched ( crashed');
}

// ----- T7: bracket-pair data integrity ------------------------------
// Spot-check the pair table.
{
  // ( pairs with )
  if (getBidiClass(0x28) !== BidiClass.ON) fail('T7 ( should be ON');
  if (getBidiClass(0x29) !== BidiClass.ON) fail('T7 ) should be ON');
  if (getBidiClass(0x3010) !== BidiClass.ON) fail('T7 【 should be ON');
  ok('T7 bracket characters classify as ON');
}

if (failures > 0) {
  console.error(`\nBIDI-N0 FAIL (${failures})`);
  process.exit(1);
}
console.log('\nBIDI-N0 PASS');
