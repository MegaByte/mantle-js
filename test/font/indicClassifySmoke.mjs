// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// indicClassifySmoke.mjs — Indic codepoint classification.

import {
  Isc,
  Ipc,
  indicScriptOf,
  isIndicCodepoint,
  classifyIsc,
  classifyIpc,
} from '../../src/font/scripts/indicShaper.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// ----- T1: script bucketing ---------------------------------------
{
  if (indicScriptOf(0x0915) !== 'deva') fail('T1 ka not deva');
  else if (indicScriptOf(0x0995) !== 'beng') fail('T1 bengali ka not beng');
  else if (indicScriptOf(0x0041) !== null) fail('T1 ASCII A wrongly indic');
  else ok(`T1 indicScriptOf: deva / beng / null routing`);
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

console.log();
console.log(failures === 0 ? 'INDIC-CLASSIFY PASS' : `INDIC-CLASSIFY FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
