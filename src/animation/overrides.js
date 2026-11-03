// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { markRevisionedOverrideTable } from '../core/overrideRevision.js';
import { clipperRowGroups } from '../bundle/layout.js';
import { deleteGlResource, trackGlResource } from '../renderer/contextResources.js';
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
import {
  OVERRIDE_COLS,
  checkTableFits,
  tableDims,
  uploadTableRows,
} from '../renderer/tableLayout.js';
import { unwrapBundle } from '../core/unwrapBundle.js';
import { createKeySpace, composeChain, groupOfKey } from './overrideKeys.js';
//   col 2 : (tint.r, tint.g, tint.b, tint.a) — multiplied into fill+stroke
//   col 3 : (fillR, fillG, fillB, fillA) — absolute fill color (mask bit 0)
//   col 4 : (strokeR, strokeG, strokeB, strokeA) — absolute stroke color (mask bit 1)
//   col 5 : (strokeWidth, _, _, _) — absolute stroke width (mask bit 2)
//
// overrideMask bits (read by the shader as `int(ovP.w + 0.5)`):
//   0x1 — replace meta fillColor with col 3
//   0x2 — replace meta strokeColor with col 4
//   0x4 — replace meta strokeWidth with col 5.x
//   0x10 — reveal a row kept hidden (importSvg keepHidden): the CPU draw list and the hit test read it, the shader ignores it
//          (0x8 is the vertex stage's own "moved" bit)
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
 *  The transform acts as the shape's own `transform`, in em space about the
 *  em origin (the DOCUMENT origin, whatever the bundle's `origin` is; the table converts): translate(localPosition) rotate(localRotation) scale(localScale).
 *  The shape is drawn and hit-tested where it puts it, and its clip-path and
 *  mask move with it.
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
 *  @property {boolean}  [reveal]                true = draw and hit-test a row that `importSvg({ keepHidden: true })` kept hidden
 *                                                (display:none, visibility:hidden); on a group id, every hidden row under it
 */

const TEXELS_PER_SHAPE = 6;
const FLOATS_PER_TEXEL = 4;
const FLOATS_PER_SHAPE = TEXELS_PER_SHAPE * FLOATS_PER_TEXEL;
/// A row's values as one number, from their float bits (53 bits of two 32-bit lanes; -0 is 0: `set` writes -sin as the off-diagonal of an unrotated row).
function rowDigest(words, at) {
  let a = 0x811c9dc5,
    b = 0x9e3779b9;
  for (let i = at, end = at + FLOATS_PER_SHAPE; i < end; i++) {
    const w = words[i] === 0x80000000 ? 0 : words[i];
    a = Math.imul(a ^ w, 0x01000193);
    a ^= a >>> 15;
    b = Math.imul(b ^ w, 0x5bd1e995);
    b ^= b >>> 13;
  }
  return (a >>> 0) * 2097152 + (b >>> 11);
}
// overrideMask bits encoded in texel 1.w. When a bit is set, the
// corresponding absolute-override texel replaces the meta value at
// draw time. Bits 0/1/2 cover fill / stroke / strokeWidth.
const OVR_MASK_FILL = 0x1;
const OVR_MASK_STROKE = 0x2;
const OVR_MASK_STROKE_WIDTH = 0x4;
const OVR_MASK_REVEAL = 0x10;
const IDENTITY_TEXELS = new Float32Array([
  1,
  0,
  0,
  1, // 0 m00, m01, m10, m11 (identity 2×2)
  0,
  0,
  1,
  0, // 1 tx, ty, visibility=1, overrideMask=0
  1,
  1,
  1,
  1, // 2 tint = white
  0,
  0,
  0,
  0, // 3 absolute fill — unused when mask & 0x1 == 0
  0,
  0,
  0,
  0, // 4 absolute stroke — unused when mask & 0x2 == 0
  0,
  0,
  0,
  0, // 5 absolute strokeWidth (.x) — unused when mask & 0x4 == 0
]);
const IDENTITY_DIGEST = rowDigest(new Uint32Array(IDENTITY_TEXELS.buffer), 0);

/** The table createOverrideTable returns. Declared because the public
 *  @returns names it, and the generated types/animation/overrides.d.ts
 *  inherits that name — undeclared, every TypeScript consumer hit
 *  `Cannot find name 'MantleOverrideTable'` in a strict build.
 *
 *  @typedef {Object} MantleOverrideTable
 *  @property {WebGL2RenderingContext} gl
 *  @property {object} bundle
 *  @property {number} numShapes          drawn rows
 *  @property {number} numHitOnly         hit-only rows, which follow the drawn rows in `packedBuffer` (0 when the bundle has none)
 *  @property {string[]} groupIds         the group ids a key can address (see the README), [] when the bundle has none
 *  @property {WebGLTexture} texture      RGBA32F, one row per shape (a table of more than 4096 shapes wraps in 4096-row bands)
 *  @property {number} textureWidth
 *  @property {number} textureHeight
 *  @property {(key: string|number, o: object|null) => boolean} set
 *    write ALL fields; omitted fields revert to identity
 *  @property {(key: string|number, partial: object) => boolean} update
 *    merge fields; absent fields are left unchanged
 *  @property {(key: string|number) => object|null} get
 *  @property {(key: string|number) => boolean} clear
 *  @property {(clipSvgId: string, opts: object) => boolean} setClipper
 *  @property {(clipSvgId: string) => boolean} clearClipper
 *  @property {Map<string, object>} clippers
 *  @property {() => void} clearAll
 *  @property {boolean} hasAny
 *  @property {() => number[]} activeIndices
 *  @property {() => void} uploadIfDirty  flush dirty rows to the texture
 *  @property {number} generation         bumps on every upload that carried a mutation
 *  @property {number} revision           bumps on every mutation, before its upload
 *  @property {() => void} markDirty
 *  @property {(idx: number) => number} shapeGenOf
 *  @property {(idx: number) => number} shapeContentOf  what a drawn row says, as a number: equal for equal rows in any table, 0 for an identity row
 *  @property {() => number} contentKey   what the whole table says, as a number
 *  @property {(key: string|number) => object|null} getEffective  the override as drawn: the row's own, under its groups
 *  @property {Float32Array} packedBuffer  (numShapes + numHitOnly) rows; only the first numShapes are uploaded
 *  @property {number} texelsPerShape
 *  @property {() => void} dispose
 */

/** A finite number, else `fallback`: the one coercion for override inputs (NaN, undefined, strings that are not
 *  numbers all read as "not given"). */
const finiteOr = (v, fallback) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : fallback);
/// An absolute color override is a list of components: [r, g, b, a].
const isColorList = (v) => v != null && typeof v === 'object' && typeof v.length === 'number';
/// Absolute-paint rule: a component that is missing or not a finite number takes `dflt[k]` (0 for r, g, b; 1 for a), so a short
/// array like [0, 1, 0] is an opaque green and a NaN never reaches the shader. Finite values are stored as given.
const RGBA_DEFAULT = [0, 0, 0, 1];
function writeRgba(packed, at, v, dflt) {
  for (let k = 0; k < 4; k++) packed[at + k] = finiteOr(v[k], dflt[k]);
}
/// Absolute stroke width: finite and >= 0 (a negative value is 0). Returns NaN when `w` is not a finite number: no override.
const strokeWidthOf = (w) => (typeof w === 'number' && Number.isFinite(w) ? (w < 0 ? 0 : w) : NaN);

/** (rotation, sx, sy) of a row's 2x2 [m00, m01, m10, m11] = R(rot) * diag(sx, sy), the inverse of what set() writes.
 *  The rotation comes from the larger column, so a scale of 0 on one axis keeps the rotation (sx or sy is 0, never
 *  reset to 1); a fully collapsed matrix has no rotation to recover and reads 0. A mirror (det < 0) is reported with
 *  the half-turn folded into both scales so the rotation stays in [-pi/2, pi/2]: scale [-1, 1] reads back as
 *  rotation 0, scale [-1, 1]. */
function decomposeRow(m00, m01, m10, m11) {
  const c0 = Math.hypot(m00, m10),
    c1 = Math.hypot(m01, m11);
  let rot = 0;
  if (c0 > 0 && c0 >= c1) rot = Math.atan2(m10, m00);
  else if (c1 > 0) rot = Math.atan2(-m01, m11);
  const cos = Math.cos(rot),
    sin = Math.sin(rot);
  let sx = m00 * cos + m10 * sin,
    sy = m11 * cos - m01 * sin;
  if (m00 * m11 - m01 * m10 < 0 && cos < 0) {
    rot += rot > 0 ? -Math.PI : Math.PI;
    sx = -sx;
    sy = -sy;
  }
  return [rot, sx, sy];
}

/**
 * Create an override table for a bundle, including an empty bundle.
 * Bundle must expose `numShapes`
 * and `shapeIds` (importSvg output / createBundle / textRun all do).
 *
 * @param {WebGL2RenderingContext} gl
 * @param {object} bundle  createBundle output (must carry numShapes + shapeIds)
 * @returns {MantleOverrideTable}
 */
export function createOverrideTable(gl, bundle) {
  if (!gl) throw new Error('createOverrideTable: gl required');
  bundle = unwrapBundle(bundle);
  if (!bundle || !Number.isInteger(bundle.numShapes) || bundle.numShapes < 0) {
    throw new Error('createOverrideTable: bundle must have a nonnegative integer numShapes');
  }
  const n = bundle.numShapes;
  // The bundle's coordinates are stored relative to its ORIGIN (bundle/layout.js), but an override acts as the shape's own
  // `transform` about the DOCUMENT origin, as documented. In the stored frame p' = M (p + o) + t - o, so the translation the
  // shader adds is t + (M - I) o. It is exactly t when M is the identity (a move), and for a rotation or scale it is the
  // document-origin pivot, computed here in float64. userT / putT are the two directions of that map.
  const OX = bundle.origin ? bundle.origin[0] : 0,
    OY = bundle.origin ? bundle.origin[1] : 0,
    hasO = OX !== 0 || OY !== 0;
  const putT = (P, base, tx, ty) => {
    if (hasO) {
      const m0 = P[base],
        m1 = P[base + 1],
        m2 = P[base + 2],
        m3 = P[base + 3];
      tx += (m0 - 1) * OX + m1 * OY;
      ty += m2 * OX + (m3 - 1) * OY;
    }
    P[base + 4] = tx;
    P[base + 5] = ty;
  };
  const userT = (P, base) =>
    hasO
      ? [
          P[base + 4] - ((P[base] - 1) * OX + P[base + 1] * OY),
          P[base + 5] - (P[base + 2] * OX + (P[base + 3] - 1) * OY),
        ]
      : [P[base + 4], P[base + 5]];
  checkTableFits(gl, 'override table', OVERRIDE_COLS, n, 'createOverrideTable');
  // What a key addresses: drawn rows, the bundle's hit-only rows (which follow the drawn ones in the CPU buffer and are never
  // uploaded), and groups (overrideKeys.js).
  const space = createKeySpace(bundle, n);
  const { H, total, companions } = space;
  const _anyId = space.anyId;
  // Surface the "bundle has no string ids at all" diagnostic exactly
  // once: without it, an empty shapeIds array makes every
  // set('foo', ...) return false, indistinguishable from "this id
  // doesn't exist".
  let _warnedNoIds = false;

  // Pre-fill the packed buffer with identity. Exponential tile so the
  // per-shape write cost is sub-linear.
  const packed = new Float32Array(total * FLOATS_PER_SHAPE);
  if (total) packed.set(IDENTITY_TEXELS, 0);
  let filled = 1;
  while (filled < total) {
    const copyN = Math.min(filled, total - filled);
    packed.copyWithin(filled * FLOATS_PER_SHAPE, 0, copyN * FLOATS_PER_SHAPE);
    filled += copyN;
  }

  // Per-shape "is currently overridden" bitfield. Used by uploadIfDirty
  // to skip the rebuild when no overrides are active.
  const overridden = new Uint8Array(total);
  // Group overrides. `gbuf` holds one override record per distinct group id; a row under an active group keeps its own override in
  // `own` (set / update / get / clear address it) and `packed` holds the composition the draw and the hit test read.
  // Allocated on the first group override: a bundle without groups never pays for them.
  let gbuf = null,
    gActive = null,
    own = null,
    covered = null,
    ownFlag = null;
  const _ownV = new Float64Array(12);
  const _stateV = new Float64Array(12);
  // Animated-clipper transforms by clipSvgId. setClipper bakes the affine
  // into the clip's shape ROWS (which is what the shader reads), but also
  // records the raw {localPosition, localRotation, localScale} here so the
  // SVG-export path can reproduce it on the live <clipPath>/<mask> element:
  // the GL shader transforms sample coords, but a serialized SVG must
  // transform the clip element itself.
  const _clippers = new Map();
  let anyDirty = true; // first upload always runs
  let disposed = false;
  // Monotonic counter bumped on every actual upload (whenever the override
  // state changed since the last upload). Consumers compare it
  // frame-to-frame to detect animation changes without inspecting the
  // buffer — used by the renderer's filter result cache as the dirty signal.
  let _generation = 0;
  // Bumped at the MUTATION (set / update / clear / markDirty), not at the upload `generation` follows. A consumer that must
  // react to a change before this frame's upload (the renderer's occlusion-cull retirement runs before the draw uploads the
  // table) compares this one. A change to a hit-only row alone draws nothing, so it bumps neither counter.
  let _revision = 0;
  // Per-shape change counter. Bumped whenever that shape's override is
  // mutated, so the filter result cache can invalidate a filter region only
  // when its feeding shape(s) changed — not on every global override edit.
  // Direct-buffer / clearAll / markDirty paths that can't localize bump a
  // global epoch instead (see shapeGenOf).
  const _shapeGen = new Uint32Array(n);
  let _globalEpoch = 0;
  // The filter and mask caches key on what a row SAYS, not on its counter: two tables that each wrote a row once agree on the counter and not on the row (see shapeContentOf).
  // Digests are made on demand and kept until the row's counter moves.
  let _digests = null,
    _digestAt = null,
    _digestWords = null,
    _tableDigest = 0,
    _tableDigestAt = -1;
  let _dirtyLo = 0,
    _dirtyHi = n - 1;
  // Morph clip/mask alias rows mirror their origin's override state (clipper transforms).
  const bindingAliases = bundle._morphBindingAliases;
  const copyBindingAliases = (idx) => {
    const list = bindingAliases && bindingAliases[idx];
    if (!list) return;
    for (const alias of list) {
      packed.copyWithin(
        alias * FLOATS_PER_SHAPE,
        idx * FLOATS_PER_SHAPE,
        (idx + 1) * FLOATS_PER_SHAPE,
      );
      overridden[alias] = overridden[idx];
      _shapeGen[alias]++;
      if (alias < _dirtyLo) _dirtyLo = alias;
      if (alias > _dirtyHi) _dirtyHi = alias;
    }
  };
  // The hit-only rows of the same element as a drawn row follow its packed row.
  const syncCompanions = (idx) => {
    const list = companions && companions.get(idx);
    if (!list) return;
    for (const slot of list)
      packed.copyWithin(
        slot * FLOATS_PER_SHAPE,
        idx * FLOATS_PER_SHAPE,
        (idx + 1) * FLOATS_PER_SHAPE,
      );
  };
  const _touchShape = (idx) => {
    if (idx >= n) return; // a hit-only row: nothing is drawn differently
    _revision++;
    if (idx >= 0) {
      copyBindingAliases(idx);
      syncCompanions(idx);
      _shapeGen[idx]++;
      if (idx < _dirtyLo) _dirtyLo = idx;
      if (idx > _dirtyHi) _dirtyHi = idx;
    }
    anyDirty = true;
  };
  const _touchAll = () => {
    _revision++;
    if (bindingAliases) for (let i = 0; i < bindingAliases.length; i++) copyBindingAliases(i);
    if (companions) for (const d of companions.keys()) syncCompanions(d);
    _globalEpoch++;
    _dirtyLo = 0;
    _dirtyHi = n - 1;
  };

  //
  // uploadIfDirty deliberately keeps the original behavior: it runs every frame,
  // its callers rebind their samplers around it, and it has always been green.
  const _prevUnit = gl.getParameter ? gl.getParameter(gl.ACTIVE_TEXTURE) : null;
  const _borrow = _prevUnit != null && gl.activeTexture;
  if (_borrow) gl.activeTexture(gl.TEXTURE15);
  const tex = trackGlResource(gl, gl.createTexture(), 'overrides');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const dims = tableDims(TEXELS_PER_SHAPE, n); // > 4096 shapes wrap in bands (renderer/tableLayout.js)
  if (dims.bands === 1) {
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      TEXELS_PER_SHAPE,
      Math.max(1, n),
      0,
      gl.RGBA,
      gl.FLOAT,
      n ? (H ? packed.subarray(0, n * FLOATS_PER_SHAPE) : packed) : IDENTITY_TEXELS,
    );
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, dims.w, dims.h, 0, gl.RGBA, gl.FLOAT, null);
    uploadTableRows(
      gl,
      TEXELS_PER_SHAPE,
      0,
      n - 1,
      H ? packed.subarray(0, n * FLOATS_PER_SHAPE) : packed,
    );
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  if (_borrow) gl.activeTexture(_prevUnit);

  // The row writers take the buffer and the row's float offset, so one body serves a row, a row's own record under a group, and
  // a group's record.
  function writeRecord(P, base, o) {
    // 2×2 affine: M = R(rot) · S(scale) (column-major math, row-major
    // storage).
    const rot = o && typeof o.localRotation === 'number' ? finiteOr(o.localRotation, 0) : 0;
    const sx = o && o.localScale ? finiteOr(o.localScale[0], 1) : 1;
    const sy = o && o.localScale ? finiteOr(o.localScale[1], 1) : 1;
    const cos = Math.cos(rot),
      sin = Math.sin(rot);
    P[base + 0] = cos * sx;
    P[base + 1] = -sin * sy;
    P[base + 2] = sin * sx;
    P[base + 3] = cos * sy;
    putT(
      P,
      base,
      o && o.localPosition ? finiteOr(o.localPosition[0], 0) : 0,
      o && o.localPosition ? finiteOr(o.localPosition[1], 0) : 0,
    );
    let vis = o && typeof o.visibility === 'number' ? finiteOr(o.visibility, 1) : 1;
    if (vis < 0) vis = 0;
    if (vis > 1) vis = 1;
    P[base + 6] = vis;
    // Per-attribute override mask in texel 1.w.
    let mask = 0;
    const swAbs = o ? strokeWidthOf(o.strokeWidth) : NaN;
    if (o && isColorList(o.fill)) mask |= OVR_MASK_FILL;
    if (o && isColorList(o.stroke)) mask |= OVR_MASK_STROKE;
    if (swAbs === swAbs) mask |= OVR_MASK_STROKE_WIDTH;
    if (o && o.reveal === true) mask |= OVR_MASK_REVEAL;
    P[base + 7] = mask;
    if (o && o.tint) {
      P[base + 8] = finiteOr(o.tint[0], 1);
      P[base + 9] = finiteOr(o.tint[1], 1);
      P[base + 10] = finiteOr(o.tint[2], 1);
      P[base + 11] = finiteOr(o.tint[3], 1);
    } else {
      P[base + 8] = 1;
      P[base + 9] = 1;
      P[base + 10] = 1;
      P[base + 11] = 1;
    }
    // Texel 3 — absolute fill.
    if (o && isColorList(o.fill)) {
      writeRgba(P, base + 12, o.fill, RGBA_DEFAULT);
    } else {
      P[base + 12] = 0;
      P[base + 13] = 0;
      P[base + 14] = 0;
      P[base + 15] = 0;
    }
    // Texel 4 — absolute stroke.
    if (o && isColorList(o.stroke)) {
      writeRgba(P, base + 16, o.stroke, RGBA_DEFAULT);
    } else {
      P[base + 16] = 0;
      P[base + 17] = 0;
      P[base + 18] = 0;
      P[base + 19] = 0;
    }
    // Texel 5 — absolute strokeWidth (.x); reserved (.y .z .w).
    P[base + 20] = swAbs === swAbs ? swAbs : 0;
    P[base + 21] = 0;
    P[base + 22] = 0;
    P[base + 23] = 0;
  }

  function resetRecord(P, base) {
    P[base + 0] = 1;
    P[base + 1] = 0;
    P[base + 2] = 0;
    P[base + 3] = 1;
    P[base + 4] = 0;
    P[base + 5] = 0;
    P[base + 6] = 1;
    P[base + 7] = 0;
    P[base + 8] = 1;
    P[base + 9] = 1;
    P[base + 10] = 1;
    P[base + 11] = 1;
    // Reset the absolute-override texels to zero. The mask in texel 1.w
    // is cleared above so the shader won't read these anyway, but
    // leaving them zero keeps the upload deterministic.
    for (let k = 12; k < 24; k++) P[base + k] = 0;
  }

  function updateRecord(P, base, p) {
    // Transform
    const tNow = hasO ? userT(P, base) : null; // the position the caller sees, kept across a change of the matrix
    if ('localRotation' in p || 'localScale' in p) {
      // The current rotation and SIGNED scales (decomposeRow): a mirror and a zero scale both survive an update
      // of the other field.
      const [rotCur, sxCur, syCur] = decomposeRow(
        P[base + 0],
        P[base + 1],
        P[base + 2],
        P[base + 3],
      );
      const rot = p.localRotation != null ? finiteOr(p.localRotation, rotCur) : rotCur;
      const sx = p.localScale ? finiteOr(p.localScale[0], sxCur) : sxCur;
      const sy = p.localScale ? finiteOr(p.localScale[1], syCur) : syCur;
      const cos = Math.cos(rot),
        sin = Math.sin(rot);
      P[base + 0] = cos * sx;
      P[base + 1] = -sin * sy;
      P[base + 2] = sin * sx;
      P[base + 3] = cos * sy;
      if (hasO) putT(P, base, tNow[0], tNow[1]);
    }
    if (p.localPosition) {
      if (hasO)
        putT(P, base, finiteOr(p.localPosition[0], tNow[0]), finiteOr(p.localPosition[1], tNow[1]));
      else {
        P[base + 4] = finiteOr(p.localPosition[0], P[base + 4]);
        P[base + 5] = finiteOr(p.localPosition[1], P[base + 5]);
      }
    }
    if ('visibility' in p) {
      let v = finiteOr(p.visibility, P[base + 6]);
      if (v < 0) v = 0;
      if (v > 1) v = 1;
      P[base + 6] = v;
    }
    if (p.tint) {
      // A component that is missing or not a finite number keeps its current value.
      P[base + 8] = finiteOr(p.tint[0], P[base + 8]);
      P[base + 9] = finiteOr(p.tint[1], P[base + 9]);
      P[base + 10] = finiteOr(p.tint[2], P[base + 10]);
      P[base + 11] = finiteOr(p.tint[3], P[base + 11]);
    }
    let mask = Math.floor(P[base + 7] + 0.5);
    if ('fill' in p) {
      if (p.fill == null) {
        mask &= ~OVR_MASK_FILL;
        P[base + 12] = 0;
        P[base + 13] = 0;
        P[base + 14] = 0;
        P[base + 15] = 0;
      } else if (isColorList(p.fill)) {
        // A component that is missing or not finite keeps the row's current color when it already has one, else the default.
        writeRgba(
          P,
          base + 12,
          p.fill,
          mask & OVR_MASK_FILL ? P.subarray(base + 12, base + 16) : RGBA_DEFAULT,
        );
        mask |= OVR_MASK_FILL;
      }
    }
    if ('stroke' in p) {
      if (p.stroke == null) {
        mask &= ~OVR_MASK_STROKE;
        P[base + 16] = 0;
        P[base + 17] = 0;
        P[base + 18] = 0;
        P[base + 19] = 0;
      } else if (isColorList(p.stroke)) {
        writeRgba(
          P,
          base + 16,
          p.stroke,
          mask & OVR_MASK_STROKE ? P.subarray(base + 16, base + 20) : RGBA_DEFAULT,
        );
        mask |= OVR_MASK_STROKE;
      }
    }
    if ('strokeWidth' in p) {
      if (p.strokeWidth == null) {
        mask &= ~OVR_MASK_STROKE_WIDTH;
        P[base + 20] = 0;
      } else {
        // Not a finite number: the row keeps whatever width override it has.
        const w = strokeWidthOf(p.strokeWidth);
        if (w === w) {
          mask |= OVR_MASK_STROKE_WIDTH;
          P[base + 20] = w;
        }
      }
    }
    if ('reveal' in p) {
      if (p.reveal === true) mask |= OVR_MASK_REVEAL;
      else mask &= ~OVR_MASK_REVEAL;
    }
    P[base + 7] = mask;
  }

  function readRecord(P, base, shapeId) {
    const m00 = P[base + 0],
      m01 = P[base + 1];
    const m10 = P[base + 2],
      m11 = P[base + 3];
    const [rot, sx, sy] = decomposeRow(m00, m01, m10, m11);
    const mask = Math.floor(P[base + 7] + 0.5);
    const out = {
      shapeId,
      localPosition: userT(P, base),
      localRotation: rot,
      localScale: [sx, sy],
      visibility: P[base + 6],
      tint: [P[base + 8], P[base + 9], P[base + 10], P[base + 11]],
    };
    if (mask & OVR_MASK_FILL) out.fill = [P[base + 12], P[base + 13], P[base + 14], P[base + 15]];
    if (mask & OVR_MASK_STROKE)
      out.stroke = [P[base + 16], P[base + 17], P[base + 18], P[base + 19]];
    if (mask & OVR_MASK_STROKE_WIDTH) out.strokeWidth = P[base + 20];
    if (mask & OVR_MASK_REVEAL) out.reveal = true;
    return out;
  }

  // ── Groups ───────────────────────────────────────────────────────────────────────────────────────────────────
  const getG = (g, out) => {
    if (!gActive[g]) return false;
    const b = g * FLOATS_PER_SHAPE;
    for (let k = 0; k < 7; k++) out[k] = gbuf[b + k];
    out[7] = gbuf[b + 8];
    out[8] = gbuf[b + 9];
    out[9] = gbuf[b + 10];
    out[10] = gbuf[b + 11];
    out[11] = (Math.floor(gbuf[b + 7] + 0.5) & OVR_MASK_REVEAL) !== 0 ? 1 : 0;
    return true;
  };
  /// packed[r] = the row's own override under the groups now active.
  function recompose(r) {
    const o = r * FLOATS_PER_SHAPE,
      v = _ownV;
    for (let k = 0; k < 7; k++) v[k] = own[o + k];
    v[7] = own[o + 8];
    v[8] = own[o + 9];
    v[9] = own[o + 10];
    v[10] = own[o + 11];
    v[11] = 0;
    composeChain(space, r, v, getG);
    for (let k = 0; k < 7; k++) packed[o + k] = v[k];
    // (a group that reveals reveals every hidden row under it)
    packed[o + 7] = v[11] !== 0 ? Math.floor(own[o + 7] + 0.5) | OVR_MASK_REVEAL : own[o + 7];
    packed[o + 8] = v[7];
    packed[o + 9] = v[8];
    packed[o + 10] = v[9];
    packed[o + 11] = v[10];
    for (let k = 12; k < 24; k++) packed[o + k] = own[o + k];
    if (r < n) syncCompanions(r);
  }
  function coverRow(r) {
    if (covered[r]++ === 0) {
      own.set(
        packed.subarray(r * FLOATS_PER_SHAPE, (r + 1) * FLOATS_PER_SHAPE),
        r * FLOATS_PER_SHAPE,
      );
      ownFlag[r] = overridden[r];
      overridden[r] = 1;
    }
  }
  function uncoverRow(r) {
    if (--covered[r] === 0) {
      packed.set(
        own.subarray(r * FLOATS_PER_SHAPE, (r + 1) * FLOATS_PER_SHAPE),
        r * FLOATS_PER_SHAPE,
      );
      overridden[r] = ownFlag[r];
      if (r < n) syncCompanions(r);
    } else recompose(r);
  }
  function ensureGroupStore() {
    if (gbuf) return;
    const G = space.groups();
    gbuf = new Float32Array(G.names.length * FLOATS_PER_SHAPE);
    for (let g = 0; g < G.names.length; g++) gbuf.set(IDENTITY_TEXELS, g * FLOATS_PER_SHAPE);
    gActive = new Uint8Array(G.names.length);
    own = new Float32Array(total * FLOATS_PER_SHAPE);
    covered = new Uint8Array(total);
    ownFlag = new Uint8Array(total);
  }
  let _warnedGroupPaint = false;
  /// A group override moves, rotates, scales, hides, tints and reveals what is under it. Absolute paint and stroke width are a row's own.
  function stripGroupPaint(g, given) {
    const b = g * FLOATS_PER_SHAPE;
    if (
      !_warnedGroupPaint &&
      given &&
      (given.fill != null || given.stroke != null || given.strokeWidth != null)
    ) {
      _warnedGroupPaint = true;
      mantleWarn(
        'MantleOverrideTable: a group override moves, rotates, scales, hides and tints what is under it; ' +
          'fill, stroke and strokeWidth are ignored on a group id (set them on the rows).',
      );
    }
    gbuf[b + 7] = Math.floor(gbuf[b + 7] + 0.5) & OVR_MASK_REVEAL; // a group reveals; it carries no absolute paint
    for (let k = 12; k < 24; k++) gbuf[b + k] = 0;
  }
  /// The group's record changed (or it was just set / cleared): recompose its rows.
  function groupChanged(g, nowActive) {
    const members = space.groups().members[g];
    const was = gActive[g] === 1;
    gActive[g] = nowActive ? 1 : 0;
    let drawn = false;
    if (nowActive && !was) for (let i = 0; i < members.length; i++) coverRow(members[i]);
    for (let i = 0; i < members.length; i++) {
      const r = members[i];
      if (nowActive) recompose(r);
      else if (was) uncoverRow(r);
      if (r < n) {
        drawn = true;
        _shapeGen[r]++;
        if (r < _dirtyLo) _dirtyLo = r;
        if (r > _dirtyHi) _dirtyHi = r;
      }
    }
    if (drawn) {
      _revision++;
      anyDirty = true;
    }
  }
  /// The buffer a row's own override lives in: `own` while a group covers it.
  const bufOf = (idx) => (covered !== null && covered[idx] ? own : packed);
  const afterRowWrite = (idx, flag) => {
    if (covered !== null && covered[idx]) {
      ownFlag[idx] = flag;
      recompose(idx);
    } else overridden[idx] = flag;
    _touchShape(idx);
  };

  /** Resolve a key to a shape index (a group is `-2 - g`, a miss -1). Logs a one-shot warning when a
   *  string key misses on a bundle with zero string ids — the usual
   *  signal that shapeIds was not populated at import time. */
  const idIndex = space.idIndex;
  function resolveIdx(key) {
    // An index is an integer row: 1.5 would be a silent no-op write into a typed array, reported as success.
    if (typeof key === 'number') return Number.isInteger(key) && key >= 0 && key < total ? key : -1;
    const i = idIndex.get(key);
    if (i !== undefined) return i;
    const g = space.resolve(key); // a group id
    if (g === -1 && typeof key === 'string' && !_anyId && !_warnedNoIds) {
      _warnedNoIds = true;
      mantleWarn(
        `MantleOverrideTable: bundle.shapeIds is empty — set('${key}', …) ` +
          `will never resolve. Did the bundle source forget to populate ` +
          `shapeIds? Pass a numeric shape index instead, or check the ` +
          `bundle's shapeIds array.`,
      );
    }
    return g;
  }
  function setGroup(g, o) {
    ensureGroupStore();
    writeRecord(gbuf, g * FLOATS_PER_SHAPE, o || {});
    stripGroupPaint(g, o);
    groupChanged(g, true);
    return true;
  }
  function updateGroup(g, p) {
    ensureGroupStore();
    updateRecord(gbuf, g * FLOATS_PER_SHAPE, p);
    stripGroupPaint(g, p);
    groupChanged(g, true);
    return true;
  }
  const groupBase = (idx) => groupOfKey(idx) * FLOATS_PER_SHAPE;
  const idOfKey = (key, idx) => (typeof key === 'string' ? key : space.idOf(idx));

  return markRevisionedOverrideTable(
    /** @type {MantleOverrideTable} */ ({
      get gl() {
        return gl;
      },
      get bundle() {
        return bundle;
      },
      get numShapes() {
        return n;
      },
      get numHitOnly() {
        return H;
      },
      get groupIds() {
        return space.groupIds();
      },
      get texture() {
        return disposed ? null : tex;
      },
      get textureWidth() {
        return dims.w;
      },
      get textureHeight() {
        return n > dims.h ? dims.h : n;
      },

      /** Set the override for a shape (by id or index). Writes ALL
       *  fields; omitted fields revert to identity. Drivers that want
       *  to preserve other fields should call `update()` instead. */
      set(key, o) {
        const idx = resolveIdx(key);
        if (idx < 0) return idx === -1 ? false : setGroup(groupOfKey(idx), o);
        if (covered === null) {
          writeRecord(packed, idx * FLOATS_PER_SHAPE, o || {});
          overridden[idx] = 1;
          _touchShape(idx);
          return true;
        }
        writeRecord(bufOf(idx), idx * FLOATS_PER_SHAPE, o || {});
        afterRowWrite(idx, 1);
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
        if (idx < 0) return idx === -1 ? false : updateGroup(groupOfKey(idx), partial || {});
        if (covered === null) {
          updateRecord(packed, idx * FLOATS_PER_SHAPE, partial || {});
          overridden[idx] = 1;
          _touchShape(idx);
          return true;
        }
        updateRecord(bufOf(idx), idx * FLOATS_PER_SHAPE, partial || {});
        afterRowWrite(idx, 1);
        return true;
      },

      /** Read the current override for a shape, as a plain object.
       *  Returns identity values when no override is set. A row under a group override reads its own override;
       *  `getEffective` reads it as drawn. */
      get(key) {
        const idx = resolveIdx(key);
        if (idx === -1) return null;
        if (idx < -1) {
          ensureGroupStore();
          return readRecord(gbuf, groupBase(idx), key);
        }
        return readRecord(bufOf(idx), idx * FLOATS_PER_SHAPE, idOfKey(key, idx));
      },

      /** The override as drawn and hit-tested: a row's own override under the group overrides above it. For a row no group
       *  covers it is `get`. */
      getEffective(key) {
        const idx = resolveIdx(key);
        if (idx === -1) return null;
        if (idx < -1) return this.get(key);
        const out = readRecord(packed, idx * FLOATS_PER_SHAPE, idOfKey(key, idx));
        // Under a group the composed 2x2 can shear, which position / rotation / scale cannot say: the exact affine rides along.
        if (covered !== null && covered[idx]) {
          const b = idx * FLOATS_PER_SHAPE;
          out.matrix = [
            packed[b],
            packed[b + 1],
            packed[b + 2],
            packed[b + 3],
            packed[b + 4],
            packed[b + 5],
          ];
        }
        return out;
      },

      /** Remove an override (reverts the shape to identity). A group id removes the group's override: its rows go back to
       *  their own. */
      clear(key) {
        const idx = resolveIdx(key);
        if (idx === -1) return false;
        if (idx < -1) {
          ensureGroupStore();
          const g = groupOfKey(idx);
          resetRecord(gbuf, groupBase(idx));
          if (gActive[g]) groupChanged(g, false);
          return true;
        }
        resetRecord(bufOf(idx), idx * FLOATS_PER_SHAPE);
        afterRowWrite(idx, 0);
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
        const groups = clipperRowGroups(bundle, clipSvgId);
        if (!groups) return false;
        for (const rows of groups)
          for (const row of rows) {
            if (row < 0 || row >= n) continue;
            // Use `update` semantics so a setClipper followed by a `set` on
            // an unrelated attribute (e.g. visibility on the same row, if
            // the caller is weird about it) doesn't clobber the transform.
            const base = row * FLOATS_PER_SHAPE;
            const rot =
              opts && typeof opts.localRotation === 'number' ? finiteOr(opts.localRotation, 0) : 0;
            const sx = opts && opts.localScale ? finiteOr(opts.localScale[0], 1) : 1;
            const sy = opts && opts.localScale ? finiteOr(opts.localScale[1], 1) : 1;
            const cos = Math.cos(rot),
              sin = Math.sin(rot);
            packed[base + 0] = cos * sx;
            packed[base + 1] = -sin * sy;
            packed[base + 2] = sin * sx;
            packed[base + 3] = cos * sy;
            putT(
              packed,
              base,
              opts && opts.localPosition ? finiteOr(opts.localPosition[0], 0) : 0,
              opts && opts.localPosition ? finiteOr(opts.localPosition[1], 0) : 0,
            );
            // Leave visibility / tint / mask alone — they may be driven by
            // a separate animator. Clip eval reads the clip's bbox + bands
            // directly, so a clip child's visibility isn't a meaningful axis
            // here.
            overridden[row] = 1;
            _touchShape(row);
          }
        // Record the raw transform in the export-facing map (see _clippers).
        _clippers.set(clipSvgId, {
          localPosition:
            opts && opts.localPosition ? [+opts.localPosition[0], +opts.localPosition[1]] : [0, 0],
          localRotation: opts && typeof opts.localRotation === 'number' ? +opts.localRotation : 0,
          localScale: opts && opts.localScale ? [+opts.localScale[0], +opts.localScale[1]] : [1, 1],
        });
        anyDirty = true;
        return true;
      },

      /** Reset a clip's transform to identity. */
      clearClipper(clipSvgId) {
        const groups = clipperRowGroups(bundle, clipSvgId);
        if (!groups) return false;
        for (const rows of groups)
          for (const row of rows) {
            if (row < 0 || row >= n) continue;
            const base = row * FLOATS_PER_SHAPE;
            packed[base + 0] = 1;
            packed[base + 1] = 0;
            packed[base + 2] = 0;
            packed[base + 3] = 1;
            packed[base + 4] = 0;
            packed[base + 5] = 0;
            // The row stops being "overridden" when nothing else (visibility, tint, absolute paint) is set on it, so
            // hasAny / activeIndices (frame export, native replay) do not keep a cleared clip row.
            if (
              packed[base + 6] === 1 &&
              packed[base + 7] === 0 &&
              packed[base + 8] === 1 &&
              packed[base + 9] === 1 &&
              packed[base + 10] === 1 &&
              packed[base + 11] === 1
            )
              overridden[row] = 0;
            _touchShape(row);
          }
        _clippers.delete(clipSvgId);
        anyDirty = true;
        return true;
      },

      /** Map<clipSvgId, {localPosition, localRotation, localScale}> of active
       *  clipper transforms. Read by the SVG-export replay to transform the
       *  live <clipPath> element. */
      get clippers() {
        return _clippers;
      },

      /** Drop all overrides; every shape reverts to identity. */
      clearAll() {
        for (let i = 0; i < total; i++) resetRecord(packed, i * FLOATS_PER_SHAPE);
        overridden.fill(0);
        if (gbuf) {
          for (let g = 0; g < gActive.length; g++) gbuf.set(IDENTITY_TEXELS, g * FLOATS_PER_SHAPE);
          gActive.fill(0);
          covered.fill(0);
          ownFlag.fill(0);
        }
        _clippers.clear();
        _touchAll();
        anyDirty = true;
      },

      /** True if at least one override is currently active on a drawn row (a group override counts through its rows). */
      get hasAny() {
        for (let i = 0; i < n; i++) if (overridden[i]) return true;
        return false;
      },

      /** Indices of shapes with an active override. Lets a consumer (e.g.
       *  the SVG-export replay) sparsely iterate only the overridden rows. Drawn rows only. */
      activeIndices() {
        const out = [];
        for (let i = 0; i < n; i++) if (overridden[i]) out.push(i);
        return out;
      },

      /** Upload the packed buffer to the GL texture if anything changed
       *  since the last upload. Idempotent + cheap when clean. */
      uploadIfDirty() {
        if (!anyDirty || disposed) return;
        const lo = Math.max(0, _dirtyLo),
          hi = Math.min(n - 1, _dirtyHi);
        if (lo <= hi) {
          gl.bindTexture(gl.TEXTURE_2D, tex);
          // Upload only the dirty row band [lo, hi] (yoffset=lo, height=rows).
          const sub = packed.subarray(lo * FLOATS_PER_SHAPE, (hi + 1) * FLOATS_PER_SHAPE);
          uploadTableRows(gl, TEXELS_PER_SHAPE, lo, hi, sub);
          gl.bindTexture(gl.TEXTURE_2D, null);
        }
        anyDirty = false;
        _dirtyLo = n;
        _dirtyHi = -1; // band consumed
        _generation++;
      },

      /** Monotonic generation counter. Bumps whenever the override state
       *  changed since the last upload (i.e. whenever uploadIfDirty did
       *  work). Compare frame-to-frame to detect animation changes. */
      get generation() {
        return _generation;
      },

      /** Monotonic counter bumped by every mutation of a drawn row or a group (including the ones still waiting for their upload). */
      get revision() {
        return _revision;
      },

      /** Force the next uploadIfDirty() to actually upload. Used when
       *  the caller has mutated the underlying buffer directly. Since a
       *  direct-buffer write can't say WHICH shapes changed, bump the
       *  global epoch so every shapeGenOf() advances (conservative). */
      markDirty() {
        anyDirty = true;
        _touchAll();
      },

      /** Per-shape change counter (includes the global epoch). The filter
       *  result cache compares this for each shape that feeds a filter
       *  region; a change means re-evaluate that filter. */
      shapeGenOf(idx) {
        return (idx >= 0 && idx < n ? _shapeGen[idx] : 0) + _globalEpoch;
      },

      /** What a drawn row says, as a number: equal for equal rows in ANY table, and 0 for an identity row, so a draw with no table agrees with it. The caches of a result the row
       *  feeds (filter results, mask bakes) compare this: one bundle drawn with two tables re-evaluates when the row really differs, and not otherwise. */
      shapeContentOf(idx) {
        if (!(idx >= 0 && idx < n)) return 0;
        if (!_digests) {
          _digests = new Float64Array(n);
          _digestAt = new Uint32Array(n);
          _digestWords = new Uint32Array(packed.buffer);
        }
        const at = (_shapeGen[idx] + _globalEpoch + 1) >>> 0;
        if (_digestAt[idx] !== at) {
          const d = rowDigest(_digestWords, idx * FLOATS_PER_SHAPE);
          _digests[idx] = d === IDENTITY_DIGEST ? 0 : d;
          _digestAt[idx] = at;
        }
        return _digests[idx];
      },

      /** What the whole table says, as a number: every drawn row. Kept until the next mutation. */
      contentKey() {
        if (_tableDigestAt === _revision) return _tableDigest;
        let a = 0x811c9dc5,
          b = 0x9e3779b9;
        for (let i = 0; i < n; i++) {
          const d = this.shapeContentOf(i);
          if (d === 0) continue;
          a = Math.imul(a ^ i ^ (d >>> 0), 0x01000193);
          a ^= a >>> 15;
          b = Math.imul(b ^ i ^ ((d / 4294967296) >>> 0), 0x5bd1e995);
          b ^= b >>> 13;
        }
        _tableDigest =
          a === (0x811c9dc5 | 0) && b === (0x9e3779b9 | 0) ? 0 : (a >>> 0) * 2097152 + (b >>> 11);
        _tableDigestAt = _revision;
        return _tableDigest;
      },

      /** Direct view into the packed Float32 buffer: 24 floats per row, the drawn rows first and then the hit-only rows
       *  (`numShapes + numHitOnly` rows; only the drawn rows are uploaded). Useful for Animator-driven hot paths that want to
       *  write without per-shape function call overhead. Call markDirty() afterwards. A row under an active group override is
       *  recomposed from its own override when the group changes: write such a row through `set` / `update`. */
      get packedBuffer() {
        return packed;
      },
      get texelsPerShape() {
        return TEXELS_PER_SHAPE;
      },

      /** Free the GL texture. Idempotent. After it the table is CPU-only: `texture` is null and uploadIfDirty() does
       *  nothing, so no deleted texture is bound or written. */
      dispose() {
        if (disposed) return;
        disposed = true;
        if (tex) deleteGlResource(gl, 'Texture', tex);
      },
    }),
  );
}
