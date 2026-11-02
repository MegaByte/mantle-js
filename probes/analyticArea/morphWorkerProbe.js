// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { importSvg, createBundle, createShapeMorph } from '../../src/index.js';
import { flatMorphPaintSvg, morphPieceDrawScope } from './morphPaintScope.js';
import { prepareRadialPolynomialMorph } from './morphFanPreparation.js';
function workerSections(b) {
  const meta = new ArrayBuffer(32 + b.metaFloats.byteLength),
    dv = new DataView(meta);
  dv.setUint32(0, b.numShapes, true);
  for (let k = 0; k < 4; k++) dv.setFloat32(4 + k * 4, b.globalBBox[k], true);
  new Float32Array(meta, 32).set(b.metaFloats);
  return {
    meta,
    metaFloatsPerShape: b.metaFloatsPerShape,
    curves: b.curveFloats.buffer.slice(
      b.curveFloats.byteOffset,
      b.curveFloats.byteOffset + b.curveFloats.byteLength,
    ),
    curveRangesByShape: b.curveRangesByShape.map((r) => ({ ...r })),
    shapeIds: b.shapeIds,
  };
}
export async function probeMorphWorker(gl, r, c, frame) {
  // This diagnostic proves deferred preparation keeps using the existing raw
  // morph. It is not a new production draw route or a release default.
  r.setFillEngine({ route: 'none', kernel: 'aac' });
  r.setLoopBlinnMorphFill('off');
  const endpoints = [];
  let morph, worker;
  try {
    for (const svg of [c.svg, c.morphSvgDst]) {
      const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
      b.globalBBox = c.bbox.slice();
      endpoints.push(b);
    }
    morph = createShapeMorph(gl, ...endpoints);
    morph.bundle._morphSrc.gpuSmallPlanes = true;
    morph.setT(c.morphT ?? 0.5);
    const a = {
      engine: 'aac',
      unified: true,
      defines: [],
      bundle: morph.bundle,
      drawOptions: c.drawOptions,
    };
    a.bundle.probeMorph = morph;
    r.prepareBundle(a.bundle);
    for (let i = 0; i < 4; i++) {
      await frame(a);
      r.precompileFills();
    }
    if (!morph.usesGpuCurveLerp)
      throw Error('Deferred fallback did not use GPU morph interpolation');
    const onMain = c.morphPreparationOnMainThread === true;
    if (onMain && !c.morphPreparationOptions?.radialFan)
      throw Error('Only the bounded radial fan probe supports main-thread preparation');
    let settled = null;
    if (!onMain) {
      worker = new Worker(new URL('./morphPreparation.worker.js', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (e) => {
        settled = e.data;
      };
      worker.onerror = (e) => {
        settled = { ok: false, reason: e.message || 'worker error' };
      };
    }
    const start = performance.now(),
      drawsBefore = r.debugStats.engines.draws.aac || 0,
      cycle = c.morphCycle || [0.05, 0.25, 0.45, 0.65, 0.85, 0.95];
    let fallbackFrames = 0;
    let scope,
      sections,
      declineReason = null;
    try {
      morphPieceDrawScope(c.drawOptions);
      scope = [flatMorphPaintSvg(c.svg), flatMorphPaintSvg(c.morphSvgDst)];
      if (scope[0].alpha !== scope[1].alpha) throw Error('Changing group opacity unsupported');
      sections = [];
      for (let i = 0; i < 2; i++) {
        if (!scope[i].changed) {
          sections.push(workerSections(endpoints[i]));
          continue;
        }
        const s = await importSvg(scope[i].svg, { preserveViewport: true });
        sections.push({
          meta: s.meta,
          metaFloatsPerShape: s.metaFloatsPerShape,
          curves: s.curves,
          curveRangesByShape: s.curveRangesByShape,
          shapeIds: s.shapeIds,
        });
      }
    } catch (e) {
      declineReason = e.message;
    }
    const scopeImportMs = performance.now() - start;
    if (onMain) {
      try {
        if (declineReason) throw Error(declineReason);
        settled = {
          ok: true,
          ...prepareRadialPolynomialMorph(...sections, c.morphPreparationOptions),
        };
      } catch (e) {
        settled = { ok: false, reason: e.message };
      }
    } else
      worker.postMessage({
        sectionsA: sections?.[0],
        sectionsB: sections?.[1],
        options: c.morphPreparationOptions,
        declineReason,
      });
    while (!settled) {
      if (performance.now() - start > 20000)
        throw Error('Morph worker exceeded diagnostic deadline');
      morph.setT(cycle[fallbackFrames % cycle.length]);
      await frame(a);
      fallbackFrames++;
    }
    const stats = {
      status: settled.ok ? 'ready' : 'declined',
      execution: onMain ? 'main thread' : 'worker',
      wallMs: performance.now() - start,
      fallbackFrames,
      fallbackAacDraws: (r.debugStats.engines.draws.aac || 0) - drawsBefore,
      usesGpuCurveLerp: morph.usesGpuCurveLerp,
      reason: settled.reason || null,
      preparation: settled.stats || null,
      scopeImportMs,
      groupAlpha: scope?.[0].alpha ?? null,
      scope: onMain
        ? 'Scope import and synchronous radial-fan proof/serialization on main thread; endpoint bundle import and prepared upload separate'
        : 'Worker dispatch/clone/certification/serialization while raw AAC renders changing poses; shaders warmed before dispatch; bounded GPU duty and idle included in wall time',
    };
    if (settled.ok) {
      c.morphPieceIntervals = settled.intervals;
      c.morphPreparation = settled.stats;
      c.pieceGroupAlpha = scope[0].alpha;
    } else c.arms = c.arms.filter((a) => !a.morphPieceAtlas);
    return stats;
  } finally {
    worker?.terminate();
    morph?.dispose();
    for (const b of endpoints) b.dispose();
  }
}
