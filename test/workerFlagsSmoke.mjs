// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// workerFlagsSmoke — the page's switches reach the build workers, and nothing else does.
//
// Forwarding every primitive global under a pool's own prefix (`__LB_` / `__lb*`, `__CP_` / `__cp*`)
// would ship globals the LIBRARY WRITES -- `__lbDeclineWhy` riding every LB job -- as though they were
// switches, drop switches outside the prefix that the worker's modules read anyway (the LB worker
// reaches cpatchImplicit through shapeResolve; the CPatch worker reaches lbCubicMath), and have no
// answer for object and function hooks. src/renderer/workerFlags.js is an allow-list instead, with
// the sinks and outputs named. This pins it two ways.
//
// STATICALLY: every global read anywhere in either worker's import graph -- directly, through
// mantleDebugHook('__X'), or through mantleDebugFlag('name') -- is on exactly one of the three
// lists; no switch on the list is one the library writes; and every listed switch is still read
// by some worker module, so the list cannot rot.
//
// DYNAMICALLY, driving each worker module's own onmessage with the flags the pool's forwarder
// builds and the page's globals removed (as cpatchWorkerFlagSmoke does): a library output set on
// the page is not forwarded; a switch from the OTHER engine's prefix reaches the worker that reads
// it and builds what the main thread builds; the structured test hook `__CP_OPTS` crosses under
// __MANTLE_DEBUG__ and acts, and does not cross without it; a function or array sink is never
// forwarded, the message still clones, and setting one warns once.
import path from 'path';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}

const WF = await import('../src/renderer/workerFlags.js');
const { WORKER_SWITCHES, MAIN_THREAD_SINKS, LIBRARY_OUTPUTS, workerFlags } = WF;
ok(
  Array.isArray(WORKER_SWITCHES) &&
    Array.isArray(MAIN_THREAD_SINKS) &&
    Array.isArray(LIBRARY_OUTPUTS) &&
    typeof workerFlags === 'function' &&
    typeof WF.applyWorkerFlags === 'function',
  'workerFlags.js exports the three lists, the forwarder and the worker-side apply',
);

// ---- 1. statically ---------------------------------------------------------------------------------
console.log("the lists, against the workers' import graphs:");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const reach = (entry) => {
  const seen = new Set(),
    st = [path.join(SRC, entry)];
  while (st.length) {
    const f = st.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const s = strip(readFileSync(f, 'utf8'));
    for (const m of s.matchAll(
      /(?:import|export)\s[^'"`;]*?from\s*['"](\.[^'"]+)['"]|import\s*['"](\.[^'"]+)['"]/g,
    )) {
      const p = path.resolve(path.dirname(f), m[1] || m[2]);
      if (existsSync(p)) st.push(p);
    }
  }
  return [...seen];
};
// mantleDebugFlag's names, mapped to the globals they read.
const dbgMap = {};
for (const m of strip(readFileSync(path.join(SRC, 'core/diagnostics.js'), 'utf8')).matchAll(
  /case '(\w+)':\s*return[^;]*?\bg\.(__\w+)/g,
))
  dbgMap[m[1]] = m[2];
ok(
  Object.keys(dbgMap).length >= 10,
  `mantleDebugFlag's name -> global map parsed (${Object.keys(dbgMap).length} names)`,
);
const readsOf = (files) => {
  const reads = new Map(),
    add = (k, f) => {
      if (!reads.has(k)) reads.set(k, new Set());
      reads.get(k).add(path.relative(SRC, f));
    };
  for (const f of files) {
    const s = strip(readFileSync(f, 'utf8'));
    for (const m of s.matchAll(/globalThis\s*\)?\s*\.\s*(__[A-Za-z]\w*)(\s*(?:=(?!=)|\+\+|\+=))?/g))
      if (!m[2]) add(m[1], f);
    for (const m of s.matchAll(/mantleDebugHook\(\s*['"](__\w+)['"]/g)) add(m[1], f);
    for (const m of s.matchAll(/mantleDebugFlag\(\s*['"](\w+)['"]/g))
      if (dbgMap[m[1]]) add(dbgMap[m[1]], f);
    // Both helpers read the gate itself.
    if (/mantleDebug(Hook|Flag)\(\s*['"](?!forceNative)/.test(s)) add('__MANTLE_DEBUG__', f);
  }
  return reads;
};
const SW = new Set(WORKER_SWITCHES),
  SINK = new Set(MAIN_THREAD_SINKS),
  OUT = new Set(LIBRARY_OUTPUTS);
const graphReads = new Map();
for (const entry of ['renderer/lbBuild.worker.js', 'renderer/cpatch.worker.js']) {
  const files = reach(entry);
  const reads = readsOf(files);
  for (const [k, v] of reads) {
    if (!graphReads.has(k)) graphReads.set(k, new Set());
    for (const f of v) graphReads.get(k).add(f);
  }
  const loose = [...reads.keys()].filter((k) => !SW.has(k) && !SINK.has(k) && !OUT.has(k));
  ok(
    loose.length === 0,
    `${entry}: every global its ${files.length} modules read is on a list (${reads.size} read)` +
      (loose.length
        ? ` -- unlisted: ${loose.map((k) => `${k} (${[...reads.get(k)].join(',')})`).join(', ')}`
        : ''),
  );
}
const both = [...SW]
  .filter((k) => SINK.has(k) || OUT.has(k))
  .concat([...SINK].filter((k) => OUT.has(k)));
ok(
  both.length === 0,
  `the three lists are disjoint${both.length ? ' -- on two: ' + both.join(', ') : ''}`,
);
const stale = [...SW].filter((k) => !graphReads.has(k));
ok(
  stale.length === 0,
  `every forwarded switch is still read by a worker module${stale.length ? ' -- stale: ' + stale.join(', ') : ''}`,
);
// Every global the library writes, anywhere in src.
const written = new Set();
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.m?js$/.test(e.name))
      for (const m of strip(readFileSync(p, 'utf8')).matchAll(
        /globalThis\s*\)?\s*\.\s*(__[A-Za-z]\w*)\s*(?:=(?!=)|\+\+|\+=)/g,
      ))
        written.add(m[1]);
  }
};
walk(SRC);
const writtenSw = [...SW].filter((k) => written.has(k));
ok(
  written.size > 0 && writtenSw.length === 0,
  `no forwarded switch is a global the library writes (${written.size} written)` +
    (writtenSw.length ? ' -- written: ' + writtenSw.join(', ') : ''),
);
const unnamedOut = [
  '__lbDeclineWhy',
  '__lbPartitionErr',
  '__lbAuditTot',
  '__lbAuditBadN',
  '__lbAuditPieces',
  '__lbProofWhy',
].filter((k) => !written.has(k) || !OUT.has(k));
ok(
  unnamedOut.length === 0,
  `the LB decline/audit records are written by the library and listed as outputs${unnamedOut.length ? ' -- ' + unnamedOut.join(', ') : ''}`,
);

// ---- 2. through each worker's own onmessage --------------------------------------------------------
console.log('through the workers:');
const replies = [];
globalThis.self = { postMessage: (m) => replies.push(m) };
await import('../src/renderer/lbBuild.worker.js');
const lbHandler = self.onmessage;
await import('../src/renderer/cpatch.worker.js');
const cpHandler = self.onmessage;
const { setDiagnostics } = await import('../src/core/diagnostics.js');
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { buildLbBundle, packLbMeshForWire } = await import('../src/renderer/lbBuildCore.js');
const { convertContour } = await import('../src/renderer/cpatchConvert.js');

const digest = (v) =>
  createHash('sha1')
    .update(
      JSON.stringify(v, (_k, x) =>
        ArrayBuffer.isView(x)
          ? Buffer.from(x.buffer, x.byteOffset, x.byteLength).toString('base64')
          : x,
      ),
    )
    .digest('hex')
    .slice(0, 16);
/// Set `page` on the page, take the forwarder's flags, clear the page, run `fn(flags)`, clean up.
const viaForwarder = (page, fn) => {
  Object.assign(globalThis, page);
  let flags;
  try {
    flags = workerFlags();
  } finally {
    for (const k of Object.keys(page)) delete globalThis[k];
  }
  return fn(flags);
};
/// ...and the same work in this thread with `page` set, for the main-thread answer.
const onPage = (page, fn) => {
  Object.assign(globalThis, page);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(page)) delete globalThis[k];
  }
};

// (a) the library's own records are not inputs.
{
  const page = {
    __lbDeclineWhy: 'loop',
    __lbPartitionErr: 'x',
    __lbAuditTot: 9,
    __lbAuditBadN: 1,
    __lbProofWhy: 'y',
    __CP_FROZEN_DECLINES: 3,
  };
  const flags = viaForwarder(page, (f) => f);
  const leaked = Object.keys(flags || {}).filter((k) => k in page);
  ok(
    leaked.length === 0,
    `library outputs set on the page are not forwarded${leaked.length ? ' -- forwarded: ' + leaked.join(', ') : ''}`,
  );
}

// (b) the OTHER engine's switch reaches the LB worker, and it builds what the main thread builds.
const TIGER = path.resolve(ROOT, 'examples/tiger.svg');
if (!existsSync(TIGER)) console.log('  SKIP (b): examples/tiger.svg is absent');
else {
  const warn = console.warn;
  console.warn = () => {};
  const sec = await importSvg(readFileSync(TIGER, 'utf8'));
  console.warn = warn;
  const pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  // __CP_TRI_EPS is a CPatch test hook (cpatchImplicit's collinearity bar) that the LB build reaches
  // through shapeResolve's exact crossings; at 0.3 it moves tiger's first 140 shapes, which keep
  // the job short.
  const n = 140,
    rs = sec.curveRangesByShape.slice(0, n);
  const input = {
    curves: new Float32Array(sec.curves),
    meta: pm.metaFloats,
    metaFloatsPerShape: pm.floatsPerShape,
    ranges: rs,
    numShapes: n,
  };
  const lbWorker = (flags) => {
    replies.length = 0;
    lbHandler({ data: { id: 1, ...input, flags } });
    WF.applyWorkerFlags(null); // this "worker" shares the page's globals: take its flags back off
    const d = replies.find((r) => r.id === 1 && r.kind !== 'lbPartial');
    return d
      ? digest({
          why: d.why ? Array.from(d.why) : null,
          p: (d.packed || []).map((pk) => (pk ? pk.verts : null)),
        })
      : 'no reply';
  };
  const lbMain = () => {
    const r = buildLbBundle({
      curveFloats: input.curves,
      metaFloats: input.meta,
      metaFloatsPerShape: input.metaFloatsPerShape,
      ranges: rs,
      numShapes: n,
    });
    return digest({
      why: Array.from(r.why),
      p: r.packed.map(packLbMeshForWire).map((pk) => (pk ? pk.verts : null)),
    });
  };
  const page = { __MANTLE_DEBUG__: true, __CP_TRI_EPS: 0.3 }; // a test hook: it reads only under debug
  const def = lbWorker(null),
    main = onPage(page, lbMain),
    pooled = viaForwarder(page, lbWorker);
  ok(main !== def, `__CP_TRI_EPS moves the LB build on the main thread (${def} -> ${main})`);
  ok(pooled === main, `...and forwarded, the LB worker builds exactly that (${pooled})`);
  ok(lbWorker(null) === def, '...and the next message without it is back at the default');
}

// (c) the structured test hook crosses under debug, acts, and does not cross without it.
const K = 6;
const cpBlob = (() => {
  const at = (j) => [
    100 + 40 * Math.cos((2 * Math.PI * j) / K),
    100 + 40 * Math.sin((2 * Math.PI * j) / K),
  ];
  const out = [];
  for (let j = 0; j < K; j++) {
    const A = at(j),
      B = at(j + 1),
      bow = 0.44;
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bow,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bow;
    out.push({
      t: 'cubic',
      P: [
        A,
        [A[0] + (mx - A[0]) * 0.9, A[1] + (my - A[1]) * 0.9],
        [B[0] + (mx - B[0]) * 1.1, B[1] + (my - B[1]) * 1.1],
        B,
      ],
    });
  }
  return out;
})();
const cpWorker = (flags) => {
  replies.length = 0;
  cpHandler({ data: { id: 2, jobs: [{ key: 0, curves: cpBlob }], opts: {}, flags } });
  WF.applyWorkerFlags(null);
  const r = replies[0] && replies[0].out[0];
  return r && r.patches ? digest(r.patches.slim.map((p) => p.c.map((c) => c.P))) : 'none';
};
const cpMain = () => {
  const r = convertContour(cpBlob, {});
  return r ? digest(r.patches.map((p) => p.curves.map((c) => c.P))) : 'none';
};
{
  const page = { __MANTLE_DEBUG__: true, __CP_OPTS: { maxCurves: 3 } };
  const def = cpWorker(null),
    main = onPage(page, cpMain);
  const flags = viaForwarder(page, (f) => f);
  ok(
    flags && flags.__CP_OPTS && flags.__CP_OPTS.maxCurves === 3,
    '__CP_OPTS is forwarded while __MANTLE_DEBUG__ is on',
  );
  const pooled = cpWorker(flags);
  ok(main !== def, `__CP_OPTS moves a main-thread conversion (${def} -> ${main})`);
  ok(pooled === main, `...and forwarded, the CPatch worker converts exactly that (${pooled})`);
  const off = viaForwarder({ __CP_OPTS: { maxCurves: 3 } }, (f) => f);
  ok(!(off && '__CP_OPTS' in off), '...and without __MANTLE_DEBUG__ it is not forwarded at all');
}

// (d) sinks never cross, the message still clones, and each warns once.
{
  const warns = [];
  setDiagnostics({ onWarn: (...a) => warns.push(a.join(' ')) });
  const page = {
    __MANTLE_DEBUG__: true,
    __CP_TERM_HOOK: () => {},
    __LB_HULLDUMP: () => {},
    __CP_STATS: [],
    __lbAuditTrace: 1,
    __CP_TOL_ABS: 0.05,
  };
  const flags = viaForwarder(page, (f) => f);
  const sinks = Object.keys(flags || {}).filter((k) => MAIN_THREAD_SINKS.includes(k));
  ok(
    sinks.length === 0,
    `no sink is forwarded${sinks.length ? ' -- forwarded: ' + sinks.join(', ') : ''}`,
  );
  ok(flags && flags.__CP_TOL_ABS === 0.05, '...while a knob beside them is');
  let cloned = true;
  try {
    structuredClone({ id: 3, flags });
  } catch {
    cloned = false;
  }
  ok(cloned, '...and the message structured-clones (a function in it would throw DataCloneError)');
  const named = ['__CP_TERM_HOOK', '__LB_HULLDUMP', '__CP_STATS', '__lbAuditTrace'].filter((k) =>
    warns.some((w) => w.includes(k)),
  );
  ok(named.length === 4, `each sink set while a pool posts warns (${named.length} of 4)`);
  const before = warns.length;
  viaForwarder(page, (f) => f);
  ok(warns.length === before, '...once');
  setDiagnostics({ onWarn: null });
}

if (fail) {
  console.log(`FAIL workerFlagsSmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS workerFlagsSmoke');
process.exit(0);
