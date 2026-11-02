// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchConvStallSmoke — a pooled CPatch conversion that never lands must not be silent.
//
// The failure class: buildCPatchBundle starts a pooled conversion, marks the bundle 'pending' and
// returns false, and the renderer draws the fallback engine until the conversion's Promise.all
// settles. If it never settles, the bundle draws the fallback for its whole life with nothing
// reporting it -- the picture is right, the engine that was asked for never runs (606 posts with 605
// answered is enough to leave every shape of tiger on Slug).
//
// What "never lands" can mean, each driven here with a fake Worker, no GPU:
//
//   dead-queue   every worker fails (a dev server 403s the worker URL, a CSP blocks it) while jobs
//                are still QUEUED. Rejecting only each worker's in-flight jobs and then dropping the
//                pool would leave a shape whose posts were all still queued unsettled.
//   msgerror     a reply that cannot be deserialized fires 'messageerror', which must be handled.
//   dispose      disposeCpatchPool terminates the workers and drops the pool with jobs in flight.
//   hang         a worker that simply never answers (unbounded work in the converter). The pool
//                deliberately has no timeout -- a clock must not decide which shapes convert -- so
//                this one cannot be made to finish; it is REPORTED instead, after a bound.
//   throw        the collect pass throws part way. The posts it made are orphaned and the bundle
//                stays 'pending'; the one caller that sees the exception swallows it.
//   healthy      and the report changes nothing when the conversion does land: same meshes, same
//                plane, no warning, no stall counted.
//
// Each scenario runs in its own process, because the pool is a module singleton and a failed
// pool stays failed.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const SCENARIOS = ['healthy', 'hang', 'throw', 'dead-queue', 'msgerror', 'dispose'];

if (!process.env.CP_STALL_SCENARIO) {
  let fail = 0;
  for (const sc of SCENARIOS) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, CP_STALL_SCENARIO: sc },
      encoding: 'utf8',
      timeout: 60000,
    });
    process.stdout.write(r.stdout || '');
    if (r.stderr)
      process.stdout.write(
        r.stderr
          .split('\n')
          .map((l) => (l ? '    ' + l : l))
          .join('\n'),
      );
    if (r.status !== 0) {
      console.log(`FAIL scenario ${sc} exited ${r.status}${r.signal ? ' ' + r.signal : ''}`);
      fail++;
    }
  }
  // THE DUMP READS THE same COUNTER. debugStats needs a GL context, so the wiring is checked at
  // the source rather than at runtime: the field must read cpatchConvStats, not a copy of it.
  const rsrc = readFileSync(new URL('../src/renderer/renderer.js', import.meta.url), 'utf8');
  const wired =
    /cpatchConvStalled:\s*_cpStall\.stalled/.test(rsrc) &&
    /_cpStall\s*=\s*_cpf\s*\?\s*_cpf\.cpatchConvStats\(\)/.test(rsrc);
  console.log(
    `${wired ? '  ok' : 'FAIL'} debugStats reports cpatchConvStalled from cpatchConvStats()`,
  );
  if (!wired) fail++;
  if (fail) {
    console.error(`CPATCH-CONV-STALL FAIL (${fail})`);
    process.exit(1);
  }
  console.log('CPATCH-CONV-STALL PASS');
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
const SC = process.env.CP_STALL_SCENARIO;
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} [${SC}] ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const x = await import('@xmldom/xmldom');
globalThis.DOMParser = x.DOMParser;
globalThis.XMLSerializer = x.XMLSerializer;
globalThis.__MANTLE_DEBUG__ = true; // __CP_POOL_N is a test hook, read only under it
// Exercise the retained seam converter and its workers, even when static paints certify.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__CP_NO_AREA = 1;
globalThis.__CP_POOL_N = 1; // one worker, so its in-flight cap leaves most posts QUEUED

// THE REAL WORKER, run in process: its onmessage is called on a structured clone of the post and
// its reply is cloned back, so the wire form and the pool's rehydration are the shipping ones.
// `self` stays defined: the worker reads it when it replies, not only when it loads.
const workerSelf = {};
globalThis.self = workerSelf;
await import('../src/renderer/cpatch.worker.js');
const workerOnMessage = workerSelf.onmessage;

class FakeWorker {
  static mode = 'answer';
  static all = [];
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.posts = 0;
    FakeWorker.all.push(this);
    // A worker whose script cannot load fails AFTER construction, asynchronously, with jobs already posted to it.
    if (FakeWorker.mode === 'dead')
      setTimeout(() => {
        if (this.onerror) this.onerror({ message: 'expected: worker script 403' });
      }, 0);
  }
  postMessage(msg) {
    this.posts++;
    const mode = FakeWorker.mode;
    if (mode === 'hang' || mode === 'dead') return;
    const data = structuredClone(msg);
    setTimeout(() => {
      if (mode === 'msgerror') {
        if (this.onmessageerror) this.onmessageerror({ data: null });
        return;
      }
      let reply = null;
      workerSelf.postMessage = (m) => {
        reply = structuredClone(m);
      };
      workerOnMessage({ data });
      if (this.onmessage) this.onmessage({ data: reply });
    }, 0);
  }
  terminate() {
    this.terminated = true;
  }
}
globalThis.Worker = FakeWorker;

const warns = [],
  errors = [];
const diag = await import('../src/core/diagnostics.js');
diag.setDiagnostics({
  onWarn: (...a) => warns.push(a.map(String).join(' ')),
  onError: (...a) => errors.push(a.map(String).join(' ')),
});

const { default: importSvg } = await import('../src/svg/importer.js');
const build = await import('../src/renderer/cpatchBuild.js');
const pool = await import('../src/renderer/cpatchWorkerPool.js');
const { buildCPatchBundle, headlessCPatchBundle } = build;
const convStats = () =>
  typeof build.cpatchConvStats === 'function' ? build.cpatchConvStats() : null;

// Twelve wavy blobs: real cubics, no recognized primitive, one cycle of 10 curves each -- enough
// cost that one worker holds two or three posts and the rest wait in the queue.
const f = (v) => v.toFixed(3);
function blob(cx, cy, R, k) {
  let d = '';
  for (let i = 0; i < k; i++) {
    const a0 = (2 * Math.PI * i) / k,
      a1 = (2 * Math.PI * (i + 1)) / k;
    const r0 = R * (i % 2 ? 0.7 : 1),
      r1 = R * ((i + 1) % 2 ? 0.7 : 1);
    const p0 = [cx + r0 * Math.cos(a0), cy + r0 * Math.sin(a0)],
      p3 = [cx + r1 * Math.cos(a1), cy + r1 * Math.sin(a1)];
    const t = 0.35 * R;
    const p1 = [p0[0] - t * Math.sin(a0), p0[1] + t * Math.cos(a0)],
      p2 = [p3[0] + t * Math.sin(a1), p3[1] - t * Math.cos(a1)];
    if (!i) d += `M${f(p0[0])} ${f(p0[1])}`;
    d += ` C${f(p1[0])} ${f(p1[1])} ${f(p2[0])} ${f(p2[1])} ${f(p3[0])} ${f(p3[1])}`;
  }
  return d + ' Z';
}
const paths = [];
for (let i = 0; i < 12; i++)
  paths.push(
    `<path fill="#468" d="${blob(60 + (i % 4) * 120, 60 + Math.floor(i / 4) * 120, 50, 10)}"/>`,
  );
const sections = await importSvg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360">${paths.join('')}</svg>`,
  { preserveViewport: true },
);

function glStub() {
  const g = {
    TEXTURE_2D: 1,
    RGBA32F: 2,
    RGBA: 3,
    FLOAT: 4,
    TEXTURE_MIN_FILTER: 5,
    TEXTURE_MAG_FILTER: 6,
    TEXTURE_WRAP_S: 7,
    TEXTURE_WRAP_T: 8,
    NEAREST: 9,
    CLAMP_TO_EDGE: 10,
    plane: null,
  };
  g.bindTexture = () => {};
  g.texParameteri = () => {};
  g.texImage2D = (...a) => {
    g.plane = a[8];
  };
  return g;
}
const until = async (pred, ms) => {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await sleep(5);
  return pred();
};
const bytesEqual = (a, b) =>
  a &&
  b &&
  a.byteLength === b.byteLength &&
  Buffer.compare(
    Buffer.from(a.buffer, a.byteOffset, a.byteLength),
    Buffer.from(b.buffer, b.byteOffset, b.byteLength),
  ) === 0;

if (SC === 'healthy') {
  FakeWorker.mode = 'answer';
  const gl = glStub(),
    b = headlessCPatchBundle(sections);
  const first = buildCPatchBundle(gl, b, { collectSlice: 0 });
  ok(
    first === false && b._cpatchConv === 'pending',
    'the first call starts a pooled conversion and reports nothing built',
  );
  ok(FakeWorker.all.length === 1, 'the pool spawned its worker');
  const landed = await until(() => b._cpatchConv instanceof Map, 20000);
  ok(landed, 'the conversion lands');
  ok(buildCPatchBundle(gl, b, {}) === true, 'the build pass after it builds');
  // THE REFERENCE: the same bundle converted in thread, no pool.
  const gl2 = glStub(),
    ref = headlessCPatchBundle(sections);
  ok(buildCPatchBundle(gl2, ref, { pool: false }) === true, 'the unpooled reference builds');
  let same = gl.plane && gl2.plane && bytesEqual(gl.plane, gl2.plane);
  for (let s = 0; s < (ref._lbMeshes || []).length; s++) {
    const m = b._lbMeshes && b._lbMeshes[s],
      r = ref._lbMeshes[s];
    if (!!m !== !!r || (m && !bytesEqual(m.verts, r.verts))) same = false;
  }
  ok(same, 'pooled meshes and plane are byte-identical to the unpooled build');
  const st = convStats();
  ok(st && st.stalled === 0, `no stall counted (${st && st.stalled})`);
  ok(!warns.length && !errors.length, `nothing warned (${warns.length + errors.length})`);
  ok(b._cpatchStall === undefined, 'the bundle carries no stall record');
  ok(
    !(b._cpatchConvWatch && b._cpatchConvWatch.timer),
    'the watch timer was cleared when the conversion landed',
  );
}

if (SC === 'hang') {
  FakeWorker.mode = 'hang';
  const b = headlessCPatchBundle(sections);
  ok(
    buildCPatchBundle(glStub(), b, { collectSlice: 0, stallReportMs: 40 }) === false,
    'the conversion starts',
  );
  await until(() => b._cpatchStall !== undefined, 20000); // the stall report IS the signal (stallReportMs 40), not a fixed 400 ms
  ok(
    b._cpatchConv === 'pending',
    'it is still pending: the fallback still draws, a clock does not decide what converts',
  );
  const st = convStats();
  ok(!!st, 'cpatchConvStats() exists');
  ok(st && st.stalled === 1, `exactly one stalled conversion counted (${st && st.stalled})`);
  ok(
    st &&
      st.pool &&
      st.pool.posted > 0 &&
      st.pool.answered === 0 &&
      st.pool.inflight + st.pool.queued === st.pool.posted,
    `the pool accounts for every post (${st && JSON.stringify(st.pool)})`,
  );
  ok(
    b._cpatchStall && b._cpatchStall.cause === 'no answer' && b._cpatchStall.ms >= 40,
    `the bundle records why (${JSON.stringify(b._cpatchStall)})`,
  );
  ok(
    warns.length === 1 && /CPatch/.test(warns[0]) && /fallback/.test(warns[0]),
    `one warning, naming the fallback (${warns[0]})`,
  );
  // Reported once, not once per tick. A FIXED WINDOW ON PURPOSE: the claim is that nothing further happens, so there is
  // no completion signal to wait for; 200 ms is five stallReportMs (40) periods.
  await sleep(200);
  ok(convStats() && convStats().stalled === 1 && warns.length === 1, 'the report is not repeated');
}

if (SC === 'throw') {
  FakeWorker.mode = 'answer';
  const b = headlessCPatchBundle(sections);
  // The fill-rule lookup reads the meta plane; make it throw on the fourth shape.
  const meta = b.metaFloats;
  let reads = 0;
  Object.defineProperty(b, 'metaFloats', {
    get() {
      if (++reads === 4) throw new Error('expected: malformed meta');
      return meta;
    },
  });
  let threw = null,
    r;
  try {
    r = buildCPatchBundle(glStub(), b, { collectSlice: 0, stallReportMs: 60000 });
  } catch (e) {
    threw = e;
  }
  ok(
    !threw && r === false,
    `the build reports nothing built rather than throwing into a caller that swallows it (${threw && threw.message})`,
  );
  ok(b._cpatchConv === 'pending', 'the bundle stays on its fallback, as before');
  const st = convStats();
  ok(
    st && st.stalled === 1,
    `a dead collect pass is counted at once, not after the bound (${st && st.stalled})`,
  );
  ok(
    b._cpatchStall && /malformed meta/.test(b._cpatchStall.cause),
    `the bundle records the exception (${JSON.stringify(b._cpatchStall)})`,
  );
  ok(errors.length === 1 && /malformed meta/.test(errors[0]), `and it is reported (${errors[0]})`);
}

if (SC === 'dead-queue') {
  FakeWorker.mode = 'dead';
  const b = headlessCPatchBundle(sections);
  buildCPatchBundle(glStub(), b, { collectSlice: 0, stallReportMs: 60000 });
  const w = FakeWorker.all[0];
  ok(w && w.posts > 0, `the worker was handed posts before it failed (${w && w.posts})`);
  const landed = await until(() => b._cpatchConv instanceof Map, 5000);
  ok(
    landed,
    `the conversion settles once every worker has failed (state ${String(b._cpatchConv)})`,
  );
  ok(
    landed && buildCPatchBundle(glStub(), b, {}) === true,
    'and the bundle builds, converted in thread',
  );
  ok(
    warns.some((m) => /CPatch/.test(m) && /worker/.test(m)),
    `a dead worker is reported (${warns.join(' | ')})`,
  );
}

if (SC === 'msgerror') {
  FakeWorker.mode = 'msgerror';
  const b = headlessCPatchBundle(sections);
  buildCPatchBundle(glStub(), b, { collectSlice: 0, stallReportMs: 60000 });
  const landed = await until(() => b._cpatchConv instanceof Map, 5000);
  ok(
    landed,
    `an unreadable reply fails the worker, and the conversion settles (state ${String(b._cpatchConv)})`,
  );
  ok(
    warns.some((m) => /CPatch/.test(m) && /worker/.test(m)),
    'and it is reported',
  );
}

if (SC === 'dispose') {
  FakeWorker.mode = 'hang';
  const { convertContour } = await import('../src/renderer/cpatchConvert.js');
  const cubic = (a, b1, c, d) => ({ t: 'cubic', P: [a, b1, c, d] });
  const claw = [
    cubic([-122.3, 84.29], [-122.3, 84.29], [-122.2, 86.18], [-123.03, 86.16]),
    cubic([-123.03, 86.16], [-123.85, 86.14], [-140.3, 38.07], [-160.83, 40.31]),
    cubic([-160.83, 40.31], [-160.83, 40.31], [-143.05, 32.96], [-122.3, 84.29]),
  ];
  let settled = null;
  pool
    .convertContoursPooled(
      [claw, claw.map((s) => ({ t: s.t, P: s.P.map((p) => [p[0] + 300, p[1]]) }))],
      { maxCurves: 8 },
    )
    .then(
      (r) => {
        settled = r;
      },
      (e) => {
        settled = e;
      },
    );
  await until(() => FakeWorker.all[0] && FakeWorker.all[0].posts > 0, 20000); // the jobs are on the worker
  ok(settled === null, 'in flight on a worker that has not answered');
  pool.disposeCpatchPool();
  await until(() => settled !== null, 3000);
  ok(
    Array.isArray(settled) &&
      settled.length === 2 &&
      settled.every((r) => r && r.patches && r.patches.patches.length > 0),
    "disposing the pool settles its jobs (they convert in thread, as a failed worker's do)",
  );
  const direct = convertContour(claw, { maxCurves: 8 });
  ok(
    Array.isArray(settled) && settled[0].patches.patches.length === direct.patches.length,
    'with the same decomposition',
  );
}

if (fail) {
  console.log(`  [${SC}] ${fail} failed`);
  process.exit(1);
}
process.exit(0);
