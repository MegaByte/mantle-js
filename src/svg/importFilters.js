// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/importFilters.js — filter graph + filterTab emission.

/// Whether a feGaussianBlur's two axes are the ELEMENT's (user-space) axes, mapped through `ctm`, rather than the
/// device's: only when the element's CTM turns or skews them (an off-diagonal term) AND that changes the
/// kernel -- an isotropic blur under a turn (a similarity) is the same disc on any axes, so it stays on the
/// device axes and keeps its earlier passes byte for byte.
export function blurFollowsAxes(p, ctm) {
  if (!ctm || (!ctm[1] && !ctm[2])) return false;
  const sx = p.sigmaX || 0,
    sy = p.sigmaY || 0;
  if (!(sx > 0 || sy > 0)) return false;
  const c0 = Math.hypot(ctm[0], ctm[1]),
    c1 = Math.hypot(ctm[2], ctm[3]);
  const similar =
    Math.abs(c0 - c1) <= 1e-9 * Math.max(c0, c1) &&
    Math.abs(ctm[0] * ctm[2] + ctm[1] * ctm[3]) <= 1e-9 * c0 * c1;
  return !(sx === sy && similar);
}

/// Whether a feMorphology's window is the ELEMENT's rectangle, mapped through `ctm`, rather than the device's: whenever the CTM turns or
/// skews it (any off-diagonal term) -- a square is not rotation-invariant, unlike an isotropic blur. A scale or a flip keeps the axes.
export function morphFollowsAxes(p, ctm) {
  return !!ctm && !!(ctm[1] || ctm[2]) && ((p.radiusX || 0) > 0 || (p.radiusY || 0) > 0);
}

/// Whether the linear part of `ctm` is the identity (a pure translation or none at all).
export const ctmLinearIsIdentity = (ctm) =>
  !ctm || (ctm[0] === 1 && ctm[1] === 0 && ctm[2] === 0 && ctm[3] === 1);

/// The lengths of the element's two user-space axes in root space: |(a, b)| for x and |(c, d)| for y. A filter length along user x
/// (a blur's stdDeviation x, a morphology radius x) reaches |(a, b)| per user unit; along y, |(c, d)|. A length of 1 up to float noise
/// (a pure turn: hypot of a cosine and a sine) is exactly 1, so a turned element keeps the bytes of its lengths.
export const ctmAxisLengths = (ctm) => {
  const snap = (v) => (Math.abs(v - 1) <= 8 * Number.EPSILON ? 1 : v);
  return [snap(Math.hypot(ctm[0], ctm[1])), snap(Math.hypot(ctm[2], ctm[3]))];
};

/// Which primitives carry a length (or a place) in the user space of the element that references the filter, and so need the element's
/// transform: SVG 1.1 section 15.7.1 / Filter Effects 1 section 3.2 -- with userSpaceOnUse units the filter works in the user coordinate system
/// of the referencing element, which includes that element's transform attribute. Offsets and light positions have always taken the whole
/// CTM; stdDeviation, radius, displacement scale and the noise field take it too.
/// Whether graph/record `rec` has anything that the LINEAR part of `ctm` (no translation) changes, so its entry splits per linear part and
/// not per position. A length changes only when the axis length is not 1; a displacement vector and a distant light turn with any
/// non-identity linear part. feOffset, point lights, feImage and subregions take the whole CTM (importWalk claimFilter) already.
export function recordNeedsLinear(rec, ctm) {
  if (!rec || !ctm || ctmLinearIsIdentity(ctm)) return false;
  const [l0, l1] = ctmAxisLengths(ctm),
    scales = l0 !== 1 || l1 !== 1;
  if (rec.kind === 'blur') return scales && ((rec.sigmaX || 0) > 0 || (rec.sigmaY || 0) > 0);
  if (rec.kind === 'morphology') return scales || morphFollowsAxes(rec, ctm);
  if (rec.kind !== 'graph' || !rec.graph || !rec.graph.nodes) return false;
  return rec.graph.nodes.some((n) => {
    const p = n.params || {};
    switch (n.type) {
      case 'feGaussianBlur':
        return scales && ((p.sigmaX || 0) > 0 || (p.sigmaY || 0) > 0);
      case 'feMorphology':
        return (
          ((p.radiusX || 0) > 0 || (p.radiusY || 0) > 0) && (scales || morphFollowsAxes(p, ctm))
        );
      case 'feDisplacementMap':
        return true;
      case 'feDiffuseLighting':
      case 'feSpecularLighting':
        return true;
      default:
        return false;
    }
  });
}

/// Whether the noise field of a graph is anchored to the element's user space (feTurbulence): a translation moves it too.
export const recordNeedsFullCtm = (rec) =>
  !!(
    rec &&
    rec.kind === 'graph' &&
    rec.graph &&
    rec.graph.nodes &&
    rec.graph.nodes.some((n) => n.type === 'feTurbulence')
  );

/// A DISTANT light's direction under the element's transform. Chrome (Skia) shades in a layer scaled by the CTM's two axis lengths (l0, l1) and
/// then turns the picture by the rest of the transform, so the light is fixed in the scaled layer: its direction there is (l0 x, l1 y, g z) with
/// g the geometric mean of the lengths (the surface height scales by g, below), and the turn of the first axis then carries it. Measured against
/// Chrome 8x on a scale, a turn, a turned anisotropic scale and a skew; for a similarity it is the
/// light turned with the element. The spec says nothing of lighting under a transform that is not a similarity.
function lightDirUnderCtm(v, ctm) {
  const [l0, l1] = ctmAxisLengths(ctm),
    g = Math.sqrt(l0 * l1);
  const X = l0 * v[0],
    Y = l1 * v[1],
    h = Math.hypot(ctm[0], ctm[1]);
  const cs = h > 0 ? ctm[0] / h : 1,
    sn = h > 0 ? ctm[1] / h : 0;
  return [cs * X - sn * Y, sn * X + cs * Y, g * v[2]];
}

/// The node's parameters in ROOT user space, given the CTM (user space of the referencing element -> root) of the element that references
/// the filter. Lengths follow the element's axes; positions take the whole CTM.
export function nodeUnderCtm(node, ctm, org = null) {
  const p = node.params;
  if (!p) return node;
  const [l0, l1] = ctmAxisLengths(ctm);
  const det = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]),
    zs = Math.sqrt(det);
  switch (node.type) {
    case 'feOffset': {
      const dx = p.dx || 0,
        dy = p.dy || 0;
      return {
        ...node,
        params: { ...p, dx: ctm[0] * dx + ctm[2] * dy, dy: ctm[1] * dx + ctm[3] * dy },
      };
    }
    case 'feDiffuseLighting':
    case 'feSpecularLighting': {
      const lt = p.lightType | 0;
      // A light's position (and a spot's pointsAt) is a POINT in the element's user space: root space needs the translation too, and its
      // height above the surface scales with the element as the filter's own scale does. A distant light is a direction.
      const at = (v) => [
        ctm[0] * v[0] + ctm[2] * v[1] + (ctm[4] || 0),
        ctm[1] * v[0] + ctm[3] * v[1] + (ctm[5] || 0),
        v[2] * zs,
      ];
      // ...and the relief scales with the element: the surface is `surfaceScale` user units high per unit of alpha, so a scaled element's
      // slopes (per device pixel) and heights follow its scale (`ls`, read by the lighting pass) -- one number for both axes, the geometric
      // mean of the axis lengths, as Chrome takes it (it is the same as theirs for a similarity).
      const lg = Math.sqrt(l0 * l1);
      const withLs = (q) => (lg !== 1 ? { ...q, ls: [lg, lg] } : q);
      if (lt > 0)
        return {
          ...node,
          params: withLs({
            ...p,
            lightPos: at(p.lightPos || [0, 0, 0]),
            spotAt: at(p.spotAt || [0, 0, 0]),
          }),
        };
      return ctmLinearIsIdentity(ctm)
        ? node
        : {
            ...node,
            params: withLs({ ...p, lightPos: lightDirUnderCtm(p.lightPos || [0, 0, 0], ctm) }),
          };
    }
    // A blur stays on the DEVICE axes unless told where the element's own axes went; on the device axes (a scale, a flip, a turn of a
    // uniform blur) its two deviations are the element's axis lengths.
    case 'feGaussianBlur':
      if (blurFollowsAxes(p, ctm))
        return { ...node, params: { ...p, m: [ctm[0], ctm[1], ctm[2], ctm[3]] } };
      return ctmLinearIsIdentity(ctm)
        ? node
        : { ...node, params: { ...p, sigmaX: (p.sigmaX || 0) * l0, sigmaY: (p.sigmaY || 0) * l1 } };
    case 'feMorphology':
      if (morphFollowsAxes(p, ctm))
        return { ...node, params: { ...p, m: [ctm[0], ctm[1], ctm[2], ctm[3]] } };
      return ctmLinearIsIdentity(ctm)
        ? node
        : {
            ...node,
            params: { ...p, radiusX: (p.radiusX || 0) * l0, radiusY: (p.radiusY || 0) * l1 },
          };
    // The displacement is a vector in user space: `m` is the linear part that carries it to root space.
    case 'feDisplacementMap':
      return ctmLinearIsIdentity(ctm)
        ? node
        : { ...node, params: { ...p, m: [ctm[0], ctm[1], ctm[2], ctm[3]] } };
    // The noise is a function of user space: `um` takes a root-space point to the element's user space.
    case 'feTurbulence': {
      const det0 = ctm[0] * ctm[3] - ctm[1] * ctm[2];
      if (!(det0 !== 0) || !Number.isFinite(det0)) return node;
      const i = 1 / det0;
      // The field is anchored to the canvas and to the element's user space in DOCUMENT terms (the noise a far element shows is its position's),
      // so the translation is the document one: a bundle stored relative to an origin (bundle/layout.js) adds the origin back here, and the
      // noise is the origin-free bundle's.
      const e = (ctm[4] || 0) + (org ? org[0] : 0),
        f = (ctm[5] || 0) + (org ? org[1] : 0);
      // (no transform in document terms: no map, the field of root user space, exactly the origin-free entry)
      if (ctm[0] === 1 && ctm[1] === 0 && ctm[2] === 0 && ctm[3] === 1 && e === 0 && f === 0 && org)
        return node;
      return {
        ...node,
        params: {
          ...p,
          um: [
            ctm[3] * i,
            -ctm[1] * i,
            -ctm[2] * i,
            ctm[0] * i,
            (ctm[2] * f - ctm[3] * e) * i,
            (ctm[1] * e - ctm[0] * f) * i,
          ],
        },
      };
    }
    default:
      return node;
  }
}

/// Build filterTab, filterGraphs, and kernelTab from claimed filter records.
export function buildFilterSections(filtersUsed, docOrigin = null) {
  const filterFloats = [];
  const kernelFloats = []; // 25 floats per kind=6 entry (5×5 max kernel)
  let convolveRow = 0;
  // Parallel CPU-only array of filter graphs. Entry N corresponds to
  // filterId N+1 (matching filtersUsed[N]). Null when the filter uses
  // the single-kind fast path. The renderer prefers filterGraphId
  // when set; the filter table entry is a no-op fallback in that case.
  const filterGraphsArr = [];
  // Filter REGIONS, CPU-side and parallel to filterGraphsArr (entry N == filterId
  // N+1). Not in filterFloats on purpose: the renderer only needs these to scissor
  // the composite, and adding a texel would change the bundle wire format for
  // something no shader reads.
  //
  // Each entry is [x, y, w, h, space] or null. A shape's claim resolved its region already (importWalk
  // resolveFilterRegion): space 0 is fractions of the shape's own bbox, which the renderer resolves from the meta row
  // whatever transform the element carries; space 1 is a rect in root user space, mapped through the element's CTM at
  // import. A shared record (an image or text claim) keeps the older rule: only a stated objectBoundingBox region.
  const filterRegionsArr = [];
  // ...and, for a group's objectBoundingBox region resolved at import, the fractions and member rows it came from: [fx, fy, fw, fh, rows] or null.
  const filterRegionObbArr = [];
  // ...and per filter entry the CTM of the element referencing it (user space -> root), or null for the
  // identity: where an external feImage's userSpaceOnUse subregion lives (filterGraph/feImagePlace.js).
  const filterPrimCtmsArr = [];
  // ...and per filter entry the region's four corners in root space when a turn or a skew makes it something other than its box.
  const filterRegionQuadsArr = [];
  for (let fi = 0; fi < filtersUsed.length; fi++) {
    const f = filtersUsed[fi];
    filterPrimCtmsArr.push(f.primCtm || null);
    filterRegionQuadsArr.push((f.regionUse && f.regionUse.quad) || null);
    filterRegionObbArr.push(f.regionObb || null);
    const rg = f.region;
    filterRegionsArr.push(
      'regionUse' in f
        ? f.regionUse
        : rg && !rg.unbounded && rg.empty
          ? [0, 0, 0, 0, 0]
          : rg && !rg.unbounded && rg.stated && rg.oBB && rg.w > 0 && rg.h > 0
            ? [rg.x, rg.y, rg.w, rg.h, 0]
            : null,
    );
    const m = f.matrix;
    // Capture graph if present; emit a no-op (identity color-matrix)
    // into the kind table so existing indexing still works. The
    // renderer's filterGraphId branch fires before the kind branch.
    if (f.kind === 'graph') {
      const ctm = f.primCtm;
      const graph = ctm
        ? { ...f.graph, nodes: f.graph.nodes.map((node) => nodeUnderCtm(node, ctm, docOrigin)) }
        : f.graph;
      filterGraphsArr.push(graph);
      // identity 4×5 matrix
      filterFloats.push(1, 0, 0, 0); // t0
      filterFloats.push(0, 1, 0, 0); // t1
      filterFloats.push(0, 0, 1, 0); // t2
      filterFloats.push(0, 0, 0, 1); // t3
      filterFloats.push(0, 0, 0, 0); // t4 offsets
      filterFloats.push(0, 0, 0, 0); // t5 kind=0 identity
      filterFloats[fi * 24 + 23] = 1 - (f.elementOpacity ?? 1);
      continue;
    }
    filterGraphsArr.push(null);
    // Layout per filter (6 texels = 24 floats):
    //   t5 = (kind, sigmaX, sigmaY, _pad). kind:
    //          0 = color matrix only
    //          1 = Gaussian blur (then color matrix)
    //          5 = morphology (erode / dilate)
    //          6 = convolveMatrix
    //   (multi-pass effects like drop-shadow run as composable fe-graphs.)
    //
    // For kinds 0/1 (kind <= 1), texels 0..3 are the color matrix,
    // texel 4 is the matrix offset column.
    // For kind=5 (morphology):
    //   t0 = (operator, _, _, _) — operator: 0=erode, 1=dilate
    //   t1..t4 = reserved (zero)
    //   t5.yz reuses sigma slots for (radiusX, radiusY) in em units.
    // For kind=6 (convolveMatrix):
    //   t0 = (orderX, orderY, targetX, targetY)
    //   t1 = (divisor, bias, edgeMode, preserveAlpha)
    //   t2 = (kernelRow, _, _, _)
    //   t3..t4 = reserved (zero)
    let kind = 0;
    if (f.kind === 'blur')
      kind = f.linear ? 7 : 1; // 7: the same blur on linear light (the identity matrix rides along)
    else if (f.kind === 'morphology') kind = 5;
    else if (f.kind === 'convolve') kind = 6;
    if (kind === 5) {
      filterFloats.push(f.operator || 0, 0, 0, 0); // t0 (operator)
      filterFloats.push(0, 0, 0, 0); // t1
      filterFloats.push(0, 0, 0, 0); // t2
      filterFloats.push(0, 0, 0, 0); // t3
      filterFloats.push(0, 0, 0, 0); // t4
      // t5: (kind, radiusX, radiusY, _pad)
      {
        const [l0, l1] = f.primCtm ? ctmAxisLengths(f.primCtm) : [1, 1];
        filterFloats.push(kind, (f.radiusX || 0) * l0, (f.radiusY || 0) * l1, 0);
      }
    } else if (kind === 6) {
      // Stash the kernel row index in t2.x; kernel itself goes into
      // kernelFloats (one 25-float entry per convolve filter).
      filterFloats.push(f.orderX || 3, f.orderY || 3, f.targetX || 0, f.targetY || 0); // t0
      filterFloats.push(f.divisor || 1, f.bias || 0, f.edgeMode || 0, f.preserveAlpha || 0); // t1
      filterFloats.push(convolveRow, 0, 0, 0); // t2
      filterFloats.push(0, 0, 0, 0); // t3
      filterFloats.push(0, 0, 0, 0); // t4
      filterFloats.push(kind, 0, 0, 0); // t5
      // Append the 25 kernel floats (parser padded to 25 already).
      for (let i = 0; i < 25; i++) kernelFloats.push(f.kernel[i] || 0);
      convolveRow++;
    } else {
      for (let r = 0; r < 4; r++) {
        filterFloats.push(m[r * 5 + 0], m[r * 5 + 1], m[r * 5 + 2], m[r * 5 + 3]);
      }
      filterFloats.push(m[0 * 5 + 4], m[1 * 5 + 4], m[2 * 5 + 4], m[3 * 5 + 4]);
      {
        const [l0, l1] = f.primCtm ? ctmAxisLengths(f.primCtm) : [1, 1];
        filterFloats.push(kind, (f.sigmaX || 0) * l0, (f.sigmaY || 0) * l1, 0);
      }
    }
    filterFloats[fi * 24 + 23] = 1 - (f.elementOpacity ?? 1);
  }
  const filtersB = new Uint8Array(new Float32Array(filterFloats).buffer);
  const kernelTab = kernelFloats.length ? new Float32Array(kernelFloats).buffer.slice(0) : null;
  return {
    filtersB,
    filterGraphsArr,
    filterRegionsArr,
    filterRegionObbArr,
    filterPrimCtmsArr,
    filterRegionQuadsArr,
    kernelTab,
  };
}
