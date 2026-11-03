// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// CPU check of the CPatch blend pass's GL state handling.
// A: warm draws keep their one-pixel scissor and paint one full-size draw.
// B: deferred flush restores the caller's framebuffer and enable flags.
// Shader coefficient arithmetic belongs to the development diagnostic; actual
// rendered output is checked by cpatchMorphServeSmoke's cpatchMorphGpuBlend case on physical hardware.
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
import { _toCurvesPair, flushCPatchBlends } from '../src/renderer/cpatchMorphBuild.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
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

// A simple quadratic boundary has a certified whole-interval production plan.
const N = 256;
function svgAt(t) {
  const radius = 40 + 22 * t,
    lo = 100 - radius,
    hi = 100 + radius;
  const d = `M${lo} 100Q${lo} ${lo} 100 ${lo}Q${hi} ${lo} ${hi} 100Q${hi} ${hi} 100 ${hi}Q${lo} ${hi} ${lo} 100Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#123" d="${d}"/></svg>`;
}

const { gl, log } = makeFakeWebgl2(N, N);
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
R.prepareBundle(bb);
// Node has no worker pool; supply the same native certificate the worker returns.
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
R.prepareBundle(bb);
ok(!!bb._cpatchBlend && (bb._cpatchBuilt | 0) > 0, 'the plan is adopted onto the GPU blend route');

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
  const blends = log.filter((e) => e.op === 'blend').length;
  ok(
    full.length === 1 && warm.every((e) => e.scissor[2] === 1 && e.scissor[3] === 1),
    `t=${t}: A. the frame paints the morph once at full size (${full.length} unscissored fill draw(s); ${warm.length} warm draw(s), ${warm.filter((e) => !(e.scissor[2] === 1 && e.scissor[3] === 1)).length} outside a one-pixel scissor; ${blends} blend pass(es))`,
  );
}

// A deferred flush preserves the offscreen target and enabled tests through the renderer state shadow.
{
  const Rc = { gl, _boundDrawFbo: null };
  attachGlState(Rc);
  Rc.bindFb = (target, f) => {
    gl.bindFramebuffer(target, f);
    Rc._boundDrawFbo = f;
  };
  const rt = gl.createFramebuffer();
  Rc.bindFb(gl.FRAMEBUFFER, rt);
  Rc.glEnable(gl.SCISSOR_TEST);
  Rc.glEnable(gl.BLEND);
  Rc.glEnable(gl.DEPTH_TEST);
  Rc._cpatchPending = [{ tgt: bb._cpatchBlend, u: 0.3 }];
  flushCPatchBlends(Rc, gl);
  const bound = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  ok(
    bound === rt,
    `B. a flush started with an offscreen target bound leaves it bound (${bound === rt ? 'the target' : bound === null ? 'the CANVAS' : 'another framebuffer'})`,
  );
  const caps = ['SCISSOR_TEST', 'BLEND', 'DEPTH_TEST'].filter((c) => !gl.isEnabled(gl[c]));
  ok(
    caps.length === 0,
    `B. ...and the tests it had enabled still enabled${caps.length ? ' -- NOT: ' + caps.join(', ') : ''}`,
  );
  Rc.glDisable(gl.SCISSOR_TEST);
  Rc.glDisable(gl.DEPTH_TEST);
  Rc.bindFb(gl.FRAMEBUFFER, null);
}

console.log(
  fail ? `\ncpatchMorphBlendStateSmoke FAIL (${fail})` : '\ncpatchMorphBlendStateSmoke PASS',
);
process.exit(fail ? 1 : 0);
