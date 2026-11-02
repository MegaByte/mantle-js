// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Mixed CPatch morph rows keep the curve plane current when strokes or raw
// fills read it. Fully prepared fills can skip those uploads. This checks
// production CPU upload state; physical image coverage has separate GPU tests.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
import { makeFakeWebgl2 } from './_fakeWebgl2.mjs';
import { importSvg, createBundle, createRenderer, createShapeMorph } from '../src/index.js';
import { SHADER_FILENAMES } from '../src/shaders/index.js';
import { certifyPolynomialMorph } from '../src/core/polynomialMorph.js';
import { _toCurvesPair } from '../src/renderer/cpatchMorphBuild.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const shaders = {};
for (const [k, f] of SHADER_FILENAMES) {
  try {
    shaders[k] = readFileSync(path.join(ROOT, 'src/shaders/generated', f), 'utf8');
  } catch {
    /* optional program */
  }
}
const N = 128;
const PA = 'M60 100Q60 60 100 60Q140 60 140 100Q140 140 100 140Q60 140 60 100Z';
const PB = 'M50 110Q50 50 110 50Q170 50 170 110Q170 170 110 170Q50 170 50 110Z';

async function side(pin, a, b) {
  const { gl } = makeFakeWebgl2(N, N);
  const R = createRenderer(gl, shaders, {
    cpatchFill: pin === 'cpatch',
    cpatchOpts: { interiorN: 8, gpuBlend: false },
    aacFill: false,
    unifiedMorph: true,
  });
  if (R.ready) await R.ready;
  R.setFillEngine({ route: pin, kernel: 'slug' });
  const m = createShapeMorph(
    gl,
    createBundle(gl, await importSvg(a)),
    createBundle(gl, await importSvg(b)),
    { cpuLerp: true },
  );
  const bb = m.bundle || m;
  m.setT(0);
  R.prepareBundle(bb);
  return { gl, R, m, bb };
}
function planAll(bb, declined) {
  const ms = bb._morphSrc,
    shapes = [];
  for (let s = 0; s < ms.curveRanges.length; s++) {
    const r = ms.curveRanges[s];
    if (!r) continue;
    const ca = curveRangeToContours(ms.mergedCurveF32, r.begin, r.end, ms.dstCurveF32),
      cb = curveRangeToContours(ms.dstCurveF32, r.begin, r.end, ms.mergedCurveF32);
    if (!ca || ca.length !== 1 || cb.length !== 1) continue;
    const pair = _toCurvesPair(ca[0], cb[0]);
    if (!pair) continue;
    const A = pair.A,
      B = pair.B,
      nativeArea = certifyPolynomialMorph(A, B);
    const plan = nativeArea ? [{ t0: 0, t1: 1, nativeArea }] : null;
    shapes[s] =
      plan && !declined.includes(s)
        ? { A, B, plan, seg: -1, pack: null, first: 0, plan2: null, planBase: -1 }
        : null;
  }
  bb._cpatchMorphPlan = { shapes, planned: shapes.filter(Boolean).length, tolPx: null };
  bb._cpatchMorphT = undefined;
}
const frames = (s, t, n = 6) => {
  s.m.setT(t);
  for (let i = 0; i < n; i++) {
    s.R.prepareBundle(s.bb);
    s.R.setViewport(N, N);
    s.R.beginFrame([1, 1, 1, 1]);
    s.R.drawBundle(s.m);
    s.R.endFrame();
  }
};

// rows: the shape rows whose curve ranges a non-CPatch entry reads; declined: shape indices whose plan is withheld; expectReadsPlane: lerp stays on.
async function run(label, a, b, rows, declined, expectReadsPlane) {
  const C = await side('cpatch', a, b),
    S = await side('none', a, b);
  planAll(C.bb, declined);
  const ms = C.bb._morphSrc;
  for (const t of [0.25, 0.5, 0.75]) {
    frames(C, t);
    frames(S, t, 2);
    ok(
      (C.bb._cpatchBuilt | 0) > 0,
      `${label}, t=${t}: the morph is CPatch-posed (${C.bb._cpatchBuilt} built)`,
    );
    ok(
      !!ms.skipCurveUploads === !expectReadsPlane,
      `${label}, t=${t}: the curve lerp is ${expectReadsPlane ? 'ON (a row reads the plane)' : 'OFF (every row is a CPatch fill)'}`,
    );
    for (const s of rows) {
      const r = ms.curveRanges[s],
        got = C.bb.curveTex.data,
        want = S.bb.curveTex.data;
      let worst = 0;
      for (let i = r.begin; i < r.end; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]));
      ok(
        worst < 1e-6,
        `${label}, t=${t}: row ${s}'s curve floats [${r.begin}, ${r.end}) equal the Slug morph's pose (worst difference ${worst.toExponential(2)})`,
      );
    }
  }
}
const one = (d, stroke, w) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="${d}" fill="#2f6fd6"${stroke ? ` stroke="#a02b2b" stroke-width="${w}"` : ''}/></svg>`;
const two = (d, e) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="${d}" fill="#2f6fd6"/><path d="${e}" fill="#d6532f" transform="translate(20 10)"/></svg>`;
await run(
  'fill + stroke (the stroke row keeps its cover quad)',
  one(PA, true, 2),
  one(PB, true, 14),
  [1],
  [],
  true,
);
await run(
  'two fills, the second plan declined (Slug cover)',
  two(PA, PA),
  two(PB, PB),
  [1],
  [1],
  true,
);
await run(
  'fill only, planned (nothing else reads the plane)',
  one(PA, false),
  one(PB, false),
  [],
  [],
  false,
);
console.log(
  fail ? `\ncpatchMorphMixedRowsSmoke FAIL (${fail})` : '\ncpatchMorphMixedRowsSmoke PASS',
);
process.exit(fail ? 1 : 0);
