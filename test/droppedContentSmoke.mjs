// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// droppedContentSmoke -- content that draws nothing at import is still THERE for everything that can observe it later.
//   * a fill or stroke whose alpha is 0 (fill-opacity 0, stroke-opacity 0, opacity 0, `transparent`, rgba(..,0)) keeps its drawn row by default;
//     a morph pairs it with the other pose's row (geometry and paint interpolate, nothing fades in from frozen geometry), an override table
//     finds it by id, and its bounds include the stroke's reach so a raised alpha draws inside its box;
//   * `keepInvisibleShapes: false` is the optimizing mode that drops it (rows, wire bytes), and `'all'` also keeps a fill of `none`;
//   * a `<text>` run that fades in through fill-opacity keeps one shape set across the fade: dropping its alpha-0 glyphs would give
//     consecutive shape-timeline or morph poses different topology (glyphs pop in), so the kept glyphs store fill alpha 0 and a morph
//     lerps their opacity.
import { readFileSync } from 'fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
import { makeFakeWebgl2 } from './_fakeWebgl2.mjs';
import { importSvg, createBundle, createShapeMorph, createOverrideTable } from '../src/index.js';
import { MantleFontAsset } from '../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../src/font/textRun.js';
import { fontFixture, readAsset } from './_assets.mjs';
console.warn = () => {};

let failures = 0;
const check = (cond, m) => {
  if (cond) console.log('ok ' + m);
  else {
    failures++;
    console.error('FAIL: ' + m);
  }
};
const G = 'x="2" y="2" width="8" height="8"';
const wrap = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${b}</svg>`;
const rect = (extra) => {
  const m = { fill: 'red', stroke: 'blue', 'stroke-width': '2' };
  for (const x of extra.matchAll(/([\w-]+)="([^"]*)"/g)) m[x[1]] = x[2];
  return `<rect id="a" ${G} ${Object.entries(m)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ')}/>`;
};
const NORMAL = rect('');
const rowsOf = async (svg, o) => (await importSvg(wrap(svg), o)).numShapes;
const fade = (fop) =>
  `<svg viewBox="0 0 200 60" xmlns="http://www.w3.org/2000/svg">` +
  `<text x="5" y="40" font-family="Roboto" font-size="30" fill="#000" fill-opacity="${fop}">color</text></svg>`;

// 1. Every alpha-0 paint keeps its row, and a morph to or from it pairs every row.
const ALPHA0 = {
  'fill-opacity 0': 'fill-opacity="0"',
  'fill transparent': 'fill="transparent"',
  'fill rgba(..,0)': 'fill="rgba(255,0,0,0)"',
  'stroke-opacity 0': 'stroke-opacity="0"',
  'stroke transparent': 'stroke="transparent"',
  'stroke rgba(..,0)': 'stroke="rgba(0,0,255,0)"',
};
const full = await rowsOf(NORMAL, {});
for (const [name, attrs] of Object.entries(ALPHA0)) {
  const v = rect(attrs);
  check((await rowsOf(v, {})) === full, `${name}: both rows kept by default`);
  check(
    (await rowsOf(v, { keepInvisibleShapes: false })) === full - 1,
    `${name}: keepInvisibleShapes:false drops the row (optimizing mode)`,
  );
  for (const [dir, A, B] of [
    ['from', v, NORMAL],
    ['to', NORMAL, v],
  ]) {
    const { gl } = makeFakeWebgl2(16, 16);
    const m = createShapeMorph(
      gl,
      createBundle(gl, await importSvg(wrap(A), {})),
      createBundle(gl, await importSvg(wrap(B), {})),
      { cpuLerp: true },
    );
    check(
      m.plan.matched.length === full && !m.plan.srcOnly.length && !m.plan.dstOnly.length,
      `${name}: morph ${dir} the invisible pose pairs all ${full} rows`,
    );
  }
}
// opacity 0 on the element: the row (group) is kept, a morph pairs it.
{
  const v = rect('opacity="0"');
  const { gl } = makeFakeWebgl2(16, 16);
  const m = createShapeMorph(
    gl,
    createBundle(gl, await importSvg(wrap(v), {})),
    createBundle(gl, await importSvg(wrap(NORMAL), {})),
    { cpuLerp: true },
  );
  check(
    !m.plan.srcOnly.length && !m.plan.dstOnly.length,
    'opacity 0: morph to the opaque pose pairs every row',
  );
}

// 2. Overrides reach a kept stroke by id; the stroke row's bounds carry the stroke's reach.
{
  const { gl } = makeFakeWebgl2(16, 16);
  const S = await importSvg(wrap(rect('stroke-opacity="0"')), {});
  const T = createOverrideTable(gl, createBundle(gl, S));
  check(
    T.set('a_stroke', { stroke: [0, 1, 0, 1] }) === true,
    'stroke-opacity 0: an absolute stroke override finds the stroke row',
  );
  const st = S.metaFloatsPerShape,
    f = new Float32Array(S.meta, 32);
  const r = S.shapeIds.indexOf('a_stroke');
  // bbox is the first texel after the header slots 0..3 (x0,y0,x1,y1)
  check(
    r >= 0 && Math.abs(f[r * st + 0] - 1) < 1e-6 && Math.abs(f[r * st + 2] - 11) < 1e-6,
    `stroke-opacity 0: the stroke row box is padded by half the width (${[f[r * st], f[r * st + 2]]})`,
  );
}

// 3. 'all' also keeps a fill of none (a stroke-only shape gets a fill row); the default does not.
{
  const v = rect('fill="none"');
  check(
    (await rowsOf(v, {})) === full - 1,
    'fill none: no fill row by default (a paint of none costs a row per stroke-only shape)',
  );
  check(
    (await rowsOf(v, { keepInvisibleShapes: 'all' })) === full,
    "fill none: keepInvisibleShapes 'all' keeps the fill row",
  );
  const { gl } = makeFakeWebgl2(16, 16);
  const m = createShapeMorph(
    gl,
    createBundle(gl, await importSvg(wrap(v), { keepInvisibleShapes: 'all' })),
    createBundle(gl, await importSvg(wrap(NORMAL), { keepInvisibleShapes: 'all' })),
    { cpuLerp: true },
  );
  check(
    m.plan.matched.length === full && !m.plan.srcOnly.length && !m.plan.dstOnly.length,
    "fill none: a morph to a filled pose pairs every row under 'all'",
  );
}

// 4. Unnamed shapes pair by their element, not by the row number: a pose that drops a row (a fill of `none`) must not shift every later name,
//    or a morph pairs one shape's fill with another shape's.
{
  const two = (a1) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 16"><rect x="1" y="1" width="8" height="8" stroke="blue" ${a1}/><rect x="20" y="1" width="8" height="8" stroke="blue" fill="red"/></svg>`;
  const { gl } = makeFakeWebgl2(16, 16);
  const SA = await importSvg(two('fill="none"'), {}),
    SB = await importSvg(two('fill="red"'), {});
  const m = createShapeMorph(gl, createBundle(gl, SA), createBundle(gl, SB), { cpuLerp: true });
  const pairs = m.plan.matched
    .map((x) => [x.srcIdx, x.dstIdx].join('>'))
    .sort()
    .join(' ');
  check(
    pairs === '0>1 1>2 2>3' && m.plan.dstOnly.length === 1 && m.plan.dstOnly[0].dstIdx === 0,
    `fill none -> filled, unnamed: each shape pairs with itself (${pairs}); only the new fill fades in`,
  );
}

// 5. A kept alpha-0 row costs the draw nothing: the draw list is the optimizing mode's, until an override gives a row ink.
{
  for (const [name, attrs] of Object.entries(ALPHA0)) {
    const { gl } = makeFakeWebgl2(16, 16);
    const kept = createBundle(gl, await importSvg(wrap(rect(attrs)), {})),
      dropped = createBundle(
        gl,
        await importSvg(wrap(rect(attrs)), { keepInvisibleShapes: false }),
      );
    check(
      kept.drawList.length === dropped.drawList.length,
      `${name}: the draw list is the optimizing mode's (${kept.drawList.length} ops)`,
    );
  }
}
// 6. A <text> fade: the optimizing mode drops the alpha-0 glyphs, the default keeps the same shape set at every pose, and a fill of
//    `none` (a stroke-only path) is not resurrected by the default.
{
  const font = new MantleFontAsset(new Uint8Array(readAsset(fontFixture('roboto-regular.ttf'))));
  const keep = { fonts: { Roboto: font }, svgTextLayout: buildSvgTextGlyphs }; // the default keeps
  const drop = { ...keep, keepInvisibleShapes: false }; // the optimizing mode
  const c0 = await importSvg(fade('0.000'), drop);
  const c1 = await importSvg(fade('0.551'), drop);
  check(
    c0.numShapes < c1.numShapes,
    `text fade: keepInvisibleShapes:false culls alpha-0 fills (t0=${c0.numShapes} < t.55=${c1.numShapes})`,
  );
  const k0 = await importSvg(fade('0.000'), keep);
  const k1 = await importSvg(fade('0.551'), keep);
  check(
    k0.numShapes === k1.numShapes && k0.numShapes === c1.numShapes,
    `text fade: uniform topology (${k0.numShapes}==${k1.numShapes}, opaque ${c1.numShapes}) across the fade by default`,
  );
  const mf = k0.metaFloats || (k0.meta ? new Float32Array(k0.meta, 32) : null);
  check(
    !!mf && mf[7] === 0,
    `text fade: the kept alpha-0 glyph stores fill alpha 0 (transparent; morph lerps opacity) (${mf ? mf[7] : 'no meta'})`,
  );
  const pn = await importSvg(
    '<svg viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M5 5 L45 45" fill="none" stroke="#000" stroke-width="2"/></svg>',
    keep,
  );
  check(
    pn.numShapes === 1,
    `fill="none" is not resurrected by the default (one stroke-only shape, got ${pn.numShapes})`,
  );
}
if (failures) {
  console.error(`droppedContentSmoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  '\ndroppedContentSmoke: invisible content survives for morphs, overrides, bounds and text fades; the optimizing mode drops it',
);
