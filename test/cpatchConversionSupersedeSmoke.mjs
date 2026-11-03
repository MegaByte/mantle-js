// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// A late conversion reply must not overwrite a replacement bake or conversion.
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import importSvg from '../src/svg/importer.js';
import { buildCPatchBundle, headlessCPatchBundle } from '../src/renderer/cpatchBuild.js';
import { releaseFillMeshes, MESH_OWNER } from '../src/renderer/fillMeshOwner.js';
import { disposeCpatchPool } from '../src/renderer/cpatchWorkerPool.js';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__CP_NO_AREA = 1;
globalThis.__CP_POOL_N = 1;
const pending = [];
globalThis.Worker = class {
  postMessage(data) {
    pending.push({ worker: this, data });
  }
  terminate() {}
};
const sections = await importSvg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 Q50 -10 90 10 Q65 50 90 90 Q50 110 10 90 Q35 50 10 10Z"/></svg>',
);
const flush = async () => {
  while (pending.length) {
    const { worker, data } = pending.shift();
    worker.onmessage({ data: { id: data.id, out: [] } });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
};
try {
  for (const replacement of [undefined, new Map([['replacement', []]]), 'pending']) {
    const bundle = headlessCPatchBundle(sections);
    assert.equal(buildCPatchBundle({}, bundle, { collectSlice: 0, stallReportMs: 0 }), false);
    assert.equal(bundle._cpatchConv, 'pending');
    assert(pending.length > 0);
    bundle._cpatchConv = replacement;
    if (replacement === 'pending') bundle._cpatchConvWatch = {};
    bundle._cpatchRetry = false;
    await flush();
    assert.ok(bundle._cpatchConv === replacement, 'old reply cannot replace newer state');
    assert.equal(bundle._cpatchRetry, false, 'old reply cannot re-open the build gate');
  }
  // Real geometry preparation: an uncached rebuild must preserve its source
  // precision and emit identical uploaded coefficients and vertices.
  {
    const sections = await importSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#468" fill-opacity=".6" d="M375.40464418 564.35065176C375.40464418 564.35065176 383.87974641999995 572.825754 377.52341974 589.77595848C377.52341974 589.77595848 352.09811301999997 618.02629928 355.62940562 642.74534748Z"/></svg>',
    );
    const bundle = headlessCPatchBundle(sections),
      source = bundle.curveFloats64;
    const planes = [];
    const gl = new Proxy(
      {
        texImage2D(...args) {
          planes.push(new Float32Array(args.at(-1)));
        },
      },
      { get: (obj, key) => (key in obj ? obj[key] : /^[A-Z_0-9]+$/.test(key) ? 0 : () => null) },
    );
    const build = () => {
      assert.equal(buildCPatchBundle(gl, bundle, { pool: false }), true);
      return {
        cells: bundle._cpatchCells,
        verts: bundle._lbMeshes.map((m) => m && Array.from(m.verts)),
        plane: Array.from(planes.at(-1)),
      };
    };
    const first = build();
    assert.equal(
      bundle.curveFloats64,
      source,
      'retain the authored precision for later route changes',
    );
    releaseFillMeshes(bundle, MESH_OWNER.CPATCH);
    assert.deepEqual(build(), first, 'unchanged geometry has an identical uncached rebuild');
  }
  console.log('CPatch conversion supersession and rebuild PASS');
} finally {
  disposeCpatchPool();
  delete globalThis.Worker;
}
