// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _mkSubpixel — write the SUB-PIXEL FEATURE CLASSES (3 px caps, 0.5 px bars, small circles, curved
// counters), sized in DEVICE PIXELS rather than in em, for the sub-pixel over-cover question.
//
// Two corner DOTS pin the content bbox (the renderer fits the CONTENT bbox, not the viewBox), so a feature's
// size in pixels is fixed by the canvas size and nothing else. The dots are shapes 0 and 1; the
// features start at shape 2.
//
//   node probes/lbAccuracy/_mkSubpixel.mjs OUTDIR [CANVAS=512]
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: _mkSubpixel.mjs OUTDIR [CANVAS]');
  process.exit(2);
}
mkdirSync(dir, { recursive: true });
const CANVAS = +(process.argv[3] || 512);
const SPAN = 100; // em across the content bbox
const PX = SPAN / CANVAS; // em per device pixel

const head = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SPAN} ${SPAN}">` +
  `<rect x="0" y="0" width="0.02" height="0.02" fill="#000"/>` +
  `<rect x="${SPAN - 0.02}" y="${SPAN - 0.02}" width="0.02" height="0.02" fill="#000"/>` +
  body +
  '</svg>';

const files = {};

/// N vertical bars, w px wide and h px tall, spaced 4 px apart.
const bars = (w, h, n) => {
  let b = '';
  for (let i = 0; i < n; i++) {
    const x = 10 + i * 4 * PX,
      y = 20;
    b += `<path d="M${x} ${y} L${x + w * PX} ${y} L${x + w * PX} ${y + h * PX} L${x} ${y + h * PX} Z" fill="#000"/>`;
  }
  return b;
};
files['bars0p5.svg'] = head(bars(0.5, 6, 40));
files['bars1p5.svg'] = head(bars(1.5, 6, 40));

/// N axis-aligned squares of s px, on a 4 px grid.
const squares = (s, n) => {
  let b = '';
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const x = 10 + i * 4 * PX,
        y = 20 + j * 4 * PX;
      b += `<path d="M${x} ${y} L${x + s * PX} ${y} L${x + s * PX} ${y + s * PX} L${x} ${y + s * PX} Z" fill="#000"/>`;
    }
  return b;
};
files['squares1p5.svg'] = head(squares(1.5, 12));
files['squares3.svg'] = head(squares(3, 12));

/// N circles of radius r px, as four QUADRATIC arcs ("r1.5 quad circles").
const qcircles = (r, n) => {
  let b = '';
  const K = (4 * (Math.SQRT2 - 1)) / 3; // unused for quads; kept for reference
  void K;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const cx = 12 + i * 5 * PX,
        cy = 20 + j * 5 * PX,
        R = r * PX;
      // four quadratic quarter-arcs with the control point at the corner (the standard quad circle)
      b +=
        `<path d="M${cx + R} ${cy} Q${cx + R} ${cy + R} ${cx} ${cy + R} Q${cx - R} ${cy + R} ${cx - R} ${cy}` +
        ` Q${cx - R} ${cy - R} ${cx} ${cy - R} Q${cx + R} ${cy - R} ${cx + R} ${cy} Z" fill="#000"/>`;
    }
  return b;
};
files['qcircles1p5.svg'] = head(qcircles(1.5, 10));
files['qcircles6.svg'] = head(qcircles(6, 6));

/// N acute triangles of the given apex angle, 20 px long.
const acute = (deg, n) => {
  let b = '';
  const half = Math.tan(((deg / 2) * Math.PI) / 180) * 20;
  for (let i = 0; i < n; i++) {
    const x = 10 + i * 8 * PX,
      y = 20;
    b += `<path d="M${x} ${y} L${x + 20 * PX} ${y + half * PX} L${x + 20 * PX} ${y - half * PX} Z" fill="#000"/>`;
  }
  return b;
};
files['acute20.svg'] = head(acute(20, 8));

/// A curved COUNTER: a disc with a smaller disc removed. `wall` px of ink.
const counter = (rOut, wall, n) => {
  let b = '';
  const arcs = (cx, cy, R, sweep) =>
    `M${cx + R} ${cy} A${R} ${R} 0 1 ${sweep} ${cx - R} ${cy} A${R} ${R} 0 1 ${sweep} ${cx + R} ${cy} Z`;
  for (let i = 0; i < n; i++) {
    const cx = 15 + i * (2 * rOut + 4) * PX,
      cy = 50,
      R = rOut * PX,
      r = (rOut - wall) * PX;
    b += `<path d="${arcs(cx, cy, R, 1)} ${arcs(cx, cy, r, 0)}" fill="#000" fill-rule="nonzero"/>`;
  }
  return b;
};
files['counter24w3.svg'] = head(counter(24, 3, 4));
files['counter12w2.svg'] = head(counter(12, 2, 6));

for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
console.log(
  `wrote ${Object.keys(files).length} assets to ${dir} (SPAN=${SPAN} em over CANVAS=${CANVAS} px, ${PX.toFixed(5)} em/px)`,
);
console.log(Object.keys(files).join(' '));
