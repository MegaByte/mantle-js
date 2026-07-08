// nativeOverrideTable.js — a CPU-only per-shape override store with the
// SAME surface as createOverrideTable (set / update / get / setClipper /
// clearClipper / clear / clearAll), but with NO GL dependency.
//
// The WebGL override table packs into a Float32 texture the shader
// reads. The native-SVG fallback has no shader: it applies overrides by
// mutating DOM attributes (transform / opacity / fill / stroke) on each
// shape's <g>/<path>. So it needs the override STATE in plain-object
// form, not a texture. This store keeps each shape's override as a
// plain object and exposes a `generation` counter the scene polls to
// know when to re-apply attributes.
//
// Animation drivers (createShapeMorph's visibility fades, timelines,
// app code) call set/update exactly as they would on the GL table — so
// the same driver code runs unchanged in fallback mode. The only
// difference is where the state lands (an object map vs. a texture).

// Shared frozen identity defaults returned by get() for unset fields, so a
// clean/partial override costs ZERO array allocation per get() (the hot path:
// the scene calls get() per active shape per frame). Read-only by every
// consumer (applyShapeOverride reads, never mutates); frozen so an accidental
// write throws instead of corrupting every shape's "default".
const ID_POS = Object.freeze([0, 0]);
const ID_SCALE = Object.freeze([1, 1]);
const ID_TINT = Object.freeze([1, 1, 1, 1]);

/**
 * @param {object} bundle  Mantle bundle (needs shapeIds + clipperRows)
 * @returns {object} table with the createOverrideTable method surface
 */
export function createNativeOverrideTable(bundle) {
  const n = bundle.numShapes | 0;
  const ids = bundle.shapeIds || new Array(n).fill('');
  const idToIdx = new Map();
  for (let i = 0; i < n; i++) {
    if (ids[i]) idToIdx.set(ids[i], i);
  }
  // Per-shape override object (null = identity). Mirrors the GL table's
  // "overridden" sparse set.
  const ovr = new Array(n).fill(null);
  // Per-clip affine (keyed by clipSvgId). Read by the scene to transform
  // the live <clipPath>/<mask> element.
  const clippers = new Map();
  let generation = 1;

  function resolveIdx(key) {
    if (typeof key === 'number') return (key >= 0 && key < n) ? key : -1;
    const idx = idToIdx.get(key);
    return idx == null ? -1 : idx;
  }

  function bump() { generation++; }

  // Extra shapes to INJECT into the bundle <g> (no counterpart in the source
  // markup) — used by the native morph for dst-only shapes. Each is a static
  // descriptor { key, pathD, fill, stroke, strokeWidth, evenOdd, alpha };
  // only `alpha` changes per frame (the fade-in). `extrasGen` bumps when the
  // scene should re-read them.
  let extras = null;
  let extrasGen = 0;

  return {
    get bundle() { return bundle; },
    get numShapes() { return n; },
    get generation() { return generation; },
    // Marks this as a CPU table so the scene can read state directly
    // instead of poking at a (nonexistent) GL texture.
    get isNative() { return true; },

    // Injected (source-markup-less) shapes — see above.
    setExtraShapes(list) { extras = (list && list.length) ? list : null; extrasGen++; },
    get extraShapes() { return extras; },
    get extrasGeneration() { return extrasGen; },
    bumpExtras() { extrasGen++; },

    set(key, o) {
      const idx = resolveIdx(key);
      if (idx < 0) return false;
      ovr[idx] = o ? { ...o } : {};
      bump();
      return true;
    },

    update(key, partial) {
      const idx = resolveIdx(key);
      if (idx < 0) return false;
      // Mutate the stored override IN PLACE (no per-call spread) — this runs
      // per shape per frame for a morph/timeline, so the spread was real GC.
      // Same null-clears-attribute semantics as the GL table (fill:null drops
      // the absolute fill override).
      let cur = ovr[idx];
      if (!cur) cur = ovr[idx] = {};
      const p = partial || {};
      for (const k of Object.keys(p)) {
        if ((k === 'fill' || k === 'stroke' || k === 'strokeWidth') && p[k] == null) {
          delete cur[k];
        } else {
          cur[k] = p[k];
        }
      }
      bump();
      return true;
    },

    get(key) {
      const idx = resolveIdx(key);
      if (idx < 0) return null;
      const o = ovr[idx];
      // Fresh wrapper (no caller-aliasing), but unset fields reuse shared
      // frozen identity arrays and set fields return the STORED array by
      // reference (consumers read, never mutate) — so the common case
      // allocates one small object instead of an object + 3–4 arrays.
      if (!o) {
        return {
          shapeId: typeof key === 'string' ? key : (ids[idx] || ''),
          localPosition: ID_POS, localRotation: 0, localScale: ID_SCALE,
          visibility: 1, tint: ID_TINT, fill: undefined, stroke: undefined,
          strokeWidth: undefined, pathD: undefined,
        };
      }
      return {
        shapeId: typeof key === 'string' ? key : (ids[idx] || ''),
        localPosition: o.localPosition || ID_POS,
        localRotation: typeof o.localRotation === 'number' ? o.localRotation : 0,
        localScale: o.localScale || ID_SCALE,
        visibility: typeof o.visibility === 'number' ? o.visibility : 1,
        tint: o.tint || ID_TINT,
        fill: o.fill || undefined,
        stroke: o.stroke || undefined,
        strokeWidth: typeof o.strokeWidth === 'number' ? o.strokeWidth : undefined,
        // Morph-driven `d` override (set by the native morph; not a GL
        // concept). When present the scene rewrites the path geometry.
        pathD: typeof o.pathD === 'string' ? o.pathD : undefined,
      };
    },

    /** True if a shape has any active override (used to skip clean shapes). */
    isOverridden(key) {
      const idx = resolveIdx(key);
      return idx >= 0 && ovr[idx] != null;
    },

    /** Iterate active override indices (scene re-apply loop). */
    activeIndices() {
      const out = [];
      for (let i = 0; i < n; i++) if (ovr[i] != null) out.push(i);
      return out;
    },

    setClipper(clipSvgId, opts) {
      const range = bundle.clipperRows && bundle.clipperRows[clipSvgId];
      if (!range) return false;
      clippers.set(clipSvgId, {
        localPosition: opts && opts.localPosition
          ? [+opts.localPosition[0], +opts.localPosition[1]] : [0, 0],
        localRotation: opts && typeof opts.localRotation === 'number' ? +opts.localRotation : 0,
        localScale: opts && opts.localScale ? [+opts.localScale[0], +opts.localScale[1]] : [1, 1],
      });
      bump();
      return true;
    },

    clearClipper(clipSvgId) {
      if (clippers.delete(clipSvgId)) bump();
      return true;
    },

    /** Map<clipSvgId, {localPosition, localRotation, localScale}>. */
    get clippers() { return clippers; },

    clear(key) {
      const idx = resolveIdx(key);
      if (idx < 0) return false;
      if (ovr[idx] != null) { ovr[idx] = null; bump(); }
      return true;
    },

    clearAll() {
      ovr.fill(null);
      clippers.clear();
      bump();
    },

    get hasAny() {
      for (let i = 0; i < n; i++) if (ovr[i]) return true;
      return clippers.size > 0;
    },

    // No-ops so a caller written against the GL table (which calls
    // uploadIfDirty / dispose each frame) works unchanged.
    uploadIfDirty() {},
    markDirty() { bump(); },
    dispose() {},
  };
}
