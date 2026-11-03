// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Filter parameter mutation, reset, generation changes and shared-source isolation.
// Pixel and morph isolation are covered by morphRouteSmoke's morphFilterGraphRoute case.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { createFilterParams } = await import('../src/animation/filterParams.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = (rel) => readFileSync(path.join(HERE, '..', 'src', rel), 'utf8');
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const doc = (defs, attr = 'filter="url(#f)"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${defs}</defs>` +
  `<rect x="10" y="10" width="50" height="50" fill="red" ${attr}/></svg>`;

/// Exactly what createBundle keeps on the CPU side for filters.
async function bundleOf(svg) {
  const s = await importSvg(svg, {});
  return {
    filterGraphs: s.filterGraphs || null,
    lastFilterFloats: s.filterTab && s.filterTab.byteLength ? new Float32Array(s.filterTab) : null,
  };
}

// Alpha-coupled matrices require unscaled SourceGraphic and post-filter opacity.
for (const [name, values] of Object.entries({
  bias: '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 .2',
  amplify: '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 2 0',
  rgbAlpha: '1 0 0 1 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0',
})) {
  const b = await bundleOf(
    doc(
      `<filter id="f" color-interpolation-filters="sRGB"><feColorMatrix values="${values}"/></filter>`,
    ),
  );
  ok(b.filterGraphs?.[0]?.nodes[0]?.type === 'feColorMatrix', `${name} uses graph evaluation`);
}
{
  const b = await bundleOf(
    doc(
      '<filter id="f" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values=".5"/></filter>',
    ),
  );
  ok(b.filterGraphs === null, 'ordinary saturation retains inline evaluation');
}

// ===========================================================================
console.log('\n-- single-primitive route: a lone feGaussianBlur --');
{
  const b = await bundleOf(
    doc(
      '<filter id="f" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="3"/></filter>',
    ),
  );
  ok(b.filterGraphs === null, 'a lone blur takes the packed-float route, not the graph route');
  const fp = createFilterParams(b);
  ok(
    fp.targets.length === 1 && fp.targets[0].id === 'f1' && fp.targets[0].type === 'blur',
    `one target, addressed 'f1' (${JSON.stringify(fp.targets.map((t) => t.id + ':' + t.type))})`,
  );
  ok(
    JSON.stringify(fp.targets[0].tweenable) === '["sigmaX","sigmaY"]',
    'sigmaX and sigmaY are the tweenable pair',
  );
  ok(
    !!fp.targets[0].note &&
      /zero sigma/.test(fp.targets[0].note) &&
      /up from 0/.test(fp.targets[0].note),
    'the target states that a zero-sigma blur keeps its node',
  );
  const g0 = fp.get('f1');
  ok(g0.sigmaX === 3 && g0.sigmaY === 3, `imported sigma reads back (${JSON.stringify(g0)})`);

  ok((b._filterParamGen | 0) === 0, 'an untouched bundle carries no write token');
  ok(fp.set('f1', { sigmaX: 7 }) === true, 'set reports the write');
  ok(
    b.lastFilterFloats[21] === 7 && b.lastFilterFloats[22] === 3,
    'the float the draw path re-reads every frame is the one that moved (and only it)',
  );
  ok(b._filterParamGen === 1 && fp.generation === 1, 'the write token bumped exactly once');

  ok(
    fp.set('f1', { sigmaX: 7 }) === false && b._filterParamGen === 1,
    'writing the same value is not a write — a per-frame poll cannot churn the caches',
  );
  ok(fp.set('f1', { sigmaY: 'wide' }) === false, 'a non-number is refused, not coerced');
  ok(
    fp.set('nope', { sigmaX: 1 }) === false && fp.set('f1', null) === false,
    'an unknown id and a null patch are no-ops',
  );

  fp.reset();
  ok(fp.get('f1').sigmaX === 3, 'reset restores the imported value');
  ok(b._filterParamGen === 2, 'and reset is itself a write, so the caches see it');
  ok(
    fp.set('f1', { sigmaX: 0.1 }) && !fp.set('f1', { sigmaX: 0.1 }),
    'repeated decimals compare against the effective float32 value',
  );
  ok(
    !fp.set('f1', { sigmaX: Number.MAX_VALUE }) && Number.isFinite(fp.get('f1').sigmaX),
    'values that overflow float32 leave the parameter unchanged',
  );
}

// ===========================================================================
console.log('\n-- graph route: blur -> offset -> composite --');
{
  const b = await bundleOf(
    doc(
      '<filter id="f" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="3" result="bl"/>' +
        '<feOffset in="bl" dx="4" dy="5" result="o"/>' +
        '<feComposite in="SourceGraphic" in2="o" operator="over"/></filter>',
    ),
  );
  ok(
    Array.isArray(b.filterGraphs) && b.filterGraphs[0].nodes.length === 3,
    'a multi-primitive filter is a graph of 3 nodes',
  );
  const fp = createFilterParams(b);
  ok(
    fp.targets.map((t) => t.type).join(',') === 'feGaussianBlur,feOffset,feComposite',
    `targets follow the graph's node order (${fp.targets.map((t) => t.id).join(' ')})`,
  );
  ok(fp.get('f1:1').dx === 4 && fp.get('f1:1').dy === 5, 'feOffset reads back its dx/dy');

  ok(fp.set('f1:0', { sigmaX: 9, sigmaY: 9 }), 'the graph blur takes a write');
  ok(
    b.filterGraphs[0].nodes[0].params.sigmaX === 9,
    'the value lands where evaluateGraph reads it (node.params)',
  );
  ok(b._filterParamGen === 1, 'one write, one token bump');

  // Array-valued parameters: feComposite's k1..k4.
  ok(fp.set('f1:2', { k: [0.5, 0.25, 0, 1] }), 'an array parameter takes a write');
  const k = fp.get('f1:2').k;
  ok(k.length === 4 && k[0] === 0.5 && k[3] === 1, `k1..k4 read back (${k})`);
  k[0] = 99;
  ok(
    b.filterGraphs[0].nodes[2].params.k[0] === 0.5,
    'get() hands back a COPY — mutating it cannot reach the bundle behind the API',
  );
  ok(
    fp.set('f1:2', { k: [0.5, 0.25, 0, 1] }) === false,
    'an array write that changes nothing is not a write either',
  );
}

// ===========================================================================
console.log('\n-- copy-on-write: one <filter> id, and a morph, share ONE graph object --');
{
  // importWalk's claimFilter shallow-copies the record, so every use of a
  // <filter> shares its graph; morphCore forwards filterGraphs by slice, so a
  // morph shares its source's. Writing straight through either would change
  // another bundle's picture. Simulate both by aliasing the graph object.
  const a = await bundleOf(
    doc(
      '<filter id="f" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="3" result="bl"/>' +
        '<feOffset in="bl" dx="4" dy="5"/></filter>',
    ),
  );
  const peer = { filterGraphs: a.filterGraphs.slice(), lastFilterFloats: a.lastFilterFloats };
  ok(peer.filterGraphs[0] === a.filterGraphs[0], 'the two bundles start on the SAME graph object');

  const fp = createFilterParams(a);
  fp.set('f1:0', { sigmaX: 11 });
  ok(
    peer.filterGraphs[0].nodes[0].params.sigmaX === 3,
    "the peer's blur is untouched — the write forked the graph instead of editing it in place",
  );
  ok(
    a.filterGraphs[0] !== peer.filterGraphs[0] && a.filterGraphs[0].nodes[0].params.sigmaX === 11,
    'the written bundle owns a private graph with the new value',
  );
  ok(
    a.filterGraphs[0].nodes[1] === peer.filterGraphs[0].nodes[1],
    'only the node that was written is copied; the rest of the graph stays shared',
  );

  // A write that changes nothing must not fork — otherwise a per-frame poll
  // allocates a graph copy every frame for no reason.
  const b2 = await bundleOf(
    doc(
      '<filter id="f" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="3" result="bl"/>' +
        '<feOffset in="bl" dx="4" dy="5"/></filter>',
    ),
  );
  const node0 = b2.filterGraphs[0].nodes[0];
  createFilterParams(b2).set('f1:0', { sigmaX: 3, sigmaY: 3 });
  ok(b2.filterGraphs[0].nodes[0] === node0, 'a no-op write does not fork the graph');
}

// Typed parameter vectors retain their representation without aliasing.
{
  const matrix = new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]);
  const graph = { nodes: [{ type: 'feColorMatrix', params: { matrix } }] };
  const b = { filterGraphs: [graph] };
  const fp = createFilterParams(b);
  const blue = matrix.slice();
  blue[0] = 0;
  blue[4] = 1;
  fp.set('f1:0', { matrix: blue });
  const written = b.filterGraphs[0].nodes[0].params.matrix;
  ok(
    written instanceof Float32Array && written !== matrix && matrix[0] === 1,
    'typed vector writes allocate private storage of the original type',
  );
  const decimal = Array.from(written);
  decimal[4] = 0.1;
  ok(
    fp.set('f1:0', { matrix: decimal }) && !fp.set('f1:0', { matrix: decimal }),
    'typed graph vectors also ignore repeated effective float32 values',
  );
}

// Shared import sections and morph sources must remain unchanged for vector
// writes, repeated writes, and independent parameter controllers.
{
  const a = await bundleOf(
    doc(
      '<filter id="f" color-interpolation-filters="sRGB"><feDropShadow stdDeviation="2"/></filter>',
    ),
  );
  const source = a.filterGraphs;
  const peer = { filterGraphs: source.slice(), lastFilterFloats: a.lastFilterFloats };
  const fp = createFilterParams(a),
    other = createFilterParams(a);
  const original = Array.from(source[0].nodes[2].params.rgba);
  fp.set('f1:2', { rgba: [0, 0, 1, 0.5] });
  ok(
    JSON.stringify(source[0].nodes[2].params.rgba) === JSON.stringify(original),
    'vector writes preserve the imported graph and its parameter arrays',
  );
  const laterPeer = { filterGraphs: a.filterGraphs.slice() };
  other.set('f1:2', { rgba: [0, 1, 0, 0.5] });
  ok(
    laterPeer.filterGraphs[0].nodes[2].params.rgba[2] === 1,
    'a later controller preserves graphs already shared with another bundle',
  );
  fp.reset();
  ok(
    JSON.stringify(peer.filterGraphs[0].nodes[2].params.rgba) === JSON.stringify(original),
    'reset leaves the source and peer filter untouched',
  );
}
{
  const a = await bundleOf(
    doc(
      '<filter id="f" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="3"/></filter>',
    ),
  );
  const peer = { lastFilterFloats: a.lastFilterFloats };
  const fp = createFilterParams(a),
    other = createFilterParams(a);
  fp.set('f1', { sigmaX: 9 });
  ok(peer.lastFilterFloats[21] === 3, 'packed parameter writes preserve shared import storage');
  other.set('f1', { sigmaY: 7 });
  ok(
    fp.get('f1').sigmaY === 7 && other.get('f1').sigmaX === 9,
    'independent controllers read the current bundle parameter plane',
  );
  fp.reset();
  ok(
    other.get('f1').sigmaX === 3 && other.get('f1').sigmaY === 3,
    'reset is visible through every controller',
  );
}

// ===========================================================================
console.log('\n-- what is deliberately NOT tweenable says so --');
{
  const b = await bundleOf(
    doc(
      '<filter id="f" color-interpolation-filters="sRGB">' +
        '<feComponentTransfer><feFuncR type="linear" slope="2" intercept="0"/></feComponentTransfer>' +
        '<feTile/></filter>',
    ),
  );
  const fp = createFilterParams(b);
  const byType = Object.fromEntries(fp.targets.map((t) => [t.type, t]));
  for (const t of ['feComponentTransfer', 'feTile']) {
    ok(
      byType[t] && byType[t].tweenable.length === 0 && !!byType[t].notTweenable,
      `${t} is listed with no tweenable parameters and a stated reason`,
    );
  }
  ok(
    /LUT/.test((byType.feComponentTransfer || {}).notTweenable || ''),
    'feComponentTransfer names the baked LUT as the reason',
  );
  ok(fp.set(byType.feTile.id, { anything: 1 }) === false, 'and a write to one of them is refused');
}
{
  // feDropShadow desugars to five primitives; its blur and its offset are both
  // tweenable, which is the common "animate a shadow" case.
  const b = await bundleOf(
    doc(
      '<filter id="f" color-interpolation-filters="sRGB"><feDropShadow dx="3" dy="4" stdDeviation="2"/></filter>',
    ),
  );
  const fp = createFilterParams(b);
  ok(
    fp.targets.map((t) => t.type).join(',') ===
      'feGaussianBlur,feOffset,feFlood,feComposite,feMerge',
    'feDropShadow exposes the five primitives it desugars to',
  );
  ok(
    fp.set('f1:0', { sigmaX: 6, sigmaY: 6 }) &&
      fp.set('f1:1', { dx: 10, dy: 10 }) &&
      fp.set('f1:2', { rgba: [0, 0, 1, 1] }),
    'a drop shadow can be animated in radius, offset and color',
  );
}
{
  const b = await bundleOf(
    doc(
      '<filter id="f" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="0"/></filter>',
    ),
  );
  const fp = createFilterParams(b);
  const blur = fp.targets.find((t) => t.type === 'feGaussianBlur');
  ok(
    blur && blur.tweenable.length > 0,
    'a zero blur retains its graph node, region and editable parameters',
  );
}

// ===========================================================================
console.log('\n-- the cache wiring (the half that needs a GPU to SEE) --');
{
  const fd = SRC('renderer/filterDraw.js');
  ok(
    /_filterKeyMatches[\s\S]{0,1200}c\.key\.paramGen === key\.paramGen/.test(fd),
    'the filter-result cache compares paramGen',
  );
  const rj = SRC('renderer/renderer.js');
  const n = (
    rj.match(
      /paramGen:\s*_handle\.bundle\s*\?\s*\(?_handle\.bundle\._filterParamGen \| 0\)?\s*:\s*0/g,
    ) || []
  ).length;
  ok(n === 2, `both of renderer.js's filter cache keys carry it (found ${n} of 2)`);
  ok(
    /paramGen: bundle\._filterParamGen \| 0/.test(SRC('renderer/morphDraw.js')),
    "the unified/morph route's key carries it too",
  );
  ok(
    /_drawStateHash[\s\S]{0,3000}_filterParamGen/.test(SRC('renderer/cacheDraw.js')),
    'the static cache folds it, so a cached mount re-bakes instead of blitting the stale radius',
  );
  ok(
    /new Float32Array\(sections\.filterTab\)/.test(SRC('renderer/bundle.js')),
    'createBundle still mirrors filterTab as the Float32Array this file writes through',
  );
}

// ===========================================================================
console.log('\n-- a blur authored at zero keeps its node, so it can be animated up from 0 --');
{
  const cases = {
    'lone stdDeviation 0 (sRGB)': doc(
      '<filter id="f" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="0"/></filter>',
    ),
    'lone stdDeviation 0 (linearRGB)': doc(
      '<filter id="f"><feGaussianBlur stdDeviation="0"/></filter>',
    ),
    'stdDeviation 0 then saturate': doc(
      '<filter id="f" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="0"/><feColorMatrix type="saturate" values="0.5"/></filter>',
    ),
    'CSS blur(0px)': doc('', 'style="filter:blur(0px)"'),
    'CSS blur(0px) brightness(1.2)': doc('', 'style="filter:blur(0px) brightness(1.2)"'),
  };
  for (const [name, svg] of Object.entries(cases)) {
    const b = await bundleOf(svg);
    const fp = createFilterParams(b);
    const blur = fp.targets.find((t) => t.type === 'feGaussianBlur');
    ok(
      !!blur,
      `${name}: a blur node is a target (${fp.targets.map((t) => t.id + ':' + t.type).join(' ') || 'none'})`,
    );
    if (!blur) continue;
    ok(fp.get(blur.id).sigmaX === 0, `${name}: it reads back sigma 0`);
    ok(
      fp.set(blur.id, { sigmaX: 4, sigmaY: 4 }) === true &&
        b.filterGraphs[blur.filterId - 1].nodes[blur.nodeIndex].params.sigmaX === 4,
      `${name}: it can be animated up from 0 (the node evaluateGraph reads now says 4)`,
    );
  }
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
