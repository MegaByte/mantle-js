// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Probe-only per-shape coverage RT. This deliberately measures the cost of
// resolving real CPatch pieces before paint. It is not a production route.
import { noteExternalGlWrite } from '../../src/core/glEpoch.js';
export function createPieceResolver(gl, r) {
  if (!gl.getExtension('EXT_color_buffer_float')) throw Error('Float coverage RT unavailable');
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
    return s;
  };
  const vs = shader(
    gl.VERTEX_SHADER,
    `#version 300 es
  void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}`,
  );
  const fs = shader(
    gl.FRAGMENT_SHADER,
    `#version 300 es
  precision highp float;uniform sampler2D mask;uniform vec4 paint;out vec4 fragColor;
  void main(){float a=clamp(texelFetch(mask,ivec2(gl_FragCoord.xy),0).r*2.,0.,1.)*paint.a;fragColor=vec4(paint.rgb*a,a);}`,
  );
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  const paint = gl.getUniformLocation(program, 'paint'),
    mask = gl.getUniformLocation(program, 'mask'),
    vao = gl.createVertexArray();
  const av = shader(
    gl.VERTEX_SHADER,
    `#version 300 es
  layout(location=0)in vec2 pos;layout(location=1)in vec2 offset;layout(location=2)in vec4 color;
  flat out vec2 tileOffset;flat out vec4 tilePaint;
  void main(){gl_Position=vec4(pos,0.,1.);tileOffset=offset;tilePaint=color;}`,
  );
  const af = shader(
    gl.FRAGMENT_SHADER,
    `#version 300 es
  precision highp float;uniform sampler2D mask;uniform float alpha;
  flat in vec2 tileOffset;flat in vec4 tilePaint;out vec4 fragColor;
  void main(){float a=clamp(texelFetch(mask,ivec2(gl_FragCoord.xy+tileOffset),0).r*2.,0.,1.)*tilePaint.a*alpha;fragColor=vec4(tilePaint.rgb*a,a);}`,
  );
  const atlasProgram = gl.createProgram();
  gl.attachShader(atlasProgram, av);
  gl.attachShader(atlasProgram, af);
  gl.linkProgram(atlasProgram);
  if (!gl.getProgramParameter(atlasProgram, gl.LINK_STATUS))
    throw Error(gl.getProgramInfoLog(atlasProgram));
  gl.deleteShader(av);
  gl.deleteShader(af);
  const atlasMask = gl.getUniformLocation(atlasProgram, 'mask'),
    atlasAlpha = gl.getUniformLocation(atlasProgram, 'alpha'),
    atlasMeshes = new WeakMap();
  // Whole-group opacity is applied after ordered paints, never per piece/paint.
  const gv = shader(
    gl.VERTEX_SHADER,
    `#version 300 es
  void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}`,
  );
  const gf = shader(
    gl.FRAGMENT_SHADER,
    `#version 300 es
  precision highp float;uniform sampler2D mask;uniform float alpha;out vec4 fragColor;
  void main(){fragColor=texelFetch(mask,ivec2(gl_FragCoord.xy),0)*alpha;}`,
  );
  const groupProgram = gl.createProgram();
  gl.attachShader(groupProgram, gv);
  gl.attachShader(groupProgram, gf);
  gl.linkProgram(groupProgram);
  if (!gl.getProgramParameter(groupProgram, gl.LINK_STATUS))
    throw Error(gl.getProgramInfoLog(groupProgram));
  gl.deleteShader(gv);
  gl.deleteShader(gf);
  const groupMask = gl.getUniformLocation(groupProgram, 'mask'),
    groupAlpha = gl.getUniformLocation(groupProgram, 'alpha'),
    groupTargets = new Map();
  function groupTarget(n) {
    if (groupTargets.has(n)) return groupTargets.get(n);
    const tex = gl.createTexture(),
      fbo = gl.createFramebuffer();
    gl.activeTexture(gl.TEXTURE15);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, n, n);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    bind(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw Error('Group color RT incomplete');
    const target = { tex, fbo, size: n, bytes: n * n * 4 };
    groupTargets.set(n, target);
    return target;
  }
  let tex = null,
    fbo = null,
    active = false;
  const targets = new Map();
  const bind = gl.bindFramebuffer.bind(gl);
  gl.bindFramebuffer = (target, fb) => bind(target, active && fb === null ? fbo : fb);
  function beforeDraw() {
    if (!active) return;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
  }
  function resize(n, format = 'rgba16f') {
    const formats = {
      rgba16f: [gl.RGBA16F, 16, 4],
      rgba32f: [gl.RGBA32F, 32, 4],
      r16f: [gl.R16F, 16, 1],
      r32f: [gl.R32F, 32, 1],
    };
    const info = formats[format];
    if (!info) throw Error('Unknown coverage format: ' + format);
    if (info[1] === 32 && !gl.getExtension('EXT_float_blend'))
      throw Error('32-bit float coverage blending unavailable');
    const key = n + ':' + format,
      cached = targets.get(key);
    if (cached) {
      tex = cached.tex;
      fbo = cached.fbo;
      return;
    }
    tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE15);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, info[0], n, n);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    fbo = gl.createFramebuffer();
    bind(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw Error('Coverage RT incomplete');
    const redBits = gl.getFramebufferAttachmentParameter(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.FRAMEBUFFER_ATTACHMENT_RED_SIZE,
    );
    if (redBits !== info[1]) throw Error('Coverage precision mismatch: ' + redBits);
    targets.set(key, {
      tex,
      fbo,
      size: n,
      format,
      redBits,
      bytes: (n * n * info[2] * redBits) / 8,
    });
    bind(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    noteExternalGlWrite();
    r.invalidateRenderState();
  }
  function draw(groups, n, count, drawOptions = {}, format = 'rgba16f') {
    resize(n, format);
    bind(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    for (let rep = 0; rep < count; rep++)
      for (const g of groups) {
        active = true;
        bind(gl.FRAMEBUFFER, fbo);
        noteExternalGlWrite();
        r.invalidateRenderState();
        r.beginFrame([0, 0, 0, 0]);
        r.drawBundle(g.bundle);
        r.endFrame();
        active = false;
        bind(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, n, n);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.SCISSOR_TEST);
        gl.colorMask(true, true, true, true);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(program);
        gl.bindVertexArray(vao);
        gl.activeTexture(gl.TEXTURE15);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(mask, 15);
        gl.uniform4f(paint, ...g.color.slice(0, 3), g.color[3] * (drawOptions.alpha ?? 1));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE0);
        noteExternalGlWrite();
        r.invalidateRenderState();
      }
  }
  function drawAtlas(atlas, n, count, drawOptions = {}, format = 'rgba16f') {
    let mesh = atlasMeshes.get(atlas);
    if (!mesh) {
      const vertices = [];
      for (const g of atlas.groups) {
        const [x, y, w, h] = g.rect,
          [ax, ay] = g.atlas;
        for (const [u, v] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [0, 1],
          [1, 0],
          [1, 1],
        ])
          vertices.push(
            (2 * (x + u * w)) / n - 1,
            1 - (2 * (y + v * h)) / n,
            ax - x,
            atlas.size - n + y - ay,
            ...g.color,
          );
      }
      const vbo = gl.createBuffer(),
        vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
      for (const [loc, len, offset] of [
        [0, 2, 0],
        [1, 2, 8],
        [2, 4, 16],
      ]) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, len, gl.FLOAT, false, 32, offset);
      }
      mesh = { vao, vbo, count: vertices.length / 8 };
      atlasMeshes.set(atlas, mesh);
      noteExternalGlWrite();
    }
    if (!(atlas.groupAlpha >= 0 && atlas.groupAlpha <= 1)) throw Error('Group alpha outside [0,1]');
    const group = atlas.groupAlpha === 1 ? null : groupTarget(n);
    resize(atlas.size, format);
    bind(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // Recompute coverage for every repetition, matching the other arms' two
    // complete draws; no across-draw mask cache is hidden in the timing.
    for (let rep = 0; rep < count; rep++) {
      active = true;
      bind(gl.FRAMEBUFFER, fbo);
      r.setViewport(atlas.size, atlas.size);
      noteExternalGlWrite();
      r.invalidateRenderState();
      r.beginFrame([0, 0, 0, 0]);
      r.drawBundle(atlas.morph || atlas.bundle);
      r.endFrame();
      active = false;
      bind(gl.FRAMEBUFFER, group?.fbo || null);
      gl.viewport(0, 0, n, n);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      if (group) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(atlasProgram);
      gl.bindVertexArray(mesh.vao);
      gl.activeTexture(gl.TEXTURE15);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(atlasMask, 15);
      gl.uniform1f(atlasAlpha, group ? 1 : (drawOptions.alpha ?? 1));
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
      if (group) {
        bind(gl.FRAMEBUFFER, null);
        gl.useProgram(groupProgram);
        gl.bindVertexArray(vao);
        gl.bindTexture(gl.TEXTURE_2D, group.tex);
        gl.uniform1i(groupMask, 15);
        gl.uniform1f(groupAlpha, atlas.groupAlpha * (drawOptions.alpha ?? 1));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
      noteExternalGlWrite();
      r.setViewport(n, n);
      r.invalidateRenderState();
    }
  }
  function inspectAtlas(atlas, n, pixels) {
    const rows = [];
    bind(gl.FRAMEBUFFER, fbo);
    for (const [x, y] of pixels)
      for (const g of atlas.groups) {
        const [sx, sy, w, h] = g.rect;
        if (x < sx || x >= sx + w || y < sy || y >= sy + h) continue;
        const ax = x - sx + g.atlas[0],
          ay = atlas.size - 1 - (y - sy + g.atlas[1]),
          v = new Float32Array(4);
        gl.readPixels(ax, ay, 1, 1, gl.RGBA, gl.FLOAT, v);
        rows.push({ x, y, shape: g.shape, atlas: [ax, ay], coverage: 2 * v[0] });
      }
    bind(gl.FRAMEBUFFER, null);
    return rows;
  }
  const targetInfo = () =>
    [...targets.values()].map(({ size, format, redBits, bytes }) => ({
      size,
      format,
      redBits,
      bytes,
    }));
  return {
    beforeDraw,
    draw,
    drawAtlas,
    inspectAtlas,
    targetInfo,
    groupTargetInfo: () =>
      [...groupTargets.values()].map(({ size, bytes }) => ({ size, format: 'rgba8', bytes })),
  };
}
