// morphCore.js — the gl-free heart of the shape/sprite morph.
//
// Holds the plan-building + curve/band/gradient lerp machinery, kept off
// the GL path so the no-WebGL fallback's native morph can reuse it without
// importing createBundle / createOverrideTable. shapeMorph.js keeps the gl
// entry points (createShapeMorph / createSpriteMorph / _buildMorph).
//
// Pure: no GL, no side effects — tree-shakes into either build.

import { mantleWarn } from './diagnostics.js';

const META_TEXEL_4 = 16;   // float offset of texel 4 within a meta row
                           // (glyphLoc.x, glyphLoc.y, ...)

function resolveSpriteRange(bundle, sprite, side) {
  if (Array.isArray(sprite) && sprite.length === 2) return [sprite[0] | 0, sprite[1] | 0];
  if (typeof sprite !== 'string')
    throw new Error('createSpriteMorph: ' + side + '.sprite must be a string id or [first,last]');
  const ranges = bundle && bundle.spriteRanges;
  const r = ranges && ranges[sprite];
  if (!r) {
    throw new Error('createSpriteMorph: unknown ' + side + ' sprite "' + sprite
      + '". Available: ' + (ranges ? (Object.keys(ranges).join(', ') || '(none)') : '(no spriteRanges)'));
  }
  const nc = bundle.spriteRangesNonContiguous;
  if (nc && nc.indexOf(sprite) >= 0) {
    mantleWarn('[Mantle] createSpriteMorph: ' + side + ' sprite "' + sprite
      + '" has a non-contiguous shape range; interleaved foreign shapes will '
      + 'be morphed too.');
  }
  return [r[0], r[1]];
}

function buildMorphPlan(src, dst, srcRange, dstRange) {
  const srcIds = src.shapeIds || new Array(src.numShapes).fill('');
  const dstIds = dst.shapeIds || new Array(dst.numShapes).fill('');
  // Sprite ranges (inclusive shape-index bounds); null = whole bundle.
  // The morph bundle keeps the WHOLE src plane (indices stay absolute), so
  // these only SCOPE which shapes get matched/faded; out-of-range src shapes
  // are collected into `hidden` and forced invisible (see end of fn).
  const srcLo = srcRange ? srcRange[0] : 0;
  const srcHi = srcRange ? srcRange[1] : (src.numShapes - 1);
  const dstLo = dstRange ? dstRange[0] : 0;
  const dstHi = dstRange ? dstRange[1] : (dst.numShapes - 1);
  // Prefer the bundle's pre-computed `curveRangesByShape` — it uses
  // the UNPADDED curve float count for the last shape's end so we
  // match by exact per-shape float count regardless of how the GL
  // curve plane was row-padded. Hand-rolled test bundles that bypass
  // createBundle fall back to the inline derivation, which resolves
  // the last shape via curveTexels.length (correct when curveTexels
  // is unpadded; the hand-built test fixtures pass this in
  // intentionally to exercise both code paths).
  const srcRanges = src.curveRangesByShape || curveRangesByShape(src);
  const dstRanges = dst.curveRangesByShape || curveRangesByShape(dst);
  resolveLastShapeEnd(srcRanges, extractCurveFloats(src).length);
  resolveLastShapeEnd(dstRanges, extractCurveFloats(dst).length);

  const usedDst = new Uint8Array(dst.numShapes);
  const usedSrc = new Uint8Array(src.numShapes);   // sprite-mode positional pass
  const matched = [];
  const srcOnly = [];
  const isSprite = !!srcRange;   // sprite morph → positional fallback ignores synthetic ids

  // First pass — name-based matching for non-empty ids.
  // Build a name → index map on dst, SCOPED to the dst range so a sprite
  // morph (esp. src === dst) matches across the two ranges, never a shape
  // against itself.
  const dstByName = new Map();
  for (let j = dstLo; j <= dstHi; j++) {
    const id = dstIds[j];
    if (id && !dstByName.has(id)) dstByName.set(id, j);
  }
  for (let i = srcLo; i <= srcHi; i++) {
    const id = srcIds[i];
    if (!id) continue;  // empty id → handled in positional pass below
    // Sprite mode: synthetic ids ("shape_N_fill") are position-derived
    // noise that differs between sprites — DON'T treat a missing name match
    // as src-only here; leave the shape for the positional pass. Only a
    // genuine cross-sprite id match (author named both parts the same)
    // should match by name. We detect "real" by: the same id also exists
    // in the dst range. If it doesn't, defer to positional.
    const j = dstByName.get(id);
    if (j == null) { if (isSprite) continue; srcOnly.push({ srcIdx: i }); continue; }
    if (usedDst[j]) {
      if (isSprite) continue;
      srcOnly.push({ srcIdx: i });
      continue;
    }
    const sR = srcRanges[i], dR = dstRanges[j];
    // Matched requires equal curve byte count. Mismatched lengths
    // can't be per-element lerped — fall back to alpha fade for that
    // pair (src fades out, dst fades in).
    if ((sR.end - sR.begin) === (dR.end - dR.begin)) {
      matched.push({
        srcIdx: i, dstIdx: j,
        srcBegin: sR.begin, srcEnd: sR.end,
        dstBegin: dR.begin, dstEnd: dR.end,
      });
      usedDst[j] = 1; usedSrc[i] = 1;
    } else {
      // Topology divergence within a matched name → both sides
      // crossfade through visibility. Append the dst version as a
      // dst-only later (we don't mark usedDst so it falls into the
      // dst-only pass).
      if (isSprite) continue;   // defer to positional pass
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
    if (posJ > dstHi) { srcOnly.push({ srcIdx: i }); continue; }
    const sR = srcRanges[i], dR = dstRanges[posJ];
    if ((sR.end - sR.begin) === (dR.end - dR.begin)) {
      matched.push({
        srcIdx: i, dstIdx: posJ,
        srcBegin: sR.begin, srcEnd: sR.end,
        dstBegin: dR.begin, dstEnd: dR.end,
      });
      usedDst[posJ] = 1; usedSrc[i] = 1;
    } else {
      srcOnly.push({ srcIdx: i });
    }
    posJ++;
  }
  // Third pass — collect unused dst shapes (within the dst range).
  const dstOnly = [];
  for (let j = dstLo; j <= dstHi; j++) {
    if (!usedDst[j]) dstOnly.push({ dstIdx: j });
  }
  // Shapes OUTSIDE the src range (when a sprite range is set) that aren't
  // part of the morph: the morph bundle keeps the WHOLE src plane (so every
  // meta row's absolute curve/band/geom/table indices stay valid — slicing
  // those is the rabbit hole), and these non-sprite rows are simply forced
  // invisible so only the sprite renders. Empty for a whole-bundle morph.
  const hidden = [];
  if (srcRange) {
    for (let i = 0; i < src.numShapes; i++) {
      if (i < srcLo || i > srcHi) hidden.push(i);
    }
  }
  return {
    matched, srcOnly, dstOnly, hidden,
    // Whole-src seed: indices stay absolute, so finalShapeCount counts the
    // full src plane plus dst-only appends (NOT just the sprite's rows).
    finalShapeCount: src.numShapes + dstOnly.length,
  };
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
    ? bundle.curveTexels.length   // only present on textRun output
    : 0;
  // Production createBundle bundles don't keep .curveTexels on the
  // returned object. Reconstruct per-shape curve ranges from meta
  // texel 4 (glyphLoc), which encodes each shape's first curve offset.
  const TEX_W = 4096;
  const ranges = new Array(n);
  for (let i = 0; i < n; i++) {
    const base = i * stride;
    const gx = (meta[base + META_TEXEL_4]     | 0);
    const gy = (meta[base + META_TEXEL_4 + 1] | 0);
    ranges[i] = { begin: 4 * (gy * TEX_W + gx), end: 0 };
  }
  for (let i = 0; i < n - 1; i++) ranges[i].end = ranges[i + 1].begin;
  // The last shape extends to the curve plane end. The bundle doesn't
  // expose buffer length on createBundle output; we let the caller
  // hand us the value via sections._mergedCurveF32.length later.
  // Stash a sentinel that composeMorphSections resolves.
  if (n > 0) ranges[n - 1].end = -1;
  return ranges;
}

// ---- Sections composition ------------------------------------------

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
function composeMorphSections(src, dst, plan) {
  const TEX_W = 4096;
  // The bundle's `curves` ArrayBuffer is only available on sections —
  // createBundle's output doesn't keep it. Reconstruct from the
  // bundle's exposed texture by reading curveTexels when present
  // (textRun + tests) or via the original bytes through sections-
  // style callers. For createBundle output we expect the consumer
  // to pass the raw sections dict directly — Mantle uses createBundle
  // output, so we read from the bundle's curve sentinel fields.
  const srcCurveF32 = extractCurveFloats(src);
  const dstCurveF32 = extractCurveFloats(dst);

  // 1) Walk plan.matched: for each matched pair, copy the dst slice
  //    into a re-mapped buffer that uses the src layout so the lerp
  //    arithmetic in setT can subarray both sides at the same indices.
  const dstRemapped = new Float32Array(srcCurveF32.length);
  // For matched pairs, copy dst[dstBegin..dstEnd] → dstRemapped[srcBegin..srcEnd].
  for (const m of plan.matched) {
    dstRemapped.set(
      dstCurveF32.subarray(m.dstBegin, m.dstEnd),
      m.srcBegin);
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
  const dstOnlyEntries = [];
  let runningOffsetF = appendOffsetF;
  for (const d of plan.dstOnly) {
    const r = dstRanges[d.dstIdx];
    const len = r.end - r.begin;
    dstOnlyEntries.push({ dstIdx: d.dstIdx, newOffsetF: runningOffsetF, len });
    runningOffsetF += len;
    // Round each shape's start to a row boundary so glyphLoc keeps
    // its (x, y) decomposition simple. For tiny per-shape buffers
    // (text glyphs) the padding is bounded; for full SVG shapes it's
    // negligible.
    if (runningOffsetF % rowFloats !== 0) {
      runningOffsetF += rowFloats - (runningOffsetF % rowFloats);
    }
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

  // 3) Build the merged meta plane. Src meta rows copied verbatim;
  //    dst-only meta rows appended with glyphLoc re-pointed into the
  //    appended curve region.
  const stride = src.metaFloatsPerShape || 48;
  const finalN = plan.finalShapeCount;
  const mergedMetaF = new Float32Array(finalN * stride);
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
  const dstAlignedMetaF = new Float32Array(finalN * stride);
  for (const m of plan.matched) {
    dstAlignedMetaF.set(
      dst.metaFloats.subarray(m.dstIdx * stride, (m.dstIdx + 1) * stride),
      m.srcIdx * stride);
  }
  // Bands FIRST: append a collapsed band region for each dst-only shape so
  // it rasterizes (its segments repointed into the merged curve buffer).
  // Done before the dst-only meta loop, which needs the band glyphLocs.
  const bandsResult = concatBandPlanes(src, dst, plan, TEX_W);
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
  const dstOnlyGids = [];   // per dstOnlyEntries[k]: the new unique gid

  for (let k = 0; k < dstOnlyEntries.length; k++) {
    const e = dstOnlyEntries[k];
    const srcRow = dst.metaFloats.subarray(e.dstIdx * stride, (e.dstIdx + 1) * stride);
    const dstRow = mergedMetaF.subarray((src.numShapes + k) * stride, (src.numShapes + k + 1) * stride);
    dstRow.set(srcRow);
    // Texel 4 = (glyphLoc.x, glyphLoc.y, bandMaxX, bandMaxY) and addresses
    // this shape's BAND region (the shader reaches curves THROUGH the bands).
    const rw = dstOnlyBandRewrites[k];
    if (rw) {
      dstRow[META_TEXEL_4]     = rw.glyphLocIdx % TEX_W;
      dstRow[META_TEXEL_4 + 1] = (rw.glyphLocIdx / TEX_W) | 0;
      dstRow[META_TEXEL_4 + 2] = 0;
      dstRow[META_TEXEL_4 + 3] = 0;
    }
    // Fresh gid so the appended cover-quad chunk maps to THIS shape.
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
    mergedMetaF[base + META_TEXEL_4]     = newGx;
    mergedMetaF[base + META_TEXEL_4 + 1] = newGy;
    mergedMetaF[base + META_TEXEL_4 + 2] = 0;  // bandMaxX = 0 (one V band)
    mergedMetaF[base + META_TEXEL_4 + 3] = 0;  // bandMaxY = 0 (one H band)
  }

  // 4) Re-emit the 32-byte meta header + body so createBundle's
  //    parseMetaBin accepts it. Done AFTER the band-rewrite pass so
  //    matched-shape glyphLoc updates land in the serialized bytes.
  //
  // The merged globalBBox must ENCLOSE the appended dst-only shapes — they
  // can sit outside src's bbox (a shape only in the dst pose, anywhere in
  // the frame). The bbox drives band grid / cover quad / em→NDC mapping, so
  // a dst-only shape outside it never rasterizes. Union src's globalBBox
  // (xywh) with each dst-only shape's per-shape bbox (meta texel 0 =
  // xmin,ymin,xmax,ymax) and re-emit as xywh.
  const srcBB = src.globalBBox || [0, 0, 0, 0];
  let bbX0 = srcBB[0], bbY0 = srcBB[1], bbX1 = srcBB[0] + srcBB[2], bbY1 = srcBB[1] + srcBB[3];
  for (const e of dstOnlyEntries) {
    const o = e.dstIdx * stride;
    if (dst.metaFloats[o + 0] < bbX0) bbX0 = dst.metaFloats[o + 0];
    if (dst.metaFloats[o + 1] < bbY0) bbY0 = dst.metaFloats[o + 1];
    if (dst.metaFloats[o + 2] > bbX1) bbX1 = dst.metaFloats[o + 2];
    if (dst.metaFloats[o + 3] > bbY1) bbY1 = dst.metaFloats[o + 3];
  }
  const totalBBox = dstOnlyEntries.length
    ? [bbX0, bbY0, bbX1 - bbX0, bbY1 - bbY0] : srcBB;
  const metaAb = new ArrayBuffer(32 + mergedMetaF.byteLength);
  const mdv = new DataView(metaAb);
  mdv.setUint32(0,  finalN, true);
  mdv.setFloat32(4,  totalBBox[0], true);
  mdv.setFloat32(8,  totalBBox[1], true);
  mdv.setFloat32(12, totalBBox[2], true);
  mdv.setFloat32(16, totalBBox[3], true);
  new Uint8Array(metaAb, 32).set(new Uint8Array(mergedMetaF.buffer));

  // 6) curveGeom (per-shape OBB cover-quad chunks): copy src's chunks
  //    (union-rewriting matched ones), then append each dst-only shape's
  //    chunk from dst, stamped with the fresh gid so it resolves to the
  //    dst-only shape's merged index. Without its cover quad the dst-only
  //    shape generates NO draw op and never renders.
  const curveGeomAb = rewriteCurveGeom(src, dst, plan, dstOnlyEntries, dstOnlyGids);

  const curveW = TEX_W;
  const curveH = mergedCurveF32.length / (TEX_W * 4) | 0;

  // Concatenate the merged curve plane back into an ArrayBuffer for
  // createBundle. (Float32Array.buffer survives the .slice copy.)
  const curvesAb = mergedCurveF32.buffer.slice(0);

  // Merged shape-id list: src's ids followed by dst-only ids.
  const mergedShapeIds = (src.shapeIds || []).slice();
  for (const e of dstOnlyEntries) {
    mergedShapeIds.push((dst.shapeIds && dst.shapeIds[e.dstIdx]) || '');
  }

  return {
    flags: src.flags || 0,
    metaFloatsPerShape: stride,
    // Interior-skip occupancy is DELIBERATELY off on a morph bundle, even if
    // src/dst were imported with it. The occupancy bits are packed in the curve
    // buffer, which setT() lerps + re-uploads per frame — the grid can't be
    // interpolated between poses (cells aren't lerpable) and would be lerped as
    // garbage curve floats. The src meta's texel-5 occupancy descriptor rides
    // along inertly; this flag is what keeps the shader from ever reading it.
    // (A morph-compatible interior skip wants an em-space POLY whose few
    // vertices lerp in the same setT pass — a separate feature.)
    hasOccupancy: false,
    meta: metaAb,
    curves: curvesAb,
    bands: bandsAb,
    curveGeom: curveGeomAb,
    shapeIds: mergedShapeIds,
    // Animatable-clipper map. The morph keeps src's WHOLE meta plane (clip /
    // mask layer rows live in the appended suffix, INSIDE numShapes, at the
    // same absolute indices), so src's clipperRows still point at valid rows.
    // Without this the morph bundle defaults clipperRows to {} and
    // overrides.setClipper(svgId) returns false → animated clips/masks on a
    // morphed (incl. sprite) bundle silently stop moving. spriteRanges is
    // forwarded for the same reason (drawSprite on a morph bundle). Both are
    // immutable side-inputs shared with src for the morph's lifetime.
    clipperRows: src.clipperRows || null,
    spriteRanges: src.spriteRanges || null,
    spriteRangesNonContiguous: src.spriteRangesNonContiguous || null,
    // Gradient state. Forward src's gradient param table + stops bytes
    // verbatim so the morph bundle's shader sees the same gradient
    // params (axis, type, spread) at t=0. setT() lerps matched stops
    // ranges into a scratch copy and uploads it per frame.
    gradients:
      (src.gradientFloats && src.gradientFloats.byteLength)
        ? src.gradientFloats.buffer.slice(
            src.gradientFloats.byteOffset,
            src.gradientFloats.byteOffset + src.gradientFloats.byteLength)
        : null,
    gradientStops:
      (src.gradientStopsBytes && src.gradientStopsBytes.byteLength)
        ? src.gradientStopsBytes.buffer.slice(
            src.gradientStopsBytes.byteOffset,
            src.gradientStopsBytes.byteOffset + src.gradientStopsBytes.byteLength)
        : null,
    gradientStopsCount: src.gradientStopsCount || 0,
    // strokeMesh / clipMesh / maskMesh: forward src's buffers so per-
    // segment stroke meshes (Flash thick strokes / sharp joins / Option-B
    // path) survive into the morph bundle. Matched + src-only shapes
    // share src's gid → mesh chunks; dst-only shapes fade in via
    // visibility but won't have their own stroke-mesh chunks until the
    // dst-only appender is wired up. Acceptable for the common morph
    // (local deformation of the same topology). null inputs round-trip
    // as null.
    // Dash pattern table — forward src's verbatim (like gradients). A dasharray
    // is a static style, not geometry: the merged meta keeps src's dashId (texel
    // 3.w) pointing at the same rows, so src's dash table stays valid. WITHOUT
    // this the morph bundle has dashId>0 but no dashTex → dashed strokes render
    // SOLID on BOTH the Slug morph and the GPU-resident route.
    dashes:
      (src.dashFloats && src.dashFloats.byteLength)
        ? src.dashFloats.buffer.slice(
            src.dashFloats.byteOffset,
            src.dashFloats.byteOffset + src.dashFloats.byteLength)
        : null,
    strokeMesh:
      (src.strokeMesh && src.strokeMesh.byteLength)
        ? src.strokeMesh.slice(0)
        : null,
    clipMesh:
      (src.clipMesh && src.clipMesh.byteLength)
        ? src.clipMesh.slice(0)
        : null,
    maskMesh:
      (src.maskMesh && src.maskMesh.byteLength)
        ? src.maskMesh.slice(0)
        : null,
    // Filter / filter-graph / image-atlas tables: forward src's
    // entries so per-shape meta filterId references resolve. The
    // meta plane's "structural slots stay at src" rule (filterId
    // is one of those) means morphed shapes still reference filter
    // index N; without these tables here, the renderer's filter
    // branches bail (filterTab=null → no color-matrix record;
    // filterGraphs=null → no graph DAG; imageAtlas=null → feImage /
    // pattern lookups miss). Tables are forwarded by-reference
    // because the morph never mutates them — an immutable side-input
    // shared with src for the lifetime of the morph bundle. The
    // ArrayBuffer fields (filterTab, imageAtlas) are sliced into
    // fresh ArrayBuffers to avoid carrying foreign-bundle ownership
    // across the boundary.
    filterTab:
      (src.filterTab && src.filterTab.byteLength)
        ? src.filterTab.slice(0)
        : null,
    filterGraphs:
      (src.filterGraphs && src.filterGraphs.length)
        ? src.filterGraphs.slice()
        : null,
    imageAtlas:
      (src.imageAtlas && src.imageAtlas.byteLength)
        ? src.imageAtlas.slice(0)
        : null,
    imageAtlasDim: src.imageAtlasDim
      ? src.imageAtlasDim.slice()
      : null,
    imageAtlasRects: src.imageAtlasRects
      ? src.imageAtlasRects.map(r => r.slice())
      : null,
    // Side-channel for setT.
    _mergedCurveF32: mergedCurveF32,
    _dstCurveF32:    dstRemapped,
    _curveW: curveW,
    _curveH: curveH,
    // Gradient stop-lerp plan. For each src gradient whose stop count
    // matches dst's gradient at the same index, the morph can lerp the
    // stop bytes byte-by-byte (premul.rgb + offset.a). Mismatched stop
    // counts fall back to src's stops at all t. Plan entries:
    //   { srcByteOffset, dstByteOffset, byteLength }
    _gradStopPlan: buildGradStopPlan(src, dst),
    _srcGradStopsB: src.gradientStopsBytes || null,
    _dstGradStopsB: dst.gradientStopsBytes || null,
    // DefineMorphShape2 meta-plane lerp side-channel:
    // _mergedMetaF32      — src's meta plane as the t=0 baseline.
    // _dstAlignedMetaF32  — dst's meta rows copied into the *src*
    //                       index for each matched pair, zero
    //                       elsewhere. setT lerps texel-by-texel
    //                       against _mergedMetaF32 for the
    //                       morphable slots only.
    _mergedMetaF32:     mergedMetaF,
    _dstAlignedMetaF32: dstAlignedMetaF,
    _metaStride:        stride,
    _matchedSrcIdxs:    plan.matched.map(m => m.srcIdx),
    // Gradient-param lerp side-channel (gradient_transform + focal):
    // pair gradients by INDEX (matched indexing same as the stops
    // plan). For each matched pair record the 16-float record range
    // in both src and dst, plus what's actually morphable:
    //   slots [4..9]   inverse 2D transform matrix (linear/radial/focal)
    //   slot  [3]      fyFrac (radial+focal — focal-point Y normalized)
    //   slots [12..15] axis params (linear: x1,y1,x2,y2 | radial: cx,cy,r,fxFrac)
    // Slots [10..11] (stopsOffset, stopsCount) are structural —
    // never lerped. Slots [0..2] (type/spread/units) are also
    // structural; type mismatch falls back to "src only" same as
    // stop-count mismatch.
    _gradParamPlan: buildGradParamPlan(src, dst),
    _srcGradParamsF: src.gradientFloats
      ? new Float32Array(src.gradientFloats.buffer,
                         src.gradientFloats.byteOffset,
                         src.gradientFloats.byteLength >> 2)
      : null,
    _dstGradParamsF: dst.gradientFloats
      ? new Float32Array(dst.gradientFloats.buffer,
                         dst.gradientFloats.byteOffset,
                         dst.gradientFloats.byteLength >> 2)
      : null,
  };
}

// Pair src/dst gradients by INDEX and record the lerpable slot
// ranges. Linear / radial / focal-radial all use the same 16-float
// record; only matching gradient *types* (slot 0) get lerped. Output
// entries:
//   { baseF, lerpSlots: [3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15] }
// where lerpSlots lists exactly the float indices within the record
// that should be lerped (slots 0/1/2/10/11 are structural).
function buildGradParamPlan(src, dst) {
  if (!src.gradientFloats || !dst.gradientFloats) return [];
  const FLOATS_PER_GRAD = 16;
  const srcF = new Float32Array(src.gradientFloats.buffer,
                                src.gradientFloats.byteOffset,
                                src.gradientFloats.byteLength >> 2);
  const dstF = new Float32Array(dst.gradientFloats.buffer,
                                dst.gradientFloats.byteOffset,
                                dst.gradientFloats.byteLength >> 2);
  const srcN = srcF.length / FLOATS_PER_GRAD;
  const dstN = dstF.length / FLOATS_PER_GRAD;
  const pairs = Math.min(srcN, dstN);
  const out = [];
  // The "morphable" slots in a 16-float gradient record. Slot
  // numbers index into the record (0..15).
  //   [3]        fyFrac (radial focal-Y normalized; zero for linear)
  //   [4..9]     inverse 2D affine (ia, ib, ic, id, ie, if_)
  //   [12..15]   axis params (linear endpoints OR radial cx/cy/r/fxFrac)
  // All other slots are structural (type, spread, units, stopsOffset,
  // stopsCount) and must NOT lerp.
  const LERP_SLOTS = [3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15];
  for (let i = 0; i < pairs; i++) {
    const baseF = i * FLOATS_PER_GRAD;
    // Type must match — different gradient types are not morph-
    // compatible (Flash MorphShape2 doesn't morph type changes
    // either; Animate compiles them as separate fill records).
    if (srcF[baseF] !== dstF[baseF]) continue;
    out.push({ baseF, lerpSlots: LERP_SLOTS });
  }
  return out;
}

/**
 * Pair src/dst gradients by INDEX (Flash/Animate compiles morph fill
 * indices canonically). For each pair where stop counts match, the
 * morph can lerp the stop bytes per `setT`. Returns an array of
 * `{ srcByteOffset, dstByteOffset, byteLength }` ranges into the
 * gradient-stops bytes buffer.
 */
function buildGradStopPlan(src, dst) {
  if (!src.gradientFloats || !dst.gradientFloats) return [];
  if (!src.gradientStopsBytes || !dst.gradientStopsBytes) return [];
  const srcG = src.gradientFloats;
  const dstG = dst.gradientFloats;
  const FLOATS_PER_GRAD = 16;     // 4 RGBA32F texels per gradient
  const STOPS_TEXEL_BYTES = 4;    // RGBA8 = 4 bytes per stop
  const srcN = srcG.length / FLOATS_PER_GRAD;
  const dstN = dstG.length / FLOATS_PER_GRAD;
  const pairs = Math.min(srcN, dstN);
  const plan = [];
  for (let i = 0; i < pairs; i++) {
    // Gradient param texel 2 (offset 8..11 within the 16 floats):
    //   (ax, ay, stopsOffset, stopsCount)  — see svg/gradient.js
    // The stops offset is in TEXEL units; convert to bytes.
    const base = i * FLOATS_PER_GRAD;
    const srcStopOff = Math.floor(srcG[base + 10] + 0.5);
    const srcStopCnt = Math.floor(srcG[base + 11] + 0.5);
    const dstStopOff = Math.floor(dstG[base + 10] + 0.5);
    const dstStopCnt = Math.floor(dstG[base + 11] + 0.5);
    if (srcStopCnt <= 0 || dstStopCnt <= 0) continue;
    if (srcStopCnt !== dstStopCnt) continue;   // stop-count mismatch → no lerp
    plan.push({
      srcByteOffset: srcStopOff * STOPS_TEXEL_BYTES,
      dstByteOffset: dstStopOff * STOPS_TEXEL_BYTES,
      byteLength:    srcStopCnt * STOPS_TEXEL_BYTES,
    });
  }
  return plan;
}

function extractCurveFloats(bundle) {
  // Source-of-truth priority:
  //   1. bundle.curveFloats — UNPADDED Float32Array exposed by
  //      createBundle since the curve-byte-count followup landed.
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
  const dstCurve = dst.curveFloats || (dst.curves ? new Float32Array(dst.curves) : new Float32Array(0));
  if (!dstBand || !dstMeta) return { buf: bandBuf, rewrites: dstOnlyEntries.map(() => null) };

  const perShape = dstOnlyEntries.map(e => {
    const base = e.dstIdx * stride;
    const gx = dstMeta[base + META_TEXEL_4] | 0;
    const gy = dstMeta[base + META_TEXEL_4 + 1] | 0;
    const bandsX = (dstMeta[base + META_TEXEL_4 + 2] | 0) + 1;
    const bandsY = (dstMeta[base + META_TEXEL_4 + 3] | 0) + 1;
    const segs = collectShapeSegs(dstBand, TEX_W, gy * TEX_W + gx, bandsY, bandsX);
    const r = dstRanges[e.dstIdx];
    const deltaTex = (e.newOffsetF - (r ? r.begin : 0)) >>> 2;   // band hx/hy are TEXELS
    return segs.map(s => {
      const newTex = (s.hy * TEX_W + s.hx) + deltaTex;
      const bb = readSegBbox(dstCurve, TEX_W, s.hx, s.hy, s.segType);
      return { hx: newTex % TEX_W, hy: (newTex / TEX_W) | 0, segType: s.segType, maxX: bb.maxX, maxY: bb.maxY };
    });
  });

  let appendTexels = 0;
  const layouts = perShape.map(segs => {
    appendTexels += 4 + segs.length * 2 + TEX_W;   // +row slack for rounding
    return { segs, headers: 4, hArr: segs.length, vArr: segs.length, glyphLocIdx: 0 };
  });
  const srcTexRounded = roundUpToTex(srcBand.length / 4, TEX_W);
  const out = new Float32Array(roundUpToTex(srcTexRounded + appendTexels, TEX_W) * 4);
  out.set(srcBand);
  const sortBy = (segs, k) => segs.slice().sort((a, b) =>
    a.segType !== b.segType ? a.segType - b.segType : (a[k] !== b[k] ? b[k] - a[k] : 0));
  let cursor = srcTexRounded;
  const rewrites = [];
  for (const layout of layouts) {
    cursor = roundUpToTex(cursor, TEX_W);
    layout.glyphLocIdx = cursor;
    const headerBase = cursor, hArrBase = cursor + 4, vArrBase = hArrBase + layout.hArr;
    const counts = [0, 0, 0, 0];
    for (const s of layout.segs) counts[s.segType]++;
    texelWrite(out, TEX_W, headerBase + 0, counts[0], counts[1], counts[2], counts[3]);
    texelWrite(out, TEX_W, headerBase + 1, 4, 0, 0, 0);
    texelWrite(out, TEX_W, headerBase + 2, counts[0], counts[1], counts[2], counts[3]);
    texelWrite(out, TEX_W, headerBase + 3, 4 + layout.hArr, 0, 0, 0);
    const hSegs = sortBy(layout.segs, 'maxX');
    for (let i = 0; i < hSegs.length; i++) texelWrite(out, TEX_W, hArrBase + i, hSegs[i].hx, hSegs[i].hy, hSegs[i].maxX, hSegs[i].segType);
    const vSegs = sortBy(layout.segs, 'maxY');
    for (let i = 0; i < vSegs.length; i++) texelWrite(out, TEX_W, vArrBase + i, vSegs[i].hx, vSegs[i].hy, vSegs[i].maxY, vSegs[i].segType);
    cursor = vArrBase + layout.vArr;
    rewrites.push({ glyphLocIdx: layout.glyphLocIdx });
  }
  return { buf: out.buffer.slice(0), rewrites };
}

function concatBandPlanes(src, dst, plan, TEX_W) {
  // Each matched-shape band-membership needs to cover BOTH src's and
  // dst's segment positions across the lerp range [0, 1]: bands are
  // computed from per-segment bboxes, and curves lerp from src→dst
  // over t. Forwarding src's bands verbatim makes the per-pixel walker
  // visit the wrong segments at t>0 — visible as cover-quad fragmentation.
  //
  // Fix: rebuild each matched shape's band region as a single-band
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
  const srcBand = src.bandFloats
    || (src.bands ? new Float32Array(src.bands) : null);
  if (!srcBand || !srcBand.length) {
    if (src.bands && src.bands.byteLength)
      return { buf: src.bands.slice(0), matchedRewrites: [] };
    return { buf: new ArrayBuffer(16), matchedRewrites: [] };
  }
  // Build a new band plane: keep src's full buffer (preserves src-only
  // and dst-only band regions) and APPEND new collapsed regions for
  // matched shapes, rewriting their meta glyphLoc/bandMax.
  if (!plan.matched.length) {
    return {
      buf: srcBand.buffer.slice(srcBand.byteOffset,
                                srcBand.byteOffset + srcBand.byteLength),
      matchedRewrites: [],
    };
  }
  // Decode matched shapes' segment lists from src's bands + compute
  // per-segment UNION control-polygon bboxes (max of src+dst extents
  // for the corresponding segment k in each pose). The union breakAxis
  // is what makes the shader's per-segment H/V early-out work for any
  // t — sorted descending, the walker breaks as soon as it sees a
  // segment whose union extent can't reach the pixel, guaranteeing
  // all earlier-sorted segments were processed.
  const stride = src.metaFloatsPerShape || 48;
  const srcMeta = src.metaFloats;
  const dstMeta = dst.metaFloats;
  const srcCurveF32 = src.curveFloats || (src.curves ? new Float32Array(src.curves) : null);
  const dstCurveF32 = dst.curveFloats || (dst.curves ? new Float32Array(dst.curves) : null);
  if (!srcCurveF32 || !dstCurveF32) {
    // No curve buffer to decode — fall back to forwarding src verbatim
    // (will still fragment at t>0).
    return {
      buf: srcBand.buffer.slice(srcBand.byteOffset,
                                srcBand.byteOffset + srcBand.byteLength),
      matchedRewrites: [],
    };
  }
  const matchedRewrites = [];
  for (const m of plan.matched) {
    const sBase = m.srcIdx * stride;
    const dBase = m.dstIdx * stride;
    const sGx = srcMeta[sBase + META_TEXEL_4] | 0;
    const sGy = srcMeta[sBase + META_TEXEL_4 + 1] | 0;
    const sBandsX = (srcMeta[sBase + META_TEXEL_4 + 2] | 0) + 1;
    const sBandsY = (srcMeta[sBase + META_TEXEL_4 + 3] | 0) + 1;
    const sGlyph = sGy * TEX_W + sGx;
    const dGx = dstMeta[dBase + META_TEXEL_4] | 0;
    const dGy = dstMeta[dBase + META_TEXEL_4 + 1] | 0;
    const dBandsX = (dstMeta[dBase + META_TEXEL_4 + 2] | 0) + 1;
    const dBandsY = (dstMeta[dBase + META_TEXEL_4 + 3] | 0) + 1;
    const dGlyph = dGy * TEX_W + dGx;
    // Collect unique segments from src's H bands. Each entry stores
    // its src curve-buffer header position (which the morph addresses
    // since the merged curve buffer = src's at t=0 baseline) and the
    // segment-index within the shape (used to find the matching dst
    // segment for the union breakAxis).
    const srcSegs = collectShapeSegs(srcBand, TEX_W, sGlyph, sBandsY, sBandsX);
    const dstSegs = collectShapeSegs(dst.bandFloats || new Float32Array(dst.bands), TEX_W, dGlyph, dBandsY, dBandsX);
    // Matched-topology invariant: srcSegs.length === dstSegs.length.
    // Pair by index. (Both bundles emit segments in path order.)
    if (srcSegs.length !== dstSegs.length) {
      // Segment counts diverge — can't pair by index; skip the union
      // rewrite and fall through to src-only bands for this shape.
      continue;
    }
    // For each segment k: read control-polygon bbox from src AND dst
    // curve plane, union them, store per-axis maxes for descending sort.
    const segs = [];
    for (let k = 0; k < srcSegs.length; k++) {
      const s = srcSegs[k];
      const d = dstSegs[k];
      const sBbox = readSegBbox(srcCurveF32, TEX_W, s.hx, s.hy, s.segType);
      const dBbox = readSegBbox(dstCurveF32, TEX_W, d.hx, d.hy, d.segType);
      segs.push({
        hx: s.hx, hy: s.hy, segType: s.segType,
        // Union per-axis extents over [src, dst] poses.
        maxX: Math.max(sBbox.maxX, dBbox.maxX),
        maxY: Math.max(sBbox.maxY, dBbox.maxY),
      });
    }
    matchedRewrites.push({ srcIdx: m.srcIdx, segs });
  }
  // Layout per matched shape:
  //   2 H-band header texels   (counts, arrIdx)
  //   2 V-band header texels   (counts, arrIdx)
  //   N segment-list entries for the H band (sorted descending by maxX)
  //   N segment-list entries for the V band (sorted descending by maxY)
  // H and V arrays are separate because they sort by different axes;
  // sharing one array would break the descending-sort invariant the
  // shader's early-out relies on.
  let appendTexels = 0;
  const layouts = matchedRewrites.map(r => {
    const headers = 4;
    const hArr = r.segs.length;
    const vArr = r.segs.length;
    const layout = { ...r, headers, hArr, vArr, glyphLocIdx: 0 };
    appendTexels += headers + hArr + vArr;
    return layout;
  });
  const srcTexCount = srcBand.length / 4;
  const srcTexRounded = roundUpToTex(srcTexCount, TEX_W);
  const totalTex = roundUpToTex(srcTexRounded + appendTexels + matchedRewrites.length * TEX_W, TEX_W);
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
    cursor = roundUpToTex(cursor, TEX_W);
    layout.glyphLocIdx = cursor;
    const headerBase = cursor;
    const hArrBase   = cursor + layout.headers;
    const vArrBase   = hArrBase + layout.hArr;
    const counts = [0, 0, 0, 0];
    for (const s of layout.segs) counts[s.segType]++;
    // H band header at slot 0.
    texelWrite(out, TEX_W, headerBase + 0, counts[0], counts[1], counts[2], counts[3]);
    texelWrite(out, TEX_W, headerBase + 1, layout.headers,                     0, 0, 0);
    // V band header at slot 1 (bandsY == 1).
    texelWrite(out, TEX_W, headerBase + 2, counts[0], counts[1], counts[2], counts[3]);
    texelWrite(out, TEX_W, headerBase + 3, layout.headers + layout.hArr,        0, 0, 0);
    // H array: descending maxX.
    const hSegs = sortByMaxThenType(layout.segs, 'x');
    for (let i = 0; i < hSegs.length; i++) {
      const s = hSegs[i];
      texelWrite(out, TEX_W, hArrBase + i, s.hx, s.hy, s.maxX, s.segType);
    }
    // V array: descending maxY.
    const vSegs = sortByMaxThenType(layout.segs, 'y');
    for (let i = 0; i < vSegs.length; i++) {
      const s = vSegs[i];
      texelWrite(out, TEX_W, vArrBase + i, s.hx, s.hy, s.maxY, s.segType);
    }
    cursor = vArrBase + layout.vArr;
  }
  // Return both the buffer and the layouts so composeMorphSections
  // can rewrite each matched shape's meta texel 4. ArrayBuffer.slice()
  // strips custom properties, so we wrap in a {buf, matchedRewrites}
  // object. composeMorphSections unpacks.
  return {
    buf: out.buffer.slice(0),
    matchedRewrites: layouts.map(l => ({
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
  buf[off]     = a;
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
    const nTotal = (ht[0] | 0) + (ht[1] | 0) + (ht[2] | 0) + (ht[3] | 0);
    const arrIdx = ot[0] | 0;
    for (let i = 0; i < nTotal; i++) {
      const e = bandTexelAt(bandFloats, TEX_W, glyphLocIdx + arrIdx + i);
      const hx = e[0] | 0, hy = e[1] | 0;
      const key = hx + ',' + hy;
      if (seen.has(key)) continue;
      seen.add(key);
      segs.push({ hx, hy, segType: (e[3] | 0) & 3 });
    }
  };
  // H bands at slots [0 .. bandsY * 2).
  for (let by = 0; by < bandsY; by++) visitBand(by * 2);
  // V bands at slots [bandsY * 2 .. (bandsY + bandsX) * 2).
  for (let bx = 0; bx < bandsX; bx++) visitBand((bandsY + bx) * 2);
  segs.sort((a, b) => (a.hy * TEX_W + a.hx) - (b.hy * TEX_W + b.hx));
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
function readSegBbox(curveFloats, TEX_W, hx, hy, segType) {
  const baseTex = hy * TEX_W + hx;
  function ctrl(texOffset, slot) {
    const t = baseTex + texOffset;
    const off = t * 4 + slot;
    return curveFloats[off];
  }
  // Collect control points by type.
  const xs = [], ys = [];
  if (segType === 0) {            // LINE
    xs.push(ctrl(1, 0), ctrl(1, 2));
    ys.push(ctrl(1, 1), ctrl(1, 3));
  } else if (segType === 1) {     // QUAD
    xs.push(ctrl(1, 0), ctrl(1, 2), ctrl(2, 0));
    ys.push(ctrl(1, 1), ctrl(1, 3), ctrl(2, 1));
  } else if (segType === 2) {     // CUBIC
    xs.push(ctrl(1, 0), ctrl(1, 2), ctrl(2, 0), ctrl(2, 2));
    ys.push(ctrl(1, 1), ctrl(1, 3), ctrl(2, 1), ctrl(2, 3));
  } else {                        // ARC: bbox is centre ± radii (loose;
                                  //      true arc-bbox would need θ-extrema)
    const cx = ctrl(1, 0), cy = ctrl(1, 1);
    const rx = ctrl(1, 2), ry = ctrl(1, 3);
    xs.push(cx - rx, cx + rx);
    ys.push(cy - ry, cy + ry);
  }
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

function rewriteCurveGeom(src, dst, plan, dstOnlyEntries, dstOnlyGids) {
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
  // so any lerped silhouette in between is also enclosed. Skip the
  // OBB-fit step (cover area is slightly bigger than a tight OBB but
  // correctness trumps fill rate for animations). Unmatched chunks
  // pass through.
  const srcF32 = src.coverQuadFloats || (src.curveGeom ? new Float32Array(src.curveGeom) : null);
  const dstF32 = dst.coverQuadFloats || (dst.curveGeom ? new Float32Array(dst.curveGeom) : null);
  if (!srcF32 || !srcF32.length) return null;
  if (!dstF32 || !dstF32.length) {
    return srcF32.buffer.slice(srcF32.byteOffset,
                               srcF32.byteOffset + srcF32.byteLength);
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
  const srcChunks = chunksOf(srcF32);
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
  const gidOf = (bundle, shapeIdx) =>
    Math.floor(bundle.metaFloats[shapeIdx * stride + 14] + 0.5);
  const srcGidToDstChunk = new Map();   // matched src gid → dst chunk
  const matchedSrcGids = new Set();
  for (const m of plan.matched) {
    const sGid = gidOf(src, m.srcIdx);
    const dGid = gidOf(dst, m.dstIdx);
    matchedSrcGids.add(sGid);
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
      let xL = Infinity, yT = Infinity, xR = -Infinity, yB = -Infinity;
      for (let v = 0; v < c.n; v++) {
        const px = srcF32[c.vertsOff + v * 12 + 0];
        const py = srcF32[c.vertsOff + v * 12 + 1];
        if (px < xL) xL = px; if (px > xR) xR = px;
        if (py < yT) yT = py; if (py > yB) yB = py;
      }
      for (let v = 0; v < dstChunk.n; v++) {
        const px = dstF32[dstChunk.vertsOff + v * 12 + 0];
        const py = dstF32[dstChunk.vertsOff + v * 12 + 1];
        if (px < xL) xL = px; if (px > xR) xR = px;
        if (py < yT) yT = py; if (py > yB) yB = py;
      }
      // Emit header with n=6 (one AABB = 2 triangles = 6 verts) and
      // the original header's gid + color + marker fields.
      outFloats.push(6);
      for (let k = 1; k < 12; k++) outFloats.push(srcF32[c.headerOff + k]);
      // 6 AABB verts in the same order as getCoverQuadMesh's AABB
      // fallback: (tl, tr, br, tl, br, bl) with AABB bisector normals
      // (±1, ±1) per corner. Kind=1 (cover), zone=-1 (hull).
      const verts   = [[xL,yT],[xR,yT],[xR,yB],[xL,yT],[xR,yB],[xL,yB]];
      const normals = [[-1,-1],[+1,-1],[+1,+1],[-1,-1],[+1,+1],[-1,+1]];
      for (let i = 0; i < 6; i++) {
        outFloats.push(verts[i][0], verts[i][1],
                       normals[i][0], normals[i][1],
                       0, 0, 0, 0, 0, 0,
                       1, -1);
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
    overrides.update(s.srcIdx, { visibility: 1 - t });
  }
  // dst-only: invisible at t=0, fade in as t→1. They live at appended
  // indices after src's shape range.
  const baseDstOnlyIdx = (overrides.numShapes) - plan.dstOnly.length;
  for (let k = 0; k < plan.dstOnly.length; k++) {
    overrides.update(baseDstOnlyIdx + k, { visibility: t });
  }
  // Non-sprite shapes (sprite-morph only): permanently hidden so the morph
  // bundle renders just the sprite, even though it carries the whole src
  // plane. t-independent.
  if (plan.hidden) {
    for (const idx of plan.hidden) overrides.update(idx, { visibility: 0 });
  }
}

// Per-setT visibility: write ONLY the t-dependent rows. Matched (visibility 1)
// and hidden (visibility 0) are t-independent and already set by the
// construction-time resetVisibility() — re-asserting them every frame would
// dirty every matched row and defeat the override table's dirty-row upload
// band (a fully-matched morph then costs ZERO per-frame override writes).
function updateVisibility(overrides, plan, t) {
  // src-only: visible at t=0, fade out as t→1
  for (const s of plan.srcOnly) {
    overrides.update(s.srcIdx, { visibility: 1 - t });
  }
  // dst-only: invisible at t=0, fade in as t→1 (appended after src's range).
  const baseDstOnlyIdx = overrides.numShapes - plan.dstOnly.length;
  for (let k = 0; k < plan.dstOnly.length; k++) {
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
  let lo = 0, hi = last;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].time <= time) lo = mid; else hi = mid;
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
    const outX = loKey.outX !== undefined ? loKey.outX : 0;
    const outY = loKey.outY !== undefined ? loKey.outY : 0;
    const inX  = loKey.inX  !== undefined ? loKey.inX  : 1;
    const inY  = loKey.inY  !== undefined ? loKey.inY  : 1;
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
    if (t < 0) t = 0; else if (t > 1) t = 1;
  }
  // Bisection fallback.
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) * 0.5;
    if (bx(mid) < u) lo = mid; else hi = mid;
  }
  return by((lo + hi) * 0.5);
}

export { timelineBracketAt, timelineEase };
