// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _fakeGl.mjs — a WebGL2 stand-in that RECORDS what the renderer asks the GPU to do.
//
// createRenderer, createBundle and the whole draw path run headless against it: every program
// "compiles", every framebuffer is complete, and nothing is ever rasterized. What it keeps is the
// DATAFLOW -- which framebuffer each clear and draw landed in, which texture each copy wrote, which
// textures a draw had bound, the scissor it ran under -- so a node test can assert things like "no copy in this frame" or
// "this texture was not written between these two draws" against the real renderer code, not a
// restatement of it. It cannot say anything about pixels; the render lane does that.
//
// Programs are named by the shader keys they were linked from: each source is tagged with a
// `// @@key` marker (see `taggedShaderSources`), so `progKeys(prog)` says which program drew.

// The constants that code does ARITHMETIC on (TEXTURE0 + unit) or compares across calls need
// their real values; everything else gets a unique number from a range no real enum uses.
const REAL = {
  TEXTURE0: 0x84c0,
  TEXTURE_2D: 0x0de1,
  TEXTURE_2D_ARRAY: 0x8c1a,
  FRAMEBUFFER: 0x8d40,
  READ_FRAMEBUFFER: 0x8ca8,
  DRAW_FRAMEBUFFER: 0x8ca9,
  COLOR_ATTACHMENT0: 0x8ce0,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  COLOR_BUFFER_BIT: 0x4000,
  DEPTH_BUFFER_BIT: 0x0100,
  STENCIL_BUFFER_BIT: 0x0400,
  SCISSOR_TEST: 0x0c11,
  DEPTH_STENCIL_ATTACHMENT: 0x821a,
  NO_ERROR: 0,
};
for (let i = 1; i < 32; i++) REAL['TEXTURE' + i] = REAL.TEXTURE0 + i;

/// A shader-source dict for createRenderer whose every entry is an empty shader tagged with its key.
export function taggedShaderSources() {
  return new Proxy(
    {},
    {
      get: (_t, k) => (typeof k === 'string' ? `// @@${k}\nvoid main() {}\n` : undefined),
      has: () => true,
    },
  );
}

/// `hideUniforms`: uniform names every program reports as absent (getUniformLocation -> null), as a
/// program linked without the define that declares them does -- how a test makes the unified route
/// bail ('no-curvetex-uniform') on demand.
export function createFakeGl({ width = 128, height = 128, hideUniforms = [] } = {}) {
  const hidden = new Set(hideUniforms);
  const consts = new Map(Object.entries(REAL));
  let nextConst = 0x40000;
  let nextId = 1;
  const S = {
    unit: 0,
    bound: new Map(), // 'tex:<target>:<unit>' | 'buf:<target>' | 'rb:<target>' -> the object last bound there
    tex: new Map(), // unit -> bound TEXTURE_2D
    drawFbo: null,
    readFbo: null,
    program: null,
    prog: new Map(), // program -> Set of shader keys
    shaderKey: new Map(), // shader -> key
    attach: new Map(), // fbo -> color attachment texture
    rbAttach: new Map(), // fbo -> Set of renderbuffer attachment points (depth / stencil)
    frame: 0,
    scissorOn: false, // SCISSOR_TEST, as the renderer last set it through gl.enable/disable
    scissor: [0, 0, width, height],
    blendOn: false, // BLEND, and the blend function a draw ran under (enum names)
    blendSrc: 'ONE',
    blendDst: 'ZERO',
    uni: new Map(), // program -> Map(uniform name -> the last value set on it)
    vp: [0, 0, width, height],
  };
  const enumName = (v) => {
    for (const [k, n] of consts) if (n === v) return k;
    return String(v);
  };
  // The blend a draw ran under: null when BLEND was off, else [src, dst] as enum names.
  const blendNow = () => (S.blendOn ? [S.blendSrc, S.blendDst] : null);
  // The uniforms the bound program holds right now, by name (values as last set, arrays copied).
  const uniNow = () => Object.fromEntries(S.uni.get(S.program) || []);
  const setUni = (loc, v) => {
    if (!loc || !S.program) return;
    if (!S.uni.has(S.program)) S.uni.set(S.program, new Map());
    S.uni.get(S.program).set(loc.uniform, v);
  };
  // The scissor a clear, draw or blit ran under: null when the test was off, else [x, y, w, h].
  const sc = () => (S.scissorOn ? S.scissor.slice() : null);
  const log = [];
  // A CANVAS THAT FIRES CONTEXT EVENTS, so the renderer registers its loss / restore listeners
  // (it only does for a canvas with addEventListener). loseContext / restoreContext below drive
  // them; everything created before a restore belongs to the lost context (isDead).
  const listeners = new Map();
  const canvas = {
    width,
    height,
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      if (listeners.has(type)) listeners.get(type).delete(fn);
    },
  };
  const fire = (type) => {
    const ev = {
      type,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    for (const fn of listeners.get(type) || []) fn(ev);
    return ev;
  };
  let deadBelow = 0; // objects with id < this were created by a context that has been lost
  const texOnUnits = () => {
    const out = [];
    for (const [u, t] of S.tex) if (t) out[u] = t;
    return out;
  };
  const impl = {
    createTexture: () => ({ id: nextId++, kind: 'tex' }),
    createFramebuffer: () => ({ id: nextId++, kind: 'fbo' }),
    createRenderbuffer: () => ({ id: nextId++, kind: 'rb' }),
    createBuffer: () => ({ id: nextId++, kind: 'buf' }),
    createVertexArray: () => ({ id: nextId++, kind: 'vao' }),
    createProgram: () => {
      const p = { id: nextId++, kind: 'prog' };
      S.prog.set(p, new Set());
      return p;
    },
    createShader: (type) => ({ id: nextId++, kind: 'shader', type }),
    createQuery: () => ({ id: nextId++, kind: 'query' }),
    createSampler: () => ({ id: nextId++, kind: 'sampler' }),
    shaderSource: (sh, src) => {
      const m = /\/\/ @@(\w+)/.exec(String(src));
      if (m) S.shaderKey.set(sh, m[1]);
    },
    attachShader: (p, sh) => {
      const k = S.shaderKey.get(sh);
      if (k && S.prog.has(p)) S.prog.get(p).add(k);
    },
    useProgram: (p) => {
      S.program = p;
    },
    activeTexture: (u) => {
      S.unit = u - REAL.TEXTURE0;
    },
    bindTexture: (target, t) => {
      if (target === REAL.TEXTURE_2D) S.tex.set(S.unit, t);
      S.bound.set('tex:' + target + ':' + S.unit, t);
    },
    bindRenderbuffer: (target, rb) => {
      S.bound.set('rb:' + target, rb);
    },
    bindFramebuffer: (target, f) => {
      if (target === REAL.FRAMEBUFFER) {
        S.drawFbo = f;
        S.readFbo = f;
      } else if (target === REAL.DRAW_FRAMEBUFFER) S.drawFbo = f;
      else if (target === REAL.READ_FRAMEBUFFER) S.readFbo = f;
    },
    framebufferRenderbuffer: (target, att, _rbt, rb) => {
      const f = target === REAL.READ_FRAMEBUFFER ? S.readFbo : S.drawFbo;
      if (!f) return;
      if (!S.rbAttach.has(f)) S.rbAttach.set(f, new Set());
      if (rb) S.rbAttach.get(f).add(att);
      else S.rbAttach.get(f).delete(att);
    },
    framebufferTexture2D: (target, att, _tt, t) => {
      const f = target === REAL.READ_FRAMEBUFFER ? S.readFbo : S.drawFbo;
      if (att === REAL.COLOR_ATTACHMENT0 && f) S.attach.set(f, t);
    },
    copyTexSubImage2D: (...a) => {
      log.push({
        op: 'copy',
        frame: S.frame,
        dst: S.tex.get(S.unit) || null,
        src: S.readFbo,
        args: a.slice(2),
      });
    },
    copyTexImage2D: (...a) => {
      log.push({
        op: 'copy',
        frame: S.frame,
        dst: S.tex.get(S.unit) || null,
        src: S.readFbo,
        args: a.slice(2),
      });
    },
    blitFramebuffer: (...a) => {
      log.push({ op: 'blit', frame: S.frame, src: S.readFbo, dst: S.drawFbo, args: a, sc: sc() });
    },
    clear: (mask) => {
      log.push({ op: 'clear', frame: S.frame, fbo: S.drawFbo, mask, sc: sc() });
    },
    drawArrays: (mode, first, count) => {
      log.push({
        op: 'draw',
        frame: S.frame,
        fbo: S.drawFbo,
        prog: S.program,
        units: texOnUnits(),
        count,
        sc: sc(),
        blend: blendNow(),
        uni: uniNow(),
        vp: S.vp.slice(),
      });
    },
    drawElements: (mode, count) => {
      log.push({
        op: 'draw',
        frame: S.frame,
        fbo: S.drawFbo,
        prog: S.program,
        units: texOnUnits(),
        count,
        sc: sc(),
        blend: blendNow(),
        uni: uniNow(),
        vp: S.vp.slice(),
      });
    },
    drawArraysInstanced: (mode, first, count, n) => {
      log.push({
        op: 'draw',
        frame: S.frame,
        fbo: S.drawFbo,
        prog: S.program,
        units: texOnUnits(),
        count: count * n,
        sc: sc(),
        blend: blendNow(),
        uni: uniNow(),
        vp: S.vp.slice(),
        instances: n,
        // the bytes of the array buffer bound now (the per-instance attributes of an instanced composite)
        instData:
          S.arrayBuf && S.arrayBuf.data
            ? new Float32Array(
                S.arrayBuf.data.buffer.slice(
                  S.arrayBuf.data.byteOffset,
                  S.arrayBuf.data.byteOffset + S.arrayBuf.data.byteLength,
                ),
              )
            : null,
      });
    },
    bindBuffer: (target, b) => {
      S.bound.set('buf:' + target, b);
      if (target === consts.get('ARRAY_BUFFER')) S.arrayBuf = b;
    },
    bufferData: (target, data, usage, srcOffset = 0, length = 0) => {
      if (target !== consts.get('ARRAY_BUFFER') || !S.arrayBuf) return;
      if (ArrayBuffer.isView(data)) {
        const bpe = data.BYTES_PER_ELEMENT || 1;
        const offset = data.byteOffset + srcOffset * bpe;
        const bytes = length ? length * bpe : data.byteLength - srcOffset * bpe;
        const copy = data.buffer.slice(offset, offset + bytes);
        S.arrayBuf.data =
          data instanceof Float32Array ? new Float32Array(copy) : new Uint8Array(copy);
      } else S.arrayBuf.data = new Uint8Array(data | 0);
    },
    bufferSubData: (target, off, data) => {
      if (
        target !== consts.get('ARRAY_BUFFER') ||
        !S.arrayBuf ||
        !S.arrayBuf.data ||
        !ArrayBuffer.isView(data)
      )
        return;
      const dst = new Uint8Array(
        S.arrayBuf.data.buffer,
        S.arrayBuf.data.byteOffset,
        S.arrayBuf.data.byteLength,
      );
      dst.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), off);
    },
    enable: (cap) => {
      if (cap === REAL.SCISSOR_TEST) S.scissorOn = true;
      else if (cap === consts.get('BLEND')) S.blendOn = true;
    },
    disable: (cap) => {
      if (cap === REAL.SCISSOR_TEST) S.scissorOn = false;
      else if (cap === consts.get('BLEND')) S.blendOn = false;
    },
    viewport: (x, y, w, h) => {
      S.vp = [x, y, w, h];
    },
    blendFunc: (s, d) => {
      S.blendSrc = enumName(s);
      S.blendDst = enumName(d);
    },
    blendFuncSeparate: (s, d) => {
      S.blendSrc = enumName(s);
      S.blendDst = enumName(d);
    },
    uniform1f: (l, x) => setUni(l, x),
    uniform1i: (l, x) => setUni(l, x),
    uniform2f: (l, x, y) => setUni(l, [x, y]),
    uniform3f: (l, x, y, z) => setUni(l, [x, y, z]),
    uniform4f: (l, x, y, z, w) => setUni(l, [x, y, z, w]),
    uniform1fv: (l, v) => setUni(l, Array.from(v)),
    uniform2fv: (l, v) => setUni(l, Array.from(v)),
    uniform3fv: (l, v) => setUni(l, Array.from(v)),
    uniform4fv: (l, v) => setUni(l, Array.from(v)),
    uniform1iv: (l, v) => setUni(l, Array.from(v)),
    scissor: (x, y, w, h) => {
      S.scissor = [x, y, w, h];
    },
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: (_p, name) => (hidden.has(name) ? null : { uniform: name }),
    getAttribLocation: () => 0,
    getUniformBlockIndex: () => 0,
    checkFramebufferStatus: () => REAL.FRAMEBUFFER_COMPLETE,
    getError: () => 0,
    getExtension: () => null,
    getSupportedExtensions: () => [],
    // The BINDING queries answer from what bindTexture / bindBuffer / bindRenderbuffer were last given (the allocation ledger reads them); every other parameter is 16384.
    getParameter: (p) => {
      const bn = (n) => {
        if (!consts.has(n)) consts.set(n, nextConst++);
        return consts.get(n);
      };
      for (const [name, tgt] of [
        ['TEXTURE_BINDING_2D', 'TEXTURE_2D'],
        ['TEXTURE_BINDING_2D_ARRAY', 'TEXTURE_2D_ARRAY'],
        ['TEXTURE_BINDING_3D', 'TEXTURE_3D'],
      ])
        if (p === bn(name) && p !== undefined)
          return S.bound.get('tex:' + bn(tgt) + ':' + S.unit) || null;
      for (const [name, tgt] of [
        ['ARRAY_BUFFER_BINDING', 'ARRAY_BUFFER'],
        ['ELEMENT_ARRAY_BUFFER_BINDING', 'ELEMENT_ARRAY_BUFFER'],
        ['UNIFORM_BUFFER_BINDING', 'UNIFORM_BUFFER'],
        ['COPY_READ_BUFFER_BINDING', 'COPY_READ_BUFFER'],
        ['COPY_WRITE_BUFFER_BINDING', 'COPY_WRITE_BUFFER'],
      ])
        if (p === bn(name) && p !== undefined) return S.bound.get('buf:' + bn(tgt)) || null;
      if (p === bn('RENDERBUFFER_BINDING') && p !== undefined)
        return S.bound.get('rb:' + bn('RENDERBUFFER')) || null;
      return 16384;
    },
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    isContextLost: () => false,
    getContextAttributes: () => ({
      alpha: true,
      premultipliedAlpha: true,
      depth: true,
      stencil: true,
    }),
    getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
  };
  // A property the code under test ASSIGNS (a wrapper installed on the context, a spy) wins over the stand-in method.
  const own = new Map();
  const gl = new Proxy(
    {},
    {
      set(_t, k, v) {
        own.set(k, v);
        return true;
      },
      deleteProperty(_t, k) {
        own.delete(k);
        return true;
      },
      get(_t, k) {
        if (typeof k !== 'string') return undefined;
        if (own.has(k)) return own.get(k);
        if (k === 'canvas') return canvas;
        if (k === 'drawingBufferWidth') return width;
        if (k === 'drawingBufferHeight') return height;
        if (/^[A-Z_0-9]+$/.test(k)) {
          if (!consts.has(k)) consts.set(k, nextConst++);
          return consts.get(k);
        }
        if (impl[k]) return impl[k];
        return () => null;
      },
    },
  );
  return {
    gl,
    log,
    /// Tag every event recorded from now on with this frame number.
    setFrame: (n) => {
      S.frame = n;
    },
    /// The scissor state right now: null when SCISSOR_TEST is off, else [x, y, w, h].
    scissorNow: () => sc(),
    /// The shader keys a program was linked from (e.g. 'cacheBlitFrag', 'compositeFrag').
    progKeys: (p) => (p && S.prog.get(p)) || new Set(),
    /// The texture attached as an FBO's color buffer (null = the canvas).
    colorOf: (fbo) => (fbo ? S.attach.get(fbo) || null : null),
    /// The FBO whose color attachment is `tex`, if any.
    fboOf: (tex) => {
      for (const [f, t] of S.attach) if (t === tex) return f;
      return null;
    },
    /// Does this FBO have a depth+stencil renderbuffer attached? (The canvas does: null -> true.)
    hasDepthStencil: (fbo) =>
      fbo
        ? !!(S.rbAttach.get(fbo) && S.rbAttach.get(fbo).has(REAL.DEPTH_STENCIL_ATTACHMENT))
        : true,
    /// Lose the context: fire 'webglcontextlost' (the renderer must preventDefault to be restored).
    loseContext: () => fire('webglcontextlost').defaultPrevented,
    /// Restore it: every GL object created so far now belongs to the LOST context, then fire
    /// 'webglcontextrestored'. A real restored context rejects such an object (INVALID_OPERATION);
    /// here it is only recorded, and isDead() names it.
    restoreContext: () => {
      deadBelow = nextId;
      fire('webglcontextrestored');
    },
    /// Was `obj` (a texture, framebuffer, renderbuffer, ...) created by a context since lost?
    isDead: (obj) => !!(obj && typeof obj.id === 'number' && obj.id < deadBelow),
  };
}

/// Is this logged draw a GROUP's composite -- groupEnd putting an accumulator back into its parent or
/// onto the canvas? Read off the GL log alone (the renderer's group entry points are internal). Two
/// shapes: composite.frag under a REPLACE (ONE, ZERO), which reads a copy of the backdrop -- every
/// group before, and a non-normal blend after it (a mix-blend-mode leaf composites the same
/// way, so a caller that has one tells them apart by position); or, for a normal group, a
/// fixed-function src-over (ONE, ONE_MINUS_SRC_ALPHA) cacheBlit whose tint is the group's opacity. A
/// filter composite is the same blit at tint (1,1,1,1), so a fixture's normal groups need opacity < 1.
export function isGroupComposite(F, e) {
  if (!e || e.op !== 'draw') return false;
  const keys = F.progKeys(e.prog);
  const bl = e.blend ? e.blend.join(',') : '';
  if (keys.has('compositeFrag')) return bl === 'ONE,ZERO';
  if (!keys.has('cacheBlitFrag') || bl !== 'ONE,ONE_MINUS_SRC_ALPHA') return false;
  const t = e.uni && e.uni.uTint;
  return !!t && t.some((v) => v !== 1);
}

/// Expand every INSTANCED cache-blit composite (the group atlas and merged runs composite N rects in one drawArraysInstanced) into the N
/// one-quad draws it stands for, in order: { viewport = the rect, uni.uInMap, uni.uTint }. Lets an assertion about "each composite" read
/// the same events whether the renderer drew N quads or one instanced draw. A draw that is not an instanced cache-blit passes through.
export function expandInstancedBlits(F, events) {
  const out = [];
  for (const e of events) {
    if (
      e.op !== 'draw' ||
      !(e.instances > 1) ||
      !e.instData ||
      !F.progKeys(e.prog).has('cacheBlitFrag')
    ) {
      out.push(e);
      continue;
    }
    for (let i = 0; i < e.instances; i++) {
      const d = e.instData,
        k = i * 12;
      out.push({
        ...e,
        count: 4,
        instances: 1,
        instData: null,
        expanded: true,
        vp: [d[k], d[k + 1], d[k + 2], d[k + 3]],
        uni: {
          ...e.uni,
          uInMap: [d[k + 4], d[k + 5], d[k + 6], d[k + 7]],
          uTint: [d[k + 8], d[k + 9], d[k + 10], d[k + 11]],
        },
      });
    }
  }
  return out;
}
