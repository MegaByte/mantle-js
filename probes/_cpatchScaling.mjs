// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchScaling — is CPatch conversion cost ALGORITHMIC or constant-factor?
//
// Before optimizing conversion, establish how its cost GROWS: bin real contours by curve count,
// and report both time and the number of
// validate / leak / score / cut operations per contour. A constant-factor problem and an
// algorithmic one look identical in a single average and need completely different fixes.
import { readFileSync, readdirSync } from 'fs';
import { parsePathD } from '../src/svg/path.js';
import { convertContour, cpStats, cpStatsReset } from '../src/renderer/cpatchConvert.js';
import { arcToRQuads } from '../src/geom/cpatchImplicit.js';
import { cubicInflections, cubicLoopCuts, cubicSlice } from '../src/geom/lbCubicMath.js';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, ''); // the package root
const files = ['examples/tiger.svg'];
for (const f of readdirSync(ROOT + '/../fixtures/svg'))
  if (f.endsWith('.svg')) files.push('../fixtures/svg/' + f);

const all = [];
for (const f of files) {
  let txt;
  try {
    txt = readFileSync(ROOT + '/' + f, 'utf8');
  } catch {
    continue;
  }
  for (const m of txt.matchAll(/\sd\s*=\s*"([^"]+)"/g)) {
    let segs;
    try {
      segs = parsePathD(m[1]);
    } catch {
      continue;
    }
    let cur = null,
      bad = false;
    const flush = () => {
      if (cur && cur.length >= 2) all.push(cur);
      cur = null;
    };
    for (const s of segs) {
      if (s.subStart) flush();
      if (!cur) cur = [];
      if (s.type === 0 && s.p2) cur.push({ t: 'line', P: [s.p1, s.p2] });
      else if (s.type === 1 && s.p3) cur.push({ t: 'quad', P: [s.p1, s.p2, s.p3] });
      else if (s.type === 2 && s.p4) {
        const P = [s.p1, s.p2, s.p3, s.p4];
        const ts = cubicInflections(P)
          .concat(cubicLoopCuts(P))
          .sort((a, b) => a - b);
        let pr = 0;
        for (const t of ts) {
          if (t - pr > 1e-4) {
            cur.push({ t: 'cubic', P: cubicSlice(P, pr, t) });
            pr = t;
          }
        }
        cur.push({ t: 'cubic', P: cubicSlice(P, pr, 1) });
      } else if (s.type === 3) {
        const q = arcToRQuads(s);
        if (!q.length) {
          bad = true;
          break;
        }
        cur.push(...q);
      } else {
        bad = true;
        break;
      }
    }
    if (!bad) flush();
  }
}

const bins = new Map();
for (const curves of all) {
  const n = curves.length;
  const b = n <= 3 ? 3 : n <= 5 ? 5 : n <= 8 ? 8 : n <= 12 ? 12 : n <= 20 ? 20 : n <= 40 ? 40 : 80;
  cpStatsReset();
  const t0 = process.hrtime.bigint();
  try {
    convertContour(curves, { maxCurves: 8, tolPx: 0.05 });
  } catch {
    continue;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const e = bins.get(b) || {
    n: 0,
    ms: 0,
    curves: 0,
    validate: 0,
    leak: 0,
    score: 0,
    cuts: 0,
    nodes: 0,
  };
  e.n++;
  e.ms += ms;
  e.curves += n;
  for (const k of ['validate', 'leak', 'score', 'cuts', 'nodes']) e[k] += cpStats[k];
  bins.set(b, e);
}
console.log('curves  contours   ms/contour   nodes   validate     leak    score     cuts');
const keys = [...bins.keys()].sort((a, b) => a - b);
for (const k of keys) {
  const e = bins.get(k);
  console.log(
    `${String('<=' + k).padStart(6)} ${String(e.n).padStart(9)} ${(e.ms / e.n).toFixed(2).padStart(12)}` +
      ` ${(e.nodes / e.n).toFixed(1).padStart(7)} ${(e.validate / e.n).toFixed(0).padStart(10)}` +
      ` ${(e.leak / e.n).toFixed(0).padStart(8)} ${(e.score / e.n).toFixed(0).padStart(8)} ${(e.cuts / e.n).toFixed(0).padStart(8)}`,
  );
}
// Scaling exponent from the bin means: ms ~ curves^k
const pts = keys
  .map((k) => {
    const e = bins.get(k);
    return [e.curves / e.n, e.ms / e.n];
  })
  .filter((p) => p[0] > 0 && p[1] > 0);
if (pts.length >= 2) {
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (const [x, y] of pts) {
    const lx = Math.log(x),
      ly = Math.log(y);
    sx += lx;
    sy += ly;
    sxx += lx * lx;
    sxy += lx * ly;
  }
  const nP = pts.length;
  const k = (nP * sxy - sx * sy) / (nP * sxx - sx * sx);
  console.log(`\nms scales as curves^${k.toFixed(2)}`);
  for (const nm of ['nodes', 'validate', 'leak', 'score']) {
    const p2 = keys
      .map((kk) => {
        const e = bins.get(kk);
        return [e.curves / e.n, e[nm] / e.n];
      })
      .filter((p) => p[0] > 0 && p[1] > 0);
    let ax = 0,
      ay = 0,
      axx = 0,
      axy = 0;
    for (const [x, y] of p2) {
      const lx = Math.log(x),
        ly = Math.log(y);
      ax += lx;
      ay += ly;
      axx += lx * lx;
      axy += lx * ly;
    }
    console.log(
      `${nm.padEnd(9)} scales as curves^${((p2.length * axy - ax * ay) / (p2.length * axx - ax * ax) || 0).toFixed(2)}`,
    );
  }
}
