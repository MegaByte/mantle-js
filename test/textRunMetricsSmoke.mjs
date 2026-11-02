// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// textRunMetricsSmoke.mjs — the SUPPORTED text metrics surface.
//
// buildTextSections computes sections.runMetrics (surfaced verbatim as
// bundle.runMetrics / text-handle .runMetrics on both backends). Apps
// lay out labels against runMetrics.typoBBox + baselines, so its shape
// and semantics are contract:
//   • typoBBox = [0, firstBaselineY - ascent, width, span-to-descent]
//   • single line: typoBBox height == fontMetrics.emHeight,
//     firstBaselineY == lastBaselineY == baselineY
//   • multi-line (wrap): lineCount reflects layout, typoBBox spans all
//     baselines, height grows by lineHeight per extra line
//   • typoBBox height is STABLE across strings with/without descenders
//     (the whole point of preferring it over ink-tight globalBBox)
//   • layout-box mode (layoutWidthEm): typoBBox width == the box width
//   • empty run (makeEmptyBundle): zero-width single-line typoBBox at
//     the font's emHeight
//
// GL-free (runs in the fast node lane). Uses the Roboto fixture; skips
// gracefully when it hasn't been fetched.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../src/font/fontAsset.js';
import { buildTextSections, makeEmptyBundle } from '../src/font/textSections.js';
import { fontFixture, requireAsset } from './_assets.mjs';

const FIXTURE = fontFixture('roboto-regular.ttf');
requireAsset(FIXTURE);
const font = new MantleFontAsset(new Uint8Array(readFileSync(FIXTURE)));
const fm = font.fontMetrics();

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const near = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol;

const sectionsOf = async (text, style = {}) =>
  (await buildTextSections(font, text, style, false)).sections;

// ---- T1: field shape ------------------------------------------------
{
  const s = await sectionsOf('Hello');
  const rm = s.runMetrics;
  const shapeOk =
    rm &&
    Array.isArray(rm.typoBBox) &&
    rm.typoBBox.length === 4 &&
    typeof rm.firstBaselineY === 'number' &&
    typeof rm.lastBaselineY === 'number' &&
    typeof rm.baselineY === 'number' &&
    typeof rm.lineCount === 'number' &&
    typeof rm.lastLineAdvance === 'number';
  if (shapeOk)
    ok(
      'T1 runMetrics carries typoBBox/firstBaselineY/lastBaselineY/baselineY/lineCount/lastLineAdvance',
    );
  else fail(`T1 runMetrics shape: ${JSON.stringify(rm)}`);
}

// ---- T2: single line — typoBBox is the ascent-to-descent rect -------
{
  const s = await sectionsOf('Hello');
  const rm = s.runMetrics;
  const [tx, ty, , th] = rm.typoBBox;
  if (near(th, fm.emHeight, 1e-3))
    ok(`T2 single-line typoBBox height == emHeight (${th.toFixed(4)})`);
  else fail(`T2 typoBBox height ${th} != emHeight ${fm.emHeight}`);
  if (tx === 0) ok('T2 typoBBox xmin == 0 (bundle-local origin)');
  else fail(`T2 typoBBox xmin ${tx}`);
  if (near(ty, rm.firstBaselineY - fm.ascent, 1e-3))
    ok('T2 typoBBox top == firstBaselineY - ascent');
  else fail(`T2 typoBBox top ${ty} vs baseline ${rm.firstBaselineY} - ascent ${fm.ascent}`);
  if (rm.firstBaselineY === rm.lastBaselineY && rm.baselineY === rm.firstBaselineY)
    ok('T2 single line: firstBaselineY == lastBaselineY == baselineY');
  else fail('T2 baseline aliases diverge on a single line');
  if (rm.lineCount === 1) ok('T2 lineCount == 1');
  else fail(`T2 lineCount ${rm.lineCount}`);
}

// ---- T3: descender stability — 'goop' vs 'noon' ----------------------
{
  const a = (await sectionsOf('goop')).runMetrics; // descenders
  const b = (await sectionsOf('noon')).runMetrics; // none
  if (near(a.typoBBox[3], b.typoBBox[3], 1e-6))
    ok('T3 typoBBox height identical with and without descenders');
  else fail(`T3 typo heights diverge: ${a.typoBBox[3]} vs ${b.typoBBox[3]}`);
}

// ---- T4: multi-line wrap ---------------------------------------------
{
  const rm = (
    await sectionsOf('one two three four five six seven', { maxWidthEm: 4, lineHeightEm: 1.25 })
  ).runMetrics;
  if (rm.lineCount > 1) ok(`T4 wrap produced ${rm.lineCount} lines`);
  else fail(`T4 expected multi-line wrap, lineCount ${rm.lineCount}`);
  if (rm.lastBaselineY > rm.firstBaselineY) ok('T4 lastBaselineY below firstBaselineY');
  else fail(`T4 baselines: first ${rm.firstBaselineY}, last ${rm.lastBaselineY}`);
  const expectH = fm.emHeight + (rm.lineCount - 1) * 1.25;
  if (near(rm.typoBBox[3], expectH, 1e-3))
    ok(`T4 typoBBox height spans all baselines (${rm.typoBBox[3].toFixed(4)})`);
  else fail(`T4 typoBBox height ${rm.typoBBox[3]} != ${expectH}`);
}

// ---- T5: layout-box mode — typoBBox width is the box width -----------
{
  const rm = (await sectionsOf('Hi', { layoutWidthEm: 7, align: 'right' })).runMetrics;
  if (near(rm.typoBBox[2], 7, 1e-6)) ok('T5 layout-box mode: typoBBox width == layoutWidthEm');
  else fail(`T5 typoBBox width ${rm.typoBBox[2]} != 7`);
  if (near(rm.typoBBox[1], 0, 1e-4)) ok('T5 layout-box mode: typo top pinned to y=0');
  else fail(`T5 typo top ${rm.typoBBox[1]}`);
}

// ---- T6: empty run (makeEmptyBundle) ----------------------------------
{
  const rm = makeEmptyBundle(font).runMetrics;
  if (
    rm &&
    rm.typoBBox[2] === 0 &&
    near(rm.typoBBox[3], fm.emHeight, 1e-6) &&
    rm.lineCount === 1 &&
    near(rm.baselineY, fm.ascent, 1e-6)
  )
    ok('T6 empty run: zero-width single-line typoBBox at emHeight, baseline at ascent');
  else fail(`T6 empty runMetrics: ${JSON.stringify(rm)}`);
}

// ---- T7: lastLineAdvance is a positive pen advance --------------------
{
  const rm = (await sectionsOf('Hello')).runMetrics;
  if (rm.lastLineAdvance > 0) ok(`T7 lastLineAdvance ${rm.lastLineAdvance.toFixed(4)} > 0`);
  else fail(`T7 lastLineAdvance ${rm.lastLineAdvance}`);
}

// Empty logical lines retain baselines and zero last-line advance.
for (const text of ['a\n\na', '\na', 'a\n', 'a\n\n', '\n', '\n\n', '\na\n']) {
  const sections = await sectionsOf(text, { lineHeightEm: 1.4 });
  const rm = sections.runMetrics,
    count = text.split('\n').length;
  if (
    rm.lineCount !== count ||
    !near(rm.lastBaselineY - rm.firstBaselineY, (count - 1) * 1.4) ||
    !near(rm.typoBBox[3], fm.emHeight + (count - 1) * 1.4) ||
    (text.endsWith('\n') && rm.lastLineAdvance !== 0)
  )
    fail('empty logical line metrics ' + JSON.stringify(text) + ' ' + JSON.stringify(rm));
}

if (failures > 0) {
  console.error(`\nTEXT-RUN-METRICS FAIL (${failures})`);
  process.exit(1);
}
console.log('\nTEXT-RUN-METRICS PASS');
