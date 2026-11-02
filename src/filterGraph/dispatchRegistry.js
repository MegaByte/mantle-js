// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// dispatchRegistry.js — opt-in registries for the two renderer-side
// filter-graph dispatchers: SVG <filter> primitives and COLRv1 paint
// nodes. Handlers are absent by default and register themselves when their
// handler module is imported, so a consumer ships only the GL handlers
// their assets need.
//
// Default state: empty. Handler modules (filterGraph/primitives/*.js for
// SVG filters, filterGraph/colr/paints.js for COLR) call the matching
// register*() at import time. These modules are listed in
// package.json#sideEffects, so importing them IS the registration.
//
// The graph evaluator (filterGraph.js) tolerates a missing entry:
// dispatch[node.type] === undefined routes to unhandledNode, which copies the
// input through so the element renders UNFILTERED rather than vanishing. So an
// asset that uses no filters / no COLR pulls in none of those handlers; the
// rest are dead code the bundler drops.
//
// That degradation is only graceful for a primitive whose input is another
// node's output. Leaving out a handler is still a visible change, not a
// no-op — omit deliberately, and prefer primitives/all.js when unsure.
//
// SVG filters split per-primitive (assets commonly use one or two).
// COLR paints register as a single set — a COLRv1 paint graph can use
// any node type and you can't know which without parsing the font, so
// the realistic granularity is "COLR on / off", matching the single
// Features.ColrPaintGraph bit.

import { warnMissingFeature } from '../core/missingFeature.js';

// ── SVG filter primitives ──────────────────────────────────────────
const _svgFilters = Object.create(null);

/// Register a handler for an SVG filter primitive node type
/// (e.g. 'feGaussianBlur'). Two type names may share one handler
/// (feDiffuseLighting / feSpecularLighting → feLightingDispatch).
export function registerSvgFilter(nodeType, handler) {
  _svgFilters[nodeType] = handler;
}

/// Snapshot of the currently-registered SVG filter handlers, suitable
/// for passing as the `dispatch` arg of evaluateGraph(). Returns a fresh
/// object so the renderer can cache it without aliasing the registry.
export function svgFilterDispatch() {
  return Object.assign(Object.create(null), _svgFilters);
}

/// Whether any handler is registered for a given node type. Mainly for
/// diagnostics / tests asserting which primitives a build included.
export function hasSvgFilter(nodeType) {
  return nodeType in _svgFilters;
}

/// The node types currently registered. Diagnostics only.
export function registeredSvgFilters() {
  return Object.keys(_svgFilters);
}

// ── COLRv1 paint nodes ─────────────────────────────────────────────
const _colrPaints = Object.create(null);

/// Register a handler for a COLRv1 paint node type (e.g. 'PaintSolid').
/// Handlers are already nodeIdx-wrapped by the paints module.
export function registerColrPaint(nodeType, handler) {
  _colrPaints[nodeType] = handler;
}

/// Snapshot of the currently-registered COLR paint handlers, for passing
/// as the `dispatch` arg of evaluateGraph(). Returns a fresh object.
export function colrPaintDispatch() {
  return Object.assign(Object.create(null), _colrPaints);
}

/// Whether any COLR paint handler is registered. Diagnostics / tests.
export function hasColrPaint(nodeType) {
  return nodeType in _colrPaints;
}

/// The COLR paint node types currently registered. Diagnostics only.
export function registeredColrPaints() {
  return Object.keys(_colrPaints);
}

// ── Missing-handler reporting ──────────────────────────────────────
// Which subpath registers a node type. The evaluator calls warnUnregisteredNode() when it meets a type with no handler, so the
// element's passthrough comes with a message naming the exact import to add (once per type).
const FILTER_MODULE = Object.freeze({
  feGaussianBlur: 'blur',
  feColorMatrix: 'colorMatrix',
  feBlend: 'blend',
  feConvolveMatrix: 'convolve',
  feDisplacementMap: 'displacementMap',
  feComponentTransfer: 'componentTransfer',
  feComposite: 'composite',
  feMerge: 'merge',
  feDiffuseLighting: 'lighting',
  feSpecularLighting: 'lighting',
  feImage: 'image',
  feFlood: 'flood',
  feTile: 'tile',
  feMorphology: 'morphology',
  feTurbulence: 'turbulence',
  feOffset: 'offset',
});

/// The subpath whose import registers `nodeType`, or null for a type Mantle has no handler module for.
export function handlerModuleFor(nodeType) {
  if (FILTER_MODULE[nodeType])
    return `@kontek/mantle/filterGraph/primitives/${FILTER_MODULE[nodeType]}`;
  if (typeof nodeType === 'string' && nodeType.startsWith('Paint'))
    return '@kontek/mantle/filterGraph/colr/paints';
  return null;
}

/// Warn once that a node type has no registered handler (its element draws unfiltered / its glyph layer is skipped).
export function warnUnregisteredNode(nodeType) {
  const sub = handlerModuleFor(nodeType);
  if (!sub) return;
  const what = nodeType.startsWith('Paint')
    ? `a color-font paint graph uses ${nodeType}, which has no handler; the paint is not drawn`
    : `a filter uses ${nodeType}, which has no handler; the filtered element draws without it`;
  warnMissingFeature('node:' + nodeType, what, sub);
}
