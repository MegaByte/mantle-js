// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// markupSpacingSmoke.mjs — spacing fields must survive markup parsing.
//
// parseMarkup rebuilds each span's style from its tag stacks, so any field
// without a stack is dropped unless it is carried from the base style.
// `wspaceEm` has no stack: it is READ by textLayout's word-separator advance
// and SET by buildSvgTextGlyphs' styleOpts.wordSpacingEm, so without the carry
// word spacing works on the SVG <text> path and silently vanishes on the markup one.
//
// GL-free (fast node lane).

import { parseMarkup, defaultStyle } from '../src/font/markupParser.js';

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

// ---- T1: base spacing survives plain markup ---------------------------
{
  const base = { ...defaultStyle(), wspaceEm: 0.25, cspaceEm: 0.1, mspaceEm: 0.05 };
  const spans = parseMarkup('hello world', base);
  const bad = spans.filter((s) => s.style && s.style.wspaceEm !== 0.25);
  if (spans.length && !bad.length) ok(`T1 wspaceEm carried to all ${spans.length} span(s)`);
  else fail(`T1 wspaceEm lost: ${JSON.stringify(spans.map((s) => s.style && s.style.wspaceEm))}`);
}

// ---- T2: and across a nested tag, where the style is rebuilt ----------
// <b> pushes a stack and flushes a new span — the rebuild path that dropped it.
{
  const base = { ...defaultStyle(), wspaceEm: 0.4 };
  const spans = parseMarkup('a <b>bold</b> c', base);
  const styled = spans.filter((s) => s.style);
  const bad = styled.filter((s) => s.style.wspaceEm !== 0.4);
  if (styled.length > 1 && !bad.length)
    ok(`T2 wspaceEm survives tag nesting (${styled.length} spans)`);
  else fail(`T2 wspaceEm lost across tags: ${JSON.stringify(styled.map((s) => s.style.wspaceEm))}`);
}

// ---- T3: the sibling fields that DO have stacks still work ------------
{
  const base = { ...defaultStyle(), cspaceEm: 0.1 };
  const spans = parseMarkup('x<cspace=0.5>y</cspace>z', base);
  const vals = spans.filter((s) => s.style).map((s) => s.style.cspaceEm);
  if (vals.includes(0.5) && vals.includes(0.1))
    ok(`T3 <cspace> still pushes/pops (${JSON.stringify(vals)})`);
  else fail(`T3 <cspace> stack broken: ${JSON.stringify(vals)}`);
}

console.log();
console.log(failures === 0 ? 'MARKUP-SPACING PASS' : `MARKUP-SPACING FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
