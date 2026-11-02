// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbBuildProfile — where does the LB mesh build actually spend its time?
//
// Motivation: relaying out cdt.js's delaunay to flat typed arrays made
// constrainedTriangulate ~2x faster (probes/_cdtRelayoutDiff.mjs) but moved the real tiger
// build only ~3% (probes/_lbBuildTime.mjs: 437ms -> 424ms). A 2x on a hot function that does
// not move the wall clock means the function is not where the wall clock is. Measure, don't
// guess: run the real build in Node and attribute self-time per module.
//
// Node-side on purpose: the same buildLbBundle the worker calls, so --cpu-prof works and there
// is no browser in the way.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Session } from 'inspector';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { buildLbBundle } = await import('../src/renderer/lbBuildCore.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(ROOT + '/examples/tiger.svg', 'utf8');

const bundle = await importSvg(svg);
// buildLbBundle's input contract mirrors what lbBuild.worker.js posts across.
// importSvg hands back raw ArrayBuffers; the renderer wraps them before posting to the worker.
// Passing the ArrayBuffer straight through makes every shape bail to Slug and the whole build
// "finish" in 0.3ms — a silent no-op that looks like a fast build.
const input = {
  // bundle.meta carries a 32-BYTE HEADER; wrapping it whole shifts every meta row by 8 floats and sends most
  // shapes down the CDT partition, so a build measured that way is 20x the real one. Strip it, as the tests do.
  curveFloats: new Float32Array(bundle.curves),
  metaFloats: bundle.meta ? new Float32Array(bundle.meta, 32) : null,
  metaFloatsPerShape: bundle.metaFloatsPerShape,
  ranges: bundle.curveRangesByShape,
  numShapes: bundle.numShapes,
};

const session = new Session();
session.connect();
const post = (m, p) =>
  new Promise((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r))));

// NO warmup, and exactly ONE build. lbPack.js keeps a module-level canonical-similarity mesh
// cache, so a second build of the same content is a cache hit that measures nothing (the first
// version of this probe warmed up twice and dutifully profiled 0.0ms of cache lookups). One
// cold build is also the honest case: the worker builds a given bundle once.

await post('Profiler.enable');
await post('Profiler.setSamplingInterval', { interval: 100 }); // 100us — fine enough to separate modules
await post('Profiler.start');
const t0 = performance.now();
buildLbBundle(input);
const built = 1;
const wall = performance.now() - t0;
const { profile } = await post('Profiler.stop');
session.disconnect();

// Attribute SELF time per source file, then roll up to the modules we care about.
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const total = profile.samples.length;
for (const s of profile.samples) {
  const n = byId.get(s);
  if (!n) continue;
  const url = n.callFrame.url || '(native)';
  const file = url.split('/').pop() || url;
  self.set(file, (self.get(file) || 0) + 1);
}
const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

console.log(
  `tiger LB build: ${wall.toFixed(1)}ms (Node, ONE cold build — the cache makes a second one meaningless)\n`,
);
console.log('  self-time by file (top 12):');
console.log('  file                          |   share');
for (const [file, cnt] of rows) {
  const pct = (cnt / total) * 100;
  const bar = '#'.repeat(Math.max(0, Math.round(pct / 2)));
  console.log(`  ${file.padEnd(29)} | ${pct.toFixed(1).padStart(5)}%  ${bar}`);
}
const share = (f) => ((self.get(f) || 0) / total) * 100;
console.log('\n  the question this probe exists to answer:');
console.log(`    cdt.js (relaid out)        ${share('cdt.js').toFixed(1)}%`);
console.log(`    predicates.js (its callee) ${share('predicates.js').toFixed(1)}%`);
console.log(`    lbInteriorSplit.js         ${share('lbInteriorSplit.js').toFixed(1)}%`);
console.log(`    lbPartition.js             ${share('lbPartition.js').toFixed(1)}%`);
console.log('\n  A 2x on cdt.js can only ever return its own share — Amdahl. If that share is');
console.log('  small, the next relayout target is whatever tops this list, not more CDT work.');
