// Universal Shaping Engine (USE) shaper unit tests.

import {
  Ucc, Ucp,
  isUseCodepoint, useScriptOf, classifyUcc, classifyUcp,
  findUseClusters, pickUseBase, hasMyanmarKinzi, reorderUseCluster,
} from '../../src/font/scripts/useShaper.js';

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

// ----- T1: script bucketing covers Khmer + Myanmar + Tibetan ------
{
  let allOk = true;
  const cases = [
    [0x1780, 'khmr', 'Khmer ka'],
    [0x1000, 'mymr', 'Myanmar ka'],
    [0x0F40, 'tibt', 'Tibetan ka'],
    [0x0041, null,   'ASCII A'],
    [0x0915, null,   'Devanagari ka (NOT USE)'],
  ];
  for (const [cp, want, label] of cases) {
    const got = useScriptOf(cp);
    if (got !== want) { fail(`T1 ${label} got ${got}, want ${want}`); allOk = false; }
  }
  if (allOk) ok(`T1 useScriptOf: 5 codepoints across 3 USE scripts + non-USE rejection`);
}

// ----- T2: Khmer classification ----------------------------------
{
  let allOk = true;
  const cases = [
    [0x1780, Ucc.Base,      'Khmer ka'],
    [0x17D2, Ucc.Halant,    'Khmer COENG'],
    [0x17C1, Ucc.MatraPre,  'Khmer E (pre-base)'],
    [0x17C2, Ucc.MatraPre,  'Khmer AE (pre-base)'],
    [0x17C3, Ucc.MatraPre,  'Khmer AI (pre-base)'],
    [0x17B7, Ucc.MatraAbove,'Khmer I (above-base)'],
    [0x17BB, Ucc.MatraBelow,'Khmer U (below-base)'],
    [0x17C6, Ucc.VowelMod,  'Khmer anusvara'],
    [0x17E0, Ucc.Number,    'Khmer 0'],
  ];
  for (const [cp, want, label] of cases) {
    const got = classifyUcc(cp);
    if (got !== want) { fail(`T2 ${label} U+${cp.toString(16)} got ${got}, want ${want}`); allOk = false; }
  }
  if (allOk) ok(`T2 Khmer UCC: ${cases.length} codepoints classified correctly`);
}

// ----- T3: Myanmar classification --------------------------------
{
  let allOk = true;
  const cases = [
    [0x1000, Ucc.Base,         'Myanmar ka'],
    [0x1023, Ucc.IndVowel,     'Myanmar a (independent)'],
    [0x1031, Ucc.MatraPre,     'Myanmar E (pre-base)'],
    [0x102D, Ucc.MatraAbove,   'Myanmar I'],
    [0x102F, Ucc.MatraBelow,   'Myanmar U'],
    [0x1039, Ucc.Halant,       'Myanmar VIRAMA'],
    [0x103A, Ucc.VowelMod,     'Myanmar ASAT'],
    [0x103B, Ucc.ConsonantSub, 'Myanmar medial YA'],
    [0x103C, Ucc.ConsonantSub, 'Myanmar medial RA (pre-base!)'],
    [0x1040, Ucc.Number,       'Myanmar 0'],
  ];
  for (const [cp, want, label] of cases) {
    const got = classifyUcc(cp);
    if (got !== want) { fail(`T3 ${label} got ${got}, want ${want}`); allOk = false; }
  }
  if (allOk) ok(`T3 Myanmar UCC: ${cases.length} codepoints + medial RA marked pre-base`);
}

// ----- T4: Pre-base positional ------------------------------------
{
  if (classifyUcp(0x17C1) !== Ucp.Left) fail('T4 Khmer E not Left');
  if (classifyUcp(0x17C2) !== Ucp.Left) fail('T4 Khmer AE not Left');
  if (classifyUcp(0x17C3) !== Ucp.Left) fail('T4 Khmer AI not Left');
  if (classifyUcp(0x1031) !== Ucp.Left) fail('T4 Myanmar E not Left');
  if (classifyUcp(0x103C) !== Ucp.Left) fail('T4 Myanmar medial RA not Left');
  if (classifyUcp(0x17B7) === Ucp.Left) fail('T4 Khmer I (Above) wrongly flagged Left');
  if (classifyUcp(0x17BB) === Ucp.Left) fail('T4 Khmer U (Below) wrongly flagged Left');
  if (failures === 0) ok(`T4 Pre-base positional: 5 pre-base codepoints across Khmer + Myanmar`);
}

// ----- T5: Khmer cluster — single base + post-matra ----------------
{
  // 'កា' = Khmer ka (U+1780) + Khmer AA (U+17B6 — post-base)
  const cps = [0x1780, 0x17B6];
  const clusters = findUseClusters(cps);
  if (clusters.length !== 1) fail(`T5 expected 1 cluster, got ${clusters.length}`);
  else if (clusters[0].start !== 0 || clusters[0].end !== 2) fail(`T5 cluster wrong range`);
  else ok(`T5 Khmer 'កា' (ka + aa): 1 cluster`);
}

// ----- T6: Khmer COENG (subscript) cluster ------------------------
{
  // ka + COENG + ka — two consonants with the second subscripted.
  // Should be ONE cluster (the COENG joins them).
  const cps = [0x1780, 0x17D2, 0x1780];
  const clusters = findUseClusters(cps);
  if (clusters.length !== 1) fail(`T6 expected 1 cluster for COENG'd consonants, got ${clusters.length}`);
  else ok(`T6 Khmer ka + COENG + ka: 1 cluster (subscript joined)`);
}

// ----- T7: Khmer pre-base vowel reorder ----------------------------
{
  // 'កេ' = ka + E (pre-base)
  // Logical: [ka, E]. Visual: [E, ka].
  const cps = [0x1780, 0x17C1];
  const order = reorderUseCluster(cps, 0, 2);
  if (order.length !== 2 || order[0] !== 1 || order[1] !== 0) {
    fail(`T7 Khmer 'កេ' reorder [${order.join(',')}], want [1,0]`);
  } else ok(`T7 Khmer 'កេ' (ka + E pre-base): [E, ka]`);
}

// ----- T8: Khmer COENG-base + pre-base vowel — canonical order ----
{
  // 'កេ្ខ' canonical Khmer typing: ka + COENG + kha + E
  // Logical:  [ka, COENG, kha, E]
  // base = LAST non-halanted Base = kha (idx 2). Pre-matra E (idx 3)
  // moves to JUST BEFORE kha → [ka, COENG, E, kha] = [0, 1, 3, 2]
  const cps = [0x1780, 0x17D2, 0x1780, 0x17C1];
  const order = reorderUseCluster(cps, 0, 4);
  if (order[0] !== 0 || order[1] !== 1 || order[2] !== 3 || order[3] !== 2) {
    fail(`T8 reorder [${order.join(',')}], want [0,1,3,2]`);
  } else ok(`T8 Khmer ka+COENG+kha+E → [ka, COENG, E, kha]: pre-matra before subscripted base`);
}

// ----- T9: Myanmar simple cluster ---------------------------------
{
  // 'ကာ' = Myanmar ka + AA. AA is post-base.
  const cps = [0x1000, 0x102C];
  const clusters = findUseClusters(cps);
  if (clusters.length !== 1) fail(`T9 expected 1 cluster, got ${clusters.length}`);
  else {
    const order = reorderUseCluster(cps, 0, 2);
    if (order[0] !== 0 || order[1] !== 1) fail(`T9 Myanmar 'ကာ' not identity`);
    else ok(`T9 Myanmar 'ကာ' (post-base): identity reorder`);
  }
}

// ----- T10: Myanmar pre-base vowel ------------------------------
{
  // 'ကေ' = Myanmar ka + E (pre-base)
  const cps = [0x1000, 0x1031];
  const order = reorderUseCluster(cps, 0, 2);
  if (order[0] !== 1 || order[1] !== 0) {
    fail(`T10 Myanmar 'ကေ' reorder [${order.join(',')}]`);
  } else ok(`T10 Myanmar 'ကေ' (ka + E pre-base): reorder to [E, ka]`);
}

// ----- T11: Myanmar kinzi detection + reorder -------------------
{
  // 'ငျ်က' — actually let's just use the kinzi prefix sequence.
  // Kinzi = NGA (U+1004) + ASAT (U+103A) + VIRAMA (U+1039), then base = ka (U+1000).
  const cps = [0x1004, 0x103A, 0x1039, 0x1000];
  if (!hasMyanmarKinzi(cps, 0, 4)) fail('T11 hasMyanmarKinzi missed valid kinzi');
  else {
    const order = reorderUseCluster(cps, 0, 4);
    // Kinzi moves to end → [ka, NGA, ASAT, VIRAMA] = [3, 0, 1, 2]
    if (order[0] !== 3 || order[1] !== 0 || order[2] !== 1 || order[3] !== 2) {
      fail(`T11 kinzi reorder [${order.join(',')}], want [3,0,1,2]`);
    } else ok(`T11 Myanmar kinzi prefix → base first, kinzi at end`);
  }
}

// ----- T12: Cluster boundary splits at non-USE -------------------
{
  // 'ក A' = Khmer ka + space + Latin A
  const cps = [0x1780, 0x0020, 0x0041];
  const clusters = findUseClusters(cps);
  if (clusters.length !== 3) fail(`T12 expected 3 clusters, got ${clusters.length}`);
  else ok(`T12 'ka SPACE A' splits into 3 clusters at non-USE boundaries`);
}

// ----- T13: ZWJ doesn't break cluster ---------------------------
{
  // 'ka + ZWJ + COENG + kha'
  const cps = [0x1780, 0x200D, 0x17D2, 0x1780];
  const clusters = findUseClusters(cps);
  if (clusters.length !== 1) fail(`T13 expected 1 cluster with ZWJ`);
  else ok(`T13 Khmer cluster with ZWJ stays together`);
}

console.log();
console.log(failures === 0 ? 'USE-SHAPER PASS' : `USE-SHAPER FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
