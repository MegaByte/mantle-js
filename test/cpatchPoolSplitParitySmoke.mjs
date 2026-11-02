// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Serial, worker-handler and encoded-bake routes must produce identical CPatch
// streams. Retain all split-positive corpus cycles, unsplit and duplicate-key
// controls, and morph split refusal. The stand-in runs the production worker
// handler with asynchronous structured-clone message boundaries.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAsset } from './_assets.mjs';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// Deliver worker messages and replies on separate tasks.
// Exercise the retained seam converter and its workers, even when static paints certify.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__CP_NO_AREA = 1;
let answered = 0;
globalThis.self = {
  postMessage: () => {
    throw new Error('stand-in worker: reply outside a message');
  },
};
await import('../src/renderer/cpatch.worker.js');
const handler = globalThis.self.onmessage;
globalThis.Worker = class {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
  }
  postMessage(msg) {
    const data = structuredClone(msg);
    setImmediate(() => {
      answered++;
      globalThis.self.postMessage = (reply) => {
        const r = structuredClone(reply);
        setImmediate(() => this.onmessage && this.onmessage({ data: r }));
      };
      try {
        handler({ data });
      } catch (ex) {
        if (this.onerror) this.onerror({ message: String(ex) });
      }
    });
  }
  terminate() {}
};

const { default: importSvg } = await import('../src/svg/importer.js');
const { headlessCPatchBundle, contoursToConverter, shapeEvenOdd, cpatchCurvePlane } =
  await import('../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { circleFromContours, ellipseFromContours } = await import('../src/geom/shapeRecognize.js');
const { packCPatchShape, cpatchConvKey, cpatchConvSettings } =
  await import('../src/renderer/cpatchPack.js');
const { encodeTraceBake, decodeTraceBake } = await import('../src/renderer/cpatchTrace.js');
const CONV = await import('../src/renderer/cpatchConvert.js');
const pool = await import('../src/renderer/cpatchWorkerPool.js');

ok(
  typeof CONV.contourSplit === 'function' &&
    typeof CONV.convertContourSplit === 'function' &&
    typeof CONV.mergeSplit === 'function',
  'the converter owns the split: contourSplit, convertContourSplit and mergeSplit',
);
if (typeof CONV.contourSplit !== 'function') {
  console.log('\nFAIL — the split is not part of the decomposition');
  process.exit(1);
}
const { contourSplit } = CONV;

/// The shapes the CPatch build converts for an asset, decoded exactly as buildCPatchBundle does.
function shapesOf(bundle) {
  const cf = cpatchCurvePlane(bundle);
  const ranges = bundle.curveRangesByShape || [];
  const out = [];
  for (let s = 0; s < ranges.length; s++) {
    const r = ranges[s];
    if (!r) continue;
    let contours = null;
    try {
      contours = curveRangeToContours(cf, r.begin, r.end);
    } catch {
      continue;
    }
    if (!contours || !contours.length) continue;
    if (circleFromContours(contours) || ellipseFromContours(contours)) continue; // a primitive draws itself
    const cs = contoursToConverter(contours, null);
    if (!cs) continue;
    out.push({ s, cs, evenOdd: shapeEvenOdd(bundle, s) });
  }
  return out;
}

/// The cycles the build's COLLECT pass hands the pool (those without holes; the rest convert on
/// the build pass, as they always have).
const cycleOwners = new WeakMap();
function cyclesOf(shapes) {
  const cc = new Map(),
    out = [];
  for (const sh of shapes) {
    const got = [];
    try {
      packCPatchShape(sh.cs, 0, { evenOdd: sh.evenOdd, collect: got, cycleCache: cc });
    } catch {
      /* the build reports it */
    }
    for (const e of got)
      if (!e.holes) {
        out.push(e.curves);
        let owners = cycleOwners.get(e.curves);
        if (!owners) cycleOwners.set(e.curves, (owners = new Set()));
        owners.add(sh.s);
      }
  }
  return out;
}

const COPTS = { maxCurves: 8, interiorN: undefined, holes: null, search: 'full' };
/// Build every shape, as buildCPatchBundle does: through one conversion map (the pooled build's, or a
/// fresh one), so a later contour of a key reuses the first one's conversion on every route.
function build(shapes, extra = {}) {
  const cc = new Map(),
    out = new Map(),
    convCache = extra.convCache || new Map();
  for (const sh of shapes) {
    let m = null;
    try {
      m = packCPatchShape(sh.cs, 0, { evenOdd: sh.evenOdd, cycleCache: cc, ...extra, convCache });
    } catch {
      m = null;
    }
    out.set(sh.s, m);
  }
  return out;
}
/// Pack with conversions returned by the production worker pool.
async function pooled(shapes, cycles) {
  const res = await pool.convertContoursPooled(cycles, COPTS);
  const convCache = new Map();
  // The FIRST contour of a key keeps it, as cpatchBuild's collect pass keeps it.
  cycles.forEach((c, i) => {
    const r = res[i],
      k = cpatchConvKey(c, null, cpatchConvSettings(COPTS));
    if (r && r.patches && !convCache.has(k)) convCache.set(k, r.patches);
  });
  return build(shapes, { convCache });
}
/// Record converter decisions, encode/decode them, and replay the bake.
function baked(shapes) {
  const traceOut = new Map(),
    ccRec = new Map();
  for (const sh of shapes) {
    try {
      packCPatchShape(sh.cs, 0, { evenOdd: sh.evenOdd, traceOut, cycleCache: ccRec });
    } catch {
      /* the build bails the same way */
    }
  }
  const traces = decodeTraceBake(encodeTraceBake(traceOut));
  const stats = {};
  return { out: build(shapes, { traces, traceStats: stats }), stats, entries: traceOut.size };
}

const sameStream = (a, b) =>
  !!a &&
  !!b &&
  a.texels.length === b.texels.length &&
  a.verts.length === b.verts.length &&
  a.texels.every((v, i) => v === b.texels[i]) &&
  a.verts.every((v, i) => v === b.verts[i]);

const ASSETS = [
  ['star', 'examples/smoke/engineDeclineIsolation__STAR.svg'],
  ['tiger', 'examples/tiger.svg'],
  ['lbMemBudget', 'examples/smoke/lbMemBudget__SVG.svg'],
  // Two contours of ONE conversion key that the search converts differently (the same arc ring
  // twice, 2e-14 apart at y = 1e5: 8 patches and 4). The first contour of a key sets it everywhere;
  // otherwise the pooled route keeps the later one's and the serial route each its own.
  ['noAaArcRow__FAR', 'examples/smoke/noAaArcRow__FAR.svg'],
];

for (const [name, rel] of ASSETS) {
  console.log(`\n-- ${name} --`);
  const svg = readFileSync(requireAsset(path.join(ROOT, rel)), 'utf8');
  const allShapes = shapesOf(headlessCPatchBundle(await importSvg(svg)));
  const allCycles = cyclesOf(allShapes);
  const fullSplit = allCycles.filter((c) => contourSplit(c, COPTS));
  let shapes = allShapes;
  if (name === 'tiger') {
    const owners = new Set(fullSplit.flatMap((c) => [...cycleOwners.get(c)]));
    const negative = allShapes.find(
      (sh) => !owners.has(sh.s) && allCycles.some((c) => cycleOwners.get(c).has(sh.s)),
    );
    if (negative) owners.add(negative.s);
    shapes = allShapes.filter((sh) => owners.has(sh.s));
  } else if (name === 'lbMemBudget') shapes = allShapes.slice(0, 3);
  const selected = new Set(shapes.map((sh) => sh.s));
  const cycles = allCycles.filter((c) => [...cycleOwners.get(c)].some((s) => selected.has(s)));
  const splitN = cycles.filter((c) => contourSplit(c, COPTS)).length;
  ok(
    splitN === fullSplit.length,
    name + ': retains every split cycle (' + splitN + '/' + fullSplit.length + ')',
  );
  ok(cycles.length > 0, name + ': selected controls reach the pool');
  console.log(
    name +
      ': selected ' +
      shapes.length +
      '/' +
      allShapes.length +
      ' shapes and ' +
      cycles.length +
      '/' +
      allCycles.length +
      ' cycles',
  );
  if (name === 'lbMemBudget' || name === 'noAaArcRow__FAR')
    ok(splitN === 0, `${name}: none of its ${cycles.length} cycles splits (the negative control)`);
  else
    ok(
      splitN > 0,
      `${name}: ${splitN} of its ${cycles.length} cycles split into their count-first pieces`,
    );

  const serial = build(shapes);
  const before = answered;
  const pool_ = await pooled(shapes, cycles);
  ok(
    answered > before,
    `${name}: the pooled arm went through the worker handler (${answered - before} messages)`,
  );
  const bake = baked(shapes);
  let sp = 0,
    sb = 0;
  for (const sh of shapes) {
    if (sameStream(serial.get(sh.s), pool_.get(sh.s))) sp++;
    if (sameStream(serial.get(sh.s), bake.out.get(sh.s))) sb++;
  }
  ok(
    sp === shapes.length,
    `${name}: the pooled build matches the serial one byte for byte, ${sp} of ${shapes.length} shapes`,
  );
  ok(sb === shapes.length, `${name}: and so does the bake replay, ${sb} of ${shapes.length}`);
  ok(
    (bake.stats.misfits | 0) === 0 && (bake.stats.misses | 0) === 0,
    `${name}: the bake covers every contour -- ${bake.entries} entries, ${bake.stats.hits | 0} hits, ` +
      `${bake.stats.misfits | 0} misfits, ${bake.stats.misses | 0} misses`,
  );

  if (name === 'star') {
    // The parity controls above exercise a nontrivial split, not an unchanged contour.
    const big = cycles.find((c) => contourSplit(c, COPTS));
    const splitPlan = contourSplit(big, COPTS);
    ok(
      splitPlan && splitPlan.pieces.length > 1,
      'the star uses multiple count-first pieces; all production routes above replay the same decomposition',
    );
    ok(
      contourSplit(big, { ...COPTS, leakMargin: 0.1 }) === null &&
        contourSplit(big, { ...COPTS, record: [] }) === null &&
        contourSplit(big, { ...COPTS, follow: [] }) === null,
      'a morph layout (leakMargin) and a morph tape (record / follow) never split',
    );
    // A retired flag cannot change the decomposition.
    globalThis.__CP_POOL_SPLIT = false;
    const forced = contourSplit(big, COPTS);
    delete globalThis.__CP_POOL_SPLIT;
    ok(!!forced, '__CP_POOL_SPLIT = false does not turn the split off');
    ok(
      typeof pool.poolSplitPieces === 'undefined',
      'the pool has no split of its own (no poolSplitPieces)',
    );
  }
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
