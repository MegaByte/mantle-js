// Thai/Lao shaper unit tests.

import {
  isThaiLaoCodepoint, isPreBaseVowel, isThaiLaoMark,
  decomposeSaraAm, reorderThaiLao,
} from '../../src/font/scripts/thaiShaper.js';

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

// ----- T1: codepoint detection -----------------------------------
{
  if (!isThaiLaoCodepoint(0x0E01)) fail('T1 Thai ko-kai not Thai');
  else if (!isThaiLaoCodepoint(0x0E81)) fail('T1 Lao ko not Thai/Lao');
  else if (isThaiLaoCodepoint(0x0041)) fail('T1 ASCII A flagged Thai/Lao');
  else if (isThaiLaoCodepoint(0x0915)) fail('T1 Devanagari ka flagged Thai/Lao');
  else ok(`T1 isThaiLaoCodepoint: Thai+Lao accepted; ASCII/Indic rejected`);
}

// ----- T2: pre-base vowel detection -------------------------------
{
  let allOk = true;
  for (let cp = 0x0E40; cp <= 0x0E44; cp++)
    if (!isPreBaseVowel(cp)) { fail(`T2 Thai pre-base U+${cp.toString(16)} not detected`); allOk = false; }
  for (let cp = 0x0EC0; cp <= 0x0EC4; cp++)
    if (!isPreBaseVowel(cp)) { fail(`T2 Lao pre-base U+${cp.toString(16)} not detected`); allOk = false; }
  if (isPreBaseVowel(0x0E32)) { fail('T2 SARA AA wrongly flagged pre-base'); allOk = false; }
  if (isPreBaseVowel(0x0E45)) { fail('T2 LAKKHANGYAO wrongly flagged pre-base'); allOk = false; }
  if (isPreBaseVowel(0x0E3F)) { fail('T2 BAHT SIGN wrongly flagged'); allOk = false; }
  if (allOk) ok(`T2 isPreBaseVowel: 5 Thai + 5 Lao detected; non-pre-base rejected`);
}

// ----- T3: SARA AM decomposition (Thai) --------------------------
{
  // 'กำ' = ko-kai + SARA AM (U+0E01 + U+0E33)
  // After decomposition: U+0E01 + U+0E32 (SARA AA) + U+0E4D (NIKHAHIT)
  const { cps, origLow } = decomposeSaraAm([0x0E01, 0x0E33]);
  if (cps.length !== 3) fail(`T3 expected 3 cps after decomp, got ${cps.length}`);
  else if (cps[0] !== 0x0E01 || cps[1] !== 0x0E32 || cps[2] !== 0x0E4D) {
    fail(`T3 cps=[${cps.map(c=>c.toString(16)).join(',')}], want [E01,E32,E4D]`);
  } else if (origLow[1] !== 1 || origLow[2] !== 1) {
    fail(`T3 origLow=[${origLow.join(',')}], want [0,1,1]`);
  } else ok(`T3 SARA AM decomp: 'กำ' → ko-kai + SARA-AA + NIKHAHIT (origLow tracks source)`);
}

// ----- T4: SARA AM decomposition (Lao) ---------------------------
{
  const { cps } = decomposeSaraAm([0x0E81, 0x0EB3]);
  if (cps.length !== 3 || cps[1] !== 0x0EB2 || cps[2] !== 0x0ECD) {
    fail(`T4 Lao SARA AM cps=[${cps.map(c=>c.toString(16)).join(',')}]`);
  } else ok(`T4 Lao SARA AM decomp: ko + SARA AM → ko + SARA AA + NIKKHIT`);
}

// ----- T5: passthrough for non-decomposable cps -----------------
{
  const { cps, origLow } = decomposeSaraAm([0x0E01, 0x0E40, 0x0E2D]);
  if (cps.length !== 3) fail(`T5 passthrough len ${cps.length}`);
  else if (cps[0] !== 0x0E01 || cps[1] !== 0x0E40 || cps[2] !== 0x0E2D) {
    fail(`T5 cps mutated unexpectedly`);
  } else if (origLow[0] !== 0 || origLow[1] !== 1 || origLow[2] !== 2) {
    fail(`T5 origLow=[${origLow.join(',')}], want [0,1,2]`);
  } else ok(`T5 non-AM stream: identity passthrough with origLow=[0,1,2]`);
}

// ----- T6: Thai mark detection ----------------------------------
{
  if (!isThaiLaoMark(0x0E31)) fail('T6 MAI HAN-AKAT not mark');
  if (!isThaiLaoMark(0x0E34)) fail('T6 SARA I not mark');
  if (!isThaiLaoMark(0x0E48)) fail('T6 MAI EK (tone) not mark');
  if (!isThaiLaoMark(0x0E4D)) fail('T6 NIKHAHIT not mark');
  if (isThaiLaoMark(0x0E01)) fail('T6 ko-kai wrongly mark');
  if (isThaiLaoMark(0x0E40)) fail('T6 SARA E (pre-base vowel) wrongly mark');
  // Lao
  if (!isThaiLaoMark(0x0EB1)) fail('T6 Lao MAI KAN not mark');
  if (!isThaiLaoMark(0x0EC8)) fail('T6 Lao MAI EK (tone) not mark');
  ok(`T6 Thai+Lao mark detection: tones + above/below vowels`);
}

// ----- T7: Pre-base vowel reorder (Thai) -------------------------
{
  // Unicode Thai is stored in logical/phonetic order (consonant first),
  // and OpenType shapers reorder pre-base vowels to visual order.
  // Input: [0x0E01, 0x0E40] (ko-kai, SARA E) → output: [0x0E40, 0x0E01]
  const ord = reorderThaiLao([0x0E01, 0x0E40]);
  if (ord.length !== 2) fail(`T7 expected 2 indices, got ${ord.length}`);
  else if (ord[0] !== 1 || ord[1] !== 0) {
    fail(`T7 reorder [${[...ord].join(',')}], want [1,0]`);
  } else ok(`T7 'เก' (Thai ke) → [vowel-first, consonant-second]`);
}

// ----- T8: Reorder with marks -----------------------------------
{
  // 'เก่' = ko-kai + SARA E + MAI EK (tone mark)
  // Logical: [ko-kai, SARA E, MAI EK]
  // Visual:  [SARA E, ko-kai, MAI EK]
  //   The tone mark stays positioned on top of the consonant via GPOS
  //   mark attachment; in the SLOT stream it follows the consonant.
  const ord = reorderThaiLao([0x0E01, 0x0E40, 0x0E48]);
  if (ord.length !== 3) fail(`T8 expected 3, got ${ord.length}`);
  else if (ord[0] !== 1 || ord[1] !== 0 || ord[2] !== 2) {
    fail(`T8 reorder [${[...ord].join(',')}], want [1,0,2]`);
  } else ok(`T8 'เก่' (Thai ke + tone) → [vowel, consonant, tone]`);
}

// ----- T9: Lao reorder ----------------------------------------
{
  // Lao 'ເກ' = ko (Lao 0x0E81) + LAO VOWEL E (0x0EC0)
  const ord = reorderThaiLao([0x0E81, 0x0EC0]);
  if (ord[0] !== 1 || ord[1] !== 0) {
    fail(`T9 Lao reorder [${[...ord].join(',')}]`);
  } else ok(`T9 Lao 'ເກ' → [vowel-first, consonant]`);
}

// ----- T10: No pre-base vowels → identity reorder ----------------
{
  // 'กา' = ko-kai + SARA AA (post-base vowel) — no reorder.
  const ord = reorderThaiLao([0x0E01, 0x0E32]);
  if (ord[0] !== 0 || ord[1] !== 1) {
    fail(`T10 post-vowel reorder [${[...ord].join(',')}], want identity`);
  } else ok(`T10 'กา' (post-base vowel) → identity reorder`);
}

// ----- T11: Multi-syllable reorder ---------------------------
{
  // 'เกเก' = (ko-kai + SARA E) twice
  // Logical:  k₁ V₁ k₂ V₂
  // Visual:   V₁ k₁ V₂ k₂
  // Indices:  [1, 0, 3, 2]
  const ord = reorderThaiLao([0x0E01, 0x0E40, 0x0E01, 0x0E40]);
  const want = [1, 0, 3, 2];
  let allOk = true;
  for (let i = 0; i < 4; i++) if (ord[i] !== want[i]) { allOk = false; break; }
  if (!allOk) fail(`T11 [${[...ord].join(',')}] want [${want.join(',')}]`);
  else ok(`T11 'เกเก' multi-syllable reorder: each (cons, vowel) pair swapped`);
}

console.log();
console.log(failures === 0 ? 'THAI-SHAPER PASS' : `THAI-SHAPER FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
