// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbAdoptBench.mjs — what per-shape adoption buys, and what a batching policy costs.
//
// Captures the REAL per-shape completion timeline of the Loop-Blinn build on an asset by driving
// lbBuildCore.buildLbBundle through its onShape hook, then replays every batching policy over that
// one timeline. Replaying beats re-running the build per policy twice over: the rebuild count is an
// exact function of the timeline, and this machine drifts 30-40% between runs, so a within-run replay
// is the only fair comparison available.
//
//   node probes/_lbAdoptBench.mjs                      # examples/tiger.svg
//   ASSET=examples/_concave_cubic.svg REPEAT=5 node probes/_lbAdoptBench.mjs
//
// Columns: REBUILDS is how many times the unified vertex stream is rebuilt across the whole build
// (each adoption is one); 1ST MESH DRAWN is when the first shape stops drawing its cover quad; FULL
// QUALITY is when the last one lands. The no-adoption row is the behavior this replaces.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSET = path.resolve(PKG, process.env.ASSET || 'examples/tiger.svg');
const REPEAT = Math.max(1, +(process.env.REPEAT || 3));

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { buildLbBundle } = await import('../src/renderer/lbBuildCore.js');

const sec = await importSvg(readFileSync(ASSET, 'utf8'), { preserveViewport: true });
const pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
// META=raw — read the meta BINARY as floats, header and all, so every row is shifted by 8 floats.
// NOT a configuration to ship or to measure the engine with: it is how a harness once misread the
// meta section, and it is kept because it is a useful LONG-BUILD FIXTURE. Shifted rows make 267 of
// tiger's 304 shapes look translucent-solid, which forces the CDT partition instead of the fast mesh
// and turns a ~1 s build into ~20 s. The renderer itself always decodes via parseMetaBin
// (bundle.js builds bundle.metaFloats that way, and requestLbBuild passes exactly that).
const rawMeta = process.env.META === 'raw';
const input = {
  curveFloats: new Float32Array(sec.curves),
  metaFloats: rawMeta ? new Float32Array(sec.meta) : pm.metaFloats,
  metaFloatsPerShape: pm.floatsPerShape,
  ranges: sec.curveRangesByShape,
  numShapes: sec.numShapes,
  // PREFER_BEZOUT=1 — the phase-1 Bezout routing, which the renderer sets per bundle. It travels with
  // the build input, so a probe that does not pass it measures the other route entirely.
  preferBezout: process.env.PREFER_BEZOUT === '1',
};
console.log(
  `asset ${path.basename(ASSET)}  shapes ${sec.numShapes}` +
    `  curve floats ${input.curveFloats.length}  repeats ${REPEAT}` +
    `  meta ${rawMeta ? 'RAW (shifted -- long-build fixture, not the renderer path)' : 'parseMetaBin (the renderer path)'}`,
);

// ---- capture the timelines ---------------------------------------------------------------------
const timelines = [];
for (let rep = 0; rep < REPEAT; rep++) {
  const tl = [];
  const t0 = performance.now();
  const res = buildLbBundle({
    ...input,
    onShape: (s, pk) =>
      tl.push({
        s,
        at: performance.now() - t0,
        real: !!(pk && !pk.slug && (pk.vertexCount | 0) > 0),
      }),
  });
  tl.total = performance.now() - t0;
  tl.real = tl.filter((e) => e.real).length;
  let worst = 0,
    worstS = -1,
    prev = 0;
  for (const e of tl) {
    const d = e.at - prev;
    if (d > worst) {
      worst = d;
      worstS = e.s;
    }
    prev = e.at;
  }
  tl.worst = worst;
  tl.worstS = worstS;
  timelines.push(tl);
  console.log(
    `  build ${rep + 1}/${REPEAT}: ${tl.total.toFixed(0)} ms, ${tl.real}/${tl.length} shapes with a mesh,` +
      ` slowest shape ${worstS} at ${worst.toFixed(0)} ms`,
  );
}

const med = (a) => {
  const b = [...a].sort((x, y) => x - y);
  const n = b.length;
  return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2;
};
const fmt = (a) =>
  `${med(a).toFixed(0)} [${Math.min(...a).toFixed(0)}-${Math.max(...a).toFixed(0)}]`;

console.log(
  `\nwhole-bundle build, ms: ${fmt(timelines.map((t) => t.total))}` +
    `   <- the main-thread stall a whole-bundle prepareBundle pays in full`,
);
console.log(
  `slowest single shape, ms: ${fmt(timelines.map((t) => t.worst))}` +
    `   <- what every other shape waits behind without adoption`,
);

// ---- replay a batching policy over a timeline ---------------------------------------------------
// Mirrors the worker's flush rule (count OR elapsed, whichever trips first) and the main thread's
// publish rule (a batch is adopted only once the staged set holds at least one real mesh), so this is
// the number of unified-stream rebuilds the policy actually causes.
function replay(tl, { shapes, ms, flat }) {
  let sinceFlush = 0,
    lastFlush = 0,
    anyReal = false,
    rebuilds = 0,
    batches = 0,
    firstAdoptAt = null;
  const flush = (at) => {
    if (!sinceFlush) return;
    batches++;
    sinceFlush = 0;
    lastFlush = at;
    if (anyReal) {
      rebuilds++;
      if (firstAdoptAt === null) firstAdoptAt = at;
    }
  };
  // Mirrors the worker: the interval grows with the elapsed build unless `flat` pins it, which is
  // what makes adoptions grow with the log of build length instead of linearly.
  const dueAt = (at) => (flat ? ms : Math.max(ms, at / 3));
  for (const e of tl) {
    sinceFlush++;
    anyReal = anyReal || e.real;
    if ((shapes > 0 && sinceFlush >= shapes) || (ms > 0 && e.at - lastFlush >= dueAt(e.at)))
      flush(e.at);
  }
  flush(tl.total); // the worker's final flush...
  rebuilds++; // ...and the result itself, whose tail shapes still have to reach the stream
  return { batches, rebuilds, firstAdoptAt, full: tl.total };
}

const POLICIES = [
  ['naive per-shape        (shapes 1,  ms 0)', { shapes: 1, ms: 0 }],
  ['PACKAGE DEFAULT        (shapes 0,  ms 100, growing)', { shapes: 0, ms: 100 }],
  ['flat interval          (shapes 0,  ms 100, flat)', { shapes: 0, ms: 100, flat: true }],
  ['count only             (shapes 32, ms 0)', { shapes: 32, ms: 0 }],
  ['count + time           (shapes 32, ms 100, flat)', { shapes: 32, ms: 100, flat: true }],
  ['coarse                 (shapes 64, ms 250)', { shapes: 64, ms: 250 }],
  ['no adoption (whole bundle)', null],
];

console.log(
  `\n${'policy'.padEnd(44)}${'REBUILDS'.padStart(12)}${'1ST MESH DRAWN'.padStart(20)}${'FULL QUALITY'.padStart(18)}`,
);
for (const [name, p] of POLICIES) {
  if (!p) {
    const full = timelines.map((t) => t.total);
    console.log(
      `${name.padEnd(44)}${'1'.padStart(12)}${fmt(full).padStart(20)}${fmt(full).padStart(18)}`,
    );
    continue;
  }
  const r = timelines.map((tl) => replay(tl, p));
  console.log(
    `${name.padEnd(44)}${fmt(r.map((x) => x.rebuilds)).padStart(12)}` +
      `${fmt(r.map((x) => x.firstAdoptAt ?? x.full)).padStart(20)}${fmt(r.map((x) => x.full)).padStart(18)}`,
  );
}
