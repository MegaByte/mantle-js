// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// glGuard.js -- the enforcement half of the zero-blocking invariant.
//
// THE INVARIANT. After createRenderer returns, no call into WebGL may block the main thread on the driver: not at load, not at first draw, not
// in play. The calls that do are the ones that need the answer of a shader compile or link the GPU process has not finished:
//   * a query on a program whose COMPLETION_STATUS_KHR is still false (getProgramParameter LINK_STATUS, getProgramInfoLog, getUniformLocation,
//     getAttribLocation, getActiveUniform, getUniformBlockIndex, ...) or on a shader attached to one (getShaderParameter, getShaderInfoLog);
//   * a draw with a program that is still linking (the driver finishes the link, then builds the pipeline, before the call returns);
//   * a read that waits on the GPU thread while it builds a pipeline (any call that comes out slow).
// The first two are detected exactly (the program's completion status is asked, which never blocks). The third is detected by time.
//
// INSTALL. `installGlGuard(gl, opts)` shadows the context's methods with counting wrappers (own properties of `gl`, so a real
// WebGL2RenderingContext keeps its prototype untouched) and returns the ledger. createRenderer installs it when
// `opts.glGuard === true` or `globalThis.__MANTLE_GL_GUARD__ === true`; `renderer.debugStats.blockingLinkWaits` then counts the first two.
// Without KHR_parallel_shader_compile nothing can be non-blocking (the extension is the only way to ask a program whether it is done), so
// the guard counts nothing for programs there and createRenderer keeps its synchronous path; that is the documented fallback.
//
// The guard asks `getProgramParameter(p, COMPLETION_STATUS_KHR)` through the context's ORIGINAL method, so its own check is not counted.

/** Program-side queries that need the link to be finished. */
const PROGRAM_QUERIES = new Set([
  'getProgramInfoLog',
  'getUniformLocation',
  'getAttribLocation',
  'getActiveUniform',
  'getActiveAttrib',
  'getUniformBlockIndex',
  'getActiveUniformBlockParameter',
  'getActiveUniformBlockName',
  'getActiveUniforms',
  'getFragDataLocation',
  'getTransformFeedbackVarying',
  'getUniform',
  'getAttachedShaders',
  'validateProgram',
]);
const SHADER_QUERIES = new Set([
  'getShaderParameter',
  'getShaderInfoLog',
  'getShaderSource',
  'getTranslatedShaderSource',
]);
const DRAWS = new Set([
  'drawArrays',
  'drawElements',
  'drawArraysInstanced',
  'drawElementsInstanced',
  'drawRangeElements',
]);

const COMPLETION_STATUS_KHR = 0x91b1;

function nowMs() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

/**
 * @param {any} gl
 * @param {{ slowMs?: number, maxSlow?: number, onViolation?: (v: object) => void }} [opts]
 * @returns {{ stats: GlGuardStats, uninstall: () => void, installed: boolean, markFresh: () => void }}
 *
 * @typedef {object} GlGuardStats
 * @property {number} blockingLinkWaits   queries on a program (or a shader of one) that was still linking, plus draws with such a program
 * @property {number} blockingQueryWaits  ...of which program/shader queries
 * @property {number} blockingDrawWaits   ...of which draws
 * @property {number} slowCalls           calls that took at least slowMs
 * @property {number} maxCallMs           the slowest call seen
 * @property {string} maxCallName
 * @property {Array<{name: string, ms: number, atMs: number, stack: string}>} slow  the slowest calls, with their stacks (capped)
 * @property {Array<{name: string, pname?: number, atMs: number, stack: string}>} violations  the first blocking-wait sites (capped)
 */
const guards = new WeakMap();
export function installGlGuard(gl, opts = {}) {
  const had = guards.get(gl);
  if (had) return had;
  const slowMs = opts.slowMs != null ? opts.slowMs : 20;
  const cap = opts.maxSlow != null ? opts.maxSlow : 200;
  const stats = {
    blockingLinkWaits: 0,
    blockingQueryWaits: 0,
    blockingDrawWaits: 0,
    slowCalls: 0,
    maxCallMs: 0,
    maxCallName: '',
    slow: [],
    violations: [],
  };
  const orig = new Map();
  const wrap = (name, make) => {
    const fn = gl[name];
    if (typeof fn !== 'function') return;
    orig.set(name, { had: Object.prototype.hasOwnProperty.call(gl, name), value: gl[name] });
    gl[name] = make(fn.bind(gl));
  };
  const khr =
    typeof gl.getExtension === 'function' ? gl.getExtension('KHR_parallel_shader_compile') : null;
  const COMPLETE = khr ? khr.COMPLETION_STATUS_KHR : COMPLETION_STATUS_KHR;
  const rawGetProgramParameter = gl.getProgramParameter.bind(gl);
  const shaderOwners = new Map(); // shader -> Set(program)
  let current = null;
  const stack = () => {
    try {
      return new Error().stack
        .split('\n')
        .slice(1)
        .filter((l) => !l.includes('glGuard.js'))
        .slice(0, 8)
        .map((l) => l.trim().replace(/^at /, ''))
        .join(' <- ');
    } catch {
      return '';
    }
  };
  // A program seen complete stays complete, so the steady state asks nothing: every poll is one more command behind whatever the GPU thread is building.
  const completeSeen = new WeakSet();
  const linking = (p) => {
    if (!khr || !p || completeSeen.has(p)) return false;
    if (rawGetProgramParameter(p, COMPLETE) === false) return true;
    completeSeen.add(p);
    return false;
  };
  const violate = (kind, name, pname) => {
    stats.blockingLinkWaits++;
    if (kind === 'draw') stats.blockingDrawWaits++;
    else stats.blockingQueryWaits++;
    if (stats.violations.length < cap)
      stats.violations.push({ name, pname, atMs: nowMs(), stack: stack() });
    if (opts.onViolation) opts.onViolation({ kind, name, pname });
  };
  const timed = (name, fn, a, self) => {
    const t = nowMs();
    try {
      return fn.apply(self, a);
    } finally {
      const ms = nowMs() - t;
      if (ms > stats.maxCallMs) {
        stats.maxCallMs = ms;
        stats.maxCallName = name;
      }
      if (ms >= slowMs) {
        stats.slowCalls++;
        if (stats.slow.length < cap) stats.slow.push({ name, ms, atMs: t, stack: stack() });
      }
    }
  };
  wrap(
    'attachShader',
    (fn) =>
      function (p, sh) {
        let s = shaderOwners.get(sh);
        if (!s) shaderOwners.set(sh, (s = new Set()));
        s.add(p);
        return timed('attachShader', fn, [p, sh], this);
      },
  );
  wrap(
    'useProgram',
    (fn) =>
      function (p) {
        current = p;
        return timed('useProgram', fn, [p], this);
      },
  );
  wrap(
    'getProgramParameter',
    (fn) =>
      function (p, pname) {
        if (pname !== COMPLETE && linking(p)) violate('query', 'getProgramParameter', pname);
        return timed('getProgramParameter', fn, [p, pname], this);
      },
  );
  for (const name of PROGRAM_QUERIES)
    wrap(
      name,
      (fn) =>
        function (p, ...rest) {
          if (linking(p)) violate('query', name);
          return timed(name, fn, [p, ...rest], this);
        },
    );
  for (const name of SHADER_QUERIES)
    wrap(
      name,
      (fn) =>
        function (sh, ...rest) {
          const owners = shaderOwners.get(sh);
          if (owners)
            for (const p of owners)
              if (linking(p)) {
                violate('query', name);
                break;
              }
          return timed(name, fn, [sh, ...rest], this);
        },
    );
  // (`checkDraws: false` skips the per-draw ask: a draw with a program still linking waits for the link, which the slow-call ledger shows by time.)
  const checkDraws = opts.checkDraws !== false;
  for (const name of DRAWS)
    wrap(
      name,
      (fn) =>
        function (...a) {
          if (checkDraws && linking(current)) violate('draw', name);
          return timed(name, fn, a, this);
        },
    );
  // Everything else that can wait on the GPU thread is caught by time alone.
  for (const name of [
    'linkProgram',
    'compileShader',
    'readPixels',
    'getParameter',
    'getError',
    'finish',
    'clientWaitSync',
    'getSyncParameter',
    'getQueryParameter',
    'fenceSync',
    'flush',
    'getBufferSubData',
    'checkFramebufferStatus',
    'createProgram',
    'createShader',
    'bufferData',
    'texImage2D',
    'texSubImage2D',
    'texImage3D',
    'texSubImage3D',
  ]) {
    wrap(
      name,
      (fn) =>
        function (...a) {
          return timed(name, fn, a, this);
        },
    );
  }
  const guard = {
    stats,
    installed: true,
    markFresh() {
      stats.blockingLinkWaits = 0;
      stats.blockingQueryWaits = 0;
      stats.blockingDrawWaits = 0;
      stats.slowCalls = 0;
      stats.maxCallMs = 0;
      stats.maxCallName = '';
      stats.slow.length = 0;
      stats.violations.length = 0;
    },
    uninstall() {
      for (const [name, o] of orig) {
        if (o.had) gl[name] = o.value;
        else delete gl[name];
      }
      orig.clear();
      guards.delete(gl);
    },
  };
  guards.set(gl, guard);
  return guard;
}
