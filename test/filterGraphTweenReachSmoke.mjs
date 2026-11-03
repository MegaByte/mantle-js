// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterGraphTweenReachSmoke — a filter-parameter write on a GRAPH node reaches the thing that
// draws it.
//
// `test/filterParamTweenSmoke.mjs` pins the WRITE side: which parameters are writable, where the
// value lands, and the copy-on-write that keeps one bundle's tween out of another's picture.
// `probes/apiGaps/filterParamTween.mjs` measures the pixels: its A1 case (a lone feGaussianBlur,
// the packed-float route) moves 43,772 px at max delta 110, and A3/A4 — the same tween through a
// drop shadow's GRAPH node — must move too, not stay at 0 with the write token bumped and the value
// sitting in `bundle.filterGraphs[0].nodes[0].params`.
//
// THE MECHANISM, and why every cache key carrying `_filterParamGen` is not enough. The unified fill route builds a per-bundle stream (`bundle._unifiedFill`) and keeps
// it across frames; it is rebuilt only when the GEOMETRY generation (or the pick / adopt /
// transform key) moves. Each offscreen-filtered entry rides that cache as an isolation job; a
// job that held the GRAPH OBJECT, captured when the stream was built, would go stale. A filter parameter moves
// none of those keys — and it does not mutate the graph either: `createFilterParams` takes a
// private copy of the graph and the touched node first (claimFilter shares one graph object
// across every use of a `<filter>` id, and a morph shares its source bundle's, so writing
// through the shared one would change somebody else's picture) and replaces
// `bundle.filterGraphs[i]` with the copy. So a captured job would point at the PRE-WRITE graph
// for the life of the bundle, and the filter-result cache, doing exactly its job — its key
// carries the token, so it misses and re-evaluates — would re-evaluate the stale numbers. So the
// job names the graph by ID and the draw resolves it live (entryFilterGraph).
//
// The packed-float route does not have this: `filterRecord` re-reads `bundle.lastFilterFloats`
// every frame, which is why A1 works. renderer.js's classic drawList loop does not either: it
// looks the graph up live, every frame.
//
// WHAT IS PINNED HERE, with no GPU: the whole chain except the pixels — a real imported
// feDropShadow graph, the real `entryFilterOf` that builds the job, a real `createFilterParams`
// write, and the real `entryFilterGraph` the draw resolves through. The pixels are the probe.
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
const uni = await import('../src/renderer/unifiedFillDraw.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = (rel) => readFileSync(path.join(HERE, '..', 'src', rel), 'utf8');
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// The probe's own GRAPH scene: feDropShadow expands to blur -> offset -> flood -> composite ->
// merge, so node 0 is the sigma A3 tweens and node 1 the dx/dy A4 tweens.
const RECT = '<rect x="120" y="120" width="160" height="160" fill="#1b3a6b" filter="url(#f)"/>';
const GRAPH =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs>' +
  '<filter id="f" x="-60%" y="-60%" width="220%" height="220%">' +
  '<feDropShadow dx="3" dy="4" stdDeviation="2" flood-color="#000"/></filter>' +
  '</defs>' +
  RECT +
  '</svg>';
const SINGLE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs>' +
  '<filter id="f" x="-60%" y="-60%" width="220%" height="220%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="2"/></filter>' +
  '</defs>' +
  RECT +
  '</svg>';

/// Exactly what createBundle keeps on the CPU side for filters (bundle.js:380-387).
async function bundleOf(svg) {
  const s = await importSvg(svg, {});
  return {
    filterGraphs: s.filterGraphs || null,
    lastFilterFloats: s.filterTab && s.filterTab.byteLength ? new Float32Array(s.filterTab) : null,
  };
}

// ===========================================================================
console.log('\n-- the two helpers the unified route dispatches and resolves through --');
ok(
  typeof uni.entryFilterOf === 'function',
  'unifiedFillDraw exports entryFilterOf — the isolation job a stream entry carries',
);
ok(
  typeof uni.entryFilterGraph === 'function',
  'unifiedFillDraw exports entryFilterGraph — the LIVE resolve the draw goes through',
);
if (typeof uni.entryFilterGraph !== 'function') {
  console.log(
    '\nFAIL — the draw resolves the graph from whatever the stream captured, which is the defect',
  );
  process.exit(1);
}

// ===========================================================================
console.log('\n-- a graph tween reaches the job the cached stream is holding --');
{
  const b = await bundleOf(GRAPH);
  ok(
    Array.isArray(b.filterGraphs) && b.filterGraphs[0] && b.filterGraphs[0].nodes.length === 5,
    `feDropShadow imports as a 5-node graph (${b.filterGraphs[0].nodes.map((n) => n.type).join(',')})`,
  );

  // buildDrawList sets filterGraphId INSTEAD of filterId for a graph op (bundle.js:178).
  const job = uni.entryFilterOf(
    b,
    { kind: 'fillShape', shapeIdx: 0, filterGraphId: 1 },
    () => null,
  );
  ok(
    !!job && job.filterId === 1 && job.graphId === 1,
    `the job names the graph by ID, which is what survives a copy-on-write (${JSON.stringify({ ...job, graph: '…' })})`,
  );
  const captured = job.graph;
  ok(captured === b.filterGraphs[0], "and the build-time object is the bundle's graph, for now");

  const fp = createFilterParams(b);
  ok(
    fp.set('f1:0', { sigmaX: 10, sigmaY: 10 }) === true && (b._filterParamGen | 0) === 1,
    'the sigma write lands and bumps the token every filter cache key carries',
  );

  // THE MECHANISM, stated as an assertion rather than as prose: the write forked the graph.
  ok(
    b.filterGraphs[0] !== captured,
    'the write REPLACED the graph object (copy-on-write) — the captured one is now a stale copy',
  );
  ok(
    captured.nodes[0].params.sigmaX === 2,
    '...and it still reads the imported sigma, which would be 0 pixels moved in A3',
  );

  const live = uni.entryFilterGraph(b, job);
  ok(
    live === b.filterGraphs[0] && live.nodes[0].params.sigmaX === 10,
    'entryFilterGraph resolves the job against the bundle NOW, so the draw sees sigma 10',
  );

  // A4: the same one node down, on feOffset.
  ok(fp.set('f1:1', { dx: 14, dy: 16 }) === true, 'the feOffset write lands too');
  const live2 = uni.entryFilterGraph(b, job);
  ok(
    live2.nodes[1].params.dx === 14 && live2.nodes[1].params.dy === 16,
    "and the draw sees dx/dy 14,16 — A4's tween",
  );
  ok(
    job.graph.nodes[1].params.dx === 3,
    'while the captured object still says 3, so this is a resolve and not a mutation in disguise',
  );

  // reset() is a write like any other, and must reach the draw the same way.
  fp.reset();
  const live3 = uni.entryFilterGraph(b, job);
  ok(
    live3.nodes[0].params.sigmaX === 2 && live3.nodes[1].params.dx === 3,
    "reset() returns the DRAWN graph to the imported numbers, not just the bundle's",
  );
}

// ===========================================================================
console.log('\n-- the packed-float route is unchanged: no graph, no id, re-read every frame --');
{
  const b = await bundleOf(SINGLE);
  ok(b.filterGraphs === null, 'a lone blur takes the packed-float route (no graph at all)');
  const rec = { kind: 1 };
  const job = uni.entryFilterOf(b, { kind: 'fillShape', shapeIdx: 0, filterId: 1 }, () => rec);
  ok(
    !!job && job.filterId === 1 && (job.graphId | 0) === 0 && job.graph === null,
    'its job carries no graph and no graph id',
  );
  ok(
    uni.entryFilterGraph(b, job) === null,
    'so the resolve answers null and _morphShapeFilter takes the single-kind branch, as before',
  );
  ok(uni.entryFilterGraph(b, null) === null, 'and an op with no filter at all resolves to nothing');
  // kind 0 is a color matrix the ubershader applies inline — no offscreen pass, no job.
  ok(
    uni.entryFilterOf(b, { filterId: 1 }, () => ({ kind: 0 })) === null,
    'a color matrix still needs no isolation',
  );
}

// ===========================================================================
console.log('\n-- the last-resort floor, and that the draw goes through the resolver --');
{
  const b = await bundleOf(GRAPH);
  const job = uni.entryFilterOf(b, { filterGraphId: 1 }, () => null);
  const g0 = b.filterGraphs[0];
  b.filterGraphs = null;
  ok(
    uni.entryFilterGraph(b, job) === g0,
    'a bundle that lost its filterGraphs degrades to the picture it had, not to the single-kind branch',
  );

  const src = SRC('renderer/unifiedFillDraw.js');
  ok(
    /const fGraph = entryFilterGraph\(bundle, f\);/.test(src) &&
      /_morphShapeFilter\(\s*bundle,\s*spanS\[i\],\s*f\.filterId,\s*fGraph,/.test(src),
    'the draw site resolves through entryFilterGraph rather than reading the cached object',
  );
  ok(
    !/_morphShapeFilter\([^)]*f\.graph[,)]/.test(src),
    'and nothing hands _morphShapeFilter the captured graph directly any more',
  );
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
