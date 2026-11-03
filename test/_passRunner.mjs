// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _passRunner.mjs -- runs one side of a test/_filtperfCases.mjs case as a single fullscreen pass on a real WebGL2
// context (browser only): compiles the side's fragment text against composite.vert, uploads its textures, sets its
// uniforms by name, draws into an RGBA8 target of the case's size, and reads it back. Shared by
// test/filterPassParityRenderSmoke.mjs (pixels) and probes/filtperf/passAB.mjs (timing). No renderer is involved:
// this is the pass alone, so a timing from it prices the shader, not what the renderer does around it.

export function makePassRunner(gl, fetchText) {
  const texts = new Map();
  const text = async (p) => {
    if (!texts.has(p)) texts.set(p, await fetchText(p));
    return texts.get(p);
  };
  const progs = new Map();
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  function compile(vs, fs) {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error('compile: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error('link: ' + gl.getProgramInfoLog(p));
    return p;
  }
  // The vertex stage is composite.vert (aPos a [-1,1] quad, vUV = aPos * 0.5 + 0.5) unless the case
  // names its own -- one whose outputs the fragment text reads (drawImage's flat tint).
  async function program(fragPath, vertPath = 'src/shaders/generated/composite.vert.glsl') {
    const key = vertPath + '\0' + fragPath;
    if (!progs.has(key)) progs.set(key, compile(await text(vertPath), await text(fragPath)));
    return progs.get(key);
  }
  function makeTex(t) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (t.f32) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, t.w, t.h, 0, gl.RGBA, gl.FLOAT, t.f32);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, t.w, t.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, t.u8);
    const f = t.linear && !t.f32 ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }
  /// Everything one side needs to draw, built once: program, textures bound to units, uniforms set, target.
  /// `size` overrides the target's size (the probe times at a real canvas size): the pass then samples
  /// the case's textures stretched over it, so its per-pixel work is the same, just more of it.
  async function prepare(c, side, { size = null } = {}) {
    const p = await program(c.frag[side], c.vert ? c.vert[side] : undefined);
    const io = c.inputs[side];
    const [W, H] = size || c.size;
    // TWO TARGETS, ALTERNATED PER DRAW. Back-to-back opaque full-target quads into ONE target are one
    // render pass on a tile-based GPU, and hidden-surface removal shades only the last of them -- so the
    // shipped runner timed per-draw overhead (every pass read ~7 us at 1024x1024). A filter node writes a
    // target of its own; alternating makes every draw its own pass, with its own store, as in a graph.
    const mk = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return [t, f];
    };
    const [target, fbo] = mk(),
      [target2, fbo2] = mk();
    let flip = 0;
    const texs = [];
    for (const [name, t] of Object.entries(io.textures || {})) texs.push({ name, tex: makeTex(t) });
    gl.useProgram(p);
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(p, info.name);
      if (info.type === gl.SAMPLER_2D) {
        const k = texs.findIndex((t) => t.name === name);
        gl.uniform1i(loc, k < 0 ? 15 : k);
        continue;
      }
      const v = (io.uniforms || {})[name];
      seen.add(name);
      if (v === undefined) continue;
      const a = typeof v === 'number' || typeof v === 'boolean' ? [+v] : Array.from(v);
      switch (info.type) {
        case gl.FLOAT:
          gl.uniform1fv(loc, a);
          break;
        case gl.FLOAT_VEC2:
          gl.uniform2fv(loc, a);
          break;
        case gl.FLOAT_VEC3:
          gl.uniform3fv(loc, a);
          break;
        case gl.FLOAT_VEC4:
          gl.uniform4fv(loc, a);
          break;
        case gl.INT:
        case gl.BOOL:
          gl.uniform1iv(
            loc,
            a.map((x) => x | 0),
          );
          break;
        case gl.INT_VEC2:
          gl.uniform2iv(
            loc,
            a.map((x) => x | 0),
          );
          break;
        case gl.INT_VEC4:
          gl.uniform4iv(
            loc,
            a.map((x) => x | 0),
          );
          break;
        case gl.FLOAT_MAT3:
          gl.uniformMatrix3fv(loc, false, a);
          break;
        case gl.FLOAT_MAT4:
          gl.uniformMatrix4fv(loc, false, a);
          break;
        default:
          throw new Error(`passRunner: uniform ${name} of type 0x${info.type.toString(16)}`);
      }
    }
    for (const k of Object.keys(io.uniforms || {})) {
      if (!seen.has(k))
        console.warn(`passRunner: ${c.name} ${side}: uniform ${k} is not active in the program`);
    }
    const bind = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, W, H);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.useProgram(p);
      texs.forEach((t, k) => {
        gl.activeTexture(gl.TEXTURE0 + k);
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
      });
      gl.bindVertexArray(vao);
      // Constant values for attributes the vertex stage reads but the quad does not supply (the
      // instanced blit's per-instance rect, matrix and tint), as one instance would carry them.
      for (const [loc, v] of Object.entries(io.attribs || {}))
        gl.vertexAttrib4f(+loc, v[0] || 0, v[1] || 0, v[2] || 0, v.length > 3 ? v[3] : 1);
    };
    const draw = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, (flip ^= 1) ? fbo2 : fbo);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    const read = () => {
      bind();
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const dispose = () => {
      for (const t of texs) gl.deleteTexture(t.tex);
      gl.deleteTexture(target);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(target2);
      gl.deleteFramebuffer(fbo2);
    };
    return { bind, draw, read, dispose };
  }
  return { prepare };
}

/// Compare two readbacks: { ch8, ties, mx, off, outliers, pass } -- ties counts 1-LSB differences where the case's
/// exact() is a rounding tie. A GPU compiler may fuse or reorder, so `pass` allows every case 1 LSB (a tolerance
/// in object form, { lsb, outliers }, allows its lsb and its fraction of outlier channels past it).
export function comparePx(c, a, b) {
  const [W] = c.size;
  const obj = c.tol && typeof c.tol === 'object';
  const lsb = Math.max(1, obj ? c.tol.lsb : 1);
  let ch8 = 0,
    ties = 0,
    mx = 0,
    off = null,
    outliers = 0;
  const onTie = (v) => {
    const x = Math.min(1, Math.max(0, v)) * 255;
    return Math.abs(x - Math.floor(x) - 0.5) < 1e-3;
  };
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (!d) continue;
    ch8++;
    if (d > mx) mx = d;
    if (d > lsb) outliers++;
    const px = (i >> 2) % W,
      py = ((i >> 2) / W) | 0,
      k = i & 3;
    if (c.tol === 'ties' && d === 1 && c.exact && onTie(c.exact(px, py, k))) ties++;
    else if (!off) off = { x: px, y: py, c: k, old: a[i], new: b[i] };
  }
  const pass = outliers <= (obj ? c.tol.outliers * a.length : 0);
  return { ch8, ties, mx, off, outliers, pass };
}
