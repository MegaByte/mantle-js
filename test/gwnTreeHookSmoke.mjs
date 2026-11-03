// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gwnTreeHookSmoke — the GWN run tree's bounds hold for a curve that hooks past its chord.
//
// A quad's chord bbox +- half its control deviation, a cubic piece's chord bbox +- its maximum perpendicular deviation,
// and a certified sub-chord's perpendicular deviation alone do not bound a curve whose hull reaches PAST its chord's
// ends: the quad M400 400 Q-300 250 110 250 reaches x = -41 where such a box stops at x = 16, its node circle misses the
// bulge, and pixels take the chord's crossing (a wrong winding, far from any AA ramp). So a quad's node box is its
// tight box, an exactly wound cubic piece's is the union with its tight box, and a grid pad is
// hypot(perpendicular, overshoot of the hull past the sub-chord's ends), with a quad quarter's perpendicular part taken
// from the quarter's own control point (dev / 16 takes it across the whole chord's direction, which a quarter that
// turns away from it exceeds -- points of lbQuadArcContainment's quad would lie outside every pad).
//
// Shapes: that quad; a hooked quad the other way round; cubics hooking past both chord ends; a plain circle and an
// unhooked quad as controls:
//   (a) GWN winding-only (float32 emulation of the shader, early exits on and off) equals the f64 point-in-fill test at
//       every pixel center;
//   (b) every certified grid cell's winding is the point-in-fill answer at its center, and no certified margin exceeds
//       the sampled distance from the cell to the outline;
//   (c) every leaf's node circle holds its pieces' curves (sampled);
//   (d) mutations in a copy of src/: the quad's chord +- deviation box, the cubic's missing union, the quarter pad across
//       the whole chord, the pads without their overshoot -- each caught by (a), (b), (c) or (e);
//   (e) every sampled point of five curves lies within its pad of the grid's polyline (taken from the encoder).
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, cpSync, rmSync, mkdtempSync } from 'fs';
import { hasCxx, buildGlslEmu, fillShapes, gwnWithoutExits, K_GWN, GWN_WIND } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const { decodeSegs } = await import('../src/hitTest/curveGeom.js');
const { pointInFill } = await import('../src/hitTest/fillCoverage.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-310 -40 1400 480">
  <path d="M 400 400 Q -300 250 110 250 L 400 250 Z"/>
  <path d="M -250 20 Q 380 120 -60 200 L -250 200 Z"/>
  <path d="M -280 260 C -420 330, 40 330, -100 260 L -100 420 L -280 420 Z"/>
  <path d="M 150 -20 C 420 60, 60 140, 330 220 C 60 180, 420 60, 150 -20 Z"/>
  <path d="M 60 120 m -40 0 a 40 40 0 1 0 80 0 a 40 40 0 1 0 -80 0 Z"/>
  <path d="M 0 -30 Q 60 -10 120 -30 L 120 20 L 0 20 Z"/>
  <path d="M 500 0 Q 1500 0 600 1 L 600 50 L 500 50 Z"/>
  <path d="M 750 300 C 630 312, 970 312, 850 300 L 850 360 L 750 360 Z"/>
</svg>`;

function inspect(b) {
  const shapes = fillShapes(b, parseMetaBin, M),
    band = new Float32Array(b.bands),
    curve = new Float32Array(b.curves);
  let gridBad = 0,
    overclaim = 0,
    cells = 0,
    circleMiss = 0,
    samples = 0;
  for (const sh of shapes) {
    const segs = decodeSegs(curve, sh.range.begin, sh.range.end);
    const g = sh.GD[1] * 4096 + sh.GD[0],
      h = (g + (sh.GD[2] + sh.GD[3] + 2) * 2) * 4;
    const nodeBase = band[h] | 0,
      nodeCount = Math.abs(band[h + 1]) | 0,
      refBase = band[h + 2] | 0,
      refCount = band[h + 3] | 0;
    const pts = [];
    for (const s of segs)
      for (let i = 0; i <= 512; i++) {
        const t = i / 512,
          u = 1 - t;
        if (s.t === 3) {
          const th = s.th0 + (s.th1 - s.th0) * t,
            ex = s.rx * Math.cos(th),
            ey = s.ry * Math.sin(th);
          pts.push([s.cx + s.cp * ex - s.sp * ey, s.cy + s.sp * ex + s.cp * ey]);
        } else if (s.t === 1)
          pts.push([
            u * u * s.x0 + 2 * u * t * s.cx + t * t * s.x1,
            u * u * s.y0 + 2 * u * t * s.cy + t * t * s.y1,
          ]);
        else if (s.t === 2)
          pts.push([
            u * u * u * s.x0 + 3 * u * u * t * s.c1x + 3 * u * t * t * s.c2x + t * t * t * s.x1,
            u * u * u * s.y0 + 3 * u * u * t * s.c1y + 3 * u * t * t * s.c2y + t * t * t * s.y1,
          ]);
        else pts.push([s.x0 + (s.x1 - s.x0) * t, s.y0 + (s.y1 - s.y0) * t]);
      }
    // (b) the grid
    const ext = (g + refBase + refCount) * 4,
      gridBase = band[ext + 2] | 0,
      gwh = band[ext + 3] | 0,
      GW = gwh >> 8,
      GH = gwh & 255;
    const ew = sh.bb[2] - sh.bb[0],
      eh = sh.bb[3] - sh.bb[1];
    const bw = ew > 0 ? ew : eh > 0 ? eh : 1,
      bh = eh > 0 ? eh : ew > 0 ? ew : 1;
    for (let gy = 0; gy < GH; gy++)
      for (let gx = 0; gx < GW; gx++) {
        const ci = gy * GW + gx,
          cell = (g + gridBase + (ci >> 1)) * 4,
          w = band[cell + (ci & 1) * 2],
          m = band[cell + (ci & 1) * 2 + 1];
        if (!(m > 0)) continue;
        cells++;
        const cx = sh.bb[0] + ((gx + 0.5) * bw) / GW,
          cy = sh.bb[1] + ((gy + 0.5) * bh) / GH;
        if ((w !== 0 ? 1 : 0) !== (pointInFill(segs, cx, cy, sh.eo) ? 1 : 0)) gridBad++;
        let d = Infinity;
        for (const p of pts) d = Math.min(d, Math.hypot(p[0] - cx, p[1] - cy));
        if (m > d - Math.hypot(bw / GW, bh / GH) / 2 + 1e-3) overclaim++;
      }
    // (c) leaf circles hold their pieces: sample each ref's own record
    for (let i = 0; i < nodeCount; i++) {
      const B = (g + nodeBase + i * 2 + 1) * 4,
        code = band[B + 3];
      if (code >= 0) continue;
      const v = -code - 1,
        rs = Math.floor(v / 64),
        rc = v % 64,
        cx = band[B],
        cy = band[B + 1],
        r = band[B + 2];
      for (let k = 0; k < rc; k++) {
        const R = (g + refBase + rs + k) * 4,
          loc = (band[R + 1] | 0) * 4096 + (band[R] | 0),
          ty = ((band[R + 2] + 0.5) | 0) % 16;
        const C = (t) => [0, 1, 2, 3].map((j) => curve[(loc + t) * 4 + j]);
        let P = null;
        if (ty === 1) {
          const a = C(1),
            c = C(2);
          P = [
            [a[0], a[1]],
            [a[2], a[3]],
            [c[0], c[1]],
          ];
        } else if (ty === 6) {
          const a = C(0),
            c = C(1);
          P = [
            [a[0], a[1]],
            [a[2], a[3]],
            [c[0], c[1]],
            [c[2], c[3]],
          ];
        } else if (ty === 4 && C(1)[3] === 0) {
          const e = C(0),
            c = C(5);
          P = [
            [e[0], e[1]],
            [c[0], c[1]],
            [c[2], c[3]],
            [e[2], e[3]],
          ];
        }
        if (!P) continue;
        for (let j = 0; j <= 64; j++) {
          const t = j / 64,
            u = 1 - t;
          const q =
            P.length === 3
              ? [0, 1].map((a) => u * u * P[0][a] + 2 * u * t * P[1][a] + t * t * P[2][a])
              : [0, 1].map(
                  (a) =>
                    u * u * u * P[0][a] +
                    3 * u * u * t * P[1][a] +
                    3 * u * t * t * P[2][a] +
                    t * t * t * P[3][a],
                );
          samples++;
          if (Math.hypot(q[0] - cx, q[1] - cy) > r * (1 + 1e-6)) circleMiss++;
        }
      }
    }
  }
  return { shapes, band, curve, gridBad, overclaim, cells, circleMiss, samples };
}
// (e) THE PADS AS CERTIFICATES: every point of every curve lies within its pad of some sub-chord of the grid's
// polyline. The grid cells are too coarse to show a missing overshoot on their own, so the polyline is taken straight
// from the encoder (deferTier3Out hands it over) and each curve is sampled against it.
const CURVES = [
  [
    [500, 0],
    [1500, 0],
    [600, 1],
  ], // a sliver quad hooking 426 units past its chord
  [
    [400, 400],
    [-300, 250],
    [110, 250],
  ], // lbQuadArcContainment's quad
  [
    [750, 300],
    [630, 312],
    [970, 312],
    [850, 300],
  ], // a cubic hooking past both chord ends
  [
    [0, 0],
    [100, 60],
    [0, 60],
    [100, 0],
  ], // a cusp cubic (type-6 pieces)
  [
    [0, 0],
    [30, 40],
    [70, 40],
    [100, 0],
  ], // controls: an arch that does not hook
];
function uncovered(texturesMod, seg) {
  const { mkLine, mkQuad, mkCubic } = SEGF;
  const P = seg,
    segs = [P.length === 3 ? mkQuad(...P) : mkCubic(...P), mkLine(P[P.length - 1], P[0])];
  const xs = P.map((p) => p[0]),
    ys = P.map((p) => p[1]);
  const out = [];
  texturesMod.buildTexturesShape(
    segs,
    1,
    1,
    [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    texturesMod.makeTexelBuffer(),
    texturesMod.makeTexelBuffer(),
    0,
    true,
    false,
    false,
    true,
    out,
    false,
    false,
  );
  const ps = out[0].polySegs,
    n = ps.length / 5;
  let bad = 0;
  for (let i = 0; i <= 4000; i++) {
    const t = i / 4000,
      u = 1 - t;
    const q =
      P.length === 3
        ? [0, 1].map((a) => u * u * P[0][a] + 2 * u * t * P[1][a] + t * t * P[2][a])
        : [0, 1].map(
            (a) =>
              u * u * u * P[0][a] +
              3 * u * u * t * P[1][a] +
              3 * u * t * t * P[2][a] +
              t * t * t * P[3][a],
          );
    let best = Infinity;
    for (let s = 0; s < n; s++) {
      const ax = ps[s * 5],
        ay = ps[s * 5 + 1],
        bx = ps[s * 5 + 2],
        by = ps[s * 5 + 3],
        pad = ps[s * 5 + 4];
      const dx = bx - ax,
        dy = by - ay,
        L2 = dx * dx + dy * dy;
      const tt = L2 > 0 ? Math.max(0, Math.min(1, ((q[0] - ax) * dx + (q[1] - ay) * dy) / L2)) : 0;
      best = Math.min(best, Math.hypot(q[0] - ax - tt * dx, q[1] - ay - tt * dy) - pad);
    }
    if (best > 1e-9 * 1000) bad++;
  }
  return bad;
}
const SEGF = await import('../src/primitives/seg.js');
function windingWrong(X, glsl) {
  if (!hasCxx()) return null;
  const out = [];
  for (const src of [glsl, gwnWithoutExits(glsl)]) {
    const emu = buildGlslEmu(ROOT, { defines: GWN_WIND, glsl: src });
    const q = [],
      want = [];
    for (const sh of X.shapes) {
      const segs = decodeSegs(X.curve, sh.range.begin, sh.range.end);
      for (let y = Math.floor(sh.bb[1]) - 1; y <= Math.ceil(sh.bb[3]) + 1; y++)
        for (let x = Math.floor(sh.bb[0]) - 1; x <= Math.ceil(sh.bb[2]) + 1; x++) {
          q.push({ k: K_GWN, GD: sh.GD, bb: sh.bb, eo: sh.eo, c: [x + 0.5, y + 0.5], ePx: [1, 1] });
          want.push(pointInFill(segs, x + 0.5, y + 0.5, sh.eo) ? 1 : 0);
        }
    }
    const r = emu.run(X.band, X.curve, q);
    out.push(r.reduce((n, v, i) => n + (v !== want[i] ? 1 : 0), 0));
  }
  return out;
}
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const { default: importSvg } = await import('../src/svg/importer.js');
const X = inspect(await importSvg(SVG, { preserveViewport: true, gwnTree: true }));
ok(
  X.shapes.length === 8 && X.shapes.every((s) => s.tree) && X.samples > 1000,
  `eight tree shapes; ${X.samples} curve samples checked against their leaf circles`,
);
const w = windingWrong(X, GLSL);
if (w)
  ok(
    w[0] === 0 && w[1] === 0,
    `(a) GWN winding-only equals the point-in-fill test at every pixel center (wrong: ${w[0]} with early exits, ${w[1]} without)`,
  );
else console.log('  SKIP (a): no C++ compiler');
ok(
  X.cells > 500 && X.gridBad === 0 && X.overclaim === 0,
  `(b) ${X.cells} certified grid cells: ${X.gridBad} with the wrong winding, ${X.overclaim} with a margin past the outline`,
);
ok(
  X.circleMiss === 0,
  `(c) every sampled curve point lies in its leaf's circle (${X.circleMiss} outside)`,
);
const TEX = await import('../src/svg/textures.js');
{
  const u = CURVES.map((c) => uncovered(TEX, c));
  ok(
    u.every((n) => n === 0),
    `(e) every sampled point of ${CURVES.length} curves lies within its pad of the grid's polyline (outside: ${u.join('/')})`,
  );
}
{
  const MUTS = [
    [
      'a quad bounded by its chord bbox +- half its control deviation',
      `          const dev = cl > 0 ? Math.abs((C[0] - A[0]) * chy - (C[1] - A[1]) * chx) / cl * 0.5 : Math.hypot(C[0] - A[0], C[1] - A[1]) * 0.5;`,
      `          const dev = cl > 0 ? Math.abs((C[0] - A[0]) * chy - (C[1] - A[1]) * chx) / cl * 0.5 : Math.hypot(C[0] - A[0], C[1] - A[1]) * 0.5;
          bbP = [Math.min(A[0], B[0]) - dev, Math.min(A[1], B[1]) - dev, Math.max(A[0], B[0]) + dev, Math.max(A[1], B[1]) + dev];`,
    ],
    [
      'an exactly wound cubic piece bounded by its chord bbox +- deviation only',
      '      if (!cheap) {\n        const tb = [0, 0, 0, 0];',
      '      if (false) {\n        const tb = [0, 0, 0, 0];',
    ],
    ['grid pads without the overshoot', '      return o;\n    };', '      return 0;\n    };'],
    [
      "a quad quarter's pad taken across the whole chord (dev / 16)",
      'polyPush(prev, nxt, Math.hypot(perp, _overshoot(prev, nxt, [ctrl]))',
      'polyPush(prev, nxt, Math.hypot(dev / 16, _overshoot(prev, nxt, [ctrl]))',
    ],
  ];
  const text = readFileSync(path.join(ROOT, 'src/svg/textures.js'), 'utf8');
  for (const [name, from, to] of MUTS) {
    if (!text.includes(from)) {
      ok(false, `(d) mutation hinge present: ${name}`);
      continue;
    }
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'gwnTreeHook-'));
    try {
      cpSync(path.join(ROOT, 'src'), path.join(tmp, 'src'), { recursive: true });
      writeFileSync(path.join(tmp, 'src/svg/textures.js'), text.split(from).join(to));
      const Y = inspect(
        await (
          await import(path.join(tmp, 'src/svg/importer.js'))
        ).default(SVG, { preserveViewport: true, gwnTree: true }),
      );
      const wy = windingWrong(Y, GLSL) || [0, 0];
      const MT = await import(path.join(tmp, 'src/svg/textures.js'));
      const unc = CURVES.map((c) => uncovered(MT, c)).reduce((a, v) => a + v, 0);
      const caught = wy[0] + wy[1] + Y.gridBad + Y.overclaim + Y.circleMiss + unc;
      ok(
        caught > 0,
        `(d) mutation "${name}" is caught (winding wrong ${wy.join('/')}, grid ${Y.gridBad}, margins ${Y.overclaim}, circle misses ${Y.circleMiss}, uncovered curve points ${unc})`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

if (fail) {
  console.error(`GWN-TREE-HOOK FAIL (${fail})`);
  process.exit(1);
}
console.log('GWN-TREE-HOOK PASS');
