// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Development coefficient-model comparison with the production CPU pack.
// Runs Float32 shader arithmetic on the CPU; never release/GPU validation.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
import { makeFakeWebgl2 } from './_fakeWebgl2.mjs';
import { installCpatchBlendShaderModel } from './_cpatchBlendShaderModel.mjs';
import { importSvg, createBundle, createRenderer, createShapeMorph } from '../src/index.js';
import { SHADER_FILENAMES } from '../src/shaders/index.js';
import { certifyPolynomialMorph } from '../src/core/polynomialMorph.js';
import {
  _toCurvesPair,
  flushCPatchBlends,
  setCPatchMorphT,
} from '../src/renderer/cpatchMorphBuild.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { CP_BLOCK_TEXELS } from '../src/renderer/cpatchPack.js';
import { attachGlState } from '../src/renderer/glState.js';

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

// A simple quadratic boundary: the production prepared route admits a CPatch morph only over a native whole-interval
// certificate (the worker's answer; an uncertified moving interval is declined, 'moving-interval-uncertified').
const N = 256;
function svgAt(t) {
  const radius = 40 + 22 * t,
    lo = 100 - radius,
    hi = 100 + radius;
  const d = `M${lo} 100Q${lo} ${lo} 100 ${lo}Q${hi} ${lo} ${hi} 100Q${hi} ${hi} 100 ${hi}Q${lo} ${hi} ${lo} 100Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#123" d="${d}"/></svg>`;
}

const fake = makeFakeWebgl2(N, N);
installCpatchBlendShaderModel(fake);
const { gl, log, hook } = fake;
const R = createRenderer(gl, shaders, {
  cpatchFill: true,
  cpatchOpts: { interiorN: 8, gpuBlend: true },
  aacFill: false,
  unifiedMorph: true,
});
if (R.ready) await R.ready;
R.setLoopBlinnFill('on');
const m = createShapeMorph(
  gl,
  createBundle(gl, await importSvg(svgAt(0))),
  createBundle(gl, await importSvg(svgAt(1))),
);
const bb = m.bundle || m;
m.setT(0);
R.prepareBundle(bb); // asks for the plan; node has no pool, so it lands here:
const ms = bb._morphSrc,
  r0 = ms.curveRanges[0];
const pair = _toCurvesPair(
  curveRangeToContours(ms.mergedCurveF32, r0.begin, r0.end)[0],
  curveRangeToContours(ms.dstCurveF32, r0.begin, r0.end)[0],
);
const A = pair.A,
  B = pair.B;
const nativeArea = certifyPolynomialMorph(A, B);
ok(!!nativeArea, 'the quadratic oval certifies over the full morph interval');
const plan = nativeArea ? [{ t0: 0, t1: 1, nativeArea }] : null;
bb._cpatchMorphPlan = {
  shapes: [{ A, B, plan, seg: -1, pack: null, first: 0, plan2: null, planBase: -1 }],
  planned: 1,
  tolPx: null,
};
bb._cpatchMorphT = undefined;
R.prepareBundle(bb); // the prepare that sees it: the pose at t = 0, and its blend queued
ok(!!bb._cpatchBlend && (bb._cpatchBuilt | 0) > 0, 'the plan is adopted onto the GPU blend route');

// What the real draw samples, against the CPU pack of the same pose.
const packAt = (t) => {
  const probe = {
    shapes: [{ A, B, plan, seg: -1, pack: null, first: 0, plan2: null, planBase: -1 }],
  };
  setCPatchMorphT(probe, t, bb._morphSrc ? morphShape(bb).first : 0, {}, true);
  return probe.shapes[0].pack.texels;
};
const morphShape = (b) => b._cpatchMorphPlan.shapes[0];
hook.onDraw = () => {
  const sh = morphShape(bb),
    tex = bb.curveTex;
  if (!sh || !sh.pack || !tex.data) return null;
  const at = sh.first * CP_BLOCK_TEXELS * 4;
  return tex.data.slice(at, at + sh.pack.texels.length);
};
for (const t of [0.2, 0.45, 0.7, 0.2]) {
  m.setT(t);
  log.length = 0;
  let drew = 0;
  for (let i = 0; i < 20 && !drew; i++) {
    R.prepareBundle(bb);
    const before = ((R.debugStats.engines || {}).draws || {}).cpatch | 0;
    R.setViewport(N, N);
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(m);
    R.endFrame();
    if (R.precompileFills) R.precompileFills();
    drew = (((R.debugStats.engines || {}).draws || {}).cpatch | 0) - before;
  }
  ok(drew > 0, `t=${t}: the morph draws with CPatch`);
  const fills = log.filter((e) => e.op === 'draw' && e.count >= 6);
  const full = fills.filter((e) => !e.scissor),
    warm = fills.filter((e) => e.scissor);
  const want = packAt(t),
    got = full.length ? full[full.length - 1].sample : null;
  let worst = got ? 0 : Infinity;
  if (got)
    for (let k = 0; k < want.length; k++)
      worst = Math.max(worst, Math.abs(got[k] - want[k]) / Math.max(1, Math.abs(want[k])));
  ok(
    worst <= 1e-4,
    `t=${t}: C. the draw samples the pose: the CPatch run equals the CPU pack (worst relative ${worst.toExponential(2)})`,
  );
}

console.log(
  fail
    ? `\ncpatchMorphBlendModelDiagnostic FAIL (${fail})`
    : '\ncpatchMorphBlendModelDiagnostic PASS',
);
process.exit(fail ? 1 : 0);
