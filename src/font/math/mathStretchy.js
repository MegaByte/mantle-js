// mathStretchy.js — codepoint-triggered MATH stretchy variants.
//
// Some math codepoints render stretched WITHOUT requiring math-layout
// markup (no `<mfenced>`, no `\left\right`, no `displaystyle` flag).
// Two categories trigger from codepoint alone:
//
// 1. ALWAYS-STRETCHY: codepoints whose nature is "spans content".
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
  0x23DC, // TOP PAREN
  0x23DD, // BOTTOM PAREN
  0x23DE, // TOP CURLY BRACKET (overbrace ⏞)
  0x23DF, // BOTTOM CURLY BRACKET (underbrace ⏟)
  0x23B4, // TOP SQUARE BRACKET
  0x23B5, // BOTTOM SQUARE BRACKET
  0x23E0, // TOP TORTOISE SHELL BRACKET
  0x23E1, // BOTTOM TORTOISE SHELL BRACKET
]);

const _ALWAYS_STRETCHY_HORIZ = new Set([
  // Horizontal stretchy: same overbrace/underbrace codepoints actually
  // stretch HORIZONTALLY (they span the content beneath/above them).
  0x23DC, 0x23DD, 0x23DE, 0x23DF, 0x23B4, 0x23B5, 0x23E0, 0x23E1,
  // Combining horizontal arrows above/below (math accents that span):
  0x20D6, // COMBINING LEFT ARROW ABOVE
  0x20D7, // COMBINING RIGHT ARROW ABOVE
  0x20E1, // COMBINING LEFT RIGHT ARROW ABOVE
  0x20EE, // COMBINING LEFT ARROW BELOW
  0x20EF, // COMBINING RIGHT ARROW BELOW
]);

// N-ary operators that render at display-size by default when used
// in math context. Per MathML operator dictionary 'largeop=true'.
const _DISPLAY_NARY = new Set([
  // U+220F..U+2211 — Big Pi / Big Coproduct / Summation
  0x220F, // N-ARY PRODUCT ∏
  0x2210, // N-ARY COPRODUCT ∐
  0x2211, // N-ARY SUMMATION ∑
  // U+222B..U+2233 — Integral family
  0x222B, // INTEGRAL ∫
  0x222C, // DOUBLE INTEGRAL ∬
  0x222D, // TRIPLE INTEGRAL ∭
  0x222E, // CONTOUR INTEGRAL ∮
  0x222F, // SURFACE INTEGRAL ∯
  0x2230, // VOLUME INTEGRAL ∰
  0x2231, // CLOCKWISE INTEGRAL ∱
  0x2232, // CLOCKWISE CONTOUR INTEGRAL ∲
  0x2233, // ANTICLOCKWISE CONTOUR INTEGRAL ∳
  // U+22C0..U+22C3 — N-ary logical operators
  0x22C0, // N-ARY LOGICAL AND ⋀
  0x22C1, // N-ARY LOGICAL OR ⋁
  0x22C2, // N-ARY INTERSECTION ⋂
  0x22C3, // N-ARY UNION ⋃
  // U+2A00..U+2A1C — additional large operators
  0x2A00, // N-ARY CIRCLED DOT OPERATOR ⨀
  0x2A01, // N-ARY CIRCLED PLUS OPERATOR ⨁
  0x2A02, // N-ARY CIRCLED TIMES OPERATOR ⨂
  0x2A03, // N-ARY UNION OPERATOR WITH DOT ⨃
  0x2A04, // N-ARY UNION OPERATOR WITH PLUS ⨄
  0x2A05, // N-ARY SQUARE INTERSECTION OPERATOR ⨅
  0x2A06, // N-ARY SQUARE UNION OPERATOR ⨆
  0x2A07, // TWO LOGICAL AND OPERATOR ⨇
  0x2A08, // TWO LOGICAL OR OPERATOR ⨈
  0x2A09, // N-ARY TIMES OPERATOR ⨉
  0x2A0B, // SUMMATION WITH INTEGRAL ⨋
  0x2A0C, // QUADRUPLE INTEGRAL OPERATOR ⨌
  0x2A0D, // FINITE PART INTEGRAL ⨍
  0x2A0E, // INTEGRAL WITH DOUBLE STROKE ⨎
  0x2A0F, // INTEGRAL AVERAGE WITH SLASH ⨏
  0x2A10, // CIRCULATION FUNCTION ⨐
  0x2A11, // ANTICLOCKWISE INTEGRATION ⨑
  0x2A12, // LINE INTEGRATION WITH RECTANGULAR PATH ⨒
  0x2A13, // LINE INTEGRATION WITH SEMICIRCULAR PATH ⨓
  0x2A14, // LINE INTEGRATION NOT INCLUDING POLE ⨔
  0x2A15, // INTEGRAL AROUND A POINT ⨕
  0x2A16, // QUATERNION INTEGRAL ⨖
  0x2A17, // INTEGRAL WITH LEFTWARDS ARROW ⨗
  0x2A18, // INTEGRAL WITH TIMES SIGN ⨘
  0x2A19, // INTEGRAL WITH INTERSECTION ⨙
  0x2A1A, // INTEGRAL WITH UNION ⨚
  0x2A1B, // INTEGRAL WITH OVERBAR ⨛
  0x2A1C, // INTEGRAL WITH UNDERBAR ⨜
]);

/// True iff `codepoint` is a math stretchy glyph that should ALWAYS
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
  return isAlwaysStretchy(codepoint, 'v') || isAlwaysStretchy(codepoint, 'h') || isDisplayNary(codepoint);
}
