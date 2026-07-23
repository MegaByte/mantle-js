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
  // curve plane was row-padded. Bundles that bypass createBundle
  // fall back to the inline derivation, which resolves the last
  // shape via curveTexels.length (correct when curveTexels is
  // unpadded).
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

  // 2b) Build the ENDPOINT-form twins of the two planes. Those — not these — are
  //     what setT interpolates, because a componentwise lerp of CENTRE-form arcs
  //     tears the contour apart (prepareArcMorph has the argument). The planes
  //     here stay in centre form: they are the bundle's t=0 state, read directly
  //     by the shader.
  const arcPrep = prepareArcMorph(src, plan, TEX_W, mergedCurveF32, dstRemapped);

  // 2c) Who-joins-whom, for the per-frame join-tangent rebuild. A stroked
  //     segment's join texel holds its neighbours' UNIT tangents, and those
  //     cannot be interpolated — they have to be recomputed from the lerped
  //     geometry each frame, or the stroke's joins fly apart (buildJoinTable).
  // Adjacency is resolved on the ENDPOINT-form plane, where arc endpoints are
  // stored and welded — centre form has none, and re-deriving them through trig
  // in float32 leaves joints up to ~2e-4 apart, which breaks the pairing.
  const joinTable = arcPrep.segTables.size
    ? buildJoinTable(src, plan, TEX_W, arcPrep.srcEp || mergedCurveF32,
                     arcPrep.segTables, new Set(arcPrep.arcs))
    : EMPTY_I32;

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
    // ARC morph side-channel. When the morph carries arcs, setT does NOT lerp
    // the two centre-form planes above — it lerps these endpoint-form twins and
    // converts each arc record back to centre form on the way into the live
    // curve texture. Null when no matched shape has a morphable arc, which is
    // the common case and leaves the fast paths exactly as they were.
    // (_arcOffsets lists each arc's HEADER float offset; see prepareArcMorph.)
    _srcEpCurveF32: arcPrep.srcEp,
    _dstEpCurveF32: arcPrep.dstEp,
    _arcOffsets:    arcPrep.arcs,
    // Stroke join-tangent rebuild table (see buildJoinTable). Empty when nothing
    // matched is stroked, which leaves the fast paths untouched.
    _joinTable:     joinTable,
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
  const TEXEL_BYTES = 4;          // RGBA8 texel
  const srcN = srcG.length / FLOATS_PER_GRAD;
  const dstN = dstG.length / FLOATS_PER_GRAD;
  const pairs = Math.min(srcN, dstN);
  const plan = [];
  for (let i = 0; i < pairs; i++) {
    // Gradient record slots 10/11: (stopsOffset, stopsCount) into the shared
    // stops LUT — see svg/gradient.js buildGradientTables. stopsOffset is in
    // TEXELS; stopsCount is SIGNED: negative = the all-opaque 1-texel/stop
    // fast path, positive = 2 texels/stop (straight RGBA texel + offset
    // texel). Sign must match for a byte-lerp to be meaningful (the sign IS
    // the stride), so a signed compare covers both count and layout.
    const base = i * FLOATS_PER_GRAD;
    const srcStopOff = Math.floor(srcG[base + 10] + 0.5);
    const srcStopCnt = Math.round(srcG[base + 11]);
    const dstStopOff = Math.floor(dstG[base + 10] + 0.5);
    const dstStopCnt = Math.round(dstG[base + 11]);
    if (srcStopCnt === 0 || dstStopCnt === 0) continue;
    if (srcStopCnt !== dstStopCnt) continue;   // count or stride mismatch → no lerp
    const texelsPerStop = srcStopCnt < 0 ? 1 : 2;
    const n = Math.abs(srcStopCnt);
    plan.push({
      srcByteOffset: srcStopOff * TEXEL_BYTES,
      dstByteOffset: dstStopOff * TEXEL_BYTES,
      byteLength:    n * texelsPerStop * TEXEL_BYTES,
    });
  }
  return plan;
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
    const arr = Math.ceil(segs.length / 2);        // packed entries: 2 per texel
    appendTexels += 4 + arr * 2 + TEX_W;           // +row slack for rounding
    return { segs, headers: 4, hArr: arr, vArr: arr, glyphLocIdx: 0 };
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
    // packed entry pairs: (loc0, brk0, loc1, brk1), loc = hy*4096 + hx; odd tail pads with
    // a sentinel break. Type is positional (sortBy groups types to match the header counts).
    const packPairs = (sorted, k, base) => {
      for (let i = 0; i < sorted.length; i += 2) {
        const s = sorted[i], t = sorted[i + 1];
        texelWrite(out, TEX_W, base + (i >> 1), s.hy * TEX_W + s.hx, s[k],
                   t ? t.hy * TEX_W + t.hx : 0, t ? t[k] : -1e30);
      }
    };
    packPairs(sortBy(layout.segs, 'maxX'), 'maxX', hArrBase);
    packPairs(sortBy(layout.segs, 'maxY'), 'maxY', vArrBase);
    cursor = vArrBase + layout.vArr;
    rewrites.push({ glyphLocIdx: layout.glyphLocIdx });
  }
  return { buf: out.buffer.slice(0), rewrites };
}

/**
 * Build the ENDPOINT-FORM curve planes the morph actually interpolates, and the
 * table of arc records setT has to convert back afterwards.
 *
 * This is what lets a morph carry an arc EXACTLY, with no cubic stand-in.
 *
 * A morph is a COMPONENTWISE LERP of two curve planes — every path does it blind
 * (the GPU mix(), its CPU fallback, the renderer's Loop-Blinn route), so the
 * planes have to be in a parameterization where that lerp MEANS something. For
 * line/quad/cubic it does: a segment's endpoints ARE stored floats, so they
 * travel straight to their dst positions, and the endpoint a segment shares with
 * its neighbour is literally the same pair of numbers in both — welded at every
 * t. An arc is stored in CENTRE form (cx, cy, rx, ry, phi, theta_start,
 * theta_end) and its endpoints are a NONLINEAR function of those: lerp the
 * floats and the arc's endpoint swings around the ellipse while the neighbouring
 * line's endpoint walks the chord. The contour comes apart mid-morph, the fill
 * walker's crossings stop pairing, and the shape tears. Centre form is also
 * MANY-TO-ONE — (rx, ry, phi, th), (rx, ry, phi+pi, th+pi) and (ry, rx,
 * phi+pi/2, th-pi/2) denote the identical arc, as does any th + 2*pi*k — and two
 * poses imported independently have no reason to agree on a branch, so a blind
 * lerp can spin the ellipse through a whole turn on the way across. On a real
 * asset that was the dominant term: joint gaps up to a THIRD of the artwork.
 *
 * ENDPOINT form — (p1, p4, rx, ry, phi, flags), the form the SVG author wrote —
 * has neither problem. p1/p4 are stored floats, so they lerp straight and stay
 * welded to the neighbours; rx/ry/phi lerp; the flags are structural and equal
 * on both sides. And every intermediate is a TRUE ellipse arc — nothing is
 * approximated, which is the whole point of keeping arcs native. It is also
 * exactly what interpolating the two SVG `d` strings would give, which is the
 * behaviour an author expects.
 *
 * The catch, and the only reason this isn't simply the storage format: the
 * SHADER wants centre form (it ray-casts against cx/cy/rx/ry/theta). So the
 * conversion has to happen AFTER the lerp, not before — hence the split: these
 * endpoint-form planes are what setT interpolates, and it converts each arc
 * record back to centre form on the way into the live curve texture. Cheap
 * (arcEndpointToCenter per arc per frame, ~1e3 arcs on a heavy asset) and exact.
 * It does mean an arc-bearing morph can't ride the GPU mix (which would write
 * endpoint form straight into the texture the shader reads as centre form), so
 * `arcs.length > 0` pins it to the CPU lerp path.
 *
 * The planes handed in stay in CENTRE form — they're the bundle's t=0 state and
 * the shader reads them directly.
 *
 * @returns {{segTables: Map, srcEp: Float32Array, dstEp: Float32Array,
 *            arcs: Int32Array}} `arcs` lists the float offset of each arc's
 *   HEADER texel; srcEp/dstEp are the endpoint-form twins of the two planes.
 */
function prepareArcMorph(src, plan, TEX_W, merged, dstRemapped) {
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
    const glyph = (srcMeta[base + META_TEXEL_4 + 1] | 0) * TEX_W
                + (srcMeta[base + META_TEXEL_4] | 0);
    const bandsX = (srcMeta[base + META_TEXEL_4 + 2] | 0) + 1;
    const bandsY = (srcMeta[base + META_TEXEL_4 + 3] | 0) + 1;
    const segs = collectShapeSegs(srcBand, TEX_W, glyph, bandsY, bandsX);
    tables.set(m.srcIdx, segs);
    for (const s of segs) {
      if (s.segType !== SEG_ARC_T) continue;
      // Both poses' records for this segment sit at the SAME float offset —
      // dstRemapped is dst's plane re-laid into src's layout, which is the
      // premise the whole lerp already rests on.
      const off = 4 * (s.hy * TEX_W + s.hx);
      if (arcRecordMorphable(merged, off) && arcRecordMorphable(dstRemapped, off)) arcs.push(off);
    }
  }
  if (!arcs.length) return empty;

  // The endpoint-form twins differ from the centre-form planes ONLY inside arc
  // records, so start from a copy and rewrite just those.
  const srcEp = merged.slice();
  const dstEp = dstRemapped.slice();
  for (const off of arcs) {
    arcRecordToEndpoint(merged, srcEp, off);
    arcRecordToEndpoint(dstRemapped, dstEp, off);
    // phi is only defined modulo pi (an ellipse rotated by pi is itself, with
    // theta shifted — and theta is gone in endpoint form), and pi/2 with the
    // radii swapped. Two poses can sit on different branches, so pull dst onto
    // the branch nearest src or the lerp rotates the ellipse the long way.
    harmonizeEndpointArc(srcEp, dstEp, off);
    holdArcFlags(srcEp, dstEp, off);
  }
  const arcSet = new Set(arcs);
  for (const [, segs] of tables) {
    weldArcJoints(srcEp, segs, TEX_W, arcSet);
    weldArcJoints(dstEp, segs, TEX_W, arcSet);
  }
  return { segTables: tables, srcEp, dstEp, arcs: Int32Array.from(arcs) };
}

/**
 * Snap each arc's endpoints onto the exact point its neighbour already holds.
 *
 * An arc record stores no endpoints — arcRecordToEndpoint has to DERIVE them from
 * the centre form, `c + R(phi)·(rx cos th, ry sin th)`. Two consecutive arcs of the
 * same ellipse therefore recover their shared corner independently, through
 * different trig, and land on points that agree only to within the conditioning of
 * the centre-form round trip. Measured on real art: up to 2e-4 em.
 *
 * Both poses carry that error, and a lerp preserves it, so it is not a morph
 * artifact — but it makes the contour ever so slightly OPEN. The GL walker never
 * notices (it accumulates winding; a 2e-4 gap is far under a pixel). The native
 * backend re-emits the shape as an SVG <path> and infers subpaths from pen
 * continuity, with a 1e-4 tolerance — so it reads the gap as a subpath break,
 * closes the contour early with a chord, and the fill loses a wedge. A circle
 * comes out as a hollow ring.
 *
 * So weld: at each joint take ONE canonical point and write it into both sides.
 * A non-arc neighbour's endpoint is a stored float and therefore exact — prefer it,
 * and only average when both sides are arcs. Non-arc records are never written, so
 * this cannot move real geometry. Applied to each pose independently by the same
 * rule, which is what keeps the two planes structurally identical and the weld
 * intact for every t.
 */
function weldArcJoints(buf, segs, TEX_W, arcSet) {
  const n = segs.length;
  if (n < 2) return;
  const TOL = 1e-2;   // far under any real vertex spacing, far over the round-trip error
  const off = new Array(n), isArc = new Array(n);
  for (let i = 0; i < n; i++) {
    off[i] = 4 * (segs[i].hy * TEX_W + segs[i].hx);
    isArc[i] = (segs[i].segType & 3) === SEG_ARC_T && arcSet.has(off[i]);
  }
  const endSlot = (i) => {
    const t = segs[i].segType & 3;
    if (isArc[i] || t === 0 /* LINE */) return off[i] + 6;   // endpoint-form arc: p4 at +6
    if (t === 1 /* QUAD */) return off[i] + 8;
    return off[i] + 10;                                      // CUBIC
  };
  const startSlot = (i) => off[i] + 4;
  // Consecutive in path order, plus the wrap that closes the last subpath.
  for (let k = 0; k < n; k++) {
    const i = k, j = (k + 1) % n;
    if (!isArc[i] && !isArc[j]) continue;      // both stored exactly — already agree
    const ei = endSlot(i), sj = startSlot(j);
    const dx = buf[ei] - buf[sj], dy = buf[ei + 1] - buf[sj + 1];
    if (Math.abs(dx) > TOL || Math.abs(dy) > TOL) continue;   // a genuine subpath break
    let cx, cy;
    if (!isArc[i])      { cx = buf[ei];     cy = buf[ei + 1]; }        // exact side wins
    else if (!isArc[j]) { cx = buf[sj];     cy = buf[sj + 1]; }
    else                { cx = (buf[ei] + buf[sj]) * 0.5;
                          cy = (buf[ei + 1] + buf[sj + 1]) * 0.5; }
    if (isArc[i]) { buf[ei] = cx; buf[ei + 1] = cy; }
    if (isArc[j]) { buf[sj] = cx; buf[sj + 1] = cy; }
  }
}

const SEG_ARC_T = 3;
const EMPTY_I32 = new Int32Array(0);

/**
 * Adjacency table for rebuilding the JOIN TEXEL of every STROKED segment each
 * frame. Rows are flat triples (selfOff, prevOff, nextOff) in curve-float units;
 * -1 means "free end" (no neighbour).
 *
 * Why this can't ride the blind lerp: the join texel holds
 * (prev.endTangent, next.startTangent) as UNIT vectors, and the stroke shader
 * builds its joins and miters off them. Interpolating two unit vectors gives a
 * vector that is neither unit nor tangent to the lerped curve — it shortens
 * toward zero as the two poses' tangents diverge, and at a half turn it vanishes
 * outright. The stroke geometry then divides by it: joins fly off as spurious
 * discs and spokes, which is what a morphing outline looked like.
 *
 * The geometry is lerped, so its tangents must be RECOMPUTED from it, not
 * interpolated. The ADJACENCY, on the other hand, is topology — and endpoint-form
 * arcs keep every joint welded for all t (prepareArcMorph), so who-meets-whom
 * cannot change mid-morph. Resolve it once here; per frame, only the trig.
 */
function buildJoinTable(src, plan, TEX_W, srcEp, segTables, arcSet) {
  const EP = 1e-5;
  const rows = [];
  for (const m of plan.matched) {
    const segs = segTables.get(m.srcIdx);
    if (!segs || segs.length < 1) continue;
    const n = segs.length;
    const offs = new Array(n), isArc = new Array(n);
    for (let i = 0; i < n; i++) {
      offs[i] = 4 * (segs[i].hy * TEX_W + segs[i].hx);
      isArc[i] = (segs[i].segType & 3) === SEG_ARC_T && arcSet.has(offs[i]);
    }
    // Fill-only shapes carry a zeroed join texel that nothing reads — skip them
    // rather than write tangents no walker will look at. (The join texel trails
    // the DATA texels, and a LINE has one where every other type has two, so its
    // join sits 4 floats earlier. Reading the wrong slot here would misread the
    // NEXT record's header as a tangent.)
    let stroked = false;
    for (let i = 0; i < n; i++) {
      const j = joinSlot(offs[i], segs[i].segType);
      if (srcEp[j] !== 0 || srcEp[j + 1] !== 0 || srcEp[j + 2] !== 0 || srcEp[j + 3] !== 0) { stroked = true; break; }
    }
    if (!stroked) continue;
    // Endpoints, read from the ENDPOINT-form plane — the one place they are exact.
    // Centre form has no stored endpoints, so they'd have to be re-derived through
    // trig, and in float32 two arcs sharing a corner recover it up to ~2e-4 apart
    // (see weldArcJoints, which is precisely why srcEp's are welded). Match those
    // against a 1e-5 tolerance and every arc-to-arc joint fails to pair: prev/next
    // come back -1, the tangents get written as ZERO, and the shader reads zero as
    // a FREE end — so it caps the stroke instead of joining it. Outlines come out
    // square-cornered.
    const sp = new Array(n), ep = new Array(n);
    for (let i = 0; i < n; i++) {
      sp[i] = segEndpointFromRecord(srcEp, offs[i], segs[i].segType, true, isArc[i]);
      ep[i] = segEndpointFromRecord(srcEp, offs[i], segs[i].segType, false, isArc[i]);
    }
    // Same neighbour rule as the importer (textures.js): prev is whoever ENDS at
    // my start, next is whoever STARTS at my end; a segment that closes on itself
    // is its own neighbour, so a lone full ellipse joins at its seam.
    for (let i = 0; i < n; i++) {
      let prev = -1, next = -1;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        if (Math.abs(ep[j][0] - sp[i][0]) < EP && Math.abs(ep[j][1] - sp[i][1]) < EP) prev = j;
        if (Math.abs(sp[j][0] - ep[i][0]) < EP && Math.abs(sp[j][1] - ep[i][1]) < EP) next = j;
      }
      if (prev < 0 && next < 0
          && Math.abs(sp[i][0] - ep[i][0]) < EP && Math.abs(sp[i][1] - ep[i][1]) < EP) {
        prev = i; next = i;
      }
      rows.push(joinSlot(offs[i], segs[i].segType), segs[i].segType,
                prev < 0 ? -1 : offs[prev], prev < 0 ? -1 : segs[prev].segType,
                next < 0 ? -1 : offs[next], next < 0 ? -1 : segs[next].segType);
    }
  }
  return rows.length ? Int32Array.from(rows) : EMPTY_I32;
}

/** Float offset of a record's JOIN texel. It trails the data texels, and a LINE
 *  carries ONE where quad/cubic/arc carry two. */
function joinSlot(off, segType) {
  return off + ((segType & 3) === 0 ? 8 : 12);
}

/** Recompute every stroked segment's join texel from the CURRENT (lerped, and
 *  for arcs already centre-form) geometry. Runs after arcRecordToCenter. */
export function rebuildJoinTangents(buf, table) {
  for (let i = 0; i < table.length; i += 6) {
    const j = table[i];                       // the join texel's float slot
    const pOff = table[i + 2], pType = table[i + 3];
    const nOff = table[i + 4], nType = table[i + 5];
    if (pOff >= 0) segTangentFromRecord(buf, pOff, pType, false, buf, j);
    else { buf[j] = 0; buf[j + 1] = 0; }
    if (nOff >= 0) segTangentFromRecord(buf, nOff, nType, true, buf, j + 2);
    else { buf[j + 2] = 0; buf[j + 3] = 0; }
  }
}

/** A segment record's start or end point. Mirrors segStart/segEnd. `epArc` says
 *  the record is an ENDPOINT-form arc (p1 at +4, p4 at +6) rather than centre form. */
function segEndpointFromRecord(buf, off, segType, atStart, epArc) {
  const t = segType & 3;
  if (t === SEG_ARC_T && !epArc) {
    const cx = buf[off + 4], cy = buf[off + 5], rx = buf[off + 6], ry = buf[off + 7];
    const th = atStart ? buf[off + 8] : buf[off + 9], phi = buf[off + 10];
    const cp = Math.cos(phi), sp = Math.sin(phi), ct = Math.cos(th), st = Math.sin(th);
    return [cx + rx * cp * ct - ry * sp * st, cy + rx * sp * ct + ry * cp * st];
  }
  if (atStart) return [buf[off + 4], buf[off + 5]];
  // An endpoint-form arc keeps p4 where a LINE keeps p2.
  if (t === 0 /* LINE */ || (t === SEG_ARC_T && epArc)) return [buf[off + 6], buf[off + 7]];
  if (t === 1 /* QUAD */) return [buf[off + 8], buf[off + 9]];
  return [buf[off + 10], buf[off + 11]];   // CUBIC
}

/** Unit tangent of a segment record at its start or end, written to out[o..o+1].
 *  Same derivative conventions (and degenerate fallbacks) as textures.js's
 *  segTangentAt — the numbers have to agree with what the importer would emit. */
function segTangentFromRecord(buf, off, segType, atStart, out, o) {
  const t = segType & 3;
  let dx, dy;
  if (t === 0) {                                   // LINE
    dx = buf[off + 6] - buf[off + 4];
    dy = buf[off + 7] - buf[off + 5];
  } else if (t === 1) {                            // QUAD
    const p1x = buf[off + 4], p1y = buf[off + 5];
    const p2x = buf[off + 6], p2y = buf[off + 7];
    const p3x = buf[off + 8], p3y = buf[off + 9];
    const u = atStart ? 0 : 1, mu = 1 - u;
    dx = 2 * mu * (p2x - p1x) + 2 * u * (p3x - p2x);
    dy = 2 * mu * (p2y - p1y) + 2 * u * (p3y - p2y);
    if (Math.hypot(dx, dy) < 1e-9) { dx = p3x - p1x; dy = p3y - p1y; }
  } else if (t === 2) {                            // CUBIC
    const p1x = buf[off + 4],  p1y = buf[off + 5];
    const p2x = buf[off + 6],  p2y = buf[off + 7];
    const p3x = buf[off + 8],  p3y = buf[off + 9];
    const p4x = buf[off + 10], p4y = buf[off + 11];
    const u = atStart ? 0 : 1, mu = 1 - u;
    dx = 3*mu*mu*(p2x-p1x) + 6*mu*u*(p3x-p2x) + 3*u*u*(p4x-p3x);
    dy = 3*mu*mu*(p2y-p1y) + 6*mu*u*(p3y-p2y) + 3*u*u*(p4y-p3y);
    if (Math.hypot(dx, dy) < 1e-9) {
      dx = p3x - p2x; dy = p3y - p2y;
      if (Math.hypot(dx, dy) < 1e-9) { dx = p4x - p1x; dy = p4y - p1y; }
    }
  } else {                                         // ARC (centre form)
    const rx = buf[off + 6], ry = buf[off + 7];
    const th0 = buf[off + 8], th1 = buf[off + 9], phi = buf[off + 10];
    const th = atStart ? th0 : th1, dth = th1 - th0;
    const cp = Math.cos(phi), sp = Math.sin(phi);
    const ct = Math.cos(th), st = Math.sin(th);
    dx = (-cp * rx * st - sp * ry * ct) * dth;
    dy = (-sp * rx * st + cp * ry * ct) * dth;
  }
  const mag = Math.hypot(dx, dy);
  if (mag < 1e-12) { out[o] = 0; out[o + 1] = 0; return; }
  out[o] = dx / mag; out[o + 1] = dy / mag;
}

/** An arc participates in the endpoint-form lerp only if endpoint form can
 *  actually denote it: a non-empty sweep, short of the full turn at which p1 == p4
 *  stops picking out an ellipse (import caps records at a half turn, so this is a
 *  backstop). A ZERO radius is ALLOWED — a flat ellipse (or a point) is exactly how
 *  a morph "appears from flat", and endpoint form denotes it fine: the radius is
 *  just a number that lerps 0 → R. arcRecordToEndpoint recovers its endpoints by
 *  forward evaluation (no radius division) and arcCentre guards the ry == 0 frame.
 *  Otherwise it keeps centre form and rides the blind lerp — no worse than before. */
function arcRecordMorphable(buf, off) {
  const rx = buf[off + 6], ry = buf[off + 7];
  const dth = buf[off + 9] - buf[off + 8];
  return Number.isFinite(rx) && Number.isFinite(ry) && Number.isFinite(dth) && dth !== 0
    && Math.abs(dth) < 2 * Math.PI - 1e-6;
}

/**
 * Write the endpoint form of the arc at float `off` in `centre` into `out`.
 *
 * Record layout (floats, from the header texel):
 *   [0..3]   header (segType, freeStart, freeEnd, startDist)  — copied as-is
 *   [4..7]   CENTRE (cx, cy, rx, ry)        ENDPOINT (p1x, p1y, p4x, p4y)
 *   [8..11]  CENTRE (thetaS, thetaE, phi,_) ENDPOINT (rx, ry, phi, flags)
 *   [12..15] join tangents — left alone; the geometry is unchanged, so the
 *            endpoint tangents it holds are still the right ones.
 * `flags` packs large_arc | sweep<<1 — structural, identical in both poses (they
 * describe the same arc traversed the same way), so lerping it is a no-op.
 */
function arcRecordToEndpoint(centre, out, off) {
  const cx = centre[off + 4], cy = centre[off + 5];
  const rx = centre[off + 6], ry = centre[off + 7];
  const th0 = centre[off + 8], th1 = centre[off + 9], phi = centre[off + 10];
  const dth = th1 - th0;
  const cp = Math.cos(phi), sp = Math.sin(phi);
  const at = (th) => {
    const c = Math.cos(th), s = Math.sin(th);
    return [cx + rx * cp * c - ry * sp * s, cy + rx * sp * c + ry * cp * s];
  };
  const p1 = at(th0), p4 = at(th1);
  const large = Math.abs(dth) > Math.PI ? 1 : 0;
  const sweep = dth > 0 ? 1 : 0;
  out[off + 4] = p1[0]; out[off + 5] = p1[1];
  out[off + 6] = p4[0]; out[off + 7] = p4[1];
  out[off + 8] = rx;    out[off + 9] = ry;
  out[off + 10] = phi;  out[off + 11] = large | (sweep << 1);
}

/**
 * Force both poses onto ONE (large, sweep) pair. The flags are STRUCTURAL — they
 * pick which of the four arcs through p1 and p4 on this ellipse is meant — and
 * they cannot ride the componentwise lerp with everything else.
 *
 * They are also the one field that genuinely differs between poses in practice.
 * A projected cylinder cap sweeps through edge-on as the solid turns, and the
 * visible arc reverses its bulge on the way out: sweep flips. Lerp the packed
 * flag float across that and it lands BETWEEN — `int()` then yields a
 * combination NEITHER pose ever had (typically large=1 on a small arc), and
 * arcEndpointToCenter dutifully selects the enormous complementary arc. The shape
 * detonates. Every blow-up of this kind traces back to exactly that.
 *
 * There is no continuous arc path between the two spellings — flipping sweep
 * mirrors the arc across its chord — EXCEPT through the degenerate pose where the
 * ellipse is flat (a radius goes to zero) and both spellings collapse onto the
 * chord. That is precisely where the flip happens, and an exporter that cuts a
 * keyframe there leaves one side of the bracket holding a flat, direction-agnostic
 * arc whose flags mean nothing.
 *
 * So: keep the flags of the pose that is LESS degenerate, and give them to the
 * other. On the flat pose the arc is a line either way, so the substitution costs
 * nothing; on the healthy pose the arc stays exactly as authored. If neither is
 * degenerate the poses genuinely disagree — hold one anyway, since a slightly
 * wrong bulge beats a shape that explodes.
 */
function holdArcFlags(srcEp, dstEp, off) {
  const sF = srcEp[off + 11], dF = dstEp[off + 11];
  if (sF === dF) return;
  const sMin = Math.min(Math.abs(srcEp[off + 8]), Math.abs(srcEp[off + 9]));
  const dMin = Math.min(Math.abs(dstEp[off + 8]), Math.abs(dstEp[off + 9]));
  const f = sMin >= dMin ? sF : dF;      // the fatter ellipse's spelling wins
  srcEp[off + 11] = f;
  dstEp[off + 11] = f;
}

/** Pull dst's (rx, ry, phi) onto the branch nearest src's. The ellipse is
 *  invariant under phi += pi, and under phi += pi/2 with the radii swapped, so
 *  the same arc has many spellings; lerping between two different ones spins it.
 *  Endpoint form has no theta to correct, so this is just the ellipse's own
 *  symmetry group — pick the spelling that travels least. */
function harmonizeEndpointArc(srcEp, dstEp, off) {
  const sRx = srcEp[off + 8], sRy = srcEp[off + 9], sPhi = srcEp[off + 10];
  const rx = dstEp[off + 8], ry = dstEp[off + 9], phi = dstEp[off + 10];
  let best = null;
  for (const swap of [0, 1]) {
    const dRx = swap ? ry : rx, dRy = swap ? rx : ry;
    // phi is defined mod pi; the swapped spelling shifts it a quarter turn.
    let p = phi + (swap ? Math.PI / 2 : 0);
    p -= Math.PI * Math.round((p - sPhi) / Math.PI);
    const cost = Math.abs(p - sPhi) * (Math.abs(sRx) + Math.abs(sRy))
               + Math.abs(dRx - sRx) + Math.abs(dRy - sRy);
    if (!best || cost < best.cost) best = { cost, rx: dRx, ry: dRy, phi: p };
  }
  dstEp[off + 8] = best.rx; dstEp[off + 9] = best.ry; dstEp[off + 10] = best.phi;
}

/**
 * The inverse, applied per frame by setT: read the LERPED endpoint-form record
 * at `off` and write the centre-form record the shader reads. Exact — this is
 * SVG's own endpoint→centre conversion (F.6.5), radii-correction and all.
 */
export function arcRecordToCenter(buf, off) {
  const p1x = buf[off + 4], p1y = buf[off + 5];
  const p4x = buf[off + 6], p4y = buf[off + 7];
  let rx = Math.abs(buf[off + 8]), ry = Math.abs(buf[off + 9]);
  const phi = buf[off + 10];
  // Round, don't truncate: the flags are held constant across the lerp
  // (holdArcFlags), so this only has to survive float32 round-off — but a bit
  // that drifts a hair low would silently select a different arc.
  const flags = Math.round(buf[off + 11]) | 0;
  const large = flags & 1, sweep = (flags >> 1) & 1;

  const cp = Math.cos(phi), sp = Math.sin(phi);
  const mx = (p1x - p4x) * 0.5, my = (p1y - p4y) * 0.5;
  const x1p =  cp * mx + sp * my;
  const y1p = -sp * mx + cp * my;
  if (rx === 0 || ry === 0) {
    const dx = p4x - p1x, dy = p4y - p1y;
    const chord = Math.hypot(dx, dy);
    let cx = p1x, cy = p1y, outPhi = phi, th0 = 0;
    if (chord > 0) {
      cx = (p1x + p4x) * 0.5; cy = (p1y + p4y) * 0.5;
      const angle = Math.atan2(dy, dx), r = chord * 0.5;
      if (ry === 0) { rx = r; ry = 0; outPhi = angle; th0 = Math.PI; }
      else { rx = 0; ry = r; outPhi = angle - Math.PI * 0.5; th0 = -Math.PI * 0.5; }
    } else { rx = 0; ry = 0; }
    const dth = sweep ? Math.PI : -Math.PI;
    buf[off + 4] = cx; buf[off + 5] = cy;
    buf[off + 6] = rx; buf[off + 7] = ry;
    buf[off + 8] = th0; buf[off + 9] = th0 + dth;
    buf[off + 10] = outPhi; buf[off + 11] = 0;
    return;
  }
  // SVG F.6.6: scale the radii up if they can't span the chord. Mid-lerp the
  // endpoints move independently of the radii, so this genuinely fires — and it
  // is exactly the right answer when it does.
  const lam = (x1p / rx) ** 2 + (y1p / ry) ** 2;
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let sq = den > 0 ? Math.sqrt(Math.max(num / den, 0)) : 0;
  if (large === sweep) sq = -sq;
  const cxp =  sq * rx * y1p / ry;
  const cyp = -sq * ry * x1p / rx;
  const cx = cp * cxp - sp * cyp + (p1x + p4x) * 0.5;
  const cy = sp * cxp + cp * cyp + (p1y + p4y) * 0.5;
  const ang = (ux, uy, vx, vy) => {
    const n = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    if (n === 0) return 0;
    const c = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / n));
    return (ux * vy - uy * vx < 0) ? -Math.acos(c) : Math.acos(c);
  };
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  const th0 = ang(1, 0, ux, uy);
  let dth = ang(ux, uy, vx, vy);
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  if (sweep && dth < 0) dth += 2 * Math.PI;

  buf[off + 4] = cx;  buf[off + 5] = cy;
  buf[off + 6] = rx;  buf[off + 7] = ry;
  buf[off + 8] = th0; buf[off + 9] = th0 + dth;
  buf[off + 10] = phi; buf[off + 11] = 0;
}

function concatBandPlanes(src, dst, plan, TEX_W, arcPrep, merged, dstRemapped) {
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
  // Read BOTH poses out of the composed planes, not the original bundles: the
  // arc→cubic rewrite (cubicizeMatchedArcs) landed there, so the bundles' own
  // curve data — and the segment types recorded in their bands — are stale for
  // any matched shape. `dstRemapped` already carries dst's curves at src's
  // offsets, which is also why one segment table indexes both.
  if (!merged || !dstRemapped) {
    // No curve buffer to decode — fall back to forwarding src verbatim
    // (will still fragment at t>0).
    return {
      buf: srcBand.buffer.slice(srcBand.byteOffset,
                                srcBand.byteOffset + srcBand.byteLength),
      matchedRewrites: [],
    };
  }
  const segTables = arcPrep && arcPrep.segTables;
  // Arcs the morph carries in ENDPOINT form (prepareArcMorph). Their bounds must
  // be read from the endpoint planes, with the endpoint rule — the centre-form
  // planes hold no lerpable centre for these.
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
    const dstSegs = collectShapeSegs(dst.bandFloats || new Float32Array(dst.bands), TEX_W, dGlyph, dBandsY, dBandsX);
    // Matched-topology invariant: srcSegs.length === dstSegs.length.
    // (Both bundles emit segments in path order, which is what lets dst's
    // curves sit at src's offsets in the first place.)
    if (srcSegs.length !== dstSegs.length) {
      // Segment counts diverge — can't pair by index; skip the union
      // rewrite and fall through to src-only bands for this shape.
      continue;
    }
    // STROKE PAD. The importer widens each segment's break value by the stroke's
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
    const joinStyle = srcMeta[m.srcIdx * stride + 25] | 0;   // MT_CAP_JOIN.y
    const miterLim = srcMeta[m.srcIdx * stride + 26];        // MT_CAP_JOIN.z
    const pad = (joinStyle === 0 /* JOIN_MITER */ || joinStyle === 4 /* JOIN_ARCS */)
      ? halfW * Math.max(1, miterLim || 4)
      : halfW;

    // For each segment: read the control-polygon bbox from BOTH poses at the
    // same offset, union them, and store the per-axis maxes for the descending
    // sort the shader's early-out relies on.
    const segs = [];
    for (const s of srcSegs) {
      const ep = epArcs.has(4 * (s.hy * TEX_W + s.hx));
      const sBbox = readSegBbox(ep ? srcEp : merged,      TEX_W, s.hx, s.hy, s.segType, ep);
      const dBbox = readSegBbox(ep ? dstEp : dstRemapped, TEX_W, s.hx, s.hy, s.segType, ep);
      segs.push({
        hx: s.hx, hy: s.hy, segType: s.segType,
        // Union per-axis extents over [src, dst] poses, then the stroke's reach.
        maxX: Math.max(sBbox.maxX, dBbox.maxX) + pad,
        maxY: Math.max(sBbox.maxY, dBbox.maxY) + pad,
      });
    }
    matchedRewrites.push({ srcIdx: m.srcIdx, segs });
  }
  // Layout per matched shape:
  //   2 H-band header texels   (counts, arrIdx)
  //   2 V-band header texels   (counts, arrIdx)
  //   ceil(N/2) texels of H-band entries (2 per texel, sorted descending by maxX)
  //   ceil(N/2) texels of V-band entries (2 per texel, sorted descending by maxY)
  // H and V arrays are separate because they sort by different axes;
  // sharing one array would break the descending-sort invariant the
  // shader's early-out relies on.
  let appendTexels = 0;
  const layouts = matchedRewrites.map(r => {
    const headers = 4;
    const hArr = Math.ceil(r.segs.length / 2);
    const vArr = Math.ceil(r.segs.length / 2);
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
    // Packed entry pairs: (loc0, brk0, loc1, brk1), loc = hy*4096 + hx; an odd tail pads
    // with a sentinel break so a stray walk stops immediately. Type is positional (the
    // sort groups line -> quad -> cubic -> arc, matching the header counts).
    const packPairs = (sorted, key, base) => {
      for (let i = 0; i < sorted.length; i += 2) {
        const s = sorted[i], t = sorted[i + 1];
        texelWrite(out, TEX_W, base + (i >> 1),
                   s.hy * TEX_W + s.hx, s[key],
                   t ? t.hy * TEX_W + t.hx : 0, t ? t[key] : -1e30);
      }
    };
    packPairs(sortByMaxThenType(layout.segs, 'x'), 'maxX', hArrBase);   // descending maxX
    packPairs(sortByMaxThenType(layout.segs, 'y'), 'maxY', vArrBase);   // descending maxY
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
    const counts = [ht[0] | 0, ht[1] | 0, ht[2] | 0, ht[3] | 0];
    const nTotal = counts[0] + counts[1] + counts[2] + counts[3];
    const arrIdx = ot[0] | 0;
    for (let i = 0; i < nTotal; i++) {
      // packed entries: 2 per texel, (loc0, brk0, loc1, brk1); loc = hy*4096 + hx
      const t = bandTexelAt(bandFloats, TEX_W, glyphLocIdx + arrIdx + (i >> 1));
      const loc = t[(i & 1) << 1] | 0;
      const hx = loc & 4095, hy = loc >> 12;
      const key = hx + ',' + hy;
      if (seen.has(key)) continue;
      seen.add(key);
      // segType is positional: the lists are type-grouped, so entry i's type is the
      // count bucket it falls into (line -> quad -> cubic -> arc)
      let segType = 0, acc = counts[0];
      while (i >= acc && segType < 3) { segType++; acc += counts[segType]; }
      segs.push({ hx, hy, segType });
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
///
/// `epArc` selects how an ARC's two data texels are read. A morph's planes hold
/// arcs in ENDPOINT form — (p1, p4), (rx, ry, phi, flags) — because that is the
/// only exact form a componentwise lerp can carry (see prepareArcMorph); every
/// other caller hands us CENTRE form. The two need different bounds, and reading
/// one as the other yields silent nonsense, so the caller must say which it has.
function readSegBbox(curveFloats, TEX_W, hx, hy, segType, epArc = false) {
  const baseTex = hy * TEX_W + hx;
  function ctrl(texOffset, slot) {
    const t = baseTex + texOffset;
    const off = t * 4 + slot;
    return curveFloats[off];
  }
  // Collect control points by type.
  const xs = [], ys = [];
  if (segType === 3 && !epArc) {  // ARC, CENTRE form — a static (unlerped) shape.
    // Full-ellipse extent: exact in phi and conservative in theta. Rotation
    // contributes both radii to each axis; understating it can drop crossings.
    const cx = ctrl(1, 0), cy = ctrl(1, 1);
    const rx = Math.abs(ctrl(1, 2)), ry = Math.abs(ctrl(1, 3));
    const phi = ctrl(2, 2);
    const cp = Math.cos(phi), sp = Math.sin(phi);
    const wx = Math.hypot(rx * cp, ry * sp);
    const wy = Math.hypot(rx * sp, ry * cp);
    return { minX: cx - wx, maxX: cx + wx, minY: cy - wy, maxY: cy + wy };
  }
  if (segType === 0) {            // LINE
    xs.push(ctrl(1, 0), ctrl(1, 2));
    ys.push(ctrl(1, 1), ctrl(1, 3));
  } else if (segType === 1) {     // QUAD
    xs.push(ctrl(1, 0), ctrl(1, 2), ctrl(2, 0));
    ys.push(ctrl(1, 1), ctrl(1, 3), ctrl(2, 1));
  } else if (segType === 2) {     // CUBIC
    xs.push(ctrl(1, 0), ctrl(1, 2), ctrl(2, 0), ctrl(2, 2));
    ys.push(ctrl(1, 1), ctrl(1, 3), ctrl(2, 1), ctrl(2, 3));
  } else {                        // ARC, ENDPOINT form — a morphing shape.
    // These numbers become the band break values, and the shader's walker trusts
    // them as descending upper bounds: it stops at the first segment whose max
    // can't reach the pixel. Understate one and the walk stops early, skipping
    // segments that DO cross the pixel's ray; the dropped crossings flip the
    // winding parity and the fill tears. So the box must hold for EVERY t, since
    // the caller unions the two poses' boxes and reuses that for the whole morph.
    //
    // The obvious box — centre ± radii — is unusable for that. It is wrong even
    // statically (it assumes phi == 0; a rotated ellipse reaches
    // hypot(rx·cosφ, ry·sinφ) in x), and worse, the arc's CENTRE is not a lerped
    // quantity at all: the morph interpolates endpoint form, and the centre is
    // re-derived from the lerped endpoints each frame. There is nothing to union.
    //
    // Anchor on what IS lerped. p1 and p4 travel straight (they are stored
    // floats), and rx, ry lerp. Every point of an ellipse lies within
    // R = max(rx, ry) of its centre, and the centre is itself within R of any
    // point ON the ellipse — so the whole arc lies within 2R of p1, and likewise
    // within 2R of p4:
    //     arc(t) ⊆ box(p1(t), 2R(t)) ∩ box(p4(t), 2R(t))
    // Both p ± 2R are affine in t, so each box's union over t is just the union
    // of its two endpoint boxes — and intersecting the two unions is still sound
    // (⋃(A∩B) ⊆ (⋃A) ∩ (⋃B)). Hence: per pose, emit both boxes; the caller
    // unions across poses; a later intersection tightens it. Looser than a tight
    // fit, but provably safe for every intermediate pose — and per this file's
    // standing trade-off, correctness beats fill rate for animation.
    const p1x = ctrl(1, 0), p1y = ctrl(1, 1);
    const p4x = ctrl(1, 2), p4y = ctrl(1, 3);
    const r2 = 2 * Math.max(Math.abs(ctrl(2, 0)), Math.abs(ctrl(2, 1)));
    xs.push(p1x - r2, p1x + r2, p4x - r2, p4x + r2);
    ys.push(p1y - r2, p1y + r2, p4y - r2, p4y + r2);
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
