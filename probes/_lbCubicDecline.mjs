// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbCubicDecline — LB declines a closed contour of outward-bulging cubics (gate 'no-meshes'), so
// the whole bundle falls to Slug. Reproduced on the CPU, where the build can be interrogated
// instead of inferred from a gate string.
import { mkCubic } from '../src/svg/importer.js';
import { buildLoopBlinnMesh } from '../src/renderer/loopBlinn.js';
// The renderer does NOT call buildLoopBlinnMesh. Its bundle path is buildLbShape, and the decline
// lives in what that returns — so measure the thing that actually runs.
import { buildLbShape } from '../src/renderer/lbBuildCore.js';
import { LB_MAX_VERTS_PER_MESH } from '../src/renderer/lbPack.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { splitCubicCusps } from '../src/svg/cubicCusp.js';
import { buildLoopBlinnPartition } from '../src/renderer/lbPartition.js';

const SEGS = +(process.env.SEGS || 16);
const K = +(process.env.K || 1.35);
const R = 44,
  CX = 64,
  CY = 64;

function contour(n, k, kind) {
  const P = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    P.push([CX + R * Math.cos(a), CY + R * Math.sin(a)]);
  }
  const segs = [];
  for (let i = 0; i < n; i++) {
    const p = P[i],
      q = P[(i + 1) % n];
    const mx = (p[0] + q[0]) / 2,
      my = (p[1] + q[1]) / 2;
    const bx = CX + (mx - CX) * 1.18,
      by = CY + (my - CY) * 1.18;
    if (kind === 'degen') segs.push(mkCubic(p, [bx, by], [bx, by], q));
    else
      segs.push(
        mkCubic(
          p,
          [p[0] + (bx - p[0]) * k, p[1] + (by - p[1]) * k],
          [q[0] + (bx - q[0]) * k, q[1] + (by - q[1]) * k],
          q,
        ),
      );
  }
  return segs;
}

// buildLbShape returns null only when the CDT fails, so walk its two stages the way it does.
const stageReport = (label, segs) => {
  const contours = [segs].map(splitCubicCusps);
  let fast = null,
    fastErr = null;
  try {
    fast = buildLoopBlinnMesh(contours, true, 'nonzero');
  } catch (e) {
    fastErr = e;
  }
  let cdt = null,
    cdtErr = null;
  try {
    cdt = buildLoopBlinnCDT(contours, { fillRule: 'nonzero', transSolid: false });
  } catch (e) {
    cdtErr = e;
  }
  const fastS = fastErr
    ? 'THREW ' + String(fastErr.message).slice(0, 34)
    : !fast
      ? 'null'
      : 'fb=' + fast.fallback.length + ' concave=' + (fast.hasConcave ? 'Y' : 'n');
  // buildLoopBlinnCDT's default route IS buildLoopBlinnPartition; when that declines the CDT has
  // nothing left and returns null. Ask the partition directly, and read the error it stashes.
  globalThis.__lbPartitionErr = null;
  let part = null,
    partErr = null;
  try {
    part = buildLoopBlinnPartition(contours, { fillRule: 'nonzero' });
  } catch (e) {
    partErr = e;
  }
  const stash = globalThis.__lbPartitionErr;
  const partS = partErr
    ? 'THREW ' + String(partErr.message).slice(0, 50)
    : part
      ? 'ok tris=' + (part.interior || []).length / 2
      : 'DECLINED' + (stash ? ' (' + String(stash).slice(0, 50) + ')' : ' (clean null)');
  const cdtS = cdtErr
    ? 'THREW ' + String(cdtErr.message).slice(0, 40)
    : !cdt
      ? 'null'
      : 'fb=' + cdt.fallback.length + ' tris=' + (cdt.interior || []).length / 2;
  console.log(
    '  ' + label.padEnd(22) + 'fast[' + fastS + ']  cdt[' + cdtS + ']  partition[' + partS + ']',
  );
};

const shapeReport = (label, segs) => {
  let b = null,
    err = null;
  try {
    b = buildLbShape([segs], false, false);
  } catch (e) {
    err = e;
  }
  if (err) {
    console.log(
      '  ' + label.padEnd(22) + 'buildLbShape THREW: ' + String(err.message).slice(0, 60),
    );
    return;
  }
  if (!b) {
    console.log('  ' + label.padEnd(22) + 'buildLbShape returned null  <-- DECLINE');
    return;
  }
  const pk = b.pk;
  const why = !pk
    ? 'no pk'
    : pk.overBudget
      ? 'overBudget'
      : !(pk.vertexCount | 0)
        ? 'vertexCount 0'
        : (pk.vertexCount | 0) > LB_MAX_VERTS_PER_MESH
          ? 'over per-mesh cap'
          : '';
  console.log(
    '  ' +
      label.padEnd(22) +
      'verts ' +
      String(pk ? pk.vertexCount | 0 : -1).padStart(6) +
      (why ? '   <-- DECLINE: ' + why : '   ok'),
  );
};

const report = (label, segs) => {
  let m = null,
    err = null;
  try {
    m = buildLoopBlinnMesh([segs]);
  } catch (e) {
    err = e;
  }
  if (err) {
    console.log('  ' + label.padEnd(22) + 'THREW: ' + String(err.message).slice(0, 70));
    return;
  }
  if (!m) {
    console.log('  ' + label.padEnd(22) + 'returned null');
    return;
  }
  const fb = (m.fallback || []).length;
  const tris = (m.interior || []).length / 2;
  const cub = (m.cubics || []).length,
    qd = (m.quads || []).length;
  console.log(
    '  ' +
      label.padEnd(22) +
      'tris ' +
      String(tris).padStart(4) +
      '  cubics ' +
      String(cub).padStart(3) +
      '  quads ' +
      String(qd).padStart(3) +
      '  FALLBACK ' +
      String(fb).padStart(3) +
      (m.slug ? '  [slug sentinel]' : '') +
      (fb ? '   <-- fell back to Slug' : ''),
  );
};

console.log(
  '\n  buildLbShape — the path the RENDERER takes (R=' + R + ', ' + SEGS + ' segments)\n',
);
shapeReport('degenerate (c1==c2)', contour(SEGS, K, 'degen'));
for (const k of [1.05, 1.1, 1.2, 1.35])
  shapeReport('real cubic, ctrl x' + k, contour(SEGS, k, 'real'));
for (const n of [3, 4, 8, 16]) shapeReport('real x1.35, ' + n + ' segs', contour(n, 1.35, 'real'));

// WHERE the audit's over-paint sits. A crescent whose hull pokes outside the shape and two
// crescents co-covering are different defects; the bad sample points tell them apart.
{
  const segs = contour(4, 1.35, 'real');
  const contours = [segs].map(splitCubicCusps);
  globalThis.__lbAuditTrace = true;
  globalThis.__lbAuditBad = [];
  try {
    buildLoopBlinnPartition(contours, { fillRule: 'nonzero' });
  } catch {}
  const bad = globalThis.__lbAuditBad || [];
  globalThis.__lbAuditTrace = false;
  console.log('\n  audit over-paint samples, 4-segment real cubic: ' + bad.length + '\n');
  const seen = new Set();
  for (const b of bad.slice(0, 12)) {
    const key = b.hull.map((v) => v.toFixed(1)).join(',');
    const dc = Math.hypot(b.p[0] - CX, b.p[1] - CY);
    console.log(
      '    ' +
        b.kind.padEnd(7) +
        ' point (' +
        b.p[0].toFixed(1) +
        ',' +
        b.p[1].toFixed(1) +
        ')' +
        '  |p-centre| ' +
        dc.toFixed(1) +
        (dc > R ? '  OUTSIDE r=' + R : '  inside r=' + R) +
        '   f=' +
        b.f.toExponential(1) +
        (seen.has(key) ? '   [same hull]' : ''),
    );
    seen.add(key);
  }
  console.log('\n    distinct crescents flagged: ' + seen.size);
}

console.log('\n  the two stages buildLbShape tries, in order\n');
stageReport('degenerate (c1==c2)', contour(SEGS, K, 'degen'));
for (const n of [3, 4, 8, 16]) stageReport('real x1.35, ' + n + ' segs', contour(n, 1.35, 'real'));

console.log('\n  buildLoopBlinnMesh — the public builder, for contrast\n');
report('degenerate (c1==c2)', contour(SEGS, K, 'degen'));
for (const k of [1.05, 1.1, 1.2, 1.35]) report('real cubic, ctrl x' + k, contour(SEGS, k, 'real'));
for (const n of [3, 4, 8, 16]) report('real x1.35, ' + n + ' segs', contour(n, 1.35, 'real'));
