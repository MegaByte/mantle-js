// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/importText.js — <text> / <textPath> / <textArea> import.

import { mantleWarn } from '../core/diagnostics.js';
import { parseLengthOr } from './length.js';
import {
  SEG_LINE,
  SEG_QUAD,
  SEG_CUBIC,
  CAP_BUTT,
  JOIN_MITER,
  mkLine,
  mkQuad,
  mkCubic,
  segsToPathD,
} from './segment.js';
import { IDENT, transformSegInto, parseTransform } from './transform.js';
import { parseShape } from './shape.js';
import {
  getStyleProp,
  getInheritedStyleProp,
  getShapeStyles,
  getStrokeDashes,
  getCapsJoins,
  resolveFontSize,
  INITIAL_FONT_SIZE,
  isDisplayed,
  isEffectivelyVisible,
} from './style.js';
import { makeFamilyResolver } from './textFamily.js';
import {
  processWhitespace,
  parseLengthList,
  parseRotateList,
  baselineHeightEm,
  parseBaselineShift,
} from './textPosition.js';
import { svgElementName, resolveIdRef, parsePaintUrl, switchChildMatches } from './utils.js';
import { buildPathArcLengthLut, samplePathAt } from './textures.js';
import { strokeFrameOf, ctmSingular } from '../bundle/strokeFrame.js';

const inhOf = (st) => ({
  fill: st.fillPaintRgba,
  stroke: st.strokePaintRgba,
  fo: st.fillOpacity,
  so: st.strokeOpacity,
});
const NO_LAYOUT = Object.freeze({ glyphs: Object.freeze([]), advance: 0 });

/// Whether a hidden <text> holds text that an element under it has set visible again. visibility inherits, so only a descendant's own value can.
export function textHasVisibleContent(node) {
  const kids = node.childNodes;
  for (let i = 0; i < (kids ? kids.length : 0); i++) {
    const k = kids[i];
    if (!k || k.nodeType !== 1 || !isDisplayed(k)) continue;
    const t = svgElementName(k);
    if (t !== 'tspan' && t !== 'a' && t !== 'textpath') continue;
    if (isEffectivelyVisible(k) && hasTextNode(k)) return true;
    if (textHasVisibleContent(k)) return true;
  }
  return false;
}
function hasTextNode(el) {
  const kids = el.childNodes;
  for (let i = 0; i < (kids ? kids.length : 0); i++)
    if (kids[i] && kids[i].nodeType === 3 && (kids[i].nodeValue || '').trim()) return true;
  return false;
}

const inhPaintStr = (c, fallback) =>
  c ? `rgba(${c[0] * 255},${c[1] * 255},${c[2] * 255},${c[3]})` : fallback;

export function handleTextPaintTag(walkCtx, node, tag, ctm, pf, ps, pw, f, s, strokeW, fo, so) {
  if (tag === 'textarea') {
    const layoutFn = walkCtx.opts.svgTextLayout;
    if (typeof layoutFn !== 'function') {
      mantleWarn('svgImporter: <textArea> requires opts.svgTextLayout — skipping');
      return true;
    }
    const taX = parseLengthOr(node.getAttribute('x') || '0', 0);
    const taY = parseLengthOr(node.getAttribute('y') || '0', 0);
    const taW = parseLengthOr(node.getAttribute('width') || '0', 0);
    // The cascade, own value first (style= and CSS beat the attribute), then the inheritance parents.
    const taFontSize = parseLengthOr(getInheritedStyleProp(node, 'font-size', null) || '16', 16);
    const taFontFamily = (getInheritedStyleProp(node, 'font-family', null) || '')
      .trim()
      .replace(/^["']|["']$/g, '');
    // Collect all text content (textArea allows direct text + <tspan>
    // children; flatten everything into one string).
    let combined = '';
    function collectText(el) {
      if (!el || !el.childNodes) return;
      for (let i = 0; i < el.childNodes.length; i++) {
        const c = el.childNodes[i];
        if (c.nodeType === 3) combined += c.nodeValue || '';
        else if (c.nodeType === 1) collectText(c);
      }
    }
    collectText(node);
    if (taW <= 0 || !combined) return true;
    const maxWidthEm = taW / taFontSize;
    let layoutResult;
    if (walkCtx.opts.fonts == null) {
      // Preserve family-resolving callbacks used without an importer font map.
      layoutResult = layoutFn(taFontFamily, combined, taX, taY, taFontSize, maxWidthEm);
    } else {
      const font = walkCtx.opts.fonts[taFontFamily];
      if (!font) {
        mantleWarn(
          `svgImporter: <textArea> with font-family='${taFontFamily}' but no matching font in opts.fonts — skipping`,
        );
        return true;
      }
      const textStyle = {
        fontWeight: getInheritedStyleProp(node, 'font-weight', null),
        fontStyle: getInheritedStyleProp(node, 'font-style', null),
        textDecoration: getInheritedStyleProp(node, 'text-decoration', null),
        writingMode: getInheritedStyleProp(node, 'writing-mode', null),
        direction: getInheritedStyleProp(node, 'direction', null),
        letterSpacing: getInheritedStyleProp(node, 'letter-spacing', null),
        wordSpacing: getInheritedStyleProp(node, 'word-spacing', null),
        fontVariant: getInheritedStyleProp(node, 'font-variant', null),
        fontFeatureSettings: getInheritedStyleProp(node, 'font-feature-settings', null),
      };
      layoutResult = layoutFn(
        combined,
        font,
        taX,
        taY,
        taFontSize,
        undefined,
        maxWidthEm,
        textStyle,
      );
    }
    if (!layoutResult || !layoutResult.glyphs) return true;
    // Mask / clip-path inheritance on <textArea>, resolved once before
    // the per-glyph loop.
    // Stack alone: walk() already folded this node's own clip-path into
    // the inherited one (intersection, SVG 1.1 §14.3).
    const _taRawClipStr = walkCtx.currentClipRef();
    const _taRawMaskStr = walkCtx.currentMaskRef(); // own mask included, placed in the element's user space
    const _taRawFilterStr =
      walkCtx.normFilter(getStyleProp(node, 'filter', '') || node.getAttribute('filter'), node) ||
      walkCtx.currentFilterRef();
    const _taClipRef = resolveIdRef(_taRawClipStr);
    const _taMaskRef = resolveIdRef(_taRawMaskStr);
    const _taFilterRef = walkCtx.resolveFilterRef(_taRawFilterStr, node);
    const _taReferencingShapeIdx = walkCtx.ctx.shapesData.length;
    const _taClipId = _taClipRef ? walkCtx.claimClip(_taClipRef, _taReferencingShapeIdx) : 0;
    const _taMaskId = _taMaskRef ? walkCtx.claimMask(_taMaskRef, _taReferencingShapeIdx) : 0;
    const _taFilterId = _taFilterRef
      ? walkCtx.claimFilter(_taFilterRef, undefined, { ctm, shapeIdx: _taReferencingShapeIdx })
      : 0;
    // Re-use the per-glyph emit path used by <text>: each glyph
    // becomes its own Mantle shape so band walks stay tight.
    const f = getStyleProp(node, 'fill', pf);
    const expanded = walkCtx.opts.retainSource ? [] : null;
    let glyphIndex = 0;
    for (const g of layoutResult.glyphs) {
      if (!g.segs || !g.segs.length) continue;
      const transformedSegs =
        ctm === IDENT
          ? g.segs
          : (() => {
              const xf = [];
              for (const sg of g.segs) transformSegInto(sg, ctm, xf);
              return xf;
            })();
      const styles = getShapeStyles(
        node,
        f,
        'none',
        0,
        fo,
        so,
        walkCtx.viewport,
        walkCtx.inClipContent > 0,
      );
      if (expanded)
        expanded.push({
          pathD: segsToPathD(g.segs, true),
          fill: styles.fillRgba,
          stroke: g.synthBoldSwEm > 0 ? styles.fillRgba : null,
          sw: g.synthBoldSwEm > 0 ? g.synthBoldSwEm * taFontSize : 0,
        });
      walkCtx.enqueueShape({
        segs: transformedSegs,
        fillRgba: styles.fillRgba,
        fillColorClear: styles.fillColorClear,
        fillNone: styles.fillNone,
        strokeNone: true,
        strokeRgba: g.synthBoldSwEm > 0 ? styles.fillRgba : [0, 0, 0, 0],
        sw: g.synthBoldSwEm > 0 ? g.synthBoldSwEm * taFontSize : 0,
        fillRule: 'nonzero',
        capStyle: CAP_BUTT,
        joinStyle: JOIN_MITER,
        miterLimit: 4,
        fillGradId: 0,
        strokeGradId: 0,
        flagsShape: 0,
        dashArray: [],
        dashOffset: 0,
        clipId: _taClipId,
        maskId: _taMaskId,
        filterId: _taFilterId,
        blendMode: 0,
        isolation: 0,
        imageId: 0,
        imageRect: [0, 0, 0, 0],
        _domLeafGlyphK: glyphIndex++,
      });
    }
    if (expanded?.length) {
      (walkCtx.ctx._textExpansions || (walkCtx.ctx._textExpansions = [])).push({
        node,
        paths: expanded,
      });
    }
    if (_taFilterId) walkCtx.setFilterBoxRows(_taFilterId, _taReferencingShapeIdx);
    walkCtx.setClaimBoxRows(_taClipId, _taMaskId, _taReferencingShapeIdx);
    return true;
  }
  if (tag === 'text') {
    const layoutFn = walkCtx.opts.svgTextLayout;
    if (typeof layoutFn !== 'function') {
      mantleWarn(
        `svgImporter: <text> requires opts.svgTextLayout (the buildSvgTextGlyphs entrypoint from font/textRun.js) — skipping`,
      );
      return true;
    }
    // Resolve `mask` / `clip-path` on the <text> element with ancestor
    // inheritance. Stamp the claimed 1-based ids on every emitted glyph
    // so the bake pipeline can clip text the same way it clips paths.
    // mix-blend-mode and isolation compose the element as one group: the glyphs are its content. (Its opacity stays on the rows.)
    const _textComp = walkCtx.groupCompositingOf(node);
    const _textGroup =
      !walkCtx.walkLayerMode &&
      !(walkCtx.inClipContent > 0) &&
      (_textComp.blendMode !== 0 || _textComp.isolation === 1);
    if (_textGroup)
      walkCtx.enqueueShape({
        kind: 'groupBegin',
        groupOpacity: 1,
        filterId: 0,
        clipId: 0,
        maskId: 0,
        blendMode: _textComp.blendMode,
        isolation: _textComp.isolation,
        _domLeaf: -1,
      });
    // Stack alone — see the <textArea> note above.
    const _textRawClipStr = walkCtx.currentClipRef();
    const _textRawMaskStr = walkCtx.currentMaskRef(); // own mask included, placed in the element's user space
    const _textRawFilterStr =
      walkCtx.normFilter(getStyleProp(node, 'filter', '') || node.getAttribute('filter'), node) ||
      walkCtx.currentFilterRef();
    const _textClipRef = resolveIdRef(_textRawClipStr);
    const _textMaskRef = resolveIdRef(_textRawMaskStr);
    const _textFilterRef = walkCtx.resolveFilterRef(_textRawFilterStr, node);
    // Per-glyph clip/mask ids; the importer-level claim returns a
    // 1-based index into walkCtx.ctx.clipsUsed/walkCtx.ctx.masksUsed (rewritten to a
    // meta-row index post-walk). An objectBoundingBox clip or mask binds to the box of every row the element emits
    // (setClaimBoxRows, once the rows exist).
    const _textReferencingShapeIdx = walkCtx.ctx.shapesData.length;
    const _textClipId = _textClipRef
      ? walkCtx.claimClip(_textClipRef, _textReferencingShapeIdx)
      : 0;
    const _textMaskId = _textMaskRef
      ? walkCtx.claimMask(_textMaskRef, _textReferencingShapeIdx)
      : 0;
    const _textFilterId = _textFilterRef
      ? walkCtx.claimFilter(_textFilterRef, undefined, { ctm, shapeIdx: _textReferencingShapeIdx })
      : 0;
    const fontMap = walkCtx.opts.fonts || null;
    const resolveFamily = makeFamilyResolver(fontMap);
    // The <text>'s computed font-size is the walker's (it resolved %, em, keywords and the font shorthand against the
    // parent on the way in); a <tspan> resolves its own against its parent's with resolveFontSize.
    const vp = walkCtx.viewport;
    const rootFontSize = vp && vp.fontSize !== undefined ? vp.fontSize : INITIAL_FONT_SIZE;
    const remSize = walkCtx.rootFontSize || INITIAL_FONT_SIZE;
    const lengthCtx = (axis, fs) => ({ ...(vp || {}), fontSize: fs, rootFontSize: remSize, axis });
    // font-family inherits through <g> ancestors per SVG 1.1 §10.10; the whole list is kept and matched against the
    // `fonts` map by makeFamilyResolver (case, quotes, fallbacks).
    const rootFontFamily = (getInheritedStyleProp(node, 'font-family', null) || '').trim();
    // Inherited text-style props (CSS Fonts / Text). All flow through the walk below; the layout adapter receives
    // them as a trailing opts dict and decides what to do with them (variant font swap, small caps and features,
    // vertical writing-mode, base direction, advance scaling). letter-spacing and word-spacing also travel as
    // computed lengths (user units): CSS inherits the computed length, so an em value keeps the size it was written at.
    const spacingPx = (raw, fs) => {
      if (raw == null) return null;
      const t = String(raw).trim().toLowerCase();
      if (t === 'normal') return 0;
      const v = parseLengthOr(t, NaN, lengthCtx('x', fs));
      return Number.isFinite(v) ? v : null;
    };
    const _rtfLetterSp = getInheritedStyleProp(node, 'letter-spacing', null);
    const _rtfWordSp = getInheritedStyleProp(node, 'word-spacing', null);
    const rootTextStyle = {
      fontWeight: getInheritedStyleProp(node, 'font-weight', null),
      fontStyle: getInheritedStyleProp(node, 'font-style', null),
      textDecoration: getInheritedStyleProp(node, 'text-decoration', null),
      writingMode: getInheritedStyleProp(node, 'writing-mode', null),
      direction: getInheritedStyleProp(node, 'direction', null),
      letterSpacing: _rtfLetterSp,
      wordSpacing: _rtfWordSp,
      letterSpacingPx: spacingPx(_rtfLetterSp, rootFontSize) ?? 0,
      wordSpacingPx: spacingPx(_rtfWordSp, rootFontSize) ?? 0,
      fontVariant: getInheritedStyleProp(node, 'font-variant', null),
      fontFeatureSettings: getInheritedStyleProp(node, 'font-feature-settings', null),
    };

    // text-anchor controls run alignment around an anchor point.
    // SVG 2 chunk model:
    //   - A "chunk" is a run of characters laid out from one absolute position: the first character, and every
    //     character an x or y value (a list entry or a <tspan> attribute) places absolutely.
    //   - A chunk's anchor is the text-anchor of its first character's element.
    // After layout, each chunk gets a constant shift along the inline axis by its width and anchor.
    // text-anchor INHERITS (SVG 2 §11.10.1): a <tspan> takes its parent's, the <text> takes a <g>'s or
    // a <use>'s, so <g text-anchor="middle"> applies to the text inside it.
    const resolveAnchor = (el, fallback) => {
      const raw = (getInheritedStyleProp(el, 'text-anchor', null) || '').trim().toLowerCase();
      if (raw === 'start' || raw === 'middle' || raw === 'end') return raw;
      return fallback || 'start';
    };
    // white-space mode: true = xml:space="preserve"; false = no xml:space in effect, or an explicit xml:space="default": CSS's
    // white-space: normal (a newline is a space), as every browser does. SVG 2 §11.10.3.2 would REMOVE the newlines of an explicit
    // "default", but it calls that processing legacy and deprecated and no browser implements it, so the importer acts as browsers
    // do, in both compat modes.
    const legacyDefault = false;
    // CSS `white-space` (CSS Text 3/4; SVG 2 §11.10 makes it the preferred mechanism): whether the white space of an element's text is
    // PRESERVED (pre, pre-wrap, break-spaces; white-space-collapse: preserve, preserve-spaces, break-spaces) or COLLAPSED (normal,
    // nowrap, pre-line; collapse, preserve-breaks). The property inherits, an element's own value beats its xml:space (the UA rule
    // `[xml|space=preserve] { white-space: pre }` is below author CSS), and xml:space="default" is `normal`. Browsers draw a
    // preserved NEWLINE as ONE space in SVG text (no forced line break) and `pre-line` collapses it like `normal`; the importer
    // acts as browsers do, in both compat modes. A preserved TAB under the CSS property advances to the next tab stop
    // (CSS Text 3 `tab-size`, 8 spaces by default; mode 'css'); Chrome draws it as one space, which `compat: 'chrome'` reproduces, and
    // xml:space="preserve" converts it to a space in every browser and in SVG 1.1 / 2 (mode true).
    const wsMode = (raw) => {
      const t = String(raw ?? '')
        .trim()
        .toLowerCase();
      if (!t) return null;
      if (
        t === 'pre' ||
        t === 'pre-wrap' ||
        t === 'break-spaces' ||
        t === 'preserve' ||
        t === 'preserve-spaces'
      )
        return walkCtx.compat === 'chrome' ? true : 'css';
      if (
        t === 'normal' ||
        t === 'nowrap' ||
        t === 'pre-line' ||
        t === 'collapse' ||
        t === 'preserve-breaks'
      )
        return false;
      return null; // invalid, or inherit / initial / unset: the cascade decides
    };
    const cssSpaceOf = (el) =>
      wsMode(getStyleProp(el, 'white-space-collapse', null)) ??
      wsMode(getStyleProp(el, 'white-space', null));
    const xmlSpaceOf = (el, parentPreserve) => {
      const css = cssSpaceOf(el);
      if (css !== null) return css;
      const v = (
        el.getAttribute('xml:space') ||
        el.getAttributeNS?.('http://www.w3.org/XML/1998/namespace', 'space') ||
        ''
      ).trim();
      return v === 'preserve' ? true : v === 'default' ? legacyDefault : parentPreserve;
    };
    // Both inherit: from a <g> around the text, or a <use>. The element's own value first, then the nearest ancestor's white-space,
    // then xml:space.
    const rootSpace = (
      getInheritedStyleProp(node, 'xml:space', null) ||
      node.getAttributeNS?.('http://www.w3.org/XML/1998/namespace', 'space') ||
      ''
    ).trim();
    const rootPreserve =
      cssSpaceOf(node) ??
      (node.getAttribute('xml:space')
        ? rootSpace === 'preserve'
          ? true
          : legacyDefault
        : (wsMode(getInheritedStyleProp(node, 'white-space-collapse', null)) ??
          wsMode(getInheritedStyleProp(node, 'white-space', null)) ??
          (rootSpace === 'preserve' ? true : rootSpace === 'default' ? legacyDefault : false)));

    // A paint that resolves to nothing this importer paints a glyph with: context-fill / context-stroke take the context element's paint, and a
    // url() that names no paint server takes its fallback, else none (SVG 2 13.2). A url() naming a gradient or a pattern stays as it was.
    const glyphPaint = (fillValue, strokeValue) => {
      const paint = {};
      const resolve = (value, which) => {
        const t = typeof value === 'string' ? value.trim() : '';
        if (/^context-(?:fill|stroke)$/i.test(t)) {
          paint[which] =
            (/fill$/i.test(t) ? walkCtx.contextPaint?.fill : walkCtx.contextPaint?.stroke) ??
            'none';
          return;
        }
        const url = parsePaintUrl(t);
        if (
          url &&
          !(url.ref && (walkCtx.gradientDefinition(url.ref) || walkCtx._patternElById[url.ref]))
        )
          paint[which] = url.fallback || 'none';
      };
      resolve(fillValue, 'fill');
      resolve(strokeValue, 'stroke');
      return paint;
    };
    const rootStyles = getShapeStyles(
      node,
      f,
      s,
      strokeW,
      fo,
      so,
      walkCtx.viewport,
      walkCtx.inClipContent > 0,
      glyphPaint(f, s),
    );
    const _mixedVisibility = !isEffectivelyVisible(node) && textHasVisibleContent(node);
    const unsetBaseline = (v) => {
      const t = String(v ?? '')
        .trim()
        .toLowerCase();
      return !t || t === 'auto' || t === 'inherit' ? null : t;
    };
    // The style context of the text content inside one element: what the element's own properties and its parent's
    // give the characters it contains.
    const rootCtx = {
      fillRgba: rootStyles.fillRgba,
      fillColorClear: rootStyles.fillColorClear,
      strokeRgba: rootStyles.strokeRgba,
      sw: rootStyles.sw,
      ff: rootFontFamily,
      fs: rootFontSize,
      ts: rootTextStyle,
      inh: inhOf(rootStyles),
      anchor: resolveAnchor(node, 'start'),
      preserve: rootPreserve,
      bshifts: (getStyleProp(node, 'baseline-shift', null) || '').trim()
        ? [{ raw: getStyleProp(node, 'baseline-shift', null), fs: rootFontSize }]
        : [],
      dom: unsetBaseline(getInheritedStyleProp(node, 'dominant-baseline', null)),
      align: unsetBaseline(getStyleProp(node, 'alignment-baseline', null)),
      group: null,
      hidden: _mixedVisibility, // its own glyphs are the hidden ones; wholly hidden text walked by the hit-only pass or keepHidden keeps every glyph
    };
    const childCtx = (el, c) => {
      // Its own cascaded value (style= and CSS too, not just the attribute), else the parent's.
      const own = (name) => getStyleProp(el, name, null);
      let ff = (own('font-family') || '').trim();
      if (!ff) ff = c.ff;
      const fs = resolveFontSize(el, c.fs, remSize);
      const parentFillStr = inhPaintStr(c.inh.fill, f);
      const parentStrokeStr = inhPaintStr(c.inh.stroke, s);
      const styles = getShapeStyles(
        el,
        parentFillStr,
        parentStrokeStr,
        c.sw,
        c.inh.fo,
        c.inh.so,
        walkCtx.viewport,
        walkCtx.inClipContent > 0,
        glyphPaint(getStyleProp(el, 'fill', null), getStyleProp(el, 'stroke', null)),
      );
      const lsRaw = own('letter-spacing'),
        wsRaw = own('word-spacing');
      const ts = {
        fontWeight: own('font-weight') || c.ts.fontWeight,
        fontStyle: own('font-style') || c.ts.fontStyle,
        textDecoration: own('text-decoration') || c.ts.textDecoration,
        writingMode: own('writing-mode') || c.ts.writingMode,
        direction: own('direction') || c.ts.direction,
        letterSpacing: lsRaw || c.ts.letterSpacing,
        wordSpacing: wsRaw || c.ts.wordSpacing,
        letterSpacingPx: spacingPx(lsRaw, fs) ?? c.ts.letterSpacingPx,
        wordSpacingPx: spacingPx(wsRaw, fs) ?? c.ts.wordSpacingPx,
        fontVariant: own('font-variant') || c.ts.fontVariant,
        fontFeatureSettings: own('font-feature-settings') || c.ts.fontFeatureSettings,
      };
      const bs = own('baseline-shift');
      const ab = unsetBaseline(own('alignment-baseline'));
      const db = unsetBaseline(own('dominant-baseline'));
      return {
        fillRgba: styles.fillRgba,
        fillColorClear: styles.fillColorClear,
        fillNone: styles.fillNone,
        strokeRgba: styles.strokeRgba,
        strokeNone: styles.strokeNone,
        sw: styles.sw,
        ff,
        fs,
        ts,
        inh: inhOf(styles),
        anchor: resolveAnchor(el, c.anchor),
        preserve: xmlSpaceOf(el, c.preserve),
        // baseline-shift does not inherit, but a descendant is shifted with the element it sits in.
        bshifts: bs != null && bs.trim() ? [...c.bshifts, { raw: bs, fs }] : c.bshifts,
        dom: db ?? c.dom,
        align: ab ?? c.align,
        group: c.group,
        // the <a> this text sits in, and whether its glyphs paint: a hidden element's glyphs still take their place in the line
        href: c.href,
        hidden: !isEffectivelyVisible(el),
      };
    };

    // ---- Collect: the text nodes in document order, white space processed across them (SVG 1.1 §10.15) ----------
    // An item is one text node with the style context it sits in; `start` is the index of its first character in the
    // whole <text> (code points of the processed text), the index the x / y / dx / dy / rotate lists address.
    const ws = { prevSpace: true };
    const items = [],
      elems = [],
      groups = [];
    let nChars = 0;
    const cpCount = (t) => {
      let n = 0;
      for (const _ of t) n++;
      return n;
    };
    const textPathChild = (k) => svgElementName(k) === 'textpath';
    const collect = (parentEl, c) => {
      const ck = parentEl.childNodes;
      for (let i = 0; i < (ck ? ck.length : 0); i++) {
        const k = ck[i];
        if (!k) continue;
        if (k.nodeType === 3 /* text */) {
          const text = processWhitespace(k.nodeValue || '', c.preserve, ws);
          if (!text) continue;
          const item = {
            text,
            start: nChars,
            n: cpCount(text),
            c,
            el: parentEl,
            cps: null,
            opts: null,
          };
          items.push(item);
          if (c.group) c.group.items.push(item);
          nChars += item.n;
        } else if (
          k.nodeType === 1 &&
          (!isDisplayed(k) ||
            ((k.hasAttribute?.('systemLanguage') || k.hasAttribute?.('requiredExtensions')) &&
              !switchChildMatches(k, walkCtx.switchLanguages, false)))
        ) {
          continue; // not rendered: display:none, a failed conditional test (SVG 2 5.8)
        } else if (k.nodeType === 1 /* element */ && textPathChild(k)) {
          const cc = childCtx(k, c);
          const grp = { el: k, c: cc, items: [], runs: [], glyphs: [], done: false };
          cc.group = grp;
          groups.push(grp);
          collect(k, cc);
        } else if (
          k.nodeType === 1 /* element */ &&
          (svgElementName(k) === 'tspan' || svgElementName(k) === 'a')
        ) {
          const cc = childCtx(k, c);
          // An <a> is text content too (SVG 2 11.2); as for one around a shape, links inside an SVG image are inert.
          if (svgElementName(k) === 'a' && !(walkCtx._imageDocDepth > 0))
            cc.href = k.getAttribute('href') || k.getAttribute('xlink:href') || c.href;
          const rec = { el: k, c: cc, start: nChars, end: nChars };
          elems.push(rec);
          collect(k, cc);
          rec.end = nChars;
        }
      }
    };
    const rootRec = { el: node, c: rootCtx, start: 0, end: 0 };
    elems.push(rootRec);
    collect(node, rootCtx);
    // A trailing collapsible space is stripped (the leading one never entered: prevSpace starts true).
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (!it.n) continue;
      if (!it.c.preserve && it.text.endsWith(' ')) {
        it.text = it.text.slice(0, -1);
        it.n--;
        nChars--;
      }
      break;
    }
    for (const r of elems) if (r.end > nChars) r.end = nChars;
    rootRec.end = nChars;

    // ---- Per-character position lists (SVG 2 §11.7.2) ---------------------------------------------------------
    // x / y place a character absolutely (and open a chunk), dx / dy shift it and everything after it, rotate turns
    // its glyph about its origin. A list indexes the characters of ITS element, ancestors first so a descendant's
    // entry overrides; rotate repeats its last value to the end of the element.
    const X = new Float64Array(nChars).fill(NaN),
      Y = new Float64Array(nChars).fill(NaN);
    const DX = new Float64Array(nChars),
      DY = new Float64Array(nChars),
      ROT = new Float64Array(nChars);
    let needCharIndex = false;
    for (const r of elems) {
      const el = r.el,
        fs = r.c.fs;
      const xs = parseLengthList(el.getAttribute('x'), lengthCtx('x', fs)),
        ys = parseLengthList(el.getAttribute('y'), lengthCtx('y', fs));
      const dxs = parseLengthList(el.getAttribute('dx'), lengthCtx('x', fs)),
        dys = parseLengthList(el.getAttribute('dy'), lengthCtx('y', fs));
      const rots = parseRotateList(el.getAttribute('rotate'));
      const span = r.end - r.start;
      if (xs) for (let j = 0; j < xs.length && j < span; j++) X[r.start + j] = xs[j];
      if (ys) for (let j = 0; j < ys.length && j < span; j++) Y[r.start + j] = ys[j];
      if (dxs) for (let j = 0; j < dxs.length && j < span; j++) DX[r.start + j] = dxs[j];
      if (dys) for (let j = 0; j < dys.length && j < span; j++) DY[r.start + j] = dys[j];
      if (rots)
        for (let j = 0; j < span; j++) ROT[r.start + j] = rots[Math.min(j, rots.length - 1)];
      const tl = parseLengthOr(el.getAttribute('textLength'), NaN, lengthCtx('x', fs));
      if (Number.isFinite(tl) && tl > 0 && span > 0) {
        r.tl = tl;
        r.glyphScale = (el.getAttribute('lengthAdjust') || '').trim() === 'spacingAndGlyphs';
        needCharIndex = true;
      }
    }
    const isMarkAt = (item, j) => {
      if (!item.cps) item.cps = Array.from(item.text);
      return /^[\p{M}‍︀-️]/u.test(item.cps[j - item.start]);
    };
    // A character that needs its own run: positioned absolutely or relatively, turned, or next to one that is.
    // A combining mark stays with its base.
    const splitBefore = (item, j) =>
      !isMarkAt(item, j) &&
      (!Number.isNaN(X[j]) ||
        !Number.isNaN(Y[j]) ||
        DX[j] !== 0 ||
        DY[j] !== 0 ||
        ROT[j] !== 0 ||
        ROT[j - 1] !== 0);

    // ---- Layout -------------------------------------------------------------------------------------------------
    const buffered = []; // glyphs in paint order
    const runs = []; // placed runs of the main flow
    const chunks = []; // text-anchor chunks of the main flow
    const decorationRuns = [];
    const pen = { x: 0, y: 0 }; // the current text position
    const warnedFamilies = new Set();
    const verticalMode = (ts) =>
      /^(?:vertical-(?:rl|lr)|tb(?:-rl|-lr)?)$/i.test(String(ts.writingMode ?? '').trim());
    const optsOf = (item) => {
      if (item.opts) return item.opts;
      const c = item.c;
      return (item.opts = {
        ...c.ts,
        letterSpacingEm: c.ts.letterSpacingPx / c.fs,
        wordSpacingEm: c.ts.wordSpacingPx / c.fs,
      });
    };
    const rotateSegs = (segs, cx, cy, deg) => {
      const th = (deg * Math.PI) / 180,
        co = Math.cos(th),
        si = Math.sin(th);
      const rp = (p) => [
        cx + (p[0] - cx) * co - (p[1] - cy) * si,
        cy + (p[0] - cx) * si + (p[1] - cy) * co,
      ];
      return segs.map((sg) => {
        if (sg.type === SEG_LINE) return mkLine(rp(sg.p1), rp(sg.p2));
        else if (sg.type === SEG_QUAD) return mkQuad(rp(sg.p1), rp(sg.p2), rp(sg.p3));
        else if (sg.type === SEG_CUBIC) return mkCubic(rp(sg.p1), rp(sg.p2), rp(sg.p3), rp(sg.p4));
        return sg;
      });
    };
    // Lay out characters [a, b) of `item` at the pen `p` (the main flow's, or a textPath's own flat one).
    const placeRun = (item, a, b, p, grp) => {
      const c = item.c;
      if (!grp) {
        // The position adjustments of the first character; an absolute x or y opens a chunk.
        const opened = chunks.length === 0 || !Number.isNaN(X[a]) || !Number.isNaN(Y[a]);
        if (opened)
          chunks.push({
            anchor: c.anchor,
            rtl: /^rtl$/i.test(String(c.ts.direction ?? '').trim()),
            runs: [],
            x0: 0,
          });
        if (!Number.isNaN(X[a])) p.x = X[a];
        if (!Number.isNaN(Y[a])) p.y = Y[a];
        if (opened) chunks[chunks.length - 1].x0 = p.x;
      }
      p.x += DX[a];
      p.y += DY[a];
      const fam = resolveFamily(c.ff);
      if (!fam) {
        if (!warnedFamilies.has(c.ff)) {
          warnedFamilies.add(c.ff);
          mantleWarn(
            `svgImporter: chunk with font-family='${c.ff}' but no matching font in opts.fonts — skipping`,
          );
        }
        return null;
      }
      if (!(c.fs > 0)) return null;
      if (!item.cps) item.cps = Array.from(item.text);
      const text =
        a === item.start && b === item.start + item.n
          ? item.text
          : item.cps.slice(a - item.start, b - item.start).join('');
      // baseline-shift raises the run, dominant-baseline / alignment-baseline put the named baseline at the pen's y.
      let up = 0;
      if (!verticalMode(c.ts)) {
        fam.font.getMetrics?.(0x20); // the font's metrics load lazily

        for (const bs of c.bshifts)
          up += parseBaselineShift(bs.raw, fam.font, bs.fs, lengthCtx('y', bs.fs)) ?? 0;
        const h = baselineHeightEm(c.align || c.dom, fam.font);
        if (h) up -= h * c.fs;
      }
      const oy = up ? p.y - up : p.y;
      let lopts = optsOf(item);
      if (c.preserve === 'css' && text.indexOf('\t') >= 0) {
        // tab-size: a number of spaces, or a length (px at the font size). Stops are counted from the chunk's start.
        const raw = (getInheritedStyleProp(item.el, 'tab-size', null) || '').trim();
        const tabOpts = {};
        if (raw) {
          if (/^[+]?(?:\d*\.?\d+)(?:e[+-]?\d+)?$/i.test(raw)) tabOpts.tabSize = parseFloat(raw);
          else {
            const v = parseLengthOr(raw, NaN, lengthCtx('x', c.fs));
            if (Number.isFinite(v) && v >= 0) tabOpts.tabSizeEm = v / c.fs;
          }
        }
        if (!grp && chunks.length)
          tabOpts.tabOriginEm = (p.x - chunks[chunks.length - 1].x0) / c.fs;
        lopts = { ...lopts, ...tabOpts };
      }
      // A layout with nothing to say for this text gives no glyphs and takes no place, as on <textArea>.
      const laid = layoutFn(text, fam.font, p.x, oy, c.fs, fam.fallbacks, 0, lopts);
      const out = laid && laid.glyphs ? laid : NO_LAYOUT;
      const vertical = !!(out && out.writingMode && out.writingMode !== 'horizontal-tb');
      const run = {
        item,
        a,
        b,
        vertical,
        x: p.x,
        y: oy,
        in0: vertical ? p.y : p.x,
        in1: 0,
        A: 1,
        B: 0,
        endExtra: 0,
        chunk: grp ? -1 : chunks.length - 1,
        glyphs: [],
        font: fam.font,
      };
      const rot = ROT[a];
      let rcps = null,
        cur = 0;
      for (const g of out.glyphs) {
        // Synth-bold: if the adapter returned a synthBoldSwEm flag
        // (set when the SVG requested bold but no boldFont variant
        // was wired), paint the glyph with a stroke OF the FILL
        // color at the requested em-thickness on top of the fill.
        // The composite (fill + same-color stroke) reads as bolder
        // without changing the typeface — matches CSS
        // `font-synthesis: weight`.
        let glyphSw = c.sw;
        let glyphStroke = c.strokeRgba;
        if (g.synthBoldSwEm && g.synthBoldSwEm > 0) {
          glyphSw = g.synthBoldSwEm * c.fs;
          glyphStroke = c.fillRgba;
        }
        let segs = g.segs;
        if (rot !== 0 && !grp)
          segs = rotateSegs(segs, vertical ? p.x : p.x + (g.penX ?? 0), vertical ? p.y : oy, rot);
        let ci = a;
        if (needCharIndex) {
          // Glyphs carry the codepoint they came from; the n-th glyph is matched to the next equal character.
          if (!rcps) rcps = Array.from(text, (ch) => ch.codePointAt(0));
          let j = cur;
          while (j < rcps.length && rcps[j] !== g.codepoint) j++;
          if (j < rcps.length) {
            ci = a + j;
            cur = j + 1;
          } else ci = a + Math.min(cur, rcps.length - 1);
        }
        run.glyphs.push({
          segs,
          fillRgba: c.fillRgba,
          fillColorClear: c.fillColorClear,
          strokeRgba: glyphStroke,
          sw: glyphSw,
          strokeElement: item.el,
          run,
          ci,
          sp: 0,
          penX: g.penX ?? 0,
          advance: g.advance ?? 0,
          synth: g.synthBoldSwEm > 0,
          c,
          rot,
        });
      }
      if (vertical) p.y += out.advance;
      else p.x += out.advance;
      run.in1 = vertical ? p.y : p.x;
      if (!grp) {
        for (const g of run.glyphs) buffered.push(g);
        runs.push(run);
        chunks[chunks.length - 1].runs.push(run);
        // Stash the text-decoration request so the post-layout loop can synthesize underline/overline/line-through
        // shapes spanning the run, after the chunk shift has placed it.
        if (c.ts.textDecoration && c.ts.textDecoration !== 'none' && !c.hidden)
          decorationRuns.push(run);
      } else {
        grp.runs.push(run);
        for (const g of run.glyphs) grp.glyphs.push(g);
      }
      return run;
    };
    const layoutItem = (item, p, grp) => {
      let a = item.start;
      const end = item.start + item.n;
      for (let j = a + 1; j <= end; j++) {
        if (j === end || splitBefore(item, j)) {
          placeRun(item, a, j, p, grp);
          a = j;
        }
      }
    };

    // <textPath href="#id" startOffset="..."> layout. The textPath's content is laid out as one flat run at y = 0 (its
    // tspans' style, dx and dy included), each glyph's pen-advance midpoint is mapped onto the path at
    // startOffset + the text-anchor shift + its flat x, and the glyph is carried by the path's tangent frame.
    // Result entries are `positioned`: the chunk shift skips them.
    const reverseSegs = (segs) => {
      if (segs.some((sg) => sg.type !== SEG_LINE && sg.type !== SEG_QUAD && sg.type !== SEG_CUBIC))
        return null;
      return segs
        .slice()
        .reverse()
        .map((sg) => {
          if (sg.type === SEG_LINE) return mkLine(sg.p2, sg.p1);
          if (sg.type === SEG_QUAD) return mkQuad(sg.p3, sg.p2, sg.p1);
          return mkCubic(sg.p4, sg.p3, sg.p2, sg.p1);
        });
    };
    const layoutGroup = (grp) => {
      const el = grp.el;
      // Resolve href / xlink:href to a shape segs array.
      const hrefRaw =
        el.getAttribute('href') ||
        el.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href') ||
        '';
      const hrefIdM = /^#(.+)$/.exec((hrefRaw || '').trim());
      if (!hrefIdM) return;
      const target = walkCtx._shapeElById[hrefIdM[1]];
      if (!target) {
        mantleWarn(`svgImporter: <textPath href="${hrefRaw}"> — no matching shape #${hrefIdM[1]}`);
        return;
      }
      let pathSegs = parseShape(target);
      if (!pathSegs.length) return;
      // The path is in the coordinate system of ITS element, which includes the element's own transform.
      const pm = parseTransform(target.getAttribute('transform') || '');
      if (pm !== IDENT) {
        const xf = [];
        for (const sg of pathSegs) transformSegInto(sg, pm, xf);
        pathSegs = xf;
      }
      // side="right" lays the text along the opposite side: the path runs the other way (arcs keep their direction).
      if ((el.getAttribute('side') || '').trim().toLowerCase() === 'right')
        pathSegs = reverseSegs(pathSegs) || pathSegs;
      const lut = buildPathArcLengthLut(pathSegs);
      // startOffset: a length (user units, em of the textPath's font) or "N%" of the path length.
      const offRaw = (el.getAttribute('startOffset') || '0').trim();
      const startOffset = offRaw.endsWith('%')
        ? (parseLengthOr(offRaw.slice(0, -1), 0) / 100) * lut.total
        : parseLengthOr(offRaw, 0, lengthCtx('x', grp.c.fs));
      const p = { x: 0, y: 0 };
      for (const it of grp.items) if (it.n) layoutItem(it, p, grp);
      if (!grp.glyphs.length) return;
      // text-anchor along the path: the flat run is shifted so its start / middle / end sits at startOffset.
      let flatEnd = 0;
      for (const r of grp.runs) flatEnd = Math.max(flatEnd, r.in1);
      // Text runs forward along the path whatever the direction, so start and end are not swapped here.
      const anchor = grp.c.anchor;
      const anchorShift = anchor === 'middle' ? -flatEnd / 2 : anchor === 'end' ? -flatEnd : 0;
      for (const g of grp.glyphs) {
        if (!g.segs || !g.segs.length) continue;
        // SVG spec: each glyph's anchor on the path is the midpoint
        // of its pen-advance interval — i.e., penX + advance/2.
        // This is independent of glyph geometry (bbox), so glyphs
        // with asymmetric bearings (e.g. italic 'f', narrow 'l')
        // stay correctly spaced along the curve.
        const cx = g.run.x + g.penX + g.advance * 0.5;
        const sAt = startOffset + anchorShift + cx;
        if (sAt < 0 || sAt > lut.total) continue; // off-path glyphs are dropped
        const sample = samplePathAt(lut, sAt);
        // Tangent-frame transform: rotate glyph so its baseline
        // aligns with path tangent (tx, ty). Glyph's local x-axis
        // maps to (tx, ty); glyph's local y-axis maps to the path
        // normal (−ty, tx) (rotated +90° CCW). Anchor: subtract cx
        // so the glyph's advance-midpoint sits at the path point.
        const ax = sample.tx,
          ay = sample.ty;
        const nx = -ay,
          ny = ax;
        // A rotate entry turns the glyph about that anchor point, on top of the path's own turn.
        const segsIn = g.rot ? rotateSegs(g.segs, cx, g.run.y, g.rot) : g.segs;
        const xformed = new Array(segsIn.length);
        const xf = (q) => {
          const lx = q[0] - cx; // glyph-local x relative to its center
          const ly = q[1]; // glyph-local y (already in SVG user-space)
          return [sample.x + ax * lx + nx * ly, sample.y + ay * lx + ny * ly];
        };
        for (let i = 0; i < segsIn.length; i++) {
          const sg = segsIn[i];
          if (sg.type === SEG_LINE) xformed[i] = mkLine(xf(sg.p1), xf(sg.p2));
          else if (sg.type === SEG_QUAD) xformed[i] = mkQuad(xf(sg.p1), xf(sg.p2), xf(sg.p3));
          else if (sg.type === SEG_CUBIC)
            xformed[i] = mkCubic(xf(sg.p1), xf(sg.p2), xf(sg.p3), xf(sg.p4));
          else xformed[i] = sg;
        }
        buffered.push({
          segs: xformed,
          fillRgba: g.c.fillRgba,
          fillColorClear: g.c.fillColorClear,
          fillNone: g.c.fillNone,
          // (strokeNone of a derived tspan context is not the cascade's answer; the root's stands unless synth-bold strokes.)
          strokeNone: g.synth ? false : undefined,
          strokeRgba: g.synth ? g.c.fillRgba : g.c.strokeRgba,
          sw: g.synth ? g.sw : g.c.sw,
          strokeElement: g.strokeElement,
          c: g.c,
          positioned: true,
        });
      }
    };

    for (const item of items) {
      if (!item.n) continue;
      if (item.c.group) {
        if (!item.c.group.done) {
          item.c.group.done = true;
          layoutGroup(item.c.group);
        }
        continue;
      }
      layoutItem(item, pen, null);
    }

    // ---- textLength (SVG 2 §11.7.2): fit an element's characters to the length its author computed -------------
    // lengthAdjust="spacing" spreads the difference over the gaps between characters; "spacingAndGlyphs" scales the
    // glyphs along the inline axis too. Innermost elements first; the characters after the element, in its chunk,
    // move by the whole difference. A run carries an affine map of its inline coordinate (A, B), a glyph an extra offset.
    const adjStart = (r) => r.A * r.in0 + r.B;
    const adjEnd = (r) => r.A * r.in1 + r.B + r.endExtra;
    for (let ei = elems.length - 1; ei >= 0; ei--) {
      const r = elems[ei];
      if (!r.tl) continue;
      const rs = runs.filter((q) => q.a >= r.start && q.b <= r.end);
      if (!rs.length) continue;
      let start = Infinity,
        end = -Infinity;
      for (const q of rs) {
        start = Math.min(start, adjStart(q));
        end = Math.max(end, adjEnd(q));
      }
      const natural = end - start,
        delta = r.tl - natural;
      if (!(natural > 0)) continue;
      if (r.glyphScale) {
        const k = r.tl / natural;
        for (const q of rs) {
          q.A *= k;
          q.B = start + k * (q.B - start);
          q.endExtra *= k;
          for (const g of q.glyphs) g.sp *= k;
        }
      } else {
        const n = r.end - r.start;
        if (n < 2) continue;
        const step = delta / (n - 1);
        for (const q of rs) {
          q.B += (q.a - r.start) * step;
          q.endExtra += (q.b - q.a - 1) * step;
          for (const g of q.glyphs) g.sp += (g.ci - q.a) * step;
        }
      }
      const last = rs[rs.length - 1];
      for (const q of runs) if (q.chunk === last.chunk && q.a >= r.end) q.B += delta;
    }

    // ---- text-anchor: each chunk shifts along the inline axis by its width ---------------------------------
    // Chunk width = the span of its runs; shift = 0 / -W/2 / -W for start / middle / end, start and end swapped for
    // a right-to-left chunk (SVG 1.1 §10.9.1: `start` is the right edge there). textPath glyphs are anchored on
    // their path above and exempt.
    for (const ch of chunks) {
      if (!ch.runs.length) continue;
      let lo = Infinity,
        hi = -Infinity;
      for (const q of ch.runs) {
        lo = Math.min(lo, adjStart(q));
        hi = Math.max(hi, adjEnd(q));
      }
      const width = hi - lo;
      const anchor = ch.rtl
        ? ch.anchor === 'start'
          ? 'end'
          : ch.anchor === 'end'
            ? 'start'
            : 'middle'
        : ch.anchor;
      const sh = anchor === 'middle' ? -width / 2 : anchor === 'end' ? -width : 0;
      if (sh !== 0) for (const q of ch.runs) q.B += sh;
    }

    // ---- Decoration synthesis ---------------------------------------
    // For each run that requested text-decoration, emit underline
    // /overline/line-through rectangles (or wavy / dashed / dotted /
    // double per CSS Text Decoration) as synthetic FILLED shapes. The
    // run's extents carry the chunk's anchor shift so decoration
    // rides with the glyphs. Runs one text node was split into (by x / y / dx / dy / rotate entries) are joined
    // back into one decoration when they are contiguous.
    //
    // Font metrics, all em of the font (user-space = em × fontSize), band TOP edges measured from the baseline:
    //   underline    : post.underlinePosition (negative = below), thickness post.underlineThickness
    //   overline     : the ascent
    //   line-through : OS/2 yStrikeoutPosition, thickness OS/2 yStrikeoutSize
    const decoShapes = [];
    const buildDecoRects = (style, x0, x1, yTop, thick) => {
      // Returns an array of {segs[]} closed rectangles approximating
      // the requested style. yTop is the TOP edge of the band.
      const yBot = yTop + thick;
      const mkRect = (x0r, yTr, x1r, yBr) => [
        mkLine([x0r, yTr], [x1r, yTr]),
        mkLine([x1r, yTr], [x1r, yBr]),
        mkLine([x1r, yBr], [x0r, yBr]),
        mkLine([x0r, yBr], [x0r, yTr]),
      ];
      if (x1 <= x0 || thick <= 0) return [];
      const out = [];
      if (!style || style === 'solid') {
        out.push(mkRect(x0, yTop, x1, yBot));
        return out;
      }
      if (style === 'dashed') {
        const dash = thick * 4,
          gap = thick * 2;
        for (let x = x0; x < x1; x += dash + gap)
          out.push(mkRect(x, yTop, Math.min(x + dash, x1), yBot));
        return out;
      }
      if (style === 'dotted') {
        const dot = thick,
          gap = thick * 1.5;
        for (let x = x0; x < x1; x += dot + gap)
          out.push(mkRect(x, yTop, Math.min(x + dot, x1), yBot));
        return out;
      }
      if (style === 'double') {
        const t = thick * 0.4;
        out.push(mkRect(x0, yTop, x1, yTop + t));
        out.push(mkRect(x0, yTop + t + t, x1, yTop + t + t + t));
        return out;
      }
      // Unknown style → fall back to solid.
      out.push(mkRect(x0, yTop, x1, yBot));
      return out;
    };
    const decoSpans = [];
    for (const run of decorationRuns) {
      const prev = decoSpans[decoSpans.length - 1];
      if (
        prev &&
        prev.last.item === run.item &&
        prev.last.vertical === run.vertical &&
        Math.abs(prev.last.y - run.y) < 1e-9 &&
        Math.abs(adjEnd(prev.last) - adjStart(run)) < 1e-6
      )
        prev.last = run;
      else decoSpans.push({ first: run, last: run });
    }
    for (const span of decoSpans) {
      const run = span.first,
        fnt = run.font,
        fontSize = run.item.c.fs,
        fillRgba = run.item.c.fillRgba;
      const toks = (run.item.c.ts.textDecoration + '').trim().toLowerCase().split(/\s+/);
      const styleKeywords = new Set(['solid', 'dashed', 'dotted', 'double', 'wavy']);
      let decoStyle = 'solid';
      const lines = { under: false, over: false, through: false };
      for (const t of toks) {
        if (t === 'underline') lines.under = true;
        else if (t === 'overline') lines.over = true;
        else if (t === 'line-through') lines.through = true;
        else if (styleKeywords.has(t)) decoStyle = t;
      }
      const uPosEm = (fnt && fnt.underlinePosition) || -0.1; // sensible fallback
      const uThickEm = (fnt && fnt.underlineThickness) || 0.05;
      const ascEm = (fnt && fnt.ascent) || 0.8;
      const strikeThickEm = fnt && fnt.strikeoutSize > 0 ? fnt.strikeoutSize : uThickEm;
      const strikeTopEm =
        fnt && fnt.strikeoutSize > 0
          ? fnt.strikeoutPosition
          : ((fnt && fnt.xHeight) || 0.5) * 0.5 + strikeThickEm * 0.5;
      const thickPx = uThickEm * fontSize;
      const strikePx = strikeThickEm * fontSize;
      // The span's inline extent after the chunk shift, text-length fitting and anchoring.
      const i0 = adjStart(run),
        i1 = adjEnd(span.last);
      if (!run.vertical) {
        // Horizontal: under/over/through are wide thin rects ALONG X.
        const linesToEmit = [];
        if (lines.under) linesToEmit.push([run.y - uPosEm * fontSize, thickPx]);
        if (lines.over) linesToEmit.push([run.y - ascEm * fontSize, thickPx]);
        if (lines.through) linesToEmit.push([run.y - strikeTopEm * fontSize, strikePx]);
        for (const [yTop, th] of linesToEmit) {
          for (const segs of buildDecoRects(decoStyle, i0, i1, yTop, th)) {
            decoShapes.push({
              segs,
              fillRgba,
              fillColorClear: run.item.c.fillColorClear,
              href: run.item.c.href,
            });
          }
        }
      } else {
        // Vertical: the inline axis is Y, the glyphs are turned a quarter, so the baseline is the column's vertical line
        // at the run's x with the ascent to its left: the horizontal geometry turned. Underline is a TALL thin rect on
        // the right, overline on the left; style variants are not defined for vertical.
        const colsToEmit = [];
        if (lines.under) colsToEmit.push([run.x - uPosEm * fontSize, thickPx]);
        if (lines.over) colsToEmit.push([run.x - ascEm * fontSize, thickPx]);
        if (lines.through) colsToEmit.push([run.x - strikeTopEm * fontSize, strikePx]);
        for (const [xTop, th] of colsToEmit) {
          if (!(i1 > i0) || th <= 0) continue;
          const segs = [
            mkLine([xTop, i0], [xTop + th, i0]),
            mkLine([xTop + th, i0], [xTop + th, i1]),
            mkLine([xTop + th, i1], [xTop, i1]),
            mkLine([xTop, i1], [xTop, i0]),
          ];
          decoShapes.push({
            segs,
            fillRgba,
            fillColorClear: run.item.c.fillColorClear,
            href: run.item.c.href,
          });
        }
      }
    }

    const ctmIsIdent =
      ctm === IDENT ||
      (ctm[0] === 1 &&
        ctm[1] === 0 &&
        ctm[2] === 0 &&
        ctm[3] === 1 &&
        ctm[4] === 0 &&
        ctm[5] === 0);
    // THE GLYPH STROKE'S SCALE, as a shape's (importWalkShapes.js). The glyphs are baked into document
    // space by the CTM, so their stroke-width must be scaled too: under scale(2) a 1-wide stroke draws 2 wide. A
    // conformal CTM scales it by its one scale; any other draws it in STROKE SPACE through the frame N, scaled by
    // the CTM's larger singular value (bundle/strokeFrame.js).
    const _singularStroke = ctmSingular(ctm);
    const _ctmScale = 0.5 * (Math.hypot(ctm[0], ctm[1]) + Math.hypot(ctm[2], ctm[3]));
    const _frameCandidate = strokeFrameOf(ctm);
    const _strokeFrame = _frameCandidate?.representable === false ? null : _frameCandidate;
    const _strokeScale =
      _singularStroke || _frameCandidate?.representable === false
        ? 0
        : _strokeFrame
          ? _strokeFrame.sMax
          : _ctmScale;
    // retainSource: collect a `<path>` per glyph/decoration so the
    // retained svgSource can carry this <text>'s shapes as real path
    // elements (one per bundle shape), instead of the unexpanded
    // <text> (1 element → N shapes), which would break the native
    // fallback's positional shape→element addressing.
    const _expandColl = walkCtx.opts.retainSource ? [] : null;
    const strokeStyles = new Map();
    const strokeStyleOf = (el) => {
      if (strokeStyles.has(el)) return strokeStyles.get(el);
      const vectorEffect = getStyleProp(
        el,
        'vector-effect',
        getStyleProp(node, 'vector-effect', 'none'),
      );
      const nonScaling = /\bnon-scaling-stroke\b/.test(vectorEffect || '');
      const local = getStrokeDashes(el, walkCtx.viewport);
      const scale = nonScaling ? 1 : _strokeScale;
      // paint-order: whether the element's strokes go under its fills.
      const order = String(getInheritedStyleProp(el, 'paint-order', '') || '')
        .trim()
        .toLowerCase()
        .split(/\s+/);
      const fillAt = order.indexOf('fill'),
        strokeAt = order.indexOf('stroke');
      const strokeFirst = strokeAt >= 0 && (fillAt < 0 || strokeAt < fillAt);
      const value = {
        nonScaling,
        local,
        caps: getCapsJoins(el),
        scale,
        strokeFirst,
        dashArray: local.dashArray.map((x) => x * scale),
        dashOffset: local.dashOffset * scale,
      };
      strokeStyles.set(el, value);
      return value;
    };
    // Running index of this shape within ITS <text>'s expansion. The
    // retained svgSource replaces the <text> with one <path> PER SHAPE,
    // so the positional map must give glyph k the ordinal textLeaf+k
    // (bundleFinalize builds shapeDomIndex in that expanded-leaf space).
    let _domLeafK9 = 0;
    // part: 0 the glyph as one record (fill, then stroke), 1 its stroke alone, 2 its fill alone.
    const emitGlyph = (b, part) => {
      let glyphSegs = b.segs;
      // The run's inline map (text-length fitting, chunk anchor) plus the glyph's own spacing offset.
      const mapA = b.run ? b.run.A : 1,
        mapB = b.run ? b.run.B + b.sp : 0;
      if (mapA !== 1 || mapB !== 0) {
        const vert = b.run.vertical;
        const mp = vert ? (q) => [q[0], mapA * q[1] + mapB] : (q) => [mapA * q[0] + mapB, q[1]];
        const shifted = new Array(glyphSegs.length);
        for (let i = 0; i < glyphSegs.length; i++) {
          const s = glyphSegs[i];
          if (s.type === SEG_LINE) shifted[i] = mkLine(mp(s.p1), mp(s.p2));
          else if (s.type === SEG_QUAD) shifted[i] = mkQuad(mp(s.p1), mp(s.p2), mp(s.p3));
          else if (s.type === SEG_CUBIC)
            shifted[i] = mkCubic(mp(s.p1), mp(s.p2), mp(s.p3), mp(s.p4));
          else shifted[i] = s;
        }
        glyphSegs = shifted;
      }
      const sourceGlyphSegs = glyphSegs;
      if (!ctmIsIdent) {
        const xformed = [];
        for (const sg of glyphSegs) transformSegInto(sg, ctm, xformed);
        glyphSegs = xformed;
      }
      const stroke = strokeStyleOf(b.strokeElement || node);
      const glyphSw = _singularStroke ? 0 : (b.sw || 0) * stroke.scale;
      const framed = !stroke.nonScaling && _strokeFrame && b.sw > 0;
      // Retain local outlines and widths; the SVG hierarchy transforms both together.
      if (_expandColl && !(_mixedVisibility && b.c && b.c.hidden))
        _expandColl.push({
          visible: _mixedVisibility,
          pathD: segsToPathD(sourceGlyphSegs, true),
          fill: part === 1 ? null : b.fillRgba,
          stroke: part === 2 ? null : b.strokeRgba,
          sw: part === 2 ? 0 : b.sw || 0,
          strokeAttrs: {
            'vector-effect': stroke.nonScaling ? 'non-scaling-stroke' : 'none',
            'stroke-dasharray': stroke.local.dashArray.join(' ') || 'none',
            'stroke-dashoffset': String(stroke.local.dashOffset),
            'stroke-linecap': ['butt', 'round', 'square'][stroke.caps.capStyle],
            'stroke-linejoin': ['miter', 'round', 'bevel', 'miter-clip', 'arcs'][
              stroke.caps.joinStyle
            ],
            'stroke-miterlimit': String(stroke.caps.miterLimit),
          },
        });
      walkCtx.enqueueShape({
        segs: glyphSegs,
        fillRgba: part === 1 ? [0, 0, 0, 0] : b.fillRgba,
        fillColorClear: b.fillColorClear,
        ...(part === 1 ? { fillNone: true } : null),
        hitFillNone: part === 1 ? true : (b.fillNone ?? rootStyles.fillNone),
        strokeNone: part === 2 ? true : (b.strokeNone ?? rootStyles.strokeNone),
        strokeRgba: part === 2 ? [0, 0, 0, 0] : b.strokeRgba || [0, 0, 0, 0],
        sw: part === 2 ? 0 : glyphSw,
        strokeFrame: framed && part !== 2 ? _strokeFrame.N : null,
        swMin: part === 2 ? 0 : framed ? b.sw * _strokeFrame.sMin : glyphSw,
        fillRule: 'nonzero',
        ...stroke.caps,
        fillGradId: 0,
        strokeGradId: 0,
        vecPatternId: 0,
        flagsShape: (stroke.nonScaling ? 1 : 0) | (stroke.dashArray.length ? 2 : 0),
        dashArray: stroke.dashArray,
        dashOffset: stroke.dashOffset,
        // Mask + clip-path resolved on the parent <text> element
        // (inherited from ancestor <g mask=> / clip-path= when
        // absent on the leaf). Every glyph row in this <text> shares
        // the same ids — clipping/masking is a property of the run,
        // not per-glyph.
        clipId: _textClipId,
        maskId: _textMaskId,
        filterId: _textFilterId,
        blendMode: 0,
        isolation: 0,
        imageId: 0,
        imageRect: [0, 0, 0, 0],
        strokeFirst: false,
        _domLeafGlyphK: _domLeafK9++,
        ...(_mixedVisibility ? { hitVisible: !(b.c && b.c.hidden) } : null),
        ...(b.c && b.c.href ? { anchorHref: b.c.href } : null),
      });
    };
    // A hidden element's glyphs took their place above and paint nothing. paint-order: a run's strokes go under ALL its fills, as a
    // browser paints the run (a glyph's stroke reaches over its neighbor's fill): the glyphs that ask for it become two records, strokes first.
    // A <text> whose elements differ keeps its hidden glyphs where the pass wants a hidden leaf's rows: flagged under keepHidden, hit-only in the second pass.
    const _keepHiddenGlyphs =
      _mixedVisibility &&
      (walkCtx.hitPass ||
        (walkCtx.keepHidden && !walkCtx.walkLayerMode && !(walkCtx.inClipContent > 0)));
    const painted = buffered.filter((b) => !(b.c && b.c.hidden) || _keepHiddenGlyphs);
    const strokesUnder = (b) =>
      b.sw > 0 &&
      b.strokeRgba &&
      b.strokeRgba[3] > 0 &&
      strokeStyleOf(b.strokeElement || node).strokeFirst;
    // Per glyph in that case only, what the walk otherwise holds for a whole leaf.
    const _leafBits = walkCtx._hiddenBits,
      _leafHidden = walkCtx._hiddenLeaf;
    const emitOwn = (b, part) => {
      if (_mixedVisibility) {
        const own = !!(b.c && b.c.hidden);
        if (walkCtx.hitPass) walkCtx._hiddenLeaf = own;
        else if (own && _keepHiddenGlyphs) walkCtx._hiddenBits = _leafBits | 2;
        else walkCtx._hiddenBits = _leafBits;
      }
      emitGlyph(b, part);
    };
    for (const b of painted) if (strokesUnder(b)) emitOwn(b, 1);
    for (const b of painted) emitOwn(b, strokesUnder(b) ? 2 : 0);
    if (_mixedVisibility) {
      walkCtx._hiddenBits = _leafBits;
      if (walkCtx.hitPass) walkCtx._hiddenLeaf = false;
    }
    // Emit decoration shapes (underline / overline / line-through)
    // computed pre-CTM; apply the same per-element CTM transform.
    for (const d of decoShapes) {
      let segs = d.segs;
      if (!ctmIsIdent) {
        const xformed = [];
        for (const sg of segs) transformSegInto(sg, ctm, xformed);
        segs = xformed;
      }
      if (_expandColl)
        _expandColl.push({
          visible: _mixedVisibility,
          pathD: segsToPathD(d.segs, true),
          fill: d.fillRgba,
          stroke: null,
          sw: 0,
        });
      walkCtx.enqueueShape({
        segs,
        fillRgba: d.fillRgba,
        fillColorClear: d.fillColorClear,
        hitFillNone: !(d.fillRgba[3] > 0),
        strokeRgba: [0, 0, 0, 0],
        sw: 0,
        fillRule: 'nonzero',
        cap: 'butt',
        join: 'miter',
        miterLimit: 4,
        fillGradId: 0,
        strokeGradId: 0,
        vecPatternId: 0,
        flagsShape: 0,
        dashArray: [],
        dashOffset: 0,
        clipId: _textClipId,
        maskId: _textMaskId,
        filterId: _textFilterId,
        blendMode: 0,
        isolation: 0,
        imageId: 0,
        imageRect: [0, 0, 0, 0],
        strokeFirst: false,
        _domLeafGlyphK: _domLeafK9++,
        ...(_mixedVisibility ? { hitVisible: true } : null), // only a visible run has a decoration
        ...(d.href ? { anchorHref: d.href } : null),
      });
    }
    // Record this <text>'s expanded glyph/decoration paths (in shape
    // order) against its source DOM node, so the retainSource block in
    // importSvg can swap the <text> for the matching real <path>s.
    if (_expandColl && _expandColl.length) {
      (walkCtx.ctx._textExpansions || (walkCtx.ctx._textExpansions = [])).push({
        node,
        paths: _expandColl,
      });
    }
    if (_textFilterId) walkCtx.setFilterBoxRows(_textFilterId, _textReferencingShapeIdx);
    walkCtx.setClaimBoxRows(_textClipId, _textMaskId, _textReferencingShapeIdx);
    if (_mixedVisibility && walkCtx.hitPass) walkCtx._hiddenLeaf = _leafHidden;
    if (_textGroup) walkCtx.enqueueShape({ kind: 'groupEnd' });
    return true;
  }
  return false;
}
