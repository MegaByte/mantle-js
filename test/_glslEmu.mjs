// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _glslEmu.mjs -- the band and tree FILL KERNELS (renderFillGWNSDF, renderFillAAC, renderFillHardBand) run on the CPU
// in float32, compiled from the ASSEMBLED SHADER itself (src/shaders/generated/mantle.frag.glsl). Not a port: nothing is
// rewritten by hand, so a test through it tests the shader text that ships.
//
// The translation is lexical and C++ carries the rest. The kernels' closure (functions, structs, consts, #defines) is cut
// out of the translation unit; float literals get an `f` suffix so no expression is promoted to double; swizzles become
// accessor calls; `out`/`inout` parameters become references; the preprocessor lines stay as they are, since C++ reads
// GLSL's #if/#define the same way. A small vector header supplies vec2..ivec4 and the built-ins. Compiled with
// -ffp-contract=off, every operation is one IEEE float32 operation, as a GPU without fused multiply-add performs it.
// `contract: true` builds the one that has it: -ffp-contract=fast, and dot() as a chain of fmas whatever the host --
// two dot products equal in exact arithmetic then round differently, as on a real GPU. Every emulator
// built on this file takes the same option (fpFlags), and MANTLE_EMU_FMA=1 makes it their default.
// Transcendental built-ins (sin, acos, atan...) come from libm, so an arc's crossings can differ from a GPU's in the
// last ulp; everything else is bit-faithful.
//
// Needs a C++17 compiler: $CXX, else clang++, g++ or c++. `hasCxx()` says whether one exists, so a smoke can SKIP loudly.
//
//   const emu = buildGlslEmu(ROOT, { defines: ['MANTLE_GWN', 'MANTLE_GWN_SDF'] });
//   const cov = emu.run(bandF32, curveF32, [{ k: K_GWN, GD, bb, eo, c: [x, y], ePx: [ex, ey] }, ...]);   // Float32Array
//
// `ePx` is the fragment's em-per-pixel (fwidth of the em coordinate); the call site's reciprocal, with the floor the
// fill shader applies, is emulated from the shader's own `invPx` line unless `invPxFloor` overrides it.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';

export const K_GWN = 0,
  K_AAC = 1,
  K_HARD = 2,
  K_INVPX = 3,
  K_SLUG = 4,
  K_CURVE_COV = 5,
  K_ARC_COV = 6;
/// The box-coverage family (`boxCov: true`): the exact area of a pixel box under ONE, TWO or THREE
/// half-planes. `exactBoxCov2` and `exactBoxCov3` are what CPatch's sub-pixel composition spends
/// (see _cpatchCoverage.glsl), and no renderFill* root reaches the three-plane form at all.
///   { k: K_BOXCOV,  bb: [n1x, n1y, d1, 0] }
///   { k: K_BOXCOV2, bb: [n1x, n1y, d1, 0], ex: [n2x, n2y, d2] }
///   { k: K_BOXCOV3, bb: [n1x, n1y, d1, 0], ex: [n2x, n2y, d2, n3x, n3y, d3] }
export const K_BOXCOV = 7,
  K_BOXCOV2 = 8,
  K_BOXCOV3 = 9;
/// The CUBIC closest-point routes (`cubicSolve: true`): `t` at the closest point of a cubic given
/// query-relative coefficient vectors, on the shipped seeded route and on the analytic descending chain.
/// `bb` is cx (t^3, t^2, t, 1) and `ex[0..3]` is cy. K_CUBIC_EVALS reports the descending chain's
/// polynomial-evaluation count instead of its answer, so the price is read off the same text.
export const K_CUBIC_DESCEND = 10,
  K_CUBIC_EVALS = 11;
const BOXCOV_FNS = ['exactBoxCov', 'exactBoxCov2', 'exactBoxCov23', 'exactBoxCov3'];
/// Floats per query record. Twelve past the fourteen the band kernels need (`ex`), so a three-half-plane
/// query or a stroke-band walk fits without a second channel; unset slots are zero.
const QF = 26;
// `chainBoxCov` — the Loop-Blinn analytic INTERIOR coverage (area(pixel box ∩ fill) for a local
// outline chain). Enabled by `chainCov: true`, lifted by name like curveCov/arcCov and for the
// same reason. A K_CHAIN_COV query passes the chain's five CELL-space points as
// (bb.xy, bb.zw, c, ePx, x) and `forceInside` as GD.x.
export const K_CHAIN_COV = 12;
/// `coverKernelId` — WHICH COVER KERNEL a fill row wants. Enabled by `coverKernel: true`, and
/// lifted by name for the same reason as the others: it is the ONE expression the per-entry id
/// changes, so holding the two arms to each other over every input the renderer can produce is the
/// whole of the byte-identity claim, and this is the only compiler the tests have.
///   { k: K_COVER_KID, bb: [flagsShape, 0, 0, 0], c: [vKind, 0] }
export const K_COVER_KID = 13;
/// CPATCH's kernel (`cpatch: true`): its whole section of the assembled shader, from its stream tag to
/// the `#endif` after cpatchCoverage, compiled with MANTLE_CPATCH. The varyings a fragment of a CPatch
/// cover reads are globals set per query, so the COMPOSITION is run exactly as a fragment runs it.
///   { k: K_CPATCH_COV, GD: vLB0 (cell box), bb: vLB1 (patch box A.xy, U.xy), c: vEm,
///     ePx: cCen (first, count), ex: [vTC.x, vTC.y, vTC.z, vLB2.x, vLB2.y, vEmPerPx] }
/// ...and ONE CONSTRAINT's answer, cpatchCurveCov(idx, p, emPerPx, outs...), one output per query:
///   { k: K_CPATCH_CURVE, GD: [which, idx, 0, 0], c: p, ex: [0, 0, 0, 0, 0, emPerPx] }
///   which: 0 coverage  1 softOut  2 nearOut  3 sdOut  4 nOut.x  5 nOut.y  6 cutOut  7 hullOut  8 outlOut (a seam's
///   companion bound; 1 on a text from before it)
export const K_CPATCH_COV = 14,
  K_CPATCH_CURVE = 15;
/// ...and the composition's loop-free exact areas, cpExactBoxCov23: the box under planes 1 and 2
/// (which = 1) or under all three with `third` set (which = 0).
///   { k: K_CPATCH_BOX23, GD: [which, third, 0, 0], bb: [n1x, n1y, d1, 0], ex: [n2x, n2y, d2, n3x, n3y, d3] }
export const K_CPATCH_BOX23 = 16;
/// ...and the arc distance itself, cpArcDistFoot: the distance from p (c) to the arc of control points g0 (bb) and g1
/// (ex[0..3]), three-point when GD[0] is set; GD[1] = 1 returns the foot point's parameter instead.
///   { k: K_CPATCH_ARC, GD: [arc3, which, 0, 0], bb: g0, c: p, ex: g1 }
export const K_CPATCH_ARC = 17;
/// The STROKE-DISTANCE math (`stroke: true`): _strokeMath.glsl's functions, pulled in through the
/// same root closure as the fill kernels, with uDashTex declared (a query with dashId 0 never reads it).
///   { k: K_QUAD_ARCLEN, bb: [p1x, p1y, p2x, p2y], c: [p3x, p3y], ePx: [t, 0] }           quadArcLen
///   { k: K_PERP_ARC,    bb: [qx, qy, tanx, tany], c: [kappa, 0] }                           perpDistToArc
///   { k: K_STROKE_QUAD, bb: [p1x, p1y, p2x, p2y], c: [p3x, p3y], ePx: [miterLimit, halfW],
///     GD: [freeStart, freeEnd, startCap | endCap << 4, joinStyle], ex: [inTan.xy, outTan.xy] }
///   strokeQuadAccum with no dash, zero curvatures and no earlier minimum: the stroke distance at the
///   origin (the control points are ORIGIN-RELATIVE, as the band walk passes them).
///   { k: K_QUAD_T, bb: [Ax, Ay, Bx, By], c: [Cx, Cy] }                                    quadClosestT
///   { k: K_STROKE_CUBIC, bb: [p1x, p1y, p2x, p2y], c: [p3x, p3y], ePx: [miterLimit, halfW],
///     GD: as K_STROKE_QUAD, ex: [p4x, p4y, inTan.xy, outTan.xy] }
///   strokeCubicAccum, the cubic twin of K_STROKE_QUAD (four origin-relative control points).
///   { k: K_STROKE_ARC, bb: [pcx, pcy, rx, ry], c: [phi, th0], ePx: [miterLimit, halfW],
///     GD: as K_STROKE_QUAD, ex: [th1, inTan.xy, outTan.xy] }
///   strokeArcAccum: the query point RELATIVE TO THE ARC'S CENTER, and the arc as encodeSeg stores it.
/// All three answer the distance, or with `GD.z >> 8` = 1 / 2 the x / y of the boundary normal they hand back.
///   { k: K_STROKE_WALK, GD: the row's (glyphLoc.x, glyphLoc.y, bandMaxX, bandMaxY), bb: its meta bbox, c: the fragment
///     in em, ePx: its em per pixel, ex: [halfW, miterLimit, startCap, endCap, joinStyle, dashId, gates, which, satD,
///     authHalfW] } -- authHalfW, the half-width the band entries were padded with, defaults to halfW
///   THE STROKE-BAND WALK, strokeMinDist, over a real band and curve plane (and the dash plane `run` is handed): the
///   distance the stroke pass reads, or (which 1 / 2) the x / y of its boundary normal. `aaEm` is the shipped
///   strokeAaReachEm(halfW, ePx); `satD` is the caller's saturation distance (-1e20 never saturates).
export const K_QUAD_ARCLEN = 16,
  K_PERP_ARC = 17,
  K_STROKE_QUAD = 18,
  K_QUAD_T = 19,
  K_STROKE_CUBIC = 20;
///   { k: K_STROKE_LOCAL, ...as K_STROKE_WALK, ex: [halfW, miterLimit, startCap, endCap, joinStyle, dashId, gates, which,
///     N.x, N.y, N.z, N.w] }
///   THE STROKE-SPACE ENTRY, strokeMinDistLocal, for a row drawn through its frame N (meta texel 5): the
///   document-space distance, (which 1 / 2) the x / y of the document normal, or (which 3) the document half-width it
///   hands back. `gates` also turns on the saturation early-out, as the main pass does.
///   { k: K_STROKE_EDGE, bb: [minD, halfW, grad.x, grad.y], ePx: [ex, ey], GD: [exactAa, 0, 0, 0] }
///   strokeEdgeCov, the band-walk stroke's edge coverage from its distance, when the text has one (a caller can append
///   main()'s coverage statements as that function to a text that computes it inline).
///   { k: K_ELLIPSE_DIST, bb: [rx, ry, px, py], GD: [which, 0, 0, 0] }
///   _arcMath.glsl distToEllipse: the distance from (px, py) to the axis-aligned ellipse, or (which 1 / 2) its foot's x / y.
///   { k: K_STROKE_EXACT, bb: edgeP, ex: [edgeQ.xyzw, N.xyzw, halfWS], ePx }
///   strokeExactCov, the exact coverage of the pixel box by the walk's edge record, when the text has one.
///   K_STROKE_WALK / K_STROKE_LOCAL hand the record back with which 4..11 (edgeP.xyzw, edgeQ.xyzw).
/// (The `stroke: true` kernels take 30 and up: 21 to 26 are the fill and `strokeWalk` kernels' below.)
/// `slugCov(f, grad)` of _lbCoverage.glsl (compiled with `curveCov: true`): (bb.x, bb.y, bb.z) = (f, fx, fy).
export const K_SLUG_COV = 36;
export const K_STROKE_ARC = 30,
  K_STROKE_WALK = 31,
  K_STROKE_LOCAL = 32,
  K_STROKE_EDGE = 33,
  K_ELLIPSE_DIST = 34,
  K_STROKE_EXACT = 35;
const STROKE_ROOTS = [
  'strokeQuadAccum',
  'strokeCubicAccum',
  'strokeArcAccum',
  'quadArcLen',
  'perpDistToArc',
  'quadClosestT',
  'strokeMinDist',
  'strokeMinDistLocal',
  'strokeAaReachEm',
  'strokeEdgeCov',
  'strokeExactCov',
];
/// `cubicChainBoxCov` -- the Loop-Blinn CUBIC interior chain. Enabled by `cubicChainCov: true`. A query
/// passes the five CELL-space points as bb.xy, bb.zw, c, ePx, ex[0..1], `lineFirst` as ex[2] and `forceInside` as ex[3].
export const K_CUBIC_CHAIN_COV = 26;
/// THE STROKE BAND WALK AS THE FILL SHADER'S CALL SITE RUNS IT (`strokeWalk: true`): strokeMinDist over a stroke row's
/// band, the whole walk as a fragment runs it -- every sub-loop, the far, hull and saturation gates -- with the
/// saturation depth and the AA reach the fill shader's call site passes. uStrokeGates is a global the query sets: on
/// when `eo` is true, off otherwise. (K_STROKE_WALK above is the `stroke: true` build's walk, with its own layout.)
///   { k: K_STROKE_BAND, GD, bb, c, ePx, eo: gates, ex: [halfW, startCap, endCap, joinStyle, miterLimit, dashId] }
/// K_STROKE_BAND returns minD; K_STROKE_BAND_GX / _GY the walk's boundary normal (gradOut).
export const K_STROKE_BAND = 21,
  K_STROKE_BAND_GX = 22,
  K_STROKE_BAND_GY = 23;
/// K_SLUG_M: renderFillM, Slug under a general em -> device-pixel map; in a text that gates the map, only
/// in a program built with MANTLE_ROTATED_MAP (elsewhere a K_SLUG_M query answers -1): `ex` = [mx.x, mx.y, my.x, my.y], the map's
/// columns (where one em unit along x and along y lands, in pixels; orientation-preserving). `ePx` is unused.
export const K_SLUG_M = 24;
/// K_AAC_M: renderFillAACM, AAC under a general em -> device-pixel map, `ex` as K_SLUG_M's. Only in a program
/// built with MANTLE_ROTATED_MAP (the rotated footprint is a variant); elsewhere a K_AAC_M query answers -1.
export const K_AAC_M = 25;
export const GWN_SDF = ['MANTLE_GWN', 'MANTLE_GWN_SDF'];
export const GWN_WIND = ['MANTLE_GWN'];
export const AAC_HARD = ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS', 'MANTLE_HARD'];

/// The GWN tree kernel with its two EARLY EXITS taken out, for a test that asks about the walk alone.
/// Tier 3 (the occupancy grid) runs only when `gridBase > 0` and tier 2 (the y-bands) only when
/// `GB > 0`, so zeroing the two reads leaves the full run-tree walk and nothing else, without a
/// shipped define for it. The tiers divide by the shape's
/// bbox and carry floors of their own, which is why scale tests read the walk without them.
/// Throws when a hinge is missing, so a rename cannot quietly turn this into the full kernel.
export function gwnWithoutExits(glsl) {
  const hinges = [
    ['  int gridBase = int(ext.z);', '  int gridBase = 0;'],
    ['  GB = int(ext.y); rbBase = int(ext.x);', '  GB = 0; rbBase = 0;'],
  ];
  let out = glsl;
  for (const [from, to] of hinges) {
    if (out.split(from).length !== 2)
      throw new Error(`gwnWithoutExits: hinge not found exactly once: ${from.trim()}`);
    out = out.split(from).join(to);
  }
  return out;
}

let _cxx;
export function cxx() {
  if (_cxx !== undefined) return _cxx;
  _cxx = null;
  for (const c of [process.env.CXX, 'clang++', 'g++', 'c++'].filter(Boolean)) {
    if (spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0) {
      _cxx = c;
      break;
    }
  }
  return _cxx;
}
export const hasCxx = () => !!cxx();
/// FUSED OR NOT, for every emulator that compiles shader text. A GPU compiler contracts a * b + c into one
/// fused multiply-add wherever it likes, so an answer that moves under contraction is one the twin cannot vouch for.
/// `contract` defaults to MANTLE_EMU_FMA=1 in the environment, so a harness runs fused without a flag of its own.
export const emuContractDefault = () => process.env.MANTLE_EMU_FMA === '1';
export const fpFlags = (contract) =>
  contract ? ['-ffp-contract=fast', '-DEMU_FMA'] : ['-ffp-contract=off'];
/// fmaf of float32 values, correctly rounded -- the fused twin's dot() term by term, for a reference that must
/// follow the emulator's arithmetic. a * b is exact in float64, so only the sum rounds twice, and that differs from one
/// rounding only when the float64 sum lands exactly on a float32 midpoint: TwoSum's residue then picks the side.
export function fmaf32(a, b, c) {
  const p = a * b,
    s = p + c,
    r = Math.fround(s);
  if (r === s || !Number.isFinite(s)) return r;
  const t = s - p,
    e = p - (s - t) + (c - t);
  if (e === 0) return r;
  const F = new Float32Array([r]),
    I = new Int32Array(F.buffer);
  I[0] += r > 0 === s > r ? 1 : -1; // the float32 neighbour on s's side of r
  const o = F[0];
  if ((r + o) / 2 !== s) return r;
  return e > 0 === o > r ? o : r;
}

// ---- top-level split of a GLSL translation unit ------------------------------------------------------------------
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
}
const SKIP_DECL = /^\s*(precision|uniform|in |out |layout|flat |smooth |centroid |invariant )/;
function classify(text) {
  const t = text.trim();
  let m;
  if ((m = t.match(/^struct\s+(\w+)/))) return { kind: 'struct', name: m[1], text };
  if (SKIP_DECL.test(t)) return { kind: 'skip', name: null, text };
  if ((m = t.match(/^(?:(?:highp|mediump|lowp)\s+)?\w+\s+(\w+)\s*\([\s\S]*?\)\s*\{/)))
    return { kind: 'func', name: m[1], text };
  if ((m = t.match(/^(?:(?:highp|mediump|lowp)\s+)?\w+\s+(\w+)\s*\([\s\S]*?\)\s*;$/)))
    return { kind: 'proto', name: m[1], text };
  if ((m = t.match(/^const\s+\w+\s+(\w+)/))) return { kind: 'const', name: m[1], text };
  if ((m = t.match(/^\w+\s+(\w+)\s*(=|;|\[)/))) return { kind: 'global', name: m[1], text };
  return { kind: 'other', name: null, text };
}
function splitTopLevel(src) {
  const s = stripComments(src),
    n = s.length,
    items = [];
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    if (s[i] === '#') {
      // a directive, with its backslash continuations
      let e = i;
      for (;;) {
        e = s.indexOf('\n', e);
        if (e < 0) {
          e = n;
          break;
        }
        if (s[e - 1] !== '\\') break;
        e++;
      }
      items.push({ kind: 'pp', text: s.slice(i, e) });
      i = e;
      continue;
    }
    let depth = 0,
      j = i,
      brace = false;
    for (; j < n; j++) {
      const ch = s[j];
      if (ch === '{') {
        depth++;
        brace = true;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      } else if (ch === ';' && depth === 0) {
        j++;
        break;
      }
    }
    let text = s.slice(i, j);
    if (brace && /^\s*struct\b/.test(text)) {
      let k = j;
      while (k < n && /\s/.test(s[k])) k++;
      if (s[k] === ';') {
        text = s.slice(i, k + 1);
        j = k + 1;
      }
    }
    items.push(classify(text));
    i = j;
  }
  return items;
}
const idents = (s) => new Set(s.match(/[A-Za-z_]\w*/g) || []);
function closure(items, roots) {
  const byName = new Map();
  for (const it of items) {
    let name = it.name;
    if (it.kind === 'pp') {
      const m = it.text.match(/^#\s*define\s+(\w+)/);
      if (!m) continue;
      name = m[1];
    }
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(it);
  }
  const want = new Set(),
    queue = [...roots];
  while (queue.length) {
    const nm = queue.pop();
    if (want.has(nm)) continue;
    want.add(nm);
    for (const it of byName.get(nm) || [])
      for (const id of idents(it.text)) if (byName.has(id) && !want.has(id)) queue.push(id);
  }
  return want;
}
// ---- lexical GLSL -> C++ ------------------------------------------------------------------------------------------
const SWZ = /^([xyzw]{2,4}|[rgba]{2,4}|[stpq]{2,4})$/,
  ALIAS = { r: 'x', g: 'y', b: 'z', a: 'w', s: 'x', t: 'y', p: 'z', q: 'w' };
function translateCode(s) {
  let out = '',
    i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (
      /[0-9]/.test(ch) ||
      (ch === '.' && /[0-9]/.test(s[i + 1] || '') && !/[\w)\]]/.test(s[i - 1] || ''))
    ) {
      let j = i;
      if (s[j] === '0' && /[xX]/.test(s[j + 1] || '')) {
        j += 2;
        while (/[0-9a-fA-F]/.test(s[j] || '')) j++;
        if (/[uU]/.test(s[j] || '')) j++;
        out += s.slice(i, j);
        i = j;
        continue;
      }
      let isFloat = false;
      while (/[0-9]/.test(s[j] || '')) j++;
      if (s[j] === '.') {
        isFloat = true;
        j++;
        while (/[0-9]/.test(s[j] || '')) j++;
      }
      if (/[eE]/.test(s[j] || '') && /[-+0-9]/.test(s[j + 1] || '')) {
        isFloat = true;
        j++;
        if (/[-+]/.test(s[j])) j++;
        while (/[0-9]/.test(s[j] || '')) j++;
      }
      let lit = s.slice(i, j);
      if (/[uU]/.test(s[j] || '')) {
        lit += 'u';
        j++;
      } else if (/[fF]/.test(s[j] || '')) {
        lit += 'f';
        j++;
      } else if (isFloat) lit += 'f';
      out += lit;
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (/\w/.test(s[j] || '')) j++;
      const word = s.slice(i, j);
      // A precision qualifier (highp/mediump/lowp) has no meaning in float32 arithmetic here: drop it wherever it qualifies a local, parameter or return type.
      if (word === 'highp' || word === 'mediump' || word === 'lowp') {
        while (/[ \t]/.test(s[j] || '')) j++;
        i = j;
        continue;
      }
      out += word;
      i = j;
      continue;
    }
    if (ch === '.') {
      let j = i + 1;
      while (/\s/.test(s[j] || '')) j++;
      let k = j;
      while (/\w/.test(s[k] || '')) k++;
      const field = s.slice(j, k);
      if (SWZ.test(field)) {
        let q = k;
        while (/\s/.test(s[q] || '')) q++;
        if (/^(=(?!=)|\+=|-=|\*=|\/=)/.test(s.slice(q, q + 2)))
          throw new Error(
            'glslEmu: swizzle write is unsupported: ' + s.slice(Math.max(0, i - 40), q + 10),
          );
        out += `.${field.replace(/[rgbastpq]/g, (c) => ALIAS[c])}()`;
        i = k;
        continue;
      }
      if (/^[rgbastpq]$/.test(field)) {
        out += '.' + ALIAS[field];
        i = k;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}
function translateSignature(text) {
  const open = text.indexOf('(');
  let depth = 0,
    close = -1;
  for (let k = open; k < text.length; k++) {
    if (text[k] === '(') depth++;
    else if (text[k] === ')' && --depth === 0) {
      close = k;
      break;
    }
  }
  const params = text
    .slice(open + 1, close)
    .replace(/\b(?:const\s+)?(?:inout|out)\s+(\w+)\s+(\w+)/g, '$1& $2')
    .replace(/\bin\s+(?=\w+\s+\w+)/g, '');
  return (
    text.slice(0, open).replace(/^\s*(?:highp|mediump|lowp)\s+/, '') +
    '(' +
    params +
    ')' +
    text.slice(close + 1)
  );
}
export function glslToCpp(src, roots) {
  const items = splitTopLevel(src),
    want = closure(items, roots),
    lines = [];
  // A flag's only use is a conditional, which the closure does not read: dropped, `#ifdef FLAG` took its other branch with no error.
  const asked = new Set();
  for (const ln of src.split('\n'))
    if (/^\s*#\s*(if|ifdef|ifndef|elif)\b/.test(ln))
      for (const id of ln.replace(/^\s*#\s*\w+/, '').match(/\b[A-Za-z_]\w*\b/g) || [])
        asked.add(id);
  for (const it of items) {
    if (it.kind === 'pp') {
      if (/^#\s*(version|extension|pragma)/.test(it.text)) continue;
      const m = it.text.match(/^#\s*define\s+(\w+)/);
      if (m && !want.has(m[1]) && !asked.has(m[1])) continue;
      lines.push(translateCode(it.text));
    } else if (it.kind === 'skip' || !it.name || !want.has(it.name)) {
      // a dropped item keeps its conditional directives, so #if/#endif pairs that straddle items stay balanced
      for (const ln of it.text.split('\n'))
        if (/^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b/.test(ln)) lines.push(ln.trim());
    } else if (it.kind === 'func' || it.kind === 'proto')
      lines.push(translateSignature(translateCode(it.text)));
    // A GLSL ARRAY CONSTRUCTOR, `T[N](a, b, ...)`, is a brace initializer in C++ (the GL-16 tables the cubic
    // arc length reads are the ones that need it).
    else
      lines.push(
        translateCode(it.text).replace(
          /=\s*\w+\s*\[\s*\d+\s*\]\s*\(([\s\S]*)\)\s*;\s*$/,
          '= { $1 };',
        ),
      );
  }
  return lines.join('\n');
}

// ---- the vector header -------------------------------------------------------------------------------------------
export function vecHeader() {
  const C = ['x', 'y', 'z', 'w'];
  const swz = (N) => {
    const out = [];
    const rec = (pre, len) => {
      if (pre.length === len) {
        out.push(
          `  V<T,${len}> ${pre.join('')}() const { return V<T,${len}>(${pre.join(', ')}); }`,
        );
        return;
      }
      for (let k = 0; k < N; k++) rec([...pre, C[k]], len);
    };
    for (let len = 2; len <= 4; len++) rec([], len);
    return out.join('\n');
  };
  let h = `#include <cmath>\n#include <cstring>\nnamespace glsl {\ntypedef unsigned int uint;\ntemplate<class T, int N> struct V;\n`;
  for (const N of [2, 3, 4]) {
    const cs = C.slice(0, N);
    h += `template<class T> struct V<T,${N}> {
  T ${cs.join(', ')};
  V() : ${cs.map((c) => `${c}(0)`).join(', ')} {}
  template<class A> explicit V(A a) { set1(a); }
  template<class A, class B, class... R> V(A a, B b, R... r) { T buf[4]; int k = 0; put(buf, k, a); put(buf, k, b); putAll(buf, k, r...); ${cs.map((c, i) => `${c} = buf[${i}];`).join(' ')} }
  template<class A> static void put(T* buf, int& k, A a) { if (k < 4) buf[k++] = T(a); }
  template<class U, int M> static void put(T* buf, int& k, const V<U,M>& v) { for (int i = 0; i < M && k < 4; i++) buf[k++] = T(v[i]); }
  static void putAll(T*, int&) {}
  template<class A, class... R> static void putAll(T* buf, int& k, A a, R... r) { put(buf, k, a); putAll(buf, k, r...); }
  template<class A> void set1(A a) { ${cs.map((c) => `${c} = T(a);`).join(' ')} }
  template<class U, int M> void set1(const V<U,M>& v) { ${cs.map((c, i) => `${c} = T(v[${i}]);`).join(' ')} }
  T& operator[](int i) { return (&x)[i]; }
  const T& operator[](int i) const { return (&x)[i]; }
${swz(N)}
};
`;
  }
  h += `typedef V<float,2> vec2; typedef V<float,3> vec3; typedef V<float,4> vec4;
typedef V<int,2> ivec2; typedef V<int,3> ivec3; typedef V<int,4> ivec4;
template<class T, int N> inline V<bool,N> greaterThanEqual(const V<T,N>& a, const V<T,N>& b) { V<bool,N> r; for (int i = 0; i < N; i++) r[i] = a[i] >= b[i]; return r; }
template<class T, int N> inline V<bool,N> lessThanEqual(const V<T,N>& a, const V<T,N>& b) { V<bool,N> r; for (int i = 0; i < N; i++) r[i] = a[i] <= b[i]; return r; }
#ifndef GLSL_EMU_ALL
#define GLSL_EMU_ALL
template<int N> inline bool all(const V<bool,N>& v) { for (int i = 0; i < N; i++) if (!v[i]) return false; return true; }
#endif
#define GLSL_BINOP(OP) \\
template<class T, int N> inline V<T,N> operator OP(const V<T,N>& a, const V<T,N>& b) { V<T,N> r; for (int i = 0; i < N; i++) r[i] = a[i] OP b[i]; return r; } \\
template<class T, int N> inline V<T,N> operator OP(const V<T,N>& a, T b) { V<T,N> r; for (int i = 0; i < N; i++) r[i] = a[i] OP b; return r; } \\
template<class T, int N> inline V<T,N> operator OP(T a, const V<T,N>& b) { V<T,N> r; for (int i = 0; i < N; i++) r[i] = a OP b[i]; return r; } \\
template<class T, int N> inline V<T,N>& operator OP##=(V<T,N>& a, const V<T,N>& b) { for (int i = 0; i < N; i++) a[i] = a[i] OP b[i]; return a; } \\
template<class T, int N> inline V<T,N>& operator OP##=(V<T,N>& a, T b) { for (int i = 0; i < N; i++) a[i] = a[i] OP b; return a; }
GLSL_BINOP(+) GLSL_BINOP(-) GLSL_BINOP(*) GLSL_BINOP(/)
template<class T, int N> inline V<T,N> operator-(const V<T,N>& a) { V<T,N> r; for (int i = 0; i < N; i++) r[i] = -a[i]; return r; }
// GLSL's vector == and != are one bool over the whole vector (a NaN component compares unequal, as a float does).
template<class T, int N> inline bool operator==(const V<T,N>& a, const V<T,N>& b) { for (int i = 0; i < N; i++) if (!(a[i] == b[i])) return false; return true; }
template<class T, int N> inline bool operator!=(const V<T,N>& a, const V<T,N>& b) { return !(a == b); }
#define GLSL_F1(NAME, EXPR) \\
inline float NAME(float x) { return EXPR; } \\
template<int N> inline V<float,N> NAME(const V<float,N>& v) { V<float,N> r; for (int i = 0; i < N; i++) r[i] = NAME(v[i]); return r; }
GLSL_F1(floor, std::floor(x)) GLSL_F1(ceil, std::ceil(x)) GLSL_F1(trunc, std::trunc(x)) GLSL_F1(fract, x - std::floor(x))
GLSL_F1(sqrt, std::sqrt(x)) GLSL_F1(inversesqrt, 1.0f / std::sqrt(x)) GLSL_F1(sin, std::sin(x)) GLSL_F1(cos, std::cos(x))
GLSL_F1(tan, std::tan(x)) GLSL_F1(asin, std::asin(x)) GLSL_F1(acos, std::acos(x)) GLSL_F1(exp, std::exp(x)) GLSL_F1(log, std::log(x))
GLSL_F1(sign, (x > 0.0f ? 1.0f : (x < 0.0f ? -1.0f : 0.0f)))
inline float abs(float x) { return std::fabs(x); }
inline int abs(int x) { return x < 0 ? -x : x; }
template<class T, int N> inline V<T,N> abs(const V<T,N>& v) { V<T,N> r; for (int i = 0; i < N; i++) r[i] = abs(v[i]); return r; }
inline float atan(float y, float x) { return std::atan2(y, x); }
inline float atan(float x) { return std::atan(x); }
inline float pow(float x, float y) { return std::pow(x, y); }
inline float min(float a, float b) { return b < a ? b : a; }
inline float max(float a, float b) { return a < b ? b : a; }
inline int min(int a, int b) { return b < a ? b : a; }
inline int max(int a, int b) { return a < b ? b : a; }
inline uint min(uint a, uint b) { return b < a ? b : a; }
inline uint max(uint a, uint b) { return a < b ? b : a; }
template<class T, int N> inline V<T,N> min(const V<T,N>& a, const V<T,N>& b) { V<T,N> r; for (int i = 0; i < N; i++) r[i] = min(a[i], b[i]); return r; }
template<class T, int N> inline V<T,N> max(const V<T,N>& a, const V<T,N>& b) { V<T,N> r; for (int i = 0; i < N; i++) r[i] = max(a[i], b[i]); return r; }
template<class T, int N> inline V<T,N> min(const V<T,N>& a, T b) { V<T,N> r; for (int i = 0; i < N; i++) r[i] = min(a[i], b); return r; }
template<class T, int N> inline V<T,N> max(const V<T,N>& a, T b) { V<T,N> r; for (int i = 0; i < N; i++) r[i] = max(a[i], b); return r; }
inline float clamp(float x, float a, float b) { return min(max(x, a), b); }
inline int clamp(int x, int a, int b) { return min(max(x, a), b); }
template<class T, int N> inline V<T,N> clamp(const V<T,N>& x, T a, T b) { V<T,N> r; for (int i = 0; i < N; i++) r[i] = clamp(x[i], a, b); return r; }
template<class T, int N> inline V<T,N> clamp(const V<T,N>& x, const V<T,N>& a, const V<T,N>& b) { V<T,N> r; for (int i = 0; i < N; i++) r[i] = clamp(x[i], a[i], b[i]); return r; }
inline float mix(float a, float b, float t) { return a * (1.0f - t) + b * t; }
template<int N> inline V<float,N> mix(const V<float,N>& a, const V<float,N>& b, float t) { V<float,N> r; for (int i = 0; i < N; i++) r[i] = mix(a[i], b[i], t); return r; }
inline float step(float e, float x) { return x < e ? 0.0f : 1.0f; }
inline float mod(float x, float y) { return x - y * std::floor(x / y); }
#ifdef EMU_FMA
template<int N> inline float dot(const V<float,N>& a, const V<float,N>& b) { float s = a[0] * b[0]; for (int i = 1; i < N; i++) s = std::fma(a[i], b[i], s); return s; }
#else
template<int N> inline float dot(const V<float,N>& a, const V<float,N>& b) { float s = 0.0f; for (int i = 0; i < N; i++) s = s + a[i] * b[i]; return s; }
#endif
template<int N> inline float length(const V<float,N>& a) { return std::sqrt(dot(a, a)); }
template<int N> inline V<float,N> normalize(const V<float,N>& a) { return a / length(a); }
inline uint floatBitsToUint(float x) { uint u; std::memcpy(&u, &x, 4); return u; }
inline float uintBitsToFloat(uint u) { float x; std::memcpy(&x, &u, 4); return x; }
inline bool isinf(float x) { return std::isinf(x); }
inline bool isnan(float x) { return std::isnan(x); }
struct sampler2D { const float* data; long texels; long w = 4096; int id = 2; };
inline long g_fetch[3] = { 0, 0, 0 };   // texelFetch calls per sampler (id 0 band, 1 curve, 2 other), for fetchCount
inline vec4 texelFetch(const sampler2D& s, ivec2 xy, int) {
  g_fetch[s.id]++;
  long idx = (long)xy.y * s.w + xy.x;
  if (xy.x < 0 || xy.y < 0 || idx >= s.texels) return vec4(0.0f);
  const float* p = s.data + idx * 4;
  return vec4(p[0], p[1], p[2], p[3]);
}
}  // namespace glsl
`;
  return h;
}

const CACHE = path.join(os.tmpdir(), 'mantle-glslemu');
/// CPatch's section of the assembled shader, translated whole: it is only #defines, #if guards and
/// function definitions, so the lexical pass and C++'s own preprocessor carry all of it. `out`
/// parameters become references, and `discard` returns zero coverage, which is what it paints.
function cpatchSection(text) {
  const a = text.indexOf('#define CP_STREAM_TAG');
  if (a < 0) throw new Error('glslEmu: the CPatch section is not in the shader text');
  const sec = stripComments(text.slice(a));
  const f = sec.indexOf('float cpatchCoverage()');
  if (f < 0) throw new Error('glslEmu: cpatchCoverage is not in the shader text');
  let d = 0,
    close = -1;
  for (let k = sec.indexOf('{', f); k < sec.length; k++) {
    if (sec[k] === '{') d++;
    else if (sec[k] === '}' && --d === 0) {
      close = k;
      break;
    }
  }
  if (close < 0) throw new Error('glslEmu: cpatchCoverage does not close');
  // ...and the `#endif` of the MANTLE_CPATCH guard it sits in.
  return translateCode(sec.slice(0, close + 1) + '\n#endif\n').replace(
    /\b(?:inout|out)\s+(\w+)\s+(\w+)/g,
    '$1& $2',
  );
}

/// A CPatch twin compiles the kernel with MANTLE_CPATCH, and with the seam companion's code (MANTLE_CPATCH_COMP, which
/// the renderer defines only for a bundle whose packs wrote a companion --) unless `cpatchComp: false`: a
/// twin models every program, and with no companion packed the code it adds is a branch no constraint takes.
function cpatchDefs(defines, cpatch, comp) {
  if (!cpatch) return defines;
  const d = defines.slice();
  if (!d.includes('MANTLE_CPATCH')) d.push('MANTLE_CPATCH');
  if (comp && !d.includes('MANTLE_CPATCH_COMP')) d.push('MANTLE_CPATCH_COMP');
  return d;
}
/// Compile the kernels of `<root>/src/shaders/generated/mantle.frag.glsl` (or `opts.glsl`, for a mutated copy).
/// `curveCov: true` also compiles _lbCoverage.glsl's curveCov and arcCov — the Loop-Blinn curve
/// coverage and the constant-curvature form the recognized SDF primitives take — which no
/// renderFill* root reaches. A K_CURVE_COV / K_ARC_COV query passes its six arguments as
/// (bb.x, bb.y, bb.z, bb.w, c.x, c.y) = (f, fx, fy, fxx, fyy, fxy).
///
/// It is lifted by NAME rather than through the root closure, because `cpatchCurveCov`'s #if
/// branches leave the assembled shader's brace depth at 1 from its declaration to the end of the
/// file: the top-level splitter cannot see anything past it, which is every function _lbCoverage
/// contributes. The text is still the shipped text, translated by the same two passes.
/// Every definition of `name` in the text, in order -- its OVERLOADS too (cdPoly has two: the descent's, and the level
/// form CPatch calls), which C++ overloads as GLSL does. The first is the one a caller instruments.
function liftFn(text, name) {
  const re = new RegExp(
    `(?:^|\\n)[ \\t]*(?:highp |mediump |lowp )?\\w+[ \\t]+${name}[ \\t]*\\(`,
    'g',
  );
  const out = [];
  for (let m; (m = re.exec(text));) {
    const start = m.index + (text[m.index] === '\n' ? 1 : 0);
    const open = text.indexOf('{', start),
      semi = text.indexOf(';', start);
    if (semi >= 0 && semi < open) continue; // a prototype, not a definition
    let d = 0,
      end = -1;
    for (let k = open; k < text.length; k++) {
      if (text[k] === '{') d++;
      else if (text[k] === '}' && --d === 0) {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Error(`glslEmu: ${name} does not close`);
    out.push(translateSignature(translateCode(stripComments(text.slice(start, end + 1)))));
    re.lastIndex = end;
  }
  if (!out.length) throw new Error(`glslEmu: ${name} is not in the shader text`);
  return out.join('\n');
}

/// `fetchCount: 'band' | 'curve'` makes every query answer the number of texelFetch calls it made on that
/// plane instead of its value -- the kernel's fetch count, read off the same text (a look-ahead that fetched
/// more than it said would show here and not in the answers).
///
/// `timed` times the query loop INSIDE the emulator (steady_clock around it, nothing else) and hands the
/// nanoseconds back as the answer array's `ns`: timing run() from node would include the spawn and the
/// job file, which swamp the kernel.
export function buildGlslEmu(
  root,
  {
    defines = [],
    glsl = null,
    invPxFloor = null,
    curveCov = false,
    boxCov = false,
    fetchCount = null,
    cubicSolve = false,
    chainCov = false,
    coverKernel = false,
    cpatch = false,
    stroke = false,
    strokeWalk = false,
    cubicChainCov = false,
    timed = false,
    contract = emuContractDefault(),
    cpatchComp = true,
    strokeExact = true,
  } = {},
) {
  // The stroke kernels are built WITH the exact edge records (MANTLE_STROKE_EXACT, the renderer's strokeExactEdges opt-in): the
  // smokes that drive them guard that path. strokeExact: false builds the default program's stroke code, records absent.
  if ((stroke || strokeWalk) && strokeExact && !defines.includes('MANTLE_STROKE_EXACT'))
    defines = defines.concat('MANTLE_STROKE_EXACT');
  const C = cxx();
  if (!C) throw new Error('glslEmu: no C++ compiler ($CXX, clang++, g++, c++)');
  const text =
    glsl ?? readFileSync(path.join(root, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
  const fm = text.match(/vec2 invPx = 1\.0 \/ max\(ePx, vec2\(([^)]+)\)\);/);
  const floorExpr = invPxFloor ?? (fm ? fm[1] : null);
  if (floorExpr == null) throw new Error("glslEmu: the fill shader's invPx line was not found");
  const hasAacM = /\bfloat\s+renderFillAACM\s*\(/.test(text);
  // A seam's companion bound is cpatchCurveCov's tenth output; a text from before it has nine.
  const compOut = /out\s+vec2\s+nOut\s*,\s*out\s+float\s+outlOut/.test(text);
  // renderFillM is a root of its own: renderFill does not reach it (both answer with AAC's walk directly)
  const hasSlugM = /\bfloat\s+renderFillM\s*\(/.test(text);
  const body = glslToCpp(text, [
    'renderFillGWNSDF',
    'renderFillAAC',
    ...(hasAacM ? ['renderFillAACM'] : []),
    'renderFillHardBand',
    'renderFill',
    ...(hasSlugM ? ['renderFillM'] : []),
    ...(stroke ? STROKE_ROOTS : []),
    ...(strokeWalk ? ['strokeMinDist', 'strokeAaReachEm'] : []),
  ]);
  // only THE ONES THE ROOTS DO NOT ALREADY PULL IN. exactBoxCov is in every fill root's closure and
  // exactBoxCov3 is in none of them, so lifting blindly would define one of them twice.
  const has = (n) => new RegExp(`\\b\\w+\\s+${n}\\s*\\(`).test(body);
  // strokeMinDist's trailing parameters, as the text declares them: the pad's half-width and the edge record
  const smdSig = (text.match(/float\s+strokeMinDist\s*\(([^)]*)\)/) || [null, ''])[1];
  const smdTail =
    (/authHalfW/.test(smdSig) ? ', hw' : '') + (/edgeP/.test(smdSig) ? ', eP_, eQ_' : '');
  // A text from before exactBoxCov23 existed has no such function to lift; only what the text defines is.
  const liftMissing = (names) =>
    names
      .filter((n) => !has(n) && new RegExp(`\\b\\w+\\s+${n}\\s*\\(`).test(text))
      .map((n) => liftFn(text, n))
      .join('\n');
  let lifted = boxCov || cpatch ? liftMissing(BOXCOV_FNS) : '';
  // CPatch's arc distance takes the stroke kernel's closest-point solvers, which no fill root reaches.
  if (cpatch && !cubicSolve)
    lifted += liftMissing([
      'evalC',
      'd2AtT',
      'cdPoly',
      'cubicClosestDescend2',
      'cubicClosestDescend',
      'quadClosestT2',
      'quadClosestT',
    ]);
  if (cpatch) {
    lifted += `
vec4 vLB0, vLB1, vLB2, vLB3; vec3 vTC; float vKind = 14.0f, vSign = 1.0f, vEmPerPx = 1.0f, vSeam = 0.0f; vec2 vEmCoord;
vec4 vAffineFootprint = vec4(0.0f);   // the draw's constant inverse map: none here, so the kernel takes the emulated derivatives
template<class T, int N> inline V<bool,N> notEqual(const V<T,N>& a, const V<T,N>& b) { V<bool,N> r; for (int i = 0; i < N; i++) r[i] = a[i] != b[i]; return r; }
template<int N> inline bool any(const V<bool,N>& v) { for (int i = 0; i < N; i++) if (v[i]) return true; return false; }
// Existing CPatch queries describe a square, axis-aligned em footprint.
// Physical-GPU tests qualify the actual interpolated affine derivatives.
vec2 dFdx(vec2) { return vec2(vEmPerPx, 0.0f); }
vec2 dFdy(vec2) { return vec2(0.0f, vEmPerPx); }
#define vEm vEmCoord
#define cBoxA vLB1.xy()
#define cBoxU vLB1.zw()
#define cBoxV vLB2.xy()
#define cCen vLB3.xy()
#define LBCOV_OUT(c) (c)
#define discard return 0.0f
${cpatchSection(text)}
`;
  }
  if (cubicSolve) {
    // INSTRUMENTED, and only here: cdPoly's lifted body gets a counter as its first statement, so
    // the descending chain's PRICE is read off the same shipped text as its answer rather than
    // from a second count of the source. Nothing else is touched.
    lifted +=
      '\nint cdEvalCount = 0;\n' +
      liftMissing(['evalC', 'evalCD', 'd2AtT']) +
      '\n' +
      liftFn(text, 'cdPoly').replace('{', '{ cdEvalCount = cdEvalCount + 1;') +
      '\n' +
      liftMissing(['cubicClosestDescend2']) +
      '\n' +
      liftFn(text, 'cubicClosestDescend');
  }
  const src = `${vecHeader()}
#include <cstdio>
#include <cstdlib>${timed ? '\n#include <chrono>' : ''}
${cpatchDefs(defines, cpatch, cpatchComp)
  .map((d) => `#define ${d}`)
  .join('\n')}
namespace glsl {
sampler2D uCurveData, uBandData${stroke || strokeWalk ? ', uDashTex' : ''};${stroke || strokeWalk ? '\nint uStrokeGates = 1;' : ''}
${body}
${lifted}
${curveCov ? (/float\s+slugCov\s*\(/.test(text) ? liftFn(text, 'slugCov') + '\n' : '') + liftFn(text, 'curveCov') + '\n' + liftFn(text, 'arcCov') : ''}
${chainCov ? [...['bparamOf', 'cornerOf', 'chainBorderParam'].filter((f) => new RegExp('\\b' + f + '\\(').test(text)), 'chainFillSide', 'chainMissCov', 'chainBoxCov'].map((f) => liftFn(text, f)).join('\n') : ''}
${
  cubicChainCov
    ? liftMissing([...(chainCov ? [] : ['bparamOf', 'cornerOf']), ...BOXCOV_FNS.slice(0, 1)]) +
      '\n' +
      [
        'cbEval',
        'cbEvalD',
        'cbSolve',
        'cbDirStart',
        'cbDirEnd',
        'cbExtrema',
        'cbEvent',
        'cbToBorder',
        'cubicChainBoxCov',
      ]
        .map((f) => liftFn(text, f))
        .join('\n')
    : ''
}
${coverKernel ? liftFn(text, 'coverKernelId') : ''}
}
using namespace glsl;
int main(int argc, char** argv) {
  FILE* f = fopen(argv[1], "rb"); if (!f) return 2;
  int hdr[5]; if (fread(hdr, 4, 5, f) != 5) return 3;
  long nb = hdr[1], nc = hdr[2], nq = hdr[3], nd = hdr[4];
  float* band = (float*)malloc(4 * 4 * (size_t)(nb + 1)), * curve = (float*)malloc(4 * 4 * (size_t)(nc + 1));
  float* dash = (float*)malloc(4 * 4 * (size_t)(nd + 1));
  float* q = (float*)malloc(4 * ${QF} * (size_t)(nq + 1)), * out = (float*)malloc(4 * (size_t)(nq + 1));
  if (fread(band, 4, (size_t)nb * 4, f) != (size_t)nb * 4 || fread(curve, 4, (size_t)nc * 4, f) != (size_t)nc * 4
      || fread(q, 4, (size_t)nq * ${QF}, f) != (size_t)nq * ${QF} || fread(dash, 4, (size_t)nd * 4, f) != (size_t)nd * 4) return 4;
  fclose(f);
  uBandData.data = band; uBandData.texels = nb; uCurveData.data = curve; uCurveData.texels = nc;
${stroke ? '  uDashTex.data = dash; uDashTex.texels = nd; uDashTex.w = 16;   // DASH_TEX_WIDTH' : ''}
  uBandData.id = 0; uCurveData.id = 1;${stroke || strokeWalk ? ' uDashTex.id = 2;' : ''}${timed ? '\n  auto t0_ = std::chrono::steady_clock::now();' : ''}
  for (long i = 0; i < nq; i++) {
    const float* r = q + i * ${QF};
    int k = (int)r[0];
    g_fetch[0] = g_fetch[1] = g_fetch[2] = 0;
    ivec4 GD((int)r[1], (int)r[2], (int)r[3], (int)r[4]);
    vec4 bb(r[5], r[6], r[7], r[8]);
    bool eo = r[9] > 0.5f;
    vec2 c(r[10], r[11]), ePx(r[12], r[13]);
    vec2 invPx = 1.0f / max(ePx, vec2(${/[.eE]/.test(floorExpr) ? floorExpr.trim() + 'f' : floorExpr}));
    float v = -1.0f;
#if defined(MANTLE_HARD_TREE) || (defined(MANTLE_GWN) && !defined(MANTLE_HARD) && !defined(MANTLE_HARD_MIXED))
    if (k == ${K_GWN}) v = renderFillGWNSDF(c, invPx, GD, eo, bb);
#endif
#ifdef MANTLE_AAC
    if (k == ${K_AAC}) v = renderFillAAC(c, invPx, GD, eo, bb);
${
  hasAacM
    ? `#ifdef MANTLE_ROTATED_MAP
    if (k == ${K_AAC_M}) v = renderFillAACM(c, vec2(r[14], r[15]), vec2(r[16], r[17]), GD, eo, bb);
#endif`
    : ''
}
#endif
#if defined(MANTLE_GWN) || defined(MANTLE_HARD) || defined(MANTLE_HARD_MIXED)
    if (k == ${K_HARD}) v = renderFillHardBand(c, GD, eo, bb);
#endif
    if (k == ${K_INVPX}) v = invPx.x;
    if (k == ${K_SLUG}) v = renderFill(c, invPx, GD, eo, bb);
${
  /\bfloat\s+renderFillM\s*\(/.test(text)
    ? text.includes('MANTLE_ROTATED_MAP')
      ? `#ifdef MANTLE_ROTATED_MAP\n    if (k == ${K_SLUG_M}) v = renderFillM(c, vec2(r[14], r[15]), vec2(r[16], r[17]), GD, eo, bb);\n#endif`
      : `    if (k == ${K_SLUG_M}) v = renderFillM(c, vec2(r[14], r[15]), vec2(r[16], r[17]), GD, eo, bb);`
    : ''
}
${
  curveCov
    ? `${/float\s+slugCov\s*\(/.test(text) ? `    if (k == ${K_SLUG_COV}) v = slugCov(bb.x, vec2(bb.y, bb.z));\n` : ''}    if (k == ${K_CURVE_COV}) v = curveCov(bb.x, bb.y, bb.z, bb.w, c.x, c.y);
    if (k == ${K_ARC_COV}) v = arcCov(bb.x, bb.y, bb.z, bb.w, c.x, c.y);`
    : ''
}
${
  cubicSolve
    ? `    if (k == ${K_CUBIC_DESCEND}) v = cubicClosestDescend(vec4(r[5], r[6], r[7], r[8]), vec4(r[14], r[15], r[16], r[17]));
    if (k == ${K_CUBIC_EVALS}) { cdEvalCount = 0;
      cubicClosestDescend(vec4(r[5], r[6], r[7], r[8]), vec4(r[14], r[15], r[16], r[17]));
      v = (float)cdEvalCount; }`
    : ''
}
${
  boxCov
    ? `    if (k == ${K_BOXCOV}) v = exactBoxCov(vec2(r[5], r[6]), r[7]);
    if (k == ${K_BOXCOV2}) v = exactBoxCov2(vec2(r[5], r[6]), r[7], vec2(r[14], r[15]), r[16]);
    if (k == ${K_BOXCOV3}) v = exactBoxCov3(vec2(r[5], r[6]), r[7], vec2(r[14], r[15]), r[16], vec2(r[17], r[18]), r[19]);`
    : ''
}
${chainCov ? `    if (k == ${K_CHAIN_COV}) v = chainBoxCov(vec2(bb.x, bb.y), vec2(bb.z, bb.w), c, ePx, vec2(r[14], r[15]), (float)GD.x);` : ''}
${coverKernel ? `    if (k == ${K_COVER_KID}) v = (float)coverKernelId((int)bb.x, c.x);` : ''}
${cubicChainCov ? `    if (k == ${K_CUBIC_CHAIN_COV}) v = cubicChainBoxCov(vec2(bb.x, bb.y), vec2(bb.z, bb.w), c, ePx, vec2(r[14], r[15]), r[16] > 0.5f, r[17]);` : ''}
${
  cpatch
    ? `    if (k == ${K_CPATCH_COV}) {
      vLB0 = vec4(r[1], r[2], r[3], r[4]); vLB1 = vec4(r[5], r[6], r[7], r[8]); vEmCoord = vec2(r[10], r[11]);
      vLB3 = vec4(r[12], r[13], 0.0f, 0.0f); vTC = vec3(r[14], r[15], r[16]); vLB2 = vec4(r[17], r[18], 0.0f, 0.0f);
      vEmPerPx = r[19]; v = cpatchCoverage();
    }
${
  /\bcpExactBoxCov23\s*\(/.test(text)
    ? `    if (k == ${K_CPATCH_BOX23}) {
      float a2_;
      float a3_ = cpExactBoxCov23(vec2(r[5], r[6]), r[7], vec2(r[14], r[15]), r[16], vec2(r[17], r[18]), r[19], r[2] != 0.0f, a2_);
      v = r[1] != 0.0f ? a2_ : a3_;
    }
`
    : ''
}    if (k == ${K_CPATCH_ARC}) {
      float t_; vec2 f_;
      float dd = cpArcDistFoot(vec4(r[5], r[6], r[7], r[8]), vec4(r[14], r[15], r[16], r[17]), r[1] != 0.0f, vec2(r[10], r[11]), ${/float cpArcDistFoot\(vec4 g0, vec4 g1, bool arc3, vec2 p, float certEm/.test(text) ? 'r[19] > 0.0f ? 4.8828125e-4f * r[19] : 0.0f, ' : ''}t_, f_);
      v = r[2] != 0.0f ? t_ : dd;
    }
    if (k == ${K_CPATCH_CURVE}) {
      bool cut_, near_, hull_; float soft_, sd_, outl_ = 1.0f; vec2 n_;
      float cv = cpatchCurveCov((int)r[2], vec2(r[10], r[11]), r[19], cut_, soft_, near_, hull_, sd_, n_${compOut ? ', outl_' : ''});
      int w = (int)r[1];
      v = w == 0 ? cv : w == 1 ? soft_ : w == 2 ? (near_ ? 1.0f : 0.0f) : w == 3 ? sd_ : w == 4 ? n_.x : w == 5 ? n_.y
        : w == 6 ? (cut_ ? 1.0f : 0.0f) : w == 7 ? (hull_ ? 1.0f : 0.0f) : outl_;
    }`
    : ''
}
${
  stroke
    ? `    if (k == ${K_QUAD_ARCLEN}) v = quadArcLen(vec2(bb.x, bb.y), vec2(bb.z, bb.w), c, ePx.x);
    if (k == ${K_PERP_ARC}) v = perpDistToArc(vec2(bb.x, bb.y), vec2(bb.z, bb.w), c.x);
    if (k == ${K_STROKE_QUAD}) { vec2 g; vec4 eP_, eQ_;
      v = strokeQuadAccum(bb, c, GD.x != 0, GD.y != 0, GD.z & 15, (GD.z >> 4) & 15, GD.w, ePx.x, ePx.y,
                          vec2(r[14], r[15]), vec2(r[16], r[17]), 0, ${has('dashHeader') ? 'vec4(0.0f), ' : ''}0.0f, vec4(0.0f), 1e30f, g${has('strokeExactCov') ? ', 1e30f, eP_, eQ_' : ''});
      if ((GD.z >> 8) == 1) v = g.x; else if ((GD.z >> 8) == 2) v = g.y; }
    if (k == ${K_QUAD_T}) v = quadClosestT(vec2(bb.x, bb.y), vec2(bb.z, bb.w), c);
    if (k == ${K_STROKE_CUBIC}) { vec2 g; vec4 eP_, eQ_;
      v = strokeCubicAccum(bb, vec4(c.x, c.y, r[14], r[15]), GD.x != 0, GD.y != 0, GD.z & 15, (GD.z >> 4) & 15, GD.w, ePx.x, ePx.y,
                           vec2(r[16], r[17]), vec2(r[18], r[19]), 0, ${has('dashHeader') ? 'vec4(0.0f), ' : ''}0.0f, vec4(0.0f), 1e30f, g${has('strokeExactCov') ? ', 1e30f, eP_, eQ_' : ''});
      if ((GD.z >> 8) == 1) v = g.x; else if ((GD.z >> 8) == 2) v = g.y; }
    if (k == ${K_STROKE_ARC}) { vec2 g; vec4 eP_, eQ_;
      v = strokeArcAccum(vec2(bb.x, bb.y), vec2(bb.z, bb.w), c.x, c.y, r[14], GD.x != 0, GD.y != 0, GD.z & 15, (GD.z >> 4) & 15,
                         GD.w, ePx.x, ePx.y, vec2(r[15], r[16]), vec2(r[17], r[18]), 0, ${has('dashHeader') ? 'vec4(0.0f), ' : ''}0.0f, vec4(0.0f), 1e30f, g${has('strokeExactCov') ? ', 1e30f, eP_, eQ_' : ''});
      if ((GD.z >> 8) == 1) v = g.x; else if ((GD.z >> 8) == 2) v = g.y; }
    if (k == ${K_STROKE_WALK}) { vec2 g; float hw = r[14]; vec4 eP_ = vec4(0.0f), eQ_ = vec4(0.0f);
      uStrokeGates = (int)r[20];
      v = strokeMinDist(c, GD, bb, hw, (int)r[16], (int)r[17], (int)r[18], r[15], (int)r[19], g, r[22],
                        strokeAaReachEm(hw, ePx)${has('strokeExactCov') ? (/float authHalfW,/.test(text) ? ', (r[23] > 0.0f ? r[23] : hw)' : '') + ', eP_, eQ_' : ''});
      int w = (int)r[21];
      if (w == 1) v = g.x; else if (w == 2) v = g.y;
      else if (w >= 4 && w < 8) v = eP_[w - 4]; else if (w >= 8 && w < 12) v = eQ_[w - 8]; }
    if (k == ${K_STROKE_LOCAL}) { vec2 g; float hw = r[14]; vec4 eP_ = vec4(0.0f), eQ_ = vec4(0.0f);
      uStrokeGates = (int)r[20];
      v = strokeMinDistLocal(c, GD, bb, vec4(r[22], r[23], r[24], r[25]), hw, (int)r[16], (int)r[17], (int)r[18], r[15],
                             (int)r[19], g, ePx, uStrokeGates != 0${has('strokeExactCov') ? (/float authHalfW,/.test(text) ? ', hw' : '') + ', eP_, eQ_' : ''});
      int w = (int)r[21];
      if (w == 1) v = g.x; else if (w == 2) v = g.y; else if (w == 3) v = hw;
      else if (w >= 4 && w < 8) v = eP_[w - 4]; else if (w >= 8 && w < 12) v = eQ_[w - 8]; }
${has('strokeEdgeCov') ? `    if (k == ${K_STROKE_EDGE}) v = strokeEdgeCov(bb.x, bb.y, vec2(bb.z, bb.w), ePx, GD.x != 0);` : ''}
${has('strokeExactCov') && defines.includes('MANTLE_STROKE_EXACT') ? `    if (k == ${K_STROKE_EXACT}) v = strokeExactCov(bb, vec4(r[14], r[15], r[16], r[17]), r[22], vec4(r[18], r[19], r[20], r[21]), ePx);` : ''}
    if (k == ${K_ELLIPSE_DIST}) { vec2 ft; v = distToEllipse(vec2(bb.x, bb.y), vec2(bb.z, bb.w), ft);
      if (GD.x == 1) v = ft.x; else if (GD.x == 2) v = ft.y; }`
    : ''
}
${
  strokeWalk
    ? `    if (k == ${K_STROKE_BAND} || k == ${K_STROKE_BAND_GX} || k == ${K_STROKE_BAND_GY}) {
      uStrokeGates = eo ? 1 : 0;
      float hw = r[14]; vec2 g; vec4 eP_ = vec4(0.0f), eQ_ = vec4(0.0f);
      float m = strokeMinDist(c, GD, bb, hw, (int)r[15], (int)r[16], (int)r[17], r[18], (int)r[19], g,
                              max(hw - 0.5f * length(ePx), 0.0f), strokeAaReachEm(hw, ePx)${smdTail});
      v = k == ${K_STROKE_BAND} ? m : k == ${K_STROKE_BAND_GX} ? g.x : g.y;
    }`
    : ''
}
${fetchCount ? `    v = (float)g_fetch[${fetchCount === 'band' ? 0 : 1}];` : ''}
    out[i] = v;
  }${
    timed
      ? `
  printf("EMU_NS %lld\\n", (long long)std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - t0_).count());`
      : ''
  }
  FILE* g = fopen(argv[2], "wb"); fwrite(out, 4, (size_t)nq, g); fclose(g);
  return 0;
}
`;
  const key = createHash('sha1')
    .update(C + '\0' + (contract ? 'fma\0' : '') + src)
    .digest('hex')
    .slice(0, 20);
  mkdirSync(CACHE, { recursive: true });
  const exe = path.join(CACHE, `emu_${key}`);
  if (!existsSync(exe)) {
    const cpp = `${exe}.${process.pid}.cpp`,
      tmpExe = `${exe}.${process.pid}.tmp`;
    writeFileSync(cpp, src);
    const r = spawnSync(C, ['-std=c++17', '-O2', ...fpFlags(contract), '-w', '-o', tmpExe, cpp], {
      encoding: 'utf8',
    });
    if (r.status !== 0)
      throw new Error(
        `glslEmu: compile failed (source kept at ${cpp}):\n` +
          (r.stderr || '').split('\n').slice(0, 30).join('\n'),
      );
    rmSync(cpp, { force: true });
    spawnSync('mv', ['-f', tmpExe, exe]);
  }
  return {
    exe,
    /// `dashF32` (optional): the dash plane, 64 floats per row as bundleFinalize writes it; uDashTex reads it.
    run(bandF32, curveF32, queries, dashF32 = null) {
      const nq = queries.length;
      const dash =
        dashF32 && dashF32.length >= 4
          ? dashF32.subarray(0, dashF32.length - (dashF32.length % 4))
          : new Float32Array(0);
      const H = 20,
        qOff = H + bandF32.byteLength + curveF32.byteLength;
      const buf = Buffer.alloc(qOff + nq * 4 * QF + dash.byteLength);
      buf.writeInt32LE(0x454d55, 0);
      buf.writeInt32LE(bandF32.length / 4, 4);
      buf.writeInt32LE(curveF32.length / 4, 8);
      buf.writeInt32LE(nq, 12);
      buf.writeInt32LE(dash.length / 4, 16);
      Buffer.from(bandF32.buffer, bandF32.byteOffset, bandF32.byteLength).copy(buf, H);
      Buffer.from(curveF32.buffer, curveF32.byteOffset, curveF32.byteLength).copy(
        buf,
        H + bandF32.byteLength,
      );
      Buffer.from(dash.buffer, dash.byteOffset, dash.byteLength).copy(buf, qOff + nq * 4 * QF);
      const qf = new Float32Array(buf.buffer, buf.byteOffset + qOff, nq * QF);
      const Z4 = [0, 0, 0, 0];
      queries.forEach((q, i) => {
        const GD = q.GD || Z4,
          c = q.c || Z4,
          ePx = q.ePx || Z4,
          ex = q.ex || [];
        qf.set(
          [
            q.k,
            GD[0],
            GD[1],
            GD[2],
            GD[3],
            q.bb[0],
            q.bb[1],
            q.bb[2],
            q.bb[3] || 0,
            q.eo ? 1 : 0,
            c[0],
            c[1],
            ePx[0],
            ePx[1],
          ],
          i * QF,
        );
        for (let e = 0; e < QF - 14; e++) qf[i * QF + 14 + e] = ex[e] || 0;
        // A chain query names its point `x`; the generalized record carries it in the shared
        // extra slots, so the two spellings mean the same two floats.
        if (q.x) {
          qf[i * QF + 14] = q.x[0];
          qf[i * QF + 15] = q.x[1];
        }
      });
      const job = path.join(CACHE, `job_${process.pid}_${Math.random().toString(36).slice(2)}`);
      writeFileSync(job + '.in', buf);
      const r = spawnSync(exe, [job + '.in', job + '.out'], { encoding: 'utf8' });
      rmSync(job + '.in', { force: true });
      if (r.status !== 0) throw new Error(`glslEmu: emulator exit ${r.status} ${r.stderr || ''}`);
      const ob = readFileSync(job + '.out');
      rmSync(job + '.out', { force: true });
      const res = new Float32Array(ob.buffer.slice(ob.byteOffset, ob.byteOffset + nq * 4));
      if (timed) {
        const m = /EMU_NS (\d+)/.exec(r.stdout || '');
        res.ns = m ? +m[1] : NaN;
      }
      return res;
    },
  };
}

/// THE SPLIT-STROKE PASS, both stages, from their assembled text (src/shaders/generated/splitStroke.{vert,frag}.glsl;
/// its one caller is incrementalStroke): the vertex stage's strokeVertexSetup reads a segment from the prim plane and
/// writes the flat varyings, then the fragment stage's strokeCoverage runs on them at the query's fragment. Varyings and
/// uniforms are globals, `fwidth(vEm)` answers the query's ePx, and `discard` returns 0 -- the coverage it paints. The
/// STROKE_SET_* macros the vertex stage writes through are taken from the vertex text itself.
///   const emu = buildSplitStrokeEmu(ROOT);
///   emu.run(primF32, [{ base, c: [x, y], ePx: [ex, ey], halfW, miterLimit, cap, join, exactAa }])   // coverage
///   ...with `corner: 1..8`: the vertex stage's segment-quad corner (corner - 1) >> 1, its x (odd) or y (even), at em per
///   pixel 1 (the quad's 3 px margin is 3 em) -- the quad the pass rasterizes
/// `base` is the segment header's texel index in `primF32` (4096 texels a row, as the curve plane's).
/// run()'s third argument sets the vertex stage's view, `{ bbox: [x, y, w, h], canvasAR: [sx, sy], viewport: [w, h],
/// worldM: 9 floats column-major or null }`; left out it is the unit view above, one em a pixel and no world matrix.
/// The fragment's ePx is still the query's: the caller derives it from the same view.
/// `nanPoison: true` builds the GPU the GLSL spec permits at its edges: atan(0, 0), which it leaves undefined, is a NaN,
/// and min / max hand a NaN operand back, as a driver may (the default header, like libm, answers 0 and drops the NaN).
export function buildSplitStrokeEmu(root, { vert = null, frag = null, nanPoison = false } = {}) {
  const C = cxx();
  if (!C) throw new Error('glslEmu: no C++ compiler ($CXX, clang++, g++, c++)');
  const vText =
    vert ?? readFileSync(path.join(root, 'src/shaders/generated/splitStroke.vert.glsl'), 'utf8');
  const fText =
    frag ?? readFileSync(path.join(root, 'src/shaders/generated/splitStroke.frag.glsl'), 'utf8');
  const body = glslToCpp(fText, ['strokeCoverage']);
  const macros = (vText.match(/^#define STROKE_SET_\w+\([^)]*\).*$/gm) || []).join('\n');
  if (!/STROKE_SET_TYPE/.test(macros))
    throw new Error("glslEmu: the vertex stage's STROKE_SET_* macros were not found");
  const setup = [
    ...(/float curveAtan2\(/.test(vText) && !/float curveAtan2\(/.test(body) ? ['curveAtan2'] : []),
    'strokeFtx',
    'strokeNrm',
    ...(/strokeWorldStretch/.test(vText) ? ['strokeWorldStretch'] : []),
    'strokeVertexSetup',
  ]
    .map((n) => liftFn(vText, n))
    .join('\n');
  const worldArgs = /mat3 worldM/.test(vText) ? ', W, hasW' : '';
  let header = vecHeader();
  if (nanPoison) {
    const edits = [
      [
        'inline float atan(float y, float x) { return std::atan2(y, x); }',
        'inline float atan(float y, float x) { return (y == 0.0f && x == 0.0f) ? NAN : std::atan2(y, x); }',
      ],
      [
        'inline float min(float a, float b) { return b < a ? b : a; }',
        'inline float min(float a, float b) { return (b < a || b != b) ? b : a; }',
      ],
      [
        'inline float max(float a, float b) { return a < b ? b : a; }',
        'inline float max(float a, float b) { return (a < b || b != b) ? b : a; }',
      ],
    ];
    for (const [a, b] of edits) {
      if (!header.includes(a)) throw new Error('glslEmu: nanPoison: the header changed');
      header = header.replace(a, b);
    }
  }
  const src = `${header}
#include <cstdio>
#include <cstdlib>
namespace glsl {
struct mat3 { vec3 c[3]; mat3() {} vec3& operator[](int i) { return c[i]; } const vec3& operator[](int i) const { return c[i]; } };
inline vec3 operator*(const mat3& m, const vec3& v) { vec3 r; for (int i = 0; i < 3; i++) r[i] = m.c[0][i] * v.x + m.c[1][i] * v.y + m.c[2][i] * v.z; return r; }
vec2 vP0, vP1, vP2, vP3, vInTan, vOutTan, vEm, gEPx;
float vHalfW, vMiterLimit, vFreeStart, vFreeEnd, vSegType, vStartDist;
int vCap, vJoin, uDashId = 0, uStrokeExactAa = 1, uPrimW = 4096;
sampler2D uDashTex, uPrim;
inline vec2 fwidth(vec2) { return gEPx; }
#define discard return 0.0f
${body}
#undef discard
${translateCode(macros)}
${setup}
}
using namespace glsl;
int main(int argc, char** argv) {
  FILE* f = fopen(argv[1], "rb"); if (!f) return 2;
  int hdr[3]; if (fread(hdr, 4, 3, f) != 3) return 3;
  float vw[18]; if (fread(vw, 4, 18, f) != 18) return 3;
  vec4 bb(vw[0], vw[1], vw[2], vw[3]); vec2 ar(vw[4], vw[5]), vp(vw[6], vw[7]);
  int hasW = (int)vw[8]; mat3 W; for (int c = 0; c < 3; c++) W.c[c] = vec3(vw[9 + c * 3], vw[10 + c * 3], vw[11 + c * 3]);
  long np = hdr[1], nq = hdr[2];
  float* prim = (float*)malloc(4 * 4 * (size_t)(np + 1)), * q = (float*)malloc(4 * 12 * (size_t)(nq + 1)), * out = (float*)malloc(4 * (size_t)(nq + 1));
  if (fread(prim, 4, (size_t)np * 4, f) != (size_t)np * 4 || fread(q, 4, (size_t)nq * 12, f) != (size_t)nq * 12) return 4;
  fclose(f);
  uPrim.data = prim; uPrim.texels = np;
  for (long i = 0; i < nq; i++) {
    const float* r = q + i * 12;
    uStrokeExactAa = (int)r[10];
    int mode = (int)r[11];
    vec2 corner = strokeVertexSetup(r[0], mode > 0 ? (float)((mode - 1) >> 1) : 0.0f, r[5], r[6], (int)r[7], (int)r[8], 0,
                                    bb, ar, vp${worldArgs});
    vEm = vec2(r[1], r[2]); gEPx = vec2(r[3], r[4]);
    // mode 1..8: the segment quad's corner (mode - 1) / 2, its x or y -- the vertex stage's own output (em per pixel 1)
    out[i] = mode > 0 ? (((mode - 1) & 1) ? corner.y : corner.x) : strokeCoverage();
  }
  FILE* g = fopen(argv[2], "wb"); fwrite(out, 4, (size_t)nq, g); fclose(g);
  return 0;
}
`;
  const key = createHash('sha1')
    .update(C + '\0' + src)
    .digest('hex')
    .slice(0, 20);
  mkdirSync(CACHE, { recursive: true });
  const exe = path.join(CACHE, `split_${key}`);
  if (!existsSync(exe)) {
    const cpp = `${exe}.${process.pid}.cpp`,
      tmpExe = `${exe}.${process.pid}.tmp`;
    writeFileSync(cpp, src);
    const r = spawnSync(C, ['-std=c++17', '-O2', '-ffp-contract=off', '-w', '-o', tmpExe, cpp], {
      encoding: 'utf8',
    });
    if (r.status !== 0)
      throw new Error(
        `glslEmu: compile failed (source kept at ${cpp}):\n` +
          (r.stderr || '').split('\n').slice(0, 30).join('\n'),
      );
    rmSync(cpp, { force: true });
    spawnSync('mv', ['-f', tmpExe, exe]);
  }
  return {
    exe,
    run(primF32, queries, view = null) {
      const nq = queries.length,
        prim = primF32.subarray(0, primF32.length - (primF32.length % 4));
      const V = 18 * 4,
        buf = Buffer.alloc(12 + V + prim.byteLength + nq * 4 * 12);
      buf.writeInt32LE(0x53504c, 0);
      buf.writeInt32LE(prim.length / 4, 4);
      buf.writeInt32LE(nq, 8);
      const vf = new Float32Array(buf.buffer, buf.byteOffset + 12, 18);
      vf.set([
        ...(view?.bbox ?? [0, 0, 1, 1]),
        ...(view?.canvasAR ?? [1, 1]),
        ...(view?.viewport ?? [1, 1]),
        view?.worldM ? 1 : 0,
        ...(view?.worldM ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]),
      ]);
      Buffer.from(prim.buffer, prim.byteOffset, prim.byteLength).copy(buf, 12 + V);
      const qf = new Float32Array(buf.buffer, buf.byteOffset + 12 + V + prim.byteLength, nq * 12);
      queries.forEach((q, i) =>
        qf.set(
          [
            q.base,
            q.c[0],
            q.c[1],
            q.ePx[0],
            q.ePx[1],
            q.halfW,
            q.miterLimit ?? 4,
            q.cap ?? 0,
            q.join ?? 0,
            0,
            q.exactAa ?? 1,
            q.corner ?? 0,
          ],
          i * 12,
        ),
      );
      const job = path.join(CACHE, `sjob_${process.pid}_${Math.random().toString(36).slice(2)}`);
      writeFileSync(job + '.in', buf);
      const r = spawnSync(exe, [job + '.in', job + '.out'], { encoding: 'utf8' });
      rmSync(job + '.in', { force: true });
      if (r.status !== 0)
        throw new Error(`glslEmu: split emulator exit ${r.status} ${r.stderr || ''}`);
      const ob = readFileSync(job + '.out');
      rmSync(job + '.out', { force: true });
      return new Float32Array(ob.buffer.slice(ob.byteOffset, ob.byteOffset + nq * 4));
    },
  };
}

/// The fill shapes of an imported bundle, as kernel inputs. `tree` says the shape carries a GWN run tree (only fill rows
/// built with gwnTree do; a clip or mask child's row does not, and its texel after the band headers is something else):
/// the encoder writes the nodes, then the refs, so refBase is nodeBase + 2 * nodeCount.
export function fillShapes(b, parseMetaBin, M) {
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    F = pm.metaFloats,
    out = [];
  const band = new Float32Array(b.bands);
  for (let s = 0; s < b.numShapes; s++) {
    const o = s * pm.floatsPerShape;
    if (!(F[o + M.META_FILL_A] > 0) || (F[o + M.META_BAND_MAX_Y] | 0) < 0) continue;
    const GD = [
      F[o + M.META_GLYPH_LOC_X] | 0,
      F[o + M.META_GLYPH_LOC_Y] | 0,
      F[o + M.META_BAND_MAX_X] | 0,
      F[o + M.META_BAND_MAX_Y] | 0,
    ];
    const h = (GD[1] * 4096 + GD[0] + (GD[2] + GD[3] + 2) * 2) * 4;
    const nodes = Math.abs(band[h + 1]) | 0;
    const tree =
      h + 3 < band.length && nodes > 0 && band[h + 3] > 0 && band[h + 2] === band[h] + 2 * nodes;
    out.push({
      s,
      GD,
      tree,
      bb: [
        F[o + M.META_BBOX_XMIN],
        F[o + M.META_BBOX_YMIN],
        F[o + M.META_BBOX_XMAX],
        F[o + M.META_BBOX_YMAX],
      ],
      eo: (F[o + M.META_FILL_RULE] | 0) === 1,
      range: b.curveRangesByShape[s],
    });
  }
  return out;
}

/// A bundle's fill data scaled exactly by a power of two: every coordinate the band and tree kernels read is multiplied by
/// S, every inverse length (a cubic piece's k/l/m gradients) divided by it, and every index, count, angle, sign and unit
/// vector left alone. Throws if one float would be scaled two ways. Kernel scale invariance can then be tested apart from
/// the importer and the encoder.
/// `gwnExactArea` (default true): the data comes from an encoder that writes every GWN cubic piece's control points
///; false for a bundle from before it.
export function scaleFillData(bandF32, curveF32, shapes, S, gwnExactArea = true) {
  const band = new Float32Array(bandF32),
    curve = new Float32Array(curveF32);
  const doneB = new Map(),
    doneC = new Map();
  const mark = (arr, done, src, texel, comp, k) => {
    const i = texel * 4 + comp;
    if (done.has(i)) {
      if (done.get(i) !== k) throw new Error(`glslEmu: texel ${texel}.${comp} scaled two ways`);
      return;
    }
    done.set(i, k);
    arr[i] = Math.fround(src[i] * k);
  };
  const B = (t, c, k) => mark(band, doneB, bandF32, t, c, k),
    C = (t, c, k) => mark(curve, doneC, curveF32, t, c, k);
  const bt = (t, c) => bandF32[t * 4 + c],
    ct = (t, c) => curveF32[t * 4 + c];
  const seg = (loc, type) => {
    if (type === 0) for (let c = 0; c < 4; c++) C(loc + 1, c, S);
    else if (type === 1) {
      for (let c = 0; c < 4; c++) C(loc + 1, c, S);
      C(loc + 2, 0, S);
      C(loc + 2, 1, S);
    } else if (type === 2)
      for (let c = 0; c < 4; c++) {
        C(loc + 1, c, S);
        C(loc + 2, c, S);
      }
    else
      for (let c = 0; c < 4; c++) {
        C(loc + 1, c, S);
        C(loc + 2, c, 1);
        C(loc + 3, c, S);
      } // + the stored endpoints
  };
  for (const sh of shapes) {
    const g = sh.GD[1] * 4096 + sh.GD[0],
      bandsX = sh.GD[2] + 1,
      bandsY = sh.GD[3] + 1;
    const list = (slot) => {
      const n = [0, 1, 2, 3].map((c) => bt(g + slot, c) | 0),
        arr = bt(g + slot + 1, 0) | 0;
      // entry (loc, break, z, w): z and w are coordinates in either layout -- (far bound, 0) or, with the
      // lanes, the crossing-axis (min, max) -- and 0 scales to itself
      for (let type = 0, e = 0; type < 4; type++)
        for (let i = 0; i < n[type]; i++, e++) {
          B(g + arr + e, 1, S);
          B(g + arr + e, 2, S);
          B(g + arr + e, 3, S);
          seg(bt(g + arr + e, 0) | 0, type);
        }
    };
    for (let by = 0; by < bandsY; by++) list(by * 2);
    for (let bx = 0; bx < bandsX; bx++) list((bandsY + bx) * 2);
    // band 0's .y is the level slot plus the ray-lane bit (bit 0; the slot is even)
    const lvSlot = (bt(g + 1, 1) | 0) & ~1,
      lTop = bt(g + 1, 2) | 0,
      lFirst = bt(g + 1, 3) | 0;
    for (let l = Math.max(lFirst, 1), k = 0; lTop > 0 && l <= lTop; l++)
      for (let b = 0; b < (bandsY + (1 << l) - 1) >> l; b++, k++) list(lvSlot + k * 2);
    if (!sh.tree) continue;
    const hdr = g + (bandsY + bandsX) * 2;
    const nodeBase = bt(hdr, 0) | 0,
      nodeCount = Math.abs(bt(hdr, 1)) | 0,
      refBase = bt(hdr, 2) | 0,
      refCount = bt(hdr, 3) | 0;
    if (!(nodeCount > 0)) continue;
    for (let i = 0; i < nodeCount; i++) {
      for (let c = 0; c < 4; c++) B(g + nodeBase + i * 2, c, S);
      for (let c = 0; c < 3; c++) B(g + nodeBase + i * 2 + 1, c, S);
    }
    for (let i = 0; i < refCount; i++) {
      const R = g + refBase + i,
        loc = (bt(R, 1) | 0) * 4096 + (bt(R, 0) | 0),
        ty = ((bt(R, 2) + 0.5) | 0) % 16;
      if (ty === 0 || ty === 1) seg(loc, ty);
      else if (ty === 6)
        for (let c = 0; c < 4; c++) {
          C(loc, c, S);
          C(loc + 1, c, S);
        }
      else if (ty === 4) {
        for (let c = 0; c < 4; c++) C(loc, c, S);
        for (const r of [1, 2, 3]) {
          C(loc + r, 0, 1 / S);
          C(loc + r, 1, 1 / S);
        }
        C(loc + 3, 3, S);
        // the raw control points: on every cubic piece under the exact-area pass (it reads them), else on the
        // exactly wound ones only (luneW 0). A record written without that pass and luneW != 0 has no texel 5.
        if (ct(loc + 1, 3) === 0 || gwnExactArea) for (let c = 0; c < 4; c++) C(loc + 5, c, S);
      } else if (ty === 5) {
        for (let c = 0; c < 4; c++) {
          C(loc, c, S);
          C(loc + 1, c, S);
        }
        C(loc + 2, 3, S);
      } // texel 4 (angles) as is
    }
    const ext = g + refBase + refCount;
    const rbBase = bt(ext, 0) | 0,
      GB = bt(ext, 1) | 0,
      gridBase = bt(ext, 2) | 0,
      gwh = bt(ext, 3) | 0;
    for (let b = 0; b < GB; b++) {
      const h = g + rbBase + (b >> 1),
        base = bt(h, (b & 1) * 2) | 0,
        cnt = bt(h, (b & 1) * 2 + 1) | 0;
      for (let e = 0; e < cnt; e++) for (const c of [1, 2, 3]) B(g + base + e, c, S);
    }
    if (gridBase > 0)
      for (let ci = 0; ci < (gwh >> 8) * (gwh & 255); ci++)
        B(g + gridBase + (ci >> 1), (ci & 1) * 2 + 1, S);
  }
  return { band, curve };
}
