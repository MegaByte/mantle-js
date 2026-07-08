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
// The graph evaluator (filterGraph.js) already tolerates a missing
// entry: dispatch[node.type] === undefined falls through to passthrough.
// So an asset that uses no filters / no COLR pulls in none of those
// handlers; the rest are dead code the bundler drops.
//
// SVG filters split per-primitive (assets commonly use one or two).
// COLR paints register as a single set — a COLRv1 paint graph can use
// any node type and you can't know which without parsing the font, so
// the realistic granularity is "COLR on / off", matching the single
// Features.ColrPaintGraph bit.

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
