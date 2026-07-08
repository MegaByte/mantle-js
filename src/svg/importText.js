// svg/importText.js — <text> / <textPath> / <textArea> import.

import { mantleWarn } from '../core/diagnostics.js';
import { parseLengthOr } from './length.js';
import {
  SEG_LINE, SEG_QUAD, SEG_CUBIC,
  CAP_BUTT, JOIN_MITER,
  mkLine, mkQuad, mkCubic,
  segsToPathD,
} from './segment.js';
import { IDENT, transformSegInto } from './transform.js';
import { parseShape } from './shape.js';
import {
  parseStyleString, getStyleProp, getInheritedStyleProp, getShapeStyles,
} from './style.js';
import { resolveIdRef } from './utils.js';
import { buildPathArcLengthLut, samplePathAt } from './textures.js';

/// Returns true when tag was a text paint element and was handled.
export function handleTextPaintTag(walkCtx, node, tag, ctm, pf, ps, pw, f, s, strokeW) {
  if (tag === 'textarea') {
      const layoutFn = walkCtx.opts.svgTextLayout;
      if (typeof layoutFn !== 'function') {
        mantleWarn('svgImporter: <textArea> requires opts.svgTextLayout — skipping');
        return true;
      }
      const taX = parseLengthOr(node.getAttribute('x') || '0', 0);
      const taY = parseLengthOr(node.getAttribute('y') || '0', 0);
      const taW = parseLengthOr(node.getAttribute('width')  || '0', 0);
      const taFontSize = parseLengthOr(
        node.getAttribute('font-size')
          || getInheritedStyleProp(node, 'font-size', null)
          || '16', 16);
      const taFontFamily = (
        node.getAttribute('font-family')
        || getInheritedStyleProp(node, 'font-family', null)
        || '').trim().replace(/^["']|["']$/g, '');
      // Collect all text content (textArea allows direct text + <tspan>
      // children; flatten everything into one string).
      let combined = '';
      function collectText(el) {
        if (!el || !el.childNodes) return;
        for (let i = 0; i < el.childNodes.length; i++) {
          const c = el.childNodes[i];
          if (c.nodeType === 3) combined += (c.nodeValue || '');
          else if (c.nodeType === 1) collectText(c);
        }
      }
      collectText(node);
      if (taW <= 0 || !combined) return true;
      const maxWidthEm = taW / taFontSize;
      const layoutResult = layoutFn(taFontFamily, combined, taX, taY, taFontSize, maxWidthEm);
      if (!layoutResult || !layoutResult.glyphs) return true;
      // Mask / clip-path inheritance on <textArea>, resolved once before
      // the per-glyph loop.
      const _taStyleMap     = parseStyleString(node.getAttribute('style') || '');
      const _taRawClipStr   = _taStyleMap['clip-path'] || node.getAttribute('clip-path') || walkCtx.currentClipRef();
      const _taRawMaskStr   = _taStyleMap['mask']      || node.getAttribute('mask')      || walkCtx.currentMaskRef();
      const _taRawFilterStr = _taStyleMap['filter']    || node.getAttribute('filter')    || walkCtx.currentFilterRef();
      const _taClipRef      = resolveIdRef(_taRawClipStr);
      const _taMaskRef      = resolveIdRef(_taRawMaskStr);
      const _taFilterRef    = resolveIdRef(_taRawFilterStr);
      const _taReferencingShapeIdx = walkCtx.ctx.shapesData.length;
      const _taClipId   = _taClipRef   ? walkCtx.claimClip(_taClipRef, _taReferencingShapeIdx) : 0;
      const _taMaskId   = _taMaskRef   ? walkCtx.claimMask(_taMaskRef, _taReferencingShapeIdx) : 0;
      const _taFilterId = _taFilterRef ? walkCtx.claimFilter(_taFilterRef) : 0;
      // Re-use the per-glyph emit path used by <text>: each glyph
      // becomes its own Mantle shape so band walks stay tight.
      const f = getStyleProp(node, 'fill', pf);
      for (const g of layoutResult.glyphs) {
        if (!g.segs || !g.segs.length) continue;
        const transformedSegs = (ctm === IDENT) ? g.segs : (() => {
          const xf = [];
          for (const sg of g.segs) transformSegInto(sg, ctm, xf);
          return xf;
        })();
        const styles = getShapeStyles(node, f, 'none', 0);
        walkCtx.enqueueShape({
          segs: transformedSegs,
          fillRgba: styles.fillRgba,
          fillNone: styles.fillNone,
          strokeRgba: [0, 0, 0, 0],
          sw: 0,
          fillRule: 'nonzero',
          capStyle: CAP_BUTT, joinStyle: JOIN_MITER, miterLimit: 4,
          fillGradId: 0, strokeGradId: 0,
          flagsShape: 0,
          dashArray: [], dashOffset: 0,
          clipId: _taClipId, maskId: _taMaskId,
          filterId: _taFilterId, blendMode: 0, isolation: 0,
          imageId: 0, imageRect: [0, 0, 0, 0],
        });
      }
      return true;
  }
  if (tag === 'text') {
      const layoutFn = walkCtx.opts.svgTextLayout;
      if (typeof layoutFn !== 'function') {
        mantleWarn(`svgImporter: <text> requires opts.svgTextLayout (the buildSvgTextGlyphs entrypoint from font/textRun.js) — skipping`);
        return true;
      }
      // Resolve `mask` / `clip-path` on the <text> element with ancestor
      // inheritance. Stamp the claimed 1-based ids on every emitted glyph
      // so the bake pipeline can clip text the same way it clips paths.
      const _textStyleMap     = parseStyleString(node.getAttribute('style') || '');
      const _textRawClipStr   = _textStyleMap['clip-path'] || node.getAttribute('clip-path') || walkCtx.currentClipRef();
      const _textRawMaskStr   = _textStyleMap['mask']      || node.getAttribute('mask')      || walkCtx.currentMaskRef();
      const _textRawFilterStr = _textStyleMap['filter']    || node.getAttribute('filter')    || walkCtx.currentFilterRef();
      const _textClipRef   = resolveIdRef(_textRawClipStr);
      const _textMaskRef   = resolveIdRef(_textRawMaskStr);
      const _textFilterRef = resolveIdRef(_textRawFilterStr);
      // Per-glyph clip/mask ids; the importer-level claim returns a
      // 1-based index into walkCtx.ctx.clipsUsed/walkCtx.ctx.masksUsed (rewritten to a
      // meta-row index post-walk). Passing walkCtx.ctx.shapesData.length at
      // claim-time lets objectBoundingBox clip/mask defs be
      // specialized to the FIRST glyph's bbox; for text consumers
      // that need true per-glyph specialization, switch to userSpace
      // units instead.
      const _textReferencingShapeIdx = walkCtx.ctx.shapesData.length;
      const _textClipId   = _textClipRef   ? walkCtx.claimClip(_textClipRef, _textReferencingShapeIdx) : 0;
      const _textMaskId   = _textMaskRef   ? walkCtx.claimMask(_textMaskRef, _textReferencingShapeIdx) : 0;
      const _textFilterId = _textFilterRef ? walkCtx.claimFilter(_textFilterRef) : 0;
      const fontMap = walkCtx.opts.fonts || null;
      const rootTextX = parseLengthOr(node.getAttribute('x') || '0', 0);
      const rootTextY = parseLengthOr(node.getAttribute('y') || '0', 0);
      // font-size + font-family inherit through <g> ancestors per
      // SVG 1.1 §10.10 (font-family) + CSS Fonts (font-size).
      const rootFontSize = parseLengthOr(
        node.getAttribute('font-size')
          || getInheritedStyleProp(node, 'font-size', null)
          || '16', 16);
      const rootFontFamily = (
        node.getAttribute('font-family')
        || getInheritedStyleProp(node, 'font-family', null)
        || '').trim().replace(/^["']|["']$/g, '');
      // Inherited text-style props (CSS Fonts / Text). All flow
      // through `walkChunks` + per-tspan resolution; the layout
      // adapter receives them as a trailing opts dict and decides
      // what to do with them (variant font swap, decoration stroke
      // emission, vertical writing-mode, RTL bidi, advance scaling).
      const _rtfWeight    = getInheritedStyleProp(node, 'font-weight',   null);
      const _rtfStyle     = getInheritedStyleProp(node, 'font-style',    null);
      const _rtfDecor     = getInheritedStyleProp(node, 'text-decoration', null);
      const _rtfWrMode    = getInheritedStyleProp(node, 'writing-mode',  null);
      const _rtfDir       = getInheritedStyleProp(node, 'direction',     null);
      const _rtfLetterSp  = getInheritedStyleProp(node, 'letter-spacing', null);
      const _rtfWordSp    = getInheritedStyleProp(node, 'word-spacing',  null);
      const _rtfFontVar   = getInheritedStyleProp(node, 'font-variant',  null);
      const _rtfFontFeat  = getInheritedStyleProp(node, 'font-feature-settings', null);
      const rootTextStyle = {
        fontWeight: _rtfWeight, fontStyle: _rtfStyle,
        textDecoration: _rtfDecor,
        writingMode: _rtfWrMode, direction: _rtfDir,
        letterSpacing: _rtfLetterSp, wordSpacing: _rtfWordSp,
        fontVariant: _rtfFontVar, fontFeatureSettings: _rtfFontFeat,
      };
    
      // text-anchor controls run alignment around an anchor X.
      // SVG 2 chunk model:
      //   - A "chunk" is a run of glyphs sharing one anchor point.
      //   - The root <text> opens chunk 0 at (rootTextX, rootTextY)
      //     with the root's text-anchor.
      //   - A <tspan> with absolute x= starts a new chunk at that
      //     x, using that tspan's text-anchor (else inherited).
      // After the walk, each chunk gets a constant X shift based on
      // its own width + anchor.
      const resolveAnchor = (el, fallback) => {
        const raw = (getStyleProp(el, 'text-anchor', null) || el.getAttribute('text-anchor') || '').trim().toLowerCase();
        if (raw === 'start' || raw === 'middle' || raw === 'end') return raw;
        return fallback || 'start';
      };
      const rootAnchor = resolveAnchor(node, 'start');
    
      // xml:space="preserve" disables whitespace collapsing for the
      // subtree. Inherits from parent. Default = collapse.
      const xmlSpacePreserve =
        (node.getAttribute('xml:space') || node.getAttributeNS?.('http://www.w3.org/XML/1998/namespace', 'space') || '').trim() === 'preserve';
    
      let penX = rootTextX, penY = rootTextY;
    
      // SVG whitespace normalization (default xml:space): collapse
      // runs of \s\r\n\t to a single space. xml:space="preserve" keeps
      // verbatim (only converts \r\n → \n, not implemented further).
      const normalizeSvgWhitespace = (s) => {
        const t = xmlSpacePreserve ? s.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : s;
        return xmlSpacePreserve ? t : t.replace(/[\s\r\n\t]+/g, ' ');
      };
    
      // Buffered emit: buffer each glyph and open a chunk record at
      // chunk boundaries (root + each tspan x= override). After the
      // walk, each chunk gets a per-chunk anchor shift.
      const buffered = [];
      const chunks = [{ start: 0, anchorX: rootTextX, anchor: rootAnchor }];
      // Decoration spans collected during emitChunk; resolved into
      // rect / wavy-path shapes after the per-chunk anchor shift so
      // the underline geometry rides with the glyphs.
      const decorationRuns = [];
      const openChunk = (anchorX, anchor) => {
        // Seal the previous chunk's pen end before opening a new one.
        chunks[chunks.length - 1]._penEnd = penX;
        chunks.push({ start: buffered.length, anchorX, anchor });
      };
    
      const emitChunk = (text, fontFamily, fontSize, fillRgba, strokeRgba, sw, textStyle) => {
        if (!text) return;
        text = normalizeSvgWhitespace(text);
        if (!text) return;
        const font = (fontMap && fontFamily) ? fontMap[fontFamily] : null;
        if (!font) {
          mantleWarn(`svgImporter: chunk with font-family='${fontFamily}' but no matching font in opts.fonts — skipping`);
          return true;
        }
        // textStyle is an optional trailing arg carrying SVG/CSS
        // inheritable text props (font-weight, font-style,
        // text-decoration, writing-mode, direction, letter-spacing,
        // word-spacing, font-variant, font-feature-settings). The
        // adapter may swap variant fonts, scale advance, etc.
        const chunkStartIdx = buffered.length;
        const chunkPenX0 = penX;
        // Invocation: (text, font, x, y, fontSize, fallbacks,
        // maxWidthEm, styleOpts). The adapter consumes styleOpts to swap
        // variant fonts / scale advance.
        const out = layoutFn(text, font, penX, penY, fontSize, undefined, 0, textStyle);
        for (const g of out.glyphs) {
          // Synth-bold: if the adapter returned a synthBoldSwEm flag
          // (set when the SVG requested bold but no boldFont variant
          // was wired), paint the glyph with a stroke OF the FILL
          // color at the requested em-thickness on top of the fill.
          // The composite (fill + same-color stroke) reads as bolder
          // without changing the typeface — matches CSS
          // `font-synthesis: weight`.
          let glyphSw = sw;
          let glyphStroke = strokeRgba;
          if (g.synthBoldSwEm && g.synthBoldSwEm > 0) {
            glyphSw = g.synthBoldSwEm * fontSize;
            glyphStroke = fillRgba;
          }
          buffered.push({ segs: g.segs, fillRgba, strokeRgba: glyphStroke, sw: glyphSw });
        }
        // Stash chunk-level text-decoration request so the post-walk
        // loop can synthesize underline/overline/line-through stroke
        // shapes spanning the chunk's pen range.
        if (textStyle && textStyle.textDecoration
            && textStyle.textDecoration !== 'none'
            && buffered.length > chunkStartIdx) {
          decorationRuns.push({
            decoration: textStyle.textDecoration,
            font, fontSize,
            penX0: chunkPenX0,
            penX1: chunkPenX0 + out.advance,
            penY,
            fillRgba,
            firstGlyphIdx: chunkStartIdx,
            writingMode: (out && out.writingMode) || 'horizontal-tb',
          });
        }
        // Vertical writing-mode reframes the inline axis to Y. We
        // advance penY (not penX) by the layout's reported advance
        // so subsequent chunks chain DOWN the column instead of
        // along the page.
        if (out && out.writingMode && out.writingMode !== 'horizontal-tb') {
          penY += out.advance;
        } else {
          penX += out.advance;
        }
      };
    
      // <textPath href="#id" startOffset="..."> emitter.
      // Lays out the textPath's text content in a flat run at y=0,
      // computes each glyph's center-x in the flat layout, queries
      // the path LUT at s = startOffset + centerX, and replaces the
      // glyph's segs with a rotate+translate so the glyph rides the
      // path. Result is pushed as { segs, ..., positioned: true }
      // so the post-walk chunk shift skips it.
      const emitTextPathChild = (el, parentFill, parentStroke, parentSw, parentFF, parentFS) => {
        // Resolve href / xlink:href to a shape segs array.
        const hrefRaw = el.getAttribute('href')
          || el.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href')
          || '';
        const hrefIdM = /^#(.+)$/.exec((hrefRaw || '').trim());
        if (!hrefIdM) return;
        const target = walkCtx._shapeElById[hrefIdM[1]];
        if (!target) {
          mantleWarn(`svgImporter: <textPath href="${hrefRaw}"> — no matching shape #${hrefIdM[1]}`);
          return true;
        }
        const pathSegs = parseShape(target);
        if (!pathSegs.length) return;
        const lut = buildPathArcLengthLut(pathSegs);
        // startOffset: number (user units) or "N%" of path length.
        const offRaw = (el.getAttribute('startOffset') || '0').trim();
        let startOffset = 0;
        if (offRaw.endsWith('%')) {
          const pct = parseLengthOr(offRaw.slice(0, -1), 0);
          startOffset = (pct / 100) * lut.total;
        } else {
          startOffset = parseLengthOr(offRaw, 0);
        }
        // Resolve style on the textPath element itself.
        let ff = (el.getAttribute('font-family') || '').trim().replace(/^["']|["']$/g, '');
        if (!ff) ff = parentFF;
        const fsAttr = el.getAttribute('font-size');
        const fs = fsAttr ? (parseLengthOr(fsAttr, parentFS)) : parentFS;
        const parentFillStr = parentFill ? `rgba(${parentFill[0]*255},${parentFill[1]*255},${parentFill[2]*255},${parentFill[3]})` : f;
        const parentStrokeStr = parentStroke ? `rgba(${parentStroke[0]*255},${parentStroke[1]*255},${parentStroke[2]*255},${parentStroke[3]})` : s;
        const styles = getShapeStyles(el, parentFillStr, parentStrokeStr, parentSw);
    
        // Gather text content. <textPath> may contain text nodes and
        // <tspan> children; we collapse the whole subtree to a flat
        // string (no per-tspan styling on textPath in this pass).
        const collectText = (e) => {
          let out = '';
          const ck = e.childNodes;
          for (let i = 0; i < (ck ? ck.length : 0); i++) {
            const k = ck[i];
            if (!k) continue;
            if (k.nodeType === 3) out += (k.nodeValue || '');
            else if (k.nodeType === 1) out += collectText(k);
          }
          return out;
        };
        let text = collectText(el);
        text = normalizeSvgWhitespace(text);
        if (!text) return;
        const font = (fontMap && ff) ? fontMap[ff] : null;
        if (!font) {
          mantleWarn(`svgImporter: <textPath> with font-family='${ff}' but no matching font in opts.fonts — skipping`);
          return true;
        }
        // Lay out flat at (0, 0). The layout's per-glyph segs are in
        // SVG user-space already (em→px applied).
        const layout = layoutFn(text, font, 0, 0, fs);
        // For each glyph: determine its center-x in the flat layout,
        // then warp. We don't have per-glyph advance from the API —
        // approximate center from glyph bbox. The glyph's segs are in
        // user-space at (penX, penY) at layout time = (cx, 0) for that
        // glyph (its baseline pen position).
        for (const g of layout.glyphs) {
          if (!g.segs || !g.segs.length) continue;
          // SVG spec: each glyph's anchor on the path is the midpoint
          // of its pen-advance interval — i.e., penX + advance/2.
          // This is independent of glyph geometry (bbox), so glyphs
          // with asymmetric bearings (e.g. italic 'f', narrow 'l')
          // stay correctly spaced along the curve.
          const cx = (g.penX ?? 0) + ((g.advance ?? 0) * 0.5);
          const sAt = startOffset + cx;
          if (sAt < 0 || sAt > lut.total) continue; // off-path glyphs are dropped
          const sample = samplePathAt(lut, sAt);
          // Tangent-frame transform: rotate glyph so its baseline
          // aligns with path tangent (tx, ty). Glyph's local x-axis
          // maps to (tx, ty); glyph's local y-axis maps to the path
          // normal (−ty, tx) (rotated +90° CCW). Anchor: subtract cx
          // so the glyph's advance-midpoint sits at the path point.
          const ax = sample.tx, ay = sample.ty;
          const nx = -ay,       ny = ax;
          const xformed = new Array(g.segs.length);
          const xf = (p) => {
            const lx = p[0] - cx; // glyph-local x relative to its center
            const ly = p[1];      // glyph-local y (already in SVG user-space)
            return [sample.x + ax*lx + nx*ly,
                    sample.y + ay*lx + ny*ly];
          };
          for (let i = 0; i < g.segs.length; i++) {
            const sg = g.segs[i];
            if      (sg.type === SEG_LINE)  xformed[i] = mkLine (xf(sg.p1), xf(sg.p2));
            else if (sg.type === SEG_QUAD)  xformed[i] = mkQuad (xf(sg.p1), xf(sg.p2), xf(sg.p3));
            else if (sg.type === SEG_CUBIC) xformed[i] = mkCubic(xf(sg.p1), xf(sg.p2), xf(sg.p3), xf(sg.p4));
            else xformed[i] = sg;
          }
          buffered.push({
            segs: xformed,
            fillRgba: styles.fillRgba,
            fillNone: styles.fillNone,
            strokeRgba: styles.strokeRgba,
            sw: styles.sw,
            positioned: true,
          });
        }
      };
    
      // Resolve a <tspan>'s effective style from itself + parent inherit.
      // Returns fill + stroke + sw + text-style props so per-span
      // bold/italic, text-decoration, letter-spacing etc. compose
      // correctly when the layout adapter consumes them.
      const resolveTspanStyle = (tspanEl, parentFill, parentStroke, parentSw, parentFontFamily, parentFontSize, parentTextStyle) => {
        let ff = (tspanEl.getAttribute('font-family') || '').trim().replace(/^["']|["']$/g, '');
        if (!ff) ff = parentFontFamily;
        const fsAttr = tspanEl.getAttribute('font-size');
        const fs = fsAttr ? (parseLengthOr(fsAttr, parentFontSize)) : parentFontSize;
        const parentFillStr = parentFill ? `rgba(${parentFill[0]*255},${parentFill[1]*255},${parentFill[2]*255},${parentFill[3]})` : f;
        const parentStrokeStr = parentStroke ? `rgba(${parentStroke[0]*255},${parentStroke[1]*255},${parentStroke[2]*255},${parentStroke[3]})` : s;
        const styles = getShapeStyles(tspanEl, parentFillStr, parentStrokeStr, parentSw);
        // Per-attribute resolve: own value (inline style OR
        // presentation attr OR ancestor walk) → parent's value.
        const own = (name) => getStyleProp(tspanEl, name, null);
        const ts = {
          fontWeight:     own('font-weight')   || parentTextStyle.fontWeight,
          fontStyle:      own('font-style')    || parentTextStyle.fontStyle,
          textDecoration: own('text-decoration') || parentTextStyle.textDecoration,
          writingMode:    own('writing-mode')  || parentTextStyle.writingMode,
          direction:      own('direction')     || parentTextStyle.direction,
          letterSpacing:  own('letter-spacing') || parentTextStyle.letterSpacing,
          wordSpacing:    own('word-spacing')  || parentTextStyle.wordSpacing,
          fontVariant:    own('font-variant')  || parentTextStyle.fontVariant,
          fontFeatureSettings: own('font-feature-settings') || parentTextStyle.fontFeatureSettings,
        };
        return {
          fontFamily: ff, fontSize: fs,
          fillRgba: styles.fillRgba, fillNone: styles.fillNone, strokeRgba: styles.strokeRgba, sw: styles.sw,
          textStyle: ts,
        };
      };
    
      const rootStyles = getShapeStyles(node, f, s, strokeW);
      const walkChunks = (parentEl, parentFill, parentStroke, parentSw, parentFontFamily, parentFontSize, parentTextStyle) => {
        const ck = parentEl.childNodes;
        for (let i = 0; i < (ck ? ck.length : 0); i++) {
          const k = ck[i];
          if (!k) continue;
          if (k.nodeType === 3 /* text */) {
            emitChunk(k.nodeValue || '', parentFontFamily, parentFontSize, parentFill, parentStroke, parentSw, parentTextStyle);
          } else if (k.nodeType === 1 /* element */ &&
                     ((k.tagName || '').toLowerCase() === 'textpath')) {
            // <textPath href="#id" startOffset="..."> places text
            // along an arbitrary path. Glyphs are NOT subject to the
            // text-anchor chunk model — they ride the path. We emit
            // directly into a separate textPath buffer (no chunk
            // accounting) and apply the rotate+translate at end.
            emitTextPathChild(k, parentFill, parentStroke, parentSw, parentFontFamily, parentFontSize);
          } else if (k.nodeType === 1 /* element */ &&
                     ((k.tagName || '').toLowerCase() === 'tspan')) {
            // Absolute x/y override on tspan replaces the pen position
            // outright (single-shot). Spec: if BOTH x and dx are set, x
            // wins. Same for y/dy. Multiple x/y on a tspan (a list) is
            // rare — handle first value only here.
            const xAttr = k.getAttribute('x');
            const yAttr = k.getAttribute('y');
            let openedChunk = false;
            if (xAttr) {
              const v = parseFloat(xAttr);
              if (Number.isFinite(v)) {
                // SVG 2 — absolute x= on tspan starts a new
                // text-positioning chunk. Seal the prev chunk's
                // _penEnd BEFORE moving penX (openChunk reads penX).
                openChunk(v, resolveAnchor(k, rootAnchor));
                penX = v;
                openedChunk = true;
              }
            } else {
              const dx = parseLengthOr(k.getAttribute('dx') || '0', 0);
              penX += dx;
            }
            if (yAttr) {
              const v = parseFloat(yAttr);
              if (Number.isFinite(v)) penY = v;
            } else {
              const dy = parseLengthOr(k.getAttribute('dy') || '0', 0);
              penY += dy;
            }
            const child = resolveTspanStyle(k, parentFill, parentStroke, parentSw, parentFontFamily, parentFontSize, parentTextStyle);
            walkChunks(k, child.fillRgba, child.strokeRgba, child.sw, child.fontFamily, child.fontSize, child.textStyle);
            // openedChunk implicitly closes when sibling/parent runs
            // again — chunks remain open in order; no explicit close.
          }
        }
      };
    
      walkChunks(node, rootStyles.fillRgba, rootStyles.strokeRgba, rootStyles.sw, rootFontFamily, rootFontSize, rootTextStyle);
    
      // Per-chunk anchor shift. Each chunk's glyphs live in
      // buffered[chunks[i].start .. chunks[i+1].start). Chunk width
      // = penEnd − anchorX. Shift = 0/−W/2/−W per anchor.
      // textPath glyphs (b.positioned) are pre-warped and exempt.
      chunks[chunks.length - 1]._penEnd = penX;
      const shiftPerGlyph = new Float64Array(buffered.length);
      for (let ci = 0; ci < chunks.length; ci++) {
        const c = chunks[ci];
        const endIdx = (ci + 1 < chunks.length) ? chunks[ci + 1].start : buffered.length;
        const width = (c._penEnd ?? penX) - c.anchorX;
        let s = 0;
        if (c.anchor === 'middle') s = -width / 2;
        else if (c.anchor === 'end') s = -width;
        for (let gi = c.start; gi < endIdx; gi++) {
          shiftPerGlyph[gi] = buffered[gi].positioned ? 0 : s;
        }
      }
    
      // ---- Decoration synthesis ---------------------------------------
      // For each chunk run that requested text-decoration, emit underline
      // /overline/line-through rectangles (or wavy / dashed / dotted /
      // double per CSS Text Decoration) as synthetic FILLED shapes. The
      // run's pen extents inherit the chunk's anchor shift so decoration
      // rides with the glyphs.
      //
      // Font metrics:
      //   underlinePosition (OT post table) — distance BELOW baseline.
      //   underlineThickness                — stroke height.
      //   ascender (OS/2 hhea)              — overline anchor.
      //   xHeight × 0.5                     — line-through anchor.
      // All in em-units; user-space = em × fontSize. SVG +Y is DOWN so
      // underline (positive distance below baseline) sits at penY + uPos.
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
          const dash = thick * 4, gap = thick * 2;
          for (let x = x0; x < x1; x += dash + gap) out.push(mkRect(x, yTop, Math.min(x + dash, x1), yBot));
          return out;
        }
        if (style === 'dotted') {
          const dot = thick, gap = thick * 1.5;
          for (let x = x0; x < x1; x += dot + gap) out.push(mkRect(x, yTop, Math.min(x + dot, x1), yBot));
          return out;
        }
        if (style === 'double') {
          const t = thick * 0.4;
          out.push(mkRect(x0, yTop,             x1, yTop + t));
          out.push(mkRect(x0, yTop + t + t,     x1, yTop + t + t + t));
          return out;
        }
        // Unknown style → fall back to solid.
        out.push(mkRect(x0, yTop, x1, yBot));
        return out;
      };
      for (const run of decorationRuns) {
        const fnt = run.font;
        // Parse CSS-style `text-decoration: underline overline line-through dashed #f00`.
        // We accept space-separated keyword list. Style modifier (solid/
        // dashed/dotted/double/wavy) may appear anywhere; first match wins.
        // Color modifier is not honoured here — decoration colour follows
        // the run's fill (CSS default behaviour is `text-decoration-color: currentColor`).
        const toks = (run.decoration + '').trim().toLowerCase().split(/\s+/);
        const styleKeywords = new Set(['solid', 'dashed', 'dotted', 'double', 'wavy']);
        let decoStyle = 'solid';
        const lines = { under: false, over: false, through: false };
        for (const t of toks) {
          if (t === 'underline') lines.under = true;
          else if (t === 'overline') lines.over = true;
          else if (t === 'line-through') lines.through = true;
          else if (styleKeywords.has(t)) decoStyle = t;
        }
        const uPosEm    = (fnt && fnt.underlinePosition)  || 0.07;  // sensible fallback
        const uThickEm  = (fnt && fnt.underlineThickness) || 0.05;
        // Overline anchor — top of the ascender. Underline thickness is
        // reused as a sensible stroke height for over/through.
        const ascEm     = (fnt && fnt.ascender) || 0.8;
        const xHeightEm = (fnt && fnt.xHeight)  || 0.5;
        const thickPx   = uThickEm * run.fontSize;
        const shift     = shiftPerGlyph[run.firstGlyphIdx] || 0;
        const vertical  = (run.writingMode || 'horizontal-tb') !== 'horizontal-tb';
        if (!vertical) {
          // Horizontal: under/over/through are wide thin rects ALONG X.
          const yUnder   = run.penY + uPosEm   * run.fontSize - thickPx * 0.5;
          const yOver    = run.penY - ascEm    * run.fontSize - thickPx * 0.5;
          const yThrough = run.penY - xHeightEm * run.fontSize * 0.5 - thickPx * 0.5;
          const x0 = run.penX0 + shift;
          const x1 = run.penX1 + shift;
          const linesToEmit = [];
          if (lines.under)   linesToEmit.push(yUnder);
          if (lines.over)    linesToEmit.push(yOver);
          if (lines.through) linesToEmit.push(yThrough);
          for (const yTop of linesToEmit) {
            for (const segs of buildDecoRects(decoStyle, x0, x1, yTop, thickPx)) {
              decoShapes.push({ segs, fillRgba: run.fillRgba });
            }
          }
        } else {
          // Vertical: underline is a TALL thin rect along the right
          // edge of the column (in vertical-rl), overline along the
          // left edge, line-through bisects horizontally. The inline
          // axis is Y so x0/x1 swap roles with y0/y1.
          // x positions assume column anchored at penX=0 in glyph
          // coords (importer already translated penX with shift).
          const halfAdv = (run.fontSize * 0.5);  // approx column half-width
          const xRight  = halfAdv + uPosEm * run.fontSize - thickPx * 0.5;
          const xLeft   = -halfAdv - ascEm * run.fontSize - thickPx * 0.5;
          const xMid    = -xHeightEm * run.fontSize * 0.5 - thickPx * 0.5;
          // y0..y1 spans the run's inline-axis range (penY0..penY1).
          // penX0/penX1 in the run record carry the inline advance
          // before shift (= y advance in vertical), so reuse them.
          const y0 = run.penX0 + shift;
          const y1 = run.penX1 + shift;
          const colsToEmit = [];
          if (lines.under)   colsToEmit.push(xRight);
          if (lines.over)    colsToEmit.push(xLeft);
          if (lines.through) colsToEmit.push(xMid);
          for (const xTop of colsToEmit) {
            // Swapped buildDecoRects call: (style, y0, y1, xLeft, thick)
            // → emit tall thin rectangles. Easier to just inline a
            // minimal rect builder since style variants for vertical
            // aren't visually defined by CSS Text Decoration spec.
            const segs = [
              mkLine([xTop, y0], [xTop + thickPx, y0]),
              mkLine([xTop + thickPx, y0], [xTop + thickPx, y1]),
              mkLine([xTop + thickPx, y1], [xTop, y1]),
              mkLine([xTop, y1], [xTop, y0]),
            ];
            decoShapes.push({ segs, fillRgba: run.fillRgba });
          }
        }
      }
      const ctmIsIdent = ctm === IDENT || (ctm[0]===1 && ctm[1]===0 && ctm[2]===0 && ctm[3]===1 && ctm[4]===0 && ctm[5]===0);
      // retainSource: collect a `<path>` per glyph/decoration so the
      // retained svgSource can carry this <text>'s shapes as real path
      // elements (one per bundle shape), instead of the unexpanded
      // <text> (1 element → N shapes), which would break the native
      // fallback's positional shape→element addressing.
      const _expandColl = walkCtx.opts.retainSource ? [] : null;
      // Running index of this shape within ITS <text>'s expansion. The
      // retained svgSource replaces the <text> with one <path> PER SHAPE,
      // so the positional map must give glyph k the ordinal textLeaf+k
      // (bundleFinalize builds shapeDomIndex in that expanded-leaf space).
      let _domLeafK9 = 0;
      for (let bi = 0; bi < buffered.length; bi++) {
        const b = buffered[bi];
        const shiftX = shiftPerGlyph[bi];
        let glyphSegs = b.segs;
        if (shiftX !== 0) {
          // Translate each seg's control points by (shiftX, 0).
          const shifted = new Array(glyphSegs.length);
          for (let i = 0; i < glyphSegs.length; i++) {
            const s = glyphSegs[i];
            if      (s.type === SEG_LINE)  shifted[i] = mkLine ([s.p1[0]+shiftX,s.p1[1]],[s.p2[0]+shiftX,s.p2[1]]);
            else if (s.type === SEG_QUAD)  shifted[i] = mkQuad ([s.p1[0]+shiftX,s.p1[1]],[s.p2[0]+shiftX,s.p2[1]],[s.p3[0]+shiftX,s.p3[1]]);
            else if (s.type === SEG_CUBIC) shifted[i] = mkCubic([s.p1[0]+shiftX,s.p1[1]],[s.p2[0]+shiftX,s.p2[1]],[s.p3[0]+shiftX,s.p3[1]],[s.p4[0]+shiftX,s.p4[1]]);
          }
          glyphSegs = shifted;
        }
        if (!ctmIsIdent) {
          const xformed = [];
          for (const sg of glyphSegs) transformSegInto(sg, ctm, xformed);
          glyphSegs = xformed;
        }
        if (_expandColl) _expandColl.push({
          pathD: segsToPathD(glyphSegs),
          fill: b.fillRgba, stroke: b.strokeRgba, sw: b.sw || 0,
        });
        walkCtx.enqueueShape({
          segs: glyphSegs,
          fillRgba: b.fillRgba,
          strokeRgba: b.strokeRgba || [0, 0, 0, 0],
          sw: b.sw || 0,
          fillRule: 'nonzero',
          cap: 'butt', join: 'miter', miterLimit: 4,
          fillGradId: 0, strokeGradId: 0,
          vecPatternId: 0,
          flagsShape: 0,
          dashArray: [], dashOffset: 0,
          // Mask + clip-path resolved on the parent <text> element
          // (inherited from ancestor <g mask=> / clip-path= when
          // absent on the leaf). Every glyph row in this <text> shares
          // the same ids — clipping/masking is a property of the run,
          // not per-glyph.
          clipId: _textClipId, maskId: _textMaskId, filterId: _textFilterId,
          blendMode: 0, isolation: 0,
          imageId: 0, imageRect: [0, 0, 0, 0],
          strokeFirst: false,
          _domLeafGlyphK: _domLeafK9++,
        });
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
        if (_expandColl) _expandColl.push({
          pathD: segsToPathD(segs), fill: d.fillRgba, stroke: null, sw: 0,
        });
        walkCtx.enqueueShape({
          segs,
          fillRgba: d.fillRgba,
          strokeRgba: [0, 0, 0, 0],
          sw: 0,
          fillRule: 'nonzero',
          cap: 'butt', join: 'miter', miterLimit: 4,
          fillGradId: 0, strokeGradId: 0,
          vecPatternId: 0,
          flagsShape: 0,
          dashArray: [], dashOffset: 0,
          clipId: _textClipId, maskId: _textMaskId, filterId: _textFilterId,
          blendMode: 0, isolation: 0,
          imageId: 0, imageRect: [0, 0, 0, 0],
          strokeFirst: false,
          _domLeafGlyphK: _domLeafK9++,
        });
      }
      // Record this <text>'s expanded glyph/decoration paths (in shape
      // order) against its source DOM node, so the retainSource block in
      // importSvg can swap the <text> for the matching real <path>s.
      if (_expandColl && _expandColl.length) {
        (walkCtx.ctx._textExpansions || (walkCtx.ctx._textExpansions = [])).push({ node, paths: _expandColl });
      }
      return true;
  }
  return false;
}
