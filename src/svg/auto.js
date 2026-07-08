// svg/auto — automatic, tree-shaking-friendly filter / COLR handler
// registration.
//
//   import { autoRegisterForSvg } from '@kontek/mantle/svg/auto';
//   const { bundle, registered } = await autoRegisterForSvg(svgText);
//   // `bundle` is ready to render; the GL handlers its filters/COLR
//   // paints need are now registered.
//
// Inspects which optional renderer subsystems an SVG actually exercises
// (filter primitives, COLRv1 paint graph) and pulls exactly those handler
// modules with a dynamic `import()`, so a bundler splits each into its own
// lazily-loaded chunk. The initial bundle carries only the always-on
// renderer core (geometry / strokes / clips / masks / gradients).
//
// Detection is claim-on-use precise: an feGaussianBlur in an unreferenced
// <filter> contributes nothing.
//
// For a known asset set, the build generator emits the same registrations
// as static imports (full dead-code elimination, no async, plus
// feature-scoped shaders). This runtime path is for dynamic / unknown SVGs
// where you can't run a build step.

import importSvg from './importer.js';
import { inspect } from '../bundle/featureSet.js';
import { featuresToModules } from '../bundle/featureManifest.js';

/**
 * Inspect an SVG (or an already-imported bundle) and register exactly the
 * optional renderer handlers it needs.
 *
 * @param {string|object} svgOrBundle  Raw SVG text, or a bundle from
 *   `importSvg({ bundleForm:false })`.
 * @param {object} [opts]  When `svgOrBundle` is text, merged into the
 *   `importSvg` options (default `{ bundleForm:false }` so the result is
 *   inspectable and render-ready).
 * @returns {Promise<{bundle: object, registered: string[]}>}
 *   `bundle` is the inspected bundle (parsed here when text was given, so
 *   callers don't re-parse); `registered` lists the subpaths pulled in.
 */
export async function autoRegisterForSvg(svgOrBundle, opts = {}) {
  const bundle = (typeof svgOrBundle === 'string')
    ? await importSvg(svgOrBundle, { bundleForm: false, ...opts })
    : svgOrBundle;
  const registered = [];
  for (const subpath of featuresToModules(inspect(bundle))) {
    await import(subpath);                 // side-effect: the module self-registers
    registered.push(subpath.replace('@kontek/mantle/', ''));
  }
  return { bundle, registered };
}
