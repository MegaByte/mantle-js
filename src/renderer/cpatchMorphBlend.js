// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import {
  deleteGlResource,
  deleteProgramWhenLinked,
  resourceScope,
  trackGlResource,
  createTrackedProgram,
} from './contextResources.js';
import { gateFor } from './gpuGate.js';
// Reconstruct morph coefficients from static sample planes. Updates queue
// until the first fill so morphs share a write-to-read transition. A valid
// interval requires no per-frame CPU packing or coefficient subupload.

import { noteExternalGlWrite } from '../core/glEpoch.js';
import { planeFits } from './tableLayout.js';
import { ledgerFor } from './memoryLedger.js';
import { CP_BLOCK_TEXELS, CP_MORPH_C_FLOATS } from './cpatchLayout.js';

const states = new WeakMap();
function stateFor(gl) {
  const scope = resourceScope(gl);
  let state = states.get(scope);
  if (!state) {
    state = { owners: 0, pass: null, prog: null };
    states.set(scope, state);
  }
  return state;
}
function disposeUnused(gl, state) {
  if (!state.pass && state.owners <= 0 && state.prog) {
    deleteProgramWhenLinked(gl, state.prog);
    state.prog = null;
  }
  const p = state.pass;
  if (!p || p.users > 0 || state.owners > 0) return;
  state.pass = null;
  deleteGlResource(gl, 'Program', p.prog);
  deleteGlResource(gl, 'VertexArray', p.vao);
  deleteGlResource(gl, 'Buffer', p.vb);
}
export function retainCPatchBlendOwner(gl) {
  const state = stateFor(gl);
  state.owners++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.owners--;
    disposeUnused(gl, state);
  };
}

/** Additional resident bytes when replacing or reusing the coefficient planes. */
export function cpatchBlendAllocationBytes(gl, tgt, w, h, y0, cw, ch) {
  if (
    tgt &&
    !tgt.disposed &&
    tgt.w === w &&
    tgt.h === h &&
    tgt.y0 === y0 &&
    tgt.cw === cw &&
    tgt.ch === ch
  )
    return 0;
  const L = ledgerFor(gl);
  const credit = tgt && !tgt.disposed ? tgt.tex.reduce((n, t) => n + L.bytesOf(t), 0) : 0;
  return (2 * w * h + cw * ch) * 16 - credit + (stateFor(gl).pass ? 0 : 24);
}

/// Reconstruct a row from two functionals and a scalar, rather than Lagrange between three
/// sampled poses. x and y are degree 1 in u and only z is quadratic, so plane A holds (x0,y0,z0),
/// plane B holds (x1,y1,z1) with z2 in its spare slot, and plane C carries the u and u^2 terms of
/// the two constants only the Bezout kind reads. Same output, 9 texels a block instead of 12.
///
const FS = `#version 300 es
precision highp float;
uniform highp sampler2D uPA, uPB, uPC;
uniform int uY0, uNB, uNC;
uniform float uU;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) - ivec2(0, uY0);
  int idx = p.y * uNB + p.x;              // texel index within the block run
  // CP_BLOCK_TEXELS to a block, shared with the packer through cpatchLayout.
  // A divide, not a shift, since 7 is not a power of two.
  int blk = idx / ${CP_BLOCK_TEXELS}, row = idx - blk * ${CP_BLOCK_TEXELS};
  float u = clamp(uU, 0.0, 1.0);
  vec4 a = texelFetch(uPA, p, 0);
  vec4 b = texelFetch(uPB, p, 0);
  float w = a.w;
  if (row == 2 || row == 3 || row == 5 || row == 6) {
    int ci = blk * ${CP_MORPH_C_FLOATS / 4} + (row > 3 ? 1 : 0);
    vec4 c = texelFetch(uPC, ivec2(ci % uNC, ci / uNC), 0);
    w += (row == 2 || row == 5) ? u * (c.x + u * c.y) : u * (c.z + u * c.w);
  }
  o = vec4(a.xy + u * b.xy, a.z + u * (b.z + u * b.w), w);
}`;

const VS = `#version 300 es
layout(location=0) in vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }`;

/// The blocking form (non-blocking mode off): compiles, links and validates on the spot, waiting for the driver.
function getBlendPassBlocking(gl) {
  const state = stateFor(gl);
  let p = state.pass;
  if (p) return p;
  const prog = createTrackedProgram(gl);
  let vs = null,
    fs = null;
  try {
    const sh = (type, src) => {
      const s = trackGlResource(gl, gl.createShader(type));
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(s);
        deleteGlResource(gl, 'Shader', s);
        throw new Error('cpatchBlend: ' + info);
      }
      return s;
    };
    vs = sh(gl.VERTEX_SHADER, VS);
    fs = sh(gl.FRAGMENT_SHADER, FS);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error('cpatchBlend link: ' + gl.getProgramInfoLog(prog));
  } catch (e) {
    deleteGlResource(gl, 'Program', prog);
    throw e;
  } finally {
    if (vs) deleteGlResource(gl, 'Shader', vs);
    if (fs) deleteGlResource(gl, 'Shader', fs);
  }
  const vao = trackGlResource(gl, gl.createVertexArray()),
    vb = trackGlResource(gl, gl.createBuffer(), 'morph');
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  p = {
    prog,
    vao,
    vb,
    state,
    users: 0,
    uP0: gl.getUniformLocation(prog, 'uPA'),
    uPH: gl.getUniformLocation(prog, 'uPB'),
    uP1: gl.getUniformLocation(prog, 'uPC'),
    uY0: gl.getUniformLocation(prog, 'uY0'),
    uNB: gl.getUniformLocation(prog, 'uNB'),
    uNC: gl.getUniformLocation(prog, 'uNC'),
    uU: gl.getUniformLocation(prog, 'uU'),
  };
  state.pass = p;
  return p;
}

/// The blend helper, or null while its link is unfinished or the GPU thread is behind (gpuGate.js): nothing is asked of a program that is not ready,
/// and the caller (buildCPatchBlend) answers null, which leaves the morph on the CPU pack for that segment, as it does for a device with no float target.
/// The first ask compiles and links it.
function getBlendPass(gl) {
  if (!gateFor(gl).nb) return getBlendPassBlocking(gl); // blocking mode
  const state = stateFor(gl);
  let p = state.pass;
  if (p) return p;
  if (!state.prog) {
    const prog = createTrackedProgram(gl);
    let vs = null,
      fs = null;
    try {
      const sh = (type, src) => {
        const s = trackGlResource(gl, gl.createShader(type));
        gl.shaderSource(s, src);
        gl.compileShader(s);
        return s;
      };
      vs = sh(gl.VERTEX_SHADER, VS);
      fs = sh(gl.FRAGMENT_SHADER, FS);
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
    } catch (e) {
      deleteGlResource(gl, 'Program', prog);
      throw e;
    } finally {
      if (vs) deleteGlResource(gl, 'Shader', vs);
      if (fs) deleteGlResource(gl, 'Shader', fs);
    }
    state.prog = prog;
  }
  const prog = state.prog;
  if (!gateFor(gl).ready(prog)) return null;
  state.prog = null;
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    deleteGlResource(gl, 'Program', prog);
    throw new Error('cpatchBlend link: ' + log);
  }
  const vao = trackGlResource(gl, gl.createVertexArray()),
    vb = trackGlResource(gl, gl.createBuffer(), 'morph');
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  p = {
    prog,
    vao,
    vb,
    state,
    users: 0,
    uP0: gl.getUniformLocation(prog, 'uPA'),
    uPH: gl.getUniformLocation(prog, 'uPB'),
    uP1: gl.getUniformLocation(prog, 'uPC'),
    uY0: gl.getUniformLocation(prog, 'uY0'),
    uNB: gl.getUniformLocation(prog, 'uNB'),
    uNC: gl.getUniformLocation(prog, 'uNC'),
    uU: gl.getUniformLocation(prog, 'uU'),
  };
  state.pass = p;
  return p;
}

function makePlane(gl, data, w, h) {
  const t = trackGlResource(gl, gl.createTexture(), 'morph');
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
    gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
    gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
  return t;
}

/// Build the three static planes for one segment, and the target that blends them into `liveTex`.
///
/// `planes` are three Float32Arrays of w*h*4 floats — the packed coefficients at u = 0, 1/2, 1.
/// Returns null when a float render target cannot be set up, which leaves the caller on the CPU
/// path rather than rendering nothing.
export function buildCPatchBlend(gl, liveTex, planes, w, h, y0, cw, ch) {
  if (typeof gl.getExtension !== 'function' || !gl.createVertexArray) return null;
  if (!planeFits(gl, w, h) || !planeFits(gl, cw, ch)) return null; // a plane the device cannot hold: the CPU path
  gl.getExtension('EXT_color_buffer_float');
  let pass;
  try {
    pass = getBlendPass(gl);
  } catch {
    return null;
  }
  if (!pass) return null; // still linking: the CPU pack serves this segment
  const fbo = trackGlResource(gl, gl.createFramebuffer());
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, liveTex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok) {
    deleteGlResource(gl, 'Framebuffer', fbo);
    disposeUnused(gl, pass.state);
    return null;
  }
  gl.activeTexture(gl.TEXTURE14);
  // A and B share the run's shape; C is ONE TEXEL A BLOCK and gets its own narrow texture —
  // padding it out to A's width would hand back the whole saving.
  const tex = [
    makePlane(gl, planes[0], w, h),
    makePlane(gl, planes[1], w, h),
    makePlane(gl, planes[2], cw, ch),
  ];
  gl.activeTexture(gl.TEXTURE0);

  noteExternalGlWrite();
  pass.users++;
  return { pass, fbo, tex, w, h, y0, cw, ch };
}

/// One draw. `u` is the segment-local parameter; everything else was uploaded when the segment
/// was planned.
export function runCPatchBlend(gl, tgt, u) {
  // A prepared morph can be disposed before a renderer flushes its queue.
  if (!tgt || tgt.disposed) return false;
  const p = tgt.pass;
  // NO gl.getParameter HERE. Reading GL state back is a synchronous round trip that drains the
  // command queue, and this runs every frame: querying the active texture unit to restore it
  // afterwards would cost more than the pass it protects. Unit 0 is the resting state every
  // draw path here sets for itself, and this runs before any of them bind.
  gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fbo);
  gl.viewport(0, tgt.y0, tgt.w, tgt.h);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.SCISSOR_TEST);
  gl.useProgram(p.prog);
  gl.activeTexture(gl.TEXTURE13);
  gl.bindTexture(gl.TEXTURE_2D, tgt.tex[0]);
  gl.uniform1i(p.uP0, 13);
  gl.activeTexture(gl.TEXTURE14);
  gl.bindTexture(gl.TEXTURE_2D, tgt.tex[1]);
  gl.uniform1i(p.uPH, 14);
  gl.activeTexture(gl.TEXTURE15);
  gl.bindTexture(gl.TEXTURE_2D, tgt.tex[2]);
  gl.uniform1i(p.uP1, 15);
  gl.uniform1i(p.uY0, tgt.y0);
  gl.uniform1i(p.uNB, tgt.w);
  gl.uniform1i(p.uNC, tgt.cw);
  gl.uniform1f(p.uU, u);
  gl.bindVertexArray(p.vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.activeTexture(gl.TEXTURE0);

  noteExternalGlWrite();
  return true;
}

/// Refill an existing target's planes. A morph crosses segment boundaries while it runs, and
/// each crossing is new coefficients for the same rows — so the textures and the framebuffer are
/// reusable, and creating them again at every crossing would be nearly the whole cost of a
/// moving morph on the GPU. Returns false when the shape changed
/// and the target has to be rebuilt.
export function updateCPatchBlend(gl, tgt, planes, w, h, y0, cw, ch) {
  if (!tgt || tgt.w !== w || tgt.h !== h || tgt.y0 !== y0 || tgt.cw !== cw || tgt.ch !== ch)
    return false;
  gl.activeTexture(gl.TEXTURE14);
  for (let i = 0; i < planes.length; i++) {
    gl.bindTexture(gl.TEXTURE_2D, tgt.tex[i]);
    const pw = i === 2 ? cw : w,
      ph = i === 2 ? ch : h;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pw, ph, gl.RGBA, gl.FLOAT, planes[i]);
  }
  gl.activeTexture(gl.TEXTURE0);

  noteExternalGlWrite();
  return true;
}

export function disposeCPatchBlend(gl, tgt) {
  if (!tgt || tgt.disposed) return;
  tgt.disposed = true;
  deleteGlResource(gl, 'Framebuffer', tgt.fbo);
  for (const t of tgt.tex) deleteGlResource(gl, 'Texture', t);
  tgt.tex = [];
  tgt.fbo = null;
  tgt.pass.users--;
  disposeUnused(gl, tgt.pass.state);
}
