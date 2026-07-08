// Verifies AAT 'kerx' contextual (format 1) and anchor (format 4) kerning.
//
// Format 1 is a state-machine kerning table (advance/offset deltas);
// format 4 attaches a glyph to a marked predecessor. Both fixtures use the
// extended encoding, guarding the run-based kerning path that getPairKerning
// (formats 0/2) cannot carry.

import { parseTtfTables } from '../../src/font/ttfTables.js';
import { AatKerx } from '../../src/font/typography/aatKerx.js';

let failures = 0;
const fail = (m) => { console.error('FAIL', m); failures++; };
const ok = (m) => console.log('ok', m);

const u16 = (n) => [(n >> 8) & 255, n & 255];
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const s16 = (n) => u16(n & 0xFFFF);
const pad4 = (a) => { while (a.length % 4) a.push(0); return a; };
const padTo = (a, len) => { while (a.length < len) a.push(0); return a; };
// AAT lookup format 6: gid1→class4, gid2→class5.
const look6 = [...u16(6), ...u16(4), ...u16(2), ...u16(8), ...u16(1), ...u16(0), ...u16(1), ...u16(4), ...u16(2), ...u16(5)];

function buildFont(kerx, extra = {}) {
  const head = new Array(54).fill(0); head[18] = 0x07; head[19] = 0xD0;
  const hhea = new Array(36).fill(0); hhea[35] = 1;
  const maxp = [...u32(0x00005000), ...u16(10)];
  const cmap6 = [...u16(6), ...u16(0), ...u16(0), ...u16(0x41), ...u16(3), ...u16(1), ...u16(2), ...u16(3)];
  const cmap = [...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12), ...cmap6];
  const tables = [['head', head], ['hhea', hhea], ['maxp', maxp], ['cmap', cmap], ['kerx', kerx],
    ...Object.entries(extra)].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let off = 12 + tables.length * 16; const dir = [], body = [];
  for (const [tag, data] of tables) {
    const pd = pad4([...data]);
    for (let i = 0; i < 4; i++) dir.push(tag.charCodeAt(i));
    dir.push(...u32(0), ...u32(off), ...u32(data.length)); body.push(...pd); off += pd.length;
  }
  return new Uint8Array([...u32(0x00010000), ...u16(tables.length), ...u16(0), ...u16(0), ...u16(0), ...dir, ...body]);
}

// Extended state machine shared by kerx 1 & 4: classOff=20 stateOff=40
// entryOff=64, then the format-specific table at 84.
function machine(extraField, entryTable, tail) {
  const stateArray = [];
  for (const x of [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 2]) stateArray.push(...u16(x));
  let m = [...u32(6), ...u32(20), ...u32(40), ...u32(64), ...extraField];
  m = padTo(m, 20); m.push(...look6); m = padTo(m, 40);
  m.push(...stateArray); m = padTo(m, 64);
  m.push(...entryTable); m = padTo(m, 84);
  m.push(...tail);
  while (m.length % 4) m.push(0);
  return m;
}

// ---- T1: format 1 — kern A by -150 only when followed by B ----
{
  const entry = [...u16(0), ...u16(0), ...u16(0xFFFF),          // e0
                 ...u16(1), ...u16(0x8000), ...u16(0xFFFF),     // e1 Push → state1
                 ...u16(0), ...u16(0), ...u16(0)];              // e2 action @ kernAction[0]
  const m = machine(u32(84), entry, s16(-150 | 1));            // kernAction offset = 84
  const sub = [...u32(12 + m.length), ...u32(0x00000001), ...u32(0), ...m];
  const t = parseTtfTables(buildFont([...u32(0x00020000), ...u32(1), ...sub]));
  const k = new AatKerx(t);
  if (!k.hasContextualKerning) fail('T1 should report contextual kerning');
  const g = (s) => [...s].map((c) => t.codepointToGlyphIndex(c.codePointAt(0)));
  for (const [s, ref] of [['AA', [0, 0]], ['AB', [-150, 0]], ['AAB', [0, -150, 0]]]) {
    const r = k.applyContextualKerning(g(s));
    if (JSON.stringify(r.xAdvance) !== JSON.stringify(ref)) fail(`T1 "${s}" xAdv=[${r.xAdvance}] != [${ref}]`);
    else ok(`T1-fmt1 "${s}" xAdvance=[${r.xAdvance}]`);
  }
}

// ---- T2: format 4 type 2 — attach B to a marked A at (300, 100) ----
{
  const entry = [...u16(0), ...u16(0), ...u16(0xFFFF),          // e0
                 ...u16(1), ...u16(0x8000), ...u16(0xFFFF),     // e1 Mark → state1
                 ...u16(0), ...u16(0), ...u16(0)];              // e2 ankrActionIndex=0
  const flags = 0x80000000 | 84;                                // actionType 2 (coordinate), offset 84
  const coord = [...s16(300), ...s16(100), ...s16(0), ...s16(0)]; // markX,markY,currX,currY
  const m = machine(u32(flags), entry, coord);
  const sub = [...u32(12 + m.length), ...u32(0x00000004), ...u32(0), ...m];
  const t = parseTtfTables(buildFont([...u32(0x00020000), ...u32(1), ...sub]));
  const k = new AatKerx(t);
  const g = (s) => [...s].map((c) => t.codepointToGlyphIndex(c.codePointAt(0)));
  for (const [s, ref] of [['AB', [{ idx: 1, markIdx: 0, dxFu: 300, dyFu: 100 }]], ['AA', []]]) {
    const r = k.applyContextualKerning(g(s));
    if (JSON.stringify(r.attach) !== JSON.stringify(ref)) fail(`T2 "${s}" attach=${JSON.stringify(r.attach)} != ${JSON.stringify(ref)}`);
    else ok(`T2-fmt4 "${s}" attach=${JSON.stringify(r.attach)}`);
  }
}

// kerx format-4 builder for a given action type + per-action data table.
function kerx4(actionType, dataTable, e2data) {
  const entry = [...u16(0), ...u16(0), ...u16(0xFFFF),
                 ...u16(1), ...u16(0x8000), ...u16(0xFFFF),
                 ...u16(0), ...u16(0), ...u16(e2data)];
  const flags = (actionType << 30) | 84;
  const m = machine(u32(flags), entry, dataTable);
  const sub = [...u32(12 + m.length), ...u32(0x00000004), ...u32(0), ...m];
  return [...u32(0x00020000), ...u32(1), ...sub];
}

// ---- T3: format 4 type 1 (anchor / 'ankr' table) ----
{
  // ankr: version0 flags0, lookupOff=12, anchorDataOff=32. lookup (fmt6)
  // gid1→0 (A anchors), gid2→8 (B anchors). A anchor0=(300,100), B=(0,0).
  const ankrLook = [...u16(6), ...u16(4), ...u16(2), ...u16(8), ...u16(1), ...u16(0), ...u16(1), ...u16(0), ...u16(2), ...u16(8)];
  const ankr = [...u16(0), ...u16(0), ...u32(12), ...u32(32), ...ankrLook,
                ...u32(1), ...s16(300), ...s16(100),   // A anchors
                ...u32(1), ...s16(0), ...s16(0)];       // B anchors
  const kerx = kerx4(1, [...u16(0), ...u16(0)], 0);     // action {markPt0, currPt0}
  const t = parseTtfTables(buildFont(kerx, { ankr }));
  const k = new AatKerx(t);
  const g = (s) => [...s].map((c) => t.codepointToGlyphIndex(c.codePointAt(0)));
  const a = k.applyContextualKerning(g('AB')).attach;
  const ref = [{ idx: 1, markIdx: 0, dxFu: 300, dyFu: 100 }];
  if (JSON.stringify(a) !== JSON.stringify(ref)) fail(`T3 ankr AB attach=${JSON.stringify(a)} != ${JSON.stringify(ref)}`);
  else ok(`T3-fmt4-type1(ankr) AB attach=${JSON.stringify(a)}`);
}

// ---- T4: format 4 type 0 (glyph outline control points) ----
{
  // A 2-point glyph {(100,200),(300,400)} at gid 1 and gid 2.
  const glyph = [...s16(1), ...s16(100), ...s16(200), ...s16(300), ...s16(400),
                 ...u16(1), ...u16(0), 0x01, 0x01, ...s16(100), ...s16(200), ...s16(200), ...s16(200)];
  const glyf = [...glyph, ...glyph];                    // gid1, gid2 copies
  const L = glyph.length;                                // 24 bytes
  const locaVals = [0, 0, L, 2 * L, 2 * L, 2 * L, 2 * L, 2 * L, 2 * L, 2 * L, 2 * L];
  const loca = locaVals.flatMap((b) => u16(b / 2));      // short loca (offset/2)
  const kerx = kerx4(0, [...u16(1), ...u16(0)], 0);      // markPt=1 (300,400), currPt=0 (100,200)
  const t = parseTtfTables(buildFont(kerx, { glyf, loca }));
  const k = new AatKerx(t);
  const g = (s) => [...s].map((c) => t.codepointToGlyphIndex(c.codePointAt(0)));
  const a = k.applyContextualKerning(g('AB')).attach;
  // dx = markX(300) - currX(100) = 200 ; dy = markY(400) - currY(200) = 200
  const ref = [{ idx: 1, markIdx: 0, dxFu: 200, dyFu: 200 }];
  if (JSON.stringify(a) !== JSON.stringify(ref)) fail(`T4 ctrl-pt AB attach=${JSON.stringify(a)} != ${JSON.stringify(ref)}`);
  else ok(`T4-fmt4-type0(control-point) AB attach=${JSON.stringify(a)}`);
}

// ---- T5: format 6 — 2D class array. Offsets are SUBTABLE-relative
// (header included = body-relative + 12). Expect kern(A,B)=-120, kern(A,A)=0. ----
{
  const look8 = (first, val) => [...u16(8), ...u16(first), ...u16(1), ...u16(val)];
  const rowB = 24, colB = 32, arrB = 40;
  const [rowOff, colOff, arrOff] = [rowB + 12, colB + 12, arrB + 12];   // subtable-relative
  const body = [...u32(0), ...u16(1), ...u16(2), ...u32(rowOff), ...u32(colOff), ...u32(arrOff), ...u32(arrOff),
    ...look8(1, 0), ...look8(2, 1), ...s16(0), ...s16(-120)];   // A→row0, B→col1, array[1]=-120
  while (body.length % 4) body.push(0);
  const sub = [...u32(12 + body.length), ...u32(0x00000006), ...u32(0), ...body];
  const t = parseTtfTables(buildFont([...u32(0x00020000), ...u32(1), ...sub]));
  const k = new AatKerx(t);
  const g = (s) => t.codepointToGlyphIndex(s.codePointAt(0));
  if (k.getPairKerning(g('A'), g('B')) !== -120) fail(`T5 fmt6 kern(A,B)=${k.getPairKerning(g('A'), g('B'))} != -120`);
  else if (k.getPairKerning(g('A'), g('A')) !== 0) fail('T5 fmt6 kern(A,A) should be 0');
  else ok('T5-fmt6 kern(A,B)=-120 kern(A,A)=0 (hb-validated)');
}

console.log(failures ? `\nAAT-KERX FAIL (${failures})` : '\nAAT-KERX PASS');
process.exit(failures ? 1 : 0);
