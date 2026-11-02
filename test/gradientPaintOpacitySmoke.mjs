// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Gradient paint metadata preserves element and inherited channel alpha.
// Shader contract assertions check modulation and premultiplication order.
import { readFileSync } from 'fs';
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import importSvg from '../src/svg/importer.js';
import { parseMetaBin } from '../src/core/metaBin.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const G =
  '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>';
/// [fill rgba, stroke rgba, fill grad id, stroke grad id] of every row.
async function rows(body) {
  const b = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${G}${body}</svg>`,
  );
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    F = pm.metaFloats,
    out = [];
  for (let s = 0; s < b.numShapes; s++) {
    const o = s * pm.floatsPerShape;
    out.push({
      fill: Array.from(F.slice(o + 4, o + 8)),
      stroke: Array.from(F.slice(o + 8, o + 12)),
      fg: F[o + 28],
      sg: F[o + 29],
    });
  }
  return out;
}
const near = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
const R = (attrs) => `<rect width="9" height="9" ${attrs}/>`;

for (const [body, want, what] of [
  [R('fill="url(#g)"'), 1, 'no opacity: unchanged'],
  [R('fill="url(#g)" fill-opacity="0.5"'), 0.5, 'its own fill-opacity'],
  [`<g fill-opacity="0.4">${R('fill="url(#g)"')}</g>`, 0.4, 'an inherited fill-opacity'],
  [R('fill="url(#g)" opacity="0.5"'), 0.5, 'its own opacity'],
  [R('fill="url(#g)" opacity="0.5" fill-opacity="0.5"'), 0.25, 'opacity x fill-opacity'],
]) {
  const r = (await rows(body)).find((x) => x.fg > 0);
  ok(
    !!r && near(r.fill, [1, 1, 1, want]),
    `gradient FILL, ${what}: paint (${r ? r.fill.map((v) => +v.toFixed(4)) : '-'}), want (1,1,1,${want})`,
  );
}
for (const [body, want, what] of [
  [R('fill="#0f0" stroke="url(#g)" stroke-width="2"'), 1, 'no opacity: unchanged'],
  [
    R('fill="#0f0" stroke="url(#g)" stroke-width="2" stroke-opacity="0.3"'),
    0.3,
    'its own stroke-opacity',
  ],
  [
    `<g stroke-opacity="0.3">${R('fill="#0f0" stroke="url(#g)" stroke-width="2"')}</g>`,
    0.3,
    'an inherited stroke-opacity',
  ],
]) {
  const r = (await rows(body)).find((x) => x.sg > 0);
  ok(
    !!r && near(r.stroke, [1, 1, 1, want]),
    `gradient STROKE, ${what}: paint (${r ? r.stroke.map((v) => +v.toFixed(4)) : '-'}), want (1,1,1,${want})`,
  );
}

// Stop opacity accepts percentages and percentage-valued CSS math.
for (const value of ['50%', 'calc(25% + 25%)']) {
  const defs = G.replace('stop-color="#f00"', 'stop-color="#f00" stop-opacity="' + value + '"');
  const b = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg">' + defs + R('fill="url(#g)"') + '</svg>',
  );
  const alpha = new Uint8Array(b.gradientStops)[3];
  ok(alpha === 128, 'stop opacity ' + value + ' packs alpha 128');
}

// The consumer: the main fill and stroke paths multiply the ramp by the row's paint, and premultiply
// after. If either ever stops, the alpha stored above stops reaching the pixel.
const FRAG = readFileSync(new URL('../src/shaders/mantle.frag.glsl', import.meta.url), 'utf8');
ok(
  /sampleGradient\(vFillGradId,[^;]*\)\s*\*\s*vFill/.test(FRAG),
  'mantle.frag.glsl: the fill ramp is multiplied by vFill',
);
ok(
  /sampleGradient\(vStrokeGradId,[^;]*\)\s*\*\s*vStroke/.test(FRAG),
  'mantle.frag.glsl: the stroke ramp is multiplied by vStroke',
);
ok(
  /vec4 color = vec4\(fillPaint\.rgb \* fillPaint\.a, fillPaint\.a\)/.test(FRAG),
  'mantle.frag.glsl: the fill paint is premultiplied after, so vFill is straight alpha',
);

const { gradientData, sampleGradientAt } = await import('../src/hitTest/paintSample.js');
for (const [tag, attrs] of [
  ['linearGradient', 'x1=".5" y1=".5" x2=".5" y2=".5"'],
  ['radialGradient', 'r="0"'],
]) {
  const section = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><${tag} id="g" ${attrs} spreadMethod="repeat"><stop stop-color="red"/><stop offset="1" stop-color="green"/><stop offset="1" stop-color="blue"/></${tag}></defs><rect width="64" height="64" fill="url(#g)"/></svg>`,
  );
  const sample = sampleGradientAt(gradientData(section), 1, 32, 32, [0, 0, 64, 64]);
  ok(
    near(sample, [0, 0, 1, 1]),
    `${tag}: zero extent selects the final duplicate stop without wrapping`,
  );
}
{
  const section = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><radialGradient id="g"><stop stop-color="white"/><stop offset="1" stop-color="white"/></radialGradient></defs><rect width="64" height="64" fill="url(#g)"/></svg>',
  );
  ok(
    near(sampleGradientAt(gradientData(section), 1, 32, 32, [0, 0, 64, 64]), [1, 1, 1, 1]),
    'an opaque radial gradient remains opaque at its focus',
  );
}

console.log(fail ? `gradientPaintOpacitySmoke FAIL (${fail})` : 'gradientPaintOpacitySmoke PASS');
process.exit(fail ? 1 : 0);
