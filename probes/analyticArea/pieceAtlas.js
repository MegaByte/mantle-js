// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Affine, view-dependent experiment. Integer-aligned atlas rectangles
// preserve the target pixel grid; paint rectangles retain original shape order.
export function packPieceAtlas(c) {
  const start = performance.now(),
    n = c.size,
    [bx, by, bw, bh] = c.bbox,
    s = n / Math.max(bw, bh),
    ox = n / 2 - (bx + bw / 2) * s,
    oy = n / 2 - (by + bh / 2) * s;
  const M = c.drawOptions?.worldMatrix || [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (
    M.length !== 9 ||
    M.some((v) => !Number.isFinite(v)) ||
    M[2] !== 0 ||
    M[5] !== 0 ||
    M[8] !== 1
  )
    throw Error('Piece atlas requires an affine worldMatrix');
  // worldMatrix acts in clip space; SVG/atlas coordinates have y down.
  const a = s * M[0],
    b = -s * M[1],
    cc = -s * M[3],
    d = s * M[4];
  const tx = (n / 2) * (M[0] * ((2 * ox) / n - 1) + M[3] * (1 - (2 * oy) / n) + M[6] + 1);
  const ty = (n / 2) * (1 - M[1] * ((2 * ox) / n - 1) - M[4] * (1 - (2 * oy) / n) - M[7]);
  const groups = c.pieceGroups.map((g) => {
    const [x0, y0, x1, y1] = g.bbox;
    const P = [
      [x0, y0],
      [x0, y1],
      [x1, y0],
      [x1, y1],
    ].map(([x, y]) => [a * x + cc * y + tx, b * x + d * y + ty]);
    const x = Math.floor(Math.min(...P.map((p) => p[0]))) - 2,
      y = Math.floor(Math.min(...P.map((p) => p[1]))) - 2;
    return {
      ...g,
      rect: [
        x,
        y,
        Math.ceil(Math.max(...P.map((p) => p[0]))) + 2 - x,
        Math.ceil(Math.max(...P.map((p) => p[1]))) + 2 - y,
      ],
    };
  });
  const pow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
  const area = groups.reduce((a, g) => a + g.rect[2] * g.rect[3], 0);
  let width = pow2(Math.max(64, Math.sqrt(area), ...groups.map((g) => g.rect[2]))),
    height = 0,
    x = 0,
    y = 0,
    row = 0;
  for (const g of [...groups].sort((a, b) => b.rect[3] - a.rect[3])) {
    const [, , w, h] = g.rect;
    if (x + w > width) {
      x = 0;
      y += row;
      row = 0;
    }
    g.atlas = [x, y];
    x += w;
    row = Math.max(row, h);
    height = Math.max(height, y + h);
  }
  const size = pow2(Math.max(width, height));
  if (size > 4096) throw Error('Atlas experiment exceeds its 4096 pixel bound');
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg">' +
    groups
      .map((g) => {
        const gx = tx + g.atlas[0] - g.rect[0],
          gy = ty + g.atlas[1] - g.rect[1];
        g.matrix = [a, b, cc, d, gx, gy];
        return (
          `<g transform="matrix(${a} ${b} ${cc} ${d} ${gx} ${gy})">` +
          g.svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '') +
          '</g>'
        );
      })
      .join('') +
    '</svg>';
  return {
    svg,
    size,
    groups,
    groupAlpha: c.pieceGroupAlpha ?? 1,
    stats: {
      packSerializeMs: performance.now() - start,
      size,
      allocatedPixels: size * size,
      usedPixels: area,
      shapes: groups.length,
      pieces: groups.reduce((a, g) => a + g.pieces, 0),
    },
  };
}
