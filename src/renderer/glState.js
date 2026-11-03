// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { resourceGeneration } from './contextResources.js';
// glState.js — shadowed GL pipeline state.

// This module keeps the defensive style — passes still declare the state they
// need, in full — while skipping the call when GL already holds that value.
// The shadow is only trustworthy if every writer goes through here, so:
//
//   - `forget()` marks everything unknown (context loss, external GL use).
//   - `audit()` reads the real state back with getParameter and reports any
//     divergence. It is debug-only (getParameter can flush the pipeline), and
//     `setDiagnostics({ auditGlState: true })` makes every setter self-check,
//     which is how an untracked writer gets found. test/glStateAuditSmoke.mjs
//     drives it across fills, strokes, clips, masks, filters, images, LB,
//     instancing and the static cache.
//
// The shadow belongs to the CONTEXT, not the renderer. Two renderers can share
// one gl (engine-comparison harnesses do exactly that), and GL state is global
// to the context — a per-renderer shadow would have each one believing its own
// last write still stood after the other had overwritten it.
//
// NOT a wrapper around the gl object: monkey-patching the context broke AAC
// under SwiftShader. These are plain functions passes call explicitly.

import { diagFlags, mantleWarn } from '../core/diagnostics.js';
import { glEpoch } from '../core/glEpoch.js';

/** True while glAuditState() is sweeping, regardless of the diag flag. */
let _forceAudit = false;
const auditingNow = () => _forceAudit || diagFlags.auditGlState;

/** Caps tracked by glEnable/glDisable. Anything else falls through untracked. */
const TRACKED_CAPS = ['BLEND', 'DEPTH_TEST', 'STENCIL_TEST', 'SCISSOR_TEST', 'CULL_FACE'];

/** One shadow per WebGL context, shared by every renderer built on it. */
const _byContext = new WeakMap();

/** Create context-owned methods without capturing a renderer. */
function createContextState(gl) {
  const S = /** @type {any} */ ({});
  // undefined = unknown (never set through here, or forgotten).
  /** @type {Map<number, boolean>} */
  const caps = new Map();

  let seenEpoch = glEpoch();
  let depthMask, depthFunc, blendEq;
  let blendS, blendD;
  let cmR, cmG, cmB, cmA;
  let vpX, vpY, vpW, vpH;
  let program, vao;

  // Debug self-check: read the value GL actually holds and complain when it
  // disagrees with the shadow. A mismatch means some code path wrote this
  // state without going through this module — the one way the shadow can lie.
  // Read through diagFlags so setDiagnostics() takes effect mid-run.
  const capNames = new Map();
  for (const name of TRACKED_CAPS) capNames.set(gl[name], name);

  const mismatches = [];
  const warn = (m) => {
    try {
      mantleWarn(m);
    } catch {
      console.warn(m);
    }
  };
  function note(what, want, got) {
    const msg = `[Mantle] glState: ${what} shadow=${JSON.stringify(want)} actual=${JSON.stringify(got)}`;
    mismatches.push(msg);
    warn(msg);
  }
  function checkCap(cap) {
    if (!auditingNow()) return;
    const want = caps.get(cap);
    if (want === undefined) return;
    const got = gl.isEnabled(cap);
    if (got !== want) note(capNames.get(cap) || String(cap), want, got);
  }
  function checkNum(what, want, pname) {
    if (!auditingNow() || want === undefined) return;
    const got = gl.getParameter(pname);
    if (got !== want) note(what, want, got);
  }
  function checkVec(what, want, pname) {
    if (!auditingNow() || want === undefined) return;
    const got = gl.getParameter(pname);
    for (let i = 0; i < want.length; i++) {
      if (got[i] !== want[i]) {
        note(what, want, Array.from(got));
        return;
      }
    }
  }

  function syncEpoch() {
    const e = glEpoch();
    if (e === seenEpoch) return;
    seenEpoch = e;
    S.glForgetState();
  }

  function setCap(cap, on) {
    syncEpoch();
    checkCap(cap);
    if (caps.get(cap) === on) return;
    caps.set(cap, on);
    if (on) gl.enable(cap);
    else gl.disable(cap);
  }

  S.glEnable = (cap) => setCap(cap, true);
  S.glDisable = (cap) => setCap(cap, false);

  S.glDepthMask = (on) => {
    syncEpoch();
    on = !!on;
    checkNum('depthMask', depthMask, gl.DEPTH_WRITEMASK);
    if (depthMask === on) return;
    depthMask = on;
    gl.depthMask(on);
  };

  S.glDepthFunc = (fn) => {
    syncEpoch();
    checkNum('depthFunc', depthFunc, gl.DEPTH_FUNC);
    if (depthFunc === fn) return;
    depthFunc = fn;
    gl.depthFunc(fn);
  };

  S.glBlendFunc = (src, dst) => {
    syncEpoch();
    checkNum('blendSrc', blendS, gl.BLEND_SRC_RGB);
    if (blendS === src && blendD === dst) return;
    blendS = src;
    blendD = dst;
    gl.blendFunc(src, dst);
  };

  S.glBlendEquation = (eq) => {
    syncEpoch();
    checkNum('blendEquation', blendEq, gl.BLEND_EQUATION_RGB);
    if (blendEq === eq) return;
    blendEq = eq;
    gl.blendEquation(eq);
  };

  S.glColorMask = (r, g, b, a) => {
    syncEpoch();
    r = !!r;
    g = !!g;
    b = !!b;
    a = !!a;
    if (auditingNow() && cmR !== undefined)
      checkVec('colorMask', [cmR, cmG, cmB, cmA], gl.COLOR_WRITEMASK);
    if (cmR === r && cmG === g && cmB === b && cmA === a) return;
    cmR = r;
    cmG = g;
    cmB = b;
    cmA = a;
    gl.colorMask(r, g, b, a);
  };

  S.glViewport = (x, y, w, h) => {
    syncEpoch();
    if (auditingNow() && vpX !== undefined) checkVec('viewport', [vpX, vpY, vpW, vpH], gl.VIEWPORT);
    if (vpX === x && vpY === y && vpW === w && vpH === h) return;
    vpX = x;
    vpY = y;
    vpW = w;
    vpH = h;
    gl.viewport(x, y, w, h);
  };

  S.glUseProgram = (p) => {
    syncEpoch();
    checkNum('program', program, gl.CURRENT_PROGRAM);
    if (program === p) return;
    program = p;
    gl.useProgram(p);
  };

  S.glBindVertexArray = (v) => {
    syncEpoch();
    checkNum('vertexArray', vao, gl.VERTEX_ARRAY_BINDING);
    if (vao === v) return;
    vao = v;
    gl.bindVertexArray(v);
  };

  /// Mark every tracked value unknown. Call when something outside this module
  /// may have written pipeline state (context loss, a consumer sharing the
  /// context, a raw gl call in application code).
  S.glForgetState = () => {
    seenEpoch = glEpoch();
    caps.clear();
    depthMask = depthFunc = blendEq = blendS = blendD = undefined;
    cmR = cmG = cmB = cmA = undefined;
    vpX = vpY = vpW = vpH = undefined;
    program = vao = undefined;
  };

  /// WHAT THE SHADOW HOLDS, for a pass that has to write raw GL in the middle of someone else's
  /// state and put it back afterwards (cpatchMorphBuild's deferred coefficient blends run inside
  /// whichever fill span comes first, and that span's caller has already set its scissor, its
  /// target and its tests). Only values the shadow KNOWS are returned -- an unknown one was never
  /// set through here, so there is nothing to restore it to -- and reading them costs no GL query.
  S.glPeek = () => {
    syncEpoch();
    return {
      caps: new Map(caps),
      viewport: vpX === undefined ? null : [vpX, vpY, vpW, vpH],
      program,
      vao,
    };
  };
  /// ...and put it back: every known cap, the viewport, the program and the vertex array, issued
  /// through the setters so the shadow agrees with GL afterwards.
  S.glRestore = (snap) => {
    if (!snap) return;
    for (const [cap, on] of snap.caps) {
      if (on) S.glEnable(cap);
      else S.glDisable(cap);
    }
    if (snap.viewport)
      S.glViewport(snap.viewport[0], snap.viewport[1], snap.viewport[2], snap.viewport[3]);
    if (snap.program !== undefined) S.glUseProgram(snap.program);
    if (snap.vao !== undefined) S.glBindVertexArray(snap.vao);
  };

  /// fillPass registers its active-unit shadow here so one audit covers both.
  /// (The texture-unit shadow itself lives in fillPass, per context.)

  /// Compare the shadow against the driver. Returns [] when they agree.
  /// Debug-only: getParameter can flush the pipeline.
  S.glAuditState = (extraAudit) => {
    const was = _forceAudit;
    _forceAudit = true;
    mismatches.length = 0;
    // Sync FIRST. An external writer (filterGraph, shapeMorph, consumer GL)
    // may have bumped the epoch since the last tracked set, in which case the
    // shadow is already known-stale and comparing it would report divergence
    // the renderer would never have acted on — a false positive that makes the
    // audit untrustworthy exactly when it matters.
    syncEpoch();
    for (const [cap] of caps) checkCap(cap);
    checkNum('depthMask', depthMask, gl.DEPTH_WRITEMASK);
    checkNum('depthFunc', depthFunc, gl.DEPTH_FUNC);
    checkNum('blendSrc', blendS, gl.BLEND_SRC_RGB);
    checkNum('blendEquation', blendEq, gl.BLEND_EQUATION_RGB);
    if (cmR !== undefined) checkVec('colorMask', [cmR, cmG, cmB, cmA], gl.COLOR_WRITEMASK);
    if (vpX !== undefined) checkVec('viewport', [vpX, vpY, vpW, vpH], gl.VIEWPORT);
    checkNum('program', program, gl.CURRENT_PROGRAM);
    checkNum('vertexArray', vao, gl.VERTEX_ARRAY_BINDING);
    if (extraAudit) {
      const extra = extraAudit();
      if (extra)
        for (const m of extra) {
          mismatches.push(m);
          warn(m);
        }
    }
    _forceAudit = was;
    return mismatches.slice();
  };

  // setDiagnostics({ auditGlState: true }) turns every setter into a
  // self-check, so an untracked writer is reported at the next tracked write
  // rather than only at an explicit audit() call.
  return S;
}

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachGlState(R) {
  const gl = R.gl;
  let entry = _byContext.get(gl);
  const generation = resourceGeneration(gl);
  if (!entry || entry.generation !== generation) {
    entry = { generation, shared: createContextState(gl) };
    _byContext.set(gl, entry);
  }
  const shared = entry.shared;
  Object.assign(R, shared);
  // The audit hook belongs to this renderer; only its wrapper captures R.
  // Shared context state must not retain a disposed renderer's object graph.
  R._glStateExtraAudit = null;
  R.glAuditState = () => shared.glAuditState(R._glStateExtraAudit);
}
