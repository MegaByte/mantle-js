// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// convolveUniformKernelSmoke — feConvolveMatrix's kernel reaches the pass as a uniform array,
// flipped on the CPU into a fixed 5-wide stride, and uPreserveAlpha is branched on outside the
// tap loops.
//
// Fetching each of up to 25 weights from a 7-texel RGBA32F row with an integer divide and a channel
// if-chain doubles the texture instructions per pixel, and running both accumulators on every tap
// makes the default path pay an unpremultiply divide per tap it never reads. So convolve.frag's kernel
// is `uniform float uKernel[25]`, written per pass by filterGraph/convolveKernel.js, and there is
// no kernel texture: not on the bundle (kernelTex) and not memoized on a graph node (_kTex).
//
// (1) THE SHADER, the texture-kernel text against the shipped one on the CPU in float32 (test/_fragEmu.mjs,
//     cases in _filtperfCases.mjs: orders 1x5 to 5x5, off-center targets, all three edge modes, preserveAlpha on and
//     off, signed and non-normalized kernels, an input with color at alpha 0): BIT-identical output,
//     texelFetch calls per pixel orderX*orderY -> 0, texture() calls unchanged.
// (2) THE DATAFLOW, the real renderer on test/_fakeGl.mjs, classic and unified routes, for a lone
//     feConvolveMatrix (the single-primitive route, kind 6) and examples/_convolve.svg's graph: every
//     convolve draw sets uKernel to the flipped imported kernel and neither uKernelTex nor uKernelRow,
//     and nothing holds a kernel texture. A tree with a kernel texture fails this part.
// (1b) holds the renderer-level timing arm (probes/filtperf/convolveKernel.arms.json) to the shipped output and
//     the texture-kernel fetch count, so the arm cannot time something else.
// On the GPU: filterPassParityRenderSmoke (the same cases as one pass each) and filterVisualSmoke's
// fe-convolve-matrix (render lane).
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, emulateCase } from './_fragEmu.mjs';
import { filtperfCases } from './_filtperfCases.mjs';
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';
import { flipConvolveKernel } from '../src/filterGraph/convolveKernel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

console.log('\n  (1) the shader, texture-kernel text against the shipped one, on the CPU:');
if (!hasCxx()) console.log('  SKIP: no C++ compiler for the shader emulator');
else {
  for (const c of filtperfCases(['convolveKernel'])) {
    let r;
    try {
      r = emulateCase(ROOT, c);
    } catch (e) {
      ok(false, `${c.name}: ${String(e.message).split('\n')[0]}`);
      continue;
    }
    const w = r.work;
    ok(
      r.bits === 0,
      `${c.name}: bit-identical over ${r.n} pixels (${r.bits} float bits differ, ${r.ch8} channels at 8 bits)` +
        (r.off ? ` -- ${JSON.stringify(r.off)}` : ''),
    );
    ok(
      w.old.texelFetch === c.taps && w.new.texelFetch === 0 && w.new.texture === w.old.texture,
      `${c.name}: texture instructions per pixel ${w.old.texture + w.old.texelFetch} -> ${w.new.texture + w.new.texelFetch} ` +
        `(kernel fetches ${w.old.texelFetch} -> ${w.new.texelFetch}, image taps ${w.old.texture} -> ${w.new.texture})`,
    );
  }
}

// The renderer-level timing arm (probes/filtperf/convolveKernel.arms.json) is the shipped interface carrying the
// texture-kernel costs. Hold it to that: the shipped text's output, and the texture-kernel text's fetch count.
if (hasCxx()) {
  console.log(
    '\n  (1b) the timing arm probes/filtperf/convolveKernel-baseCost.convolve.frag.glsl against the shipped text:',
  );
  for (const c of filtperfCases(['convolveKernel'])) {
    const arm = Object.assign({}, c, {
      frag: { old: 'probes/filtperf/convolveKernel-baseCost.convolve.frag.glsl', new: c.frag.new },
      inputs: { old: c.inputs.new, new: c.inputs.new },
    });
    let r;
    try {
      r = emulateCase(ROOT, arm);
    } catch (e) {
      ok(false, `${c.name} (timing arm): ${String(e.message).split('\n')[0]}`);
      continue;
    }
    const w = r.work;
    ok(
      r.bits === 0 && w.old.texelFetch === c.taps,
      `${c.name}: the arm is bit-identical (${r.bits} bits differ) ` +
        `and fetches ${w.old.texelFetch} kernel texels per pixel, as the texture-kernel text does (${c.taps})`,
    );
  }
}

console.log('\n  (2) the dataflow, the real renderer on the recording fake GL:');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg, createBundle, createRenderer } = await import('../src/index.js');
const N = 64;
const LONE =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}"><defs><filter id="k" color-interpolation-filters="sRGB">` +
  '<feConvolveMatrix order="3 2" kernelMatrix="1 2 3 4 5 6" divisor="21" bias="0.1" targetX="1" targetY="0" preserveAlpha="true"/>' +
  `</filter></defs><circle cx="32" cy="32" r="20" fill="red" filter="url(#k)"/></svg>`;
const GRAPH = readFileSync(path.join(ROOT, 'examples/_convolve.svg'), 'utf8');
const FIX = [
  {
    name: 'a lone feConvolveMatrix (single-primitive route)',
    svg: LONE,
    want: { k: [1, 2, 3, 4, 5, 6], ox: 3, oy: 2 },
    single: true,
  },
  {
    name: 'examples/_convolve.svg (graph route)',
    svg: GRAPH,
    want: { k: [-1, 0, 1, -2, 0, 2, -1, 0, 1], ox: 3, oy: 3 },
  },
];
for (const fx of FIX) {
  for (const route of ['none', 'lb']) {
    const F = createFakeGl({ width: N, height: N });
    const R = createRenderer(F.gl, taggedShaderSources(), {});
    R.setFillEngine({ route, kernel: 'slug' });
    const b = createBundle(F.gl, await importSvg(fx.svg, { preserveViewport: true }));
    if (R.prepareBundle) R.prepareBundle(b);
    if (R.awaitLbReady) {
      try {
        await R.awaitLbReady(b, 20000);
      } catch {
        /* the draw count reports it */
      }
    }
    R.prewarmBundle(b);
    R.precompileFills();
    R.setViewport(N, N);
    for (let i = 0; i < 3; i++) {
      F.setFrame(i);
      R.beginFrame([0, 0, 0, 0]);
      R.drawBundle(b, { worldMatrix: [1, 0, 0, 0, 1, 0, 0.01 * i, 0, 1] }); // moving: every filter misses
      R.endFrame();
    }
    const tag = `${fx.name}, route ${route}`;
    const isSingle = b.drawList.some((o) => o.filterId && !o.filterGraphId);
    ok(
      isSingle === !!fx.single,
      `${tag}: imports on the ${fx.single ? 'single-primitive' : 'graph'} route`,
    );
    const draws = F.log.filter((e) => e.op === 'draw' && F.progKeys(e.prog).has('convolveFrag'));
    const want = Array.from(
      flipConvolveKernel(
        Float32Array.from(fx.want.k),
        0,
        fx.want.ox,
        fx.want.oy,
        new Float32Array(25),
      ),
    );
    const bad = draws.filter(
      (e) =>
        !e.uni.uKernel ||
        e.uni.uKernel.length !== 25 ||
        e.uni.uKernel.some((v, i) => Math.fround(v) !== Math.fround(want[i])) ||
        'uKernelTex' in e.uni ||
        'uKernelRow' in e.uni,
    );
    ok(
      draws.length > 0 && !bad.length,
      `${tag}: ${draws.length} convolve draw(s), each with uKernel = the flipped kernel ` +
        `and no kernel texture or row` +
        (bad.length ? ` -- first: ${JSON.stringify(bad[0].uni)}` : ''),
    );
    const kTex = [];
    for (const g of b.filterGraphs || [])
      for (const n of (g && g.nodes) || []) if (n && n.params && n.params._kTex) kTex.push(n);
    ok(
      !('kernelTex' in b) && !kTex.length && b.lastKernelFloats !== undefined,
      `${tag}: no kernel texture on the bundle (kernelTex ${'kernelTex' in b ? 'present' : 'absent'}) or on a node (${kTex.length})`,
    );
  }
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
