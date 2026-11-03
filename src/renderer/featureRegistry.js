// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// featureRegistry.js — the slots optional renderer features register into.
//
// The renderer core imports none of these features. A feature is a module under renderer/features/, reached through its own
// subpath (`@kontek/mantle/renderer/features/<name>`); importing it registers the implementation here, and the renderer asks
// this registry at the point of use. The root entry imports them all. A feature that is requested and not registered throws
// (an explicit request: an option or a method call) or warns once (a feature an asset's content reaches), naming the import.
//
// State lives in this one module, so unbundled ESM served from one origin shares a single registry across every page script
// that resolves it to the same URL, and a feature registered by one script is visible to the others.

import { missingFeatureHint } from '../core/missingFeature.js';

/** Feature name -> the subpath that registers it. The messages and the CDN recipe are generated from this. */
export const RENDERER_FEATURES = Object.freeze({
  frameExport: '@kontek/mantle/renderer/features/frameExport',
  cpatch: '@kontek/mantle/renderer/features/cpatch',
  filters: '@kontek/mantle/renderer/features/filters',
});

const _slots = Object.create(null);

export function registerRendererFeature(name, impl) {
  if (!(name in RENDERER_FEATURES))
    throw new Error(`registerRendererFeature: unknown feature '${name}'`);
  _slots[name] = impl;
}

/** The registered implementation, or null. */
export function getRendererFeature(name) {
  return _slots[name] || null;
}

export function hasRendererFeature(name) {
  return !!_slots[name];
}

/** The registered implementation; throws, naming the import to add, when there is none. */
export function requireRendererFeature(name, what) {
  const impl = _slots[name];
  if (impl) return impl;
  throw new Error(
    `[Mantle] ${what} needs the '${name}' renderer feature, which is not registered. Add: ${missingFeatureHint(RENDERER_FEATURES[name])}`,
  );
}

/** Registered feature names, for diagnostics and tests. */
export function registeredRendererFeatures() {
  return Object.keys(_slots);
}
