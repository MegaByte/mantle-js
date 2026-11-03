// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { prepareMorphImageFrames } from './morphImageFrames.js';
import { rowHitBits } from '../svg/hitBits.js';
import { morphFilterImageIds, prepareMorphFilters } from './morphFilters.js';
import { prepareMorphDrawOrder, extendMorphDrawOrder } from './morphDrawOrder.js';
import { planMorphGroups } from './morphGroups.js';
import { mergeNode, compactTree } from '../svg/hitGroups.js';
import { composeMorphBindings } from './morphBindings.js';
import { prepareMorphDashes, prepareMorphImages } from './morphPaintResources.js';
import { prepareMorphGradients } from './morphGradients.js';
import { FS_FILL_HUELESS } from '../bundle/layout.js';
// morphCore.js — the gl-free heart of the shape/sprite morph.
//
// Holds the plan-building + curve/band/gradient lerp machinery, kept off
// the GL path so the no-WebGL fallback's native morph can reuse it without
// importing createBundle / createOverrideTable. shapeMorph.js keeps the gl
// entry points (createShapeMorph / createSpriteMorph / _buildMorph).
//
// Pure: no GL, no side effects — tree-shakes into either build.

import { mantleWarn, warnHitOnlyStatic } from './diagnostics.js';
import { checkedSpriteBounds, ownSpriteRange } from './spriteRange.js';
import { metaStrokeReachFactor } from '../bundle/strokeReach.js';
import { unionMorphArcBounds } from './morphArcBounds.js';
import {
  clipperRowGroups,
  META_PRIM_KIND,
  META_END_CAP_OR_RX,
  stampMetaHeader,
  FS_HIDDEN,
} from '../bundle/layout.js';

function remapMorphHitTable(table, remap, endpointRows, mergedRows, ranks, endpointOrder) {
  if (!table) return null;
  // Sprite scopes can omit destination rows: their anchors precede the next retained row.
  // Missing transform owners remain -1 and never borrow that following row's identity.
  let anchorRows = remap;
  if (remap && remap.subarray(0, endpointRows).includes(-1)) {
    anchorRows = new Int32Array(endpointRows);
    let next = -1;
    for (let row = endpointRows - 1; row >= 0; row--) {
      if (remap[row] >= 0) next = remap[row];
      anchorRows[row] = next;
    }
  }
  const before = new Int32Array(table.rows.length);
  let monotone = true,
    previous = -1;
  for (let k = 0; k < before.length; k++) {
    // Decode prepared ranks before using this table as another morph endpoint.
    const position = table.before[k];
    const row =
      table.beforeIsPaintRank && endpointOrder && position < endpointRows
        ? endpointOrder[position]
        : position;
    const moved = row < endpointRows ? (anchorRows ? anchorRows[row] : row) : -1;
    const rank = moved < 0 ? mergedRows : ranks ? ranks[moved] : moved;
    before[k] = rank;
    if (rank < previous) monotone = false;
    previous = rank;
  }
  // Most anchors remain ordered. Relocation sorts only reversed layouts, preserving equal-anchor order.
  let slots = null;
  if (!monotone) {
    slots = Array.from({ length: before.length }, (_, k) => k);
    slots.sort((a, b) => before[a] - before[b] || a - b);
  }
  const reorder = (plane) => (slots ? Int32Array.from(slots, (k) => plane[k]) : plane);
  const ownerAt = (k) => {
    const owner = table.hiddenOwner[k];
    return owner === -2
      ? -2
      : owner < 0 || owner >= endpointRows
        ? -1
        : remap
          ? remap[owner]
          : owner;
  };
  return {
    ...table,
    beforeIsPaintRank: true,
    rows: reorder(table.rows),
    before: reorder(before),
    ...(table.rowGroup ? { rowGroup: reorder(table.rowGroup) } : {}),
    ...(table.hiddenOwner
      ? {
          hiddenOwner: slots
            ? Int32Array.from(slots, ownerAt)
            : remap
              ? Int32Array.from(table.hiddenOwner, (_, k) => ownerAt(k))
              : table.hiddenOwner,
        }
      : {}),
  };
}

/// Rows kept hidden (FS_HIDDEN: importSvg keepHidden) take part in a morph as rows at alpha 0, so a pose that shows a shape another pose hides
/// fades it in (or out) while its geometry interpolates, and a shape hidden in both stays hidden. The hue of the hidden end is the other end's
/// (CSS Color 4: a color with no alpha has no hue to blend toward). Run on the merged and the dst-aligned meta, after the dst-only rows joined.
/// The flag is cleared: the morph's draw list reads the alphas.
function settleHiddenRows(src, dst, plan, mergedMetaF, dstAlignedMetaF, stride, dstOnlyEntries) {
  if (stride < 28) return;
  const hiddenAt = (m, o) => (Math.round(m[o + 27]) & FS_HIDDEN) !== 0;
  const zero = (m, o) => {
    m[o + 7] = 0;
    m[o + 11] = 0;
  };
  const hue = (to, toO, from, fromO) => {
    for (let k = 4; k < 7; k++) to[toO + k] = from[fromO + k];
    for (let k = 8; k < 11; k++) to[toO + k] = from[fromO + k];
  };
  for (const m of plan.matched) {
    const so = m.srcIdx * stride,
      dO = m.dstIdx * stride;
    const sH = hiddenAt(src.metaFloats, so),
      dH = hiddenAt(dst.metaFloats, dO);
    if (sH && !dH) hue(mergedMetaF, so, dst.metaFloats, dO);
    if (dH && !sH) hue(dstAlignedMetaF, so, src.metaFloats, so);
    if (sH) zero(mergedMetaF, so);
    if (dH) zero(dstAlignedMetaF, so);
  }
  for (let s = 0; s < src.numShapes; s++) {
    const o = s * stride;
    if (hiddenAt(mergedMetaF, o)) {
      zero(mergedMetaF, o);
      mergedMetaF[o + 27] = Math.round(mergedMetaF[o + 27]) & ~FS_HIDDEN;
    }
  }
  for (let k = 0; k < dstOnlyEntries.length; k++) {
    const o = (src.numShapes + k) * stride;
    if (hiddenAt(mergedMetaF, o)) {
      zero(mergedMetaF, o);
      mergedMetaF[o + 27] = Math.round(mergedMetaF[o + 27]) & ~FS_HIDDEN;
    }
  }
}

// Dash, fill and stroke paint, filter, fill and stroke image, image rect and atlas: what the paint steps of composeMorphSections rewrite in a row.
const ALIAS_RESOURCE_SLOTS = [15, 28, 29, 32, 35, 36, 37, 38, 39, 43, 47];
const META_TEXEL_4 = 16; // float offset of texel 4 within a meta row
// (glyphLoc.x, glyphLoc.y, ...)

/// A morph's bands carry no crossing-axis lanes. A fill-only structure's entries hold each
/// segment's (min, max) on the crossing axis, and every fill walker skips a segment whose range misses its
/// ray -- trusting that range to bound the curve texels it would have read. setT rewrites those texels every
/// frame: a matched shape's by the lerp, and on the GPU route every texel of the rows the matched spans
/// touch, unmatched ones included, as mix(v, v, t), which float32 need not return as v. A lane is a static
/// bound on moving data, so the morph turns the reject off rather than trust it: bit 0 of texel 1's .y
/// (svg/textures.js BAND_HDR_RAY_LANES) is cleared on every header of every structure the morph's rows
/// reference, and those walkers read the lane-free layout's rule: no lane reject. The lane-free layout's z is the stroke
/// walker's far bound, so each such list's entries also get an INERT one -- z = -FLT_MAX, w = 0, a far edge
/// no reach falls short of -- and a stroke that ever walked one would skip nothing. (No stroke walks a fill-
/// only structure; this keeps the layout the bit declares true all the same.) The collapsed regions built
/// here never set the bit. Same reasoning as `hasOccupancy: false` below.
///
/// Only a GENUINE header is touched: H band 0's list offset must equal the header count this structure's
/// own band counts and level fields imply, which no other texel a meta row could point at satisfies, and
/// the level and V headers are found from the same fields. Returns false where that does not hold.
const FLT_MAX = 3.4028234663852886e38;
function clearRayLanes(band, glyphLocIdx, bandsX, bandsY) {
  const at = (slot, c) => band[(glyphLocIdx + slot) * 4 + c];
  if (!(bandsY >= 2) || !(bandsX >= 1) || (glyphLocIdx + 2) * 4 > band.length) return false;
  const arr0 = at(1, 0),
    y0 = at(1, 1),
    nLv = at(1, 2),
    lFirst = at(1, 3);
  if (![arr0, y0, nLv, lFirst].every(Number.isInteger)) return false;
  const base = (bandsY + bandsX) * 2; // H + V headers; +1 when a GWN tree header follows
  const levelSlot = y0 & ~1;
  let nLevelBands = 0;
  if (nLv > 0) {
    if (levelSlot !== base && levelSlot !== base + 2) return false;
    for (let l = Math.max(lFirst, 1); l <= nLv; l++) nLevelBands += (bandsY + (1 << l) - 1) >> l;
    if (arr0 !== levelSlot + nLevelBands * 2) return false;
  } else if (arr0 !== base && arr0 !== base + 1) return false;
  if ((glyphLocIdx + arr0) * 4 > band.length) return false;
  const clear = (slot) => {
    const i = (glyphLocIdx + slot + 1) * 4 + 1;
    if (!((band[i] | 0) & 1)) return;
    band[i] -= 1;
    const h = (glyphLocIdx + slot) * 4,
      n = (band[h] | 0) + (band[h + 1] | 0) + (band[h + 2] | 0) + (band[h + 3] | 0);
    const e0 = glyphLocIdx + (band[i - 1] | 0);
    for (let k = 0; k < n && (e0 + k + 1) * 4 <= band.length; k++) {
      band[(e0 + k) * 4 + 2] = -FLT_MAX;
      band[(e0 + k) * 4 + 3] = 0;
    }
  };
  for (let b = 0; b < bandsY + bandsX; b++) clear(b * 2);
  for (let k = 0; k < nLevelBands; k++) clear(levelSlot + k * 2);
  return true;
}

function resolveSpriteRange(bundle, sprite, side) {
  if (Array.isArray(sprite) && sprite.length === 2) {
    const r = checkedSpriteBounds(sprite, bundle && bundle.numShapes);
    if (!r)
      throw new Error(
        'createSpriteMorph: ' +
          side +
          '.sprite range [' +
          sprite.join(', ') +
          '] must be integers with 0 <= first <= last < ' +
          (bundle && bundle.numShapes) +
          ' shapes',
      );
    return r;
  }
  if (typeof sprite !== 'string')
    throw new Error('createSpriteMorph: ' + side + '.sprite must be a string id or [first,last]');
  const ranges = bundle && bundle.spriteRanges;
  const r = ownSpriteRange(bundle, sprite);
  if (!r) {
    throw new Error(
      'createSpriteMorph: unknown ' +
        side +
        ' sprite "' +
        sprite +
        '". Available: ' +
        (ranges ? Object.keys(ranges).join(', ') || '(none)' : '(no spriteRanges)'),
    );
  }
  const nc = bundle.spriteRangesNonContiguous;
  if (nc && nc.indexOf(sprite) >= 0) {
    mantleWarn(
      '[Mantle] createSpriteMorph: ' +
        side +
        ' sprite "' +
        sprite +
        '" has a non-contiguous shape range; interleaved foreign shapes will ' +
        'be morphed too.',
    );
  }
  return [r[0], r[1]];
}

function buildMorphPlan(src, dst, srcRange, dstRange) {
  const srcIds = src.shapeIds || new Array(src.numShapes).fill('');
  const dstIds = dst.shapeIds || new Array(dst.numShapes).fill('');
  // Sprite ranges (inclusive shape-index bounds); null = whole bundle.
  // The morph bundle keeps the whole src plane (indices stay absolute), so
  // these only SCOPE which shapes get matched/faded; out-of-range src shapes
  // are collected into `hidden` and forced invisible (see end of fn).
  const srcLo = srcRange ? srcRange[0] : 0;
  const srcHi = srcRange ? srcRange[1] : src.numShapes - 1;
  const dstLo = dstRange ? dstRange[0] : 0;
  const dstHi = dstRange ? dstRange[1] : dst.numShapes - 1;

  const srcRanges = src.curveRangesByShape || curveRangesByShape(src);
  const dstRanges = dst.curveRangesByShape || curveRangesByShape(dst);
  resolveLastShapeEnd(srcRanges, extractCurveFloats(src).length);
  resolveLastShapeEnd(dstRanges, extractCurveFloats(dst).length);

  const srcCurves = extractCurveFloats(src),
    dstCurves = extractCurveFloats(dst);
  const records = (bundle, ranges, curves) => {
    const band = bundle.bandFloats || (bundle.bands ? new Float32Array(bundle.bands) : null);
    const cache = new Map(),
      stride = bundle.metaFloatsPerShape || 48;
    return (index) => {
      if (cache.has(index)) return cache.get(index);
      if (!band) return null;
      const base = index * stride + META_TEXEL_4,
        meta = bundle.metaFloats;
      const segs = collectShapeSegs(
        band,
        4096,
        (meta[base + 1] | 0) * 4096 + (meta[base] | 0),
        (meta[base + 3] | 0) + 1,
        (meta[base + 2] | 0) + 1,
      );
      const layout = segs.map((seg) => {
        const off = 4 * (seg.hy * 4096 + seg.hx);
        return [off - ranges[index].begin, (curves[off] | 0) & ~8];
      });
      cache.set(index, layout);
      return layout;
    };
  };
  const srcRecords = records(src, srcRanges, srcCurves),
    dstRecords = records(dst, dstRanges, dstCurves);
  const compatible = (i, j) => {
    if (src === dst && i === j) return true;
    const a = srcRanges[i],
      b = dstRanges[j],
      length = a.end - a.begin;
    if (length !== b.end - b.begin) return false;
    if (!length) return true;
    // Ordinary records are contiguous: header, data and join. Arcs-join rows
    // add curvature texels and use the band-indexed check below instead.
    if (
      src.metaFloats[i * (src.metaFloatsPerShape || 48) + 25] !== 4 &&
      dst.metaFloats[j * (dst.metaFloatsPerShape || 48) + 25] !== 4
    ) {
      let offA = a.begin,
        offB = b.begin;
      while (offA < a.end) {
        const x = srcCurves[offA],
          y = dstCurves[offB];
        if (!(x >= 0 && x < 16 && x === (x | 0) && y >= 0 && y < 16 && y === (y | 0))) break;
        const typeA = (x | 0) & 3,
          typeB = (y | 0) & 3;
        const stepA = typeA === 0 ? 12 : typeA === 3 ? 20 : 16;
        const stepB = typeB === 0 ? 12 : typeB === 3 ? 20 : 16;
        if (offA + stepA > a.end || offB + stepB > b.end) break;
        if (((x | 0) & ~8) !== ((y | 0) & ~8)) return false;
        offA += stepA;
        offB += stepB;
      }
      if (offA === a.end) return true;
    }
    const A = srcRecords(i),
      B = dstRecords(j);
    return !!(
      A &&
      B &&
      A.length === B.length &&
      A.every((r, k) => r[0] === B[k][0] && r[1] === B[k][1])
    );
  };

  const usedDst = new Uint8Array(dst.numShapes);
  const usedSrc = new Uint8Array(src.numShapes); // sprite-mode positional pass
  const matched = [];
  const srcOnly = [];
  const isSprite = !!srcRange; // sprite morph → positional fallback ignores synthetic ids

  // First pass — name-based matching for non-empty ids.
  // Build a name → index map on dst, SCOPED to the dst range so a sprite
  // morph (esp. src === dst) matches across the two ranges, never a shape
  // against itself.
  const dstByName = new Map();
  for (let j = dstLo; j <= dstHi; j++) {
    const id = dstIds[j];
    if (id) {
      let entries = dstByName.get(id);
      if (!entries) {
        entries = { rows: [], next: 0 };
        dstByName.set(id, entries);
      }
      entries.rows.push(j);
    }
  }
  for (let i = srcLo; i <= srcHi; i++) {
    const id = srcIds[i];
    if (!id) continue;
    const entries = dstByName.get(id);
    const j = entries && entries.rows[entries.next++];
    if (j == null) {
      if (isSprite) continue;
      srcOnly.push({ srcIdx: i });
      continue;
    }
    if (usedDst[j]) {
      if (isSprite) continue;
      srcOnly.push({ srcIdx: i });
      continue;
    }
    const sR = srcRanges[i],
      dR = dstRanges[j];
    // Equal lengths, record offsets and packed types are required. Incompatible
    // pairs use the source-only / target-only visibility fade.
    if (compatible(i, j)) {
      matched.push({
        srcIdx: i,
        dstIdx: j,
        srcBegin: sR.begin,
        srcEnd: sR.end,
        dstBegin: dR.begin,
        dstEnd: dR.end,
      });
      usedDst[j] = 1;
      usedSrc[i] = 1;
    } else {
      if (isSprite) continue; // defer to positional pass
      srcOnly.push({ srcIdx: i });
    }
  }
  // Second pass — positional matching. Whole-bundle: only empty-id shapes
  // (existing behavior). Sprite mode: ALL still-unmatched in-range shapes,
  // ignoring synthetic ids (the i-th shape of sprite A morphs into the i-th
  // of sprite B — the intuitive pose-to-pose pairing).
  let posJ = dstLo;
  for (let i = srcLo; i <= srcHi; i++) {
    if (isSprite ? usedSrc[i] : srcIds[i]) continue;
    // Find the next unused in-range dst slot. Whole-bundle requires an
    // empty id; sprite mode takes any unused dst row in range.
    while (posJ <= dstHi && (usedDst[posJ] || (!isSprite && dstIds[posJ]))) posJ++;
    if (posJ > dstHi) {
      srcOnly.push({ srcIdx: i });
      continue;
    }
    const sR = srcRanges[i],
      dR = dstRanges[posJ];
    if (compatible(i, posJ)) {
      matched.push({
        srcIdx: i,
        dstIdx: posJ,
        srcBegin: sR.begin,
        srcEnd: sR.end,
        dstBegin: dR.begin,
        dstEnd: dR.end,
      });
      usedDst[posJ] = 1;
      usedSrc[i] = 1;
    } else {
      srcOnly.push({ srcIdx: i });
    }
    posJ++;
  }
  // Whole-bundle morphs: a synthetic id (`shape_<row>_fill`, `shape_<row>_stroke`) names a ROW, not a shape, and a row that opens a
  // group in one pose and not in the other shifts every later number. What the name pass left over pairs by order, per paint kind, when
  // the records are compatible (sprite morphs already pair every leftover by position).
  if (!isSprite) {
    const kindOf = (id) => {
      const m = /^shape_L?\d+_(fill|stroke)$/.exec(id || '');
      return m ? m[1] : null;
    };
    const pending = { fill: [], stroke: [] };
    for (let j = dstLo; j <= dstHi; j++)
      if (!usedDst[j]) {
        const k = kindOf(dstIds[j]);
        if (k) pending[k].push(j);
      }
    const next = { fill: 0, stroke: 0 };
    for (let n = 0; n < srcOnly.length; n++) {
      const i = srcOnly[n].srcIdx,
        k = kindOf(srcIds[i]);
      if (!k || i < srcLo || i > srcHi) continue;
      const list = pending[k];
      if (next[k] >= list.length) continue;
      const j = list[next[k]];
      if (!compatible(i, j)) continue;
      next[k]++;
      const sR = srcRanges[i],
        dR = dstRanges[j];
      matched.push({
        srcIdx: i,
        dstIdx: j,
        srcBegin: sR.begin,
        srcEnd: sR.end,
        dstBegin: dR.begin,
        dstEnd: dR.end,
      });
      usedDst[j] = 1;
      usedSrc[i] = 1;
      srcOnly.splice(n--, 1);
    }
  }
  // Third pass — collect unused dst shapes (within the dst range).
  const dstOnly = [];
  for (let j = dstLo; j <= dstHi; j++) {
    if (!usedDst[j]) dstOnly.push({ dstIdx: j });
  }
  // Shapes OUTSIDE the src range (when a sprite range is set) that aren't
  // part of the morph: the morph bundle keeps the whole src plane (so every
  // meta row's absolute curve/band/geom/table indices stay valid — slicing
  // those is the rabbit hole), and these non-sprite rows are simply forced
  // invisible so only the sprite renders. Empty for a whole-bundle morph.
  const hidden = [];
  if (srcRange) {
    for (let i = 0; i < src.numShapes; i++) {
      if (i < srcLo || i > srcHi) hidden.push(i);
    }
  }
  const plan = {
    matched,
    srcOnly,
    dstOnly,
    hidden,
    // Whole-src seed: indices stay absolute, so finalShapeCount counts the
    // full src plane plus dst-only appends (NOT just the sprite's rows).
    finalShapeCount: src.numShapes + dstOnly.length,
  };
  // A leaf that is a composited group in one pose and not in the other: morphGroups.js.
  planMorphGroups(src, dst, plan, srcRange, dstRange);
  return plan;
}

/**
 * Walk a bundle's metaFloats and return per-shape curve-buffer
 * ranges [{ begin, end }] in float units (i.e. 4 floats per RGBA32F
 * texel). Empty ranges are valid (`begin === end`).
 */
function curveRangesByShape(bundle) {
  const n = bundle.numShapes;
  const stride = bundle.metaFloatsPerShape || 48;
  const meta = bundle.metaFloats;
  const totalCurveFloats = bundle.curveTexels
    ? bundle.curveTexels.length // only present on textRun output
    : 0;
  // Production createBundle bundles don't keep .curveTexels on the
  // returned object. Reconstruct per-shape curve ranges from meta
  // texel 4 (glyphLoc), which encodes each shape's first curve offset.
  const TEX_W = 4096;
  const ranges = new Array(n);
  for (let i = 0; i < n; i++) {
    const base = i * stride;
    const gx = meta[base + META_TEXEL_4] | 0;
    const gy = meta[base + META_TEXEL_4 + 1] | 0;
    ranges[i] = { begin: 4 * (gy * TEX_W + gx), end: 0 };
  }
  for (let i = 0; i < n - 1; i++) ranges[i].end = ranges[i + 1].begin;

  if (n > 0) ranges[n - 1].end = -1;
  return ranges;
}

// ---- Sections composition ------------------------------------------

// Keep static bundles unchanged; only preparation reads the restored ceilings.
function withMorphStrokeLimits(bundle) {
  const limits = bundle.strokeMiterLimits;
  if (!limits || !bundle.metaFloats) return bundle;
  const original = bundle.metaFloats,
    stride = bundle.metaFloatsPerShape || 48;
  let meta = null;
  for (let i = 0; i < bundle.numShapes; i++) {
    const limit = Math.fround(limits[i]),
      off = i * stride;
    if (
      !(original[off + 12] > 0) ||
      !Number.isFinite(limit) ||
      limit < 1 ||
      limit === original[off + 26]
    )
      continue;
    if (!meta) meta = original.slice();
    meta[off + 26] = limit;
  }
  return meta
    ? Object.assign(Object.create(bundle), { metaFloats: meta, __morphInput: null })
    : bundle;
}

/**
 * Build a `sections`-shape dict for the morph bundle. The merged
 * curve plane lays out src first, then dst-only shapes appended,
 * each rounded to row boundaries. The merged meta plane copies src
 * meta rows as-is, then dst-only meta rows with their glyphLoc
 * rewritten to point into the new curve plane.
 *
 * Side-channel fields (prefixed with `_`):
 *   _mergedCurveF32: the assembled curve plane as Float32Array.
 *                     Cached so setT can re-upload from it.
 *   _dstCurveF32:    dst's curve plane as Float32Array, reindexed
 *                     into the merged layout (matched shapes have
 *                     their dst curves copied into the slot that
 *                     holds the src shape's curves).
 *   _curveW, _curveH: dims of the merged curve plane.
 */
/** @param {{alignFullTurnDirection?: boolean, compat?: 'spec'|'chrome', arcRotation?: 'spec'|'shortest'}} [opts] */

function composeMorphSections(src, dst, plan, opts = {}) {
  const sourceHitEnd = src.numShapes,
    destinationHitEnd = dst.numShapes;
  // The poses seen with the neutral group rows the group policy added (morphGroups.js); the same objects when it added none.
  src = withMorphStrokeLimits(plan.srcView || src);
  dst = withMorphStrokeLimits(plan.dstView || dst);
  const sourceHidden = src._morphEndpointHidden || null,
    destinationHidden = dst._morphEndpointHidden || null;
  if (sourceHidden || destinationHidden) {
    plan.endpointSourceHidden = sourceHidden;
    plan.endpointDestinationHidden = destinationHidden;
    for (const m of plan.matched) {
      const a = sourceHidden && sourceHidden.has(m.srcIdx) ? 0 : 1;
      const b = destinationHidden && destinationHidden.has(m.dstIdx) ? 0 : 1;
      if (a === 1 && b === 1) continue;
      if (!plan.endpointVisibilityPairs) plan.endpointVisibilityPairs = [];
      plan.endpointVisibilityPairs.push([m.srcIdx, a, b]);
    }
  }
  const TEX_W = 4096;
  // Both poses' coordinates are stored relative to their bundle's ORIGIN (bundle/layout.js). The merged table is src's frame with
  // the dst rows copied in, so a dst whose origin differs would draw displaced by the difference (and a lerp mixes the two
  // frames). Re-expressing every dst plane (curves, bboxes, gradients, regions, atlas frames) in src's frame is not done: both
  // poses must be imported with one origin, which `importSvg(svg, { origin: [x, y] })` pins.
  const mergedOrigin = (src.numShapes === 0 ? dst.origin : src.origin) || [0, 0];
  if (src.numShapes !== 0 && dst.numShapes !== 0) {
    const so = src.origin || [0, 0],
      dO = dst.origin || [0, 0];
    if (so[0] !== dO[0] || so[1] !== dO[1])
      throw new Error(
        'morph: the two bundles have different origins (' +
          JSON.stringify(so) +
          ' and ' +
          JSON.stringify(dO) +
          '): their coordinates are stored ' +
          'relative to them, so the poses would not line up. Import both with the same origin: importSvg(svg, { origin: [x, y] }).',
      );
  }

  const srcCurveF32 = extractCurveFloats(src);
  const dstCurveF32 = extractCurveFloats(dst);

  // 1) Walk plan.matched: for each matched pair, copy the dst slice
  //    into a re-mapped buffer that uses the src layout so the lerp
  //    arithmetic in setT can subarray both sides at the same indices.
  const dstRemapped = new Float32Array(srcCurveF32.length);
  // For matched pairs, copy dst[dstBegin..dstEnd] → dstRemapped[srcBegin..srcEnd].
  for (const m of plan.matched) {
    dstRemapped.set(dstCurveF32.subarray(m.dstBegin, m.dstEnd), m.srcBegin);
  }
  // Non-matched src ranges in dstRemapped stay zero — they're never
  // sampled (the corresponding shapes fade out + the matched lerp
  // doesn't read those slots).

  // 2) Append dst-only shape curves. They land after src's curve
  //    plane, padded to a row boundary so meta's glyphLoc remains a
  //    valid (x, y) into the new TEX_W-wide plane.
  const dstRanges = dst.curveRangesByShape || curveRangesByShape(dst);
  resolveLastShapeEnd(dstRanges, dstCurveF32.length);
  const srcRanges = src.curveRangesByShape || curveRangesByShape(src);
  resolveLastShapeEnd(srcRanges, srcCurveF32.length);

  let appendOffsetF = srcCurveF32.length;
  // Round appendOffset up to the next row boundary (TEX_W * 4 floats).
  const rowFloats = TEX_W * 4;
  if (appendOffsetF % rowFloats !== 0) {
    appendOffsetF += rowFloats - (appendOffsetF % rowFloats);
  }
  // Curve location zero is the band-walk sentinel, including an empty source.
  if (appendOffsetF === 0 && plan.dstOnly.length) appendOffsetF = 4;
  const dstOnlyEntries = [];
  let runningOffsetF = appendOffsetF;
  for (const d of plan.dstOnly) {
    const r = dstRanges[d.dstIdx];
    const len = r.end - r.begin;
    dstOnlyEntries.push({ dstIdx: d.dstIdx, newOffsetF: runningOffsetF, len });
    runningOffsetF += len;
    // Band entries address curve texels linearly, including records that
    // cross texture rows. Only the completed plane needs row padding.
  }
  // Fixed fades retain their exact record ranges, excluding append padding.
  const fixedCurveRanges = [];
  for (const entry of plan.srcOnly) {
    const range = srcRanges[entry.srcIdx];
    fixedCurveRanges[entry.srcIdx] = { begin: range.begin, end: range.end };
  }
  for (let i = 0; i < dstOnlyEntries.length; i++) {
    const entry = dstOnlyEntries[i];
    fixedCurveRanges[src.numShapes + i] = {
      begin: entry.newOffsetF,
      end: entry.newOffsetF + entry.len,
    };
  }
  const mergedCurveTotalF = Math.max(srcCurveF32.length, runningOffsetF);
  const mergedCurveF32 = new Float32Array(roundUpToRow(mergedCurveTotalF, rowFloats));
  // Copy src first; this is the baseline / t=0 state.
  mergedCurveF32.set(srcCurveF32, 0);
  // Append dst-only chunks at their assigned offsets.
  for (let k = 0; k < dstOnlyEntries.length; k++) {
    const e = dstOnlyEntries[k];
    const r = dstRanges[e.dstIdx];
    mergedCurveF32.set(dstCurveF32.subarray(r.begin, r.end), e.newOffsetF);
  }

  // 2b) Build the ENDPOINT-form twins of the two planes. Those — not these — are
  //     what setT interpolates, because a componentwise lerp of CENTER-form arcs
  //     tears the contour apart (prepareArcMorph has the argument). The planes
  //     here stay in center form: they are the bundle's t=0 state, read directly
  //     by the shader.
  const arcPrep = prepareArcMorph(
    src,
    plan,
    TEX_W,
    mergedCurveF32,
    dstRemapped,
    opts?.alignFullTurnDirection === true,
    opts?.compat === 'chrome',
    opts?.arcRotation === 'shortest',
  );

  // 2c) Who-joins-whom, for the per-frame join-tangent rebuild. A stroked
  //     segment's join texel holds its neighbors' UNIT tangents, and those
  //     cannot be interpolated — they have to be recomputed from the lerped
  //     geometry each frame, or the stroke's joins fly apart (buildJoinTable).
  // Resolve adjacency from stored endpoint-form vertices rather than a
  // trigonometric reconstruction from center-form parameters.
  const joinTable = arcPrep.segTables.size
    ? buildJoinTable(
        src,
        plan,
        TEX_W,
        arcPrep.srcEp || mergedCurveF32,
        arcPrep.segTables,
        new Set(arcPrep.arcs),
      )
    : EMPTY_I32;

  // 3) Build the merged meta plane. Src meta rows copied verbatim;
  //    dst-only meta rows appended with glyphLoc re-pointed into the
  //    appended curve region.
  const stride = src.metaFloatsPerShape || 48;
  let finalN = plan.finalShapeCount;
  let mergedMetaF = new Float32Array(finalN * stride);
  mergedMetaF.set(src.metaFloats.subarray(0, src.numShapes * stride), 0);
  // Parallel dst-aligned meta plane — for each matched src shape, the
  // dst shape's meta row is copied into the *src* slot so setT() can
  // lerp per-texel against the matched src row at the same byte
  // offset. Non-matched rows are zeroed and untouched by the lerp.
  // DefineMorphShape2 morphs: fillColor (texel 1) + strokeColor
  // (texel 2) + strokeWidth (texel 3.x) + bbox (texel 0) + imageRect
  // (texel 9). The setT pass only touches those slots; structural
  // slots (gradient ids, clip/mask ids, glyphLoc, flagsShape, ...)
  // stay at src.
  let dstAlignedMetaF = new Float32Array(finalN * stride);
  for (const m of plan.matched) {
    dstAlignedMetaF.set(
      dst.metaFloats.subarray(m.dstIdx * stride, (m.dstIdx + 1) * stride),
      m.srcIdx * stride,
    );
    const sourceOff = m.srcIdx * stride,
      targetOff = m.dstIdx * stride;
    const sourceFillImage = src.metaFloats[sourceOff + 35] > 0;
    const sourceStrokeImage = src.metaFloats[sourceOff + 47] > 0;
    const targetSameRole = sourceFillImage
      ? dst.metaFloats[targetOff + 35] > 0
      : !(dst.metaFloats[targetOff + 35] > 0) && dst.metaFloats[targetOff + 47] > 0;
    // Bitmap bindings remain source-owned. A solid target has no mapping to interpolate.
    if ((sourceFillImage || sourceStrokeImage) && !targetSameRole)
      dstAlignedMetaF.set(src.metaFloats.subarray(sourceOff + 36, sourceOff + 40), sourceOff + 36);
  }
  // A fill whose color has alpha 0 of its own (a hueless transparent color: FS_FILL_HUELESS) has nothing to interpolate toward: CSS Color 4
  // interpolates colors premultiplied, so the other pose's hue holds all the way across (red to rgba(0,0,255,0) is red fading, not purple).
  // A fill kept at alpha 0 by fill-opacity keeps its hue and blends with it, because fill and fill-opacity interpolate on their own.
  for (const m of plan.matched) {
    const so = m.srcIdx * stride,
      dO = m.dstIdx * stride;
    const sClear = (Math.round(src.metaFloats[so + 27]) & FS_FILL_HUELESS) !== 0,
      dClear = (Math.round(dst.metaFloats[dO + 27]) & FS_FILL_HUELESS) !== 0;
    if (sClear === dClear) continue;
    for (let k = 4; k < 7; k++) {
      if (sClear) mergedMetaF[so + k] = dst.metaFloats[dO + k];
      else dstAlignedMetaF[so + k] = src.metaFloats[so + k];
    }
  }
  // A pattern carrier's pattern inverse (texel 5, slots 20..23) lerps with the tile (36..39): a shared pattern's carriers differ in it by
  // the box's scale (bundleFinalize.js vectorPatternMaterial), so a morph between two poses of the same art lands on each. Every other
  // pairing (a carrier with a row that is not one, any row whose texel 5 holds something else) keeps the source's.
  const isCarrier = (meta, o) =>
    Math.round(meta[o + 43]) === 2 && !(Math.round(meta[o + 27]) & 256);
  for (const m of plan.matched) {
    const so = m.srcIdx * stride,
      dO = m.dstIdx * stride;
    if (isCarrier(src.metaFloats, so) && isCarrier(dst.metaFloats, dO)) continue;
    for (let k = 20; k < 24; k++) dstAlignedMetaF[so + k] = src.metaFloats[so + k];
  }
  // A primitive tag (rect, circle, roundRect, annulus) describes the source geometry and the closed-form fast paths read it
  // together with the bbox; neither slot is lerped, so a pose between two different primitives (or two roundRects of different
  // radii) is not that primitive. Clear the tag on those rows, as streamGeometry.js does for a deformed shape.
  for (const m of plan.matched) {
    const so = m.srcIdx * stride,
      dO = m.dstIdx * stride;
    const kind = src.metaFloats[so + META_PRIM_KIND] | 0;
    if (!kind) continue;
    if (
      kind === (dst.metaFloats[dO + META_PRIM_KIND] | 0) &&
      (kind !== 3 ||
        src.metaFloats[so + META_END_CAP_OR_RX] === dst.metaFloats[dO + META_END_CAP_OR_RX])
    )
      continue;
    mergedMetaF[so + META_PRIM_KIND] = 0;
    if (kind === 3) mergedMetaF[so + META_END_CAP_OR_RX] = 0;
  }
  // Bands FIRST: append a collapsed band region for each dst-only shape so
  // it rasterizes (its segments repointed into the merged curve buffer).
  // Done before the dst-only meta loop, which needs the band glyphLocs.
  const bandsResult = concatBandPlanes(src, dst, plan, TEX_W, arcPrep, mergedCurveF32, dstRemapped);
  const dstOnlyBanded = appendDstOnlyBands(bandsResult.buf, dst, dstOnlyEntries, TEX_W);
  const bandsAb = dstOnlyBanded.buf;
  const matchedRewrites = bandsResult.matchedRewrites;
  const dstOnlyBandRewrites = dstOnlyBanded.rewrites;

  // Assign each dst-only shape a FRESH unique gid (meta texel 3.z / float 14)
  // so its appended cover-quad chunk resolves to its own merged shape index
  // (buildGidToShapeIdx maps gid→first shape with that gid; a collision with
  // a src gid would steal the chunk). Track the gid → merged-index mapping so
  // rewriteCurveGeom can stamp the appended chunks with the same gids.
  let maxGid = 0;
  for (let s = 0; s < src.numShapes; s++) {
    const g = Math.floor(src.metaFloats[s * stride + 14] + 0.5);
    if (g > maxGid) maxGid = g;
  }
  const dstOnlyGids = []; // per dstOnlyEntries[k]: the new unique gid

  for (let k = 0; k < dstOnlyEntries.length; k++) {
    const e = dstOnlyEntries[k];
    const srcRow = dst.metaFloats.subarray(e.dstIdx * stride, (e.dstIdx + 1) * stride);
    const dstRow = mergedMetaF.subarray(
      (src.numShapes + k) * stride,
      (src.numShapes + k + 1) * stride,
    );
    dstRow.set(srcRow);
    // Texel 4 = (glyphLoc.x, glyphLoc.y, bandMaxX, bandMaxY) and addresses
    // this shape's BAND region (the shader reaches curves THROUGH the bands).
    const rw = dstOnlyBandRewrites[k];
    if (rw) {
      dstRow[META_TEXEL_4] = rw.glyphLocIdx % TEX_W;
      dstRow[META_TEXEL_4 + 1] = (rw.glyphLocIdx / TEX_W) | 0;
      dstRow[META_TEXEL_4 + 2] = 0;
      dstRow[META_TEXEL_4 + 3] = 0;
    }
    // Fresh gid so the appended cover-quad chunk maps to this shape.
    const newGid = ++maxGid;
    dstRow[14] = newGid;
    dstOnlyGids.push(newGid);
  }
  // 5) Bands for MATCHED shapes: rebuild as 1×1 collapsed layouts (every
  //    segment in the single H + V band) — see concatBandPlanes rationale
  //    (prevents cover-quad segment fragmentation at t>0). Apply the
  //    collapsed-band glyphLoc rewrites to mergedMetaF before serializing.
  for (const r of matchedRewrites) {
    const base = r.srcIdx * stride;
    const newGx = r.glyphLocIdx % TEX_W;
    const newGy = (r.glyphLocIdx / TEX_W) | 0;
    mergedMetaF[base + META_TEXEL_4] = newGx;
    mergedMetaF[base + META_TEXEL_4 + 1] = newGy;
    mergedMetaF[base + META_TEXEL_4 + 2] = 0; // bandMaxX = 0 (one V band)
    mergedMetaF[base + META_TEXEL_4 + 3] = 0; // bandMaxY = 0 (one H band)
  }
  // Clip/mask bindings are row indices; see morphBindings.js for the t < 1 / t = 1 policy.
  const bindings = composeMorphBindings(src, dst, plan, mergedMetaF, dstAlignedMetaF, stride);
  mergedMetaF = bindings.meta;
  dstAlignedMetaF = bindings.aligned;
  const aliasN = bindings.sources.length;
  finalN += aliasN;

  //
  // The merged globalBBox must ENCLOSE the appended dst-only shapes — they
  // can sit outside src's bbox (a shape only in the dst pose, anywhere in
  // the frame). The bbox drives band grid / cover quad / em→NDC mapping, so
  // a dst-only shape outside it never rasterizes. Union src's globalBBox
  // (xywh) with each dst-only shape's per-shape bbox (meta texel 0 =
  // xmin,ymin,xmax,ymax) and re-emit as xywh.
  const srcBB = (src.numShapes === 0 ? dst.globalBBox : src.globalBBox) || [0, 0, 0, 0];
  let bbX0 = srcBB[0],
    bbY0 = srcBB[1],
    bbX1 = srcBB[0] + srcBB[2],
    bbY1 = srcBB[1] + srcBB[3];
  for (const e of dstOnlyEntries) {
    const o = e.dstIdx * stride;
    if (dst.metaFloats[o + 0] < bbX0) bbX0 = dst.metaFloats[o + 0];
    if (dst.metaFloats[o + 1] < bbY0) bbY0 = dst.metaFloats[o + 1];
    if (dst.metaFloats[o + 2] > bbX1) bbX1 = dst.metaFloats[o + 2];
    if (dst.metaFloats[o + 3] > bbY1) bbY1 = dst.metaFloats[o + 3];
  }
  settleHiddenRows(src, dst, plan, mergedMetaF, dstAlignedMetaF, stride, dstOnlyEntries);
  // The visible endpoint supplies base RGBA; visibility applies the fade once.
  if (plan.endpointVisibilityPairs)
    for (const [row, a, b] of plan.endpointVisibilityPairs) {
      if (a === b) continue;
      const o = row * stride,
        from = a === 0 ? dstAlignedMetaF : mergedMetaF;
      const to = a === 0 ? mergedMetaF : dstAlignedMetaF;
      for (let k = 4; k < 12; k++) to[o + k] = from[o + k];
    }
  const gradientPlan = prepareMorphGradients(src, dst, plan, mergedMetaF, stride);
  const paintGradients = prepareMorphImageFrames(
    src,
    dst,
    plan,
    mergedMetaF,
    dstAlignedMetaF,
    stride,
    gradientPlan,
  );
  const paintDashes = prepareMorphDashes(src, dst, plan, mergedMetaF, stride);
  const { targetImageIds, ...paintImages } = prepareMorphImages(
    src,
    dst,
    plan,
    mergedMetaF,
    stride,
    morphFilterImageIds(dst, plan, stride, dstAlignedMetaF),
  );
  const { filterSteps, ...paintFilters } = prepareMorphFilters(
    src,
    dst,
    plan,
    mergedMetaF,
    stride,
    targetImageIds,
    dstAlignedMetaF,
  );
  // An alias row was copied from its origin before the steps above gave the origin its merged resource ids and image frame.
  for (let k = 0; k < aliasN; k++) {
    const to = (plan.finalShapeCount + k) * stride,
      from = bindings.sources[k].origin * stride;
    for (const slot of ALIAS_RESOURCE_SLOTS) mergedMetaF[to + slot] = mergedMetaF[from + slot];
    for (let slot = 36; slot < 40; slot++)
      dstAlignedMetaF[to + slot] = dstAlignedMetaF[from + slot];
  }
  const totalBBox =
    src.numShapes === 0
      ? srcBB
      : dstOnlyEntries.length
        ? [bbX0, bbY0, bbX1 - bbX0, bbY1 - bbY0]
        : srcBB;
  const metaAb = new ArrayBuffer(32 + mergedMetaF.byteLength);
  const mdv = new DataView(metaAb);
  mdv.setUint32(0, finalN, true);
  stampMetaHeader(mdv, mergedOrigin);
  mdv.setFloat32(4, totalBBox[0], true);
  mdv.setFloat32(8, totalBBox[1], true);
  mdv.setFloat32(12, totalBBox[2], true);
  mdv.setFloat32(16, totalBBox[3], true);
  new Uint8Array(metaAb, 32).set(new Uint8Array(mergedMetaF.buffer));

  // 6) curveGeom (per-shape OBB cover-quad chunks): copy src's chunks
  //    (union-rewriting matched ones), then append each dst-only shape's
  //    chunk from dst, stamped with the fresh gid so it resolves to the
  //    dst-only shape's merged index. Without its cover quad the dst-only
  //    shape generates NO draw op and never renders.
  const curveGeomAb = rewriteCurveGeom(src, dst, plan, dstOnlyEntries, dstOnlyGids, arcPrep);

  const curveW = TEX_W;
  const curveH = (mergedCurveF32.length / (TEX_W * 4)) | 0;

  // Concatenate the merged curve plane back into an ArrayBuffer for
  // createBundle. (Float32Array.buffer survives the .slice copy.)
  const curvesAb = mergedCurveF32.buffer.slice(0);

  // Merged shape-id list: src's ids followed by dst-only ids. The <a href> list follows the same
  // row order, so a hit on a morph answers the link its row came from.
  const mergedShapeIds = (src.shapeIds || []).slice();
  const mergedShapeHrefs = src.shapeHrefs
    ? src.shapeHrefs.slice()
    : new Array(mergedShapeIds.length).fill('');
  for (const e of dstOnlyEntries) {
    mergedShapeIds.push((dst.shapeIds && dst.shapeIds[e.dstIdx]) || '');
    mergedShapeHrefs.push((dst.shapeHrefs && dst.shapeHrefs[e.dstIdx]) || '');
  }
  // Alias rows are unnamed: overrides address their origin and propagate.
  for (let k = 0; k < aliasN; k++) {
    mergedShapeIds.push('');
    mergedShapeHrefs.push('');
  }
  // What the pointer can target: a matched row keeps the source's, a destination-only row its own, an alias row its origin's.
  let mergedHitBits = null;
  if (src.hitBits || dst.hitBits) {
    mergedHitBits = new Uint8Array(mergedShapeIds.length);
    // A side with no table answers by its paint (a programmatic or text bundle): never as bits 0, which would make its rows untargetable.
    for (let i = 0; i < src.numShapes; i++) mergedHitBits[i] = rowHitBits(src, i);
    // (a source row kept hidden that the destination shows takes the destination's bits: the morph ends on the destination)
    for (const m of plan.matched) {
      if ((mergedHitBits[m.srcIdx] & 0x80) !== 0 && (rowHitBits(dst, m.dstIdx) & 0x80) === 0)
        mergedHitBits[m.srcIdx] = rowHitBits(dst, m.dstIdx);
    }
    dstOnlyEntries.forEach((e, k) => {
      mergedHitBits[src.numShapes + k] = rowHitBits(dst, e.dstIdx);
    });
    bindings.sources.forEach((e, k) => {
      mergedHitBits[src.numShapes + dstOnlyEntries.length + k] = mergedHitBits[e.origin];
    });
  }

  // No crossing-axis lanes on a morph (clearRayLanes). bandsAb is this morph's own copy of the planes.
  {
    const bf = new Float32Array(bandsAb);
    let unread = 0;
    for (let r = 0; r < finalN; r++) {
      const o = r * stride,
        byM = mergedMetaF[o + META_TEXEL_4 + 3] | 0;
      if (byM < 1) continue; // no bands (a group row), or a collapsed region: no lanes
      const g =
        (mergedMetaF[o + META_TEXEL_4 + 1] | 0) * TEX_W + (mergedMetaF[o + META_TEXEL_4] | 0);
      if (!clearRayLanes(bf, g, (mergedMetaF[o + META_TEXEL_4 + 2] | 0) + 1, byM + 1)) unread++;
    }
    if (unread)
      mantleWarn(
        `mantle: morph: ${unread} row(s) point at no band header this morph can read; their lane bits (if any) stay`,
      );
  }
  // Source rows keep their addresses; relocate destination owners through the merged row layout.
  let destinationHitRows = null;
  if (dst.hitOnly) {
    destinationHitRows = new Int32Array(dst.numShapes).fill(-1);
    for (const pair of plan.matched) destinationHitRows[pair.dstIdx] = pair.srcIdx;
    dstOnlyEntries.forEach((entry, k) => {
      destinationHitRows[entry.dstIdx] = src.numShapes + k;
    });
  }
  const sceneOrder = extendMorphDrawOrder(
    plan.sceneOrder !== undefined ? plan.sceneOrder : prepareMorphDrawOrder(src, dst, plan, stride),
    finalN,
  );
  // Hit-only anchors refer to paint positions, while geometry retains stable row addresses.
  let hitPaintRanks = null;
  if (sceneOrder && (src.hitOnly || dst.hitOnly)) {
    hitPaintRanks = new Int32Array(finalN);
    for (let i = 0; i < finalN; i++) hitPaintRanks[sceneOrder[i]] = i;
  }
  // Metadata glyph locations address bands, not curves. Preserve exact source
  // ranges and appended destination ranges instead of inferring from them.
  const mergedRanges = [
    ...srcRanges.map((r) => ({ begin: r.begin, end: r.end })),
    ...dstOnlyEntries.map((e) => ({ begin: e.newOffsetF, end: e.newOffsetF + e.len })),
  ];
  for (const e of bindings.sources) mergedRanges.push({ ...mergedRanges[e.origin] });
  // Preserve the poses' segment types and density for engine selection. Empty
  // endpoints contribute no types, despite their conservative all-type default.
  return {
    segTypeMask:
      (src.numShapes === 0 ? 0 : src.segTypeMask | 0) |
        (dst.numShapes === 0 ? 0 : dst.segTypeMask | 0) || 0xf,
    totalSegments: Math.round(
      Math.max(
        (src.meanSegsPerShape || 0) * (src.numShapes | 0),
        (dst.meanSegsPerShape || 0) * (dst.numShapes | 0),
      ),
    ),
    flags: (src.numShapes === 0 ? dst.flags : src.flags) || 0,
    metaFloatsPerShape: stride,
    // Interior-skip occupancy is deliberately off on a morph bundle, even if
    // src/dst were imported with it. The occupancy bits are packed in the curve
    // buffer, which setT() lerps + re-uploads per frame — the grid can't be
    // interpolated between poses (cells aren't lerpable) and would be lerped as
    // garbage curve floats. The src meta's texel-5 occupancy descriptor rides
    // along inertly; this flag is what keeps the shader from ever reading it.
    // (A morph-compatible interior skip wants an em-space POLY whose few
    // vertices lerp in the same setT pass — a separate feature.)
    hasOccupancy: false,
    origin: mergedOrigin.slice(),
    meta: metaAb,
    curves: curvesAb,
    bands: bandsAb,
    curveGeom: curveGeomAb,
    // Metadata glyph locations address bands, not curves. Preserve exact source
    // ranges and appended destination ranges instead of inferring from them.
    curveRangesByShape: mergedRanges,
    drawOrder: sceneOrder,
    _morphBindingAliases: bindings.aliases,
    _morphBindingSteps:
      filterSteps.length || gradientPlan.steps.length
        ? [...bindings.steps, ...filterSteps, ...gradientPlan.steps]
        : bindings.steps,
    shapeIds: mergedShapeIds,
    shapeHrefs: mergedShapeHrefs,
    hitBits: mergedHitBits,
    // Group ids keep working on the merged rows: the source's containers, plus the target's for the rows only it has.
    groupTree: mergedGroupTree(src, dst, dstOnlyEntries, finalN),
    // The hit-only regions are static: the source's until the morph passes halfway, the destination's after (hitTest.js).
    hitOnly: remapMorphHitTable(
      warnedHitOnly(src.hitOnly, 'the source'),
      null,
      sourceHitEnd,
      finalN,
      hitPaintRanks,
      src._drawOrder || src.drawOrder,
    ),
    hitOnlyTo: remapMorphHitTable(
      warnedHitOnly(dst.hitOnly, 'the destination'),
      destinationHitRows,
      destinationHitEnd,
      finalN,
      hitPaintRanks,
      dst._drawOrder || dst.drawOrder,
    ),
    // Animatable-clipper map. The morph keeps src's whole meta plane (clip /
    // mask layer rows live in the appended suffix, INSIDE numShapes, at the
    // same absolute indices), so src's clipperRows still point at valid rows.
    // Without this the morph bundle defaults clipperRows to {} and
    // overrides.setClipper(svgId) returns false → animated clips/masks on a
    // morphed (incl. sprite) bundle silently stop moving. spriteRanges is
    // forwarded for the same reason (drawSprite on a morph bundle). Both are
    // read-only side-inputs for the morph's lifetime.
    clipperRowSets: (() => {
      const out = Object.create(null);
      const mapping = new Map(plan.matched.map((m) => [m.dstIdx, m.srcIdx]));
      dstOnlyEntries.forEach((e, k) => mapping.set(e.dstIdx, src.numShapes + k));
      for (const side of [src, dst])
        for (const id of Object.keys(side.clipperRowSets || side.clipperRows || {})) {
          for (const group of clipperRowGroups(side, id) || []) {
            const rows =
              side === src
                ? group.slice()
                : group.map((r) => mapping.get(r)).filter((r) => r != null);
            if (!rows.length) continue;
            const groups = out[id] || (out[id] = []);
            if (!groups.some((g) => g.length === rows.length && g.every((r, i) => r === rows[i])))
              groups.push(rows);
          }
        }
      return out;
    })(),
    shapeDomPaths: src.shapeDomPaths || null,
    shapeDomIndex: src.shapeDomIndex || null,
    clipperRows: src.clipperRows || null,
    spriteRanges: src.spriteRanges || null,
    spriteRangesNonContiguous: src.spriteRangesNonContiguous || null,
    gradients: paintGradients.params.length ? paintGradients.params.buffer : null,
    gradientStops: paintGradients.stops.length ? paintGradients.stops.buffer : null,
    gradientStopsCount: paintGradients.stops.length / 4,
    // strokeMesh / clipMesh / maskMesh: forward src's buffers so per-
    // segment stroke meshes (Flash thick strokes / sharp joins / Option-B
    // path) survive into the morph bundle. Matched + src-only shapes
    // share src's gid → mesh chunks; dst-only shapes fade in via
    // visibility but won't have their own stroke-mesh chunks until the
    // dst-only appender is wired up. Acceptable for the common morph
    // (local deformation of the same topology). null inputs round-trip
    // as null.
    dashes: paintDashes,
    strokeMesh: src.strokeMesh && src.strokeMesh.byteLength ? src.strokeMesh.slice(0) : null,
    clipMesh: src.clipMesh && src.clipMesh.byteLength ? src.clipMesh.slice(0) : null,
    maskMesh: src.maskMesh && src.maskMesh.byteLength ? src.maskMesh.slice(0) : null,
    ...paintFilters,
    ...paintImages,
    // Side-channel for setT.
    _fixedCurveRanges: fixedCurveRanges,
    _mergedCurveF32: mergedCurveF32,
    _dstCurveF32: dstRemapped,
    _curveW: curveW,
    _curveH: curveH,
    // ARC morph side-channel. When the morph carries arcs, setT does NOT lerp
    // the two center-form planes above — it lerps these endpoint-form twins and
    // converts each arc record back to center form on the way into the live
    // curve texture. Null when no matched shape has a morphable arc, which is
    // the common case and leaves the fast paths exactly as they were.
    // (_arcOffsets lists each arc's HEADER float offset; see prepareArcMorph.)
    _srcEpCurveF32: arcPrep.srcEp,
    _dstEpCurveF32: arcPrep.dstEp,
    _arcOffsets: arcPrep.arcs,
    _arcEndPoseRanges: arcPrep.endPoseRanges || null,
    _arcFlagSteps: arcPrep.flagSteps || null,
    // Stroke join-tangent rebuild table (see buildJoinTable). Empty when nothing
    // matched is stroked, which leaves the fast paths untouched.
    _joinTable: joinTable,
    _curvatureRows: (() => {
      const frames = new Map();
      for (const m of plan.matched) {
        const b = m.srcIdx * stride;
        if (src.metaFloats[b + 25] !== 4 || !(src.metaFloats[b + 12] > 0)) continue;
        const frame =
          src.metaFloats[b + 27] & 4
            ? Array.from(src.metaFloats.subarray(b + 20, b + 24))
            : [1, 0, 0, 1];
        for (const seg of arcPrep.segTables.get(m.srcIdx) || [])
          frames.set(4 * (seg.hy * TEX_W + seg.hx), frame);
      }
      if (!frames.size) return [];
      const joins = new Map();
      for (let i = 0; i < joinTable.length; i += 6) {
        const type = joinTable[i + 1],
          off = joinTable[i] - (type === 0 ? 8 : type === 3 ? 16 : 12);
        joins.set(off, i);
      }
      const rows = [];
      for (const [off, frame] of frames) {
        const type = mergedCurveF32[off] & 3,
          index = joins.get(off);
        rows.push({
          out: off + (type === 0 ? 12 : type === 3 ? 20 : 16),
          off,
          type,
          prev: index === undefined ? -1 : joinTable[index + 2],
          prevType: index === undefined ? -1 : joinTable[index + 3],
          next: index === undefined ? -1 : joinTable[index + 4],
          nextType: index === undefined ? -1 : joinTable[index + 5],
          frame,
        });
      }
      return rows;
    })(),
    _dashMetricRows: plan.matched.flatMap((m) => {
      const base = m.srcIdx * stride;
      if (!(src.metaFloats[base + 15] > 0) || !(src.metaFloats[base + 12] > 0)) return [];
      const offsets = (arcPrep.segTables.get(m.srcIdx) || [])
        .map((s) => 4 * (s.hy * TEX_W + s.hx))
        .filter((off) => !(mergedCurveF32[off] & 4));
      if (!offsets.length) return [];
      const frame =
        src.metaFloats[base + 27] & 4
          ? [
              src.metaFloats[base + 20],
              src.metaFloats[base + 21],
              src.metaFloats[base + 22],
              src.metaFloats[base + 23],
              0,
              0,
            ]
          : null;
      return [{ offsets, frame }];
    }),
    _gradStopPlan: paintGradients.stopPlan,
    _srcGradStopsB: paintGradients.stops,
    _dstGradStopsB: paintGradients.targetStops,
    // DefineMorphShape2 meta-plane lerp side-channel:
    // _mergedMetaF32      — src's meta plane as the t=0 baseline.
    // _dstAlignedMetaF32  — dst's meta rows copied into the *src*
    //                       index for each matched pair, zero
    //                       elsewhere. setT lerps texel-by-texel
    //                       against _mergedMetaF32 for the
    //                       morphable slots only.
    _mergedMetaF32: mergedMetaF,
    _dstAlignedMetaF32: dstAlignedMetaF,
    _metaStride: stride,
    _matchedSrcIdxs: [...plan.matched.map((m) => m.srcIdx), ...bindings.matched],
    _gradParamPlan: paintGradients.paramPlan,
    _srcGradParamsF: paintGradients.params,
    _dstGradParamsF: paintGradients.targetParams,
  };
}

/// The group tree of a morph bundle's rows: a source row keeps its container, a target-only row takes the target's (nodes merge by
/// parent and name); a virtual group row and an alias row are in none. null when neither pose has a tree.
function mergedGroupTree(src, dst, dstOnlyEntries, finalN) {
  const sT = src.groupTree,
    dT = dst.groupTree;
  if (!sT && !dT) return null;
  const into = {
    names: sT ? sT.groupNames.slice() : [],
    parent: sT ? Array.from(sT.groupParent) : [],
  };
  const drawn = new Int32Array(finalN).fill(-1);
  if (sT)
    for (let i = 0, n = Math.min(src.numShapes, sT.drawnGroup.length); i < n; i++)
      drawn[i] = sT.drawnGroup[i];
  if (dT) {
    const memo = new Map();
    dstOnlyEntries.forEach((e, k) => {
      const g = e.dstIdx < dT.drawnGroup.length ? dT.drawnGroup[e.dstIdx] : -1;
      if (g >= 0)
        drawn[src.numShapes + k] = mergeNode(into, dT.groupNames, dT.groupParent, g, memo);
    });
  }
  const tree = compactTree(into.names, into.parent, [drawn]);
  return tree
    ? { format: 2, groupNames: tree.names, groupParent: tree.parent, drawnGroup: drawn }
    : null;
}

function extractCurveFloats(bundle) {
  // Source-of-truth priority:
  //   1. bundle.curveFloats — UNPADDED Float32Array exposed by
  //      createBundle exposes this unpadded view directly.
  //   2. bundle.curveTexels — textRun's intermediate shape (pre-
  //      createBundle); also unpadded.
  //   3. bundle._mergedCurveF32 — morph's own intermediate shape.
  //   4. bundle.curves ArrayBuffer — raw sections shape, padded
  //      iff createBundle has run on it (test-only path with
  //      hand-built sections).
  if (bundle.curveFloats instanceof Float32Array) return bundle.curveFloats;
  if (bundle.curveTexels instanceof Float32Array) return bundle.curveTexels;
  if (bundle._mergedCurveF32 instanceof Float32Array) return bundle._mergedCurveF32;
  if (bundle.curves && bundle.curves.byteLength) return new Float32Array(bundle.curves);
  return new Float32Array(0);
}

function resolveLastShapeEnd(ranges, totalLenF) {
  for (let i = 0; i < ranges.length; i++) {
    // -1 is the sentinel the inline build uses for the last shape.
    // createBundle's prebuilt ranges arrive fully resolved; leave
    // them alone. (`end === 0` legitimately means "zero-curve shape"
    // and is not a sentinel — don't overwrite it.)
    if (ranges[i].end === -1) ranges[i].end = totalLenF;
  }
}

function roundUpToRow(floats, rowFloats) {
  return floats % rowFloats === 0 ? floats : floats + (rowFloats - (floats % rowFloats));
}

// Append a collapsed (1×1) band region for each dst-only shape to an
// existing merged band buffer, with each segment's curve-header position
// repointed from the dst curve plane into the appended merged curve plane.
// dst-only shapes are STATIC (they fade in by visibility, don't lerp), so a
// plain copy of dst's segments suffices — no src/dst union needed.
// Returns { buf, rewrites:[{glyphLocIdx}|null] } aligned with dstOnlyEntries.
function appendDstOnlyBands(bandBuf, dst, dstOnlyEntries, TEX_W) {
  if (!dstOnlyEntries || !dstOnlyEntries.length) return { buf: bandBuf, rewrites: [] };
  const srcBand = new Float32Array(bandBuf);
  const dstBand = dst.bandFloats || (dst.bands ? new Float32Array(dst.bands) : null);
  const dstRanges = dst.curveRangesByShape || [];
  const stride = dst.metaFloatsPerShape || 48;
  const dstMeta = dst.metaFloats;
  const dstCurve =
    dst.curveFloats || (dst.curves ? new Float32Array(dst.curves) : new Float32Array(0));
  if (!dstBand || !dstMeta) return { buf: bandBuf, rewrites: dstOnlyEntries.map(() => null) };

  const perShape = dstOnlyEntries.map((e) => {
    const base = e.dstIdx * stride;
    const gx = dstMeta[base + META_TEXEL_4] | 0;
    const gy = dstMeta[base + META_TEXEL_4 + 1] | 0;
    const bandsX = (dstMeta[base + META_TEXEL_4 + 2] | 0) + 1;
    const bandsY = (dstMeta[base + META_TEXEL_4 + 3] | 0) + 1;
    const segs = collectShapeSegs(dstBand, TEX_W, gy * TEX_W + gx, bandsY, bandsX);
    const r = dstRanges[e.dstIdx];
    const deltaTex = (e.newOffsetF - (r ? r.begin : 0)) / 4; // signed relocation, in texels
    // The stroke's reach, as the importer pads a break value and a matched row's rewrite does (concatBandPlanes): without it the walk stops short of a cap's corner.
    const pad = Math.abs(dstMeta[base + 12]) * 0.5 * metaStrokeReachFactor(dstMeta, base);
    return segs.map((s) => {
      const newTex = s.hy * TEX_W + s.hx + deltaTex;
      const bb = readSegBbox(dstCurve, TEX_W, s.hx, s.hy, s.segType);
      return {
        hx: newTex % TEX_W,
        hy: (newTex / TEX_W) | 0,
        segType: s.segType,
        maxX: bb.maxX + pad,
        maxY: bb.maxY + pad,
        minX: bb.minX - pad,
        minY: bb.minY - pad,
      };
    });
  });

  let appendTexels = 0;
  const layouts = perShape.map((segs) => {
    const arr = segs.length; // ONE entry per texel
    appendTexels += 4 + arr * 2; // packed: no row slack (see concatBandPlanes)
    return { segs, headers: 4, hArr: arr, vArr: arr, glyphLocIdx: 0 };
  });
  const srcTexRounded = roundUpToTex(srcBand.length / 4, TEX_W);
  const out = new Float32Array(roundUpToTex(srcTexRounded + appendTexels, TEX_W) * 4);
  out.set(srcBand);
  const sortBy = (segs, k) =>
    segs
      .slice()
      .sort((a, b) =>
        a.segType !== b.segType ? a.segType - b.segType : a[k] !== b[k] ? b[k] - a[k] : 0,
      );
  let cursor = srcTexRounded;
  const rewrites = [];
  for (const layout of layouts) {
    layout.glyphLocIdx = cursor;
    const headerBase = cursor,
      hArrBase = cursor + 4,
      vArrBase = hArrBase + layout.hArr;
    const counts = [0, 0, 0, 0];
    for (const s of layout.segs) counts[s.segType]++;
    texelWrite(out, TEX_W, headerBase + 0, counts[0], counts[1], counts[2], counts[3]);
    texelWrite(out, TEX_W, headerBase + 1, 4, 0, 0, 0);
    texelWrite(out, TEX_W, headerBase + 2, counts[0], counts[1], counts[2], counts[3]);
    texelWrite(out, TEX_W, headerBase + 3, 4 + layout.hArr, 0, 0, 0);
    // ONE entry per texel: (loc, breakAxis, farAxis, _), loc = hy*4096 + hx.
    // farAxis is the seg's opposite edge on the break axis; the stroke walk
    // rejects a seg lying entirely past the pixel from this alone, without
    // reading its header or control texels. MUST match svg/textures.js and
    // hitTest/bandWinding.js — all three read the same buffer.
    const packEntries = (sorted, k, far, base) => {
      for (let i = 0; i < sorted.length; i++) {
        const s = sorted[i];
        texelWrite(out, TEX_W, base + i, s.hy * TEX_W + s.hx, s[k], s[far], 0);
      }
    };
    packEntries(sortBy(layout.segs, 'maxX'), 'maxX', 'minX', hArrBase);
    packEntries(sortBy(layout.segs, 'maxY'), 'maxY', 'minY', vArrBase);
    cursor = vArrBase + layout.vArr;
    rewrites.push({ glyphLocIdx: layout.glyphLocIdx });
  }
  return { buf: out.buffer, rewrites };
}

/**
 * Build endpoint-form twins for arc interpolation and retain the source
 * segment tables. Shared endpoints stay joined as positions and radii move.
 * The GPU fixup pass or CPU fallback converts arcs back to center form after
 * interpolation and rebuilds stroke join tangents. Input planes remain in
 * center form for ordinary rendering.
 *
 * @returns {{segTables: Map, srcEp: Float32Array, dstEp: Float32Array,
 *            arcs: Int32Array}} `arcs` lists the float offset of each arc's
 *   HEADER texel; srcEp/dstEp are the endpoint-form twins of the two planes.
 */
function prepareArcMorph(
  src,
  plan,
  TEX_W,
  merged,
  dstRemapped,
  alignFullTurnDirection,
  chromeFlags = false,
  shortestRotation = false,
) {
  const tables = new Map();
  const empty = { segTables: tables, srcEp: null, dstEp: null, arcs: EMPTY_I32 };
  if (!plan.matched.length) return empty;
  const srcBand = src.bandFloats || (src.bands ? new Float32Array(src.bands) : null);
  if (!srcBand || !srcBand.length) return empty;
  const stride = src.metaFloatsPerShape || 48;
  const srcMeta = src.metaFloats;

  const arcs = [];
  for (const m of plan.matched) {
    const base = m.srcIdx * stride;
    const glyph =
      (srcMeta[base + META_TEXEL_4 + 1] | 0) * TEX_W + (srcMeta[base + META_TEXEL_4] | 0);
    const bandsX = (srcMeta[base + META_TEXEL_4 + 2] | 0) + 1;
    const bandsY = (srcMeta[base + META_TEXEL_4 + 3] | 0) + 1;
    const segs = collectShapeSegs(srcBand, TEX_W, glyph, bandsY, bandsX);
    tables.set(m.srcIdx, segs);
    for (const s of segs) {
      const header = 4 * (s.hy * TEX_W + s.hx);
      // Subpath-start is a packed flag, not a quantity. Matched rows keep the
      // source topology: interpolating a difference of 8 sets fill-only (bit 2)
      // at intermediate poses and incorrectly removes the segment's stroke.
      if (((merged[header] | 0) ^ (dstRemapped[header] | 0)) === 8)
        dstRemapped[header] = merged[header];
      if (s.segType !== SEG_ARC_T) continue;
      // Both poses' records for this segment sit at the same float offset —
      // dstRemapped is dst's plane re-laid into src's layout, which is the
      // premise the whole lerp already rests on.
      const off = 4 * (s.hy * TEX_W + s.hx);
      reanchorFullTurnArc(merged, dstRemapped, off, alignFullTurnDirection);
      if (arcRecordMorphable(merged, off) && arcRecordMorphable(dstRemapped, off)) arcs.push(off);
    }
  }
  if (!arcs.length) return empty;

  // The endpoint-form twins differ from the center-form planes only inside arc
  // records, so start from a copy and rewrite just those.
  const srcEp = merged.slice();
  const dstEp = dstRemapped.slice();
  const flips = new Set();
  const flagSteps = chromeFlags ? new Map() : null;
  for (const off of arcs) {
    arcRecordToEndpoint(merged, srcEp, off);
    arcRecordToEndpoint(dstRemapped, dstEp, off);
    if (shortestRotation) spellArcNearest(srcEp, dstEp, off);
    settleHalfTurnLarge(merged, srcEp, off);
    settleHalfTurnLarge(dstRemapped, dstEp, off);
    const from = srcEp[off + 11],
      to = dstEp[off + 11];
    if (spanArcFlags(srcEp, dstEp, off)) {
      flips.add(off);
      if (flagSteps) flagSteps.set(off, [from, to]);
    }
  }
  // A shape holding such an arc is exact at its two ends only from the center-form planes: one end pose does not have the flags of the poses between.
  const endPoseRanges = flips.size
    ? plan.matched
        .filter((m) => arcs.some((off) => flips.has(off) && off >= m.srcBegin && off < m.srcEnd))
        .map((m) => ({ begin: m.srcBegin, end: m.srcEnd }))
    : null;
  return {
    segTables: tables,
    srcEp,
    dstEp,
    arcs: Int32Array.from(arcs),
    endPoseRanges,
    flagSteps: flagSteps && flagSteps.size ? flagSteps : null,
  };
}

/**
 * Chrome's flag at pose t, one bit at a time: the flag lerps as a number and rounds, so it steps at t = 0.5, where 0 and 1 both read 1 (createShapeMorph
 * compat: 'chrome'). The default is the spec's, spanArcFlags. `steps` maps an arc's offset to its two poses' packed flags.
 */
export function applyArcFlagSteps(plane, steps, t) {
  if (!steps) return;
  for (const [off, [from, to]] of steps)
    plane[off + 11] = t < 0.5 ? from : t > 0.5 ? to : from | to;
}

/// Write the center-form end pose over each range of `plane`, at t = 0 or t = 1 (prepareArcMorph endPoseRanges).
export function restoreArcEndPoses(plane, ranges, t, source, target) {
  if (!ranges || (t !== 0 && t !== 1)) return;
  const from = t === 0 ? source : target;
  for (const r of ranges) plane.set(from.subarray(r.begin, r.end), r.begin);
}

/** Align a full-turn arc's seam to the paired partial arc before interpolation.
 * Stored endpoints and tangents follow the new seam. This preserves the ellipse
 * as a filled region but can shift a dashed stroke's phase.
 * Direction is preserved unless explicitly aligned; reversing a full turn can
 * change dash order and compound-path winding. Both-full pairs are unchanged.
 */
function reanchorFullTurnArc(a, b, off, alignDirection) {
  const full = (buf) =>
    buf[off + 12] === buf[off + 14] &&
    buf[off + 13] === buf[off + 15] &&
    buf[off + 9] !== buf[off + 8];
  const aFull = full(a),
    bFull = full(b);
  if (aFull === bFull) return;
  const f = aFull ? a : b,
    o = aFull ? b : a;
  const cx = f[off + 4],
    cy = f[off + 5],
    rx = f[off + 6],
    ry = f[off + 7],
    phi = f[off + 10];
  if (
    !(rx > 0) ||
    !(ry > 0) ||
    !Number.isFinite(o[off + 12]) ||
    !Number.isFinite(o[off + 13]) ||
    !Number.isFinite(o[off + 8])
  )
    return;
  const cp = Math.cos(phi),
    sp = Math.sin(phi);
  const dx = o[off + 12] - cx,
    dy = o[off + 13] - cy;
  const ang = Math.atan2((-sp * dx + cp * dy) / ry, (cp * dx + sp * dy) / rx);
  const th0 = ang + 2 * Math.PI * Math.round((o[off + 8] - ang) / (2 * Math.PI));
  let dth = f[off + 9] - f[off + 8];
  if (
    alignDirection &&
    Math.sign(dth) !== Math.sign(o[off + 9] - o[off + 8]) &&
    o[off + 9] !== o[off + 8]
  )
    dth = -dth;
  const ct = Math.cos(th0),
    st = Math.sin(th0);
  const px = cx + cp * rx * ct - sp * ry * st,
    py = cy + sp * rx * ct + cp * ry * st;
  f[off + 8] = th0;
  f[off + 9] = th0 + dth;
  f[off + 12] = px;
  f[off + 13] = py;
  f[off + 14] = px;
  f[off + 15] = py;
  // the unit tangent at the new start, along the sweep (texel 4: the end tangent, then the start tangent)
  let tx = cp * (-rx * st) - sp * (ry * ct),
    ty = sp * (-rx * st) + cp * (ry * ct);
  if (dth < 0) {
    tx = -tx;
    ty = -ty;
  }
  const m = Math.hypot(tx, ty);
  if (m > 0) {
    tx /= m;
    ty /= m;
    f[off + 16] = tx;
    f[off + 17] = ty;
    f[off + 18] = tx;
    f[off + 19] = ty;
  }
}

const SEG_ARC_T = 3;
const EMPTY_I32 = new Int32Array(0);

/**
 * Prepare tangent adjacency from authored subpaths and free-end flags.
 * Rows contain join offset/type, previous header/type, next header/type,
 * with offsets in curve-float units and -1 for an absent neighbor.
 * Geometry interpolation changes tangents; adjacency stays fixed.
 */
function buildJoinTable(src, plan, TEX_W, srcEp, segTables, arcSet) {
  const EP = 1e-5;
  const rows = [];
  for (const m of plan.matched) {
    const segs = segTables.get(m.srcIdx);
    if (!segs || segs.length < 1) continue;
    const n = segs.length;
    const offs = new Array(n),
      isArc = new Array(n);
    for (let i = 0; i < n; i++) {
      offs[i] = 4 * (segs[i].hy * TEX_W + segs[i].hx);
      isArc[i] = (segs[i].segType & 3) === SEG_ARC_T && arcSet.has(offs[i]);
    }

    let stroked = false;
    for (let i = 0; i < n; i++) {
      const j = joinSlot(offs[i], segs[i].segType);
      if (srcEp[j] !== 0 || srcEp[j + 1] !== 0 || srcEp[j + 2] !== 0 || srcEp[j + 3] !== 0) {
        stroked = true;
        break;
      }
    }
    if (!stroked) continue;
    // Endpoints, read from the ENDPOINT-form plane — the one place they are exact.
    // Stored path vertices preserve joins without a distance-based weld.
    const sp = new Array(n),
      ep = new Array(n);
    for (let i = 0; i < n; i++) {
      sp[i] = segEndpointFromRecord(srcEp, offs[i], segs[i].segType, true, isArc[i]);
      ep[i] = segEndpointFromRecord(srcEp, offs[i], segs[i].segType, false, isArc[i]);
    }
    const paths = [],
      pathOf = new Array(n),
      position = new Int32Array(n);
    const authored = offs.some((off) => (srcEp[off] | 0) & 8);
    let path;
    for (let i = 0; i < n; i++) {
      const flags = srcEp[offs[i]] | 0;
      if (!path || flags & 8) {
        path = [];
        paths.push(path);
      }
      if (flags & 4) continue;
      position[i] = path.length;
      path.push(i);
      pathOf[i] = path;
    }
    // Authored subpaths determine adjacency, including closed seams. Unmarked
    // legacy records retain endpoint matching, bounded by the known subpath.
    const neighbor = (i, previous) => {
      const off = offs[i];
      if (srcEp[off + (previous ? 1 : 2)] > 0.5 || !pathOf[i]) return -1;
      const chain = pathOf[i],
        k = position[i];
      if (chain.length === 1 && srcEp[off + 1] < 0.5 && srcEp[off + 2] < 0.5) return i;
      if (authored) {
        const j = chain[(k + (previous ? chain.length - 1 : 1)) % chain.length];
        const p = previous ? ep[j] : sp[j],
          q = previous ? sp[i] : ep[i];
        return srcEp[offs[j] + (previous ? 2 : 1)] < 0.5 && p[0] === q[0] && p[1] === q[1] ? j : -1;
      }
      let found = -1;
      for (const j of chain) {
        if (j === i || srcEp[offs[j] + (previous ? 2 : 1)] > 0.5) continue;
        const p = previous ? ep[j] : sp[j],
          q = previous ? sp[i] : ep[i];
        if (Math.abs(p[0] - q[0]) < EP && Math.abs(p[1] - q[1]) < EP) found = j;
      }
      return found;
    };
    for (let i = 0; i < n; i++) {
      const prev = neighbor(i, true),
        next = neighbor(i, false);
      rows.push(
        joinSlot(offs[i], segs[i].segType),
        segs[i].segType,
        prev < 0 ? -1 : offs[prev],
        prev < 0 ? -1 : segs[prev].segType,
        next < 0 ? -1 : offs[next],
        next < 0 ? -1 : segs[next].segType,
      );
    }
  }
  return rows.length ? Int32Array.from(rows) : EMPTY_I32;
}

/** Float offset of a record's JOIN texel. It trails the data texels, and a LINE
 *  carries ONE where quad/cubic/arc carry two. */
function joinSlot(off, segType) {
  const t = segType & 3;
  return off + (t === 0 ? 8 : t === SEG_ARC_T ? 16 : 12); // an arc's endpoints texel precedes its join
}

/** Recompute every stroked segment's join texel from the current (lerped, and
 *  for arcs already center-form) geometry. Runs after arcRecordToCenter. */
export function rebuildJoinTangents(buf, table) {
  for (let i = 0; i < table.length; i += 6) {
    const j = table[i]; // the join texel's float slot
    const pOff = table[i + 2],
      pType = table[i + 3];
    const nOff = table[i + 4],
      nType = table[i + 5];
    if (pOff >= 0) segTangentFromRecord(buf, pOff, pType, false, buf, j);
    else {
      buf[j] = 0;
      buf[j + 1] = 0;
    }
    if (nOff >= 0) segTangentFromRecord(buf, nOff, nType, true, buf, j + 2);
    else {
      buf[j + 2] = 0;
      buf[j + 3] = 0;
    }
  }
}

/** A segment record's start or end point. Mirrors segStart/segEnd. `epArc` says
 *  the record is an ENDPOINT-form arc (p1 at +4, p4 at +6) rather than center form. */
function segEndpointFromRecord(buf, off, segType, atStart, epArc) {
  const t = segType & 3;
  if (t === SEG_ARC_T && !epArc)
    return atStart ? [buf[off + 12], buf[off + 13]] : [buf[off + 14], buf[off + 15]]; // stored
  if (atStart) return [buf[off + 4], buf[off + 5]];
  // An endpoint-form arc keeps p4 where a LINE keeps p2.
  if (t === 0 /* LINE */ || (t === SEG_ARC_T && epArc)) return [buf[off + 6], buf[off + 7]];
  if (t === 1 /* QUAD */) return [buf[off + 8], buf[off + 9]];
  return [buf[off + 10], buf[off + 11]]; // CUBIC
}

/**
Unit tangent of a segment record at its start or end, written to out[o..o+1].
 *  Same derivative conventions (and degenerate fallbacks) as textures.js's
 *  segTangentAt — the numbers have to agree with what the importer would emit.

 */
const _recSpan = (xs, ys) =>
  Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
const _recMag = (vs) => vs.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
function segTangentFromRecord(buf, off, segType, atStart, out, o) {
  const t = segType & 3;
  let dx, dy, round;
  if (t === 0) {
    // LINE
    dx = buf[off + 6] - buf[off + 4];
    dy = buf[off + 7] - buf[off + 5];
    round = _recMag([buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]]);
  } else if (t === 1) {
    // QUAD
    const p1x = buf[off + 4],
      p1y = buf[off + 5];
    const p2x = buf[off + 6],
      p2y = buf[off + 7];
    const p3x = buf[off + 8],
      p3y = buf[off + 9];
    const u = atStart ? 0 : 1,
      mu = 1 - u;
    dx = 2 * mu * (p2x - p1x) + 2 * u * (p3x - p2x);
    dy = 2 * mu * (p2y - p1y) + 2 * u * (p3y - p2y);
    if (!(Math.hypot(dx, dy) > 1e-9 * _recSpan([p1x, p2x, p3x], [p1y, p2y, p3y]))) {
      dx = p3x - p1x;
      dy = p3y - p1y;
    }
    round = _recMag([p1x, p1y, p2x, p2y, p3x, p3y]);
  } else if (t === 2) {
    // CUBIC
    const p1x = buf[off + 4],
      p1y = buf[off + 5];
    const p2x = buf[off + 6],
      p2y = buf[off + 7];
    const p3x = buf[off + 8],
      p3y = buf[off + 9];
    const p4x = buf[off + 10],
      p4y = buf[off + 11];
    const u = atStart ? 0 : 1,
      mu = 1 - u;
    dx = 3 * mu * mu * (p2x - p1x) + 6 * mu * u * (p3x - p2x) + 3 * u * u * (p4x - p3x);
    dy = 3 * mu * mu * (p2y - p1y) + 6 * mu * u * (p3y - p2y) + 3 * u * u * (p4y - p3y);
    const span = 1e-9 * _recSpan([p1x, p2x, p3x, p4x], [p1y, p2y, p3y, p4y]);
    if (!(Math.hypot(dx, dy) > span)) {
      dx = p3x - p2x;
      dy = p3y - p2y;
      if (!(Math.hypot(dx, dy) > span)) {
        dx = p4x - p1x;
        dy = p4y - p1y;
      }
    }
    round = _recMag([p1x, p1y, p2x, p2y, p3x, p3y, p4x, p4y]);
  } else if (buf[off + 6] === 0 || buf[off + 7] === 0) {
    // a ZERO-RADIUS arc: its chord, as segTangentAt
    dx = buf[off + 14] - buf[off + 12];
    dy = buf[off + 15] - buf[off + 13];
    round = _recMag([buf[off + 4], buf[off + 5]]) + _recMag([buf[off + 6], buf[off + 7]]);
  } else {
    // ARC (center form)
    const rx = buf[off + 6],
      ry = buf[off + 7];
    const th0 = buf[off + 8],
      th1 = buf[off + 9],
      phi = buf[off + 10];
    const th = atStart ? th0 : th1,
      dth = th1 - th0;
    const cp = Math.cos(phi),
      sp = Math.sin(phi);
    const ct = Math.cos(th),
      st = Math.sin(th);
    dx = (-cp * rx * st - sp * ry * ct) * dth;
    dy = (-sp * rx * st + cp * ry * ct) * dth;
    round = _recMag([buf[off + 4], buf[off + 5]]) + _recMag([rx, ry]);
  }
  const mag = Math.hypot(dx, dy);
  if (!(mag > 64 * Number.EPSILON * round)) {
    out[o] = 0;
    out[o + 1] = 0;
    return;
  }
  out[o] = dx / mag;
  out[o + 1] = dy / mag;
}

/** Endpoint interpolation requires a nonempty sweep shorter than a full turn.
 * Zero radii are valid: a flat endpoint can interpolate into an ellipse.
 * Other records retain center-form interpolation.
 */
function arcRecordMorphable(buf, off) {
  const rx = buf[off + 6],
    ry = buf[off + 7];
  const dth = buf[off + 9] - buf[off + 8];
  return (
    Number.isFinite(rx) &&
    Number.isFinite(ry) &&
    Number.isFinite(dth) &&
    dth !== 0 &&
    Math.abs(dth) < 2 * Math.PI - 1e-6
  );
}

/**
 * Write the endpoint form of the arc at float `off` in `center` into `out`.
 *
 * Record layout (floats, from the header texel):
 *   [0..3]   header (segType, freeStart, freeEnd, startDist)  — copied as-is
 *   [4..7]   CENTER (cx, cy, rx, ry)        ENDPOINT (p1x, p1y, p4x, p4y)
 *   [8..11]  CENTER (thetaS, thetaE, phi,_) ENDPOINT (rx, ry, phi, flags)
 *   [12..15] the arc's endpoints — left alone: they lerp as the
 *            neighbors' stored vertices lerp, so a shared vertex stays shared.
 *   [16..19] join tangents — left alone; the geometry is unchanged, so the
 *            endpoint tangents it holds are still the right ones.
 * `flags` packs large_arc | sweep<<1, and spanArcFlags gives both poses one value, so lerping it is a no-op.
 */
export function arcRecordFlags(center, off) {
  const dth = center[off + 9] - center[off + 8];
  const large =
    Math.abs(Math.abs(dth) - Math.PI) < HALF_TURN_TOL
      ? center[off + 11] < 0
      : Math.abs(dth) > Math.PI;
  return (large ? 1 : 0) | (dth > 0 ? 2 : 0);
}

function arcRecordToEndpoint(center, out, off) {
  const cx = center[off + 4],
    cy = center[off + 5];
  // the AUTHORED radii: the record holds them scaled up by F.6.6's factor (center[off + 11], 0 = none). SVG path animation
  // interpolates the authored numbers and normalizes at each pose (arcRecordToCenter does), so the lerp must start from them
  const rs = Math.abs(center[off + 11]) > 1 ? Math.abs(center[off + 11]) : 1;
  const rx = center[off + 6] / rs,
    ry = center[off + 7] / rs;
  const th0 = center[off + 8],
    th1 = center[off + 9],
    phi = center[off + 10];
  const dth = th1 - th0;
  // the endpoints are the record's stored vertices: the path's own points, which the neighbors store --
  // exact, where rebuilding them from the center form put two arcs sharing a corner up to ~2e-4 apart
  const p1 = [center[off + 12], center[off + 13]],
    p4 = [center[off + 14], center[off + 15]];
  const large = Math.abs(dth) > Math.PI ? 1 : 0;
  const sweep = dth > 0 ? 1 : 0;
  out[off + 4] = p1[0];
  out[off + 5] = p1[1];
  out[off + 6] = p4[0];
  out[off + 7] = p4[1];
  out[off + 8] = rx;
  out[off + 9] = ry;
  out[off + 10] = phi;
  out[off + 11] = large | (sweep << 1);
}

/**
 * SVG 2, 9.3.2: "Flags and booleans must be interpolated as fractions between zero and one, with any non-zero value considered to be a value of
 * one/true." So a flag that differs between the poses is 1 at every pose between them, each flag for itself, and only the end whose own flag is 0 has 0:
 * large 1 sweep 0 to large 0 sweep 1 draws large 1 sweep 1, which neither pose has. The arc steps just inside that end. Writing the one value to both planes
 * makes the lerp a no-op on it; the two ends come from the center-form planes (prepareArcMorph endPoseRanges). Returns whether the poses differ.
 */
function spanArcFlags(srcEp, dstEp, off) {
  const sF = srcEp[off + 11],
    dF = dstEp[off + 11];
  if (sF === dF) return false;
  srcEp[off + 11] = dstEp[off + 11] = sF | dF;
  return true;
}

/**
 * arcRotation: 'shortest' (the default is the numbers, SVG 2, 9.3.2). Spell the destination's ellipse the nearest way to the source's, so a pose written with a running
 * angle does not spin: an ellipse is itself under rotation + 180, and under rotation + 90 with its radii swapped. Endpoint form has no angle on the ellipse to correct.
 */
function spellArcNearest(srcEp, dstEp, off) {
  const sRx = srcEp[off + 8],
    sRy = srcEp[off + 9],
    sPhi = srcEp[off + 10];
  const rx = dstEp[off + 8],
    ry = dstEp[off + 9],
    phi = dstEp[off + 10];
  let best = null;
  for (const swap of [0, 1]) {
    const dRx = swap ? ry : rx,
      dRy = swap ? rx : ry;
    let p = phi + (swap ? Math.PI / 2 : 0);
    p -= Math.PI * Math.round((p - sPhi) / Math.PI);
    const cost =
      Math.abs(p - sPhi) * (Math.abs(sRx) + Math.abs(sRy)) +
      Math.abs(dRx - sRx) +
      Math.abs(dRy - sRy);
    if (!best || cost < best.cost) best = { cost, rx: dRx, ry: dRy, phi: p };
  }
  dstEp[off + 8] = best.rx;
  dstEp[off + 9] = best.ry;
  dstEp[off + 10] = best.phi;
}

/**
 * A half turn has no large-arc flag to read back from its angles. A center-form record stores a sweep, and the authored flag survives only as
 * that sweep over or under pi, but at pi both flags name the same arc: a semicircle, and any arc whose radii F.6.6 scaled up. The float32 angles
 * come out either side of pi by rounding, and as soon as the lerp shortens the chord that bit picks the arc: a shallow cap would draw as the
 * big complement of its circle. The importer marks a half turn authored large (the sign of the record's w, svg/textures.js); this reads it.
 * An angle is scale-free; the bar is some float32 steps at 2 pi, the importer's.
 */
const HALF_TURN_TOL = 4e-6;
function settleHalfTurnLarge(center, ep, off) {
  if (Math.abs(Math.abs(center[off + 9] - center[off + 8]) - Math.PI) < HALF_TURN_TOL)
    ep[off + 11] = (ep[off + 11] & 2) | (center[off + 11] < 0 ? 1 : 0);
}

/**
 * The inverse, applied per frame by setT: read the LERPED endpoint-form record
 * at `off` and write the center-form record the shader reads. Exact — this is
 * SVG's own endpoint→center conversion (F.6.5), radii-correction and all.
 */
export function arcRecordToCenter(buf, off) {
  const p1x = buf[off + 4],
    p1y = buf[off + 5];
  const p4x = buf[off + 6],
    p4y = buf[off + 7];
  let rx = Math.abs(buf[off + 8]),
    ry = Math.abs(buf[off + 9]);
  const phi = buf[off + 10];
  // Round, don't truncate: the flags are constant across the lerp (spanArcFlags), so this only has to survive
  // float32 round-off, but a bit that drifts a hair low would silently select a different arc.
  const flags = Math.round(buf[off + 11]) | 0;
  const large = flags & 1,
    sweep = (flags >> 1) & 1;

  const cp = Math.cos(phi),
    sp = Math.sin(phi);
  const mx = (p1x - p4x) * 0.5,
    my = (p1y - p4y) * 0.5;
  const x1p = cp * mx + sp * my;
  const y1p = -sp * mx + cp * my;
  if (rx === 0 || ry === 0) {
    const dx = p4x - p1x,
      dy = p4y - p1y;
    const chord = Math.hypot(dx, dy);
    let cx = p1x,
      cy = p1y,
      outPhi = phi,
      th0 = 0;
    if (chord > 0) {
      cx = (p1x + p4x) * 0.5;
      cy = (p1y + p4y) * 0.5;
      const angle = Math.atan2(dy, dx),
        r = chord * 0.5;
      if (ry === 0) {
        rx = r;
        ry = 0;
        outPhi = angle;
        th0 = Math.PI;
      } else {
        rx = 0;
        ry = r;
        outPhi = angle - Math.PI * 0.5;
        th0 = -Math.PI * 0.5;
      }
    } else {
      rx = 0;
      ry = 0;
    }
    const dth = sweep ? Math.PI : -Math.PI;
    buf[off + 4] = cx;
    buf[off + 5] = cy;
    buf[off + 6] = rx;
    buf[off + 7] = ry;
    buf[off + 8] = th0;
    buf[off + 9] = th0 + dth;
    buf[off + 10] = outPhi;
    buf[off + 11] = 0;
    return;
  }
  // SVG f.6.6: scale the radii up if they can't span the chord. Mid-lerp the
  // endpoints move independently of the radii, so this genuinely fires — and it
  // is exactly the right answer when it does.
  const lam = (x1p / rx) ** 2 + (y1p / ry) ** 2;
  if (lam > 1) {
    const s = Math.sqrt(lam);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let sq = den > 0 ? Math.sqrt(Math.max(num / den, 0)) : 0;
  if (large === sweep) sq = -sq;
  const cxp = (sq * rx * y1p) / ry;
  const cyp = (-sq * ry * x1p) / rx;
  const cx = cp * cxp - sp * cyp + (p1x + p4x) * 0.5;
  const cy = sp * cxp + cp * cyp + (p1y + p4y) * 0.5;
  const ang = (ux, uy, vx, vy) => {
    const n = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    if (n === 0) return 0;
    const c = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / n));
    return ux * vy - uy * vx < 0 ? -Math.acos(c) : Math.acos(c);
  };
  const ux = (x1p - cxp) / rx,
    uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx,
    vy = (-y1p - cyp) / ry;
  const th0 = ang(1, 0, ux, uy);
  let dth = ang(ux, uy, vx, vy);
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  if (sweep && dth < 0) dth += 2 * Math.PI;

  buf[off + 4] = cx;
  buf[off + 5] = cy;
  buf[off + 6] = rx;
  buf[off + 7] = ry;
  buf[off + 8] = th0;
  buf[off + 9] = th0 + dth;
  buf[off + 10] = phi;
  buf[off + 11] = 0;
}

function concatBandPlanes(src, dst, plan, TEX_W, arcPrep, merged, dstRemapped) {
  // Each matched-shape band-membership needs to cover both src's and
  // dst's segment positions across the lerp range [0, 1]: bands are
  // computed from per-segment bboxes, and curves lerp from src→dst
  // over t. Forwarding src's bands verbatim makes the per-pixel walker
  // visit the wrong segments at t>0 — visible as cover-quad fragmentation.
  //
  // So rebuild each matched shape's band region as a single-band
  // layout (bandMaxX = bandMaxY = 0) whose H and V bands each list
  // every segment of the shape. This is the union-coverage fallback —
  // wider than a tight tiered layout but correct for any t. Per-pixel
  // walk cost rises from O(N/√bands) to O(N) for matched shapes; for
  // animation-typical low-segment-count shapes (Flash MorphShape2 ~16
  // segs per pose) this is fine. The bandMax field on meta texel 4 is
  // also rewritten so the shader walks band 0 only.
  //
  // Src-only / dst-only shapes keep their original band layouts —
  // they're not lerped, they fade via visibility.
  const srcBand = src.bandFloats || (src.bands ? new Float32Array(src.bands) : null);
  if (!srcBand || !srcBand.length) {
    if (src.bands && src.bands.byteLength) return { buf: src.bands.slice(0), matchedRewrites: [] };
    return { buf: new ArrayBuffer(16), matchedRewrites: [] };
  }
  // Build a new band plane: keep src's full buffer (preserves src-only
  // and dst-only band regions) and APPEND new collapsed regions for
  // matched shapes, rewriting their meta glyphLoc/bandMax.
  if (!plan.matched.length) {
    return {
      buf: srcBand.buffer.slice(srcBand.byteOffset, srcBand.byteOffset + srcBand.byteLength),
      matchedRewrites: [],
    };
  }

  const stride = src.metaFloatsPerShape || 48;
  const srcMeta = src.metaFloats;
  const dstMeta = dst.metaFloats;
  // Read both poses out of the composed planes, not the original bundles: the
  // arc→cubic rewrite (cubicizeMatchedArcs) landed there, so the bundles' own
  // curve data — and the segment types recorded in their bands — are stale for
  // any matched shape. `dstRemapped` already carries dst's curves at src's
  // offsets, which is also why one segment table indexes both.
  if (!merged || !dstRemapped) {
    // No curve buffer to decode — fall back to forwarding src verbatim
    // (will still fragment at t>0).
    return {
      buf: srcBand.buffer.slice(srcBand.byteOffset, srcBand.byteOffset + srcBand.byteLength),
      matchedRewrites: [],
    };
  }
  const segTables = arcPrep && arcPrep.segTables;
  // Arcs the morph carries in ENDPOINT form (prepareArcMorph). Their bounds must
  // be read from the endpoint planes, with the endpoint rule — the center-form
  // planes hold no lerpable center for these.
  const epArcs = new Set(arcPrep && arcPrep.arcs ? arcPrep.arcs : []);
  const srcEp = (arcPrep && arcPrep.srcEp) || merged;
  const dstEp = (arcPrep && arcPrep.dstEp) || dstRemapped;

  const matchedRewrites = [];
  for (const m of plan.matched) {
    const dBase = m.dstIdx * stride;
    const dGx = dstMeta[dBase + META_TEXEL_4] | 0;
    const dGy = dstMeta[dBase + META_TEXEL_4 + 1] | 0;
    const dBandsX = (dstMeta[dBase + META_TEXEL_4 + 2] | 0) + 1;
    const dBandsY = (dstMeta[dBase + META_TEXEL_4 + 3] | 0) + 1;
    const dGlyph = dGy * TEX_W + dGx;
    const srcSegs = segTables && segTables.get(m.srcIdx);
    if (!srcSegs) continue;
    if (!srcSegs.length && m.dstEnd === m.dstBegin) continue;
    const dstSegs = collectShapeSegs(
      dst.bandFloats || new Float32Array(dst.bands),
      TEX_W,
      dGlyph,
      dBandsY,
      dBandsX,
    );
    // Matched-topology invariant: srcSegs.length === dstSegs.length.
    // (Both bundles emit segments in path order, which is what lets dst's
    // curves sit at src's offsets in the first place.)
    if (srcSegs.length !== dstSegs.length) {
      // Segment counts diverge — can't pair by index; skip the union
      // rewrite and fall through to src-only bands for this shape.
      continue;
    }
    // Stroke pad. The importer widens each segment's break value by the stroke's
    // reach (textures.js bakes strokePadEm into breakAxis) precisely because a
    // segment's INK extends past its control bbox — by half the stroke width for
    // a cap or round join, and by the miter limit for a mitered one. The shader's
    // early-out trusts the break value: a pixel out in the cap wedge, past the
    // seg's control maxX, would otherwise see the walk stop short and the segment
    // skipped. The importer's own note calls it "a notch at one corner of the cap";
    // over a whole outline it reads as round caps and joins turning SQUARE and the
    // halo thinning out. Rebuild the bands without it and every stroked morph loses
    // its corners — which is what happened here.
    const sSw = srcMeta[m.srcIdx * stride + 12];
    const dSw = dstMeta[m.dstIdx * stride + 12];
    const halfW = Math.max(Math.abs(sSw), Math.abs(dSw)) * 0.5;
    const pad = halfW * metaStrokeReachFactor(srcMeta, m.srcIdx * stride); // the importer's pad

    // For each segment: read the control-polygon bbox from both poses at the
    // same offset, union them, and store the per-axis maxes for the descending
    // sort the shader's early-out relies on.
    const segs = [];
    for (const s of srcSegs) {
      const ep = epArcs.has(4 * (s.hy * TEX_W + s.hx));
      const sBbox = readSegBbox(ep ? srcEp : merged, TEX_W, s.hx, s.hy, s.segType, ep);
      const dBbox = readSegBbox(ep ? dstEp : dstRemapped, TEX_W, s.hx, s.hy, s.segType, ep);
      if (ep) widenForScaledRadii(srcEp, dstEp, 4 * (s.hy * TEX_W + s.hx), sBbox, dBbox);
      segs.push({
        hx: s.hx,
        hy: s.hy,
        segType: s.segType,
        // Union per-axis extents over [src, dst] poses, then the stroke's reach.
        maxX: Math.max(sBbox.maxX, dBbox.maxX) + pad,
        maxY: Math.max(sBbox.maxY, dBbox.maxY) + pad,
        minX: Math.min(sBbox.minX, dBbox.minX) - pad,
        minY: Math.min(sBbox.minY, dBbox.minY) - pad,
      });
    }
    matchedRewrites.push({ srcIdx: m.srcIdx, segs });
  }
  // Layout per matched shape:
  //   2 H-band header texels   (counts, arrIdx)
  //   2 V-band header texels   (counts, arrIdx)
  //   N texels of H-band entries (ONE per texel, sorted descending by maxX)
  //   N texels of V-band entries (ONE per texel, sorted descending by maxY)
  // H and V arrays are separate because they sort by different axes;
  // sharing one array would break the descending-sort invariant the
  // shader's early-out relies on.
  let appendTexels = 0;
  const layouts = matchedRewrites.map((r) => {
    const headers = 4;
    const hArr = r.segs.length;
    const vArr = r.segs.length;
    const layout = { ...r, headers, hArr, vArr, glyphLocIdx: 0 };
    appendTexels += headers + hArr + vArr;
    return layout;
  });
  const srcTexCount = srcBand.length / 4;
  const srcTexRounded = roundUpToTex(srcTexCount, TEX_W);
  // PACKED, NOT ROW-ALIGNED (memory): the band walk addresses a shape's header and entries through bLoc/bFetchL, which carry across rows, so a rewritten shape's region needs no row of its own.
  // Starting every region on a fresh 4096-texel row (65,536 bytes each) would give a 5,000-shape morph pair hundreds of MB for a plane that holds about 2 MB of data.
  const totalTex = roundUpToTex(srcTexRounded + appendTexels, TEX_W);
  const out = new Float32Array(totalTex * 4);
  out.set(srcBand);
  // Sort helpers: descending by maxX for H, by maxY for V; within
  // equal extents, segType ascending so the shader's per-type sub-loop
  // dispatch sees contiguous type groups (line→quad→cubic→arc).
  const sortByMaxThenType = (segs, axis) => {
    const k = axis === 'x' ? 'maxX' : 'maxY';
    return segs.slice().sort((a, b) => {
      if (a.segType !== b.segType) return a.segType - b.segType;
      if (a[k] !== b[k]) return b[k] - a[k];
      return 0;
    });
  };
  let cursor = srcTexRounded;
  for (const layout of layouts) {
    layout.glyphLocIdx = cursor;
    const headerBase = cursor;
    const hArrBase = cursor + layout.headers;
    const vArrBase = hArrBase + layout.hArr;
    const counts = [0, 0, 0, 0];
    for (const s of layout.segs) counts[s.segType]++;
    // H band header at slot 0.
    texelWrite(out, TEX_W, headerBase + 0, counts[0], counts[1], counts[2], counts[3]);
    texelWrite(out, TEX_W, headerBase + 1, layout.headers, 0, 0, 0);
    // V band header at slot 1 (bandsY == 1).
    texelWrite(out, TEX_W, headerBase + 2, counts[0], counts[1], counts[2], counts[3]);
    texelWrite(out, TEX_W, headerBase + 3, layout.headers + layout.hArr, 0, 0, 0);
    // Packed entry pairs: (loc0, brk0, loc1, brk1), loc = hy*4096 + hx; an odd tail pads
    // with a sentinel break so a stray walk stops immediately. Type is positional (the
    // sort groups line -> quad -> cubic -> arc, matching the header counts).
    const packEntries = (sorted, key, far, base) => {
      for (let i = 0; i < sorted.length; i++) {
        const s = sorted[i];
        texelWrite(out, TEX_W, base + i, s.hy * TEX_W + s.hx, s[key], s[far], 0);
      }
    };
    packEntries(sortByMaxThenType(layout.segs, 'x'), 'maxX', 'minX', hArrBase);
    packEntries(sortByMaxThenType(layout.segs, 'y'), 'maxY', 'minY', vArrBase);
    cursor = vArrBase + layout.vArr;
  }

  return {
    buf: out.buffer, // `out` is local: no defensive copy (that would be a second full-size plane)
    matchedRewrites: layouts.map((l) => ({
      srcIdx: l.srcIdx,
      glyphLocIdx: l.glyphLocIdx,
    })),
  };
}

function roundUpToTex(texels, TEX_W) {
  return texels % TEX_W === 0 ? texels : texels + (TEX_W - (texels % TEX_W));
}

function bandTexelAt(buf, TEX_W, texIdx) {
  const off = texIdx * 4;
  return [buf[off], buf[off + 1], buf[off + 2], buf[off + 3]];
}

function texelWrite(buf, TEX_W, texIdx, a, b, c, d) {
  const off = texIdx * 4;
  buf[off] = a;
  buf[off + 1] = b;
  buf[off + 2] = c;
  buf[off + 3] = d;
}

/// Walk a shape's H + V band segment lists in bandFloats, collecting
/// every unique segment header position + type. Walking both axes
/// catches segments whose bbox crosses only H or only V (e.g. a
/// degenerate horizontal LINE has height 0 so misses every H band but
/// appears in some V band, and vice versa for a vertical LINE).
/// Returns segments sorted by curveBuf header position — matches the
/// importer's contiguous segment-write order, so two bundles with
/// matched topology yield identical enumeration sequences.
function collectShapeSegs(bandFloats, TEX_W, glyphLocIdx, bandsY, bandsX) {
  const segs = [];
  const seen = new Set();
  const visitBand = (hdrSlot) => {
    const ht = bandTexelAt(bandFloats, TEX_W, glyphLocIdx + hdrSlot);
    const ot = bandTexelAt(bandFloats, TEX_W, glyphLocIdx + hdrSlot + 1);
    const counts = [ht[0] | 0, ht[1] | 0, ht[2] | 0, ht[3] | 0];
    const nTotal = counts[0] + counts[1] + counts[2] + counts[3];
    const arrIdx = ot[0] | 0;
    for (let i = 0; i < nTotal; i++) {
      // ONE entry per texel: (loc, breakAxis, farAxis, _); loc = hy*4096 + hx.
      // This READS a band buffer the encoder wrote, so it moves with
      // svg/textures.js, hitTest/bandWinding.js and the shader's bandEntry.
      const t = bandTexelAt(bandFloats, TEX_W, glyphLocIdx + arrIdx + i);
      const loc = t[0] | 0;
      const hx = loc & 4095,
        hy = loc >> 12;
      if (seen.has(loc)) continue;
      seen.add(loc);
      // segType is positional: the lists are type-grouped, so entry i's type is the
      // count bucket it falls into (line -> quad -> cubic -> arc)
      let segType = 0,
        acc = counts[0];
      while (i >= acc && segType < 3) {
        segType++;
        acc += counts[segType];
      }
      segs.push({ hx, hy, segType });
    }
  };
  // H bands at slots [0 .. bandsY * 2).
  for (let by = 0; by < bandsY; by++) visitBand(by * 2);
  // V bands at slots [bandsY * 2 .. (bandsY + bandsX) * 2).
  for (let bx = 0; bx < bandsX; bx++) visitBand((bandsY + bx) * 2);
  segs.sort((a, b) => a.hy * TEX_W + a.hx - (b.hy * TEX_W + b.hx));
  return segs;
}

/// Read a segment's control-polygon bbox from a curveBuf. Segment
/// layout per encodeSeg:
///   header texel @ (hx, hy):     (segType, freeStart, freeEnd, startDist)
///   data texel(s) @ (hx+1, hy):  type-dependent:
///     LINE  → 1 texel: (p1.x, p1.y, p2.x, p2.y)
///     QUAD  → 2 texels: (p1.x, p1.y, p2.x, p2.y), (p3.x, p3.y, 0, 0)
///     CUBIC → 2 texels: (p1.x, p1.y, p2.x, p2.y), (p3.x, p3.y, p4.x, p4.y)
///     ARC   → 2 texels: (cx, cy, rx, ry), (theta_s, theta_e, phi, 0)
/// Returns control-polygon bbox (looser than curve-tight) — matches
/// the importer's band-membership test in textures.js.
///
/// `epArc` selects how an ARC's two data texels are read. A morph's planes hold
/// arcs in ENDPOINT form — (p1, p4), (rx, ry, phi, flags) — because that is the
/// only exact form a componentwise lerp can carry (see prepareArcMorph); every
/// other caller hands us CENTER form. The two need different bounds, and reading
/// one as the other yields silent nonsense, so the caller must say which it has.
function readSegBbox(curveFloats, TEX_W, hx, hy, segType, epArc = false) {
  const baseTex = hy * TEX_W + hx;
  function ctrl(texOffset, slot) {
    const t = baseTex + texOffset;
    const off = t * 4 + slot;
    return curveFloats[off];
  }
  // Collect control points by type.
  const xs = [],
    ys = [];
  if (segType === 3 && !epArc) {
    // ARC, CENTER form — a static (unlerped) shape.
    // Full-ellipse extent: exact in phi and conservative in theta. Rotation
    // contributes both radii to each axis; understating it can drop crossings.
    const cx = ctrl(1, 0),
      cy = ctrl(1, 1);
    const rx = Math.abs(ctrl(1, 2)),
      ry = Math.abs(ctrl(1, 3));
    const phi = ctrl(2, 2);
    const cp = Math.cos(phi),
      sp = Math.sin(phi);
    const wx = Math.hypot(rx * cp, ry * sp);
    const wy = Math.hypot(rx * sp, ry * cp);
    return { minX: cx - wx, maxX: cx + wx, minY: cy - wy, maxY: cy + wy };
  }
  if (segType === 0) {
    // LINE
    xs.push(ctrl(1, 0), ctrl(1, 2));
    ys.push(ctrl(1, 1), ctrl(1, 3));
  } else if (segType === 1) {
    // QUAD
    xs.push(ctrl(1, 0), ctrl(1, 2), ctrl(2, 0));
    ys.push(ctrl(1, 1), ctrl(1, 3), ctrl(2, 1));
  } else if (segType === 2) {
    // CUBIC
    xs.push(ctrl(1, 0), ctrl(1, 2), ctrl(2, 0), ctrl(2, 2));
    ys.push(ctrl(1, 1), ctrl(1, 3), ctrl(2, 1), ctrl(2, 3));
  } else {
    // ARC, ENDPOINT form — a morphing shape.
    // These numbers become the band break values, and the shader's walker trusts
    // them as descending upper bounds: it stops at the first segment whose max
    // can't reach the pixel. Understate one and the walk stops early, skipping
    // segments that DO cross the pixel's ray; the dropped crossings flip the
    // winding parity and the fill tears. So the box must hold for every t, since
    // the caller unions the two poses' boxes and reuses that for the whole morph.
    //
    // The obvious box — center ± radii — is unusable for that. It is wrong even
    // statically (it assumes phi == 0; a rotated ellipse reaches
    // hypot(rx·cosφ, ry·sinφ) in x), and worse, the arc's CENTER is not a lerped
    // quantity at all: the morph interpolates endpoint form, and the center is
    // re-derived from the lerped endpoints each frame. There is nothing to union.
    //
    // Anchor on what IS lerped. p1 and p4 travel straight (they are stored
    // floats), and rx, ry lerp. Every point of an ellipse lies within
    // R = max(rx, ry) of its center, and the center is itself within R of any
    // point ON the ellipse — so the whole arc lies within 2R of p1, and likewise
    // within 2R of p4:
    //     arc(t) ⊆ box(p1(t), 2R(t)) ∩ box(p4(t), 2R(t))
    // Both p ± 2R are affine in t, so each box's union over t is just the union
    // of its two endpoint boxes — and intersecting the two unions is still sound
    // (⋃(A∩B) ⊆ (⋃A) ∩ (⋃B)). Hence: per pose, emit both boxes; the caller
    // unions across poses; a later intersection tightens it. Looser than a tight
    // fit, but provably safe for every intermediate pose — and per this file's
    // standing trade-off, correctness beats fill rate for animation.
    const p1x = ctrl(1, 0),
      p1y = ctrl(1, 1);
    const p4x = ctrl(1, 2),
      p4y = ctrl(1, 3);
    const r2 = 2 * Math.max(Math.abs(ctrl(2, 0)), Math.abs(ctrl(2, 1)));
    xs.push(p1x - r2, p1x + r2, p4x - r2, p4x + r2);
    ys.push(p1y - r2, p1y + r2, p4y - r2, p4y + r2);
  }
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

/**
 * The 2R box of readSegBbox holds for the radii a pose states. F.6.6 scales radii too small for their chord, by up to (half chord) / (smaller
 * radius), and an eccentric ellipse then reaches far past 2R: authored 8 by 1 across a chord of 10 is 40 by 5, and a break value of 16 stopped
 * the walk short of the arc. At any t the half chord is at most the larger of the two poses' (it is convex in t) and each radius ratio is
 * monotone in t, so half chord x ratio at the two ends bounds the scaled radius for the whole morph. A radius that is zero at one end makes
 * that ratio unbounded, and the arc does swing out unbounded just inside that end, so the walk may not stop for it at all.
 */
const NO_BREAK = 1e30;
function widenForScaledRadii(srcEp, dstEp, off, sBox, dBox) {
  const half = (e) => Math.hypot(e[off + 6] - e[off + 4], e[off + 7] - e[off + 5]) / 2;
  const hi = (e) => Math.max(Math.abs(e[off + 8]), Math.abs(e[off + 9])),
    lo = (e) => Math.min(Math.abs(e[off + 8]), Math.abs(e[off + 9]));
  const h = Math.max(half(srcEp), half(dstEp));
  if (!(h > 0)) return;
  const ratio = Math.max(hi(srcEp) / lo(srcEp), hi(dstEp) / lo(dstEp));
  const scaled = h * ratio; // Infinity for a zero radius, NaN for two
  if (scaled <= Math.max(hi(srcEp), hi(dstEp))) return; // no pose's radii come close: the common case stays as it was
  const reach = Number.isFinite(scaled) ? 2 * scaled : NO_BREAK;
  for (const [e, box] of [
    [srcEp, sBox],
    [dstEp, dBox],
  ])
    for (const [x, y] of [
      [e[off + 4], e[off + 5]],
      [e[off + 6], e[off + 7]],
    ]) {
      box.minX = Math.min(box.minX, x - reach);
      box.maxX = Math.max(box.maxX, x + reach);
      box.minY = Math.min(box.minY, y - reach);
      box.maxY = Math.max(box.maxY, y + reach);
    }
}

/**
 * The box a matched row's arcs sweep over the whole morph, or null when it has none in endpoint form. Unlike a Bezier, a lerped arc can leave
 * the union of its two poses (one radius, a chord that shortens: the large arc stands taller at every pose between), so the static cover
 * quad cropped it. Extent in t is smooth but not closed form: exact boxes at 33 poses, each side carried on past each step by that step's own
 * change, which covers a peak between samples. A radius growing out of zero swings out unbounded just inside that end; that sliver of t stays cropped.
 */
function arcSweepBox(arcPrep, m, pad) {
  if (!arcPrep || !arcPrep.arcs || !arcPrep.arcs.length || !arcPrep.srcEp) return null;
  const row = m.srcIdx,
    curveRanges = [];
  curveRanges[row] = { begin: m.srcBegin, end: m.srcEnd };
  const view = {
    arcOffsets: arcPrep.arcs,
    curveRanges,
    srcEpCurveF32: arcPrep.srcEp,
    dstEpCurveF32: arcPrep.dstEp,
    arcFlagSteps: arcPrep.flagSteps,
  };
  const out = [Infinity, Infinity, -Infinity, -Infinity],
    box = [0, 0, 0, 0],
    prev = [0, 0, 0, 0];
  for (let k = 0; k <= 32; k++) {
    box[0] = box[1] = Infinity;
    box[2] = box[3] = -Infinity;
    if (!unionMorphArcBounds(view, row, k / 32, pad, box)) return null;
    for (let i = 0; i < 4; i++) {
      const step = k ? Math.abs(box[i] - prev[i]) : 0;
      out[i] = i < 2 ? Math.min(out[i], box[i] - step) : Math.max(out[i], box[i] + step);
      prev[i] = box[i];
    }
  }
  return out;
}

function rewriteCurveGeom(src, dst, plan, dstOnlyEntries, dstOnlyGids, arcPrep = null) {
  // Per-shape OBB cover-quad chunks. The cover quad defines which
  // screen pixels the rasterizer walks for that shape; the
  // ray-cast runs per covered pixel against the shape's lerped curves.
  //
  // Forwarding src's chunks verbatim is wrong: when dst's
  // silhouette extends beyond src's OBB (Flash MorphShape2 with wide
  // control-point drift between poses), the lerped silhouette at t>0
  // writes pixels OUTSIDE the src-derived cover quad → those pixels
  // are never walked → visible diagonal cropping on intermediate
  // frames (cover-quad fragmentation).
  //
  // Instead: for each matched shape, rebuild its cover quad as the AABB
  // of (src's chunk verts ∪ dst's chunk verts). The result is an
  // axis-aligned bbox guaranteed to enclose both poses' silhouettes,
  // so any lerped Bezier silhouette in between is also enclosed (an arc's is
  // not: arcSweepBox). Skip the
  // OBB-fit step (cover area is slightly bigger than a tight OBB but
  // correctness trumps fill rate for animations). Unmatched chunks
  // pass through.
  const srcF32 = src.coverQuadFloats || (src.curveGeom ? new Float32Array(src.curveGeom) : null);
  const dstF32 = dst.coverQuadFloats || (dst.curveGeom ? new Float32Array(dst.curveGeom) : null);
  if ((!srcF32 || !srcF32.length) && (!dstF32 || !dstF32.length)) return null;
  if (!dstF32 || !dstF32.length) {
    return srcF32.buffer.slice(srcF32.byteOffset, srcF32.byteOffset + srcF32.byteLength);
  }

  // Decode chunks: each starts with a 12-float header (n, gid, r, g,
  // b, aFlag, _, _, _, _, marker, _), followed by n × 12 vertex floats.
  function chunksOf(f32) {
    const out = [];
    let i = 0;
    while (i + 12 <= f32.length) {
      const n = Math.floor(f32[i] + 0.5);
      if (n <= 0 || i + 12 + n * 12 > f32.length) break;
      out.push({ headerOff: i, vertsOff: i + 12, n, gid: Math.floor(f32[i + 1] + 0.5) });
      i += 12 * (n + 1);
    }
    return out;
  }
  const srcChunks = chunksOf(srcF32 || new Float32Array(0));
  const dstChunks = chunksOf(dstF32);
  const dstChunkByGid = new Map();
  for (const c of dstChunks) dstChunkByGid.set(c.gid, c);
  // Pair each matched SRC chunk to its DST chunk via the PLAN, not via a
  // shared gid. Same-bundle sprite morphs (poseA→poseB in one sheet) have
  // DIFFERENT gids per sprite, and poseA's own gid still exists in dst (===
  // src) — so `dstByGid.get(srcGid)` would wrongly pair poseA with itself,
  // unioning the cover quad to poseA's extent only and clipping poseB's
  // silhouette at t→1 (the shape vanishes). Map by matched pair instead:
  // srcGid → the dst shape's chunk. Falls back to gid identity for whole-
  // bundle morphs where src/dst gids coincide.
  const stride = src.metaFloatsPerShape || 48;
  const gidOf = (bundle, shapeIdx) => Math.floor(bundle.metaFloats[shapeIdx * stride + 14] + 0.5);
  const srcGidToDstChunk = new Map(); // matched src gid → dst chunk
  const matchedSrcGids = new Set();
  const matchOfGid = new Map(); // matched src gid → the matched pair, for its arcs
  for (const m of plan.matched) {
    const sGid = gidOf(src, m.srcIdx);
    const dGid = gidOf(dst, m.dstIdx);
    matchedSrcGids.add(sGid);
    matchOfGid.set(sGid, m);
    const dc = dstChunkByGid.get(dGid);
    if (dc) srcGidToDstChunk.set(sGid, dc);
  }

  // Build output by streaming through src's chunks. For each chunk
  // whose gid is in matchedSrcGids, replace its verts with a fresh
  // 6-vertex AABB cover quad enclosing src∪dst vert extents. For
  // others, copy verbatim.
  const outFloats = [];
  for (const c of srcChunks) {
    const dstChunk = srcGidToDstChunk.get(c.gid);
    if (dstChunk && matchedSrcGids.has(c.gid)) {
      // Union AABB across src verts + dst verts.
      let xL = Infinity,
        yT = Infinity,
        xR = -Infinity,
        yB = -Infinity;
      for (let v = 0; v < c.n; v++) {
        const px = srcF32[c.vertsOff + v * 12 + 0];
        const py = srcF32[c.vertsOff + v * 12 + 1];
        if (px < xL) xL = px;
        if (px > xR) xR = px;
        if (py < yT) yT = py;
        if (py > yB) yB = py;
      }
      for (let v = 0; v < dstChunk.n; v++) {
        const px = dstF32[dstChunk.vertsOff + v * 12 + 0];
        const py = dstF32[dstChunk.vertsOff + v * 12 + 1];
        if (px < xL) xL = px;
        if (px > xR) xR = px;
        if (py < yT) yT = py;
        if (py > yB) yB = py;
      }
      const m = matchOfGid.get(c.gid);
      const halfW =
        Math.max(
          Math.abs(src.metaFloats[m.srcIdx * stride + 12]),
          Math.abs(dst.metaFloats[m.dstIdx * stride + 12]),
        ) * 0.5;
      const swept = arcSweepBox(
        arcPrep,
        m,
        halfW * metaStrokeReachFactor(src.metaFloats, m.srcIdx * stride),
      );
      if (swept) {
        xL = Math.min(xL, swept[0]);
        yT = Math.min(yT, swept[1]);
        xR = Math.max(xR, swept[2]);
        yB = Math.max(yB, swept[3]);
      }
      // Emit header with n=6 (one AABB = 2 triangles = 6 verts) and
      // the original header's gid + color + marker fields.
      outFloats.push(6);
      for (let k = 1; k < 12; k++) outFloats.push(srcF32[c.headerOff + k]);
      // 6 AABB verts in the same order as getCoverQuadMesh's AABB
      // fallback: (tl, tr, br, tl, br, bl) with AABB bisector normals
      // (±1, ±1) per corner. Kind=1 (cover), zone=-1 (hull).
      const verts = [
        [xL, yT],
        [xR, yT],
        [xR, yB],
        [xL, yT],
        [xR, yB],
        [xL, yB],
      ];
      const normals = [
        [-1, -1],
        [+1, -1],
        [+1, +1],
        [-1, -1],
        [+1, +1],
        [-1, +1],
      ];
      for (let i = 0; i < 6; i++) {
        outFloats.push(
          verts[i][0],
          verts[i][1],
          normals[i][0],
          normals[i][1],
          0,
          0,
          0,
          0,
          0,
          0,
          1,
          -1,
        );
      }
    } else {
      // Pass-through: copy header + verts.
      for (let k = 0; k < 12 + c.n * 12; k++) {
        outFloats.push(srcF32[c.headerOff + k]);
      }
    }
  }
  // Append each dst-only shape's cover-quad chunk from dst, copied verbatim
  // (the chunk verts are em-space, no remap needed) but with its gid stamped
  // to the fresh dst-only gid so buildGidToShapeIdx resolves it to the
  // dst-only shape's merged index. Without this the dst-only shape has no
  // chunk → buildDrawList emits no op → it never renders.
  if (dstOnlyEntries && dstOnlyEntries.length) {
    const dstByGid = new Map();
    for (const c of dstChunks) dstByGid.set(c.gid, c);
    for (let k = 0; k < dstOnlyEntries.length; k++) {
      const origGid = gidOf(dst, dstOnlyEntries[k].dstIdx);
      const c = dstByGid.get(origGid);
      if (!c) continue;
      const newGid = dstOnlyGids[k];
      // Header: copy 12 floats, overwrite gid slot (float 1) with newGid.
      outFloats.push(dstF32[c.headerOff + 0], newGid);
      for (let kk = 2; kk < 12; kk++) outFloats.push(dstF32[c.headerOff + kk]);
      // Verts verbatim.
      for (let v = 0; v < c.n * 12; v++) outFloats.push(dstF32[c.vertsOff + v]);
    }
  }
  return new Float32Array(outFloats).buffer;
}

// ---- Visibility ----------------------------------------------------

function resetVisibility(overrides, plan, t) {
  // Use update() so external animation drivers (SVG SMIL, Lottie)
  // pushing fill/stroke/strokeWidth via the same override table keep
  // their values across morph.setT() calls.
  // matched shapes: full visibility (the curve lerp owns the morph)
  for (const m of plan.matched) {
    overrides.update(m.srcIdx, { visibility: 1 });
  }
  // src-only: visible at t=0, fade out as t→1
  for (const s of plan.srcOnly) {
    overrides.update(s.srcIdx, {
      visibility: plan.endpointSourceHidden && plan.endpointSourceHidden.has(s.srcIdx) ? 0 : 1 - t,
    });
  }
  // dst-only: invisible at t=0, fade in as t→1. They live at appended
  // indices after src's shape range.
  const baseDstOnlyIdx = (plan.finalShapeCount ?? overrides.numShapes) - plan.dstOnly.length;
  for (let k = 0; k < plan.dstOnly.length; k++) {
    overrides.update(baseDstOnlyIdx + k, {
      visibility:
        plan.endpointDestinationHidden && plan.endpointDestinationHidden.has(plan.dstOnly[k].dstIdx)
          ? 0
          : t,
    });
  }
  if (plan.endpointVisibilityPairs)
    for (const [row, a, b] of plan.endpointVisibilityPairs) {
      overrides.update(row, { visibility: a + (b - a) * t });
    }
  // Non-sprite shapes (sprite-morph only): permanently hidden so the morph
  // bundle renders just the sprite, even though it carries the whole src
  // plane. t-independent.
  if (plan.hidden) {
    for (const idx of plan.hidden) overrides.update(idx, { visibility: 0 });
  }
}

// Per-setT visibility: write only the t-dependent rows. Matched (visibility 1)
// and hidden (visibility 0) are t-independent and already set by the
// construction-time resetVisibility() — re-asserting them every frame would
// dirty every matched row and defeat the override table's dirty-row upload
// band (a fully-matched morph then costs ZERO per-frame override writes).
function updateVisibility(overrides, plan, t) {
  if (plan.endpointVisibilityPairs)
    for (const [row, a, b] of plan.endpointVisibilityPairs) {
      if (a !== b) overrides.update(row, { visibility: a + (b - a) * t });
    }
  // src-only: visible at t=0, fade out as t→1
  for (const s of plan.srcOnly) {
    if (!plan.endpointSourceHidden || !plan.endpointSourceHidden.has(s.srcIdx))
      overrides.update(s.srcIdx, { visibility: 1 - t });
  }
  // dst-only: invisible at t=0, fade in as t→1 (appended after src's range).
  const baseDstOnlyIdx = (plan.finalShapeCount ?? overrides.numShapes) - plan.dstOnly.length;
  for (let k = 0; k < plan.dstOnly.length; k++) {
    if (
      !plan.endpointDestinationHidden ||
      !plan.endpointDestinationHidden.has(plan.dstOnly[k].dstIdx)
    )
      overrides.update(baseDstOnlyIdx + k, { visibility: t });
  }
}

// Public (within-library) surface.
export {
  resolveSpriteRange,
  buildMorphPlan,
  curveRangesByShape,
  composeMorphSections,
  extractCurveFloats,
  resolveLastShapeEnd,
  resetVisibility,
  updateVisibility,
};

// ── Timeline bracket + easing (gl-free) — used by createShapeTimeline /
// createSpriteTimeline AND the native fallback timeline. Pure.
function timelineBracketAt(keys, time) {
  if (time <= keys[0].time) return { iLo: 0, iHi: 0, localT: 0 };
  const last = keys.length - 1;
  if (time >= keys[last].time) return { iLo: last, iHi: last, localT: 1 };
  let lo = 0,
    hi = last;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].time <= time) lo = mid;
    else hi = mid;
  }
  const dt = keys[hi].time - keys[lo].time;
  const localT = dt > 0 ? (time - keys[lo].time) / dt : 0;
  return { iLo: lo, iHi: hi, localT };
}

function timelineEase(loKey, localT) {
  const kind = loKey && loKey.interp;
  if (!kind || kind === 'linear') return localT;
  if (kind === 'hold') return 0;
  if (kind === 'cubicBezier') {
    // The x controls are clamped to [0, 1], as CSS and Lottie require: outside it x(t) is not monotone and the curve is
    // not a function of time. The y controls may overshoot.
    const unit = (x) => {
      x = +x;
      return x > 1 ? 1 : x > 0 ? x : 0;
    };
    const outX = loKey.outX !== undefined ? unit(loKey.outX) : 0;
    const outY = loKey.outY !== undefined ? loKey.outY : 0;
    const inX = loKey.inX !== undefined ? unit(loKey.inX) : 1;
    const inY = loKey.inY !== undefined ? loKey.inY : 1;
    return cubicBezier1D(outX, outY, inX, inY, localT);
  }
  return localT;
}

function cubicBezier1D(outX, outY, inX, inY, u) {
  // Bezier(0, outX, inX, 1)(t) = 3(1-t)²t·outX + 3(1-t)t²·inX + t³.
  // Derivative: 3(1-t)²·outX + 6(1-t)t·(inX-outX) + 3t²·(1-inX).
  function bx(t) {
    const omt = 1 - t;
    return 3 * omt * omt * t * outX + 3 * omt * t * t * inX + t * t * t;
  }
  function dbx(t) {
    const omt = 1 - t;
    return 3 * omt * omt * outX + 6 * omt * t * (inX - outX) + 3 * t * t * (1 - inX);
  }
  function by(t) {
    const omt = 1 - t;
    return 3 * omt * omt * t * outY + 3 * omt * t * t * inY + t * t * t;
  }
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  // Newton seeded from u (works well for near-linear curves).
  let t = u;
  for (let i = 0; i < 6; i++) {
    const x = bx(t) - u;
    if (Math.abs(x) < 1e-6) return by(t);
    const d = dbx(t);
    if (Math.abs(d) < 1e-9) break;
    t = t - x / d;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  // Bisection fallback.
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) * 0.5;
    if (bx(mid) < u) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) * 0.5);
}

export { timelineBracketAt, timelineEase };

// Rebuild endpoint-form arc parameters when a driven morph changes its source pose.
export { prepareArcMorph as prepareDrivenArcMorph };

/// A morph does not move hit-only shapes (they stay at their authored place, the source's until t = 0.5 and the destination's after):
/// say so once per table rather than let a hit land on a region that is not where the pose is.
function warnedHitOnly(ho, side) {
  warnHitOnlyStatic(
    ho,
    'createShapeMorph',
    `A morph does not move the hit-only shapes of ${side} bundle.`,
  );
  return ho;
}
