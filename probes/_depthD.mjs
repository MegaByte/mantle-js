// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _depthD -- the overlap depth D the whole-bundle points gate computes (em-space cover-box area over union), and the budget it allows, per benchmark asset.
import { readFileSync, existsSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { parseMetaBin } from '../src/core/metaBin.js';
import { attachAacPointsDraw } from '../src/renderer/aacPointsDraw.js';
const A = process.env.MANTLE_BENCH_ASSETS
  ? process.env.MANTLE_BENCH_ASSETS.replace(/\/?$/, '/')
  : ''; // the benchmark asset tree (not in this repo)
if (!A || !existsSync(A)) {
  console.log('SKIP: set MANTLE_BENCH_ASSETS to the benchmark asset directory');
  process.exit(0);
}
// The assets: each argument is a path under MANTLE_BENCH_ASSETS, optionally named as name=path.
const FILES = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a) =>
      a.includes('=') ? a.split('=') : [a.replace(/^.*\//, '').replace(/\.svg$/, ''), a],
    ),
);
if (!Object.keys(FILES).length) {
  console.log(
    'SKIP: name the assets to read, as paths under MANTLE_BENCH_ASSETS (name=path or path)',
  );
  process.exit(0);
}
const R = { gl: null, opts: {}, _pendingShaders: [], _pendingPrograms: [] };
attachAacPointsDraw(R);
const G = R._aacPointsGate;
for (const [n, f] of Object.entries(FILES)) {
  const sec = await importSvg(readFileSync(A + f, 'utf8'));
  const m = parseMetaBin(sec.meta, sec.metaFloatsPerShape),
    st = m.floatsPerShape;
  const abs = [];
  let x0 = 1e30,
    y0 = 1e30,
    x1 = -1e30,
    y1 = -1e30;
  for (let s = 0; s < m.numShapes; s++) {
    const o = s * st;
    if (!(m.metaFloats[o + 7] > 0 || m.metaFloats[o + 11] > 0)) continue;
    abs.push(m.metaFloats[o], m.metaFloats[o + 1], m.metaFloats[o + 2], m.metaFloats[o + 3]);
    x0 = Math.min(x0, m.metaFloats[o]);
    y0 = Math.min(y0, m.metaFloats[o + 1]);
    x1 = Math.max(x1, m.metaFloats[o + 2]);
    y1 = Math.max(y1, m.metaFloats[o + 3]);
  }
  const D = G.overlapDepth(abs, [x0, y0, x1 - x0, y1 - y0]);
  console.log(
    `DEPTH ${n}: rows ${abs.length / 4} D ${D.toFixed(2)} budget ${Math.round(G.budget(D))}`,
  );
}
