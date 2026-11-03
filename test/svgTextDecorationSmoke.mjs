// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svgTextDecorationSmoke.mjs — verify <text text-decoration="underline">
// emits a synthetic underline rect alongside the per-glyph shapes,
// and that the decoration inherits from a <g text-decoration=...>
// ancestor.
import { readFileSync } from 'fs';
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import importSvg from '../src/svg/importer.js';
import { MantleFontAsset } from '../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../src/font/textRun.js';

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

const arial = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
);

const STRIDE = 48;
const META_FLAGS = 27;
const FLAG_LAYER = 0x100;

function visibleShapeCount(s) {
  const mf = new Float32Array(s.meta, 32);
  let count = 0;
  for (let i = 0; i < s.numShapes; i++) {
    const flags = (mf[i * STRIDE + META_FLAGS] + 0.5) | 0;
    if ((flags & FLAG_LAYER) === 0) count++;
  }
  return count;
}

// ---- T1: direct text-decoration="underline" -----------------------
{
  const plain = readFileSync(
    new URL('../examples/smoke/svgTextDecoration__plain.svg', import.meta.url),
    'utf8',
  );
  const underlined = readFileSync(
    new URL('../examples/smoke/svgTextDecoration__underlined.svg', import.meta.url),
    'utf8',
  );
  const sP = await importSvg(plain, { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs });
  const sU = await importSvg(underlined, {
    fonts: { Arial: arial },
    svgTextLayout: buildSvgTextGlyphs,
  });
  const nP = visibleShapeCount(sP);
  const nU = visibleShapeCount(sU);
  // Same glyph count, plus one underline shape.
  if (nU === nP + 1) ok(`T1 direct underline adds 1 shape (${nP} → ${nU})`);
  else fail(`T1 direct: plain=${nP} underlined=${nU} (expected ${nP}+1)`);
}

// ---- T2: inherited from <g text-decoration=...> -------------------
{
  const inherited = readFileSync(
    new URL('../examples/smoke/svgTextDecoration__inherited.svg', import.meta.url),
    'utf8',
  );
  const s = await importSvg(inherited, {
    fonts: { Arial: arial },
    svgTextLayout: buildSvgTextGlyphs,
  });
  const n = visibleShapeCount(s);
  // 2 glyphs + 1 underline = 3.
  if (n >= 3) ok(`T2 <g text-decoration=underline> inherits to <text> (${n} visible shapes)`);
  else fail(`T2 inherited: ${n} shapes (expected ≥ 3)`);
}

// ---- T3: line-through stacks WITH underline ----------------------
{
  const both = readFileSync(
    new URL('../examples/smoke/svgTextDecoration__both.svg', import.meta.url),
    'utf8',
  );
  const s = await importSvg(both, { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs });
  const n = visibleShapeCount(s);
  // 2 glyphs + 2 decoration rects.
  if (n === 4) ok(`T3 underline+line-through stacks: 4 visible shapes`);
  else fail(`T3 both decorations: ${n} shapes (expected 4)`);
}

// ---- T4: text-decoration="none" suppresses (negative case) -------
{
  const noneOnGrandchild = readFileSync(
    new URL('../examples/smoke/svgTextDecoration__noneOnGrandchild.svg', import.meta.url),
    'utf8',
  );
  const s = await importSvg(noneOnGrandchild, {
    fonts: { Arial: arial },
    svgTextLayout: buildSvgTextGlyphs,
  });
  const n = visibleShapeCount(s);
  // 2 glyphs, no decoration.
  if (n === 2) ok(`T4 no text-decoration → no decoration shape`);
  else fail(`T4 plain: ${n} shapes (expected 2 glyphs)`);
}

console.log();
console.log(failures === 0 ? 'SVG-TEXT-DECORATION PASS' : `SVG-TEXT-DECORATION FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
