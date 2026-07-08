// svg/pattern.js — <pattern> element parsing.
//
// Owns turning a <pattern> element into the geometry the importer needs
// to build a vector-pattern tile: the tile size (width/height) and the
// optional patternTransform. The CLAIM/RENDER of the tile — re-entering
// the shape walk on the pattern subtree and capturing its shape range —
// stays in importer.js because it is bound to the walk()/ctx machinery,
// so the parser lives here and the importer/emitter performs the claim.

import { parseLengthOr } from './length.js';
import { parseTransform } from './transform.js';

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
    tileEmW: parseLengthOr(el.getAttribute('width')  || '0', 0),
    tileEmH: parseLengthOr(el.getAttribute('height') || '0', 0),
    // patternTransform — an extra transform on the pattern's coordinate
    // system (commonly rotate(θ) for diagonal stripe / hatch fills). The
    // tile children stay walked in pattern-local space; the transform is
    // applied to the SAMPLE coord in the shader (its inverse), because a
    // rotated/skewed tile can't wrap on an axis-aligned lattice.
    patM: parseTransform(el.getAttribute('patternTransform') || ''),
  };
}
