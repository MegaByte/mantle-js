// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Hangul shaper jamo classification (Leading/Vowel/Trailing).

import {
  HangulJamoRole,
  isHangulJamo,
  isPrecomposedHangul,
  classifyHangulJamo,
  classifyJamoStream,
} from '../../src/font/scripts/hangulJamo.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// ----- T1: range predicates -----------------------------------------
{
  if (!isHangulJamo(0x1100)) fail('T1 U+1100 (kiyeok) not flagged jamo');
  else if (!isHangulJamo(0x11ff)) fail('T1 U+11FF (jamo block end) not flagged');
  else if (isHangulJamo(0x10ff)) fail('T1 U+10FF wrongly flagged jamo');
  else if (isHangulJamo(0x1200)) fail('T1 U+1200 wrongly flagged jamo');
  else if (isHangulJamo(0xac01)) fail('T1 precomposed AC01 wrongly flagged jamo');
  else ok('T1 isHangulJamo: range checks correct');
}

// ----- T2: precomposed range -------------------------------------
{
  if (!isPrecomposedHangul(0xac00)) fail('T2 U+AC00 (가) not precomposed');
  else if (!isPrecomposedHangul(0xd7a3)) fail('T2 U+D7A3 (힣) not precomposed');
  else if (isPrecomposedHangul(0xac00 - 1)) fail('T2 U+ABFF wrongly precomposed');
  else if (isPrecomposedHangul(0xd7a4)) fail('T2 U+D7A4 wrongly precomposed');
  else ok('T2 isPrecomposedHangul: range checks correct');
}

// ----- T3: classify Leading / Vowel / Trailing ---------------------
{
  const cases = [
    [0x1100, HangulJamoRole.Leading, 'kiyeok (L)'],
    [0x1112, HangulJamoRole.Leading, 'hieuh (L)'],
    [0x115f, HangulJamoRole.Leading, 'choseong filler (L)'],
    [0x1161, HangulJamoRole.Vowel, 'a (V)'],
    [0x1175, HangulJamoRole.Vowel, 'i (V)'],
    [0x11a7, HangulJamoRole.Vowel, 'V boundary'],
    [0x11a8, HangulJamoRole.Trailing, 'kiyeok-T (T)'],
    [0x11c2, HangulJamoRole.Trailing, 'hieuh-T (T)'],
    [0x11ff, HangulJamoRole.Trailing, 'block end (T)'],
  ];
  let allOk = true;
  for (const [cp, want, label] of cases) {
    const got = classifyHangulJamo(cp);
    if (got !== want) {
      fail(`T3 ${label} U+${cp.toString(16)} got ${got}, want ${want}`);
      allOk = false;
    }
  }
  if (allOk) ok(`T3 classifyHangulJamo: 9 codepoints across L/V/T`);
}

// ----- T4: non-jamo classify returns null -----------------------
{
  if (classifyHangulJamo(0x41) !== null) fail('T4 ASCII A not null');
  else if (classifyHangulJamo(0xac01) !== null) fail('T4 precomposed not null');
  else if (classifyHangulJamo(0x3131) !== null)
    fail('T4 compat-jamo not null (correct per L7 scope)');
  else ok('T4 non-jamo cps return null (compat jamo excluded too)');
}

// ----- T5: classifyJamoStream on 3-jamo + ASCII ---------------------
{
  const cps = [0x1100, 0x1161, 0x11a8, 0x41]; // L+V+T + 'A'
  const roles = classifyJamoStream(cps);
  if (roles[0] !== HangulJamoRole.Leading) fail(`T5 [0]=${roles[0]}`);
  else if (roles[1] !== HangulJamoRole.Vowel) fail(`T5 [1]=${roles[1]}`);
  else if (roles[2] !== HangulJamoRole.Trailing) fail(`T5 [2]=${roles[2]}`);
  else if (roles[3] !== -1) fail(`T5 [3] (A) expected -1, got ${roles[3]}`);
  else ok(`T5 classifyJamoStream: [L, V, T, -1] for ㄱㅏᆨA`);
}

console.log();
console.log(failures === 0 ? 'HANGUL-JAMO PASS' : `HANGUL-JAMO FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
