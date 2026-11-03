// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// TTC multi-face selection: faceCount inspection + faceIndex param.

import { readFileSync, existsSync } from 'fs';
import { MantleFontAsset, ttcFaceCount } from '../../src/font/fontAsset.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// ----- T1: faceCount on plain TTF returns 1 ------------------------------
{
  const f = '/System/Library/Fonts/Supplemental/Arial.ttf';
  if (!existsSync(f)) {
    ok('T1 skipped (Arial missing)');
  } else {
    const b = new Uint8Array(readFileSync(f));
    const n = ttcFaceCount(b);
    if (n !== 1) fail(`T1 plain TTF count=${n}, expected 1`);
    else ok(`T1 plain TTF → 1 face`);
  }
}

// ----- T2: faceCount on TTC reports collection size ----------------------
{
  const f = '/System/Library/Fonts/Apple Color Emoji.ttc';
  if (!existsSync(f)) {
    ok('T2 skipped (Apple Color Emoji.ttc missing)');
  } else {
    const b = new Uint8Array(readFileSync(f));
    const n = ttcFaceCount(b);
    if (n < 1) fail(`T2 TTC count=${n}, expected ≥1`);
    else ok(`T2 Apple Color Emoji.ttc → ${n} face(s)`);
  }
}

// ----- T3: face 0 picks the default face --------------------------------
{
  const f = '/System/Library/Fonts/ArialHB.ttc';
  if (!existsSync(f)) {
    ok('T3 skipped (ArialHB.ttc missing)');
  } else {
    const b = new Uint8Array(readFileSync(f));
    const font = new MantleFontAsset(b); // implicit faceIndex=0
    void font.name;
    if (!font.familyName) fail('T3 face 0 familyName empty');
    else ok(`T3 ArialHB.ttc face 0 → family='${font.familyName}' style='${font.styleName}'`);
  }
}

// ----- T4: face N picks a different face --------------------------------
{
  const f = '/System/Library/Fonts/ArialHB.ttc';
  if (!existsSync(f)) {
    ok('T4 skipped (ArialHB.ttc missing)');
  } else {
    const b = new Uint8Array(readFileSync(f));
    const n = ttcFaceCount(b);
    const face0 = new MantleFontAsset(b, { faceIndex: 0 });
    const faceLast = new MantleFontAsset(b, { faceIndex: n - 1 });
    void face0.name;
    void faceLast.name;
    if (n < 2) {
      ok(`T4 single-face TTC; skipping cross-face check`);
    } else if (!face0.fullName || !faceLast.fullName) {
      fail(`T4 fullName empty (face0='${face0.fullName}' faceN='${faceLast.fullName}')`);
    } else if (face0.fullName === faceLast.fullName) {
      fail(`T4 face 0 and face ${n - 1} have identical fullName='${face0.fullName}'`);
    } else {
      ok(`T4 ArialHB.ttc face 0='${face0.fullName}', face ${n - 1}='${faceLast.fullName}'`);
    }
  }
}

// ----- T5: out-of-range faceIndex throws --------------------------------
{
  const f = '/System/Library/Fonts/Apple Color Emoji.ttc';
  if (!existsSync(f)) {
    ok('T5 skipped');
  } else {
    const b = new Uint8Array(readFileSync(f));
    let threw = false;
    try {
      const font = new MantleFontAsset(b, { faceIndex: 9999 });
      void font.name;
    } catch (_) {
      threw = true;
    }
    if (!threw) fail('T5 out-of-range faceIndex should throw');
    else ok('T5 out-of-range faceIndex throws');
  }
}

console.log();
console.log(failures === 0 ? 'TTC-FACE-SELECT PASS' : `TTC-FACE-SELECT FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
