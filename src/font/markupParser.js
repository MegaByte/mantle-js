// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { toUpper, toLower } from './unicode/case.js';
// Inline-tag markup parser. Recognized tags use stack semantics with
// value pre-validation. Supported tags: <color>, <size>, <voffset>,
// <u>, <s>, <mark>, <cspace>, <mspace>, <space>, <width>, <lowercase>,
// <uppercase>, <allcaps>, <nobr>, <align>, <indent>, <sub>, <sup>,
// <br>, <noparse>, <pos>, <line-height>, <rotate>, <scale>,
// <line-indent>, <margin>, <margin-left>, <margin-right>, <smallcaps>
// (GSUB 'smcp' + 'c2sc'), <link> (id propagates via Style.linkId so
// downstream hit-test code can map a hit position back to a link).

const NAMED_COLORS = {
  black: [0, 0, 0, 1],
  white: [1, 1, 1, 1],
  red: [1, 0, 0, 1],
  green: [0, 1, 0, 1],
  blue: [0, 0, 1, 1],
  yellow: [1, 235 / 255, 4 / 255, 1],
  cyan: [0, 1, 1, 1],
  magenta: [1, 0, 1, 1],
  grey: [0.5, 0.5, 0.5, 1],
  gray: [0.5, 0.5, 0.5, 1],
  orange: [1, 0.5, 0, 1],
  purple: [0.5, 0, 0.5, 1],
  pink: [1, 0.4, 0.7, 1],
};

/**
 * @typedef {[number,number,number,number]} Color
 * The authority for this shape is `defaultStyle()` below — keep the two in
 * step. (They had drifted: half the fields it emits were undeclared here, so
 * every caller that passed a real style looked ill-typed.)
 * @typedef {'solid'|'dashed'|'dotted'|'double'|'wavy'} DecorationStyle
 * @typedef {object} Style
 * @property {Color} color
 * @property {number} sizeScale
 * @property {number} voffsetEm
 * @property {number} widthScale
 * @property {number} cspaceEm   extra advance after every glyph (em)
 * @property {number} wspaceEm   extra advance on word separators (em)
 * @property {number} mspaceEm
 * @property {boolean} underline
 * @property {boolean} strikethrough
 * @property {Color|null} underlineColor      null = use the text color
 * @property {DecorationStyle} underlineStyle
 * @property {number} underlineThicknessEm    0 = use font.underlineThickness
 * @property {Color|null} strikeColor         null = use the text color
 * @property {DecorationStyle} strikeStyle
 * @property {number} strikeThicknessEm       0 = use font.underlineThickness
 * @property {boolean} mark
 * @property {Color} markColor
 * @property {boolean} nobr
 * @property {boolean} smallCaps
 * @property {boolean} bold
 * @property {boolean} italic
 * @property {number} rotateDeg
 * @property {number} glyphScale
 * @property {string|null} linkId
 *
 * @typedef {object} Directive
 * @property {boolean} hasAlign
 * @property {'left'|'center'|'right'} [align]
 * @property {boolean} hasIndent
 * @property {number} [indentEm]
 *
 * @typedef {object} Span
 * @property {string} text
 * @property {Style} style
 * @property {Directive} [directive]
 */

/** @returns {Style} */
export const defaultStyle = () => ({
  color: [0, 0, 0, 1],
  sizeScale: 1,
  voffsetEm: 0,
  widthScale: 1,
  cspaceEm: 0,
  wspaceEm: 0,
  mspaceEm: 0,
  underline: false,
  strikethrough: false,
  // Rich text-decoration: per-decoration color (null = use text color),
  // style ∈ {'solid','dashed','dotted','double','wavy'} (default solid),
  // thickness (em; 0 = use font.underlineThickness).
  underlineColor: null,
  underlineStyle: 'solid',
  underlineThicknessEm: 0,
  strikeColor: null,
  strikeStyle: 'solid',
  strikeThicknessEm: 0,
  mark: false,
  markColor: [1, 1, 0, 0.5],
  nobr: false,
  smallCaps: false,
  bold: false,
  italic: false,
  rotateDeg: 0,
  glyphScale: 1,
  linkId: null,
});

const CASE_NONE = 0,
  CASE_LOWER = 1,
  CASE_UPPER = 2;

/**
 * @param {string} markup
 * @param {Style} [base]
 * @returns {Span[]}
 */
export function parseMarkup(markup, base = defaultStyle()) {
  /** @type {Span[]} */
  const output = [];
  if (!markup) return output;

  // Bottom of each stack is the default (so close-tag against the
  // outermost layer is a no-op).
  const colorStack = [base.color.slice()];
  const sizeStack = [base.sizeScale];
  const voffsetStack = [base.voffsetEm];
  const widthStack = [base.widthScale];
  const cspaceStack = [base.cspaceEm];
  const mspaceStack = [base.mspaceEm];
  const ulStack = [base.underline];
  const ulColorStack = [base.underlineColor ? base.underlineColor.slice() : null];
  const ulStyleStack = [base.underlineStyle || 'solid'];
  const ulThickStack = [base.underlineThicknessEm || 0];
  const sStack = [base.strikethrough];
  const sColorStack = [base.strikeColor ? base.strikeColor.slice() : null];
  const sStyleStack = [base.strikeStyle || 'solid'];
  const sThickStack = [base.strikeThicknessEm || 0];
  const boldStack = [!!base.bold];
  const italicStack = [!!base.italic];
  const markStack = [base.mark];
  const markColorStack = [base.markColor.slice()];
  const nobrStack = [base.nobr];
  const smallCapsStack = [!!base.smallCaps];
  const caseStack = [CASE_NONE];
  const rotateStack = [base.rotateDeg || 0];
  const glyphScaleStack = [base.glyphScale || 1];
  const alignStack = [null]; // null = no override
  const indentStack = [0];
  const lineHeightStack = [0];
  const marginLeftStack = [0];
  const marginRightStack = [0];
  const linkIdStack = [base.linkId || null];
  // <noparse>: while >0, only </noparse> is honored.
  let noparseDepth = 0;

  const top = (a) => a[a.length - 1];

  const currentStyle = () => ({
    color: top(colorStack).slice(),
    sizeScale: top(sizeStack),
    voffsetEm: top(voffsetStack),
    widthScale: top(widthStack),
    cspaceEm: top(cspaceStack),
    // Carried from the base style rather than a stack: there is no <wspace>
    // tag to push one (unlike <cspace>/<mspace>). Omitting it would make
    // markup text silently LOSE any word spacing the caller had set — the
    // field is read by textLayout's word-separator advance and set by
    // buildSvgTextGlyphs' styleOpts.wordSpacingEm, so it would survive on
    // the SVG <text> path and vanish on the markup one.
    wspaceEm: base.wspaceEm || 0,
    mspaceEm: top(mspaceStack),
    underline: top(ulStack),
    underlineColor: top(ulColorStack) ? top(ulColorStack).slice() : null,
    underlineStyle: top(ulStyleStack),
    underlineThicknessEm: top(ulThickStack),
    strikethrough: top(sStack),
    strikeColor: top(sColorStack) ? top(sColorStack).slice() : null,
    strikeStyle: top(sStyleStack),
    strikeThicknessEm: top(sThickStack),
    bold: top(boldStack),
    italic: top(italicStack),
    mark: top(markStack),
    markColor: top(markColorStack).slice(),
    nobr: top(nobrStack),
    smallCaps: top(smallCapsStack),
    rotateDeg: top(rotateStack),
    glyphScale: top(glyphScaleStack),
    linkId: top(linkIdStack),
  });

  const n = markup.length;
  let i = 0;
  let buf = '';

  const flush = () => {
    if (!buf) return;
    let text = buf;
    const cse = top(caseStack);
    // Full Unicode case mapping (ß→SS, locale-independent).
    if (cse === CASE_LOWER) text = toLower(text);
    else if (cse === CASE_UPPER) text = toUpper(text);
    output.push({ text, style: currentStyle() });
    buf = '';
  };

  while (i < n) {
    const c = markup[i];
    if (c !== '<') {
      buf += c;
      i++;
      continue;
    }
    const end = markup.indexOf('>', i + 1);
    if (end < 0) {
      buf += c;
      i++;
      continue;
    }
    const inner = markup.slice(i + 1, end);

    // <noparse>: while active, only </noparse> is honored.
    if (noparseDepth > 0) {
      const t = inner.trim().toLowerCase();
      if (t === '/noparse') {
        noparseDepth--;
        i = end + 1;
        continue;
      }
      buf += markup.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (inner.trim().toLowerCase() === 'noparse') {
      flush();
      noparseDepth++;
      i = end + 1;
      continue;
    }
    // <br>, <br/> — emit literal newline.
    const tnorm = inner.trim().toLowerCase();
    if (tnorm === 'br' || tnorm === 'br/') {
      buf += '\n';
      i = end + 1;
      continue;
    }

    const parsed = parseTag(
      inner,
      colorStack,
      sizeStack,
      voffsetStack,
      widthStack,
      cspaceStack,
      mspaceStack,
      ulStack,
      sStack,
      markStack,
      markColorStack,
      nobrStack,
      caseStack,
      alignStack,
      indentStack,
      rotateStack,
      lineHeightStack,
      glyphScaleStack,
      marginLeftStack,
      marginRightStack,
      smallCapsStack,
      boldStack,
      italicStack,
      linkIdStack,
      ulColorStack,
      ulStyleStack,
      ulThickStack,
      sColorStack,
      sStyleStack,
      sThickStack,
    );
    if (parsed) {
      flush();
      parsed.apply();
      if (parsed.inject) output.push(/** @type {Span} */ (parsed.inject));
      i = end + 1;
    } else {
      buf += markup.slice(i, end + 1);
      i = end + 1;
    }
  }
  flush();
  return output;
}

function parseTag(
  inner,
  colorStack,
  sizeStack,
  voffsetStack,
  widthStack,
  cspaceStack,
  mspaceStack,
  ulStack,
  sStack,
  markStack,
  markColorStack,
  nobrStack,
  caseStack,
  alignStack,
  indentStack,
  rotateStack,
  lineHeightStack,
  glyphScaleStack,
  marginLeftStack,
  marginRightStack,
  smallCapsStack,
  boldStack,
  italicStack,
  linkIdStack,
  ulColorStack,
  ulStyleStack,
  ulThickStack,
  sColorStack,
  sStyleStack,
  sThickStack,
) {
  if (!inner) return null;

  // Closing tag.
  if (inner[0] === '/') {
    const name = inner.slice(1).trim().toLowerCase();
    switch (name) {
      case 'color':
        return colorStack.length > 1 ? { apply: () => colorStack.pop(), inject: null } : null;
      case 'size':
        return sizeStack.length > 1 ? { apply: () => sizeStack.pop(), inject: null } : null;
      case 'voffset':
        return voffsetStack.length > 1 ? { apply: () => voffsetStack.pop(), inject: null } : null;
      case 'width':
        return widthStack.length > 1 ? { apply: () => widthStack.pop(), inject: null } : null;
      case 'cspace':
        return cspaceStack.length > 1 ? { apply: () => cspaceStack.pop(), inject: null } : null;
      case 'mspace':
        return mspaceStack.length > 1 ? { apply: () => mspaceStack.pop(), inject: null } : null;
      case 'u':
        return ulStack.length > 1
          ? {
              apply: () => {
                ulStack.pop();
                ulColorStack.pop();
                ulStyleStack.pop();
                ulThickStack.pop();
              },
              inject: null,
            }
          : null;
      case 's':
        return sStack.length > 1
          ? {
              apply: () => {
                sStack.pop();
                sColorStack.pop();
                sStyleStack.pop();
                sThickStack.pop();
              },
              inject: null,
            }
          : null;
      case 'b':
      case 'strong':
        return boldStack.length > 1 ? { apply: () => boldStack.pop(), inject: null } : null;
      case 'i':
      case 'em':
        return italicStack.length > 1 ? { apply: () => italicStack.pop(), inject: null } : null;
      case 'mark':
        return markStack.length > 1
          ? {
              apply: () => {
                markStack.pop();
                markColorStack.pop();
              },
              inject: null,
            }
          : null;
      case 'nobr':
        return nobrStack.length > 1 ? { apply: () => nobrStack.pop(), inject: null } : null;
      case 'lowercase':
      case 'uppercase':
      case 'allcaps':
        return caseStack.length > 1 ? { apply: () => caseStack.pop(), inject: null } : null;
      case 'align': {
        if (alignStack.length <= 1) return null;
        const restored = alignStack[alignStack.length - 2];
        return {
          apply: () => alignStack.pop(),
          inject: {
            text: '',
            style: defaultStyle(),
            directive: { hasAlign: true, align: restored || 'left', hasIndent: false, indentEm: 0 },
          },
        };
      }
      case 'indent': {
        if (indentStack.length <= 1) return null;
        const restored = indentStack[indentStack.length - 2];
        return {
          apply: () => indentStack.pop(),
          inject: {
            text: '',
            style: defaultStyle(),
            directive: { hasAlign: false, hasIndent: true, indentEm: restored },
          },
        };
      }
      case 'sub':
      case 'sup':
        if (sizeStack.length > 1 && voffsetStack.length > 1) {
          return {
            apply: () => {
              sizeStack.pop();
              voffsetStack.pop();
            },
            inject: null,
          };
        }
        return null;
      case 'rotate':
        return rotateStack.length > 1 ? { apply: () => rotateStack.pop(), inject: null } : null;
      case 'line-height':
      case 'lineheight': {
        if (lineHeightStack.length <= 1) return null;
        const restored = lineHeightStack[lineHeightStack.length - 2];
        return {
          apply: () => lineHeightStack.pop(),
          inject: {
            text: '',
            style: defaultStyle(),
            directive: { hasLineHeight: true, lineHeightEm: restored },
          },
        };
      }
      case 'scale':
        return glyphScaleStack.length > 1
          ? { apply: () => glyphScaleStack.pop(), inject: null }
          : null;
      case 'margin': {
        if (marginLeftStack.length <= 1 || marginRightStack.length <= 1) return null;
        const restoredL = marginLeftStack[marginLeftStack.length - 2];
        const restoredR = marginRightStack[marginRightStack.length - 2];
        return {
          apply: () => {
            marginLeftStack.pop();
            marginRightStack.pop();
          },
          inject: {
            text: '',
            style: defaultStyle(),
            directive: {
              hasMarginLeft: true,
              marginLeftEm: restoredL,
              hasMarginRight: true,
              marginRightEm: restoredR,
            },
          },
        };
      }
      case 'margin-left':
      case 'marginleft': {
        if (marginLeftStack.length <= 1) return null;
        const restoredL = marginLeftStack[marginLeftStack.length - 2];
        return {
          apply: () => marginLeftStack.pop(),
          inject: {
            text: '',
            style: defaultStyle(),
            directive: { hasMarginLeft: true, marginLeftEm: restoredL },
          },
        };
      }
      case 'margin-right':
      case 'marginright': {
        if (marginRightStack.length <= 1) return null;
        const restoredR = marginRightStack[marginRightStack.length - 2];
        return {
          apply: () => marginRightStack.pop(),
          inject: {
            text: '',
            style: defaultStyle(),
            directive: { hasMarginRight: true, marginRightEm: restoredR },
          },
        };
      }
      case 'smallcaps':
        return smallCapsStack.length > 1
          ? { apply: () => smallCapsStack.pop(), inject: null }
          : null;
      case 'link':
        return linkIdStack.length > 1 ? { apply: () => linkIdStack.pop(), inject: null } : null;
      default:
        return null;
    }
  }

  const eq = inner.indexOf('=');
  const name = (eq < 0 ? inner : inner.slice(0, eq)).trim().toLowerCase();
  const value = eq < 0 ? null : inner.slice(eq + 1).trim();

  switch (name) {
    case 'color': {
      const col = parseColor(value);
      return col ? { apply: () => colorStack.push(col), inject: null } : null;
    }
    case 'size': {
      const sz = parseSize(value, sizeStack[sizeStack.length - 1]);
      return sz == null ? null : { apply: () => sizeStack.push(sz), inject: null };
    }
    case 'voffset': {
      const vo = parseEm(value);
      return vo == null ? null : { apply: () => voffsetStack.push(vo), inject: null };
    }
    case 'width': {
      const w = parsePercentOrFloat(value, widthStack[widthStack.length - 1]);
      return w == null ? null : { apply: () => widthStack.push(w), inject: null };
    }
    case 'cspace': {
      const v = parseEm(value);
      return v == null ? null : { apply: () => cspaceStack.push(v), inject: null };
    }
    case 'mspace': {
      const v = parseEm(value);
      return v == null ? null : { apply: () => mspaceStack.push(v), inject: null };
    }
    case 'space': {
      const v = parseEm(value);
      if (v == null) return null;
      // Single-shot inject — a 1-char span with mspaceEm overriding
      // its advance. Use NBSP so layout won't pick it as a break.
      const injStyle = {
        color: colorStack[colorStack.length - 1].slice(),
        sizeScale: sizeStack[sizeStack.length - 1],
        voffsetEm: voffsetStack[voffsetStack.length - 1],
        widthScale: widthStack[widthStack.length - 1],
        cspaceEm: 0,
        mspaceEm: v,
        underline: false,
        strikethrough: false,
        mark: false,
        markColor: markColorStack[markColorStack.length - 1].slice(),
        nobr: nobrStack[nobrStack.length - 1],
      };
      return {
        apply: () => {},
        inject: { text: ' ', style: injStyle }, // NBSP (no soft-wrap)
      };
    }
    case 'u': {
      // CSS-shorthand-style value: space-separated tokens in any
      // order. Recognized: a color, a style keyword (solid / dashed /
      // dotted / double / wavy), a thickness with 'em'/'px' suffix
      // (em assumed if no suffix). Unrecognized tokens are ignored.
      const a = parseDecorationShorthand(value, ulColorStack, ulStyleStack, ulThickStack);
      return {
        apply: () => {
          ulStack.push(true);
          ulColorStack.push(a.color);
          ulStyleStack.push(a.style);
          ulThickStack.push(a.thick);
        },
        inject: null,
      };
    }
    case 's': {
      const a = parseDecorationShorthand(value, sColorStack, sStyleStack, sThickStack);
      return {
        apply: () => {
          sStack.push(true);
          sColorStack.push(a.color);
          sStyleStack.push(a.style);
          sThickStack.push(a.thick);
        },
        inject: null,
      };
    }
    case 'b':
    case 'strong':
      return { apply: () => boldStack.push(true), inject: null };
    case 'i':
    case 'em':
      return { apply: () => italicStack.push(true), inject: null };
    case 'mark': {
      const mc = (value && parseColor(value)) || markColorStack[markColorStack.length - 1].slice();
      return {
        apply: () => {
          markStack.push(true);
          markColorStack.push(mc);
        },
        inject: null,
      };
    }
    case 'nobr':
      return { apply: () => nobrStack.push(true), inject: null };
    case 'lowercase':
      return { apply: () => caseStack.push(CASE_LOWER), inject: null };
    case 'uppercase':
    case 'allcaps':
      return { apply: () => caseStack.push(CASE_UPPER), inject: null };
    case 'align': {
      const al = parseAlign(value);
      if (al == null) return null;
      return {
        apply: () => alignStack.push(al),
        inject: {
          text: '',
          style: defaultStyle(),
          directive: { hasAlign: true, align: al, hasIndent: false, indentEm: 0 },
        },
      };
    }
    case 'indent': {
      const v = parseEm(value);
      if (v == null) return null;
      return {
        apply: () => indentStack.push(v),
        inject: {
          text: '',
          style: defaultStyle(),
          directive: { hasAlign: false, hasIndent: true, indentEm: v },
        },
      };
    }

    case 'sub':
      // size 80%, voffset -0.14em. Both popped on </sub>.
      return {
        apply: () => {
          sizeStack.push(sizeStack[sizeStack.length - 1] * 0.8);
          voffsetStack.push(-0.14);
        },
        inject: null,
      };
    case 'sup':
      // size 80%, voffset +0.4em.
      return {
        apply: () => {
          sizeStack.push(sizeStack[sizeStack.length - 1] * 0.8);
          voffsetStack.push(0.4);
        },
        inject: null,
      };
    case 'rotate': {
      const d = parseDeg(value);
      if (d == null) return null;
      return { apply: () => rotateStack.push(d), inject: null };
    }
    case 'pos': {
      const v = parseEm(value);
      if (v == null) return null;
      // Single-shot: no stack mutation, just inject the directive.
      return {
        apply: () => {},
        inject: { text: '', style: defaultStyle(), directive: { hasPos: true, posEm: v } },
      };
    }
    case 'line-height':
    case 'lineheight': {
      const v = parseEm(value);
      if (v == null) return null;
      return {
        apply: () => lineHeightStack.push(v),
        inject: {
          text: '',
          style: defaultStyle(),
          directive: { hasLineHeight: true, lineHeightEm: v },
        },
      };
    }

    case 'scale': {
      const v = parsePercentOrFloat(value, glyphScaleStack[glyphScaleStack.length - 1]);
      if (v == null) return null;
      return { apply: () => glyphScaleStack.push(v), inject: null };
    }
    case 'line-indent':
    case 'lineindent': {
      const v = parseEm(value);
      if (v == null) return null;
      // Single-shot directive — no stack push, no </line-indent>.
      return {
        apply: () => {},
        inject: {
          text: '',
          style: defaultStyle(),
          directive: { hasLineIndent: true, lineIndentEm: v },
        },
      };
    }
    case 'margin': {
      const v = parseEm(value);
      if (v == null) return null;
      return {
        apply: () => {
          marginLeftStack.push(v);
          marginRightStack.push(v);
        },
        inject: {
          text: '',
          style: defaultStyle(),
          directive: {
            hasMarginLeft: true,
            marginLeftEm: v,
            hasMarginRight: true,
            marginRightEm: v,
          },
        },
      };
    }
    case 'margin-left':
    case 'marginleft': {
      const v = parseEm(value);
      if (v == null) return null;
      return {
        apply: () => marginLeftStack.push(v),
        inject: {
          text: '',
          style: defaultStyle(),
          directive: { hasMarginLeft: true, marginLeftEm: v },
        },
      };
    }
    case 'margin-right':
    case 'marginright': {
      const v = parseEm(value);
      if (v == null) return null;
      return {
        apply: () => marginRightStack.push(v),
        inject: {
          text: '',
          style: defaultStyle(),
          directive: { hasMarginRight: true, marginRightEm: v },
        },
      };
    }
    case 'smallcaps':
      return { apply: () => smallCapsStack.push(true), inject: null };

    case 'link': {
      // <link=id> or <link="id"> — pushes an id onto the link stack;
      // every span emitted while the stack is non-default carries it
      // via Style.linkId so downstream hit-test code can map a hit
      // position back to a link payload. The id is opaque to the
      // parser; callers decide what it means (URL, internal route, etc).
      if (!value) return null;
      let id = value;
      if ((id[0] === '"' || id[0] === "'") && id[id.length - 1] === id[0]) id = id.slice(1, -1);
      if (!id) return null;
      return { apply: () => linkIdStack.push(id), inject: null };
    }

    default:
      return null;
  }
}

function parseColor(s) {
  if (!s) return null;
  if ((s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) s = s.slice(1, -1);
  if (!s) return null;
  if (s[0] === '#') return parseHexColor(s.slice(1));
  const named = NAMED_COLORS[s.toLowerCase()];
  return named ? named.slice() : null;
}

function parseHexColor(hex) {
  if (!hex) return null;
  let r,
    g,
    b,
    a = 255;
  const nib = (c) => {
    if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
    if (c >= 'a' && c <= 'f') return c.charCodeAt(0) - 97 + 10;
    if (c >= 'A' && c <= 'F') return c.charCodeAt(0) - 65 + 10;
    return -1;
  };
  const byteAt = (i) => {
    const h = nib(hex[i]);
    const l = nib(hex[i + 1]);
    return h < 0 || l < 0 ? -1 : (h << 4) | l;
  };
  if (hex.length === 3 || hex.length === 4) {
    const rn = nib(hex[0]),
      gn = nib(hex[1]),
      bn = nib(hex[2]);
    if (rn < 0 || gn < 0 || bn < 0) return null;
    r = (rn << 4) | rn;
    g = (gn << 4) | gn;
    b = (bn << 4) | bn;
    if (hex.length === 4) {
      const an = nib(hex[3]);
      if (an < 0) return null;
      a = (an << 4) | an;
    }
  } else if (hex.length === 6 || hex.length === 8) {
    r = byteAt(0);
    g = byteAt(2);
    b = byteAt(4);
    if (r < 0 || g < 0 || b < 0) return null;
    if (hex.length === 8) {
      a = byteAt(6);
      if (a < 0) return null;
    }
  } else return null;
  const k = 1 / 255;
  return [r * k, g * k, b * k, a * k];
}

function parseSize(s, currentScale) {
  if (!s) return null;
  const percent = s.endsWith('%');
  const num = parseFloat(percent ? s.slice(0, -1) : s);
  if (!Number.isFinite(num)) return null;
  const out = percent ? currentScale * (num / 100) : num;
  return out > 0 ? out : null;
}

function parsePercentOrFloat(s, currentScale) {
  if (!s) return null;
  const percent = s.endsWith('%');
  const num = parseFloat(percent ? s.slice(0, -1) : s);
  if (!Number.isFinite(num)) return null;
  const out = percent ? currentScale * (num / 100) : num;
  return out > 0 ? out : null;
}

function parseEm(s) {
  if (!s) return null;
  if (/em$/i.test(s)) s = s.slice(0, -2);
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

function parseAlign(s) {
  if (!s) return null;
  switch (s.trim().toLowerCase()) {
    case 'left':
      return 'left';
    case 'center':
      return 'center';
    case 'right':
      return 'right';
    case 'justify':
      return 'justify';
    default:
      return null;
  }
}

function parseDeg(s) {
  if (!s) return null;
  if (/deg$/i.test(s)) s = s.slice(0, -3);
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

const _DECORATION_STYLES = new Set(['solid', 'dashed', 'dotted', 'double', 'wavy']);

/// Parse a CSS-shorthand-style decoration value: space-separated
/// tokens in any order. Tokens classify as:
///   - style keyword: solid / dashed / dotted / double / wavy
///   - thickness: number followed by 'em' or 'px' (em assumed if no
///     suffix); 'px' converted to em via 1px ≈ 0.0625em (16-px em)
///   - color: anything else parsed via parseColor (#hex, name, etc.)
/// Unrecognized tokens are silently dropped. Returns { color, style,
/// thick } with current stack tops as fallbacks (so attribute-less
/// `<u>` preserves whatever the outer scope set).
function parseDecorationShorthand(value, colorStack, styleStack, thickStack) {
  const top = (a) => a[a.length - 1];
  let color = top(colorStack); // null = inherit text color
  let style = top(styleStack);
  let thick = top(thickStack);
  if (!value) return { color, style, thick };
  // Strip surrounding quotes (the grammar passes them through).
  let v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  const toks = v.split(/\s+/);
  for (const tok of toks) {
    const lo = tok.toLowerCase();
    if (_DECORATION_STYLES.has(lo)) {
      style = lo;
      continue;
    }
    // Thickness with unit.
    if (/^[+-]?\d*\.?\d+(em|px)?$/i.test(tok)) {
      const isPx = /px$/i.test(tok);
      const raw = parseFloat(tok);
      if (Number.isFinite(raw)) {
        thick = isPx ? raw * 0.0625 : raw; // 1px ≈ 0.0625em (16px em)
        continue;
      }
    }
    // Otherwise: try as color.
    const col = parseColor(tok);
    if (col) {
      color = col;
      continue;
    }
  }
  return { color, style, thick };
}
