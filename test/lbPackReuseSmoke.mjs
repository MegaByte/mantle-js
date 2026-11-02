// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbPackReuseSmoke -- a stream packs each frame over last frame's vertex buffer. A mesh packed over a dirty buffer draws what the
// same mesh packed fresh draws. The kernel reads a chain face's second chain whenever a slot is nonzero, so a face with no chain 2
// must not inherit the slots a previous frame's chain 2 wrote.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { packLoopBlinnMesh, LB_VERT_FLOATS } = await import('../src/renderer/lbPack.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};
const contoursOf = async (d) => {
  const b = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="${d}"/></svg>`,
    { preserveViewport: true },
  );
  const r = b.curveRangesByShape[0];
  return curveRangeToContours(new Float32Array(b.curves), r.begin, r.end);
};
// The same triangle-and-arc outline, one frame apart: the first frame's faces carry a second chain, the next frame's do not, at one vertex count.
const frame = (g) => `M10 100Q64 ${100 + g} 118 100L64 ${100 - g * 3}Z`;
const a = buildLbShape(await contoursOf(frame(2)), false, false, { fastCorrect: true });
const b = buildLbShape(await contoursOf(frame(3)), false, false, { fastCorrect: true });
ok(
  !!a.raw.interiorChainD && !b.raw.interiorChainD,
  'the first frame has a second chain and the next does not',
);
ok(
  a.pk.vertexCount === b.pk.vertexCount,
  `one vertex count across the frames, so the buffer is reused (${a.pk.vertexCount}, ${b.pk.vertexCount})`,
);
const fresh = packLoopBlinnMesh(b.raw);
const reused = packLoopBlinnMesh(b.raw, { verts: a.pk.verts.slice() });
let moved = 0;
for (let i = 0; i < fresh.verts.length; i++) if (fresh.verts[i] !== reused.verts[i]) moved++;
ok(
  moved === 0,
  `packed over the last frame's buffer, the frame's vertices equal a fresh pack (${moved} of ${fresh.verts.length} floats differ, ${LB_VERT_FLOATS} a vertex)`,
);
console.warn = warn;
if (fail) {
  console.log(`lbPackReuseSmoke: ${fail} FAILED`);
  process.exit(1);
}
console.log('lbPackReuseSmoke: PASS');
