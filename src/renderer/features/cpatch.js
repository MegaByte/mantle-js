// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// features/cpatch.js — the CPatch fill engine: converts a shape to half-space patches (static) or plans a morph's coefficients
// (animated), and runs its conversion workers. Importing this module registers it; the renderer core does not carry it.
//
//   import '@kontek/mantle/renderer/features/cpatch';
//   const r = createRenderer(gl, shaders, { cpatchFill: true });      // or cpatchAuto, or setFillEngine({ route: 'cpatch' })
//
// Asking for CPatch without it throws, naming this import.

import { buildCPatchBundle, cpatchConvStats } from '../cpatchBuild.js';
import { applyCPatchMorphFrame, flushCPatchBlends } from '../cpatchMorphBuild.js';
import { warmCpatchPool, cpatchPoolStats } from '../cpatchWorkerPool.js';
import { registerRendererFeature } from '../featureRegistry.js';

export function registerCpatch() {
  // memoryStats: what getMemoryStats() reads from a registered feature (its GPU bytes are already in the ledger: the grown curve plane is bundle bytes,
  // the morph blend targets are 'morph'); the conversion pool's jobs in flight are its CPU side.
  registerRendererFeature('cpatch', {
    buildCPatchBundle,
    cpatchConvStats,
    applyCPatchMorphFrame,
    flushCPatchBlends,
    warmCpatchPool,
    memoryStats: () => {
      const p = cpatchPoolStats();
      return {
        inflight: p.inflight,
        queued: p.queued,
        posted: p.posted,
        answered: p.answered,
        failed: p.failed,
      };
    },
  });
}
registerCpatch();
