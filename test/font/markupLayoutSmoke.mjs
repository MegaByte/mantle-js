// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Smoke: markup parsing + layout + assembly.
import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildTextRun, buildStyled, buildFromMarkup } from '../../src/font/textRun.js';
import { parseMarkup, defaultStyle } from '../../src/font/markupParser.js';

const font = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
);
let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};

// T1: parse spans
const spans = parseMarkup('Hello, <color=#f00>World</color>!', defaultStyle());
if (spans.length !== 3) fail(`T1 span count: ${spans.length}`);
if (spans[0]?.text !== 'Hello, ') fail(`T1 span0 text`);
if (spans[1]?.text !== 'World') fail(`T1 span1 text`);
if (spans[2]?.text !== '!') fail(`T1 span2 text`);
if (spans[0]?.style.color[0] !== 0) fail(`T1 span0 color`);
if (spans[1]?.style.color[0] !== 1) fail(`T1 span1 color (expect red)`);
if (spans[2]?.style.color[0] !== 0) fail(`T1 span2 color`);
console.log(`T1 parse: ${spans.length} spans, color pattern ok`);

// T2: markup → bundle and check per-glyph red flag
const richBundle = await buildFromMarkup('Hello, <color=#f00>World</color>!', font);
const plainBundle = await buildTextRun('Hello, World!', font);
if (richBundle.numShapes !== plainBundle.numShapes) fail(`T2 numShapes`);
const expectedReds = [
  false,
  false,
  false,
  false,
  false,
  false,
  true,
  true,
  true,
  true,
  true,
  false,
];
const stride = richBundle.metaFloatsPerShape;
for (let i = 0; i < richBundle.numShapes; i++) {
  const r = richBundle.metaFloats[i * stride + 4];
  const isRed = r > 0.5;
  if (isRed !== expectedReds[i]) fail(`T2.${i}: r=${r}, expected red=${expectedReds[i]}`);
}
console.log(`T2 markup → bundle: ${richBundle.numShapes} shapes, color pattern verified`);

// T3: wrap
const single = await buildTextRun('Hello World', font);
const wrapped = await buildFromMarkup('Hello World', font, [0, 0, 0, 1], {
  maxWidthEm: 3.5,
  align: 'left',
});
const singleH = single.globalBBox[3];
const wrapH = wrapped.globalBBox[3];
if (wrapH <= singleH + 0.5) fail(`T3 height: wrap=${wrapH} single=${singleH}`);
const wrapW = wrapped.globalBBox[2];
if (wrapW > 3.6) fail(`T3 width ${wrapW} > 3.5`);
console.log(
  `T3 wrap: single h=${singleH.toFixed(3)} w=${single.globalBBox[2].toFixed(3)}, wrapped h=${wrapH.toFixed(3)} w=${wrapW.toFixed(3)}`,
);

// T4: size
const sized = await buildStyled(
  [
    { text: 'X', style: { color: [0, 0, 0, 1], sizeScale: 1, voffsetEm: 0 } },
    { text: 'Y', style: { color: [0, 0, 0, 1], sizeScale: 0.5, voffsetEm: 0 } },
    { text: 'Z', style: { color: [0, 0, 0, 1], sizeScale: 1, voffsetEm: 0 } },
  ],
  font,
);
const widths = [];
for (let i = 0; i < sized.numShapes; i++) {
  widths.push(sized.metaFloats[i * stride + 2] - sized.metaFloats[i * stride + 0]);
}
if (widths[1] >= widths[0] * 0.9) fail(`T4 size: Y w=${widths[1]} not < X w=${widths[0]} * 0.9`);
console.log(
  `T4 size: X w=${widths[0].toFixed(3)}, Y w=${widths[1].toFixed(3)}, Z w=${widths[2].toFixed(3)}`,
);

console.log();
console.log(failures === 0 ? 'MARKUP-LAYOUT PASS' : `MARKUP-LAYOUT FAIL (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
