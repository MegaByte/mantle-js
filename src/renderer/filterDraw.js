// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import {
  hasTrackedOverrideRevision,
  overrideRowKey,
  sameOverrideContent,
} from '../core/overrideRevision.js';
import { morphFilterOpacity } from '../core/morphFilters.js';
import { deleteGlResource, deleteProgramWhenLinked, trackGlResource } from './contextResources.js';
// filterDraw.js — SVG filter-graph draw (cache keys, FBO composite, scissor,
// blur/morphology/convolve in-place passes). Attached onto the renderer context.

import { computeNodeBboxes } from '../filterGraph/bbox.js';
import { feImagePlacement, primitiveSubregions } from '../filterGraph/feImagePlace.js';
import { metaStrokeReachFactor } from '../bundle/strokeReach.js';
import { widenMorphRowForArcs } from '../core/morphArcBounds.js';
import {
  blurPasses,
  blurAxesPx,
  morphAxesPx,
  morphRadiusPasses,
  setGaussTaps,
} from '../filterGraph/blurKernel.js';
import { flipConvolveKernel } from '../filterGraph/convolveKernel.js';
import {
  FILT_KIND_BLUR,
  FILT_KIND_BLUR_LINEAR,
  META_FLOATS_PER_SHAPE,
  META_FILL_R,
  META_FILL_G,
  META_FILL_B,
  META_FILL_A,
  META_STROKE_A,
  META_STROKE_W,
  META_ATLAS_Y,
  META_ATLAS_W,
  META_FLAGS_SHAPE,
  META_FILL_GRAD,
  META_STROKE_GRAD,
  META_CLIP_ID,
  META_MASK_ID,
  META_BLEND_MODE,
  META_ISOLATION,
  META_IMAGE_ID,
  META_ATLAS_IS_PATTERN,
  META_COLR_GRAPH,
  META_STROKE_IMAGE_ID,
  META_FILTER_ID,
} from '../bundle/layout.js';
import {
  graphFrameNeed,
  graphReach,
  graphSeenMargins,
  singleKindReach,
  frameGeometry,
  frameWorldMatrix,
  FRAME_SLACK_PX,
} from './filterFrame.js';
import { beginFullscreen } from '../filterGraph/svgFilterShared.js';

// A bundle extent used as a divisor: any positive extent is real at any scale, so only an extent that is exactly zero
// (or not a number) has no scale to speak of and takes the legacy stand-in. An absolute floor such as 1e-6 compressed the
// sigma, the region and the px-per-em of art authored below ~2^-20 units.
const extentOr = (v, standIn) => (v > 0 ? v : standIn);
const SCISSOR_MAX = 2 ** 30 - 1;
// Float32 ulps allowed between a region edge and the integer pixel boundary it was authored on (see _filterRegionRectPx).
const SNAP_TOL = 4 * 2 ** -23;

/** @param {import('./rendererContext.js').RendererContext} R */
function createMaterialIntervalResolver(R, frames, precisionInfo) {
  const precision = precisionInfo?.precision,
    rangeMin = precisionInfo?.rangeMin,
    rangeMax = precisionInfo?.rangeMax;
  if (
    !Number.isInteger(precision) ||
    precision < 4 ||
    !Number.isInteger(rangeMin) ||
    rangeMin < 2 ||
    !Number.isInteger(rangeMax) ||
    rangeMax < 2
  )
    return () => null;
  const unit = 2 ** -precision,
    gamma = (n) => (n * unit) / (1 - n * unit),
    floor = 2 ** (1 - rangeMin);
  const f32 = new Float32Array(1),
    u32 = new Uint32Array(f32.buffer);
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const next = (x, up) => {
    f32[0] = x;
    const v = f32[0];
    if (!Number.isFinite(v)) return v;
    if (v === 0) {
      u32[0] = up ? 1 : 0x80000001;
      return f32[0];
    }
    u32[0] += v > 0 === up ? 1 : -1;
    return f32[0];
  };
  const outward = (x, up) => {
    const y = Math.fround(x);
    return up ? (y < x ? next(y, true) : y) : y > x ? next(y, false) : y;
  };
  const excluded = [
    META_FLAGS_SHAPE,
    META_FILL_GRAD,
    META_STROKE_GRAD,
    META_CLIP_ID,
    META_MASK_ID,
    META_BLEND_MODE,
    META_ISOLATION,
    META_IMAGE_ID,
    META_ATLAS_IS_PATTERN,
    META_COLR_GRAPH,
    META_STROKE_IMAGE_ID,
  ];
  const valid = (row) =>
    row &&
    row.length >= META_FLOATS_PER_SHAPE &&
    excluded.every((i) => row[i] === 0) &&
    row[META_STROKE_A] === 0 &&
    row[META_STROKE_W] === 0;
  const uninformative = () => ({
    nominal: [0, 0, 0, 0],
    materialLo: [0, 0, 0, 0],
    materialHi: [1, 1, 1, 1],
    opacityLo: 0,
    opacityHi: 1,
    uninformative: true,
  });
  const maxFloat = 3.4028234663852886e38;
  const maxArithmetic = Math.min(maxFloat, (2 - 2 ** -precision) * 2 ** rangeMax);
  const loadRadius = (v) => (Math.abs(v) < floor ? Math.abs(v) : 0);
  const mul = (a, ea, b, eb) => {
    const value = a * b,
      prop = Math.abs(a) * eb + Math.abs(b) * ea + ea * eb;
    if (Math.abs(value) + prop > maxArithmetic) return [value, Infinity];
    if (value === 0 && prop === 0) return [0, 0];
    return [value, prop + unit * (Math.abs(value) + prop) + floor];
  };
  const effectiveMatrix = (m, offset) => {
    let identity = true,
      zero = true;
    if (m)
      for (let i = 0; i < 16; i++)
        if (Math.abs(m[i] - (i % 5 === 0 ? 1 : 0)) > 1e-6) identity = false;
    if (offset) for (let i = 0; i < 4; i++) if (Math.abs(offset[i]) > 1e-6) zero = false;
    return !identity || !zero;
  };
  return (shapeIdx, inputScale) => {
    const b = R._handle.bundle,
      d = R.draw,
      stride = b.metaFloatsPerShape;
    if (
      b.numShapes !== 1 ||
      shapeIdx !== 0 ||
      b._nineSliceActive ||
      !(stride >= META_FLOATS_PER_SHAPE) ||
      d.palette ||
      d.channelLerp ||
      d.extClipMode > 0 ||
      frames.some((f) => f.s !== 1)
    )
      return null;
    let paint,
      radius = [0, 0, 0, 0];
    const slots = [META_FILL_R, META_FILL_G, META_FILL_B, META_FILL_A],
      ms = b._morphSrc;
    if (ms) {
      const a = ms.mergedMetaF32,
        z = ms.dstMetaF32,
        t = ms.t;
      if (
        ms.metaStride !== stride ||
        !valid(a) ||
        !valid(z) ||
        (ms.bindingSteps || []).some((e) => e.row !== shapeIdx || e.slot !== META_FILTER_ID) ||
        !Number.isFinite(t) ||
        t < 0 ||
        t > 1
      )
        return null;
      const matched = !ms.matchedSrcIdxs || ms.matchedSrcIdxs.includes(0);
      paint = slots.map((i) => (matched ? a[i] * (1 - t) + z[i] * t : a[i]));
      // Covers endpoint interpolation, uploaded t and final Float32 storage.
      if (matched)
        radius = slots.map((i) => gamma(8) * (Math.abs(a[i]) + Math.abs(z[i])) + 8 * floor);
      else radius = paint.map(loadRadius);
    } else {
      if (!valid(b.metaFloats)) return null;
      paint = slots.map((i) => b.metaFloats[i]);
    }
    if (!ms) radius = paint.map(loadRadius);
    let tint = [1, 1, 1, 1],
      visibility = 1;
    if (d.overrides) {
      const ov = d.overrides.packedBuffer;
      if (
        !hasTrackedOverrideRevision(d.overrides) ||
        !ov ||
        ov.length !== 24 ||
        !Array.from(ov).every(Number.isFinite)
      )
        return null;
      const mask = Math.fround(Math.fround(ov[7]) + 0.5);
      if (!Number.isFinite(mask) || mask < -2147483648 || mask >= 2147483648) return null;
      const bits = Math.trunc(mask);
      if ((bits & ~31) !== 0 || (bits & 2 && ov[19] !== 0) || (bits & 4 && ov[20] !== 0))
        return null;
      if (bits & 1) {
        paint = [ov[12], ov[13], ov[14], ov[15]];
        radius = paint.map(loadRadius);
      }
      tint = [ov[8], ov[9], ov[10], ov[11]];
      visibility = clamp(ov[6]);
    }
    if (
      !paint.every(Number.isFinite) ||
      !tint.every(Number.isFinite) ||
      !Number.isFinite(d.alpha) ||
      !Number.isFinite(inputScale) ||
      inputScale <= 0
    )
      return null;
    tint = tint.map(Math.fround);
    const drawAlpha = Math.fround(d.alpha),
      uploadedScale = Math.fround(inputScale),
      scale = uploadedScale > 0 ? uploadedScale : 1;
    if (!tint.every(Number.isFinite) || !Number.isFinite(drawAlpha) || !Number.isFinite(scale))
      return uninformative();
    const scaleError = uploadedScale > 0 && uploadedScale < floor ? 1 : loadRadius(scale);
    let alpha = mul(drawAlpha, loadRadius(drawAlpha), visibility, loadRadius(visibility));
    alpha = mul(tint[3], loadRadius(tint[3]), ...alpha);
    alpha = mul(...alpha, scale, scaleError);
    alpha = mul(paint[3], radius[3], ...alpha);
    const values = [],
      errors = [];
    for (let i = 0; i < 3; i++) {
      const pair = mul(paint[i], radius[i], tint[i], loadRadius(tint[i]));
      values.push(pair[0]);
      errors.push(pair[1]);
    }
    values.push(alpha[0]);
    errors.push(alpha[1]);
    const cm = d.colorMatrix,
      offset = d.colorMatrixOffset;
    if (cm && (cm.length !== 16 || !Array.from(cm).every(Number.isFinite))) return null;
    if (offset && (offset.length !== 4 || !Array.from(offset).every(Number.isFinite))) return null;
    const enabled = effectiveMatrix(cm, offset);
    let nominal = values,
      error = errors;
    if (enabled) {
      const matrix = cm
        ? Array.from(cm, Math.fround)
        : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      const bias = offset ? Array.from(offset, Math.fround) : [0, 0, 0, 0];
      if (!matrix.every(Number.isFinite) || !bias.every(Number.isFinite)) return uninformative();
      nominal = [];
      error = [];
      for (let i = 0; i < 4; i++) {
        let value = bias[i],
          sumAbs = Math.abs(bias[i]),
          prop = 0;
        for (let j = 0; j < 4; j++) {
          const m = matrix[4 * j + i];
          value += m * values[j];
          sumAbs += Math.abs(m * values[j]);
          prop += Math.abs(m) * errors[j] + loadRadius(m) * (Math.abs(values[j]) + errors[j]);
        }
        nominal.push(value);
        error.push(
          sumAbs + prop > maxArithmetic ? Infinity : prop + gamma(8) * (sumAbs + prop) + 8 * floor,
        );
      }
    }
    if (!nominal.every(Number.isFinite) || !error.every((v) => Number.isFinite(v) && v >= 0))
      return uninformative();
    error = error.map(
      (v, i) =>
        v * (1 + 64 * Number.EPSILON) + 64 * Number.EPSILON * Math.max(1, Math.abs(nominal[i])),
    );
    // Enabled recolor clamps before coverage. Without it, retain raw opacity
    // limits so the terminal resolver can account for RGBA8 saturation.
    const rawLo = Math.max(0, nominal[3] - error[3]),
      rawHi = Math.max(0, nominal[3] + error[3]);
    if (rawHi > maxArithmetic || !Number.isFinite(Math.fround(rawHi))) return uninformative();
    const materialLo = [],
      materialHi = [];
    for (let i = 0; i < 4; i++) {
      const lo = i === 3 && !enabled ? rawLo : clamp(nominal[i] - error[i]);
      const hi = i === 3 && !enabled ? rawHi : clamp(nominal[i] + error[i]);
      materialLo.push(outward(lo, false));
      materialHi.push(outward(hi, true));
    }
    return {
      nominal: nominal.map((v, i) => (i === 3 && !enabled ? Math.max(0, v) : clamp(v))),
      materialLo,
      materialHi,
      opacityLo: outward(enabled ? materialLo[3] : rawLo, false),
      opacityHi: outward(enabled ? materialHi[3] : rawHi, true),
      uninformative: false,
    };
  };
}

export function attachFilterDraw(R) {
  const { gl, coverVao, arScale, viewportSize, bindFb, ensurePingFbo } = R;

  // ── Uniform locations (derived once from the R-published programs) ─────
  // vUV → texture-uv maps. Every filter RT covers a canvas RECT, and an input's
  // rect need not be the output's; uv is an affine remap of vUV through the two.
  // See src/shaders/_filterRect.glsl. IDENTITY = (1, 1, 0, 0), which is what a
  // canvas-sized input in a canvas-sized pass gets.

  const blurUTex = gl.getUniformLocation(R.blurProg, 'uTex');
  const blurUTexel = gl.getUniformLocation(R.blurProg, 'uTexel');
  const blurUInMap = gl.getUniformLocation(R.blurProg, 'uInMap');
  const blurUDir = gl.getUniformLocation(R.blurProg, 'uDir');
  const blurUW0 = gl.getUniformLocation(R.blurProg, 'uW0');
  const blurUCount = gl.getUniformLocation(R.blurProg, 'uTapCount');
  const blurUTaps = gl.getUniformLocation(R.blurProg, 'uTaps');

  const bbUTex = R.boxBlurProg ? gl.getUniformLocation(R.boxBlurProg, 'uTex') : null;
  const bbUTexel = R.boxBlurProg ? gl.getUniformLocation(R.boxBlurProg, 'uTexel') : null;
  const bbUInMap = R.boxBlurProg ? gl.getUniformLocation(R.boxBlurProg, 'uInMap') : null;
  const bbUDir = R.boxBlurProg ? gl.getUniformLocation(R.boxBlurProg, 'uDir') : null;
  const bbURadius = R.boxBlurProg ? gl.getUniformLocation(R.boxBlurProg, 'uRadius') : null;
  const blurUInPast = gl.getUniformLocation(R.blurProg, 'uInPast');
  const bbUInPast = R.boxBlurProg ? gl.getUniformLocation(R.boxBlurProg, 'uInPast') : null;

  const morphUTex = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uTex') : null;
  const morphUTexel = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uTexel') : null;
  const morphUInMap = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uInMap') : null;
  const morphUDir = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uDir') : null;
  const morphURadius = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uRadius') : null;
  const morphUOperator = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uOperator') : null;

  const convUTex = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uTex') : null;
  const convUKernel = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uKernel') : null;
  const convUTexel = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uTexel') : null;
  const convUInMap = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uInMap') : null;
  const convUOrder = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uOrder') : null;
  const convUTarget = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uTarget') : null;
  const convUDivisor = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uDivisor') : null;
  const convUBias = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uBias') : null;
  const convUEdgeMode = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uEdgeMode') : null;
  const convUPreserve = R.convolveProg
    ? gl.getUniformLocation(R.convolveProg, 'uPreserveAlpha')
    : null;

  const cmUTex = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uTex') : null;
  const cmUInMap = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uInMap') : null;
  const cmULinearZeroBorder = R.colorMatrixProg
    ? gl.getUniformLocation(R.colorMatrixProg, 'uLinearZeroBorder')
    : null;
  const cmUM0 = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uM0') : null;
  const cmUM1 = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uM1') : null;
  const cmUM2 = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uM2') : null;
  const cmUM3 = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uM3') : null;
  const cmUMOff = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uMOff') : null;
  const cmUCsIn = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uCsIn') : null;
  const cmUCsOut = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uCsOut') : null;

  const fcUIn1 = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uIn1') : null;
  const fcUIn2 = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uIn2') : null;
  const fcUIn1Map = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uIn1Map') : null;
  const fcUIn2Map = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uIn2Map') : null;
  const fcUOp = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uOp') : null;
  const fcUPD = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uPD') : null;
  const fcUK = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uK') : null;
  const fcUCsIn = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uCsIn') : null;
  const fcUPixelAligned = R.feCompositeProg
    ? gl.getUniformLocation(R.feCompositeProg, 'uCoveragePixelAligned')
    : null;
  const fcUCoverageIn1 = R.feCompositeProg
    ? gl.getUniformLocation(R.feCompositeProg, 'uCoverageIn1')
    : null;
  const fcUCoverageIn2 = R.feCompositeProg
    ? gl.getUniformLocation(R.feCompositeProg, 'uCoverageIn2')
    : null;
  const fcUIn1Offset = R.feCompositeProg
    ? gl.getUniformLocation(R.feCompositeProg, 'uCoverageIn1Offset')
    : null;
  const fcUIn2Offset = R.feCompositeProg
    ? gl.getUniformLocation(R.feCompositeProg, 'uCoverageIn2Offset')
    : null;
  const fcUCoverage = R.feCompositeProg
    ? gl.getUniformLocation(R.feCompositeProg, 'uCoverageResolve')
    : null;
  const fcUUnitOpacity = R.feCompositeProg
    ? gl.getUniformLocation(R.feCompositeProg, 'uSourceCoverageScale')
    : null;
  const fcUMaterialLo = R.feCompositeProg
    ? gl.getUniformLocation(R.feCompositeProg, 'uSourceMaterialLo')
    : null;
  const fcUMaterialHi = R.feCompositeProg
    ? gl.getUniformLocation(R.feCompositeProg, 'uSourceMaterialHi')
    : null;

  const fbUIn1 = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uIn1') : null;
  const fbUIn2 = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uIn2') : null;
  const fbUIn1Map = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uIn1Map') : null;
  const fbUIn2Map = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uIn2Map') : null;
  const fbUMode = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uMode') : null;
  const fbUCsIn = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uCsIn') : null;

  const ftUTex = R.feTileProg ? gl.getUniformLocation(R.feTileProg, 'uTex') : null;
  const ftUTileA = R.feTileProg ? gl.getUniformLocation(R.feTileProg, 'uTileA') : null;
  const ftUTileB = R.feTileProg ? gl.getUniformLocation(R.feTileProg, 'uTileB') : null;

  const ftbUBaseFreq = R.feTurbulenceProg
    ? gl.getUniformLocation(R.feTurbulenceProg, 'uBaseFreq')
    : null;
  const ftbUNumOctaves = R.feTurbulenceProg
    ? gl.getUniformLocation(R.feTurbulenceProg, 'uNumOctaves')
    : null;
  const ftbUSeed = R.feTurbulenceProg ? gl.getUniformLocation(R.feTurbulenceProg, 'uSeed') : null;
  const ftbUKind = R.feTurbulenceProg ? gl.getUniformLocation(R.feTurbulenceProg, 'uKind') : null;
  const ftbUTilePos = R.feTurbulenceProg
    ? gl.getUniformLocation(R.feTurbulenceProg, 'uTilePos')
    : null;
  const ftbUTileSize = R.feTurbulenceProg
    ? gl.getUniformLocation(R.feTurbulenceProg, 'uTileSize')
    : null;
  const ftbUStitch = R.feTurbulenceProg
    ? gl.getUniformLocation(R.feTurbulenceProg, 'uStitch')
    : null;
  const ftbUStitchPos = R.feTurbulenceProg
    ? gl.getUniformLocation(R.feTurbulenceProg, 'uStitchPos')
    : null;
  const ftbUStitchSize = R.feTurbulenceProg
    ? gl.getUniformLocation(R.feTurbulenceProg, 'uStitchSize')
    : null;
  const fimgUIn = R.feImageProg ? gl.getUniformLocation(R.feImageProg, 'uIn') : null;
  // The PLACED path (an external image) reads the atlas slot and the rects; the region fit
  // reads its two maps, composed on the CPU (primitives/image.js feImageMaps).
  const fimgUAtlasSize = R.feImageProg ? gl.getUniformLocation(R.feImageProg, 'uAtlasSize') : null;
  const fimgUAtlasRect = R.feImageProg ? gl.getUniformLocation(R.feImageProg, 'uAtlasRect') : null;
  const fimgUPlaced = R.feImageProg ? gl.getUniformLocation(R.feImageProg, 'uPlaced') : null;
  const fimgUOutRect = R.feImageProg ? gl.getUniformLocation(R.feImageProg, 'uOutRect') : null;
  const fimgUImgRect = R.feImageProg ? gl.getUniformLocation(R.feImageProg, 'uImgRect') : null;
  const fimgUClipRect = R.feImageProg ? gl.getUniformLocation(R.feImageProg, 'uClipRect') : null;
  const fimgUImgMap = R.feImageProg ? gl.getUniformLocation(R.feImageProg, 'uImgMap') : null;
  const fimgUAtlasMap = R.feImageProg ? gl.getUniformLocation(R.feImageProg, 'uAtlasMap') : null;

  const fdUIn1 = R.feDisplacementMapProg
    ? gl.getUniformLocation(R.feDisplacementMapProg, 'uIn1')
    : null;
  const fdUIn2 = R.feDisplacementMapProg
    ? gl.getUniformLocation(R.feDisplacementMapProg, 'uIn2')
    : null;
  const fdUScale = R.feDisplacementMapProg
    ? gl.getUniformLocation(R.feDisplacementMapProg, 'uScale')
    : null;
  const fdUTexel = R.feDisplacementMapProg
    ? gl.getUniformLocation(R.feDisplacementMapProg, 'uTexel')
    : null;
  const fdUDispM = R.feDisplacementMapProg
    ? gl.getUniformLocation(R.feDisplacementMapProg, 'uDispM')
    : null;
  const fdUDispUseM = R.feDisplacementMapProg
    ? gl.getUniformLocation(R.feDisplacementMapProg, 'uDispUseM')
    : null;
  const fdUIn1Map = R.feDisplacementMapProg
    ? gl.getUniformLocation(R.feDisplacementMapProg, 'uIn1Map')
    : null;
  const fdUIn2Map = R.feDisplacementMapProg
    ? gl.getUniformLocation(R.feDisplacementMapProg, 'uIn2Map')
    : null;
  const fdUXSel = R.feDisplacementMapProg
    ? gl.getUniformLocation(R.feDisplacementMapProg, 'uXSel')
    : null;
  const fdUYSel = R.feDisplacementMapProg
    ? gl.getUniformLocation(R.feDisplacementMapProg, 'uYSel')
    : null;
  const fdUCsIn2 = R.feDisplacementMapProg
    ? gl.getUniformLocation(R.feDisplacementMapProg, 'uCsIn2')
    : null;

  const flUIn = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uIn') : null;
  const flUTexel = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uTexel') : null;
  const flUInMap = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uInMap') : null;
  const flUOutRect = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uOutRect') : null;
  const flUWorldScale = R.feLightingProg
    ? gl.getUniformLocation(R.feLightingProg, 'uWorldScale')
    : null;
  const flUSurfaceScale = R.feLightingProg
    ? gl.getUniformLocation(R.feLightingProg, 'uSurfaceScale')
    : null;
  const flUK = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uK') : null;
  const flUExponent = R.feLightingProg
    ? gl.getUniformLocation(R.feLightingProg, 'uExponent')
    : null;
  const flULightColor = R.feLightingProg
    ? gl.getUniformLocation(R.feLightingProg, 'uLightColor')
    : null;
  const flUMode = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uMode') : null;
  const flULightType = R.feLightingProg
    ? gl.getUniformLocation(R.feLightingProg, 'uLightType')
    : null;
  const flULightPos = R.feLightingProg
    ? gl.getUniformLocation(R.feLightingProg, 'uLightPos')
    : null;
  const flUSpotAt = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uSpotAt') : null;
  const flUSurfaceZ = R.feLightingProg
    ? gl.getUniformLocation(R.feLightingProg, 'uSurfaceZ')
    : null;
  const flUSpotExp = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uSpotExp') : null;
  const flUSpotCosCone = R.feLightingProg
    ? gl.getUniformLocation(R.feLightingProg, 'uSpotCosCone')
    : null;

  const fctUIn = R.feComponentTransferProg
    ? gl.getUniformLocation(R.feComponentTransferProg, 'uIn')
    : null;
  const fctUInMap = R.feComponentTransferProg
    ? gl.getUniformLocation(R.feComponentTransferProg, 'uInMap')
    : null;
  const fctULUT = R.feComponentTransferProg
    ? gl.getUniformLocation(R.feComponentTransferProg, 'uLUT')
    : null;
  const fctUCsIn = R.feComponentTransferProg
    ? gl.getUniformLocation(R.feComponentTransferProg, 'uCsIn')
    : null;

  // vUV → uv for a pass whose output and input cover the same rect (both the
  // whole canvas, in every case below). Identity — but it must still be UPLOADED:
  // an unset vec4 uniform is (0,0,0,0), which samples one texel forever.
  const IDENTITY_MAP = [1, 1, 0, 0];
  function setMap(loc, m) {
    if (loc) gl.uniform4f(loc, m[0], m[1], m[2], m[3]);
  }

  /// A filter region's scissor, INTERSECTED with the caller's.
  ///
  const _outerScissor = (dstFbo) => R._targetScissor(dstFbo, true);
  const _scissorScratch = [0, 0, 0, 0];
  function _pushRegionScissor(clipRect, dstFbo) {
    if (!clipRect) return false;
    // (a deep zoom puts a region's edge past 2^31 px: a bit-or would wrap it round to a rect that holds nothing. Clamped, the width and height still fit a GLsizei.)
    const px = (v) => Math.trunc(Math.max(-SCISSOR_MAX, Math.min(SCISSOR_MAX, v)));
    let x0 = px(clipRect[0]),
      y0 = px(clipRect[1]);
    let x1 = px(x0 + Math.max(0, clipRect[2])),
      y1 = px(y0 + Math.max(0, clipRect[3]));
    const outer = _outerScissor(dstFbo);
    if (outer) {
      x0 = Math.max(x0, outer[0]);
      y0 = Math.max(y0, outer[1]);
      x1 = Math.min(x1, outer[0] + outer[2]);
      y1 = Math.min(y1, outer[1] + outer[3]);
    }
    _scissorScratch[0] = x0;
    _scissorScratch[1] = y0;
    _scissorScratch[2] = Math.max(0, x1 - x0);
    _scissorScratch[3] = Math.max(0, y1 - y0);
    R.glEnable(gl.SCISSOR_TEST);
    gl.scissor(_scissorScratch[0], _scissorScratch[1], _scissorScratch[2], _scissorScratch[3]);
    return true;
  }
  function _popRegionScissor(on, dstFbo) {
    if (on) R._applyTargetScissor(dstFbo, true); // hand the caller's (or the warm's) back, or off
  }

  // What the override table says about what a row paints, for a filter result's key: the row, and for a vector-pattern fill the rows of its tile, which the fill shader reads too.
  function _rowFeedKey(ov, row, depth = 0) {
    const own = overrideRowKey(ov, row);
    const b = R._handle && R._handle.bundle,
      st = b ? b.metaFloatsPerShape | 0 : 0;
    if (!ov || st <= META_ATLAS_IS_PATTERN || depth > 3) return own;
    const m = b.metaFloats,
      o = row * st;
    if (Math.round(m[o + META_ATLAS_IS_PATTERN]) !== 2) return own;
    const first = Math.round(m[o + META_ATLAS_Y]) - 1,
      last = Math.round(m[o + META_ATLAS_W]) - 1;
    let a = own >>> 0,
      c = (own / 4294967296) >>> 0;
    for (let child = first; child <= last && child >= 0; child++) {
      const k = _rowFeedKey(ov, child, depth + 1);
      if (k === 0) continue;
      a = Math.imul(a ^ child ^ (k >>> 0), 0x01000193);
      c = Math.imul(c ^ child ^ ((k / 4294967296) >>> 0), 0x5bd1e995);
    }
    return a === own >>> 0 && c === (own / 4294967296) >>> 0
      ? own
      : (a >>> 0) * 2097152 + (c >>> 11);
  }
  R._rowFeedKey = _rowFeedKey;

  // ── Filter-result cache key compare ───────────────────────────
  function _filterKeyMatches(c, key) {
    return (
      c &&
      c.key &&
      c.key.gen === key.gen &&
      c.key.geomGen === key.geomGen &&
      c.key.morphT === key.morphT &&
      c.key.cw === key.cw &&
      c.key.ch === key.ch &&
      c.key.shapeGen === key.shapeGen &&
      c.key.wmHash === key.wmHash &&
      c.key.recolor === key.recolor &&
      // A filter's own NUMBERS. Without this term a mutated blur sigma
      // (createFilterParams) would be invisible and the first frame's output
      // would be served for the life of the bundle. It is the bundle's counter, not
      // a per-filter one: every entry is already keyed per (filter, shape), so
      // a shared token re-evaluates filters that did not move — which is what
      // makes it one comparison here instead of a lookup.
      c.key.paramGen === key.paramGen &&
      c.key.frameKey === key.frameKey &&
      // The unified route keys on the fill variant that drew the source (renderer.js's keys leave it undefined on
      // both sides). Not comparing it would serve a result stored before the bundle's variant was bound for the rest of
      // the bundle's life (filterRegionSmoke checks a wide stroke's fill on the unified frame).
      c.key.variant === key.variant &&
      // A filtered group's result also depends on what every child row says, the rest of the override table (a clip row, say; two tables that say the same are one),
      // the resources its children sample, the mask bake and the graph object itself (createFilterParams replaces it).
      // Per-shape keys leave these undefined on both sides.
      c.key.graph === key.graph &&
      sameOverrideContent(c.key.overrides, key.overrides) &&
      c.key.maskGen === key.maskGen &&
      _sameList(c.key.groupGens, key.groupGens) &&
      _sameList(c.key.world, key.world) &&
      _sameList(c.key.recolorState, key.recolorState) &&
      _sameList(c.key.res, key.res)
    );
  }
  function _sameList(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const _wmBits = new Float64Array(1),
    _wmWords = new Uint32Array(_wmBits.buffer);
  function _wmHash(m) {
    // Value hash of the column-major mat3 (or identity when null) over the exact float64 bits of its nine entries. A
    // quantized hash (round(x * 4096)) maps every scale below 1/8192 to the same value, so two draws at different tiny
    // document scales shared one cached filter result.
    if (!m) return 0;
    let h = 2166136261;
    for (let i = 0; i < 9; i++) {
      _wmBits[0] = m[i];
      h ^= _wmWords[0];
      h = Math.imul(h, 16777619) >>> 0;
      h ^= _wmWords[1];
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  }
  // Cheap value hash of the per-draw recolor state that beginFillPass
  // bakes into a filter's SourceGraphic (alpha, colorMatrix + offset,
  // channelLerp, paletteChannel, extClipMode, palette-present). The
  // filtered output is cached POST-recolor, so two draws of the same
  // bundle in one frame with different tints must key differently — else
  // the second draw composites the first's recolored texture. The
  // palette LUT is mutable with no version token, so only its presence is
  // hashed; an active-palette draw is additionally barred from hitting
  // the cache (see the filterHit/skHit guards below).
  function _recolorHash() {
    let h = 2166136261;
    const mix = (x) => {
      h ^= x | 0;
      h = (h * 16777619) >>> 0;
    };
    mix(Math.round(R.draw.alpha * 4096));
    mix(R.draw.paletteChannel | 0);
    mix(R.draw.extClipMode | 0);
    mix(R.draw.palette ? 1 : 0);
    if (R.draw.colorMatrix)
      for (let i = 0; i < 16; i++) mix(Math.round(R.draw.colorMatrix[i] * 4096));
    else mix(0x9e3779b1 | 0);
    if (R.draw.colorMatrixOffset)
      for (let i = 0; i < 4; i++) mix(Math.round(R.draw.colorMatrixOffset[i] * 4096));
    else mix(0x85ebca77 | 0);
    if (R.draw.channelLerp) {
      const cl = R.draw.channelLerp;
      const arrs = [
        cl.primary || [0, 0, 0, 1],
        cl.contrast || [0, 0, 0, 1],
        cl.highlight || [1, 1, 1, 1],
      ];
      for (const a of arrs)
        for (let i = 0; i < 4; i++)
          mix(Math.round((a[i] == null ? (i === 3 ? 1 : 0) : a[i]) * 4096));
    } else mix(0x27d4eb2f | 0);
    return h;
  }
  /// The per-draw recolor state as its raw values, for a key that must tell two states apart exactly (the hash above
  /// quantizes to 1/4096 and folds to 32 bits).
  function _recolorState() {
    const d = R.draw,
      cl = d.channelLerp;
    const lerp = cl
      ? [
          cl.primary || [0, 0, 0, 1],
          cl.contrast || [0, 0, 0, 1],
          cl.highlight || [1, 1, 1, 1],
        ].flatMap((a) => [0, 1, 2, 3].map((i) => (a[i] == null ? (i === 3 ? 1 : 0) : a[i])))
      : null;
    return [
      d.alpha,
      d.paletteChannel | 0,
      d.extClipMode | 0,
      d.palette ? 1 : 0,
      ...(d.colorMatrix ? Array.from(d.colorMatrix) : [null]),
      ...(d.colorMatrixOffset ? Array.from(d.colorMatrixOffset) : [null]),
      ...(lerp || [null]),
    ];
  }
  // Composite a (premultiplied) filtered texture over the backdrop into
  // `dstFbo` (null = canvas) — the tail step shared by the filter cache
  // hit + miss paths. Inside a group the caller passes the group
  // accumulator FBO so the filtered shape stays IN the group instead of
  // escaping to the canvas.
  // `srcRect` is the canvas rect the filtered texture covers — null = the whole
  // canvas. The backdrop always covers the canvas, so it takes the identity.
  /// The <filter> region for a shape, as a GL-space canvas rect, or null.
  ///
  /// Entries are [x, y, w, h, space]. Space 0 is fractions of the shape's own bbox, which resolve exactly from the meta
  /// row whatever transform the element carries; space 1 is a rect in root user space (a userSpaceOnUse region mapped
  /// through the element's CTM at import). Both go through _shapeBboxPx, which maps em -> canvas px through globalBBox,
  /// the aspect fit, the world matrix and any per-shape override: the region has to track all of those or it would
  /// clip the wrong part of a moved shape.
  /// The meta row's bbox and stroke width AS THE FRAME DRAWS THEM: (x0, y0, x1, y1, strokeWidth) in em.
  ///
  /// A morph lerps those slots on the GPU (shapeMorph's MORPH_LERP_SLOTS covers 0-3 and 12) and leaves `metaFloats` at
  /// the source pose, so a region resolved from the CPU row would clip the shape where it no longer is. Read both poses
  /// and lerp at t. An unmatched shape (one that fades in or out) keeps the source pose: the destination plane carries
  /// values only for the matched rows.
  function _rowBoxEm(b, shapeIdx, meta, mb) {
    const out = [meta[mb + 0], meta[mb + 1], meta[mb + 2], meta[mb + 3], meta[mb + 12]];
    const ms = b._morphSrc;
    if (!ms || !ms.mergedMetaF32 || !ms.dstMetaF32) return out;
    const t = +ms.t || 0;
    const stride = ms.metaStride | 0;
    if (!(t > 0) || !stride) return out;
    const matched = ms.matchedSrcIdxs;
    if (
      matched &&
      (ms.matchedSrcSet
        ? !ms.matchedSrcSet.has(shapeIdx | 0)
        : Array.prototype.indexOf.call(matched, shapeIdx | 0) < 0)
    )
      return out;
    const base = (shapeIdx | 0) * stride,
      src = ms.mergedMetaF32,
      dst = ms.dstMetaF32;
    if (base + 12 >= src.length || base + 12 >= dst.length) return out;
    const ti = 1 - t;
    for (let k = 0; k < 4; k++) out[k] = src[base + k] * ti + dst[base + k] * t;
    out[4] = src[base + 12] * ti + dst[base + 12] * t;
    const row13 = [out[0], out[1], out[2], out[3], 0, 0, 0, 0, 0, 0, 0, 0, out[4]];
    if (widenMorphRowForArcs(ms, row13, 0, shapeIdx | 0, t))
      for (let k = 0; k < 4; k++) out[k] = row13[k];
    return out;
  }

  /// A group filter's objectBoundingBox region on a morph, in em: the fractions it was stated in, taken against the union of its
  /// members' geometry boxes AS THE FRAME DRAWS THEM (the import resolved them against the pose it read). null when the entry carries
  /// no fractions or the bundle is not a morph; the entry's own rect stands then.
  function _morphRegionEm(b, fid) {
    const obb = b.filterRegionObb && b.filterRegionObb[fid - 1];
    if (!b._morphSrc || !obb) return null;
    const meta = b.metaFloats,
      st = b.metaFloatsPerShape | 0;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const si of obb[4]) {
      const mb = si * st,
        row = _rowBoxEm(b, si, meta, mb),
        sw = Math.abs(row[4] || 0);
      const hw = sw > 0 && !((meta[mb + 27] | 0) & 1) ? 0.5 * sw : 0;
      const ax = row[0] + hw,
        ay = row[1] + hw,
        bx = row[2] - hw,
        by = row[3] - hw;
      if (!(bx > ax && by > ay)) continue;
      if (ax < x0) x0 = ax;
      if (ay < y0) y0 = ay;
      if (bx > x1) x1 = bx;
      if (by > y1) y1 = by;
    }
    if (!(x1 > x0 && y1 > y0)) return null;
    const [fx, fy, fw, fh] = obb,
      gw = x1 - x0,
      gh = y1 - y0;
    return [x0 + fx * gw, y0 + fy * gh, x0 + (fx + fw) * gw, y0 + (fy + fh) * gh];
  }

  /// A region with no area. The filter output is then empty and the element is NOT RENDERED (Filter Effects 1 §7.1):
  /// an objectBoundingBox region needs a bounding box, and a horizontal or vertical line has none. Chrome and WebKit
  /// both draw nothing for a filtered line; a zero-size scissor is that, and it costs no special case downstream.
  const EMPTY_REGION = [0, 0, 0, 0];

  function _filterRegionRectPx(shapeIdx, cw, ch) {
    const b = R._handle && R._handle.bundle;
    const regions = b && b.filterRegions;
    if (!regions) return null;
    // Nine-slice rewrites the cover quad but leaves the meta bbox at the native extent, so there is no box here to
    // resolve a region against — _shapeBboxPx declines it for the same reason. No clip rather than a wrong one.
    if (b._nineSliceActive) return null;
    const meta = b.metaFloats,
      st = b.metaFloatsPerShape | 0,
      mb = (shapeIdx | 0) * st;
    const fid = Math.floor(meta[mb + 32] + 0.5); // MT_FILTER_BLEND .x
    const rg = fid > 0 ? regions[fid - 1] : null;
    if (!rg) return null;
    let x0, y0, w, h;
    if ((rg[4] | 0) === 1) {
      const r = _shapeBboxPx(
        shapeIdx,
        cw,
        ch,
        _morphRegionEm(b, fid) || [rg[0], rg[1], rg[0] + rg[2], rg[1] + rg[3]],
        true,
      );
      if (!r) return EMPTY_REGION; // a stated region with no area paints nothing
      x0 = r.x;
      y0 = r.y;
      w = r.w;
      h = r.h;
    } else {
      // Fractions are of the OBJECT bounding box, which is the geometry alone (Filter Effects 1 §7.1). A fill row's meta
      // bbox is exactly that. A stroke is a row of its own, filtered on its own, and bundleFinalize pads that row's bbox
      // by half the stroke width (bboxMeta), so take the half-width back off. A non-scaling stroke's width is not in em,
      // so its row keeps the padded box. The box goes in as `rect`, which _shapeBboxPx maps without a stroke pad of its
      // own. Chrome and WebKit cut a wide stroke at this region; a stroke-padded box never did.
      const row = _rowBoxEm(b, shapeIdx, meta, mb);
      const sw = Math.abs(row[4] || 0);
      const hw = sw > 0 && !((meta[mb + 27] | 0) & 1) ? 0.5 * sw : 0;
      const ex0 = row[0] + hw,
        ey0 = row[1] + hw,
        ex1 = row[2] - hw,
        ey1 = row[3] - hw;
      // No width or no height: the box is degenerate, the region is empty, and the element is not rendered.
      if (!(ex1 > ex0) || !(ey1 > ey0)) return EMPTY_REGION;
      const bb = _shapeBboxPx(shapeIdx, cw, ch, [ex0, ey0, ex1, ey1], true);
      if (!bb) return EMPTY_REGION;
      x0 = bb.x + rg[0] * bb.w;
      y0 = bb.y + rg[1] * bb.h;
      w = rg[2] * bb.w;
      h = rg[3] * bb.h;
    }
    if (!(w > 0) || !(h > 0)) return EMPTY_REGION;
    // Under a turn, a skew or a rotating world matrix the region is a quad, and the rect below is its box. (A morph's region is a lerped box.)
    let quad = null;
    if (!b._morphSrc) {
      const stored = b.filterRegionQuads && b.filterRegionQuads[fid - 1];
      const toPx = _shapeToPx(shapeIdx, cw, ch),
        corners = [];
      if (stored) for (let k = 0; k < 8; k += 2) corners.push(toPx(stored[k], stored[k + 1]));
      else if ((rg[4] | 0) === 1)
        for (const [ex, ey] of [
          [rg[0], rg[1]],
          [rg[0] + rg[2], rg[1]],
          [rg[0] + rg[2], rg[1] + rg[3]],
          [rg[0], rg[1] + rg[3]],
        ])
          corners.push(toPx(ex, ey));
      else {
        const row = _rowBoxEm(b, shapeIdx, meta, mb),
          sw = Math.abs(row[4] || 0),
          hw = sw > 0 && !((meta[mb + 27] | 0) & 1) ? 0.5 * sw : 0;
        const ex = row[0] + hw,
          ey = row[1] + hw,
          ew = row[2] - hw - ex,
          eh = row[3] - hw - ey;
        for (const [fx, fy] of [
          [rg[0], rg[1]],
          [rg[0] + rg[2], rg[1]],
          [rg[0] + rg[2], rg[1] + rg[3]],
          [rg[0], rg[1] + rg[3]],
        ])
          corners.push(toPx(ex + fx * ew, ey + fy * eh));
      }
      const leans = (p, q) => {
        const dx = Math.abs(q[0] - p[0]),
          dy = Math.abs(q[1] - p[1]);
        return Math.min(dx, dy) > 1e-6 * Math.max(dx, dy);
      };
      if (leans(corners[0], corners[1]) || leans(corners[1], corners[2])) {
        quad = corners;
        const xs = corners.map((p) => p[0]),
          ys = corners.map((p) => p[1]);
        x0 = Math.min(...xs);
        y0 = Math.min(...ys);
        w = Math.max(...xs) - x0;
        h = Math.max(...ys) - y0;
      }
    }
    // An exact integer boundary does not arrive exactly: the region comes out of the float32 meta (relative error 2^-24 of
    // its source coordinate, which at S = 1e-6 or 1e12 is an inexact multiple of the pixel) and through the NDC mapping. The
    // tolerance is therefore a few FLOAT32 ulps of the device coordinate, not a few double ulps -- 16 double ulps (3.5e-15)
    // snapped at power-of-two scales only and grew the scissor by a whole pixel row at every other scale.
    const snap = (value) => {
      const integer = Math.round(value);
      return Math.abs(value - integer) <= SNAP_TOL * Math.max(1, Math.abs(value)) ? integer : value;
    };
    const gx = Math.floor(snap(x0)),
      gw = Math.ceil(snap(x0 + w)) - gx;
    const gyTop = Math.floor(snap(y0)),
      gh = Math.ceil(snap(y0 + h)) - gyTop;
    const glRect = /** @type {number[] & { quad?: number[][] }} */ ([
      gx,
      ch - (gyTop + gh),
      gw,
      gh,
    ]); // flip to GL
    if (quad) glRect.quad = quad.map((p) => [p[0], ch - p[1]]);
    return glRect;
  }
  R._filterRegionRectPx = _filterRegionRectPx;
  /// Start the small helper programs a filtered draw may need (the linear-light blits and fused blurs, the effect mask), asking nothing
  /// of them. A program first asked for in play makes the draw wait behind every compile the driver still has queued (seconds, even
  /// for a 1 KB blit); started when a filtered bundle is prepared they are at the front of that queue. Only with
  /// KHR_parallel_shader_compile, where starting costs the main thread nothing.
  /// Wait for the helper programs started above (the explicit loading call: the wait belongs behind the load screen).
  R._finishFilterPrograms = (soft) => {
    let pending = 0;
    for (const p of _started.values()) {
      if (soft && R._khrParallel && !R._programReady(p)) {
        pending++;
        continue;
      }
      gl.getProgramParameter(p, gl.LINK_STATUS);
    }
    return pending;
  };
  /// The helper programs a filtered draw composites with, linked and ready (strictPlay's loading draws each once on both target kinds and both blend
  /// states so no filtered frame in play builds their pipeline).
  R._filterAuxPrograms = () => {
    const out = [];
    if (R.cacheBlitProg) out.push({ label: 'cacheBlit', prog: R.cacheBlitProg });
    for (const [label, prog] of _started) if (label !== 'ownerPaint') out.push({ label, prog });
    // both OUTCOMES of the blur kernel tier (filterGraph/blurKernel.js blurAxisPlan: a Gaussian table up to ceil(3 sigma) <= 2 * BLUR_MAX_PAIRS device px, box passes beyond):
    // the box program is warmed whatever the loaded filters hold, since sigma_px = stdDeviation x scale reaches the tier inside the display's range.
    if (R.boxBlurProg) out.push({ label: 'boxBlur', prog: R.boxBlurProg });
    return out;
  };
  /// strictPlay's loading: start every helper a filtered draw may need (whatever the loaded bundles are: a bundle that arrives in play may filter) and prime the
  /// cached uniform tables of the ones that are ready. Answers how many are still linking.
  R._primeFilterPrograms = () => {
    if (!R._khrParallel || R._contextLost) return 0;
    let pending = 0;
    try {
      R._beginFilterPrograms();
      if (R.shaderSources.cacheBlitFrag && R.shaderSources.cacheBlitVert) {
        if (!_blitCsProgram()) pending++;
        if (!_blitQuadProgram(0)) pending++;
        if (!_blitQuadProgram(1)) pending++;
      }
      if (R.shaderSources.blurFrag)
        for (const key of ['i', 'o', 'io'])
          if (!_blurCsProgram(key.includes('i'), key.includes('o'))) pending++;
      if (R.shaderSources.effectMaskFrag && R.shaderSources.cacheBlitVert) {
        const p = _effectMaskStart();
        if (!R._programReady(p)) pending++;
        else if (!effectMaskUniforms) {
          const u = (name) => gl.getUniformLocation(R.effectMaskProg, name);
          effectMaskUniforms = {
            source: u('uCacheTex'),
            masks: u('uMasks'),
            layers: u('uLayers'),
            viewport: u('uViewport'),
            tint: u('uTint'),
            map: u('uInMap'),
          };
        }
        const lin = _startProgram(
          'effectMaskLinear',
          R.shaderSources.cacheBlitVert,
          _withCsOut(R.shaderSources.effectMaskFrag),
        );
        if (!R._programReady(lin)) pending++;
        else if (!effectMaskCs) {
          const uu = (name) => gl.getUniformLocation(lin, name);
          effectMaskCs = {
            prog: lin,
            source: uu('uCacheTex'),
            masks: uu('uMasks'),
            layers: uu('uLayers'),
            viewport: uu('uViewport'),
            tint: uu('uTint'),
            map: uu('uInMap'),
          };
        }
      }
    } catch {
      /* best effort: the lazy path stays */
    }
    return pending;
  };
  R._beginFilterPrograms = () => {
    if (!R._khrParallel || R._contextLost) return;
    try {
      if (R.shaderSources.cacheBlitFrag && R.shaderSources.cacheBlitVert) {
        _blitCsStart();
        _blitQuadStart(0);
        _blitQuadStart(1);
      }
      for (const key of ['i', 'o', 'io']) _blurCsStart(key);
      if (R.shaderSources.effectMaskFrag && R.shaderSources.cacheBlitVert) {
        _effectMaskStart();
        _startProgram(
          'effectMaskLinear',
          R.shaderSources.cacheBlitVert,
          _withCsOut(R.shaderSources.effectMaskFrag),
        );
      }
    } catch {
      /* best-effort: a failure leaves the lazy path */
    }
  };

  /// A filtered shape composites over its backdrop once: the fixed-function blend below (ONE,
  /// ONE_MINUS_SRC_ALPHA) IS premultiplied src-over, so the program must hand it the filtered texture
  /// and nothing else. A graph that reads BackgroundImage consumes its snapshot as an INPUT, not here.
  /// The viewport is the filtered texture's own rect, so the blit reads it 1:1.
  ///
  /// NEITHER COMPOSITE TAKES A BACKDROP, and that is the point of their signatures: the blend unit
  /// reads the destination itself. A snapshot is taken only where something samples it: a graph
  /// that reads BackgroundImage or BackgroundAlpha (R._graphReadsBackdrop).
  R._filterOutputOpacity = (shapeIdx, filterId) => {
    const bundle = R._handle.bundle,
      record = bundle.lastFilterFloats;
    let own =
      bundle._drivenFilterOpacities?.get(shapeIdx) ??
      (record ? 1 - record[(filterId - 1) * 24 + 23] : 1);
    const pair = bundle._morphSrc?.filterOpacityPairs?.get(shapeIdx);
    if (pair) own = morphFilterOpacity(pair, bundle._morphSrc.t);
    const ov = R.draw.overrides?.packedBuffer,
      i = shapeIdx * 24;
    const stroke = bundle.metaFloats[shapeIdx * bundle.metaFloatsPerShape + 11] > 0;
    if (ov && (ov[i + 7] | 0) & (stroke ? 2 : 1)) own = 1;
    const visibility = ov ? Math.max(0, Math.min(1, ov[i + 6])) : 1;
    const tint = ov ? ov[i + 11] : 1;
    return Math.max(0, own * R.draw.alpha * visibility * tint);
  };
  // The variants of the two blits a FILTER RESULT is composited with that convert it from linearRGB to sRGB on the way (the result of a graph
  // that ends in linearRGB primitives, filterGraph/colorSpace.js). Compiled on first use, so a scene with no linearRGB filter never builds them
  // and the plain blits carry no conversion.
  const _withDefine = (src, name) => src.replace(/^(\s*#version[^\n]*\n)/, `$1#define ${name} 1\n`);
  const _withCsOut = (src) => _withDefine(src, 'FILTER_CS_OUT');
  // The Gaussian blur that converts what it reads and/or what it writes (blur.frag.glsl BLUR_CS_IN / BLUR_CS_OUT): the first pass of a linearRGB blur
  // of an sRGB input (which would otherwise take a pass of its own to convert the input first) and its last, which hands the result back as sRGB.
  // Compiled on first use, one program per combination: 'i' (in), 'o' (out), 'io'.
  const _blurCs = {};
  // A program started by _beginFilterPrograms (or at its first use) is not asked anything until it is used: the uniform lookup is what
  // waits for the driver, and a program started at load is long finished by then.
  const _started = new Map();
  function _startProgram(label, vert, frag) {
    let p = _started.get(label);
    if (!p) {
      const pendingAt = R._pendingPrograms.length,
        shadersAt = R._pendingShaders.length;
      p = R.program(vert, frag, label);
      if (R._khrParallel) {
        R._pendingPrograms.length = pendingAt;
        R._pendingShaders.length = shadersAt;
      }
      _started.set(label, p);
    }
    return p;
  }
  function _blurCsStart(key) {
    if (!R.shaderSources.blurFrag) return null;
    let src = R.shaderSources.blurFrag;
    if (key.includes('i')) src = _withDefine(src, 'BLUR_CS_IN');
    if (key.includes('o')) src = _withDefine(src, 'BLUR_CS_OUT');
    return _startProgram('blurCs_' + key, R.shaderSources.compositeVert, src);
  }
  function _blurCsProgram(inF = true, outF = false) {
    const key = (inF ? 'i' : '') + (outF ? 'o' : '');
    if (_blurCs[key] || !R.shaderSources.blurFrag) return _blurCs[key] || null;
    const prog = _blurCsStart(key);
    // Not asked until ready (complete, GPU thread clear): the caller (blur.js) has the unfused path -- convert the input, then blur -- for the
    // same picture, so the fused program is simply not used until it can be.
    if (R._khrParallel && R._nbNow() && !R._forceLinks && !R._programReady(prog)) return null;
    const u = (n) => gl.getUniformLocation(prog, n);
    return (_blurCs[key] = {
      prog,
      u: {
        uTex: u('uTex'),
        uTexel: u('uTexel'),
        uInMap: u('uInMap'),
        uDir: u('uDir'),
        uW0: u('uW0'),
        uTapCount: u('uTapCount'),
        uTaps: u('uTaps'),
        uCsIn: u('uCsIn'),
        uInPast: u('uInPast'),
      },
    });
  }
  // FillPaint / StrokePaint as a gradient (shaders/ownerPaint.frag.glsl): the fill shader's gradient sampler over a graph target. Compiled on first use.
  let _ownerPaintProg,
    _ownerPaintStarted = null;
  /// The helper programs started here (the converting blits, the fused blurs, the owner paint). renderer.dispose() deletes the programs it names, and none of these is one of them; on a context
  /// that outlives its renderer each renderer would leave all of them behind. (R.effectMaskProg is one of its names.)
  R._disposeFilterPrograms = () => {
    for (const p of _started.values()) if (p !== R.effectMaskProg) deleteProgramWhenLinked(gl, p);
    _started.clear();
    if (_ownerPaintStarted) deleteProgramWhenLinked(gl, _ownerPaintStarted);
    _ownerPaintStarted = null;
  };
  function _ownerPaintProgram() {
    if (_ownerPaintProg !== undefined) return _ownerPaintProg;
    if (!R.shaderSources.ownerPaintFrag) return (_ownerPaintProg = null);
    const prog = (_ownerPaintStarted ||= R.program(
      R.shaderSources.compositeVert,
      R.shaderSources.ownerPaintFrag,
      'ownerPaint',
    ));
    // Asked only once ready (complete, GPU thread clear). Until then the hook paints nothing and says so (false): the next frame asks again.
    if (R._khrParallel && R._nbNow() && !R._forceLinks && !R._programReady(prog)) return null;
    const u = (n) => gl.getUniformLocation(prog, n);
    return (_ownerPaintProg = {
      prog,
      grad: u('uGradientTex'),
      stops: u('uGradientStops'),
      id: u('uGradId'),
      emX: u('uEmX'),
      emY: u('uEmY'),
      rect: u('uRect'),
    });
  }
  /// The owner-paint hooks of one graph evaluation (ctx.ownerPaint): `rect()`, the canvas rect (GL px) the paint targets cover, and
  /// `draw(paint, rt)`, which paints the placed gradient record `paint` into `rt`. The paint has infinite extent: the target is the filter region plus
  /// the longest reach of the graph past it (a blur at the region's edge reads paint beyond it), within the canvas -- and the frame, when the draw runs in one.
  function _ownerPaintFor(ctx, shapeIdx, cw, ch) {
    let rect = null;
    return {
      rect() {
        if (rect) return rect;
        const region = _filterRegionRectPx(shapeIdx, cw, ch);
        // (Every target is on the pool's grid like any node rect -- _bboxToRect: the pool allocates its quantum and consumers map uv through the
        // rect's own size -- so the box is handed over as a top-left bbox.)
        const grid = (x, y, w, h) =>
          _bboxToRect({ x, y: ch - (y + h), w, h }, ch) ||
          _bboxToRect({ x: 0, y: 0, w: 1, h: 1 }, ch);
        if (region === EMPTY_REGION) return (rect = grid(0, 0, 1, 1));
        let x0 = 0,
          y0 = 0,
          x1 = cw,
          y1 = ch;
        if (region) {
          const graph = ctx._graph;
          const reach = graph
            ? graphReach(_pxGraph(graph, shapeIdx, cw, ch, null))
            : { rx: Infinity, ry: Infinity };
          if (Number.isFinite(reach.rx) && Number.isFinite(reach.ry)) {
            const rx = Math.ceil(reach.rx) + FRAME_SLACK_PX,
              ry = Math.ceil(reach.ry) + FRAME_SLACK_PX;
            x0 = Math.max(0, region[0] - rx);
            y0 = Math.max(0, region[1] - ry);
            x1 = Math.min(cw, region[0] + region[2] + rx);
            y1 = Math.min(ch, region[1] + region[3] + ry);
          }
        }
        return (rect = x1 > x0 && y1 > y0 ? grid(x0, y0, x1 - x0, y1 - y0) : grid(0, 0, 1, 1));
      },
      draw(paint, rt) {
        const P = _ownerPaintProgram(),
          b = R._handle.bundle;
        // (still linking: this evaluation's paint input is transparent, so its result is deferred, not stored: "the next frame asks again" needs a next evaluation)
        if (!P && _ownerPaintProg === undefined)
          R._deferredFilterDraws = (R._deferredFilterDraws | 0) + 1;
        if (!P || !b.gradientTex || !b.gradientStopsTex) return false;
        // Canvas pixel (origin top left) -> em, the inverse of the shape's em -> pixel map (override, world matrix and fit included), from the
        // images of the global box's origin and two edges: it is affine, and these three points keep the arithmetic in the box's own scale.
        const g = b.globalBBox,
          gw = extentOr(g[2], 1),
          gh = extentOr(g[3], 1),
          toPx = _shapeToPx(shapeIdx, cw, ch);
        const [x0, y0] = toPx(g[0], g[1]),
          [x1, y1] = toPx(g[0] + gw, g[1]),
          [x2, y2] = toPx(g[0], g[1] + gh);
        const a = (x1 - x0) / gw,
          c = (x2 - x0) / gh,
          bb = (y1 - y0) / gw,
          d = (y2 - y0) / gh,
          det = a * d - bb * c;
        if (!(Math.abs(det) > 0) || !Number.isFinite(det)) return false;
        beginFullscreen(gl, rt);
        gl.useProgram(P.prog);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, b.gradientTex);
        gl.uniform1i(P.grad, 1);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, b.gradientStopsTex);
        gl.uniform1i(P.stops, 2);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(P.id, paint.gradientId);
        gl.uniform3f(P.emX, d / det, -c / det, g[0] + (-d * x0 + c * y0) / det);
        gl.uniform3f(P.emY, -bb / det, a / det, g[1] + (bb * x0 - a * y0) / det);
        const r = rt.rect || [0, 0, rt.size[0], rt.size[1]];
        gl.uniform3f(P.rect, r[0], r[1], ch);
        gl.bindVertexArray(coverVao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
        R._forgetFillUnits();
        return true;
      },
    };
  }
  let _blitCs = null;
  function _blitCsStart() {
    return _startProgram(
      'cacheBlitLinear',
      R.shaderSources.cacheBlitVert,
      _withCsOut(R.shaderSources.cacheBlitFrag),
    );
  }
  function _blitCsProgram() {
    if (_blitCs) return _blitCs;
    const prog = _blitCsStart();
    if (R._khrParallel && R._nbNow() && !R._forceLinks && !R._programReady(prog)) return null; // the caller defers the draw (_bindOverBlit answers false)
    const u = (n) => gl.getUniformLocation(prog, n);
    _blitCs = { prog, tex: u('uCacheTex'), tint: u('uTint'), inMap: u('uInMap') };
    return _blitCs;
  }
  // The blit with the four edges of a turned filter region (cacheBlit.frag.glsl FILTER_REGION_QUAD), plain and linear-light. Null until linked: the caller then draws the quad hard-edged.
  const _blitQuad = [null, null];
  function _blitQuadStart(cs) {
    const src = _withDefine(R.shaderSources.cacheBlitFrag, 'FILTER_REGION_QUAD');
    return _startProgram(
      cs ? 'cacheBlitQuadLinear' : 'cacheBlitQuad',
      R.shaderSources.cacheBlitVert,
      cs ? _withCsOut(src) : src,
    );
  }
  function _blitQuadProgram(cs) {
    const i = cs ? 1 : 0;
    if (_blitQuad[i]) return _blitQuad[i];
    const prog = _blitQuadStart(cs);
    if (R._khrParallel && R._nbNow() && !R._forceLinks && !R._programReady(prog)) return null;
    const u = (n) => gl.getUniformLocation(prog, n);
    return (_blitQuad[i] = {
      prog,
      tex: u('uCacheTex'),
      tint: u('uTint'),
      inMap: u('uInMap'),
      edges: u('uRegionEdges'),
    });
  }
  // The four edges of a convex quad, positive inside, each scaled so that it changes by one across the pixel the edge crosses (the extent of a unit box along the edge's normal).
  const _quadEdges = (q) => {
    let area = 0;
    for (let k = 0; k < 4; k++) {
      const p = q[k],
        n = q[(k + 1) % 4];
      area += p[0] * n[1] - n[0] * p[1];
    }
    const sign = area < 0 ? -1 : 1,
      out = new Float32Array(12);
    for (let k = 0; k < 4; k++) {
      const p = q[k],
        n = q[(k + 1) % 4],
        a = -(n[1] - p[1]) * sign,
        b = (n[0] - p[0]) * sign,
        s = 1 / (Math.abs(a) + Math.abs(b) || 1);
      out[k * 3] = a * s;
      out[k * 3 + 1] = b * s;
      out[k * 3 + 2] = -(a * p[0] + b * p[1]) * s;
    }
    return out;
  };
  // A turned region's corners in the target's pixels, from the canvas's (a frame's target is scaled and offset; see _clipToTarget).
  const _quadOnTarget = (q, ffr) =>
    ffr ? q.map((p) => [p[0] * ffr.s - ffr.Mc, p[1] * ffr.s - ffr.Mc]) : q;
  // The quad as geometry, through the current viewport: the cover quad's vertex format, drawn as the same strip.
  let _quadVao = null,
    _quadVb = null;
  function _drawQuadGeometry(q, vp) {
    if (!_quadVao) {
      _quadVao = trackGlResource(gl, gl.createVertexArray());
      _quadVb = trackGlResource(gl, gl.createBuffer(), 'filterQuad');
      gl.bindVertexArray(_quadVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, _quadVb);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    const ndc = new Float32Array(8);
    [q[0], q[1], q[3], q[2]].forEach((p, k) => {
      ndc[k * 2] = ((p[0] - vp[0]) / vp[2]) * 2 - 1;
      ndc[k * 2 + 1] = ((p[1] - vp[1]) / vp[3]) * 2 - 1;
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, _quadVb);
    gl.bufferData(gl.ARRAY_BUFFER, ndc, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    R.glBindVertexArray(_quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    R.glBindVertexArray(null);
  }
  function _bindQuadBlit(tex, opacity, map, cs, quad) {
    const v = _blitQuadProgram(cs);
    if (!v) return false;
    R.glUseProgram(v.prog);
    R._forgetFillUnits();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(v.tex, 0);
    gl.uniform4f(v.tint, opacity, opacity, opacity, opacity);
    if (map) gl.uniform4f(v.inMap, map[0], map[1], map[2], map[3]);
    else gl.uniform4f(v.inMap, 1, 1, 0, 0);
    gl.uniform3fv(v.edges, _quadEdges(quad));
    return true;
  }
  function _bindOverBlit(tex, opacity = 1, map = null, cs = 0) {
    const v = cs ? _blitCsProgram() : null;
    // A linearRGB result needs the converting blit; without it the plain blit would paint the wrong colors, and nothing built draws these pixels.
    // No draw waits for the link: this one is deferred (false), counted in debugStats.deferredFilterDraws, and the next frame asks again.
    if (cs && !v) {
      R._deferredFilterDraws = (R._deferredFilterDraws | 0) + 1;
      return false;
    }
    R.glUseProgram(v ? v.prog : R.cacheBlitProg);
    R._forgetFillUnits();
    const uTex = v ? v.tex : R.cbUCacheTex,
      uTint = v ? v.tint : R.cbUTint,
      uMap = v ? v.inMap : R.cbUInMap;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(uTex, 0);
    gl.uniform4f(uTint, opacity, opacity, opacity, opacity);
    if (uMap) {
      if (map) gl.uniform4f(uMap, map[0], map[1], map[2], map[3]);
      else gl.uniform4f(uMap, 1, 1, 0, 0);
    }
    return true;
  }
  let effectMaskUniforms = null,
    effectMaskCs = null;
  function _effectMaskStart() {
    return (R.effectMaskProg ||= _startProgram(
      'effectMask',
      R.shaderSources.cacheBlitVert,
      R.shaderSources.effectMaskFrag,
    ));
  }
  function _bindEffectMask(tex, opacity, row, cw, ch, map = null, cs = 0) {
    const b = R._handle.bundle,
      off = row * b.metaFloatsPerShape;
    const ids = [Math.round(b.metaFloats[off + 30]), Math.round(b.metaFloats[off + 31])];
    const layers = ids.map((id) =>
      id > 0 ? R._handle.maskRegions.findIndex((reg) => reg.maskRow === id) : -1,
    );
    if (layers.every((layer) => layer < 0)) return false;
    // (a program whose uniform table is already captured is asked nothing: readiness is only for a first query)
    if (
      R._khrParallel &&
      R._nbNow() &&
      !R._forceLinks &&
      !effectMaskUniforms &&
      !R._programReady(_effectMaskStart())
    ) {
      R._deferredFilterDraws = (R._deferredFilterDraws | 0) + 1;
      return 'defer';
    }
    if (cs && !effectMaskCs) {
      const lin = _startProgram(
        'effectMaskLinear',
        R.shaderSources.cacheBlitVert,
        _withCsOut(R.shaderSources.effectMaskFrag),
      );
      if (R._khrParallel && R._nbNow() && !R._forceLinks && !R._programReady(lin)) {
        R._deferredFilterDraws = (R._deferredFilterDraws | 0) + 1;
        return 'defer';
      }
    }
    if (!effectMaskUniforms) {
      _effectMaskStart();
      const u = (name) => gl.getUniformLocation(R.effectMaskProg, name);
      effectMaskUniforms = {
        source: u('uCacheTex'),
        masks: u('uMasks'),
        layers: u('uLayers'),
        viewport: u('uViewport'),
        tint: u('uTint'),
        map: u('uInMap'),
      };
    }
    if (cs && !effectMaskCs) {
      const prog = _startProgram(
        'effectMaskLinear',
        R.shaderSources.cacheBlitVert,
        _withCsOut(R.shaderSources.effectMaskFrag),
      );
      const uu = (name) => gl.getUniformLocation(prog, name);
      effectMaskCs = {
        prog,
        source: uu('uCacheTex'),
        masks: uu('uMasks'),
        layers: uu('uLayers'),
        viewport: uu('uViewport'),
        tint: uu('uTint'),
        map: uu('uInMap'),
      };
    }
    const u = cs ? effectMaskCs : effectMaskUniforms;
    R.glUseProgram(cs ? effectMaskCs.prog : R.effectMaskProg);
    R._forgetFillUnits();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(u.source, 0);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, R._effectMaskTexture());
    gl.uniform1i(u.masks, 3);
    gl.uniform2f(u.layers, layers[0], layers[1]);
    gl.uniform2f(u.viewport, cw, ch);
    gl.uniform4f(u.tint, opacity, opacity, opacity, opacity);
    if (map) gl.uniform4f(u.map, map[0], map[1], map[2], map[3]);
    else gl.uniform4f(u.map, 1, 1, 0, 0);
    return true;
  }
  // The frame this filter op runs in, whose output a composite must hand back to the op's host (shifted by the margin), or null. A group's
  // frame is the coordinate system its children paint in, not a host to hand back to: a child composited into the group's accumulator
  // is already in the group's pixels (the group hands back as a whole, in _groupEnd).
  const _opFrame = () => {
    const t = _frames.length ? _frames[_frames.length - 1] : null;
    return t && !t.group ? t : null;
  };
  // Hand a frame back to the target it sits in: frame pixel p is target pixel p * s - Mc (s = 1 unless the frame was degraded to a
  // lower resolution). The viewport is the part of the frame's rect that lands on the target, never the whole of it -- a degraded
  // frame is s times larger than the target and would exceed the viewport limit, and the margin is not worth rasterizing -- and the
  // cover quad's uv map (vUV spans that viewport) reads the matching part of the frame's texture. Null = nothing lands on it.
  //   rect: the frame-pixel rect the texture covers, [x, y, w, h]
  function _frameDest(fr, rect) {
    const dx = rect[0] * fr.s - fr.Mc,
      dy = rect[1] * fr.s - fr.Mc,
      dw = rect[2] * fr.s,
      dh = rect[3] * fr.s;
    const x0 = Math.max(0, dx),
      y0 = Math.max(0, dy),
      x1 = Math.min(fr.cw, dx + dw),
      y1 = Math.min(fr.ch, dy + dh);
    if (!(x1 > x0) || !(y1 > y0)) return null;
    return {
      vp: [x0, y0, x1 - x0, y1 - y0],
      map: [(x1 - x0) / dw, (y1 - y0) / dh, (x0 - dx) / dw, (y0 - dy) / dh],
    };
  }
  R._frameDest = _frameDest;
  // A frame-pixel clip rect on the target, limited to the target (a region millions of pixels wide would overflow the scissor).
  function _clipToTarget(r, fr) {
    if (!r) return r;
    const x0 = Math.max(0, r[0] * fr.s - fr.Mc),
      y0 = Math.max(0, r[1] * fr.s - fr.Mc);
    const x1 = Math.min(fr.cw, (r[0] + r[2]) * fr.s - fr.Mc),
      y1 = Math.min(fr.ch, (r[1] + r[3]) * fr.s - fr.Mc);
    return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
  }
  const _meetRects = (a, b) => {
    const x0 = Math.max(a[0], b[0]),
      y0 = Math.max(a[1], b[1]);
    return [
      x0,
      y0,
      Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - x0),
      Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - y0),
    ];
  };
  function _compositeFilteredTex(
    filteredTex,
    cw,
    ch,
    dstFbo = null,
    srcRect = null,
    clipRect = null,
    opacity = 1,
    effectRow = -1,
    sameFrame = false,
    cs = 0,
  ) {
    bindFb(gl.FRAMEBUFFER, dstFbo);
    let quad = clipRect && clipRect.quad;
    // A target past its pixels (_onQuantum) is clear out there: the composite does not shade it.
    if (srcRect && srcRect.keep)
      clipRect = clipRect ? _meetRects(clipRect, srcRect.keep) : srcRect.keep;
    // `sameFrame`: the destination is a target of the frame's own size and coordinates (a filtered group's output), not the frame's host.
    const ffr = !sameFrame ? _opFrame() : null;
    let map = null;
    if (ffr) {
      const d = _frameDest(ffr, srcRect || [0, 0, cw, ch]);
      if (!d) return; // the frame's output lies wholly off the target
      clipRect = _clipToTarget(clipRect, ffr);
      srcRect = d.vp;
      map = d.map;
      cw = ffr.cw;
      ch = ffr.ch;
      if (quad) quad = _quadOnTarget(quad, ffr);
    }
    // The filter region clips the OUTPUT. A scissor rather than a smaller viewport:
    // vUV spans the viewport and reads the filtered texture 1:1, so shrinking the
    // viewport would rescale the sample instead of cropping it.
    const _clipOn = _pushRegionScissor(clipRect, dstFbo);

    if (srcRect) R.glViewport(srcRect[0], srcRect[1], srcRect[2], srcRect[3]);
    else R.glViewport(0, 0, cw, ch);
    R.glDisable(gl.DEPTH_TEST);
    R.glDisable(gl.STENCIL_TEST);
    R.glEnable(gl.BLEND);
    R.glBlendEquation(gl.FUNC_ADD);
    R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const masked =
      effectRow >= 0 ? _bindEffectMask(filteredTex, opacity, effectRow, cw, ch, map, cs) : false;
    // A turned region: the edges antialiased in the blit, or, under an effect mask or while that program links, the quad's own hard edges.
    const edged = quad && !masked && _bindQuadBlit(filteredTex, opacity, map, cs, quad);
    const bound =
      edged ||
      (masked === 'defer' ? false : masked || _bindOverBlit(filteredTex, opacity, map, cs));
    if (bound) {
      if (quad && !edged) _drawQuadGeometry(quad, srcRect || [0, 0, cw, ch]);
      else {
        R.glBindVertexArray(coverVao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        R.glBindVertexArray(null);
      }
    }
    // Hand the scissor back exactly as found — the CALLER's rect when there is
    // one (setScissorRect / drawBundle's dstRect), off otherwise. Leaving the
    // region's rect in place would silently crop every later draw in the frame.
    _popRegionScissor(_clipOn, dstFbo);
  }
  // Allocate/reuse a persistent RGBA8 texture (+ its own FBO) named
  // `texField` on a cache entry, sized (cw,ch). Re-creates on resize.
  function _ensureCacheTex(entry, texField, cw, ch) {
    const fboField = texField + 'Fbo';
    if (entry[texField] && entry.w === cw && entry.h === ch) return;
    if (entry[texField]) {
      deleteGlResource(gl, 'Texture', entry[texField]);
      deleteGlResource(gl, 'Framebuffer', entry[fboField]);
    }

    const bytesField = '_bytes_' + texField;
    if (R._filterCacheCharge) R._filterCacheCharge(cw * ch * 4 - (entry[bytesField] | 0));
    entry[bytesField] = cw * ch * 4;

    const prevUnit = gl.getParameter(gl.ACTIVE_TEXTURE);
    gl.activeTexture(gl.TEXTURE11);
    const tex = trackGlResource(gl, gl.createTexture(), 'filterCache');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(prevUnit);
    const fbo = trackGlResource(gl, gl.createFramebuffer());
    // Through bindFb, not raw: the renderer shadows the bound framebuffer too, and
    // a raw bind here desynced it — the next bindFb(null) became a no-op and the
    // caller's draw landed in this framebuffer instead of on the canvas.
    bindFb(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    entry[texField] = tex;
    entry[fboField] = fbo;
    if (R._enforceFilterBudget) R._enforceFilterBudget(entry); // (an entry that grew has passed no store)
  }
  // Build the SVG filter-graph dispatch context (programs + uniform handles +
  // source/backdrop RTs). Pure object construction over module program +
  // uniform consts — shared by render()'s filter-graph branch and the morph
  // route's offscreen filter path so the two can't drift.
  function _buildFilterCtx(
    cw,
    ch,
    pxPerEm,
    sourceRT,
    mainCopyRT,
    shapeIdx = 0,
    sourceCaptureBundle = null,
    sourceInputScale = 1,
  ) {
    const ctx = {
      gl,
      pool: R._rtPool,
      coverVao,
      w: cw,
      h: ch,
      worldScale: pxPerEm,
      // The margin of the filter frame this graph runs in (0 = the canvas). Handlers whose output is anchored to the CANVAS (feTurbulence)
      // take it off to stay where they were.
      frameM: _frames.reduce((a, f) => a + f.m, 0), // in frame pixels, nested frames summed
      offsetMatrix: _offsetMatrixPx(shapeIdx, cw, ch),
      sourceRT,
      mainCopyRT,
      sourceMaterial:
        sourceCaptureBundle === R._handle.bundle
          ? R._filterSourceMaterial(shapeIdx, sourceInputScale)
          : null,
      blurProg: R.blurProg,
      blurU: {
        uTex: blurUTex,
        uTexel: blurUTexel,
        uInMap: blurUInMap,
        uDir: blurUDir,
        uW0: blurUW0,
        uTapCount: blurUCount,
        uTaps: blurUTaps,
        uInPast: blurUInPast,
      },
      boxBlurProg: R.boxBlurProg,
      boxBlurU: R.boxBlurProg
        ? {
            uTex: bbUTex,
            uTexel: bbUTexel,
            uInMap: bbUInMap,
            uDir: bbUDir,
            uRadius: bbURadius,
            uInPast: bbUInPast,
          }
        : null,
      morphProg: R.morphProg,
      morphU: R.morphProg
        ? {
            uTex: morphUTex,
            uTexel: morphUTexel,
            uInMap: morphUInMap,
            uDir: morphUDir,
            uRadius: morphURadius,
            uOperator: morphUOperator,
          }
        : null,
      colorMatrixProg: R.colorMatrixProg,
      colorMatrixU: R.colorMatrixProg
        ? {
            uTex: cmUTex,
            uInMap: cmUInMap,
            uLinearZeroBorder: cmULinearZeroBorder,
            uM0: cmUM0,
            uM1: cmUM1,
            uM2: cmUM2,
            uM3: cmUM3,
            uMOff: cmUMOff,
            uCsIn: cmUCsIn,
            uCsOut: cmUCsOut,
          }
        : null,
      feCompositeProg: R.feCompositeProg,
      feCompositeU: R.feCompositeProg
        ? {
            uIn1: fcUIn1,
            uIn2: fcUIn2,
            uIn1Map: fcUIn1Map,
            uIn2Map: fcUIn2Map,
            uOp: fcUOp,
            uK: fcUK,
            uPD: fcUPD,
            uCsIn: fcUCsIn,
            uCoverageResolve: fcUCoverage,
            uCoveragePixelAligned: fcUPixelAligned,
            uCoverageIn1: fcUCoverageIn1,
            uCoverageIn2: fcUCoverageIn2,
            uCoverageIn1Offset: fcUIn1Offset,
            uCoverageIn2Offset: fcUIn2Offset,
            uSourceCoverageScale: fcUUnitOpacity,
            uSourceMaterialLo: fcUMaterialLo,
            uSourceMaterialHi: fcUMaterialHi,
          }
        : null,
      feBlendProg: R.feBlendProg,
      feBlendU: R.feBlendProg
        ? {
            uIn1: fbUIn1,
            uIn2: fbUIn2,
            uIn1Map: fbUIn1Map,
            uIn2Map: fbUIn2Map,
            uMode: fbUMode,
            uCsIn: fbUCsIn,
          }
        : null,
      feTileProg: R.feTileProg,
      feTileU: R.feTileProg ? { uTex: ftUTex, uTileA: ftUTileA, uTileB: ftUTileB } : null,
      feTurbulenceProg: R.feTurbulenceProg,
      feTurbulenceU: R.feTurbulenceProg
        ? {
            uBaseFreq: ftbUBaseFreq,
            uNumOctaves: ftbUNumOctaves,
            uSeed: ftbUSeed,
            uKind: ftbUKind,
            uTilePos: ftbUTilePos,
            uTileSize: ftbUTileSize,
            uStitch: ftbUStitch,
            uStitchPos: ftbUStitchPos,
            uStitchSize: ftbUStitchSize,
          }
        : null,
      feDisplacementMapProg: R.feDisplacementMapProg,
      feDisplacementMapU: R.feDisplacementMapProg
        ? {
            uIn1: fdUIn1,
            uIn2: fdUIn2,
            uIn1Map: fdUIn1Map,
            uIn2Map: fdUIn2Map,
            uScale: fdUScale,
            uTexel: fdUTexel,
            uDispM: fdUDispM,
            uDispUseM: fdUDispUseM,
            uXSel: fdUXSel,
            uYSel: fdUYSel,
            uCsIn2: fdUCsIn2,
          }
        : null,
      feLightingProg: R.feLightingProg,
      feLightingU: R.feLightingProg
        ? {
            uIn: flUIn,
            uTexel: flUTexel,
            uInMap: flUInMap,
            uOutRect: flUOutRect,
            uWorldScale: flUWorldScale,
            uSurfaceScale: flUSurfaceScale,
            uK: flUK,
            uExponent: flUExponent,
            uLightColor: flULightColor,
            uMode: flUMode,
            uLightType: flULightType,
            uLightPos: flULightPos,
            uSpotAt: flUSpotAt,
            uSurfaceZ: flUSurfaceZ,
            uSpotExp: flUSpotExp,
            uSpotCosCone: flUSpotCosCone,
          }
        : null,
      feComponentTransferProg: R.feComponentTransferProg,
      feComponentTransferU: R.feComponentTransferProg
        ? { uIn: fctUIn, uInMap: fctUInMap, uLUT: fctULUT, uCsIn: fctUCsIn }
        : null,
      feImageProg: R.feImageProg,
      feImageU: R.feImageProg
        ? {
            uIn: fimgUIn,
            uAtlasSize: fimgUAtlasSize,
            uAtlasRect: fimgUAtlasRect,
            uPlaced: fimgUPlaced,
            uOutRect: fimgUOutRect,
            uImgRect: fimgUImgRect,
            uClipRect: fimgUClipRect,
            uImgMap: fimgUImgMap,
            uAtlasMap: fimgUAtlasMap,
          }
        : null,
      convolveProg: R.convolveProg,
      convolveU: R.convolveProg
        ? {
            uTex: convUTex,
            uKernel: convUKernel,
            uTexel: convUTexel,
            uInMap: convUInMap,
            uOrder: convUOrder,
            uTarget: convUTarget,
            uDivisor: convUDivisor,
            uBias: convUBias,
            uEdgeMode: convUEdgeMode,
            uPreserveAlpha: convUPreserve,
          }
        : null,
      blurCs: _blurCsProgram,
      bundle: R._handle.bundle,
    };
    if (R.shaderSources.ownerPaintFrag) ctx.ownerPaint = _ownerPaintFor(ctx, shapeIdx, cw, ch);
    // The primitive subregion of graph node `j` (negative: a standard input), [x, y, w, h] in this context's GL pixels, in USER space and
    // unclipped -- feTile's period and origin (filterGraph/primitives/tile.js). Filter Effects 1 §15.3: an explicit x/y/width/height is
    // the subregion (an external feImage is the one primitive that carries it here); otherwise the union of the subregions of the node's
    // inputs; a node without node inputs (a standard input, a generator) takes the filter region. null = no filter region to take.
    //
    // A graph that states primitive subregions resolves all of this in em first (_primSubs), so a stated x / y / width / height of any
    // primitive, and the default it falls back to per component, are honored; `subsOf` is that answer, once per evaluation.
    let _subMemo = null,
      _subsG = null,
      _subsV = null;
    const subsOf = (graph) => {
      if (_subsG !== graph) {
        _subsG = graph;
        _subsV = _primSubs(graph, shapeIdx, cw, ch);
      }
      return _subsV;
    };
    ctx.primClipsOf = (graph) => {
      const s = subsOf(graph);
      return s ? s.clips : null;
    };
    ctx.subregionOf = (j) => {
      const graph = ctx._graph;
      if (!graph) return null;
      const subs = subsOf(graph);
      if (!_subMemo) {
        _subMemo = {
          region: _filterRegionRectPx(shapeIdx, cw, ch),
          place: _feImagePlacements(graph, shapeIdx, cw, ch),
          by: new Map(),
        };
      }
      if (subs) {
        if (j < 0 || j >= graph.nodes.length) return _subMemo.region;
        const sr = subs.rects[j];
        return sr ? (sr.empty ? [0, 0, 0, 0] : sr.gl) : _subMemo.region;
      }
      const M = _subMemo,
        at = (i) => {
          if (i < 0 || i >= graph.nodes.length) return M.region;
          if (M.by.has(i)) return M.by.get(i);
          M.by.set(i, null); // (a graph is acyclic; this only guards a malformed one)
          const pl = M.place && M.place[i];
          let r;
          if (pl && !pl.empty) r = pl.sub;
          else {
            r = undefined;
            for (const k of graph.nodes[i].inputs || []) {
              const s = at(k);
              if (!s) {
                r = null;
                break;
              }
              r = r ? _unionGL(r, s) : s;
            }
            if (r === undefined) r = M.region;
          }
          M.by.set(i, r);
          return r;
        };
      return at(j);
    };
    // A light position (feePointLight / feSpotLight x, y, z and pointsAt, in root user space) as the lighting pass
    // reads it: GL canvas px, origin bottom-left, y UP -- so x and y go through the same em -> px chain as the shape
    // (override, world matrix, fit) and y is flipped; z is scaled by the geometric-mean px per user unit, as Chrome
    // scales a light's z with the filter's own scale.
    let toPx = null;
    const zScale = () => {
      const m = ctx.offsetMatrix;
      return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    };
    ctx.lightZScale = zScale;
    ctx.lightToGL = (x, y, z) => {
      toPx ||= _shapeToPx(shapeIdx, cw, ch);
      const s = zScale();
      const [px, py] = toPx(x, y);
      return [px, ch - py, z * s];
    };
    return ctx;
  }
  // A shape's override scale on the filter's two user axes (the lengths of the override matrix's columns), or null for none: an override
  // acts as a transform of the element, so a filter's lengths follow it as they follow a transform attribute (SVG 1.1 section 15.7.1: the
  // filter works in the user space of the referencing element). Exact for a scale or a flip; a turn leaves the lengths as they are.
  function _ovAxisScale(shapeIdx) {
    const ov = R.draw.overrides;
    if (!ov || !ov.packedBuffer || !ov.texelsPerShape) return null;
    const p = ov.packedBuffer,
      o = (shapeIdx | 0) * (ov.texelsPerShape | 0) * 4;
    if (o + 4 > p.length) return null;
    const l0 = Math.hypot(p[o], p[o + 2]),
      l1 = Math.hypot(p[o + 1], p[o + 3]);
    return (l0 === 1 && l1 === 1) || !(l0 >= 0) || !(l1 >= 0) ? null : [l0, l1];
  }
  function _filterPxPerEm(cw, ch, shapeIdx) {
    const b = R._handle.bundle;
    // In a filter frame, the scale is the CANVAS's (the frame's compensated matrix mixes the axes' unequal pixel scales into the
    // rotation term below, and a frame must not change what a sigma means).
    const fr = _frames.length ? _frames[_frames.length - 1] : null;
    if (fr) {
      cw = fr.cw;
      ch = fr.ch;
    }
    const [scX, scY] = arScale(b.globalBBox, cw, ch);
    const wM = fr ? fr.savedWorld : R.draw.worldM;
    const inv = fr ? 1 / fr.s : 1; // a degraded frame has s canvas pixels per pixel
    const wsX = wM ? Math.hypot(wM[0], wM[1]) : 1;
    const wsY = wM ? Math.hypot(wM[3], wM[4]) : 1;
    const ovS = shapeIdx === undefined ? null : _ovAxisScale(shapeIdx);
    return [
      ((inv * (cw * scX * wsX)) / extentOr(b.globalBBox[2], 1e-6)) * (ovS ? ovS[0] : 1),
      ((inv * (ch * scY * wsY)) / extentOr(b.globalBBox[3], 1e-6)) * (ovS ? ovS[1] : 1),
    ];
  }
  // Per-node RECTS for a filter graph: the region of the canvas where each
  // node's output can be non-zero (the SourceGraphic bbox propagated through
  // the graph by computeNodeBboxes). Each node's RT is then allocated at its
  // own rect instead of at the full canvas — so a 200×150 card with a drop
  // shadow on a 1080p canvas evaluates its five nodes in ~600KB of RTs rather
  // than ~41MB, and shades only the pixels that can matter.
  //
  // Output-identical: a bounded primitive is transparent black beyond its bbox
  // by spec (Filter Effects §7), which is exactly what a consumer reads off the
  // rect's edge — sampleIn returns 0 outside the input's rect rather than the
  // clamped edge texel.
  //
  // Returns an array aligned with graph.nodes — each entry a rect
  // [x, y, w, h] in GL framebuffer pixels (origin bottom-left) — or null to
  // run the whole graph at canvas size.
  //
  // Sizes are rounded out to a 32px grid to improve exact-size pool reuse. The
  // texture still matches its quantized canvas rect at one pixel per pixel.

  function _shapeToPx(shapeIdx, cw, ch) {
    const b = R._handle.bundle;
    const gBB = b.globalBBox;
    const [arSx, arSy] = arScale(gBB, cw, ch);
    const wM = R.draw.worldM; // column-major mat3 or null
    // em → top-left screen px (the convention computeNodeBboxes + the SVG
    // filter primitives assume; feOffset dy is screen-down). Mirrors the
    // fill vertex shader's em→clip chain, including the per-draw world
    // matrix so the scissor tracks the world-transformed silhouette.
    const emToPx = (ex, ey) => {
      const planeX = (((ex - gBB[0]) / extentOr(gBB[2], 1e-12)) * 2 - 1) * arSx;
      const planeY = (((ey - gBB[1]) / extentOr(gBB[3], 1e-12)) * 2 - 1) * arSy;
      let nx = planeX,
        ny = -planeY,
        nw = 1;
      if (wM) {
        const cx = wM[0] * nx + wM[3] * ny + wM[6];
        const cy = wM[1] * nx + wM[4] * ny + wM[7];
        const cwv = wM[2] * nx + wM[5] * ny + wM[8];
        nx = cx;
        ny = cy;
        nw = cwv;
      }
      const iw = 1 / (Math.abs(nw) < 1e-12 ? 1 : nw);
      return [(nx * iw + 1) * cw * 0.5, (1 - ny * iw) * ch * 0.5];
    };
    //
    const ov = R.draw.overrides;
    let m00 = 1,
      m01 = 0,
      m10 = 0,
      m11 = 1,
      tx = 0,
      ty = 0;
    if (ov && ov.packedBuffer && ov.texelsPerShape) {
      const fps = (ov.texelsPerShape | 0) * 4; // floats per shape row
      const p = ov.packedBuffer,
        o = (shapeIdx | 0) * fps;
      if (o + 6 <= p.length) {
        m00 = p[o + 0];
        m01 = p[o + 1];
        m10 = p[o + 2];
        m11 = p[o + 3];
        tx = p[o + 4];
        ty = p[o + 5];
      }
    }
    const ovEm = (ex, ey) => [m00 * ex + m01 * ey + tx, m10 * ex + m11 * ey + ty];
    return (ex, ey) => {
      const [ox, oy] = ovEm(ex, ey);
      return emToPx(ox, oy);
    };
  }
  R._shapeToPx = _shapeToPx;
  function _offsetMatrixPx(shapeIdx, cw, ch) {
    const b = R._handle.bundle,
      bb = b.globalBBox,
      world = R.draw.worldM;
    if (world && (world[2] !== 0 || world[5] !== 0)) {
      const scale = _filterPxPerEm(cw, ch);
      return [scale[0], 0, 0, scale[1]];
    }
    const ar = arScale(bb, cw, ch),
      x = bb[2] > 0 ? ar[0] / bb[2] : 0,
      y = bb[3] > 0 ? ar[1] / bb[3] : 0;
    const ov = R.draw.overrides,
      buf = ov?.packedBuffer,
      off = shapeIdx * ((ov?.texelsPerShape || 6) * 4);
    const a = buf ? buf[off] : 1,
      c = buf ? buf[off + 1] : 0,
      d = buf ? buf[off + 2] : 0,
      e = buf ? buf[off + 3] : 1;
    const w = world && world[8] !== 0 ? world[8] : 1,
      wa = world ? world[0] / w : 1,
      wc = world ? world[3] / w : 0;
    const wb = world ? world[1] / w : 0,
      wd = world ? world[4] / w : 1;
    return [
      cw * (wa * x * a - wc * y * d),
      ch * (-wb * x * a + wd * y * d),
      cw * (wa * x * c - wc * y * e),
      ch * (-wb * x * c + wd * y * e),
    ];
  }
  // The shape's own silhouette in top-left canvas px, or null when rects are off /
  // unsafe for this bundle. Shared by the graph route (where it seeds
  // computeNodeBboxes) and the single-kind route (which just dilates it by the
  // kernel's reach) so the two can't disagree about where the shape is.
  // `rect` ([ex0, ey0, ex1, ey1] in em), when given, replaces the shape's own stroke-padded bbox: a root-space filter
  // region, mapped through the same override, world matrix and fit as the shape.
  // `forRegion`: a filter REGION clip is correctness, not the bbox-RT optimization, so it maps whether or not that
  // optimization (or its diagnostic switch) is on. Nine-slice still returns null: its meta bbox is the native extent.
  function _shapeBboxPx(shapeIdx, cw, ch, rect, forRegion, inkTight) {
    if (!forRegion && !R._filterBboxEnabled) return null;
    const b = R._handle.bundle;
    // Nine-slice rewrites the fill cover-quad to the stretched target but leaves
    // the per-shape meta bbox (texels 0-3) at its NATIVE extent. Mapping that
    // native bbox through the target globalBBox below would size the filter RTs to
    // where the native rect lands in target space (the un-stretched corner) —
    // silently clipping the 9-sliced filtered shape. Run a 9-sliced bundle on
    // canvas-sized RTs; correct, just unoptimized.
    if (b && b._nineSliceActive) return null;
    // Each RT owns an explicit canvas rect and consumers remap UVs through it, so
    // allocation at the bbox replaces a separate scissor. The diagnostic switch
    // falls back to canvas-sized RTs when validating rect calculations.
    if (!forRegion && typeof globalThis !== 'undefined' && R.mantleDebugFlag('noFilterBbox'))
      return null;
    const meta = b.metaFloats,
      st = b.metaFloatsPerShape | 0,
      mb = (shapeIdx | 0) * st;
    // GPU morph interpolation leaves the CPU meta plane at the source pose.
    // Group accumulators and filter targets must contain the current silhouette,
    // just as explicit filter regions do. Reuse their matched-row pose helper.
    const posedBox = b._morphSrc ? _rowBoxEm(b, shapeIdx, meta, mb) : null;
    const toPx = _shapeToPx(shapeIdx, cw, ch);
    // The meta bbox (texel 0) bounds the FILL. A stroke straddles the outline, so it
    // reaches half a stroke-width beyond it — and a miter join reaches miterLimit times
    // further still at a sharp corner. Sizing an RT to the fill bbox CUTS THE STROKE OFF
    // at the RT edge. Pad in EM, before the override transform, so an overridden shape's
    // pad scales with it exactly as its stroke does.
    //   texel 3 = (strokeWidth, fillRuleEvenOdd, accumGroup, dashId)
    //   texel 6 = (capStyle, joinStyle, miterLimit, flagsShape)
    //
    // An override's absolute stroke width (mask bit 4, col 5.x) replaces the row's in the vertex stage, which grows the cover with it: a box from the authored width cut the wider stroke.
    const authoredW = Math.abs((posedBox ? posedBox[4] : meta[mb + 12]) || 0);
    const ovRow = R.draw.overrides && R.draw.overrides.packedBuffer,
      ovAt = (shapeIdx | 0) * 24;
    const strokeW = rect
      ? 0
      : ovRow && ovAt + 20 < ovRow.length && (Math.round(ovRow[ovAt + 7]) & 4) !== 0
        ? Math.abs(ovRow[ovAt + 20])
        : authoredW;
    let padEm = 0;
    if (strokeW > 0) padEm = 0.5 * strokeW * metaStrokeReachFactor(meta, mb);
    // `inkTight` (the group-alpha overlap tests): a plain stroke row's bbox is ALREADY the path box grown by halfW (svg/bundleFinalize.js
    // bboxMeta), so the ink -- at most halfW * reach from the path -- lies within halfW * (reach - 1) of it; the pad above counts the
    // first halfW twice. A row whose stroke width is not in the same space as its box (non-scaling, vector-effect, drawn in stroke
    // space) or that has no visible stroke keeps the whole pad.
    if (
      inkTight &&
      strokeW > 0 &&
      !posedBox &&
      meta[mb + 11] > 0 &&
      (Math.round(meta[mb + 27]) & 0x1c05) === 0
    )
      padEm = Math.max(0, 0.5 * (strokeW * metaStrokeReachFactor(meta, mb) - authoredW));
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    const ex0 = rect ? rect[0] : (posedBox ? posedBox[0] : meta[mb + 0]) - padEm,
      ey0 = rect ? rect[1] : (posedBox ? posedBox[1] : meta[mb + 1]) - padEm;
    const ex1 = rect ? rect[2] : (posedBox ? posedBox[2] : meta[mb + 2]) + padEm,
      ey1 = rect ? rect[3] : (posedBox ? posedBox[3] : meta[mb + 3]) + padEm;
    for (const [cx, cy] of [
      [ex0, ey0],
      [ex1, ey0],
      [ex0, ey1],
      [ex1, ey1],
    ]) {
      const [px, py] = toPx(cx, cy);
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    if (!(maxX > minX) || !(maxY > minY)) return null; // degenerate
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  // A canvas rect (GL px, origin bottom-left) from a top-left px bbox, padded, with
  // its SIZE rounded up to the quantum. Returns null if degenerate.
  //
  // The size is quantized; the ORIGIN is not. Snapping the rect to a global grid
  // instead — origin down, extent up — makes the SIZE depend on where the box happens
  // to fall on that grid, so two identical cards a few pixels apart get different-sized
  // RTs. Everything downstream is cached by size, and the filter-result cache DELETES
  // And recreates its texture whenever the size changes: six identical cards thrashed
  // one cache entry through several sizes every frame. Sizing off the box's own extent
  // makes identical shapes agree no matter where they sit.
  const RECT_PAD = 2;
  // Rect quantum. Coarse ON PURPOSE — it is an ALLOCATION-CHURN control, not a
  // pixel-budget one.
  //
  // The cost is a few more shaded pixels per pass, which is noise next to the canvas
  // these rects replaced.
  const RECT_Q = 128;
  const _evenDown = (v) => 2 * Math.floor(v / 2); // (not `v & ~1`: a pixel coordinate of a shape zoomed far past the canvas is past 2^31, where bit operators wrap it)
  function _bboxToRect(bb, ch, padX = 0, padY = 0) {
    if (!bb || !(bb.w > 0) || !(bb.h > 0)) return null;
    const qUp = (v) => Math.max(RECT_Q, Math.ceil(v / RECT_Q) * RECT_Q);
    const px = RECT_PAD + padX,
      py = RECT_PAD + padY;
    // The GL origin of every rect is forced EVEN on both axes.
    //
    // A shape rendered into a rect-sized RT gets the same projection under a
    // TRANSLATED viewport, so its geometry is unchanged — but gl_FragCoord is
    // rect-local, and derivatives (fwidth/dFdx) are evaluated over 2x2 fragment
    // quads aligned to EVEN framebuffer coordinates. An odd origin therefore
    // re-pairs every fragment with different neighbors than the canvas-sized
    // render did, and any AA that reads a derivative lands one quad out.
    //
    // It is small and it is real: a shape at an odd origin differs from the
    // canvas-sized render on exactly its CORNERS (up to a third of full alpha —
    // corners being where both derivatives matter), which a feComposite-in
    // against a flood then amplifies across hundreds of pixels of output, while
    // a shape at an even origin is byte-identical. Rounding the origin down to even keeps every fragment's
    // quad-mate the same as on the canvas, which is what makes the two routes
    // agree exactly rather than approximately.
    const x0 = _evenDown(Math.floor(bb.x - px)); // left edge, top-left px
    const yTop = Math.floor(bb.y - py); // top edge, top-left px
    const w = qUp(Math.ceil(bb.x + bb.w + px) - x0);
    let h = qUp(Math.ceil(bb.y + bb.h + py) - yTop);
    if (w <= 0 || h <= 0) return null;
    // Flip to GL (origin bottom-left). The y origin's parity follows the CANVAS
    // height, so an odd-height canvas needs one more nudge: drop the origin a
    // row and add both rows back to the height, which keeps the box containing
    // the padded bbox and keeps the height even.
    let ry = ch - (yTop + h);
    if (ry % 2 !== 0) {
      ry -= 1;
      h += 2;
    }
    // The quantized box grows DOWN and RIGHT from (x0, yTop), so it still contains the
    // padded bbox.
    //
    // In a filter frame the "canvas" is the frame, and nothing outside it can be rendered (the viewport clips there),
    // so a rect is clipped to it. A clipped origin stays even: the frame's own origin is 0.
    const fr = _frames.length ? _frames[_frames.length - 1] : null;
    if (fr) {
      const X = _cutToFrame(x0, w, fr.W, fr.degraded),
        Y = _cutToFrame(ry, h, fr.H, fr.degraded);
      if (!X || !Y) return null;
      return [X[0], Y[0], X[1], Y[1]];
    }
    return [x0, ry, w, h];
  }
  // One axis of a rect cut to the frame, back on the quantum: a cut size follows the shape, and the size is what the pool allocates. Grown inward from the edge that cut it, so the rect
  // still holds what it held and stays in the frame. The origin stays even (the frame's own origin is 0). A degraded frame keeps the cut as it is, like its margin (frameGeometry).
  function _cutToFrame(at, size, F, exact) {
    const lo = Math.max(0, at),
      hi = Math.min(F, at + size);
    if (hi <= lo) return null;
    if (hi - lo === size || exact) return [lo, hi - lo];
    const q = Math.min(F, Math.ceil((hi - lo) / RECT_Q) * RECT_Q);
    const top = Math.min(F, lo + q),
      bottom = _evenDown(Math.max(0, top - q));
    return [bottom, top - bottom];
  }
  const _isWholeCanvas = (r, cw, ch) =>
    r[0] <= 0 && r[1] <= 0 && r[0] + r[2] >= cw && r[1] + r[3] >= ch;
  /// A target outside a frame, cut to what can reach the canvas: the canvas plus `mx`, `my`, the reach of whatever reads this target (0 where only pointwise primitives do, Infinity
  /// where one reads from any distance). A shape far past the canvas otherwise asks for a target its own size, past the device's limit once it is zoomed in, for pixels nothing shows. The picture
  /// cannot change: by the margins, no pixel of the canvas reads across a cut edge. The size goes back on the quantum, so panning a shape past the edge does not reallocate per pixel, and the origin stays even.
  /// Nothing left: the smallest target, since a null rect means the whole canvas. (In a frame _bboxToRect has already cut to the frame.)
  function _clipRectToSeen(r, mx, my, cw, ch) {
    if (!r || _frames.length || r.empty) return r;
    const side = (v) => (v > 0 ? 2 * Math.ceil((v + FRAME_SLACK_PX) / 2) : 0); // even, so the origin below stays even
    const ax = side(mx),
      ay = side(my);
    const x = Math.max(r[0], -ax),
      y = Math.max(r[1], -ay),
      w = Math.min(r[0] + r[2], cw + ax) - x,
      h = Math.min(r[1] + r[3], ch + ay) - y;
    if (w === r[2] && h === r[3]) return r;
    if (w <= 0 || h <= 0)
      return [_evenDown(Math.min(x, cw + ax)), _evenDown(Math.min(y, ch + ay)), 2, 2];
    const onQ = (v, cap) => Math.min(cap, Math.ceil(v / RECT_Q) * RECT_Q);
    return [x, y, onQ(w, r[2]), onQ(h, r[3])];
  }

  // ── Filter frame (filterFrame.js) ─────────────────────────────────────────
  // A filtered draw whose shape crosses the canvas edge runs in a FRAME: the canvas plus a margin, so the filter's
  // neighborhood sees the shape beyond the edge. Inside the frame the "canvas" is the frame (viewportSize() answers W x H and
  // the world matrix is compensated), so every rect, pool RT and region below needs no change of its own; only the hand-off
  // back to the real target shifts by the margin (the composites below).
  const _frames = [];
  R._filterFrameTop = () => (_frames.length ? _frames[_frames.length - 1] : null);
  let _frameMaxDim = 0,
    _frameWarned = false;
  // The box a shape's source can occupy, in top-left px: its own box (_shapeBboxPx), or for a nine-sliced bundle -- whose meta box is
  // the native one, not where the stretched mesh lands -- the bundle's whole target box (globalBBox = [x, y, w, h] in the target's em;
  // every shape of the bundle lies inside it) padded by the row's stroke reach at the largest stretch. An upper bound: the frame only
  // needs to be at least as large as the content, and a looser box costs a margin, never a pixel.
  function _frameBoxPx(shapeIdx, cw, ch) {
    const b = R._handle.bundle;
    if (!b._nineSliceActive) return _shapeBboxPx(shapeIdx, cw, ch, undefined, true);
    const g = b.globalBBox,
      ng = b._nineSliceGeom;
    if (!g || !ng) return null;
    const meta = b.metaFloats,
      mb = (shapeIdx | 0) * (b.metaFloatsPerShape | 0);
    const stretch = Math.max(
      1,
      ng.targetW / extentOr(ng.emR - ng.emL, 1e-12),
      ng.targetH / extentOr(ng.emB - ng.emT, 1e-12),
    );
    const sw = Math.abs(meta[mb + 12] || 0);
    const pad = sw > 0 ? 0.5 * sw * metaStrokeReachFactor(meta, mb) * stretch : 0;
    const toPx = _shapeToPx(shapeIdx, cw, ch);
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const [ex, ey] of [
      [g[0] - pad, g[1] - pad],
      [g[0] + g[2] + pad, g[1] - pad],
      [g[0] - pad, g[1] + g[3] + pad],
      [g[0] + g[2] + pad, g[1] + g[3] + pad],
    ]) {
      const [px, py] = toPx(ex, ey);
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }
  // How far a box goes past the canvas, px, SIGNED: the worst of the four edges, negative when the box is inside by that much.
  const _protrusionOf = (x0, y0, x1, y1, cw, ch) => Math.max(-x0, -y0, x1 - cw, y1 - ch);
  // A graph that reads a gradient owner paint (FillPaint / StrokePaint) reads something of infinite extent: it reaches as far past the canvas edge as
  // the filter region does (without a region, as far as the graph reads). -Infinity for a graph that reads none.
  function _paintProtrusion(graph, shapeIdx, cw, ch) {
    const paints = graph && graph.ownerPaints;
    if (
      !paints ||
      !graph.nodes.some((n) =>
        n.inputs.some(
          (i) =>
            (i === -5 && paints.fill?.kind === 'gradient' && paints.fill.gradientId > 0) ||
            (i === -6 && paints.stroke?.kind === 'gradient' && paints.stroke.gradientId > 0),
        ),
      )
    )
      return -Infinity;
    const rg = _regionBoxTL(shapeIdx, cw, ch);
    return rg ? _protrusionOf(rg.x0, rg.y0, rg.x1, rg.y1, cw, ch) : Infinity;
  }
  // A filter's own reach in px per axis ({0,0} for a pointwise one): a graph's longest path, a single-kind record's kernel.
  function _filterReachOf(graph, rec, shapeIdx, cw, ch) {
    if (graph) return graphReach(_pxGraph(graph, shapeIdx, cw, ch, null));
    if (rec && rec.kind >= 1) {
      const [pxX, pxY] = _filterPxPerEm(cw, ch, shapeIdx);
      return singleKindReach(rec, pxX, pxY);
    }
    return { rx: 0, ry: 0 };
  }
  // The filter region as a top-left px box, or null (none stated, or empty).
  function _regionBoxTL(shapeIdx, cw, ch) {
    const r = _filterRegionRectPx(shapeIdx, cw, ch);
    return r && r !== EMPTY_REGION
      ? { x0: r[0], y0: ch - (r[1] + r[3]), x1: r[0] + r[2], y1: ch - r[1] }
      : null;
  }
  // Grow a box by a filter's reach, then clip it to that filter's region (nothing is painted outside it): the extent of the filter's output.
  function _afterFilter(e, reach, region) {
    const x0 = e.x0 - reach.rx,
      y0 = e.y0 - reach.ry,
      x1 = e.x1 + reach.rx,
      y1 = e.y1 + reach.ry;
    return region
      ? {
          x0: Math.max(x0, region.x0),
          y0: Math.max(y0, region.y0),
          x1: Math.min(x1, region.x1),
          y1: Math.min(y1, region.y1),
        }
      : { x0, y0, x1, y1 };
  }
  // The decision (box, reach, margin, geometry) is a pure function of the inputs below, which a static scene repeats every frame: keep the
  // last answer per shape row and reuse it while they are bitwise equal. The frame object is reused too (its per-use fields are set on entry).
  function _filterFrameFor(shapeIdx, cw, ch, graph, rec) {
    if (R.opts.filterFrame === false) return null;
    const h = R._handle,
      b = h && h.bundle;
    if (!b) return null;
    const memo = (h._frameMemo ||= new Map());
    const mk = (shapeIdx | 0) * 2 + (graph ? 1 : 0);
    const w = R.draw.worldM,
      ov = R.draw.overrides;
    const sg = overrideRowKey(ov, shapeIdx | 0),
      mt = b._morphSrc ? b._morphSrc.t : 0,
      pg = b._filterParamGen | 0;
    const e = memo.get(mk);
    if (
      e &&
      e.cw === cw &&
      e.ch === ch &&
      e.gen === h.generation &&
      e.geom === (b._geomGen | 0) &&
      e.mt === mt &&
      e.pg === pg &&
      e.sg === sg &&
      e.graph === graph &&
      e.rec === rec &&
      e.mp === R.opts.filterFrameMaxPixels &&
      e.nine === !!b._nineSliceActive &&
      (w ? e.w && e.w.every((v, i) => v === w[i]) : !e.w)
    )
      return e.fr;
    const fr = _filterFrameForIn(shapeIdx, cw, ch, graph, rec);
    memo.set(mk, {
      cw,
      ch,
      gen: h.generation,
      geom: b._geomGen | 0,
      mt,
      pg,
      sg,
      graph,
      rec,
      mp: R.opts.filterFrameMaxPixels,
      nine: !!b._nineSliceActive,
      w: w ? Array.from(w) : null,
      fr,
    });
    return fr;
  }
  function _filterFrameForIn(shapeIdx, cw, ch, graph, rec) {
    const b = R._handle && R._handle.bundle;
    // A graph that reads the backdrop snapshots the canvas (below): it keeps the canvas as its frame. (An external clip texture and a
    // nine-sliced bundle are framed: _enterFilterFrame re-lays the clip over the frame, _frameBoxPx bounds the nine-slice target.)
    if (!b) return null;
    if (graph && R._graphReadsBackdrop(graph)) return null;
    const bb = _frameBoxPx(shapeIdx, cw, ch);
    if (!bb) return null;
    let protrusion = _protrusionOf(bb.x, bb.y, bb.x + bb.w, bb.y + bb.h, cw, ch);
    if (graph) protrusion = Math.max(protrusion, _paintProtrusion(graph, shapeIdx, cw, ch));
    let need;
    if (graph) need = graphFrameNeed(_pxGraph(graph, shapeIdx, cw, ch, null), protrusion);
    else {
      const r = _filterReachOf(null, rec, shapeIdx, cw, ch);
      need = Math.min(Math.max(r.rx, r.ry), protrusion);
    }
    if (!(need > 0)) return null; // nothing to pull in from past the edge (inside the canvas, or pointwise): the draw is byte-identical to before
    return _grantFrame(need, cw, ch);
  }
  function _maxTargetDim() {
    if (!_frameMaxDim) {
      _frameMaxDim = Math.min(
        gl.getParameter(gl.MAX_TEXTURE_SIZE),
        gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
        (gl.getParameter(gl.MAX_VIEWPORT_DIMS) || [1 << 30])[0],
      );
    }
    return _frameMaxDim;
  }
  function _grantFrame(need, cw, ch) {
    _maxTargetDim();
    const fr = frameGeometry({
      need,
      cw,
      ch,
      maxDim: _frameMaxDim,
      maxPixels: R.opts.filterFrameMaxPixels > 0 ? R.opts.filterFrameMaxPixels : undefined,
    });
    if (fr && fr.degraded && !_frameWarned) {
      _frameWarned = true;
      R.mantleWarn(
        `[Mantle] a filtered shape reaches ${fr.wanted}px past the canvas, more than a ${_frameMaxDim}px render target can hold: ` +
          `its filter is evaluated at 1/${fr.s} resolution (filterFrameMaxPixels sets the budget).`,
      );
    }
    return fr;
  }
  function _enterFilterFrame(fr) {
    const bbox = R._handle.bundle.globalBBox;
    const c = arScale(bbox, fr.cw, fr.ch),
      arC = [c[0], c[1]];
    const f = arScale(bbox, fr.W, fr.H),
      arF = [f[0], f[1]];
    fr.savedWorld = R.draw.worldM;
    fr.savedViewport = R._explicitViewport;
    R.draw.worldM = frameWorldMatrix(fr.savedWorld, arC, arF, fr);
    R._explicitViewport = [fr.W, fr.H];
    _frames.push(fr);
    R.fillPassCanvasW = 0;
    R.fillPassCanvasH = 0;
    // An external clip (setNodeClip) is a coverage texture the fill samples by fragment position over the viewport: laid over the
    // canvas, it would land stretched over the frame. Re-lay it over the frame (the margin reads the clip's edge texel) for the span.
    fr.savedClip = R.draw.extClipTex;
    if (fr.savedClip && R.draw.extClipMode > 0) R.draw.extClipTex = _frameClipTex(fr, fr.savedClip);
    if (fr.syncMasks && R._ensureMaskBake) R._ensureMaskBake();
  }
  // `clip` (a coverage texture the size of the frame's host) resampled into a frame-sized target: frame pixel f is host pixel f * s - Mc.
  function _frameClipTex(fr, clip) {
    const rt = R._acquireShapeRT(fr.W, fr.H, 'frame-clip:');
    bindFb(gl.FRAMEBUFFER, rt.fbo);
    R.glViewport(0, 0, fr.W, fr.H);
    R.glDisable(gl.DEPTH_TEST);
    R.glDisable(gl.STENCIL_TEST);
    R.glDisable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    _bindOverBlit(clip, 1, [
      (fr.W * fr.s) / fr.cw,
      (fr.H * fr.s) / fr.ch,
      -fr.Mc / fr.cw,
      -fr.Mc / fr.ch,
    ]);
    R.glBindVertexArray(coverVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    R.glBindVertexArray(null);
    R._handle.fillPassAssetDirty = true;
    return rt.tex;
  }
  function _exitFilterFrame(fr) {
    _frames.pop();
    R.draw.worldM = fr.savedWorld;
    R._explicitViewport = fr.savedViewport;
    R.draw.extClipTex = fr.savedClip;
    R.fillPassCanvasW = 0;
    R.fillPassCanvasH = 0;
    if (R._handle) R._handle.fillPassAssetDirty = true;
    if (fr.syncMasks && R._ensureMaskBake) R._ensureMaskBake();
  }
  // Mask layers are baked at the canvas and sampled by canvas pixel. A filtered SHAPE's mask is an effect mask, sampled when the
  // filtered result is composited onto the target (the target's own pixels, after the frame hands back), so a shape's frame never
  // touches the bake. A masked row in a framed GROUP is sampled while the frame is open, at frame pixels: that frame re-bakes the
  // layers at its own size on entry and at the canvas's on exit (`syncMasks`; the frame has a slot of its own per handle, so a draw bakes only when a slot's world matrix or canvas moved: twice on a moving frame, never on a steady one).
  function _rowHasMask(row) {
    const b = R._handle.bundle,
      off = row * b.metaFloatsPerShape;
    return Math.round(b.metaFloats[off + 30]) > 0 || Math.round(b.metaFloats[off + 31]) > 0;
  }
  // A group's descendants for the frame decision, computed once per draw-list op: each leaf shape op with the filtered groups it sits in
  // (inside the group, innermost last), and whether any group or row among them is masked. null = the op is not in the draw list.
  function _groupKidsFor(op, b) {
    const c = op._frameKids;
    if (c && c.dl === b.drawList) return c.kids;
    const dl = b.drawList,
      i0 = dl.indexOf(op);
    let kids = null;
    if (i0 >= 0) {
      kids = { rows: [], masked: _rowHasMask(op.shapeIdx | 0) };
      const nest = [];
      let depth = 1;
      for (let j = i0 + 1; j < dl.length; j++) {
        const o = dl[j];
        if (o.kind === 'groupBegin') {
          depth++;
          nest.push(o.filterId ? o : null);
          if (o.shapeIdx >= 0 && _rowHasMask(o.shapeIdx | 0)) kids.masked = true;
        } else if (o.kind === 'groupEnd') {
          if (--depth === 0) break;
          nest.pop();
        } else if (o.kind === 'fillShape') {
          if (_rowHasMask(o.shapeIdx | 0)) kids.masked = true;
          kids.rows.push({ o, nest: nest.filter(Boolean) });
        }
      }
    }
    op._frameKids = { dl, kids };
    return kids;
  }
  /// The frame of a FILTERED GROUP (`op`, its groupBegin), whose source is whatever its children paint. The source's extent is the union
  /// of the children's boxes, each GROWN by its own filter's reach (a child blur pushes content past its box) and by those of the
  /// filtered groups it sits in, each clipped to that filter's region (a child whose box cannot be bounded makes the extent unknown,
  /// which asks for the graph's whole reach). Null for a graph that reads the backdrop.
  R._filterFrameForGroup = (op, cw, ch, graph) => {
    if (R.opts.filterFrame === false) return null;
    const b = R._handle && R._handle.bundle;
    if (!b || !graph || R._graphReadsBackdrop(graph)) return null;
    const shapeIdx = op.shapeIdx | 0,
      kids = _groupKidsFor(op, b);
    let protrusion = kids && kids.rows.length ? -Infinity : Infinity;
    if (kids)
      for (const { o, nest } of kids.rows) {
        const si = o.shapeIdx | 0;
        const bb = _frameBoxPx(si, cw, ch);
        if (!bb) {
          protrusion = Infinity;
          break;
        }
        let e = { x0: bb.x, y0: bb.y, x1: bb.x + bb.w, y1: bb.y + bb.h };
        if (o.filterGraphId || o.filterId) {
          const fg = o.filterGraphId ? b.filterGraphs && b.filterGraphs[o.filterGraphId - 1] : null;
          const rec = !fg && o.filterId ? R.filterRecord(o.filterId) : null;
          e = _afterFilter(e, _filterReachOf(fg, rec, si, cw, ch), _regionBoxTL(si, cw, ch));
        }
        for (let k = nest.length - 1; k >= 0; k--) {
          const ng = b.filterGraphs && b.filterGraphs[nest[k].filterId - 1],
            row = nest[k].shapeIdx | 0;
          if (ng)
            e = _afterFilter(e, _filterReachOf(ng, null, row, cw, ch), _regionBoxTL(row, cw, ch));
        }
        protrusion = Math.max(protrusion, _protrusionOf(e.x0, e.y0, e.x1, e.y1, cw, ch));
      }
    protrusion = Math.max(protrusion, _paintProtrusion(graph, shapeIdx, cw, ch));
    const need = graphFrameNeed(_pxGraph(graph, shapeIdx, cw, ch, null), protrusion);
    if (!(need > 0)) return null;
    const fr = _grantFrame(need, cw, ch);
    if (fr && (!kids || kids.masked)) fr.syncMasks = true;
    return fr;
  };
  R._filterFrameFor = _filterFrameFor;
  R._enterFilterFrame = _enterFilterFrame;
  R._exitFilterFrame = _exitFilterFrame;
  R._shapeBboxPx = _shapeBboxPx; // a shape's exact painted box in px (top-left), under the current per-draw world matrix and overrides
  R._bboxToRect = _bboxToRect; // the COLR leaf's node rects take the same padding, quantum and even origins

  // The rect a SINGLE-KIND filter (blur / morphology / convolve — no graph) needs:
  // the shape, dilated by that kernel's reach in canvas px. Same job computeNodeBboxes
  // does for a graph, for the one-node case where there is no graph to walk.
  function _filterSingleKindRect(shapeIdx, cw, ch, f, pxPerEmX, pxPerEmY) {
    const bb = _shapeBboxPx(shapeIdx, cw, ch);
    if (!bb) return null;
    let rx = 0,
      ry = 0;
    if (f.kind === 1) {
      // Gaussian: the tap table truncates at ±3σ; the box passes that take the
      // widest blurs reach about as far (their weight past 3σ is under a level).
      rx = Math.ceil(3 * Math.abs(f.sigmaX * pxPerEmX));
      ry = Math.ceil(3 * Math.abs(f.sigmaY * pxPerEmY));
    } else if (f.kind === 5) {
      // Morphology: dilate grows by the radius; erode only shrinks, but padding by
      // the radius anyway is over-inclusive, never wrong.
      rx = Math.ceil(Math.abs(f.sigmaX * pxPerEmX));
      ry = Math.ceil(Math.abs(f.sigmaY * pxPerEmY));
    } else if (f.kind === 6) {
      // Convolve: one kernel cell is one canvas px, so the reach is the order.
      rx = Math.max(f.orderX | 0, 1);
      ry = Math.max(f.orderY | 0, 1);
    }
    const r = _clipRectToSeen(_bboxToRect(bb, ch, rx, ry), rx, ry, cw, ch);
    if (!r || _isWholeCanvas(r, cw, ch)) return null;
    return r;
  }

  /// Where each EXTERNAL feImage of `graph` draws for this shape, aligned with graph.nodes (null for any
  /// other node): { sub, img } in GL canvas px (origin bottom-left, [x, y, w, h]) -- the primitive
  /// subregion it is clipped to and its fitted image -- plus `subTL`, the subregion as a top-left px box,
  /// or { empty: true } when it draws nothing. null when the graph has none, or for a nine-sliced bundle
  /// (whose meta box is not where it draws; the handler then falls back to the region fit).
  ///
  /// The placement itself is filterGraph/feImagePlace.js, in em. The filter region and the referencing
  /// element's box are resolved here exactly as _filterRegionRectPx resolves them, and every em rect goes
  /// to pixels through _shapeBboxPx, the same mapping the region clip takes.
  function _feImagePlacements(graph, shapeIdx, cw, ch) {
    if (
      !graph ||
      !graph.nodes ||
      !graph.nodes.some((n) => n.type === 'feImage' && n.params && n.params.external)
    )
      return null;
    const env = _placeEnv(shapeIdx);
    if (!env) return null;
    const { regionEm, boxEm, ctm } = env;
    const toGL = (r) => [r.x, ch - (r.y + r.h), r.w, r.h];
    return graph.nodes.map((n) => {
      if (n.type !== 'feImage' || !n.params || !n.params.external) return null;
      const pl = feImagePlacement(n.params, { regionEm, boxEm, ctm });
      const sub = pl && _shapeBboxPx(shapeIdx, cw, ch, pl.sub, true);
      const img = pl && _shapeBboxPx(shapeIdx, cw, ch, pl.img, true);
      if (!sub || !img) return { empty: true };
      return { sub: toGL(sub), img: toGL(img), subTL: sub };
    });
  }

  /// What a primitive's subregion is measured against for this shape, in em (root user space, where the meta rows live): the filter
  /// region, the referencing element's box (geometry, no stroke) and its CTM. null for a nine-sliced bundle (whose meta box is not where
  /// it draws; the callers then fall back to the region).
  function _placeEnv(shapeIdx) {
    const b = R._handle && R._handle.bundle;
    if (!b || b._nineSliceActive) return null;
    const meta = b.metaFloats,
      st = b.metaFloatsPerShape | 0,
      mb = (shapeIdx | 0) * st;
    const fid = Math.floor(meta[mb + 32] + 0.5); // MT_FILTER_BLEND .x
    const rg = fid > 0 && b.filterRegions ? b.filterRegions[fid - 1] : null;
    // The referencing element's box: the geometry without the stroke, as _filterRegionRectPx takes it.
    const row = _rowBoxEm(b, shapeIdx, meta, mb);
    const sw = Math.abs(row[4] || 0);
    const hw = sw > 0 && !((meta[mb + 27] | 0) & 1) ? 0.5 * sw : 0;
    const boxEm = [row[0] + hw, row[1] + hw, row[2] - hw, row[3] - hw];
    const bw = boxEm[2] - boxEm[0],
      bh = boxEm[3] - boxEm[1];
    // The region: a root-space rect, fractions of the box, or (no entry) the -10%/120% default.
    const fr = rg && (rg[4] | 0) === 1 ? null : rg || [-0.1, -0.1, 1.2, 1.2];
    const regionEm = fr
      ? [
          boxEm[0] + fr[0] * bw,
          boxEm[1] + fr[1] * bh,
          boxEm[0] + (fr[0] + fr[2]) * bw,
          boxEm[1] + (fr[1] + fr[3]) * bh,
        ]
      : _morphRegionEm(b, fid) || [rg[0], rg[1], rg[0] + rg[2], rg[1] + rg[3]];
    const ctm = (fid > 0 && b.filterPrimCtms && b.filterPrimCtms[fid - 1]) || null;
    return { regionEm, boxEm, ctm };
  }

  // Graphs that state a primitive subregion (params.sub, or an external feImage's stated one), by identity: the scan runs once per graph.
  const _graphStatesSub = new WeakMap();
  function _hasPrimSub(graph) {
    if (!graph || !graph.nodes) return false;
    let v = _graphStatesSub.get(graph);
    if (v === undefined) {
      v = graph.nodes.some(
        (n) => n.params && (n.type === 'feImage' ? n.params.subStated : n.params.sub),
      );
      _graphStatesSub.set(graph, v);
    }
    return v;
  }
  /// The primitive subregions of `graph` for this shape as device pixels (Filter Effects 1 §15.3; filterGraph/feImagePlace.js primitiveSubregions
  /// resolves them in em), or null when no primitive states one -- the whole of the cost for a graph that does not. Per node: null = the
  /// filter region (nothing to clip beyond the region), { empty: true } = no area (transparent), else the rect with its edges ROUNDED OUT to
  /// whole pixels, { gl: [x, y, w, h] (origin bottom-left), tl: { x, y, w, h } (top-left) }. `clips` is `gl` per node for the nodes the
  /// evaluation must clear outside of (an external feImage clips itself).
  function _primSubs(graph, shapeIdx, cw, ch) {
    if (!_hasPrimSub(graph)) return null;
    const env = _placeEnv(shapeIdx);
    if (!env) return null;
    const em = primitiveSubregions(graph, env);
    const rects = em.map((e) => {
      if (e === null || e === undefined) return null;
      if (e === 'empty') return { empty: true };
      const tl = _shapeBboxPx(shapeIdx, cw, ch, e, true);
      if (!tl) return { empty: true };
      // The ENCLOSING pixel rect (floor the near edges, ceil the far ones), which is what Chrome clips a fractional subregion to at 1x
      // (x 10.25..30.25 user units at 2x draws columns 20..60). A relative slack keeps a pixel edge that float noise put a hair off from
      // growing a whole column, at any scale.
      const lo = (v) => Math.floor(v + 1e-9 * Math.max(1, Math.abs(v))),
        hi = (v) => Math.ceil(v - 1e-9 * Math.max(1, Math.abs(v)));
      const x0 = lo(tl.x),
        y0 = lo(tl.y),
        x1 = hi(tl.x + tl.w),
        y1 = hi(tl.y + tl.h);
      if (!(x1 > x0 && y1 > y0)) return { empty: true };
      return { gl: [x0, ch - y1, x1 - x0, y1 - y0], tl: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
    });
    const clips = rects.map((r, i) =>
      r && graph.nodes[i].type !== 'feImage' ? (r.empty ? [0, 0, 0, 0] : r.gl) : null,
    );
    return { rects, clips };
  }
  R._primSubs = _primSubs;

  const _unionGL = (a, b) => {
    const x = Math.min(a[0], b[0]),
      y = Math.min(a[1], b[1]);
    return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
  };

  // A primitive's rect clipped to the filter region. The region's edges are arbitrary pixels, but every rect's GL
  // origin must stay EVEN (see _bboxToRect): an odd origin re-pairs fragments into different 2x2 derivative quads than
  // the canvas-sized render. Round the origin down and give the width and height back.
  function _clipRectToRegion(r, region) {
    const x0 = Math.max(r[0], region[0]),
      y0 = Math.max(r[1], region[1]);
    const w0 = Math.min(r[0] + r[2], region[0] + region[2]) - x0;
    const h0 = Math.min(r[1] + r[3], region[1] + region[3]) - y0;
    const x = _evenDown(x0),
      y = _evenDown(y0);
    return Object.assign([x, y, Math.max(1, w0 + (x0 - x)), Math.max(1, h0 + (y0 - y))], {
      empty: w0 <= 0 || h0 <= 0,
    });
  }

  // A node's rect back on the quantum. The region cuts a rect to its own edges, which move with the shape and with the zoom, and the size is what the pool allocates: a moving filtered shape would ask
  // for a new target on nearly every frame. So the target grows on the quantum, at the same origin, and `keep` says what it covers: every pass is scissored there (filterGraph.js applyKeepScissor), so
  // the fragments and the answer are the exact rect's. `exact`: a reader that takes the edge of the target for the edge of its input (feConvolveMatrix's edge modes). A degraded frame stays as it is, as its margin does.
  function _onQuantum(r, exact) {
    if (exact || r.empty || (_frames.length && _frames[_frames.length - 1].degraded)) return r;
    const w = Math.ceil(r[2] / RECT_Q) * RECT_Q,
      h = Math.ceil(r[3] / RECT_Q) * RECT_Q;
    if ((w === r[2] && h === r[3]) || w > _maxTargetDim() || h > _maxTargetDim()) return r;
    return Object.assign([r[0], r[1], w, h], { keep: [r[0], r[1], r[2], r[3]] });
  }

  // The graph with its spatial parameters in DEVICE PIXELS (blur sigma, offset, morphology radius, displacement scale, an
  // external feImage's subregion), for bbox propagation and for the frame's reach. The dispatch handlers fold the same scales
  // at draw time.
  function _pxGraph(graph, shapeIdx, cw, ch, _feImg, _subs) {
    // computeNodeBboxes works in canvas pixels, but the SVG graph's
    // spatial params (blur σ, offset dx/dy, morphology radius, …) are in
    // em/userspace units — the dispatch handlers fold _filterPxPerEm at
    // draw time. Scale a shallow clone of the graph's params to px so the
    // propagated bboxes match the rendered extents (mirrors the COLR
    // path's rescaleColrGraph). Anisotropic: x by pxX, y by pxY.
    const [pxX, pxY] = _filterPxPerEm(cw, ch, shapeIdx);
    const pxS = Math.max(pxX, pxY);
    let offsetM = null;
    const withSub = (nd, ni) => {
      const sr = _subs && _subs.rects[ni];
      return sr && !sr.empty && nd.type !== 'feImage'
        ? { ...nd, params: { ...nd.params, subregionPx: sr.tl } }
        : nd;
    };
    const scaled = (nd, ni, p) => {
      switch (nd.type) {
        case 'feGaussianBlur': {
          if (p.m) {
            // the element's axes: the reach on the DEVICE axes is the axes' combined spread
            offsetM ||= _offsetMatrixPx(shapeIdx, cw, ch);
            const { rx, ry } = blurAxesPx(p, offsetM);
            return { ...nd, params: { ...p, sigmaX: rx, sigmaY: ry } };
          }
          return {
            ...nd,
            params: { ...p, sigmaX: (p.sigmaX || 0) * pxX, sigmaY: (p.sigmaY || 0) * pxY },
          };
        }
        case 'feOffset':
          offsetM ||= _offsetMatrixPx(shapeIdx, cw, ch);
          return {
            ...nd,
            params: {
              ...p,
              dx: (p.dx || 0) * offsetM[0] + (p.dy || 0) * offsetM[2],
              dy: (p.dx || 0) * offsetM[1] + (p.dy || 0) * offsetM[3],
            },
          };
        case 'feMorphology': {
          if (p.m) {
            // the element's axes: the window's reach on the device axes
            offsetM ||= _offsetMatrixPx(shapeIdx, cw, ch);
            const { ex, ey } = morphAxesPx(p, offsetM);
            return { ...nd, params: { ...p, radiusX: ex, radiusY: ey } };
          }
          return {
            ...nd,
            params: { ...p, radiusX: (p.radiusX || 0) * pxX, radiusY: (p.radiusY || 0) * pxY },
          };
        }
        case 'feDisplacementMap': {
          if (p.m) {
            // under the element's transform: the larger of the two user axes' lengths in pixels
            offsetM ||= _offsetMatrixPx(shapeIdx, cw, ch);
            const o = offsetM,
              m = p.m;
            const l0 = Math.hypot(o[0] * m[0] + o[2] * m[1], o[1] * m[0] + o[3] * m[1]),
              l1 = Math.hypot(o[0] * m[2] + o[2] * m[3], o[1] * m[2] + o[3] * m[3]);
            return { ...nd, params: { ...p, scale: (p.scale || 0) * Math.max(l0, l1) } };
          }
          return { ...nd, params: { ...p, scale: (p.scale || 0) * pxS } };
        }
        case 'feImage': {
          const pl = _feImg && _feImg[ni];
          return pl && pl.subTL ? { ...nd, params: { ...p, subregionPx: pl.subTL } } : nd;
        }
        default:
          return nd; // order (cell count) + color params are px/unitless
      }
    };
    return {
      ...graph,
      nodes: graph.nodes.map((nd, ni) => (nd.params ? withSub(scaled(nd, ni, nd.params), ni) : nd)),
    };
  }

  function _filterNodeRects(graph, shapeIdx, cw, ch, sourceBounds = null) {
    const sourceBbox = sourceBounds || _shapeBboxPx(shapeIdx, cw, ch);
    if (!sourceBbox) {
      // The filter region clips every primitive's result, not only the last: a blur that reaches past it must not
      // come back through a later feOffset. That is correctness, so it holds when the bbox optimization is off or
      // has no safe bound -- the canvas-sized render clips at the region exactly as the bbox-sized one does.
      const region = _filterRegionRectPx(shapeIdx, cw, ch);
      if (!region || region === EMPTY_REGION) return null;
      const clipped = _clipRectToRegion([0, 0, cw, ch], region);
      if (_isWholeCanvas(clipped, cw, ch)) return null;
      return {
        rects: graph.nodes.map(() => clipped),
        source: null,
        subregions: graph.nodes.map(() => null),
      };
    }
    // An external feImage paints its own subregion, which reaches wherever it is placed -- not the
    // shape's box, the bound computeNodeBboxes otherwise assumes for a generator.
    const _feImg = _feImagePlacements(graph, shapeIdx, cw, ch);
    const b = R._handle.bundle;
    // Primitives that state a subregion (null for nearly every graph): narrowed to it here, and cleared outside it exactly when evaluated.
    const subs = _primSubs(graph, shapeIdx, cw, ch);
    const sgraph = _pxGraph(graph, shapeIdx, cw, ch, _feImg, subs);
    // A generator paints the whole filter region (its stated subregion narrows it in the pass below): what merges or blends one over the source
    // reaches past the source's box.
    const rgTL = _regionBoxTL(shapeIdx, cw, ch);
    const { bboxes } = computeNodeBboxes(
      sgraph,
      sourceBbox,
      cw,
      ch,
      rgTL && { x: rgTL.x0, y: rgTL.y0, w: rgTL.x1 - rgTL.x0, h: rgTL.y1 - rgTL.y0 },
    );
    // Generator resize pass (see header). GEN = no-input fillers; POINT =
    // consumers that sample at-uv inside their own bbox.
    const GEN = new Set([
      'feFlood',
      'feTurbulence',
      'feImage',
      'PaintSolid',
      'PaintLinearGradient',
      'PaintRadialGradient',
      'PaintSweepGradient',
    ]);
    const POINT = new Set([
      'feComposite',
      'feBlend',
      'feMerge',
      'feColorMatrix',
      'feComponentTransfer',
      'PaintComposite',
      'PaintMerge',
      'PaintGlyph',
    ]);
    const nN = graph.nodes.length;
    const consumers = graph.nodes.map(() => []);
    for (let i = 0; i < nN; i++)
      for (const inp of graph.nodes[i].inputs) if (inp >= 0 && inp < nN) consumers[inp].push(i);
    const unionRect = (a, c) => {
      if (!a) return { x: c.x, y: c.y, w: c.w, h: c.h };
      const x = Math.min(a.x, c.x),
        y = Math.min(a.y, c.y);
      return { x, y, w: Math.max(a.x + a.w, c.x + c.w) - x, h: Math.max(a.y + a.h, c.y + c.h) - y };
    };
    for (let i = 0; i < nN; i++) {
      if (!GEN.has(graph.nodes[i].type)) continue;
      if (subs && subs.rects[i] && !subs.rects[i].empty) continue; // it fills its stated subregion, whoever reads it
      const cs = consumers[i];
      if (cs.length && cs.every((c) => POINT.has(graph.nodes[c].type))) {
        let u = null;
        for (const c of cs) u = unionRect(u, bboxes[c]);
        if (u) bboxes[i] = u;
      } else {
        bboxes[i] = { x: 0, y: 0, w: cw, h: ch }; // unbounded / root → full canvas
      }
    }
    const FULL = [0, 0, cw, ch];
    const region = _filterRegionRectPx(shapeIdx, cw, ch);
    const seen = graphSeenMargins(sgraph);
    let anyBounded = !!region;
    const rects = bboxes.map((bb, bi) => {
      // A subregion with no area: the primitive is transparent black (the RT is cleared on acquire and the handler skipped).
      if (subs && subs.rects[bi] && subs.rects[bi].empty) {
        anyBounded = true;
        return Object.assign([0, 0, 2, 2], { empty: true });
      }
      let r = _bboxToRect(bb, ch);
      // Clip each primitive before its output becomes another primitive's input.
      if (region) r = _clipRectToRegion(r || FULL, region);
      r = _clipRectToSeen(r, seen.x[bi], seen.y[bi], cw, ch);
      // No safe bound, or it reaches the whole canvas anyway → a rect buys nothing.
      if (!r || _isWholeCanvas(r, cw, ch)) return FULL;
      anyBounded = true;
      return _onQuantum(
        r,
        consumers[bi].some(
          (c) =>
            graph.nodes[c].type === 'feConvolveMatrix' &&
            (graph.nodes[c].params?.edgeMode | 0) !== 2,
        ),
      );
    });
    if (!anyBounded) return null;
    // The SourceGraphic's own rect. The shape is rendered into an RT covering just
    // this, instead of a canvas-sized one — see renderer.acquireShapeRT. A primitive
    // reading SourceGraphic outside it reads 0, which is what the shape is there.
    const src = _clipRectToSeen(_bboxToRect(sourceBbox, ch), seen.srcX, seen.srcY, cw, ch);
    const source = src && !_isWholeCanvas(src, cw, ch) ? src : null;
    // The UNQUANTIZED bboxes travel too. A node's RT rect is its bbox padded and
    // rounded up to RECT_Q, which is an allocation decision; anything that needs
    // the primitive's true SUBREGION — feTurbulence's stitch period, whose whole
    // job is to match the tile a consumer will lay down — must not read the rect
    // and inherit the padding. GL-space (origin bottom-left), to match the rects.
    const subregions = bboxes.map((bb) =>
      bb && bb.w > 0 && bb.h > 0 ? [bb.x, ch - (bb.y + bb.h), bb.w, bb.h] : null,
    );
    return { rects, source, subregions };
  }
  // Composite the post-filter shapeFboTex over the destination — the tail
  // step shared by the single-kind filter cache hit + miss paths. Expects
  // shapeFboTex (or srcTex) to already hold the filtered shape. Single-kind
  // filters (blur / colorMatrix / morphology / convolve) all composite as a
  // straight premultiplied over-blend, so no backdrop is read (see
  // _bindOverBlit). Optional (srcTex, dstFbo) route the composite inside a
  // group (accumulator FBO as dst) — defaults preserve the canvas path.
  function _filterSingleKindComposite(
    f,
    cw,
    ch,
    srcTex = null,
    dstFbo = null,
    srcRect = null,
    clipRect = null,
  ) {
    bindFb(gl.FRAMEBUFFER, dstFbo);
    const ffr = _opFrame();
    let map = null,
      quad = clipRect && clipRect.quad;
    if (ffr) {
      const d = _frameDest(ffr, srcRect || [0, 0, cw, ch]);
      if (!d) return;
      clipRect = _clipToTarget(clipRect, ffr);
      srcRect = d.vp;
      map = d.map;
      cw = ffr.cw;
      ch = ffr.ch;
      if (quad) quad = _quadOnTarget(quad, ffr);
    }
    // Filter region clip — same reasoning as the graph route: a scissor, because
    // vUV spans the viewport and shrinking it would rescale rather than crop.
    const _clipOn = _pushRegionScissor(clipRect, dstFbo);
    // Same as the graph route: draw only where the filtered shape lives.
    if (srcRect) R.glViewport(srcRect[0], srcRect[1], srcRect[2], srcRect[3]);
    else R.glViewport(0, 0, cw, ch);
    R.glDisable(gl.DEPTH_TEST);
    R.glDisable(gl.STENCIL_TEST);
    R.glEnable(gl.BLEND);
    R.glBlendEquation(gl.FUNC_ADD);
    R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const edged = quad && _bindQuadBlit(srcTex || R.shapeFboTex, 1, map, 0, quad);
    if (!edged) _bindOverBlit(srcTex || R.shapeFboTex, 1, map, 0); // (a linear-light blur has already handed its result back as sRGB: blurShapeFbo)
    if (quad && !edged) _drawQuadGeometry(quad, srcRect || [0, 0, cw, ch]);
    else {
      R.glBindVertexArray(coverVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      R.glBindVertexArray(null);
    }
    _popRegionScissor(_clipOn, dstFbo);
  }
  // Copy a freshly-evaluated filter output (a transient pool RT texture)
  // into the persistent per-filter-graph-and-shape cache texture + stamp its key.
  // Uses a blit (read FBO = src, draw FBO = the cache's own FBO).
  // `rect` — the canvas rect the filtered output covers (null = whole canvas).
  // The cache texture is allocated at the RECT, so a small filtered shape doesn't
  // hold a canvas-sized texture per filter graph; the rect rides along so the hit
  // path composites it back where it belongs.
  function _storeFilteredTex(filterGraphId, srcTex, cw, ch, key, rect = null, cs = 0) {
    let c = R._getFilterCache(filterGraphId);
    let pl = _resultPlacement(c && c.tex ? c : null, rect, cw, ch);
    if (R._filterStoreFits && !R._filterStoreFits(filterGraphId, pl.w * pl.h * 4)) return;
    if (!c && rect) {
      // a texture a disposed handle's entry left
      const f = R._takeFreeResult(pl.rw, pl.rh);
      if (f) {
        pl = _resultPlacement(f, rect, cw, ch);
        c = {
          tex: f.tex,
          fbo: f.fbo,
          w: f.w,
          h: f.h,
          key: null,
          rect: pl.rect,
          _bytes_tex: f.w * f.h * 4,
        };
        if (R._filterCacheCharge) R._filterCacheCharge(c._bytes_tex);
        R._setFilterCache(filterGraphId, c);
      }
    }
    const rw = pl.w,
      rh = pl.h;
    if (c) c.rect = pl.rect;
    if (!c || c.w !== rw || c.h !== rh) {
      if (c) {
        if (R._filterCacheCharge) R._filterCacheCharge(-(c._bytes_tex | 0));
        c._bytes_tex = 0;
        deleteGlResource(gl, 'Texture', c.tex);
        deleteGlResource(gl, 'Framebuffer', c.fbo);
        c.tex = null;
        c.fbo = null; // (the entry stays in the map until the store below replaces it, and that drop recycles what the entry still holds: never a deleted pair)
      }
      const tex = trackGlResource(gl, gl.createTexture(), 'filterCache');
      R._parkFillActiveUnit();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, rw, rh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = trackGlResource(gl, gl.createFramebuffer());
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      c = { tex, fbo, w: rw, h: rh, key: null, rect: pl.rect, _bytes_tex: rw * rh * 4 };
      if (R._filterCacheCharge) R._filterCacheCharge(c._bytes_tex);
      R._setFilterCache(filterGraphId, c);
    }

    // A linearRGB result is stored AS sRGB: the conversion is paid once, here, and a cache hit composites it with the plain blit.
    if (!_blitResult(srcTex, c.fbo, pl, cs)) return; // false = deferred: the cache entry is not stamped, the next frame stores it
    R._noteResultStored(c, pl);
    c.key = key;
  }
  // Where a result goes in the cache: at its own pixels (a node rect's `keep`, so an entry holds no more than it did), in a texture that keeps its size while the result fits. A moving shape's result changes
  // size by a pixel or two on nearly every frame, a bundle drawn at several sizes changes it on every draw, and the entry is one texture, with no pool to find the other size in. A texture is never
  // larger than its rect: the entry's rect grows to the texture's size, and the part past the result is clear. A second size means it moves: that allocation leaves room to move in. A texture
  // goes back down after RESULT_SHRINK_STORES stores in a row that would waste half of it, at once when the cache is past its budget (keeping spare room is not worth evicting a result for), and,
  // where nothing stores again, by the idle trim (the renderer's _shrinkIdleResult).
  //   have: the entry, if it holds a texture ({ w, h }). Returns the entry's { rect, w, h } and the copy's { rw, rh, map }.
  const RESULT_SHRINK_STORES = 32;
  function _resultPlacement(have, rect, cw, ch) {
    if (!rect) return { rect: null, w: cw, h: ch, rw: cw, rh: ch, map: null };
    const k = rect.keep || rect,
      rw = k[2],
      rh = k[3];
    const room = (v) => v + Math.max(4, Math.ceil(v / 8));
    let w = rw,
      h = rh;
    if (have) {
      const fits = rw <= have.w && rh <= have.h,
        waste = have.w * have.h > 2 * rw * rh;
      have._wasted = waste ? (have._wasted | 0) + 1 : 0;
      if (fits && have._wasted < RESULT_SHRINK_STORES && !(waste && R._filterCacheOverBudget())) {
        w = have.w;
        h = have.h;
        if (waste) R._resultsOversized = true;
      } else if (fits) {
        w = room(rw);
        h = room(rh);
        have._wasted = 0;
      } else {
        w = rw <= have.w ? have.w : room(rw);
        h = rh <= have.h ? have.h : room(rh);
      }
    }
    return {
      rect: [k[0], k[1], w, h],
      w,
      h,
      rw,
      rh,
      map: rect.keep ? [rw / rect[2], rh / rect[3], 0, 0] : null,
    };
  }
  /// Copy a result to its entry's target, as _resultPlacement says.
  function _blitResult(srcTex, dstFbo, pl, cs) {
    bindFb(gl.FRAMEBUFFER, dstFbo);
    if (pl.w !== pl.rw || pl.h !== pl.rh) {
      R.glViewport(0, 0, pl.w, pl.h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    R.glViewport(0, 0, pl.rw, pl.rh); // 1:1
    R.glDisable(gl.BLEND);
    R.glDisable(gl.DEPTH_TEST);
    R.glDisable(gl.STENCIL_TEST);
    if (!_bindOverBlit(srcTex, 1, pl.map, cs)) return false;
    R.glBindVertexArray(coverVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    R.glBindVertexArray(null);
    return true;
  }
  R._resultPlacement = _resultPlacement;
  R._blitResult = _blitResult;

  function filterRecord(filterId) {
    const b = R._handle.bundle;
    if (!b || !b.lastFilterFloats || filterId <= 0) return null;
    const off = (filterId - 1) * 24;
    const ff = b.lastFilterFloats;
    if (off + 24 > ff.length) return null;
    const rawKind = ff[off + 20] | 0;
    return {
      // A blur on linear light (FILT_KIND_BLUR_LINEAR) is kind 1 with `linear`: every route that sizes, caches or blurs a kind-1 record is unchanged,
      // and only the first blur pass and the composite know the space.
      kind: rawKind === FILT_KIND_BLUR_LINEAR ? FILT_KIND_BLUR : rawKind,
      linear: rawKind === FILT_KIND_BLUR_LINEAR,
      sigmaX: ff[off + 21] || 0,
      sigmaY: ff[off + 22] || 0,

      tintR: ff[off + 0] || 0,
      tintG: ff[off + 1] || 0,
      tintB: ff[off + 2] || 0,
      tintA: ff[off + 3] || 0,
      offsetX: ff[off + 4] || 0,
      offsetY: ff[off + 5] || 0,
      orderX: ff[off + 0] | 0,
      orderY: ff[off + 1] | 0,
      targetX: ff[off + 2] | 0,
      targetY: ff[off + 3] | 0,
      divisor: ff[off + 4] || 1,
      bias: ff[off + 5] || 0,
      edgeMode: ff[off + 6] | 0,
      preserveAlpha: ff[off + 7] | 0,
      kernelRow: ff[off + 8] | 0,
    };
  }

  // Separable max/min morphology on shapeFboTex, in place. operator
  // 0 = erode, 1 = dilate. rx/ry are pixel radii (per-axis).
  // `t` — the RT to filter in place, with a same-sized ping to bounce through:
  // { fbo, tex, pingFbo, pingTex, w, h }. Omitted → the canvas-sized shapeFbo/pingFbo
  // pair, which is what a group's filtered child still uses.
  function _kernelTarget(t) {
    if (t) return t;
    ensurePingFbo();
    const [cw, ch] = viewportSize();
    return {
      fbo: R.shapeFbo,
      tex: R.shapeFboTex,
      pingFbo: R.pingFbo,
      pingTex: R.pingTex,
      w: cw,
      h: ch,
    };
  }
  function morphShapeFbo(operator, rx, ry, target) {
    if (!R.morphProg) return;
    if (rx < 0.5 && ry < 0.5) return;
    const t = _kernelTarget(target);
    const cw = t.w,
      ch = t.h;
    R.glDisable(gl.DEPTH_TEST);
    R.glDisable(gl.STENCIL_TEST);
    R.glDisable(gl.BLEND);
    R.glUseProgram(R.morphProg);
    gl.uniform2f(morphUTexel, 1 / cw, 1 / ch);
    setMap(morphUInMap, IDENTITY_MAP); // target ↔ ping: same rect
    gl.uniform1i(morphUTex, 0);
    gl.uniform1i(morphUOperator, operator | 0);
    R.glBindVertexArray(coverVao);
    // Horizontal passes, then vertical, bouncing target -> ping -> target (morphRadiusPasses: each axis's radius within one pass's reach is
    // one pass). The result has to land in the target: an odd count ends on an identity pass, radius 0.
    const longest = Math.max(cw, ch),
      steps = [];
    for (const r of morphRadiusPasses(rx, longest)) steps.push([r, 1, 0]);
    for (const r of morphRadiusPasses(ry, longest)) steps.push([r, 0, 1]);
    if (steps.length & 1) steps.push([0, 0, 1]);
    for (let i = 0; i < steps.length; i++) {
      const odd = (i & 1) === 1;
      bindFb(gl.FRAMEBUFFER, odd ? t.fbo : t.pingFbo);
      R.glViewport(0, 0, cw, ch);
      R._forgetFillUnits();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, odd ? t.pingTex : t.tex);
      gl.uniform2f(morphUDir, steps[i][1], steps[i][2]);
      gl.uniform1f(morphURadius, steps[i][0]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    R.glBindVertexArray(null);
    R.glEnable(gl.BLEND);
  }

  // Apply feConvolveMatrix to shapeFboTex, in place. The kernel is row
  // `kernelRow` of the bundle's kernel table (25 floats each), flipped into
  // the pass's uKernel uniform; runs a single full-screen pass into pingFbo,
  // then blits ping → shape so subsequent code continues to read from shapeFboTex.
  const _convKernel = new Float32Array(25);
  function convolveShapeFbo(rec, target) {
    const b = R._handle.bundle;
    if (!R.convolveProg || !b || !b.lastKernelFloats) return;
    const t = _kernelTarget(target);
    const cw = t.w,
      ch = t.h;
    R.glDisable(gl.DEPTH_TEST);
    R.glDisable(gl.STENCIL_TEST);
    R.glDisable(gl.BLEND);
    R.glUseProgram(R.convolveProg);
    R._forgetFillUnits();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform1i(convUTex, 0);
    flipConvolveKernel(
      b.lastKernelFloats,
      (rec.kernelRow | 0) * 25,
      rec.orderX,
      rec.orderY,
      _convKernel,
    );
    gl.uniform1fv(convUKernel, _convKernel);
    gl.uniform2f(convUTexel, 1 / cw, 1 / ch);
    setMap(convUInMap, IDENTITY_MAP); // target ↔ ping: same rect
    gl.uniform2f(convUOrder, rec.orderX, rec.orderY);
    gl.uniform2f(convUTarget, rec.targetX, rec.targetY);
    gl.uniform1f(convUDivisor, rec.divisor || 1);
    gl.uniform1f(convUBias, rec.bias || 0);
    gl.uniform1i(convUEdgeMode, rec.edgeMode | 0);
    gl.uniform1i(convUPreserve, rec.preserveAlpha | 0);
    bindFb(gl.FRAMEBUFFER, t.pingFbo);
    R.glViewport(0, 0, cw, ch);
    R.glBindVertexArray(coverVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    R.glBindVertexArray(null);
    // Blit ping → target so the next stage (composite) sees the result.
    bindFb(gl.READ_FRAMEBUFFER, t.pingFbo);
    bindFb(gl.DRAW_FRAMEBUFFER, t.fbo);
    gl.blitFramebuffer(0, 0, cw, ch, 0, 0, cw, ch, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    bindFb(gl.READ_FRAMEBUFFER, null);
    bindFb(gl.DRAW_FRAMEBUFFER, null);
    R.glEnable(gl.BLEND);
  }

  // Separable Gaussian blur on shapeFboTex, in place. After the call the
  // shape FBO holds the blurred result. sx/sy are pixel sigmas (the shape
  // FBO is canvas-sized, so em → px scale already in pixel units). Each axis
  // is one Gaussian pass or, past the tap table's reach, box passes
  // (filterGraph/blurKernel.js); the passes ping-pong target ↔ ping, and an
  // odd count ends with a blit back to the target.
  const blurGaussU = { uW0: blurUW0, uTapCount: blurUCount, uTaps: blurUTaps };
  /// Blur in place with sRGB input and output. LinearRGB intermediates use SRGB8_ALPHA8
  /// storage so shaders read and write linear values without coarse dark-color quantization.
  /// Gaussian edge passes convert on read or write; box edge passes use separate conversions.
  function blurShapeFbo(sx, sy, target, linear = false) {
    const passes = blurPasses(sx, sy, !!R.boxBlurProg);
    if (!passes.length) return;
    const t = _kernelTarget(target);
    const cw = t.w,
      ch = t.h;
    R.glDisable(gl.DEPTH_TEST);
    R.glDisable(gl.STENCIL_TEST);
    R.glDisable(gl.BLEND);
    R.glBindVertexArray(coverVao);
    let prog = null;
    const n = passes.length;
    // Linear-light scratch, at most two, taken on first use: the target's own ping when the caller made it linear light (pingLin), else pool targets
    // (handed back at the end).
    const lin = [];
    const pingLin = !!t.pingLin;
    const takeLin = (i) => {
      if (!lin[i]) {
        if (i === 0 && pingLin) lin[i] = { rt: { fbo: t.pingFbo, tex: t.pingTex } };
        else {
          const pool = R._rtPool,
            was = pool.setLinear(true);
          try {
            const idx = pool.acquire(cw, ch, [0, 0, cw, ch], true);
            lin[i] = { idx, rt: pool.get(idx) };
          } finally {
            pool.setLinear(was);
          }
        }
      }
      return lin[i].rt;
    };
    const convPass = (mode, from, to) => {
      // identity color matrix, `mode` conversion on the read: 1 sRGB -> linear, 2 linear -> sRGB
      R.glUseProgram(R.colorMatrixProg);
      prog = R.colorMatrixProg;
      gl.uniform1i(cmUTex, 0);
      if (cmULinearZeroBorder) gl.uniform1i(cmULinearZeroBorder, 0);
      gl.uniform1i(cmUCsIn, mode);
      if (cmUCsOut) gl.uniform1i(cmUCsOut, 0);
      setMap(cmUInMap, IDENTITY_MAP);
      gl.uniform4f(cmUM0, 1, 0, 0, 0);
      gl.uniform4f(cmUM1, 0, 1, 0, 0);
      gl.uniform4f(cmUM2, 0, 0, 1, 0);
      gl.uniform4f(cmUM3, 0, 0, 0, 1);
      gl.uniform4f(cmUMOff, 0, 0, 0, 0);
      bindFb(gl.FRAMEBUFFER, to.fbo);
      R.glViewport(0, 0, cw, ch);
      R._forgetFillUnits();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, from.tex);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.uniform1i(cmUCsIn, 0);
    };
    const canConvert = !!(R.colorMatrixProg && cmUCsIn);
    // `cur`: what the next pass reads; `curLin`: it holds linear light (a linear-light target) rather than the sRGB of the target.
    let cur = { fbo: t.fbo, tex: t.tex },
      curLin = false,
      next = 0;
    if (linear && !passes[0].gauss && canConvert) {
      const a = takeLin(next);
      convPass(1, cur, a);
      cur = a;
      curLin = true;
      next ^= 1;
    }
    for (let i = 0; i < n; i++) {
      const p = passes[i],
        last = i === n - 1;
      const inFused = linear && !curLin && p.gauss; // reads the sRGB target: convert as it reads
      // A Gaussian last pass converts as it writes, into the target (sRGB) when it reads something else, or, for a lone pass, into the plain ping
      // that is blitted back; a ping that holds linear light takes the lone pass in linear and the conversion pass below hands it back.
      const toTarget = linear && last && p.gauss && cur.fbo !== t.fbo;
      const toPing = linear && last && p.gauss && cur.fbo === t.fbo && !pingLin;
      const outFused = toTarget || toPing;
      let dst;
      if (!linear)
        dst = cur.fbo === t.fbo ? { fbo: t.pingFbo, tex: t.pingTex } : { fbo: t.fbo, tex: t.tex };
      else if (toTarget) dst = { fbo: t.fbo, tex: t.tex };
      else if (toPing) dst = { fbo: t.pingFbo, tex: t.pingTex };
      else {
        dst = takeLin(next);
        next ^= 1;
      }
      const f = p.gauss ? (inFused || outFused ? _blurCsProgram(inFused, outFused) : null) : null;
      // This path has no unfused form of a converting pass: while its program links, the frame blurs in the wrong color space. Such a result is deferred, never a cache's for good.
      if (p.gauss && (inFused || outFused) && !f && R.shaderSources.blurFrag)
        R._deferredFilterDraws = (R._deferredFilterDraws | 0) + 1;
      const want = f ? f.prog : p.gauss ? R.blurProg : R.boxBlurProg;
      const u = f ? f.u : null;
      if (prog !== want) {
        R.glUseProgram(want);
        prog = want;
        if (p.gauss) {
          gl.uniform2f(f ? u.uTexel : blurUTexel, 1 / cw, 1 / ch);
          setMap(f ? u.uInMap : blurUInMap, IDENTITY_MAP);
          gl.uniform1i(f ? u.uTex : blurUTex, 0);
        } else {
          gl.uniform2f(bbUTexel, 1 / cw, 1 / ch);
          setMap(bbUInMap, IDENTITY_MAP);
          gl.uniform1i(bbUTex, 0);
        }
      }
      if (f && inFused) gl.uniform1i(u.uCsIn, 1);
      bindFb(gl.FRAMEBUFFER, dst.fbo);
      R.glViewport(0, 0, cw, ch);
      R._forgetFillUnits();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, cur.tex);
      if (p.gauss) {
        gl.uniform2f(f ? u.uDir : blurUDir, p.dir[0], p.dir[1]);
        setGaussTaps(gl, f ? f.u : blurGaussU, p.gauss);
      } else {
        gl.uniform2f(bbUDir, p.dir[0], p.dir[1]);
        gl.uniform1i(bbURadius, p.box);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      cur = dst;
      if (linear) curLin = !outFused;
    }
    // A last box pass left linear light in a scratch target: one conversion pass writes the sRGB result.
    if (linear && curLin && canConvert) {
      const to = { fbo: t.fbo, tex: t.tex };
      convPass(2, cur, to);
      cur = to;
    }
    R.glBindVertexArray(null);
    if (cur.fbo !== t.fbo) {
      // The last pass wrote ping; the next stage (composite) reads the target.
      bindFb(gl.READ_FRAMEBUFFER, cur.fbo);
      bindFb(gl.DRAW_FRAMEBUFFER, t.fbo);
      gl.blitFramebuffer(0, 0, cw, ch, 0, 0, cw, ch, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      bindFb(gl.READ_FRAMEBUFFER, null);
      bindFb(gl.DRAW_FRAMEBUFFER, null);
    }
    for (const e of lin) if (e && e.idx !== undefined) R._rtPool.release(e.idx);
    R.glEnable(gl.BLEND);
  }

  R._filterKeyMatches = _filterKeyMatches;
  R._wmHash = _wmHash;
  R._recolorState = _recolorState;
  R._recolorHash = _recolorHash;
  R._compositeFilteredTex = _compositeFilteredTex;
  R._pushRegionScissor = _pushRegionScissor;
  R._popRegionScissor = _popRegionScissor;
  R._ensureCacheTex = _ensureCacheTex;

  const coverageAvailable =
    ['feGaussianBlur', 'feOffset', 'feFlood', 'feComposite', 'feMerge'].every(
      (type) => typeof R._svgDispatch?.[type] === 'function',
    ) &&
    fcUCoverage &&
    fcUPixelAligned &&
    fcUCoverageIn1 &&
    fcUCoverageIn2 &&
    fcUIn1Offset &&
    fcUIn2Offset &&
    fcUUnitOpacity &&
    fcUMaterialLo &&
    fcUMaterialHi &&
    /\buFilterCoverageScale\b/.test(R.shaderSources.fillFrag);
  R._filterSourceMaterial = coverageAvailable
    ? createMaterialIntervalResolver(R, _frames, { precision: 23, rangeMin: 127, rangeMax: 127 })
    : () => null;
  R._buildFilterCtx = _buildFilterCtx;
  R._filterPxPerEm = _filterPxPerEm;
  // The canvas rect the current handle's bundle actually paints into — the union of
  // every shape's own rect, expanded by whatever that shape's filter or stroke reaches.
  // Reuses the per-shape machinery the filter rects are built on, so it cannot disagree
  // with them about where a shape is.
  //
  // Used to stop the static cache blitting a FULL-CANVAS quad for a shape that covers a
  // tenth of the screen, once per cached handle, every frame. That is pure fillrate, it
  // scales with the canvas, and it is what makes a scene fall over at fullscreen.
  //
  // null = "could not bound it safely, use the whole canvas". Be conservative: a rect
  // that is too small CLIPS the cached image, and a clipped cache is the worst kind of
  // bug (it looks like the content is simply missing).
  function _contentRectPx(cw, ch, ops) {
    const b = R._handle && R._handle.bundle;
    if (!b || !b.drawList || !b.drawList.length) return null;
    if (b._nineSliceActive) return null;
    const list = ops || b.drawList;
    if (!list.length) return null;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const op of list) {
      // A filtered group paints past its children by the filter's reach, and nothing here prices that reach: no bound.
      if (op.kind === 'groupBegin' && op.filterId) return null;
      if (op.kind !== 'fillShape') continue;
      const si = op.shapeIdx | 0;
      let r = null;
      if (op.filterGraphId) {
        const g = b.filterGraphs && b.filterGraphs[op.filterGraphId - 1];
        if (!g) return null;
        const info = _filterNodeRects(g, si, cw, ch);
        if (!info) return null; // rects off / unsafe → don't bound
        r = info.rects[g.rootOut];
        if (r.keep) r = r.keep;
      } else if (op.filterId) {
        const f = filterRecord(op.filterId);
        if (!f) return null;
        r =
          f.kind >= 1
            ? _filterSingleKindRect(si, cw, ch, f, ..._filterPxPerEm(cw, ch, si))
            : _bboxToRect(_shapeBboxPx(si, cw, ch), ch);
      } else {
        r = _bboxToRect(_shapeBboxPx(si, cw, ch), ch);
      }
      if (!r) return null;
      if (r[0] < minX) minX = r[0];
      if (r[1] < minY) minY = r[1];
      if (r[0] + r[2] > maxX) maxX = r[0] + r[2];
      if (r[1] + r[3] > maxY) maxY = r[1] + r[3];
    }
    if (!(maxX > minX) || !(maxY > minY)) return null;
    // Clamp to the canvas — off-canvas pixels are not ours to touch, and the blit's
    // viewport is in canvas space.
    const x = Math.max(0, Math.floor(minX)),
      y = Math.max(0, Math.floor(minY));
    const w = Math.min(cw, Math.ceil(maxX)) - x,
      h = Math.min(ch, Math.ceil(maxY)) - y;
    if (w <= 0 || h <= 0) return null;
    if (x <= 0 && y <= 0 && w >= cw && h >= ch) return null; // covers the canvas anyway
    return [x, y, w, h];
  }
  R._contentRectPx = _contentRectPx;

  R._filterNodeRects = _filterNodeRects;
  R._feImagePlacements = _feImagePlacements;
  R._filterSingleKindRect = _filterSingleKindRect;
  R._filterSingleKindComposite = _filterSingleKindComposite;
  R._storeFilteredTex = _storeFilteredTex;
  R.filterRecord = filterRecord;
  R.morphShapeFbo = morphShapeFbo;
  R.convolveShapeFbo = convolveShapeFbo;
  R.blurShapeFbo = blurShapeFbo;
}
