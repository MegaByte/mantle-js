// overrides.js — per-shape runtime overrides.
//
// One override table per scene-graph node that owns a bundle;
// callers `set('shapeId', { tint, visibility, fill, stroke,
// strokeWidth, … })` and the table re-packs a 6-texel-per-shape
// RGBA32F texture the fill shader reads.
//
// Texture layout (one row per shape, six RGBAFloat texels per row):
//   col 0 : (m00, m01, m10, m11) — 2×2 affine basis (row-major)
//   col 1 : (tx, ty, visibility, overrideMask) — see mask bits below

import { mantleWarn } from '../core/diagnostics.js';
//   col 2 : (tint.r, tint.g, tint.b, tint.a) — multiplied into fill+stroke
//   col 3 : (fillR, fillG, fillB, fillA) — absolute fill color (mask bit 0)
//   col 4 : (strokeR, strokeG, strokeB, strokeA) — absolute stroke color (mask bit 1)
//   col 5 : (strokeWidth, _, _, _) — absolute stroke width (mask bit 2)
//
// overrideMask bits (read by the shader as `int(ovP.w + 0.5)`):
//   0x1 — replace meta fillColor with col 3
//   0x2 — replace meta strokeColor with col 4
//   0x4 — replace meta strokeWidth with col 5.x
//
// Texels 0–2 are unconditional (the affine/visibility/tint chain).
// Texels 3–5 are gated by the mask so shapes that don't override an
// attribute leave the underlying meta value alone.
//
// Animation drivers (SVG SMIL, Lottie, Flash shape-tween playback)
// push the resolved per-frame value of each animated attribute via
// `set('shapeId', { fill: [r,g,b,a] })` — the renderer reads it
// per-pixel without re-uploading the curve plane or meta buffer.
//
// Public API:
//   const table = createOverrideTable(gl, bundle);
//   table.set('hat',   { tint: [1,0,0,1] });
//   table.set('shirt', { visibility: 0 });
//   table.set('box',   { fill: [0,1,0,1], strokeWidth: 4 });
//   table.clear('hat');
//   table.uploadIfDirty();        // called automatically by renderer
//   table.dispose();              // releases the GL texture
//
// The override texture is owned by the table, not the bundle, so
// the same bundle can be drawn multiple times per frame with
// independent overrides.

/** Per-shape override record. All fields optional; omitted fields
 *  fall back to identity (no transform, full visibility, white tint,
 *  no absolute attribute overrides).
 *
 *  @typedef {Object} MantleShapeOverride
 *  @property {string}   [shapeId]
 *  @property {[number, number]} [localPosition] em-space (tx, ty)
 *  @property {number}   [localRotation]         radians
 *  @property {[number, number]} [localScale]    per-axis scale
 *  @property {[number, number, number, number]} [tint] rgba in [0,1] — multiplicative
 *  @property {number}   [visibility]            0..1; 0 = hidden
 *  @property {[number, number, number, number]} [fill] absolute fill RGBA (replaces meta)
 *  @property {[number, number, number, number]} [stroke] absolute stroke RGBA (replaces meta)
 *  @property {number}   [strokeWidth]           absolute em-space width (replaces meta)
 */

const TEXELS_PER_SHAPE = 6;
const FLOATS_PER_TEXEL = 4;
const FLOATS_PER_SHAPE = TEXELS_PER_SHAPE * FLOATS_PER_TEXEL;
// overrideMask bits encoded in texel 1.w. When a bit is set, the
// corresponding absolute-override texel replaces the meta value at
// draw time. Bits 0/1/2 cover fill / stroke / strokeWidth.
const OVR_MASK_FILL         = 0x1;
const OVR_MASK_STROKE       = 0x2;
const OVR_MASK_STROKE_WIDTH = 0x4;
const IDENTITY_TEXELS = new Float32Array([
  1, 0, 0, 1,   // 0 m00, m01, m10, m11 (identity 2×2)
  0, 0, 1, 0,   // 1 tx, ty, visibility=1, overrideMask=0
  1, 1, 1, 1,   // 2 tint = white
  0, 0, 0, 0,   // 3 absolute fill — unused when mask & 0x1 == 0
  0, 0, 0, 0,   // 4 absolute stroke — unused when mask & 0x2 == 0
  0, 0, 0, 0,   // 5 absolute strokeWidth (.x) — unused when mask & 0x4 == 0
]);

/**
 * Create an override table for a bundle. Bundle must expose `numShapes`
 * and `shapeIds` (importSvg output / createBundle / textRun all do).
 *
 * @param {WebGL2RenderingContext} gl
 * @param {object} bundle  createBundle output (must carry numShapes + shapeIds)
 * @returns {MantleOverrideTable}
 */
export function createOverrideTable(gl, bundle) {
  if (!gl) throw new Error('createOverrideTable: gl required');
  if (!bundle || typeof bundle.numShapes !== 'number' || bundle.numShapes <= 0) {
    throw new Error('createOverrideTable: bundle must have numShapes > 0');
  }
  const n = bundle.numShapes;
  const ids = bundle.shapeIds || new Array(n).fill('');

  // Build the id → index map once. Bundles ship stable ids for the
  // lifetime of the bundle handle; we don't need to detect mutation.
  const idIndex = new Map();
  let _anyId = false;
  for (let i = 0; i < ids.length; i++) {
    const s = ids[i];
    if (s) {
      _anyId = true;
      if (!idIndex.has(s)) idIndex.set(s, i);
    }
  }
  // Surface the "bundle has no string ids at all" diagnostic exactly
  // once: without it, an empty shapeIds array makes every
  // set('foo', ...) return false, indistinguishable from "this id
  // doesn't exist".
  let _warnedNoIds = false;

  // Pre-fill the packed buffer with identity. Exponential tile so the
  // per-shape write cost is sub-linear.
  const packed = new Float32Array(n * FLOATS_PER_SHAPE);
  packed.set(IDENTITY_TEXELS, 0);
  let filled = 1;
  while (filled < n) {
    const copyN = Math.min(filled, n - filled);
    packed.copyWithin(filled * FLOATS_PER_SHAPE, 0, copyN * FLOATS_PER_SHAPE);
    filled += copyN;
  }

  // Per-shape "is currently overridden" bitfield. Used by uploadIfDirty
  // to skip the rebuild when no overrides are active.
  const overridden = new Uint8Array(n);
  // Animated-clipper transforms by clipSvgId. setClipper bakes the affine
  // into the clip's shape ROWS (which is what the shader reads), but also
  // records the raw {localPosition, localRotation, localScale} here so the
  // SVG-export path can reproduce it on the live <clipPath>/<mask> element:
  // the GL shader transforms sample coords, but a serialized SVG must
  // transform the clip element itself.
  const _clippers = new Map();
  let anyDirty = true;   // first upload always runs
  // Monotonic counter bumped on every actual upload (whenever the override
  // state changed since the last upload). Consumers compare it
  // frame-to-frame to detect animation changes without inspecting the
  // buffer — used by the renderer's filter result cache as the dirty signal.
  let _generation = 0;
  // Per-shape change counter. Bumped whenever that shape's override is
  // mutated, so the filter result cache can invalidate a filter region only
  // when its feeding shape(s) changed — not on every global override edit.
  // Direct-buffer / clearAll / markDirty paths that can't localize bump a
  // global epoch instead (see shapeGenOf).
  const _shapeGen = new Uint32Array(n);
  let _globalEpoch = 0;   // added to every shapeGenOf() result
  // Inclusive dirty-row band for uploadIfDirty: a morph's setT touches only a
  // few rows (src-only/dst-only crossfade), so we texSubImage2D just that band
  // instead of the whole n-row plane. Starts full for the first upload; reset
  // empty (_dirtyLo>_dirtyHi) after each upload. Every mutation site routes
  // through _touchShape (localized) or _touchAll (whole-plane), so the band
  // stays correct.
  let _dirtyLo = 0, _dirtyHi = n - 1;
  const _touchShape = (idx) => {
    if (idx >= 0 && idx < n) {
      _shapeGen[idx]++;
      if (idx < _dirtyLo) _dirtyLo = idx;
      if (idx > _dirtyHi) _dirtyHi = idx;
    }
  };
  const _touchAll = () => { _globalEpoch++; _dirtyLo = 0; _dirtyHi = n - 1; };

  // Allocate + upload the GL texture immediately, so the table is
  // bindable even before the bundle's main pass first fires.
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F,
                TEXELS_PER_SHAPE, n, 0, gl.RGBA, gl.FLOAT, packed);
  gl.bindTexture(gl.TEXTURE_2D, null);

  function writeShape(idx, o) {
    const base = idx * FLOATS_PER_SHAPE;
    // 2×2 affine: M = R(rot) · S(scale) (column-major math, row-major
    // storage).
    const rot = o && typeof o.localRotation === 'number' ? o.localRotation : 0;
    const sx = o && o.localScale ? +o.localScale[0] : 1;
    const sy = o && o.localScale ? +o.localScale[1] : 1;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    packed[base + 0] = cos * sx;
    packed[base + 1] = -sin * sy;
    packed[base + 2] = sin * sx;
    packed[base + 3] = cos * sy;
    packed[base + 4] = o && o.localPosition ? +o.localPosition[0] : 0;
    packed[base + 5] = o && o.localPosition ? +o.localPosition[1] : 0;
    let vis = (o && typeof o.visibility === 'number') ? +o.visibility : 1;
    if (vis < 0) vis = 0;
    if (vis > 1) vis = 1;
    packed[base + 6] = vis;
    // Per-attribute override mask in texel 1.w.
    let mask = 0;
    if (o && o.fill)          mask |= OVR_MASK_FILL;
    if (o && o.stroke)        mask |= OVR_MASK_STROKE;
    if (o && typeof o.strokeWidth === 'number') mask |= OVR_MASK_STROKE_WIDTH;
    packed[base + 7] = mask;
    if (o && o.tint) {
      packed[base + 8]  = +o.tint[0];
      packed[base + 9]  = +o.tint[1];
      packed[base + 10] = +o.tint[2];
      packed[base + 11] = +o.tint[3];
    } else {
      packed[base + 8] = 1; packed[base + 9] = 1; packed[base + 10] = 1; packed[base + 11] = 1;
    }
    // Texel 3 — absolute fill.
    if (o && o.fill) {
      packed[base + 12] = +o.fill[0];
      packed[base + 13] = +o.fill[1];
      packed[base + 14] = +o.fill[2];
      packed[base + 15] = +o.fill[3];
    } else {
      packed[base + 12] = 0; packed[base + 13] = 0;
      packed[base + 14] = 0; packed[base + 15] = 0;
    }
    // Texel 4 — absolute stroke.
    if (o && o.stroke) {
      packed[base + 16] = +o.stroke[0];
      packed[base + 17] = +o.stroke[1];
      packed[base + 18] = +o.stroke[2];
      packed[base + 19] = +o.stroke[3];
    } else {
      packed[base + 16] = 0; packed[base + 17] = 0;
      packed[base + 18] = 0; packed[base + 19] = 0;
    }
    // Texel 5 — absolute strokeWidth (.x); reserved (.y .z .w).
    packed[base + 20] = (o && typeof o.strokeWidth === 'number') ? +o.strokeWidth : 0;
    packed[base + 21] = 0; packed[base + 22] = 0; packed[base + 23] = 0;
  }

  function resetShape(idx) {
    const base = idx * FLOATS_PER_SHAPE;
    packed[base + 0] = 1; packed[base + 1] = 0;
    packed[base + 2] = 0; packed[base + 3] = 1;
    packed[base + 4] = 0; packed[base + 5] = 0;
    packed[base + 6] = 1; packed[base + 7] = 0;
    packed[base + 8] = 1; packed[base + 9] = 1; packed[base + 10] = 1; packed[base + 11] = 1;
    // Reset the absolute-override texels to zero. The mask in texel 1.w
    // is cleared above so the shader won't read these anyway, but
    // leaving them zero keeps the upload deterministic.
    for (let k = 12; k < 24; k++) packed[base + k] = 0;
  }

  /** Resolve a key to a shape index. Logs a one-shot warning when a
   *  string key misses on a bundle with zero string ids — the usual
   *  signal that shapeIds was not populated at import time. */
  function resolveIdx(key) {
    if (typeof key === 'number') {
      return (key >= 0 && key < n) ? key : -1;
    }
    if (typeof key === 'string') {
      const i = idIndex.get(key);
      if (i == null) {
        if (!_anyId && !_warnedNoIds) {
          _warnedNoIds = true;
          mantleWarn(
            `MantleOverrideTable: bundle.shapeIds is empty — set('${key}', …) ` +
            `will never resolve. Did the bundle source forget to populate ` +
            `shapeIds? Pass a numeric shape index instead, or check the ` +
            `bundle's shapeIds array.`,
          );
        }
        return -1;
      }
      return i;
    }
    return -1;
  }

  return /** @type {MantleOverrideTable} */ ({
    get gl() { return gl; },
    get bundle() { return bundle; },
    get numShapes() { return n; },
    get texture() { return tex; },
    get textureWidth() { return TEXELS_PER_SHAPE; },
    get textureHeight() { return n; },

    /** Set the override for a shape (by id or index). Writes ALL
     *  fields; omitted fields revert to identity. Drivers that want
     *  to preserve other fields should call `update()` instead. */
    set(key, o) {
      const idx = resolveIdx(key);
      if (idx < 0) return false;
      writeShape(idx, o || {});
      overridden[idx] = 1;
      _touchShape(idx);
      anyDirty = true;
      return true;
    },

    /** Merge fields into the existing override row. Fields present in
     *  `partial` are written; fields absent are LEFT UNCHANGED. Use
     *  this when multiple animation drivers (e.g., a morph driving
     *  visibility + an SVG SMIL driver pushing fill) share an override
     *  table. Returns true if the shape was found.
     *
     *  For absolute attribute overrides (fill, stroke, strokeWidth),
     *  setting the field flips the mask bit; passing `null` for an
     *  attribute CLEARS its mask bit and zeros the slot. */
    update(key, partial) {
      const idx = resolveIdx(key);
      if (idx < 0) return false;
      const base = idx * FLOATS_PER_SHAPE;
      const p = partial || {};
      // Transform
      if ('localRotation' in p || 'localScale' in p) {
        const m00 = packed[base + 0], m10 = packed[base + 2];
        const m01 = packed[base + 1], m11 = packed[base + 3];
        // SIGNED scale recovery: hypot() is always positive, so a mirror
        // (negative scale) silently un-flipped on the next update(). Fix
        // the rotation from column 0, then project each column onto its
        // rotated axis — a det<0 matrix decomposes as a negative sy
        // (same matrix family: (rot, −sx, −sy) ≡ (rot+π, sx, sy)).
        const rotCur = Math.atan2(m10, m00);
        const cosC = Math.cos(rotCur), sinC = Math.sin(rotCur);
        const sxCur = (m00 * cosC + m10 * sinC) || 1;
        const syCur = (m11 * cosC - m01 * sinC) || 1;
        const rot = p.localRotation != null ? +p.localRotation : rotCur;
        const sx  = p.localScale ? +p.localScale[0] : sxCur;
        const sy  = p.localScale ? +p.localScale[1] : syCur;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        packed[base + 0] = cos * sx;
        packed[base + 1] = -sin * sy;
        packed[base + 2] = sin * sx;
        packed[base + 3] = cos * sy;
      }
      if (p.localPosition) {
        packed[base + 4] = +p.localPosition[0];
        packed[base + 5] = +p.localPosition[1];
      }
      if ('visibility' in p) {
        let v = +p.visibility;
        if (v < 0) v = 0; if (v > 1) v = 1;
        packed[base + 6] = v;
      }
      if (p.tint) {
        packed[base + 8]  = +p.tint[0];
        packed[base + 9]  = +p.tint[1];
        packed[base + 10] = +p.tint[2];
        packed[base + 11] = +p.tint[3];
      }
      let mask = Math.floor(packed[base + 7] + 0.5);
      if ('fill' in p) {
        if (p.fill == null) {
          mask &= ~OVR_MASK_FILL;
          packed[base + 12] = 0; packed[base + 13] = 0;
          packed[base + 14] = 0; packed[base + 15] = 0;
        } else {
          mask |= OVR_MASK_FILL;
          packed[base + 12] = +p.fill[0];
          packed[base + 13] = +p.fill[1];
          packed[base + 14] = +p.fill[2];
          packed[base + 15] = +p.fill[3];
        }
      }
      if ('stroke' in p) {
        if (p.stroke == null) {
          mask &= ~OVR_MASK_STROKE;
          packed[base + 16] = 0; packed[base + 17] = 0;
          packed[base + 18] = 0; packed[base + 19] = 0;
        } else {
          mask |= OVR_MASK_STROKE;
          packed[base + 16] = +p.stroke[0];
          packed[base + 17] = +p.stroke[1];
          packed[base + 18] = +p.stroke[2];
          packed[base + 19] = +p.stroke[3];
        }
      }
      if ('strokeWidth' in p) {
        if (p.strokeWidth == null) {
          mask &= ~OVR_MASK_STROKE_WIDTH;
          packed[base + 20] = 0;
        } else {
          mask |= OVR_MASK_STROKE_WIDTH;
          packed[base + 20] = +p.strokeWidth;
        }
      }
      packed[base + 7] = mask;
      overridden[idx] = 1;
      _touchShape(idx);
      anyDirty = true;
      return true;
    },

    /** Read the current override for a shape, as a plain object.
     *  Returns identity values when no override is set. */
    get(key) {
      const idx = resolveIdx(key);
      if (idx < 0) return null;
      const base = idx * FLOATS_PER_SHAPE;
      // Recover (rot, scale) from the 2x2 affine assuming we packed it
      // ourselves. Decomposition: scale_x = |column 0|, scale_y = |column 1|,
      // rot = atan2(m10, m00) when scale_x > 0. Returns nominal values
      // when the table holds identity.
      const m00 = packed[base + 0], m01 = packed[base + 1];
      const m10 = packed[base + 2], m11 = packed[base + 3];
      const sx = Math.hypot(m00, m10) || 1;
      const sy = Math.hypot(m01, m11) || 1;
      const rot = Math.atan2(m10, m00);
      const mask = Math.floor(packed[base + 7] + 0.5);
      const out = {
        shapeId: typeof key === 'string' ? key : (bundle.shapeIds && bundle.shapeIds[idx]) || '',
        localPosition: [packed[base + 4], packed[base + 5]],
        localRotation: rot,
        localScale: [sx, sy],
        visibility: packed[base + 6],
        tint: [packed[base + 8], packed[base + 9], packed[base + 10], packed[base + 11]],
      };
      if (mask & OVR_MASK_FILL)
        out.fill = [packed[base + 12], packed[base + 13], packed[base + 14], packed[base + 15]];
      if (mask & OVR_MASK_STROKE)
        out.stroke = [packed[base + 16], packed[base + 17], packed[base + 18], packed[base + 19]];
      if (mask & OVR_MASK_STROKE_WIDTH)
        out.strokeWidth = packed[base + 20];
      return out;
    },

    /** Remove an override (reverts the shape to identity). */
    clear(key) {
      const idx = resolveIdx(key);
      if (idx < 0) return false;
      resetShape(idx);
      overridden[idx] = 0;
      _touchShape(idx);
      anyDirty = true;
      return true;
    },

    /** Set an animated 2D affine transform on a `<clipPath id="...">`
     *  mask. Mirrors `set` / `update` but writes the transform to ALL
     *  layer rows in the clip's range (multi-shape clips transform as
     *  one unit). The shader transforms the visible shape's sample
     *  coord by the clip's INVERSE affine before evaluating clip
     *  coverage — equivalent to translating / scaling / rotating the
     *  clip mask in world space without touching the clipped shapes.
     *
     *  @param {string} clipSvgId  the SVG `<clipPath id="...">` value
     *  @param {Object} [opts]
     *  @param {[number, number]} [opts.localPosition]  em-space (tx, ty)
     *  @param {number} [opts.localRotation]            radians
     *  @param {[number, number]} [opts.localScale]     per-axis scale
     *  @returns {boolean} true when the clip resolved to a known row range
     */
    setClipper(clipSvgId, opts) {
      const range = bundle.clipperRows && bundle.clipperRows[clipSvgId];
      if (!range) return false;
      const [firstRow, lastRow] = range;
      for (let row = firstRow; row <= lastRow; row++) {
        if (row < 0 || row >= n) continue;
        // Use `update` semantics so a setClipper followed by a `set` on
        // an unrelated attribute (e.g. visibility on the same row, if
        // the caller is weird about it) doesn't clobber the transform.
        const base = row * FLOATS_PER_SHAPE;
        const rot = opts && typeof opts.localRotation === 'number' ? +opts.localRotation : 0;
        const sx = opts && opts.localScale ? +opts.localScale[0] : 1;
        const sy = opts && opts.localScale ? +opts.localScale[1] : 1;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        packed[base + 0] = cos * sx;
        packed[base + 1] = -sin * sy;
        packed[base + 2] = sin * sx;
        packed[base + 3] = cos * sy;
        packed[base + 4] = opts && opts.localPosition ? +opts.localPosition[0] : 0;
        packed[base + 5] = opts && opts.localPosition ? +opts.localPosition[1] : 0;
        // Leave visibility / tint / mask alone — they may be driven by
        // a separate animator. Clip eval reads the clip's bbox + bands
        // directly, so a clip child's visibility isn't a meaningful axis
        // here.
        overridden[row] = 1;
        _touchShape(row);
      }
      // Record the raw transform in the export-facing map (see _clippers).
      _clippers.set(clipSvgId, {
        localPosition: opts && opts.localPosition
          ? [+opts.localPosition[0], +opts.localPosition[1]] : [0, 0],
        localRotation: opts && typeof opts.localRotation === 'number' ? +opts.localRotation : 0,
        localScale: opts && opts.localScale ? [+opts.localScale[0], +opts.localScale[1]] : [1, 1],
      });
      anyDirty = true;
      return true;
    },

    /** Reset a clip's transform to identity. */
    clearClipper(clipSvgId) {
      const range = bundle.clipperRows && bundle.clipperRows[clipSvgId];
      if (!range) return false;
      const [firstRow, lastRow] = range;
      for (let row = firstRow; row <= lastRow; row++) {
        if (row < 0 || row >= n) continue;
        const base = row * FLOATS_PER_SHAPE;
        packed[base + 0] = 1; packed[base + 1] = 0;
        packed[base + 2] = 0; packed[base + 3] = 1;
        packed[base + 4] = 0; packed[base + 5] = 0;
        _touchShape(row);
      }
      _clippers.delete(clipSvgId);
      anyDirty = true;
      return true;
    },

    /** Map<clipSvgId, {localPosition, localRotation, localScale}> of active
     *  clipper transforms. Read by the SVG-export replay to transform the
     *  live <clipPath> element. */
    get clippers() { return _clippers; },

    /** Drop all overrides; every shape reverts to identity. */
    clearAll() {
      for (let i = 0; i < n; i++) resetShape(i);
      overridden.fill(0);
      _clippers.clear();
      _touchAll();
      anyDirty = true;
    },

    /** True if at least one override is currently active. */
    get hasAny() {
      for (let i = 0; i < n; i++) if (overridden[i]) return true;
      return false;
    },

    /** Indices of shapes with an active override. Lets a consumer (e.g.
     *  the SVG-export replay) sparsely iterate only the overridden rows. */
    activeIndices() {
      const out = [];
      for (let i = 0; i < n; i++) if (overridden[i]) out.push(i);
      return out;
    },

    /** Upload the packed buffer to the GL texture if anything changed
     *  since the last upload. Idempotent + cheap when clean. */
    uploadIfDirty() {
      if (!anyDirty) return;
      const lo = Math.max(0, _dirtyLo), hi = Math.min(n - 1, _dirtyHi);
      if (lo <= hi) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        // Upload only the dirty row band [lo, hi] (yoffset=lo, height=rows).
        const sub = packed.subarray(lo * FLOATS_PER_SHAPE, (hi + 1) * FLOATS_PER_SHAPE);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, lo,
                         TEXELS_PER_SHAPE, hi - lo + 1, gl.RGBA, gl.FLOAT, sub);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      anyDirty = false;
      _dirtyLo = n; _dirtyHi = -1;   // band consumed
      _generation++;
    },

    /** Monotonic generation counter. Bumps whenever the override state
     *  changed since the last upload (i.e. whenever uploadIfDirty did
     *  work). Compare frame-to-frame to detect animation changes. */
    get generation() { return _generation; },

    /** Force the next uploadIfDirty() to actually upload. Used when
     *  the caller has mutated the underlying buffer directly. Since a
     *  direct-buffer write can't say WHICH shapes changed, bump the
     *  global epoch so every shapeGenOf() advances (conservative). */
    markDirty() { anyDirty = true; _touchAll(); },

    /** Per-shape change counter (includes the global epoch). The filter
     *  result cache compares this for each shape that feeds a filter
     *  region; a change means re-evaluate that filter. */
    shapeGenOf(idx) {
      return ((idx >= 0 && idx < n) ? _shapeGen[idx] : 0) + _globalEpoch;
    },

    /** Direct view into the packed Float32 buffer. Useful for
     *  Animator-driven hot paths that want to write without per-shape
     *  function call overhead. Call markDirty() afterwards. */
    get packedBuffer() { return packed; },
    get texelsPerShape() { return TEXELS_PER_SHAPE; },

    /** Free the GL texture. The table is unusable after this call. */
    dispose() {
      if (tex) gl.deleteTexture(tex);
    },
  });
}
