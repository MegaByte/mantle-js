// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Equal byte lengths do not make differently typed curve records compatible.
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import importSvg from '../src/svg/importer.js';
import { createFakeGl } from './_fakeGl.mjs';
import { createBundle } from '../src/renderer/bundle.js';
import { buildMorphPlan } from '../src/core/morphCore.js';
Object.assign(globalThis, { DOMParser, XMLSerializer });
const paths = ['M10 10Q40 20 80 70L10 10Z', 'M10 10C40 20 50 30 80 70L10 10Z'];
for (const named of [false, true])
  for (const reverse of [false, true])
    for (const curvature of [false, true]) {
      const { gl } = createFakeGl();
      const bundle = async (d) =>
        createBundle(
          gl,
          await importSvg(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path ${named ? 'id="s"' : ''} ${curvature ? 'fill="none" stroke="red" stroke-width="2" stroke-linejoin="arcs"' : 'fill="red"'} d="${d}"/></svg>`,
          ),
        );
      const A = await bundle(paths[+reverse]),
        B = await bundle(paths[1 - +reverse]);
      assert.equal(
        A.curveRangesByShape[0].end - A.curveRangesByShape[0].begin,
        B.curveRangesByShape[0].end - B.curveRangesByShape[0].begin,
      );
      for (const range of [false, true]) {
        const plan = buildMorphPlan(A, B, range ? [0, 0] : null, range ? [0, 0] : null);
        assert.equal(plan.matched.length, 0, 'different record types must not interpolate');
        assert.equal(plan.srcOnly.length, 1);
        assert.equal(plan.dstOnly.length, 1);
      }
      const same = buildMorphPlan(A, A);
      assert.equal(same.matched.length, 1, 'compatible geometry still interpolates');
      A.dispose();
      B.dispose();
    }
console.log('morphRecordCompatibilitySmoke PASS');
