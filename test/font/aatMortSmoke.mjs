// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Verifies AAT legacy 'mort' metamorphosis.
//
// Builds a synthetic sfnt with a noncontextual 'mort' subtable mapping
// glyph 1 (A) → glyph 3 (C), and asserts the reader applies it, plus the
// classic ligature / contextual / rearrangement / insertion state machines.

import { parseTtfTables } from '../../src/font/ttfTables.js';
import { AatMort } from '../../src/font/typography/aatMort.js';

let failures = 0;
const fail = (m) => {
  console.error('FAIL', m);
  failures++;
};
const ok = (m) => console.log('ok', m);

const u16 = (n) => [(n >> 8) & 255, n & 255];
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const pad4 = (a) => {
  while (a.length % 4) a.push(0);
  return a;
};

// AAT lookup format 6 (single-glyph binary search): gid g → value v.
const lookup6 = (g, v) => [
  ...u16(6),
  ...u16(4),
  ...u16(1),
  ...u16(4),
  ...u16(0),
  ...u16(0),
  ...u16(g),
  ...u16(v),
];

function mortNoncontextual() {
  const body = lookup6(1, 3); // A(gid1) → C(gid3)
  const sub = [...u16(8 + body.length), ...u16(0x0004), ...u32(1), ...body]; // type 4, horizontal
  let chain = [...u32(1), ...u32(0), ...u16(0), ...u16(1), ...sub];
  chain = [...u32(1), ...u32(chain.length), ...u16(0), ...u16(1), ...sub]; // defaultFlags, chainLength
  return [...u32(0x00010000), ...u32(1), ...chain];
}

// cmap format 6: 0x41..0x43 → gids 1..3.
const cmap6 = () => [
  ...u16(6),
  ...u16(0),
  ...u16(0),
  ...u16(0x41),
  ...u16(3),
  ...u16(1),
  ...u16(2),
  ...u16(3),
];

function buildFont(mort = mortNoncontextual()) {
  const head = new Array(54).fill(0);
  head[18] = 0x07;
  head[19] = 0xd0;
  const hhea = new Array(36).fill(0);
  hhea[35] = 1;
  const maxp = [...u32(0x00005000), ...u16(10)]; // numGlyphs = 10
  const cmapBody = cmap6();
  const cmap = [...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12), ...cmapBody];
  const tables = [
    ['head', head],
    ['hhea', hhea],
    ['maxp', maxp],
    ['cmap', cmap],
    ['mort', mort],
  ].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let off = 12 + tables.length * 16;
  const dir = [],
    body = [];
  for (const [tag, data] of tables) {
    const pd = pad4([...data]);
    for (let i = 0; i < 4; i++) dir.push(tag.charCodeAt(i));
    dir.push(...u32(0), ...u32(off), ...u32(data.length));
    body.push(...pd);
    off += pd.length;
  }
  return new Uint8Array([
    ...u32(0x00010000),
    ...u16(tables.length),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...dir,
    ...body,
  ]);
}

const t = parseTtfTables(buildFont());
const mort = new AatMort(t);
if (!mort.hasMort) fail('T1 synthetic font should have mort');
else ok('T1 hasMort');

const gid = (s) => [...s].map((c) => t.codepointToGlyphIndex(c.codePointAt(0)));
for (const [s, ref] of [
  ['A', [3]],
  ['AB', [3, 2]],
  ['BA', [2, 3]],
  ['B', [2]],
]) {
  const out = mort.apply(gid(s)).gids;
  if (JSON.stringify(out) !== JSON.stringify(ref)) fail(`T2 "${s}" → [${out}] != [${ref}]`);
  else ok(`T2 "${s}" → [${out}] (noncontextual A→C)`);
}

// ---- T3: classic ligature state machine ([A,B] → C). Classic ligature
// addressing is offset-from-body, NOT index-based like morx. ----
function mortLigature() {
  const NC = 6;
  // body offsets: header(14) class@14 state@21 entry@33 ligAct@48 comp@56 lig@60
  const classOff = 14,
    stateOff = 21,
    entryOff = 33,
    ligActOff = 48,
    compOff = 56,
    ligOff = 60;
  const classTable = [...u16(1), ...u16(3), 4, 5, 1];
  const stateArray = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 2];
  const entry = [
    ...u16(stateOff + 0),
    ...u16(0), // e0 noop
    ...u16(stateOff + NC),
    ...u16(0x8000), // e1 setComponent → state1
    ...u16(stateOff + 0),
    ...u16(0x8000 | ligActOff), // e2 setComponent + action @ ligActOff
  ];
  const pad = new Array(ligActOff - 45).fill(0);
  const ligAction = [...u32(26), ...u32(0x80000000 | 28)]; // B(off26,last0), A(off28,last1)
  const component = [...u16(ligOff), ...u16(0)]; // compVal_B=60, compVal_A=0
  const ligature = u16(3); // ligature[0] = gid 3 (C)
  let body = [
    ...u16(NC),
    ...u16(classOff),
    ...u16(stateOff),
    ...u16(entryOff),
    ...u16(ligActOff),
    ...u16(compOff),
    ...u16(ligOff),
    ...classTable,
    ...stateArray,
    ...entry,
    ...pad,
    ...ligAction,
    ...component,
    ...ligature,
  ];
  while (body.length % 4) body.push(0);
  const sub = [...u16(8 + body.length), ...u16(0x0002), ...u32(1), ...body]; // type 2 ligature
  let chain = [...u32(1), ...u32(0), ...u16(0), ...u16(1), ...sub];
  chain = [...u32(1), ...u32(chain.length), ...u16(0), ...u16(1), ...sub];
  return [...u32(0x00010000), ...u32(1), ...chain];
}
{
  const tl = parseTtfTables(buildFont(mortLigature()));
  const ml = new AatMort(tl);
  const g = (s) => [...s].map((c) => tl.codepointToGlyphIndex(c.codePointAt(0)));
  for (const [s, ref] of [
    ['A', [1]],
    ['AB', [3]],
    ['ABB', [3, 2]],
    ['AAB', [1, 3]],
  ]) {
    const out = ml.apply(g(s)).gids;
    if (JSON.stringify(out) !== JSON.stringify(ref)) fail(`T3 "${s}" → [${out}] != hb [${ref}]`);
    else ok(`T3 "${s}" → [${out}] (classic ligature, hb-validated)`);
  }
}

// ---- T4–T6: contextual / rearrangement / insertion state machines. ----
const cls = [...u16(1), ...u16(3), 4, 5, 1]; // gids 1,2,3 → class 4,5,1
function run(mortBytes, sm, cases, label) {
  const tt = parseTtfTables(buildFont(mortBytes));
  const m = new AatMort(tt);
  const g = (s) => [...s].map((c) => tt.codepointToGlyphIndex(c.codePointAt(0)));
  for (const [s, ref] of cases) {
    const out = m.apply(g(s)).gids;
    if (JSON.stringify(out) !== JSON.stringify(ref))
      fail(`${label} "${s}" → [${out}] != hb [${ref}]`);
    else ok(`${label} "${s}" → [${out}]`);
  }
}
const wrap = (sub) => {
  let chain = [...u32(1), ...u32(0), ...u16(0), ...u16(1), ...sub];
  chain = [...u32(1), ...u32(chain.length), ...u16(0), ...u16(1), ...sub];
  return [...u32(0x00010000), ...u32(1), ...chain];
};
// T4 contextual: substitute current A→C only after a B.
{
  const NC = 6,
    classOff = 10,
    stateOff = 17,
    entryOff = 29,
    substOff = 54,
    substVal = 26;
  const state = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 1];
  const entry = [
    ...u16(stateOff),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u16(stateOff + NC),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u16(stateOff),
    ...u16(0),
    ...u16(0),
    ...u16(substVal),
  ];
  let body = [
    ...u16(NC),
    ...u16(classOff),
    ...u16(stateOff),
    ...u16(entryOff),
    ...u16(substOff),
    ...cls,
    ...state,
    ...entry,
    ...new Array(substOff - 53).fill(0),
    ...u16(3),
  ];
  while (body.length % 4) body.push(0);
  run(
    wrap([...u16(8 + body.length), ...u16(0x0001), ...u32(1), ...body]),
    1,
    [
      ['AA', [1, 1]],
      ['AB', [1, 2]],
      ['BA', [2, 3]],
      ['BAA', [2, 3, 1]],
    ],
    'T4-ctx',
  );
}
// T5 rearrangement: verb 3 (AxD→DxA) swaps a marked A…B pair.
{
  const NC = 6,
    classOff = 8,
    stateOff = 15,
    entryOff = 27;
  const state = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 2];
  const entry = [
    ...u16(stateOff),
    ...u16(0),
    ...u16(stateOff + NC),
    ...u16(0x8000),
    ...u16(stateOff),
    ...u16(0x2000 | 0x0003),
  ];
  let body = [
    ...u16(NC),
    ...u16(classOff),
    ...u16(stateOff),
    ...u16(entryOff),
    ...cls,
    ...state,
    ...entry,
  ];
  while (body.length % 4) body.push(0);
  run(
    wrap([...u16(8 + body.length), ...u16(0x0000), ...u32(1), ...body]),
    0,
    [
      ['AB', [2, 1]],
      ['AAB', [1, 2, 1]],
      ['ABA', [2, 1, 1]],
    ],
    'T5-rearr',
  );
}
// T6 insertion: insert C after each B.
{
  const NC = 6,
    classOff = 10,
    stateOff = 17,
    entryOff = 23,
    insOff = 40;
  const state = [0, 0, 0, 0, 0, 1];
  const entry = [
    ...u16(stateOff),
    ...u16(0),
    ...u16(0xffff),
    ...u16(0xffff),
    ...u16(stateOff),
    ...u16(0x20),
    ...u16(0),
    ...u16(0xffff),
  ];
  let body = [
    ...u16(NC),
    ...u16(classOff),
    ...u16(stateOff),
    ...u16(entryOff),
    ...u16(insOff),
    ...cls,
    ...state,
    ...entry,
    ...new Array(insOff - 39).fill(0),
    ...u16(3),
  ];
  while (body.length % 4) body.push(0);
  run(
    wrap([...u16(8 + body.length), ...u16(0x0005), ...u32(1), ...body]),
    5,
    [
      ['B', [2, 3]],
      ['AB', [1, 2, 3]],
      ['BB', [2, 3, 2, 3]],
      ['ABA', [1, 2, 3, 1]],
    ],
    'T6-ins',
  );
}

// Equivalent indexed and canonical byte-offset insertion encodings.
for (const indexed of [true, false]) {
  const nc = 6,
    classOff = indexed ? 10 : 8,
    classes = [...u16(1), ...u16(3), 4, 5, 1],
    stateOff = classOff + classes.length,
    entryOff = stateOff + nc * 2,
    actionOff = entryOff + 24;
  const state = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 2],
    none = indexed ? 0xffff : 0,
    marked = indexed ? 0 : actionOff;
  const entry = [
    ...u16(stateOff),
    ...u16(0),
    ...u16(none),
    ...u16(none),
    ...u16(stateOff + nc),
    ...u16(0x8000),
    ...u16(none),
    ...u16(none),
    ...u16(stateOff),
    ...u16(1 | 0x400),
    ...u16(none),
    ...u16(marked),
  ];
  const body = [
    ...u16(nc),
    ...u16(classOff),
    ...u16(stateOff),
    ...u16(entryOff),
    ...(indexed ? u16(actionOff) : []),
    ...classes,
    ...state,
    ...entry,
    ...u16(3),
  ];
  const table = wrap([...u16(8 + body.length), ...u16(5), ...u32(1), ...body]);
  const actual = new AatMort(parseTtfTables(buildFont(table))).apply([1, 2]);
  if (actual.gids.join() !== '3,1,2' || actual.src.join() !== '0,0,1')
    fail(`marked-before encoding indexed=${indexed}`);
  else ok(`marked-before encoding indexed=${indexed}`);
}

console.log(failures ? `\nAAT-MORT FAIL (${failures})` : '\nAAT-MORT PASS');
process.exit(failures ? 1 : 0);
