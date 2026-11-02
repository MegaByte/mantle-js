// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Thai/Lao shaper unit tests.
//
// Thai and Lao are encoded in VISUAL order (TUS §16.1): pre-base vowels
// are already stored before their consonant, so the shaper performs NO
// reordering — only SARA AM decomposition and mark classification.

import {
  isThaiLaoCodepoint,
  isPreBaseVowel,
  isThaiLaoMark,
  decomposeSaraAm,
} from '../../src/font/scripts/thaiShaper.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// ----- T1: codepoint detection -----------------------------------
{
  if (!isThaiLaoCodepoint(0x0e01)) fail('T1 Thai ko-kai not Thai');
  else if (!isThaiLaoCodepoint(0x0e81)) fail('T1 Lao ko not Thai/Lao');
  else if (isThaiLaoCodepoint(0x0041)) fail('T1 ASCII A flagged Thai/Lao');
  else if (isThaiLaoCodepoint(0x0915)) fail('T1 Devanagari ka flagged Thai/Lao');
  else ok(`T1 isThaiLaoCodepoint: Thai+Lao accepted; ASCII/Indic rejected`);
}

// ----- T2: pre-base vowel detection -------------------------------
{
  let allOk = true;
  for (let cp = 0x0e40; cp <= 0x0e44; cp++)
    if (!isPreBaseVowel(cp)) {
      fail(`T2 Thai pre-base U+${cp.toString(16)} not detected`);
      allOk = false;
    }
  for (let cp = 0x0ec0; cp <= 0x0ec4; cp++)
    if (!isPreBaseVowel(cp)) {
      fail(`T2 Lao pre-base U+${cp.toString(16)} not detected`);
      allOk = false;
    }
  if (isPreBaseVowel(0x0e32)) {
    fail('T2 SARA AA wrongly flagged pre-base');
    allOk = false;
  }
  if (isPreBaseVowel(0x0e45)) {
    fail('T2 LAKKHANGYAO wrongly flagged pre-base');
    allOk = false;
  }
  if (isPreBaseVowel(0x0e3f)) {
    fail('T2 BAHT SIGN wrongly flagged');
    allOk = false;
  }
  if (allOk) ok(`T2 isPreBaseVowel: 5 Thai + 5 Lao detected; non-pre-base rejected`);
}

// ----- T3: SARA AM decomposition (Thai) --------------------------
{
  // 'กำ' = ko-kai + SARA AM (U+0E01 + U+0E33)
  // Canonical decomposition (and HarfBuzz) emit the MARK first:
  // U+0E01 + U+0E4D (NIKHAHIT) + U+0E32 (SARA AA) — the nikhahit
  // anchors to the consonant, the spacing SARA AA follows.
  const { cps, origLow } = decomposeSaraAm([0x0e01, 0x0e33]);
  if (cps.length !== 3) fail(`T3 expected 3 cps after decomp, got ${cps.length}`);
  else if (cps[0] !== 0x0e01 || cps[1] !== 0x0e4d || cps[2] !== 0x0e32) {
    fail(`T3 cps=[${cps.map((c) => c.toString(16)).join(',')}], want [E01,E4D,E32]`);
  } else if (origLow[1] !== 1 || origLow[2] !== 1) {
    fail(`T3 origLow=[${origLow.join(',')}], want [0,1,1]`);
  } else ok(`T3 SARA AM decomp: 'กำ' → ko-kai + NIKHAHIT + SARA-AA (origLow tracks source)`);
}

// ----- T4: SARA AM decomposition (Lao) ---------------------------
{
  const { cps } = decomposeSaraAm([0x0e81, 0x0eb3]);
  if (cps.length !== 3 || cps[1] !== 0x0ecd || cps[2] !== 0x0eb2) {
    fail(`T4 Lao SARA AM cps=[${cps.map((c) => c.toString(16)).join(',')}]`);
  } else ok(`T4 Lao SARA AM decomp: ko + SARA AM → ko + NIKKHIT + SARA AA`);
}

// ----- T5: passthrough for non-decomposable cps -----------------
{
  const { cps, origLow } = decomposeSaraAm([0x0e01, 0x0e40, 0x0e2d]);
  if (cps.length !== 3) fail(`T5 passthrough len ${cps.length}`);
  else if (cps[0] !== 0x0e01 || cps[1] !== 0x0e40 || cps[2] !== 0x0e2d) {
    fail(`T5 cps mutated unexpectedly`);
  } else if (origLow[0] !== 0 || origLow[1] !== 1 || origLow[2] !== 2) {
    fail(`T5 origLow=[${origLow.join(',')}], want [0,1,2]`);
  } else ok(`T5 non-AM stream: identity passthrough with origLow=[0,1,2]`);
}

// ----- T6: Thai mark detection ----------------------------------
{
  if (!isThaiLaoMark(0x0e31)) fail('T6 MAI HAN-AKAT not mark');
  if (!isThaiLaoMark(0x0e34)) fail('T6 SARA I not mark');
  if (!isThaiLaoMark(0x0e48)) fail('T6 MAI EK (tone) not mark');
  if (!isThaiLaoMark(0x0e4d)) fail('T6 NIKHAHIT not mark');
  if (isThaiLaoMark(0x0e01)) fail('T6 ko-kai wrongly mark');
  if (isThaiLaoMark(0x0e40)) fail('T6 SARA E (pre-base vowel) wrongly mark');
  // Lao
  if (!isThaiLaoMark(0x0eb1)) fail('T6 Lao MAI KAN not mark');
  if (!isThaiLaoMark(0x0ec8)) fail('T6 Lao MAI EK (tone) not mark');
  ok(`T6 Thai+Lao mark detection: tones + above/below vowels`);
}

// ----- T7: visual-order encoding is preserved --------------------
{
  // 'เก' is TYPED and STORED as (SARA E, ko-kai) — already visual.
  // The shaper must NOT reorder: decompose is the only stream pass.
  const { cps } = decomposeSaraAm([0x0e40, 0x0e01]);
  if (cps.length !== 2 || cps[0] !== 0x0e40 || cps[1] !== 0x0e01) {
    fail(`T7 visual-order stream mutated: [${cps.map((c) => c.toString(16)).join(',')}]`);
  } else ok(`T7 'เก' (visual-order input) passes through untouched — no reorder pass exists`);
}

console.log();
console.log(failures === 0 ? 'THAI-SHAPER PASS' : `THAI-SHAPER FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
