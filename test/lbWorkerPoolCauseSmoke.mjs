// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbWorkerPoolCauseSmoke — the static build's per-shape causes survive the pool's WORKER path.
//
// A shape nobody built is not a shape that declined, so the build reports WHY each shape has no mesh
// (SLUG_WHY) and which shapes the caller's memory budget refused (memWants). The worker posts both,
// and the pool's synchronous fallback hands both to onDone, so the pool's worker handler must carry
// both too. Rebuilt from a field list that has neither, every sentinel in a browser (where the worker
// is the path) would arrive as DECLINED (morphDraw's fallback when the cause array is missing) and no
// budget refusal would be counted: lbMeshCensus would book a memory refusal as a decline, the
// conflation the cause array exists to stop, and R._lbShapeMemDeclined would stay 0.
//
// No GPU. The real worker module runs behind a stand-in Worker, and the pool is driven three ways --
// its synchronous fallback, its worker path, and its worker path with per-shape adoption (a streamed
// build) -- then end to end through the renderer's own builder on a stub GL context. The fixture is
// lbDeclineCensusSmoke's: a blob that builds, a point-cubic that DECLINES, and a polyline a 64 KB
// per-shape budget refuses (OVER_MEMORY).
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { buildLbBundle, lbMeshCensus, SLUG_WHY } = await import('../src/renderer/lbBuildCore.js');
const { setLbShapeMemoryBudget } = await import('../src/renderer/lbPack.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const zig = () => {
  let d = 'M0 260';
  for (let i = 1; i <= 420; i++) d += ` L${(i * 0.9).toFixed(2)} ${260 + (i % 2 ? 14 : 0)}`;
  return d + ' Z';
};
const SVG =
  '<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg">' +
  '<path fill="#000" d="M150 40 C70 20 30 70 30 100 C30 130 70 180 150 160 Z"/>' +
  '<path fill="#088" d="M300 100 C300 100 300 100 300 100 Z"/>' +
  `<path fill="#c33" d="${zig()}"/></svg>`;
const sec = await importSvg(SVG, { preserveViewport: true });
const pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const BUDGET = 65536;
const ref = buildLbBundle({
  curveFloats: new Float32Array(sec.curves),
  metaFloats: pm.metaFloats,
  metaFloatsPerShape: pm.floatsPerShape,
  ranges: sec.curveRangesByShape,
  numShapes: sec.numShapes,
  shapeMemBytes: BUDGET,
});
const WANT = [SLUG_WHY.REAL, SLUG_WHY.DECLINED, SLUG_WHY.OVER_MEMORY];
ok(
  Array.from(ref.why).join() === WANT.join() &&
    ref.memWants.length === 1 &&
    ref.memWants[0].shape === 2,
  `the build core: why [${Array.from(ref.why)}], memWants ${JSON.stringify(ref.memWants)}`,
);

const bundle = () => ({
  curveFloats: new Float32Array(sec.curves),
  metaFloats: pm.metaFloats,
  metaFloatsPerShape: pm.floatsPerShape,
  curveRangesByShape: sec.curveRangesByShape,
  numShapes: sec.numShapes,
  segTypeMask: sec.segTypeMask,
  _geomGen: 0,
});
const same = (r) =>
  !!r &&
  !!r.why &&
  Array.from(r.why).join() === WANT.join() &&
  !!r.memWants &&
  JSON.stringify(r.memWants) === JSON.stringify(ref.memWants);
const tell = (r) =>
  r
    ? `why ${r.why ? `[${Array.from(r.why)}]` : r.why}, memWants ${JSON.stringify(r.memWants)}`
    : 'no result';

setLbShapeMemoryBudget(BUDGET);
try {
  // ── the synchronous fallback (no Worker here yet) ────────────────────────────────────────────────
  const syncPool = await import('../src/renderer/lbWorkerPool.js?sync');
  const viaSync = await new Promise((resolve) => syncPool.requestLbBuild(bundle(), resolve));
  ok(same(viaSync), `the pool's synchronous build: ${tell(viaSync)}`);

  // ── the worker path: the real worker module behind a stand-in Worker ─────────────────────────────
  let bridged = 0;
  globalThis.self = { postMessage: () => {} };
  await import('../src/renderer/lbBuild.worker.js');
  class BridgedWorker {
    constructor() {
      globalThis.self.postMessage = (m) => queueMicrotask(() => this.onmessage({ data: m }));
    }
    postMessage(m) {
      bridged++;
      queueMicrotask(() => globalThis.self.onmessage({ data: structuredClone(m) }));
    }
    terminate() {}
  }
  globalThis.Worker = BridgedWorker;
  // The pool the renderer imports, first touched here, so it settles on the bridged worker.
  const pool = await import('../src/renderer/lbWorkerPool.js');
  const viaWorker = await new Promise((resolve) => pool.requestLbBuild(bundle(), resolve));
  ok(
    bridged === 1 && same(viaWorker),
    `the pool's worker path (${bridged} message through the bridge): ${tell(viaWorker)}`,
  );
  const partials = [];
  const streamed = await new Promise((resolve) =>
    pool.requestLbBuild(bundle(), resolve, {
      shapes: 1,
      ms: 0,
      onPartial: (m) => partials.push(m),
    }),
  );
  ok(
    !!streamed.streamed && partials.length > 0 && same(streamed),
    `...and a streamed build's final message (${partials.length} batch(es) adopted first): ${tell(streamed)}`,
  );

  // ── end to end: the renderer's own builder adopts it onto the bundle ─────────────────────────────
  const { attachMorphDraw } = await import('../src/renderer/morphDraw.js');
  const glStub = () =>
    new Proxy(
      {},
      { get: (_t, k) => (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => null) },
    );
  const R = {
    gl: glStub(),
    opts: { lbAdopt: false },
    draw: {},
    _lbFillMode: 'on',
    _lbSlugOnly: false,
    _lbSlugFallback: true,
  };
  attachMorphDraw(R);
  const b = bundle();
  const before = bridged;
  R._requestLbBuild(b);
  for (let i = 0; i < 200 && (b._lbWorkerPendingGen !== undefined || b._lbGen === undefined); i++)
    await new Promise((r) => setTimeout(r, 5));
  const c = lbMeshCensus(b);
  ok(
    bridged === before + 1 &&
      c.real === 1 &&
      c.declined === 1 &&
      c.overMemory === 1 &&
      c.unknown === 0,
    `R._requestLbBuild through the worker: lbMeshCensus ${JSON.stringify(c)}`,
  );
  ok(
    JSON.stringify(b._lbMemWants) === JSON.stringify(ref.memWants) &&
      (R._lbShapeMemDeclined | 0) === 1,
    `...and the budget refusal is counted (bundle._lbMemWants ${JSON.stringify(b._lbMemWants)}, R._lbShapeMemDeclined ${R._lbShapeMemDeclined})`,
  );
} finally {
  setLbShapeMemoryBudget(Infinity);
  delete globalThis.Worker;
}

console.log(fail ? `LB-WORKER-POOL-CAUSE FAIL (${fail})` : 'LB-WORKER-POOL-CAUSE PASS');
process.exit(fail ? 1 : 0);
