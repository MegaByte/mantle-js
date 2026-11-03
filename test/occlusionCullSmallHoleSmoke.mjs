// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// occlusionCullSmallHoleSmoke: an occluder with an opening smaller than the containment test's samples does not hide what shows through it.
//
// Sampling only the covered shape's boundary and a 6 x 6 grid of its box misses a hole or a notch in the occluder that falls between those
// samples: a sheet with a small window would cull the layer behind it, at load, and the window would show whatever was under both.
// So the occluder's own boundary is sampled too, and an opening that has any boundary over the covered shape is seen, whatever its size.
// Controls: a real cover, flush and nested, still culls, including an occluder whose overlapping contours keep a solid interior.
// CPU, through the real importer, on the draw list.
const { M, imp, mkRenderer, wrap } = await import('./_exportHarness.mjs');
const { computeOccludedShapes } = await import('../src/renderer/occlusionCull.js');
const warn = console.warn;
console.warn = () => {};
const { gl } = await mkRenderer(100, 100);
let fails = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('PASS', name);
  else {
    fails++;
    console.log('FAIL', name, detail ?? '');
  }
};

const SCALES = [1, 2 ** -20, 2 ** 16];
const scaled = (body, k) =>
  wrap(`<g transform="scale(${k})">${body}</g>`, `viewBox="0 0 ${100 * k} ${100 * k}"`);
async function culled(body, k = 1) {
  const b = M.createBundle(gl, await imp(scaled(body, k)));
  const full = computeOccludedShapes(
    b.curveFloats,
    b.curveRangesByShape,
    b.metaFloats,
    b.numShapes,
    b.metaFloatsPerShape,
    'full',
  );
  const inline = b._culledShapes ? [...b._culledShapes] : [];
  const drawn = b.drawList.length;
  b.dispose();
  return { full: [...full], inline, drawn };
}
const back = '<rect width="100" height="100" fill="#f00"/>';
const openings = {
  'an even-odd window': `${back}<path fill-rule="evenodd" fill="#00f" d="M0 0H100V100H0Z M48 48H52V52H48Z"/>`,
  'a nonzero window, wound against the sheet': `${back}<path fill="#00f" d="M0 0H100V100H0Z M48 48V52H52V48Z"/>`,
  'a very small window': `${back}<path fill-rule="evenodd" fill="#00f" d="M0 0H100V100H0Z M50 50H50.2V50.2H50Z"/>`,
  'a curved window': `${back}<path fill-rule="evenodd" fill="#00f" d="M0 0H100V100H0Z M48 50A2 2 0 0 0 52 50A2 2 0 0 0 48 50Z"/>`,
  'a notch in the edge between the samples': `${back}<path fill="#00f" d="M0 0H100V100H33V96H30V100H0Z"/>`,
  'a stroke over a window between its samples':
    '<path d="M10 50H90" stroke="#f00" stroke-width="6" fill="none"/><path fill-rule="evenodd" fill="#00f" d="M0 0H100V100H0Z M33 48H36V52H33Z"/>',
};
for (const [name, body] of Object.entries(openings)) {
  for (const k of SCALES) {
    const c = await culled(body, k);
    check(
      `${name} at scale ${k}: nothing culled, inline or in the worker's pass`,
      !c.inline.length && !c.full.length && c.drawn === 2,
      JSON.stringify(c),
    );
  }
}
const covers = {
  'a flush cover': `${back}<rect width="100" height="100" fill="#00f"/>`,
  'a nested cover':
    '<rect x="20" y="20" width="10" height="10" fill="#f00"/><rect width="100" height="100" fill="#00f"/>',
  'a stroke under a cover':
    '<path d="M10 50H90" stroke="#f00" stroke-width="6" fill="none"/><rect width="100" height="100" fill="#00f"/>',
  'a cover with overlapping contours that stay solid': `${back}<path fill="#00f" d="M0 0H100V100H0Z M40 40H60V60H40Z"/>`,
  'a hole away from the covered shape':
    '<rect x="10" y="10" width="20" height="20" fill="#f00"/><path fill-rule="evenodd" fill="#00f" d="M0 0H100V100H0Z M70 70H90V90H70Z"/>',
};
for (const [name, body] of Object.entries(covers)) {
  for (const k of SCALES) {
    const c = await culled(body, k);
    check(
      `${name} at scale ${k}: still culled`,
      c.full.length === 1 && c.full[0] === 0,
      JSON.stringify(c),
    );
  }
}
console.warn = warn;
if (fails) {
  console.log(`occlusionCullSmallHoleSmoke: ${fails} FAILED`);
  process.exit(1);
}
console.log('occlusionCullSmallHoleSmoke PASS');
process.exit(0);
