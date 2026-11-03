// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// singularPaintTransformSmoke -- a gradientTransform or patternTransform with no inverse makes the paint server unusable.
// Chrome (on the Metal renderer) paints the url() FALLBACK color, else nothing, and so does the importer -- never the untransformed
// gradient or tile. Each cell asserts the rows the importer writes.
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
let failures = 0;
const check = (good, msg) => {
  console.log(`  ${good ? 'ok' : 'FAIL'} ${msg}`);
  if (!good) failures++;
};
const warn = console.warn;
console.warn = () => {};
const G = (attrs, tag = 'linearGradient') =>
  `<${tag} id="g" ${attrs}><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></${tag}>`;
const P = (attrs) =>
  `<pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse" ${attrs}><rect width="4" height="8" fill="#0a0"/><rect x="4" width="4" height="8" fill="#a0a"/></pattern>`;
/// { n: drawn shape rows, fill, stroke, grad (gradient id of the first drawn row), pattern: it carries a vector pattern }
async function rows(body) {
  const b = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`,
    { preserveViewport: true },
  );
  const st = b.metaFloatsPerShape,
    mf = parseMetaBin(b.meta, st).metaFloats,
    out = [];
  for (let r = 0; r < mf.length / st; r++) {
    const o = r * st,
      flags = Math.round(mf[o + 27]);
    if (flags & (64 | 128 | 256)) continue;
    out.push({
      fill: Array.from(mf.slice(o + 4, o + 8)).map((v) => +v.toFixed(2)),
      stroke: Array.from(mf.slice(o + 8, o + 12)).map((v) => +v.toFixed(2)),
      sw: mf[o + 12],
      grad: Math.round(mf[o + 28]),
      atlasW: mf[o + 43],
    });
  }
  return { n: out.length, rows: out, b };
}
const RECT = (paint, extra = '') =>
  `<rect x="8" y="8" width="48" height="48" fill="${paint}" ${extra}/>`;
const STROKE = (paint) =>
  `<rect x="12" y="12" width="40" height="40" fill="none" stroke="${paint}" stroke-width="10"/>`;
const LIME = [0, 1, 0, 1];
const same = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.01);

console.log('a singular gradientTransform paints the fallback, else nothing');
for (const gt of ['scale(0)', 'matrix(1 2 2 4 0 0)', 'scale(1 0)', 'matrix(0 0 0 0 5 5)']) {
  for (const tag of ['linearGradient', 'radialGradient']) {
    let r = await rows(`<defs>${G(`gradientTransform="${gt}"`, tag)}</defs>${RECT('url(#g)')}`);
    check(r.n === 0, `${tag} ${gt}: no paint, no row (${r.n} rows)`);
    r = await rows(`<defs>${G(`gradientTransform="${gt}"`, tag)}</defs>${RECT('url(#g) lime')}`);
    check(
      r.n === 1 && r.rows[0].grad === 0 && same(r.rows[0].fill, LIME),
      `${tag} ${gt} + fallback: the lime fallback (${JSON.stringify(r.rows[0]?.fill)})`,
    );
  }
}
{
  let r = await rows(`<defs>${G('gradientTransform="scale(0)"')}</defs>${STROKE('url(#g)')}`);
  check(
    r.n === 0 || r.rows.every((x) => x.sw === 0 || x.stroke[3] === 0),
    'a singular stroke gradient strokes nothing',
  );
  r = await rows(`<defs>${G('gradientTransform="scale(0)"')}</defs>${STROKE('url(#g) lime')}`);
  check(
    r.rows.some((x) => same(x.stroke, LIME) && x.sw > 0 && x.grad === 0),
    'a singular stroke gradient with a fallback strokes with it',
  );
  r = await rows(
    `<defs>${G('gradientTransform="scale(0)"')}<linearGradient id="h" href="#g"/></defs>${RECT('url(#h)')}`,
  );
  check(r.n === 0, 'a transform inherited through href counts');
  r = await rows(
    `<defs>${G('gradientTransform="scale(0)"')}<linearGradient id="h" href="#g" gradientTransform="scale(2)"/></defs>${RECT('url(#h)')}`,
  );
  check(
    r.n === 1 && r.rows[0].grad > 0,
    'a valid transform of the referencing gradient overrides the singular one',
  );
}
console.log('controls: invertible transforms (tiny ones included) still paint the gradient');
for (const gt of [
  'scale(0.01)',
  'scale(1e-6)',
  'scale(1e-9 1)',
  'rotate(30)',
  'scale(-1)',
  'skewX(80)',
]) {
  const r = await rows(`<defs>${G(`gradientTransform="${gt}"`)}</defs>${RECT('url(#g)')}`);
  check(r.n === 1 && r.rows[0].grad > 0, `gradientTransform ${gt} paints the gradient`);
}
console.log('a singular patternTransform paints the fallback, else nothing');
for (const pt of ['scale(0)', 'matrix(1 2 2 4 0 0)', 'scale(1 0)']) {
  let r = await rows(`<defs>${P(`patternTransform="${pt}"`)}</defs>${RECT('url(#p)')}`);
  check(r.n === 0, `${pt}: no paint, no row (${r.n} rows)`);
  r = await rows(`<defs>${P(`patternTransform="${pt}"`)}</defs>${RECT('url(#p) lime')}`);
  check(
    r.n === 1 && same(r.rows[0].fill, LIME) && r.rows[0].atlasW !== 2,
    `${pt} + fallback: the lime fallback, no pattern carrier`,
  );
}
{
  let r = await rows(`<defs>${P('patternTransform="scale(0)"')}</defs>${STROKE('url(#p)')}`);
  check(
    r.n === 0 || r.rows.every((x) => x.stroke[3] === 0 || x.sw === 0),
    'a singular pattern stroke strokes nothing (it painted black)',
  );
  r = await rows(`<defs>${P('patternTransform="scale(0)"')}</defs>${STROKE('url(#p) lime')}`);
  check(
    r.rows.some((x) => same(x.stroke, LIME) && x.sw > 0),
    'a singular pattern stroke with a fallback strokes with it',
  );
  r = await rows(
    `<defs>${P('patternTransform="scale(0)"')}<pattern id="q" href="#p"/></defs>${RECT('url(#q)')}`,
  );
  check(r.n === 0, 'a patternTransform inherited through href counts');
  for (const pt of ['scale(0.5)', 'scale(1e-6)', 'rotate(30)']) {
    r = await rows(`<defs>${P(`patternTransform="${pt}"`)}</defs>${RECT('url(#p)')}`);
    check(
      r.n >= 1 && r.rows.some((x) => x.atlasW === 2),
      `patternTransform ${pt} still paints the pattern`,
    );
  }
}
console.warn = warn;
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('singularPaintTransformSmoke: all passed');
