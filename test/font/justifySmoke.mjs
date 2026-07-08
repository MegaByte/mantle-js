// justifySmoke.mjs — verifies word-spacing justification on wrapped
// multi-line runs. We assert:
//   T1 plain left-align: penX progression matches natural advances
//   T2 justify: non-last line's last slot ends at usableMax (= no slack)
//   T3 justify: last line keeps natural advances (text-align-last:auto)
//   T4 justify: distribution is EVEN across space slots
//   T5 justify with text-align-last:'justify' justifies the last line too

import { readFileSync, existsSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { _layoutSlotsForTest } from '../../src/font/textRun.js';
import { defaultStyle } from '../../src/font/markupParser.js';

let failures = 0;
const fail = (msg) => { console.error('FAIL', msg); failures++; };
const ok   = (msg) => console.log('ok', msg);

const arialPath = '/System/Library/Fonts/Supplemental/Arial.ttf';
if (!existsSync(arialPath)) {
  console.log('Skip justify smoke: Arial not found');
  process.exit(0);
}
const font = new MantleFontAsset(new Uint8Array(readFileSync(arialPath)));
font.getMetrics(0x20);

// Long enough to wrap into multiple lines at typical maxWidth.
const text = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen';
const baseStyle = defaultStyle();

// Width that should force several lines. Em-space numbers.
const maxWidth = 10;

// ---- T1: left-align baseline ------------------------------------
{
  const slots = _layoutSlotsForTest([{ text, style: baseStyle }], font,
    { maxWidthEm: maxWidth, align: 'left' });
  if (!slots.length) fail('T1 no slots');
  else {
    // Each line's last slot should have penX + advance ≤ maxWidth.
    // Group by line via penY.
    const lines = groupByLine(slots);
    let any = false;
    for (const line of lines) {
      const last = line[line.length - 1];
      const end = last.penX + last.advance;
      if (end > maxWidth + 1e-6) fail(`T1 line ends past maxWidth: ${end}`);
      any = true;
    }
    if (any) ok(`T1 left-align: ${lines.length} lines, all within maxWidth`);
  }
}

// ---- T2: justify — non-last line ends at maxWidth ---------------
{
  const slots = _layoutSlotsForTest([{ text, style: baseStyle }], font,
    { maxWidthEm: maxWidth, align: 'justify' });
  const lines = groupByLine(slots);
  if (lines.length < 2) fail('T2 expected ≥2 lines');
  else {
    let pass = true;
    for (let li = 0; li < lines.length - 1; li++) {
      const last = lines[li][lines[li].length - 1];
      const end = last.penX + last.advance;
      // Justification should bring the line END close to maxWidth.
      // Allow small slack when the line has only 1 word (no spaces
      // to expand).
      const hasSpace = lines[li].some(s => s.breakKind === 1);
      if (hasSpace && Math.abs(end - maxWidth) > 0.05) {
        fail(`T2 line ${li} end=${end.toFixed(3)} maxWidth=${maxWidth}`);
        pass = false; break;
      }
    }
    if (pass) ok(`T2 justify: ${lines.length - 1} non-last line(s) end at maxWidth`);
  }
}

// ---- T3: justify — LAST line keeps natural advances -------------
{
  const slots = _layoutSlotsForTest([{ text, style: baseStyle }], font,
    { maxWidthEm: maxWidth, align: 'justify' });
  const lines = groupByLine(slots);
  const lastLine = lines[lines.length - 1];
  // Sum of advances + last.penX should NOT equal maxWidth (unless
  // last line happens to be naturally full).
  const last = lastLine[lastLine.length - 1];
  const end = last.penX + last.advance;
  if (end > maxWidth) fail(`T3 last line overshoots: end=${end}`);
  // We can't strictly assert end < maxWidth because the last line
  // might be naturally full by chance. Confirm by comparing to
  // left-aligned layout: penX positions should match.
  const leftSlots = _layoutSlotsForTest([{ text, style: baseStyle }], font,
    { maxWidthEm: maxWidth, align: 'left' });
  const leftLines = groupByLine(leftSlots);
  const leftLastLine = leftLines[leftLines.length - 1];
  let matches = true;
  for (let i = 0; i < lastLine.length && i < leftLastLine.length; i++) {
    if (Math.abs(lastLine[i].penX - leftLastLine[i].penX) > 1e-6) {
      matches = false; break;
    }
  }
  if (!matches) fail('T3 last line penX differs from left-align (should be identical)');
  else ok('T3 justify: last line matches left-align (text-align-last:auto)');
}

// ---- T4: justify — slack distributed EVENLY across spaces -------
{
  const slots = _layoutSlotsForTest([{ text, style: baseStyle }], font,
    { maxWidthEm: maxWidth, align: 'justify' });
  const lines = groupByLine(slots);
  // For the first line: find consecutive space gaps and verify
  // they're all the same width (= natural space advance + perSpaceExtra).
  if (lines.length < 1) fail('T4 no lines');
  else {
    const line = lines[0];
    // Compute gap-after-space: for each breakKind=1 slot at index i,
    // gap = next.penX - (slot.penX + slot.advance). This is just the
    // extra justification, not the space's natural advance — but
    // there's no "extra" stored separately. The post-justify penX of
    // a slot AFTER a space differs from its pre-justify penX by the
    // extra. We can instead verify spaces have UNIFORM
    // (slot.advance + injected gap) by computing (next.penX - slot.penX).
    const gaps = [];
    for (let i = 0; i < line.length - 1; i++) {
      if (line[i].breakKind === 1) {
        gaps.push(line[i + 1].penX - line[i].penX);
      }
    }
    if (gaps.length < 2) {
      console.log('T4 SKIP: line had <2 spaces');
    } else {
      let allEq = true;
      const first = gaps[0];
      for (const g of gaps) if (Math.abs(g - first) > 1e-9) { allEq = false; break; }
      if (!allEq) fail(`T4 gaps unequal: ${gaps.map(g=>g.toFixed(4)).join(', ')}`);
      else ok(`T4 ${gaps.length} space gaps all equal at ${first.toFixed(4)}em`);
    }
  }
}

// ---- T5: lastLineAlign='justify' justifies the last line too ----
{
  const slots = _layoutSlotsForTest([{ text, style: baseStyle }], font,
    { maxWidthEm: maxWidth, align: 'justify', lastLineAlign: 'justify' });
  const lines = groupByLine(slots);
  const lastLine = lines[lines.length - 1];
  const last = lastLine[lastLine.length - 1];
  const end = last.penX + last.advance;
  const hasSpace = lastLine.some(s => s.breakKind === 1);
  if (hasSpace && Math.abs(end - maxWidth) > 0.05) {
    fail(`T5 lastLineAlign=justify last line should hit maxWidth: end=${end}`);
  } else ok('T5 lastLineAlign=justify justifies last line');
}

function groupByLine(slots) {
  const lines = [];
  let cur = [];
  let curY = null;
  for (const s of slots) {
    if (curY === null || Math.abs(s.penY - curY) < 1e-6) {
      cur.push(s); curY = s.penY;
    } else {
      lines.push(cur); cur = [s]; curY = s.penY;
    }
  }
  if (cur.length) lines.push(cur);
  return lines;
}

if (failures > 0) {
  console.error(`\nJUSTIFY FAIL (${failures})`);
  process.exit(1);
}
console.log('\nJUSTIFY PASS');
