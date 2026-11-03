// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupFilterRectSmoke -- a filter on a <g> paints past its children, so no rect bounded by the children may cut it.
//
// A <g filter> is a groupBegin with a filterId, not a filter flattened onto its children, so no child's rect carries the filter's reach and a content
// rect that walks only fillShape rows misses it. Two consumers would cut the result at the children's box: the static cache's blit (a cached bundle holding a filtered group), and the
// accumulator of a group around a filtered group (an opacity group or a blend group). Pinned on the driver-free stand-in, by the viewport of the draw that reaches the canvas: each one covers the filter's output.
// A faded sprite's accumulator is the third: its list of what it paints must count the filtered group, not only leaves.
// CPU (test/_fakeGl.mjs). No pixels: the claim is which rectangle the composite is drawn through. test/groupFilterRectRenderSmoke.mjs and test/spriteFilterAlphaRenderSmoke.mjs are the pixels.
globalThis.__MANTLE_DEBUG__ = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { createRenderer, createBundle, importSvg, CacheStrategy } = await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const SZ = 800;
const withLimits = (F) => {
  const g = F.gl,
    gp = g.getParameter.bind(g),
    max = new Set([g.MAX_TEXTURE_SIZE, g.MAX_RENDERBUFFER_SIZE]);
  g.getParameter = (p) =>
    max.has(p) ? 16384 : p === g.MAX_VIEWPORT_DIMS ? new Int32Array([16384, 16384]) : gp(p);
  return F;
};
const DEFS =
  '<defs><filter id="b" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="20"/><feOffset dx="-30" dy="-30"/></filter></defs><rect width="400" height="400" fill="none"/>';
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">${DEFS}${body}</svg>`;
const KIDS =
  '<rect x="150" y="150" width="60" height="60" fill="#c33"/><rect x="190" y="190" width="60" height="60" fill="#3c3"/>';
// the children sit at canvas x 300..500; the sigma is 40 px and the offset -60 px, so three sigma of the output reaches x 120 on the left
const REACH_LEFT = 120;
async function rig() {
  const F = withLimits(createFakeGl({ width: SZ, height: SZ }));
  const R = createRenderer(F.gl, taggedShaderSources(), {});
  R.setViewport(SZ, SZ);
  return { F, R };
}
const canvasDraws = (F, key) =>
  F.log.filter((e) => e.op === 'draw' && e.fbo === null && F.progKeys(e.prog).has(key));
const covers = (e) => !!e && e.vp[0] <= REACH_LEFT;

console.log('(cache) the static cache of a bundle holding a filtered group blits the whole result');
{
  const { F, R } = await rig();
  const bundle = createBundle(
    F.gl,
    await importSvg(svg(`<g filter="url(#b)">${KIDS}</g>`), { preserveViewport: true }),
  );
  ok(
    bundle.drawList.some((o) => o.kind === 'groupBegin' && o.filterId),
    'the premise: the filter stays on the group row',
  );
  const h = R.createBundleHandle(bundle, {
    staticCache: { strategy: CacheStrategy.ForceWholeAsset },
  });
  for (let i = 0; i < 6; i++) {
    R.beginFrame([1, 1, 1, 1]);
    h.draw();
    R.endFrame();
  }
  ok(h.staticCache.isCacheValid, 'the premise: the cache is valid');
  const blit = canvasDraws(F, 'cacheBlitFrag').pop();
  ok(covers(blit), `the blit reaches x ${REACH_LEFT} (viewport ${blit && blit.vp})`);
  R.dispose();
}
console.log('(control) a filter on the shape is bounded by its reach');
{
  const { F, R } = await rig();
  const bundle = createBundle(
    F.gl,
    await importSvg(
      svg('<rect x="150" y="150" width="100" height="100" fill="#c33" filter="url(#b)"/>'),
      { preserveViewport: true },
    ),
  );
  const h = R.createBundleHandle(bundle, {
    staticCache: { strategy: CacheStrategy.ForceWholeAsset },
  });
  for (let i = 0; i < 6; i++) {
    R.beginFrame([1, 1, 1, 1]);
    h.draw();
    R.endFrame();
  }
  const blit = canvasDraws(F, 'cacheBlitFrag').pop();
  ok(
    covers(blit) && blit.vp[2] < SZ,
    `the blit is bounded and reaches x ${REACH_LEFT} (viewport ${blit && blit.vp})`,
  );
  R.dispose();
}
console.log(
  '(faded sprite) a faded sprite that paints through a filtered group composites past its leaves; a sprite with no filter keeps its rect',
);
{
  const fadedDraws = async (body, sprite) => {
    const { F, R } = await rig();
    const bundle = createBundle(F.gl, await importSvg(svg(body), { preserveViewport: true }));
    const n0 = F.log.length;
    R.beginFrame([1, 1, 1, 1]);
    R.drawSprite(bundle, sprite, { alpha: 0.5 });
    R.endFrame();
    const d = F.log.slice(n0).filter((e) => e.op === 'draw' && e.fbo === null);
    R.dispose();
    return d;
  };
  const PLAIN =
    '<g id="plain"><rect x="330" y="330" width="20" height="20" fill="#36c"/><rect x="340" y="340" width="20" height="20" fill="#c33"/></g>';
  for (const [name, body, sprite] of [
    ['in the sprite', `<g id="s"><g filter="url(#b)">${KIDS}</g></g>`, 's'],
    ['the sprite itself', `<g id="s" filter="url(#b)">${KIDS}</g>`, 's'],
    ['around a row range', `<g filter="url(#b)">${KIDS}</g>`, [1, 2]],
  ]) {
    const d = await fadedDraws(body + PLAIN, sprite);
    ok(
      d.length > 0 && d.every(covers),
      `a filtered group ${name}: every composite reaches x ${REACH_LEFT} (${d.map((e) => e.vp.join(',')).join(' | ')})`,
    );
  }
  const onFiltered = await fadedDraws(
    `<g id="s"><g filter="url(#b)">${KIDS}</g></g>${PLAIN}`,
    'plain',
  );
  const onPlain = await fadedDraws(`<g id="s">${KIDS}</g>${PLAIN}`, 'plain');
  const last = (d) => (d.length ? d[d.length - 1].vp.join(',') : 'none');
  ok(
    onPlain.length > 0 && last(onPlain) !== `0,0,${SZ},${SZ}`,
    `a sprite with no filter composites through its own rect (${last(onPlain)})`,
  );
  ok(
    last(onFiltered) === last(onPlain),
    `...on a sheet with a filtered group elsewhere too (${last(onFiltered)} against ${last(onPlain)})`,
  );
}
for (const [name, outer, key] of [
  ['opacity', 'opacity="0.5"', 'cacheBlitFrag'],
  ['blend', 'style="mix-blend-mode:multiply"', 'compositeFrag'],
]) {
  console.log(
    `(${name} group) the outer group's composite covers the filtered group inside it, cached or not`,
  );
  const { F, R } = await rig();
  const bundle = createBundle(
    F.gl,
    await importSvg(svg(`<g ${outer}><g filter="url(#b)">${KIDS}</g></g>`), {
      preserveViewport: true,
    }),
  );
  const n0 = F.log.length;
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(bundle);
  R.endFrame();
  const draws = F.log
    .slice(n0)
    .filter(
      (e) =>
        e.op === 'draw' &&
        e.fbo === null &&
        (F.progKeys(e.prog).has(key) ||
          F.progKeys(e.prog).has('cacheBlitFrag') ||
          F.progKeys(e.prog).has('compositeFrag')),
    );
  ok(
    draws.length > 0 && draws.every(covers),
    `every composite to the canvas reaches x ${REACH_LEFT} (${draws.map((d) => d.vp.join(',')).join(' | ')})`,
  );
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
