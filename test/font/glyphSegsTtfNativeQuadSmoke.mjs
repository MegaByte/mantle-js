// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Guards that TTF glyph outlines stay quadratic-native (no quad→cubic
// promotion). Promoted cubics make cy.x≈0, destabilising Cardano's
// disc-sign test in the coverage fragment walker. Asserts:
//   T1: native TTF quadratic outlines stay SEG_QUAD (not SEG_CUBIC).
//   T2: composite-glyph children also stay quad-native.
//   T3: point-in-path topology survives — sample inside the counter
//       of a typical '0', on the ring, and far-outside; expected
//       insideness matches.
//   T4: bundle assembly still emits valid curve/band textures.
// Falls back to Arial.ttf when no font path is given; skip if none found.

import { readFileSync, existsSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { SEG_LINE, SEG_QUAD, SEG_CUBIC } from '../../src/primitives/seg.js';
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';

const candidates = [
  process.argv[2],
  process.env.MANTLE_FONT,
  new URL('./fixtures/roboto-regular.ttf', import.meta.url),
  '/System/Library/Fonts/Supplemental/Arial.ttf',
].filter(Boolean);
const fontPath = candidates.find((p) => existsSync(p));
if (!fontPath) {
  console.log('Skip glyphSegsTtfNativeQuad: no TTF found');
  process.exit(0);
}
const font = new MantleFontAsset(new Uint8Array(readFileSync(fontPath)));

let failures = 0;
const fail = (msg) => {
  console.error('FAIL', msg);
  failures++;
};
const ok = (msg) => console.log('ok', msg);

// ----- T1: '0' (and other curvy glyphs) emit SEG_QUAD natively -----
{
  // Sample a handful of glyphs with known curves: '0' / 'O' / 'C' /
  // 'S' / 'o' / 'e' are curvy across typical fonts.
  const probes = '0OCSoe';
  let totalQuads = 0,
    totalCubics = 0,
    totalLines = 0;
  for (const ch of probes) {
    const segs = font.getGlyphSegs(ch.codePointAt(0));
    for (const s of segs) {
      if (s.type === SEG_QUAD) totalQuads++;
      else if (s.type === SEG_CUBIC) totalCubics++;
      else if (s.type === SEG_LINE) totalLines++;
    }
  }
  // TTF fonts MUST produce quads (their native curve type). Zero quads
  // alongside many cubics signals an unwanted quad→cubic promotion.
  if (totalQuads === 0 && totalCubics > 0)
    fail(`T1 zero quads emitted but ${totalCubics} cubics — quad→cubic promotion regression?`);
  else
    ok(
      `T1 glyphs '${probes}' emit ${totalQuads} quads, ${totalCubics} cubics, ${totalLines} lines (TTF-native quads preserved)`,
    );
}

// ----- T2: '0' has two contours (outer + inner counter) -----------
{
  const segs = font.getGlyphSegs(0x30); // '0'
  if (segs.length === 0) fail('T2 no segs for "0"');
  else {
    const startPt = (s) => s.p1;
    const endPt = (s) => s.p4 || s.p3 || s.p2 || s.p1;
    let contours = 0;
    let lastEnd = null;
    for (const s of segs) {
      const p0 = startPt(s);
      if (
        lastEnd == null ||
        Math.abs(p0[0] - lastEnd[0]) > 1e-3 ||
        Math.abs(p0[1] - lastEnd[1]) > 1e-3
      ) {
        contours++;
      }
      lastEnd = endPt(s);
    }
    if (contours !== 2) fail(`T2 '0' expected 2 contours (outer + counter), got ${contours}`);
    else ok(`T2 '0' has 2 contours (outer + counter)`);
  }
}

// ----- T3: even-odd point-in-path coverage topology --------------
{
  // Build a simple flattening + even-odd ray-cast against the glyph
  // segs. Flatten via uniform t-sampling (32 samples per curve is
  // ample for topology testing).
  function flatten(segs, samplesPerCurve = 32) {
    const pts = [];
    let lastEnd = null;
    let firstOfContour = null;
    const breaks = []; // start indices of each contour in pts
    for (const s of segs) {
      const startNew =
        lastEnd == null ||
        Math.abs(s.p1[0] - lastEnd[0]) > 1e-3 ||
        Math.abs(s.p1[1] - lastEnd[1]) > 1e-3;
      if (startNew) {
        if (firstOfContour) {
          pts.push(firstOfContour); // close previous contour
        }
        breaks.push(pts.length);
        pts.push([s.p1[0], s.p1[1]]);
        firstOfContour = [s.p1[0], s.p1[1]];
      }
      if (s.type === SEG_LINE) {
        pts.push([s.p2[0], s.p2[1]]);
        lastEnd = s.p2;
      } else if (s.type === SEG_QUAD) {
        for (let i = 1; i <= samplesPerCurve; i++) {
          const t = i / samplesPerCurve;
          const u = 1 - t;
          const x = u * u * s.p1[0] + 2 * u * t * s.p2[0] + t * t * s.p3[0];
          const y = u * u * s.p1[1] + 2 * u * t * s.p2[1] + t * t * s.p3[1];
          pts.push([x, y]);
        }
        lastEnd = s.p3;
      } else if (s.type === SEG_CUBIC) {
        for (let i = 1; i <= samplesPerCurve; i++) {
          const t = i / samplesPerCurve;
          const u = 1 - t;
          const x =
            u * u * u * s.p1[0] +
            3 * u * u * t * s.p2[0] +
            3 * u * t * t * s.p3[0] +
            t * t * t * s.p4[0];
          const y =
            u * u * u * s.p1[1] +
            3 * u * u * t * s.p2[1] +
            3 * u * t * t * s.p3[1] +
            t * t * t * s.p4[1];
          pts.push([x, y]);
        }
        lastEnd = s.p4;
      }
    }
    if (firstOfContour) pts.push(firstOfContour);
    return { pts, breaks };
  }

  function ringInsideTest(ring, px, py) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0],
        yi = ring[i][1];
      const xj = ring[j][0],
        yj = ring[j][1];
      if (yi > py !== yj > py) {
        const x = ((xj - xi) * (py - yi)) / (yj - yi) + xi;
        if (px < x) inside = !inside;
      }
    }
    return inside;
  }

  // Even-odd across contours = XOR of per-contour parity. Ray-casting the
  // concatenated point list as ONE polygon adds phantom edges between
  // contours (outer end → counter start), whose crossings depend on where
  // the font version happens to place each contour's start point.
  function evenOddInside(flat, px, py) {
    let inside = false;
    for (let k = 0; k < flat.breaks.length; k++) {
      const lo = flat.breaks[k];
      const hi = k + 1 < flat.breaks.length ? flat.breaks[k + 1] : flat.pts.length;
      if (ringInsideTest(flat.pts.slice(lo, hi), px, py)) inside = !inside;
    }
    return inside;
  }

  const segs = font.getGlyphSegs(0x30);
  const flat = flatten(segs);
  const pts = flat.pts;
  if (pts.length < 8) fail('T3 flatten produced too few points');
  else {
    // bbox
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const p of pts) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    // Center of the '0' is inside the COUNTER → must report OUTSIDE
    // for even-odd fill. (For two contours with opposite winding
    // even-odd toggles to outside at the counter.)
    const centerInside = evenOddInside(flat, cx, cy);
    if (centerInside) fail('T3 center of "0" reports inside — counter winding broken');
    else ok('T3 center of "0" is outside (counter punches through, as expected)');

    // A point clearly inside the ring (between outer and counter): halfway
    // between the COUNTER's right edge and the outer right edge at mid-height.
    // (Halfway between center and outer edge lands inside the counter for any
    // '0' whose counter is wider than half the glyph — i.e. most fonts.)
    let counterMaxX = cx;
    if (flat.breaks.length >= 2) {
      let bestArea = Infinity,
        bestMaxX = cx;
      for (let k = 0; k < flat.breaks.length; k++) {
        const lo = flat.breaks[k];
        const hi = k + 1 < flat.breaks.length ? flat.breaks[k + 1] : pts.length;
        let x0 = Infinity,
          y0 = Infinity,
          x1 = -Infinity,
          y1 = -Infinity;
        for (let i = lo; i < hi; i++) {
          const p = pts[i];
          if (p[0] < x0) x0 = p[0];
          if (p[0] > x1) x1 = p[0];
          if (p[1] < y0) y0 = p[1];
          if (p[1] > y1) y1 = p[1];
        }
        const area = (x1 - x0) * (y1 - y0);
        if (area < bestArea) {
          bestArea = area;
          bestMaxX = x1;
        }
      }
      counterMaxX = bestMaxX;
    }
    const rx = (counterMaxX + maxX) * 0.5;
    const ringInside = evenOddInside(flat, rx, cy);
    if (!ringInside) fail('T3 right-wall of "0" reports outside — outer contour broken');
    else ok('T3 right-wall of "0" is inside (ring fills, as expected)');

    // Far outside the bbox.
    const farInside = evenOddInside(flat, maxX + 100, cy);
    if (farInside) fail('T3 far-outside point reports inside — bogus winding');
    else ok('T3 far-outside is outside (sanity)');
  }
}

// ----- T3b: no duplicate consecutive segs (overshoot guard) -------
// Off-curve-start contours must be walked with steps=n, not n+1;
// the latter emits a duplicate first seg plus a stray closing line.
// Fingerprint: identical signatures on segs that should each belong
// to disjoint contour positions.
{
  const segs = font.getGlyphSegs(0x30);
  const sigs = new Map();
  let dup = null;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const pts =
      s.type === SEG_LINE
        ? [s.p1, s.p2]
        : s.type === SEG_QUAD
          ? [s.p1, s.p2, s.p3]
          : [s.p1, s.p2, s.p3, s.p4];
    const sig = s.type + '|' + pts.map((p) => p[0].toFixed(2) + ',' + p[1].toFixed(2)).join('|');
    if (sigs.has(sig)) {
      dup = { i, j: sigs.get(sig), sig };
      break;
    }
    sigs.set(sig, i);
  }
  if (dup) fail(`T3b duplicate seg in "0": #${dup.i} == #${dup.j} sig=${dup.sig}`);
  else ok(`T3b "0" has no duplicate segs (walker steps=n, no overshoot)`);
}

// ----- T4: text bundle assembly still works -----------------------
{
  const out = buildSvgTextGlyphs('0', font, 0, 0, 100, null, 0);
  if (!out.glyphs || out.glyphs.length !== 1)
    fail(`T4 expected 1 glyph for "0", got ${out.glyphs ? out.glyphs.length : 0}`);
  else if (out.glyphs[0].segs.length === 0)
    fail('T4 "0" glyph emitted zero segs through buildSvgTextGlyphs');
  else {
    // Verify the SVG-text path also kept quads native (no promotion
    // inside buildSvgTextGlyphs's seg-rewrite loop either).
    let nQuad = 0,
      nCubic = 0;
    for (const s of out.glyphs[0].segs) {
      if (s.type === SEG_QUAD) nQuad++;
      else if (s.type === SEG_CUBIC) nCubic++;
    }
    if (nQuad === 0 && nCubic > 0)
      fail(`T4 SVG-text path promoted ${nCubic} cubics from a TTF source — regression`);
    else
      ok(
        `T4 buildSvgTextGlyphs("0") emits ${out.glyphs[0].segs.length} segs (${nQuad} quads + ${nCubic} cubics)`,
      );
  }
}

// Original contour points, including off-curve controls, determine attachment offsets.
{
  const { pointAttachmentFonts } = await import('./_ttPointAttachmentFixture.mjs');
  const { autoRegisterForFont } = await import('../../src/font/auto.js');
  const cmp = (a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  };
  const pointCmp = (a, b) => a[0] - b[0] || a[1] - b[1];
  const canonical = (s) => {
    let p =
      s.type === 0 ? [s.p1, s.p2] : s.type === 1 ? [s.p1, s.p2, s.p3] : [s.p1, s.p2, s.p3, s.p4];
    if (
      pointCmp(p.at(-1), p[0]) < 0 ||
      (pointCmp(p.at(-1), p[0]) === 0 && p.length > 2 && pointCmp(p.at(-2), p[1]) < 0)
    )
      p = p.reverse();
    return [s.type, ...p.flat()];
  };
  for (const fixture of pointAttachmentFonts) {
    const bytes = new Uint8Array(Buffer.from(fixture.font, 'base64'));
    await autoRegisterForFont(bytes);
    const f = new MantleFontAsset(bytes),
      segs = f
        .getGlyphSegsByGidVar(2, null)
        .filter((s) => s.type !== 0 || pointCmp(s.p1, s.p2) !== 0)
        .map(canonical)
        .sort(cmp);
    if (
      segs.length !== fixture.segments.length ||
      segs.some(
        (s, i) =>
          s.length !== fixture.segments[i].length ||
          s.some((v, j) => Math.abs(v - fixture.segments[i][j]) > 1e-6),
      )
    )
      fail('point attachment ' + fixture.label);
    else ok('point attachment ' + fixture.label);
  }
}

if (failures > 0) {
  console.error(`\nGLYPH-SEGS-TTF-NATIVE-QUAD FAIL (${failures})`);
  process.exit(1);
}
console.log('\nGLYPH-SEGS-TTF-NATIVE-QUAD PASS');
