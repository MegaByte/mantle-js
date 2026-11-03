// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Sparse independent Chrome box-filter reference for the paired release matrix.
// No timing claims: rasterize the original complete SVG, including strokes/groups,
// at two sample densities. Reports premultiplied channels like the GPU readback.
import { readFileSync, writeFileSync } from 'node:fs';
import { launchBrowser } from '../../test/_launch.mjs';
const [input, output] = process.argv.slice(2),
  d = JSON.parse(readFileSync(input));
const browser = await launchBrowser({
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal'],
});
try {
  const page = await browser.newPage();
  await page.goto('about:blank');
  const rows = [];
  for (const row of d.rows) {
    const c = d.config.cases.find((c) => c.name === row.name && c.size === row.size);
    const q = row.comparisons.find((q) => q.arm === 'fixed');
    if (!q) continue;
    const points = q.overOne?.length ? q.overOne : [q.worst].filter(Boolean);
    // All changed pixels for normal-sized lists. Stratified locations + worst for
    // larger lists; never describe sparse validation as a full-image oracle.
    const selected =
      points.length > 256
        ? [
            ...Array.from({ length: 255 }, (_, i) => points[Math.floor((i * points.length) / 255)]),
            q.worst,
          ]
        : points;
    const reference = await page.evaluate(
      async ({ c, selected }) => {
        const doc = new DOMParser().parseFromString(c.svg, 'image/svg+xml'),
          root = doc.documentElement;
        const vb = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
        if (vb.length !== 4 || !vb.every(Number.isFinite))
          throw Error('Reference requires a viewBox');
        const bb = c.bbox || vb,
          span = Math.max(bb[2], bb[3]),
          scale = c.size / span;
        const offX = (c.size - scale * bb[2]) / 2 - scale * bb[0],
          offY = (c.size - scale * bb[3]) / 2 - scale * bb[1];
        root.setAttribute('x', '0');
        root.setAttribute('y', '0');
        root.setAttribute('width', String(vb[2]));
        root.setAttribute('height', String(vb[3]));
        root.setAttribute('preserveAspectRatio', 'none');
        const inner = new XMLSerializer().serializeToString(root),
          result = [];
        for (const S of [16, 32]) {
          const tiles = new Map();
          for (const p of selected) {
            const tx = Math.floor(p.x / 64) * 64,
              ty = Math.floor(p.y / 64) * 64,
              key = tx + ',' + ty;
            if (!tiles.has(key)) tiles.set(key, { tx, ty, points: [] });
            tiles.get(key).points.push(p);
          }
          const samples = [];
          for (const { tx, ty, points } of tiles.values()) {
            const T = Math.min(64, c.size),
              cv = document.createElement('canvas');
            cv.width = cv.height = S * T;
            const cx = cv.getContext('2d', { willReadFrequently: true });
            const svg =
              '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' +
              S * T +
              '" height="' +
              S * T +
              '" viewBox="' +
              [tx, ty, T, T].join(' ') +
              '"><g transform="matrix(' +
              [scale, 0, 0, scale, offX + scale * vb[0], offY + scale * vb[1]].join(' ') +
              ')">' +
              inner +
              '</g></svg>';
            const start = performance.now(),
              img = new Image();
            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
            await img.decode();
            cx.drawImage(img, 0, 0, S * T, S * T);
            const data = cx.getImageData(0, 0, S * T, S * T).data;
            for (const p of points) {
              const rgba = [0, 0, 0, 0];
              for (let y = 0; y < S; y++)
                for (let x = 0; x < S; x++) {
                  const at = (((p.y - ty) * S + y) * S * T + (p.x - tx) * S + x) * 4,
                    a = data[at + 3];
                  for (let k = 0; k < 3; k++) rgba[k] += (data[at + k] * a) / 255;
                  rgba[3] += a;
                }
              samples.push({ x: p.x, y: p.y, rgba: rgba.map((v) => Math.round(v / (S * S))) });
            }
            await new Promise((r) => setTimeout(r, performance.now() - start + 16));
          }
          result.push({ slices: S, samples });
        }
        return result;
      },
      { c, selected },
    );
    const pointsOut = selected.map((p, i) => {
      const low = reference[0].samples[i],
        high = reference[1].samples[i];
      // Tile order may differ from selection order.
      const lo = reference[0].samples.find((v) => v.x === p.x && v.y === p.y),
        hi = reference[1].samples.find((v) => v.x === p.x && v.y === p.y);
      const errors = (rgba, ch, val) =>
        rgba
          ? Math.max(...rgba.map((v, k) => Math.abs(v - hi.rgba[k])))
          : Math.abs(val - hi.rgba[ch]);
      return {
        ...p,
        referenceRGBA: hi.rgba,
        drift: Math.max(...lo.rgba.map((v, k) => Math.abs(v - hi.rgba[k]))),
        releaseError: errors(p.baseRGBA, p.channel, p.base),
        fixedError: errors(p.actualRGBA, p.channel, p.actual),
      };
    });
    rows.push({
      name: row.name,
      size: row.size,
      changedOverOne: points.length,
      checked: pointsOut.length,
      points: pointsOut,
    });
    console.log(
      JSON.stringify({
        name: row.name,
        size: row.size,
        checked: pointsOut.length,
        maxDrift: Math.max(0, ...pointsOut.map((p) => p.drift)),
        better: pointsOut.filter((p) => p.fixedError < p.releaseError).length,
        worse: pointsOut.filter((p) => p.fixedError > p.releaseError).length,
        worst: pointsOut.reduce((a, b) => (!a || b.fixedError > a.fixedError ? b : a), null),
      }),
    );
  }
  writeFileSync(
    output,
    JSON.stringify(
      {
        scope:
          'Sparse changed pixels against complete original SVG rasterized by Chrome at 16x/32x, averaged in premultiplied RGBA. Difference between densities reported. Not a full-image oracle.',
        input,
        rows,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser.close();
}
