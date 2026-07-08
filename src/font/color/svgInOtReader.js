// svgInOtReader.js — SVG-in-OT table reader.
//
// The OpenType 'SVG ' table embeds SVG documents inside the font.
// Twemoji ships this way: each glyph has (or shares) an SVG
// document that references the gid by `id="glyph{N}"`. Rendering
// the gid means rendering that referenced element through the
// SVG importer.
//
// Spec: https://learn.microsoft.com/en-us/typography/opentype/spec/svg

const GZIP_MAGIC = 0x1F8B;  // gzip header magic — 'SVG ' allows gzipped docs

/// When an SVG-in-OT document covers multiple glyphs, the sub-element
/// with id="glyph{N}" is the one to render for gid N. Lift that
/// subtree into its own SVG document so the importer renders only
/// that piece (everything else stays "defs-only" / hidden).
///
/// The lifted document preserves the parent <svg>'s viewBox / width /
/// height / xmlns so the sub-element's coordinates land in the
/// original em-space frame. When `subElementId` doesn't match (single-
/// glyph documents, or callers passing null), `svgText` returns
/// unchanged.
///
/// Strategy: leave the original tree intact, hide every NON-target
/// `<g id="glyph{N}">` sibling via display="none". The renderer skips
/// hidden subtrees during the importer walk; defs / gradients /
/// filters remain reachable for the target subtree to reference.
///
/// Optional `outerTransform` is spliced (prepended) onto the target
/// glyph group's `transform` attribute so callers (e.g. font/textRun
/// for SVG-in-OT emoji emit) can pipe a per-glyph translate/scale
/// through the importer's CTM machinery without manual seg transform.
export function liftGlyphSubElement(svgText, subElementId, outerTransform = null) {
  if (!subElementId) return svgText;
  // DOMParser must be wired up (browser default; Node polyfills
  // from xmldom).
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root) return svgText;
  // Find the target element. Try getElementById first (browser),
  // fall back to a manual walk for xmldom which doesn't index ids.
  let target = (typeof doc.getElementById === 'function')
    ? doc.getElementById(subElementId)
    : null;
  if (!target) target = findById(root, subElementId);
  if (!target) return svgText;
  // Walk every `<g id="glyph...">` element under root and hide the
  // ones whose id isn't subElementId. We only need to neutralize
  // top-level glyph groups (siblings of the target); nested
  // <g id="glyph..."> shouldn't occur in well-formed docs.
  hideOtherGlyphGroups(root, subElementId);
  if (outerTransform) {
    // Prepend: outer is applied AFTER any inner transform when CTM
    // composes L→R.
    const existing = (typeof target.getAttribute === 'function')
      ? (target.getAttribute('transform') || '')
      : '';
    const spliced = existing
      ? outerTransform + ' ' + existing
      : outerTransform;
    if (typeof target.setAttribute === 'function') {
      target.setAttribute('transform', spliced);
    }
  }
  // Serialize. Browsers and xmldom both expose XMLSerializer.
  const ser = new XMLSerializer();
  return ser.serializeToString(doc);
}

function findById(node, id) {
  if (!node || node.nodeType !== 1) return null;
  if (typeof node.getAttribute === 'function'
      && node.getAttribute('id') === id) return node;
  const ch = node.childNodes;
  if (!ch) return null;
  for (let i = 0; i < ch.length; i++) {
    const r = findById(ch[i], id);
    if (r) return r;
  }
  return null;
}

function hideOtherGlyphGroups(root, keepId) {
  // BFS through element children, marking sibling `glyph{N}` groups
  // hidden. Stops descending into the target so it stays visible.
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    const ch = n.childNodes;
    if (!ch) continue;
    for (let i = 0; i < ch.length; i++) {
      const c = ch[i];
      if (c.nodeType !== 1) continue;
      const id = (typeof c.getAttribute === 'function')
        ? c.getAttribute('id') : null;
      if (id && id !== keepId && /^glyph\d+$/.test(id)) {
        // Hide this sibling subtree.
        if (typeof c.setAttribute === 'function') {
          c.setAttribute('display', 'none');
        }
        // Don't descend into hidden subtrees — every `glyph{N}` is
        // a leaf-level group in well-formed SVG-in-OT docs.
        continue;
      }
      stack.push(c);
    }
  }
}

/// Detect gzip header bytes (1F 8B). Caller is responsible for
/// gunzipping when this returns true; this module doesn't pull
/// in a decompressor (browsers have DecompressionStream, Node has
/// zlib — each environment wires its own).
export function isGzipped(bytes) {
  return bytes != null && bytes.length >= 2
    && bytes[0] === 0x1F && bytes[1] === 0x8B;
}

/// Per-glyph SVG payload. The bytes may be gzip-compressed; reader
/// exposes `isGzipped` so callers can decompress before parsing.
/// `subElementId` is the id the SVG importer should target inside
/// the document (e.g. "glyph2087"); when the document only has
/// one glyph, the importer can render the whole tree.
export class SvgInOtGlyph {
  constructor(svgBytes, isGzipped, subElementId, startGid, endGid) {
    this.svgBytes = svgBytes;
    this.isGzipped = isGzipped;
    this.subElementId = subElementId;
    this.startGid = startGid;
    this.endGid = endGid;
  }
}

export class SvgInOtReader {
  /** @param {object} tables result of parseTtfTables */
  constructor(tables) {
    this._view = tables.view;
    this._bytes = tables.bytes;
    this._tableOff = -1;
    this._docListOff = -1;
    this._version = -1;
    this._numEntries = 0;
    // Parsed records: [{ startGid, endGid, docOff (absolute), docLen }]
    this._records = null;

    if (!tables.svg) return;
    const v = this._view;
    const off = tables.svg[0];
    this._tableOff = off;
    this._version = v.getUint16(off + 0, false);
    if (this._version !== 0) return;
    const listRel = v.getUint32(off + 2, false);
    this._docListOff = off + listRel;
    this._numEntries = v.getUint16(this._docListOff, false);
  }

  get hasSvg()      { return this._version === 0 && this._numEntries > 0; }
  get numEntries()  { return this._numEntries; }

  /// Returns the SvgInOtGlyph for `gid`, or null when no record
  /// covers this gid.
  getGlyph(gid) {
    if (!this.hasSvg) return null;
    this._ensureRecords();
    // Records are sorted by startGid per spec — binary search.
    let lo = 0, hi = this._records.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this._records[mid];
      if (gid > r.endGid) lo = mid + 1;
      else if (gid < r.startGid) hi = mid - 1;
      else {
        const start = r.docOff;
        const end = start + r.docLen;
        // Slice into the original buffer.
        const svgBytes = new Uint8Array(this._bytes.buffer,
                                        this._bytes.byteOffset + start,
                                        r.docLen);
        const isGzipped = svgBytes.length >= 2
          && svgBytes[0] === 0x1F && svgBytes[1] === 0x8B;
        // Per spec: when the document covers multiple glyphs, the
        // sub-element with id="glyph{N}" is the one to render for
        // gid N. When the document covers exactly one glyph, the
        // ID is still typically present but the whole document
        // works as a fallback.
        return new SvgInOtGlyph(svgBytes, isGzipped, `glyph${gid}`,
                                r.startGid, r.endGid);
      }
    }
    return null;
  }

  _ensureRecords() {
    if (this._records != null) return;
    const v = this._view;
    const recs = new Array(this._numEntries);
    // First record starts 2 bytes into the doc list (after numEntries).
    for (let i = 0; i < this._numEntries; i++) {
      const recOff = this._docListOff + 2 + i * 12;
      const startGid = v.getUint16(recOff + 0, false);
      const endGid   = v.getUint16(recOff + 2, false);
      const docRel   = v.getUint32(recOff + 4, false);
      const docLen   = v.getUint32(recOff + 8, false);
      // docRel is from the start of the document list.
      recs[i] = { startGid, endGid,
                  docOff: this._docListOff + docRel, docLen };
    }
    this._records = recs;
  }
}
