// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// patternStrokeSmoke -- a vector pattern as a stroke paint, not solid black (with or without a fallback). The importer draws it as the
// pattern MASKED BY THE STROKED OUTLINE: a rect filled with the pattern, masked by a synthetic alpha mask holding the element's own geometry
// stroked white. Record-level (CPU); the pixels are proved against Chrome by paintRowsRenderSmoke.
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
let warned = [];
const warn = console.warn;
console.warn = (...a) => warned.push(a.join(' '));
const P =
  '<pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="4" height="8" fill="#0a0"/><rect x="4" width="4" height="8" fill="#a0a"/></pattern>';
/// Drawn rows: { fill, stroke, sw, mask, carrier (atlas.w == 2), layer }.
async function rows(body) {
  warned = [];
  const b = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs>${P}</defs>${body}</svg>`,
    { preserveViewport: true },
  );
  const st = b.metaFloatsPerShape,
    mf = parseMetaBin(b.meta, st).metaFloats,
    out = [];
  for (let r = 0; r < mf.length / st; r++) {
    const o = r * st,
      flags = Math.round(mf[o + 27]);
    out.push({
      layer: !!(flags & 256),
      group: !!(flags & (64 | 128)),
      fill: Array.from(mf.slice(o + 4, o + 8)).map((v) => +v.toFixed(2)),
      stroke: Array.from(mf.slice(o + 8, o + 12)).map((v) => +v.toFixed(2)),
      sw: mf[o + 12],
      mask: Math.round(mf[o + 31]),
      carrier: Math.round(mf[o + 43]) === 2,
    });
  }
  return { rows: out, b };
}
const drawn = (r) => r.rows.filter((x) => !x.layer && !x.group);
const R = (
  extra = '',
  body = '<rect x="14" y="14" width="36" height="36" fill="none" stroke="url(#p)" stroke-width="12"',
) => `${body} ${extra}/>`;

console.log('a stroke pattern is the pattern masked by the stroked outline');
{
  const r = await rows(R());
  const d = drawn(r);
  check(
    d.length === 1 && d[0].carrier && d[0].mask > 0 && d[0].fill[3] === 1,
    `one drawn row: the pattern carrier under a mask (${d.length} rows, carrier ${d[0]?.carrier}, mask ${d[0]?.mask})`,
  );
  const maskKid = r.rows.filter(
    (x) =>
      x.layer &&
      x.sw === 12 &&
      x.stroke[0] === 1 &&
      x.stroke[1] === 1 &&
      x.stroke[2] === 1 &&
      x.fill[3] === 0,
  );
  check(maskKid.length === 1, 'the mask holds the element stroked white at its own width, no fill');
  check(
    r.rows.every(
      (x) =>
        !(
          x.stroke[0] === 0 &&
          x.stroke[1] === 0 &&
          x.stroke[2] === 0 &&
          x.stroke[3] === 1 &&
          x.sw > 0
        ),
    ),
    'no solid black stroke row',
  );
  check(warned.length === 0, 'no warning');
}
console.log('fill and stroke');
{
  let r = await rows(
    R(
      '',
      '<rect x="14" y="14" width="36" height="36" fill="#ccc" stroke="url(#p)" stroke-width="12"',
    ),
  );
  let d = drawn(r);
  check(
    d.length === 2 && !d[0].carrier && d[1].carrier,
    'default paint order: the fill row, then the pattern stroke',
  );
  r = await rows(
    R(
      'paint-order="stroke"',
      '<rect x="14" y="14" width="36" height="36" fill="#ccc" stroke="url(#p)" stroke-width="12"',
    ),
  );
  d = drawn(r);
  check(
    d.length === 2 && d[0].carrier && !d[1].carrier,
    'paint-order stroke: the pattern stroke first',
  );
  r = await rows(R('stroke-opacity=".5"'));
  d = drawn(r);
  check(
    d.length === 1 && Math.abs(d[0].fill[3] - 0.5) < 1e-6,
    'stroke-opacity rides on the pattern rect',
  );
}
console.log('unsupported cases paint the fallback, else nothing, and say so');
{
  let r = await rows(R('vector-effect="non-scaling-stroke"'));
  check(
    drawn(r).length === 0 && warned.some((w) => /pattern as a stroke/.test(w)),
    'non-scaling-stroke: nothing, warned',
  );
  r = await rows(R('vector-effect="non-scaling-stroke"').replace('url(#p)', 'url(#p) lime'));
  check(
    drawn(r).some((x) => x.stroke[1] === 1 && x.stroke[0] === 0 && x.sw > 0),
    'non-scaling-stroke + fallback: the fallback stroke',
  );
  r = await rows(
    `<pattern id="q" width="8" height="8" patternUnits="userSpaceOnUse"/>` +
      R().replace('url(#p)', 'url(#q) lime'),
  );
  check(
    drawn(r).some((x) => x.stroke[1] === 1 && x.sw > 0) && warned.length === 0,
    'an empty pattern + fallback: the fallback, silently (nothing to draw)',
  );
}
console.log('everything else is untouched');
{
  const solid = await rows(R().replace('url(#p)', '#f00'));
  check(drawn(solid).length === 1 && !drawn(solid)[0].carrier, 'a solid stroke is one row');
  const none = await rows(R().replace('url(#p)', 'none'));
  check(none.rows.length === 0, 'stroke none: nothing');
  const fillPat = await rows('<rect x="14" y="14" width="36" height="36" fill="url(#p)"/>');
  check(
    drawn(fillPat).length === 1 && drawn(fillPat)[0].carrier && drawn(fillPat)[0].mask === 0,
    'a pattern FILL is unchanged',
  );
}
console.warn = warn;
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('patternStrokeSmoke: all passed');
