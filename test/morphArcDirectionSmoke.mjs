// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Full-turn direction alignment is explicit and does not mutate the source bundles.
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import importSvg from '../src/svg/importer.js';
import { createFakeGl } from './_fakeGl.mjs';
import { createBundle } from '../src/renderer/bundle.js';
import { createShapeMorph, createSpriteMorph } from '../src/animation/shapeMorph.js';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const find = (b) => {
  for (let i = 4; i + 20 <= b.length; i += 4) if ((b[i] & 3) === 3 && b[i + 6] > 0) return i;
  throw Error('arc missing');
};
let checked = 0;
for (const k of [2 ** -20, 1, 2 ** 20])
  for (const reverse of [false, true])
    for (const dash of [false, true]) {
      const svg = (s) =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${100 * k} ${100 * k}">${s}</svg>`;
      const st = `id="s" fill="#3677ab" fill-opacity=".55" stroke="#cf3355" stroke-width="${2 * k}" ${dash ? `stroke-dasharray="${5 * k} ${3 * k}"` : ''}`;
      const e = 0.0002,
        a = (t) => `${(50 + 30 * Math.cos(t)) * k} ${(50 + 30 * Math.sin(t)) * k}`;
      const full = svg(`<circle ${st} cx="${50 * k}" cy="${50 * k}" r="${30 * k}"/>`);
      const part = svg(
        `<path ${st} d="M${a(Math.PI + e)} A${30 * k} ${30 * k} 0 1 0 ${a(-Math.PI + 3 * e)}"/>`,
      );
      const { gl } = createFakeGl();
      const A = createBundle(gl, await importSvg(reverse ? part : full)),
        B = createBundle(gl, await importSvg(reverse ? full : part));
      const beforeA = A.curveFloats.slice(),
        beforeB = B.curveFloats.slice();
      for (const align of [undefined, false, true]) {
        const opts = align === undefined ? undefined : { alignFullTurnDirection: align };
        const m = createShapeMorph(gl, A, B, opts),
          ms = m._morphSrc || m.bundle._morphSrc;
        const o = find(ms.mergedCurveF32),
          a = ms.mergedCurveF32[o + 9] - ms.mergedCurveF32[o + 8],
          b = ms.dstCurveF32[o + 9] - ms.dstCurveF32[o + 8];
        assert.equal(Math.sign(a) === Math.sign(b), align === true, 'alignment is opt-in');
        for (let h = 4; h + 20 <= ms.mergedCurveF32.length; h += 4)
          if ((ms.mergedCurveF32[h] & 3) === 3 && ms.mergedCurveF32[h + 6] > 0) {
            assert.equal(
              ms.mergedCurveF32[h],
              ms.dstCurveF32[h],
              'packed subpath-start never interpolates into fill-only',
            );
          }
        if (align)
          for (const t of [0, 0.25, 0.5, 0.75, 1])
            assert(Math.abs(a * (1 - t) + b * t) > 6, 'intermediate sweep stays a full turn');
        m.dispose();
        checked++;
        if (align === true) {
          const sprite = createSpriteMorph(
            gl,
            { bundle: A, sprite: [0, A.numShapes - 1] },
            { bundle: B, sprite: [0, B.numShapes - 1] },
            opts,
          );
          const sms = sprite.bundle._morphSrc,
            so = find(sms.mergedCurveF32);
          assert.equal(
            Math.sign(sms.mergedCurveF32[so + 9] - sms.mergedCurveF32[so + 8]),
            Math.sign(sms.dstCurveF32[so + 9] - sms.dstCurveF32[so + 8]),
          );
          sprite.dispose();
        }
      }
      assert.deepEqual(A.curveFloats, beforeA);
      assert.deepEqual(B.curveFloats, beforeB);
      A.dispose?.();
      B.dispose?.();
    }
console.log(
  `morphArcDirectionSmoke PASS (${checked} plans; defaults, dashed strokes, scales and pair order)`,
);
