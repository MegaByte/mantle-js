// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/filterUnits.js — primitiveUnits="objectBoundingBox" (Filter Effects 1 §15.7): the lengths a primitive's attributes carry
// (stdDeviation, dx / dy, radius, scale, a light's x / y / z, and the x / y / width / height of its subregion) are fractions of
// the referencing element's bounding box, in the element's own user space.
//
// parseFilters flags the nodes that carry such numbers (params.obb, params.subUnits = 1) and the graph (graph.obb). Once the box
// of the element that uses the filter is known, resolveObbGraph returns the equivalent graph in USER UNITS, which every later stage
// (the CTM mapping of offsets and lights, the world scale of blurs, the subregion placement) already understands. Pure.

/// `box` = [x0, y0, x1, y1], the element's object bounding box (geometry, no stroke) in its own user space. Returns a new graph; the
/// input is shared between every use of the filter and is never modified.
export function resolveObbGraph(graph, box) {
  const bx = box[0],
    by = box[1],
    bw = box[2] - box[0],
    bh = box[3] - box[1];
  const zs = Math.sqrt((bw * bw + bh * bh) / 2); // a length with no axis (a light's z) is of the box's diagonal
  const nodes = graph.nodes.map((n) => {
    const p = n.params;
    if (!p || !(p.obb || (p.subUnits === 1 && n.type !== 'feImage'))) return n;
    const q = { ...p };
    if (p.obb) {
      delete q.obb;
      switch (n.type) {
        case 'feGaussianBlur':
          q.sigmaX = (p.sigmaX || 0) * bw;
          q.sigmaY = (p.sigmaY || 0) * bh;
          break;
        case 'feOffset':
          q.dx = (p.dx || 0) * bw;
          q.dy = (p.dy || 0) * bh;
          break;
        case 'feMorphology':
          q.radiusX = (p.radiusX || 0) * bw;
          q.radiusY = (p.radiusY || 0) * bh;
          break;
        case 'feDisplacementMap':
          // One scale for both axes, a fraction of the box's WIDTH: that is what Chrome does (a 32 x 16 box with scale 0.5 displaces y by 16 * (c - 0.5), not 8).
          q.scale = (p.scale || 0) * bw;
          break;
        case 'feDiffuseLighting':
        case 'feSpecularLighting':
          if ((p.lightType | 0) > 0) {
            const at = (v) => [bx + v[0] * bw, by + v[1] * bh, v[2] * zs];
            q.lightPos = at(p.lightPos || [0, 0, 0]);
            q.spotAt = at(p.spotAt || [0, 0, 0]);
          }
          break;
        default:
          break;
      }
    }
    if (p.subUnits === 1 && n.type !== 'feImage' && p.sub) {
      const v = p.sub;
      q.sub = [
        v[0] === null ? null : bx + v[0] * bw,
        v[1] === null ? null : by + v[1] * bh,
        v[2] === null ? null : v[2] * bw,
        v[3] === null ? null : v[3] * bh,
      ];
      q.subUnits = 0;
    }
    return { ...n, params: q };
  });
  const g = { ...graph, nodes };
  delete g.obb;
  return g;
}
