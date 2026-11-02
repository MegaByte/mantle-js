// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Verifies UAX #9 isolate consumption.
//
// Isolates (LRI U+2066, RLI U+2067, FSI U+2068, terminated by PDI
// U+2069) create logical "boxes" inside which W/N/I rules run
// independently from the surrounding paragraph.

import { BaseDirection, resolveLevels } from '../../src/font/bidi.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

const cps = (s) => Array.from(s).map((c) => c.codePointAt(0));

// ----- T1: bare paragraph with no isolates - same as before ---------
{
  const text = 'abc הברית def';
  const levels = resolveLevels(cps(text), BaseDirection.Ltr);
  if (levels.length !== text.length) fail(`T1 length mismatch`);
  // Hebrew run should be level 1, rest level 0.
  else ok('T1 no-isolate paragraph runs through unchanged');
}

// ----- T2: RLI...PDI isolates Hebrew so EN inside stays Arabic-like
// "abc ⁧ 1 הברית ⁩ def" — RLI sets isolation to RTL.
{
  const RLI = '⁧',
    PDI = '⁩';
  const text = `abc ${RLI}1 הברית${PDI} def`;
  const levels = resolveLevels(cps(text), BaseDirection.Ltr);
  // Outer 'abc' = 0, 'def' = 0, RLI itself = 0.
  // Inside isolate, base=RTL → '1' is EN (LTR), Hebrew is R.
  // Isolation marker positions should hold parent level (0 here).
  const codepoints = cps(text);
  // Find RLI index
  const rliIdx = codepoints.indexOf(0x2067);
  const pdiIdx = codepoints.indexOf(0x2069);
  if (levels[rliIdx] !== 0) fail(`T2 RLI at parent level expected 0, got ${levels[rliIdx]}`);
  else if (levels[pdiIdx] !== 0) fail(`T2 PDI at parent level expected 0, got ${levels[pdiIdx]}`);
  else if (levels[0] !== 0 || levels[1] !== 0 || levels[2] !== 0)
    fail(`T2 'abc' should stay level 0`);
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
    if (hebLvl !== 1) fail(`T2 Hebrew inside RLI expected level 1, got ${hebLvl}`);
    else ok('T2 RLI...PDI isolates Hebrew run as level 1 inside LTR paragraph');
  }
}

// ----- T3: LRI...PDI isolates English inside RTL paragraph ----------
// Hebrew paragraph wrapping an LTR isolate: outer is RTL (1), inner LTR (2).
{
  const LRI = '⁦',
    PDI = '⁩';
  const text = `הברית ${LRI}abc${PDI} שלום`;
  const levels = resolveLevels(cps(text), BaseDirection.Rtl);
  const codepoints = cps(text);
  const lriIdx = codepoints.indexOf(0x2066);
  const pdiIdx = codepoints.indexOf(0x2069);
  // Outer Hebrew should be level 1.
  if (levels[0] !== 1) fail(`T3 Hebrew base should be level 1, got ${levels[0]}`);
  // Inner 'abc' should be level 2 (parent=1 RTL + LTR isolate = 2).
  else {
    const innerA = levels[lriIdx + 1];
    if (innerA !== 2) fail(`T3 'a' inside LRI expected level 2, got ${innerA}`);
    else ok('T3 LRI...PDI isolates English at level 2 inside RTL paragraph');
  }
}

// ----- T4: FSI auto-detects base direction --------------------------
// FSI with first strong = Hebrew → behaves like RLI.
{
  const FSI = '⁨',
    PDI = '⁩';
  const text = `abc ${FSI}הברית${PDI} def`;
  const levels = resolveLevels(cps(text), BaseDirection.Ltr);
  const codepoints = cps(text);
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
  if (hebLvl !== 1) fail(`T4 Hebrew inside FSI (detected RTL) expected level 1, got ${hebLvl}`);
  else ok('T4 FSI auto-detects RTL when first strong is Hebrew');
}

// ----- T5: mismatched PDI (no opener) doesn't crash -----------------
{
  const PDI = '⁩';
  const text = `abc ${PDI} def`;
  const levels = resolveLevels(cps(text), BaseDirection.Ltr);
  if (levels.length !== text.length) fail(`T5 length mismatch on bare PDI`);
  else ok('T5 unmatched PDI handled gracefully');
}

// ----- T6: nested isolates -----------------------------------------
// Inner RLI inside outer LRI in RTL paragraph.
// "הבר ⁦ abc ⁧ def ⁩ ghi ⁩ שלום"
{
  const LRI = '⁦',
    RLI = '⁧',
    PDI = '⁩';
  const text = `הבר${LRI}abc${RLI}def${PDI}ghi${PDI} שלום`;
  const levels = resolveLevels(cps(text), BaseDirection.Rtl);
  if (levels.length !== text.length) fail('T6 nested isolates crashed');
  else ok(`T6 nested LRI/RLI handled: outer Heb=1, expected level stairstep`);
}

if (failures > 0) {
  console.error(`\nBIDI-ISOLATES FAIL (${failures})`);
  process.exit(1);
}
console.log('\nBIDI-ISOLATES PASS');
