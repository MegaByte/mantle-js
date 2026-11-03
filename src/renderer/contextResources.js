// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Resource generations change on context loss; pipeline-state epochs are separate.
import { ledgerFor, peekLedger } from './memoryLedger.js';
import { gateFor } from './gpuGate.js';
const contexts = new WeakMap();
const resources = new WeakMap();

function contextState(gl) {
  let state = contexts.get(gl);
  if (!state) {
    state = { generation: 0, scope: {}, programsCreated: 0 };
    contexts.set(gl, state);
    const canvas = gl.canvas;
    if (canvas && typeof canvas.addEventListener === 'function') {
      canvas.addEventListener(
        'webglcontextlost',
        () => {
          state.generation++;
          state.scope = {};
          state.programsCreated = 0;
          const L = peekLedger(gl);
          if (L) L.reset();
        },
        false,
      );
    }
  }
  return state;
}

/** Current resource generation; shared GL caches must use it with context identity. */
export function resourceGeneration(gl) {
  return contextState(gl).generation;
}

/** Stable identity for resource-sharing groups within one generation. */
export function resourceScope(gl) {
  return contextState(gl).scope;
}

/** Library programs created in this context generation, shared by its renderers.
 * @param {WebGL2RenderingContext} gl @returns {number} */
export function contextProgramsCreated(gl) {
  return contextState(gl).programsCreated;
}

/** Create and track a library program, including helper programs shared by renderers.
 * @param {WebGL2RenderingContext} gl @returns {WebGLProgram|null} */
export function createTrackedProgram(gl) {
  const program = trackGlResource(gl, gl.createProgram());
  if (program) contextState(gl).programsCreated++;
  return program;
}

/** Track a created GL object for context-loss handling and the memory ledger. `cat` names the ledger category of its bytes (default: the
 * innermost ledger scope, else 'other'); `owner` is the object (a bundle, a handle) or string key the bytes are charged to.
 * @template T @param {WebGL2RenderingContext} gl @param {T} resource @param {string} [cat] @param {any} [owner] @returns {T} */
export function trackGlResource(gl, resource, cat, owner) {
  if (resource && (typeof resource === 'object' || typeof resource === 'function')) {
    const state = contextState(gl);
    resources.set(resource, { state, generation: state.generation });
    try {
      ledgerFor(gl).register(resource, cat, owner);
    } catch {
      /* a context the ledger cannot wrap still tracks for loss */
    }
  }
  return resource;
}

/** Delete live allocations, including objects that have not been bound yet.
 * Stale native objects are already released by context loss. Untagged resources
 * retain native deletion behavior, including wrong-context error reporting. */
export function deleteGlResource(gl, kind, resource) {
  const owner = resource && resources.get(resource);
  if (!owner || owner.generation === owner.state.generation) {
    gl['delete' + kind](resource);
    const L = peekLedger(gl);
    if (L && L.noteDeleted) L.noteDeleted(resource); // the same subtraction when the context could not be interposed (a forwarding Proxy)
  }
}

/** Delete a program whose link may still be running on a driver thread (KHR_parallel_shader_compile). Deleting it mid-link makes
 * the browser raise INVALID_VALUE "glGetProgramiv: Program object expected" on the context for a program the host never touched, and
 * that error sits in the host's getError queue. A program that has finished (or a context without the extension) is deleted at once;
 * a pending one is deleted when its link completes, polled on a timer for at most MAX_MS and then deleted regardless. */
export function deleteProgramWhenLinked(gl, program) {
  if (!program) return;
  const khr = gl.getExtension && gl.getExtension('KHR_parallel_shader_compile');
  const owner = resources.get(program);
  const stale = () => owner && owner.generation !== owner.state.generation;
  // (Non-blocking renderers ask through the gate -- complete AND the GPU thread clear: a poll behind a pipeline build is itself a wait.)
  const gate = khr ? gateFor(gl) : null;
  const finished = () =>
    gate && gate.nb
      ? gate.ready(program)
      : gl.getProgramParameter(program, khr.COMPLETION_STATUS_KHR);
  if (!khr || stale() || finished()) {
    deleteGlResource(gl, 'Program', program);
    return;
  }
  const t0 = Date.now(),
    MAX_MS = 20000;
  const poll = () => {
    if (stale() || Date.now() - t0 > MAX_MS || finished()) {
      deleteGlResource(gl, 'Program', program);
      return;
    }
    setTimeout(poll, 16);
  };
  setTimeout(poll, 16);
}
