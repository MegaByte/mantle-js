// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbChainRaster — rasterize an asset's LB kind-0 CHAIN coverage on the CPU with the shader's own
// chainBoxCov (probes/lbEmTuned/_chainKernel.mjs), so a claim about what the GPU will show can be
// checked before anyone renders it.
//
// The draw composites faces by MAX, and a kind-0 face with the analytic-chain sentinel takes
//   cov = chainBoxCov(own chain, 2.0)           (_lbCoverage.glsl, LB_IS_INTERIOR, vTC.x > 1.5)
//   cov = min(cov, chainBoxCov(chain 2, 1.0))   when chain 2 is present
// with each chain point mapped into the pixel cell as (p - vEm) / emPerPx. emPerPx here is the
// asset's content bbox across 512 px, which is what setViewport(512,512) + drawBundle give
// (the renderer fits the CONTENT bbox, not the viewBox).
//
// ARMS. Run it twice and diff: the absolute hull budget is selected with TOL=0.00025 (the
// __LB_HULL_TOL global the builder still honours), so both arms come from one tree.
//
//   node probes/lbEmTuned/_lbChainRaster.mjs FILE.svg [FILE.svg ...]    N=512 TOL=...
//   AB=1 ... compares TOL=0.00025 against the default budget and prints the pixel diff
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { curveRangeToContours, rayWinding } = await import('../../src/geom/lbContour.js');
const { buildLbShape } = await import('../../src/renderer/lbBuildCore.js');
const { chainBoxCov } = await import('./_chainKernel.mjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
console.warn = () => {};
const N = +(process.env.N || 512);
const AB = !!process.env.AB;

const inTri = (px, py, t, I) => {
  const ax = I[t],
    ay = I[t + 1],
    bx = I[t + 2],
    by = I[t + 3],
    cx = I[t + 4],
    cy = I[t + 5];
  const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
};

/// One shape's chain faces: triangle, 5-point chain, optional chain 2, and the face bbox.
function chainFaces(raw) {
  const I = raw.interior,
    A = raw.interiorChainA,
    B = raw.interiorChainB,
    C = raw.interiorChainC;
  const D = raw.interiorChainD,
    E = raw.interiorChainE;
  if (!I || !A) return [];
  const out = [];
  for (let f = 0; f * 6 + 5 < I.length; f++) {
    const t = f * 6,
      o = f * 12;
    const P = [
      [A[o], A[o + 1]],
      [A[o + 2], A[o + 3]],
      [B[o], B[o + 1]],
      [B[o + 2], B[o + 3]],
      [C[o], C[o + 1]],
    ];
    const mode = C[o + 2];
    if (!(mode > 1.5)) continue; // not an analytic-chain face
    let P2 = null;
    if (
      D &&
      E &&
      (D[o] || D[o + 1] || D[o + 2] || D[o + 3] || E[o] || E[o + 1] || E[o + 2] || E[o + 3])
    ) {
      const q = [
        [D[o], D[o + 1]],
        [D[o + 2], D[o + 3]],
        [E[o], E[o + 1]],
        [E[o + 2], E[o + 3]],
      ];
      P2 = [q[0], q[1], q[2], q[3], q[3]];
    }
    const xs = [I[t], I[t + 2], I[t + 4]],
      ys = [I[t + 1], I[t + 3], I[t + 5]];
    out.push({
      t,
      P,
      P2,
      conic: mode > 2.5,
      bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    });
  }
  return out;
}

async function armOf(file, tol, rel) {
  const bundle = await importSvg(readFileSync(path.resolve(ROOT, file), 'utf8'));
  const meta = new Float32Array(bundle.meta, 32),
    mst = bundle.metaFloatsPerShape;
  const cf = new Float32Array(bundle.curves);
  const shapes = [];
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let s = 0; s < bundle.numShapes; s++) {
    const r = bundle.curveRangesByShape[s];
    if (!r || r.end <= r.begin) continue;
    const bb = s * mst;
    const cs = curveRangeToContours(cf, r.begin, r.end);
    if (!cs) continue;
    for (const c of cs)
      for (const sg of c)
        for (const p of [sg.p1, sg.p2, sg.p3, sg.p4]) {
          if (!p) continue;
          if (p[0] < x0) x0 = p[0];
          if (p[0] > x1) x1 = p[0];
          if (p[1] < y0) y0 = p[1];
          if (p[1] > y1) y1 = p[1];
        }
    if (tol || rel) globalThis.__MANTLE_DEBUG__ = true; // the hull tolerances are test hooks, read only under it
    if (tol) globalThis.__LB_HULL_TOL = tol;
    if (rel) globalThis.__LB_HULL_TOL_REL = rel;
    const b = buildLbShape(
      cs,
      meta[bb + 7] < 0.996 &&
        Math.floor(meta[bb + 28] + 0.5) === 0 &&
        (mst < 36 || Math.floor(meta[bb + 35] + 0.5) === 0),
      meta[bb + 13] > 0.5,
    );
    globalThis.__LB_HULL_TOL = undefined;
    globalThis.__LB_HULL_TOL_REL = undefined;
    if (b && b.raw && b.raw.interior)
      shapes.push({ s, I: b.raw.interior, faces: chainFaces(b.raw), cs, eo: meta[bb + 13] > 0.5 });
  }
  return { shapes, box: [x0, y0, x1, y1] };
}

/// MAX over the chain faces containing the pixel center. Faces with no chain, crescents and the
/// line-mode faces are NOT modelled: they are byte-identical between the arms, so they cannot
/// contribute to a difference, and this probe exists to predict the difference.
function raster(arm, box, n) {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0,
    h = y1 - y0,
    ext = Math.max(w, h);
  const emPerPx = ext / n;
  const cx0 = (x0 + x1) / 2 - (n / 2) * emPerPx,
    cy0 = (y0 + y1) / 2 - (n / 2) * emPerPx;
  const buf = new Float32Array(n * n);
  let conic = 0;
  for (const sh of arm.shapes) {
    for (const f of sh.faces) {
      if (f.conic) {
        conic++;
        continue;
      }
      const i0 = Math.max(0, Math.floor((f.bb[0] - cx0) / emPerPx) - 1),
        i1 = Math.min(n - 1, Math.ceil((f.bb[2] - cx0) / emPerPx) + 1);
      const j0 = Math.max(0, Math.floor((f.bb[1] - cy0) / emPerPx) - 1),
        j1 = Math.min(n - 1, Math.ceil((f.bb[3] - cy0) / emPerPx) + 1);
      for (let j = j0; j <= j1; j++) {
        const py = cy0 + (j + 0.5) * emPerPx;
        for (let i = i0; i <= i1; i++) {
          const px = cx0 + (i + 0.5) * emPerPx;
          if (!inTri(px, py, f.t, sh.I)) continue;
          const C = f.P.map((p) => [(p[0] - px) / emPerPx, (p[1] - py) / emPerPx]);
          let cov = chainBoxCov(C, 2.0);
          if (f.P2)
            cov = Math.min(
              cov,
              chainBoxCov(
                f.P2.map((p) => [(p[0] - px) / emPerPx, (p[1] - py) / emPerPx]),
                1.0,
              ),
            );
          const k = j * n + i;
          if (cov > buf[k]) buf[k] = cov;
        }
      }
    }
  }
  return { buf, emPerPx, conic };
}

/// |cov_model - cov_true| over the pixels the chain faces own. cov_true is area(box INTERSECT path)
/// by SxS supersampling of the shape's own winding -- the same reference coverageMiss uses.
function truthErr(arm, box, n, S) {
  const [x0, y0, x1, y1] = box,
    ext = Math.max(x1 - x0, y1 - y0);
  const emPerPx = ext / n;
  const cx0 = (x0 + x1) / 2 - (n / 2) * emPerPx,
    cy0 = (y0 + y1) / 2 - (n / 2) * emPerPx;
  let cnt = 0,
    sum = 0,
    mx = 0,
    bad = 0;
  for (const sh of arm.shapes) {
    const wind = (x, y) => {
      let w = 0;
      for (const c of sh.cs) w += rayWinding(c, x, y);
      return sh.eo ? (w & 1) !== 0 : w !== 0;
    };
    for (const f of sh.faces) {
      if (f.conic) continue;
      const i0 = Math.max(0, Math.floor((f.bb[0] - cx0) / emPerPx)),
        i1 = Math.min(n - 1, Math.ceil((f.bb[2] - cx0) / emPerPx));
      const j0 = Math.max(0, Math.floor((f.bb[1] - cy0) / emPerPx)),
        j1 = Math.min(n - 1, Math.ceil((f.bb[3] - cy0) / emPerPx));
      for (let j = j0; j <= j1; j++) {
        const py = cy0 + (j + 0.5) * emPerPx;
        for (let i = i0; i <= i1; i++) {
          const px = cx0 + (i + 0.5) * emPerPx;
          if (!inTri(px, py, f.t, sh.I)) continue;
          const C = f.P.map((p) => [(p[0] - px) / emPerPx, (p[1] - py) / emPerPx]);
          let cov = chainBoxCov(C, 2.0);
          if (f.P2)
            cov = Math.min(
              cov,
              chainBoxCov(
                f.P2.map((p) => [(p[0] - px) / emPerPx, (p[1] - py) / emPerPx]),
                1.0,
              ),
            );
          let k = 0;
          for (let b2 = 0; b2 < S; b2++)
            for (let a2 = 0; a2 < S; a2++)
              if (
                wind(px + ((a2 + 0.5) / S - 0.5) * emPerPx, py + ((b2 + 0.5) / S - 0.5) * emPerPx)
              )
                k++;
          const cT = k / (S * S);
          const e = Math.abs(cov - cT);
          cnt++;
          sum += e;
          if (e > mx) mx = e;
          if (e > 0.05) bad++;
        }
      }
    }
  }
  return { cnt, mean: sum / Math.max(1, cnt), max: mx, bad };
}

const files = process.argv.slice(2);
console.log(`${N}x${N}, chain faces only (everything else is byte-identical between the arms)`);
console.log(
  'asset                                                  faces  diff px   max |d|*255   mean|d|*255',
);
for (const file of files) {
  const B = await armOf(file, null, null);
  const rb = raster(B, B.box, N);
  let nf = B.shapes.reduce((a, s) => a + s.faces.length, 0);
  if (process.env.TRUTH) {
    const T = truthErr(B, B.box, N, +(process.env.S || 8));
    console.log(
      `${file.replace('examples/', '').padEnd(54)} ${String(nf).padStart(5)}  px ${String(T.cnt).padStart(6)}  mean|err| ${T.mean.toFixed(5)}  max ${T.max.toFixed(4)}  off>0.05 ${T.bad}`,
    );
    continue;
  }
  if (!AB) {
    console.log(
      `${file.replace('examples/', '').padEnd(54)} ${String(nf).padStart(5)}  (single arm; set AB=1 to diff)`,
    );
    continue;
  }
  // A arm: TOLREL=<fraction of the extent> compares against another scale-free budget (e.g. the
  // span/65536 one); otherwise the absolute 0.00025.
  const A = process.env.TOLREL
    ? await armOf(file, null, +process.env.TOLREL)
    : await armOf(file, 0.00025);
  const ra = raster(A, B.box, N);
  let diff = 0,
    mx = 0,
    sum = 0;
  for (let k = 0; k < rb.buf.length; k++) {
    const d = Math.abs(Math.round(ra.buf[k] * 255) - Math.round(rb.buf[k] * 255));
    if (d > 0) {
      diff++;
      sum += d;
      if (d > mx) mx = d;
    }
  }
  console.log(
    `${file.replace('examples/', '').padEnd(54)} ${String(nf).padStart(5)}  ${String(diff).padStart(7)}  ${String(mx).padStart(11)}  ${(sum / Math.max(1, diff)).toFixed(2).padStart(11)}${rb.conic ? '  (conic faces skipped: ' + rb.conic + ')' : ''}`,
  );
}
