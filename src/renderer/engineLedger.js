// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// engineLedger.js — WHICH ENGINE actually PAINTED, and when one did not, why.

//   an OPTION      cpatchFill / aacFill / setLoopBlinnFill('on'|'auto'|'off')  — what was ASKED for
//   a MESH FLAG    `packed.cpatch`, set by CPatch's own packer                   — CPatch only
//   a ROUTE COUNT  loopBlinnRouteCount / unifiedFillDraws / unifiedWarmFallbacks
//
// Slug is in none of them: it is "no LB kind at all, shade through the coverage kernel". None of
// them answers which engine drew a frame, and triangulating it from them takes a different
// hand-written rule per engine:
//
//   if (name === 'cpatch' && !row.morph && !(x.cpatchBuilt | 0)) return null;   // built...
//   if ((x.warmFb | 0)) return null;                                            // ...but drew?
//   if (name === 'lb' && !(x.lbReady && x.route)) return null;                  // different test
//
// Guessing wrong is not a reporting inconvenience, it is a wrong measurement attributed to the
// wrong engine: a timing credited to CPatch can be LB's, and an antialiasing result credited to
// CPatch can be Slug's because a fragment shader failed to compile and the pixels could not say
// so. Pixels never can. Only the draw site knows.

// A decline is data. "CPatch drew 0 times" and "CPatch drew 0 times because its variant would not
// compile" are different findings, and only the second one names a bug. Every path that turns an
// engine away records why, so a silent fallback becomes a reportable event rather than a number
// that quietly belongs to somebody else.

// ENGINE SELECTION IS TWO AXES, NOT ONE, which is why no single setter fits. A bundle draws ANALYTIC GEOMETRY (Loop-Blinn triangles, CPatch covers) and COVER QUADS, and
// the two are shaded by different things:
//
//   ROUTE    what carries the geometry     none (cover quads only) | lb | cpatch
//   KERNEL   what shades a cover fragment  slug | aac | hard-band | hard-tree | hard-mixed
//
// They are independent: a bundle can take the LB route for the shapes that have meshes and shade
// the rest with AAC in the same draw, which is exactly why setLoopBlinnFill('on'|'auto'|'off') and
// aacFill are separate options rather than one enum -- and why cpatchFill being a third boolean,
// with a fourth (gwnTree) and a fifth (noAaFill) on the import side, reads as five unrelated
// switches instead of two choices. ENGINES names the union, since a DRAW is attributed to whatever
// shaded it and a frame can honestly contain several.
//
/// What shaded a draw. Not what was configured, and not what geometry it used.
import { FS_GROUP_BEGIN, FS_GROUP_END } from '../bundle/layout.js';

export const ENGINES = Object.freeze({
  SLUG: 'slug', // the default fill kernel: the exact box coverage (AAC's walk)
  AAC: 'aac', // exact per-pixel signed area (Manson-Schaefer)
  LB: 'lb', // Loop-Blinn implicit coverage, unified route
  CPATCH: 'cpatch', // Dokter half-space patches, unified route
  SDF: 'sdf', // a RECOGNIZED primitive -- circle, ellipse or annulus -- drawn as an
  // exact SDF record. A peer, not a Loop-Blinn result: the shape was
  // recognized (shapeRecognize) and never decomposed by any engine, so
  // crediting it to whichever builder asked reads as that engine being
  // fast on circles when nothing was fitted at all.
  HARD_BAND: 'hard-band', // no-AA band crossings
  HARD_TREE: 'hard-tree', // no-AA winding tree
  HARD_MIXED: 'hard-mixed', // per-row hard where a stroke covers the fill edge
  HARD_MIXED_AAC: 'hard-mixed+aac', // ...with the antialiased rows on AAC rather than Slug
  GWN: 'gwn',
  INERT: 'inert', // stroke-only: no fill kernel runs at all
  STROKE: 'stroke',
});

export const ROUTES = Object.freeze({
  UNIFIED: 'unified', // the ubershader's single drawArrays: cover quads + analytic geometry
  CLASSIC: 'classic', // the standalone loopBlinn program, per shape, composed through an RT
  COVER: 'cover', // a cover-quad draw shaded by the coverage kernel
  POINTS: 'points', // small shapes as 1-px points, the coverage kernel run per point in the vertex stage
  INSTANCED: 'instanced', // N copies of a simple fill-only bundle in one drawArraysInstanced
});

/// Why an engine did not draw. The reason is the finding; the count alone is not.
export const DECLINE = Object.freeze({
  NOT_BUILT: 'not-built', // no mesh/patches for this bundle
  PENDING: 'pending', // an off-thread build has not landed yet
  NOT_WARM: 'not-warm', // variant or pipeline still linking
  COMPILE_FAILED: 'compile-failed', // the variant cannot link at all — a bug, not a wait
  UNSUPPORTED: 'unsupported', // a feature this route cannot serve (group, blend leaf)
  GATED: 'gated', // a cost/size/memory gate chose otherwise
  NO_TREE: 'no-gwn-tree', // a tree kernel was pinned on a bundle imported without its run tree
});

/** @type {Set<string>} */
const KNOWN = new Set(Object.values(ENGINES));

export function createEngineLedger() {
  const draws = Object.create(null);
  const routes = Object.create(null);
  const viaRoute = Object.create(null);
  const declines = Object.create(null);
  let last = null;
  return {
    /// One submitted draw, attributed to an engine AND to the route that carried it.
    drew(engine, route = ROUTES.UNIFIED, n = 1) {
      if (!engine) return;
      draws[engine] = (draws[engine] | 0) + n;
      routes[route] = (routes[route] | 0) + n;
      const k = engine + '@' + route;
      viaRoute[k] = (viaRoute[k] | 0) + n;
      last = engine;
    },
    /// An engine was asked for and did not draw. Reasons accumulate per engine, so a bundle that
    /// waits three frames and then fails to compile reports both, in the proportion they happened.
    declined(engine, reason) {
      if (!engine || !reason) return;
      const e = declines[engine] || (declines[engine] = Object.create(null));
      e[reason] = (e[reason] | 0) + 1;
    },
    reset() {
      for (const k of Object.keys(routes)) delete routes[k];
      for (const k of Object.keys(viaRoute)) delete viaRoute[k];
      for (const k of Object.keys(draws)) delete draws[k];
      for (const k of Object.keys(declines)) delete declines[k];
      last = null;
    },
    /// Plain data, copied — debugStats is read across frames and must not alias live counters.
    snapshot() {
      const d = {};
      for (const k of Object.keys(draws)) d[k] = draws[k];
      const rt = {};
      for (const k of Object.keys(routes)) rt[k] = routes[k];
      const vr = {};
      for (const k of Object.keys(viaRoute)) vr[k] = viaRoute[k];
      const r = {};
      for (const k of Object.keys(declines)) {
        r[k] = {};
        for (const q of Object.keys(declines[k])) r[k][q] = declines[k][q];
      }
      return { last, draws: d, routes: rt, viaRoute: vr, declines: r };
    },
    /// Did this engine paint anything? The one question every consumer asks.
    drewAny(engine) {
      return (draws[engine] | 0) > 0;
    },
    get unknown() {
      return Object.keys(draws).filter((k) => !KNOWN.has(k));
    },
  };
}

/// The engine a fill VARIANT KEY selects, for the paths that only hold the key — a link failure,
/// a warm decision. Order matters: a CPatch variant is also an LB_FILL variant, and it is CPatch
/// that failed.
export function engineOfVariantKey(key) {
  const defs = key ? key.split('|') : [];
  if (defs.includes('MANTLE_CPATCH')) return ENGINES.CPATCH;
  if (defs.includes('MANTLE_LB_FILL')) return ENGINES.LB;
  return coverKernelOfVariantKey(key, false);
}

/// The kernel that shades a cover quad in the program a fill variant key names. It is the fragment shader's own selection
/// chain (mantle.frag.glsl, after "Per-shape engine bits"), in its order, over whole define names: MANTLE_HARD is a prefix
/// of MANTLE_HARD_MIXED and MANTLE_HARD_TREE, so a substring test answers the wrong question.

/// `inert` is the one answer a key cannot give: a bundle with no fill row runs no fill kernel, whatever the program.
export function coverKernelOfVariantKey(key, inert) {
  if (inert) return ENGINES.INERT;
  const defs = key ? key.split('|') : [];
  const has = (d) => defs.includes(d);

  if (has('MANTLE_HARD_MIXED') || has('MANTLE_COVER_KERNEL'))
    return has('MANTLE_AAC') ? ENGINES.HARD_MIXED_AAC : ENGINES.HARD_MIXED;
  if (has('MANTLE_HARD')) return has('MANTLE_HARD_TREE') ? ENGINES.HARD_TREE : ENGINES.HARD_BAND;
  if (has('MANTLE_GWN')) return ENGINES.GWN;
  if (has('MANTLE_AAC')) return ENGINES.AAC;
  return ENGINES.SLUG;
}

export function isStrokeRow(meta, stride, s) {
  if (!meta || !stride) return false;
  const b = s * stride;
  return meta[b + 11] > 0 && meta[b + 12] > 0; // MT_STROKE.a, MT_STROKE_PARAMS.x
}

///
/// A count here is therefore "draws this engine's geometry appeared in", not "draws this engine
/// owned outright". How MUCH of the picture each one painted is a different question, answered by
/// shape counts (bundle._cpatchBuilt against numShapes), and no per-draw counter can answer it.
///
export function enginesOfUnifiedDraw(bundle, coverKernel, coverFill) {
  // The answer is a function of the bundle's meshes, meta and geometry generation and of the two arguments, and a bundle of N groups
  // asks it once per run of the unified draw (2N times a frame, each a pass over every shape): remembered per bundle under exactly those terms.
  const meshes0 = bundle && (bundle._lbMeshes || bundle._morphMeshes);
  const memo = bundle && bundle._enginesMemo;
  if (
    memo &&
    memo.meshes === meshes0 &&
    memo.nMeshes === (meshes0 ? meshes0.length : 0) &&
    memo.meta === bundle.metaFloats &&
    memo.n === (bundle.numShapes | 0) &&
    memo.gen === (bundle._geomGen | 0) &&
    memo.adopt === (bundle._lbAdoptKey | 0) &&
    memo.ck === coverKernel &&
    memo.cf === coverFill
  )
    return memo.out.slice();
  const out = enginesOfUnifiedDrawCompute(bundle, coverKernel, coverFill);
  if (bundle)
    bundle._enginesMemo = {
      meshes: meshes0,
      nMeshes: meshes0 ? meshes0.length : 0,
      meta: bundle.metaFloats,
      n: bundle.numShapes | 0,
      gen: bundle._geomGen | 0,
      adopt: bundle._lbAdoptKey | 0,
      ck: coverKernel,
      cf: coverFill,
      out,
    };
  return out.slice();
}
function enginesOfUnifiedDrawCompute(bundle, coverKernel, coverFill) {
  const meshes = bundle && (bundle._lbMeshes || bundle._morphMeshes);

  const anyPrim = !!(meshes && meshes.some((m) => m && m.prim));
  const out = [];
  const base = engineOfBundle(bundle);
  // Only if analytic geometry actually drew. engineOfBundle answers "which of the two analytic
  // engines is this", and it answers LB for a bundle carrying no meshes at all -- so a stroke-only
  // or cover-only bundle on this route reported an LB draw that never happened.
  const analytic = (m) =>
    !!(m && !m.slug && ((m.vertexCount | 0) > 0 || (m.segments && m.segments.length)));

  const anyAnalytic = !!(meshes && meshes.some((m) => analytic(m) && !m.prim));
  if (anyAnalytic) out.push(base);
  if (anyPrim) out.push(ENGINES.SDF);

  const meta = bundle && bundle.metaFloats;
  const st = bundle ? bundle.metaFloatsPerShape | 0 : 0;
  const n = bundle ? bundle.numShapes | 0 : 0;
  let anyStroke = false,
    anyCoverFill = false;
  if (meta && st && n) {
    for (let s = 0; s < n; s++) {
      // Isolation brackets have no cover quad and shade no fill kernel.
      if (Math.floor(meta[s * st + 27] + 0.5) & (FS_GROUP_BEGIN | FS_GROUP_END)) continue;
      // Stroke rows are never given a mesh on this route (LB triangles would lose part of the
      // stroke), so a stroke row is always a cover quad and always the stroke path's work.
      if (isStrokeRow(meta, st, s)) {
        anyStroke = true;
        continue;
      }
      const m = meshes ? meshes[s] : null;
      if (!analytic(m)) anyCoverFill = true;
    }
  } else {
    // No meta to classify with: fall back to the mesh list rather than inventing an answer.
    anyCoverFill = !meshes || meshes.some((m) => !m || m.slug || !(m.vertexCount | 0));
  }
  if (coverFill !== undefined) anyCoverFill = !!coverFill;
  if (anyCoverFill && coverKernel && out.indexOf(coverKernel) < 0) out.push(coverKernel);
  if (anyStroke) out.push(ENGINES.STROKE);
  return out;
}

/// The engine a unified-route draw used. The route hosts both, and kind 14 is what separates
/// them: it is the only kind CPatch packs and no ordinary LB mesh carries it.
///
export function engineOfBundle(bundle) {
  const meshes = bundle && (bundle._lbMeshes || bundle._morphMeshes);
  if (meshes) {
    for (const m of meshes) {
      if (!m) continue;
      if (m.segments) {
        for (const sg of m.segments) if (sg && sg.cpatch) return ENGINES.CPATCH;
      } else if (m.cpatch) return ENGINES.CPATCH;
    }
  }
  return ENGINES.LB;
}
