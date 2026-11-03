// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// prepareVsWorker — does prepareBundle's synchronous build give the frame the mesh the worker gives it?
//
// createBundle hands every static bundle to the off-thread builder (lbWorkerPool.requestLbBuild), and
// prepareBundle builds it again on the main thread (morphDraw.js `_ensureLbMeshes`). Whichever lands
// last is what the frame draws. This runs the REAL renderer on test/_fakeGl.mjs, so both paths are
// the package code: node has no Worker, so requestLbBuild takes its deferred synchronous fallback,
// which calls the same buildLbBundle the worker module calls.
//
// Per file: create, prepareBundle (the main-thread set, captured at once), then buildLbBundle on the
// bundle's own input (what the worker builds), and compare the two per shape -- the packed vertex
// bytes, the kind mask and the Slug verdict. Then let the deferred build land and report whether it
// replaced the prepared set.
//
//   node probes/lbBuildPaths/prepareVsWorker.mjs [out.json] [corpus dir | file.svg ...]
//
// Files are processed in ONE process, in order, so the module-level caches (_lbMeshCache and the
// similarity orbit cache) are warm from earlier files -- which is what a page that loads several
// assets does. Pass a single file to see it cold.
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [outArg, ...rest] = process.argv.slice(2);
const x = await import('@xmldom/xmldom');
globalThis.DOMParser = x.DOMParser;
globalThis.XMLSerializer = x.XMLSerializer;
const { createFakeGl, taggedShaderSources } = await import('../../test/_fakeGl.mjs');
const { importSvg, createBundle, createRenderer } = await import('../../src/index.js');
const { buildLbBundle, packLbMeshForWire } = await import('../../src/renderer/lbBuildCore.js');

const files = [];
const add = (p) => {
  if (!existsSync(p)) {
    console.error('missing ' + p);
    return;
  }
  if (statSync(p).isDirectory()) {
    for (const f of readdirSync(p)
      .filter((n) => n.endsWith('.svg'))
      .sort())
      files.push(path.join(p, f));
  } else files.push(p);
};
if (rest.length) rest.forEach((p) => add(path.resolve(p)));
else {
  add(path.join(ROOT, 'examples/smoke'));
  add(path.join(ROOT, '../MantleSamples/Assets/Mantle'));
}

const F = createFakeGl({ width: 256, height: 256 });
const R = createRenderer(F.gl, taggedShaderSources(), {});
if (R.ready) await R.ready;
R.setViewport(256, 256);
const hashPk = (pk) => {
  if (!pk || pk.slug) return 'slug' + (pk && pk.why != null ? pk.why : '');
  const h = createHash('sha1');
  h.update(Buffer.from(pk.verts.buffer, pk.verts.byteOffset, pk.verts.byteLength));
  return h.digest('hex').slice(0, 12) + '/k' + (pk.kindMask | 0) + '/n' + (pk.vertexCount | 0);
};
const snap = (b) =>
  Array.isArray(b._lbMeshes)
    ? b._lbMeshes.map(hashPk)
    : b._lbMeshes === null
      ? 'null'
      : 'undefined';
const settle = () => new Promise((r) => setTimeout(r, 0));

const out = { files: {} };
let nShapes = 0,
  nDiff = 0,
  nFiles = 0,
  nFileDiff = 0,
  nPopped = 0;
const warn = console.warn;
console.warn = () => {};
for (const f of files) {
  let sec = null;
  try {
    sec = await importSvg(readFileSync(f, 'utf8'));
  } catch {
    continue;
  }
  const b = createBundle(F.gl, sec);
  let prepared = null;
  try {
    R.prepareBundle(b);
    prepared = snap(b);
  } catch (ex) {
    prepared = 'threw ' + ex.message;
  }
  const preparedArr = b._lbMeshes;
  const pendingAfterPrepare = b._lbWorkerPendingGen === (b._geomGen | 0);
  // THE WORKER'S SET, from the worker's own function on the bundle's own input.
  let worker = null;
  try {
    const res = buildLbBundle({
      curveFloats: b.curveFloats,
      metaFloats: b.metaFloats,
      metaFloatsPerShape: b.metaFloatsPerShape,
      ranges: b.curveRangesByShape,
      numShapes: b.numShapes,
      preferBezout: !!b._preferBezout,
      skip: b._lbBuildSkip || null,
    });
    worker = res.overBudget
      ? 'null'
      : res.packed.map(packLbMeshForWire).map((pk, s) => (pk ? hashPk(pk) : 'slug' + res.why[s]));
    if (worker !== 'null' && !res.hasReal) worker = 'null';
  } catch (ex) {
    worker = 'threw ' + ex.message;
  }
  for (let i = 0; i < 20 && b._lbWorkerPendingGen === (b._geomGen | 0); i++) await settle();
  const landed = snap(b);
  const kept = b._lbMeshes === preparedArr;
  const rel = path.relative(path.resolve(ROOT, '..'), f);
  const rec = { prepared, worker, landed, kept, pendingAfterPrepare, diff: [] };
  // Slug sentinels compare by verdict only: the prepared path's sentinel carries its cause, and the
  // worker's cause rides a separate array.
  const norm = (h) => (typeof h === 'string' && h.startsWith('slug') ? 'slug' : h);
  if (Array.isArray(prepared) && Array.isArray(worker)) {
    for (let s = 0; s < Math.max(prepared.length, worker.length); s++) {
      nShapes++;
      if (norm(prepared[s]) !== norm(worker[s])) {
        nDiff++;
        rec.diff.push({ s, prepared: prepared[s], worker: worker[s] });
      }
    }
  } else if (JSON.stringify(prepared) !== JSON.stringify(worker))
    rec.diff.push({ whole: true, prepared, worker });
  if (Array.isArray(prepared) && !kept) nPopped++;
  nFiles++;
  if (rec.diff.length) {
    nFileDiff++;
    console.log(
      `${rel}: ${rec.diff.length} differ ${JSON.stringify(process.env.ALL ? rec.diff : rec.diff.slice(0, 6))}`,
    );
  }
  out.files[rel] = rec;
  try {
    b.dispose && b.dispose();
  } catch {
    /* */
  }
}
console.warn = warn;
console.log(
  `\n${nShapes} shapes over ${nFiles} files: ${nDiff} shapes differ between the prepared set and the worker's (buildLbBundle), in ${nFileDiff} files; ` +
    `${nPopped} prepared sets were replaced when the deferred build landed`,
);
if (outArg && outArg.endsWith('.json')) writeFileSync(outArg, JSON.stringify(out));
process.exit(0);
