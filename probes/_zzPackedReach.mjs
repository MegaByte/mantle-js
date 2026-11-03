// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzPackedReach — does the VERTEX STREAM the GPU draws contain a triangle over the point the
// audit condemned? The audit scans the mesh's `cubics` records; the packer is what turns those
// into vertices, and only the stream is evidence about what is drawn. The rendered frame is pure
// white at every condemned sample, so either the packer never emits the piece, or it emits it
// somewhere else -- and those are different bugs with different fixes.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { packLoopBlinnMesh, LB_VERT_FLOATS } from '../src/renderer/lbPack.js';
import { parseMetaBin } from '../src/core/metaBin.js';

const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const WANT = new Set((process.env.SHAPES || '176,187,189').split(',').map(Number));
const KINDNAME = {
  0: 'INTERIOR',
  2: 'CUBIC',
  4: 'CUBIC_BEZ',
  5: 'ARC',
  7: 'DISC',
  10: 'EDGE_STRIP',
  12: 'CURVE_BAND',
  13: 'CHAIN_STRIP',
};

globalThis.__lbAuditTrace = 1;
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__lbAuditOff = 1;
for (let s = 0; s < meta.numShapes; s++) {
  if (!WANT.has(s)) continue;
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r) continue;
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  globalThis.__lbAuditBad = [];
  let m = null;
  try {
    m = buildLoopBlinnCDT(curveRangeToContours(cf, r.begin | 0, r.end | 0), {
      fillRule: evenOdd ? 'evenodd' : 'nonzero',
    });
  } catch {
    m = null;
  }
  // An explicit point, in em: PXX/PXY overrides the audit's own samples so a pixel measured wrong
  // on the GPU can be put to the stream directly.
  const bad = process.env.PXX
    ? [{ p: [+process.env.PXX, +process.env.PXY], kind: 'given', f: 0 }]
    : (globalThis.__lbAuditBad || []).slice(0, +(process.env.POINTS_N || 4));
  if (!m || !bad.length) {
    console.log(`s${s}: nothing to ask (declined or no samples)`);
    continue;
  }
  // THE SHAPE'S own TIGHT BOX. The draw path fences a shape's fill to it, so a piece claiming a
  // point outside the box paints nothing no matter what its implicit says -- and the audit, which
  // knows nothing about the box, declines the shape for ink that could never reach the frame.
  let bx0 = Infinity,
    by0 = Infinity,
    bx1 = -Infinity,
    by1 = -Infinity;
  for (let i2 = r.begin | 0; i2 < (r.end | 0); i2 += 2) {
    const X = cf[i2],
      Y = cf[i2 + 1];
    if (X < bx0) bx0 = X;
    if (X > bx1) bx1 = X;
    if (Y < by0) by0 = Y;
    if (Y > by1) by1 = Y;
  }
  const pk = packLoopBlinnMesh(m);
  const V = pk && (pk.verts || pk.v);
  if (!V) {
    console.log(`s${s}: pack produced no vertex stream`);
    continue;
  }
  const nv = pk.vertexCount | 0 || (V.length / LB_VERT_FLOATS) | 0;
  console.log(
    `s${s}: ${nv} packed verts (${(nv / 3) | 0} triangles), ${bad.length} condemned samples asked`,
  );
  for (const b of bad) {
    const [x, y] = b.p;
    const hitKinds = new Map();
    const detail = [];
    for (let t = 0; t + 2 < nv; t += 3) {
      const o0 = t * LB_VERT_FLOATS,
        o1 = (t + 1) * LB_VERT_FLOATS,
        o2 = (t + 2) * LB_VERT_FLOATS;
      const ax = V[o0],
        ay = V[o0 + 1],
        bx = V[o1],
        by = V[o1 + 1],
        cx2 = V[o2],
        cy2 = V[o2 + 1];
      const d = (bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax);
      if (!(Math.abs(d) > 0)) continue;
      const w1 = ((x - ax) * (cy2 - ay) - (y - ay) * (cx2 - ax)) / d;
      const w2 = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / d;
      const w0 = 1 - w1 - w2;
      // A SEAM TOLERANCE, so a fragment sitting essentially ON a shared edge reports both faces.
      // The rasterizer gives such a pixel to exactly one of them, and if the two disagree about
      // coverage that is the jaggy -- which only shows up if the probe admits both.
      const SEAM = +(process.env.SEAM || 1e-9);
      if (w0 < -SEAM || w1 < -SEAM || w2 < -SEAM) continue;
      // aKind rides slot 5 with aSign in slot 6 (see lbPack `head`).
      const k = Math.round(V[o0 + 5]);
      hitKinds.set(k, (hitKinds.get(k) || 0) + 1);
      // THE TRIANGLE ITSELF. A face can contain the point and still paint nothing if it is
      // degenerate -- a zero-area triangle rasterises no fragment at all, which is a hole rather
      // than a coverage error, and the two need completely different fixes.
      detail.push(
        `area ${Math.abs(d / 2).toExponential(2)} em^2` +
          ` verts (${ax.toFixed(2)},${ay.toFixed(2)}) (${bx.toFixed(2)},${by.toFixed(2)}) (${cx2.toFixed(2)},${cy2.toFixed(2)})` +
          ` bary ${w0.toFixed(4)}/${w1.toFixed(4)}/${w2.toFixed(4)}`,
      );
      // THE KERNEL'S own ARITHMETIC, on the attributes the GPU actually receives: (k,l,m) ride
      // slots 2..4 and interpolate barycentrically, and the implicit is sign*(k^3 - l*m). If this
      // disagrees with the audit's verdict on the same point, the audit is reading a record the
      // packer did not ship.
      if (k === 2) {
        const K = w0 * V[o0 + 2] + w1 * V[o1 + 2] + w2 * V[o2 + 2];
        const L = w0 * V[o0 + 3] + w1 * V[o1 + 3] + w2 * V[o2 + 3];
        const M = w0 * V[o0 + 4] + w1 * V[o1 + 4] + w2 * V[o2 + 4];
        const sg = Math.sign(V[o0 + 6]) || 1;
        detail.push(`sign ${sg > 0 ? '+' : '-'} f=${(sg * (K * K * K - L * M)).toExponential(2)}`);
      }
    }
    const list = [...hitKinds].map(([k, n]) => `${KINDNAME[k] || 'k' + k}x${n}`).join(' ');
    console.log(
      `   (${x.toFixed(2)},${y.toFixed(2)}) [${b.kind}] audit f=${b.f.toExponential(2)}  stream: ${list || 'NOTHING'}  ${detail.join(' ')}  box ${x < bx0 || x > bx1 || y < by0 || y > by1 ? 'OUTSIDE' : 'inside'} [${bx0.toFixed(0)},${by0.toFixed(0)},${bx1.toFixed(0)},${by1.toFixed(0)}]`,
    );
  }
}
