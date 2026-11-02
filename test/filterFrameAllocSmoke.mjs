// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterFrameAllocSmoke -- a filtered shape crossing the canvas edge reuses its targets while it moves.
//
// The frame's margin follows the shape, and a rect cut by the frame or by the filter region follows it too. Exact sizes would ask for a new target on nearly every frame: about 4 allocations per frame on a
// 1024 px canvas, more than 800 in 200 frames, each about 1.5 ms at 1536 px, in play. The margin sits on a grid, a rect goes back on its quantum with its passes scissored to the exact pixels, and a cached result keeps its texture while it fits.
// CPU (test/_fakeGl.mjs): texImage2D calls, counted over 200 frames. The bounds are about 1.3 times what the grid gives, and the exact sizes are 7 to 50 times past them.
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
const SZ = 1024;
const doc = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">${b}</svg>`;
const WIDE_F =
  '<defs><filter id="b" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="8"/><feOffset dx="3" dy="3"/></filter></defs>';
const DROP_F =
  '<defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="4" dy="6" stdDeviation="5" flood-color="#000"/></filter></defs>';
const AUTO_F =
  '<defs><filter id="b"><feGaussianBlur stdDeviation="4"/><feOffset dx="2" dy="2"/></filter></defs>';
const WIDE = `${WIDE_F}<rect x="-40" y="100" width="500" height="120" fill="#c33" filter="url(#b)"/>`;
const GROUP = `${WIDE_F}<g filter="url(#b)"><rect x="-40" y="100" width="500" height="60" fill="#c33"/><circle cx="200" cy="260" r="80" fill="#3a3"/></g>`;
const DROP = `${DROP_F}<circle cx="10" cy="200" r="80" fill="#36c" filter="url(#b)"/>`;
const AUTO = `${AUTO_F}<rect x="-40" y="100" width="500" height="120" fill="#c33" filter="url(#b)"/>`;
const INSIDE = `${WIDE_F}<rect x="100" y="100" width="120" height="120" fill="#c33" filter="url(#b)"/>`;
const run = async (svg, at, { tint = false, n = 200 } = {}) => {
  const F = withLimits(createFakeGl({ width: SZ, height: SZ })),
    gl = F.gl;
  const R = createRenderer(gl, taggedShaderSources(), {});
  R.setViewport(SZ, SZ);
  const b = createBundle(gl, await importSvg(doc(svg), { preserveViewport: true }));
  let allocs = 0,
    first = 0;
  const ti = gl.texImage2D.bind(gl);
  gl.texImage2D = (...a) => {
    allocs++;
    return ti(...a);
  };
  const table = tint ? createOverrideTable(gl, b) : null,
    row = tint ? b.drawList.find((o) => o.kind === 'fillShape').shapeIdx : 0;
  for (let i = 0; i <= n; i++) {
    if (table) table.set(row, { tint: [1, 1 - (i % 16) / 64, 1, 1] });
    const [z, tx, ty = 0] = at(i);
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b, {
      ...(table ? { overrides: table } : {}),
      worldMatrix: new Float32Array([z, 0, 0, 0, z, 0, tx, ty, 1]),
    });
    R.endFrame();
    if (i === 0) first = allocs;
  }
  const evals = R.debugStats.filterEvalCount;
  R.dispose();
  return { allocs, first, evals };
};
const pan = (i) => [1, i * 0.005],
  zoom = (i) => [1 + i * 0.02, 0];
for (const [name, svg, at, most] of [
  ['a pan', WIDE, pan, 30],
  ['a zoom', WIDE, zoom, 120],
  ['a zoom out', WIDE, (i) => [5 - i * 0.02, 0], 120],
  ['a filtered group, zoomed', GROUP, zoom, 40],
  ['a drop shadow, panned', DROP, (i) => [1, i * 0.002], 25],
  ['a default filter region, panned', AUTO, pan, 25],
]) {
  const r = await run(svg, at);
  ok(r.evals >= 150, `the premise, ${name}: the filter re-evaluates as it moves (${r.evals})`);
  ok(r.allocs <= most, `${name}: ${r.allocs} targets in 200 frames, at most ${most}`);
}
console.log('(a default filter region, on a shape that never touches the edge)');
const IN = `${AUTO_F}<circle cx="200" cy="200" r="50" fill="#36c" filter="url(#b)"/>`,
  CROSS = `${AUTO_F}<circle cx="10" cy="200" r="80" fill="#36c" filter="url(#b)"/>`;
const BLUR =
  '<defs><filter id="b" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="6"/></filter></defs><circle cx="10" cy="200" r="80" fill="#36c" filter="url(#b)"/>';
for (const [name, svg, at, most] of [
  ['inside, panned', IN, (i) => [1, -0.2 + i * 0.002], 10],
  ['inside, zoomed', IN, (i) => [0.5 + i * 0.005, 0], 30],
  ['inside, panned on both axes', IN, (i) => [1, -0.2 + i * 0.002, -0.2 + i * 0.0017], 12],
  ['crossing, panned', CROSS, (i) => [1, i * 0.002], 15],
  ['crossing, zoomed', CROSS, (i) => [1 + i * 0.02, 0], 95],
  ['a single blur, crossing, panned on both axes', BLUR, (i) => [1, i * 0.002, i * 0.0017], 18],
]) {
  const r = await run(svg, at);
  ok(r.evals >= 150, `the premise, ${name}: the filter re-evaluates as it moves (${r.evals})`);
  ok(r.allocs <= most, `${name}: ${r.allocs} targets in 200 frames, at most ${most}`);
}
console.log('(one bundle drawn at two sizes on every frame: the cached result is one texture)');
{
  const F = withLimits(createFakeGl({ width: SZ, height: SZ })),
    gl = F.gl;
  const R = createRenderer(gl, taggedShaderSources(), {});
  R.setViewport(SZ, SZ);
  const b = createBundle(gl, await importSvg(doc(IN), { preserveViewport: true }));
  let allocs = 0;
  const ti = gl.texImage2D.bind(gl);
  gl.texImage2D = (...a) => {
    allocs++;
    return ti(...a);
  };
  for (let i = 0; i < 200; i++) {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b, { worldMatrix: new Float32Array([0.4, 0, 0, 0, 0.4, 0, -0.5, 0.002 * i, 1]) });
    R.drawBundle(b, { worldMatrix: new Float32Array([1.1, 0, 0, 0, 1.1, 0, 0.1, 0.002 * i, 1]) });
    R.endFrame();
  }
  ok(
    R.debugStats.filterEvalCount >= 300,
    `the premise: the filter re-evaluates (${R.debugStats.filterEvalCount})`,
  );
  ok(allocs <= 20, `${allocs} targets in 200 frames, at most 20`);
  R.dispose();
}
console.log(
  '(more bundles than the renderer keeps handles for: a result texture outlives its handle)',
);
{
  const F = withLimits(createFakeGl({ width: SZ, height: SZ })),
    gl = F.gl;
  const R = createRenderer(gl, taggedShaderSources(), {});
  R.setViewport(SZ, SZ);
  const bundles = [];
  for (let i = 0; i < 12; i++)
    bundles.push(
      createBundle(
        gl,
        await importSvg(
          doc(
            `${WIDE_F}<g filter="url(#b)"><rect x="${100 + i}" y="100" width="100" height="60" fill="#c33"/></g>`,
          ),
          { preserveViewport: true },
        ),
      ),
    );
  const frame = (t) => {
    R.beginFrame([1, 1, 1, 1]);
    for (const b of bundles)
      R.drawBundle(b, { worldMatrix: new Float32Array([1, 0, 0, 0, 1, 0, 0.001 * t, 0, 1]) });
    R.endFrame();
  };
  for (let t = 0; t < 10; t++) frame(t);
  let results = 0;
  const ti = gl.texImage2D.bind(gl);
  gl.texImage2D = (...a) => {
    if (a[8] == null) results++;
    return ti(...a);
  };
  for (let t = 10; t < 70; t++) frame(t);
  ok(results <= 24, `${results} targets in 60 frames of 12 bundles, at most 24`);
  R.dispose();
}
console.log('(a target on the quantum shades only its own pixels)');
{
  const F = withLimits(createFakeGl({ width: SZ, height: SZ })),
    gl = F.gl;
  const R = createRenderer(gl, taggedShaderSources(), {});
  R.setViewport(SZ, SZ);
  const b = createBundle(gl, await importSvg(doc(IN), { preserveViewport: true }));
  let vp = [0, 0, SZ, SZ],
    box = [0, 0, 0, 0],
    on = false,
    keep = 0,
    wholeTarget = 0;
  const v0 = gl.viewport.bind(gl),
    s0 = gl.scissor.bind(gl),
    e0 = gl.enable.bind(gl),
    d0 = gl.disable.bind(gl),
    a0 = gl.drawArrays.bind(gl);
  gl.viewport = (x, y, w, h) => {
    vp = [x, y, w, h];
    return v0(x, y, w, h);
  };
  gl.scissor = (x, y, w, h) => {
    box = [x, y, w, h];
    return s0(x, y, w, h);
  };
  gl.enable = (c) => {
    if (c === gl.SCISSOR_TEST) on = true;
    return e0(c);
  };
  gl.disable = (c) => {
    if (c === gl.SCISSOR_TEST) on = false;
    return d0(c);
  };
  gl.drawArrays = (m, f, c) => {
    if (vp[0] === 0 && vp[1] === 0 && vp[2] % 128 === 0 && vp[3] % 128 === 0 && vp[2] < SZ) {
      if (on && box[2] < vp[2] && box[3] < vp[3]) keep++;
      else wholeTarget++;
    }
    return a0(m, f, c);
  };
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(b, { worldMatrix: new Float32Array([1, 0, 0, 0, 1, 0, 0.0137, 0, 1]) });
  R.endFrame();
  ok(keep >= 3, `the passes are scissored to the node's exact rect (${keep} passes)`);
  ok(wholeTarget === 0, `...and none shades the whole target (${wholeTarget})`);
  ok(!on, 'the scissor is handed back off');
  R.dispose();
}
console.log('(a shape that does not move allocates nothing after its first frame)');
for (const [name, svg] of [
  ['crossing the edge', WIDE],
  ['a filtered group crossing the edge', GROUP],
  ['inside the canvas', INSIDE],
]) {
  const r = await run(svg, () => [1, 0], { tint: true });
  ok(r.evals >= 150, `the premise, ${name}: the filter re-evaluates on every frame (${r.evals})`);
  ok(r.allocs === r.first, `${name}: ${r.allocs} targets, all on the first frame (${r.first})`);
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
