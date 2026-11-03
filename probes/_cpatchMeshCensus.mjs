// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchMeshCensus — every shape's CPatch mesh, fingerprinted, so a converter change can be told
// apart from no change and every shape it moved can be named.
//
// Runs the BUILD PASS's per-shape pipeline exactly -- the float64 plane where the importer kept one,
// the shared decoder, recognized primitives skipped, contoursToConverter, the shape's own fill rule,
// packCPatchShape with a cycle cache -- in plain node, one shape at a time at block 0, so a shape's
// fingerprint does not depend on how many texels the shapes before it took. Aggregates hide a moved
// shape inside a total that happens to balance; a hash per shape does not.
//
//   node probes/_cpatchMeshCensus.mjs OUT.json [file.svg ...]
//
// With no files it takes tiger, examples/*.svg, examples/_bench/*.svg and examples/smoke/*.svg --
// the gitignored ones are skipped when absent. Compare two runs with --diff A.json B.json, which
// prints every shape whose texels, vertices or unresolved count moved.
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
  const rows = [];
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
      if (x.h === y.h && x.u === y.u) {
        same++;
        continue;
      }
      moved++;
      rows.push(
        `${f} #${s}: blocks ${x.b} -> ${y.b}, verts ${x.v} -> ${y.v}, unresolved ${x.u} -> ${y.u}${x.h === null || y.h === null ? ' (null)' : ''}`,
      );
    }
    for (const s of Object.keys(b.shapes)) if (!a.shapes[s]) onlyB++;
  }
  for (const r of rows) console.log(r);
  console.log(`shapes identical ${same}, moved ${moved}, only in A ${onlyA}, only in B ${onlyB}`);
  process.exit(0);
}

const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { headlessCPatchBundle, contoursToConverter, shapeEvenOdd, cpatchCurvePlane } =
  await import('../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { circleFromContours, ellipseFromContours } = await import('../src/geom/shapeRecognize.js');
const { packCPatchShape, CP_BLOCK_TEXELS } = await import('../src/renderer/cpatchPack.js');

const out = process.argv[2];
if (!out) {
  console.error('usage: _cpatchMeshCensus.mjs OUT.json [file.svg ...] | --diff A.json B.json');
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

// FNV-1a over the bytes, texels then vertices.
function hash(...arrs) {
  let h = 0x811c9dc5 >>> 0;
  for (const a of arrs) {
    const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < u.length; i++) {
      h ^= u[i];
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h.toString(16);
}

const result = { assets: {} };
let tShapes = 0,
  tBuilt = 0,
  tMs = 0;
for (const rel of files) {
  let svg;
  try {
    svg = readFileSync(path.resolve(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  let bundle;
  try {
    bundle = headlessCPatchBundle(await importSvg(svg));
  } catch {
    continue;
  }
  const cf = cpatchCurvePlane(bundle);
  const ranges = bundle.curveRangesByShape || [];
  const cycleCache = new Map();
  const shapes = {};
  const t0 = performance.now();
  for (let s = 0; s < ranges.length; s++) {
    const r = ranges[s];
    if (!r) continue;
    let contours = null;
    try {
      contours = curveRangeToContours(cf, r.begin, r.end);
    } catch {
      contours = null;
    }
    if (!contours || !contours.length) continue;
    if (circleFromContours(contours) || ellipseFromContours(contours)) continue;
    const cs = contoursToConverter(contours, null);
    if (!cs) continue;
    let m = null;
    try {
      m = packCPatchShape(cs, 0, { evenOdd: shapeEvenOdd(bundle, s), cycleCache, search: 'full' });
    } catch {
      m = null;
    }
    tShapes++;
    if (!m) {
      shapes[s] = { h: null, b: 0, v: 0, u: 0 };
      continue;
    }
    tBuilt++;
    shapes[s] = {
      h: hash(m.texels, m.verts),
      b: m.texels.length / (CP_BLOCK_TEXELS * 4),
      v: m.vertexCount,
      u: m.unresolved | 0,
    };
  }
  const ms = performance.now() - t0;
  tMs += ms;
  result.assets[rel] = { ms: Math.round(ms), shapes };
  console.log(`${rel}: ${Object.keys(shapes).length} shapes, ${Math.round(ms)} ms`);
}
writeFileSync(out, JSON.stringify(result));
console.log(`total: ${tShapes} shapes, ${tBuilt} built, ${Math.round(tMs)} ms -> ${out}`);
