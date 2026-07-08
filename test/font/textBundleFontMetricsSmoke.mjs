// Text font-metrics API.
//
// Verifies:
//   1. MantleFontAsset.capHeight + xHeight + emHeight populated from
//      OS/2 sCapHeight + sxHeight (with H/x glyph-measurement fallback).
//   2. fontAsset.fontMetrics() returns a metrics packet with positive
//      `descent` (the raw .descent field is negative).
//   3. createTextBundle exposes `fontMetrics` + `runMetrics` on the
//      handle.
//   4. 'BLACK' vs 'YELLOW' have IDENTICAL fontMetrics.emHeight and
//      IDENTICAL runMetrics.typoBBox.h, but their ink-tight globalBBox
//      heights DIFFER ('YELLOW' has the 'Y' descender, 'BLACK' doesn't).
//      Layout against typoBBox produces consistent on-screen heights;
//      layout against globalBBox makes 'BLACK' float up.
//   5. fontMetrics is stable across setText.
//   6. runMetrics refreshes on setText (lastLineAdvance changes when
//      the text changes; lineCount tracks).

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { createTextBundle } from '../../src/textBundle.js';

let failures = 0;
const ok   = (msg) => console.log('ok', msg);
const fail = (msg) => { failures++; console.error('FAIL', msg); };
const approxEq = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

// Stub GL — textBundle creates textures but doesn't render in this test.
function makeFakeGL() {
  const fake = {
    TEXTURE_2D: 1, RGBA: 2, FLOAT: 3, UNSIGNED_BYTE: 4, RGBA32F: 5, RGBA8: 6,
    TEXTURE_MIN_FILTER: 6, TEXTURE_MAG_FILTER: 7, TEXTURE_WRAP_S: 8, TEXTURE_WRAP_T: 9,
    NEAREST: 10, CLAMP_TO_EDGE: 11, LINEAR: 12,
    bindTexture() {}, texImage2D() {}, texParameteri() {}, texSubImage2D() {},
    createTexture() { return {}; }, deleteTexture() {}, pixelStorei() {},
    activeTexture() {}, useProgram() {},
    uniform1i() {}, uniform1f() {}, uniform2f() {}, uniform4f() {},
    bindFramebuffer() {}, deleteFramebuffer() {}, createFramebuffer() { return {}; },
    framebufferTexture2D() {}, checkFramebufferStatus() { return 0x8CD5; },
    FRAMEBUFFER: 0, FRAMEBUFFER_COMPLETE: 0x8CD5, COLOR_ATTACHMENT0: 0,
  };
  return fake;
}

const FONT_PATH = '/System/Library/Fonts/Supplemental/Arial.ttf';
const font = new MantleFontAsset(new Uint8Array(readFileSync(FONT_PATH)));
// Force _ensure() so the metric fields are populated.
void font.name;

// T1: capHeight / xHeight populated.
{
  if (!(font.capHeight > 0.5 && font.capHeight < 0.9))
    fail(`T1 capHeight out of plausible range: ${font.capHeight}`);
  else ok(`T1 capHeight = ${font.capHeight.toFixed(4)} em`);
  if (!(font.xHeight > 0.3 && font.xHeight < 0.7))
    fail(`T1 xHeight out of plausible range: ${font.xHeight}`);
  else ok(`T1 xHeight = ${font.xHeight.toFixed(4)} em`);
}

// T2: fontAsset.fontMetrics() packet.
{
  const fm = font.fontMetrics();
  if (!fm || !(fm.ascent > 0))
    fail(`T2 fontMetrics ascent should be positive: ${JSON.stringify(fm)}`);
  else if (!(fm.descent > 0))
    fail(`T2 fontMetrics descent should be positive (positive distance below baseline): ${fm.descent}`);
  else if (!approxEq(fm.emHeight, fm.ascent + fm.descent))
    fail(`T2 emHeight should equal ascent + descent: ${fm.emHeight} vs ${fm.ascent + fm.descent}`);
  else ok(`T2 fontMetrics ascent=${fm.ascent.toFixed(4)} descent=${fm.descent.toFixed(4)} emHeight=${fm.emHeight.toFixed(4)}`);
}

// T3: createTextBundle exposes fontMetrics + runMetrics.
const gl = makeFakeGL();
const tbBlack  = await createTextBundle(gl, { font, text: 'BLACK',  style: { fontSizePx: 1 } });
const tbYellow = await createTextBundle(gl, { font, text: 'YELLOW', style: { fontSizePx: 1 } });

{
  if (!tbBlack.fontMetrics) fail('T3 tbBlack.fontMetrics missing');
  else if (!tbBlack.runMetrics) fail('T3 tbBlack.runMetrics missing');
  else if (!tbYellow.fontMetrics) fail('T3 tbYellow.fontMetrics missing');
  else if (!tbYellow.runMetrics) fail('T3 tbYellow.runMetrics missing');
  else ok('T3 fontMetrics + runMetrics present on both handles');
}

// T4: BLACK vs YELLOW — IDENTICAL emHeight + typoBBox.h, DIFFERENT
// globalBBox.h (descender vs no descender).
{
  const fmB = tbBlack.fontMetrics, fmY = tbYellow.fontMetrics;
  if (!approxEq(fmB.emHeight, fmY.emHeight))
    fail(`T4 emHeight diverges: BLACK=${fmB.emHeight} YELLOW=${fmY.emHeight}`);
  else ok(`T4 emHeight identical across strings: ${fmB.emHeight.toFixed(4)}`);

  const rmB = tbBlack.runMetrics, rmY = tbYellow.runMetrics;
  if (!approxEq(rmB.typoBBox[3], rmY.typoBBox[3]))
    fail(`T4 typoBBox.h diverges: BLACK=${rmB.typoBBox[3]} YELLOW=${rmY.typoBBox[3]}`);
  else ok(`T4 typoBBox.h identical across strings: ${rmB.typoBBox[3].toFixed(4)}`);

  const inkB = tbBlack.bundle.globalBBox[3];
  const inkY = tbYellow.bundle.globalBBox[3];
  if (approxEq(inkB, inkY))
    fail(`T4 globalBBox.h SHOULD differ (Y has descender, BLACK doesn't): BLACK=${inkB} YELLOW=${inkY}`);
  else if (!(inkY > inkB))
    fail(`T4 YELLOW ink should be TALLER than BLACK (Y descender): BLACK=${inkB} YELLOW=${inkY}`);
  else ok(`T4 globalBBox.h differs as expected: BLACK=${inkB.toFixed(4)} (cap only) YELLOW=${inkY.toFixed(4)} (cap + descent)`);
}

// T5: fontMetrics stable across setText.
{
  const before = tbBlack.fontMetrics;
  await tbBlack.setText('Resume');
  const after = tbBlack.fontMetrics;
  if (!approxEq(before.emHeight, after.emHeight))
    fail(`T5 fontMetrics drifted across setText: before=${before.emHeight} after=${after.emHeight}`);
  else ok(`T5 fontMetrics.emHeight stable across setText (${after.emHeight.toFixed(4)})`);
}

// T6: runMetrics refreshes on setText (lastLineAdvance changes, lineCount
// tracks). 'Resume' has different advance than 'BLACK'.
{
  const rm1 = tbBlack.runMetrics;   // currently shows 'Resume'
  await tbBlack.setText('BLACK');
  const rm2 = tbBlack.runMetrics;
  if (approxEq(rm1.lastLineAdvance, rm2.lastLineAdvance))
    fail(`T6 lastLineAdvance should differ between 'Resume' and 'BLACK': ${rm1.lastLineAdvance} vs ${rm2.lastLineAdvance}`);
  else ok(`T6 runMetrics.lastLineAdvance refreshes: Resume=${rm1.lastLineAdvance.toFixed(4)} BLACK=${rm2.lastLineAdvance.toFixed(4)}`);
  if (rm2.lineCount !== 1)
    fail(`T6 single-line run should have lineCount=1, got ${rm2.lineCount}`);
  else ok(`T6 single-line lineCount = 1`);
}

// T7: Empty run still reports fontMetrics + a single-line runMetrics
// fallback (so layout doesn't divide-by-zero).
{
  const tbEmpty = await createTextBundle(gl, { font, text: '', style: { fontSizePx: 1 } });
  if (!tbEmpty.fontMetrics)
    fail('T7 empty bundle should still expose fontMetrics');
  else if (!tbEmpty.runMetrics)
    fail('T7 empty bundle should still expose runMetrics (1-line typoBBox fallback)');
  else if (tbEmpty.runMetrics.lineCount !== 1)
    fail(`T7 empty bundle lineCount should be 1, got ${tbEmpty.runMetrics.lineCount}`);
  else ok(`T7 empty bundle reports fontMetrics + 1-line runMetrics`);
  tbEmpty.dispose();
}

// T8: ALL-CAPS no-descender 'BLACK' vs a string with both ascender and
// descender ('Hgpq'). 'Hgpq' rises to cap-line + descends past the
// baseline, so its ink is taller than 'BLACK' (cap height only, no
// descent). typoBBox is identical across all strings — pivoting layout
// on per-string globalBBox.h instead of fontMetrics centers them
// inconsistently.
{
  const tbFull = await createTextBundle(gl, { font, text: 'Hgpq', style: { fontSizePx: 1 } });
  const fmA = tbBlack.fontMetrics, fmB = tbFull.fontMetrics;
  if (!approxEq(fmA.emHeight, fmB.emHeight))
    fail(`T8 emHeight diverges between 'BLACK' and 'Hgpq': ${fmA.emHeight} vs ${fmB.emHeight}`);
  else ok(`T8 emHeight identical: ${fmA.emHeight.toFixed(4)}`);
  const inkBlack = tbBlack.bundle.globalBBox[3];
  const inkFull  = tbFull.bundle.globalBBox[3];
  // 'Hgpq' has 'H' to the cap-line + 'g'/'p'/'q' descenders below
  // the baseline. Expected ink ≈ capHeight + descent ≈ ~0.93 em on
  // Arial vs 'BLACK'-only ~0.72 em (cap only). Ratio ≈ 1.28.
  const ratio = inkFull / Math.max(inkBlack, 1e-9);
  if (!(ratio > 1.15))
    fail(`T8 'Hgpq' ink should be ≥ 1.15× 'BLACK' ink (descender extends past baseline): BLACK=${inkBlack} Hgpq=${inkFull} ratio=${ratio.toFixed(3)}`);
  else ok(`T8 'Hgpq' ink visibly taller: BLACK=${inkBlack.toFixed(4)} Hgpq=${inkFull.toFixed(4)} ratio=${ratio.toFixed(3)}`);
  tbFull.dispose();
}

tbBlack.dispose();
tbYellow.dispose();

console.log();
console.log(failures === 0 ? 'TEXT-BUNDLE FONT-METRICS PASS' : `TEXT-BUNDLE FONT-METRICS FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
