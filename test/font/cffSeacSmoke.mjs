// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cffSeacSmoke — legacy Type 2 endchar-seac composition. Hand-builds a minimal
// CFF1 with a custom charset and four glyphs: .notdef, a base 'A' (SID 34), an
// accent 'grave' (SID 124), and a seac glyph whose charstring is
// `adx ady bchar achar endchar` with bchar=65 ('A' in StandardEncoding) and
// achar=193 ('grave'). CffReader.readGlyph must resolve the StandardEncoding
// codes → SIDs → GIDs via the charset, run base+accent, and translate the
// accent by (adx,ady). Verifies the composed outline == base ++ translated
// accent.
import { CffReader } from '../../src/font/formats/cffReader.js';

let fail = 0;
const eq = (a, b) => Math.abs(a - b) < 1e-6;

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
const str = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
// Type2 integer operand encoding (small ints + the 2-byte 108..1131 range).
const num = (v) => {
  if (v >= -107 && v <= 107) return [v + 139];
  if (v >= 108 && v <= 1131) {
    const w = v - 108;
    return [(w >> 8) + 247, w & 255];
  }
  if (v >= -1131 && v <= -108) {
    const w = -v - 108;
    return [(w >> 8) + 251, w & 255];
  }
  return [28, (v >> 8) & 255, v & 255];
};
const ENDCHAR = 14,
  RMOVETO = 21,
  RLINETO = 5;

// Top DICT: charset(15) + CharStrings(17) + Private(18), all i32 → fixed 23 bytes.
const TD_LEN = 23;
const topDict = (csetOff, csOff, privOff) => [
  ...i32(csetOff),
  15,
  ...i32(csOff),
  17,
  ...i32(0),
  ...i32(privOff),
  18,
];

const header = [1, 0, 4, 1];
const nameIndex = index([str('Seac')]);
const stringIndex = [0, 0];
const gsubrIndex = [0, 0];
// Custom charset, format 0: SIDs for gid 1..3 (gid0 .notdef implicit).
// gid1='A'(SID 34), gid2='grave'(SID 124), gid3=seac glyph (SID 35, arbitrary).
const charset = [0, 0, 34, 0, 124, 0, 35];
// Glyph charstrings.
const ADX = 30,
  ADY = 40;
const gNotdef = Uint8Array.from([ENDCHAR]);
const gBaseA = Uint8Array.from([
  ...num(100),
  ...num(0),
  RMOVETO,
  ...num(50),
  ...num(0),
  RLINETO,
  ENDCHAR,
]);
const gGrave = Uint8Array.from([
  ...num(10),
  ...num(200),
  RMOVETO,
  ...num(20),
  ...num(0),
  RLINETO,
  ENDCHAR,
]);
const gSeac = Uint8Array.from([...num(ADX), ...num(ADY), ...num(65), ...num(193), ENDCHAR]);
const charStrings = index([gNotdef, gBaseA, gGrave, gSeac]);

const pName = header.length;
const pTop = pName + nameIndex.length;
const topDictIndex0 = index([new Uint8Array(TD_LEN)]); // fixed size
const pStr = pTop + topDictIndex0.length;
const pGsub = pStr + stringIndex.length;
const pCset = pGsub + gsubrIndex.length;
const pChar = pCset + charset.length;
const pPriv = pChar + charStrings.length;

const td = topDict(pCset, pChar, pPriv);
const topDictIndex = index([Uint8Array.from(td)]);
if (topDictIndex.length !== topDictIndex0.length) {
  console.error('FAIL: TD INDEX size drift');
  fail++;
}

const cff = Uint8Array.from([
  ...header,
  ...nameIndex,
  ...topDictIndex,
  ...stringIndex,
  ...gsubrIndex,
  ...charset,
  ...charStrings,
]);

const r = new CffReader(cff, 0, cff.length, 1);
if (r.numGlyphs !== 4) {
  console.error(`FAIL: nGlyphs ${r.numGlyphs} != 4`);
  fail++;
}

const base = r.readGlyph(1);
const acc = r.readGlyph(2);
const composed = r.readGlyph(3); // the seac glyph

if (!base || !acc) {
  console.error('FAIL: base/accent did not render');
  fail++;
} else if (!composed) {
  console.error('FAIL: seac composed to null (resolution failed)');
  fail++;
} else {
  // Expected = base segs, then accent segs translated by (ADX, ADY).
  const expected = [
    ...base,
    ...acc.map((s) => {
      const t = (p) => [p[0] + ADX, p[1] + ADY];
      const o = { type: s.type, p1: t(s.p1), p2: t(s.p2) };
      if (s.p3) o.p3 = t(s.p3);
      if (s.p4) o.p4 = t(s.p4);
      return o;
    }),
  ];
  if (composed.length !== expected.length) {
    console.error(`FAIL: composed seg count ${composed.length} != expected ${expected.length}`);
    fail++;
  } else {
    let ok = true;
    for (let i = 0; i < expected.length; i++) {
      const a = composed[i],
        b = expected[i];
      for (const k of ['p1', 'p2', 'p3', 'p4']) {
        if (!b[k]) continue;
        if (!a[k] || !eq(a[k][0], b[k][0]) || !eq(a[k][1], b[k][1])) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
    }
    if (!ok) {
      console.error('FAIL: composed outline != base ++ translated accent');
      fail++;
    } else
      console.log(
        `  seac composed OK: ${base.length} base + ${acc.length} accent segs, accent +(${ADX},${ADY})`,
      );
  }
  // Spot check: at least one composed point must equal an accent point + offset.
  if (composed && acc && acc[0]) {
    const want = [acc[0].p1[0] + ADX, acc[0].p1[1] + ADY];
    const found = composed.some((s) => eq(s.p1[0], want[0]) && eq(s.p1[1], want[1]));
    if (!found) {
      console.error('FAIL: translated accent point not found in composed outline');
      fail++;
    }
  }
}

console.log(fail ? 'cffSeacSmoke: FAIL' : 'cffSeacSmoke: PASS');
process.exit(fail ? 1 : 0);
