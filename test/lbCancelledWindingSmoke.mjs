// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbCancelledWindingSmoke -- the Loop-Blinn partition reads a curve's sides, and the faces inside its control triangle, from the
// whole outline's winding.
//
// Nine ways a partial reading goes wrong, each a plain path with a wrong region and none of them a decline:
//   * Another subpath's fill inside a quad's control triangle, on the far side of the arc: the arc's implicit carves it away.
//   * A neighbor close to the arc's midpoint on the air side (within 2% of the shape): the arc reads "ink on both sides", the
//     invisible boundary of a same-wound nested contour, and its whole hull paints solid over the air between them.
//   * A curve its own path retraces, or a copy it cancels: air on both sides, and a crescent painted between arc and chord.
//   * A straight contour with no area (`M a L b`): a hairline of half coverage down each edge.
//   * A polygon about 100 to 1 whose vertices follow a gentle arc: most of its triangles go with the super-triangle.
//   * A plus sign at fractional coordinates: a face side running on along an arm's edge takes that edge as a corner partner.
//   * A straight edge wholly inside another subpath's fill, in a shape that also has a curve: a hairline of half coverage through ink.
//   * A curve rounded a hair apart from its neighbor: the sliver of air reads as two boundaries, and two half ramps cannot add up to ink.
// A same-wound nested contour must stay invisible, so it is a case too.
//
// No GPU. Through the kernel's CPU twin against the path's exact coverage, at three sizes of the same art. A pixel with exact
// coverage flat across its neighbors is not an antialiasing question, so it is scored to 1/8.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const R = await import('../probes/lbAccuracy/_lbRaster.mjs');
const REF = await import('../probes/lbAccuracy/_lbAaRef.mjs');
const { default: importSvg } = await import('../src/svg/importer.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};

const N = 128;
const QUAD = 'M10 100Q64 0 118 100Z',
  CUB = 'M10 100C30 0 98 0 118 100Z';
const CASES = [
  // [name, path, rule, the mesh is expected to exist]
  // A straight-edge row along a chord the crescent carries ink across: 14 flat pixels in solid fill on the fast mesh.
  [
    'one contour of fat quads',
    'M115.38 68.119Q107.898 82.542 95.431 99.462Q74.08 125.421 56.994 107.292Q28.109 104.894 24.047 86.505Q-3.357 61.657 18.905 40.714Q27.211 17.27 53.731 17.151Q79.957 16.086 93.728 24.637Q118.308 41.796 115.38 68.119Z',
    'nonzero',
    true,
  ],
  ['rect in a quad hull', QUAD + 'M20 10H108V20H20Z', 'nonzero', true],
  ['rect in a quad hull, even-odd', QUAD + 'M20 10H108V20H20Z', 'evenodd', true],
  ['triangle in a quad hull', QUAD + 'M64 30L100 10L28 10Z', 'nonzero', true],
  ['triangle 5 from the arc', QUAD + 'M64 45L100 10L28 10Z', 'nonzero', true],
  ['triangle 1 from the arc', QUAD + 'M64 49L100 10L28 10Z', 'nonzero', true],
  ['triangle touching the arc', QUAD + 'M64 50L100 10L28 10Z', 'nonzero', true],
  ['triangle 1 from a cubic', CUB + 'M64 24L100 2L28 2Z', 'nonzero', true],
  ['retraced quad', 'M92 73Q12 62 24 98Q12 62 92 73L56 110Q31 106 92 73Z', 'nonzero', true],
  ['retraced cubic', 'M92 73C12 62 30 40 24 98C30 40 12 62 92 73L56 110L100 100Z', 'nonzero', true],
  [
    'same-wound nested quads',
    'M10 64Q10 10 64 10Q118 10 118 64Q118 118 64 118Q10 118 10 64Z' +
      'M30 64Q30 30 64 30Q98 30 98 64Q98 98 64 98Q30 98 30 64Z',
    'nonzero',
    true,
  ],
  [
    'same-wound nested cubics',
    'M10 64C10 10 118 10 118 64C118 118 10 118 10 64ZM30 64C30 30 98 30 98 64C98 98 30 98 30 64Z',
    'nonzero',
    true,
  ],
  [
    'a plus sign at fractional coordinates',
    'M112.3 44.6L112.3 83.4L83.4 83.4L83.4 112.1L44.6 112.1L44.6 83.4L15.7 83.4L15.7 44.6L44.6 44.6L44.6 15.9L83.4 15.9L83.4 44.6L112.3 44.6Z',
    'nonzero',
    true,
  ],
  // Two pieces of art whose shared curve was rounded apart by 0.01: under a pixel of air. Each curve read as a boundary of its own leaves a seam of two half ramps.
  [
    'a cubic rounded apart from its neighbor',
    'M20 64C40 20 88 20 108 64ZM108 64C88 19.99 40 19.99 20 64L20 10L108 10Z',
    'nonzero',
    true,
  ],
  [
    'the same, opposite winding',
    'M20 64C40 20 88 20 108 64ZM20 64C40 19.99 88 19.99 108 64L108 10L20 10Z',
    'nonzero',
    true,
  ],
  [
    'the same, even-odd',
    'M20 64C40 20 88 20 108 64ZM20 64C40 19.99 88 19.99 108 64L108 10L20 10Z',
    'evenodd',
    true,
  ],
  [
    'a quad rounded apart from its neighbor',
    'M20 64Q64 20 108 64ZM108 64Q64 19.99 20 64L20 10L108 10Z',
    'nonzero',
    true,
  ],
  // A straight edge wholly inside another subpath's fill is not outline, in a shape with a curve as in one without.
  [
    'a straight edge inside a curved subpath',
    'M10 64C10 20 68 20 68 64C68 108 10 108 10 64ZM113 64L94 90L62.3 80.5L62.3 47.5L94 37Z',
    'nonzero',
    true,
  ],
  [
    'a straight edge 1 from a curved subpath keeps its side',
    'M10 64C10 20 68 20 68 64C68 108 10 108 10 64ZM113 64L94 90L69 80.5L69 47.5L94 37Z',
    'nonzero',
    true,
  ],
  ['collinear subpath beside a shape', QUAD + 'M10 110L118 110', 'nonzero', true],
];
// A fan of 8 vertices along a gentle arc over a long bar, 6000 by 60: the triangulation's super-triangle took 95% of its area with it.
{
  let d = '';
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    d += (i ? 'L' : 'M') + (64 - 3000 + 6000 * t) + ' ' + (90 - 240 * t * (1 - t));
  }
  CASES.push([
    'a long flat fan and a bar',
    d + 'L3064 92L-2936 92ZM-2936 93L3064 93L3064 94L-2936 94Z',
    'nonzero',
    true,
  ]);
}
const FAST_LEVEL = [
  [
    'a touching curve, ink lost',
    'M32 64Q40 56 48 64V80H32ZM64 72Q72 56 80 72Q88 88 96 72Q80 96 64 72Z',
    'nonzero',
  ],
  ['a touching curve, ink over', 'M32 56Q52 48 72 56V104H32ZM80 80Q96 48 112 80Z', 'evenodd'],
];
const scaled = (d, k) => d.replace(/-?\d+(\.\d+)?/g, (v) => String(+v * k));

async function solidWrong(d, rule, k, buildOpts) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${128 * k} ${128 * k}" width="${N}" height="${N}"><path fill-rule="${rule}" d="${scaled(d, k)}"/></svg>`;
  const b = await importSvg(svg, { preserveViewport: true });
  const { shapes } = await R.shapesOf(b, { rows: 'fill' });
  const g = b.globalBBox,
    view = R.viewOf([g[0], g[1], g[0] + g[2], g[1] + g[3]], N);
  const { rowSpans, contoursToConverter, closed } = await REF.refKit();
  const acc = new Float64Array(N * N).fill(1),
    ref = new Float64Array(N * N);
  let meshes = 0;
  for (const sh of shapes) {
    const m = buildLbShape(sh.contours, sh.transSolid, sh.evenOdd, buildOpts);
    if (!m || !m.pk || !m.pk.vertexCount || (m.pk.fallback && m.pk.fallback.length)) continue;
    meshes++;
    R.rasterMesh(m.pk, view, acc);
    const cur = closed(contoursToConverter(sh.contours)),
      cache = new Map();
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++)
        ref[j * N + i] = Math.max(
          ref[j * N + i],
          REF.exactCov(rowSpans, cur, i, j, view, 16, sh.evenOdd, cache),
        );
  }
  let wrong = 0,
    far = 0;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) if (Math.abs(1 - acc[j * N + i] - ref[j * N + i]) > 0.38) far++;
  for (let j = 1; j < N - 1; j++)
    for (let i = 1; i < N - 1; i++) {
      const r = ref[j * N + i];
      let flat = true;
      for (let dy = -1; dy <= 1 && flat; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (Math.abs(ref[(j + dy) * N + i + dx] - r) > 0.01) {
            flat = false;
            break;
          }
      if (flat && Math.abs(1 - acc[j * N + i] - r) > 0.125) wrong++;
    }
  return { wrong, far, meshes };
}

for (const [name, d, rule, wantMesh] of CASES) {
  for (const k of [1, 2 ** -20, 2 ** 20]) {
    const { wrong, meshes } = await solidWrong(d, rule, k);
    ok(
      wrong === 0 && (!wantMesh || meshes > 0),
      `${name} at x${k}: ${wrong} solid pixels wrong, ${meshes} mesh`,
    );
  }
}

// The stream route's fast build: a row level with a vertex of another contour. The resolver's fill test read a curve only touching that row as crossing it, and
// gave the contour the wrong side, or dropped it: a vertical side's midpoint is that row whenever the art is on a grid.
for (const [name, d, rule] of FAST_LEVEL) {
  for (const k of [1, 2 ** -20, 2 ** 20]) {
    const { wrong, meshes } = await solidWrong(d, rule, k, { fastCorrect: true });
    ok(
      wrong === 0 && meshes > 0,
      `fast build: ${name} at x${k}: ${wrong} solid pixels wrong, ${meshes} mesh`,
    );
  }
}

// A curve whose control points are on its chord is a line: drawn as a curve it has no crescent and no edge strip, and its edge comes out jagged. This one is on the edge, so
// every pixel is scored. A real strip that turns into a polygon stays on the partition: the fast route's chain reads a long thin side worse.
for (const [name, d] of [
  ['a straight quad', 'M0 0H100Q90 25 80 50Q90 75 100 100H0Z'],
  ['a straight cubic', 'M10 10H100C94 25 86 45 80 60L10 60Z'],
  [
    'a long thin strip with a straight cubic',
    'M148.44 72.57L87.43 10.94L81.72 10.94C81.72 10.94 143.65 73.19 143.65 73.19L148.44 73.19Z',
  ],
]) {
  const { far, meshes } = await solidWrong(d, 'nonzero', 1);
  ok(far === 0 && meshes > 0, `${name}: ${far} pixels off by more than 3/8`);
}

console.warn = warn;
if (fail) {
  console.log(`lbCancelledWindingSmoke: ${fail} FAILED`);
  process.exit(1);
}
console.log('lbCancelledWindingSmoke: PASS');
