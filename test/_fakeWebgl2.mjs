// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Records GL state, calls, uploads and attachments; never evaluates a shader.
// Draws leave uploaded texture bytes unchanged. Optional observer hooks are
// invoked by explicit development diagnostics; this helper imports no model.
export function makeFakeWebgl2(W = 256, H = 256, log = []) {
  const K = {
    NO_ERROR: 0,
    TEXTURE_2D: 0x0de1,
    TEXTURE_2D_ARRAY: 0x8c1a,
    RGBA32F: 0x8814,
    RGBA: 0x1908,
    FLOAT: 0x1406,
    UNSIGNED_BYTE: 0x1401,
    FRAMEBUFFER: 0x8d40,
    DRAW_FRAMEBUFFER: 0x8ca9,
    READ_FRAMEBUFFER: 0x8ca8,
    COLOR_ATTACHMENT0: 0x8ce0,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    TEXTURE0: 0x84c0,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    TRIANGLES: 4,
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    VIEWPORT: 0x0ba2,
    COLOR_WRITEMASK: 0x0c23,
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_TEXTURE_IMAGE_UNITS: 0x8872,
    MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c,
    MAX_VERTEX_ATTRIBS: 0x8869,
    MAX_VIEWPORT_DIMS: 0x0d3a,
    MAX_RENDERBUFFER_SIZE: 0x84e8,
    MAX_SAMPLES: 0x8d57,
    MAX_DRAW_BUFFERS: 0x8824,
    MAX_COLOR_ATTACHMENTS: 0x8cdf,
    MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
    MAX_UNIFORM_BLOCK_SIZE: 0x8a30,
    MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb,
    MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd,
    ALREADY_SIGNALED: 0x911a,
    CONDITION_SATISFIED: 0x911c,
    TIMEOUT_EXPIRED: 0x911b,
    FRAMEBUFFER_BINDING: 0x8ca6,
    TEXTURE_BINDING_2D: 0x8069,
    ACTIVE_TEXTURE: 0x84e0,
    CURRENT_PROGRAM: 0x8b8d,
    ARRAY_BUFFER_BINDING: 0x8894,
    VERTEX_ARRAY_BINDING: 0x85b5,
    DEPTH_TEST: 0x0b71,
    BLEND: 0x0be2,
    SCISSOR_TEST: 0x0c11,
    STENCIL_TEST: 0x0b90,
    SCISSOR_BOX: 0x0c10,
    SHADING_LANGUAGE_VERSION: 0x8b8c,
    VERSION: 0x1f02,
    RENDERER: 0x1f01,
    VENDOR: 0x1f00,
  };
  let next = 1,
    active = 0,
    prog = null,
    fbo = null,
    vp = [0, 0, W, H],
    cm = [true, true, true, true],
    sc = [0, 0, W, H];
  const units = new Map();
  const enabled = new Set();
  const canvas = {
    width: W,
    height: H,
    clientWidth: W,
    clientHeight: H,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
  };
  const impl = {
    canvas,
    drawingBufferWidth: W,
    drawingBufferHeight: H,
    getError: () => 0,
    isContextLost: () => false,
    getContextAttributes: () => ({
      antialias: false,
      premultipliedAlpha: true,
      alpha: true,
      depth: true,
      stencil: true,
    }),
    getSupportedExtensions: () => ['EXT_color_buffer_float', 'OES_texture_float_linear'],
    getExtension: (n) => (n === 'KHR_parallel_shader_compile' ? null : {}),
    getParameter: (p) => {
      if (p === K.VIEWPORT) return new Int32Array(vp);
      if (p === K.COLOR_WRITEMASK) return cm.slice();
      if (p === K.MAX_VIEWPORT_DIMS) return new Int32Array([16384, 16384]);
      if (p === K.FRAMEBUFFER_BINDING) return fbo;
      if (p === K.ACTIVE_TEXTURE) return K.TEXTURE0 + active;
      if (p === K.TEXTURE_BINDING_2D) return units.get(active) || null;
      if (p === K.CURRENT_PROGRAM) return prog;
      if (p === K.SCISSOR_BOX) return new Int32Array([0, 0, W, H]);
      if (p === K.MAX_TEXTURE_SIZE || p === K.MAX_RENDERBUFFER_SIZE) return 16384;
      if (p === K.MAX_TEXTURE_IMAGE_UNITS || p === K.MAX_VERTEX_TEXTURE_IMAGE_UNITS) return 16;
      if (p === K.MAX_COMBINED_TEXTURE_IMAGE_UNITS) return 32;
      if (p === K.MAX_VERTEX_ATTRIBS) return 16;
      if (p === K.MAX_SAMPLES || p === K.MAX_DRAW_BUFFERS || p === K.MAX_COLOR_ATTACHMENTS)
        return 4;
      if (p === K.MAX_ARRAY_TEXTURE_LAYERS) return 256;
      if (p === K.MAX_UNIFORM_BLOCK_SIZE) return 65536;
      if (p === K.MAX_VERTEX_UNIFORM_VECTORS || p === K.MAX_FRAGMENT_UNIFORM_VECTORS) return 1024;
      if (p === K.SHADING_LANGUAGE_VERSION) return 'WebGL GLSL ES 3.00';
      if (p === K.VERSION) return 'WebGL 2.0';
      return 0;
    },
    isEnabled: (c) => enabled.has(c),
    enable: (c) => enabled.add(c),
    disable: (c) => enabled.delete(c),
    colorMask: (r, g, b, a) => {
      cm = [!!r, !!g, !!b, !!a];
    },
    viewport: (x, y, w, h) => {
      vp = [x, y, w, h];
    },
    scissor: (x, y, w, h) => {
      sc = [x, y, w, h];
    },
    clear: (bits) => {
      log.push({
        op: 'clear',
        fbo: fbo && fbo.id,
        scissor: enabled.has(K.SCISSOR_TEST) ? sc.slice() : null,
        vp: vp.slice(),
      });
    },
    createTexture: () => ({ id: next++, w: 0, h: 0, data: null }),
    deleteTexture: (t) => {
      if (t) t.dead = true;
    },
    activeTexture: (u) => {
      active = u - K.TEXTURE0;
    },
    bindTexture: (target, t) => {
      if (target === K.TEXTURE_2D) units.set(active, t || null);
    },
    texImage2D: (target, lvl, internal, w, h, border, format, type, data) => {
      if (target !== K.TEXTURE_2D || typeof w !== 'number') return; // image-source overloads
      const t = units.get(active);
      if (!t) return;
      if (lvl !== 0) return;
      t.w = w;
      t.h = h;
      t.float = type === K.FLOAT;
      t.data = t.float ? new Float32Array(w * h * 4) : null;
      if (t.float && data) {
        if (data.length < w * h * 4)
          throw new Error(`texImage2D: ${data.length} floats for ${w}x${h}`);
        t.data.set(data.subarray(0, w * h * 4));
      }
      log.push({ op: 'texImage2D', tex: t.id, w, h });
    },
    texSubImage2D: (target, lvl, x, y, w, h, format, type, data) => {
      if (target !== K.TEXTURE_2D || typeof w !== 'number') return;
      const t = units.get(active);
      if (!t || !t.data || !(data instanceof Float32Array)) return;
      for (let r = 0; r < h; r++)
        t.data.set(data.subarray(r * w * 4, (r + 1) * w * 4), ((y + r) * t.w + x) * 4);
      log.push({ op: 'texSubImage2D', tex: t.id, x, y, w, h });
    },
    createFramebuffer: () => ({ id: next++, att: null }),
    deleteFramebuffer: (f) => {
      if (f) f.dead = true;
    },
    bindFramebuffer: (target, f) => {
      if (f && f.dead) {
        log.push({ op: 'BIND DELETED FBO', fbo: f.id });
        return;
      }
      fbo = f || null;
    },
    framebufferTexture2D: (target, att, tt, t) => {
      if (fbo) fbo.att = t;
    },
    checkFramebufferStatus: () => K.FRAMEBUFFER_COMPLETE,
    createShader: (type) => ({ type, src: '' }),
    shaderSource: (s, src) => {
      s.src = src;
    },
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: () => {},
    createProgram: () => ({ id: next++, sh: [], u: {} }),
    attachShader: (p, s) => {
      p.sh.push(s);
    },
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: () => {},
    validateProgram: () => {},
    getUniformLocation: (p, name) => ({ p, name }),
    getAttribLocation: () => 0,
    getUniformBlockIndex: () => 0,
    uniformBlockBinding: () => {},
    getActiveUniform: () => null,
    getActiveAttrib: () => null,
    getProgramParameterCount: () => 0,
    useProgram: (p) => {
      prog = p;
    },
    uniform1i: (l, v) => {
      if (l) l.p.u[l.name] = v;
    },
    uniform1f: (l, v) => {
      if (l) l.p.u[l.name] = v;
    },
    fenceSync: () => ({}),
    clientWaitSync: () => K.ALREADY_SIGNALED,
    deleteSync: () => {},
    getSyncParameter: () => 0x9119,
    readPixels: (x, y, w, h, f, t, out) => {
      if (out && out.fill) out.fill(0);
    },
    drawArrays: (mode, first, count) => {
      const fs = prog && prog.sh.find((s) => s.type === K.FRAGMENT_SHADER);
      if (fs && /uniform highp sampler2D uPA/.test(fs.src)) {
        const out = fbo && fbo.att;
        log.push({
          op: 'blend',
          tex: out && out.id,
          u: prog.u.uU,
          vp: vp.slice(),
          fbo: fbo && fbo.id,
          scissor: enabled.has(K.SCISSOR_TEST) ? sc.slice() : null,
        });
        if (hook.onBlend)
          hook.onBlend({
            fragmentSource: fs.src,
            uniforms: { ...prog.u },
            target: out,
            viewport: vp.slice(),
            colorMask: cm.slice(),
            units,
          });
        return;
      }
      log.push({
        op: 'draw',
        prog: prog && prog.id,
        fbo: fbo && fbo.id,
        first,
        count,
        scissor: enabled.has(K.SCISSOR_TEST) ? sc.slice() : null,
        vp: vp.slice(),
        blend: enabled.has(K.BLEND),
        sample: hook.onDraw ? hook.onDraw() : null,
      });
    },
    drawElements: () => {
      log.push({ op: 'drawElements', fbo: fbo && fbo.id });
    },
    drawArraysInstanced: () => {
      log.push({ op: 'drawArraysInstanced', fbo: fbo && fbo.id });
    },
  };
  const hook = {};
  let uniq = 0x20000;
  const consts = new Map();
  const gl = new Proxy(impl, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k !== 'string') return undefined;
      if (k in K) return K[k];
      if (/^TEXTURE\d+$/.test(k)) return K.TEXTURE0 + +k.slice(7);
      if (/^[A-Z][A-Z0-9_]*$/.test(k)) {
        if (!consts.has(k)) consts.set(k, uniq++);
        return consts.get(k);
      }
      if (/^(create|fenceSync)/.test(k)) return () => ({ id: next++ });
      if (/^is/.test(k)) return () => false;
      if (/^get/.test(k)) return () => null;
      return () => {};
    },
  });
  return { gl, log, hook, units, K };
}
