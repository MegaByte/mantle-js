// indicReorderSmoke.mjs — syllable identification +
// pre-base matra reorder + reph reorder.

import {
  Isc, Ipc,
  classifyIsc, classifyIpc,
  findIndicSyllables, pickBaseConsonant, hasInitialReph,
  reorderSyllable, reorderIndicStream,
} from '../../src/font/scripts/indicShaper.js';

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

// ----- T1: simple consonant + matra cluster ---------------------
{
  // क + ि → "ki" (pronounced "kee" — reads visually as ि-क)
  // U+0915 ka + U+093F i-matra
  // Pre-base i-matra → reorder puts i BEFORE ka.
  const cps = [0x0915, 0x093F];
  const syl = findIndicSyllables(cps);
  if (syl.length !== 1) fail(`T1 expected 1 syllable, got ${syl.length}`);
  else {
    const base = pickBaseConsonant(cps, 0, 2);
    if (base !== 0) fail(`T1 base should be 0 (ka), got ${base}`);
    const order = reorderSyllable(cps, 0, 2);
    // After pre-matra reorder: [i, ka] → [1, 0]
    if (order.length !== 2 || order[0] !== 1 || order[1] !== 0) {
      fail(`T1 pre-matra reorder wrong: [${order.join(',')}], want [1,0]`);
    } else ok(`T1 'ki' (ka + i-matra): pre-base matra moved to position 0`);
  }
}

// ----- T2: reph — Ra + Halant + consonant ---------------------------
{
  // र + ् + क → "rk" with reph on top of ka.
  // U+0930 ra + U+094D halant + U+0915 ka
  // Reorder: reph moves to END, so result is [ka, ra, halant]
  // (or [ka, reph] after GSUB rphf compresses ra+halant).
  const cps = [0x0930, 0x094D, 0x0915];
  const syl = findIndicSyllables(cps);
  if (syl.length !== 1) fail(`T2 expected 1 syllable, got ${syl.length}`);
  else {
    if (!hasInitialReph(cps, 0, 3)) fail(`T2 hasInitialReph not detected`);
    else {
      const order = reorderSyllable(cps, 0, 3);
      // Expected: [2 (ka), 0 (ra), 1 (halant)]
      if (order.length !== 3 || order[0] !== 2 || order[1] !== 0 || order[2] !== 1) {
        fail(`T2 reph reorder wrong: [${order.join(',')}], want [2,0,1]`);
      } else ok(`T2 reph 'rka' → reorder ka first, ra+halant tail`);
    }
  }
}

// ----- T3: reph + pre-base matra combined ----------------------------
{
  // र + ् + क + ि → "rki" with reph and pre-matra
  // U+0930 ra + U+094D halant + U+0915 ka + U+093F i
  // Reorder:
  //   1. base = ka (idx 2). pre-matra i (idx 3) moves to just before ka.
  //      order after step 1: [0, 1, 3, 2]  (ra, halant, i, ka)
  //   2. reph detected — move first 2 to end:
  //      order after step 2: [3, 2, 0, 1]  (i, ka, ra, halant)
  const cps = [0x0930, 0x094D, 0x0915, 0x093F];
  const order = reorderSyllable(cps, 0, 4);
  if (order.length !== 4) fail(`T3 expected 4 elements, got ${order.length}`);
  else if (order[0] !== 3 || order[1] !== 2 || order[2] !== 0 || order[3] !== 1) {
    fail(`T3 reph+pre-matra wrong: [${order.join(',')}], want [3,2,0,1]`);
  } else ok(`T3 'rki' → [i, ka, ra, halant] — reph + pre-matra combined`);
}

// ----- T4: no reorder needed for simple syllable ---------------------
{
  // क + ा → "kaa" — aa-matra is POST-base, no reorder.
  const cps = [0x0915, 0x093E];
  const order = reorderSyllable(cps, 0, 2);
  if (order[0] !== 0 || order[1] !== 1) fail(`T4 [${order.join(',')}] should be [0,1]`);
  else ok(`T4 'kaa' (aa-matra post-base): identity reorder`);
}

// ----- T5: consonant cluster (halant joining) --------------------
{
  // क + ् + ष + ् + य → "kṣya" — multi-consonant conjunct.
  // ka + halant + sha + halant + ya — all consonants halant-joined.
  // The base is the LAST non-halanted consonant = य (idx 4).
  const cps = [0x0915, 0x094D, 0x0937, 0x094D, 0x092F];
  const syl = findIndicSyllables(cps);
  if (syl.length !== 1) fail(`T5 expected 1 syllable for conjunct, got ${syl.length}`);
  else if (pickBaseConsonant(cps, 0, 5) !== 4) {
    fail(`T5 base of 'kṣya' should be 4 (ya), got ${pickBaseConsonant(cps, 0, 5)}`);
  } else ok(`T5 'kṣya' conjunct: 1 syllable, base = ya (last unhalanted)`);
}

// ----- T6: non-Indic punctuation breaks syllable ----------------
{
  // 'क ' — ka + space
  const cps = [0x0915, 0x0020];
  const syl = findIndicSyllables(cps);
  if (syl.length !== 2) fail(`T6 expected 2 syllables, got ${syl.length}`);
  else if (syl[0].start !== 0 || syl[0].end !== 1) fail(`T6 first syl wrong: ${syl[0].start}..${syl[0].end}`);
  else if (syl[1].start !== 1 || syl[1].end !== 2) fail(`T6 second syl wrong: ${syl[1].start}..${syl[1].end}`);
  else ok(`T6 'ka ' splits into 2 syllables (Indic + non-Indic)`);
}

// ----- T7: Bengali pre-base 'e' matra ------------------------------
{
  // ক + ে → "ke" — Bengali e is PRE-BASE.
  // U+0995 bengali ka + U+09C7 bengali e
  const cps = [0x0995, 0x09C7];
  const order = reorderSyllable(cps, 0, 2);
  // Expected: [1, 0] — e moves before ka.
  if (order[0] !== 1 || order[1] !== 0) {
    fail(`T7 Bengali pre-e wrong: [${order.join(',')}], want [1,0]`);
  } else ok(`T7 Bengali 'ke' (e-matra pre-base): reordered to [e, ka]`);
}

// ----- T8: reorderIndicStream over multi-syllable text -------------
{
  // 'किकी' — ki + kii. Both have pre-base 'i' matras.
  // U+0915 ka + U+093F i + U+0915 ka + U+0940 ii
  //   (ii is post-base, not pre-base)
  // Syllable 1: ka + i  →  reorder [1, 0]
  // Syllable 2: ka + ii →  no reorder [2, 3]
  // Final order: [1, 0, 2, 3]
  const cps = [0x0915, 0x093F, 0x0915, 0x0940];
  const order = reorderIndicStream(cps);
  if (order.length !== 4) fail(`T8 expected length 4`);
  else if (order[0] !== 1 || order[1] !== 0 || order[2] !== 2 || order[3] !== 3) {
    fail(`T8 stream reorder: [${[...order].join(',')}], want [1,0,2,3]`);
  } else ok(`T8 stream 'kiki' → [i, ka, ka, ii] (per-syllable reorder)`);
}

console.log();
console.log(failures === 0 ? 'INDIC-REORDER PASS' : `INDIC-REORDER FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
