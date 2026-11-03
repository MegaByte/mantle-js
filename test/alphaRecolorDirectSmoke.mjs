// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// alphaRecolorDirectSmoke -- a faded ONE-LEAF draw whose colorMatrix leaves alpha alone takes the direct path, not a group.
//
// A puzzle board that draws 36 region-border cells per frame (one white fill path each, tinted per region by a diagonal
// colorMatrix, faded to alpha 0.377). A one-leaf draw at alpha < 1 is direct (groupAlphaSmoke C); sending it to an isolated group
// for ANY colorMatrix costs an accumulator clear, the leaf, and a composite back onto the canvas -- two render-pass switches per cell
// on ANGLE-Metal, ~28 ms a frame at 3376x2082 (36 group composites per frame). The fill applies
// the draw's alpha to the straight paint BEFORE the colorMatrix (aacPoints.vert.glsl, mantle.frag), so the group is only needed
// when the matrix reads or writes alpha: the alpha row is not (0,0,0,1), the alpha offset is not 0, or an RGB row reads alpha.
// Anything else (a tint, an RGB offset, a channel mix among RGB) gives the same pixels per leaf as the group's one fade.
//
// HOW: the real renderer against test/_fakeGl.mjs (it records every clear/draw with its target). Per route ('none' = classic cover, 'lb' = unified):
//   (A) one fill leaf, diagonal tint, alpha .4: no group composite, the leaf paints the canvas with uDrawAlpha .4;
//   (B) one fill leaf, RGB offset + RGB channel mix, alpha .4: direct as well;
//   (C) one fill leaf, a matrix that WRITES alpha (alpha offset .2): the group is kept (one composite);
//   (D) one fill leaf, a matrix whose RGB reads alpha: the group is kept;
//   (E) a fill+stroke row with the tint: the group is kept (two overlapping paints, groupAlphaSmoke D).
import { createFakeGl, taggedShaderSources, expandInstancedBlits } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg, createBundle, createRenderer } = await import('../src/index.js');

const N = 120;
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">${body}</svg>`;
const ONE_FILL = '<path d="M10 10h60v80h-60z" fill="#fff"/>';
const FILL_STROKE =
  '<rect x="10" y="10" width="60" height="80" fill="#fff" stroke="#f00" stroke-width="6"/>';
const M = (a) => new Float32Array(a);
const TINT = M([0.4, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 0.9, 0, 0, 0, 0, 1]);
const MIX = M([0.5, 0.2, 0, 0, 0.3, 0.6, 0.1, 0, 0.2, 0, 0.9, 0, 0, 0, 0, 1]);
const READS_ALPHA = M([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 0, 0, 1]); // column-major: red += 0.5 * alpha
const Z = M([0, 0, 0, 0]),
  RGB_OFF = M([0.1, 0, 0.05, 0]),
  A_OFF = M([0, 0, 0, 0.2]);
const FRAMES = 3;

async function run(body, route, cm, off) {
  const F = createFakeGl({ width: N, height: N });
  const R = createRenderer(F.gl, taggedShaderSources(), {});
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(F.gl, await importSvg(svg(body), { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) {
    try {
      await R.awaitLbReady(b, 20000);
    } catch {
      /* the route check reports it */
    }
  }
  R.prewarmBundle(b);
  R.precompileFills();
  R.setViewport(N, N);
  for (let i = 0; i < FRAMES; i++) {
    F.setFrame(i);
    R.beginFrame([0, 0, 0, 0]);
    R.drawBundle(b, { alpha: 0.4, colorMatrix: cm, colorMatrixOffset: off });
    R.endFrame();
  }
  const ev = expandInstancedBlits(
    F,
    F.log.filter((e) => e.frame === FRAMES - 1),
  );
  const accFbos = new Set(ev.filter((e) => e.op === 'clear' && e.fbo).map((e) => e.fbo));
  const has = (e, k) => F.progKeys(e.prog).has(k);
  const comps = ev.filter(
    (e) => e.op === 'draw' && has(e, 'cacheBlitFrag') && accFbos.has(F.fboOf(e.units[0])),
  );
  const rtDraws = ev.filter((e) => e.op === 'draw' && e.fbo);
  const leafAlpha = ev
    .filter(
      (e) => e.op === 'draw' && !has(e, 'cacheBlitFrag') && e.uni && e.uni.uDrawAlpha !== undefined,
    )
    .map((e) => e.uni.uDrawAlpha);
  R.dispose && R.dispose();
  return { comps: comps.length, rtDraws: rtDraws.length, leafAlpha };
}

for (const route of ['none', 'lb']) {
  console.log(`(${route})`);
  const a = await run(ONE_FILL, route, TINT, Z);
  ok(
    a.comps === 0 &&
      a.rtDraws === 0 &&
      a.leafAlpha.length > 0 &&
      a.leafAlpha.every((x) => Math.abs(x - 0.4) < 1e-6),
    `A one leaf + diagonal tint at alpha .4: direct (composites ${a.comps}, RT draws ${a.rtDraws}, leaf uDrawAlpha ${JSON.stringify(a.leafAlpha)})`,
  );
  const bb = await run(ONE_FILL, route, MIX, RGB_OFF);
  ok(
    bb.comps === 0 && bb.rtDraws === 0,
    `B one leaf + RGB mix and RGB offset: direct (composites ${bb.comps}, RT draws ${bb.rtDraws})`,
  );
  const c = await run(ONE_FILL, route, TINT, A_OFF);
  ok(c.comps === 1, `C one leaf + alpha offset .2: the group is kept (composites ${c.comps})`);
  const d = await run(ONE_FILL, route, READS_ALPHA, Z);
  ok(
    d.comps === 1,
    `D one leaf + a matrix whose RGB reads alpha: the group is kept (composites ${d.comps})`,
  );
  const e = await run(FILL_STROKE, route, TINT, Z);
  ok(e.comps === 1, `E fill+stroke row + tint: the group is kept (composites ${e.comps})`);
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
