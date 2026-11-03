// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// dropped.js -- what an import left out because the document marks it as not drawn, and the one-time warning that says so.
//
// The default import drops content the document explicitly says draws nothing: a display:none subtree, a visibility:hidden or
// collapse leaf, a shape of zero size, a stroke of width 0, a marker at stroke width 0, an empty group. A runtime API could bring
// some of it back (an override, a morph or a timeline pose), so nothing is dropped silently: the bundle reports
// the counts by class (`bundle.dropped`, absent when nothing was dropped) and the import warns once, naming the option that keeps them.
// `importSvg({ keepHidden: true })` keeps the display:none and visibility:hidden content as rows that draw nothing until an override reveals them;
// the other classes are counted in both modes.

import { mantleWarn } from '../core/diagnostics.js';

/// The report classes, in order, each with the words the warning uses and whether a runtime API could reveal it.
/// Only display:none and visibility:hidden content can be kept (keepHidden), so only those are warned about; the rest is counted.
const CLASSES = [
  ['displayNoneSubtrees', 'display:none subtree', true],
  ['displayNoneShapes', 'shape inside a display:none subtree', false],
  ['hiddenVisibilityLeaves', 'visibility:hidden leaf', true],
  ['zeroSizeShapes', 'zero-size shape', false],
  ['emptyGeometry', 'shape with no geometry (an empty path or too few points)', false],
  ['zeroWidthStrokes', 'stroke of width 0', false],
  ['zeroWidthMarkers', 'marker at stroke width 0', false],
  ['emptyGroups', 'empty group', false],
];

/// The bundle's `dropped` report for the counts `ctx.dropped` gathered, or null when nothing was dropped.
export function droppedReportOf(counts) {
  if (!counts) return null;
  const out = {};
  for (const [key] of CLASSES) if (counts[key] > 0) out[key] = counts[key] | 0;
  return Object.keys(out).length ? out : null;
}

/// Warns once for an import that dropped content a runtime API could reveal, naming `keepHidden`.
export function warnDropped(report, opts) {
  if (!report) return;
  const parts = [];
  for (const [key, words, reveals] of CLASSES)
    if (reveals && report[key] > 0)
      parts.push(`${report[key]} ${words}${report[key] === 1 ? '' : 's'}`);
  if (!parts.length) return;
  mantleWarn(
    `importSvg: left out ${parts.join(', ')}. They draw nothing, so nothing on screen changes, but an override, a morph pose, a timeline ` +
      'or a geometry update cannot reveal them. Pass { keepHidden: true } to keep them as rows that draw nothing until revealed ' +
      '(bundle.dropped lists the counts).',
  );
}
