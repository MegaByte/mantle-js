// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupFrameTargetSmoke -- a filter frame must not re-size a target an outer group is drawing into.
//
// A filtered shape or group that crosses the canvas edge runs in a FRAME: the viewport is the frame's size for the span. The outermost group's accumulator is the renderer's canvas-sized target, re-created
// whenever it is asked for at another size, so a filtered leaf, a plain group or a blend leaf inside the frame must not ask for it (none of them uses it): that would delete the outer group's target
// while the group is open, losing what it holds and compositing through a deleted object (in pixels: groupTargetsRenderSmoke, the group gone on every frame the filter re-evaluates).
// CPU (test/_fakeGl.mjs): which objects are deleted, and whether a deleted one is bound again.
globalThis.__MANTLE_DEBUG__ = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { createRenderer, createBundle, importSvg, createOverrideTable } =
  await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const withLimits = (F) => {
  const g = F.gl,
    gp = g.getParameter.bind(g),
    max = new Set([g.MAX_TEXTURE_SIZE, g.MAX_RENDERBUFFER_SIZE]);
  g.getParameter = (p) =>
    max.has(p) ? 16384 : p === g.MAX_VIEWPORT_DIMS ? new Int32Array([16384, 16384]) : gp(p);
  return F;
};
const SZ = 400;
const DEFS =
  '<defs><filter id="b" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="8"/><feOffset dx="3" dy="3"/></filter></defs>';
const svg = (b) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">${DEFS}${b}</svg>`;
const SQ = '<rect x="250" y="250" width="60" height="60" fill="#00f"/>';
const LEAF = '<rect x="-40" y="100" width="120" height="120" fill="#c33" filter="url(#b)"/>';
const R2 = '<rect x="-40" y="100" width="120" height="120" fill="#c33"/>';
const CASES = [
  ['a graph-filtered leaf in an opacity group', svg(`<g opacity="0.5">${SQ}${LEAF}</g>`), {}],
  [
    'a plain group in a filtered group in an opacity group',
    svg(
      `<g opacity="0.5">${SQ}<g filter="url(#b)"><g opacity="0.5">${R2}<rect x="-30" y="110" width="120" height="120" fill="#3c3"/></g></g></g>`,
    ),
    {},
  ],
  [
    'a blend leaf in a filtered group in an opacity group',
    svg(
      `<g opacity="0.5">${SQ}<g filter="url(#b)">${R2}<rect x="-30" y="110" width="120" height="120" fill="#3c3" style="mix-blend-mode:multiply"/></g></g>`,
    ),
    {},
  ],
  ['a graph-filtered leaf in a faded draw', svg(`${SQ}${LEAF}`), { alpha: 0.5 }],
  [
    'a blend group holding a filtered group',
    svg(
      `<g style="mix-blend-mode:multiply">${SQ}<g filter="url(#b)"><g opacity="0.5">${R2}</g></g></g>`,
    ),
    {},
  ],
];
for (const [name, source, opts] of CASES) {
  console.log(`(${name})`);
  const F = withLimits(createFakeGl({ width: SZ, height: SZ })),
    gl = F.gl;
  const gone = new Set();
  let badBind = 0,
    deletes = 0;
  const df = gl.deleteFramebuffer.bind(gl),
    dt = gl.deleteTexture.bind(gl),
    bf = gl.bindFramebuffer.bind(gl),
    bt = gl.bindTexture.bind(gl);
  gl.deleteFramebuffer = (o) => {
    gone.add(o);
    deletes++;
    return df(o);
  };
  gl.deleteTexture = (o) => {
    gone.add(o);
    deletes++;
    return dt(o);
  };
  gl.bindFramebuffer = (t, o) => {
    if (o && gone.has(o)) badBind++;
    return bf(t, o);
  };
  gl.bindTexture = (t, o) => {
    if (o && gone.has(o)) badBind++;
    return bt(t, o);
  };
  const R = createRenderer(gl, taggedShaderSources(), {});
  R.setViewport(SZ, SZ);
  const bundle = createBundle(gl, await importSvg(source, { preserveViewport: true }));
  const table = createOverrideTable(gl, bundle);
  const row = bundle.drawList
    .filter((o) => o.kind === 'fillShape')
    .map((o) => o.shapeIdx)
    .pop();
  const v0 = R.debugStats.filterEvalCount;
  // a moving tint: the filter re-evaluates on every frame, as an animated one does
  for (let i = 0; i < 4; i++) {
    table.set(row, { tint: [1, 1 - i / 16, 1, 1] });
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(bundle, { overrides: table, ...opts });
    R.endFrame();
  }
  ok(
    R.debugStats.filterEvalCount - v0 >= 4,
    `the premise: the filter ran on every frame (${R.debugStats.filterEvalCount - v0})`,
  );
  ok(deletes === 0, `no target was deleted while frames drew at one size (${deletes})`);
  ok(badBind === 0, `no deleted target was bound again (${badBind})`);
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
