// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _chainWhy — name the mechanism behind an INTERIOR-chain pixel's error.
//
// The chain kernel (chainBoxCov, _boxCov.glsl) is exact for a boundary that really is the chain:
// probes/_polyClip.mjs scores it 0.5/255 against a 256x supersample. So when it is the dominant
// painter of a wrong pixel, the wrongness is in what the face was HANDED, not in the clip. This
// asks which, per pixel:
//
//   clipped   the chain crossed the box and was shoelaced -- the exact area OF THE CHAIN. The
//             residual against the path is then the chain's departure from the outline (chords
//             standing in for arcs), and `sag` reports it as the largest distance from the box
//             center's nearest chain segment to the true outline.
//   miss/..   the chain did not cross the box and a MISS MODE answered: `solid` (forceInside),
//             `line` (chainMissCov's nearest-segment half-plane) or `term` (a terminal end, "no
//             opinion" -> solid). A miss mode is a discrete verdict and its error is not bounded
//             by any sagitta.
//   empty     the face carried no chain at all (all-zero slots) -- deep-interior by assumption.
//
//   node probes/lbAccuracy/_chainWhy.mjs FILE.svg [#shape]   CANVAS=512 TOP=25 FIT=hull
//
// ── THE CURVED COUNTER ───────────────────────────────────────────────────────────────────────
// The hypothesis this tests: Loop-Blinn is the WORST engine on a curved counter because chain
// pixels (INTERIOR_chain) take chainBoxCov's forceInside=2 miss and return a flat 1.0.
//
// On the AA corpus's own `evenOddRing` (probes/_aaAccuracy.mjs) at 192 px, on both fits and with
// OPT='{"noArcMoment":true}' (identical here, because this shape's control hull IS its path box):
//
//     AA           2.638 px^2 over 1132 edge px, mean 0.594/255, worst pixel 0.159 coverage
//     UNPAINTED    1.95 px^2 over 70 px (7.09/255)      <- the dominant painter
//     INTERIOR_chain  0.32 px^2 over TWO px, both in the canvas's own edge column
//     CUBIC 0.12/255   CUBIC_BEZ 0.06/255   miss 0.32   stray 0.003   jaggy 0
//
// So the chain is NOT the dominant painter: this probe finds 2 chain pixels off by more than 0.02
// on the whole shape, one 'empty' and one 'clipped' with a chain-to-path distance of 0.19 px, and
// the counter's dominant error is UNPAINTED. A GPU measurement at authored size against an 8x
// box-downsample is a different instrument; where the two disagree by an order of magnitude about
// the same shape, take it to the GPU.
import { loadSvg, shapesOf, viewOf, buildMesh, rasterMesh } from './_lbRaster.mjs';
import { refKit, exactCov } from './_lbAaRef.mjs';
import { decodeVert, lbVertexSetup, LBK } from './_lbKernel.mjs';
import { chainBoxCov, chainMissCov, chainFillSide, dot, sub, mul, len } from './_lbBoxCov.mjs';

console.warn = () => {};
const [file, shSel] = (process.argv[2] || '').split('#');
if (!file) {
  console.error('usage: _chainWhy.mjs FILE.svg[#shape]');
  process.exit(2);
}
const N = +(process.env.CANVAS || 512);
const TOP = +(process.env.TOP || 25);
const bundle = await loadSvg(file);
const { shapes, bbox } = await shapesOf(bundle, { fit: process.env.FIT });
const view = viewOf(bbox, N);
const { rowSpans, contoursToConverter, closed } = await refKit();

const rows = [];
for (const sh of shapes) {
  if (shSel != null && shSel !== '' && sh.s !== +shSel) continue;
  const built = await buildMesh(sh);
  if (!built) continue;
  const curves = closed(contoursToConverter(sh.contours, null));
  const acc = new Float64Array(N * N).fill(1);
  const dom = new Int32Array(N * N).fill(-1);
  const domC = new Float64Array(N * N);
  rasterMesh(built.pk, view, acc, {}, null, dom, domC);
  // every chain face, so a pixel can be re-attributed to the face that painted it
  const faces = [];
  const pk = built.pk;
  for (let t = 0; t + 2 < pk.vertexCount; t += 3) {
    const a = decodeVert(pk.verts, t + 2);
    if (a.kind !== LBK.INTERIOR || !(a.tc[0] > 1.5)) continue;
    const P = [0, 1, 2].map((q) => lbVertexSetup(decodeVert(pk.verts, t + q), view.basePx).emPos);
    faces.push({
      P,
      chain: [
        [a.C3[0], a.C3[1]],
        [a.C3[2], a.C3[3]],
        [a.C0[0], a.C0[1]],
        [a.C0[2], a.C0[3]],
        [a.tc[1], a.tc[2]],
      ],
      conic: a.tc[0] > 2.5,
    });
  }
  const inTri = (px, py, T) => {
    const s1 = (T[1][0] - T[0][0]) * (py - T[0][1]) - (T[1][1] - T[0][1]) * (px - T[0][0]);
    const s2 = (T[2][0] - T[1][0]) * (py - T[1][1]) - (T[2][1] - T[1][1]) * (px - T[1][0]);
    const s3 = (T[0][0] - T[2][0]) * (py - T[2][1]) - (T[0][1] - T[2][1]) * (px - T[2][0]);
    return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  };
  const rc = new Map();
  for (let j = 0; j < N; j++) {
    rc.clear();
    for (let i = 0; i < N; i++) {
      if (dom[j * N + i] !== 21 && dom[j * N + i] !== 22) continue;
      const ex = exactCov(rowSpans, curves, i, j, view, 64, sh.evenOdd, rc);
      if (!(ex > 1e-6 && ex < 1 - 1e-6)) continue;
      const mo = 1 - acc[j * N + i];
      const d = mo - ex;
      if (Math.abs(d) < 0.02) continue;
      const cx = view.emX(i),
        cy = view.emY(j);
      const f = faces.find((q) => inTri(cx, cy, q.P));
      let mode = 'empty',
        sag = 0;
      if (f) {
        const inv = 1 / view.basePx;
        const C = f.chain.map((p) => mul(sub(p, [cx, cy]), inv));
        const degen = C.every((p) => Math.abs(p[0]) < 1e-9 && Math.abs(p[1]) < 1e-9);
        if (degen) mode = 'empty';
        else {
          // did any segment cross the box? (the kernel's own Liang-Barsky test, in summary)
          let crossed = false;
          for (let s = 0; s < 4; s++) {
            const A = C[s],
              B = C[s + 1];
            if (Math.abs(B[0] - A[0]) + Math.abs(B[1] - A[1]) < 1e-9) continue;
            const lo = [Math.min(A[0], B[0]), Math.min(A[1], B[1])],
              hi = [Math.max(A[0], B[0]), Math.max(A[1], B[1])];
            if (hi[0] < -0.5 || lo[0] > 0.5 || hi[1] < -0.5 || lo[1] > 0.5) continue;
            crossed = true;
          }
          if (crossed) {
            mode = 'clipped';
            // sagitta: how far the nearest chain segment sits from the true outline, in px
            let best = Infinity,
              bp = null;
            for (let s = 0; s < 4; s++) {
              const A = C[s],
                B = C[s + 1];
              const dd = sub(B, A);
              const L2 = dot(dd, dd);
              if (L2 < 1e-18) continue;
              const t = Math.max(0, Math.min(1, dot(mul(A, -1), dd) / L2));
              const q = [A[0] + t * dd[0], A[1] + t * dd[1]];
              const q2 = dot(q, q);
              if (q2 < best) {
                best = q2;
                bp = q;
              }
            }
            if (bp) {
              // distance from that chain point to the path, by bisecting the exact coverage's
              // own scanline spans on the point's row
              const py = cy + bp[1] * view.basePx;
              const sp = rowSpans(curves, py, sh.evenOdd);
              const pxE = cx + bp[0] * view.basePx;
              let dmin = Infinity;
              for (const q of sp) dmin = Math.min(dmin, Math.abs(q[0] - pxE), Math.abs(q[1] - pxE));
              sag = dmin / view.basePx;
            }
          } else {
            const mc = chainMissCov(C[0], C[1], C[2], C[3], C[4]);
            mode = mc < 0 ? 'miss/term' : 'miss/line';
            if (chainBoxCov(C[0], C[1], C[2], C[3], C[4], 2.0) === 1.0 && mc < 0)
              mode = 'miss/solid';
          }
        }
      }
      rows.push({
        i,
        j,
        ex,
        mo,
        d,
        mode,
        sag,
        shape: sh.s,
        chain: f
          ? f.chain.map((p) => [(p[0] - cx) / view.basePx, (p[1] - cy) / view.basePx])
          : null,
        face: f ? f.P.map((p) => [(p[0] - cx) / view.basePx, (p[1] - cy) / view.basePx]) : null,
      });
    }
  }
}
rows.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
const byMode = {};
for (const r of rows) {
  const m = byMode[r.mode] || (byMode[r.mode] = { n: 0, err: 0, sgn: 0 });
  m.n++;
  m.err += Math.abs(r.d);
  m.sgn += r.d;
}
console.log(`${rows.length} INTERIOR-chain edge pixels off by more than 0.02 (CANVAS=${N})`);
for (const k of Object.keys(byMode).sort((a, b) => byMode[b].err - byMode[a].err))
  console.log(
    `  ${k.padEnd(11)} n=${String(byMode[k].n).padStart(5)}  err ${byMode[k].err.toFixed(3).padStart(9)} px^2  signed ${(byMode[k].sgn >= 0 ? '+' : '') + byMode[k].sgn.toFixed(3)}`,
  );
if (process.env.DUMP) {
  console.log(
    '  worst pixels, chain in CELL coordinates (pixel center at the origin, box [-0.5,0.5]):',
  );
  for (const r of rows.slice(0, +(process.env.DUMP || 5))) {
    console.log(
      `    #${r.shape} (${r.i},${r.j}) exact ${r.ex.toFixed(3)} model ${r.mo.toFixed(3)} ${r.mode}`,
    );
    console.log(
      `      chain ${r.chain ? r.chain.map((p) => '(' + p[0].toFixed(2) + ',' + p[1].toFixed(2) + ')').join(' ') : 'none'}`,
    );
    console.log(
      `      face  ${r.face ? r.face.map((p) => '(' + p[0].toFixed(2) + ',' + p[1].toFixed(2) + ')').join(' ') : 'none'}`,
    );
  }
}
console.log('  worst:');
for (const r of rows.slice(0, TOP))
  console.log(
    `    #${r.shape} (${r.i},${r.j}) exact ${r.ex.toFixed(3)} model ${r.mo.toFixed(3)} d ${(r.d >= 0 ? '+' : '') + r.d.toFixed(3)}  ${r.mode}${r.mode === 'clipped' ? '  chain-to-path ' + r.sag.toFixed(3) + ' px' : ''}`,
  );
