// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchCorpusFill — the fill-area audit across MANY assets, not just tiger.
//
// _cpatchFillArea measures one drawing. That is enough to catch a regression and NOT enough to
// change a default: a knob that trades search effort for accuracy can look free on the asset it
// is tuned against and cost real ink on the next one. This runs the same measurement -- convert
// each contour, then compare the union of its patches against the contour's own fill on a grid --
// over every SVG given, and reports per asset so one drawing cannot hide inside a total.
//
// WHAT IT DEFAULTS TO IS NOT A CORPUS, AND THE NAME OVERSELLS IT. examples/ is 8 drawings and
// 265 contours, of which TIGER IS 256 -- 97%. A change that helps tiger and hurts everything else
// reads here as a clean win, and one did: leak scoring turned off during clip offenders measured
// +0.5% references on this set and +33% on a production illustration outside it (a fence of long
// thin overlapping slats). Anything that changes a DEFAULT wants real artwork:
//
//   FILES=$(ls ~/art/*.svg | tr "\n" ,) node probes/_cpatchCorpusFill.mjs
//
// Measured across 89 production illustrations, 10 contours REFUSE to convert -- under every
// option setting tried, including the shipping one. Nothing in this repository can see them,
// because nothing in this repository is that kind of drawing.
import { readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tigerCycles } from './_cpatchCycles.mjs';
import { convertContour, inPatch, insideContour } from '../src/renderer/cpatchConvert.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const G = Number(process.env.G || 60);
const CAP = +(process.env.CP_CAP || 0);
if (CAP) globalThis.__CP_CAP = CAP;
const MAXC = +(process.env.MAXC || 8);

const closed = (cs) => {
  if (!cs.length) return true;
  const a = segPt(cs[0], 0),
    b = segPt(cs[cs.length - 1], 1);
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
};
const close = (cs) =>
  closed(cs) ? cs : cs.concat([{ t: 'line', P: [segPt(cs[cs.length - 1], 1), segPt(cs[0], 0)] }]);

const files = (
  process.env.FILES
    ? process.env.FILES.split(',')
    : readdirSync(path.join(ROOT, 'examples'))
        .filter((f) => f.endsWith('.svg'))
        .map((f) => 'examples/' + f)
).filter(Boolean);

let tOver = 0,
  tUnder = 0,
  tInk = 0,
  tPatch = 0,
  tMs = 0,
  tContours = 0;
console.log('\n  asset                      contours  patches   over-fill      under      convert');
for (const rel of files) {
  let contours = [];
  try {
    contours = tigerCycles(new URL('file://' + path.resolve(ROOT, rel))).cycles.map(close);
  } catch {
    continue;
  }
  if (!contours.length) continue;
  let over = 0,
    under = 0,
    ink = 0,
    patches = 0,
    ms = 0;
  for (const cs of contours) {
    let r = null;
    const t = performance.now();
    // TOLPX=0.05 pins a flat bar; unset is what the RENDER PATH does -- defaultTolPx
    // scales the bar with the contour's own extent. Pinning it measures a decomposition the
    // renderer does not build.
    const _co = { maxCurves: MAXC };
    if (process.env.TOLPX) _co.tolPx = +process.env.TOLPX;
    try {
      r = convertContour(cs, _co);
    } catch {
      /* refused */
    }
    ms += performance.now() - t;
    if (!r || !r.patches) continue;
    patches += r.patches.length;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const s of cs)
      for (const p of s.P) {
        x0 = Math.min(x0, p[0]);
        x1 = Math.max(x1, p[0]);
        y0 = Math.min(y0, p[1]);
        y1 = Math.max(y1, p[1]);
      }
    const pad = 0.02 * Math.max(x1 - x0, y1 - y0) + 1;
    x0 -= pad;
    y0 -= pad;
    x1 += pad;
    y1 += pad;
    for (let gy = 0; gy < G; gy++) {
      const y = y0 + (y1 - y0) * ((gy + 0.5) / G);
      for (let gx = 0; gx < G; gx++) {
        const x = x0 + (x1 - x0) * ((gx + 0.5) / G);
        const truth = insideContour(cs, x, y);
        let got = false;
        for (const p of r.patches)
          if (inPatch(p, x, y)) {
            got = true;
            break;
          }
        if (truth) ink++;
        if (got && !truth) over++;
        else if (!got && truth) under++;
      }
    }
  }
  if (!ink) continue;
  tOver += over;
  tUnder += under;
  tInk += ink;
  tPatch += patches;
  tMs += ms;
  tContours += contours.length;
  console.log(
    '  ' +
      path.basename(rel).padEnd(26) +
      String(contours.length).padStart(6) +
      String(patches).padStart(9) +
      (over + ' (' + ((100 * over) / ink).toFixed(3) + '%)').padStart(16) +
      (under + ' (' + ((100 * under) / ink).toFixed(3) + '%)').padStart(14) +
      (ms.toFixed(0) + 'ms').padStart(11),
  );
}
console.log(
  '\n  TOTAL  ' +
    tContours +
    ' contours, ' +
    tPatch +
    ' patches, ' +
    tOver +
    ' over (' +
    ((100 * tOver) / Math.max(tInk, 1)).toFixed(3) +
    '%), ' +
    tUnder +
    ' under (' +
    ((100 * tUnder) / Math.max(tInk, 1)).toFixed(3) +
    '%), ' +
    tMs.toFixed(0) +
    'ms' +
    (CAP ? '   [candidate budget ' + CAP + ']' : ''),
);
