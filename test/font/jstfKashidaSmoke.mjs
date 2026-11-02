// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// jstfKashidaSmoke.mjs — JSTF Arabic kashida justification.
//
// Arial ships a JSTF table whose 'arab' script lists kashida (tatweel)
// extender glyphs. When an Arabic line is justified, the layout inserts
// those connectors at cursive joins to fill slack, instead of only
// stretching spaces. We assert the extenders are exposed and that a
// justified Arabic line emits tatweel (U+0640) glyphs a left-aligned one
// does not. Uses Arial (CI-portable).

import { readFileSync, existsSync } from 'fs';
import { MantleFontAsset, buildStyled } from '../../src/font/index.js';
import { defaultStyle } from '../../src/font/markupParser.js';

const p = '/System/Library/Fonts/Supplemental/Arial.ttf';
if (!existsSync(p)) {
  console.log('Skip jstf: no Arial');
  process.exit(0);
}

let failures = 0;
const fail = (m) => {
  console.error('FAIL', m);
  failures++;
};
const ok = (m) => console.log('ok', m);

const font = new MantleFontAsset(new Uint8Array(readFileSync(p)));

// ---- T1: Arabic extender glyphs exposed; Latin has none ----
const arab = font.jstf.getExtenderGlyphs('arab');
if (!font.jstf.hasJstf) fail('T1 Arial should have JSTF');
else if (!arab || arab.length === 0) fail('T1 arab extenders missing');
else if (font.jstf.getExtenderGlyphs('latn')) fail('T1 latn should have no extenders');
else ok(`T1 arab kashida extenders: [${arab}]`);

// ---- T2: justified Arabic inserts kashida (U+0640); left-aligned doesn't ----
const text = 'العربية الخط العربي المتصل الحروف تتصل ببعضها';
const style = { ...defaultStyle(), color: [0, 0, 0, 1] };
const kashidaCount = async (align) => {
  const b = await buildStyled([{ text, style }], font, {
    maxWidthEm: 12,
    align,
    lastLineAlign: 'justify',
  });
  return (b.shapeIds || []).filter((s) => s.includes('u0640')).length;
};
const left = await kashidaCount('left');
const justified = await kashidaCount('justify');
if (left !== 0) fail(`T2 left-aligned should insert no kashida, got ${left}`);
else if (justified <= 0) fail('T2 justified Arabic should insert kashida connectors');
else ok(`T2 justify inserts ${justified} kashida; left-align inserts 0`);

{
  const { planKashida } = await import('../../src/font/textBreak.js');
  const fontA = {
    jstf: { getExtenderGlyphs: () => [3] },
    getMetricsByGid: () => ({ advance: 0.4 }),
  };
  const fontB = {
    jstf: { getExtenderGlyphs: () => [7] },
    getMetricsByGid: () => ({ advance: 0.2 }),
  };
  for (const scale of [0.25, 0.5, 1, 2, 4]) {
    const slots = Array.from({ length: 3 }, () => ({
      font: fontA,
      glyphId: 1,
      codepoint: 0x628,
      style: { sizeScale: scale, widthScale: 1 },
    }));
    const plan = planKashida(slots, 0.95),
      expected = Math.floor(0.95 / (0.4 * scale));
    if ((plan?.total || 0) !== expected || (plan?.usedAdvance || 0) > 0.95)
      fail('scaled extender budget ' + scale);
  }
  const variable = {
    isVariable: true,
    jstf: { getExtenderGlyphs: () => [3, 7] },
    getMetricsByGid: (gid) => ({ advance: gid === 3 ? 0.4 : 0.6 }),
    getGlyphAdvanceVar: (gid, coords) => (gid === 3 ? 0.4 + 0.4 * coords[0] : 0.6),
  };
  const variableSlots = Array.from({ length: 2 }, () => ({
    font: variable,
    glyphId: 1,
    codepoint: 0x628,
    style: { sizeScale: 1, widthScale: 1 },
  }));
  for (const coord of [0, 1]) {
    const result = planKashida(variableSlots, 1, [coord]);
    if (
      result?.insertions.get(0).gid !== (coord === 0 ? 7 : 3) ||
      Math.abs(result.insertions.get(0).advEm - (coord === 0 ? 0.6 : 0.8)) > 1e-6
    )
      fail('variable widest extender and budget ' + coord);
  }
  const slots = [fontA, fontA, fontB, fontB].map((font) => ({
    font,
    glyphId: 1,
    codepoint: 0x628,
    style: { sizeScale: 1, widthScale: 1 },
  }));
  const plan = planKashida(slots, 0.95);
  if (
    !plan ||
    plan.insertions.get(0).font !== fontA ||
    plan.insertions.get(2).font !== fontB ||
    plan.insertions.get(0).gid !== 3 ||
    plan.insertions.get(2).gid !== 7 ||
    plan.usedAdvance > 0.95
  )
    fail('mixed-font joins retain their font and slack budget');
}

console.log(failures ? `\nJSTF-KASHIDA FAIL (${failures})` : '\nJSTF-KASHIDA PASS');
process.exit(failures ? 1 : 0);
