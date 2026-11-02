// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// SVG pattern attributes and template content selection.

import { parseLengthOr } from './length.js';
import { parseTransform } from './transform.js';
import { svgElementName } from './utils.js';
import { mantleWarn } from '../core/diagnostics.js';

const PATTERN_ATTRS = [
  'x',
  'y',
  'width',
  'height',
  'patternUnits',
  'patternContentUnits',
  'patternTransform',
  'viewBox',
  'preserveAspectRatio',
];

/**
 * A `<pattern>` as SVG defines it after `href` inheritance (SVG 2 §14.3.4): each attribute comes from the first pattern
 * in the href chain that specifies it, and content from the first pattern with non-descriptive child elements. The chain is followed
 * through `byId` and stops at a cycle. SVG sets no limit on its length; `maxDepth` only bounds a pathological document, and a
 * chain it cuts is reported, never dropped quietly.
 * @param {Element} el
 * @param {Record<string, Element>} byId pattern elements by id
 * @returns {{ attrs: Record<string, string|null>, owners: Record<string, Element|null>, contentEl: Element }}
 *   `owners` is the pattern each attribute came from (its font-size is the one an em in it is of).
 */
export function resolvePatternDef(el, byId, maxDepth = 4096) {
  const chain = [];
  const seen = new Set();
  for (let cur = el, d = 0; cur && !seen.has(cur); d++) {
    if (d > maxDepth) {
      mantleWarn(
        `pattern: href chain longer than ${maxDepth} links; the patterns past it are ignored.`,
      );
      break;
    }
    seen.add(cur);
    chain.push(cur);
    const href = cur.getAttribute('href') || cur.getAttribute('xlink:href') || '';
    const id = href.startsWith('#') ? href.slice(1) : '';
    cur = id && byId ? byId[id] : null;
  }
  const attrs = {},
    owners = {};
  for (const a of PATTERN_ATTRS) {
    const from = chain.find((c) => c.hasAttribute(a));
    attrs[a] = from ? from.getAttribute(a) : null;
    owners[a] = from || null;
  }
  const hasKids = (c) => {
    for (let n = c.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 1) continue;
      const name = svgElementName(n);
      if (name !== 'title' && name !== 'desc' && name !== 'metadata') return true;
    }
    return false;
  };
  return { attrs, owners, contentEl: chain.find(hasKids) || el };
}

/**
 * Parse a `<pattern>` element's tile geometry.
 * @param {Element} el the `<pattern>` element
 * @returns {{ element: Element, tileEmW: number, tileEmH: number, patM: number[] }}
 *   `tileEmW`/`tileEmH` are the tile dimensions in em space (0 for a
 *   degenerate pattern — the caller drops the fill); `patM` is the parsed
 *   `patternTransform` matrix (identity when absent).
 */
export function parsePatternDef(el) {
  return {
    element: el,
    tileEmW: parseLengthOr(el.getAttribute('width') || '0', 0),
    tileEmH: parseLengthOr(el.getAttribute('height') || '0', 0),
    // patternTransform — an extra transform on the pattern's coordinate
    // system (commonly rotate(θ) for diagonal stripe / hatch fills). The
    // tile children stay walked in pattern-local space; the transform is
    // applied to the SAMPLE coord in the shader (its inverse), because a
    // rotated/skewed tile can't wrap on an axis-aligned lattice.
    patM: parseTransform(el.getAttribute('patternTransform') || ''),
  };
}
