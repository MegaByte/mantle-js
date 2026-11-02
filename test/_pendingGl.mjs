// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _pendingGl.mjs -- the recording WebGL stand-in (_fakeGl.mjs) with a DRIVER MODEL, for the zero-blocking guard smokes.
//
// What the real stack does, as far as the main thread can feel it (as measured in Chrome/ANGLE-Metal):
//   * linkProgram returns at once; the program is COMPLETE (COMPLETION_STATUS_KHR) some tens of ms later, in parallel;
//   * the first DRAW with a program builds its Metal pipeline serially on the GPU thread (0.1-0.3 s lean, ~10 s the all-feature program);
//   * every main-thread query that needs the service's answer (a LINK_STATUS read, a uniform location, readPixels) is an in-order command: it waits
//     for the link, and for every draw ahead of it, to finish;
//   * a fence (fenceSync) signals when the GPU thread reaches it, and getSyncParameter / clientWaitSync(.., 0) poll it without waiting.
// The model keeps a virtual clock (real elapsed time plus the time the page would have been frozen) so a "wait" costs nothing to run but is
// counted and timed. Each wait is recorded in `waits` independently of src/renderer/glGuard.js, so the two records can be compared.

import { createFakeGl } from './_fakeGl.mjs';

const COMPLETION = 0x91b1;

/**
 * @param {{ width?: number, height?: number, linkMs?: number, pipelineMs?: number, hold?: boolean, khr?: boolean }} [o]
 *   linkMs     how long a link takes to complete (parallel, off the GPU thread)
 *   pipelineMs the GPU-thread cost of a program's first draw
 *   hold       links never complete until release() (a driver deep in a compile)
 *   khr        expose KHR_parallel_shader_compile (default true)
 */
export function createPendingGl(o = {}) {
  const F = createFakeGl({ width: o.width || 128, height: o.height || 128 });
  const gl = F.gl;
  const linkMs = o.linkMs != null ? o.linkMs : 40,
    pipelineMs = o.pipelineMs != null ? o.pipelineMs : 300;
  const t0 = performance.now();
  let skew = 0;
  const vt = () => performance.now() - t0 + skew;
  const M = {
    hold: !!o.hold,
    gpuFree: 0,
    progs: new Map(),
    drawn: new Set(),
    shaderOwners: new Map(),
    cur: null,
    waits: [],
    stalledMs: 0,
    links: 0,
    pipelines: 0,
    fences: 0,
    draws: 0,
  };
  const stall = (to, kind, name) => {
    const d = Math.max(0, to - vt());
    skew += d;
    M.stalledMs += d;
    M.waits.push({
      kind,
      name,
      ms: d,
      stack: new Error().stack
        .split('\n')
        .slice(3, 14)
        .map((l) =>
          l
            .trim()
            .replace(/^at /, '')
            .replace(/\(?file:.*\/src\//, '('),
        )
        .join(' < '),
    });
  };
  const linkReadyAt = (p) => {
    const r = M.progs.get(p);
    return r ? r.readyAt : 0;
  };
  const complete = (p) => {
    if (!M.progs.has(p)) return true;
    const r = M.progs.get(p);
    return r.readyAt <= vt();
  };
  /// A query that needs the service's answer about program `p`.
  const syncQuery = (p, name) => {
    if (p && M.progs.has(p)) {
      if (!complete(p)) {
        const r = M.progs.get(p);
        if (r.readyAt === Infinity) r.readyAt = vt() + linkMs; // a held link finishes only because something forced it
        stall(r.readyAt, 'link', name);
      }
    }
    if (vt() < M.gpuFree) stall(M.gpuFree, 'behind-build', name);
  };
  // a framebuffer-status query is a synchronous round trip to the GPU process: it waits behind a build in flight
  gl.checkFramebufferStatus = (
    (orig) =>
    (...a) => {
      syncQuery(null, 'checkFramebufferStatus');
      return orig(...a);
    }
  )(gl.checkFramebufferStatus);
  gl.getExtension = (n) =>
    o.khr === false
      ? null
      : n === 'KHR_parallel_shader_compile'
        ? { COMPLETION_STATUS_KHR: COMPLETION }
        : null;
  gl.linkProgram = (p) => {
    M.links++;
    M.progs.set(p, { readyAt: M.hold ? Infinity : vt() + linkMs });
  };
  gl.attachShader = ((orig) => (p, sh) => {
    let s = M.shaderOwners.get(sh);
    if (!s) M.shaderOwners.set(sh, (s = new Set()));
    s.add(p);
    return orig(p, sh);
  })(gl.attachShader);
  gl.getProgramParameter = (p, pname) => {
    if (pname === COMPLETION) return o.khr === false ? true : complete(p);
    syncQuery(p, 'getProgramParameter');
    return true;
  };
  for (const name of [
    'getProgramInfoLog',
    'getUniformLocation',
    'getAttribLocation',
    'getActiveUniform',
    'getUniformBlockIndex',
  ]) {
    const orig = gl[name];
    gl[name] = (p, ...rest) => {
      syncQuery(p, name);
      return orig(p, ...rest);
    };
  }
  for (const name of ['getShaderParameter', 'getShaderInfoLog']) {
    gl[name] = (sh) => {
      const owners = M.shaderOwners.get(sh);
      if (owners) for (const p of owners) syncQuery(p, name);
      return name === 'getShaderInfoLog' ? '' : true;
    };
  }
  gl.useProgram = ((orig) => (p) => {
    M.cur = p;
    return orig(p);
  })(gl.useProgram);
  for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced']) {
    const orig = gl[name];
    gl[name] = (...a) => {
      M.draws++;
      const p = M.cur;
      if (p && M.progs.has(p)) {
        if (!complete(p)) {
          const r = M.progs.get(p);
          if (r.readyAt === Infinity) r.readyAt = vt() + linkMs;
          stall(r.readyAt, 'draw-on-link', name);
        }
        if (!M.drawn.has(p)) {
          M.drawn.add(p);
          M.pipelines++;
          M.gpuFree = Math.max(M.gpuFree, vt()) + pipelineMs;
        }
      }
      return orig(...a);
    };
  }
  // fenceMode: 'normal' | 'never' (the fence is never signaled) | 'flush' (signaled only once a flush has followed its creation, and the GPU is through it)
  gl.fenceSync = () => {
    M.fences++;
    const f = { fence: true, at: Math.max(M.gpuFree, vt()), flushed: false };
    (M.fenceList ||= []).push(f);
    return f;
  };
  M.lastFence = null;
  gl.getSyncParameter = (s, pname) => {
    if (pname === gl.SYNC_STATUS) {
      if (o.fenceMode === 'never') return gl.UNSIGNALED;
      if (o.fenceMode === 'flush' && !s.flushed) return gl.UNSIGNALED;
      return vt() >= s.at ? gl.SIGNALED : gl.UNSIGNALED;
    }
    return 0;
  };
  gl.clientWaitSync = (s, _flags, timeout) => {
    if (vt() >= s.at) return gl.ALREADY_SIGNALED;
    if (!timeout) return gl.TIMEOUT_EXPIRED;
    stall(s.at, 'clientWaitSync', 'clientWaitSync');
    return gl.CONDITION_SATISFIED;
  };
  gl.deleteSync = () => {};
  gl.flush = () => {
    M.flushes = (M.flushes | 0) + 1;
    for (const f of M.fenceList || []) f.flushed = true;
  };
  // A big upload needs transfer space that the GPU thread frees as it consumes commands: while it is deep in a pipeline build the upload waits for it.
  for (const name of ['bufferData', 'texSubImage2D', 'texImage2D']) {
    const orig = gl[name];
    gl[name] = (...a) => {
      M.uploads = (M.uploads | 0) + 1;
      if (name === 'texImage2D') M.texAllocs = (M.texAllocs | 0) + 1;
      const data = a.find((x) => x && typeof x === 'object' && x.byteLength !== undefined);
      if (data && data.byteLength >= 16384 && vt() < M.gpuFree - 50)
        stall(M.gpuFree, 'upload-behind-build', name);
      return orig(...a);
    };
  }
  gl.readPixels = (...a) => {
    if (vt() < M.gpuFree) stall(M.gpuFree, 'behind-build', 'readPixels');
    const buf = a[6];
    if (buf && buf.fill) buf.fill(0);
  };
  return {
    F,
    gl,
    model: M,
    vt,
    /// The links the driver has been holding finish now.
    release() {
      M.hold = false;
      for (const r of M.progs.values()) if (r.readyAt === Infinity) r.readyAt = vt();
    },
    hold() {
      M.hold = true;
    },
    /// Let `ms` of wall time pass for the model (a test that awaits a timer needs nothing; this is for a synchronous drive).
    advance(ms) {
      skew += ms;
    },
    /// Are all links complete and the GPU thread idle?
    idle() {
      for (const p of M.progs.keys()) if (!complete(p)) return false;
      return vt() >= M.gpuFree;
    },
    progCount: () => M.progs.size,
    waitsOf(kind) {
      return M.waits.filter((w) => !kind || w.kind === kind);
    },
    resetWaits() {
      M.waits.length = 0;
      M.stalledMs = 0;
    },
  };
}
