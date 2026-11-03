// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbZeroAreaFaceSmoke — a static Loop-Blinn build ships no crescent face of exactly zero area.
//
// A clip polygon's repeated corner, fanned into triangles, leaves cubic faces with two identical corners (hundreds on
// tiger). Such a face covers no pixel, but it SHARES an edge with the real crescent beside it, and the packer rings only
// a hull edge that no other face shares. So the crescent would lose its exterior ring along that edge, and every pixel
// whose center lies just outside the arc there would be reached by no primitive at all: unpainted, though the path
// covers part of it. An S-curve at 384 px, identity, shows it on its first piece.
//
// No GPU:
//   - no cubic face of a static build of tiger or of the probe's four shapes has zero area (the exact orientation predicate
//     on its stored corners);
//   - through the kernel's CPU twin at 384 px, the five pixels just outside the S-curve's first arc that the path
//     covers 13% to 44% of are painted.
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const LC = await import('../src/geom/lbContour.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { orient2dXY } = await import('../src/geom/predicates.js');
const R = await import('../probes/lbAccuracy/_lbRaster.mjs');
const REF = await import('../probes/lbAccuracy/_lbAaRef.mjs');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};

const ZERO_AREA_SCENE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="384" height="384" viewBox="0 0 384 384">' +
  '<circle cx="120" cy="130" r="70" fill="#000"/>' +
  '<path d="M250 60 L280 150 L370 150 L300 205 L325 295 L250 240 L175 295 L200 205 L130 150 L220 150 Z" fill="#000"/>' +
  '<path d="M40 300 C80 230 160 380 200 300 S300 240 340 330 L340 370 L40 370 Z" fill="#000"/>' +
  '<ellipse cx="300" cy="80" rx="60" ry="22" fill="#000"/></svg>';

// ── no zero-area cubic face ───────────────────────────────────────────────────────────────────────
for (const [name, text, opts] of [
  ['tiger', readFileSync(new URL('../examples/tiger.svg', import.meta.url), 'utf8'), undefined],
  ["the probe's scene", ZERO_AREA_SCENE, { preserveViewport: true }],
]) {
  const bun = await importSvg(text, opts);
  const pm = parseMetaBin(bun.meta, bun.metaFloatsPerShape),
    mst = pm.floatsPerShape,
    meta = pm.metaFloats,
    cf = new Float32Array(bun.curves);
  let faces = 0,
    zero = 0,
    shapes = 0;
  for (let s = 0; s < bun.numShapes; s++) {
    const r = bun.curveRangesByShape[s];
    let Cs;
    try {
      Cs = LC.curveRangeToContours(cf, r.begin, r.end);
    } catch {
      continue;
    }
    let b = null;
    try {
      b = buildLbShape(Cs, false, meta[s * mst + 13] > 0.5);
    } catch {
      b = null;
    }
    if (!b || !b.raw) continue;
    let z = 0;
    for (const c of b.raw.cubics || []) {
      if (!c.hull || c.hull.length !== 6) continue;
      faces++;
      if (orient2dXY(c.hull[0], c.hull[1], c.hull[2], c.hull[3], c.hull[4], c.hull[5]) === 0) z++;
    }
    zero += z;
    if (z) shapes++;
  }
  ok(
    faces > 0 && zero === 0,
    `${name}: ${zero} of ${faces} cubic faces have zero area (in ${shapes} shapes)`,
  );
}

// ── the S-curve's first arc, through the kernel's twin ────────────────────────────────────────────
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lbzero-')),
    file = path.join(dir, 'scene.svg');
  writeFileSync(file, ZERO_AREA_SCENE);
  const prev = process.env.PRESERVE_VIEWPORT;
  process.env.PRESERVE_VIEWPORT = '1';
  const bundle = await R.loadSvg(file);
  if (prev === undefined) delete process.env.PRESERVE_VIEWPORT;
  else process.env.PRESERVE_VIEWPORT = prev;
  const { shapes, bbox } = await R.shapesOf(bundle),
    N = 384,
    view = R.viewOf(bbox, N);
  const sh = shapes.find((s) => s.s === 2),
    built = await R.buildMesh(sh);
  const acc = new Float64Array(N * N).fill(1);
  R.rasterMesh(built.pk, view, acc, {});
  const { rowSpans, contoursToConverter, closed } = await REF.refKit();
  const curves = closed(contoursToConverter(sh.contours, null));
  const rows = [];
  for (const [i, j] of [
    [100, 291],
    [105, 294],
    [108, 296],
    [113, 299],
    [116, 301],
  ]) {
    rows.push({
      i,
      j,
      ex: REF.exactCov(rowSpans, curves, i, j, view, 64, sh.evenOdd, null),
      mo: 1 - acc[j * N + i],
    });
  }
  ok(
    rows.every((r) => r.ex > 32 / 255 && r.mo > 0),
    `the S-curve's first arc: ${rows.map((r) => `(${r.i},${r.j}) path ${r.ex.toFixed(2)} drawn ${r.mo.toFixed(2)}`).join('; ')}`,
  );
}

console.warn = warn;
console.log(fail ? `LB-ZERO-AREA-FACE FAIL (${fail})` : 'LB-ZERO-AREA-FACE PASS');
process.exit(fail ? 1 : 0);
