// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bundle/ — bundle data spec + introspection.
//
// Standalone subpath (`@kontek/mantle/bundle`) for consumers
// that need to inspect a bundle without pulling in WebGL, SVG, or
// font runtime code. Useful for:
//
//   • Distribution-build tooling (which features does this asset need?)
//   • Asset CLI / CI inspectors / size telemetry
//   • Documentation generators
//   • Test fixtures that hand-build bundles for unit tests
//
// All exports are pure JS — no DOM, no WebGL, no async fetch.

// Bundle texel layout — authoritative offset constants for the
// per-shape layout + the gradient / filter table strides. Bit
// positions and field offsets are part of the bundle wire contract.
export * from './layout.js';

// Feature introspection. inspect(bundle) → BigInt flag mask;
// inspectAll([bundles]) → union; toNames(flags) → string[]. (The scene-level fill-omit helpers,
// featuresToFillOmit / BAKED_FILL_FEATURES, belong to the renderer.)
export { Features, inspect, inspectAll, toNames } from './featureSet.js';
