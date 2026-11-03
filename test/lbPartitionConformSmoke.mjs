// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbPartitionConformSmoke.mjs — THE PARTITION'S MESH MUST BE CONFORMING.
//
// A T-junction is a vertex of one face lying strictly inside another face's edge. The two faces
// then rasterize that edge from different endpoints, and where they disagree the pixel is reached
// by neither: a dropped pixel is a T-junction at distance ZERO. `healCracks` exists for exactly
// this and is called from `buildLoopBlinnMesh` and the ramped refresh — but it cannot serve
// `buildLoopBlinnPartition`: it closes the interior against `quads` only, while the partition's
// crescents are mostly `cubics`. The partition runs its own conform pass.
//
// Without that pass tiger at 512 px has T-junctions across many shapes (probes/lbAccuracy/
// _partitionTjunctions.mjs and the exact one-ulp count below), and fill the mesh does not put
// down over pixels the path covers FULLY. With it, 0 T-junctions; the residue is the probe's own
// window, which is 2^-16 of the shape span where a true T-vertex sits within one float32 ulp of
// the edge.
//
// THE FIXTURE IS REAL ART, not a construction: shape 9 of the standard tiger, three cubics, six
// T-junctions without the pass. It is inlined so the test needs no artwork.
//
// ...AND THE CLOSURE MUST NOT MANUFACTURE WHAT THE BUILDER'S own DROP REFUSES (section 5). The
// partition drops cubic pieces whose hull has collapsed toward a point, and that drop runs early,
// before the over-paint audit, because a collapsed hull's implicit is computed ON that hull and its
// verdict is noise. `conformMeshFaces` runs LAST and CREATES faces: split near the thin end of an
// already-thin crescent, a child lands below the drop's bar — a collapsed face manufactured after
// the drop has walked past, enough on the stroke-stripped tiger to fail `lbDegenerateCubicDropSmoke`
// (a GPU-lane smoke, which is why this Node twin exists). So the drop is applied again to what the
// mesh SHIPS.
//
// Asserted on the BUILD, so it needs no GPU.
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { tjUlp } from '../src/renderer/lbInteriorSplit.js';
import { mkCubic, mkLine, mkQuad } from '../src/primitives/seg.js';
import { rayWinding } from '../src/geom/lbContour.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

/** Every triangle the mesh will draw, whichever family it belongs to. */
function facesOf(mesh) {
  const F = [];
  const I = mesh.interior || new Float32Array(0);
  for (let t = 0; t + 5 < I.length; t += 6)
    F.push([
      [I[t], I[t + 1]],
      [I[t + 2], I[t + 3]],
      [I[t + 4], I[t + 5]],
    ]);
  for (const q of mesh.quads || []) {
    if (q.circle) continue; // an SDF kind ignores mesh edges
    const T = q.tri || q.hull;
    if (!T || T.length !== 6) continue;
    F.push([
      [T[0], T[1]],
      [T[2], T[3]],
      [T[4], T[5]],
    ]);
  }
  for (const c of mesh.cubics || []) {
    const T = c.hull || c.tri;
    if (!T || T.length !== 6) continue;
    F.push([
      [T[0], T[1]],
      [T[2], T[3]],
      [T[4], T[5]],
    ]);
  }
  return F;
}

/**
 * T-junctions under the builder's own definition of "on an edge": within one float32 ulp of the
 * largest coordinate involved (`tjUlp`), strictly interior to the edge. Scale-free by
 * construction — the gate is a relative one, so the count says the same thing at every size.
 */
function tjunctions(mesh) {
  const F = facesOf(mesh);
  const V = [],
    E = [];
  for (const P of F) {
    for (const p of P) V.push(p);
    for (let k = 0; k < 3; k++) E.push([P[k], P[(k + 1) % 3]]);
  }
  let n = 0;
  for (const p of V)
    for (const [A, B] of E) {
      const dx = B[0] - A[0],
        dy = B[1] - A[1],
        L2 = dx * dx + dy * dy;
      const u = tjUlp(A, B, p);
      if (!(L2 > u * u)) continue;
      const t = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2;
      if (t < 0.02 || t > 0.98) continue;
      const cx = p[0] - A[0] - t * dx,
        cy = p[1] - A[1] - t * dy;
      if (cx * cx + cy * cy > u * u) continue;
      n++;
    }
  return n;
}

/**
 * THE FACES TILE: sampled on a grid over the mesh, no point lies in two faces and no point of the
 * fill lies in none. A heal that LOSES a piece leaves a hole and one that duplicates a piece leaves
 * an overlap, so this is the absolute form of "the closure repartitions, it does not drop or add
 * ink". Zero-area faces are counted apart (a split at a vertex one float32 ulp off its edge leaves
 * one, and it covers nothing); a sample within a relative 1e-9 of an edge takes no verdict.
 */
function tiling(mesh, contours, rule, G = 200) {
  const ar = (P) =>
    (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[1][1] - P[0][1]) * (P[2][0] - P[0][0]);
  const all = facesOf(mesh),
    F = all.filter((P) => ar(P) !== 0);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const P of F)
    for (const p of P) {
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
  const inFill = (x, y) => {
    const w = contours.reduce((a, c) => a + rayWinding(c, x, y), 0);
    return rule === 'evenodd' ? (w & 1) === 1 : w !== 0;
  };
  const inTri = (P, x, y) => {
    const d = (a, b) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    const u = d(P[0], P[1]),
      v = d(P[1], P[2]),
      w = d(P[2], P[0]),
      e = 1e-9 * (Math.abs(u) + Math.abs(v) + Math.abs(w));
    if (Math.abs(u) <= e || Math.abs(v) <= e || Math.abs(w) <= e) return -1;
    return (u > 0 && v > 0 && w > 0) || (u < 0 && v < 0 && w < 0) ? 1 : 0;
  };
  let n = 0,
    over = 0,
    hole = 0;
  for (let i = 0; i < G; i++)
    for (let j = 0; j < G; j++) {
      const x = x0 + ((x1 - x0) * (i + 0.6234)) / (G + 1),
        y = y0 + ((y1 - y0) * (j + 0.5731)) / (G + 1);
      let c = 0,
        edge = false;
      for (const P of F) {
        const r = inTri(P, x, y);
        if (r < 0) {
          edge = true;
          break;
        }
        c += r;
      }
      if (edge) continue;
      n++;
      if (c > 1) over++;
      else if (c === 0 && inFill(x, y)) hole++;
    }
  return { faces: F.length, zero: all.length - F.length, n, over, hole };
}

const build = (contours, rule, extra) => {
  let m = null;
  try {
    m = buildLoopBlinnCDT(contours, { fillRule: rule, ...(extra || {}) });
  } catch {
    m = null;
  }
  return m;
};

// ── FIXTURE: tiger shape 9, three cubics, scaled so the same drawing is asked at three sizes ────
const TIGER9 = [
  [
    [151.33706665039062, 481.50653076171875],
    [151.33706665039062, 481.50653076171875],
    [154.47637939453125, 482.6718444824219],
    [153.865478515625, 483.99609375],
  ],
  [
    [153.865478515625, 483.99609375],
    [153.2545623779297, 485.3203125],
    [63.821041107177734, 478.09881591796875],
    [52.99763107299805, 512.8997192382812],
  ],
  [
    [52.99763107299805, 512.8997192382812],
    [52.99763107299805, 512.8997192382812],
    [53.615604400634766, 478.9286804199219],
    [151.33706665039062, 481.50653076171875],
  ],
];
const tiger9 = (k) => [TIGER9.map((P) => mkCubic(...P.map((p) => [p[0] * k, p[1] * k])))];

for (const k of [2 ** -6, 1, 2 ** 6]) {
  const mesh = build(tiger9(k), 'nonzero');
  if (!mesh) {
    ok(false, `tiger9 at 2^${Math.round(Math.log2(k))}: the partition declined it`);
    continue;
  }
  ok(
    /partition|carve/.test(mesh._route || ''),
    `tiger9 at 2^${Math.round(Math.log2(k))}: route is ${mesh._route}`,
  );
  const tj = tjunctions(mesh);
  ok(
    tj === 0,
    `tiger9 at 2^${Math.round(Math.log2(k))}: ${tj} T-junctions (6 before the conform pass)`,
  );
}

// The conform pass repartitions faces; it does not drop or add ink. Against the mesh as it stands
// before the pass: total face area 661.8948 either way, faces 46 -> 48 (two of them
// zero-area splits), T-junctions 6 -> 0.
{
  const mesh = build(tiger9(1), 'nonzero');
  const t = mesh ? tiling(mesh, tiger9(1), 'nonzero') : null;
  ok(
    !!t && t.n > 30000 && t.over === 0 && t.hole === 0,
    `tiger9: the faces tile — ${t ? t.n : 0} samples, ${t ? t.over : '?'} in two faces, ${t ? t.hole : '?'} fill points in none ` +
      `(${t ? t.faces : '?'} faces, ${t ? t.zero : '?'} zero-area)`,
  );
}

// ── CONTROLS: shapes that conform without the pass must not move ─────────────────────────────────
const RING = [
  [
    [20, 4],
    [31, 4],
    [36, 9],
    [36, 20],
  ],
  [
    [36, 20],
    [36, 31],
    [31, 36],
    [20, 36],
  ],
  [
    [20, 36],
    [9, 36],
    [4, 31],
    [4, 20],
  ],
  [
    [4, 20],
    [4, 9],
    [9, 4],
    [20, 4],
  ],
];
const COUNTER = [
  [
    [20, 12],
    [26, 12],
    [28, 14],
    [28, 20],
  ],
  [
    [28, 20],
    [28, 26],
    [26, 28],
    [20, 28],
  ],
  [
    [20, 28],
    [14, 28],
    [12, 26],
    [12, 20],
  ],
  [
    [12, 20],
    [12, 14],
    [14, 12],
    [20, 12],
  ],
];
const contour = (cps) => {
  const segs = cps.map((P) => mkCubic(...P.map((p) => [p[0], p[1]])));
  segs.push(mkLine(segs[segs.length - 1].p4, segs[0].p1));
  return segs;
};
const star = (n, r0, r1) => {
  const pts = [];
  for (let i = 0; i < 2 * n; i++) {
    const a = (i / (2 * n)) * Math.PI * 2,
      r = i % 2 ? r0 : r1;
    pts.push([Math.cos(a) * r + 60, Math.sin(a) * r + 60]);
  }
  return pts.map((A, i) => {
    const B = pts[(i + 1) % pts.length];
    return mkQuad(A, [(A[0] + B[0]) / 2 + 3, (A[1] + B[1]) / 2 + 3], B);
  });
};
for (const [name, contours, rule] of [
  ['evenodd cubic ring + counter', [contour(RING), contour(COUNTER)], 'evenodd'],
  ['quad star 7', [star(7, 20, 50)], 'nonzero'],
]) {
  // 32 is the CDT's own face count for both, which the pass leaves alone; a split here would
  // show as more faces or a zero-area one.
  const after = build(contours, rule);
  const t = after ? tiling(after, contours, rule) : null;
  ok(
    !!t && t.faces === 32 && t.zero === 0,
    `${name}: already conforming, so the pass splits nothing (${t ? t.faces : '?'} faces, ${t ? t.zero : '?'} zero-area)`,
  );
  ok(
    !!t && t.n > 30000 && t.over === 0 && t.hole === 0,
    `${name}: the faces tile (${t ? t.over : '?'} overlaps, ${t ? t.hole : '?'} holes)`,
  );
  ok(!!after && tjunctions(after) === 0, `${name}: 0 T-junctions`);
}

// ── 5. THE CLOSURE MUST NOT SHIP A FACE THE DROP REFUSES ─────────────────────────────────────
// The Node twin of `lbDegenerateCubicDropSmoke`'s `collapsed` counter: a cubic hull whose every
// edge is below 0.3% of the shape's own cubic-hull diagonal. That smoke needs a GPU; this asks the
// same question of the same mesh on the CPU, and reads the same number on the stroke-stripped
// tiger.
//
// FIXTURE: shape 16 of that tiger — 26 cubics, the smallest of three shapes that get a
// manufactured collapsed face without the second drop. Inlined, so no artwork is needed.
const TIGER16 = [
  [396.9455261230469, 233.46853637695312],
  [398.1108703613281, 232.84349060058594],
  [398.094970703125, 231.1308135986328],
  [399.1190490722656, 230.8253631591797],
  [401.14776611328125, 230.21798706054688],
  [401.4373474121094, 228.3340301513672],
  [402.3519287109375, 226.94976806640625],
  [403.8933410644531, 224.62088012695312],
  [404.234130859375, 221.9141387939453],
  [405.26171875, 219.2815704345703],
  [405.7419738769531, 218.0456085205078],
  [405.7896423339844, 216.3594207763672],
  [405.23699951171875, 215.194091796875],
  [403.16412353515625, 210.8135223388672],
  [401.9246520996094, 206.4894561767578],
  [399.37860107421875, 202.2060089111328],
  [398.9053955078125, 201.41146850585938],
  [398.44281005859375, 200.00953674316406],
  [398.087890625, 198.95367431640625],
  [397.2704162597656, 196.51002502441406],
  [395.0509948730469, 194.76026916503906],
  [393.53253173828125, 192.4296112060547],
  [393.0240173339844, 191.65097045898438],
  [393.95098876953125, 190.0177459716797],
  [392.6867980957031, 189.8694305419922],
  [391.1029968261719, 189.6840362548828],
  [388.5445861816406, 188.6599578857422],
  [388.1331787109375, 190.4715118408203],
  [387.0950012207031, 195.03924560546875],
  [388.88006591796875, 199.4939727783203],
  [390.5892028808594, 203.80567932128906],
  [389.2084655761719, 205.0275115966797],
  [389.7981872558594, 206.65367126464844],
  [390.0665588378906, 208.00791931152344],
  [391.3201904296875, 214.3748321533203],
  [389.2049255371094, 220.2932891845703],
  [387.86126708984375, 226.42713928222656],
  [387.8206787109375, 226.6107635498047],
  [388.4245300292969, 226.96035766601562],
  [388.3750915527344, 227.06983947753906],
  [386.21746826171875, 231.81236267089844],
  [383.65374755859375, 236.12936401367188],
  [380.4420471191406, 240.3333740234375],
  [379.1036682128906, 242.0848846435547],
  [377.56402587890625, 243.7022247314453],
  [376.6864929199219, 245.5791015625],
  [376.0367431640625, 246.9686737060547],
  [375.3163757324219, 248.67428588867188],
  [375.7577819824219, 250.4187469482422],
  [369.6927795410156, 255.32723999023438],
  [365.7200622558594, 262.11614990234375],
  [361.1099853515625, 268.9068298339844],
  [360.29425048828125, 270.1074523925781],
  [360.80804443359375, 272.24212646484375],
  [361.7809143066406, 272.7170715332031],
  [363.2164001464844, 273.4197998046875],
  [364.90435791015625, 271.6117858886719],
  [365.73419189453125, 270.1180419921875],
  [366.4210510253906, 268.8856201171875],
  [367.0443115234375, 267.73797607421875],
  [367.9112548828125, 266.6026611328125],
  [368.14605712890625, 266.2936706542969],
  [367.83001708984375, 265.5538635253906],
  [368.0683898925781, 265.3402099609375],
  [372.7173156738281, 261.1962585449219],
  [375.6641845703125, 256.0122985839844],
  [379.9953308105469, 251.8312530517578],
  [383.4383239746094, 251.2503662109375],
  [386.1521301269531, 249.48825073242188],
  [389.2384948730469, 247.69964599609375],
  [389.78228759765625, 247.3835906982422],
  [390.7074890136719, 247.8232421875],
  [391.21954345703125, 247.47894287109375],
  [394.3147277832031, 245.40077209472656],
  [394.3111877441406, 241.80592346191406],
  [394.49835205078125, 238.43353271484375],
  [394.5866394042969, 236.87269592285156],
  [394.93267822265625, 234.54734802246094],
  [396.9455261230469, 233.46853637695312],
];
{
  // the flat point list above is one closed chain of cubics: p1 = the previous segment's p4
  const segs = [];
  for (let i = 0; i + 3 < TIGER16.length; i += 3)
    segs.push(mkCubic(TIGER16[i], TIGER16[i + 1], TIGER16[i + 2], TIGER16[i + 3]));
  const contours = [segs];
  /// The drop's own predicate, read off the shipped mesh.
  const collapsedOf = (m) => {
    const cub = (m && m.cubics) || [];
    if (!cub.length) return { n: 0, of: 0 };
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const c of cub) {
      const H = c.hull;
      for (let k = 0; k < 6; k += 2) {
        if (H[k] < x0) x0 = H[k];
        if (H[k] > x1) x1 = H[k];
        if (H[k + 1] < y0) y0 = H[k + 1];
        if (H[k + 1] > y1) y1 = H[k + 1];
      }
    }
    const diag = Math.hypot(x1 - x0, y1 - y0) || 1;
    let n = 0;
    for (const c of cub) {
      const H = c.hull;
      const e0 = Math.hypot(H[2] - H[0], H[3] - H[1]);
      const e1 = Math.hypot(H[4] - H[2], H[5] - H[3]);
      const e2 = Math.hypot(H[0] - H[4], H[1] - H[5]);
      if (Math.max(e0, e1, e2) < 3e-3 * diag) n++;
    }
    return { n, of: cub.length };
  };
  const mesh = build(contours, 'nonzero');
  ok(!!mesh, 'tiger16 builds');
  if (mesh) {
    const c = collapsedOf(mesh);
    ok(c.of > 20, `non-vacuous: ${c.of} cubic pieces shipped (the closure has something to split)`);
    ok(
      c.n === 0,
      `no face below the drop's own bar survives to the mesh (${c.n} of ${c.of}; 4 before the post-closure drop)`,
    );
    ok(tjunctions(mesh) === 0, `...and it is still conforming: ${tjunctions(mesh)} T-junctions`);
  }
  // The drop stays STATIC-only: a morph-pair build must keep every piece, or a piece degenerate at
  // the src pose and real at the dst desyncs the pair. The post-closure call carries the same gate,
  // which `lbDegenerateCubicDropSmoke` also asserts from the other side (morph invariance).
  const pair = build(contours, 'nonzero', { skipCurveInterior: true });
  const solo = build(contours, 'nonzero');
  ok(
    !!pair && !!solo && (pair.cubics || []).length >= (solo.cubics || []).length,
    `a morph-pair build keeps its pieces (${pair ? (pair.cubics || []).length : '?'} vs the static ${solo ? (solo.cubics || []).length : '?'})`,
  );
}

console.log(fail ? `lbPartitionConformSmoke: ${fail} failure(s)` : 'lbPartitionConformSmoke: PASS');
process.exit(fail ? 1 : 0);
