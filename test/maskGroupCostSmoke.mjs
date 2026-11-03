// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// maskGroupCostSmoke -- what a masked group COSTS the GPU, counted on the real renderer over test/_fakeGl.mjs (no GPU): the
// passes, their scissors and their viewports. Pixels are the render lane's: importerSemanticsRenderSmoke's compositingGroup cells (the picture against
// Chrome) and maskGroupCostRenderSmoke (the same picture with the group rect switched off).
//
// A group with a non-binary mask draws its members into an accumulator, masks that, and composites it. Done canvas-wide that is a
// canvas-sized accumulator clear, a canvas-sized masked copy (clear + full-canvas pass) and a full-canvas composite; instead every pass
// stays inside the rect the group paints (a mask only removes pixels, so nothing outside it is ever read), by scissor with the
// full-canvas viewport (a rect viewport would remap the accumulator fetch and move pixels of a scene by a byte).
// Each assertion fails on canvas-wide passes. (Folding a one-layer mask into the composite is not done: it moves a byte in the render
// lane's alpha-ramp cell.)
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg, createBundle, createRenderer } = await import('../src/index.js');
console.warn = () => {};
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const N = 512,
  CANVAS = N * N;
const HEAD =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><linearGradient id="g" x2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>' +
  '<mask id="m"><rect x="10" y="10" width="40" height="40" fill="url(#g)"/></mask><mask id="m2"><rect x="10" y="10" width="40" height="40" fill="url(#g)"/></mask>';
// (two dots outside every group keep the content box -- which the renderer fits to the canvas -- much larger than the group)
const DOTS = '<circle cx="3" cy="3" r="2" fill="#333"/><circle cx="97" cy="97" r="2" fill="#333"/>';
const TWO =
  '<rect x="12" y="12" width="20" height="20" fill="#0cf"/><circle cx="26" cy="26" r="10" fill="#f0c"/>';
const DOCS = {
  plain: HEAD + `<g mask="url(#m)">${TWO}</g>${DOTS}</svg>`,
  opacity: HEAD + `<g mask="url(#m)" opacity=".5">${TWO}</g>${DOTS}</svg>`,
  nested:
    HEAD +
    `<g mask="url(#m)"><g mask="url(#m2)">${TWO}</g><rect x="30" y="30" width="9" height="9"/></g>${DOTS}</svg>`,
};

/// The last frame's passes, from the GL log: { fills, clears, masks (effect-mask draws), blits (group composites), canvasMasks }.
async function passes(text) {
  const F = createFakeGl({ width: N, height: N });
  const R = createRenderer(F.gl, taggedShaderSources(), {});
  R.setFillEngine({ route: 'auto', kernel: 'auto' });
  const b = createBundle(F.gl, await importSvg(text, {}));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) {
    try {
      await R.awaitLbReady(b, 60000);
    } catch {
      /* the counts say so */
    }
  }
  R.setViewport(N, N);
  if (R.prewarmBundle) R.prewarmBundle(b);
  const LAST = 9;
  for (let i = 0; i <= LAST; i++) {
    F.setFrame(i);
    if (R.precompileFills) R.precompileFills();
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b);
    R.endFrame();
  }
  const ev = F.log.filter((e) => e.frame === LAST);
  const area = (r) => (r ? r[2] * r[3] : CANVAS);
  const has = (e, k) => e.prog && F.progKeys(e.prog).has(k);
  const draws = ev.filter((e) => e.op === 'draw');
  if (process.env.SMOKE_DEBUG)
    for (const e of ev)
      console.log(
        '   ',
        e.op,
        'fbo',
        e.fbo && e.fbo.id,
        'sc',
        JSON.stringify(e.sc),
        e.vp ? 'vp ' + e.vp : '',
        e.prog ? [...F.progKeys(e.prog)].join('+') : '',
      );
  const out = {
    draws: draws.length,
    rtClears: ev.filter((e) => e.op === 'clear' && e.fbo),
    masks: draws.filter((e) => has(e, 'effectMaskFrag')),
    blits: draws.filter((e) => has(e, 'cacheBlitFrag')),
    area,
  };
  try {
    R.dispose();
  } catch {
    /* headless */
  }
  return out;
}

console.log('a masked group stays inside the rect it paints');
for (const [name, text] of Object.entries(DOCS)) {
  const p = await passes(text);
  // (the accumulator's first clear, and the clear of the masked copy; a later full clear of the accumulator is the unified route's depth
  // reset for a group below opacity 1 and is not this row's)
  const first = new Map();
  for (const e of p.rtClears) if (!first.has(e.fbo)) first.set(e.fbo, e);
  ok(
    first.size >= 2 && [...first.values()].every((e) => p.area(e.sc) < CANVAS / 2),
    `${name}: the first clear of every group render target is scissored to the group's rect (${[...first.values()].map((e) => p.area(e.sc)).join(', ')} px of ${CANVAS})`,
  );
  ok(
    p.masks.length > 0 && p.masks.every((e) => e.sc && p.area(e.sc) < CANVAS / 2),
    `${name}: every mask pass is scissored to it (${p.masks.map((e) => p.area(e.sc)).join(', ')})`,
  );
  ok(
    p.blits.length > 0 && p.blits.every((e) => e.sc && p.area(e.sc) < CANVAS / 2),
    `${name}: every composite is scissored to it (${p.blits.map((e) => p.area(e.sc)).join(', ')})`,
  );
  // the canvas-sized viewport and identity fetch map stay: a rect viewport remaps the accumulator fetch (a float rounding off a texel center)
  ok(
    p.blits.every((e) => p.area(e.vp) === CANVAS),
    `${name}: ... with the canvas-sized viewport (the fetch map stays the identity)`,
  );
}
console.log('the pass structure is unchanged: accumulator, masked copy, composite');
{
  const p = await passes(DOCS.plain);
  ok(
    p.masks.length === 1 && p.masks[0].fbo !== null,
    'one mask pass, into a render target (the 8-bit copy)',
  );
  ok(p.blits.length === 1 && p.blits[0].fbo === null, 'one composite, into the canvas');
}
{
  const p = await passes(DOCS.nested);
  ok(
    p.masks.length === 2 &&
      p.blits.length === 2 &&
      p.blits[0].fbo !== null &&
      p.blits[1].fbo === null,
    'nested masked groups: the inner composites into the outer accumulator, the outer into the canvas',
  );
}
console.log(fail ? `\nFAILED ${fail}` : '\nall ok');
process.exit(fail ? 1 : 0);
