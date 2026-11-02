// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchAreaGateSmoke.mjs -- the area cost gate (lbShapePolicy areaCellLoses): a complete-paint area is ONE cell whose fragment
// shader walks all of its curves for every pixel of the shape's box, so over a large box with many curves it costs more than the
// cover quad (CPatch pinned, tiger at 2048 px: 46 -> 68-71 ms with 348 more shapes on the area cell). The cost is curves x box
// device pixels, so the gate follows the draw's scale: a row the gate prices out draws its cover quad, and the same row is an area
// cell again at a smaller size.
//
//   * the rule: over the limit loses, at it does not; monotone in curves and in box pixels; a mesh with no curve count (a
//     decomposition) and a limit that is off never lose
//   * a PINNED CPatch bundle draws every mesh at any size: the answer is null whatever the limit (the request wins over the gate)
//   * 'cpatch-auto' is asked to pick, so the gate decides there: a row it prices out takes its cover quad, per scale, and the box past the canvas is not priced
//   * the decision is made in device pixels: the same art 2^20 times larger or smaller, drawn at the same size, decides the same
//   * 'auto' (cpatch-auto) declines the same rows
const P = await import('../src/renderer/lbShapePolicy.js');
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__LB_MIN_BUNDLE_PX2 = 0;
const setLimit = (v) => {
  if (v === undefined) delete globalThis.__CP_AREA_PX;
  else globalThis.__CP_AREA_PX = v;
};

// the rule
ok(typeof P.areaCellLoses === 'function', 'areaCellLoses is exported');
if (typeof P.areaCellLoses === 'function') {
  ok(P.areaCellLoses(10, 1000, 10000) === false, 'exactly at the limit does not lose');
  ok(
    P.areaCellLoses(11, 1000, 10000) === true && P.areaCellLoses(10, 1001, 10000) === true,
    'over it loses',
  );
  ok(P.areaCellLoses(0, 1e12, 10) === false, 'a mesh with no area curve count never loses');
  ok(P.areaCellLoses(1000, 1e12, Infinity) === false, 'a limit that is off never loses');
  let flips = 0,
    prev = false;
  for (let c = 1; c <= 500; c++) {
    const v = P.areaCellLoses(c, 700, 50000);
    if (prev && !v) flips++;
    prev = v;
  }
  ok(flips === 0, 'monotone in curves: once over, a larger count is not under');
}

// a bundle of three rectangles-as-cubics at different sizes: BIG (the whole viewBox), SMALL (a 1/20 square), WIDE (half)
const rect = (x, y, w, h) =>
  `M${x} ${y} C${x + w / 3} ${y} ${x + (2 * w) / 3} ${y} ${x + w} ${y} C${x + w} ${y + h / 3} ${x + w} ${y + (2 * h) / 3} ${x + w} ${y + h} C${x + (2 * w) / 3} ${y + h} ${x + w / 3} ${y + h} ${x} ${y + h} C${x} ${y + (2 * h) / 3} ${x} ${y + h / 3} ${x} ${y} Z`;
async function bundleOf(scale = 1) {
  const S = scale,
    d = (a, b, c, e) => rect(a * S, b * S, c * S, e * S);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${1000 * S} ${1000 * S}"><path fill="#111" d="${d(0, 0, 1000, 1000)}"/><path fill="#222" d="${d(100, 100, 50, 50)}"/><path fill="#333" d="${d(0, 500, 1000, 500)}"/></svg>`;
  const b = await importSvg(svg);
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  return {
    curveFloats: new Float32Array(b.curves),
    curveRangesByShape: b.curveRangesByShape,
    numShapes: b.numShapes,
    metaFloats: pm.metaFloats,
    metaFloatsPerShape: pm.floatsPerShape,
    segTypeMask: b.segTypeMask,
    globalBBox: b.globalBBox,
  };
}
const R = (N, opts) => ({
  viewportSize: () => [N, N],
  arScale: () => [1, 1],
  draw: {},
  opts: opts || {},
  _lbFillMode: 'on',
});
const areaMesh = (curves) => ({
  vertexCount: 6,
  cpatch: true,
  cpatchAreaOnly: true,
  areaCurves: curves,
});
const cellMesh = () => ({ vertexCount: 90, cpatch: true, cpatchAreaOnly: false, cells: 15 });
const meshes = () => [areaMesh(96), areaMesh(96), areaMesh(8)];

// px^2 of box x curves: BIG 96 x N^2, SMALL 96 x N^2/400, WIDE 8 x N^2/2. Limit 4e7: at N=128 BIG is 1.6e6 (pays); at N=2048 BIG is 4.0e8 (loses),
// SMALL 1.0e6 (pays), WIDE 1.7e7 (pays).
const LIMIT = 4e7;
setLimit(LIMIT);
const pin = { cpatchFill: true },
  auto = { cpatchAuto: true };
const allPicked = (a) => !!a && Array.from(a).every((v) => v === 1);
let b = await bundleOf();
b._cpatchBuilt = 3;
ok(
  allPicked(P.lbShapePicks(R(128, auto), b, meshes())),
  'cpatch-auto, nothing over the limit at 128 px: every row keeps its cell',
);
const at2048 = P.lbShapePicks(R(2048, auto), b, meshes());
ok(
  at2048 && at2048[0] === 0 && at2048[1] === 1 && at2048[2] === 1,
  `cpatch-auto at 2048 px: the big many-curve area yields its cover quad, the small and the few-curve keep the cell (${at2048 && Array.from(at2048)})`,
);
ok(
  allPicked(P.lbShapePicks(R(128, auto), b, meshes())),
  'cpatch-auto, back at 128 px the cell is taken again',
);
{
  const m = [areaMesh(96), areaMesh(96), areaMesh(96)];
  setLimit(1);
  ok(
    P.lbShapePicks(R(2048, auto), b, m) === null,
    'cpatch-auto, every row priced out: null, the route draws nothing of it',
  );
  setLimit(LIMIT);
}
{
  const m = [cellMesh(), cellMesh(), cellMesh()];
  ok(
    allPicked(P.lbShapePicks(R(2048, auto), b, m)),
    'cpatch-auto: a decomposition has no curve count to price',
  );
}
// THE PIN: the request wins. Every mesh draws, at any size and under any limit.
{
  const bp = await bundleOf();
  bp._cpatchBuilt = 3;
  for (const N of [128, 2048])
    for (const limit of [LIMIT, 1]) {
      setLimit(limit);
      ok(
        P.lbShapePicks(R(N, pin), bp, meshes()) === null,
        `pinned at ${N} px, limit ${limit}: null, every mesh draws`,
      );
    }
  setLimit(LIMIT);
  ok(
    P.lbShapePicks(R(2048, pin), bp, [cellMesh(), cellMesh(), cellMesh()]) === null,
    'pinned decompositions draw too',
  );
  const k0 = bp._lbPickKey | 0;
  for (const N of [128, 512, 2048]) P.lbShapePicks(R(N, pin), bp, meshes());
  ok(
    (bp._lbPickKey | 0) === k0,
    'a pin never rebuilds the stream on a size change: the answer does not move',
  );
}
setLimit(undefined);
ok(
  Number.isFinite(P.CP_AREA_MAX_CURVE_PX2) && P.CP_AREA_MAX_CURVE_PX2 > 0,
  `the shipped limit is finite and positive (${P.CP_AREA_MAX_CURVE_PX2})`,
);
{
  // the shipped limit: a 96-curve area over a quarter of a 2048 px viewport loses, the same area at 128 px does not, a small part never does
  const L = P.CP_AREA_MAX_CURVE_PX2;
  ok(
    P.areaCellLoses(96, (2048 * 2048) / 4) === (96 * 2048 * 2048) / 4 > L &&
      P.areaCellLoses(96, (2048 * 2048) / 4),
    '96 curves over a quarter of 2048 px loses at the shipped limit',
  );
  ok(
    !P.areaCellLoses(96, 128 * 128) && !P.areaCellLoses(4, (2048 * 2048) / 200),
    '96 curves over all of 128 px, and 4 curves over a 1/200 part at 2048 px, keep the cell',
  );
}
setLimit(LIMIT);

// device pixels, not units: the art 2^20 times larger or smaller drawn at the same size decides the same
for (const S of [2 ** -20, 2 ** 20]) {
  const bs = await bundleOf(S);
  bs._cpatchBuilt = 3;
  const a = P.lbShapePicks(R(2048, auto), bs, meshes());
  ok(
    a && a[0] === 0 && a[1] === 1 && a[2] === 1,
    `art at scale ${S}: the same rows lose at 2048 px`,
  );
  ok(
    allPicked(P.lbShapePicks(R(128, auto), bs, meshes())),
    `art at scale ${S}: nothing loses at 128 px`,
  );
}

// the pixels an area cell can shade are on the canvas: under cpatch-auto a few-curve row keeps its cell at any zoom, a many-curve row over the canvas still loses
{
  const wm = (z) => new Float32Array([z, 0, 0, 0, z, 0, 0, 0, 1]);
  const Rz = (N, z, opts) => ({ ...R(N, opts), draw: { worldM: wm(z) } });
  const bz = await bundleOf();
  bz._cpatchBuilt = 3;
  const few = [areaMesh(2), areaMesh(2), areaMesh(2)],
    many = [areaMesh(1024), areaMesh(1024), areaMesh(1024)];
  setLimit(3e6);
  for (const z of [1, 16, 65536, 2 ** 20])
    ok(
      allPicked(P.lbShapePicks(Rz(512, z, auto), bz, few)),
      `cpatch-auto, 2 curves on a 512 px canvas at zoom ${z}: 2 x the canvas pays, every row keeps its cell`,
    );
  ok(
    P.lbShapePicks(Rz(512, 65536, auto), bz, many) === null,
    'cpatch-auto, 1024 curves past the canvas: 1024 x the canvas does not pay, no row keeps its cell',
  );
  ok(
    P.lbShapePicks(Rz(512, 65536, pin), bz, many) === null && !bz._lbPickCache.picks,
    'pinned, the same rows: every mesh draws',
  );
  setLimit(LIMIT);
}

setLimit(undefined);
console.log(fail ? `\n${fail} FAILED` : '\nall ok');
process.exit(fail ? 1 : 0);
