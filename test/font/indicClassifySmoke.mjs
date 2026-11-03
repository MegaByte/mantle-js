// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// indicClassifySmoke.mjs — Indic codepoint classification and syllable reordering across the ten
// Indic scripts: Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam
// and Sinhala. T1-T6 cover script bucketing and the Devanagari/Bengali classes and positions;
// T7-T13 cover RA, halant and pre-base matras per script and the reorders they drive.

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

// ----- T1: script bucketing covers all 10 scripts; non-Indic is null --
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
    [0x0041, null, 'ASCII A'],
  ];
  let allOk = true;
  for (const [cp, want, label] of cases) {
    const got = indicScriptOf(cp);
    if (got !== want) {
      fail(`T1 ${label}: got ${got}, want ${want}`);
      allOk = false;
    }
  }
  if (allOk) ok(`T1 indicScriptOf: 10 scripts bucketed correctly, ASCII routes to null`);
}

// ----- T2: Devanagari classifier ----------------------------------
{
  const cases = [
    [0x0915, Isc.Consonant, 'ka'],
    [0x0917, Isc.Consonant, 'ga'],
    [0x0930, Isc.Ra, 'ra (DV)'],
    [0x094d, Isc.Halant, 'halant'],
    [0x093f, Isc.VowelDependent, 'i (matra)'],
    [0x0940, Isc.VowelDependent, 'ii (matra)'],
    [0x093c, Isc.Nukta, 'nukta'],
    [0x0905, Isc.VowelIndependent, 'a (vowel)'],
    [0x0902, Isc.Bindu, 'anusvara'],
    [0x0966, Isc.Number, 'devanagari 0'],
    [0x200d, Isc.ZWJ, 'ZWJ'],
    [0x200c, Isc.ZWNJ, 'ZWNJ'],
    [0x25cc, Isc.ConsonantPlaceholder, 'dotted circle'],
  ];
  let allOk = true;
  for (const [cp, want, label] of cases) {
    const got = classifyIsc(cp);
    if (got !== want) {
      fail(`T2 ${label} U+${cp.toString(16)} got ${got}, want ${want}`);
      allOk = false;
    }
  }
  if (allOk) ok(`T2 Devanagari classify: ${cases.length} codepoints all correct`);
}

// ----- T3: Bengali classifier ------------------------------------
{
  const cases = [
    [0x0995, Isc.Consonant, 'bengali ka'],
    [0x09b0, Isc.Ra, 'bengali ra'],
    [0x09f0, Isc.Ra, 'assamese ra'],
    [0x09cd, Isc.Halant, 'bengali halant'],
    [0x09bf, Isc.VowelDependent, 'bengali i (pre-base)'],
    [0x09c7, Isc.VowelDependent, 'bengali e (pre-base)'],
    [0x09bc, Isc.Nukta, 'bengali nukta'],
    [0x0985, Isc.VowelIndependent, 'bengali a (independent)'],
    [0x09e6, Isc.Number, 'bengali 0'],
  ];
  let allOk = true;
  for (const [cp, want, label] of cases) {
    const got = classifyIsc(cp);
    if (got !== want) {
      fail(`T3 ${label} U+${cp.toString(16)} got ${got}, want ${want}`);
      allOk = false;
    }
  }
  if (allOk) ok(`T3 Bengali classify: ${cases.length} codepoints all correct`);
}

// ----- T4: Positional category for Devanagari --------------------
{
  // Pre-base 'i' is the canonical reorder trigger.
  if (classifyIpc(0x093f) !== Ipc.Left) fail(`T4 DV i not Left: ${classifyIpc(0x093f)}`);
  else if (classifyIpc(0x0941) !== Ipc.Bottom) fail(`T4 DV u not Bottom`);
  else if (classifyIpc(0x0947) !== Ipc.Top) fail(`T4 DV e not Top`);
  // U+094B is Right per UCD IndicPositionalCategory (0949..094C ; Right) —
  // unlike Bengali's genuinely two-part U+09CB, which IS Left_And_Right (T5).
  else if (classifyIpc(0x094b) !== Ipc.Right) fail(`T4 DV o not Right`);
  else if (classifyIpc(0x0915) !== Ipc.Right) fail(`T4 DV ka not Right (default)`);
  else ok(`T4 Devanagari positional: i=Left, u=Bottom, e=Top, o=Right, default=Right`);
}

// ----- T5: Positional category for Bengali ------------------------
{
  // Bengali has THREE pre-base matras: i, e, ai
  if (classifyIpc(0x09bf) !== Ipc.Left) fail(`T5 BG i not Left`);
  else if (classifyIpc(0x09c7) !== Ipc.Left) fail(`T5 BG e not Left`);
  else if (classifyIpc(0x09c8) !== Ipc.Left) fail(`T5 BG ai not Left`);
  else if (classifyIpc(0x09cb) !== Ipc.LeftRight) fail(`T5 BG o not LeftRight (two-part)`);
  else if (classifyIpc(0x09c1) !== Ipc.Bottom) fail(`T5 BG u not Bottom`);
  else ok(`T5 Bengali positional: i/e/ai=Left, o=LeftRight, u=Bottom`);
}

// ----- T6: isIndicCodepoint coverage ------------------------------
{
  if (!isIndicCodepoint(0x0915)) fail('T6 ka not indic');
  else if (!isIndicCodepoint(0x0995)) fail('T6 bn ka not indic');
  else if (isIndicCodepoint(0x0041)) fail('T6 ASCII wrongly indic');
  else if (isIndicCodepoint(0x0628)) fail('T6 Arabic beh wrongly indic');
  else ok(`T6 isIndicCodepoint: deva+beng accepted; ASCII+Arabic rejected`);
}

// ----- T7: RA classified correctly per script ----------------------
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
      fail(`T7 ${label} U+${cp.toString(16)} not Ra`);
      allOk = false;
    }
  }
  if (allOk) ok(`T7 RA codepoint classified as Isc.Ra across all 10 scripts`);
}

// ----- T8: Halant per-script ---------------------------------------
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
      fail(`T8 ${label} U+${cp.toString(16)} not Halant`);
      allOk = false;
    }
  }
  if (allOk) ok(`T8 halant classified across all 10 scripts (Sinhala at 0x0DCA)`);
}

// ----- T9: Pre-base matras --------------------------------------
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
      fail(`T9 ${label} U+${cp.toString(16)} not Left, got ${classifyIpc(cp)}`);
      allOk = false;
    }
  }
  if (allOk)
    ok(`T9 ${cases.length} pre-base matras across Deva/Beng/Guru/Gujr/Orya/Taml/Mlym/Sinh`);
}

// ----- T10: Telugu + Kannada have NO pre-base matras ----------------
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
      fail(`T10 ${label} unexpectedly Left`);
      allOk = false;
    }
  }
  if (allOk) ok(`T10 Telu/Knda dep vowels are NOT Left (no pre-base matras in these scripts)`);
}

// ----- T11: Tamil 'கி' (ka + i) — but Tamil 'i' is POST-base ------
{
  // Tamil 'i' (0x0BBF) is NOT in the pre-base list (it's post-base).
  // So reordering should be identity for Tamil 'ki'.
  if (classifyIpc(0x0bbf) === Ipc.Left) fail('T11 Tamil i wrongly Left');
  // But Tamil 'e' (0x0BC6) IS pre-base.
  if (classifyIpc(0x0bc6) !== Ipc.Left) fail('T11 Tamil e not Left');
  // Reorder Tamil 'ke' (ka + e).
  const cps = [0x0b95, 0x0bc6];
  const ord = reorderSyllable(cps, 0, 2);
  if (ord[0] !== 1 || ord[1] !== 0) fail(`T11 Tamil 'ke' reorder [${ord}]`);
  else ok(`T11 Tamil 'ke' (e is pre-base) → reordered; 'ki' (i is post-base) wouldn't reorder`);
}

// ----- T12: Telugu has NO pre-base reorder ---------------------
{
  // Telugu 'కి' (ka + i) — both stay in logical order.
  const cps = [0x0c15, 0x0c3f];
  const ord = reorderSyllable(cps, 0, 2);
  if (ord[0] !== 0 || ord[1] !== 1) fail(`T12 Telugu 'ki' should be identity, got [${ord}]`);
  else ok(`T12 Telugu 'ki' identity reorder (no pre-base matras)`);
}

// ----- T13: Sinhala reph (Sinhala HAS reph via RA + halant 0x0DCA) -
{
  // Sinhala 'rka' — ra + halant + ka.
  // RA = 0x0DBB, halant = 0x0DCA, ka = 0x0D9A.
  const cps = [0x0dbb, 0x0dca, 0x0d9a];
  const ord = reorderSyllable(cps, 0, 3);
  // Reph moves to end → [2, 0, 1]
  if (ord[0] !== 2 || ord[1] !== 0 || ord[2] !== 1) {
    fail(`T13 Sinhala reph reorder [${ord}], want [2,0,1]`);
  } else ok(`T13 Sinhala reph (RA at 0x0DBB + halant at 0x0DCA) → reorder to end`);
}

console.log();
console.log(failures === 0 ? 'INDIC-CLASSIFY PASS' : `INDIC-CLASSIFY FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
