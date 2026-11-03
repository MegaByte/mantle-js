// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterCacheInputsSmoke — the filter result cache is bypassed, on both routes, by every input its
// key has no term for.
//
// The filter result cache keys a filtered shape's result on its geometry, overrides, world matrix,
// canvas, recolor and filter parameters. Some inputs change that result with no term in the key: a
// palette LUT (mutable in place, no version token), an external clip texture (setNodeClip / the
// extClipTex draw option), a sprite subset draw (shapeRange), a bundle mask mesh, and a graph that
// reads the backdrop. The classic loop refuses to cache under any of them (`_filterCacheable`); a
// route that refused only the backdrop would serve a palette draw or a sprite draw of a static
// filtered shape the first frame's result for as long as the key held. Both routes ask one
// predicate, R._filterCacheable.
//
// HOW: the real renderer, headless, against test/_fakeGl.mjs. A blurred (single-kind) and a
// graph-filtered shape are each drawn for five STATIC frames with one input active -- the palette
// is rewritten every frame, as an animated palette is -- and debugStats.filterEvalCount must move
// every frame after the first on both routes (the cache is bypassed). A control arm with no input
// must HIT (0 evaluations), so the cache is shown to be live. The filtered shape is a PATH, not a
// circle, so the classic arm cannot become the unified route by recognizing a primitive. The unified
// arm must really be the unified route; the one exception is the external clip, which the analytic
// route never takes (_analyticRoute declines it), and that is asserted instead.
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

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
const { importSvg, createBundle, createRenderer, createPalette } = await import('../src/index.js');

const N = 120;
const REGION = 'x="-100%" y="-100%" width="300%" height="300%"';
const DEFS =
  `<filter id="b" ${REGION}><feGaussianBlur stdDeviation="1.5"/></filter>` +
  `<filter id="g" ${REGION}><feMorphology operator="dilate" radius="1"/><feGaussianBlur stdDeviation="1.5"/></filter>`;
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  `<defs>${DEFS}</defs>${body}</svg>`;
const PLAIN = '<path d="M10 10 L70 10 L70 110 L10 110 Z" fill="#f00"/>';
const blob = (f) =>
  `<path d="M80 40 C100 40 104 62 92 76 C80 90 58 86 60 64 C62 48 68 40 80 40 Z" fill="#00f" filter="url(#${f})"/>`;
const FILTERS = [
  { name: 'single-kind blur', id: 'b' },
  { name: 'filter graph', id: 'g' },
];
const INPUTS = ['none', 'palette', 'extClipTex', 'shapeRange', 'maskMesh'];
const FRAMES = 5;

async function run(filterId, route, input) {
  const F = createFakeGl({ width: N, height: N });
  const R = createRenderer(F.gl, taggedShaderSources(), {});
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(
    F.gl,
    await importSvg(svg(PLAIN + blob(filterId)), { preserveViewport: true }),
  );
  // createBundle never carries a mask mesh itself; a hand-built bundle may, and the rule reads it.
  if (input === 'maskMesh') b.maskMesh = new Uint8Array(4);
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
  const pal = createPalette(F.gl, [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
  ]);
  const clip = F.gl.createTexture();
  const stats = [];
  for (let i = 0; i < FRAMES; i++) {
    F.setFrame(i);
    R.beginFrame([0, 0, 0, 0]);
    const o = {};
    if (input === 'palette') {
      pal.set(0, [255, (i * 40) & 255, 0, 255]);
      o.palette = pal;
    }
    if (input === 'extClipTex') {
      o.extClipTex = clip;
      o.extClipMode = 1;
    }
    if (input === 'shapeRange') R.drawSprite(b, [0, 1], o);
    else R.drawBundle(b, o);
    R.endFrame();
    // The first draw under a recolor finds its LB variant cold (it records the draw state it
    // wanted); warm it the way a load screen would, so the unified arm really takes the route.
    if (i === 0) R.precompileFills();
    stats.push(Object.assign({}, R.debugStats));
  }
  return stats;
}

for (const f of FILTERS) {
  console.log(`\n  ${f.name}:`);
  for (const input of INPUTS) {
    for (const route of ['none', 'lb']) {
      const st = await run(f.id, route, input);
      // Frames 2..4: every frame after the one that followed the warm (a variant change is a key change).
      const evals = [];
      for (let i = 2; i < FRAMES; i++)
        evals.push((st[i].filterEvalCount | 0) - (st[i - 1].filterEvalCount | 0));
      const d = (k) => (st[FRAMES - 1][k] | 0) - (st[1][k] | 0);
      const tag = `${input}, route ${route}`;
      if (route === 'none') {
        ok(
          d('unifiedFillDraws') === 0,
          `${tag}: the classic route (unified draws +${d('unifiedFillDraws')})`,
        );
      } else if (input === 'extClipTex') {
        ok(
          d('unifiedFillDraws') === 0,
          `${tag}: the analytic route declines an external clip (unified draws +${d('unifiedFillDraws')})`,
        );
      } else {
        ok(
          d('unifiedFillDraws') > 0 && d('unifiedFilterDraws') > 0,
          `${tag}: the unified route isolated the filter (unified draws +${d('unifiedFillDraws')}, ` +
            `filter draws +${d('unifiedFilterDraws')}, gate ${st[FRAMES - 1].unifiedFillGate})`,
        );
      }
      if (input === 'none') {
        ok(
          evals.every((n) => n === 0),
          `${tag}: a static filtered shape is served from the cache (evaluations per frame [${evals}], want 0)`,
        );
      } else {
        ok(
          evals.every((n) => n === 1),
          `${tag}: the cache is bypassed (evaluations per frame [${evals}], want 1)`,
        );
      }
    }
  }
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
