// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { clipperRowGroups } from '../bundle/layout.js';
import { createKeySpace, composeChain, groupOfKey } from '../animation/overrideKeys.js';
// nativeOverrideTable.js — a CPU-only per-shape override store with the
// same surface as createOverrideTable (set / update / get / setClipper /
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
 * Returns a table with the createOverrideTable method surface (its type is inferred from the returned object).
 *
 * @param {object} bundle  Mantle bundle (needs shapeIds + clipperRows)
 */
export function createNativeOverrideTable(bundle) {
  const n = bundle.numShapes | 0;
  // What a key addresses: drawn rows, hit-only rows, groups (animation/overrideKeys.js: the same as the WebGL table).
  const space = createKeySpace(bundle, n);
  const { H, total, companions } = space;
  // Per-shape override object (null = identity). Mirrors the GL table's
  // "overridden" sparse set. The hit-only rows follow the drawn ones.
  const ovr = new Array(total).fill(null);
  // Group overrides by group index (null = none): applied over the rows under the group, see overrideKeys.js.
  let gOvr = null,
    gActiveCount = 0;
  // Per-clip affine (keyed by clipSvgId). Read by the scene to transform
  // the live <clipPath>/<mask> element.
  const clippers = new Map();
  let generation = 1;
  // Bumped by every change, including one to a row nothing draws; the scene follows `generation`, the hit test this.
  let hitGeneration = 1;
  let batchDepth = 0;
  let batchDirty = false;

  const resolveIdx = (key) => space.resolve(key);

  function bump(drawn = true) {
    hitGeneration++;
    if (!drawn) return;
    if (batchDepth) {
      batchDirty = true;
      return;
    }
    generation++;
  }
  /// Whether a change to group g reaches a drawn row.
  const groupHasDrawn = (g) => {
    const m = space.groups().members[g];
    return m.length > 0 && m[0] < n;
  };
  const groupState = (g) => (gOvr && gOvr[g]) || null;

  // Extra shapes to INJECT into the bundle <g> (no counterpart in the source
  // markup) — used by the native morph for dst-only shapes. Each is a static
  // descriptor { key, pathD, fill, stroke, strokeWidth, evenOdd, alpha };
  // only `alpha` changes per frame (the fade-in). `extrasGen` bumps when the
  // scene should re-read them.
  let extras = null;
  let extrasGen = 0;

  // ── Groups ─────────────────────────────────────────────────────────────────────────────────────────────────
  /// A group override takes a transform, visibility and tint only (see overrideKeys.js).
  function groupOnly(o) {
    const out = {};
    for (const k of Object.keys(o))
      if (k !== 'fill' && k !== 'stroke' && k !== 'strokeWidth') out[k] = o[k];
    return out;
  }
  /// [m00, m01, m10, m11, tx, ty, visibility, tintR, tintG, tintB, tintA] of a plain-object override (its own record).
  function ownValues(o, out = new Float64Array(11)) {
    const rot =
      o && typeof o.localRotation === 'number' && Number.isFinite(o.localRotation)
        ? o.localRotation
        : 0;
    const sx = o && o.localScale && Number.isFinite(+o.localScale[0]) ? +o.localScale[0] : 1;
    const sy = o && o.localScale && Number.isFinite(+o.localScale[1]) ? +o.localScale[1] : 1;
    const c = Math.cos(rot),
      sn = Math.sin(rot);
    out[0] = c * sx;
    out[1] = -sn * sy;
    out[2] = sn * sx;
    out[3] = c * sy;
    out[4] = o && o.localPosition && Number.isFinite(+o.localPosition[0]) ? +o.localPosition[0] : 0;
    out[5] = o && o.localPosition && Number.isFinite(+o.localPosition[1]) ? +o.localPosition[1] : 0;
    const v =
      o && typeof o.visibility === 'number' && Number.isFinite(o.visibility) ? o.visibility : 1;
    out[6] = v < 0 ? 0 : v > 1 ? 1 : v;
    const t = o && o.tint;
    for (let k = 0; k < 4; k++) out[7 + k] = t && Number.isFinite(+t[k]) ? +t[k] : 1;
    return out;
  }
  const getG = (g, out) => {
    const o = groupState(g);
    if (!o) return false;
    ownValues(o, out);
    return true;
  };
  /// The rows (drawn and hit-only) under an active group override, with the groups' ownership tests.
  let coveredCache = null;
  function coveredSet() {
    if (coveredCache && coveredCache.gen === hitGeneration) return coveredCache.set;
    const set = new Set(),
      G = space.groups();
    if (G && gOvr)
      for (let g = 0; g < gOvr.length; g++) if (gOvr[g]) for (const r of G.members[g]) set.add(r);
    if (companions)
      for (const [d, slots] of companions) if (set.has(d)) for (const s of slots) set.add(s);
    coveredCache = { gen: hitGeneration, set };
    return set;
  }
  /// The effective values of row `idx` (drawn or hit-only): its own record under the active groups, or null if no group covers it.
  function effectiveOf(idx) {
    if (!coveredSet().has(idx)) return null;
    const v = ownValues(ovr[idx] || null);
    const slotRow =
      companions && space.isCompanion && space.isCompanion[idx] ? companionOwner(idx) : idx;
    if (slotRow !== idx) ownValues(ovr[slotRow] || null, v);
    return composeChain(space, slotRow, v, getG);
  }
  function companionOwner(slot) {
    for (const [d, slots] of companions) if (slots.includes(slot)) return d;
    return slot;
  }
  /// (rotation, sx, sy) of the 2x2 nearest R(rot) * diag(sx, sy); a sheared composition has no exact one (`matrix` is exact).
  function decomposeMatrix(m00, m01, m10, m11) {
    const c0 = Math.hypot(m00, m10);
    const rot =
      c0 > 0 ? Math.atan2(m10, m00) : Math.hypot(m01, m11) > 0 ? Math.atan2(-m01, m11) : 0;
    const c = Math.cos(rot),
      sn = Math.sin(rot);
    return [rot, m00 * c + m10 * sn, m11 * c - m01 * sn];
  }
  let packedCache = null;

  return {
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
    get generation() {
      return generation;
    },
    get hitGeneration() {
      return hitGeneration;
    },
    // Marks this as a CPU table so the scene can read state directly
    // instead of poking at a (nonexistent) GL texture.
    get isNative() {
      return true;
    },
    // Timeline/morph writers often update many shapes for one visual state.
    // Coalesce their generation bumps so a native scene never observes an
    // intermediate table and does one override walk per timeline tick.
    beginBatch() {
      batchDepth++;
    },
    endBatch() {
      if (batchDepth === 0) return;
      if (--batchDepth === 0 && batchDirty) {
        batchDirty = false;
        generation++;
      }
    },

    // Injected (source-markup-less) shapes — see above.
    setExtraShapes(list) {
      extras = list && list.length ? list : null;
      extrasGen++;
    },
    get extraShapes() {
      return extras;
    },
    get extrasGeneration() {
      return extrasGen;
    },
    bumpExtras() {
      extrasGen++;
    },

    set(key, o) {
      const idx = resolveIdx(key);
      if (idx === -1) return false;
      if (idx < -1) {
        const g = groupOfKey(idx);
        if (!gOvr) gOvr = new Array(space.groups().names.length).fill(null);
        if (!gOvr[g]) gActiveCount++;
        gOvr[g] = o ? groupOnly(o) : {};
        bump(groupHasDrawn(g));
        return true;
      }
      ovr[idx] = o ? { ...o } : {};
      bump(idx < n);
      return true;
    },

    update(key, partial) {
      const idx = resolveIdx(key);
      if (idx === -1) return false;
      // Mutate the stored override IN PLACE (no per-call spread) — this runs
      // per shape per frame for a morph/timeline, so a spread would be real GC.
      // Same null-clears-attribute semantics as the GL table (fill:null drops
      // the absolute fill override).
      const p = partial || {};
      let cur;
      if (idx < -1) {
        const g = groupOfKey(idx);
        if (!gOvr) gOvr = new Array(space.groups().names.length).fill(null);
        if (!gOvr[g]) {
          gOvr[g] = {};
          gActiveCount++;
        }
        cur = gOvr[g];
        for (const k of Object.keys(groupOnly(p))) cur[k] = p[k];
        bump(groupHasDrawn(g));
        return true;
      }
      cur = ovr[idx];
      if (!cur) cur = ovr[idx] = {};
      for (const k of Object.keys(p)) {
        if ((k === 'fill' || k === 'stroke' || k === 'strokeWidth') && p[k] == null) {
          delete cur[k];
        } else {
          cur[k] = p[k];
        }
      }
      bump(idx < n);
      return true;
    },

    get(key) {
      const idx = resolveIdx(key);
      if (idx === -1) return null;
      const o = idx < -1 ? groupState(groupOfKey(idx)) : ovr[idx];
      // Fresh wrapper (no caller-aliasing), but unset fields reuse shared
      // frozen identity arrays and set fields return the STORED array by
      // reference (consumers read, never mutate) — so the common case
      // allocates one small object instead of an object + 3–4 arrays.
      if (!o) {
        return {
          shapeId: typeof key === 'string' ? key : space.idOf(idx),
          localPosition: ID_POS,
          localRotation: 0,
          localScale: ID_SCALE,
          visibility: 1,
          tint: ID_TINT,
          fill: undefined,
          stroke: undefined,
          strokeWidth: undefined,
          pathD: undefined,
        };
      }
      return {
        shapeId: typeof key === 'string' ? key : space.idOf(idx),
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
        ...(o.bitmapPaint ? { bitmapPaint: o.bitmapPaint } : {}),
        // A tweened gradient (nativeGradientPaint.js): the scene writes it onto gradient elements of its own.
        ...(o.gradientPaint ? { gradientPaint: o.gradientPaint } : {}),
        ...(typeof o.groupOpacity === 'number' ? { groupOpacity: o.groupOpacity } : {}),
        ...(typeof o.elementOpacity === 'number' ? { elementOpacity: o.elementOpacity } : {}),
        ...(typeof o.filterOpacity === 'number' ? { filterOpacity: o.filterOpacity } : {}),
      };
    },

    /*

 */
    isOverridden(key) {
      const idx = resolveIdx(key);
      if (idx < -1) return groupState(groupOfKey(idx)) != null;
      return idx >= 0 && (ovr[idx] != null || (gActiveCount > 0 && coveredSet().has(idx)));
    },

    /** Iterate active override indices (scene re-apply loop): the drawn rows with an override of their own or under a group's. */
    activeIndices() {
      const out = [];
      const cov = gActiveCount > 0 ? coveredSet() : null;
      for (let i = 0; i < n; i++) if (ovr[i] != null || (cov && cov.has(i))) out.push(i);
      return out;
    },

    /** The override as drawn: a row's own, under the group overrides above it. For a row no group covers it is `get`. */
    getEffective(key) {
      const idx = resolveIdx(key);
      if (idx < 0 || !(gActiveCount > 0)) return this.get(key);
      const eff = effectiveOf(idx);
      if (!eff) return this.get(key);
      const own = this.get(idx);
      const [rot, sx, sy] = decomposeMatrix(eff[0], eff[1], eff[2], eff[3]);
      return {
        ...own,
        shapeId: typeof key === 'string' ? key : own.shapeId,
        localPosition: [eff[4], eff[5]],
        localRotation: rot,
        localScale: [sx, sy],
        visibility: eff[6],
        tint: [eff[7], eff[8], eff[9], eff[10]],
        matrix: [eff[0], eff[1], eff[2], eff[3], eff[4], eff[5]],
      };
    },

    /** The hit test's view of the table: the GL table's packed rows (24 floats a row, the drawn rows then the hit-only ones),
     *  built from the plain-object state and kept until the next change. */
    packedForHit() {
      if (packedCache && packedCache.gen === hitGeneration) return packedCache.buf;
      const buf = new Float32Array(total * 24);
      for (let i = 0; i < total; i++) {
        const b = i * 24;
        buf[b] = 1;
        buf[b + 3] = 1;
        buf[b + 6] = 1;
        buf[b + 8] = buf[b + 9] = buf[b + 10] = buf[b + 11] = 1;
      }
      const cov = gActiveCount > 0 ? coveredSet() : null;
      for (let i = 0; i < total; i++) {
        const o = ovr[i],
          covered = cov && cov.has(i);
        if (!o && !covered) continue;
        const eff = covered ? effectiveOf(i) : ownValues(o);
        const b = i * 24;
        for (let k = 0; k < 7; k++) buf[b + k] = eff[k];
        buf[b + 8] = eff[7];
        buf[b + 9] = eff[8];
        buf[b + 10] = eff[9];
        buf[b + 11] = eff[10];
        if (o && typeof o.strokeWidth === 'number' && Number.isFinite(o.strokeWidth)) {
          buf[b + 7] = 4;
          buf[b + 20] = Math.max(0, o.strokeWidth);
        }
      }
      if (companions)
        for (const [d, slots] of companions)
          for (const slot of slots) buf.copyWithin(slot * 24, d * 24, d * 24 + 24);
      packedCache = { gen: hitGeneration, buf };
      return buf;
    },

    setClipper(clipSvgId, opts) {
      const groups = clipperRowGroups(bundle, clipSvgId);
      if (!groups) return false;
      clippers.set(clipSvgId, {
        localPosition:
          opts && opts.localPosition ? [+opts.localPosition[0], +opts.localPosition[1]] : [0, 0],
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
    get clippers() {
      return clippers;
    },

    clear(key) {
      const idx = resolveIdx(key);
      if (idx === -1) return false;
      if (idx < -1) {
        const g = groupOfKey(idx);
        if (gOvr && gOvr[g]) {
          gOvr[g] = null;
          gActiveCount--;
          bump(groupHasDrawn(g));
        }
        return true;
      }
      if (ovr[idx] != null) {
        ovr[idx] = null;
        bump(idx < n);
      }
      return true;
    },

    clearAll() {
      ovr.fill(null);
      if (gOvr) {
        gOvr.fill(null);
        gActiveCount = 0;
      }
      clippers.clear();
      bump();
    },

    get hasAny() {
      for (let i = 0; i < n; i++) if (ovr[i]) return true;
      if (gActiveCount > 0 && coveredSet().size && [...coveredSet()].some((r) => r < n))
        return true;
      return clippers.size > 0;
    },

    // No-ops so a caller written against the GL table (which calls
    // uploadIfDirty / dispose each frame) works unchanged.
    uploadIfDirty() {},
    markDirty() {
      bump();
    },
    dispose() {},
  };
}
