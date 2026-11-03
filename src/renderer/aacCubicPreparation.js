// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Ordered Bernstein controls certify coordinate monotonicity. The shader can
// then integrate the original cubic as one piece without extrema searches.
const staticCache = new WeakMap(),
  morphCache = new WeakMap(),
  featureCache = new WeakMap();
const NO_DESTINATION = Object.freeze({});
function cacheNode(cache, key) {
  let next = cache.get(key);
  if (!next) {
    next = new WeakMap();
    cache.set(key, next);
  }
  return next;
}
const ROUND_MARGIN = 16 * 2 ** -23,
  MIN_MARGIN = 16 * 2 ** -126;

function ordered(a, b, c, d) {
  return (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Number.isFinite(c) &&
    Number.isFinite(d) &&
    ((a <= b && b <= c && c <= d) || (a >= b && b >= c && c >= d))
  );
}
function intervalEdge(a, b, c, d, sign) {
  // Identical adjacent control trajectories remain identical under either
  // CPU interpolation or the GPU mix. Other edges need a rounding margin.
  if (a === b && c === d) return true;
  const margin = Math.max(
    MIN_MARGIN,
    ROUND_MARGIN * (Math.abs(a) + Math.abs(b) + Math.abs(c) + Math.abs(d)),
  );
  return sign * (b - a) > margin && sign * (d - c) > margin;
}
function intervalAxis(A, B, i) {
  for (let sign = 1; sign >= -1; sign -= 2) {
    let good = true;
    for (let e = 0; e < 3; e++)
      if (!intervalEdge(A[i + 2 * e], A[i + 2 * e + 2], B[i + 2 * e], B[i + 2 * e + 2], sign))
        good = false;
    if (good) return true;
  }
  return false;
}
function scan(A, B, begin, end) {
  if (
    !(A instanceof Float32Array) ||
    !Number.isInteger(begin) ||
    !Number.isInteger(end) ||
    begin < 0 ||
    end < begin ||
    end > A.length ||
    (B && end > B.length)
  )
    return -1;
  let cubics = 0,
    at = begin;
  while (at < end) {
    const h = A[at],
      type = h & 3;
    if (!Number.isInteger(h) || h < 0 || h >= 16 || (B && B[at] !== h)) return -1;
    const size = type === 0 ? 12 : type === 3 ? 20 : 16;
    if (at + size > end) return -1;
    if (type === 2) {
      for (let k = 0; k < 2; k++) {
        const i = at + 4 + k;
        if (
          !ordered(A[i], A[i + 2], A[i + 4], A[i + 6]) ||
          (B && (!ordered(B[i], B[i + 2], B[i + 4], B[i + 6]) || !intervalAxis(A, B, i)))
        )
          return -1;
      }
      cubics++;
    }
    // Arc endpoint repair can adjust shared curve endpoints during a morph.
    if (B && type === 3) return -1;
    at += size;
  }
  return cubics;
}
export function preparedMonotoneCubics(bundle) {
  if (
    !bundle ||
    bundle._disposed ||
    bundle._geomGen ||
    bundle._lbStream ||
    bundle._incStroke ||
    bundle._nineSliceActive
  )
    return false;
  const src = bundle._morphSrc;
  if (src) {
    if (src.skipUploads || src.skipCurveUploads || src.arcOffsets?.length) return false;
    const A = src.mergedCurveF32,
      B = src.dstCurveF32,
      ranges = src.curveRanges,
      fixed = src.fixedCurveRanges;
    if (
      !(A instanceof Float32Array) ||
      !(B instanceof Float32Array) ||
      !Array.isArray(ranges) ||
      (fixed && !Array.isArray(fixed))
    )
      return false;
    const cache = cacheNode(cacheNode(cacheNode(morphCache, A), B), ranges),
      key = fixed || NO_DESTINATION;
    const hit = cache.get(key);
    if (hit && hit.n === bundle.numShapes) return hit.eligible;
    let cubics = 0,
      valid = true;
    for (let row = 0; row < bundle.numShapes; row++) {
      const r = ranges[row] || (fixed && fixed[row]);
      if (!r) {
        valid = false;
        break;
      }
      const n = scan(A, ranges[row] ? B : null, r.begin, r.end);
      if (n < 0) {
        valid = false;
        break;
      }
      cubics += n;
    }
    const eligible = valid && cubics > 0;
    cache.set(key, { n: bundle.numShapes, eligible });
    return eligible;
  }
  // Mutable and streaming bundles can have GPU geometry newer than this mirror.
  const A = bundle.curveFloats,
    ranges = bundle.curveRangesByShape;
  if (!(A instanceof Float32Array) || !Array.isArray(ranges) || ranges.length !== bundle.numShapes)
    return false;
  const cache = cacheNode(staticCache, A),
    hit = cache.get(ranges);
  if (hit && hit.n === bundle.numShapes) return hit.eligible;
  let count = 0,
    valid = true;
  for (const r of ranges) {
    if (!r) {
      valid = false;
      break;
    }
    const n = scan(A, null, r.begin, r.end);
    if (n < 0) {
      valid = false;
      break;
    }
    count += n;
  }
  const eligible = valid && count > 0;
  cache.set(ranges, { n: bundle.numShapes, eligible });
  return eligible;
}

function plainMetadata(bundle) {
  const src = bundle._morphSrc;
  const A = src ? src.mergedMetaF32 : bundle.metaFloats,
    B = src && src.dstMetaF32;
  const stride = bundle.metaFloatsPerShape,
    n = bundle.numShapes;
  if (!(A instanceof Float32Array)) return false;
  if (B && !(B instanceof Float32Array)) return false;
  const cache = cacheNode(featureCache, A),
    key = B || NO_DESTINATION,
    hit = cache.get(key);
  if (hit && hit.stride === stride && hit.n === n) return hit.plain;
  let plain = stride >= 44 && A.length >= n * stride;
  if (B && (!(B instanceof Float32Array) || B.length < n * stride)) plain = false;
  for (let row = 0; plain && row < n; row++) {
    const at = row * stride;
    for (let pose = 0; pose < (B ? 2 : 1); pose++) {
      const data = pose ? B : A;
      if (
        Math.round(data[at + 27]) & 7168 ||
        data[at + 30] > 0 ||
        data[at + 31] > 0 ||
        data[at + 43] > 0
      ) {
        plain = false;
        break;
      }
    }
  }
  cache.set(key, { stride, n, plain });
  return plain;
}

export function monotoneCubicDrawEligible(bundle, draw) {
  if (
    !bundle ||
    bundle._disposed ||
    bundle._geomGen ||
    bundle._lbStream ||
    bundle._incStroke ||
    bundle._nineSliceActive
  )
    return false;
  const m = draw && draw.worldM;
  if (
    m &&
    (m[1] !== 0 ||
      m[2] !== 0 ||
      m[3] !== 0 ||
      m[5] !== 0 ||
      m[8] !== 1 ||
      !Number.isFinite(m[0]) ||
      !Number.isFinite(m[4]) ||
      m[0] === 0 ||
      m[4] === 0 ||
      !Number.isFinite(m[6]) ||
      !Number.isFinite(m[7]))
  )
    return false;
  // (an external clip, a sprite range and a row an override collapses change what is drawn, not the shape of a cubic: the certificate holds, the two programs draw the same bytes
  // (monotoneCubicStatesRenderSmoke), and a key that moved with them would name a program no warm built: a link in play at the first such draw)
  const ov = draw && draw.overrides;
  if (ov) {
    const p = ov instanceof Float32Array ? ov : ov.packedBuffer;
    if (!(p instanceof Float32Array) || p.length % 24) return false;
    const end = ov.numShapes >= 0 ? Math.min(p.length, ov.numShapes * 24) : p.length; // the drawn rows (hit-only rows follow them)
    for (let i = 0; i < end; i += 24) {
      if (p[i + 1] !== 0 || p[i + 2] !== 0) return false;
      for (let k = 0; k < 6; k++) if (!Number.isFinite(p[i + k])) return false;
    }
  }
  if (!bundle || bundle.filterGraphs?.length || !plainMetadata(bundle)) return false;
  return preparedMonotoneCubics(bundle);
}
