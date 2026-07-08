// hvarReaderSmoke.mjs — HVAR advance-width variations.
// Verifies that variable fonts' advance widths grow at heavy weights
// (otherwise glyphs overlap on the page).

import { readFileSync, existsSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { registerVariableFontReaders } from '../../src/font/variations/index.js';
registerVariableFontReaders();

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

const VF = '/System/Library/Fonts/NewYork.ttf';
if (!existsSync(VF)) {
  ok('all tests skipped (NewYork.ttf not present)');
  console.log(); console.log('HVAR-READER PASS (skipped)');
  process.exit(0);
}

const bytes = new Uint8Array(readFileSync(VF));
const font = new MantleFontAsset(bytes);
void font.name;

// ----- T1: font has HVAR ----------------------------------------------
{
  if (!font.hvar.hasHvar) fail('T1 NewYork should ship HVAR');
  else ok('T1 NewYork has HVAR');
}

// ----- T2: advance at default == static hmtx --------------------------
{
  const gidA = font.codepointToGlyphId(0x41);
  const advStatic = font._tables.glyphAdvanceWidth(gidA) / font.unitsPerEm;
  const advVarDef = font.getGlyphAdvanceVar(gidA, font.fvar.defaultCoords());
  if (Math.abs(advStatic - advVarDef) > 1e-4)
    fail(`T2 default-coords advance ${advVarDef} != static ${advStatic}`);
  else ok(`T2 'A' default-coords advance == static hmtx (${advStatic.toFixed(4)} em)`);
}

// ----- T3: advance at wght=max grows ---------------------------------
{
  const gidA = font.codepointToGlyphId(0x41);
  const wghtAxis = font.fvar.findAxis('wght');
  const defCoords = font.fvar.defaultCoords();
  const maxCoords = defCoords.slice();
  for (let i = 0; i < font.fvar.axes.length; i++)
    if (font.fvar.axes[i].tag === 'wght') maxCoords[i] = wghtAxis.max;
  const advDef = font.getGlyphAdvanceVar(gidA, defCoords);
  const advMax = font.getGlyphAdvanceVar(gidA, maxCoords);
  if (advMax <= advDef)
    fail(`T3 wght=max advance ${advMax} not > wght=default ${advDef}`);
  else ok(`T3 'A' advance: wght=${wghtAxis.default}→${advDef.toFixed(4)} em, wght=${wghtAxis.max}→${advMax.toFixed(4)} em (+${((advMax/advDef - 1) * 100).toFixed(1)}%)`);
}

// ----- T4: every glyph in "Hello" widens at heavy weight --------------
{
  const wghtAxis = font.fvar.findAxis('wght');
  const defCoords = font.fvar.defaultCoords();
  const maxCoords = defCoords.slice();
  for (let i = 0; i < font.fvar.axes.length; i++)
    if (font.fvar.axes[i].tag === 'wght') maxCoords[i] = wghtAxis.max;
  let allGrew = true;
  let widened = 0;
  for (const ch of 'Hello') {
    const gid = font.codepointToGlyphId(ch.charCodeAt(0));
    const aD = font.getGlyphAdvanceVar(gid, defCoords);
    const aM = font.getGlyphAdvanceVar(gid, maxCoords);
    if (aM <= aD) allGrew = false;
    else widened++;
  }
  if (!allGrew) fail(`T4 only ${widened}/5 'Hello' glyphs widened at heavy weight`);
  else ok(`T4 all 5 'Hello' glyphs widen at wght=max`);
}

console.log();
console.log(failures === 0 ? 'HVAR-READER PASS' : `HVAR-READER FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
