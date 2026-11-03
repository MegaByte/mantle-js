// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import {
  deleteGlResource,
  deleteProgramWhenLinked,
  trackGlResource,
  resourceScope,
  createTrackedProgram,
} from './contextResources.js';
import { gateFor } from './gpuGate.js';

// GPU texture lerp (gl-memoized): out = mix(texA, texB, uT). Interpolates
// the static src/dst CURVE textures into the live curve texture each setT,
// avoiding a per-frame CPU lerp + texSubImage2D upload. Samples on high
// texture units (14/15) so it never disturbs the renderer's cached fill-pass
// bindings (units 0–9); the RTT updates the live texture's content while its
// unit-0 binding stays valid.
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

// Register a renderer without compiling a program. One helper stays warm per live context generation.
export function retainMorphLerpOwner(gl) {
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

function disposeUnused(gl, state) {
  if (!state.pass && state.owners <= 0 && state.prog) {
    deleteProgramWhenLinked(gl, state.prog);
    state.prog = null;
  }
  const p = state.pass;
  if (!p || p.users > 0 || state.owners > 0) return;
  state.pass = null;
  deleteProgramWhenLinked(gl, p.prog);
  deleteGlResource(gl, 'VertexArray', p.vao);
  deleteGlResource(gl, 'Buffer', p.vb);
}
const LERP_FS =
  '#version 300 es\nprecision highp float; uniform highp sampler2D uA, uB; uniform float uT; out vec4 o; void main(){ ivec2 p = ivec2(gl_FragCoord.xy); o = mix(texelFetch(uA, p, 0), texelFetch(uB, p, 0), uT); }';
// Create, compile and link the helper program, asking nothing of it. The link status is read when the pass is first used.
function startLerpProgram(gl) {
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
    vs = sh(
      gl.VERTEX_SHADER,
      '#version 300 es\nlayout(location=0) in vec2 a; void main(){ gl_Position = vec4(a,0.0,1.0); }',
    );
    // texelFetch on gl_FragCoord, NOT a normalized uv. uv is interpolated across the whole
    // triangle and clip space maps to whatever the VIEWPORT is, so a narrowed viewport would
    // squeeze the entire source plane into the sub-rect. Absolute addressing is what lets the
    // pass cover only the texels that actually change — see `dirty` in buildLerpTarget.
    fs = sh(gl.FRAGMENT_SHADER, LERP_FS);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
  } catch (error) {
    deleteGlResource(gl, 'Program', prog);
    throw error;
  } finally {
    if (vs) deleteGlResource(gl, 'Shader', vs);
    if (fs) deleteGlResource(gl, 'Shader', fs);
  }
  return prog;
}
/// Start the helper's link when a morph is created, so its first use (a setT in play) finds it finished. Only where the driver compiles in
/// parallel: without that, starting a link is waiting for it.
export function beginLerpPass(gl) {
  if (!gl.getExtension || !gl.getExtension('KHR_parallel_shader_compile')) return;
  const state = stateFor(gl);
  if (state.pass || state.prog) return;
  state.prog = startLerpProgram(gl);
}
/// Wait for the helper's link if it was started (the explicit loading call).
/// `soft`: ask nothing of a program that is not ready -- complete and the GPU thread clear, via `ready(prog)` -- and answer how many programs still link.
export function finishLerpPass(gl, soft, ready) {
  const state = stateFor(gl);
  if (!state.prog) return 0;
  if (soft && ready && !ready(state.prog)) return 1;
  gl.getProgramParameter(state.prog, gl.LINK_STATUS);
  return 0;
}
/// The helper, or null while its link is unfinished or the GPU thread is behind (gpuGate.js): nothing is asked of a program that is not ready.
/// The caller has the CPU interpolation for the same texels (shapeMorph.js cpuFallback). Starts the link on the first ask.
export function tryLerpPass(gl) {
  if (!gateFor(gl).nb) return getLerpPass(gl); // blocking mode
  const state = stateFor(gl);
  if (state.pass) return state.pass;
  if (!state.prog) state.prog = startLerpProgram(gl);
  if (!gateFor(gl).ready(state.prog)) return null;
  return getLerpPass(gl);
}
export function getLerpPass(gl) {
  const state = stateFor(gl);
  let p = state.pass;
  if (p) return p;
  const prog = state.prog || startLerpProgram(gl);
  state.prog = null;
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const logs = [gl.getProgramInfoLog(prog)];
    for (const sh of (gl.getAttachedShaders && gl.getAttachedShaders(prog)) || [])
      logs.push(gl.getShaderInfoLog(sh));
    deleteGlResource(gl, 'Program', prog);
    throw new Error('lerpPass link: ' + logs.join(' '));
  }
  const vao = trackGlResource(gl, gl.createVertexArray());
  const vb = trackGlResource(gl, gl.createBuffer(), 'morph');
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // fullscreen tri
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  p = {
    prog,
    vao,
    vb,
    state,
    users: 0,
    uA: gl.getUniformLocation(prog, 'uA'),
    uB: gl.getUniformLocation(prog, 'uB'),
    uT: gl.getUniformLocation(prog, 'uT'),
  };
  state.pass = p;
  return p;
}

export function releaseLerpPass(gl, p) {
  if (!p) return;
  p.users--;
  disposeUnused(gl, p.state);
}
