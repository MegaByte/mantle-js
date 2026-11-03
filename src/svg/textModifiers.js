// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/textModifiers.js — Text-side driver primitives (Rive
// TextFollowPathModifier / TextVariationModifier / per-glyph
// addressing for animator ranges).
//
// All functions take a pre-shaped glyph layout (the structure
// produced by `layoutFn` in the SVG importer: an array of
// `{ codepoint, segs, penX, advance, ... }` entries) and return a
// transformed glyph array. They never mutate the input.

import { SEG_LINE, SEG_QUAD, SEG_CUBIC, mkLine, mkQuad, mkCubic } from './segment.js';
import { buildPathArcLengthLut, samplePathAt } from './textures.js';

// ────────────────────────────────────────────────────────────────
// TextFollowPathModifier (Rive: text/text_follow_path_modifier.hpp)
// ────────────────────────────────────────────────────────────────
//
// Lays glyphs along a path (segment list) with:
//   strength: 0..1 — interpolation between the unfollowed (flat)
//     glyph position and the on-path position. 0 = baseline stays
//     a straight line (no follow); 1 = full textPath following.
//     Lerps both position AND rotation.
//   start, end, offset: 0..1 — sub-range of the path used for layout.
//     start=0/end=1/offset=0 is full path. The arc-length window
//     [start..end] is shifted by `offset`; a wrapped window
//     (start+offset > end+offset mod 1) emits in two runs.
//   radial: when true, the glyph's local y-axis rotates to point
//     along the path normal (radial orient — characters splay
//     outward like rays). When false (default), local x rotates to
//     the path tangent and local y to the normal (standard
//     tangential textPath — what SVG `<textPath>` does).
//
// Returns a glyph-array compatible with the input. Each glyph's
// `.segs` is rewritten to the warped position; `.followed = true`
// on every output entry.
//
// `pathSegs`: a Seg[] in the same coordinate space as the glyph
// segs (typically em-applied SVG user-units).
export function textFollowPath(glyphs, pathSegs, opts = {}) {
  if (!glyphs || glyphs.length === 0 || !pathSegs || pathSegs.length === 0) {
    return glyphs ? glyphs.slice() : [];
  }
  const strength = opts.strength === undefined ? 1 : Math.max(0, Math.min(1, opts.strength));
  const start = opts.start === undefined ? 0 : Math.max(0, Math.min(1, opts.start));
  const end = opts.end === undefined ? 1 : Math.max(0, Math.min(1, opts.end));
  const offset = opts.offset === undefined ? 0 : opts.offset;
  const radial = !!opts.radial;
  // Pre-build the path arc-length LUT (shared across all glyphs).
  const lut = buildPathArcLengthLut(pathSegs);
  // The on-path window is [start*total, end*total] in arc-length;
  // the OFFSET shifts the *anchor* (the s coordinate the glyph
  // samples), not the window. Conventional Rive behavior: glyphs
  // map their advance-midpoint to a fraction of the window plus
  // offset, modulo total when looping.
  const sWinStart = start * lut.total;
  const sWinEnd = end * lut.total;
  const sWin = sWinEnd - sWinStart;
  if (sWin <= 0) return [];

  let layoutEnd = 0;
  for (const g of glyphs) {
    const e = (g.penX || 0) + (g.advance || 0);
    if (e > layoutEnd) layoutEnd = e;
  }
  if (layoutEnd <= 0) return [];

  const out = [];
  for (const g of glyphs) {
    if (!g.segs || !g.segs.length) continue;
    const cx = (g.penX || 0) + (g.advance || 0) * 0.5;
    // Glyph fraction along the layout.
    let f = cx / layoutEnd;
    // Apply offset (fraction of window) and wrap into [0, 1].
    f = f + offset;
    f = f - Math.floor(f);
    // Map to arc-length within the window.
    const sAt = sWinStart + f * sWin;
    const sample = samplePathAt(lut, sAt);
    // Flat-baseline position (strength=0) is just the glyph's
    // existing layout pose. On-path pose follows tangent (or normal,
    // for radial). Interpolate both.
    // Tangent → (tx, ty). Normal (rotated +90° CCW in y-down) → (-ty, tx).
    let ax = sample.tx,
      ay = sample.ty;
    let nx = -ay,
      ny = ax;
    if (radial) {
      // Radial orient: glyph's local-x axis = normal (so glyphs
      // splay outward), local-y = -tangent (so vertical stroke
      // points along path forward direction).
      const tmpX = ax,
        tmpY = ay;
      ax = nx;
      ay = ny;
      nx = -tmpX;
      ny = -tmpY;
    }
    // Strength lerp on axes: identity-rotation flat baseline = (1,0)/(0,1).
    const aXmix = ax * strength + 1 * (1 - strength);
    const aYmix = ay * strength + 0 * (1 - strength);
    const nXmix = nx * strength + 0 * (1 - strength);
    const nYmix = ny * strength + 1 * (1 - strength);
    // Flat position is (cx, 0); on-path is (sample.x, sample.y);
    // lerp.
    const px = sample.x * strength + cx * (1 - strength);
    const py = sample.y * strength + 0 * (1 - strength);
    const xf = (p) => {
      const lx = p[0] - cx;
      const ly = p[1];
      return [px + aXmix * lx + nXmix * ly, py + aYmix * lx + nYmix * ly];
    };
    const xformed = new Array(g.segs.length);
    for (let i = 0; i < g.segs.length; i++) {
      const sg = g.segs[i];
      if (sg.type === SEG_LINE) xformed[i] = mkLine(xf(sg.p1), xf(sg.p2));
      else if (sg.type === SEG_QUAD) xformed[i] = mkQuad(xf(sg.p1), xf(sg.p2), xf(sg.p3));
      else if (sg.type === SEG_CUBIC)
        xformed[i] = mkCubic(xf(sg.p1), xf(sg.p2), xf(sg.p3), xf(sg.p4));
      else xformed[i] = sg;
    }
    out.push({
      ...g,
      segs: xformed,
      followed: true,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// TextVariationModifier (Rive: text/text_variation_modifier.hpp)
// ────────────────────────────────────────────────────────────────
//
// Animate variable-font axis coordinates per-glyph over a
// character-index range. Returns a NEW glyph array where each
// glyph carries its own `.varCoords` map keyed by 4-char axis tag.
//
// The actual glyph re-rasterization at the new axis coords is the
// host's responsibility (call the font subsystem with the per-glyph
// varCoords). This function just decorates the layout with the
// per-glyph axis values; downstream code (textRun.js / MantleTextRun)
// reads `.varCoords` when emitting glyph segs.
//
// `range`: { startIndex, endIndex, fallOffStart, fallOffEnd }
//   - startIndex / endIndex: glyph-index range over which the axis
//     value transitions from baseValue → targetValue.
//   - fallOffStart / fallOffEnd: number of glyphs over which the
//     transition ramps. Glyphs inside [startIndex+falloffStart ..
//     endIndex-falloffEnd] get the full targetValue.
//
// `axes`: a map { tag: { base, target } } where tag is the OT axis
// tag (e.g. 'wght', 'wdth', 'slnt', 'opsz', 'ital'). All four-char
// tags supported by the font's fvar table are valid.
export function textVariationApply(glyphs, range, axes) {
  if (!glyphs || glyphs.length === 0) return glyphs ? glyphs.slice() : [];
  const sI = range && range.startIndex !== undefined ? range.startIndex : 0;
  const eI = range && range.endIndex !== undefined ? range.endIndex : glyphs.length;
  const fS = range && range.fallOffStart !== undefined ? range.fallOffStart : 0;
  const fE = range && range.fallOffEnd !== undefined ? range.fallOffEnd : 0;
  const axesArr = Object.keys(axes || {});
  if (!axesArr.length) return glyphs.slice();
  const out = new Array(glyphs.length);
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    let weight = 0; // 0 = use base, 1 = use target
    if (i >= sI && i <= eI) {
      const inStart = i - sI;
      const inEnd = eI - i;
      // Linear ramp in/out via the falloff lengths.
      const wIn = fS > 0 ? Math.min(1, inStart / fS) : 1;
      const wOut = fE > 0 ? Math.min(1, inEnd / fE) : 1;
      weight = Math.max(0, Math.min(wIn, wOut));
    }
    const varCoords = { ...(g.varCoords || {}) };
    for (const tag of axesArr) {
      const { base = 0, target = 0 } = axes[tag] || {};
      varCoords[tag] = base + (target - base) * weight;
    }
    out[i] = { ...g, varCoords };
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// Per-glyph text addressing (Lottie range selector / Rive
// TextModifierRange + TextModifierGroup)
// ────────────────────────────────────────────────────────────────
//
// Both Lottie and Rive layer per-glyph property animation on top of
// a text layout: opacity, color, transform offset/rotation/scale,
// each gated by a glyph-index range with falloff curves. The
// renderer-side primitive is a "glyph override table" — a per-
// glyph dictionary of property overrides applied at draw time.
//
// `applyGlyphRange(glyphs, range, props)`:
//   - range: { startIndex, endIndex, fallOffStart, fallOffEnd, easing }
//   - props: per-property { base, target } pairs; common keys:
//       opacity:      number 0..1
//       tint:         [r,g,b,a] (multiplicative tint over existing fill)
//       transformX:   number, post-layout x shift (em units)
//       transformY:   number
//       rotateDeg:    number, around glyph advance-midpoint
//       scale:        number (uniform; for non-uniform pass scaleX/scaleY)
//       scaleX, scaleY: numbers
//
// Returns a NEW glyph array where each glyph has a `.modifiers`
// dictionary populated. Downstream renderers compose multiple
// modifier passes via repeated calls before emit.
//
// easing: 'linear' (default), 'easeIn', 'easeOut', 'easeInOut'.
export function applyGlyphRange(glyphs, range, props) {
  if (!glyphs || glyphs.length === 0) return glyphs ? glyphs.slice() : [];
  const sI = range && range.startIndex !== undefined ? range.startIndex : 0;
  const eI = range && range.endIndex !== undefined ? range.endIndex : glyphs.length;
  const fS = range && range.fallOffStart !== undefined ? range.fallOffStart : 0;
  const fE = range && range.fallOffEnd !== undefined ? range.fallOffEnd : 0;
  const easing = (range && range.easing) || 'linear';
  const easeFn = pickEasing(easing);
  const propKeys = Object.keys(props || {});
  if (!propKeys.length) return glyphs.slice();
  const out = new Array(glyphs.length);
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    let raw = 0;
    if (i >= sI && i <= eI) {
      const inStart = i - sI;
      const inEnd = eI - i;
      const wIn = fS > 0 ? Math.min(1, inStart / fS) : 1;
      const wOut = fE > 0 ? Math.min(1, inEnd / fE) : 1;
      raw = Math.max(0, Math.min(wIn, wOut));
    }
    const w = easeFn(raw);
    const m = { ...(g.modifiers || {}) };
    for (const k of propKeys) {
      const spec = props[k];
      if (!spec) continue;
      const base =
        spec.base !== undefined
          ? spec.base
          : Array.isArray(spec.target)
            ? spec.target.map(() => 0)
            : 0;
      const target = spec.target;
      if (Array.isArray(target)) {
        const baseArr = Array.isArray(base) ? base : target.map(() => base);
        m[k] = target.map((t, ix) => baseArr[ix] + (t - baseArr[ix]) * w);
      } else if (typeof target === 'number') {
        m[k] = base + (target - base) * w;
      }
    }
    out[i] = { ...g, modifiers: m };
  }
  return out;
}

function pickEasing(name) {
  switch (name) {
    case 'easeIn':
      return (t) => t * t;
    case 'easeOut':
      return (t) => 1 - (1 - t) * (1 - t);
    case 'easeInOut':
      return (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    case 'linear':
    default:
      return (t) => t;
  }
}
