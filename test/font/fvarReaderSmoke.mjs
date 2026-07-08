// fvarReaderSmoke.mjs — variable-font axis discovery + normalize.

import { readFileSync, existsSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { FvarTable } from '../../src/font/variations/fvarReader.js';
import { registerVariableFontReaders } from '../../src/font/variations/index.js';
registerVariableFontReaders();

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

// ----- T1: non-variable font reports isVariable=false ------------------
{
  const f = '/System/Library/Fonts/Supplemental/Arial.ttf';
  if (!existsSync(f)) ok('T1 skipped');
  else {
    const b = new Uint8Array(readFileSync(f));
    const font = new MantleFontAsset(b);
    if (font.isVariable) fail('T1 Arial should not be variable');
    else if (font.fvar.axes != null && font.fvar.axes.length > 0)
      fail('T1 Arial reports axes');
    else ok('T1 Arial → isVariable=false');
  }
}

// ----- T2: SF Arabic has wght + opsz axes ------------------------------
{
  const f = '/System/Library/Fonts/SFArabic.ttf';
  if (!existsSync(f)) ok('T2 skipped');
  else {
    const b = new Uint8Array(readFileSync(f));
    const font = new MantleFontAsset(b);
    if (!font.isVariable) fail('T2 SFArabic should be variable');
    else if (font.fvar.axes.length !== 2)
      fail(`T2 SFArabic axes=${font.fvar.axes.length}, expected 2`);
    else {
      const tags = font.fvar.axes.map(a => a.tag).sort();
      if (tags[0] !== 'opsz' || tags[1] !== 'wght')
        fail(`T2 SFArabic axis tags ${tags}, expected ['opsz','wght']`);
      else ok(`T2 SFArabic axes: ${tags.join(',')}`);
    }
  }
}

// ----- T3: New York has 3 axes (opsz, wght, GRAD) ----------------------
{
  const f = '/System/Library/Fonts/NewYork.ttf';
  if (!existsSync(f)) ok('T3 skipped');
  else {
    const b = new Uint8Array(readFileSync(f));
    const font = new MantleFontAsset(b);
    if (!font.isVariable) fail('T3 NewYork should be variable');
    else {
      const wght = font.fvar.findAxis('wght');
      if (!wght) fail('T3 wght axis missing');
      else if (wght.min !== 400) fail(`T3 wght min=${wght.min}, expected 400`);
      else if (wght.max !== 1000) fail(`T3 wght max=${wght.max}, expected 1000`);
      else ok(`T3 NewYork wght axis: ${wght.min}..${wght.max} (default ${wght.default})`);
    }
  }
}

// ----- T4: defaultCoords picks each axis's default --------------------
{
  const f = '/System/Library/Fonts/NewYork.ttf';
  if (!existsSync(f)) ok('T4 skipped');
  else {
    const b = new Uint8Array(readFileSync(f));
    const font = new MantleFontAsset(b);
    const coords = font.fvar.defaultCoords();
    if (coords.length !== font.fvar.axes.length)
      fail(`T4 coords len=${coords.length}, axes=${font.fvar.axes.length}`);
    else {
      let ok_ = true;
      for (let i = 0; i < coords.length; i++) {
        if (coords[i] !== font.fvar.axes[i].default) { ok_ = false; break; }
      }
      if (!ok_) fail('T4 defaultCoords mismatch');
      else ok(`T4 defaultCoords matches each axis.default`);
    }
  }
}

// ----- T5: normalizeCoords maps (min,default,max) → (-1,0,+1) ----------
{
  const f = '/System/Library/Fonts/NewYork.ttf';
  if (!existsSync(f)) ok('T5 skipped');
  else {
    const b = new Uint8Array(readFileSync(f));
    const font = new MantleFontAsset(b);
    // Build raw coords at min, default, max for each axis.
    const axes = font.fvar.axes;
    const atMin = axes.map(a => a.min);
    const atDef = axes.map(a => a.default);
    const atMax = axes.map(a => a.max);
    const nMin = font.fvar.normalizeCoords(atMin);
    const nDef = font.fvar.normalizeCoords(atDef);
    const nMax = font.fvar.normalizeCoords(atMax);
    let ok_ = true;
    for (let i = 0; i < axes.length; i++) {
      if (nMin[i] !== -1 || nDef[i] !== 0 || nMax[i] !== 1) {
        // It's possible an axis has min == default OR default == max,
        // in which case one of the bounds normalizes to 0. Tolerate.
        if (axes[i].min === axes[i].default && nMin[i] !== 0) ok_ = false;
        else if (axes[i].max === axes[i].default && nMax[i] !== 0) ok_ = false;
        else if (axes[i].min !== axes[i].default && nMin[i] !== -1) ok_ = false;
        else if (axes[i].max !== axes[i].default && nMax[i] !== 1)  ok_ = false;
        if (nDef[i] !== 0) ok_ = false;
      }
    }
    if (!ok_) fail(`T5 normalize: nMin=${nMin} nDef=${nDef} nMax=${nMax}`);
    else ok(`T5 normalizeCoords: (min,default,max) → (-1,0,+1) for ${axes.length} axes`);
  }
}

// ----- T6: instance names resolve via name table ----------------------
{
  const f = '/System/Library/Fonts/NewYork.ttf';
  if (!existsSync(f)) ok('T6 skipped');
  else {
    const b = new Uint8Array(readFileSync(f));
    const font = new MantleFontAsset(b);
    const insts = font.fvar.instances;
    if (!insts || insts.length === 0) fail('T6 no instances');
    else {
      const sample = insts[0];
      if (!sample.subfamilyName) fail(`T6 first instance has empty subfamilyName`);
      else ok(`T6 NewYork instances[0].subfamilyName='${sample.subfamilyName}' (${insts.length} total)`);
    }
  }
}

console.log();
console.log(failures === 0 ? 'FVAR-READER PASS' : `FVAR-READER FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
