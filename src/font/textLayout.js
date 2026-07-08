// textLayout.js — line wrap, alignment, bidi itemization hooks.

import { BaseDirection } from './bidiConst.js';
import { getBidi } from './bidiRegistry.js';
import { normalizeNFC, segmentGraphemes } from './unicodeRegistry.js';
import { mirror, hasMirror } from './unicode/mirror.js';
import { emojiPresentationDefault } from './unicode/emoji.js';
import {
  getArabicShaping, getHangulShaping, getMathStretchy,
  getIndicShaping,  getThaiShaping,   getUseShaping,
} from './shaperRegistry.js';
import { isDefaultIgnorable } from './defaultIgnorable.js';

import { isCjkOpening, isCjkBreakBefore, planKashida, resolveGlyph, resolveGlyphWithSelector, isVariationSelector } from './textBreak.js';
export function layoutSlots(spans, font, layout) {
  font.getMetrics(0x20);
  const naturalLineHeight = font.ascent - font.descent + font.lineGap;
  // Per-line height resolved in the second pass (a <line-height>
  // directive can change it mid-paragraph).
  const maxWidth = layout.maxWidthEm > 0 ? layout.maxWidthEm : 0;
  const wrap = maxWidth > 0;
  // Fixed layout box width (align in a rect). Drives
  // horizontal alignment even WITHOUT wrap: a right-aligned single line
  // is pushed to the box's right edge rather than collapsing to its own
  // ink width. `0` = ink-tight behaviour. textBundle.js turns
  // this into the bundle's globalBBox so the alignment offset survives.
  const layoutBoxW = layout.layoutWidthEm > 0 ? layout.layoutWidthEm : 0;
  const defaultAlign = layout.align || 'left';
  const varCoords = layout.varCoords || null;

  // OpenType feature toggles (caller-driven). `features` opts INTO
  // GSUB lookups that are off-by-default (tnum, lnum, ss01,
  // alternate-style sets); `disabledFeatures` opts OUT of the two
  // default-on tags callers may want suppressed (`kern`, `liga`/`rlig`).
  // Built once per layoutSlots call.
  const featureTags = [];
  if (layout.features) {
    for (const tag of Object.keys(layout.features)) {
      if (layout.features[tag]) featureTags.push(tag);
    }
  }
  const disabled = (layout.disabledFeatures instanceof Set)
    ? layout.disabledFeatures
    : new Set(layout.disabledFeatures || []);
  const kernDisabled = disabled.has('kern');
  const ligaDisabled = disabled.has('liga') || disabled.has('rlig');

  const lines = [];
  const lineAdvances = [];
  const lineAlignOverride = [];
  const lineHeights = [];
  const lineUsableMaxes = [];
  let curLine = [];
  let curLineAdv = 0;
  let curLineAlign = null;
  let pendingAlign = null;
  let currentIndent = 0;
  let currentLineIndent = 0;               // single-shot, resets at line break
  let currentMarginLeft = 0;
  let currentMarginRight = 0;
  let currentLineHeightOverride = 0;       // 0 = use default
  let pendingPosOverride = null;           // null = no override
  let lastBreakIdx = -1;     // any break candidate (space, CJK char, CJK word-start)
  let lastBreakAdv = 0;
  let lastWordBreakIdx = -1; // preferred candidate (word-start or space)
  let lastWordBreakAdv = 0;

  const lineStartX = () => currentMarginLeft + currentIndent + currentLineIndent;
  const lineUsableMax = () => wrap ? (maxWidth - currentMarginRight) : 0;

  const endLine = () => {
    lines.push(curLine);
    lineAdvances.push(curLineAdv);
    lineAlignOverride.push(curLineAlign);
    lineHeights.push(currentLineHeightOverride);
    lineUsableMaxes.push(lineUsableMax());
    if (pendingAlign != null) { curLineAlign = pendingAlign; pendingAlign = null; }
    // <line-indent> single-shot — resets at line break.
    currentLineIndent = 0;
    curLine = [];
    curLineAdv = lineStartX();
    lastBreakIdx = -1;
    lastBreakAdv = 0;
    lastWordBreakIdx = -1;
    lastWordBreakAdv = 0;
  };

  // Per-slot fonts: layout.fallbacks (if non-empty) is an ordered
  // list walked when the primary has no glyph for a codepoint. Each
  // slot stores its resolved font; GSUB/GPOS/metrics use that font.
  const fallbacks = (layout.fallbacks && layout.fallbacks.length > 0) ? layout.fallbacks : null;

  curLineAdv = lineStartX();

  for (const span of spans) {
    // Directive span — apply layout commands, emit no glyphs.
    const d = span.directive;
    if (d && (d.hasAlign || d.hasIndent || d.hasPos || d.hasLineHeight ||
              d.hasLineIndent || d.hasMarginLeft || d.hasMarginRight)) {
      if (d.hasAlign) pendingAlign = d.align;
      if (d.hasIndent) {
        currentIndent = d.indentEm || 0;
        if (curLine.length === 0) curLineAdv = lineStartX();
      }
      if (d.hasLineIndent) {
        currentLineIndent = d.lineIndentEm || 0;
        if (curLine.length === 0) curLineAdv = lineStartX();
      }
      if (d.hasMarginLeft) {
        currentMarginLeft = d.marginLeftEm || 0;
        if (curLine.length === 0) curLineAdv = lineStartX();
      }
      if (d.hasMarginRight) {
        currentMarginRight = d.marginRightEm || 0;
      }
      if (d.hasPos) {
        pendingPosOverride = d.posEm || 0;
      }
      if (d.hasLineHeight) {
        currentLineHeightOverride = d.lineHeightEm || 0;
      }
      continue;
    }

    if (!span.text) continue;

    // NFC-normalize before tokenizing. Routed through the Unicode registry:
    // platform String.prototype.normalize by default, or the shipped UAX #15
    // table engine when "@kontek/mantle/font/unicode" is registered (and the
    // platform is behind/unavailable).
    const normalized = normalizeNFC(span.text);

    // <b>/<i> font-variant swap. When the span's style has bold
    // or italic AND the caller wired the matching font variant on
    // layout.{bold,italic,boldItalic}Font, use that as the span's
    // primary. When the matching variant is NOT wired, fall back to
    // synthesis: italic via shear, bold via stroke-rendering.
    let spanFont = font;
    let synthBold = false;
    let synthItalic = false;
    if (span.style.bold && span.style.italic) {
      if (layout.boldItalicFont) spanFont = layout.boldItalicFont;
      else if (layout.boldFont)   { spanFont = layout.boldFont;   synthItalic = true; }
      else if (layout.italicFont) { spanFont = layout.italicFont; synthBold = true; }
      else                        { synthBold = synthItalic = true; }
    } else if (span.style.bold) {
      if (layout.boldFont) spanFont = layout.boldFont;
      else                 synthBold = true;
    } else if (span.style.italic) {
      if (layout.italicFont) spanFont = layout.italicFont;
      else                   synthItalic = true;
    }

    // Build cps/gids/fonts parallel with cluster-start + word-start
    // flags. Per-cluster font resolution: pick the font for the
    // cluster's first codepoint, then keep all cps of that cluster on
    // the same font so ZWJ chains and combining marks share GSUB/GPOS
    // tables.
    //
    // Word-start flags come from Intl.Segmenter('word') — ICU-quality
    // CJK morphological segmentation in browsers.
    const cps = [];
    const gids = [];
    const clusterStarts = [];
    const wordStarts = [];
    const fonts = [];
    // Precompute UTF-16 indices of word starts so we can flag them
    // during the cp walk. Each Segmenter result's .index is a UTF-16
    // offset; we mark the cp whose UTF-16 position matches.
    const wordStartSet = new Set();
    // Word boundaries are a wrap HINT only (non-output-critical); keep them on
    // the platform segmenter and degrade gracefully if it is absent.
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      const wseg = new Intl.Segmenter(undefined, { granularity: 'word' });
      for (const w of wseg.segment(normalized)) {
        // We only care about word-LIKE boundaries — punctuation
        // segments (e.g. the period between sentences) shouldn't
        // become break candidates on their own.
        if (w.isWordLike) wordStartSet.add(w.index);
      }
    }
    // Grapheme clustering DOES affect output (shaping cluster runs); route it
    // through the registry so it can fall back to the UAX #29 table engine.
    let utf16Pos = 0;
    for (const segment of segmentGraphemes(normalized)) {
      let firstOfCluster = true;
      let clusterFont = null;
      // Materialize the cluster's codepoints so the base can look ahead
      // to a trailing Unicode variation selector (VS1–16 / IVS).
      const segCps = [...codepoints(segment)];
      // We track a per-codepoint UTF-16 position. Each codepoint is
      // 1 unit (BMP) or 2 units (surrogate pair).
      for (let ci = 0; ci < segCps.length; ci++) {
        const cp = segCps[ci];
        cps.push(cp);
        let chosen, gid;
        if (cp === 0x0A) { chosen = spanFont; gid = 0; }
        else if (firstOfCluster) {
          // Unicode Variation Sequence: a base immediately followed by a
          // variation selector (e.g. base + U+FE0F → emoji presentation,
          // or a CJK ideograph + IVS selector) resolves via the font's
          // format-14 cmap. The selector itself is hidden downstream as a
          // default-ignorable.
          const nextCp = ci + 1 < segCps.length ? segCps[ci + 1] : 0;
          if (nextCp && isVariationSelector(nextCp)) {
            [chosen, gid] = resolveGlyphWithSelector(cp, nextCp, spanFont, fallbacks);
          } else if (emojiPresentationDefault(cp)) {
            // Emoji-presentation-default codepoint with no explicit selector:
            // try an implicit emoji selector (VS16) so dual-form characters
            // prefer their emoji glyph; resolveGlyphWithSelector falls back to
            // the plain base glyph when the font has no such UVS entry.
            [chosen, gid] = resolveGlyphWithSelector(cp, 0xfe0f, spanFont, fallbacks);
          } else {
            [chosen, gid] = resolveGlyph(cp, spanFont, fallbacks);
          }
          clusterFont = chosen;
        } else {
          chosen = clusterFont;
          gid = chosen.codepointToGlyphId(cp);
        }
        gids.push(gid);
        fonts.push(chosen);
        clusterStarts.push(firstOfCluster);
        wordStarts.push(wordStartSet.has(utf16Pos));
        utf16Pos += cp > 0xFFFF ? 2 : 1;
        firstOfCluster = false;
      }
    }

    // AAT 'morx' shaping. AAT-only fonts (Zapfino, Hoefler Text, Apple
    // Chancery, …) carry no GSUB and form ligatures / contextual forms
    // through morx instead. Apply it per maximal same-font run so mixed-
    // font fallback still composes, then rebuild the parallel arrays from
    // morx's source map (a ligature inherits its first component's
    // codepoint / cluster / word-start; an inserted glyph its neighbor's).
    // The GSUB passes below then no-op on these fonts (null GSUB).
    if (fonts.some((f) => f.usesAatShaping)) {
      const nCps = [], nGids = [], nClusterStarts = [], nWordStarts = [], nFonts = [];
      let ri = 0;
      while (ri < gids.length) {
        const f = fonts[ri];
        let rj = ri; while (rj < gids.length && fonts[rj] === f) rj++;
        if (f.usesAatShaping) {
          const { gids: outGids, src } = f.applyAatShaping(gids.slice(ri, rj));
          for (let k = 0; k < outGids.length; k++) {
            const s = ri + src[k];
            nGids.push(outGids[k]);
            nCps.push(cps[s]);
            nClusterStarts.push(clusterStarts[s]);
            nWordStarts.push(wordStarts[s]);
            nFonts.push(f);
          }
        } else {
          for (let k = ri; k < rj; k++) {
            nGids.push(gids[k]); nCps.push(cps[k]);
            nClusterStarts.push(clusterStarts[k]); nWordStarts.push(wordStarts[k]); nFonts.push(fonts[k]);
          }
        }
        ri = rj;
      }
      cps.length = 0; cps.push(...nCps);
      gids.length = 0; gids.push(...nGids);
      clusterStarts.length = 0; clusterStarts.push(...nClusterStarts);
      wordStarts.length = 0; wordStarts.push(...nWordStarts);
      fonts.length = 0; fonts.push(...nFonts);
    }

    // SmallCaps substitution (GSUB lookup 1). Runs BEFORE ligatures so
    // "fi" inside <smallcaps> first becomes (smallcap-f, smallcap-i)
    // then liga checks among those. With fallback, smcp runs against
    // each slot's own GSUB (a fallback font may have smcp where primary
    // doesn't).
    if (span.style.smallCaps) {
      for (let gi = 0; gi < gids.length; gi++) {
        const g = gids[gi];
        if (g === 0) continue;
        const fGsub = fonts[gi].gsub;
        if (!fGsub || !fGsub.hasSmallCaps) continue;
        gids[gi] = fGsub.substituteSmallCap(g);
      }
    }

    // 'ccmp' pre-shaping pass — glyph composition/decomposition. Some
    // Arabic fonts pre-decompose precomposed alef-with-hamza into
    // alef + hamza so subsequent shaping can see the components.
    // Runs FIRST in the GSUB chain (canonical OT ordering: ccmp →
    // locl → isol/init/medi/fina → liga/rlig).
    {
      const newCps = [], newGids = [], newClusterStarts = [], newWordStarts = [], newFonts = [];
      for (let i = 0; i < gids.length; i++) {
        const fGsub = fonts[i].gsub;
        const g = gids[i];
        const hit = (fGsub && fGsub.hasCcmp && g !== 0) ? fGsub.tryMatchCcmp(gids, i) : null;
        if (hit && hit.replacements.length > 0) {
          // Replace gid[i] with hit.replacements (1 or N gids). The
          // codepoint, cluster-start, word-start, font stay attached
          // to the FIRST replacement; subsequent replacements inherit
          // font + a fresh "non-cluster-start" so transparent rules
          // skip them.
          for (let r = 0; r < hit.replacements.length; r++) {
            newGids.push(hit.replacements[r]);
            newCps.push(r === 0 ? cps[i] : 0);
            newClusterStarts.push(r === 0 ? clusterStarts[i] : false);
            newWordStarts.push(r === 0 ? wordStarts[i] : false);
            newFonts.push(fonts[i]);
          }
        } else {
          newCps.push(cps[i]);
          newGids.push(gids[i]);
          newClusterStarts.push(clusterStarts[i]);
          newWordStarts.push(wordStarts[i]);
          newFonts.push(fonts[i]);
        }
      }
      cps.length = 0; cps.push(...newCps);
      gids.length = 0; gids.push(...newGids);
      clusterStarts.length = 0; clusterStarts.push(...newClusterStarts);
      wordStarts.length = 0; wordStarts.push(...newWordStarts);
      fonts.length = 0; fonts.push(...newFonts);
    }

    // Arabic positional form substitution (init/medi/fina/isol).
    // Runs BEFORE ligatures so the lam-alef ligature lookup (which
    // applies the final form's lam + alef as a single glyph) sees the
    // form-substituted gids. Joining-context is resolved over the
    // ORIGINAL codepoint stream so transparent marks act correctly
    // around their cluster base. Per-cp font lookup means a fallback
    // font's Arabic GSUB can apply where the primary lacks it.
    const _arabic = getArabicShaping();
    if (_arabic && cps.some(_arabic.isArabicCodepoint)) {
      const forms = _arabic.resolveArabicForms(cps);
      for (let gi = 0; gi < gids.length; gi++) {
        const g = gids[gi];
        if (g === 0) continue;
        const fGsub = fonts[gi].gsub;
        if (!fGsub || !fGsub.hasArabicForms) continue;
        gids[gi] = fGsub.substituteArabicForm(g, forms[gi]);
      }
    }

    // Hangul jamo positional form substitution (ljmo/vjmo/tjmo).
    // Runs over raw Hangul Jamo codepoints (U+1100..U+11FF) that NFC
    // couldn't compose into precomposed syllables — Old Korean and
    // archaic jamo combinations. Modern Korean text reaches us as
    // precomposed Hangul Syllables (U+AC00..U+D7A3) which go through
    // cmap directly and don't need this pass.
    const _hangul = getHangulShaping();
    if (_hangul && cps.some(_hangul.isHangulJamo)) {
      for (let gi = 0; gi < gids.length; gi++) {
        const g = gids[gi];
        if (g === 0) continue;
        const role = _hangul.classifyHangulJamo(cps[gi]);
        if (role == null) continue;
        const fGsub = fonts[gi].gsub;
        if (!fGsub || !fGsub.hasHangulJamoForms) continue;
        gids[gi] = fGsub.substituteHangulJamo(g, role);
      }
    }

    // Indic shaping (10 scripts). Per OpenType Indic2:
    //   1. Pre-reorder GSUB features applied per-syllable (in canonical
    //      order): nukt, akhn, rphf, rkrf, pref, blwf, half, vatu, cjct.
    //   2. Per-syllable reorder: pre-base matras move to position 0;
    //      initial reph moves to syllable end (with explicit-reph
    //      awareness since rphf may have collapsed ra+halant into 1 gid).
    //   3. Post-reorder GSUB features per-glyph (type-1):
    //      pres, abvs, blws, psts, haln, calt.
    const _indic = getIndicShaping();
    if (_indic && cps.some(_indic.isIndicCodepoint)) {
      const PRE_FEATURES  = ['nukt','akhn','rphf','rkrf','pref','blwf','half','vatu','cjct'];
      const POST_FEATURES = ['pres','abvs','blws','psts','haln','calt'];
      const syllables = _indic.findIndicSyllables(cps);
      const newCps = [], newGids = [], newClusterStarts = [], newWordStarts = [], newFonts = [];
      for (const { start, end } of syllables) {
        // Snapshot syllable state BEFORE features run. The reph
        // detector reads pre-feature cps because rphf may have
        // collapsed (ra, halant) into a single glyph, hiding the
        // halant signal.
        const origCps = [];
        for (let k = start; k < end; k++) origCps.push(cps[k]);
        const hadReph = _indic.hasInitialReph(origCps, 0, origCps.length);

        // Parallel arrays + origLow tracks each glyph's first-source
        // position so we can compute post-feature rephLen.
        let sCps = [], sGids = [], sClusters = [], sWords = [], sFonts = [], sOrigLow = [];
        for (let k = start; k < end; k++) {
          sCps.push(cps[k]);
          sGids.push(gids[k]);
          sClusters.push(clusterStarts[k]);
          sWords.push(wordStarts[k]);
          sFonts.push(fonts[k]);
          sOrigLow.push(k - start);
        }
        const fGsub = sFonts[0].gsub;
        const hasIndic = fGsub && fGsub.hasIndicFeatures;

        // Pre-reorder feature application.
        if (hasIndic) {
          for (const tag of PRE_FEATURES) {
            const lookups = fGsub._indicLookupsByTag(tag);
            if (!lookups || lookups.length === 0) continue;
            let i = 0;
            const outCps = [], outGids = [], outClusters = [], outWords = [], outFonts = [], outOrigLow = [];
            while (i < sGids.length) {
              if (sGids[i] === 0) {
                outCps.push(sCps[i]); outGids.push(sGids[i]);
                outClusters.push(sClusters[i]); outWords.push(sWords[i]);
                outFonts.push(sFonts[i]); outOrigLow.push(sOrigLow[i]);
                i++; continue;
              }
              const slice = sGids.slice(i);
              const hit = fGsub.tryMatchIndicLigature(tag, slice, 0);
              if (hit && hit.consumed > 0 && i + hit.consumed <= sGids.length) {
                outCps.push(sCps[i]);
                outGids.push(hit.replacement);
                outClusters.push(sClusters[i]);
                outWords.push(sWords[i]);
                outFonts.push(sFonts[i]);
                outOrigLow.push(sOrigLow[i]);
                i += hit.consumed;
              } else {
                const subbed = fGsub.substituteIndicSingle(sGids[i], tag);
                outCps.push(sCps[i]);
                outGids.push(subbed);
                outClusters.push(sClusters[i]);
                outWords.push(sWords[i]);
                outFonts.push(sFonts[i]);
                outOrigLow.push(sOrigLow[i]);
                i++;
              }
            }
            sCps = outCps; sGids = outGids;
            sClusters = outClusters; sWords = outWords; sFonts = outFonts;
            sOrigLow = outOrigLow;
          }
        }

        // Compute rephLen post-features and reorder.
        let rephLen = 0;
        if (hadReph) {
          for (let i = 0; i < sOrigLow.length; i++) {
            if (sOrigLow[i] < 2) rephLen++;
            else break;
          }
        }
        const sylOrder = _indic.reorderSyllableExplicitReph(sCps, 0, sCps.length, hadReph, rephLen);
        const reCps = [], reGids = [], reClusters = [], reWords = [], reFonts = [];
        for (const idx of sylOrder) {
          reCps.push(sCps[idx]);
          reGids.push(sGids[idx]);
          reClusters.push(sClusters[idx]);
          reWords.push(sWords[idx]);
          reFonts.push(sFonts[idx]);
        }
        sCps = reCps; sGids = reGids;
        sClusters = reClusters; sWords = reWords; sFonts = reFonts;

        // Post-reorder feature application.
        if (hasIndic) {
          for (const tag of POST_FEATURES) {
            for (let i = 0; i < sGids.length; i++) {
              if (sGids[i] === 0) continue;
              sGids[i] = fGsub.substituteIndicSingle(sGids[i], tag);
            }
          }
        }

        for (let k = 0; k < sCps.length; k++) {
          newCps.push(sCps[k]);
          newGids.push(sGids[k]);
          newClusterStarts.push(sClusters[k]);
          newWordStarts.push(sWords[k]);
          newFonts.push(sFonts[k]);
        }
      }
      cps.length = 0; cps.push(...newCps);
      gids.length = 0; gids.push(...newGids);
      clusterStarts.length = 0; clusterStarts.push(...newClusterStarts);
      wordStarts.length = 0; wordStarts.push(...newWordStarts);
      fonts.length = 0; fonts.push(...newFonts);
    }

    // Thai/Lao shaping. Two passes:
    //   1. SARA AM decomposition (U+0E33 → U+0E32 + U+0E4D for Thai,
    //      U+0EB3 → U+0EB2 + U+0ECD for Lao). NFC keeps SARA AM
    //      composed, but some fonts only glyph the decomposed pair —
    //      this mirrors what OT 'ccmp' would do.
    //   2. Pre-base vowel reorder: 5 Thai vowels (U+0E40..U+0E44) and
    //      5 Lao vowels (U+0EC0..U+0EC4) appear AFTER the consonant in
    //      memory but render visually BEFORE. We swap each
    //      (consonant, pre-vowel) pair in the parallel arrays.
    //   GPOS mark attachment for Thai/Lao tone marks + above/below
    //   vowels rides the mark-attachment slot loop via the isMarkAt()
    //   predicate.
    const _thai = getThaiShaping();
    if (_thai && cps.some(_thai.isThaiLaoCodepoint)) {
      // Decompose SARA AM. The decomposed halves re-resolve their gid
      // via cmap (see below); the pair shares a single source-cp's
      // metadata (cluster/word/font).
      const decomp = _thai.decomposeSaraAm(cps);
      if (decomp.cps.length !== cps.length) {
        // Stream length changed: rebuild parallel arrays.
        const newCps = [], newGids = [], newClusterStarts = [], newWordStarts = [], newFonts = [];
        for (let i = 0; i < decomp.cps.length; i++) {
          const src = decomp.origLow[i];
          const outCp = decomp.cps[i];
          newCps.push(outCp);
          // For the FIRST half (SARA AA), reuse the source's gid
          // (font's SARA AM glyph) iff decomposition wasn't applied;
          // for the actual decomposed halves we re-resolve via cmap.
          let outGid = gids[src];
          if (outCp !== cps[src]) {
            outGid = fonts[src].codepointToGlyphId(outCp);
          }
          newGids.push(outGid);
          // Cluster-start only on the first emitted half.
          const firstHalf = (i === 0) || (decomp.origLow[i - 1] !== src);
          newClusterStarts.push(firstHalf ? clusterStarts[src] : false);
          newWordStarts.push(firstHalf ? wordStarts[src] : false);
          newFonts.push(fonts[src]);
        }
        cps.length = 0; cps.push(...newCps);
        gids.length = 0; gids.push(...newGids);
        clusterStarts.length = 0; clusterStarts.push(...newClusterStarts);
        wordStarts.length = 0; wordStarts.push(...newWordStarts);
        fonts.length = 0; fonts.push(...newFonts);
      }

      // Pre-base vowel reorder. Operates on the (now-decomposed) cps
      // array; permutes all parallel arrays.
      const ord = _thai.reorderThaiLao(cps);
      // Skip rebuild when identity (no pre-base vowels found).
      let identity = true;
      for (let i = 0; i < ord.length; i++) if (ord[i] !== i) { identity = false; break; }
      if (!identity) {
        const newCps = [], newGids = [], newClusterStarts = [], newWordStarts = [], newFonts = [];
        for (let i = 0; i < ord.length; i++) {
          const src = ord[i];
          newCps.push(cps[src]);
          newGids.push(gids[src]);
          newClusterStarts.push(clusterStarts[src]);
          newWordStarts.push(wordStarts[src]);
          newFonts.push(fonts[src]);
        }
        cps.length = 0; cps.push(...newCps);
        gids.length = 0; gids.push(...newGids);
        clusterStarts.length = 0; clusterStarts.push(...newClusterStarts);
        wordStarts.length = 0; wordStarts.push(...newWordStarts);
        fonts.length = 0; fonts.push(...newFonts);
      }
    }

    // USE shaping (Khmer + Myanmar + Tibetan + other USE scripts).
    // Per-cluster reorder like Indic but with USE's coarser grammar:
    // find cluster boundaries, per-cluster pre-base matra reorder +
    // Myanmar kinzi-to-end. The shared Indic GSUB feature pipeline
    // handles nukt/blwf/half/pres/abvs/etc.; USE-specific features
    // (abvf/pstf/cfar) ride the same dispatch via _indicLookupsByTag.
    const _use = getUseShaping();
    if (_use && cps.some(_use.isUseCodepoint)) {
      const clusters = _use.findUseClusters(cps);
      const newCps = [], newGids = [], newClusterStarts = [], newWordStarts = [], newFonts = [];
      for (const { start, end } of clusters) {
        const order = _use.reorderUseCluster(cps, start, end);
        for (const absIdx of order) {
          newCps.push(cps[absIdx]);
          newGids.push(gids[absIdx]);
          newClusterStarts.push(clusterStarts[absIdx]);
          newWordStarts.push(wordStarts[absIdx]);
          newFonts.push(fonts[absIdx]);
        }
      }
      cps.length = 0; cps.push(...newCps);
      gids.length = 0; gids.push(...newGids);
      clusterStarts.length = 0; clusterStarts.push(...newClusterStarts);
      wordStarts.length = 0; wordStarts.push(...newWordStarts);
      fonts.length = 0; fonts.push(...newFonts);
    }

    // Ligature pass — only within runs of same-font glyphs.
    // We also track per-glyph ligComponents: when a glyph was produced
    // by a type-4 ligature substitution, this records the count of
    // logical input components (≥2 on ligatures, 1 otherwise). MarkLigPos
    // (GPOS type 5) reads this to know how many "slots" the base
    // ligature spans, then attaches a following mark to the right
    // component. ligComponents stays 1 for non-ligature glyphs so the
    // downstream code can treat it uniformly.
    const ligComponents = new Array(gids.length).fill(1);
    if (!ligaDisabled) {
      const newCps = [], newGids = [], newClusterStarts = [], newWordStarts = [], newFonts = [], newLigComps = [];
      let i = 0;
      while (i < gids.length) {
        const fGsub = fonts[i].gsub;
        const tryLiga = fGsub && fGsub.hasLigatures && gids[i] !== 0;
        // Find longest run of same-font glyphs starting at i.
        let runEnd = i + 1;
        while (runEnd < gids.length && fonts[runEnd] === fonts[i]) runEnd++;
        // Slice gids to that run so liga lookup can't straddle fonts.
        let runSlice = gids;
        let runOffset = i;
        if (runEnd !== gids.length) {
          runSlice = gids.slice(i, runEnd);
          runOffset = 0;
        }
        const hit = tryLiga ? fGsub.tryMatchLigature(runSlice, runOffset) : null;
        if (hit && hit.consumed > 0 && i + hit.consumed <= runEnd) {
          newGids.push(hit.replacement);
          newCps.push(cps[i]);
          newClusterStarts.push(clusterStarts[i]);
          newWordStarts.push(wordStarts[i]);
          newFonts.push(fonts[i]);
          newLigComps.push(hit.consumed);
          i += hit.consumed;
        } else {
          newGids.push(gids[i]);
          newCps.push(cps[i]);
          newClusterStarts.push(clusterStarts[i]);
          newWordStarts.push(wordStarts[i]);
          newFonts.push(fonts[i]);
          newLigComps.push(1);
          i++;
        }
      }
      ligComponents.length = 0; ligComponents.push(...newLigComps);
      cps.length = 0; cps.push(...newCps);
      gids.length = 0; gids.push(...newGids);
      clusterStarts.length = 0; clusterStarts.push(...newClusterStarts);
      wordStarts.length = 0; wordStarts.push(...newWordStarts);
      fonts.length = 0; fonts.push(...newFonts);
    }

    // Caller-opted-in GSUB features (tnum, lnum, ss01, salt, etc.).
    // Each tag runs across same-font runs of glyph ids — feature
    // lookups are font-local, same constraint that gates the
    // ligature pass above. Per-tag, per-run we hand the slice to
    // `applyFeatureToSeq` (a one-shot lookup-chain walker that
    // returns the input unchanged when the font doesn't ship that
    // feature, so unknown tags or partial-coverage fonts no-op
    // silently). Glyph COUNT is preserved by all the substitution
    // types this list realistically uses (tnum/lnum/onum/sups/subs/
    // smcp/cv01/ss01..ss20/salt → GSUB type 1 single-substitution);
    // when a tag's lookups happen to be type 4 ligatures we still
    // hand the run through unchanged on length mismatch, so the
    // parallel arrays (cps / fonts / clusterStarts / etc.) stay in
    // sync.
    if (featureTags.length > 0 && gids.length > 0) {
      let i = 0;
      while (i < gids.length) {
        let runEnd = i + 1;
        while (runEnd < gids.length && fonts[runEnd] === fonts[i]) runEnd++;
        const fGsub = fonts[i].gsub;
        if (fGsub) {
          let slice = gids.slice(i, runEnd);
          const before = slice.length;
          for (const tag of featureTags) {
            if (!fGsub.hasFeature(tag)) continue;
            const out = fGsub.applyFeatureToSeq(tag, slice);
            // Glyph-count change → skip this tag for this run (lookup
            // type 4/ligature inside a non-ligature feature is rare
            // but defensible to bail rather than re-sync the parallel
            // arrays). Type 1 / type 2 / single-substitution chains
            // preserve count.
            if (out.length === before) slice = out;
          }
          for (let k = 0; k < slice.length; k++) gids[i + k] = slice[k];
        }
        i = runEnd;
      }
    }

    let prevGid = 0;
    let prevCp = 0;   // tracks LB14: don't break after CJK opening punct
    let prevFont = null;
    for (let idx = 0; idx < gids.length; idx++) {
      const cp = cps[idx];
      let gid = gids[idx];
      const slotFont = fonts[idx];
      if (cp === 0x0A) { endLine(); prevGid = 0; prevCp = 0; prevFont = null; continue; }

      // Unicode Default_Ignorable_Code_Point hiding (HarfBuzz parity).
      // Variation selectors (FE00–FE0F, E0100–E01EF), ZWJ/ZWNJ, ZWSP,
      // soft hyphen, BOM, bidi controls, etc. that reach layout without
      // being consumed by shaping must render as zero-advance, zero-ink
      // — never as a `.notdef` tofu box. We mark the slot `ignorable`
      // (emit path skips its outline) and force advance 0 below, and
      // keep it transparent to kerning / break context so it behaves
      // like the invisible character it is.
      const isIgnorable = isDefaultIgnorable(cp);

      // OT MATH stretchy variant substitution — codepoint-driven.
      // Some math codepoints render at a larger stretchy variant
      // without any markup or display-mode flag:
      //   - Always-stretchy single codepoints (overbrace U+23DE,
      //     underbrace U+23DF, top-square-bracket U+23B4 etc.)
      //   - Display-size N-ary operators (∑ ∫ ∏ ⋃ ⋂ ⨁ etc.) which
      //     should pull MathConstants.displayOperatorMinHeight
      // Substitute the gid BEFORE metric queries so advance/italic-
      // correction/etc. use the variant's values.
      //
      // When the target exceeds even the largest pre-built variant,
      // we ask the reader to BUILD AN ASSEMBLY — a recipe of stacked
      // parts that together cover the target size. The emit path
      // below renders one shape per part at the right offset.
      let slotMathAssembly = null;
      const _math = getMathStretchy();
      if (_math && gid !== 0 && slotFont.math.hasTable && slotFont.math.hasMathVariants &&
          _math.isCodepointStretchy(cp)) {
        const constants = slotFont.math.getConstants();
        const target = _math.targetStretchHeight(cp, constants);
        if (target > 0) {
          const axis = _math.isAlwaysStretchy(cp, 'h') ? 'h' : 'v';
          // First try pre-built variants — fastest path, single gid.
          const variantGid = slotFont.math.pickVariantForSize(gid, target, axis);
          gid = variantGid;
          // If the picked variant still isn't big enough, AND the font
          // ships an assembly recipe, switch to assembly emit.
          // pickVariantForSize falls back to the largest pre-built when
          // none cover — so we re-check its advance.
          const variantAdv = slotFont.getMetricsByGid(variantGid).advance
                             * slotFont.unitsPerEm;
          const targetAxisAdv = target;  // already in font units (height for the v-axis)
          if (variantAdv < targetAxisAdv) {
            const asm = slotFont.math.buildAssembly(gid, target, axis);
            if (asm && asm.parts.length > 1) {
              slotMathAssembly = { axis, asm };
            }
          }
        }
      }

      // Per-slot metrics — every em-space quantity normalizes by THIS
      // font's unitsPerEm so mixed-font runs compose correctly.
      const slotInvUpem = slotFont.unitsPerEm > 0 ? 1 / slotFont.unitsPerEm : 0;
      // `disabledFeatures: ['kern']` opts out of pair-kerning AND of
      // GPOS SinglePos xAdvance deltas. Both are kern-family
      // adjustments — the SinglePos delta is what GPOS calls the
      // per-glyph X-advance shift, which a caller wanting tabular
      // figures expects suppressed alongside pair kerning.
      const slotKern = !kernDisabled && slotFont.hasAnyKerning;

      const sizeScale = span.style.sizeScale;
      const widthScale = span.style.widthScale > 0 ? span.style.widthScale : 1;
      // Variation-aware advance when layout.varCoords is supplied for a
      // variable font; getGlyphAdvanceVar resolves HVAR → gvar phantom points
      // → static internally (so HVAR-less VFs still vary). Non-variable / no
      // coords fall back to static hmtx via getMetricsByGid.
      const natAdv = (varCoords != null && slotFont.isVariable)
        ? slotFont.getGlyphAdvanceVar(gid, varCoords)
        : slotFont.getMetricsByGid(gid).advance;
      // GPOS SinglePos (lookup type 1) xAdvance delta — composed
      // additively with the natural advance before width-scaling.
      const singlePosFu = (slotKern && gid !== 0) ? slotFont.gpos.getSingleXAdvanceDelta(gid) : 0;
      const singlePosDelta = singlePosFu * slotInvUpem;
      // OT MATH italic correction — for math-equipped fonts, slanted
      // math italic glyphs (U+1D400..U+1D7FF range) carry an italic-
      // correction value that adds extra X advance so the next glyph
      // doesn't overlap the slant. Real strings like '𝑓+' or '𝑓(𝑥)'
      // need this; ASCII fonts return 0 (no MATH table). HarfBuzz's
      // simple model: always add to advance; explicit kern between
      // italic+italic pairs can subtract if needed.
      // italicCorrFu is in FONT UNITS; natAdv is in EM units (already
      // / unitsPerEm). Scale to em.
      const italicCorrFu = (gid !== 0 && slotFont.math.hasTable)
        ? slotFont.math.getItalicCorrection(gid)
        : 0;
      const italicCorrEm = italicCorrFu * slotInvUpem;
      const mspace = span.style.mspaceEm || 0;
      const cspace = span.style.cspaceEm || 0;
      const adv = isIgnorable
        ? 0
        : mspace > 0
        ? mspace * sizeScale
        : ((natAdv + singlePosDelta + italicCorrEm) * widthScale + cspace) * sizeScale;

      // Pair kerning — only between same-font adjacent slots (kerning
      // pairs are font-local; no cross-font kern).
      const posPending = pendingPosOverride !== null;
      if (!posPending && mspace <= 0 && slotKern && !isIgnorable
          && prevGid !== 0 && gid !== 0 && prevFont === slotFont) {
        const kFu = slotFont.getPairKerningFu(prevGid, gid);
        if (kFu !== 0) curLineAdv += kFu * slotInvUpem * widthScale * sizeScale;
      }

      // Single-shot <pos> override: place this glyph at PosEm.
      if (posPending) {
        curLineAdv = pendingPosOverride;
        pendingPosOverride = null;
      }

      // BreakKind: 0 none, 1 at-slot-drop (space), 2 before-slot (CJK).
      // TR#14 LB14: don't break BETWEEN an opening punct and the
      // codepoint that follows it. Cluster gate: BeforeSlot breaks
      // require a grapheme-cluster boundary so ZWJ chains stay intact.
      const isSpace = cp === 0x20 || cp === 0x09;
      const isCjk = isCjkBreakBefore(cp);
      const clusterStart = clusterStarts[idx];
      const wordStart = wordStarts[idx];
      const lb14Block = isCjkOpening(prevCp);
      let breakKind = 0;
      if (!span.style.nobr && !lb14Block) {
        if (isSpace) breakKind = 1;
        else if (isCjk && clusterStart) breakKind = 2;
      }

      // GPOS mark attachment: when this glyph's codepoint is a
      // Transparent Arabic mark (harakat / Quranic annotation), set
      // an `attachToIdx` pointer + (dxEm, dyEm) offset on the slot.
      // Final penX/penY are resolved AFTER bidi reorder so that
      // reordering doesn't clobber the mark's anchor link to its
      // base. A mark slot also has advance=0 (the pen doesn't move).
      //
      // Mark stacking: a mark following another mark goes through
      // the 'mkmk' lookup against the previous mark; non-stacked
      // marks go through 'mark' against the preceding non-mark.
      let slotAdvance = adv;
      let attachToIdx = -1;   // index INTO THIS LINE to anchor against
      let attachDxEm = 0;
      let attachDyEm = 0;
      // Mark detection. A codepoint is a "mark" for GPOS attachment
      // purposes if it has no advance of its own and anchors on a base:
      //   - Arabic transparent harakat / Quranic annotation marks
      //   - Thai/Lao tone marks + above/below vowels
      //   - Combining marks for symbols (U+20D0..U+20FF) — math accents
      //     like \hat{x}, \vec{x}, etc.
      // The Arabic + Thai predicates dereference the registry; when a
      // script isn't registered, that script's mark contribution is 0
      // (correct: if the consumer didn't enable Arabic shaping they
      // won't have Arabic content needing transparent-mark anchoring).
      const _arabicMark = getArabicShaping();
      const _thaiMark   = getThaiShaping();
      const isMathMark = (c) => c >= 0x20D0 && c <= 0x20FF;
      const isArMark = _arabicMark
        ? (_arabicMark.getArabicJoiningType(cp) === _arabicMark.ArabicJoiningType.T)
        : false;
      const isThaiMark = _thaiMark ? _thaiMark.isThaiLaoMark(cp) : false;
      const isMarkCp = isArMark || isThaiMark || isMathMark(cp);
      const isMarkAt = (cp) =>
        (_arabicMark && _arabicMark.getArabicJoiningType(cp) === _arabicMark.ArabicJoiningType.T) ||
        (_thaiMark   && _thaiMark.isThaiLaoMark(cp)) ||
        isMathMark(cp);
      if (isMarkCp && curLine.length > 0 && gid !== 0) {
        // Find preceding non-mark slot AND immediate previous slot.
        let prevSlotIdx = -1, prevSlot = null;
        let lastBaseIdx = -1, lastBaseSlot = null;
        for (let j = curLine.length - 1; j >= 0; j--) {
          const s = curLine[j];
          if (s.font !== slotFont) break;
          if (prevSlotIdx === -1) { prevSlotIdx = j; prevSlot = s; }
          if (!isMarkAt(s.codepoint)) {
            lastBaseIdx = j; lastBaseSlot = s;
            break;
          }
        }
        const gpos = slotFont.gpos;
        let att = null;
        let targetIdx = -1;
        if (prevSlot && isMarkAt(prevSlot.codepoint) && gpos.hasMarkMark) {
          att = gpos.getMarkMarkAttachment(prevSlot.glyphId, gid);
          if (att) targetIdx = prevSlotIdx;
        }
        if (!att && lastBaseSlot && gpos.hasMarkBase) {
          // GPOS type 5 — MarkLigPos. When the prior base is itself
          // a ligature (≥2 components), try the per-component anchor
          // table first. The component index for a trailing mark is
          // the last component (compCount - 1) under the HarfBuzz
          // "default to final" heuristic — sufficient for the common
          // case where one mark binds to a ligature.
          if (lastBaseSlot.ligComponents > 1) {
            const compIdx = lastBaseSlot.ligComponents - 1;
            att = gpos.getMarkLigAttachment(lastBaseSlot.glyphId, gid, compIdx);
            if (att) targetIdx = lastBaseIdx;
          }
          if (!att) {
            att = gpos.getMarkBaseAttachment(lastBaseSlot.glyphId, gid);
            if (att) targetIdx = lastBaseIdx;
          }
        }
        // MATH top-accent fallback: when the font has OT MATH but no
        // GPOS anchor for this base/mark pair, use MATH's top-accent
        // attachment X with the mark's centerline mapped to it.
        // dy = 0 (caller handles y-stacking via accentBaseHeight); we
        // only set dx so the accent's center aligns with the base's
        // top-accent anchor.
        if (!att && lastBaseSlot && slotFont.math.hasTable && isMathMark(cp)) {
          const baseAcc = slotFont.math.getTopAccentAttachment(lastBaseSlot.glyphId);
          if (!Number.isNaN(baseAcc)) {
            // Centre the mark's advance over baseAcc. We don't have the
            // mark's own top-accent anchor (rare) so assume mark
            // origin = mark center. dx = baseAcc - markAdvance/2.
            // The mark glyph's natural advance is what's already in
            // sGids[i]; query metrics for it.
            const markAdvFu = slotFont.getMetricsByGid(gid).advance;
            att = { dx: baseAcc - (markAdvFu * 0.5), dy: 0 };
            targetIdx = lastBaseIdx;
          }
        }
        if (att) {
          attachToIdx = targetIdx;
          attachDxEm = att.dx * slotInvUpem * widthScale * sizeScale;
          attachDyEm = -att.dy * slotInvUpem * sizeScale; // +Y up → +Y down
        }
        slotAdvance = 0;
      }

      // GPOS type 3 (cursive). Two adjacent same-font non-mark glyphs
      // with cursive anchors stitch their baselines together: the
      // current glyph's entry anchor lands on the previous glyph's
      // exit anchor. Y-only adjustment (X is implicit via font-designer
      // anchor placement matching the advance widths — HarfBuzz model).
      // The RIGHT_TO_LEFT lookupFlag bit on the curs lookup selects
      // which glyph absorbs the Y shift: with bit set (real Arabic
      // Naskh fonts), the CURRENT glyph moves; otherwise the PRIOR.
      // Mark glyphs don't participate (they're already anchored via
      // mark-attach above). slotCursiveDyEm is the Y shift to apply to
      // *this* slot; cursivePrevDyEm tracks a pending shift that the
      // PRIOR slot should receive on the LTR branch.
      let cursiveDyEm = 0;
      let slotCursiveExit = null;
      if (!isMarkCp && gid !== 0 && slotFont.gpos.hasCursive) {
        const myAnch = slotFont.gpos.getCursiveAnchors(gid);
        if (myAnch && myAnch.entry && prevFont === slotFont) {
          // Find prev non-mark same-font slot for the exit/entry join.
          let prevBaseIdx = -1;
          for (let j = curLine.length - 1; j >= 0; j--) {
            const s = curLine[j];
            if (s.font !== slotFont) break;
            if (!isMarkAt(s.codepoint)) { prevBaseIdx = j; break; }
          }
          if (prevBaseIdx >= 0) {
            const pSlot = curLine[prevBaseIdx];
            if (pSlot.cursiveExit) {
              const dyFu = pSlot.cursiveExit.y - myAnch.entry.y;
              const dyEm = -dyFu * slotInvUpem * sizeScale; // +Y up → +Y down
              if (myAnch.rtl) {
                cursiveDyEm = dyEm;
              } else {
                // LTR cursive: the PRIOR slot moves. Apply now since
                // the slot is already in curLine.
                pSlot.penY += dyEm;
              }
            }
          }
        }
        slotCursiveExit = (myAnch && myAnch.exit) ? myAnch.exit : null;
      }
      curLine.push({
        codepoint: cp, glyphId: gid, style: span.style, font: slotFont,
        penX: curLineAdv, penY: cursiveDyEm, advance: slotAdvance, breakKind, clusterStart,
        synthBold, synthItalic,
        attachToIdx, attachDxEm, attachDyEm,
        cursiveExit: slotCursiveExit,
        ligComponents: ligComponents[idx] || 1,
        mathAssembly: slotMathAssembly,
        ignorable: isIgnorable,
      });
      // Default-ignorable slots are invisible and transparent: leave the
      // prev-glyph context (kerning pair, LB14 CJK) pointing at the last
      // VISIBLE glyph so a selector/joiner between two letters doesn't
      // break their kern pair or line-break decision.
      if (!isIgnorable) {
        prevGid = gid;
        prevCp = cp;
        prevFont = slotFont;
      }

      if (breakKind !== 0) {
        lastBreakIdx = curLine.length - 1;
        lastBreakAdv = curLineAdv;
        // Word-aware preference: a space is always word-bounded; a CJK
        // BeforeSlot is preferred only when Intl tagged it as a word
        // start. When no word-starts exist on the line (e.g. a Korean
        // string with no spaces, where the whole run is one "word"),
        // the per-char gate still triggers via lastBreakIdx so the
        // text still wraps.
        if (breakKind === 1 || wordStart) {
          lastWordBreakIdx = curLine.length - 1;
          lastWordBreakAdv = curLineAdv;
        }
      }

      const next = curLineAdv + adv;
      if (wrap && next > lineUsableMax() && lastBreakIdx >= 0 && curLine.length > 1) {
        // Prefer the latest word-aware break point when one exists
        // AND it's not at the very start of the current line (a
        // word-start at idx 0 would mean "wrap before the first
        // char", which makes no progress). Fall back to the per-
        // character break for runs Intl couldn't segment (Korean
        // without spaces, isolated CJK substrings).
        let breakerIdx, breakerAdv;
        if (lastWordBreakIdx > 0) {
          breakerIdx = lastWordBreakIdx;
          breakerAdv = lastWordBreakAdv;
        } else {
          breakerIdx = lastBreakIdx;
          breakerAdv = lastBreakAdv;
        }
        // breakKind=2 (CJK): keep the breaker; carry STARTS at it.
        // breakKind=1 (space): drop the breaker; carry is everything AFTER.
        const breakerSlot = curLine[breakerIdx];
        const carryStart = breakerSlot.breakKind === 2 ? breakerIdx : breakerIdx + 1;
        const carry = curLine.slice(carryStart);
        curLine.length = breakerIdx;
        curLineAdv = breakerAdv;
        endLine();
        let penX = curLineAdv;
        let lastGid = 0;
        let lastFont = null;
        for (const s of carry) {
          const cw = s.style.widthScale > 0 ? s.style.widthScale : 1;
          const sFont = s.font;
          const sInvUpem = sFont.unitsPerEm > 0 ? 1 / sFont.unitsPerEm : 0;
          if ((s.style.mspaceEm || 0) <= 0 && !kernDisabled && sFont.hasAnyKerning
              && lastGid !== 0 && s.glyphId !== 0 && lastFont === sFont) {
            const kFu = sFont.getPairKerningFu(lastGid, s.glyphId);
            if (kFu !== 0) penX += kFu * sInvUpem * cw * s.style.sizeScale;
          }
          curLine.push({ ...s, penX });
          penX += s.advance;
          lastGid = s.glyphId;
          lastFont = sFont;
        }
        curLineAdv = penX;
        prevGid = lastGid;
        prevFont = lastFont;
      } else {
        curLineAdv = next;
      }
    }
  }
  if (curLine.length > 0 || lines.length === 0) endLine();

  const paraIsRtl = reorderLinesBidi(lines, layout, fallbacks);
  const slots = emitAlignedSlots(lines,
    { lineAdvances, lineAlignOverride, lineHeights, lineUsableMaxes },
    { layout, naturalLineHeight, defaultAlign, wrap, layoutBoxW, paraIsRtl });
  applyAatContextualKerning(slots);
  return slots;
}

// ---- layout phase 2: bidi reordering (per-line, resolved paragraph-wide) --
// Mutates `lines` in place (reordered slot arrays, mirrored glyphs, mark
// attachments applied post-reorder); returns whether the paragraph base
// direction resolved RTL (drives right-anchored alignment in phase 3).
function reorderLinesBidi(lines, layout, fallbacks) {

  // Bidi: reorder per-line slots into visual order.
  //
  // Resolve once over the FULL paragraph codepoint stream so explicit
  // base-direction context is consistent across line boundaries; then
  // slice per-line. Each line gets reorderLine() applied and penX
  // reassigned to preserve advances. RTL paragraphs are also marked
  // for right-anchored emission below (xOff = slack instead of 0).
  const rawBase = layout.baseDirection != null
    ? layout.baseDirection
    : BaseDirection.Auto;
  const allCps = [];
  for (const line of lines) for (const s of line) allCps.push(s.codepoint);
  const bidi = getBidi();
  const paraDir   = bidi.resolveBaseDirection(rawBase, allCps);
  const paraLevels = bidi.resolveLevels(allCps, paraDir);
  // UAX #9 L4: a mirrorable character at an odd (RTL) level is drawn with its
  // mirrored glyph (e.g. '(' shows as ')').
  {
    let mi = 0;
    for (const line of lines) {
      for (const s of line) {
        if ((paraLevels[mi] & 1) && hasMirror(s.codepoint)) {
          const [mfont, mgid] = resolveGlyph(mirror(s.codepoint), s.font, fallbacks);
          if (mgid) { s.glyphId = mgid; s.font = mfont; }
        }
        mi++;
      }
    }
  }
  let cpCursor = 0;
  for (let li = 0; li < lines.length; li++) {
    const lineLen = lines[li].length;
    if (lineLen === 0) continue;
    const lvSlice = paraLevels.subarray(cpCursor, cpCursor + lineLen);
    cpCursor += lineLen;
    const order = bidi.reorderLine(lvSlice);
    // Reassign penX so visually-ordered slots are left-to-right.
    // Build a logical→visual index map so per-slot attach pointers
    // can be remapped to their new positions.
    const orig = lines[li];
    let identity = true;
    for (let i = 0; i < order.length; i++) if (order[i] !== i) { identity = false; break; }
    let workingLine = orig;
    if (!identity) {
      let penX = orig[0].penX;
      const reord = new Array(lineLen);
      const logicalToVisual = new Array(lineLen);
      for (let v = 0; v < lineLen; v++) {
        const logIdx = order[v];
        logicalToVisual[logIdx] = v;
        const s = orig[logIdx];
        reord[v] = { ...s, penX };
        penX += s.advance;
      }
      // Remap attachToIdx through the reorder.
      for (let v = 0; v < lineLen; v++) {
        const s = reord[v];
        if (s.attachToIdx >= 0) s.attachToIdx = logicalToVisual[s.attachToIdx];
      }
      lines[li] = reord;
      workingLine = reord;
    }
    // Apply mark attachments on the final (post-reorder) line.
    for (let v = 0; v < lineLen; v++) {
      const s = workingLine[v];
      if (s.attachToIdx >= 0) {
        const base = workingLine[s.attachToIdx];
        if (base) {
          s.penX = base.penX + s.attachDxEm;
          s.penY = base.penY + s.attachDyEm;
        }
      }
    }
  }
  return paraDir === BaseDirection.Rtl;
}

// ---- layout phase 3: alignment + slot emission ----------------------------
// Applies per-line alignment (incl. justify: kashida elongation then
// space distribution), the per-line baseline step, and the layout origin,
// emitting the final flat slot list.
function emitAlignedSlots(lines, { lineAdvances, lineAlignOverride, lineHeights, lineUsableMaxes },
                          { layout, naturalLineHeight, defaultAlign, wrap, layoutBoxW, paraIsRtl }) {

  const slots = [];
  const ox = layout.originX || 0;
  const oy = layout.originY || 0;
  // Per-line baseline accumulator — supports <line-height> directives
  // that change the step mid-paragraph.
  let baselineAccum = 0;
  // CSS `text-align-last` semantics: when align='justify', the LAST
  // line of a paragraph is naturally short and we don't justify it
  // (would produce hilariously wide word gaps). Layout option
  // `lastLineAlign` overrides: 'auto' (default) = use 'left' (or
  // 'right' under RTL), 'justify' = always justify, or any explicit
  // align value.
  const lastLineAlign = layout.lastLineAlign || 'auto';
  for (let li = 0; li < lines.length; li++) {
    const effLh = lineHeights[li] > 0
      ? lineHeights[li]
      : (layout.lineHeightEm > 0 ? layout.lineHeightEm : naturalLineHeight);
    const baselineY = baselineAccum;
    baselineAccum += effLh;
    let xOff = 0;
    let perSpaceExtra = 0;        // for justify: extra em per breakKind=1 slot
    const effAlign = lineAlignOverride[li] || defaultAlign;
    // RTL paragraph base direction implies right anchor by default
    // when no explicit align was given.
    const effAlignFinal = (lineAlignOverride[li] == null && defaultAlign === 'left' && paraIsRtl)
      ? 'right' : effAlign;
    // text-align-last decoupling: last-line in 'justify' mode falls
    // back to plain align ('left' / 'right' under RTL).
    const isLastLine = li === lines.length - 1;
    let effLineAlign = effAlignFinal;
    if (effAlignFinal === 'justify' && isLastLine) {
      if (lastLineAlign === 'auto') effLineAlign = paraIsRtl ? 'right' : 'left';
      else effLineAlign = lastLineAlign;
    }
    // Align against the wrap width when wrapping, else against the fixed
    // layout-box width. Without either, single lines have no slack and
    // stay left (ink-tight behaviour).
    let kashidaPlan = null;       // JSTF Arabic elongation for this line
    const usableMax = wrap ? lineUsableMaxes[li] : layoutBoxW;
    if (usableMax > 0 && effLineAlign !== 'left') {
      const slack = usableMax - lineAdvances[li];
      if (slack > 0) {
        if (effLineAlign === 'center') xOff = slack * 0.5;
        else if (effLineAlign === 'right') xOff = slack;
        else if (effLineAlign === 'justify') {
          // Arabic kashida elongation first (JSTF extender glyphs): insert
          // tatweel connectors at cursive joins to absorb slack. Whatever
          // a whole number of kashidas can't cover spills to the spaces.
          let remainingSlack = slack;
          kashidaPlan = planKashida(lines[li], slack);
          if (kashidaPlan) remainingSlack -= kashidaPlan.total * kashidaPlan.advEm;
          // Count breakKind=1 (space) slots on this line. Distribute the
          // remaining slack equally as extra advance INSERTED AFTER each
          // space. Spaces at the very END of the line are stripped by the
          // wrap logic, so we can simply count all breakKind=1 slots.
          let spaceCount = 0;
          for (const s of lines[li]) if (s.breakKind === 1) spaceCount++;
          if (spaceCount > 0) perSpaceExtra = remainingSlack / spaceCount;
          // No spaces and no kashida (single-word Latin line that
          // overflowed): leave as-is.
        }
      }
    }
    let extraAcc = 0;
    for (let si = 0; si < lines[li].length; si++) {
      const s = lines[li][si];
      slots.push({ ...s, penX: s.penX + xOff + ox + extraAcc, penY: baselineY + oy });
      // Inject extra after each space (the gap visually grows to the
      // right of the space character, before the next word).
      if (perSpaceExtra > 0 && s.breakKind === 1) extraAcc += perSpaceExtra;
      // Kashida insertions after this visual slot (JSTF justification):
      // emit `count` connector glyphs, each pushing the rest of the line
      // right by its advance.
      const kc = kashidaPlan && kashidaPlan.counts.get(si);
      if (kc) {
        for (let n = 0; n < kc; n++) {
          const kx = s.penX + s.advance + xOff + ox + extraAcc;
          slots.push({
            codepoint: 0x0640, glyphId: kashidaPlan.gid, font: kashidaPlan.font,
            style: s.style, penX: kx, penY: baselineY + oy, advance: kashidaPlan.advEm,
            breakKind: 0, clusterStart: true,
            synthBold: s.synthBold, synthItalic: s.synthItalic,
            attachToIdx: -1, attachDxEm: 0, attachDyEm: 0,
            cursiveExit: null, ligComponents: 1, mathAssembly: null, ignorable: false,
          });
          extraAcc += kashidaPlan.advEm;
        }
      }
    }
  }
  return slots;
}

/// AAT 'kerx' contextual (format 1) + anchor (format 4) positioning. Runs
/// after layout, per line, over each maximal same-font run whose font is
/// AAT-shaped and ships a state-machine/anchor kerning subtable. Format 1
/// produces per-glyph advance / offset deltas; format 4 attaches a glyph
/// to a marked predecessor. Pairwise kerx 0/2 are already applied in the
/// pen loop, so they're excluded here.
function applyAatContextualKerning(slots) {
  if (slots.length === 0) return;
  // Split into lines (constant penY), preserving order.
  let lineStart = 0;
  for (let end = 1; end <= slots.length; end++) {
    if (end === slots.length || slots[end].penY !== slots[lineStart].penY) {
      _kerxLine(slots, lineStart, end);
      lineStart = end;
    }
  }
}

function _kerxLine(slots, lo, hi) {
  const N = hi - lo;
  if (N === 0) return;
  const xAdv = new Array(N).fill(0), xOff = new Array(N).fill(0), yOff = new Array(N).fill(0);
  const attaches = [];
  let any = false;
  let i = 0;
  while (i < N) {
    const f = slots[lo + i].font;
    let j = i;
    while (j < N && slots[lo + j].font === f) j++;
    if (f && f.usesAatKerning) {
      const inv = f.unitsPerEm > 0 ? 1 / f.unitsPerEm : 0;
      const runGids = [];
      for (let k = i; k < j; k++) runGids.push(slots[lo + k].glyphId);
      const r = f.kerx.applyContextualKerning(runGids);
      for (let k = 0; k < runGids.length; k++) {
        xAdv[i + k] = r.xAdvance[k] * inv;
        xOff[i + k] = r.xOffset[k] * inv;
        yOff[i + k] = r.yOffset[k] * inv;
        if (r.xAdvance[k] || r.xOffset[k] || r.yOffset[k]) any = true;
      }
      for (const a of r.attach) {
        attaches.push({ idx: i + a.idx, markIdx: i + a.markIdx, dx: a.dxFu * inv, dy: a.dyFu * inv });
        any = true;
      }
    }
    i = j;
  }
  if (!any) return;
  // Cumulative left-to-right pass: advance deltas shift everything after;
  // x/y offsets shift the glyph itself.
  let cum = 0;
  for (let k = 0; k < N; k++) {
    const s = slots[lo + k];
    s.penX += cum + xOff[k];
    s.penY += -yOff[k];          // FUnits +Y up → layout +Y down
    s.advance += xAdv[k];
    cum += xAdv[k];
  }
  // Format-4 attachments: place the glyph at its mark's pen + (dx, dy).
  for (const a of attaches) {
    slots[lo + a.idx].penX = slots[lo + a.markIdx].penX + a.dx;
    slots[lo + a.idx].penY = slots[lo + a.markIdx].penY - a.dy;
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function* codepoints(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
        yield ((c - 0xD800) << 10) + (c2 - 0xDC00) + 0x10000;
        i++; continue;
      }
    }
    yield c;
  }
}
