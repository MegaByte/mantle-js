// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gradientManyStopsRenderSmoke — a 600-stop linear gradient draws all 600 stops, as Chrome does.
// The reference is Chrome's rendering of the same SVG (test/_chromeRef.mjs).
//
// Cut to its first 256 stops (a binary search of a fixed 9 probes), everything past stop 255 -- 57%
// of this ramp -- would draw as one flat color, the last kept stop's. gradientManyStopsSmoke pins the packing, the fine offsets and the LUT wrap in node; this is
// the pixels. Two ramps, 600 stops each, colors varying smoothly (three hue cycles) so a reference
// that bakes its own gradient into a color table still agrees closely:
//   - top: opaque (every stop alpha 1), read for color;
//   - bottom: translucent (alpha swings 0.15..1), read for alpha and, where alpha allows, color.
// Both on a transparent ground, so alpha is compared as drawn.
import { launchBrowser } from './_launch.mjs';
import { openChromeRef, diffStats } from './_chromeRef.mjs';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

const W = 600,
  H = 40,
  N = 600;
const hex = (v) =>
  Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, '0');
const stops = (alpha) => {
  const out = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1),
      p = 2 * Math.PI * 3 * t;
    const c =
      '#' +
      hex(0.5 + 0.5 * Math.sin(p)) +
      hex(0.5 + 0.5 * Math.sin(p + 2.1)) +
      hex(0.5 + 0.5 * Math.sin(p + 4.2));
    const a = alpha ? (0.575 + 0.425 * Math.cos(2 * Math.PI * 2 * t)).toFixed(4) : '1';
    out.push(`<stop offset="${t.toFixed(6)}" stop-color="${c}" stop-opacity="${a}"/>`);
  }
  return out.join('');
};
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>` +
  `<linearGradient id="o" x1="0" y1="0" x2="1" y2="0">${stops(false)}</linearGradient>` +
  `<linearGradient id="a" x1="0" y1="0" x2="1" y2="0">${stops(true)}</linearGradient></defs>` +
  `<rect x="0" y="0" width="${W}" height="20" fill="url(#o)"/>` +
  `<rect x="0" y="20" width="${W}" height="20" fill="url(#a)"/></svg>`;

const ref = await openChromeRef(launchBrowser);
try {
  const { mantle, chrome } = await ref.render(svg, { w: W, h: H, ground: 'transparent' });
  // Inside each rect, two pixels clear of every edge. Chrome may dither a gradient and bake it into
  // a color table, so allow a few levels; a dropped stop is off by tens to hundreds.
  for (const [name, box, tail] of [
    ['opaque ramp', [2, 2, W - 2, 18], [260, 2, W - 2, 18]],
    ['translucent ramp', [2, 22, W - 2, 38], [260, 22, W - 2, 38]],
  ]) {
    const all = diffStats(mantle, chrome, W, box, 8);
    const past = diffStats(mantle, chrome, W, tail, 8);
    const msg =
      `${name}: mean |d| ${all.mean.toFixed(2)}, max ${all.max}, ${all.over}/${all.n} px over 8/255; ` +
      `past stop 256 (x >= 260): mean ${past.mean.toFixed(2)}, max ${past.max}`;
    if (all.mean <= 2 && all.max <= 16 && all.over <= all.n * 0.01) ok(msg);
    else fail(msg);
  }
  for (const e of ref.pageErrors) fail('page: ' + e);
} catch (e) {
  fail('setup: ' + e.message);
}
await ref.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\ngradientManyStopsRenderSmoke: a 600-stop gradient draws every stop, as Chrome does');
