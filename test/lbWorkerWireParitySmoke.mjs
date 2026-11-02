// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbWorkerWireParitySmoke.mjs — the off-thread Loop-Blinn build must return what the main-thread build returns.
//
// Two ways it can fail, both invisible from a single build:
//   - the SDF recognizer switch is a MODULE flag, and the worker holds its own copy of the module, so the switch
//     must ride the build input or a page that turns primitives off still gets them from the worker. prepareBundle
//     builds on the main thread and the worker result lands later and replaces it, so which engine draws a ring
//     would depend on worker latency.
//   - the wire form must carry `prim` and `kindMask` beside {verts, vertexCount, hasBezout}: without `prim` the
//     engine tally (engineLedger.js) books primitive draws as Loop-Blinn, and without `kindMask` every worker-built
//     bundle compiles every LB kind.
// Drives the real worker module through a stand-in `self`, and the synchronous fallback that shares its pack.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { setSdfPrimitivesEnabled } = await import('../src/geom/shapeRecognize.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// A ring from four quarter arcs outside and four inside, wound opposite.
function ring(cx, cy, R, r) {
  const o =
    `M${cx} ${cy - R} A${R} ${R} 0 0 0 ${cx - R} ${cy} A${R} ${R} 0 0 0 ${cx} ${cy + R} ` +
    `A${R} ${R} 0 0 0 ${cx + R} ${cy} A${R} ${R} 0 0 0 ${cx} ${cy - R} Z`;
  const i =
    `M${cx} ${cy - r} A${r} ${r} 0 0 1 ${cx + r} ${cy} A${r} ${r} 0 0 1 ${cx} ${cy + r} ` +
    `A${r} ${r} 0 0 1 ${cx - r} ${cy} A${r} ${r} 0 0 1 ${cx} ${cy - r} Z`;
  return `<path fill="#77f" d="${o} ${i}"/>`;
}
// Shape 0: a thin ring (Slug when not recognized). Shape 1: a thick ring (a Loop-Blinn mesh when not recognized).
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 250">${ring(125, 125, 100, 90)}${ring(375, 125, 100, 76)}</svg>`;
const sec = await importSvg(svg, { preserveViewport: true });
const pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const desc = (packed) =>
  packed
    .map((p) => (p ? `${p.vertexCount}v${p.prim ? '/prim' : ''}/k${p.kindMask}` : 'slug'))
    .join(' ');

let posted = null;
globalThis.self = {
  postMessage: (m) => {
    posted = m;
  },
};
await import('../src/renderer/lbBuild.worker.js');
const viaWorker = (sdfPrimsOff) => {
  posted = null;
  globalThis.self.onmessage({
    data: {
      id: 1,
      curves: new Float32Array(sec.curves),
      meta: pm.metaFloats,
      metaFloatsPerShape: pm.floatsPerShape,
      ranges: sec.curveRangesByShape,
      numShapes: sec.numShapes,
      sdfPrimsOff,
    },
  });
  return posted.packed;
};

const on = viaWorker(false);
console.log('  worker, primitives on :', desc(on));
ok(
  on.length === 2 && on.every((p) => p && p.prim === true && p.vertexCount === 6),
  'primitives on: both rings come back as primitives, flagged prim on the wire',
);
ok(
  on.every((p) => p && p.kindMask > 0),
  'primitives on: the kind mask crosses the wire',
);

const off = viaWorker(true);
console.log('  worker, primitives off:', desc(off));
ok(off[0] === null, 'primitives off reaches the worker: the thin ring is not recognized (Slug)');
ok(
  !!off[1] && off[1].prim === false && off[1].vertexCount > 6 && off[1].kindMask > 0,
  'primitives off: the thick ring is a Loop-Blinn mesh with its real kind mask',
);

// The synchronous fallback (no Worker here) packs through the same function and reads the page's switch directly.
const { requestLbBuild } = await import('../src/renderer/lbWorkerPool.js');
setSdfPrimitivesEnabled(false);
const bundle = {
  curveFloats: new Float32Array(sec.curves),
  metaFloats: pm.metaFloats,
  metaFloatsPerShape: pm.floatsPerShape,
  curveRangesByShape: sec.curveRangesByShape,
  numShapes: sec.numShapes,
};
const sync = await new Promise((resolve) => requestLbBuild(bundle, resolve));
console.log('  sync fallback, off    :', desc(sync.packed));
ok(desc(sync.packed) === desc(off), 'the sync fallback returns exactly what the worker returns');
setSdfPrimitivesEnabled(true);

console.log(fail ? `lbWorkerWireParitySmoke: FAIL (${fail})` : 'lbWorkerWireParitySmoke: PASS');
process.exit(fail ? 1 : 0);
