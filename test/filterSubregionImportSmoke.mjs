// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterSubregionImportSmoke -- the importer and the pure pieces behind primitive subregions, primitiveUnits="objectBoundingBox"
// and CSS filter functions / filter lists. No GPU: it reads bundle.filterGraphs / filterRegions / filterPrimCtms through each
// shape's filter id, and exercises primitiveSubregions (filterGraph/feImagePlace.js), resolveObbGraph (svg/filterUnits.js) and the filter
// value grammar (svg/cssFilter.js) directly.
//
// Before: a primitive's x / y / width / height reached the graph only on feImage, primitiveUnits="objectBoundingBox" scaled nothing but an
// feImage, and a CSS filter function or a list of url()s imported with filter id 0 and no word about it.
// Literal fixtures (genSmokeAssets derives examples/smoke/filterSubregionImport__*.svg from them): a subregion, primitiveUnits, CSS functions.
const SVG_SUBREGION =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><feOffset dx="10" dy="0" x="20" y="0" width="30" height="64"/></filter><rect x="16" y="16" width="32" height="32" fill="#e04020" filter="url(#f)"/></svg>';
const SVG_OBB =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64" primitiveUnits="objectBoundingBox"><feGaussianBlur stdDeviation="0.1" result="b"/><feOffset in="b" dx="0.25" dy="0.25"/></filter><rect x="16" y="16" width="32" height="32" fill="#e04020" filter="url(#f)"/></svg>';
const SVG_CSS =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="16" y="16" width="32" height="32" fill="#e04020" style="filter: grayscale(50%) drop-shadow(5px 5px 3px #2060d0)"/></svg>';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { primitiveSubregions } = await import('../src/filterGraph/feImagePlace.js');
const { resolveObbGraph } = await import('../src/svg/filterUnits.js');
const { scanFilterList, canonicalFilter, filterListGraph, cssColorMatrix } =
  await import('../src/svg/cssFilter.js');
const { setDiagnostics } = await import('../src/core/diagnostics.js');
const { computeNodeBboxes } = await import('../src/filterGraph/bbox.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const near = (a, b, e = 1e-6) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === b.length &&
  a.every((v, i) => (v === null || b[i] === null ? v === b[i] : Math.abs(v - b[i]) <= e));

const warnings = [];
setDiagnostics({ onWarn: (...a) => warnings.push(a.join(' ')) });
const warned = (re) => warnings.filter((w) => re.test(w)).length;

const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">${body}</svg>`;
const REG =
  'filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64" color-interpolation-filters="sRGB"';
const R = (attrs = '') => `<rect x="16" y="16" width="32" height="32" fill="#e04020" ${attrs}/>`;

/** The filter ids of the filtered rows, in paint order. */
function filterIds(b) {
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const ids = [];
  for (let s = 0; s < pm.numShapes; s++) {
    const fid = Math.floor(pm.metaFloats[s * pm.floatsPerShape + 32] + 0.5);
    if (fid > 0) ids.push(fid);
  }
  return ids;
}
const graphOf = (b, k = 0) => {
  const ids = filterIds(b);
  return ids.length > k ? b.filterGraphs[ids[k] - 1] : null;
};
const types = (g) => (g ? g.nodes.map((n) => n.type) : null);

// ── primitive subregions at import ──────────────────────────────────────────────────────────────────────────────────────
console.log('primitive subregions');
{
  const b = await importSvg(SVG_SUBREGION);
  const g = graphOf(b);
  ok(
    g && types(g).join() === 'feOffset',
    'a stated subregion on feOffset takes the graph route (the single-kind fast path would drop it)',
  );
  ok(
    g && near(g.nodes[0].params.sub, [20, 0, 30, 64]) && g.nodes[0].params.subUnits === 0,
    'x / y / width / height are kept in user units: ' + JSON.stringify(g && g.nodes[0].params.sub),
  );
}
{
  const b = await importSvg(
    doc(
      `<filter id="f" ${REG}><feGaussianBlur stdDeviation="4" x="20" width="30"/></filter>${R('filter="url(#f)"')}`,
    ),
  );
  const g = graphOf(b);
  ok(
    g && types(g).join() === 'feGaussianBlur' && near(g.nodes[0].params.sub, [20, null, 30, null]),
    'blur with a subregion is a graph node (the unbounded fast path dropped it); unstated components stay null',
  );
}
{
  const b = await importSvg(
    doc(
      `<filter id="f" ${REG}><feFlood flood-color="blue" x="25%" y="50%" width="10%" height="10%"/></filter>${R('filter="url(#f)"')}`,
    ),
  );
  const g = graphOf(b);
  ok(
    g && near(g.nodes[0].params.sub, [16, 32, 6.4, 6.4]),
    'userSpaceOnUse percentages are of the viewport: ' + JSON.stringify(g && g.nodes[0].params.sub),
  );
}
{
  const b = await importSvg(
    doc(
      `<filter id="f" ${REG}><feColorMatrix type="saturate" values="0.5" x="20" y="20" width="10" height="10"/></filter>${R('filter="url(#f)"')}`,
    ),
  );
  const g = graphOf(b);
  ok(
    g && types(g).join() === 'feColorMatrix' && !!g.nodes[0].params.sub,
    'a color matrix with a subregion is a graph node, not the inline tint',
  );
}
{
  const b = await importSvg(
    doc(
      `<filter id="f" ${REG}><feOffset dx="3" x="10" width="20"/></filter><g transform="translate(5 7)">${R('filter="url(#f)"')}</g>`,
    ),
  );
  const ids = filterIds(b);
  ok(
    ids.length === 1 && b.filterPrimCtms && near(b.filterPrimCtms[ids[0] - 1], [1, 0, 0, 1, 5, 7]),
    'a subregion is in the user space of the referencing element: its CTM rides the entry ' +
      JSON.stringify(b.filterPrimCtms),
  );
}
{
  const b = await importSvg(
    doc(`<filter id="f" ${REG}><feOffset dx="3"/></filter>${R('filter="url(#f)"')}`),
  );
  const g = graphOf(b);
  ok(
    g && g.nodes[0].params.sub === undefined && g.nodes[0].params.subUnits === undefined,
    'a primitive that states nothing carries nothing (no new field on existing graphs)',
  );
}

// ── primitiveSubregions (Filter Effects 1 §15.3) ─────────────────────────────────────────────────────────────────────────────
console.log('subregion defaults');
{
  const env = { regionEm: [0, 0, 64, 64], boxEm: [16, 16, 48, 48], ctm: null };
  const g = {
    nodes: [
      { type: 'feFlood', inputs: [], params: { sub: [20, 20, 10, 10], subUnits: 0 } }, // 0 explicit
      { type: 'feOffset', inputs: [0], params: { dx: 5 } }, // 1 default: the input's
      { type: 'feFlood', inputs: [], params: { sub: [40, 40, 10, 10], subUnits: 0 } }, // 2 explicit
      { type: 'feMerge', inputs: [1, 2], params: {} }, // 3 union of 1 and 2
      { type: 'feBlend', inputs: [0, -1], params: {} }, // 4 a standard input -> the region
      { type: 'feTile', inputs: [0], params: {} }, // 5 feTile -> the region
      { type: 'feGaussianBlur', inputs: [0], params: { sub: [null, null, 20, null] } }, // 6 width only: x, y, height from the input's
      { type: 'feFlood', inputs: [], params: { sub: [5, 5, 0, 10], subUnits: 0 } }, // 7 no area
      { type: 'feOffset', inputs: [7], params: {} }, // 8 its input is empty
      { type: 'feFlood', inputs: [], params: {} }, // 9 nothing stated
    ],
    rootOut: 9,
  };
  const r = primitiveSubregions(g, env);
  ok(near(r[0], [20, 20, 30, 30]), 'a stated x / y / width / height is the subregion');
  ok(
    near(r[1], [20, 20, 30, 30]),
    "the default is the union of the input subregions (an offset of a flood is held to the flood's)",
  );
  ok(
    near(r[3], [20, 20, 50, 50]),
    "a merge's default is the union of its inputs: " + JSON.stringify(r[3]),
  );
  ok(r[4] === null, 'a standard input makes the default the filter region');
  ok(r[5] === null, "feTile's default is the filter region");
  ok(
    near(r[6], [20, 20, 40, 30]),
    "a stated width alone keeps the input's x, y and height: " + JSON.stringify(r[6]),
  );
  ok(
    r[7] === 'empty' && r[8] === 'empty',
    'zero width DISABLES the primitive (Filter Effects 1: transparent black); what reads it is empty too (specDefaultSmoke holds the compat arm)',
  );
  ok(r[9] === null, 'a generator that states nothing has the region');
  const img = (stated) =>
    primitiveSubregions(
      {
        nodes: [
          {
            type: 'feImage',
            inputs: [],
            params: {
              external: 1,
              imgW: 8,
              imgH: 8,
              align: [1, 1],
              fit: 0,
              subUnits: 0,
              sub: [10, 10, 20, 20],
              ...(stated ? { subStated: 1 } : null),
            },
          },
          { type: 'feOffset', inputs: [0], params: { dx: 14 } },
        ],
        rootOut: 1,
      },
      env,
    );
  ok(
    near(img(true)[0], [10, 10, 30, 30]) && near(img(true)[1], [10, 10, 30, 30]),
    'an feImage that states a subregion gives it to what reads it (no stated x / y / width / height on the reader needed)',
  );
  ok(img(false)[1] === null, 'an feImage that states none: its readers have the filter region');
  const turned = primitiveSubregions(
    {
      nodes: [{ type: 'feFlood', inputs: [], params: { sub: [1, 2, 3, 4], subUnits: 0 } }],
      rootOut: 0,
    },
    { ...env, ctm: [2, 0, 0, 2, 10, 20] },
  );
  ok(
    near(turned[0], [12, 24, 18, 32]),
    'user units go through the element CTM: ' + JSON.stringify(turned[0]),
  );
}

// ── bbox propagation with a resolved subregion (params.subregionPx, top-left px) ────────────────────────────────────────────────
console.log('bbox propagation');
{
  const src = { x: 20, y: 20, w: 20, h: 20 };
  const g = {
    nodes: [
      {
        type: 'feFlood',
        inputs: [],
        params: { rgba: [0, 0, 1, 1], subregionPx: { x: 50, y: 5, w: 10, h: 10 } },
      }, // a generator fills its subregion, far from the shape
      {
        type: 'feOffset',
        inputs: [-1],
        params: { dx: 30, dy: 0, subregionPx: { x: 0, y: 0, w: 60, h: 64 } },
      }, // narrowed to its subregion
      { type: 'feTile', inputs: [0], params: { subregionPx: { x: 40, y: 0, w: 24, h: 24 } } }, // a tile fills its subregion, not the canvas
      {
        type: 'feGaussianBlur',
        inputs: [-1],
        params: { sigmaX: 2, sigmaY: 2, subregionPx: { x: 100, y: 100, w: 5, h: 5 } },
      }, // a subregion off the content: nothing
    ],
    rootOut: 3,
  };
  const { bboxes } = computeNodeBboxes(g, src, 128, 128);
  ok(
    near([bboxes[0].x, bboxes[0].y, bboxes[0].w, bboxes[0].h], [50, 5, 10, 10]),
    "a generator's box is its subregion: " + JSON.stringify(bboxes[0]),
  );
  ok(
    near([bboxes[1].x, bboxes[1].y, bboxes[1].w, bboxes[1].h], [50, 20, 10, 20]),
    "an offset's shifted box is narrowed to the subregion: " + JSON.stringify(bboxes[1]),
  );
  ok(
    near([bboxes[2].x, bboxes[2].y, bboxes[2].w, bboxes[2].h], [40, 0, 24, 24]),
    'feTile fills its subregion: ' + JSON.stringify(bboxes[2]),
  );
  ok(bboxes[3].w === 0 && bboxes[3].h === 0, 'a subregion that misses the content leaves nothing');
  const plain = computeNodeBboxes(
    {
      nodes: [
        { type: 'feTile', inputs: [-1], params: {} },
        { type: 'feFlood', inputs: [], params: {} },
      ],
      rootOut: 0,
    },
    src,
    128,
    128,
  ).bboxes;
  ok(
    plain[0].w === 128 && near([plain[1].x, plain[1].w], [20, 20]),
    'with no subregion nothing changed (feTile whole canvas, a flood the source box)',
  );
}

// ── primitiveUnits = objectBoundingBox ──────────────────────────────────────────────────────────────────────────────────
console.log('primitiveUnits objectBoundingBox');
{
  const b = await importSvg(
    doc(
      `<filter id="f" ${REG} primitiveUnits="objectBoundingBox"><feGaussianBlur stdDeviation="0.1 0.2" result="b"/><feOffset in="b" dx="0.25" dy="0.5" x="0.25" y="0" width="0.5" height="1"/><feMorphology operator="dilate" radius="0.1"/></filter><rect x="16" y="16" width="32" height="16" fill="#e04020" filter="url(#f)"/>`,
    ),
  );
  const g = graphOf(b);
  ok(
    g && near([g.nodes[0].params.sigmaX, g.nodes[0].params.sigmaY], [3.2, 3.2]),
    'stdDeviation is a fraction of the box (32 x 16): ' + JSON.stringify(g && g.nodes[0].params),
  );
  ok(
    g && near([g.nodes[1].params.dx, g.nodes[1].params.dy], [8, 8]),
    'dx / dy are fractions of the width / height',
  );
  ok(
    g && near(g.nodes[1].params.sub, [24, 16, 16, 16]) && g.nodes[1].params.subUnits === 0,
    "a subregion is the box's fractions in user units: " +
      JSON.stringify(g && g.nodes[1].params.sub),
  );
  ok(
    g && near([g.nodes[2].params.radiusX, g.nodes[2].params.radiusY], [3.2, 1.6]),
    'morphology radius, per axis',
  );
  ok(
    g && g.obb === undefined && g.nodes.every((n) => n.params.obb === undefined),
    'the import leaves no unit flag behind',
  );
}
{
  const b = await importSvg(
    doc(
      `<filter id="f" ${REG} primitiveUnits="objectBoundingBox"><feGaussianBlur stdDeviation="0.1"/></filter><rect x="0" y="0" width="20" height="20" filter="url(#f)"/><rect x="30" y="30" width="40" height="40" filter="url(#f)"/>`,
    ),
  );
  const a = graphOf(b, 0),
    c = graphOf(b, 1);
  ok(
    a && c && near([a.nodes[0].params.sigmaX, c.nodes[0].params.sigmaX], [2, 4]),
    'two shapes that share the filter each get their own box: ' +
      JSON.stringify([a && a.nodes[0].params.sigmaX, c && c.nodes[0].params.sigmaX]),
  );
}
{
  const b = await importSvg(
    doc(
      `<filter id="f" ${REG} primitiveUnits="objectBoundingBox"><feGaussianBlur stdDeviation="0.05"/></filter><g filter="url(#f)"><rect x="0" y="0" width="20" height="20"/><rect x="30" y="30" width="40" height="40"/></g>`,
    ),
  );
  const g = graphOf(b);
  ok(
    g && near([g.nodes[0].params.sigmaX], [3.5]),
    "a group filter takes the union of its shapes' boxes (70 wide): " +
      JSON.stringify(g && g.nodes[0].params),
  );
}
{
  const b = await importSvg(
    doc(
      `<filter id="f" ${REG} primitiveUnits="objectBoundingBox"><feGaussianBlur in="SourceAlpha" stdDeviation="0.1" result="a"/><feDiffuseLighting in="a"><fePointLight x="0.25" y="0.5" z="0.5"/></feDiffuseLighting></filter><rect x="16" y="16" width="32" height="32" filter="url(#f)"/>`,
    ),
  );
  const g = graphOf(b);
  const n = g && g.nodes.find((x) => x.type === 'feDiffuseLighting');
  ok(
    n && near(n.params.lightPos, [24, 32, 16]),
    "a light's x / y are box fractions and z a fraction of the diagonal measure: " +
      JSON.stringify(n && n.params.lightPos),
  );
}
{
  const g = resolveObbGraph(
    {
      nodes: [{ type: 'feDisplacementMap', inputs: [-1, -1], params: { scale: 0.5, obb: 1 } }],
      rootOut: 0,
      obb: true,
    },
    [0, 0, 32, 16],
  );
  ok(
    g.nodes[0].params.scale === 16 && g.nodes[0].params.scaleY === undefined,
    'displacement scale: one scale, a fraction of the box width (as Chrome)',
  );
}
{
  const b = await importSvg(
    doc(
      `<filter id="f" ${REG} primitiveUnits="objectBoundingBox"><feOffset dx="0.25"/></filter><g transform="scale(2)"><rect x="4" y="4" width="16" height="16" filter="url(#f)"/></g>`,
    ),
  );
  const ids = filterIds(b),
    g = graphOf(b);
  ok(
    g &&
      g.nodes[0].params.dx === 8 &&
      b.filterPrimCtms &&
      near(b.filterPrimCtms[ids[0] - 1], [2, 0, 0, 2, 0, 0]),
    "the fraction is of the box in the element's OWN user space (16 wide, 4 user units), which the CTM then carries to root space (8): dx " +
      (g && g.nodes[0].params.dx),
  );
}
{
  const before = warned(/kernelUnitLength/);
  await importSvg(
    doc(
      `<filter id="f"><feConvolveMatrix order="3" kernelMatrix="0 0 0 0 1 0 0 0 0" kernelUnitLength="2"/></filter>${R('filter="url(#f)"')}`,
    ),
  );
  await importSvg(
    doc(
      `<filter id="f"><feConvolveMatrix order="3" kernelMatrix="0 0 0 0 1 0 0 0 0" kernelUnitLength="2"/><feOffset dx="1"/></filter>${R('filter="url(#f)"')}`,
    ),
  );
  ok(
    warned(/kernelUnitLength/) - before === 2,
    'kernelUnitLength is said to be unsupported (once per import, never silently)',
  );
}

// ── the filter value grammar ────────────────────────────────────────────────────────────────────────────────────────────
console.log('CSS filter value grammar');
const valid = [
  'none',
  'blur(3px)',
  'blur()',
  'blur(0)',
  'blur(0.2em)',
  'brightness(150%)',
  'brightness(1.5)',
  'contrast(.5)',
  'grayscale()',
  'grayscale(2)',
  'hue-rotate(90deg)',
  'hue-rotate(0.25turn)',
  'hue-rotate(1rad)',
  'hue-rotate(100grad)',
  'hue-rotate(0)',
  'invert(50%)',
  'opacity(.3)',
  'saturate(300%)',
  'sepia(1)',
  'drop-shadow(2px 3px)',
  'drop-shadow(2px 3px 4px)',
  'drop-shadow(red 2px 3px)',
  'drop-shadow(2px 3px 4px rgb(0 0 255 / .5))',
  'drop-shadow(2px 3px currentColor)',
  'url(#a)',
  'url(#a) url(#b)',
  'blur(2px) url(#a) grayscale(1)',
  'blur(2px)grayscale(1)',
  'url("#a")',
  'blur(calc(1px + 2px))',
];
const invalid = [
  '',
  'blur(3)',
  'blur(-1px)',
  'blur(10%)',
  'brightness(-1)',
  'brightness(red)',
  'hue-rotate(90)',
  'hue-rotate(10px)',
  'drop-shadow(2px)',
  'drop-shadow()',
  'drop-shadow(red blue 2px 3px)',
  'drop-shadow(2px 3px -1px)',
  'drop-shadow(2px red 3px)',
  'foo(1)',
  'blur(2px',
  'blur(2px) foo',
  'grayscale(1, 2)',
  'saturate(none)',
  'alpha(opacity=50)',
];
for (const v of valid) ok(scanFilterList(v) !== null, `valid: ${v}`);
for (const v of invalid) ok(scanFilterList(v) === null, `invalid: ${v || '(empty)'}`);
{
  const env = {
    len: (t) => (t === '0' ? 0 : t.endsWith('em') ? parseFloat(t) * 20 : parseFloat(t)),
    colorStr: (t) => (t.toLowerCase() === 'currentcolor' ? 'rgba(0,128,0,1)' : t),
  };
  ok(
    canonicalFilter(
      scanFilterList('blur(0.5em) brightness(150%) hue-rotate(.25turn) drop-shadow(red 2px 3px)'),
      env,
    ) === 'blur(10px) brightness(1.5) hue-rotate(90deg) drop-shadow(red 2px 3px)',
    'canonical: em and % and turns resolved: ' +
      canonicalFilter(
        scanFilterList('blur(0.5em) brightness(150%) hue-rotate(.25turn) drop-shadow(red 2px 3px)'),
        env,
      ),
  );
  ok(
    canonicalFilter(scanFilterList('drop-shadow(1px 2px)'), env) ===
      'drop-shadow(rgba(0,128,0,1) 1px 2px)',
    'canonical: the missing color is currentColor',
  );
  const gr = (t) =>
    filterListGraph(scanFilterList(t), { color: () => [0, 0, 1, 1], urlGraph: () => null }).graph;
  ok(
    types(gr('blur(3px)')).join() === 'feGaussianBlur' &&
      gr('blur(3px)').nodes[0].params.sigmaX === 3,
    'blur(r): stdDeviation r',
  );
  ok(gr('url(#nope)') === null, 'a missing url() does nothing');
  ok(
    types(gr('blur(0)')).join() === 'feGaussianBlur' &&
      gr('blur(0)').nodes[0].params.sigmaX === 0 &&
      gr('blur()').nodes[0].params.sigmaY === 0,
    'blur(0) and blur() keep a zero-sigma node, so a blur can be animated up from 0',
  );
  const ds = gr('drop-shadow(4px 5px 6px)');
  ok(
    types(ds).join() === 'feGaussianBlur,feOffset,feFlood,feComposite,feMerge' &&
      ds.nodes[0].params.sigmaX === 6 &&
      ds.nodes[1].params.dx === 4 &&
      ds.nodes[1].params.dy === 5 &&
      ds.nodes[0].inputs[0] === -2,
    'drop-shadow: the third length is the standard deviation (as Chrome); shadow of SourceAlpha under the source',
  );
  const chain = gr('grayscale(1) drop-shadow(1px 1px 2px)');
  ok(
    chain.nodes[0].inputs[0] === -1 &&
      chain.nodes[1].type === 'feColorMatrix' &&
      chain.nodes[1].inputs[0] === 0 &&
      chain.nodes[chain.rootOut].inputs[1] === 0,
    "a later stage reads the earlier one (its shadow comes from the previous result's alpha)",
  );
  const withUrl = filterListGraph(scanFilterList('blur(2px) url(#g) opacity(.5)'), {
    color: () => [0, 0, 0, 1],
    urlGraph: () => ({
      nodes: [
        { type: 'feOffset', inputs: [-1], params: { dx: 1 } },
        { type: 'feMerge', inputs: [0, -2], params: {} },
      ],
      rootOut: 1,
    }),
  }).graph;
  ok(
    withUrl.nodes.length >= 4 && withUrl.nodes[1].inputs[0] === 0,
    "a url() stage's SourceGraphic is the previous stage",
  );
  const m = (f, v) => cssColorMatrix(f, v);
  ok(
    near(m('grayscale', 1).slice(0, 3), [0.2126, 0.7152, 0.0722]),
    'grayscale(1) is the luminance row',
  );
  ok(near(m('sepia', 1).slice(0, 3), [0.393, 0.769, 0.189]), 'sepia(1) is the sepia row');
  ok(near([m('invert', 0.3)[0], m('invert', 0.3)[4]], [0.4, 0.3]), 'invert(.3): c * (1 - 2n) + n');
  ok(m('opacity', 0.4)[18] === 0.4 && m('opacity', 7)[18] === 1, 'opacity clamps at 1');
  ok(
    near(
      m('contrast', 0.5).filter((_, i) => i === 0 || i === 4),
      [0.5, 0.25],
    ),
    'contrast(.5): c * .5 + .25',
  );
  ok(
    m('grayscale', 3).every((v, i) => v === m('grayscale', 1)[i]),
    'grayscale clamps at 1',
  );
}

// ── through the importer ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('CSS filters through the importer');
{
  const b = await importSvg(doc(`<g style="filter: blur(3px) grayscale(50%)">${R()}</g>`));
  const g = graphOf(b);
  ok(
    g && types(g).join() === 'feGaussianBlur,feColorMatrix' && g.nodes[0].params.sigmaX === 3,
    'a style declaration on a group imports as a graph: ' + (g && types(g).join()),
  );
  ok(
    b.filterRegions == null || b.filterRegions.every((r) => r == null),
    'a CSS function list has no filter region (nothing clips the blur)',
  );
}
{
  const css = await importSvg(SVG_CSS),
    obb = await importSvg(SVG_OBB);
  ok(
    types(graphOf(css)).join() ===
      'feColorMatrix,feColorMatrix,feGaussianBlur,feOffset,feFlood,feComposite,feMerge' &&
      near([graphOf(obb).nodes[0].params.sigmaX, graphOf(obb).nodes[1].params.dx], [3.2, 8]),
    'the literal fixtures import: ' + types(graphOf(css)).join(),
  );
  const b = await importSvg(
    doc(`<rect x="16" y="16" width="32" height="32" filter="drop-shadow(2px 2px 2px #2060d0)"/>`),
  );
  const g = graphOf(b);
  ok(
    g &&
      types(g)[0] === 'feGaussianBlur' &&
      g.nodes[0].params.sigmaX === 2 &&
      Math.abs(g.nodes[2].params.rgba[2] - 0xd0 / 255) < 1e-6,
    'the presentation attribute on an element works: ' + (g && types(g).join()),
  );
}
{
  const b = await importSvg(doc(`<style>.s{filter:saturate(2)}</style><g class="s">${R()}</g>`));
  ok(graphOf(b) && types(graphOf(b)).join() === 'feColorMatrix', 'a stylesheet rule works');
}
{
  const b = await importSvg(
    doc(
      `<g style="color:#00ff00; font-size:20px; filter: blur(0.5em) drop-shadow(1px 1px)">${R()}</g>`,
    ),
  );
  const g = graphOf(b);
  ok(
    g &&
      g.nodes[0].params.sigmaX === 10 &&
      near(g.nodes[g.nodes.findIndex((n) => n.type === 'feFlood')].params.rgba, [0, 1, 0, 1]),
    'em and currentColor resolve against the element that wrote the value',
  );
}
{
  const b = await importSvg(doc(`<g style="filter: blur(3px); filter: foo(1)">${R()}</g>`));
  ok(
    graphOf(b) && types(graphOf(b)).join() === 'feGaussianBlur',
    'an invalid declaration is dropped and the earlier one stays',
  );
}
{
  const b = await importSvg(doc(`<g filter="blur(5)" style="filter: grayscale(1)">${R()}</g>`));
  ok(
    graphOf(b) && types(graphOf(b)).join() === 'feColorMatrix',
    'an invalid presentation attribute does not beat a valid style',
  );
  const c = await importSvg(doc(`<g filter="blur(5)">${R()}</g>`));
  ok(filterIds(c).length === 0, 'an invalid presentation attribute alone is no filter');
}
{
  const b = await importSvg(
    doc(
      `<g style="filter: blur(3px)"><rect x="8" y="8" width="20" height="20"/><rect x="34" y="34" width="20" height="20" style="filter:none"/></g>`,
    ),
  );
  ok(filterIds(b).length >= 1, 'filter:none on a child is accepted beside a filtered group');
}
{
  const b = await importSvg(
    doc(
      `<filter id="g" ${REG}><feOffset dx="6"/></filter><g filter="url(#g) blur(2px)">${R()}</g>`,
    ),
  );
  const g = graphOf(b);
  // Filter Effects 1 section 5: each stage is a filter of its own. The url() stage clips ITSELF to its region (an identity primitive that states
  // it as its subregion); the function after it is not bounded by that region.
  ok(
    g &&
      types(g).join() === 'feOffset,feOffset,feGaussianBlur' &&
      g.nodes[1].inputs[0] === 0 &&
      g.nodes[2].inputs[0] === 1,
    'url() then a function is one chain, in order, the url() stage clipped to its own region',
  );
  ok(
    g && near(g.nodes[1].params.sub, [0, 0, 64, 64]) && g.nodes[1].params.subUnits === 0,
    'the url() stage keeps its filter region as a subregion: ' +
      JSON.stringify(g && g.nodes[1].params),
  );
  ok(
    !b.filterRegions || !b.filterRegions.some((r) => r),
    'a list that ends in a function is bounded by no region of its own',
  );
}
{
  const b = await importSvg(
    doc(
      `<filter id="g" ${REG}><feOffset dx="6"/></filter><filter id="h" ${REG}><feGaussianBlur stdDeviation="2"/></filter><g filter="url(#g) url(#h)">${R()}</g>`,
    ),
  );
  const g = graphOf(b);
  ok(
    g && types(g).join() === 'feOffset,feOffset,feGaussianBlur',
    'a list of url()s chains the two filters (it imported with no filter at all), the first clipped to its region',
  );
  ok(
    b.filterRegions && b.filterRegions.some((r) => r && r[4] === 1 && r[2] === 64),
    "the last stage's region is the list's",
  );
}
{
  const before = warnings.length;
  await importSvg(
    doc(
      `<g style="filter: blur(calc(1px + 2px)) url(a.svg#f)">${R()}</g><g style="filter: blur(calc(1px + 2px)) url(a.svg#f)">${R()}</g>`,
    ),
  );
  ok(
    warnings.length - before === 1 && /cannot evaluate/.test(warnings[warnings.length - 1]),
    'a value the importer cannot evaluate warns once, and draws unfiltered: ' +
      warnings.slice(before).join(' | '),
  );
}
{
  const svg = doc(
    `<filter id="f" ${REG}><feGaussianBlur stdDeviation="3"/></filter>${R('filter="url(#f)"')}`,
  );
  const a = await importSvg(svg),
    c = await importSvg(svg);
  ok(
    a.filterTab &&
      Buffer.compare(Buffer.from(a.filterTab), Buffer.from(c.filterTab)) === 0 &&
      (a.filterGraphs || []).every((x) => x == null),
    'a plain url(#id) filter imports as it always did (single-kind, no graph)',
  );
}

console.log(fail ? `\n${fail} FAILED` : '\nfilterSubregionImportSmoke: all passed');
process.exit(fail ? 1 : 0);
