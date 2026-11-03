// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterColorSpaceImportSmoke -- color-interpolation-filters: what the importer reads (the property on the filter and on each primitive,
// inherited), which spaces the graph evaluates in (per node, per input, the tag of the result) and how many conversions that costs.
// GL-free: reads the filter graphs and the parsed records.
import { imp, wrap, makeChecker } from './_importSemantics.mjs';
import { parseFilters } from '../../src/svg/filter.js';
// (A tree without the module fails the space assertions instead of failing to load.)
const CS = await import('../../src/filterGraph/colorSpace.js').catch(() => null);
const analyzeSpaces = CS ? CS.analyzeSpaces : () => ({ any: false, op: [], out: [], root: 0 });
const countConversions = CS ? CS.countConversions : () => 0;
const convMode = CS ? CS.convMode : () => -1;

const { ok, done } = makeChecker('FILTER-COLOR-SPACE');
const R = '<rect x="10" y="10" width="40" height="40" fill="red" filter="url(#f)"/>';
const G =
  '<g filter="url(#f)"><rect x="10" y="10" width="40" height="40" fill="red"/><circle cx="40" cy="40" r="10" fill="blue"/></g>';
const graphOf = async (defs, body = G, wrapAttrs) => {
  const b = await imp(wrap(defs + body, wrapAttrs));
  return b.filterGraphs && b.filterGraphs[0];
};
const csOf = (g) => g.nodes.map((n) => (n.params && n.params.cs) | 0);
const SAT = '<feColorMatrix type="saturate" values="0.3"/>';

// ---- the property: where it is read -----------------------------------------------------------------------------------------------
ok(
  csOf(await graphOf(`<filter id="f">${SAT}</filter>`)).join() === '1',
  'no property: linearRGB, the initial value',
);
ok(
  csOf(
    await graphOf(`<filter id="f" color-interpolation-filters="sRGB">${SAT}</filter>`),
  ).join() === '0',
  'sRGB on the filter',
);
ok(
  csOf(
    await graphOf(`<filter id="f" color-interpolation-filters="linearRGB">${SAT}</filter>`),
  ).join() === '1',
  'linearRGB on the filter',
);
ok(
  csOf(
    await graphOf(`<filter id="f" color-interpolation-filters="auto">${SAT}</filter>`),
  ).join() === '0',
  'auto is sRGB (as in Chrome)',
);
ok(
  csOf(
    await graphOf(`<filter id="f" color-interpolation-filters="bogus">${SAT}</filter>`),
  ).join() === '1',
  'an invalid value is dropped: the initial value',
);
ok(
  csOf(
    await graphOf(`<filter id="f" style="color-interpolation-filters:sRGB">${SAT}</filter>`),
  ).join() === '0',
  'style attribute on the filter',
);
ok(
  csOf(
    await graphOf(
      `<style>#f{color-interpolation-filters:sRGB}</style><filter id="f">${SAT}</filter>`,
    ),
  ).join() === '0',
  'stylesheet rule on the filter',
);
ok(
  csOf(
    await graphOf(
      `<style>filter{color-interpolation-filters:sRGB}</style><filter id="f">${SAT}</filter>`,
    ),
  ).join() === '0',
  'a type rule',
);
ok(
  csOf(
    await graphOf(
      `<filter id="f" color-interpolation-filters="linearRGB">${SAT.replace('/>', ' color-interpolation-filters="sRGB"/>')}</filter>`,
    ),
  ).join() === '0',
  'a primitive overrides the filter (sRGB in linearRGB)',
);
ok(
  csOf(
    await graphOf(
      `<filter id="f" color-interpolation-filters="sRGB">${SAT.replace('/>', ' color-interpolation-filters="linearRGB"/>')}</filter>`,
    ),
  ).join() === '1',
  'a primitive overrides the filter (linearRGB in sRGB)',
);
ok(
  csOf(
    await graphOf(
      `<filter id="f" color-interpolation-filters="sRGB">${SAT.replace('/>', ' style="color-interpolation-filters:linearRGB"/>')}</filter>`,
    ),
  ).join() === '1',
  'style on a primitive',
);
ok(
  csOf(
    await graphOf(
      `<filter id="f" color-interpolation-filters="sRGB">${SAT.replace('/>', ' color-interpolation-filters="inherit"/>')}</filter>`,
    ),
  ).join() === '0',
  "inherit takes the filter's value",
);
ok(
  csOf(
    await graphOf(
      `<filter id="f">${SAT}</filter>`,
      G,
      'viewBox="0 0 100 100" color-interpolation-filters="sRGB"',
    ),
  ).join() === '0',
  'inherited from the root element',
);
ok(
  csOf(
    await graphOf(`<g style="color-interpolation-filters:sRGB"><filter id="f">${SAT}</filter></g>`),
  ).join() === '0',
  'inherited from an ancestor of the filter',
);
ok(
  csOf(
    await graphOf(
      `<filter id="f">${SAT}</filter>`,
      G.replace('<g ', '<g color-interpolation-filters="sRGB" '),
    ),
  ).join() === '1',
  "the referencing element's value is NOT inherited (the filter sits where it is defined)",
);
ok(
  csOf(
    await graphOf(
      `<filter id="f">${SAT}<feGaussianBlur stdDeviation="1" color-interpolation-filters="sRGB"/></filter>`,
    ),
  ).join() === '1,0',
  'per primitive in one filter',
);

// ---- which primitives carry it ----------------------------------------------------------------------------------------------------
{
  const g = await graphOf(
    `<filter id="f"><feFlood flood-color="red" result="a"/><feOffset in="a" dx="2"/><feTile/><feMerge><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
  );
  ok(
    csOf(g).join() === '0,0,0,1',
    `feFlood, feOffset and feTile carry nothing (a flood is sRGB data; the movers keep their input's space): ${csOf(g)}`,
  );
}
{
  const g = await graphOf(
    `<filter id="f"><feDropShadow dx="2" dy="2" stdDeviation="1" flood-color="red"/></filter>`,
  );
  ok(
    g.nodes.map((n) => n.type + (n.params.cs ? ':lin' : '')).join() ===
      'feGaussianBlur:lin,feOffset,feFlood,feComposite:lin,feMerge:lin',
    'feDropShadow: its blur, composite and merge are linear (the flood is sRGB data)',
  );
}

// ---- which route a filter takes ---------------------------------------------------------------------------------------------------
const routeOf = (prims, attrs = '') => {
  const doc = new DOMParser().parseFromString(
    wrap(`<filter id="f" ${attrs}>${prims}</filter>`),
    'image/svg+xml',
  );
  const f = parseFilters(doc.documentElement, null);
  return (f && f.f && f.f.kind) || 'none';
};
const S = 'color-interpolation-filters="sRGB"';
ok(
  routeOf('<feGaussianBlur stdDeviation="3"/>', S) === 'blur',
  'a blur of the source in sRGB keeps the single-kind record',
);
ok(
  routeOf('<feGaussianBlur stdDeviation="3"/>') === 'blur',
  'a blur of the source in linearRGB is the single-kind blur on linear light',
);
ok(
  routeOf('<feGaussianBlur in="SourceAlpha" stdDeviation="3"/>') === 'blur',
  'a blur of the source ALPHA keeps the record in linearRGB (no color to mix)',
);
ok(
  routeOf('<feColorMatrix in="SourceAlpha" type="saturate" values="0"/>') === 'colorMatrix',
  'a matrix on the alpha that makes no color keeps the record',
);
ok(
  routeOf('<feColorMatrix type="saturate" values="0.3"/>') === 'graph',
  'saturate in linearRGB takes the graph',
);
ok(
  routeOf('<feColorMatrix type="saturate" values="0.3"/>', S) !== 'graph',
  'saturate in sRGB keeps the record',
);
ok(
  routeOf('<feColorMatrix type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 .5 0"/>') !==
    'graph',
  'an alpha-only matrix is the same in either space',
);
ok(
  routeOf('<feColorMatrix type="luminanceToAlpha"/>') === 'graph',
  'luminanceToAlpha reads color: graph',
);
ok(
  routeOf(
    '<feFlood flood-color="black" flood-opacity=".5" result="r"/><feComposite in="r" in2="SourceGraphic" operator="in"/>',
  ) === 'colorMatrix',
  'the tint idiom (a black flood) is the same in either space',
);
ok(routeOf('<feMorphology radius="2"/>') === 'graph', 'feMorphology in linearRGB takes the graph');
ok(
  routeOf('<feMorphology radius="2"/>', S) === 'morphology',
  'feMorphology in sRGB keeps its record',
);
ok(
  routeOf('<feConvolveMatrix order="3" kernelMatrix="0 0 0 0 1 0 0 0 0"/>') === 'graph',
  'feConvolveMatrix in linearRGB takes the graph',
);
ok(
  routeOf('<feDropShadow dx="1" dy="1" stdDeviation="1"/>', S) === 'graph',
  'feDropShadow is always a graph',
);

// ---- CSS filter functions are sRGB ------------------------------------------------------------------------------------------------
for (const f of [
  'blur(3px)',
  'grayscale(.5)',
  'hue-rotate(90deg) saturate(.5)',
  'drop-shadow(2px 2px 1px red)',
  'brightness(.5) contrast(2) invert(.2) sepia(.3) opacity(.5)',
]) {
  const b = await imp(
    wrap(`<g style="filter:${f}"><rect x="10" y="10" width="40" height="40" fill="red"/></g>`),
  );
  const g = b.filterGraphs && b.filterGraphs[0];
  ok(
    g && g.nodes.length && !csOf(g).some((c) => c) && countConversions(g) === 0,
    `filter: ${f} compiles to sRGB primitives with no conversion`,
  );
}
{
  const b = await imp(
    wrap(
      `<filter id="u">${SAT}</filter><g style="filter:url(#u) blur(2px)"><rect x="10" y="10" width="40" height="40" fill="red"/></g>`,
    ),
  );
  const g = b.filterGraphs && b.filterGraphs[0];
  ok(
    g && csOf(g).join() === '1,0',
    `url() keeps its own filter's space, the function stays sRGB: ${g && csOf(g)}`,
  );
}

// ---- spaces and conversion counts -------------------------------------------------------------------------------------------------
const G1 = (inner, attrs = '') => graphOf(`<filter id="f" ${attrs}>${inner}</filter>`);
{
  const g = await G1(
    `${SAT}<feGaussianBlur stdDeviation="2"/><feComponentTransfer><feFuncA type="linear" slope=".8"/></feComponentTransfer>`,
  );
  const a = analyzeSpaces(g);
  ok(
    a.any && Array.from(a.op).join() === '1,1,1' && Array.from(a.out).join() === '1,1,1',
    'three linear primitives are linear nodes',
  );
  ok(
    countConversions(g) === 2,
    `a chain of linear primitives converts once in and once out (${countConversions(g)})`,
  );
}
{
  const g = await G1(`${SAT}<feGaussianBlur stdDeviation="2"/>`, S);
  ok(!analyzeSpaces(g).any && countConversions(g) === 0, 'sRGB: no conversion at all');
}
{
  const g = await G1(
    `<feGaussianBlur in="SourceAlpha" stdDeviation="2" result="b"/><feOffset in="b" dx="4" dy="4" result="o"/><feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge>`,
  );
  const a = analyzeSpaces(g);
  ok(
    Array.from(a.out).join() === '-1,-1,1',
    `the blur of SourceAlpha and its offset are colorless (${Array.from(a.out)})`,
  );
  ok(
    countConversions(g) === 2,
    `drop-shadow chain: SourceGraphic into the merge, and the result out (${countConversions(g)})`,
  );
}
{
  const g = await G1(`<feGaussianBlur in="SourceAlpha" stdDeviation="2"/>`);
  ok(
    countConversions(g) === 0 && analyzeSpaces(g).root === 0,
    'a colorless result needs no conversion out',
  );
}
{
  const g = await G1(`<feOffset dx="3" dy="2"/><feColorMatrix type="saturate" values="0.3"/>`);
  const a = analyzeSpaces(g);
  ok(a.out[0] === 0 && a.op[0] === 0, "feOffset of the source keeps the source's sRGB");
  ok(
    countConversions(g) === 2,
    `offset then a linear matrix: one in, one out (${countConversions(g)})`,
  );
}
{
  const g = await G1(
    `${SAT.replace('/>', ' color-interpolation-filters="sRGB"/>')}<feColorMatrix type="hueRotate" values="90"/>`,
  );
  ok(
    Array.from(analyzeSpaces(g).out).join() === '0,0' && countConversions(g) === 2,
    `sRGB then linear: convert in at the change, the root matrix writes sRGB (${countConversions(g)})`,
  );
}
{
  const g = await G1(
    `<feColorMatrix type="hueRotate" values="90"/>${SAT.replace('/>', ' color-interpolation-filters="sRGB"/>')}`,
  );
  ok(
    Array.from(analyzeSpaces(g).out).join() === '0,0' && countConversions(g) === 2,
    `linear then sRGB: the first matrix converts in and writes sRGB, the second reads it as it is (${countConversions(g)})`,
  );
}
{
  const g = await G1(
    `<feFlood flood-color="red" result="a"/><feBlend in="a" in2="SourceGraphic" mode="multiply"/>`,
  );
  ok(
    countConversions(g) === 3,
    `flood (sRGB data) multiply source in linear: both in, the result out (${countConversions(g)})`,
  );
}
{
  const g = await G1(
    `<feTurbulence baseFrequency=".05" result="m"/><feDisplacementMap in="SourceGraphic" in2="m" scale="5"/>`,
  );
  const a = analyzeSpaces(g);
  ok(
    Array.from(a.out).join() === '1,0' && countConversions(g) === 0,
    `displacement: the map is linear, the displaced image keeps its space, nothing converts (${countConversions(g)})`,
  );
}
{
  const g = await G1(`<feTurbulence baseFrequency=".05"/>`);
  ok(
    analyzeSpaces(g).root === 1 && countConversions(g) === 1,
    'a lone turbulence is linear light: converted once on the way out',
  );
}
{
  const g = await G1(`<feImage href="data:image/png;base64,iVBORw0KGgo="/>`);
  ok(countConversions(g) === 0 || !g, 'feImage is sRGB data');
}
ok(
  convMode(0, 1) === 1 &&
    convMode(1, 0) === 2 &&
    convMode(1, 1) === 0 &&
    convMode(-1, 1) === 0 &&
    convMode(0, -1) === 0,
  'convMode',
);

done();
