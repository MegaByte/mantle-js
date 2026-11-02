// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// indicAllScriptsSmoke.mjs — verifies the 7 additional Indic scripts
// classify correctly: Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada,
// Malayalam, Sinhala.

import {
  Isc,
  Ipc,
  indicScriptOf,
  isIndicCodepoint,
  classifyIsc,
  classifyIpc,
  reorderSyllable,
} from '../../src/font/scripts/indicShaper.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// ----- T1: script bucketing covers all 10 scripts ------------------
{
  const cases = [
    [0x0915, 'deva', 'Devanagari ka'],
    [0x0995, 'beng', 'Bengali ka'],
    [0x0a15, 'guru', 'Gurmukhi ka'],
    [0x0a95, 'gujr', 'Gujarati ka'],
    [0x0b15, 'orya', 'Oriya ka'],
    [0x0b95, 'taml', 'Tamil ka'],
    [0x0c15, 'telu', 'Telugu ka'],
    [0x0c95, 'knda', 'Kannada ka'],
    [0x0d15, 'mlym', 'Malayalam ka'],
    [0x0d9a, 'sinh', 'Sinhala ka'],
  ];
  let allOk = true;
  for (const [cp, want, label] of cases) {
    const got = indicScriptOf(cp);
    if (got !== want) {
      fail(`T1 ${label}: got ${got}, want ${want}`);
      allOk = false;
    }
  }
  if (allOk) ok(`T1 indicScriptOf: 10 scripts bucketed correctly`);
}

// ----- T2: RA classified correctly per script ----------------------
{
  const cases = [
    [0x0930, 'Deva ra'],
    [0x09b0, 'Beng ra'],
    [0x0a30, 'Guru ra'],
    [0x0ab0, 'Gujr ra'],
    [0x0b30, 'Orya ra'],
    [0x0bb0, 'Taml ra'],
    [0x0c30, 'Telu ra'],
    [0x0cb0, 'Knda ra'],
    [0x0d30, 'Mlym ra'],
    [0x0dbb, 'Sinh ra (different offset!)'],
  ];
  let allOk = true;
  for (const [cp, label] of cases) {
    if (classifyIsc(cp) !== Isc.Ra) {
      fail(`T2 ${label} U+${cp.toString(16)} not Ra`);
      allOk = false;
    }
  }
  if (allOk) ok(`T2 RA codepoint classified as Isc.Ra across all 10 scripts`);
}

// ----- T3: Halant per-script ---------------------------------------
{
  const cases = [
    [0x094d, 'Deva halant'],
    [0x09cd, 'Beng halant'],
    [0x0a4d, 'Guru halant'],
    [0x0acd, 'Gujr halant'],
    [0x0b4d, 'Orya halant'],
    [0x0bcd, 'Taml halant'],
    [0x0c4d, 'Telu halant'],
    [0x0ccd, 'Knda halant'],
    [0x0d4d, 'Mlym halant'],
    [0x0dca, 'Sinh halant (different offset!)'],
  ];
  let allOk = true;
  for (const [cp, label] of cases) {
    if (classifyIsc(cp) !== Isc.Halant) {
      fail(`T3 ${label} U+${cp.toString(16)} not Halant`);
      allOk = false;
    }
  }
  if (allOk) ok(`T3 halant classified across all 10 scripts (Sinhala at 0x0DCA)`);
}

// ----- T4: Pre-base matras --------------------------------------
{
  // Scripts WITH pre-base matras and which cps to check.
  const cases = [
    ['Deva i', 0x093f],
    ['Beng i', 0x09bf],
    ['Beng e', 0x09c7],
    ['Beng ai', 0x09c8],
    ['Guru i', 0x0a3f],
    ['Gujr i', 0x0abf],
    ['Orya e', 0x0b47],
    ['Taml e', 0x0bc6],
    ['Taml ee', 0x0bc7],
    ['Taml ai', 0x0bc8],
    ['Mlym e', 0x0d46],
    ['Mlym ee', 0x0d47],
    ['Mlym ai', 0x0d48],
    ['Sinh e', 0x0dd9],
    ['Sinh ai', 0x0ddb],
  ];
  let allOk = true;
  for (const [label, cp] of cases) {
    if (classifyIpc(cp) !== Ipc.Left) {
      fail(`T4 ${label} U+${cp.toString(16)} not Left, got ${classifyIpc(cp)}`);
      allOk = false;
    }
  }
  if (allOk)
    ok(`T4 ${cases.length} pre-base matras across Deva/Beng/Guru/Gujr/Orya/Taml/Mlym/Sinh`);
}

// ----- T5: Telugu + Kannada have NO pre-base matras ----------------
{
  // Spot check a few Telugu/Kannada dep vowels — should all be NOT Left.
  const cases = [
    [0x0c3f, 'Telu i'],
    [0x0c40, 'Telu ii'],
    [0x0c46, 'Telu e'],
    [0x0cbf, 'Knda i'],
    [0x0cc6, 'Knda e'],
  ];
  let allOk = true;
  for (const [cp, label] of cases) {
    if (classifyIpc(cp) === Ipc.Left) {
      fail(`T5 ${label} unexpectedly Left`);
      allOk = false;
    }
  }
  if (allOk) ok(`T5 Telu/Knda dep vowels are NOT Left (no pre-base matras in these scripts)`);
}

// ----- T6: Tamil 'கி' (ka + i) — but Tamil 'i' is POST-base ------
{
  // Tamil 'i' (0x0BBF) is NOT in the pre-base list (it's post-base).
  // So reordering should be identity for Tamil 'ki'.
  if (classifyIpc(0x0bbf) === Ipc.Left) fail('T6 Tamil i wrongly Left');
  // But Tamil 'e' (0x0BC6) IS pre-base.
  if (classifyIpc(0x0bc6) !== Ipc.Left) fail('T6 Tamil e not Left');
  // Reorder Tamil 'ke' (ka + e).
  const cps = [0x0b95, 0x0bc6];
  const ord = reorderSyllable(cps, 0, 2);
  if (ord[0] !== 1 || ord[1] !== 0) fail(`T6 Tamil 'ke' reorder [${ord}]`);
  else ok(`T6 Tamil 'ke' (e is pre-base) → reordered; 'ki' (i is post-base) wouldn't reorder`);
}

// ----- T7: Telugu has NO pre-base reorder ---------------------
{
  // Telugu 'కి' (ka + i) — both stay in logical order.
  const cps = [0x0c15, 0x0c3f];
  const ord = reorderSyllable(cps, 0, 2);
  if (ord[0] !== 0 || ord[1] !== 1) fail(`T7 Telugu 'ki' should be identity, got [${ord}]`);
  else ok(`T7 Telugu 'ki' identity reorder (no pre-base matras)`);
}

// ----- T8: Sinhala reph (Sinhala HAS reph via RA + halant 0x0DCA) -
{
  // Sinhala 'rka' — ra + halant + ka.
  // RA = 0x0DBB, halant = 0x0DCA, ka = 0x0D9A.
  const cps = [0x0dbb, 0x0dca, 0x0d9a];
  const ord = reorderSyllable(cps, 0, 3);
  // Reph moves to end → [2, 0, 1]
  if (ord[0] !== 2 || ord[1] !== 0 || ord[2] !== 1) {
    fail(`T8 Sinhala reph reorder [${ord}], want [2,0,1]`);
  } else ok(`T8 Sinhala reph (RA at 0x0DBB + halant at 0x0DCA) → reorder to end`);
}

console.log();
console.log(failures === 0 ? 'INDIC-ALL-SCRIPTS PASS' : `INDIC-ALL-SCRIPTS FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
