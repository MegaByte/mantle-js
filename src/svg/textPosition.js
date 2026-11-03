// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/textPosition.js — pure helpers of the SVG <text> importer: white-space processing, the per-character position
// lists and the baseline tables. No DOM and no geometry; importText.js owns the walk.

import { parseLengthOr, splitLengthList } from './length.js';

/// SVG 1.1 §10.15 white-space handling, as browsers apply it, for ONE text node. `state.prevSpace` carries across nodes
/// (it starts true so the text's leading space is stripped).
///   default  : newline and tab become a space, a run of spaces collapses to one, and a space that follows another
///              space -- in this node or the previous one -- is dropped. Only XML white space collapses (space, tab,
///              CR, LF); a no-break space is a character.
///   'css'    : white-space: pre, pre-wrap or break-spaces: every newline becomes ONE space (browsers draw no forced break in SVG text), nothing
///              collapses, and a tab stays a tab (it advances to a tab stop in the layout).
///   preserve : every newline and tab becomes ONE space and nothing collapses (SVG 1.1 §10.15 and SVG 2 §11.10.3.2: "convert all
///              newline and tab characters into space characters"; no line is broken).
///   'legacy' : an explicit xml:space="default" (SVG 2 §11.10.3.2): every newline is REMOVED, then a tab becomes a space, leading and
///              trailing spaces go and a run of spaces collapses. Browsers turn the newline into a space instead; compat 'chrome'
///              passes false (the first mode) for it.
export function processWhitespace(raw, preserve, state) {
  if (preserve === true) {
    state.prevSpace = false;
    return raw.replace(/\r\n|[\r\n\t]/g, ' ');
  }
  if (preserve === 'css') {
    // white-space: pre / pre-wrap / break-spaces: a newline is a space, a tab survives for the tab stops
    state.prevSpace = false;
    return raw.replace(/\r\n|[\r\n]/g, ' ');
  }
  if (preserve === 'legacy') raw = raw.replace(/\r\n|[\r\n]/g, '');
  let t = raw.replace(/[ \t\r\n]+/g, ' ');
  if (state.prevSpace && t.startsWith(' ')) t = t.slice(1);
  if (t) state.prevSpace = t.endsWith(' ');
  return t;
}

/// A whitespace/comma separated list of lengths (x, y, dx, dy), each resolved against `ctx`; null when the attribute is
/// absent. An entry that does not parse is 0, as the list position it holds still counts (SVG 2 §11.7.2).
export function parseLengthList(raw, ctx) {
  if (raw == null) return null;
  const tokens = splitLengthList(raw);
  if (!tokens || !tokens.length) return null;
  return tokens.map((t) => parseLengthOr(t, 0, ctx));
}

/// The `rotate` list in degrees; null when absent or empty.
export function parseRotateList(raw) {
  if (raw == null) return null;
  const tokens = splitLengthList(raw);
  if (!tokens || !tokens.length) return null;
  return tokens.map((t) => {
    const v = parseFloat(t);
    return Number.isFinite(v) ? v : 0;
  });
}

/// Height of the named baseline above the alphabetic one, in em, for a font with `ascent` and `descent` (descent is
/// negative as the font reports it) and `xHeight`. Positive is up. The same table browsers use: `hanging` is 0.8 of
/// the ascent and `mathematical` half of it. Null for a keyword that selects the alphabetic baseline.
export function baselineHeightEm(keyword, font) {
  const k = String(keyword || '')
    .trim()
    .toLowerCase();
  const asc = font.ascent || 0,
    desc = -(font.descent || 0);
  switch (k) {
    case 'middle':
      return (font.xHeight || 0.5) / 2;
    case 'central':
      return (asc - desc) / 2;
    case 'hanging':
      return asc * 0.8;
    case 'mathematical':
      return asc / 2;
    case 'text-before-edge':
    case 'text-top':
    case 'before-edge':
      return asc;
    case 'text-after-edge':
    case 'text-bottom':
    case 'after-edge':
      return -desc;
    case 'ideographic':
      return -desc;
    default:
      return null;
  }
}

/// `baseline-shift` (CSS Inline 3 / SVG 1.1 §10.9.2) as user units raised above the parent's baseline: `baseline` is 0,
/// `sub` and `super` use the font's OS/2 offsets (a third / a seventh of an em when it has none), a percentage is of the
/// font size and a length is itself. Null for an absent or invalid value.
export function parseBaselineShift(raw, font, fontSize, lengthCtx) {
  if (raw == null) return null;
  const t = String(raw).trim().toLowerCase();
  if (!t || t === 'inherit') return null;
  if (t === 'baseline') return 0;
  if (t === 'super')
    return (font && font.superscriptOffset > 0 ? font.superscriptOffset : 1 / 3) * fontSize;
  if (t === 'sub')
    return -(font && font.subscriptOffset > 0 ? font.subscriptOffset : 1 / 7) * fontSize;
  if (t.endsWith('%')) {
    const p = parseFloat(t);
    return Number.isFinite(p) ? (p / 100) * fontSize : null;
  }
  const v = parseLengthOr(t, NaN, lengthCtx);
  return Number.isFinite(v) ? v : null;
}
