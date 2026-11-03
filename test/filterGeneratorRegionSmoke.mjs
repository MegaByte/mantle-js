// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterGeneratorRegionSmoke -- what a filter paints past its source's box, and the inputs a filter cannot draw.
//
// A generator (feFlood, feTurbulence, feImage) paints the whole filter region (Filter Effects 1 §15.3), so what merges, blends or composites one over the
// source reaches past the source's box; so does an arithmetic k4 > 0 (it adds to transparent input); a negative displacement scale moves pixels as far as a
// positive one. A node target bounded by the source's box (and shrunk by a negative scale) would cut the result there. Also: a non-primitive child of
// <filter> (<desc>) must not drop the whole filter; an `in` naming an Object.prototype member is not a source; and an owner paint with nothing to draw must
// not leave feMerge sampling a null texture, which WebGL reads as opaque black, or feComposite without its other input.
// CPU (test/_fakeGl.mjs). No pixels: the claim is the rectangle the composite is drawn through, and the textures bound for a pass.
globalThis.__MANTLE_DEBUG__ = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');
const { computeNodeBboxes } = await import('../src/filterGraph/bbox.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const SZ = 800;
const DOC = (flt, shape) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs>${flt}<pattern id="pt" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#0f0"/></pattern></defs><rect width="400" height="400" fill="none"/>${shape}</svg>`;
const SHAPE = '<rect x="150" y="150" width="100" height="100" fill="#c33" filter="url(#f)"/>';
const REGION = 'x="-50%" y="-50%" width="200%" height="200%"';
async function frame(flt, shape = SHAPE) {
  const F = createFakeGl({ width: SZ, height: SZ });
  const R = createRenderer(F.gl, taggedShaderSources(), {});
  R.setViewport(SZ, SZ);
  const b = createBundle(F.gl, await importSvg(DOC(flt, shape), { preserveViewport: true }));
  const n0 = F.log.length;
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(b);
  R.endFrame();
  const log = F.log.slice(n0).filter((e) => e.op === 'draw');
  R.dispose();
  return { F, b, log, canvas: log.filter((e) => e.fbo === null) };
}
// The shape is canvas 300..500 and the region canvas 200..600.
const reaches = (f, x0, x1) => f.canvas.some((e) => e.vp[0] <= x0 && e.vp[0] + e.vp[2] >= x1);

console.log(
  '(generators) a generator merged, blended or composited over the source paints the filter region',
);
for (const [name, body] of [
  [
    'feFlood + feMerge',
    '<feFlood flood-color="#00f" result="a"/><feMerge><feMergeNode in="a"/><feMergeNode in="SourceGraphic"/></feMerge>',
  ],
  [
    'feFlood + feComposite over',
    '<feFlood flood-color="#00f" result="a"/><feComposite in="SourceGraphic" in2="a" operator="over"/>',
  ],
  [
    'feFlood + feBlend',
    '<feFlood flood-color="#00f" result="a"/><feBlend in="SourceGraphic" in2="a" mode="multiply"/>',
  ],
  [
    'feTurbulence + feMerge',
    '<feTurbulence baseFrequency="0.1" result="a"/><feMerge><feMergeNode in="a"/><feMergeNode in="SourceGraphic"/></feMerge>',
  ],
]) {
  const f = await frame(`<filter id="f" ${REGION}>${body}</filter>`);
  ok(
    reaches(f, 200, 600),
    `${name}: the composite covers the region (${f.canvas.map((e) => e.vp.join(',')).join(' | ')})`,
  );
}
console.log(
  '(control) an feComposite in stays on the shape it is cut to: the flood-tint chain pays nothing',
);
{
  const f = await frame(
    `<filter id="f" ${REGION}><feFlood flood-color="#00f" result="a"/><feComposite in="a" in2="SourceAlpha" operator="in"/></filter>`,
  );
  const vp = f.canvas[0] && f.canvas[0].vp;
  ok(vp && vp[2] <= 256 && vp[3] <= 256, `the composite stays near the source's box (${vp})`);
}
console.log('(arithmetic) k4 > 0 paints the region; k4 = 0 does not');
{
  const f = await frame(
    `<filter id="f" ${REGION}><feComposite in="SourceGraphic" in2="SourceGraphic" operator="arithmetic" k4="0.5"/></filter>`,
  );
  ok(
    reaches(f, 200, 600),
    `k4 = 0.5 covers the region (${f.canvas.map((e) => e.vp.join(',')).join(' | ')})`,
  );
  const c = await frame(
    `<filter id="f" ${REGION}><feComposite in="SourceGraphic" in2="SourceGraphic" operator="arithmetic" k2="1"/></filter>`,
  );
  ok(
    c.canvas[0] && c.canvas[0].vp[2] <= 256,
    `k4 = 0 stays on the source (${c.canvas[0] && c.canvas[0].vp})`,
  );
}
console.log('(displacement) a negative scale reaches as far as a positive one');
{
  const neg = await frame(
    `<filter id="f" ${REGION}><feDisplacementMap in="SourceGraphic" in2="SourceGraphic" scale="-40"/></filter>`,
  );
  const pos = await frame(
    `<filter id="f" ${REGION}><feDisplacementMap in="SourceGraphic" in2="SourceGraphic" scale="40"/></filter>`,
  );
  ok(reaches(neg, 300, 500), `the source is not cut (${neg.canvas[0] && neg.canvas[0].vp})`);
  ok(
    String(neg.canvas[0] && neg.canvas[0].vp) === String(pos.canvas[0] && pos.canvas[0].vp),
    'the same rect as the positive scale',
  );
  const { rootBbox } = computeNodeBboxes(
    {
      nodes: [{ type: 'feDisplacementMap', inputs: [-1, -1], params: { scale: -20 } }],
      rootOut: 0,
    },
    { x: 100, y: 100, w: 100, h: 100 },
    800,
    800,
  );
  ok(
    rootBbox.w === 120 && rootBbox.x === 90,
    `computeNodeBboxes grows by |scale| / 2 (${JSON.stringify(rootBbox)})`,
  );
}
console.log('(no region known) a flood keeps the source box: nothing here invents an extent');
{
  const flood = {
    nodes: [
      { type: 'feFlood', inputs: [], params: {} },
      { type: 'feMerge', inputs: [0, -1], params: {} },
    ],
    rootOut: 1,
  };
  ok(
    computeNodeBboxes(flood, { x: 100, y: 100, w: 100, h: 100 }, 800, 800).rootBbox.w === 100,
    'without a region the bound is the source',
  );
  ok(
    computeNodeBboxes(flood, { x: 100, y: 100, w: 100, h: 100 }, 800, 800, {
      x: 50,
      y: 50,
      w: 300,
      h: 300,
    }).rootBbox.w === 300,
    'with one it is the region',
  );
}
console.log('(parser) what is not a primitive takes no part in the chain');
for (const child of [
  '<desc>a shadow</desc>',
  '<title>a shadow</title>',
  '<animate attributeName="x" to="1" dur="1s"/>',
  '<metadata/>',
]) {
  const f = await frame(`<filter id="f" ${REGION}>${child}<feOffset dx="10" dy="10"/></filter>`);
  ok(
    (f.b.filterGraphs || []).some(
      (g) => g && g.nodes.length === 1 && g.nodes[0].type === 'feOffset',
    ),
    `${child}: the filter keeps its graph`,
  );
}
{
  const f = await frame(
    `<filter id="f" ${REGION}><feOffset dx="10" dy="10"/><feOffset in="constructor" dx="1"/></filter>`,
  );
  const g = (f.b.filterGraphs || []).find(Boolean);
  ok(
    g && g.nodes[1].inputs[0] === 0,
    `an \`in\` naming an Object.prototype member reads as an unknown name: the previous result (${g && g.nodes[1].inputs})`,
  );
}
console.log(
  '(owner paint) a paint with nothing to draw is transparent: no pass samples a missing texture, and the other input survives',
);
{
  const shape =
    '<rect x="150" y="150" width="100" height="100" fill="url(#pt)" stroke="#000" filter="url(#f)"/>';
  const merge = await frame(
    '<filter id="f" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB"><feMerge><feMergeNode in="FillPaint"/><feMergeNode in="SourceGraphic"/></feMerge></filter>',
    shape,
  );
  const passes = merge.log.filter((e) => merge.F.progKeys(e.prog).has('feCompositeFrag'));
  ok(
    passes.length > 0 && passes.every((e) => e.units[0] && e.units[1]),
    'feMerge: both units hold a texture in every pass',
  );
  const comp = await frame(
    '<filter id="f" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB"><feComposite in="SourceGraphic" in2="FillPaint" operator="over"/></filter>',
    shape,
  );
  const cp = comp.log.filter((e) => comp.F.progKeys(e.prog).has('feCompositeFrag'));
  ok(
    cp.length > 0 && cp.every((e) => e.units[0] && e.units[1]),
    'feComposite over: the pass runs, its source kept',
  );
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
