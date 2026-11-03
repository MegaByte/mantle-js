// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import {
  trackGlResource,
  deleteGlResource,
  resourceGeneration,
  resourceScope,
} from '../src/renderer/contextResources.js';
export async function run(offscreen = false) {
  const rows = [],
    kinds = [
      'Buffer',
      'Texture',
      'Program',
      'Shader',
      'VertexArray',
      'Framebuffer',
      'Renderbuffer',
      'Query',
      'Sampler',
      'TransformFeedback',
      'Sync',
    ];
  const makeCanvas = () =>
    offscreen ? new OffscreenCanvas(8, 8) : document.createElement('canvas');
  const canvas = makeCanvas();
  canvas.width = canvas.height = 8;
  if (!offscreen) document.body.append(canvas);
  const gl = canvas.getContext('webgl2'),
    otherCanvas = makeCanvas(),
    other = otherCanvas.getContext('webgl2');
  const ext = gl.getExtension('WEBGL_lose_context'),
    dbg = gl.getExtension('WEBGL_debug_renderer_info'),
    device = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
  if (/software|swiftshader|llvmpipe/i.test(device)) throw Error('Physical GPU required');
  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  const calls = [];
  for (const kind of kinds) {
    const native = gl['delete' + kind].bind(gl);
    gl['delete' + kind] = (value) => {
      calls.push({ kind, value });
      native(value);
    };
  }
  const make = (kind) =>
    trackGlResource(
      gl,
      kind === 'Shader'
        ? gl.createShader(gl.VERTEX_SHADER)
        : kind === 'Sync'
          ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
          : gl['create' + kind](),
    );
  const error = (label) => {
    const e = gl.getError();
    if (e) throw Error(label + ' GL ' + e);
  };
  const otherScope = resourceScope(other),
    firstScope = resourceScope(gl);
  const event = (name) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(name + ' timeout')), 10000);
      canvas.addEventListener(
        name,
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  const stale = [];
  for (let cycle = 0; cycle < 2; cycle++) {
    for (const kind of kinds) {
      const value = make(kind),
        validBeforeUse = gl['is' + kind](value),
        before = calls.length;
      deleteGlResource(gl, kind, value);
      error('unused ' + kind);
      if (calls.length !== before + 1) throw Error('Unused allocation not deleted');
      rows.push({ cycle, kind, validBeforeUse, unusedNativeDeletes: 1 });
    }
    for (const kind of kinds) stale.push({ kind, value: make(kind) });
    const generation = resourceGeneration(gl),
      scope = resourceScope(gl),
      lost = event('webglcontextlost');
    ext.loseContext();
    await lost;
    const lostStatus = gl.getError();
    if (lostStatus && lostStatus !== gl.CONTEXT_LOST_WEBGL) throw Error('Unexpected loss error');
    await new Promise((r) => setTimeout(r, 100));
    const restored = event('webglcontextrestored');
    ext.restoreContext();
    await restored;
    error('restored');
    gl.viewport(0, 0, 8, 8);
    gl.clearColor(0.125, 0.25, 0.5, 0.75);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    error('restored clear');
    if (pixel.some((v, i) => Math.abs(v - [32, 64, 128, 191][i]) > 1))
      throw Error('Restored native clear mismatch');
    if (
      resourceGeneration(gl) !== generation + 1 ||
      resourceScope(gl) === scope ||
      resourceScope(other) !== otherScope
    )
      throw Error('Generation/scope isolation');
    const before = calls.length;
    for (const { kind, value } of stale) deleteGlResource(gl, kind, value);
    error('stale deletes');
    if (calls.length !== before) throw Error('Stale native deletion');
    for (const kind of kinds) {
      const value = make(kind),
        before = calls.length;
      deleteGlResource(gl, kind, value);
      error('fresh ' + kind);
      if (calls.length !== before + 1) throw Error('Fresh allocation not deleted');
    }
  }
  const foreign = make('Buffer');
  deleteGlResource(other, 'Buffer', foreign);
  const wrongContextError = other.getError();
  if (wrongContextError !== other.INVALID_OPERATION)
    throw Error('Native wrong-context validation was suppressed');
  deleteGlResource(gl, 'Buffer', foreign);
  error('foreign cleanup');
  if (resourceScope(gl) === firstScope) throw Error('Stale scope after restoration');
  const result = {
    passed: true,
    device,
    offscreen,
    rows,
    cycles: 2,
    nativeFreshDeletes: 44,
    staleNativeDeletes: 0,
    wrongContextError,
    generation: resourceGeneration(gl),
  };
  ext.loseContext();
  other.getExtension('WEBGL_lose_context').loseContext();
  canvas.remove?.();
  return result;
}
