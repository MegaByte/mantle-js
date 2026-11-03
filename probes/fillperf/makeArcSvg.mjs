// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// makeArcSvg — an ARC-HEAVY SVG for the fill-performance timings (the band-hard arc rule, Slug's arc roots):
// every shape a <path> of elliptical-arc segments, so primitive recognition (circles, rounded rects) never takes it
// off the band walk. Rounded rectangles with unequal radii, arc-edged stars, pie wedges, rotated elliptical lenses and
// even-odd rings, on a grid. Deterministic. Node only, no GPU.
//
//   node probes/fillperf/makeArcSvg.mjs out.svg [cols=12] [rows=10]
import { writeFileSync } from 'fs';

const out = process.argv[2];
if (!out) {
  console.error('usage: node probes/fillperf/makeArcSvg.mjs <out.svg> [cols] [rows]');
  process.exit(2);
}
const COLS = +(process.argv[3] || 12),
  ROWS = +(process.argv[4] || 10),
  CELL = 100;
const f = (v) => +v.toFixed(3);
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
function roundRect(x, y, w, h, rx, ry) {
  return (
    `M${f(x + rx)} ${f(y)} H${f(x + w - rx)} A${f(rx)} ${f(ry)} 0 0 1 ${f(x + w)} ${f(y + ry)} V${f(y + h - ry)} ` +
    `A${f(rx)} ${f(ry)} 0 0 1 ${f(x + w - rx)} ${f(y + h)} H${f(x + rx)} A${f(rx)} ${f(ry)} 0 0 1 ${f(x)} ${f(y + h - ry)} ` +
    `V${f(y + ry)} A${f(rx)} ${f(ry)} 0 0 1 ${f(x + rx)} ${f(y)} Z`
  );
}
function arcStar(cx, cy, r0, n, rot) {
  const P = (k) => [
    cx + r0 * Math.cos(rot + (Math.PI * 2 * k) / n),
    cy + r0 * Math.sin(rot + (Math.PI * 2 * k) / n),
  ];
  let d = `M${f(P(0)[0])} ${f(P(0)[1])} `;
  for (let k = 1; k <= n; k++) {
    const p = P(k);
    d += `A${f(r0 * 0.45)} ${f(r0 * 0.3)} ${f(k * 17)} 0 ${k & 1} ${f(p[0])} ${f(p[1])} `;
  }
  return d + 'Z';
}
function wedge(cx, cy, r, a0, a1) {
  const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)],
    p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
  return `M${f(cx)} ${f(cy)} L${f(p0[0])} ${f(p0[1])} A${f(r)} ${f(r)} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${f(p1[0])} ${f(p1[1])} Z`;
}
function lens(cx, cy, rx, ry, rot) {
  return `M${f(cx - rx)} ${f(cy)} A${f(rx)} ${f(ry)} ${f(rot)} 0 1 ${f(cx + rx)} ${f(cy)} A${f(rx * 0.8)} ${f(ry * 1.3)} ${f(rot)} 0 1 ${f(cx - rx)} ${f(cy)} Z`;
}
function ring(cx, cy, r0, r1) {
  return (
    `M${f(cx - r0)} ${f(cy)} A${f(r0)} ${f(r0 * 0.9)} 0 1 1 ${f(cx + r0)} ${f(cy)} A${f(r0)} ${f(r0 * 0.9)} 0 1 1 ${f(cx - r0)} ${f(cy)} Z ` +
    `M${f(cx - r1)} ${f(cy)} A${f(r1)} ${f(r1)} 0 1 0 ${f(cx + r1)} ${f(cy)} A${f(r1)} ${f(r1)} 0 1 0 ${f(cx - r1)} ${f(cy)} Z`
  );
}
let body = '',
  n = 0;
for (let j = 0; j < ROWS; j++)
  for (let i = 0; i < COLS; i++) {
    const x = i * CELL,
      y = j * CELL,
      cx = x + CELL / 2,
      cy = y + CELL / 2,
      k = (i + j * COLS) % 5;
    const hue = Math.floor(rnd() * 360),
      fill = `hsl(${hue},60%,45%)`;
    let d;
    if (k === 0)
      d = roundRect(
        x + 8,
        y + 12,
        84 - rnd() * 20,
        76 - rnd() * 20,
        6 + rnd() * 14,
        4 + rnd() * 18,
      );
    else if (k === 1) d = arcStar(cx, cy, 40, 5 + Math.floor(rnd() * 5), rnd() * 6.28);
    else if (k === 2) d = wedge(cx, cy, 42, rnd() * 6.28, rnd() * 6.28 + 1 + rnd() * 4);
    else if (k === 3) d = lens(cx, cy, 36, 18 + rnd() * 14, rnd() * 180);
    else d = ring(cx, cy, 42, 18 + rnd() * 12);
    body += `<path fill="${fill}"${k === 4 ? ' fill-rule="evenodd"' : ''} d="${d}"/>\n`;
    n++;
  }
writeFileSync(
  out,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${COLS * CELL} ${ROWS * CELL}">\n${body}</svg>\n`,
);
console.log(`wrote ${out}: ${n} arc-built shapes, ${COLS} x ${ROWS}`);
