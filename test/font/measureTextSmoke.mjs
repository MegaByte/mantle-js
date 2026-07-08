// measureTextSmoke.mjs — verifies MeasureText returns the same
// width as buildStyled's per-line max advance, without paying the
// curve/band/mesh cost.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { measureText, measureFromMarkup, buildFromMarkup, buildStyled } from '../../src/font/textRun.js';

const arial = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')));
arial.getMetrics(0x41);

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

// T1: empty input → all zeros, lineWidths == [].
{
  const m = measureText([], arial);
  if (m.lineCount !== 0) fail(`T1 empty lineCount=${m.lineCount}`);
  else if (m.width !== 0 || m.height !== 0) fail(`T1 empty size: ${m.width}x${m.height}`);
  else if (m.lineWidths.length !== 0) fail(`T1 empty lineWidths.length=${m.lineWidths.length}`);
  else ok('T1 empty input: width=0 height=0 lineCount=0');
}

// T2: single-line plain ASCII — width agrees with bundle's globalBBox xmax.
{
  const text = 'Hello, World!';
  const m = measureFromMarkup(text, arial);
  const b = await buildFromMarkup(text, arial);
  // Bundle's globalBBox is INK extent; measure is ADVANCE extent.
  // The two agree to within a few percent for body Latin (advance
  // is slightly wider — accounts for right side-bearing). Assert
  // measure.width >= bundle.bbox.width and within 10%.
  const bbWidth = b.globalBBox[2];
  if (m.width < bbWidth) fail(`T2 measure ${m.width} < ink-bbox ${bbWidth}`);
  else if (m.width > bbWidth * 1.10) fail(`T2 measure ${m.width} > 110% of ink ${bbWidth}`);
  else if (m.lineCount !== 1) fail(`T2 lineCount=${m.lineCount}`);
  else ok(`T2 single line: measure.width=${m.width.toFixed(3)} vs ink-bbox=${bbWidth.toFixed(3)}`);
}

// T3: multi-line wrap — lineCount matches.
{
  const text = 'The quick brown fox jumps over the lazy dog';
  const layout = { maxWidthEm: 8 };
  const m = measureFromMarkup(text, arial, layout);
  if (m.lineCount < 2) fail(`T3 expected wrap to multiple lines, got ${m.lineCount}`);
  // height = ascent + descent + (lineCount-1) * lineHeight.
  const expectedH = m.ascent + m.descent + (m.lineCount - 1) * m.lineHeight;
  if (Math.abs(m.height - expectedH) > 0.001) fail(`T3 height=${m.height} expected ${expectedH}`);
  else if (m.lineWidths.length !== m.lineCount) fail(`T3 lineWidths.length=${m.lineWidths.length} vs lineCount=${m.lineCount}`);
  else ok(`T3 wrap: ${m.lineCount} lines, height=${m.height.toFixed(3)}, lineWidths=[${m.lineWidths.map(x => x.toFixed(2)).join(', ')}]`);
}

// T4: explicit lineHeight override honored.
{
  const text = 'A\nB\nC';  // Note: \n likely doesn't break in plain text — use wrap.
  const layout = { lineHeightEm: 2.5, maxWidthEm: 0.5 };
  const m = measureFromMarkup('AAA AAA', arial, layout);
  if (m.lineHeight !== 2.5) fail(`T4 lineHeight=${m.lineHeight} expected 2.5`);
  else ok(`T4 lineHeight override: ${m.lineHeight} (lineCount=${m.lineCount})`);
}

// T5: ascent/descent come from font, not zero.
{
  const m = measureFromMarkup('X', arial);
  if (m.ascent <= 0) fail(`T5 ascent=${m.ascent} (expected positive)`);
  else if (m.descent <= 0) fail(`T5 descent=${m.descent} (expected positive)`);
  else ok(`T5 font metrics: ascent=${m.ascent.toFixed(3)} descent=${m.descent.toFixed(3)}`);
}

// T6: measure is cheaper than build. Wall-clock check, paragraph
// of ~500 chars. Threshold is loose to avoid CI flakiness.
{
  let text = '';
  for (let i = 0; i < 50; i++) text += 'The quick brown fox jumps. ';
  const layout = { maxWidthEm: 30 };

  // Warm up.
  measureFromMarkup(text, arial, layout);
  await buildFromMarkup(text, arial, [0,0,0,1], layout);

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) measureFromMarkup(text, arial, layout);
  const tMeas = Number(process.hrtime.bigint() - t0) / 5;

  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) await buildFromMarkup(text, arial, [0,0,0,1], layout);
  const tBuild = Number(process.hrtime.bigint() - t1) / 5;

  const ratio = tBuild / tMeas;
  if (ratio < 2) fail(`T6 measure not meaningfully cheaper: measure=${(tMeas/1e6).toFixed(2)}ms build=${(tBuild/1e6).toFixed(2)}ms ratio=${ratio.toFixed(2)}x`);
  else ok(`T6 cheaper than build: measure=${(tMeas/1e6).toFixed(2)}ms build=${(tBuild/1e6).toFixed(2)}ms (${ratio.toFixed(1)}x speedup)`);
}

console.log();
console.log(failures === 0 ? 'MEASURE-TEXT PASS' : `MEASURE-TEXT FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
