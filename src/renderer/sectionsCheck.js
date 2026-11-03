// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// sectionsCheck.js: createBundle's input contract. A `sections` dict is binary wire data (importSvg,
// sceneToSections and the text builders produce it); a truncated, tampered or JSON-round-tripped one
// must fail with a message that names the problem rather than with a raw TypeError from a DataView.
//
// What is checked is only what is certainly broken: types, the version word, the shape count against
// the meta header, and curve ranges against the curve buffer. A shape's band location (meta glyphLoc) is
// NOT checked: hand-built and legacy sections use it as a curve offset, so it is not reliably a band index.
// The meta header carries a magic and a version word (bytes 20..27, META_MAGIC / META_VERSION; version 3 makes bytes 28..31 a feature-flag word: origin, hidden rows). A header from before they existed has
// those bytes zero and reads as version 1; a buffer with other nonzero bytes in 20..31, or a newer version than this build reads, is
// rejected by name instead of being read as shape data.

import {
  META_HEADER_BYTES,
  META_MAGIC,
  META_VERSION,
  META_FLAG_ORIGIN,
  META_FLAGS_KNOWN,
} from '../bundle/layout.js';

export const SECTIONS_VERSION_MAX = 3;

const isBinary = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v);
const what = (v) =>
  v === undefined
    ? 'missing'
    : v === null
      ? 'null'
      : typeof v === 'object' && !isBinary(v)
        ? 'a plain object (typed arrays do not survive JSON; use structuredClone)'
        : typeof v;

/** Before the meta header is read: the container and the meta section. */
export function checkSectionsHead(sections) {
  if (sections === null || typeof sections !== 'object')
    throw new TypeError(
      'createBundle: sections must be an object from importSvg / sceneToBundle, got ' +
        (sections === null ? 'null' : typeof sections),
    );
  if (!(sections.meta instanceof ArrayBuffer))
    throw new TypeError(
      'createBundle: sections.meta must be an ArrayBuffer, got ' + what(sections.meta),
    );
  const v = sections.version;
  if (v != null && !(Number.isInteger(v) && v >= 1 && v <= SECTIONS_VERSION_MAX))
    throw new Error(
      'createBundle: unsupported sections.version ' +
        JSON.stringify(v) +
        ' (this build reads 1..' +
        SECTIONS_VERSION_MAX +
        ')',
    );
  checkMetaHeader(sections.meta, sections);
}

/** The meta header's tag: zero (version 1), or the magic and a version this build reads. */
export function checkMetaHeader(meta, sections) {
  if (meta.byteLength < META_HEADER_BYTES) return; // empty is a zero-shape bundle; a short non-empty one is parseMetaBin's error
  const dv = new DataView(meta);
  const magic = dv.getUint32(20, true),
    version = dv.getUint32(24, true),
    pad = dv.getUint32(28, true);
  if (magic === 0 && version === 0 && pad === 0) return;
  if (magic !== META_MAGIC)
    throw new Error(
      'createBundle: sections.meta is not a Mantle meta section (header bytes 20..23 are 0x' +
        magic.toString(16) +
        ', expected the tag 0x' +
        META_MAGIC.toString(16) +
        ' or zero)',
    );
  if (version < 2 || version > META_VERSION)
    throw new Error(
      'createBundle: unsupported meta header version ' +
        version +
        ' (this build reads 1..' +
        META_VERSION +
        '; was the buffer written by a newer Mantle?)',
    );
  if (version < 3) {
    if (pad !== 0)
      throw new Error(
        'createBundle: sections.meta header bytes 28..31 must be zero, got 0x' + pad.toString(16),
      );
    return;
  }
  // Version 3: bytes 28..31 are a feature-flag word (bundle/layout.js META_FLAG_*). A flag this build does not know, or an empty word, is refused by name.
  if (pad === 0 || (pad & ~META_FLAGS_KNOWN) !== 0)
    throw new Error(
      'createBundle: sections.meta header flag word 0x' +
        pad.toString(16) +
        ' is not a set of known version-3 flags (this build knows 0x' +
        META_FLAGS_KNOWN.toString(16) +
        '; was the buffer written by a newer Mantle?)',
    );
  // META_FLAG_ORIGIN: the coordinates are relative to sections.origin. A header that says so with no origin (a sections dict that lost the field)
  // would draw and hit-test the bundle at the wrong place, so it is refused by name.
  if (pad & META_FLAG_ORIGIN) {
    const o = sections && sections.origin;
    if (!(o && o.length === 2 && Number.isFinite(o[0]) && Number.isFinite(o[1])))
      throw new Error(
        'createBundle: sections.meta is flagged as relative to a bundle origin but sections.origin is ' +
          (o === undefined ? 'missing' : JSON.stringify(o)) +
          '; it must be a [x, y] pair of finite numbers',
      );
  }
}

/** After parseMetaBin: the buffers the meta rows point into. */
export function checkSectionsBody(sections, parsed) {
  const n = parsed.numShapes;
  if (sections.numShapes != null && sections.numShapes !== n)
    throw new Error(
      'createBundle: sections.numShapes (' +
        sections.numShapes +
        ') does not match the meta header (' +
        n +
        ')',
    );
  if (n === 0) return;
  for (const key of ['curves', 'bands']) {
    if (!isBinary(sections[key]))
      throw new TypeError(
        'createBundle: sections.' + key + ' must be an ArrayBuffer, got ' + what(sections[key]),
      );
  }
  for (const key of ['gradients', 'gradientStops', 'dashes']) {
    const b = sections[key];
    if (b != null && !isBinary(b))
      throw new TypeError(
        'createBundle: sections.' + key + ' must be an ArrayBuffer or null, got ' + what(b),
      );
  }
  const curveFloats = sections.curves.byteLength >> 2;
  const ranges = sections.curveRangesByShape;
  if (ranges != null) {
    if (!Array.isArray(ranges) || ranges.length !== n)
      throw new Error(
        'createBundle: sections.curveRangesByShape must have one range per shape (' +
          n +
          '), got ' +
          (Array.isArray(ranges) ? ranges.length : what(ranges)),
      );
    for (let i = 0; i < n; i++) {
      const r = ranges[i];
      if (!r || !(r.begin >= 0 && r.end >= r.begin && r.end <= curveFloats))
        throw new Error(
          'createBundle: shape ' +
            i +
            ' curve range [' +
            (r && r.begin) +
            ', ' +
            (r && r.end) +
            ') is outside sections.curves (' +
            curveFloats +
            ' floats); the sections are truncated or corrupt',
        );
    }
  }
}
