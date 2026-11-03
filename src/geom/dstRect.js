// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Place the inked content bounds into a viewport-pixel rectangle (x, y, w, h),
// measured from the top left. SVG viewBox padding does not affect this fit.
// Placement composes A * W in clip space, preserving the caller's world matrix
// before applying the destination rectangle. Fit accepts preserveAspectRatio
// syntax: 'none' or an xMin/Mid/MaxYMin/Mid/Max alignment with meet or slice.
const ALIGN_RE = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/;
const FRAC = { Min: 0, Mid: 0.5, Max: 1 };

/** @typedef {{ax: number, ay: number, slice: boolean, stretch: boolean}} DstFit */

/** Parse a `preserveAspectRatio`-style fit string.
 *  Returns null for a string that is not one (the caller warns + falls back). */
export function parseDstFit(fit) {
  if (fit == null) return { ax: 0.5, ay: 0.5, slice: false, stretch: false };
  if (typeof fit !== 'string') return null;
  const parts = fit.trim().split(/\s+/);
  if (!parts.length || !parts[0]) return null;
  if (parts[0] === 'none') {
    // 'none' takes no meet/slice — both are meaningless once the aspect is free.
    return parts.length === 1 ? { ax: 0.5, ay: 0.5, slice: false, stretch: true } : null;
  }
  const m = ALIGN_RE.exec(parts[0]);
  if (!m) return null;
  let slice = false;
  if (parts.length > 1) {
    if (parts[1] === 'slice') slice = true;
    else if (parts[1] !== 'meet') return null;
  }
  if (parts.length > 2) return null;
  return { ax: FRAC[m[1]], ay: FRAC[m[2]], slice, stretch: false };
}

/// The pixel rect the DEFAULT draw (no dstRect) puts the content bbox in:
/// aspect-preserving fit of `bbox` to the viewport, centered. y-down.
/// This is the inverse statement of arScale + mantle.vert's plane mapping, and
/// the two must agree exactly — it is what makes `dstRect` and
/// `bundleDrawMatrix` describe the same pixels the shader draws.
export function contentRectPx(R, bbox, out) {
  const vp = R.viewportSize();
  const vw = vp[0],
    vh = vp[1];
  const ar = R.arScale(bbox, vw, vh);
  const cw = ar[0] * vw,
    ch = ar[1] * vh;
  const o = out || [0, 0, 0, 0];
  o[0] = (vw - cw) * 0.5;
  o[1] = (vh - ch) * 0.5;
  o[2] = cw;
  o[3] = ch;
  return o;
}

/// Where the content should END UP, given the caller's rect and the fit mode.
/// 'meet' scales to fit inside (letterbox), 'slice' scales to cover (and
/// overflows, which is why clipping defaults on), 'none' stretches to fill.
export function fittedRectPx(dst, content, fit, out) {
  const dx = dst[0],
    dy = dst[1],
    dw = dst[2],
    dh = dst[3];
  const cw = content[2],
    ch = content[3];
  const o = out || [0, 0, 0, 0];
  if (fit.stretch || !(cw > 0) || !(ch > 0)) {
    o[0] = dx;
    o[1] = dy;
    o[2] = dw;
    o[3] = dh;
    return o;
  }
  const sx = dw / cw,
    sy = dh / ch;
  const s = fit.slice ? Math.max(sx, sy) : Math.min(sx, sy);
  const tw = cw * s,
    th = ch * s;
  o[0] = dx + (dw - tw) * fit.ax;
  o[1] = dy + (dh - th) * fit.ay;
  o[2] = tw;
  o[3] = th;
  return o;
}

/// out = A * B, both column-major mat3 (m[col*3 + row]).
function mul3(out, A, B) {
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      out[c * 3 + r] = A[r] * B[c * 3] + A[3 + r] * B[c * 3 + 1] + A[6 + r] * B[c * 3 + 2];
    }
  }
  return out;
}

/// The clip-space affine that moves the content from `content` (where the
/// default fit puts it) to `target` (where the caller wants it), both y-down
/// pixel rects. Derivation, x axis (y is the same with the axis flipped):
///     px      = (clip.x + 1) / 2 * W          // clip -> pixels
///     px'     = a*px + b,  a = Tw/Cw,  b = Tx - a*Cx
///  => clip.x' = a*clip.x + (a - 1 + 2b/W)
/// and for y, px_down = (1 - clip.y)/2 * H gives
///     clip.y' = c*clip.y + (1 - c - 2d/H).
function placementMatrix(out, content, target, vw, vh) {
  const a = target[2] / content[2];
  const c = target[3] / content[3];
  const b = target[0] - a * content[0];
  const d = target[1] - c * content[1];
  out[0] = a;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = c;
  out[5] = 0;
  out[6] = a - 1 + (2 * b) / vw;
  out[7] = 1 - c - (2 * d) / vh;
  out[8] = 1;
  return out;
}

/// A bundle's inked bbox, or null when it has none / has no area. A bundle with
/// no extent cannot be fitted to anything, so `dstRect` declines rather than
/// dividing by zero and painting NaNs.
function bboxOf(target) {
  const bundle = target && target.bundle !== undefined ? target.bundle : target;
  const bb = bundle && bundle.globalBBox;
  if (!bb || !(bb[2] > 0) || !(bb[3] > 0)) return null;
  return bb;
}

function validRect(r) {
  if (!r || typeof r !== 'object' || typeof r.length !== 'number' || r.length < 4) return false;
  return (
    Number.isFinite(r[0]) &&
    Number.isFinite(r[1]) &&
    Number.isFinite(r[2]) &&
    Number.isFinite(r[3]) &&
    r[2] > 0 &&
    r[3] > 0
  );
}

/** The placement `opts.dstRect` + `opts.fit` ask for, as pure arithmetic with no renderer: the affine (SVG matrix order
 *  [a, b, c, d, e, f], float64, em -> viewport pixels, y-down) that carries the content bbox `bb` onto the fitted rect, and the
 *  rect's clip box rounded to whole pixels exactly as the GL scissor is. It is the same fit rule as resolveDstRect (parseDstFit,
 *  fittedRectPx), expressed against the bbox instead of against the viewport fit: the default fit maps bb onto contentRectPx and
 *  the placement maps that onto the fitted rect, so together they map bb onto the fitted rect. Scale invariant: only the bbox's
 *  aspect enters the fit. The native SVG backend, which draws no projection of its own, composes this into its root.
 *  Returns { error } instead when the rect, the bbox or the fit cannot be used (the caller words the warning).
 *  @returns {{m: number[], clip: number[]}|{error: 'rect'|'bbox'|'fit'}}
 */
export function dstRectAffine(bb, rect, fitString) {
  if (!validRect(rect)) return { error: 'rect' };
  if (!bb || !(bb[2] > 0) || !(bb[3] > 0)) return { error: 'bbox' };
  const fit = parseDstFit(fitString);
  if (!fit) return { error: 'fit' };
  const target = fittedRectPx(rect, [0, 0, bb[2], bb[3]], fit);
  const sx = target[2] / bb[2],
    sy = target[3] / bb[3];
  return {
    m: [sx, 0, 0, sy, target[0] - sx * bb[0], target[1] - sy * bb[1]],
    clip: [
      Math.round(rect[0]),
      Math.round(rect[1]),
      Math.round(rect[0] + rect[2]),
      Math.round(rect[1] + rect[3]),
    ],
  };
}

/** Everything one draw needs to honor `opts.dstRect`, or null when the draw
 *  has no dstRect (or cannot use one).
 *
 *  `worldM`  — the matrix to put in R.draw.worldM (rect placement composed
 *              with the caller's own worldMatrix).
 *  `scissor` — [x, yBottom, w, h] in GL scissor coordinates (origin LOWER
 *              left), or null when the caller opted out of clipping.
 *
 *  Scratch is per-renderer, so a per-frame draw allocates nothing. `worldM`
 *  comes from a 4-deep ring because the draw HOLDS it (in R.draw.worldM) until
 *  beginFillPass copies it into the uniform, and drawBundle re-enters; the
 *  scissor array is consumed before the draw starts and needs no ring. Anything
 *  that must OUTLIVE the draw — the frame recorder, for one — copies it.
 *  @returns {{worldM: Float32Array, scissor: number[]|null}|null}
 */
export function resolveDstRect(R, target, opts) {
  if (!opts) return null;
  const rect = opts.dstRect;
  if (rect == null) return null;
  if (!validRect(rect)) {
    R.mantleWarn(
      '[Mantle] drawBundle: dstRect must be [x, y, w, h] with w > 0 and h > 0 ' +
        '(viewport pixels, y-down); ignoring it.',
    );
    return null;
  }
  const bb = bboxOf(target);
  if (!bb) {
    R.mantleWarn(
      '[Mantle] drawBundle: dstRect needs the bundle to have an inked bounding box; ' +
        'this one has none, so the rect is ignored.',
    );
    return null;
  }
  const fit = parseDstFit(opts.fit);
  if (!fit) {
    R.mantleWarn(
      `[Mantle] drawBundle: fit ${JSON.stringify(opts.fit)} is not a preserveAspectRatio ` +
        "value ('none', or 'xMidYMid meet' / 'xMinYMax slice' / …); using 'xMidYMid meet'.",
    );
    return resolveDstRect(R, target, { ...opts, fit: undefined });
  }

  // Per-renderer scratch, so a per-frame draw allocates nothing. The MATRICES
  // ride a small ring rather than a single slot: `R.draw.worldM` holds the
  // returned array until beginFillPass copies it into the GL uniform, and
  // drawBundle can re-enter (a group that nests, a morph handle that rebuilds).
  // One slot would let an inner draw's rect rewrite the outer draw's matrix in
  // place. Four covers real nesting; deeper than that and the outer draw's
  // R.draw state has already been reset by the inner draw's own teardown, which
  // is a different (pre-existing) problem.
  let S = R._dstRectScratch;
  if (!S) {
    S = R._dstRectScratch = {
      content: [0, 0, 0, 0],
      target: [0, 0, 0, 0],
      scissor: [0, 0, 0, 0],
      ring: [0, 1, 2, 3].map(() => ({ place: new Float32Array(9), world: new Float32Array(9) })),
      at: 0,
    };
  }
  S.at = (S.at + 1) & 3;
  const slot = S.ring[S.at];
  S.place = slot.place;
  S.world = slot.world;
  const vp = R.viewportSize();
  const vw = vp[0],
    vh = vp[1];
  contentRectPx(R, bb, S.content);
  fittedRectPx(rect, S.content, fit, S.target);
  placementMatrix(S.place, S.content, S.target, vw, vh);

  const w = opts.worldMatrix;
  let worldM = S.place;
  if (w && w.length >= 9) {
    mul3(S.world, S.place, w);
    worldM = S.world;
  }

  // Clip to the destination rectangle unless clipToRect is false. Intersect
  // the existing frame scissor so placement cannot widen it. Convert y-down
  // viewport coordinates to WebGL's lower-left drawing-buffer coordinates.
  let scissor = null;
  if (opts.clipToRect !== false) {
    const x0 = Math.round(rect[0]),
      x1 = Math.round(rect[0] + rect[2]);
    const yTop = Math.round(rect[1]),
      yBot = Math.round(rect[1] + rect[3]);
    let sx0 = x0,
      sy0 = vh - yBot,
      sx1 = x1,
      sy1 = vh - yTop;
    const prev = R._scissor;
    if (prev) {
      sx0 = Math.max(sx0, prev[0]);
      sy0 = Math.max(sy0, prev[1]);
      sx1 = Math.min(sx1, prev[0] + prev[2]);
      sy1 = Math.min(sy1, prev[1] + prev[3]);
    }
    S.scissor[0] = sx0;
    S.scissor[1] = sy0;
    S.scissor[2] = Math.max(0, sx1 - sx0);
    S.scissor[3] = Math.max(0, sy1 - sy0);
    scissor = S.scissor;
  }
  return { worldM, scissor };
}

/** em -> VIEWPORT PIXELS (y-down, origin top-left) for the draw that
 *  `drawBundle(target, opts)` would perform right now.
 *
 *  This is the matrix a hit test needs: `fillHitShape` inverse-transforms the
 *  query point through its `worldMatrix` to reach em space, so handing it this
 *  matrix makes the hit boundary agree with the pixels on screen — including
 *  the viewport fit, which the raw `opts.worldMatrix` does NOT contain (that
 *  one acts in clip space, so passing it alone answers for the wrong frame).
 *
 *  Returns a fresh Float32Array(9), column-major, or null when the bundle has
 *  no inked bbox. It is a pure query: no GL state is touched.
 *  @returns {Float32Array|null}
 */
export function bundleDrawMatrix(R, target, opts) {
  const bb = bboxOf(target);
  if (!bb) return null;
  const vp = R.viewportSize();
  const vw = vp[0],
    vh = vp[1];
  const ar = R.arScale(bb, vw, vh);
  const arx = ar[0],
    ary = ar[1];

  // em -> clip, exactly mantle.vert's emRow0/emRow1.
  const kx = (2 * arx) / bb[2];
  const ox = -arx - (2 * bb[0] * arx) / bb[2];
  const ky = (-2 * ary) / bb[3];
  const oy = ary + (2 * bb[1] * ary) / bb[3];
  const E = new Float32Array([kx, 0, 0, 0, ky, 0, ox, oy, 1]);

  // The draw's total clip-space matrix: rect placement composed with the
  // caller's worldMatrix, or just one of them, or neither.
  const res = resolveDstRect(R, target, opts);
  let M = null;
  if (res) M = res.worldM;
  else if (opts && opts.worldMatrix && opts.worldMatrix.length >= 9) M = opts.worldMatrix;

  // clip -> pixels (y-down).
  const C = new Float32Array([vw / 2, 0, 0, 0, -vh / 2, 0, vw / 2, vh / 2, 1]);

  const out = new Float32Array(9);
  if (M) {
    const t = new Float32Array(9);
    mul3(t, C, M);
    mul3(out, t, E);
  } else {
    mul3(out, C, E);
  }
  return out;
}
