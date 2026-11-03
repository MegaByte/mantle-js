// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// dstRectPlacementSmoke — `drawBundle({ dstRect })` puts the content where it says it does,
// and the hit test agrees with it.
//
// WHY this IS A NODE TEST AT ALL. `dstRect` is pure arithmetic: it resolves to a clip-space
// affine that rides `uWorldM`, plus a scissor rect. Nothing about it is a shader question, so
// every property below is decidable without a GPU — and the one thing that is NOT decidable
// here (that the shader's projection is the chain this file mirrors) is asserted against
// renderer.js's own source, and measured on a GPU by probes/apiGaps/dstRectPaint.mjs.
//
// THE REFERENCE. The em→NDC chain is mantle.vert.glsl:479-481 and emRow0/emRow1 (:261-268):
//     uv    = (em - gbb.xy) / gbb.zw
//     plane = (uv*2 - 1) * canvasAR
//     clip  = (plane.x, -plane.y)   then   clip = uWorldM * clip
// and the viewport maps clip → pixels as px = (clip.x+1)/2*W, py = (1-clip.y)/2*H. Every
// expectation below is computed from THAT, independently of dstRect.js's own algebra, so an
// error in the derivation shows up as a mismatch rather than as two copies of one mistake.
//
// The load-bearing case is the FIRST one: a dstRect covering the whole viewport must be the
// identity. If it is not, every other number here is measuring the wrong thing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseDstFit,
  contentRectPx,
  fittedRectPx,
  resolveDstRect,
  bundleDrawMatrix,
} from '../src/geom/dstRect.js';
import { fillHitShape } from '../src/hitTest/hitTest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;
const rectNear = (a, b, eps = 1e-4) =>
  near(a[0], b[0], eps) && near(a[1], b[1], eps) && near(a[2], b[2], eps) && near(a[3], b[3], eps);

// ---- the fake renderer context ------------------------------------------------------------
// arScale is renderer.js's, mirrored; the source check below fails if that copy goes stale.
function arScale(bbox, vw, vh) {
  const cAR = vw / vh,
    sAR = bbox[2] / bbox[3];
  let sx = 1,
    sy = 1;
  if (sAR > cAR) sy = cAR / sAR;
  else sx = sAR / cAR;
  return [sx, sy];
}
let warns = [];
function makeR(vw, vh, scissor = null) {
  return {
    viewportSize: () => [vw, vh],
    arScale,
    mantleWarn: (m) => warns.push(m),
    _scissor: scissor,
  };
}

// The shader chain, as a function. em (x, y) → viewport pixels (y-down), given the bundle bbox,
// the viewport and an optional clip-space mat3 (column-major) standing in for uWorldM.
function emToPxRef(bb, vw, vh, M) {
  const [arx, ary] = arScale(bb, vw, vh);
  return (ex, ey) => {
    const ux = (ex - bb[0]) / bb[2],
      uy = (ey - bb[1]) / bb[3];
    const planeX = (ux * 2 - 1) * arx,
      planeY = (uy * 2 - 1) * ary;
    let cx = planeX,
      cy = -planeY;
    if (M) {
      const nx = M[0] * cx + M[3] * cy + M[6];
      const ny = M[1] * cx + M[4] * cy + M[7];
      cx = nx;
      cy = ny;
    }
    return [((cx + 1) / 2) * vw, ((1 - cy) / 2) * vh];
  };
}
// Apply a column-major mat3 to a point (the same convention fillHitShape inverts).
const applyM = (m, x, y) => [m[0] * x + m[3] * y + m[6], m[1] * x + m[4] * y + m[7]];

// A 40x20 bundle (aspect 2:1) at em origin (10, 5) — offset on both axes so a translation
// error cannot hide, and non-square so a swapped axis cannot either.
const BB = [10, 5, 40, 20];
const VW = 400,
  VH = 400;

// ===========================================================================================
console.log('\n-- fit vocabulary (preserveAspectRatio) --');
ok(
  JSON.stringify(parseDstFit(undefined)) ===
    JSON.stringify({ ax: 0.5, ay: 0.5, slice: false, stretch: false }),
  'default is xMidYMid meet',
);
ok(
  parseDstFit('xMinYMax slice').ax === 0 &&
    parseDstFit('xMinYMax slice').ay === 1 &&
    parseDstFit('xMinYMax slice').slice === true,
  'xMinYMax slice parses to (0, 1, slice)',
);
ok(
  parseDstFit('xMaxYMin').ax === 1 &&
    parseDstFit('xMaxYMin').ay === 0 &&
    !parseDstFit('xMaxYMin').slice,
  'meet is the default qualifier',
);
ok(parseDstFit('none').stretch === true, "'none' stretches");
ok(
  parseDstFit('none meet') === null,
  "'none meet' is rejected (meet/slice are meaningless with none)",
);
ok(parseDstFit('xMidYMid cover') === null, "'cover' is not the vocabulary ('slice' is)");
ok(parseDstFit('xmidymid') === null, 'the align keyword is case-sensitive, as in SVG');
ok(parseDstFit(42) === null, 'a non-string fit is rejected');

// ===========================================================================================
console.log('\n-- the default fit, and the full-viewport rect that must be its identity --');
{
  const R = makeR(VW, VH);
  const c = contentRectPx(R, BB);
  // 2:1 content in a square viewport: full width, half height, centered.
  ok(rectNear(c, [0, 100, 400, 200]), `content rect is the centered letterbox (${c})`);

  const ref = emToPxRef(BB, VW, VH, null);
  const m = bundleDrawMatrix(R, { globalBBox: BB }, null);
  const corners = [
    [10, 5],
    [50, 5],
    [10, 25],
    [50, 25],
  ];
  let agree = true;
  for (const [ex, ey] of corners) {
    const a = applyM(m, ex, ey),
      b = ref(ex, ey);
    if (!near(a[0], b[0]) || !near(a[1], b[1])) agree = false;
  }
  ok(agree, 'bundleDrawMatrix with no opts reproduces the shader chain exactly');

  // THE ANCHOR: a dstRect over the whole viewport is a no-op.
  const res = resolveDstRect(R, { globalBBox: BB }, { dstRect: [0, 0, VW, VH] });
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let isI = true;
  for (let i = 0; i < 9; i++) if (!near(res.worldM[i], I[i], 1e-6)) isI = false;
  ok(isI, `dstRect = the whole viewport is the identity matrix (${Array.from(res.worldM)})`);
}

// ===========================================================================================
console.log('\n-- meet / slice / none place the content where they promise --');
{
  const R = makeR(VW, VH);
  const bundle = { globalBBox: BB };
  const D = [50, 60, 200, 200]; // a square rect, offset from the origin
  const content = contentRectPx(R, BB); // 400 x 200

  // meet: scale = min(200/400, 200/200) = 0.5 → 200 x 100, centered in D.
  {
    const t = fittedRectPx(D, content, parseDstFit(undefined));
    ok(rectNear(t, [50, 110, 200, 100]), `meet letterboxes: ${t}`);
    const m = bundleDrawMatrix(R, bundle, { dstRect: D });
    const tl = applyM(m, BB[0], BB[1]),
      br = applyM(m, BB[0] + BB[2], BB[1] + BB[3]);
    ok(
      near(tl[0], 50) && near(tl[1], 110) && near(br[0], 250) && near(br[1], 210),
      `meet: the bbox corners land on the fitted rect (${tl} .. ${br})`,
    );
    ok(
      near((br[0] - tl[0]) / (br[1] - tl[1]), BB[2] / BB[3]),
      'meet preserves the content aspect ratio',
    );
  }
  // slice: scale = max(0.5, 1) = 1 → 400 x 200 covering D, centered, overflowing in x.
  {
    const t = fittedRectPx(D, content, parseDstFit('xMidYMid slice'));
    ok(rectNear(t, [-50, 60, 400, 200]), `slice covers and overflows: ${t}`);
    const m = bundleDrawMatrix(R, bundle, { dstRect: D, fit: 'xMidYMid slice' });
    const tl = applyM(m, BB[0], BB[1]),
      br = applyM(m, BB[0] + BB[2], BB[1] + BB[3]);
    ok(tl[0] < D[0] && br[0] > D[0] + D[2], 'slice spills past both vertical edges of the rect');
    ok(near(tl[1], 60) && near(br[1], 260), 'slice exactly covers the rect on the tight axis');
  }
  // none: stretch to fill, aspect broken on purpose.
  {
    const m = bundleDrawMatrix(R, bundle, { dstRect: D, fit: 'none' });
    const tl = applyM(m, BB[0], BB[1]),
      br = applyM(m, BB[0] + BB[2], BB[1] + BB[3]);
    ok(
      near(tl[0], 50) && near(tl[1], 60) && near(br[0], 250) && near(br[1], 260),
      `none fills the rect exactly (${tl} .. ${br})`,
    );
  }
  // alignment moves the letterbox inside the rect, and only that.
  for (const [fit, wantX, wantY] of [
    ['xMinYMin meet', 50, 60],
    ['xMaxYMax meet', 50, 160],
    ['xMidYMin meet', 50, 60],
  ]) {
    const t = fittedRectPx(D, content, parseDstFit(fit));
    ok(near(t[0], wantX) && near(t[1], wantY), `${fit} anchors at (${wantX}, ${wantY}) — got ${t}`);
  }
}

// ===========================================================================================
console.log('\n-- the rect clip --');
{
  const R = makeR(VW, VH);
  const bundle = { globalBBox: BB };
  const res = resolveDstRect(R, bundle, { dstRect: [50, 60, 200, 100] });
  // y-down [50, 60, 200, 100] → GL scissor origin lower-left: y = 400 - (60 + 100) = 240.
  ok(
    res.scissor[0] === 50 &&
      res.scissor[1] === 240 &&
      res.scissor[2] === 200 &&
      res.scissor[3] === 100,
    `scissor is the rect, y-flipped (${res.scissor})`,
  );
  ok(
    resolveDstRect(R, bundle, { dstRect: [50, 60, 200, 100], clipToRect: false }).scissor === null,
    'clipToRect: false leaves the frame unscissored',
  );

  // An outer setScissorRect is INTERSECTED, never widened.
  // Outer [100, 250, 50, 50] covers GL x 100..150, y 250..300; the rect covers x 50..250,
  // y 240..340. The intersection is the outer rect, entirely inside the per-draw one.
  const R2 = makeR(VW, VH, [100, 250, 50, 50]);
  const s = resolveDstRect(R2, bundle, { dstRect: [50, 60, 200, 100] }).scissor;
  ok(
    s[0] === 100 && s[1] === 250 && s[2] === 50 && s[3] === 50,
    `a per-draw rect intersects the caller's scissor (${s})`,
  );
  // …and the other way: an outer scissor that only half-overlaps is cut by the rect.
  const R2b = makeR(VW, VH, [0, 300, 400, 100]); // GL y 300..400; rect tops out at 340
  const s2 = resolveDstRect(R2b, bundle, { dstRect: [50, 60, 200, 100] }).scissor;
  ok(
    s2[0] === 50 && s2[1] === 300 && s2[2] === 200 && s2[3] === 40,
    `the rect cuts the caller's scissor too — neither widens the other (${s2})`,
  );
  const R3 = makeR(VW, VH, [300, 0, 10, 10]); // disjoint from the rect
  const s3 = resolveDstRect(R3, bundle, { dstRect: [50, 60, 200, 100] }).scissor;
  ok(
    s3[2] === 0 || s3[3] === 0,
    'a disjoint outer scissor leaves an empty rect, not a negative one',
  );
}

// ===========================================================================================
console.log("\n-- composition with the caller's worldMatrix, and the refusals --");
{
  const R = makeR(VW, VH);
  const bundle = { globalBBox: BB };
  // A clip-space translate of +0.5 in x, then the rect placement. Order is A*W: the caller's
  // matrix acts in the frame it always acted in, and the rect is applied ON TOP.
  const W = [1, 0, 0, 0, 1, 0, 0.5, 0, 1];
  const D = [0, 0, 200, 400];
  const res = resolveDstRect(R, bundle, { dstRect: D, worldMatrix: W });
  const A = resolveDstRect(R, bundle, { dstRect: D }).worldM.slice();
  // A*W translates by A's x-scale times 0.5 — i.e. the caller's shift is scaled INTO the rect.
  ok(near(res.worldM[6], A[6] + A[0] * 0.5), 'dstRect composes as A*W (caller first, rect on top)');
  ok(
    near(res.worldM[0], A[0]) && near(res.worldM[4], A[4]),
    'the linear part is unchanged by a pure translate',
  );

  warns = [];
  ok(
    resolveDstRect(R, bundle, { dstRect: [0, 0, 0, 100] }) === null && warns.length === 1,
    'a zero-width rect is refused with a warning, not drawn',
  );
  warns = [];
  ok(
    resolveDstRect(R, { globalBBox: [0, 0, 0, 0] }, { dstRect: [0, 0, 10, 10] }) === null &&
      warns.length === 1,
    'a bundle with no inked area is refused with a warning',
  );
  warns = [];
  const bad = resolveDstRect(R, bundle, { dstRect: [0, 0, 100, 100], fit: 'squish' });
  ok(bad !== null && warns.length === 1, 'an unparseable fit warns and falls back to the default');
  ok(
    resolveDstRect(R, bundle, {}) === null && resolveDstRect(R, bundle, null) === null,
    'no dstRect means no matrix and no scissor (the untouched path stays untouched)',
  );

  // The returned matrix is held in R.draw.worldM until beginFillPass copies it
  // into the uniform, and drawBundle re-enters (a group that nests, a morph
  // that rebuilds). A single scratch slot would let the inner draw rewrite the
  // outer draw's matrix IN PLACE — a wrong placement with no wrong value
  // anywhere to find. Nested resolves must hand back distinct buffers.
  const outer = resolveDstRect(R, bundle, { dstRect: [0, 0, 100, 100] }).worldM;
  const outer0 = outer[0];
  const inner = resolveDstRect(R, bundle, { dstRect: [200, 200, 50, 50] }).worldM;
  ok(outer !== inner, 'a nested resolve uses a different scratch slot');
  ok(outer[0] === outer0, "...so the outer draw's matrix is still its own");
}

// ===========================================================================================
console.log('\n-- the hit test agrees with what was drawn --');
{
  // One shape filling the whole bundle bbox, hit-tested in Bbox mode.
  const stride = 48;
  const meta = new Float32Array(stride);
  meta[0] = BB[0];
  meta[1] = BB[1];
  meta[2] = BB[0] + BB[2];
  meta[3] = BB[1] + BB[3];
  meta[7] = 1.0;
  const bundle = {
    numShapes: 1,
    metaFloats: meta,
    metaFloatsPerShape: stride,
    shapeIds: ['target'],
    globalBBox: BB,
  };
  const R = makeR(VW, VH);
  const D = [50, 60, 200, 200];
  const opts = { dstRect: D };
  const m = bundleDrawMatrix(R, bundle, opts);
  // The drawn rect under the default meet fit is [50, 110, 200, 100] (checked above).
  const inside = [
    [51, 111],
    [249, 209],
    [150, 160],
  ];
  const outside = [
    [49, 160],
    [251, 160],
    [150, 108],
    [150, 212],
  ];
  let allIn = true,
    allOut = true;
  for (const [px, py] of inside)
    if (fillHitShape(bundle, px, py, { mode: 'bbox', worldMatrix: m }) !== 0) allIn = false;
  for (const [px, py] of outside)
    if (fillHitShape(bundle, px, py, { mode: 'bbox', worldMatrix: m }) !== -1) allOut = false;
  ok(allIn, 'every pixel inside the drawn rect hits');
  ok(allOut, 'every pixel outside the drawn rect misses');

  // And the gap this closes: passing the RAW opts.worldMatrix (clip space) instead answers for
  // a different frame entirely. With no worldMatrix at all the hit test treats the point as em,
  // so a viewport pixel inside the drawn rect reports a miss.
  ok(
    fillHitShape(bundle, 150, 160, { mode: 'bbox' }) === -1,
    'without the matrix a viewport pixel is read as em and misses — which is why the helper exists',
  );
}

// ===========================================================================================
console.log("\n-- the mirrored projection is still renderer.js's --");
{
  // arScale and the plane mapping are copied into this file. If either moves in the renderer,
  // every number above becomes a measurement of the wrong thing, silently. Pin the source.
  const rsrc = readFileSync(path.join(HERE, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  const fn = /function arScale\(bbox, vw, vh\) \{([\s\S]*?)\n  \}/.exec(rsrc);
  ok(!!fn, 'arScale is still a function of (bbox, vw, vh) in renderer.js');
  if (fn) {
    const body = fn[1].replace(/\s+/g, ' ');
    ok(
      body.includes('const cAR = vw / vh, sAR = bbox[2] / bbox[3]') &&
        body.includes('if (sAR > cAR) sy = cAR / sAR') &&
        body.includes('else sx = sAR / cAR'),
      'arScale still computes the aspect-preserving fit this file mirrors',
    );
  }
  const vsrc = readFileSync(path.join(HERE, '..', 'src', 'shaders', 'mantle.vert.glsl'), 'utf8');
  ok(
    vsrc.includes('vec2 uv = (emTransformed - uGlobalBBox.xy) / uGlobalBBox.zw;') &&
      vsrc.includes('vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;'),
    'mantle.vert still projects em through (uv*2-1)*canvasAR',
  );
  ok(
    vsrc.includes('clip3 = wWorldM * clip3;'),
    'mantle.vert still applies the per-draw world matrix in CLIP space (which is what dstRect rides)',
  );
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
