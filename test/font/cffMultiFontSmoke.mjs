// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cffMultiFontSmoke.mjs — CFF1 FontSet (Top DICT INDEX count > 1).
//
// Real multi-font CFFs are essentially extinct, so we hand-build a minimal
// 2-font CFF1 (both Top DICTs share one CharStrings + empty Private) and check
// that CffReader selects either font instead of throwing. Top DICTs use
// fixed-width (op 29, int32) operands so their size is constant and the
// absolute CharStrings/Private offsets can be back-patched.
import { CffReader } from '../../src/font/formats/cffReader.js';

let fail = 0;
function index(items) {
  if (items.length === 0) return [0, 0];
  let dataLen = 0;
  for (const it of items) dataLen += it.length;
  const offSize = dataLen + 1 < 256 ? 1 : 2;
  const out = [(items.length >> 8) & 255, items.length & 255, offSize];
  const wOff = (v) => {
    if (offSize === 1) out.push(v & 255);
    else out.push((v >> 8) & 255, v & 255);
  };
  let off = 1;
  wOff(off);
  for (const it of items) {
    off += it.length;
    wOff(off);
  }
  for (const it of items) for (const b of it) out.push(b);
  return out;
}
const i32 = (v) => [29, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const topDict = (csOff, privLen, privOff) => [
  ...i32(csOff),
  17,
  ...i32(privLen),
  ...i32(privOff),
  18,
]; // 17 bytes
const str = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

const header = [1, 0, 4, 1];
const nameIndex = index([str('FontA'), str('FontB')]);
const TD_LEN = 17;
const topDictIndex0 = index([new Uint8Array(TD_LEN), new Uint8Array(TD_LEN)]); // size only (fixed)
const stringIndex = [0, 0];
const gsubrIndex = [0, 0];
const charStrings = index([Uint8Array.from([14])]); // 1 glyph: endchar

// Positions (Top DICT INDEX size is constant → all computable up front).
const pName = header.length;
const pTop = pName + nameIndex.length;
const pStr = pTop + topDictIndex0.length;
const pGsub = pStr + stringIndex.length;
const pChar = pGsub + gsubrIndex.length;
const pPriv = pChar + charStrings.length;

const td = topDict(pChar, 0, pPriv); // CharStrings @pChar, Private empty @pPriv
const topDictIndex = index([Uint8Array.from(td), Uint8Array.from(td)]);
if (topDictIndex.length !== topDictIndex0.length) {
  console.error('FAIL: Top DICT INDEX size drift');
  fail++;
}

const cff = Uint8Array.from([
  ...header,
  ...nameIndex,
  ...topDictIndex,
  ...stringIndex,
  ...gsubrIndex,
  ...charStrings,
]);

for (const fi of [0, 1]) {
  try {
    const r = new CffReader(cff, 0, cff.length, 1, fi);
    if (r._nGlyphs !== 1) {
      console.error(`FAIL: font ${fi} nGlyphs ${r._nGlyphs} != 1`);
      fail++;
    }
    if (r._fontCount !== 2) {
      console.error(`FAIL: font ${fi} fontCount ${r._fontCount} != 2`);
      fail++;
    } else console.log(`  font ${fi}: parsed OK (${r._nGlyphs} glyph, fontCount ${r._fontCount})`);
  } catch (e) {
    console.error(`FAIL: font ${fi} threw: ${e.message}`);
    fail++;
  }
}
// Out-of-range index falls back to font 0 rather than throwing.
try {
  new CffReader(cff, 0, cff.length, 1, 99);
  console.log('  out-of-range index → font 0 (no throw) OK');
} catch (e) {
  console.error(`FAIL: out-of-range index threw: ${e.message}`);
  fail++;
}

console.log(fail ? 'cffMultiFontSmoke: FAIL' : 'cffMultiFontSmoke: PASS');
process.exit(fail ? 1 : 0);
