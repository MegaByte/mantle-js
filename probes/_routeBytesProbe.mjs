// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _routeBytesProbe -- estimateRouteBytes against the measured bundle bytes (the benchmark harness's memBundle): cover texture bytes, projected
// Loop-Blinn buffer bytes, and the points list at 128 / 512 / 2048, for five benchmark assets. Node only: a bundle-shaped object from importSvg.
import { readFileSync, existsSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { parseMetaBin } from '../src/core/metaBin.js';
import { attachRouteBytes } from '../src/renderer/routeBytes.js';
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
let size = 128;
const R = { viewportSize: () => [size, size], arScale: () => [1, 1], draw: {} };
attachRouteBytes(R);
for (const [name, f] of Object.entries(FILES)) {
  const sec = await importSvg(readFileSync(A + f, 'utf8'));
  const m = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  const bundle = {
    numShapes: m.numShapes,
    metaFloats: m.metaFloats,
    metaFloatsPerShape: m.floatsPerShape,
    curveFloats: new Float32Array(sec.curves),
    bandFloats: new Float32Array(sec.bands),
    curveRangesByShape: sec.curveRangesByShape,
    globalBBox: sec.globalBBox || null,
    _geomGen: 0,
  };
  if (!bundle.globalBBox) {
    let x0 = 1e30,
      y0 = 1e30,
      x1 = -1e30,
      y1 = -1e30;
    for (let s = 0; s < m.numShapes; s++) {
      const o = s * m.floatsPerShape;
      x0 = Math.min(x0, m.metaFloats[o]);
      y0 = Math.min(y0, m.metaFloats[o + 1]);
      x1 = Math.max(x1, m.metaFloats[o + 2]);
      y1 = Math.max(y1, m.metaFloats[o + 3]);
    }
    bundle.globalBBox = [x0, y0, x1 - x0, y1 - y0];
  }
  for (size of [128, 512, 2048]) {
    const e = R.estimateRouteBytes(bundle, { perRow: true });
    const b = e.bundles[0],
      mb = (x) => (x / 1048576).toFixed(2);
    console.log(
      `ROUTEBYTES ${name} @${size}: rows ${b.rows} cover ${mb(b.cover.tex)} MB | points list ${mb(b.aacPoints.buf)} MB | LB projected ${mb(b.loopBlinn.buf)} MB | cpatch ${mb(b.cpatch.tex)} | raster ${mb(b.cachedRaster.tex)} | row0 cover ${b.perRow.cover[0].toFixed(0)} points ${b.perRow.aacPoints[0].toFixed(0)} lb ${b.perRow.loopBlinn[0].toFixed(0)} E ${b.perRow.extentPx[0].toFixed(1)}`,
    );
  }
}
