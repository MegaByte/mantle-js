// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterScratchCeilingSmoke -- filter scratch has a ceiling while filters run.
//
// The only trim waits for a long filter-free stretch, so a long zoom keeps every target size it crosses. Past the ceiling (the larger of 256 MiB and six canvases of color + depth/stencil) the targets neither of the
// last two frames used are freed. A working set in use is never freed, however far past the ceiling it is. How little a moving shape allocates at all: filterFrameAllocSmoke.
// CPU (test/_fakeGl.mjs): the memory ledger's bytes and the targets allocated.
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
const SZ = 1024,
  MIB = 1048576;
const DEFS =
  '<defs><filter id="b" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="8"/><feOffset dx="3" dy="3"/></filter></defs>';
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">${DEFS}<rect x="-40" y="100" width="500" height="120" fill="#c33" filter="url(#b)"/></svg>`;
// Filtered rows of many sizes: the sizes do not share a target, and all of them are asked for on every frame.
const sized = () => {
  let b = '';
  for (let x = 1; x <= 10; x++)
    for (let y = 1; y <= 10; y++)
      b += `<rect x="0" y="0" width="${x * 40}" height="${y * 40}" fill="#c33" filter="url(#b)"/>`;
  return b;
};
const MANY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">${DEFS}${sized()}</svg>`;
const rig = async (svg, opts = {}, size = SZ) => {
  const F = withLimits(createFakeGl({ width: size, height: size })),
    gl = F.gl;
  const R = createRenderer(gl, taggedShaderSources(), opts);
  R.setViewport(size, size);
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  let allocs = 0;
  const ti = gl.texImage2D.bind(gl);
  gl.texImage2D = (...a) => {
    allocs++;
    return ti(...a);
  };
  const frame = (z, tx) => {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b, { worldMatrix: new Float32Array([z, 0, 0, 0, z, 0, tx, 0, 1]) });
    R.endFrame();
  };
  const table = createOverrideTable(gl, b),
    rows = b.drawList.filter((o) => o.kind === 'fillShape').map((o) => o.shapeIdx);
  const moving = (i) => {
    for (const row of rows) table.set(row, { tint: [1, 1 - (i % 16) / 64, 1, 1] });
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b, {
      overrides: table,
      worldMatrix: new Float32Array([1.5, 0, 0, 0, 1.5, 0, 0, 0, 1]),
    });
    R.endFrame();
  };
  const pool = () => R.getMemoryStats().gpu.byCategory.pool?.bytes || 0;
  return { R, frame, moving, pool, allocs: () => allocs };
};
console.log('(a long zoom)');
{
  const { R, frame, pool } = await rig(SVG);
  let peak = 0;
  for (let i = 0; i <= 200; i++) {
    frame(1 + i * 0.02, 0);
    peak = Math.max(peak, pool());
  }
  // the ceiling, plus what the frames it may not touch hold: at most a frame-sized color + depth/stencil target and two color targets each, on the zoom's largest frame
  const limit = 256 * MIB + 2 * 40 * MIB;
  ok(
    R.debugStats.scratchTrim.ceilingFreedBytes > 0,
    `the premise: the ceiling was reached (${(R.debugStats.scratchTrim.ceilingFreedBytes / MIB) | 0} MiB freed)`,
  );
  ok(
    peak <= limit,
    `scratch stays near the ceiling (peak ${(peak / MIB) | 0} MiB, limit ${(limit / MIB) | 0} MiB)`,
  );
  R.dispose();
}
console.log('(a working set in use, past the ceiling)');
{
  const { R, moving, pool, allocs } = await rig(MANY, { filterCacheBytes: 4 * 1024 * MIB }); // (the results are not what this is about)
  moving(0);
  moving(1);
  const a0 = allocs(),
    held = pool(),
    v0 = R.debugStats.filterEvalCount;
  for (let i = 0; i < 6; i++) moving(i + 2);
  ok(
    R.debugStats.filterEvalCount - v0 >= 6,
    `the premise: the filter re-evaluates on every frame (${R.debugStats.filterEvalCount - v0})`,
  );
  ok(held > 256 * MIB, `the premise: it holds more than the ceiling (${(held / MIB) | 0} MiB)`);
  ok(
    allocs() === a0,
    `it finds its targets on every frame: nothing is allocated (${allocs() - a0})`,
  );
  ok(pool() === held, `...and nothing is freed (${(pool() / MIB) | 0} MiB)`);
  R.dispose();
}
console.log('(under the ceiling nothing moves)');
{
  const { R, frame } = await rig(SVG);
  for (let i = 0; i < 30; i++) frame(1 + (i % 3) * 0.1, 0);
  ok(R.debugStats.scratchTrim.ceilingFreedBytes === 0, 'nothing is freed');
  R.dispose();
}
console.log('(the ceiling is not an option)');
{
  const { createRenderer: cr } = await import('../src/index.js');
  const F = withLimits(createFakeGl({ width: 64, height: 64 }));
  const warnings = [];
  const w0 = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  const R = cr(F.gl, taggedShaderSources(), { filterScratchMaxBytes: 1024 });
  console.warn = w0;
  ok(
    warnings.some((w) => w.includes('filterScratchMaxBytes')),
    'the option is an unknown one',
  );
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
