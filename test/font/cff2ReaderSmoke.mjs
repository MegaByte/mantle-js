// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Verifies CFF2 (variable-flavor Adobe outlines) end-to-end against a
// synthesized fixture (_cff2FontFixture.mjs).

import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { registerCffReader } from '../../src/font/formats/cff.js';
import { buildCff2TestSfnt, buildPrivateVsindexFixtures } from './_cff2FontFixture.mjs';
registerCffReader();

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// ----- T1: static CFF2 (no blend) — fixture parses + glyph reads ----
{
  const bytes = buildCff2TestSfnt({ variable: false });
  const font = new MantleFontAsset(bytes);
  void font.name;
  const gid = font.codepointToGlyphId(0x41);
  if (gid === 0) fail('T1 codepoint did not map to gid');
  else {
    const segs = font.getGlyphSegsByGid(gid);
    if (!segs) fail('T1 segs null');
    else if (segs.length === 0) fail('T1 empty segs');
    else ok(`T1 static CFF2 'A' → ${segs.length} segs`);
  }
}

// ----- T2: outline bbox matches the synthesized triangle ------------
{
  // Default triangle (no blend) vertices:
  //   (200, 0), (250, 700), (300, 0)
  // After CFF clockwise→TT counter-clockwise reversal the points
  // are the same set; bbox should be (200..300, 0..700).
  const bytes = buildCff2TestSfnt({ variable: false });
  const font = new MantleFontAsset(bytes);
  const gid = font.codepointToGlyphId(0x41);
  const segs = font.getGlyphSegsByGid(gid);
  if (!segs) fail('T2 segs null');
  else {
    let xmin = Infinity,
      xmax = -Infinity,
      ymin = Infinity,
      ymax = -Infinity;
    for (const s of segs) {
      for (const p of [s.p1, s.p2, s.p3, s.p4]) {
        if (!p) continue;
        if (p[0] < xmin) xmin = p[0];
        if (p[0] > xmax) xmax = p[0];
        if (p[1] < ymin) ymin = p[1];
        if (p[1] > ymax) ymax = p[1];
      }
    }
    if (xmin !== 200 || xmax !== 300 || ymin !== 0 || ymax !== 700)
      fail(`T2 bbox (${xmin}, ${ymin}, ${xmax}, ${ymax}), expected (200, 0, 300, 700)`);
    else ok(`T2 triangle bbox: (200, 0) → (300, 700)`);
  }
}

// ----- T3: variable CFF2 — default coords match static --------------
{
  const bytesV = buildCff2TestSfnt({ variable: true });
  const bytesS = buildCff2TestSfnt({ variable: false });
  const fontV = new MantleFontAsset(bytesV);
  const fontS = new MantleFontAsset(bytesS);
  const gid = fontV.codepointToGlyphId(0x41);
  // Variable, but we read at default coords (no varCoords supplied).
  const segsV = fontV.getGlyphSegsByGid(gid);
  const segsS = fontS.getGlyphSegsByGid(gid);
  if (!segsV || !segsS) fail(`T3 segs null (variable=${!!segsV} static=${!!segsS})`);
  else if (segsV.length !== segsS.length)
    fail(`T3 default-blend segs len differs from static (${segsV.length} vs ${segsS.length})`);
  else {
    let drift = 0;
    for (let i = 0; i < segsV.length; i++) {
      const a = segsV[i],
        b = segsS[i];
      for (const k of ['p1', 'p2', 'p3', 'p4']) {
        if (!a[k] || !b[k]) continue;
        if (Math.abs(a[k][0] - b[k][0]) > 1 || Math.abs(a[k][1] - b[k][1]) > 1) drift++;
      }
    }
    if (drift > 0) fail(`T3 default-blend drift: ${drift} point mismatches`);
    else ok(`T3 variable CFF2 at default coords matches static outline`);
  }
}

// ----- T4: variable CFF2 — at region peak, top vertex shifts --------
{
  // The fixture's variable charstring blends dx with delta=+250 at
  // region peak (normalized=1). So the top vertex x should shift
  // from 250 (default) to 250 + 250 = 500 at peak.
  //
  // The fixture has no fvar table (we synthesized only the CFF2
  // VarStore for unit-testing). To exercise blend we pass normalized
  // coords directly through the lower-level path.
  const bytes = buildCff2TestSfnt({ variable: true });
  const font = new MantleFontAsset(bytes);
  void font.name;
  const gid = font.codepointToGlyphId(0x41);
  // Use the glyphReader entry point with explicit normalized coords.
  // (font.getGlyphSegsByGidVar requires fvar which the fixture lacks.)
  const { readGlyph } = await import('../../src/font/glyphReader.js');
  font._ensure();
  const segsDef = readGlyph(font._tables, gid, null);
  const segsMax = readGlyph(font._tables, gid, [1.0]);
  if (!segsDef || !segsMax) fail('T4 segs null');
  else {
    function bbox(segs) {
      let xmin = Infinity,
        xmax = -Infinity;
      for (const s of segs)
        for (const p of [s.p1, s.p2, s.p3, s.p4]) {
          if (p && p[0] < xmin) xmin = p[0];
          if (p && p[0] > xmax) xmax = p[0];
        }
      return [xmin, xmax];
    }
    const [, xmaxDef] = bbox(segsDef);
    const [, xmaxMax] = bbox(segsMax);
    // Default xmax = 300 (right vertex). At blend peak the right
    // vertex stays at 300, but the TOP vertex moves to x=500 — so
    // overall xmax should grow to 500.
    if (xmaxDef !== 300 || xmaxMax < 499 || xmaxMax > 501)
      fail(`T4 blend xmax: default ${xmaxDef} (expect 300), peak ${xmaxMax} (expect ≈500)`);
    else ok(`T4 blend at peak: top vertex x morphs default 250 → peak ${xmaxMax}`);
  }
}

// Private DICT vsindex supplies the default; a CharString may override it.
{
  const { autoRegisterForFont } = await import('../../src/font/auto.js');
  const { pathBbox } = await import('../../src/svg/bbox.js');
  for (const [index, bytes] of buildPrivateVsindexFixtures().entries()) {
    await autoRegisterForFont(bytes);
    const font = new MantleFontAsset(bytes);
    for (const coord of [-1, 0, 1]) {
      const shifted = index === 0 ? coord === -1 : coord === 1;
      const expected = shifted ? [14, 28, 114, 88] : [10, 20, 110, 80];
      const actual = pathBbox(font.getGlyphSegsByGidVar(1, [coord]));
      if (actual.some((v, i) => !Number.isFinite(v) || Math.abs(v - expected[i]) > 1e-9))
        fail(`private variation ${index} at ${coord}: ${actual}`);
    }
  }
}

console.log();
console.log(failures === 0 ? 'CFF2-READER PASS' : `CFF2-READER FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
