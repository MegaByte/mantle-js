// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchIdentity — is a source tree's CPatch output byte-identical to another tree's?
//
// Built to prove that deleting a switch kept its DEFAULT branch: an escape's removal must change no
// byte on the default path, so this runs the SERIAL (non-pool) build over a corpus through one
// tree's modules, writes a digest per shape, and a second invocation compares two digest files.
//
//   node probes/flags/cpatchIdentity.mjs run <tree>/js.kontek.mantle <out.json> [substr ...]
//   node probes/flags/cpatchIdentity.mjs model <tree>/js.kontek.mantle <out.json> [substr ...]
//   node probes/flags/cpatchIdentity.mjs pool <tree>/js.kontek.mantle <out.json> [substr ...]
//   node probes/flags/cpatchIdentity.mjs cmp <a.json> <b.json>
//   CP_FLAGS='{"__MANTLE_DEBUG__":true,"__CP_TRI_EPS":0.3}' sets globals first, to show the corpus reaches a
//   switch (a test hook reads only under __MANTLE_DEBUG__).
//
// WHAT IS HASHED, per SVG: buildCPatchBundle's return, the whole uploaded plane (the curve floats
// followed by every CPatch block), each shape's mesh (verts, vertex count, kind mask, whether it is
// CPatch or a primitive, or null for a shape the build declined or the cover guard refused), and the
// build's stamps (bail reason, dropped / unresolved / cells / all-seam counts, the rule list). Then a
// bake of the same bundle (bakeCPatchBundle's bytes, which record every search decision) and the
// replayed build from that bake. Then a MORPH arm: the worker's plan job run in thread on the smoke's
// blob families, with every plan segment packed at its ends and middle.
//
// `pool` is `run` with the build POOLED: node has no Worker, so a stand-in is installed that runs
// cpatch.worker.js's own message handler in this process (the way cpatchWorkerFlagSmoke drives
// it), with every message and reply passed through structuredClone as a real worker's are. The
// build then takes the browser's route -- collect pass, convertContoursPooled's units and merge,
// the slim reply rehydrated -- and its digests compare against `run`'s, the serial route node and a
// Worker-less host take. The bake arms stay serial (a recording build never pools).
//
// `model` is the CPU KERNEL TWIN (cpatchCov.patchCoverage), which reaches the build only through the
// shape coverage guard -- and the guard samples the interior and refuses nothing on the corpus, so
// a build hash cannot see a change to the twin's AA terms. It is scored directly instead: every
// shape's own patches (packCPatchShape's onPatches, holes and all), patchCoverage at every pixel
// center of the shape laid out 32 px across plus a 2 px margin, hashed per shape.
//
// The bundle comes from importSvg's sections through headlessCPatchBundle, which parses meta with
// parseMetaBin (the 32-byte header trap), the same path cpatchConvStallSmoke and the bake producer use.
// `Worker` does not exist in node, so buildCPatchBundle never pools: this IS the serial path.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [mode, a1, a2, ...rest] = process.argv.slice(2);

if (mode === 'cmp') {
  const A = JSON.parse(readFileSync(a1, 'utf8')),
    B = JSON.parse(readFileSync(a2, 'utf8'));
  let files = 0,
    shapes = 0,
    differ = 0,
    fileDiffer = 0,
    missing = 0;
  for (const f of Object.keys(A.files)) {
    const x = A.files[f],
      y = B.files[f];
    if (!y) {
      missing++;
      console.log('MISSING in b: ' + f);
      continue;
    }
    files++;
    let fd = false;
    for (const k of ['err', 'ret', 'plane', 'stamps', 'bake', 'replayPlane', 'replayShapes']) {
      if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) {
        fd = true;
        console.log(
          `DIFF ${f} ${k}: ${String(JSON.stringify(x[k])).slice(0, 160)} | ${String(JSON.stringify(y[k])).slice(0, 160)}`,
        );
      }
    }
    const n = Math.max((x.shapes || []).length, (y.shapes || []).length);
    for (let s = 0; s < n; s++) {
      shapes++;
      const u = JSON.stringify((x.shapes || [])[s]),
        v = JSON.stringify((y.shapes || [])[s]);
      if (u !== v) {
        differ++;
        fd = true;
        console.log(`DIFF ${f} shape ${s}: ${u} | ${v}`);
      }
    }
    if (fd) fileDiffer++;
  }
  for (const f of Object.keys(B.files))
    if (!A.files[f]) {
      missing++;
      console.log('MISSING in a: ' + f);
    }
  let mShapes = 0,
    mDiffer = 0;
  for (const f of Object.keys(A.model || {})) {
    const x = A.model[f],
      y = (B.model || {})[f];
    if (!y) {
      missing++;
      console.log('MISSING model in b: ' + f);
      continue;
    }
    if (x.err !== y.err) {
      mDiffer++;
      console.log(`DIFF model ${f} err: ${x.err} | ${y.err}`);
    }
    const n = Math.max((x.shapes || []).length, (y.shapes || []).length);
    for (let s = 0; s < n; s++) {
      mShapes++;
      if (JSON.stringify((x.shapes || [])[s]) !== JSON.stringify((y.shapes || [])[s])) {
        mDiffer++;
        console.log(`DIFF model ${f} shape ${s}`);
      }
    }
  }
  let mDiff = 0,
    mN = 0;
  for (const k of Object.keys(A.morph || {})) {
    mN++;
    const strip = (r) => JSON.stringify(r ? { ...r, ms: undefined } : r); // timing is not output
    if (strip(A.morph[k]) !== strip((B.morph || {})[k])) {
      mDiff++;
      console.log('DIFF morph ' + k);
    }
  }
  console.log(
    `\n${shapes} shapes over ${files} files, ${differ} shapes differ, ${fileDiffer} files differ (plane/stamps/bake included), ${missing} missing`,
  );
  console.log(`morph: ${mN} plans, ${mDiff} differ`);
  if (A.model)
    console.log(
      `model: ${mShapes} shapes over ${Object.keys(A.model).length} files, ${mDiffer} differ`,
    );
  process.exit(differ || fileDiffer || missing || mDiff || mDiffer ? 1 : 0);
}

if ((mode !== 'run' && mode !== 'model' && mode !== 'pool') || !a1 || !a2) {
  console.log(
    'usage: cpatchIdentity.mjs run|model|pool <js.kontek.mantle root> <out.json> [substr ...] | cmp <a.json> <b.json>',
  );
  process.exit(2);
}

const ROOT = path.resolve(a1);
// CP_FLAGS='{"__MANTLE_DEBUG__":true,"__CP_TRI_EPS":0.3}' sets globals before anything builds -- run against the BASELINE with a
// switch set, it shows the harness reaches that switch at all (lbMeshIdentity's LB_FLAGS, for CPatch).
if (process.env.CP_FLAGS) Object.assign(globalThis, JSON.parse(process.env.CP_FLAGS));
const HERE = path.dirname(new URL(import.meta.url).pathname);
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const src = (p) => import(path.join(ROOT, 'src', p));
// THE STAND-IN WORKER, for `pool`: installed before the pool module first spawns. One handler
// serves every stand-in (the module sets `self.onmessage` once); a message is answered on a later
// task, and the reply goes to the stand-in that sent it.
let pooled = 0;
if (mode === 'pool') {
  globalThis.self = {
    postMessage: () => {
      throw new Error('stand-in worker: reply outside a message');
    },
  };
  await import(path.join(ROOT, 'src/renderer/cpatch.worker.js'));
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
        pooled++;
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
}
/// The pooled build: the first call starts the conversion and builds nothing; the second, once the
/// conversion map has landed, builds from it.
async function buildPooled(gl, b) {
  const first = buildCPatchBundle(gl, b, {});
  // Only a first call that STARTED a conversion leaves it pending; one that bailed (nothing to
  // convert, no curve plane) answers the same false the serial build does.
  if (first || b._cpatchConv !== 'pending') return first;
  const t0 = Date.now();
  while (!(b._cpatchConv instanceof Map)) {
    if (Date.now() - t0 > 600000) throw new Error('pooled conversion never landed');
    await new Promise((r) => setImmediate(r));
  }
  return buildCPatchBundle(gl, b, {});
}
const { default: importSvg } = await src('svg/importer.js');
const { headlessCPatchBundle, buildCPatchBundle, bakeCPatchBundle } =
  await src('renderer/cpatchBuild.js');
const { decodeTraceBake } = await src('renderer/cpatchTrace.js');
const { convertContour, morphTolPx, framePatch } = await src('renderer/cpatchConvert.js');
const { planMorph, splitForMorph, layoutAt, applyLayout } = await src(
  'renderer/cpatchMorphCert.js',
);
const { planCPatchMorphSegment, packCPatchMorphFrame, packCPatchShape } =
  await src('renderer/cpatchPack.js');
const { contoursToConverter, shapeEvenOdd, cpatchCurvePlane } =
  await src('renderer/cpatchBuild.js');
const { curveRangeToContours } = await src('geom/lbContour.js');
const { circleFromContours, ellipseFromContours } = await src('geom/shapeRecognize.js');
const { patchCoverage } = await src('renderer/cpatchCov.js');

// ---- hashing: exact bits, not a printed form (-0, NaN and 1e-17 all survive) -------------------
function digest(v, skipKey = null) {
  const h = createHash('sha1'),
    seen = new WeakSet(),
    f8 = new Float64Array(1),
    u8 = new Uint8Array(f8.buffer);
  const walk = (x) => {
    if (x === null) return h.update('N');
    if (x === undefined) return h.update('U');
    const t = typeof x;
    if (t === 'number') {
      f8[0] = x;
      h.update('n');
      return h.update(u8);
    }
    if (t === 'string') return h.update('s' + x.length + ':' + x);
    if (t === 'boolean') return h.update(x ? 'T' : 'F');
    if (t === 'function' || t === 'symbol' || t === 'bigint') return h.update('?' + t);
    if (ArrayBuffer.isView(x)) {
      h.update('v' + x.constructor.name + x.byteLength + ':');
      return h.update(Buffer.from(x.buffer, x.byteOffset, x.byteLength));
    }
    if (seen.has(x)) return h.update('C');
    seen.add(x);
    if (Array.isArray(x)) {
      h.update('[' + x.length);
      for (const e of x) walk(e);
      // Arrays carry named properties here (a cover plane's `outlineAlong`), so they are hashed too.
      const ks = Object.keys(x)
        .filter((k) => !/^\d+$/.test(k))
        .sort();
      for (const k of ks) {
        h.update('.' + k);
        walk(x[k]);
      }
      return h.update(']');
    }
    if (x instanceof Map) {
      h.update('M' + x.size);
      for (const [k, e] of x) {
        walk(k);
        walk(e);
      }
      return;
    }
    const ks = Object.keys(x)
      .filter((k) => !(skipKey && skipKey.test(k)))
      .sort();
    h.update('{' + ks.length);
    for (const k of ks) {
      h.update(k);
      walk(x[k]);
    }
    h.update('}');
  };
  walk(v);
  return h.digest('hex').slice(0, 20);
}

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

const shapeRecord = (m) =>
  m
    ? {
        cp: !!m.cpatch,
        prim: !!m.prim,
        fb: !!m.fallback,
        n: m.vertexCount | 0,
        km: m.kindMask,
        v: digest(m.verts),
      }
    : null;
const stampsOf = (b) => ({
  bail: b._cpatchBail || null,
  built: b._cpatchBuilt | 0,
  dropped: b._cpatchDropped,
  unres: b._cpatchUnresolved,
  cells: b._cpatchCells,
  allSeam: b._cpatchAllSeam,
  rules: (b._cpatchRules || []).join(','),
  stomps: b._fillMeshStomps | 0,
});

// ---- corpus --------------------------------------------------------------------------------
const corpus = [];
const addDir = (dir, tag) => {
  if (!existsSync(dir)) {
    console.log('(missing corpus dir ' + dir + ')');
    return;
  }
  for (const f of readdirSync(dir).sort())
    if (f.endsWith('.svg')) corpus.push({ name: tag + '/' + f, file: path.join(dir, f) });
};
addDir(path.join(ROOT, 'examples/smoke'), 'smoke');
addDir(path.join(ROOT, '../MantleSamples/Assets/Mantle'), 'samples');
// EXTRA_CORPUS=dir,dir adds directories outside the repository (none by default).
for (const d of (process.env.EXTRA_CORPUS || '').split(',').filter(Boolean))
  addDir(path.resolve(d), 'extra/' + path.basename(d));
// Tiger is the asset every CPatch measurement in the tree was taken on. It is fetched, not tracked,
// so a checkout may not have it; a sibling checkout's copy is read if this tree lacks one.
for (const t of [
  path.join(ROOT, 'examples/tiger.svg'),
  path.join(HERE, '../../../../../js.kontek.mantle/examples/tiger.svg'),
]) {
  if (existsSync(t)) {
    corpus.push({ name: 'tiger.svg', file: t });
    break;
  }
}
const want = rest.filter(Boolean);
const list = want.length ? corpus.filter((c) => want.some((w) => c.name.includes(w))) : corpus;

if (mode === 'model') {
  // The twin's assets: tiger (every CPatch number in the tree), the star (the hull-row asset), and
  // every sample asset (holes, arcs, landscapes, tiger's morph frames).
  const MODEL = want.length
    ? list
    : corpus.filter(
        (c) =>
          c.name === 'tiger.svg' ||
          c.name.startsWith('samples/') ||
          c.name === 'smoke/engineDeclineIsolation__STAR.svg',
      );
  const outM = { root: ROOT, files: {}, morph: {}, model: {} };
  for (const c of MODEL) {
    const t0 = Date.now(),
      rec = { shapes: [] };
    try {
      const b = headlessCPatchBundle(await importSvg(readFileSync(c.file, 'utf8')));
      const cf = cpatchCurvePlane(b),
        ranges = b.curveRangesByShape || [];
      for (let s = 0; s < ranges.length; s++) {
        const r = ranges[s];
        let contours = null;
        try {
          contours = r ? curveRangeToContours(cf, r.begin, r.end) : null;
        } catch {
          contours = null;
        }
        if (
          !contours ||
          !contours.length ||
          circleFromContours(contours) ||
          ellipseFromContours(contours)
        ) {
          rec.shapes.push(null);
          continue;
        }
        const cs = contoursToConverter(contours, null);
        if (!cs) {
          rec.shapes.push(null);
          continue;
        }
        const patches = [];
        let m = null;
        try {
          m = packCPatchShape(cs, 0, {
            evenOdd: shapeEvenOdd(b, s),
            onPatches: (a) => patches.push(...a),
          });
        } catch {
          m = null;
        }
        let x0 = Infinity,
          y0 = Infinity,
          x1 = -Infinity,
          y1 = -Infinity;
        for (const q of cs)
          for (const g of q)
            for (const p of g.P) {
              if (p[0] < x0) x0 = p[0];
              if (p[0] > x1) x1 = p[0];
              if (p[1] < y0) y0 = p[1];
              if (p[1] > y1) y1 = p[1];
            }
        const em = Math.max(x1 - x0, y1 - y0) / 32;
        if (!(em > 0) || !patches.length) {
          rec.shapes.push({ built: !!m, n: patches.length });
          continue;
        }
        const vals = [];
        for (let y = y0 - 2 * em + 0.5 * em; y <= y1 + 2 * em; y += em)
          for (let x = x0 - 2 * em + 0.5 * em; x <= x1 + 2 * em; x += em)
            for (const p of patches) {
              const v = patchCoverage(p, x, y, em);
              if (v !== 0) vals.push(v);
            }
        rec.shapes.push({
          built: !!m,
          n: patches.length,
          k: vals.length,
          v: digest(new Float64Array(vals)),
        });
      }
    } catch (ex) {
      rec.err = String((ex && ex.message) || ex).slice(0, 200);
    }
    rec.ms = Date.now() - t0;
    outM.model[c.name] = rec;
    console.log(
      `model ${c.name} ${rec.shapes.length} shapes ${rec.ms} ms${rec.err ? ' ERR ' + rec.err : ''}`,
    );
  }
  writeFileSync(a2, JSON.stringify(outM));
  process.exit(0);
}

const out = { root: ROOT, files: {}, morph: {} };
const tAll = Date.now();
let i = 0;
for (const c of list) {
  i++;
  const t0 = Date.now();
  const rec = {};
  try {
    const sections = await importSvg(readFileSync(c.file, 'utf8'));
    const b = headlessCPatchBundle(sections);
    const gl = glStub();
    rec.ret =
      mode === 'pool' ? await buildPooled(gl, b) : buildCPatchBundle(gl, b, { pool: false });
    rec.plane = gl.plane ? digest(gl.plane) : null;
    rec.shapes = (b._lbMeshes || []).map(shapeRecord);
    rec.stamps = stampsOf(b);
    if (rec.ret) {
      // THE BAKE: every decision the search made, as bytes, then the build replayed from it.
      const bb = headlessCPatchBundle(sections);
      const bytes = bakeCPatchBundle(bb, {});
      rec.bake = digest(bytes);
      const rb = headlessCPatchBundle(sections);
      rb._cpatchTraces = decodeTraceBake(bytes);
      const g2 = glStub();
      buildCPatchBundle(g2, rb, { pool: false });
      rec.replayPlane = g2.plane ? digest(g2.plane) : null;
      rec.replayShapes = digest((rb._lbMeshes || []).map(shapeRecord));
    }
  } catch (ex) {
    rec.err = String((ex && ex.message) || ex).slice(0, 200);
  }
  rec.ms = Date.now() - t0;
  out.files[c.name] = rec;
  if (rec.ms > 2000 || i % 50 === 0)
    console.log(`[${i}/${list.length}] ${c.name} ${rec.ms} ms${rec.err ? ' ERR ' + rec.err : ''}`);
}

// ---- morph arm: the worker's plan job (cpatch.worker.js planJob), in thread ------------------
if (!want.length || want.includes('morph')) {
  const K = 6;
  const blob = (t, phase, kind) => {
    const R = 40 + 22 * t,
      cx = 100,
      cy = 100;
    const at = (j) => [
      cx + R * Math.cos((2 * Math.PI * j) / K + phase * t),
      cy + R * Math.sin((2 * Math.PI * j) / K + phase * t),
    ];
    const o = [];
    for (let j = 0; j < K; j++) {
      const A = at(j),
        B = at(j + 1),
        bow = 0.3 + 0.14 * t;
      const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bow,
        my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bow;
      if (kind === 'cubic')
        o.push({
          t: 'cubic',
          P: [
            A,
            [A[0] + (mx - A[0]) * 0.9, A[1] + (my - A[1]) * 0.9],
            [B[0] + (mx - B[0]) * 1.1, B[1] + (my - B[1]) * 1.1],
            B,
          ],
        });
      else if (kind === 'rquad') o.push({ t: 'rquad', P: [A, [mx, my], B], w: 0.75 + 0.1 * t });
      else o.push({ t: 'quad', P: [A, [mx, my], B] });
    }
    return o;
  };
  const poseAt = (A, B, t) =>
    A.map((c, k) => ({
      t: c.t,
      cut: c.cut,
      w: c.w,
      _bez: c._bez,
      P: c.P.map((q, m) => [q[0] + (B[k].P[m][0] - q[0]) * t, q[1] + (B[k].P[m][1] - q[1]) * t]),
    }));
  for (const kind of ['quad', 'rquad', 'cubic'])
    for (const phase of [0, 1.0]) {
      const key = kind + '@' + phase,
        t0 = Date.now();
      const rec = {};
      try {
        const jA = blob(0, phase, kind),
          jB = blob(1, phase, kind);
        const tolPx = morphTolPx(jA, jB);
        const convert = (cs, o) => {
          try {
            return convertContour(cs, {
              maxCurves: 8,
              tolPx,
              noCurveCuts: true,
              forceBezout: true,
              leakMargin: (o && o.leakMargin) || 0,
            });
          } catch {
            return null;
          }
        };
        const [A, B] = splitForMorph(jA, jB);
        const plan = planMorph(A, B, convert, { tolPx });
        // A plan carries its planner's per-phase TIMES (certMs, poseMs, convertMs); those are not output.
        rec.plan = plan ? digest(plan, /Ms$/) : null;
        rec.segs = [];
        for (const seg of plan || []) {
          const lay = layoutAt(plan, (seg.t0 + seg.t1) / 2);
          const fr = (tt) => {
            const ls = applyLayout(lay, poseAt(A, B, tt));
            if (!ls) return null;
            const o = [];
            for (const l of ls) {
              const f = framePatch(l);
              if (!f) return null;
              o.push(f);
            }
            return o;
          };
          const lo = fr(seg.t0),
            hi = fr(seg.t1),
            mid = fr((seg.t0 + seg.t1) / 2);
          const sp = lo && hi ? planCPatchMorphSegment(lo, hi, 0, {}) : null;
          const frames = [];
          for (const f of [lo, mid, hi])
            frames.push(sp && f ? digest(packCPatchMorphFrame(f, sp, null)) : null);
          rec.segs.push({ sp: sp ? digest(sp) : null, frames });
        }
      } catch (ex) {
        rec.err = String((ex && ex.message) || ex).slice(0, 200);
      }
      rec.ms = Date.now() - t0;
      out.morph[key] = rec;
      console.log(`morph ${key} ${rec.ms} ms${rec.err ? ' ERR ' + rec.err : ''}`);
    }
}

if (mode === 'pool') console.log(`pooled: ${pooled} worker messages answered`);
writeFileSync(a2, JSON.stringify(out));
const nS = Object.values(out.files).reduce((s, r) => s + ((r.shapes && r.shapes.length) | 0), 0);
console.log(
  `\nwrote ${a2}: ${Object.keys(out.files).length} files, ${nS} shapes, ${Object.keys(out.morph).length} morph plans, ${((Date.now() - tAll) / 1000).toFixed(1)} s`,
);
