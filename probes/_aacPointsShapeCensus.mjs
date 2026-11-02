// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _aacPointsShapeCensus — what the AAC point route's whole-DRAW gate costs, per asset.
//
// The route is all-or-nothing: it paints every drawn shape as points from one instanced call, so a
// bundle takes it whole or not at all, and the size test is on the bundle's largest shape, so one
// big shape, or one stroke, in an illustration disqualifies every small shape in it. This puts a
// number on that, with no GL.
//
// For each asset, at a raster size, it prints
//   qualify      shapes whose own on-screen extent is within AAC_POINTS_MAX_PX
//   ink          the share of the drawing's fill ink those shapes carry
//   blocked by   what stops the whole draw: the largest shape, a stroke row, a gradient row
//
//   N=512 node probes/_aacPointsShapeCensus.mjs [svg ...]
// With no arguments it walks examples/smoke and the samples directory.
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');

const N = +(process.env.N || 512);
const MAX_PX = +(process.env.MAX_PX || 8); // AAC_POINTS_MAX_PX

let files = process.argv.slice(2);
if (!files.length) {
  const dirs = [
    path.join(ROOT, 'examples/smoke'),
    path.join(ROOT, '../MantleSamples/Assets/Mantle'),
  ];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (f.endsWith('.svg')) files.push(path.join(d, f));
  }
}

const arScale = (bb, vw, vh) => {
  const cAR = vw / vh,
    sAR = bb[2] / bb[3];
  return sAR > cAR ? [1, cAR / sAR] : [sAR / cAR, 1];
};
let tot = 0,
  wholeDrawOk = 0,
  someQualify = 0,
  inkLost = 0,
  inkAll = 0;
const rows = [];
for (const f of files) {
  let b;
  try {
    b = await importSvg(readFileSync(f, 'utf8'), { preserveViewport: true });
  } catch {
    continue;
  }
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    F = pm.metaFloats,
    st = pm.floatsPerShape;
  const gbb = b.globalBBox;
  if (!gbb || !(gbb[2] > 0) || !(gbb[3] > 0)) continue;
  const [sx, sy] = arScale(gbb, N, N);
  const ex = (N * sx) / gbb[2],
    ey = (N * sy) / gbb[3];
  let nFill = 0,
    nSmall = 0,
    inkSmall = 0,
    ink = 0,
    worst = 0,
    stroke = 0,
    grad = 0;
  for (let s = 0; s < b.numShapes; s++) {
    const o = s * st;
    if (F[o + 11] > 0 && F[o + 12] > 0) {
      stroke++;
      continue;
    }
    if (F[o + 28] > 0.5) {
      grad++;
      continue;
    }
    if (!(F[o + 7] > 0)) continue;
    const w = (F[o + 2] - F[o]) * ex,
      h = (F[o + 3] - F[o + 1]) * ey;
    const a = w * h;
    nFill++;
    ink += a;
    const e = Math.max(w, h);
    if (e > worst) worst = e;
    if (e <= MAX_PX) {
      nSmall++;
      inkSmall += a;
    }
  }
  if (!nFill) continue;
  tot++;
  const whole = nSmall === nFill && !stroke && !grad;
  if (whole) wholeDrawOk++;
  if (nSmall > 0) someQualify++;
  if (!whole && nSmall > 0) {
    inkLost += inkSmall;
  }
  inkAll += ink;
  if (nSmall > 0) {
    rows.push({
      name: path.basename(f),
      nFill,
      nSmall,
      frac: nSmall / nFill,
      inkFrac: inkSmall / ink,
      worst,
      whole,
      stroke,
      grad,
    });
  }
}
rows.sort((a, b2) => b2.nSmall - a.nSmall);
console.log(`AAC point route survey at ${N} px, gate ${MAX_PX} px — ${tot} assets with fill ink\n`);
console.log('  shapes<=gate / fill shapes   ink share   largest px   whole draw?   blocked by');
for (const r of rows.slice(0, 30)) {
  console.log(
    `  ${String(r.nSmall).padStart(5)} / ${String(r.nFill).padEnd(5)} ${(100 * r.frac).toFixed(0).padStart(4)}%  ` +
      `${(100 * r.inkFrac).toFixed(1).padStart(6)}%  ${r.worst.toFixed(1).padStart(9)}  ` +
      `${(r.whole ? 'yes' : 'NO').padStart(10)}   ${r.whole ? '' : [r.worst > MAX_PX ? 'largest shape' : '', r.stroke ? `${r.stroke} stroke rows` : '', r.grad ? `${r.grad} gradient rows` : ''].filter(Boolean).join(', ')}   ${r.name}`,
  );
}
console.log(
  `\n${wholeDrawOk} of ${tot} assets can take the route WHOLE; ${someQualify} have at least one shape inside the gate.`,
);
console.log(
  `Ink in qualifying shapes of assets the whole-draw gate rejects: ${((100 * inkLost) / inkAll).toFixed(2)}% of all fill ink at ${N} px.`,
);
