// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Bind filter-owner gradients independently of leaf paint and metadata rows.
import { resolveIdRef } from './utils.js';
import { matMul } from './transform.js';
import { GRAD_UNITS_USER } from './gradient.js';

export function prepareFilterOwnerGradients(ctx, definitionFor, ownerBoxFor) {
  if (!definitionFor) return;
  for (const filter of ctx.filtersUsed) {
    const graph = filter.graph,
      frame = filter.ownerPaintFrame;
    if (!graph?.ownerPaints || !frame) continue;
    const paints = { ...graph.ownerPaints };
    let ownerBox = null,
      boxReady = false;
    for (const [role, source] of [
      ['fill', -5],
      ['stroke', -6],
    ]) {
      const paint = paints[role];
      if (paint?.kind !== 'server' || !graph.nodes.some((node) => node.inputs.includes(source)))
        continue;
      const gradient = definitionFor(resolveIdRef(paint.reference));
      if (!gradient) continue;
      const authored = gradient.gradient_transform.slice(),
        ctm = frame.ctm;
      const obb = gradient.units !== GRAD_UNITS_USER;
      if (obb && !boxReady) {
        ownerBox = ownerBoxFor(frame);
        boxReady = true;
      }
      const box = obb ? ownerBox : null;
      const valid =
        ctm.every(Number.isFinite) && (!obb || (box && box[2] > box[0] && box[3] > box[1]));
      let matrix = valid
        ? obb
          ? matMul(ctm, [box[2] - box[0], 0, 0, box[3] - box[1], box[0], box[1]])
          : ctm
        : null;
      matrix = matrix ? matMul(matrix, authored) : null;
      const determinant = matrix ? matrix[0] * matrix[3] - matrix[1] * matrix[2] : 0;
      const known =
        !!matrix &&
        matrix.every(Number.isFinite) &&
        Math.abs(determinant) >
          1e-12 * (Math.abs(matrix[0] * matrix[3]) + Math.abs(matrix[1] * matrix[2]));
      let gradientId = 0;
      if (known) {
        ctx.gradientsUsed.push({
          ...gradient,
          units: GRAD_UNITS_USER,
          _carrierPlaced: true,
          gradient_transform: matrix,
        });
        gradientId = ctx.gradientsUsed.length;
      }
      paints[role] = {
        kind: 'gradient',
        gradientId,
        frameKnown: known,
        objectBoundingBox: obb,
        authoredTransform: authored,
        ownerCtm: ctm.slice(),
        ownerBox: box?.slice() || null,
      };
    }
    filter.graph = { ...graph, ownerPaints: paints };
  }
}
