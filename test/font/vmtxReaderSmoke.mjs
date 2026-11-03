// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// vmtxReaderSmoke.mjs — verifies the vhea/vmtx reader exposes per-gid
// vertical advance + topSideBearing for CJK fonts that ship vertical
// metrics, and that getVerticalOriginY composes VORG/vmtx/fallback.

import { readFileSync, existsSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// ----- T1: Horizontal-only font (Arial) reports hasVerticalMetrics
// false but vertical accessors return sensible fallbacks --------------
{
  const arialPath = '/System/Library/Fonts/Supplemental/Arial.ttf';
  if (existsSync(arialPath)) {
    const font = new MantleFontAsset(new Uint8Array(readFileSync(arialPath)));
    font.getMetrics(0x41);
    if (font.hasVerticalMetrics) {
      fail('T1 Arial unexpectedly has vmtx');
    } else {
      const aGid = font._tables.codepointToGlyphIndex(0x41);
      const vm = font.getVerticalMetricsByGid(aGid);
      // Fallback advance should be 1.0 em.
      if (Math.abs(vm.advanceHeight - 1.0) > 1e-9)
        fail(`T1 Arial fallback advanceHeight expected 1.0em, got ${vm.advanceHeight}`);
      else ok('T1 Arial (no vmtx) returns 1.0em fallback advance');
    }
  } else console.log('Skip T1: Arial not found');
}

// ----- T2: Hiragino Sans GB (CJK) ships vmtx; ideograph metrics ----
{
  const hgPath = '/System/Library/Fonts/Hiragino Sans GB.ttc';
  if (!existsSync(hgPath)) {
    console.log('Skip T2-T4: Hiragino Sans GB not found');
    if (failures > 0) {
      console.error(`\nVMTX-READER FAIL (${failures})`);
      process.exit(1);
    }
    console.log('\nVMTX-READER PASS');
    process.exit(0);
  }
  const font = new MantleFontAsset(new Uint8Array(readFileSync(hgPath)));
  font.getMetrics(0x4e00);
  if (!font.hasVerticalMetrics) fail('T2 Hiragino Sans GB should report hasVerticalMetrics=true');
  else ok('T2 Hiragino Sans GB exposes vmtx');

  // T3: ideograph 一 (U+4E00) — should have advance ~1em.
  const yiGid = font._tables.codepointToGlyphIndex(0x4e00);
  const vm = font.getVerticalMetricsByGid(yiGid);
  if (Math.abs(vm.advanceHeight - 1.0) > 0.01)
    fail(`T3 一 advanceHeight expected ~1.0em, got ${vm.advanceHeight.toFixed(3)}`);
  else
    ok(
      `T3 一 advanceHeight=${vm.advanceHeight.toFixed(3)}em, topSideBearing=${vm.topSideBearing.toFixed(3)}em`,
    );

  // T4: vhea ascender/descender ranges.
  if (font.vertTypoAscender <= 0 || font.vertTypoDescender >= 0)
    fail(
      `T4 vhea metrics out of range: asc=${font.vertTypoAscender}, desc=${font.vertTypoDescender}`,
    );
  else
    ok(
      `T4 vhea metrics: ascender=${font.vertTypoAscender}em, descender=${font.vertTypoDescender}em`,
    );
}

// ----- T5: getVerticalOriginY composes VORG + vmtx + fallback ------
{
  const hgPath = '/System/Library/Fonts/Hiragino Sans GB.ttc';
  if (existsSync(hgPath)) {
    const font = new MantleFontAsset(new Uint8Array(readFileSync(hgPath)));
    font.getMetrics(0x4e00);
    const yiGid = font._tables.codepointToGlyphIndex(0x4e00);
    const originY = font.getVerticalOriginY(yiGid);
    // Hiragino Sans GB ships VORG (defaultVertOriginY=880fu = 0.88em);
    // VORG takes precedence over vmtx-derived. The test asserts a
    // positive value in the [0, 1em] range.
    if (originY <= 0 || originY > 1.2)
      fail(`T5 一 verticalOriginY ${originY.toFixed(3)} out of plausible range`);
    else ok(`T5 一 verticalOriginY = ${originY.toFixed(3)}em (VORG precedence)`);
  }
}

// ----- T6: fallback for fonts with neither VORG nor vmtx -----------
{
  const arialPath = '/System/Library/Fonts/Supplemental/Arial.ttf';
  if (existsSync(arialPath)) {
    const font = new MantleFontAsset(new Uint8Array(readFileSync(arialPath)));
    font.getMetrics(0x41);
    const aGid = font._tables.codepointToGlyphIndex(0x41);
    const originY = font.getVerticalOriginY(aGid);
    // Should be 0.5em (half em-box) or vhea-ascender if any.
    if (originY <= 0 || originY > 1.5)
      fail(`T6 Arial 'A' verticalOriginY ${originY.toFixed(3)} out of range`);
    else ok(`T6 Arial 'A' verticalOriginY = ${originY.toFixed(3)}em (fallback)`);
  }
}

if (failures > 0) {
  console.error(`\nVMTX-READER FAIL (${failures})`);
  process.exit(1);
}
console.log('\nVMTX-READER PASS');
