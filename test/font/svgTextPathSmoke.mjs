// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svgTextPathSmoke.mjs — <textPath href="#id" startOffset="...">
// rides text along an arbitrary path. Validates:
//   • Glyphs end up near the path (not at the text's nominal x/y).
//   • startOffset shifts the run along the arc.
//   • A horizontal path keeps the styled glyph geometry of a flat run.
//   • The shipped arc-length math the run is laid out by (_quadLenAt's
//     closed form, _glLenAt's 16-point Gauss–Legendre for cubics) agrees
//     with an independent 1e6-interval trapezoid reference, and a quad
//     whose control point sits on its chord collapses to the chord.

import { readFileSync } from 'fs';
import { DOMParser } from '@xmldom/xmldom';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';
import importSvg from '../../src/svg/importer.js';
import { _quadLenAt, _glLenAt } from '../../src/svg/textures.js';
import { mkQuad, mkCubic } from '../../src/svg/segment.js';

if (typeof globalThis.DOMParser === 'undefined') globalThis.DOMParser = DOMParser;

const arial = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
);
arial.getMetrics(0x41);

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

const META_HEADER_BYTES = 32;
const asMetaF32 = (b) =>
  new Float32Array(b.meta, META_HEADER_BYTES, b.numShapes * b.metaFloatsPerShape);
const xminI = (b, mf, i) => mf[i * b.metaFloatsPerShape + 0];
const yminI = (b, mf, i) => mf[i * b.metaFloatsPerShape + 1];
const xmaxI = (b, mf, i) => mf[i * b.metaFloatsPerShape + 2];
const ymaxI = (b, mf, i) => mf[i * b.metaFloatsPerShape + 3];

// T1: textPath along a horizontal line. Glyphs ride the line at
// y = pathY, not the <text> element's y attribute.
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200">
  <defs>
    <path id="line" d="M 50 100 L 750 100"/>
  </defs>
  <text x="0" y="999" font-family="Arial" font-size="40" fill="black">
    <textPath href="#line">ABC</textPath>
  </text>
</svg>`;
  const b = await importSvg(svg, { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs });
  if (b.numShapes !== 3) fail(`T1 expected 3 shapes, got ${b.numShapes}`);
  else {
    const mf = asMetaF32(b);
    // Glyphs should be near y=100, NOT y=999.
    for (let i = 0; i < 3; i++) {
      const cy = (yminI(b, mf, i) + ymaxI(b, mf, i)) / 2;
      if (Math.abs(cy - 100) > 30) fail(`T1 glyph ${i} ycenter=${cy.toFixed(1)} (expected ~100)`);
    }
    // X coords: should advance left → right along the line.
    const x0 = (xminI(b, mf, 0) + xmaxI(b, mf, 0)) / 2;
    const x1 = (xminI(b, mf, 1) + xmaxI(b, mf, 1)) / 2;
    const x2 = (xminI(b, mf, 2) + xmaxI(b, mf, 2)) / 2;
    if (!(x0 < x1 && x1 < x2))
      fail(`T1 glyphs not in order: ${x0.toFixed(1)} ${x1.toFixed(1)} ${x2.toFixed(1)}`);
    if (failures === 0)
      ok(
        `T1 textPath on line: 3 glyphs along y≈100, x=${x0.toFixed(1)}/${x1.toFixed(1)}/${x2.toFixed(1)}`,
      );
  }
}

// T2: textPath along a vertical line — glyphs rotate 90°, so each
// glyph's bbox should be taller than wide.
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="800">
  <defs><path id="vline" d="M 100 50 L 100 750"/></defs>
  <text font-family="Arial" font-size="40" fill="black">
    <textPath href="#vline">A</textPath>
  </text>
</svg>`;
  const b = await importSvg(svg, { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs });
  if (b.numShapes !== 1) fail(`T2 expected 1 shape, got ${b.numShapes}`);
  else {
    const mf = asMetaF32(b);
    const w = xmaxI(b, mf, 0) - xminI(b, mf, 0);
    const h = ymaxI(b, mf, 0) - yminI(b, mf, 0);
    // Rotated 90° CW (tangent points +y), A's stem should be vertical-aligned
    // (taller than wide in screen y), but actually the rotation maps the
    // glyph's local x-axis onto the path tangent, so an 'A' that was
    // ~30w × 30h becomes 30h × 30w — bbox doesn't change much. Just
    // check the center is near the vertical line.
    const cx = (xminI(b, mf, 0) + xmaxI(b, mf, 0)) / 2;
    if (Math.abs(cx - 100) > 30) fail(`T2 glyph cx=${cx.toFixed(1)} (expected ~100)`);
    else
      ok(`T2 textPath on vertical line: cx=${cx.toFixed(1)} (w=${w.toFixed(1)} h=${h.toFixed(1)})`);
  }
}

// T3: startOffset moves the run along the path.
{
  const svgFor = (off) => `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200">
  <defs><path id="line" d="M 50 100 L 750 100"/></defs>
  <text font-family="Arial" font-size="40" fill="black">
    <textPath href="#line" startOffset="${off}">A</textPath>
  </text>
</svg>`;
  const b0 = await importSvg(svgFor(0), {
    fonts: { Arial: arial },
    svgTextLayout: buildSvgTextGlyphs,
  });
  const b1 = await importSvg(svgFor(200), {
    fonts: { Arial: arial },
    svgTextLayout: buildSvgTextGlyphs,
  });
  const m0 = asMetaF32(b0),
    m1 = asMetaF32(b1);
  const x0 = (xminI(b0, m0, 0) + xmaxI(b0, m0, 0)) / 2;
  const x1 = (xminI(b1, m1, 0) + xmaxI(b1, m1, 0)) / 2;
  // Difference should be ~200 (startOffset).
  const delta = x1 - x0;
  if (Math.abs(delta - 200) > 5) fail(`T3 startOffset delta=${delta.toFixed(2)} (expected ~200)`);
  else ok(`T3 startOffset shifts: A@${x0.toFixed(1)} → A@${x1.toFixed(1)} (Δ=${delta.toFixed(2)})`);
}

// T4: textPath on a cubic Bézier emits its glyphs on the curve (the
// cubic's GL16 length itself is checked against a reference in T8-T9).
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400">
  <defs><path id="c" d="M 50 300 C 250 50, 550 50, 750 300"/></defs>
  <text font-family="Arial" font-size="32" fill="black">
    <textPath href="#c">CURVE</textPath>
  </text>
</svg>`;
  const b = await importSvg(svg, { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs });
  if (b.numShapes !== 5) fail(`T4 expected 5 shapes, got ${b.numShapes}`);
  else {
    const mf = asMetaF32(b);
    // All glyphs must lie within the cubic's bounding rectangle
    // [50, 750] × [50, 300]. (The cubic dips up to y≈50 at the
    // mid because both control points are at y=50.)
    let okT4 = true;
    for (let i = 0; i < 5; i++) {
      const cx = (xminI(b, mf, i) + xmaxI(b, mf, i)) / 2;
      const cy = (yminI(b, mf, i) + ymaxI(b, mf, i)) / 2;
      if (cx < 40 || cx > 760 || cy < 40 || cy > 310) {
        fail(`T4 glyph ${i} off-curve: cx=${cx.toFixed(1)} cy=${cy.toFixed(1)}`);
        okT4 = false;
      }
    }
    if (okT4) ok(`T4 textPath on cubic: 5 glyphs all inside curve bbox`);
  }
}

// T5: percentage startOffset — "50%" of a 700-long line is x=400.
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200">
  <defs><path id="line" d="M 50 100 L 750 100"/></defs>
  <text font-family="Arial" font-size="40" fill="black">
    <textPath href="#line" startOffset="50%">A</textPath>
  </text>
</svg>`;
  const b = await importSvg(svg, { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs });
  const mf = asMetaF32(b);
  const xL = xminI(b, mf, 0);
  // 50% along a 50→750 line = x=400 — that's where the run STARTS.
  // Per SVG spec startOffset positions the first character's start
  // edge, not its center. Allow a small (few px) tolerance.
  if (Math.abs(xL - 400) > 5) fail(`T5 50% offset xmin=${xL.toFixed(2)} (expected ~400)`);
  else ok(`T5 startOffset='50%': A starts at x=${xL.toFixed(2)}`);
}

// A horizontal path preserves styled glyph geometry and synthesized weight.
for (const own of [false, true]) {
  const style = own
    ? 'font-weight="900" font-style="italic" letter-spacing="3px" direction="rtl"'
    : '';
  const expected = {
    fontWeight: own ? '900' : '700',
    fontStyle: own ? 'italic' : 'normal',
    letterSpacing: own ? '3px' : '2px',
    direction: own ? 'rtl' : 'ltr',
  };
  const svg = (path) => `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200">
    <defs><path id="line" d="M0 0H750"/></defs>
    <g font-family="Arial" font-size="40" font-weight="700" font-style="normal" letter-spacing="2px" direction="ltr">
      <text>${path ? `<textPath href="#line" ${style}>Af</textPath>` : `<tspan ${style}>Af</tspan>`}</text>
    </g></svg>`;
  const seen = [];
  const layout = (...args) => {
    seen.push(args[7]);
    return buildSvgTextGlyphs(...args);
  };
  const opts = { fonts: { Arial: arial }, svgTextLayout: layout };
  const flat = await importSvg(svg(false), opts),
    onPath = await importSvg(svg(true), opts);
  if (
    seen.length !== 2 ||
    seen.some((v) => Object.entries(expected).some(([k, x]) => v?.[k] !== x))
  )
    fail(`textPath ${own ? 'own' : 'inherited'} styles missing from layout callback`);
  const a = asMetaF32(flat),
    b = asMetaF32(onPath);
  if (flat.numShapes !== onPath.numShapes || flat.numShapes === 0)
    fail('styled textPath glyph count');
  else {
    // direction="rtl" right-aligns a flat run at its x (SVG 1.1 10.9.1: start is the right edge) but not along a path,
    // so only the left-to-right case compares geometry.
    let delta = 0;
    if (!own)
      for (let i = 0; i < flat.numShapes; i++)
        for (const j of [0, 1, 2, 3, 7, 8, 9, 10, 11, 12])
          delta = Math.max(
            delta,
            Math.abs(a[i * flat.metaFloatsPerShape + j] - b[i * onPath.metaFloatsPerShape + j]),
          );
    if (delta > 1e-4) fail(`styled textPath differs from flat glyph geometry/paint by ${delta}`);
    else ok(`textPath ${own ? 'own' : 'inherited'} styles preserve glyph geometry and weight`);
  }
}

// ---- Arc length: the shipped closed-form quad and GL16 cubic -----------
// The reference integrates an independently written |p'(t)| with a
// 1e6-interval composite trapezoid. Each check is written so a NaN fails.
const quadSpeed = (P0, P1, P2, t) => {
  const ax = P0[0] - 2 * P1[0] + P2[0],
    ay = P0[1] - 2 * P1[1] + P2[1];
  const bx = P1[0] - P0[0],
    by = P1[1] - P0[1];
  const dx = 2 * (ax * t + bx),
    dy = 2 * (ay * t + by);
  return Math.hypot(dx, dy);
};
const cubicSpeed = (P0, P1, P2, P3, t) => {
  const u = 1 - t;
  const dx =
    3 * u * u * (P1[0] - P0[0]) + 6 * u * t * (P2[0] - P1[0]) + 3 * t * t * (P3[0] - P2[0]);
  const dy =
    3 * u * u * (P1[1] - P0[1]) + 6 * u * t * (P2[1] - P1[1]) + 3 * t * t * (P3[1] - P2[1]);
  return Math.hypot(dx, dy);
};
const trapLen = (speedFn, N) => {
  // ∫₀¹ |p'(t)| dt via composite trapezoid with N intervals.
  const h = 1 / N;
  let sum = 0.5 * (speedFn(0) + speedFn(1));
  for (let i = 1; i < N; i++) sum += speedFn(i * h);
  return sum * h;
};

// T6: quad — closed form vs 1e6-sample trapezoid.
{
  const P0 = [10, 30],
    P1 = [100, -50],
    P2 = [200, 200];
  const closed = _quadLenAt(mkQuad(P0, P1, P2), 1);
  const ref = trapLen((t) => quadSpeed(P0, P1, P2, t), 1_000_000);
  const relErr = Math.abs(closed - ref) / ref;
  if (!(relErr <= 1e-9))
    fail(
      `T6 quad closed-form vs trap: closed=${closed} ref=${ref} relErr=${relErr.toExponential(3)}`,
    );
  else ok(`T6 quad closed-form len=${closed.toFixed(6)} relErr=${relErr.toExponential(2)}`);
}

// T7: degenerate quad (control point on chord) — collapses to the chord.
{
  const closed = _quadLenAt(mkQuad([0, 0], [50, 0], [100, 0]), 1);
  if (!(Math.abs(closed - 100) <= 1e-9)) fail(`T7 degenerate quad len=${closed} (expected 100)`);
  else ok(`T7 degenerate quad len=${closed.toFixed(6)}`);
}

// T8: cubic GL16 vs 1e6-sample trapezoid.
{
  const P0 = [50, 300],
    P1 = [250, 50],
    P2 = [550, 50],
    P3 = [750, 300];
  const gl = _glLenAt(mkCubic(P0, P1, P2, P3), 1);
  const ref = trapLen((t) => cubicSpeed(P0, P1, P2, P3, t), 1_000_000);
  const relErr = Math.abs(gl - ref) / ref;
  if (!(relErr <= 1e-9))
    fail(`T8 cubic GL16 vs trap: gl=${gl} ref=${ref} relErr=${relErr.toExponential(3)}`);
  else ok(`T8 cubic GL16 len=${gl.toFixed(6)} relErr=${relErr.toExponential(2)}`);
}

// T9: high-curvature cubic (S-curve). Stresses GL16.
{
  const P0 = [0, 0],
    P1 = [100, 1000],
    P2 = [-100, 1000],
    P3 = [0, 2000];
  const gl = _glLenAt(mkCubic(P0, P1, P2, P3), 1);
  const ref = trapLen((t) => cubicSpeed(P0, P1, P2, P3, t), 1_000_000);
  const relErr = Math.abs(gl - ref) / ref;
  if (!(relErr <= 1e-7))
    fail(`T9 S-curve cubic GL16 vs trap: gl=${gl} ref=${ref} relErr=${relErr.toExponential(3)}`);
  else ok(`T9 S-curve cubic GL16 len=${gl.toFixed(4)} relErr=${relErr.toExponential(2)}`);
}

console.log();
console.log(failures === 0 ? 'SVG-TEXTPATH PASS' : `SVG-TEXTPATH FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
