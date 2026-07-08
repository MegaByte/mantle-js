// nativeStream.js — streaming geometry updates for the no-WebGL native scene.
//
// The WebGL streaming fast path (updateBundleGeometry) rewrites GPU buffers,
// which the native (createNativeScene) renderer never reads — it draws by
// cloning the bundle's svgSource. This is the native analogue: convert each
// shape's new segment list to a path `d` string and stash the raw array on the
// bundle. The native scene writes those directly onto cloned <path> elements,
// avoiding the generic per-shape override machinery and full SVG rebuilds.
// The hot path is allocation-light: N path strings + N setAttribute, skipped
// entirely when the geometry hasn't changed.
//
// Pairs with updateBundleGeometry (the WebGL path); the engine routes to one or
// the other by backend.
import { segsToPathD } from '../svg/segment.js';

function clamp01(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? (n < 0 ? 0 : (n > 1 ? 1 : n)) : fallback;
}

function rgbaCss(c) {
  if (!c) return null;
  if (typeof c === 'string') return c;
  const r = Math.round(clamp01(c[0]) * 255);
  const g = Math.round(clamp01(c[1]) * 255);
  const b = Math.round(clamp01(c[2]) * 255);
  const a = clamp01(c[3], 1);
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * Stream new fixed-topology geometry into a bundle for the NATIVE scene.
 * Stores per-shape path `d` (+ optional fills) on the bundle; the native
 * scene applies them directly on its next drawBundle. No GL.
 * @param {object} bundle  a buildStreamableSections/createBundle bundle
 * @param {Array<Array<object>>} perShapeSegs  one segment list per shape
 * @param {object} [opts]
 * @param {ReadonlyArray<readonly number[]>} [opts.fills]  per-shape straight rgba
 * @returns {{ok:boolean, reason?:string}}
 */
export function updateNativeBundleGeometry(bundle, perShapeSegs, opts = {}) {
  if (!bundle) return { ok: false, reason: 'no bundle' };
  const n = bundle.numShapes | 0;
  if (!Array.isArray(perShapeSegs) || perShapeSegs.length !== n)
    return { ok: false, reason: 'perShapeSegs length must equal bundle.numShapes' };

  // Reused per-bundle arrays — no per-frame array allocation.
  let ds = bundle.__streamPathD;
  if (!ds || ds.length !== n) { ds = new Array(n); defineHidden(bundle, '__streamPathD', ds); }
  for (let i = 0; i < n; i++) {
    const segs = perShapeSegs[i];
    let d = '';
    if (Array.isArray(segs)) { try { d = segsToPathD(segs) || ''; } catch { d = ''; } }
    ds[i] = d;
  }
  if (opts.fills) {
    let fs = bundle.__streamFills;
    if (!fs || fs.length !== n) { fs = new Array(n); defineHidden(bundle, '__streamFills', fs); }
    for (let i = 0; i < n; i++) fs[i] = rgbaCss(opts.fills[i]);
  }
  // Generation bump — the native scene skips re-applying a slot whose stream
  // generation is unchanged (a paused road costs zero DOM writes).
  defineHidden(bundle, '__streamGen', (bundle.__streamGen | 0) + 1);
  return { ok: true };
}

function defineHidden(obj, key, value) {
  try { Object.defineProperty(obj, key, { value, configurable: true, enumerable: false, writable: true }); }
  catch { try { obj[key] = value; } catch { /* frozen bundle — ignore */ } }
}
