// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbMeshCensus — every shape's Loop-Blinn mesh, fingerprinted, so a change under the builder (the
// self-overlap resolver, the path boolean beneath it) can be told apart from no change and every
// shape it moved can be named.
//
// Runs the static build per shape exactly as _lbBandDrop does -- the bundle's curve plane, the shared
// decoder, the shape's own fill rule and translucency class -- through buildLbShape in plain node, and
// hashes the packed vertex stream. A shape the builder declines (Slug draws it) records h: null.
//
//   node probes/_lbMeshCensus.mjs OUT.json [file.svg ...]
//   node probes/_lbMeshCensus.mjs --diff A.json B.json
//
// With no files it takes examples/*.svg, examples/_bench/*.svg and examples/smoke/*.svg (tiger lives
// in examples/); the gitignored ones are skipped when absent.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv[2] === '--diff') {
  const A = JSON.parse(readFileSync(process.argv[3], 'utf8')),
    B = JSON.parse(readFileSync(process.argv[4], 'utf8'));
  let same = 0,
    moved = 0,
    onlyA = 0,
    onlyB = 0;
  for (const f of Object.keys(A.assets)) {
    const a = A.assets[f],
      b = B.assets[f];
    if (!b) {
      onlyA++;
      continue;
    }
    for (const s of Object.keys(a.shapes)) {
      const x = a.shapes[s],
        y = b.shapes[s];
      if (!y) {
        onlyA++;
        continue;
      }
      if (x.h === y.h) {
        same++;
        continue;
      }
      moved++;
      console.log(
        `${f} #${s}: verts ${x.v} -> ${y.v}${x.h === null ? ' (was declined)' : ''}${y.h === null ? ' (now declined)' : ''}`,
      );
    }
    for (const s of Object.keys(b.shapes)) if (!a.shapes[s]) onlyB++;
  }
  console.log(`shapes identical ${same}, moved ${moved}, only in A ${onlyA}, only in B ${onlyB}`);
  process.exit(0);
}

const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { curveRangeToContours } = await import('../src/renderer/loopBlinn.js');

const out = process.argv[2];
if (!out) {
  console.error('usage: _lbMeshCensus.mjs OUT.json [file.svg ...] | --diff A.json B.json');
  process.exit(2);
}
let files = process.argv.slice(3);
if (!files.length) {
  const dir = (d) =>
    existsSync(path.join(ROOT, d))
      ? readdirSync(path.join(ROOT, d))
          .filter((f) => f.endsWith('.svg'))
          .sort()
          .map((f) => d + '/' + f)
      : [];
  files = [...dir('examples'), ...dir('examples/_bench'), ...dir('examples/smoke')];
}

const { LB_VERT_FLOATS } = await import('../src/renderer/lbPack.js');
// FNV-1a over the vertex bytes.
function hash(a) {
  let h = 0x811c9dc5 >>> 0;
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  for (let i = 0; i < u.length; i++) {
    h ^= u[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

const result = { assets: {} };
let tShapes = 0,
  tBuilt = 0,
  tMs = 0;
for (const f of files) {
  const rel = f.includes('examples/') ? f.slice(f.lastIndexOf('examples/')) : f; // the same key from any checkout
  let svg;
  try {
    svg = readFileSync(path.resolve(ROOT, f), 'utf8');
  } catch {
    continue;
  }
  let bundle;
  try {
    bundle = await importSvg(svg);
  } catch {
    continue;
  }
  if (!bundle.numShapes || !bundle.curves) {
    result.assets[rel] = { ms: 0, shapes: {} };
    continue;
  }
  const meta =
    bundle.meta && bundle.meta.byteLength > 32 ? new Float32Array(bundle.meta, 32) : null; // 32-BYTE HEADER
  const mst = bundle.metaFloatsPerShape;
  const curveFloats = new Float32Array(bundle.curves);
  const shapes = {};
  const t0 = performance.now();
  for (let s = 0; s < bundle.numShapes; s++) {
    const r = bundle.curveRangesByShape[s];
    if (!r || r.end <= r.begin) continue;
    const bb = meta && mst ? s * mst : -1;
    const transSolid =
      bb >= 0 &&
      meta[bb + 7] < 0.996 &&
      Math.floor(meta[bb + 28] + 0.5) === 0 &&
      (mst < 36 || Math.floor(meta[bb + 35] + 0.5) === 0);
    const evenodd = !!(meta && meta[s * mst + 13] > 0.5);
    let contours = null;
    try {
      contours = curveRangeToContours(curveFloats, r.begin, r.end);
    } catch {
      continue;
    }
    let built = null;
    try {
      built = buildLbShape(contours, transSolid, evenodd);
    } catch {
      built = null;
    }
    tShapes++;
    if (!built || !built.pk || !built.pk.vertexCount) {
      shapes[s] = { h: null, v: 0 };
      continue;
    }
    tBuilt++;
    shapes[s] = {
      h: hash(built.pk.verts.subarray(0, built.pk.vertexCount * LB_VERT_FLOATS)),
      v: built.pk.vertexCount,
    };
  }
  const ms = performance.now() - t0;
  tMs += ms;
  result.assets[rel] = { ms: Math.round(ms), shapes };
}
writeFileSync(out, JSON.stringify(result));
console.log(
  `total: ${Object.keys(result.assets).length} assets, ${tShapes} shapes, ${tBuilt} built, ${Math.round(tMs)} ms -> ${out}`,
);
