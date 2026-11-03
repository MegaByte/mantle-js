// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

export function snapBoundaryNodes(cycles) {
  let coordinateMax = 0;
  for (const loop of cycles)
    for (const curve of loop)
      for (const p of curve.P)
        coordinateMax = Math.max(coordinateMax, Math.abs(p[0]), Math.abs(p[1]));
  if (!(coordinateMax > 0) || !Number.isFinite(coordinateMax)) return null;
  const tolerance = 4096 * Number.EPSILON * coordinateMax;
  const snapped = cycles.map((loop) =>
    loop.map((curve) => ({ ...curve, P: curve.P.map((p) => p.slice()) })),
  );
  for (const loop of snapped)
    for (let i = 0; i < loop.length; i++) {
      const end = loop[i].P.at(-1),
        start = loop[(i + 1) % loop.length].P[0];
      if (Math.hypot(end[0] - start[0], end[1] - start[1]) > tolerance) return null;
      start[0] = end[0];
      start[1] = end[1];
    }
  return snapped;
}
export function localBoundaryProgram(curves, cell, supportBound) {
  const margin = supportBound.map((s) => s * (1 + 1 / 256));
  const envelope = [
    cell[0] - margin[0],
    cell[1] - margin[1],
    cell[2] + margin[0],
    cell[3] + margin[1],
  ];
  const extent = Math.max(
    1,
    ...envelope.map(Math.abs),
    ...curves.flatMap((c) => c.P.flat().map(Math.abs)),
  );
  const guard = extent * 2 ** -20;
  const outside = (c) => {
    if (c.t === 'rquad') throw Error('Local native rational integration is not implemented');
    const xs = c.P.map((p) => p[0]),
      ys = c.P.map((p) => p[1]);
    return (
      (Math.max(...xs) < envelope[0] - guard ? 1 : 0) |
      (Math.min(...xs) > envelope[2] + guard ? 2 : 0) |
      (Math.max(...ys) < envelope[1] - guard ? 4 : 0) |
      (Math.min(...ys) > envelope[3] + guard ? 8 : 0)
    );
  };
  const program = [];
  let pending = null;
  const end = (c) => c.P[c.P.length - 1];
  const flush = () => {
    if (!pending) return;
    program.push({ t: 'line', P: [curves[pending.start].P[0], end(curves[pending.end])] });
    pending = null;
  };
  for (let i = 0; i < curves.length; i++) {
    if (pending) {
      const a = end(curves[pending.end]),
        b = curves[i].P[0];
      if (a[0] !== b[0] || a[1] !== b[1]) flush();
    }
    const mask = outside(curves[i]);
    if (!mask) {
      flush();
      program.push(curves[i]);
      continue;
    }
    if (pending && pending.mask & mask) {
      pending.end = i;
      pending.mask &= mask;
    } else {
      flush();
      pending = { start: i, end: i, mask };
    }
  }
  flush();
  // The native area dispatch requires three records. Zero edges preserve area.
  while (program.length < 3) {
    const p = program.length ? end(program[program.length - 1]) : curves[0].P[0];
    program.push({ t: 'line', P: [p, p] });
  }
  return { program };
}
export function spatialBoundaryCells(curves, bounds, supportBound) {
  const target = 24,
    maxDepth = 6,
    maxCells = 4096,
    maxRecords = 16384;
  const nativeLimit = curves.some((c) => c.t === 'cubic') ? 256 : 64;
  const prepare = (box, depth) => ({
    box,
    depth,
    local: localBoundaryProgram(curves, box, supportBound),
  });
  // A preparation heuristic, not a GPU timing model: bound the raster footprint
  // by its expanded rectangle and weight it by the number of integral records.
  const work = (cell) =>
    (cell.box[2] - cell.box[0] + supportBound[0]) *
    (cell.box[3] - cell.box[1] + supportBound[1]) *
    cell.local.program.length;
  const stack = [prepare(bounds, 0)],
    cells = [];
  let pendingRecords = stack[0].local.program.length,
    acceptedRecords = 0;
  while (stack.length) {
    const cell = stack.pop(),
      count = cell.local.program.length;
    pendingRecords -= count;
    if (count > target && cell.depth < maxDepth) {
      const [x0, y0, x1, y1] = cell.box,
        xm = (x0 + x1) / 2,
        ym = (y0 + y1) / 2;
      if (xm === x0 || xm === x1 || ym === y0 || ym === y1) {
        if (count > nativeLimit) return null;
        acceptedRecords += count;
        if (acceptedRecords + pendingRecords > maxRecords) return null;
        cells.push(cell);
        continue;
      }
      const children = [
        [x0, y0, xm, ym],
        [xm, y0, x1, ym],
        [xm, ym, x1, y1],
        [x0, ym, xm, y1],
      ].map((box) => prepare(box, cell.depth + 1));
      const childWork = children.reduce((sum, child) => sum + work(child), 0),
        parentWork = work(cell);
      if (!Number.isFinite(childWork) || !Number.isFinite(parentWork)) return null;
      if (count > nativeLimit || childWork < parentWork) {
        if (cells.length + stack.length + children.length > maxCells) return null;
        const childRecords = children.reduce((sum, child) => sum + child.local.program.length, 0);
        if (acceptedRecords + pendingRecords + childRecords > maxRecords) return null;
        pendingRecords += childRecords;
        stack.push(...children);
        continue;
      }
    }
    if (count > nativeLimit) return null;
    acceptedRecords += count;
    if (acceptedRecords + pendingRecords > maxRecords) return null;
    cells.push(cell);
  }
  return cells;
}
