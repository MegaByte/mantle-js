// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterFrameSmoke.mjs -- the pure part of the filter frame (renderer/filterFrame.js): the reach of a graph, the
// geometry of the frame, and the world matrix that lays the canvas into it. No GL: the render smoke
// (filterOffCanvasRenderSmoke.mjs) proves the pixels; this proves the arithmetic at every scale, including the ones no render can reach.

import {
  graphReach,
  graphFrameNeed,
  singleKindReach,
  frameGeometry,
  frameMarginUp,
  frameWorldMatrix,
} from '../src/renderer/filterFrame.js';
import { tileMaps } from '../src/filterGraph/primitives/tile.js';

let failures = 0;
const assert = (c, m) => {
  if (!c) {
    console.error('FAIL:', m);
    failures++;
  } else console.log('ok:', m);
};
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e * Math.max(1, Math.abs(a), Math.abs(b));

// ── reach ────────────────────────────────────────────────────────────────────
{
  const blur = {
    nodes: [{ type: 'feGaussianBlur', inputs: [-1], params: { sigmaX: 4, sigmaY: 2 } }],
    rootOut: 0,
  };
  const r = graphReach(blur);
  assert(r.rx === 12 && r.ry === 6, `blur 4/2 reaches 3 sigma per axis (${r.rx}, ${r.ry})`);
}
{
  // blur -> offset -> merge(with source): reach is the longest path, 12 + 5 on x
  const g = {
    nodes: [
      { type: 'feGaussianBlur', inputs: [-2], params: { sigmaX: 4, sigmaY: 4 } },
      { type: 'feOffset', inputs: [0], params: { dx: -5, dy: 3 } },
      { type: 'feMerge', inputs: [1, -1], params: {} },
    ],
    rootOut: 2,
  };
  const r = graphReach(g);
  assert(r.rx === 17 && r.ry === 15, `blur then offset sums along the path (${r.rx}, ${r.ry})`);
}
{
  const g = {
    nodes: [
      { type: 'feFlood', inputs: [], params: { rgba: [1, 0, 0, 1] } },
      { type: 'feComposite', inputs: [0, -1], params: { op: 0 } },
    ],
    rootOut: 1,
  };
  const r = graphReach(g);
  assert(r.rx === 0 && r.ry === 0, 'flood + composite is pointwise: no reach, no frame');
}
{
  const g = { nodes: [{ type: 'feTile', inputs: [-1], params: {} }], rootOut: 0 };
  assert(graphReach(g).rx === Infinity, 'feTile reads from an unbounded distance');
  const m = {
    nodes: [
      { type: 'feMorphology', inputs: [-1], params: { operator: 0, radiusX: 2.2, radiusY: 1 } },
    ],
    rootOut: 0,
  };
  assert(
    graphReach(m).rx === 3 && graphReach(m).ry === 1,
    'erode reads its radius all around, rounded up',
  );
  const c = {
    nodes: [
      {
        type: 'feConvolveMatrix',
        inputs: [-1],
        params: { orderX: 3, orderY: 5, targetX: 0, targetY: 2 },
      },
    ],
    rootOut: 0,
  };
  assert(
    graphReach(c).rx === 2 && graphReach(c).ry === 2,
    'convolve reaches the larger side of an off-center target',
  );
  const d = {
    nodes: [{ type: 'feDisplacementMap', inputs: [-1, -1], params: { scale: 15 } }],
    rootOut: 0,
  };
  assert(graphReach(d).rx === 8, 'displacement reaches half its scale, rounded up');
}
{
  const k = singleKindReach({ kind: 1, sigmaX: 2, sigmaY: 3 }, 2, 2);
  assert(k.rx === 12 && k.ry === 18, 'single-kind blur: 3 sigma in device px');
  assert(singleKindReach({ kind: 6, orderX: 3, orderY: 3 }, 1, 1).rx === 3, 'single-kind convolve');
}

// ── what a graph needs ───────────────────────────────────────────────────────
{
  const blur = {
    nodes: [{ type: 'feGaussianBlur', inputs: [-1], params: { sigmaX: 10, sigmaY: 10 } }],
    rootOut: 0,
  };
  assert(
    graphFrameNeed(blur, 5) === 5,
    'a single blur needs min(reach, protrusion): the source ends 5 px out',
  );
  assert(
    graphFrameNeed(blur, 500) === 30,
    'a single blur needs its 3 sigma when the source goes on',
  );
  // A shadow of a shape far outside the view: blur grows the source (G = 23), the offset (123) brings the growth back. The source
  // ends 120 px out, but the BLURRED source must be known to 123: min(D_blur = 123, 120 + 23) = 123 > 120.
  const sh = {
    nodes: [
      { type: 'feGaussianBlur', inputs: [-2], params: { sigmaX: 7.6, sigmaY: 7.6 } },
      { type: 'feOffset', inputs: [0], params: { dx: 123, dy: 0 } },
      { type: 'feFlood', inputs: [], params: { rgba: [0, 0, 0, 1] } },
      { type: 'feComposite', inputs: [2, 1], params: { op: 0 } },
    ],
    rootOut: 3,
  };
  const need = graphFrameNeed(sh, 120);
  assert(
    need === 123,
    `a blurred, offset shadow needs the node's downstream reach, not the source's protrusion (${need})`,
  );
  assert(
    graphFrameNeed(sh, 20) === 43,
    'a source 20 px out: its blur reaches 43 px, which the offset brings back',
  );
  const pointwise = {
    nodes: [
      { type: 'feFlood', inputs: [], params: {} },
      { type: 'feComposite', inputs: [0, -1], params: {} },
    ],
    rootOut: 1,
  };
  assert(graphFrameNeed(pointwise, 999) === 0, 'a pointwise graph needs nothing');
  const tile = { nodes: [{ type: 'feTile', inputs: [-1], params: {} }], rootOut: 0 };
  assert(
    graphFrameNeed(tile, 77) === 77,
    'feTile needs the whole of the source that is out there, and no more',
  );
  const two = {
    nodes: [
      { type: 'feGaussianBlur', inputs: [-1], params: { sigmaX: 2, sigmaY: 30 } },
      { type: 'feOffset', inputs: [0], params: { dx: 40, dy: 0 } },
    ],
    rootOut: 1,
  };
  assert(
    graphFrameNeed(two, 1000) === 90,
    'the axes are taken separately (x reaches 6 + 40 = 46, y reaches 90) and the larger wins',
  );
}

// ── geometry ─────────────────────────────────────────────────────────────────
const geo = (o) => frameGeometry({ cw: 128, ch: 128, maxDim: 16384, ...o });
{
  assert(
    geo({ need: 0 }) === null,
    'no need, no frame (a shape inside the canvas draws byte-identical to before)',
  );
  const f = geo({ need: 30 });
  assert(
    f.s === 1 && f.m === 32 && f.Mc === 32 && f.W === 128 + 64,
    `need 30 + 2 slack -> margin 32, on this canvas's grid of 16 (${f.m}, W ${f.W})`,
  );
  const f2 = frameGeometry({ need: 30, cw: 1024, ch: 768, maxDim: 16384 });
  assert(
    f2.m === 64 && f2.W === 1024 + 128 && f2.H === 768 + 128,
    `...and up to 64 on a larger canvas's grid (${f2.m})`,
  );
  const f3 = frameGeometry({ need: 30, cw: 40, ch: 3000, maxDim: 16384 });
  assert(f3.m === 32, `...the short side sets the step (${f3.m})`);
  for (const need of [1, 3, 5, 31, 100, 257, 4000]) {
    const g = geo({ need });
    assert(
      g.m % 2 === 0 && g.W % 2 === 0,
      `margin and size are even (need ${need}: m ${g.m}, W ${g.W})`,
    );
  }
}
{
  // Scale: the frame degrades by powers of two and covers the wanted margin at every need up to 2^24 px.
  let ok = true,
    worst = 0;
  for (let e = 0; e <= 24; e++) {
    const need = 2 ** e;
    const g = frameGeometry({ need, cw: 1920, ch: 1080, maxDim: 16384 });
    const covers = g.Mc >= need + 2 - 2 * g.s && g.W * g.s >= 1920 + 2 * g.Mc;
    const fits =
      g.W <= 16384 && g.H <= 16384 && g.W * g.H <= Math.max(4096 * 4096, 2 * 1920 * 1080);
    if (!covers || !fits) {
      ok = false;
      console.error('  bad frame at need 2^' + e, g);
    }
    worst = Math.max(worst, g.s);
    if (e <= 9 && g.s !== 1) {
      ok = false;
      console.error('  degraded too early at 2^' + e, g);
    }
  }
  assert(
    ok,
    `need 1 .. 2^24 px: every frame covers its margin, fits the budget, and is exact up to 2^9 (worst scale ${worst})`,
  );
  const huge = frameGeometry({ need: 1e12, cw: 128, ch: 128, maxDim: 16384 });
  assert(
    huge && huge.W >= 2 && huge.W <= 16384,
    `an absurd need still yields a bounded frame (s ${huge.s}, ${huge.W}x${huge.H})`,
  );
  const small = frameGeometry({ need: 5000, cw: 128, ch: 128, maxDim: 2048 });
  assert(
    small.W <= 2048 && small.degraded,
    'the device limit forces a degrade, not an oversize target',
  );
  const big = frameGeometry({ need: 300, cw: 3840, ch: 2160, maxDim: 16384 });
  assert(
    big.s === 1,
    'a 4K canvas with a 300 px margin is exact (the budget is at least twice the canvas)',
  );
}
{
  // The margin's grid: a moving shape keeps its frame's size between crossings, and a zoom crosses a logarithmic number of sizes.
  const seen = new Set();
  let monotone = true,
    covers = true,
    even = true,
    tight = true,
    last = 0;
  for (let need = 1; need <= 1500; need++) {
    // (past that, the default budget degrades this canvas's frame)
    const g = frameGeometry({ need, cw: 1024, ch: 1024, maxDim: 16384 });
    seen.add(g.m);
    if (g.m < last) monotone = false;
    if (g.m < need + 2) covers = false;
    if (g.m % 2) even = false;
    if (g.m >= need + 2 + Math.max(64, (need + 2) / 8) + 2) tight = false;
    last = g.m;
  }
  assert(
    monotone && covers && even,
    'the margin never shrinks as the need grows, always covers it, and stays even',
  );
  assert(tight, 'the margin is at most one grid step past the need: 64 px, or 1/8 of the margin');
  assert(seen.size <= 20, `a need from 1 to 1500 px crosses few sizes (${seen.size})`);
  assert(
    frameMarginUp(64) === 64 && frameMarginUp(frameMarginUp(1000)) === frameMarginUp(1000),
    'a margin on the grid stays where it is',
  );
  // The grid never spends the budget: what fits exactly at s stays at s, with its margin capped at what fits, and a capped margin is steady.
  for (const [cw, ch, maxPixels, maxDim] of [
    [1024, 1024, 2100000, 16384],
    [1024, 768, 2200000, 16384],
    [511, 397, 500000, 16384],
    [1024, 1024, 4096 * 4096, 1100],
    [1920, 1080, 4147200, 2000],
  ]) {
    let sOk = true,
      fitOk = true,
      steadyOk = true,
      exactOk = true,
      prev = null;
    for (let need = 1; need <= 3000; need += 3) {
      const g = frameGeometry({ need, cw, ch, maxDim, maxPixels });
      const budget = Math.max(maxPixels, 2 * cw * ch);
      let s = 1;
      for (; s <= 2 ** 30; s *= 2) {
        const c = Math.max(1, Math.ceil((need + 2) / s)),
          m = c + (c & 1),
          W = Math.ceil(cw / s) + 2 * m,
          H = Math.ceil(ch / s) + 2 * m;
        if (W <= maxDim && H <= maxDim && W * H <= budget) break;
      }
      if (g.s !== s) sOk = false;
      if (!(g.W <= maxDim && g.H <= maxDim && g.W * g.H <= budget)) fitOk = false;
      if (g.m * g.s < need + 2 - 2 * g.s) fitOk = false;
      if (prev && prev.s === g.s && g.m < prev.m) steadyOk = false;
      if (g.s > 1) {
        const c = Math.max(1, Math.ceil((need + 2) / g.s));
        if (g.m !== c + (c & 1)) exactOk = false;
      }
      prev = g;
    }
    assert(
      sOk,
      `${cw}x${ch}, budget ${maxPixels}, limit ${maxDim}: the grid does not change when a frame degrades`,
    );
    assert(fitOk && steadyOk, `...and every frame fits and covers its margin`);
    assert(exactOk, '...and a degraded frame keeps the exact margin');
  }
}

// ── world matrix ─────────────────────────────────────────────────────────────
// A canvas pixel must land where the frame says: p_frame = (p_canvas + Mc) / s. Checked through the fit the shader applies.
function project(m, x, y) {
  const w = m[2] * x + m[5] * y + m[8];
  return [(m[0] * x + m[3] * y + m[6]) / w, (m[1] * x + m[4] * y + m[7]) / w];
}
const toPx = (c, n) => ((c + 1) * n) / 2;
for (const fr of [
  { cw: 128, ch: 128, s: 1, m: 32, Mc: 32, W: 192, H: 192 },
  { cw: 400, ch: 300, s: 1, m: 14, Mc: 14, W: 428, H: 328 },
  { cw: 400, ch: 300, s: 8, m: 6, Mc: 48, W: 50 + 12, H: 38 + 12 },
]) {
  let worst = 0;
  const world = [0.7, 0.2, 0, -0.15, 0.9, 0, 0.1, -0.05, 1];
  const arC = [1, 0.75],
    arF = [1, 0.8]; // any two fits: the matrix undoes their ratio
  for (const [x, y] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
    [0.3, -0.2],
    [0, 0],
  ]) {
    // canvas clip of the point under the canvas fit, then the frame clip of the same point under the frame fit
    const unit = [x, y];
    const clipC = project(world, unit[0] * arC[0], unit[1] * arC[1]);
    const m2 = frameWorldMatrix(Float32Array.from(world), arC, arF, fr);
    const clipF = project(m2, unit[0] * arF[0], unit[1] * arF[1]);
    const pcx = toPx(clipC[0], fr.cw),
      pcy = toPx(clipC[1], fr.ch);
    const pfx = toPx(clipF[0], fr.W),
      pfy = toPx(clipF[1], fr.H);
    worst = Math.max(
      worst,
      Math.abs(pfx - (pcx + fr.Mc) / fr.s),
      Math.abs(pfy - (pcy + fr.Mc) / fr.s),
    );
  }
  assert(
    worst < 1e-3,
    `world matrix puts canvas pixel p at frame pixel (p + Mc) / s (${fr.cw}x${fr.ch} s=${fr.s}, worst ${worst.toExponential(2)} px)`,
  );
}
{
  const f = { cw: 100, ch: 100, s: 1, m: 0, Mc: 0, W: 100, H: 100 };
  const id = frameWorldMatrix(null, [1, 1], [1, 1], f);
  assert(
    Array.from(id).every((v, i) => near(v, [1, 0, 0, 0, 1, 0, 0, 0, 1][i])),
    'no margin and no scale: the identity (a frame of nothing changes nothing)',
  );
}

// ── a source that stops SHORT of the edge (signed protrusion) ───────
{
  const blur = {
    nodes: [{ type: 'feGaussianBlur', inputs: [-1], params: { sigmaX: 10, sigmaY: 10 } }],
    rootOut: 0,
  };
  assert(
    graphFrameNeed(blur, -5) === 0 && graphFrameNeed(blur, -500) === 0,
    'a single blur of a source inside the canvas needs no frame (its own growth is cut by the canvas, as it is drawn)',
  );
  // blur (grows 30) -> offset 23: the source ends 6 px SHORT of the edge, its blur reaches 24 px past it, the offset reads that back.
  const sh = {
    nodes: [
      { type: 'feGaussianBlur', inputs: [-2], params: { sigmaX: 10, sigmaY: 10 } },
      { type: 'feOffset', inputs: [0], params: { dx: 23, dy: 0 } },
    ],
    rootOut: 1,
  };
  assert(
    graphFrameNeed(sh, -6) === 18,
    'blur then offset: a source 6 px short still has its blur tail (2.4 sigma = 24) read back: min(23, -6 + 24) = 18',
  );
  assert(
    graphFrameNeed(sh, -40) === 0,
    'blur then offset: a source 40 px short never reaches the edge: no frame',
  );
  assert(
    graphFrameNeed(sh, -26) === 0 && graphFrameNeed(sh, -24) === 0,
    'blur then offset: a source 2.4 sigma or more short: the kernel tail is under 2/255, so the frame is not taken',
  );
  assert(
    graphFrameNeed(sh, 0) === 23 && graphFrameNeed(sh, 5) === 23,
    'blur then offset: a source AT or past the edge counts the full 3 sigma (unchanged)',
  );
  // blur then blur: the second reads the first's halo, which is past the edge when the source is within 3 sigma of it.
  const bb = {
    nodes: [
      { type: 'feGaussianBlur', inputs: [-1], params: { sigmaX: 10, sigmaY: 10 } },
      { type: 'feGaussianBlur', inputs: [0], params: { sigmaX: 4, sigmaY: 4 } },
    ],
    rootOut: 1,
  };
  assert(
    graphFrameNeed(bb, -10) === 12 && graphFrameNeed(bb, -25) === 0,
    'blur then blur: the first halo tail (24) is read by the second (12) only when it crosses the edge',
  );
}

// ── feTile maps: the tile is the input subregion, wherever the render target sits ──────────────────────────
{
  const apply = (m, u) => ({
    t: [0, 1].map((k) => {
      const v = u[k] * m.a[k] + m.a[2 + k];
      return v - Math.floor(v);
    }),
  });
  const toIn = (m, t) => [t[0] * m.b[0] + m.b[2], t[1] * m.b[1] + m.b[3]];
  // The tile is [10, 20, 50, 40]; the input texture holds exactly that rect; the output is [-30, -20, 200, 100].
  const T = [10, 20, 50, 40],
    oR = [-30, -20, 200, 100],
    m = tileMaps(oR, T, T);
  // an output pixel at global x = 10 + 50k + 7 (any k) reads the tile at offset 7 / 50 from its left
  let worst = 0;
  for (const gx of [-33, 17, 67, 117, 167]) {
    if (gx < oR[0] || gx >= oR[0] + oR[2]) continue;
    const u = [(gx - oR[0]) / oR[2], 0.25],
      t = apply(m, u).t,
      uv = toIn(m, t);
    worst = Math.max(worst, Math.abs(uv[0] - 7 / 50));
  }
  assert(
    worst < 1e-12,
    `tile phase follows the tile origin and period, not the output rect (worst ${worst.toExponential(1)})`,
  );
  // The same tile with an input texture larger than the tile (a padded, quantized target at [-6, 14, 128, 128]): the same tile, so
  // the tile origin lands at texel (10 - -6) / 128 and its period at 50 / 128.
  const m2 = tileMaps(oR, T, [-6, 14, 128, 128]);
  const uv0 = toIn(m2, [0, 0]),
    uv1 = toIn(m2, [1, 1]);
  assert(
    near(uv0[0], 16 / 128) &&
      near(uv0[1], 6 / 128) &&
      near(uv1[0], 66 / 128) &&
      near(uv1[1], 46 / 128),
    'a padded input target does not move the tile: tile coordinate 0..1 spans the subregion inside the texture',
  );
  // Reduced offset: a huge origin offset keeps full double precision in the maps (the offset is reduced to [0, 1) on the CPU).
  const far = tileMaps([1e9 + 3, 0, 64, 64], [0, 0, 7, 7], [0, 0, 7, 7]);
  assert(
    far.a[2] >= 0 && far.a[2] < 1 && near(far.a[2], ((1e9 + 3) / 7) % 1, 1e-6),
    `the tile-coordinate offset is reduced to [0, 1) in double precision (${far.a[2]})`,
  );
  // Identity: the tile is the input's own rect and the output is that rect: a whole-texture tile, bit for bit.
  const id = tileMaps([5, 6, 70, 80], [5, 6, 70, 80], [5, 6, 70, 80]);
  assert(
    id.a.join() === '1,1,0,0' && id.b.join() === '1,1,0,0',
    'tile = input rect = output rect: the identity maps',
  );
}

if (failures) {
  console.error(`filterFrameSmoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('filterFrameSmoke: PASS');
