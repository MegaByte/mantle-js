// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gvarReaderSmoke.mjs — variable-font outline morphing end-to-end.
// Verifies that gvar deltas applied at different axis coordinates
// produce different glyph outlines (proving the variation pipeline
// works), and that coords at axis default match static read.

import { readFileSync, existsSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { registerVariableFontReaders } from '../../src/font/variations/index.js';
registerVariableFontReaders();

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

function segsHash(segs) {
  if (!segs) return 'null';
  let s = `${segs.length}:`;
  for (const seg of segs) {
    s += seg.type + ',';
    s += seg.p1[0].toFixed(1) + ',' + seg.p1[1].toFixed(1) + ',';
    if (seg.p2) s += seg.p2[0].toFixed(1) + ',' + seg.p2[1].toFixed(1) + ',';
    if (seg.p3) s += seg.p3[0].toFixed(1) + ',' + seg.p3[1].toFixed(1) + ',';
    if (seg.p4) s += seg.p4[0].toFixed(1) + ',' + seg.p4[1].toFixed(1) + ',';
    s += '|';
  }
  return s;
}

const VF = '/System/Library/Fonts/NewYork.ttf';
if (!existsSync(VF)) {
  ok('all tests skipped (NewYork.ttf not present)');
  console.log();
  console.log('GVAR-READER PASS (skipped)');
  process.exit(0);
}

const bytes = new Uint8Array(readFileSync(VF));
const font = new MantleFontAsset(bytes);
void font.name;

// ----- T1: font is variable; outline at default == static read --------
{
  if (!font.isVariable) fail('T1 NewYork not detected as variable');
  else {
    const gidA = font.codepointToGlyphId(0x41);
    const sStatic = font.getGlyphSegsByGid(gidA);
    const sVarDef = font.getGlyphSegsByGidVar(gidA, font.fvar.defaultCoords());
    if (segsHash(sStatic) !== segsHash(sVarDef))
      fail(`T1 default-coords outline differs from static read`);
    else ok(`T1 'A' at default coords matches static outline`);
  }
}

// ----- T2: outline at max wght differs from default -------------------
{
  const gidA = font.codepointToGlyphId(0x41);
  const wghtAxis = font.fvar.findAxis('wght');
  if (!wghtAxis) fail('T2 wght axis missing on NewYork');
  else {
    const defCoords = font.fvar.defaultCoords();
    const maxCoords = defCoords.slice();
    for (let i = 0; i < font.fvar.axes.length; i++)
      if (font.fvar.axes[i].tag === 'wght') maxCoords[i] = wghtAxis.max;
    const sDef = font.getGlyphSegsByGidVar(gidA, defCoords);
    const sMax = font.getGlyphSegsByGidVar(gidA, maxCoords);
    if (!sDef || !sMax) fail(`T2 outlines null (def=${!!sDef} max=${!!sMax})`);
    else if (segsHash(sDef) === segsHash(sMax))
      fail(`T2 'A' at wght=400 identical to wght=1000 (gvar deltas not applied)`);
    else ok(`T2 'A' at wght=400 vs wght=1000 differs (${sDef.length} vs ${sMax.length} segs)`);
  }
}

// ----- T3: outline at min wght differs from max -----------------------
{
  const gidA = font.codepointToGlyphId(0x41);
  const wghtAxis = font.fvar.findAxis('wght');
  if (!wghtAxis) {
    ok('T3 skipped (no wght)');
  } else {
    const minCoords = font.fvar.defaultCoords();
    const maxCoords = font.fvar.defaultCoords();
    for (let i = 0; i < font.fvar.axes.length; i++) {
      if (font.fvar.axes[i].tag === 'wght') {
        minCoords[i] = wghtAxis.min;
        maxCoords[i] = wghtAxis.max;
      }
    }
    const sMin = font.getGlyphSegsByGidVar(gidA, minCoords);
    const sMax = font.getGlyphSegsByGidVar(gidA, maxCoords);
    if (segsHash(sMin) === segsHash(sMax))
      fail(`T3 'A' min/max identical — variation pipeline ineffective`);
    else ok(`T3 'A' at wght=${wghtAxis.min} vs ${wghtAxis.max} differs`);
  }
}

// ----- T4: bbox grows with weight (heavier glyph = wider strokes) -----
{
  const gidA = font.codepointToGlyphId(0x41);
  const wghtAxis = font.fvar.findAxis('wght');
  if (!wghtAxis) {
    ok('T4 skipped');
  } else {
    function bbox(segs) {
      let xmin = Infinity,
        ymin = Infinity,
        xmax = -Infinity,
        ymax = -Infinity;
      for (const seg of segs) {
        for (const p of [seg.p1, seg.p2, seg.p3, seg.p4]) {
          if (!p) continue;
          if (p[0] < xmin) xmin = p[0];
          if (p[0] > xmax) xmax = p[0];
          if (p[1] < ymin) ymin = p[1];
          if (p[1] > ymax) ymax = p[1];
        }
      }
      return [xmin, ymin, xmax, ymax];
    }
    const defCoords = font.fvar.defaultCoords();
    const maxCoords = defCoords.slice();
    for (let i = 0; i < font.fvar.axes.length; i++)
      if (font.fvar.axes[i].tag === 'wght') maxCoords[i] = wghtAxis.max;
    const bDef = bbox(font.getGlyphSegsByGidVar(gidA, defCoords));
    const bMax = bbox(font.getGlyphSegsByGidVar(gidA, maxCoords));
    // 'A' bbox: heavier weight should have similar X extent (the letter
    // doesn't get wider as much as it gets thicker — internal counter
    // shrinks). Width may stay similar; verify ANY dimension changed.
    const wDef = bDef[2] - bDef[0],
      wMax = bMax[2] - bMax[0];
    const hDef = bDef[3] - bDef[1],
      hMax = bMax[3] - bMax[1];
    if (Math.abs(wDef - wMax) < 0.5 && Math.abs(hDef - hMax) < 0.5)
      fail(
        `T4 'A' bbox identical: wgt=400 (${wDef.toFixed(1)}×${hDef.toFixed(1)}) vs 1000 (${wMax.toFixed(1)}×${hMax.toFixed(1)})`,
      );
    else
      ok(
        `T4 'A' bbox changes: wgt=400→(${wDef.toFixed(1)}×${hDef.toFixed(1)}) wgt=1000→(${wMax.toFixed(1)}×${hMax.toFixed(1)})`,
      );
  }
}

console.log();
console.log(failures === 0 ? 'GVAR-READER PASS' : `GVAR-READER FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
