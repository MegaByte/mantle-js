// mvarReaderSmoke.mjs — MVAR font-wide metric variations.

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
  console.log(); console.log('MVAR-READER PASS (skipped)');
  process.exit(0);
}

const bytes = new Uint8Array(readFileSync(VF));
const font = new MantleFontAsset(bytes);
void font.name;

// ----- T1: NewYork ships MVAR -----------------------------------------
{
  if (!font.mvar.hasMvar) fail('T1 NewYork should ship MVAR');
  else ok('T1 NewYork has MVAR');
}

// ----- T2: default-coords metrics == static metrics --------------------
{
  const def = font.fvar.defaultCoords();
  const m = font.getMetricsVar(def);
  if (Math.abs(m.ascent - font.ascent) > 1e-4 ||
      Math.abs(m.descent - font.descent) > 1e-4 ||
      Math.abs(m.lineGap - font.lineGap) > 1e-4) {
    fail(`T2 default metrics drift: a=${m.ascent}/${font.ascent} d=${m.descent}/${font.descent}`);
  } else ok(`T2 default-coords metrics match static (asc=${m.ascent.toFixed(3)} dsc=${m.descent.toFixed(3)})`);
}

// ----- T3: heavy-weight metrics may differ ---------------------------
{
  const def = font.fvar.defaultCoords();
  const max = def.slice();
  for (let i = 0; i < font.fvar.axes.length; i++)
    if (font.fvar.axes[i].tag === 'wght') max[i] = font.fvar.findAxis('wght').max;
  const mDef = font.getMetricsVar(def);
  const mMax = font.getMetricsVar(max);
  // Underline thickness usually grows at heavier weights.
  if (mMax.underlineThickness === mDef.underlineThickness) {
    // Not a failure — some fonts don't vary underline. Inform.
    ok(`T3 underline thickness static: ${mDef.underlineThickness.toFixed(4)} em`);
  } else {
    const dpct = ((mMax.underlineThickness / mDef.underlineThickness) - 1) * 100;
    ok(`T3 underline thickness at wght=max: ${mDef.underlineThickness.toFixed(4)} → ${mMax.underlineThickness.toFixed(4)} em (${dpct.toFixed(1)}%)`);
  }
}

console.log();
console.log(failures === 0 ? 'MVAR-READER PASS' : `MVAR-READER FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
