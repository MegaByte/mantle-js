// hvarlessAdvanceSmoke.mjs — variation-aware advance widths for a variable
// font that has NO HVAR table, where the advance must be derived from gvar
// phantom points. Exercises both the raw helper (glyphGvarAdvanceFu) and the
// full getGlyphAdvanceVar fallback path, with golden values that the C# port
// (MantleGlyphReader.GvarAdvanceFu) must match.

import { readFileSync, existsSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { glyphGvarAdvanceFu } from '../../src/font/glyphReader.js';
import { registerVariableFontReaders } from '../../src/font/variations/index.js';
registerVariableFontReaders();

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

const VF = '/System/Library/Fonts/NewYork.ttf';
if (!existsSync(VF)) {
  ok('all tests skipped (NewYork.ttf not present)');
  console.log(); console.log('HVARLESS-ADVANCE PASS (skipped)');
  process.exit(0);
}

// Rename the 'HVAR' entry in the sfnt table directory so the parser doesn't
// register it — turning NewYork into a (synthetic) HVAR-less variable font
// with its gvar/fvar intact. The directory is iterated linearly, so a tag the
// loader doesn't recognise is simply skipped (the table bytes stay put).
function stripHvarTag(src) {
  const b = new Uint8Array(src);                  // copy
  const dv = new DataView(b.buffer);
  const numTables = dv.getUint16(4, false);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (b[rec] === 0x48 && b[rec + 1] === 0x56 &&  // 'H' 'V'
        b[rec + 2] === 0x41 && b[rec + 3] === 0x52) { // 'A' 'R'
      b[rec] = 0x58; b[rec + 1] = 0x58; b[rec + 2] = 0x58; b[rec + 3] = 0x58; // 'XXXX'
      return b;
    }
  }
  return b; // no HVAR present (already HVAR-less)
}

const bytes = new Uint8Array(readFileSync(VF));
const font = new MantleFontAsset(bytes);
void font.name;
const fontNH = new MantleFontAsset(stripHvarTag(bytes));
void fontNH.name;

// gid + golden advance (font units) at max wght for this NewYork. Static is the
// default-instance advance; gvarMax is the gvar-phantom advance at wght=1000.
// (gid 909 = 'i' is a COMPOSITE glyph — the phantom-point helper can't answer.)
const CASES = [
  { cp: 0x41, gid: 4,   static: 1244, gvarMax: 1490 }, // A
  { cp: 0x6d, gid: 961, static: 1646, gvarMax: 2080 }, // m
  { cp: 0x57, gid: 251, static: 2001, gvarMax: 2314 }, // W
  { cp: 0x6f, gid: 983, static: 1106, gvarMax: 1344 }, // o
];

// ----- preconditions --------------------------------------------------
if (!font.isVariable) fail('NewYork not detected as variable');
if (!font.hvar.hasHvar) fail('expected stock NewYork to ship HVAR');
if (fontNH.hvar.hasHvar) fail('HVAR-stripped copy still reports HVAR');
if (!fontNH.isVariable) fail('HVAR-stripped copy lost variability (gvar/fvar)');

const def = font.fvar.defaultCoords();
const wi = font.fvar.axes.findIndex((a) => a.tag === 'wght');
const maxw = def.slice(); maxw[wi] = font.fvar.axes[wi].max;
const nDef = font.fvar.normalizeCoords(def);
const nMax = font.fvar.normalizeCoords(maxw);
const upem = font.unitsPerEm;

// ----- T1: gid mapping sanity ----------------------------------------
for (const c of CASES) {
  if (font.codepointToGlyphId(c.cp) !== c.gid)
    fail(`T1 U+${c.cp.toString(16)} → gid ${font.codepointToGlyphId(c.cp)}, fixture expects ${c.gid}`);
}
if (failures === 0) ok('T1 gid mapping matches fixture');

// ----- T2: gvar phantom advance — default == static, max == golden ----
for (const c of CASES) {
  const aDef = glyphGvarAdvanceFu(c.gid, font._tables, nDef);
  const aMax = glyphGvarAdvanceFu(c.gid, font._tables, nMax);
  if (aDef !== c.static) fail(`T2 U+${c.cp.toString(16)} gvar@default ${aDef} != static ${c.static}`);
  if (aMax !== c.gvarMax) fail(`T2 U+${c.cp.toString(16)} gvar@maxWght ${aMax} != golden ${c.gvarMax}`);
  if (aMax === c.static) fail(`T2 U+${c.cp.toString(16)} advance did not vary with weight`);
}
if (failures === 0) ok('T2 gvar phantom advance: default == static, maxWght == golden, varies');

// ----- T3: getGlyphAdvanceVar fallback path (HVAR-less font) -----------
// On the stripped font, getGlyphAdvanceVar must route through gvar phantom
// points and return the same advance (in em) as the raw helper.
for (const c of CASES) {
  const advEm = fontNH.getGlyphAdvanceVar(c.gid, maxw);
  const wantEm = c.gvarMax / upem;
  if (Math.abs(advEm - wantEm) > 1e-9)
    fail(`T3 U+${c.cp.toString(16)} getGlyphAdvanceVar(HVAR-less)=${advEm} want ${wantEm}`);
  // default coords → static advance (em)
  const advDefEm = fontNH.getGlyphAdvanceVar(c.gid, def);
  if (Math.abs(advDefEm - c.static / upem) > 1e-9)
    fail(`T3 U+${c.cp.toString(16)} getGlyphAdvanceVar@default=${advDefEm} want ${c.static / upem}`);
}
if (failures === 0) ok('T3 getGlyphAdvanceVar routes HVAR-less VFs through gvar phantom points');

// ----- T4: composite glyph → helper returns null (documented limit) ---
{
  const gidI = font.codepointToGlyphId(0x69); // 'i' is composite in NewYork
  const aI = glyphGvarAdvanceFu(gidI, font._tables, nMax);
  if (aI !== null) fail(`T4 composite glyph should return null, got ${aI}`);
  else ok('T4 composite glyph advance returns null (falls back to static)');
}

console.log();
if (failures === 0) { console.log('HVARLESS-ADVANCE PASS'); process.exit(0); }
console.log(`HVARLESS-ADVANCE FAIL (${failures})`); process.exit(1);
