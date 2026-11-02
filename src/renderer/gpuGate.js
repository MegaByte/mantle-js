// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Poll GPU and shader completion before issuing queries that can block.
//
// A query that needs the GPU service's answer (a LINK_STATUS read, a uniform location, getShaderParameter, getProgramInfoLog, readPixels) is
// an in-order command: it returns only after every command ahead of it has run. Two kinds of command ahead of it can take seconds on a cold
// driver cache (on Chrome/ANGLE-Metal a real scene's LINK_STATUS reads can sum to tens of seconds, the Metal compiler on many cores):
//   * the program's own link, which KHR_parallel_shader_compile lets the page poll without waiting (COMPLETION_STATUS_KHR);
//   * the first draw of ANY program, which builds its Metal pipeline serially on the GPU thread (a fraction of a second for a lean
//     program, seconds for the all-feature one) and runs ahead of every later command, a query on a finished program included.
// So "the program reports complete" is necessary and not sufficient. The gate adds the second condition: a fence issued after the
// last first-draw has signaled (getSyncParameter polls it without waiting).
//
//   gate.work()           a program was used for the first time (or a warm draw was issued): commands that may take the GPU thread long are queued
//   gate.clear()          non-blocking: has the GPU thread caught up with everything queued so far?
//   gate.ready(p)         non-blocking: the program is complete AND the GPU thread is clear; only then may the page query it
//
// One gate per context (the morph helpers have no renderer, only a gl). Without KHR_parallel_shader_compile there is no way to ask, the
// synchronous path runs as it always did and the gate answers "ready" (README: that fallback blocks). Without fenceSync (a test double) the
// gate answers from completion alone.

import { trackGlResource, deleteGlResource } from './contextResources.js';

const gates = new WeakMap();

/** @param {any} gl */
/** The gate if one exists for this context (never creates one, never touches the context). @param {any} gl */
export function peekGate(gl) {
  return gates.get(gl) || null;
}

/** @param {any} gl */
export function gateFor(gl) {
  let g = gates.get(gl);
  if (g) return g;
  const khr =
    typeof gl.getExtension === 'function' ? gl.getExtension('KHR_parallel_shader_compile') : null;
  const hasFence = typeof gl.fenceSync === 'function' && typeof gl.getSyncParameter === 'function';
  const completeSeen = new WeakSet();
  let dirty = false; // work was queued since the last fence
  let fence = null; // the fence behind it, once one was inserted
  const stats = {
    fences: 0,
    polls: 0,
    workNotes: 0,
    clearAsks: 0,
    busyAsks: 0,
    slowFences: [],
    maxFenceMs: 0,
    fenceMsTotal: 0,
    shedFrames: 0,
    shedPassed: 0,
    slowFenceCount: 0,
    stuckFences: 0,
    relaxed: 0,
    pending: null,
    postReady: [],
    postReadyCount: 0,
    fixedStates: [],
    pipeLog: [],
    pipelinesWithFixed: 0,
    pipelinesNoFixed: 0,
  };
  // WHICH PROGRAMS THE GPU THREAD WAS BUILDING, for the cold-start harnesses: the labels of the programs first used since the previous fence, and how
  // long the thread took to reach the fence after the first of them (observed at a poll, so good to a few ms). A fence over 50 ms is logged.
  const labels = new WeakMap();
  let pendingLabels = [],
    workAt = 0,
    fenceLabels = null,
    lastShedCheck = -1e9,
    lastShed = false,
    shedSince = 0,
    lastTouch = -1e9,
    busySince = 0,
    relaxMs = 1500,
    valveMs = 30000;
  const nowMs = () =>
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  // THE INTERPOSERS the gate needs: the first DRAW of a (program, vertex array, target kind) is when the GPU thread builds a pipeline. A program's first
  // bind is not that moment (a program is bound once to set its sampler units, long before it draws), so the draws themselves are watched; the
  // identity is a cheap stand-in for a Metal pipeline key (program x vertex layout x color format) -- a program drawn into a texture after the canvas
  // builds a second pipeline, and so does a program drawn with another vertex array.
  let armed = false,
    loadReady = false,
    ctxFn = null,
    lastFenceMs = 1e9,
    batched = 0;
  const pipesRef = new WeakMap(); // program -> Set of the pipeline keys drawn (arm() fills it)
  const arm = () => {
    if (armed || !khr || !hasFence || typeof gl.useProgram !== 'function') return;
    armed = true;
    let curProg = null,
      curVao = null,
      curFboNull = true,
      nextLayout = 1;
    // A pipeline's vertex side is a LAYOUT (attribute index, size, type, stride), not a vertex array object: every bundle handle owns a VAO, and
    // keying on the object made each of them a "new pipeline" (4000 fences in a minute of play). The layout of a VAO is accumulated as its pointers are
    // set and interned once.
    const NULL_VAO = {};
    const vaoAttrs = new WeakMap(); // vao -> Map(index -> 'size,type,stride,i?')
    const vaoLayout = new WeakMap(); // vao -> interned layout id (dropped when a pointer changes)
    const layoutIds = new Map(); // layout string -> id
    const pipes = pipesRef; // program -> Set of layoutId * 4 + (target kind) * 2 + (instanced)
    const vaoExtra = new WeakMap(); // vao -> Map(index -> { o: byte offset, n: normalized }): kept beside the layout identity, which ignores both
    const attrNote = (index, size, type, stride, integer, tag, offset, normalized) => {
      const key = curVao === null ? NULL_VAO : curVao;
      let m = vaoAttrs.get(key);
      if (!m) vaoAttrs.set(key, (m = new Map()));
      m.set((tag || '') + index, size + ',' + type + ',' + stride + (integer ? 'i' : ''));
      if (g.recordPipes && !tag) {
        let x = vaoExtra.get(key);
        if (!x) vaoExtra.set(key, (x = new Map()));
        x.set(index, { o: offset | 0, n: !!normalized });
      }
      vaoLayout.delete(key);
    };
    // The current vertex layout as plain data (a manifest records it; warmQueue replays it on a synthetic vertex array): one entry per enabled
    // attribute pointer, with its divisor.
    const layoutDesc = () => {
      const key = curVao === null ? NULL_VAO : curVao,
        m = vaoAttrs.get(key),
        x = vaoExtra.get(key),
        out = [];
      if (!m) return out;
      for (const [k, v] of m) {
        if (k.charAt(0) === 'd') continue;
        const [size, type, rest] = v.split(',');
        const integer = rest.endsWith('i'),
          stride = parseInt(rest, 10),
          e = x && x.get(+k),
          dv = m.get('d' + k);
        out.push({
          i: +k,
          s: +size,
          t: +type,
          st: stride,
          int: integer,
          o: e ? e.o : 0,
          n: e ? e.n : false,
          d: dv ? parseInt(dv.split(',')[2], 10) : 0,
        });
      }
      return out.sort((a, b) => a.i - b.i);
    };
    const layoutOf = () => {
      const key = curVao === null ? NULL_VAO : curVao;
      let id = vaoLayout.get(key);
      if (id !== undefined) return id;
      const m = vaoAttrs.get(key);
      const sig = m
        ? [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).join(';')
        : '';
      id = layoutIds.get(sig);
      if (id === undefined) layoutIds.set(sig, (id = nextLayout++));
      vaoLayout.set(key, id);
      return id;
    };
    // FIXED-FUNCTION STATE that a Metal pipeline is keyed on besides the program and the vertex layout: blend (enable, factors, equations) and the
    // color write mask. Tracked from the calls the renderer makes, interned to a small id; reported as stats.fixedStates / pipelinesWithFixed so the
    // pipeline key space of a real app is measured, not assumed (attachment formats and sample counts are fixed per target kind).
    const blend = { on: false, sc: 1, dc: 0, sa: 1, da: 0, eqc: 0x8006, eqa: 0x8006 };
    let cmask = 15;
    const sigIds = new Map();
    let sigId = 0,
      sigDirty = true;
    const sigOf = () => {
      if (!sigDirty) return sigId;
      const s =
        (blend.on
          ? 'B' +
            blend.sc +
            ',' +
            blend.dc +
            ',' +
            blend.sa +
            ',' +
            blend.da +
            ',' +
            blend.eqc +
            ',' +
            blend.eqa
          : 'b') +
        ' m' +
        cmask;
      let id = sigIds.get(s);
      if (id === undefined) {
        id = sigIds.size;
        sigIds.set(s, id);
        stats.fixedStates[id] = { sig: s, draws: 0 };
      }
      sigId = id;
      sigDirty = false;
      return id;
    };
    const wrapState = (name, make) => {
      if (typeof gl[name] === 'function') gl[name] = make(gl[name].bind(gl));
    };
    wrapState('enable', (o) => (c) => {
      if (c === gl.BLEND) {
        blend.on = true;
        sigDirty = true;
      }
      return o(c);
    });
    wrapState('disable', (o) => (c) => {
      if (c === gl.BLEND) {
        blend.on = false;
        sigDirty = true;
      }
      return o(c);
    });
    wrapState('blendFunc', (o) => (a, b) => {
      blend.sc = blend.sa = a;
      blend.dc = blend.da = b;
      sigDirty = true;
      return o(a, b);
    });
    wrapState('blendFuncSeparate', (o) => (a, b, c, d) => {
      blend.sc = a;
      blend.dc = b;
      blend.sa = c;
      blend.da = d;
      sigDirty = true;
      return o(a, b, c, d);
    });
    wrapState('blendEquation', (o) => (e) => {
      blend.eqc = blend.eqa = e;
      sigDirty = true;
      return o(e);
    });
    wrapState('blendEquationSeparate', (o) => (a, b) => {
      blend.eqc = a;
      blend.eqa = b;
      sigDirty = true;
      return o(a, b);
    });
    wrapState('colorMask', (o) => (r, g, b, a) => {
      cmask = (r ? 1 : 0) | (g ? 2 : 0) | (b ? 4 : 0) | (a ? 8 : 0);
      sigDirty = true;
      return o(r, g, b, a);
    });
    // Programs the renderer did not label (the filter-graph and composite helpers) are named by the hash of their fragment source, so a post-ready
    // build can be traced to a shader file: srcHash(src) in test/tools, or `node -e` over loadShaders().
    const srcOf = new WeakMap(),
      progSrc = new WeakMap();
    wrapState('shaderSource', (o) => (sh, src) => {
      srcOf.set(sh, src);
      return o(sh, src);
    });
    wrapState('attachShader', (o) => (p, sh) => {
      const src = srcOf.get(sh);
      if (src && !/gl_Position/.test(src)) progSrc.set(p, src);
      return o(p, sh);
    });
    const labelOf = (p) => {
      let l = labels.get(p);
      if (l) return l;
      const src = progSrc.get(p);
      if (!src) return '?';
      let h = 2166136261;
      for (let i = 0; i < src.length; i++) h = Math.imul(h ^ src.charCodeAt(i), 16777619);
      l = 'src#' + (h >>> 0).toString(16) + ':' + src.length;
      labels.set(p, l);
      return l;
    };
    const fixedSeen = new WeakMap();
    const note = (instanced) => {
      if (!curProg) return;
      {
        const sid = sigOf();
        let fs = fixedSeen.get(curProg);
        if (!fs) fixedSeen.set(curProg, (fs = new Set()));
        const fk = (layoutOf() * 4 + (curFboNull ? 0 : 2) + (instanced ? 1 : 0)) * 4096 + sid;
        stats.fixedStates[sid].draws++;
        if (!fs.has(fk)) {
          fs.add(fk);
          stats.pipelinesWithFixed++;
          // (a manifest recording: the program, vertex layout, target kind, instancing and fixed-function state of every pipeline the session built)
          if (g.recordPipes && g.pipeRecs.length < 6000)
            g.pipeRecs.push({
              prog: curProg,
              lay: layoutDesc(),
              tex: !curFboNull,
              inst: !!instanced,
              blend: blend.on
                ? [blend.sc, blend.dc, blend.sa, blend.da, blend.eqc, blend.eqa]
                : null,
              cmask,
            });
        }
      }
      let set = pipes.get(curProg);
      const firstOfProgram = !set;
      if (!set) pipes.set(curProg, (set = new Set()));
      const key = layoutOf() * 4 + (curFboNull ? 0 : 2) + (instanced ? 1 : 0);
      if (set.has(key)) return;
      set.add(key);
      stats.pipelinesNoFixed++;
      if (stats.pipeLog.length < 600)
        stats.pipeLog.push([
          nowMs() | 0,
          labelOf(curProg).slice(0, 80),
          layoutOf(),
          curFboNull ? 'canvas' : 'texture',
          instanced ? 1 : 0,
          loadReady ? 1 : 0,
        ]);
      if (!dirty) workAt = nowMs();
      dirty = true;
      stats.workNotes++;
      if (pendingLabels.length < 24) pendingLabels.push(labelOf(curProg));
      // A pipeline first built AFTER the loading call resolved is a first-sight build in play: log what drew it and the draw state that picked it.
      if (loadReady && !firstOfProgram) {
        // a program already drawn once, now with another vertex layout or target kind: these open no gap (no 50 ms fence), so are logged apart
        stats.postReadyCombos = (stats.postReadyCombos | 0) + 1;
      }
      if (loadReady && firstOfProgram) {
        stats.postReadyCount++;
        if (stats.postReady.length < 60) {
          let ctx = null;
          try {
            ctx = ctxFn ? ctxFn() : null;
          } catch {
            /* diagnostic only */
          }
          stats.postReady.push({
            atMs: Math.round(nowMs()),
            program: labelOf(curProg).slice(0, 600),
            layout: layoutOf(),
            target: curFboNull ? 'canvas' : 'texture',
            instanced: !!instanced,
            ctx,
          });
        }
      }
    };
    const useProgram = gl.useProgram.bind(gl);
    gl.useProgram = function (p) {
      curProg = p;
      return useProgram(p);
    };
    if (typeof gl.bindVertexArray === 'function') {
      const bindVertexArray = gl.bindVertexArray.bind(gl);
      gl.bindVertexArray = function (v) {
        curVao = v;
        return bindVertexArray(v);
      };
    }
    if (typeof gl.bindFramebuffer === 'function') {
      const bindFramebuffer = gl.bindFramebuffer.bind(gl);
      gl.bindFramebuffer = function (target, f) {
        if (target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER) curFboNull = !f;
        return bindFramebuffer(target, f);
      };
    }
    // (explicit arity: a rest/spread wrapper would allocate on every draw of every frame)
    const wrapDraw = (name, make) => {
      if (typeof gl[name] === 'function') gl[name] = make(gl[name].bind(gl));
    };
    wrapDraw('drawArrays', (o) => (a, b, c) => {
      note(false);
      return o(a, b, c);
    });
    wrapDraw('drawElements', (o) => (a, b, c, d) => {
      note(false);
      return o(a, b, c, d);
    });
    wrapDraw('drawArraysInstanced', (o) => (a, b, c, d) => {
      note(true);
      return o(a, b, c, d);
    });
    wrapDraw('drawElementsInstanced', (o) => (a, b, c, d, e) => {
      note(true);
      return o(a, b, c, d, e);
    });
    wrapDraw('drawRangeElements', (o) => (a, b, c, d, e, f) => {
      note(false);
      return o(a, b, c, d, e, f);
    });
    if (typeof gl.vertexAttribPointer === 'function') {
      const o = gl.vertexAttribPointer.bind(gl);
      gl.vertexAttribPointer = (index, size, type, normalized, stride, offset) => {
        attrNote(index, size, type, stride, false, '', offset, normalized);
        return o(index, size, type, normalized, stride, offset);
      };
    }
    if (typeof gl.vertexAttribIPointer === 'function') {
      const o = gl.vertexAttribIPointer.bind(gl);
      gl.vertexAttribIPointer = (index, size, type, stride, offset) => {
        attrNote(index, size, type, stride, true, '', offset, false);
        return o(index, size, type, stride, offset);
      };
    }
    if (typeof gl.vertexAttribDivisor === 'function') {
      const o = gl.vertexAttribDivisor.bind(gl);
      gl.vertexAttribDivisor = (index, divisor) => {
        attrNote(index, 0, 0, divisor, false, 'd');
        return o(index, divisor);
      };
    }
  };
  g = {
    khr,
    stats,
    nb: false,
    recordPipes: false,
    pipeRecs: [],
    markLoaded() {
      loadReady = true;
    },
    setContext(fn) {
      ctxFn = fn;
    },
    arm,
    setRelaxMs(ms) {
      relaxMs = ms;
    },
    setValveMs(ms) {
      valveMs = ms;
    },
    /// The LOADING call's form of clear(): while the builds of the last fence were cheap (under 90 ms) up to four more warm draws may join the pending fence,
    /// so a scene of hundreds of small pipelines does not pay a fence round trip (and an idle GPU thread) for each.
    clearBatch() {
      if (g.clear()) {
        batched = 0;
        return true;
      }
      if (lastFenceMs < 90 && batched < 4) {
        batched++;
        return true;
      }
      return false;
    },
    /// Has a draw ever been issued with this program (its pipeline exists, whatever the vertex layout)?
    drawn(prog, tex) {
      if (!prog) return false;
      const set = pipesRef.get(prog);
      if (!set) return false;
      if (tex === undefined) return true;
      for (const k of set) if (((k & 2) !== 0) === tex) return true;
      return false;
    },
    work() {
      if (!dirty) workAt = nowMs();
      dirty = true;
      stats.workNotes++;
    },
    /// An upload of app content (a bundle's textures, an image) is happening now. The loading call starts no pipeline build for a moment after one: an
    /// upload that finds the GPU thread in a build waits for it (hundreds of milliseconds), and the app cannot defer its own.
    touch() {
      lastTouch = nowMs();
    },
    quiet(ms) {
      return nowMs() - lastTouch >= ms;
    },
    /// Name a program for the slow-fence log.
    label(prog, text) {
      if (prog && text) labels.set(prog, String(text).slice(0, 160));
    },
    clear() {
      stats.clearAsks++;
      if (!khr || !hasFence) return true;
      if (!fence && dirty) {
        fence = trackGlResource(gl, gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0));
        stats.fences++;
        dirty = false;
        fenceLabels = pendingLabels;
        pendingLabels = [];
        gl.flush();
      }
      if (!fence) {
        busySince = 0;
        return true;
      }
      stats.polls++;
      // A fence that has not signaled in 30 s is not a pipeline build; whatever is wrong, the app must not wait on it forever (stuckFences counts it).
      if (nowMs() - workAt > valveMs) {
        deleteGlResource(gl, 'Sync', fence);
        fence = null;
        fenceLabels = null;
        stats.stuckFences++;
        busySince = 0;
        if (
          typeof globalThis !== 'undefined' &&
          globalThis.__MANTLE_DEBUG__ === true &&
          typeof console !== 'undefined'
        )
          console.error(
            '[mantle] gpuGate: STUCK FENCE after 30 s (a fence that never signals); the gate stood down',
          );
        return !dirty;
      }
      if (gl.getSyncParameter(fence, gl.SYNC_STATUS) === gl.SIGNALED) {
        deleteGlResource(gl, 'Sync', fence);
        fence = null;
        const ms = nowMs() - workAt;
        lastFenceMs = ms;
        batched = 0;
        stats.fenceMsTotal += ms;
        if (ms > stats.maxFenceMs) stats.maxFenceMs = ms;
        if (ms >= 50) stats.slowFenceCount++;
        if (ms >= 50 && stats.slowFences.length < 80)
          stats.slowFences.push({
            atMs: Math.round(workAt),
            ms: Math.round(ms),
            labels: fenceLabels || [],
          });
        fenceLabels = null;
        busySince = 0;
        return !dirty;
      }
      stats.busyAsks++;
      if (!busySince) busySince = nowMs();
      stats.pending = {
        ageMs: Math.round(nowMs() - workAt),
        labels: (fenceLabels || []).slice(0, 6),
      };
      return false;
    },
    /// BACKPRESSURE. While the GPU thread is deep in a pipeline build, every command the page adds to the queue is a command nobody will run for
    /// a while, and the queue is finite: a bufferData or a texture upload that needs transfer space then WAITS for the build (seconds, with
    /// a dozen pipelines queued). A frame drawn into a backlog also adds nothing anyone can see (the compositor is stuck
    /// behind the same thread). So a frame entry asks whether to SHED the frame: true when work is outstanding for `thresholdMs` or more.
    /// A frame is let through every `maxMs` of continuous shedding, so a fence that never signals cannot freeze the app for good.
    shedFrame(thresholdMs, maxMs) {
      if (!khr || !hasFence) return false;
      const t = nowMs();
      if (t - lastShedCheck < 3) return lastShed;
      lastShedCheck = t;
      if (g.clear()) {
        shedSince = 0;
        return (lastShed = false);
      }
      if (t - workAt < thresholdMs) return (lastShed = false);
      // Frames are shed only while the backlog is plausibly a pipeline build (younger than relaxMs); past that the gate is not trusted to know, and every frame
      // is let through (stats.shedPassed counts them): an app must always be able to submit the frames its first paint is waiting for.
      if (busySince && t - busySince > Math.min(maxMs, relaxMs)) {
        stats.shedPassed++;
        return (lastShed = false);
      }
      stats.shedFrames++;
      return (lastShed = true);
    },
    ready(prog) {
      if (!khr) return true;
      if (!prog) return false;
      // The fence first: a COMPLETION poll is one more command behind a deep pipeline build (it can wait hundreds of ms there), and with the GPU
      // thread behind there is no use asking. A program seen complete stays complete.
      if (!g.clear()) {
        // THE GATE MAY NOT STARVE THE APP. A program is held back while the GPU thread is behind, and a fence is only the proxy for that; if the proxy stays
        // false for `relaxMs` (a fence the driver never signals, a GPU thread wedged on something that is not a build) the draws that need a ready program
        // would be deferred for ever and an app that waits for its first paint would never start. After that, a program that reports COMPLETE is
        // validated anyway (a query that may wait for the GPU thread, counted in stats.relaxed): one correct frame beats a blank screen.
        if (!(busySince && nowMs() - busySince > relaxMs)) return false;
        if (completeSeen.has(prog)) return true;
        if (!gl.getProgramParameter(prog, khr.COMPLETION_STATUS_KHR)) return false;
        completeSeen.add(prog);
        stats.relaxed++;
        if (
          typeof globalThis !== 'undefined' &&
          globalThis.__MANTLE_DEBUG__ === true &&
          stats.relaxed === 1 &&
          typeof console !== 'undefined'
        )
          console.error(
            '[mantle] gpuGate: the GPU fence has not signaled for ' +
              relaxMs +
              ' ms; validating ready programs anyway',
          );
        return true;
      }
      if (completeSeen.has(prog)) return true;
      if (!gl.getProgramParameter(prog, khr.COMPLETION_STATUS_KHR)) return false;
      completeSeen.add(prog);
      return true;
    },
    /// Is the program complete (no fence involved)? A cached answer once true. For pollers that have already established the GPU thread is clear.
    complete(prog) {
      if (!khr) return true;
      if (!prog) return false;
      if (completeSeen.has(prog)) return true;
      if (!gl.getProgramParameter(prog, khr.COMPLETION_STATUS_KHR)) return false;
      completeSeen.add(prog);
      return true;
    },
  };
  gates.set(gl, g);
  return g;
}

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachGpuGate(R) {
  const g = gateFor(R.gl);
  // NON-BLOCKING MODE (`nonBlocking: true`, createMantleScene's default). Off, the renderer behaves as it always did: a draw that needs a program finishes
  // its link on the spot (blocking), the loading calls wait, nothing is shed. The cooperative loading call (precompileFillsAsync) is non-blocking in
  // either mode, for the length of its steps (R._coop).
  const nonBlocking = R.opts.nonBlocking === true;
  if (nonBlocking) {
    g.nb = true;
    g.arm();
  }
  if (R.opts.recordWarmManifest === true) {
    g.recordPipes = true;
    g.arm();
  }
  R._gateArm = () => g.arm();
  R._gateLoaded = () => g.markLoaded();
  g.setContext(() => {
    const d = R.draw,
      wm = d && d.worldM;
    const vp = R.viewportSize ? R.viewportSize() : null;
    return {
      window: !!R._warmWindow || !!R._inferSlice,
      viewport: vp ? [vp[0], vp[1]] : null,
      variant: String(R._lastDrawnFillVariantKey || '').slice(0, 120),
      route: R._unifiedFillGate || null,
      rotated: !!(wm && (wm[1] !== 0 || wm[3] !== 0)),
      recolor: !!(d && (d.colorMatrix || d.palette || d.channelLerp)),
      overrides: !!(d && d.overrides),
    };
  });
  if (R.opts.gpuRelaxMs != null) g.setRelaxMs(+R.opts.gpuRelaxMs);
  if (R.opts.gpuFenceValveMs != null) g.setValveMs(+R.opts.gpuFenceValveMs); // (the absolute backstop; a test or a real-flow proof sets it huge to show it is never used)
  R._gateQuiet = (ms) => g.quiet(ms);
  R._nonBlocking = () => nonBlocking;
  R._nbNow = () => nonBlocking || R._coop === true;
  R._gateStats = g.stats;
  R._gatePipeRecords = (on) => {
    if (on !== undefined) g.recordPipes = !!on;
    return g.pipeRecs;
  };
  R._gateDrawn = (prog, tex) => g.drawn(prog, tex);
  R._gpuClear = () => g.clear();
  R._gpuClearBatch = () => g.clearBatch();
  R._programReady = (prog) => g.ready(prog);
  R._gpuLabel = (prog, text) => g.label(prog, text);
  R._progDrawn = (prog, tex) => g.drawn(prog, tex);
  R._gpuShedFrame = () =>
    g.shedFrame(
      R.opts.gpuShedMs != null ? R.opts.gpuShedMs : nonBlocking ? 40 : Infinity,
      R.opts.gpuShedMaxMs != null ? R.opts.gpuShedMaxMs : 2500,
    );
  /// A fence is in flight (or work is queued that has none yet): the loading call waits on this, off the main thread.
  R._gpuBusy = () => !g.clear();
}
