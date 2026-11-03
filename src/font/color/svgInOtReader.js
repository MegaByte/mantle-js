// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { viewBoxFit } from '../../svg/transform.js';
import { parseLengthOr } from '../../svg/length.js';
import {
  buildStylesheet,
  setActiveStylesheet,
  clearActiveStylesheet,
} from '../../svg/stylesheet.js';
import { getStyleProp } from '../../svg/style.js';

// svgInOtReader.js — SVG-in-OT table reader.
//
// The OpenType 'SVG ' table embeds SVG documents inside the font.
// Twemoji ships this way: each glyph has (or shares) an SVG
// document that references the gid by `id="glyph{N}"`. Rendering
// the gid means rendering that referenced element through the
// SVG importer.
//
// Spec: https://learn.microsoft.com/en-us/typography/opentype/spec/svg

const GZIP_MAGIC = 0x1f8b; // gzip header magic — 'SVG ' allows gzipped docs

/// Instantiate the selected element through <use>, retaining shared definitions
/// and CSS matches from the source tree. Font calls fit the root viewport to
/// design units and disable root viewport clipping.
export function liftGlyphSubElement(
  svgText,
  subElementId,
  outerTransform = null,
  fontUnitsPerEm = null,
) {
  if (!subElementId || typeof svgText !== 'string' || !svgText) return svgText;
  // DOMParser must be wired up (browser default; Node polyfills
  // from xmldom).
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg' || doc.getElementsByTagName('parsererror').length)
    return svgText;
  // Find the target element. Try getElementById first (browser),
  // fall back to a manual walk for xmldom which doesn't index ids.
  let target = typeof doc.getElementById === 'function' ? doc.getElementById(subElementId) : null;
  if (!target) target = findById(root, subElementId);
  if (!target && !(fontUnitsPerEm > 0)) return svgText;

  freezeSourceStyles(root);
  if (target && target !== root) {
    const definitions = doc.createElementNS('http://www.w3.org/2000/svg', 'defs');
    while (root.firstChild) definitions.appendChild(root.firstChild);
    root.appendChild(definitions);
    const instance = doc.createElementNS('http://www.w3.org/2000/svg', 'use');
    instance.setAttribute('href', '#' + subElementId);
    root.appendChild(instance);
    target = instance;
  }
  if (fontUnitsPerEm > 0) {
    const viewport = { parentWidth: fontUnitsPerEm, parentHeight: fontUnitsPerEm };
    const width = parseLengthOr(root.getAttribute('width'), fontUnitsPerEm, {
      ...viewport,
      axis: 'x',
    });
    const height = parseLengthOr(root.getAttribute('height'), fontUnitsPerEm, {
      ...viewport,
      axis: 'y',
    });
    const vb = (root.getAttribute('viewBox') || '')
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    const fit =
      vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0
        ? viewBoxFit(
            vb[0],
            vb[1],
            vb[2],
            vb[3],
            root.getAttribute('preserveAspectRatio'),
            0,
            0,
            width,
            height,
          )
        : null;
    const existing = root.getAttribute('transform') || '';
    root.setAttribute(
      'transform',
      [outerTransform, existing, fit && `matrix(${fit.join(' ')})`].filter(Boolean).join(' '),
    );
    root.setAttribute('width', String(width));
    root.setAttribute('height', String(height));
    // OpenType glyph viewports never clip, including authored root overrides.
    root.setAttribute('overflow', 'visible');
    root.setAttribute('clip', 'auto');
    root.setAttribute(
      'style',
      (root.getAttribute('style') || '') + ';overflow:visible!important;clip:auto!important',
    );
  } else if (outerTransform) {
    const existing =
      typeof target.getAttribute === 'function' ? target.getAttribute('transform') || '' : '';
    const spliced = existing ? outerTransform + ' ' + existing : outerTransform;
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
  if (typeof node.getAttribute === 'function' && node.getAttribute('id') === id) return node;
  const ch = node.childNodes;
  if (!ch) return null;
  for (let i = 0; i < ch.length; i++) {
    const r = findById(ch[i], id);
    if (r) return r;
  }
  return null;
}

// Resolve author selectors before moving their subjects under <defs>. Keep
// declarations local: a referenced target inherits from <use>, not from its
// former ancestors. currentColor and custom properties resolve on the instance.
function freezeSourceStyles(root) {
  const rules = buildStylesheet(root);
  if (!rules) return;
  setActiveStylesheet(root, rules);
  const properties = new Set();
  for (const rule of rules) for (const name of Object.keys(rule.decls)) properties.add(name);
  const updates = [],
    sheets = [];
  function visit(el) {
    if (el.nodeType !== 1) return;
    if (el.localName === 'style') sheets.push(el);
    else {
      let style = el.getAttribute('style') || '';
      for (const name of properties) {
        const value = getStyleProp(el, name, null, false);
        if (value != null) style += ';' + name + ':' + value + '!important';
      }
      updates.push([el, style]);
    }
    for (let child = el.firstChild; child; child = child.nextSibling) visit(child);
  }
  try {
    visit(root);
  } finally {
    clearActiveStylesheet(root);
  }
  for (const [el, style] of updates) if (style) el.setAttribute('style', style);
  for (const sheet of sheets) sheet.parentNode.removeChild(sheet);
}

/// Detect gzip header bytes (1F 8B). Caller is responsible for
/// gunzipping when this returns true; this module doesn't pull
/// in a decompressor (browsers have DecompressionStream, Node has
/// zlib — each environment wires its own).
export function isGzipped(bytes) {
  return bytes != null && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
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

  get hasSvg() {
    return this._version === 0 && this._numEntries > 0;
  }
  get numEntries() {
    return this._numEntries;
  }

  /// Returns the SvgInOtGlyph for `gid`, or null when no record
  /// covers this gid.
  getGlyph(gid) {
    if (!this.hasSvg) return null;
    this._ensureRecords();
    // Records are sorted by startGid per spec — binary search.
    let lo = 0,
      hi = this._records.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this._records[mid];
      if (gid > r.endGid) lo = mid + 1;
      else if (gid < r.startGid) hi = mid - 1;
      else {
        const start = r.docOff;
        const end = start + r.docLen;
        // Slice into the original buffer.
        const svgBytes = new Uint8Array(
          this._bytes.buffer,
          this._bytes.byteOffset + start,
          r.docLen,
        );
        const isGzipped = svgBytes.length >= 2 && svgBytes[0] === 0x1f && svgBytes[1] === 0x8b;
        // Per spec: when the document covers multiple glyphs, the
        // sub-element with id="glyph{N}" is the one to render for
        // gid N. When the document covers exactly one glyph, the
        // ID is still typically present but the whole document
        // works as a fallback.
        return new SvgInOtGlyph(svgBytes, isGzipped, `glyph${gid}`, r.startGid, r.endGid);
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
      const endGid = v.getUint16(recOff + 2, false);
      const docRel = v.getUint32(recOff + 4, false);
      const docLen = v.getUint32(recOff + 8, false);
      // docRel is from the start of the document list.
      recs[i] = { startGid, endGid, docOff: this._docListOff + docRel, docLen };
    }
    this._records = recs;
  }
}
