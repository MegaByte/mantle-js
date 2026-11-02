// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// mathStretchy.js — codepoint-triggered MATH stretchy variants.
//
// Some math codepoints render stretched WITHOUT requiring math-layout
// markup (no `<mfenced>`, no `\left\right`, no `displaystyle` flag).
// Two categories trigger from codepoint alone:
//
// 1. always-STRETCHY: codepoints whose nature is "spans content".
//    Includes top/bottom braces, top/bottom square brackets, top/
//    bottom parens, horizontal arrows-above. Render at the largest
//    available variant; no surrounding context needed.
//
// 2. DISPLAY-SIZE N-ARY operators: integral / summation / product
//    families. Per OT MATH MathConstants.displayOperatorMinHeight,
//    these grow when used in "display style". Heuristic: any time one
//    of these codepoints appears, treat it as display-style (always
//    pull the display variant), matching what most document renderers
//    do for standalone operators.
//
// Reference for the codepoint lists: MathML Operator Dictionary 4.0
// (https://w3c.github.io/mathml/appendix/oper-dict.html) — the
// "stretchy" + "largeop" attributes correspond to these two
// categories respectively.

const _ALWAYS_STRETCHY_VERT = new Set([
  // Top/bottom braces + brackets + parens (Unicode 4.0+)
  0x23dc, // TOP PAREN
  0x23dd, // BOTTOM PAREN
  0x23de, // TOP CURLY BRACKET (overbrace ⏞)
  0x23df, // BOTTOM CURLY BRACKET (underbrace ⏟)
  0x23b4, // TOP SQUARE BRACKET
  0x23b5, // BOTTOM SQUARE BRACKET
  0x23e0, // TOP TORTOISE SHELL BRACKET
  0x23e1, // BOTTOM TORTOISE SHELL BRACKET
]);

const _ALWAYS_STRETCHY_HORIZ = new Set([
  // Horizontal stretchy: same overbrace/underbrace codepoints actually
  // stretch HORIZONTALLY (they span the content beneath/above them).
  0x23dc,
  0x23dd,
  0x23de,
  0x23df,
  0x23b4,
  0x23b5,
  0x23e0,
  0x23e1,
  // Combining horizontal arrows above/below (math accents that span):
  0x20d6, // COMBINING LEFT ARROW ABOVE
  0x20d7, // COMBINING RIGHT ARROW ABOVE
  0x20e1, // COMBINING LEFT RIGHT ARROW ABOVE
  0x20ee, // COMBINING LEFT ARROW BELOW
  0x20ef, // COMBINING RIGHT ARROW BELOW
]);

// N-ary operators that render at display-size by default when used
// in math context. Per MathML operator dictionary 'largeop=true'.
const _DISPLAY_NARY = new Set([
  // U+220F..U+2211 — Big Pi / Big Coproduct / Summation
  0x220f, // N-ARY PRODUCT ∏
  0x2210, // N-ARY COPRODUCT ∐
  0x2211, // N-ARY SUMMATION ∑
  // U+222B..U+2233 — Integral family
  0x222b, // INTEGRAL ∫
  0x222c, // DOUBLE INTEGRAL ∬
  0x222d, // TRIPLE INTEGRAL ∭
  0x222e, // CONTOUR INTEGRAL ∮
  0x222f, // SURFACE INTEGRAL ∯
  0x2230, // VOLUME INTEGRAL ∰
  0x2231, // CLOCKWISE INTEGRAL ∱
  0x2232, // CLOCKWISE CONTOUR INTEGRAL ∲
  0x2233, // ANTICLOCKWISE CONTOUR INTEGRAL ∳
  // U+22C0..U+22C3 — N-ary logical operators
  0x22c0, // N-ARY LOGICAL AND ⋀
  0x22c1, // N-ARY LOGICAL OR ⋁
  0x22c2, // N-ARY INTERSECTION ⋂
  0x22c3, // N-ARY UNION ⋃
  // U+2A00..U+2A1C — additional large operators
  0x2a00, // N-ARY CIRCLED DOT OPERATOR ⨀
  0x2a01, // N-ARY CIRCLED PLUS OPERATOR ⨁
  0x2a02, // N-ARY CIRCLED TIMES OPERATOR ⨂
  0x2a03, // N-ARY UNION OPERATOR WITH DOT ⨃
  0x2a04, // N-ARY UNION OPERATOR WITH PLUS ⨄
  0x2a05, // N-ARY SQUARE INTERSECTION OPERATOR ⨅
  0x2a06, // N-ARY SQUARE UNION OPERATOR ⨆
  0x2a07, // TWO LOGICAL AND OPERATOR ⨇
  0x2a08, // TWO LOGICAL OR OPERATOR ⨈
  0x2a09, // N-ARY TIMES OPERATOR ⨉
  0x2a0b, // SUMMATION WITH INTEGRAL ⨋
  0x2a0c, // QUADRUPLE INTEGRAL OPERATOR ⨌
  0x2a0d, // FINITE PART INTEGRAL ⨍
  0x2a0e, // INTEGRAL WITH DOUBLE STROKE ⨎
  0x2a0f, // INTEGRAL AVERAGE WITH SLASH ⨏
  0x2a10, // CIRCULATION FUNCTION ⨐
  0x2a11, // ANTICLOCKWISE INTEGRATION ⨑
  0x2a12, // LINE INTEGRATION WITH RECTANGULAR PATH ⨒
  0x2a13, // LINE INTEGRATION WITH SEMICIRCULAR PATH ⨓
  0x2a14, // LINE INTEGRATION NOT INCLUDING POLE ⨔
  0x2a15, // INTEGRAL AROUND A POINT ⨕
  0x2a16, // QUATERNION INTEGRAL ⨖
  0x2a17, // INTEGRAL WITH LEFTWARDS ARROW ⨗
  0x2a18, // INTEGRAL WITH TIMES SIGN ⨘
  0x2a19, // INTEGRAL WITH INTERSECTION ⨙
  0x2a1a, // INTEGRAL WITH UNION ⨚
  0x2a1b, // INTEGRAL WITH OVERBAR ⨛
  0x2a1c, // INTEGRAL WITH UNDERBAR ⨜
]);

/// True iff `codepoint` is a math stretchy glyph that should always
/// render at its largest available variant (overbrace, underbrace,
/// horizontal arrow above, etc.).
export function isAlwaysStretchy(codepoint, axis = 'v') {
  return axis === 'h'
    ? _ALWAYS_STRETCHY_HORIZ.has(codepoint)
    : _ALWAYS_STRETCHY_VERT.has(codepoint);
}

/// True iff `codepoint` is a math N-ary operator that should render
/// at displayOperatorMinHeight by default.
export function isDisplayNary(codepoint) {
  return _DISPLAY_NARY.has(codepoint);
}

/// Returns the target height (font units) that the codepoint should
/// stretch to. Different rules per category:
///   - Display n-ary: math.constants.displayOperatorMinHeight
///   - Always-stretchy (vertical): math.constants.accentBaseHeight × 2
///     (gives a "definitely larger than inline" target — the
///     font's largest pre-built variant will win on lookup)
/// `mathConstants` is the MathConstants struct from the font; falls
/// back to a reasonable default when constants are zero.
export function targetStretchHeight(codepoint, mathConstants) {
  if (isDisplayNary(codepoint)) {
    const h = mathConstants.displayOperatorMinHeight;
    return h > 0 ? h : 1800; // ~1.8 em for fonts that don't ship a constant
  }
  if (_ALWAYS_STRETCHY_VERT.has(codepoint)) {
    const h = mathConstants.accentBaseHeight;
    return h > 0 ? h * 2 : 1400;
  }
  return 0;
}

/// True iff `codepoint` triggers stretching on either axis or as a
/// display n-ary operator. For combining horizontal accents the
/// stretch target is the base glyph's advance width, supplied by the
/// caller.
export function isCodepointStretchy(codepoint) {
  return (
    isAlwaysStretchy(codepoint, 'v') || isAlwaysStretchy(codepoint, 'h') || isDisplayNary(codepoint)
  );
}
