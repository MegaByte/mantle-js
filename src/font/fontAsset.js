// fontAsset.js — one per .ttf; glyphs extracted JIT
// and held in an LRU keyed by codepoint. Outline + metrics only —
// bundle assembly lives in textRun.

import { parseTtfTables, ttcFaceCount } from './ttfTables.js';
export { ttcFaceCount };
import { readGlyph, glyphGvarAdvanceFu } from './glyphReader.js';
import { MantleGlyphCache } from './glyphCache.js';
// Always-on readers — every text render needs them.
// GSUB for ligatures + Indic / Arabic features, GPOS for kerning +
// mark attachment, GDEF for lookupFlag (IgnoreMarks etc.), name for
// face metadata. Stripping any of these would break basic Latin text.
import { GposReader } from './gposReader.js';
import { GsubReader } from './gsubReader.js';
import { GdefReader } from './gdefReader.js';
import { NameTable } from './nameReader.js';

// Optional readers — looked up via the registry so consumers opt in
// per subsystem and unused readers tree-shake. See
// font/{color,variations,math,formats}/* subpaths. A Latin-text
// consumer pays nothing for COLR / CBDT / sbix / SVG-in-OT /
// fvar+friends / MATH / VORG / BASE / STAT / legacy kern / WOFF2.
import { tryNewReader, nullObjectFor, getReaderCtor } from './readerRegistry.js';

/**
 * Async pre-decoder: if `bytes` is a woff2 file, decompress + reassemble
 * into a regular sfnt byte buffer. If already sfnt (TTF/OTF), returns
 * the input unchanged.
 *
 * Use this before constructing a MantleFontAsset for fonts that might
 * arrive as woff2 (e.g. fetched from a Google Fonts CDN).
 *
 *   const raw = new Uint8Array(await (await fetch(url)).arrayBuffer());
 *   const sfnt = await decodeIfWoff2(raw);
 *   const font = new MantleFontAsset(sfnt);
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function decodeIfWoff2(bytes) {
  // WOFF2 support is opt-in: register via the formats/woff2 subpath
  // before passing woff2 bytes here. Without registration, woff2
  // input throws (since detection still works but decode isn't
  // available). Detection lives in the same opt-in module so the
  // ~brotli WASM payload only loads when a consumer actually expects
  // to handle woff2.
  //
  //   import { registerWoff2Reader } from '@kontek/mantle/font/formats/woff2';
  //   registerWoff2Reader();
  const isWoff2 = getReaderCtor('isWoff2');
  const decodeWoff2 = getReaderCtor('decodeWoff2');
  if (!isWoff2 || !decodeWoff2) return bytes;     // No WOFF2 registered → pass through.
                                                  // If `bytes` is woff2 the downstream
                                                  // sfnt parser will throw, surfacing the
                                                  // "register the woff2 subpath" message
                                                  // to the developer.
  return isWoff2(bytes) ? await decodeWoff2(bytes) : bytes;
}

/**
 * @typedef {Object} MantleGlyphMetrics
 * @property {number} advance      em-units / unitsPerEm
 * @property {number} leftBearing
 * @property {number} ascent
 * @property {number} descent
 * @property {number[]} bbox       [xmin, ymin, xmax, ymax], em-normalized
 */

export class MantleFontAsset {
  /**
   * @param {Uint8Array} ttfBytes
   * @param {{ byteBudget?: number, faceIndex?: number }} [opts]
   *   faceIndex selects a face from a TTC; ignored for plain TTF/OTF.
   */
  constructor(ttfBytes, opts = {}) {
    this._ttfBytes = ttfBytes;
    this._faceIndex = opts.faceIndex | 0;
    this._tables = null;
    this._cache  = new MantleGlyphCache(opts.byteBudget);
    this._gpos = null;
    this._gsub = null;
    this._legacyKern = null;
    this._colr = null;
    this._sbix = null;
    this._cbdt = null;
    this._ebdt = null;
    this._svgInOt = null;
    this._name = null;
    this._fvar = null;
    this._hvar = null;
    this._vvar = null;
    this._mvar = null;
    this._gdef = null;
    this._vorg = null;
    this._base = null;
    this._jstf = null;
    this._morx = null;
    this._mort = null;
    this._kerx = null;
    this._feat = null;
    this._stat = null;
    this._math = null;

    this.familyName = '';
    this.styleName  = '';
    this.fullName       = '';
    this.postScriptName = '';
    this.unitsPerEm = 0;
    this.ascent  = 0;
    this.descent = 0;
    this.lineGap = 0;
    this.underlinePosition  = 0;
    this.underlineThickness = 0;
    /** post.italicAngle in degrees (0 for upright fonts). */
    this.italicAngle = 0;
  }

  /** GPOS reader; lazily built. */
  get gpos() {
    this._ensure();
    if (this._gpos == null) {
      this._gpos = new GposReader(this._tables);
      // Inject GDEF so context/chain-context pos can honor lookupFlag
      // (IgnoreMarks etc.). Cheap when GDEF absent — reader no-ops.
      if (this._gpos.setGdef) this._gpos.setGdef(this.gdef);
    }
    return this._gpos;
  }
  /** GSUB reader; lazily built. */
  get gsub() {
    this._ensure();
    if (this._gsub == null) {
      this._gsub = new GsubReader(this._tables);
      // Inject GDEF so context/chain-context/reverse-chain sub +
      // ligature component walks honor lookupFlag skips.
      if (this._gsub.setGdef) this._gsub.setGdef(this.gdef);
    }
    return this._gsub;
  }
  /** Legacy 'kern' table reader; lazily built. Returns a null-object
   *  (hasKern=false, pairKern=>0) when the optional reader hasn't
   *  been registered via font/typography/legacyKern. */
  get legacyKern() {
    this._ensure();
    if (this._legacyKern == null)
      this._legacyKern = tryNewReader('legacyKern', this._tables) || nullObjectFor('legacyKern');
    return this._legacyKern;
  }
  /** COLR + CPAL reader; lazily built. Returns a null-object
   *  (hasColor=false, getLayers=>null, getPaint=>null) when font/color
   *  hasn't been registered. */
  get colr() {
    this._ensure();
    if (this._colr == null)
      this._colr = tryNewReader('colr', this._tables) || nullObjectFor('colr');
    return this._colr;
  }
  /** True iff this font has a v0 COLR + CPAL pair we can render. */
  get hasColor() { return this.colr.hasColor; }

  /** Sbix reader; lazily built. Null-object (hasBitmaps=false) when
   *  font/color (which registers sbix alongside colr/cbdt/svgInOt)
   *  hasn't been registered. */
  get sbix() {
    this._ensure();
    if (this._sbix == null)
      this._sbix = tryNewReader('sbix', this._tables) || nullObjectFor('sbix');
    return this._sbix;
  }
  /** CBDT/CBLC reader; lazily built. Null-object when not registered. */
  get cbdt() {
    this._ensure();
    if (this._cbdt == null)
      this._cbdt = tryNewReader('cbdt', this._tables) || nullObjectFor('cbdt');
    return this._cbdt;
  }
  /** EBDT/EBLC monochrome/grayscale bitmap reader; lazily built. */
  get ebdt() {
    this._ensure();
    if (this._ebdt == null)
      this._ebdt = tryNewReader('ebdt', this._tables) || nullObjectFor('ebdt');
    return this._ebdt;
  }
  /** True iff this font carries bitmap glyphs (sbix OR CBDT OR EBDT). */
  get hasBitmaps() {
    return this.sbix.hasBitmaps || this.cbdt.hasBitmaps || this.ebdt.hasBitmaps;
  }

  /** SVG-in-OT reader (Twemoji format); lazily built. Null-object
   *  when not registered. */
  get svgInOt() {
    this._ensure();
    if (this._svgInOt == null)
      this._svgInOt = tryNewReader('svgInOt', this._tables) || nullObjectFor('svgInOt');
    return this._svgInOt;
  }
  /** True iff this font carries SVG-in-OT glyph documents. */
  get hasSvgGlyphs() { return this.svgInOt.hasSvg; }

  /// Resolves the SVG-in-OT document for `gid`. Returns null when
  /// no record covers this gid (or when the font has no 'SVG ' table).
  /// Returned object: { svgBytes, isGzipped, subElementId,
  ///                    startGid, endGid, advanceEm }
  /// Callers gunzip when isGzipped, parse the SVG, and render the
  /// sub-element with id=subElementId through the SVG importer.
  getSvgGlyphByGid(gid) {
    this._ensure();
    if (!this.svgInOt.hasSvg) return null;
    const g = this.svgInOt.getGlyph(gid);
    if (!g) return null;
    const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
    return {
      svgBytes: g.svgBytes,
      isGzipped: g.isGzipped,
      subElementId: g.subElementId,
      startGid: g.startGid,
      endGid: g.endGid,
      advanceEm: this._tables.glyphAdvanceWidth(gid) * inv,
    };
  }

  /// Codepoint convenience for getSvgGlyphByGid.
  getSvgGlyph(codepoint) {
    this._ensure();
    if (!this.hasSvgGlyphs) return null;
    const gid = this._tables.codepointToGlyphIndex(codepoint);
    if (gid === 0 && codepoint !== 0) return null;
    return this.getSvgGlyphByGid(gid);
  }

  /// Resolves a bitmap glyph for `gid` at the requested target
  /// rendering size (ppem = px per em-square). Picks the best
  /// strike (closest >= target, largest fallback). Returns
  /// null when no bitmap is available.
  ///
  /// Returned object: { pngBytes, originXEm, originYEm,
  ///                    widthEm, heightEm, advanceEm, strikePpem }
  /// Units are EM-NORMALIZED so callers (text run, atlas pack)
  /// don't need to know which table the font used. Bearings and
  /// dimensions vary per format:
  ///   sbix: originX/Y are font-unit offsets; PNG W/H comes from
  ///         the PNG itself (callers decode to learn).
  ///   CBDT: SmallGlyphMetrics gives pixel W/H plus bearingX/Y
  ///         (s8) and advance (u8); we convert to em via the
  ///         strike's ppem.
  getBitmapGlyphByGid(gid, targetPpem = 32) {
    this._ensure();
    // Prefer sbix if available (Apple ecosystem); fall back to CBDT.
    if (this.sbix.hasBitmaps) {
      const strikeIdx = this.sbix.pickStrikeForPpem(targetPpem);
      if (strikeIdx < 0) return null;
      const g = this.sbix.getBitmapGlyph(gid, strikeIdx);
      if (!g || !g.isPng) return null;
      // sbix originX/Y are font units. Em-normalize via unitsPerEm.
      const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
      // PNG dimensions come from the PNG header; caller decodes.
      // For atlas pack we report ppem (= strike's render size at
      // 1em) — caller scales accordingly.
      return {
        pngBytes: g.pngBytes,
        originXEm: g.originX * inv,
        originYEm: g.originY * inv,
        widthEm: 0,            // sbix doesn't include width metric — caller reads PNG header
        heightEm: 0,           // ditto
        advanceEm: this._tables.glyphAdvanceWidth(gid) * inv,
        strikePpem: g.strikePpem,
        source: 'sbix',
      };
    }
    if (this.cbdt.hasBitmaps) {
      const strikeIdx = this.cbdt.pickStrikeForPpem(targetPpem);
      if (strikeIdx < 0) return null;
      const g = this.cbdt.getBitmapGlyph(gid, strikeIdx);
      if (!g) return null;
      // CBDT SmallGlyphMetrics: bearingX/Y in font units (s8 — yes,
      // really, narrow range), advance + W/H in PIXELS at strike ppem.
      const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
      const px2em = g.strikePpem > 0 ? 1 / g.strikePpem : 0;
      return {
        pngBytes: g.pngBytes,
        originXEm: g.bearingX * inv,
        originYEm: g.bearingY * inv,
        widthEm:   g.width  * px2em,
        heightEm:  g.height * px2em,
        advanceEm: g.advance * px2em,
        strikePpem: g.strikePpem,
        source: 'cbdt',
      };
    }
    if (this.ebdt.hasBitmaps) {
      const strikeIdx = this.ebdt.pickStrikeForPpem(targetPpem);
      if (strikeIdx < 0) return null;
      const g = this.ebdt.getBitmapGlyph(gid, strikeIdx);
      if (!g) return null;
      // EBDT carries raw coverage (not PNG): `alphaBitmap` is one 8-bit
      // coverage byte per pixel (row-major, width*height). bearingX/Y in
      // font units; advance + W/H in PIXELS at the strike's ppem. The
      // glyph is monochrome/grayscale — consumers tint by the fill color.
      const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
      const px2em = g.strikePpem > 0 ? 1 / g.strikePpem : 0;
      return {
        alphaBitmap: g.alphaBitmap,
        bitDepth: g.bitDepth,
        pixelWidth: g.width,
        pixelHeight: g.height,
        originXEm: g.bearingX * inv,
        originYEm: g.bearingY * inv,
        widthEm:   g.width  * px2em,
        heightEm:  g.height * px2em,
        advanceEm: g.advance * px2em,
        strikePpem: g.strikePpem,
        source: 'ebdt',
      };
    }
    return null;
  }

  /// Codepoint convenience for getBitmapGlyphByGid.
  getBitmapGlyph(codepoint, targetPpem = 32) {
    this._ensure();
    if (!this.hasBitmaps) return null;
    const gid = this._tables.codepointToGlyphIndex(codepoint);
    if (gid === 0 && codepoint !== 0) return null;
    return this.getBitmapGlyphByGid(gid, targetPpem);
  }

  /** True iff GPOS, AAT kerx, or legacy kern has any pair data. */
  get hasAnyKerning() { return this.gpos.hasKerning || this.kerx.hasKerx || this.legacyKern.hasKerning; }

  /** Pair kerning in font units. GPOS preempts AAT kerx preempts legacy. */
  getPairKerningFu(a, b) {
    if (this.gpos.hasKerning) return this.gpos.getPairKerning(a, b);
    if (this.kerx.hasKerx) return this.kerx.getPairKerning(a, b);
    return this.legacyKern.getPairKerning(a, b);
  }

  /** Codepoint → glyph index. 0 = .notdef. */
  codepointToGlyphId(cp) {
    this._ensure();
    return this._tables.codepointToGlyphIndex(cp);
  }

  /** True when the font ships a format-14 Unicode-Variation-Sequence cmap. */
  get hasVariationSelectors() {
    this._ensure();
    return this._tables.hasUvs;
  }

  /// Resolve a (base, variation-selector) pair via the format-14 UVS
  /// cmap. Returns an explicit variant glyph id (>0) when the font
  /// defines one for this sequence (e.g. emoji presentation for VS16, or
  /// a CJK ideographic variant), or 0 to mean "use the ordinary glyph
  /// for `baseCp`". 0 when the font has no UVS table.
  codepointToVariationGlyphId(baseCp, selectorCp) {
    this._ensure();
    return this._tables.resolveVariationGlyph(baseCp, selectorCp);
  }

  /** Outline for an already-resolved glyph id. No codepoint cache lookup. */
  getGlyphSegsByGid(gid) {
    this._ensure();
    return readGlyph(this._tables, gid);
  }

  /// Variable-font variant: outline for `gid` morphed by the supplied
  /// USER-SPACE axis coordinates (one per axis, in the axis's native
  /// range e.g. wght=400..1000). Coords shorter than axisCount fall
  /// back to each axis default; null/undefined → returns the default
  /// outline (identical to getGlyphSegsByGid).
  ///
  /// avar value mapping is applied when an 'avar' table is present
  /// (handled in normalizeCoords by the fvar reader).
  getGlyphSegsByGidVar(gid, userCoords) {
    this._ensure();
    if (!this.isVariable || userCoords == null) {
      return readGlyph(this._tables, gid);
    }
    const n = this.fvar.normalizeCoords(userCoords);
    return readGlyph(this._tables, gid, n);
  }

  /** Metrics for an already-resolved glyph id. */
  getMetricsByGid(gid) {
    this._ensure();
    const segs = readGlyph(this._tables, gid);
    return this._computeMetrics(gid, segs);
  }

  /**
   * Layered color-glyph layers for a resolved gid. Returns null
   * when the font has no COLR table OR the gid isn't a color glyph
   * (regular monochrome glyphs aren't in COLR). Callers should fall
   * back to getGlyphSegsByGid(gid) for monochrome rendering.
   *
   * Each layer entry: { segs, rgba, isForeground, glyphId }
   *   segs         em-space outline of the layer's glyph
   *   rgba         [r, g, b, a] resolved from CPAL palette 0, or
   *                null when isForeground === true
   *   isForeground true when the layer's paletteIndex is 0xFFFF
   *                (callers substitute the run color)
   *   glyphId      the layer glyph's own gid (info / debug)
   *
   * Layer order is paint-order (back to front).
   *
   * Advance + bbox of the COLORED glyph are the BASE glyph's
   * (use getMetricsByGid on the base gid). Layers may extend
   * slightly past the base's ink bbox; that's a property of how
   * the font is authored.
   *
   * @param {number} gid
   * @returns {{segs: object[], rgba: number[]|null, isForeground: boolean, glyphId: number}[]|null}
   */
  getColoredGlyphByGid(gid) {
    this._ensure();
    if (!this.colr.hasColor) return null;
    const layerInfos = this.colr.getLayers(gid);
    if (!layerInfos) return null;
    const out = new Array(layerInfos.length);
    for (let i = 0; i < layerInfos.length; i++) {
      const li = layerInfos[i];
      out[i] = {
        segs: readGlyph(this._tables, li.glyphId),
        rgba: li.rgba,
        isForeground: li.paletteIndex === 0xFFFF,
        glyphId: li.glyphId,
      };
    }
    return out;
  }

  /** Codepoint convenience for getColoredGlyphByGid. Returns null
   *  when the codepoint isn't a color glyph (caller falls back to
   *  getGlyphSegs). */
  getColoredGlyph(codepoint) {
    this._ensure();
    if (!this.colr.hasColor) return null;
    const gid = this._tables.codepointToGlyphIndex(codepoint);
    if (gid === 0 && codepoint !== 0) return null;
    return this.getColoredGlyphByGid(gid);
  }

  /** True when the font ships a COLRv1 BaseGlyphList in addition to or
   *  instead of the v0 LayerList. v1 glyphs use richer paint trees
   *  (gradients, transforms, composites) and dispatch through the
   *  filter-graph evaluator rather than emitting flat layer shapes. */
  get hasColrV1() {
    this._ensure();
    return this.colr.hasColrV1;
  }

  /** COLRv1: return a `{ graph, glyphSegs, glyphIds }` triple for
   *  a v1-painted glyph, or null when the gid has no v1 paint tree.
   *
   *  - `graph` is the filter-graph DAG (filterGraph.js schema)
   *    produced by colrPaintToGraph. The renderer's COLR dispatch
   *    evaluates this DAG to produce the final colored glyph pixels.
   *  - `glyphSegs` is the **silhouette outline** that the fill walker (ray-cast)
   *    paints to build the glyph alpha mask used by PaintGlyph nodes.
   *    For a tree whose root is `PaintGlyph(glyphId=N)`, the silhouette
   *    is the outline of gid N — which is the same gid as the painted
   *    glyph (the top-level glyph). For trees with multiple PaintGlyph
   *    leaves at different glyphIds, the renderer must walk the graph
   *    and bake one mask per distinct glyphId; for the common case
   *    (one PaintGlyph at root) we return the single silhouette here
   *    to make the renderer's fast path trivial.
   *  - `glyphIds` is the de-duplicated set of glyph silhouettes the
   *    graph references; the renderer needs to bake one mask per
   *    distinct gid. Always a superset of `[gid]`.
   *
   *  Returns null when the font has no COLRv1 table or this gid has
   *  no v1 paint record (caller falls back to v0 layers via
   *  getColoredGlyphByGid, then to the monochrome outline).
   *
   *  @param {number} gid
   *  @param {Float32Array|number[]|null} [coords]  normalized variation
   *    coords; when supplied, PaintVar* nodes interpolate the paint
   *    tree to that instance. Default null = static / default master.
   *  @returns {{ graph: object, glyphSegs: object[], glyphIds: number[] }|null}
   */
  getColrV1GraphByGid(gid, coords = null) {
    this._ensure();
    if (!this.colr.hasColrV1) return null;
    const paintTree = this.colr.getPaint(gid, coords);
    if (!paintTree) return null;
    // colrPaintToGraph is registered alongside the COLR reader by
    // font/color (it has no value without colr). Treat as a guard:
    // if COLR is registered but the paint-graph converter isn't,
    // skip v1 rendering and let the caller fall back.
    const colrPaintToGraph = getReaderCtor('colrPaintToGraph');
    if (!colrPaintToGraph) return null;
    const graph = colrPaintToGraph(paintTree, this.colr, coords);
    if (!graph || !graph.nodes.length) return null;
    // Collect every glyphId referenced by PaintGlyph nodes — the
    // renderer needs to render each one's silhouette into a mask
    // before evaluating the graph.
    const glyphIds = new Set([gid]);
    for (const n of graph.nodes) {
      if (n.type === 'PaintGlyph' && n.params && typeof n.params.glyphId === 'number') {
        glyphIds.add(n.params.glyphId);
      }
    }
    // The "primary" silhouette = the top-level glyph's outline.
    // Real COLRv1 fonts frequently leave the top-level glyph's outline
    // empty when the silhouette is supplied by a PaintGlyph leaf — in
    // that case the primary outline lookup returns null and we fall
    // back to the first PaintGlyph's referenced gid. If neither produces
    // segs, return an empty array so the caller can choose whether to
    // emit a shape at all.
    let glyphSegs = readGlyph(this._tables, gid) || [];
    if (glyphSegs.length === 0) {
      for (const n of graph.nodes) {
        if (n.type === 'PaintGlyph' && n.params && typeof n.params.glyphId === 'number') {
          const alt = readGlyph(this._tables, n.params.glyphId);
          if (alt && alt.length) { glyphSegs = alt; break; }
        }
      }
    }
    // Per-PaintGlyph silhouette outlines: one segs array per distinct
    // PaintGlyph.glyphId referenced inside the graph. The renderer
    // bakes each into its own alpha mask FBO so PaintGlyph nodes at
    // non-root positions clip by their own gid's outline (not the
    // top-level silhouette). Map<gid → segs[]>. Always includes the
    // primary gid keyed under `gid` for completeness.
    const glyphSegsByGid = new Map();
    glyphSegsByGid.set(gid, glyphSegs);
    for (const n of graph.nodes) {
      if (n.type === 'PaintGlyph' && n.params && typeof n.params.glyphId === 'number') {
        const g = n.params.glyphId;
        if (!glyphSegsByGid.has(g)) {
          glyphSegsByGid.set(g, readGlyph(this._tables, g) || []);
        }
      }
    }
    return {
      graph,
      glyphSegs,
      glyphIds: Array.from(glyphIds),
      glyphSegsByGid,
    };
  }

  /**
   * @param {number} codepoint
   * @returns {Array|null} segs in em-space (+Y up), or null if no glyph
   */
  getGlyphSegs(codepoint) {
    this._ensure();
    const hit = this._cache.tryGet(codepoint);
    if (hit) return hit.segs;
    const gid = this._tables.codepointToGlyphIndex(codepoint);
    if (gid === 0 && codepoint !== 0) return null;
    const segs = readGlyph(this._tables, gid);
    const metrics = this._computeMetrics(gid, segs);
    this._cache.put(codepoint, segs, metrics);
    return segs;
  }

  /**
   * @param {number} codepoint
   * @returns {MantleGlyphMetrics}
   */
  getMetrics(codepoint) {
    this._ensure();
    const hit = this._cache.tryGet(codepoint);
    if (hit) return hit.metrics;
    const gid = this._tables.codepointToGlyphIndex(codepoint);
    if (gid === 0 && codepoint !== 0) {
      return { advance: 0, leftBearing: 0, ascent: 0, descent: 0, bbox: [0, 0, 0, 0] };
    }
    const segs = readGlyph(this._tables, gid);
    const metrics = this._computeMetrics(gid, segs);
    this._cache.put(codepoint, segs, metrics);
    return metrics;
  }

  /** GPOS pair adjustment. */
  getKerning(_a, _b) { return 0; }

  _ensure() {
    if (this._tables) return;
    if (!this._ttfBytes || this._ttfBytes.length === 0)
      throw new Error('MantleFontAsset has no .ttf bytes');
    this._tables = parseTtfTables(this._ttfBytes, this._faceIndex);
    this.unitsPerEm = this._tables.unitsPerEm;
    const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
    this.ascent  = this._tables.ascender  * inv;
    this.descent = this._tables.descender * inv;
    this.lineGap = this._tables.lineGap   * inv;
    // OS/2 typographic helpers (em-normalized). Both default to a
    // glyph-measured fallback when OS/2 v2+ isn't present: 'H' for
    // capHeight, 'x' for xHeight. Layout consumers need these to vertically
    // center against the FONT's metrics rather than the per-string
    // ink bbox — which changes height depending on whether the string
    // contains descenders like 'y' / 'g'.
    this.capHeight = this._tables.os2CapHeight * inv;
    this.xHeight   = this._tables.os2xHeight   * inv;
    if (!(this.capHeight > 0)) this.capHeight = this._measureGlyphHeight('H'.charCodeAt(0));
    if (!(this.xHeight   > 0)) this.xHeight   = this._measureGlyphHeight('x'.charCodeAt(0));
    this.underlinePosition  = this._tables.postUnderlinePosition  * inv;
    this.underlineThickness = this._tables.postUnderlineThickness * inv;
    this.italicAngle        = this._tables.postItalicAngle || 0;
    // Populate display names from the 'name' table when present.
    // Preferred typographic names (IDs 16/17) win over legacy 1/2.
    this._name = new NameTable(this._tables);
    if (this._name.hasNames) {
      const { family, subfamily } = this._name.resolveFamily();
      this.familyName     = family;
      this.styleName      = subfamily;
      this.fullName       = this._name.get(4) || '';
      this.postScriptName = this._name.postScriptName || '';
    }
  }

  /** Name table accessor; lazily populated by _ensure. */
  get name() { this._ensure(); return this._name; }

  /// fvar reader. Null-object (isVariable=false) when font/variations
  /// hasn't been registered. font/variations registers fvar + hvar +
  /// vvar + mvar + (transitive) gvar + avar + IVS as a group.
  get fvar() {
    this._ensure();
    if (this._fvar == null)
      this._fvar = tryNewReader('fvar', this._tables) || nullObjectFor('fvar');
    return this._fvar;
  }
  /** True iff this font ships variation axes (fvar table present). */
  get isVariable() { return this.fvar.isVariable; }

  /// HVAR (horizontal metric variations). Null-object (0-delta) when
  /// font/variations not registered or font has no HVAR.
  get hvar() {
    this._ensure();
    if (this._hvar == null)
      this._hvar = tryNewReader('hvar', this._tables) || nullObjectFor('hvar');
    return this._hvar;
  }

  /// VVAR (vertical metric variations). Null-object when font/variations
  /// not registered.
  get vvar() {
    this._ensure();
    if (this._vvar == null)
      this._vvar = tryNewReader('vvar', this._tables) || nullObjectFor('vvar');
    return this._vvar;
  }

  /// GDEF (Glyph Definition) — ALWAYS ON. Used by GSUB/GPOS
  /// lookupFlag filtering and cursor placement inside ligatures;
  /// dropping it would break basic kerning + ligature behavior.
  get gdef() {
    this._ensure();
    if (this._gdef == null) this._gdef = new GdefReader(this._tables);
    return this._gdef;
  }

  /// VORG (Vertical Origin). Null-object when font/vertical not
  /// registered. Used only in vertical writing-mode rendering.
  get vorg() {
    this._ensure();
    if (this._vorg == null)
      this._vorg = tryNewReader('vorg', this._tables) || nullObjectFor('vorg');
    return this._vorg;
  }

  /// BASE (Baseline alignment). Null-object when font/baseline not
  /// registered. Used for mixed-script line alignment.
  get base() {
    this._ensure();
    if (this._base == null)
      this._base = tryNewReader('base', this._tables) || nullObjectFor('base');
    return this._base;
  }

  /// JSTF (justification) reader; lazily built. Null-object when not
  /// registered. Supplies Arabic kashida extender glyphs for the
  /// justify path.
  get jstf() {
    this._ensure();
    if (this._jstf == null)
      this._jstf = tryNewReader('jstf', this._tables) || nullObjectFor('jstf');
    return this._jstf;
  }

  /// AAT 'morx' glyph-metamorphosis reader; lazily built. Null-object
  /// when not registered. Drives shaping for AAT-only fonts.
  get morx() {
    this._ensure();
    if (this._morx == null)
      this._morx = tryNewReader('morx', this._tables) || nullObjectFor('morx');
    return this._morx;
  }

  /// AAT 'kerx' extended-kerning reader; lazily built. Null-object when
  /// not registered.
  get kerx() {
    this._ensure();
    if (this._kerx == null)
      this._kerx = tryNewReader('kerx', this._tables) || nullObjectFor('kerx');
    return this._kerx;
  }

  /// True when AAT contextual/anchor kerning (kerx format 1/4) should run:
  /// the font ships such a subtable and has NO GSUB (HarfBuzz uses the AAT
  /// positioning path when the OpenType one isn't present).
  get usesAatKerning() {
    this._ensure();
    return !this._tables.gsub && this.kerx.hasContextualKerning;
  }

  /// AAT 'feat' feature-name reader; lazily built. Metadata for a
  /// feature-picker UI; does not change default shaping.
  get feat() {
    this._ensure();
    if (this._feat == null)
      this._feat = tryNewReader('feat', this._tables) || nullObjectFor('feat');
    return this._feat;
  }

  /// AAT legacy 'mort' metamorphosis reader; lazily built. Null-object
  /// when not registered. Preferred only when there's no 'morx'.
  get mort() {
    this._ensure();
    if (this._mort == null)
      this._mort = tryNewReader('mort', this._tables) || nullObjectFor('mort');
    return this._mort;
  }

  /// True when the font shapes via AAT (has morx or legacy mort) and
  /// carries NO GSUB table — the signal to run the AAT pass instead of
  /// the OpenType GSUB chain (HarfBuzz prefers GSUB whenever present).
  get usesAatShaping() {
    this._ensure();
    return (this.morx.hasMorx || this.mort.hasMort) && !this._tables.gsub;
  }

  /// Run AAT glyph metamorphosis over a glyph-id run, preferring the
  /// modern 'morx' table over the legacy 'mort' (matching CoreText /
  /// HarfBuzz). Returns { gids, src } — see AatMorx.apply.
  applyAatShaping(gids) {
    this._ensure();
    if (this.morx.hasMorx) return this.morx.apply(gids);
    if (this.mort.hasMort) return this.mort.apply(gids);
    return { gids: gids.slice(), src: gids.map((_, i) => i) };
  }

  /// STAT (Style Attributes). Null-object when font/variations not
  /// registered (STAT lives in the same opt-in group as fvar etc.).
  get stat() {
    this._ensure();
    if (this._stat == null)
      this._stat = tryNewReader('stat', this._tables) || nullObjectFor('stat');
    return this._stat;
  }

  /// MATH (Math typesetting). Null-object when font/math not
  /// registered. Pairs with the math script-shaper at the textRun
  /// level: math content needs BOTH font/scripts/math (stretchy
  /// codepoint detection) AND font/math (the MATH table reader).
  get math() {
    this._ensure();
    if (this._math == null)
      this._math = tryNewReader('math', this._tables) || nullObjectFor('math');
    return this._math;
  }

  /// MVAR (font-wide metrics variations). Null-object when
  /// font/variations not registered.
  get mvar() {
    this._ensure();
    if (this._mvar == null)
      this._mvar = tryNewReader('mvar', this._tables) || nullObjectFor('mvar');
    return this._mvar;
  }

  /// Variation-aware font-wide metrics (ascender, descender, lineGap,
  /// underlinePosition, underlineThickness) at USER-SPACE axis coords.
  /// Returns an object with em-normalized values. Falls back to the
  /// static font.ascent / .descent / etc when this font isn't variable
  /// or doesn't ship MVAR.
  getMetricsVar(userCoords) {
    this._ensure();
    const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
    if (!this.isVariable || userCoords == null || !this.mvar.hasMvar) {
      return {
        ascent: this.ascent, descent: this.descent, lineGap: this.lineGap,
        capHeight: this.capHeight, xHeight: this.xHeight,
        underlinePosition:  this.underlinePosition,
        underlineThickness: this.underlineThickness,
      };
    }
    const n = this.fvar.normalizeCoords(userCoords);
    return {
      ascent:  this.ascent  + this.mvar.delta('hasc', n) * inv,
      descent: this.descent + this.mvar.delta('hdsc', n) * inv,
      lineGap: this.lineGap + this.mvar.delta('hlgp', n) * inv,
      // OS/2 capHeight + xHeight variations live under MVAR tags
      // 'cpht' (cap height) and 'xhgt' (x-height). Falls back to the
      // static values when the font's MVAR doesn't carry those tags.
      capHeight: this.capHeight + this.mvar.delta('cpht', n) * inv,
      xHeight:   this.xHeight   + this.mvar.delta('xhgt', n) * inv,
      underlinePosition:  this.underlinePosition  + this.mvar.delta('unds', n) * inv,
      underlineThickness: this.underlineThickness + this.mvar.delta('undo', n) * inv,
    };
  }

  /// Font-wide metrics packet. Returns the FONT's
  /// typographic metrics (NOT per-string ink bounds) in em-normalized
  /// form, ready for layout consumers to scale + position text
  /// against `fontSize × emHeight` instead of the per-string bbox.
  ///
  /// Ascent / descent are positive distances FROM the baseline (the font's
  /// internal `descent` field is NEGATIVE; this getter returns its
  /// magnitude so layout doesn't have to think about sign).
  ///
  /// `emHeight = ascent + descent` is the canonical "line height of a
  /// single line, no extra leading" — the value the layout
  /// scales screen px against to keep on-screen heights consistent
  /// across strings.
  ///
  /// When `userCoords` is supplied AND this font is variable, returns
  /// metrics interpolated to those axis values via MVAR. The result
  /// is also stable across `setText()` for the SAME bundle (the
  /// bundle snapshots them at build time).
  fontMetrics(userCoords = null) {
    this._ensure();
    const m = (userCoords != null) ? this.getMetricsVar(userCoords) : null;
    const ascent  = m ? m.ascent  : this.ascent;
    const descNeg = m ? m.descent : this.descent;   // negative
    const lineGap = m ? m.lineGap : this.lineGap;
    const capH    = m ? m.capHeight : this.capHeight;
    const xH      = m ? m.xHeight   : this.xHeight;
    const descent = -descNeg;                        // positive
    return {
      unitsPerEm: this.unitsPerEm,
      ascent, descent, lineGap,
      capHeight: capH, xHeight: xH,
      emHeight: ascent + descent,
    };
  }

  /// Advance width for `gid` morphed by USER-SPACE axis coords.
  /// Falls back to static hmtx when:
  ///   * the font isn't variable, OR
  ///   * userCoords is null, OR
  ///   * HVAR is absent — phantom-point advance from gvar when present.
  /// Returns advance in em units.
  getGlyphAdvanceVar(gid, userCoords) {
    this._ensure();
    const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
    const baseFu = this._tables.glyphAdvanceWidth(gid);
    if (!this.isVariable || userCoords == null) {
      return baseFu * inv;
    }
    if (this.hvar.hasHvar) {
      const n = this.fvar.normalizeCoords(userCoords);
      const deltaFu = this.hvar.advanceDelta(gid, n);
      return (baseFu + deltaFu) * inv;
    }
    const n = this.fvar.normalizeCoords(userCoords);
    const advFu = glyphGvarAdvanceFu(gid, this._tables, n);
    if (advFu != null) return advFu * inv;
    return baseFu * inv;
  }

  _computeMetrics(gid, segs) {
    const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
    const adv = this._tables.glyphAdvanceWidth(gid) * inv;
    const lsb = this._tables.glyphLeftSideBearing(gid) * inv;
    let bbox = [0, 0, 0, 0];
    if (segs && segs.length > 0) {
      let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
      const acc = (p) => {
        if (p[0] < xmin) xmin = p[0];
        if (p[0] > xmax) xmax = p[0];
        if (p[1] < ymin) ymin = p[1];
        if (p[1] > ymax) ymax = p[1];
      };
      for (const s of segs) {
        acc(s.p1);
        if (s.type === 0) acc(s.p2);
        else if (s.type === 1) { acc(s.p2); acc(s.p3); }
        else if (s.type === 2) { acc(s.p2); acc(s.p3); acc(s.p4); }
      }
      bbox = [xmin * inv, ymin * inv, xmax * inv, ymax * inv];
    }
    return { advance: adv, leftBearing: lsb, ascent: this.ascent, descent: this.descent, bbox };
  }

  /// Em-normalized distance from baseline (y=0) to the topmost y of
  /// the glyph for `codepoint`. Used as the capHeight / xHeight
  /// fallback when OS/2 v2+ sxHeight / sCapHeight aren't present.
  /// Returns 0 when the glyph is missing or has no segments
  /// (e.g. .notdef on a stripped font); callers can detect 0 and
  /// substitute a reasonable default (typical capHeight ≈ 0.7 em,
  /// xHeight ≈ 0.5 em).
  _measureGlyphHeight(codepoint) {
    const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
    if (inv === 0) return 0;
    const gid = this._tables.codepointToGlyphIndex(codepoint);
    if (!gid) return 0;
    const segs = readGlyph(this._tables, gid);
    if (!segs || segs.length === 0) return 0;
    let ymax = -Infinity;
    const acc = (p) => { if (p[1] > ymax) ymax = p[1]; };
    for (const s of segs) {
      acc(s.p1);
      if (s.type === 0) acc(s.p2);
      else if (s.type === 1) { acc(s.p2); acc(s.p3); }
      else if (s.type === 2) { acc(s.p2); acc(s.p3); acc(s.p4); }
    }
    return ymax === -Infinity ? 0 : ymax * inv;
  }

  /// Vertical metrics — returns advance height (em) + topSideBearing
  /// (em) for vertical-writing layout. Falls back to advance=1.0 (one
  /// em-box height) when the font has no vmtx, which is the
  /// conventional default for ideograph fonts.
  getVerticalMetricsByGid(gid) {
    this._ensure();
    const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
    return {
      advanceHeight: this._tables.glyphAdvanceHeight(gid) * inv,
      topSideBearing: this._tables.glyphTopSideBearing(gid) * inv,
    };
  }

  /// True iff this font ships a vmtx table.
  get hasVerticalMetrics() {
    this._ensure();
    return this._tables.vmtx != null;
  }

  /// Unified vertical origin (em) — distance from the glyph cell's
  /// baseline up to the glyph's vertical origin point. Used by
  /// vertical-mode layout to position each glyph in its cell.
  ///
  /// Resolution order per OT spec:
  ///   1. VORG table (if present): returns its vertOriginY for gid.
  ///   2. vmtx-derived: vhea.ascender + (negative) topSideBearing → top
  ///      of glyph; we return that converted to em.
  ///   3. Fallback: vertTypoAscender or 0.5em (half em-box).
  getVerticalOriginY(gid) {
    this._ensure();
    const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
    if (this.vorg.hasTable) {
      return this.vorg.getVertOriginY(gid) * inv;
    }
    if (this.hasVerticalMetrics) {
      // vmtx topSideBearing is the gap from cell top down to glyph
      // top, in font units. With vhea.ascender as the cell-top
      // position, the glyph's vertical origin (visual top) is:
      //   originY = ascender - topSideBearing
      const ascFu = this._tables.vertTypoAscender || 0;
      const tsbFu = this._tables.glyphTopSideBearing(gid);
      return (ascFu - tsbFu) * inv;
    }
    // No vmtx, no VORG — use vertTypoAscender if available, else half em.
    return (this._tables.vertTypoAscender || (this.unitsPerEm * 0.5)) * inv;
  }

  /// vhea typographic ascender (em) — distance from origin up to top
  /// of glyph cell. Used by vertical-mode line spacing. 0 when no vhea.
  get vertTypoAscender() {
    this._ensure();
    return (this._tables.vertTypoAscender || 0)
      * (this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0);
  }
  get vertTypoDescender() {
    this._ensure();
    return (this._tables.vertTypoDescender || 0)
      * (this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0);
  }
  get vertTypoLineGap() {
    this._ensure();
    return (this._tables.vertTypoLineGap || 0)
      * (this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0);
  }
}
