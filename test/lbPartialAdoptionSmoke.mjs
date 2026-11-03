// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbPartialAdoptionSmoke.mjs — a bundle draws each shape's Loop-Blinn mesh as it becomes ready.
//
// The build is off-thread and a heavy asset takes seconds. As one whole-bundle result the last shape to
// triangulate would hold back every shape that had finished first, and the bundle would spend those
// seconds entirely on the cover kernel. So the builder posts finished shapes in batches and
// the bundle adopts them, which is only safe because of the property this pins: the unified stream
// already mixes engines SHAPE BY SHAPE, so a half-built bundle is a correct picture in which some
// shapes have not reached their best engine yet — not a half-drawn one.
//
// Asserted here, without a GPU:
//   - a partially built bundle names every shape exactly once, meshed ones as their triangles and the
//     rest as their cover quads;
//   - an unmeshed shape's vertices are BYTE-IDENTICAL to the same shape's in an all-Slug stream, so
//     adoption cannot change what a shape that has not been adopted draws;
//   - a meshed shape's vertices are byte-identical to the same shape's in a fully built stream;
//   - the streamed build reconstructs the whole-bundle result exactly, so a finished bundle's stream
//     is the whole-bundle build's stream;
//   - the worker batches: with no policy it posts a single result, and with one it
//     never exceeds the batch size.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { buildLbBundle, packLbMeshForWire } = await import('../src/renderer/lbBuildCore.js');
const { attachUnifiedFillDraw } = await import('../src/renderer/unifiedFillDraw.js');
const { buildUnifiedFillVerts, UNIFIED_STRIDE } =
  await import('../src/renderer/unifiedFillVerts.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// A cubic star: concave, so it is neither a recognized primitive nor a convex fast-mesh case, and it
// builds a real Loop-Blinn mesh (lbShapePolicySmoke pins that it takes one at every size).
const f = (v) => v.toFixed(3);
function cubicStar(cx, cy, R, r, k) {
  const pts = [];
  for (let i = 0; i < 2 * k; i++) {
    const rad = i % 2 ? r : R,
      t = (Math.PI * i) / k - Math.PI / 2;
    pts.push([cx + rad * Math.cos(t), cy + rad * Math.sin(t)]);
  }
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < 2 * k; i++) {
    const a = pts[i],
      b = pts[(i + 1) % (2 * k)];
    d +=
      ` C${f(a[0] + (b[0] - a[0]) / 3)} ${f(a[1] + (b[1] - a[1]) / 3)}` +
      ` ${f(a[0] + (2 * (b[0] - a[0])) / 3)} ${f(a[1] + (2 * (b[1] - a[1])) / 3)} ${f(b[0])} ${f(b[1])}`;
  }
  return d + ' Z';
}

const N = 6;
const paths = [];
for (let i = 0; i < N; i++) {
  const cx = 150 + (i % 3) * 300,
    cy = 150 + Math.floor(i / 3) * 300;
  paths.push(
    `<path fill="#${(i + 3) % 10}${(i + 5) % 10}${(i + 7) % 10}" d="${cubicStar(cx, cy, 120, 52, 5)}"/>`,
  );
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 600">${paths.join('')}</svg>`;
const sec = await importSvg(svg, { preserveViewport: true });
const pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const n = sec.numShapes | 0;
ok(n === N, `imported ${N} shapes (got ${n})`);

const buildInput = {
  curveFloats: new Float32Array(sec.curves),
  metaFloats: pm.metaFloats,
  metaFloatsPerShape: pm.floatsPerShape,
  ranges: sec.curveRangesByShape,
  numShapes: n,
};
const full = buildLbBundle(buildInput);
const meshesFull = full.packed.map(packLbMeshForWire);
ok(
  meshesFull.every((m) => m && (m.vertexCount | 0) > 0),
  'every star built a real Loop-Blinn mesh',
);

// ---- a bundle the entry builder can walk, with synthetic cover quads --------------------------
// The cover-quad floats only have to be CONSISTENT across the arms: what is asserted is that the same
// shape's bytes do not move, not what they contain.
const CQ = 12,
  VPS = 6; // floats per cover vertex, cover vertices per shape
const cover = new Float32Array(n * VPS * CQ);
const sidx = new Float32Array(n * VPS);
for (let s = 0; s < n; s++) {
  for (let v = 0; v < VPS; v++) {
    const o = (s * VPS + v) * CQ;
    cover[o] = 10 * s + v;
    cover[o + 1] = 20 * s + v;
    cover[o + 2] = 0.25 * v;
    cover[o + 3] = -0.25 * v;
    cover[o + 4] = 30 * s + v;
    cover[o + 5] = 40 * s + v;
    sidx[s * VPS + v] = s;
  }
}
const drawList = [];
for (let s = 0; s < n; s++)
  drawList.push({ kind: 'fillShape', shapeIdx: s, chunk: { vboStart: s * VPS, count: VPS } });

const R = {
  gl: {},
  opts: {},
  draw: {},
  _lbFillMode: 'on',
  _coverChunkStart: (c) => c.vboStart | 0,
  filterRecord: () => null,
};
attachUnifiedFillDraw(R);
ok(typeof R._unifiedFillEntriesFor === 'function', 'the entry builder is reachable for test');

const bundleWith = (meshes) => ({
  _lbMeshes: meshes,
  drawList,
  numShapes: n,
  _geomGen: 0,
  metaFloats: pm.metaFloats,
  metaFloatsPerShape: pm.floatsPerShape,
  coverQuadVboFloats: cover,
  hybridShapeIdxVboFloats: sidx,
});
const streamOf = (meshes) => {
  const entries = R._unifiedFillEntriesFor(bundleWith(meshes));
  if (!entries) return null;
  const built = buildUnifiedFillVerts(entries, cover, sidx);
  return { entries, verts: built.verts, vertexCount: built.vertexCount };
};
// Ranges are stamped on the entries by the builder, so a shape's slice is exactly what it contributed.
const sliceOfShape = (st, s) => {
  const e = st.entries.find((x) => (x.shapeIdx | 0) === s);
  return e
    ? st.verts.subarray(e.vStart * UNIFIED_STRIDE, (e.vStart + e.vCount) * UNIFIED_STRIDE)
    : null;
};
const sameBytes = (a, b) =>
  !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

// ADOPTED: shapes 0, 2 and 4 have landed; 1, 3 and 5 are still in the builder.
const ADOPTED = [0, 2, 4];
const meshesNone = new Array(n); // nothing built yet
const meshesPart = new Array(n);
for (const s of ADOPTED) meshesPart[s] = meshesFull[s];

const stNone = streamOf(meshesNone),
  stPart = streamOf(meshesPart),
  stFull = streamOf(meshesFull);
ok(!!stNone && !!stPart && !!stFull, 'all three arms produced a stream');

// --- every shape is named exactly once, whatever has been adopted
for (const [name, st, adopted] of [
  ['none', stNone, []],
  ['partial', stPart, ADOPTED],
  ['full', stFull, [0, 1, 2, 3, 4, 5]],
]) {
  const seen = st.entries.map((e) => e.shapeIdx | 0).sort((a, b) => a - b);
  ok(
    seen.length === n && seen.every((v, i) => v === i),
    `${name}: every shape appears exactly once`,
  );
  const kinds = new Map(st.entries.map((e) => [e.shapeIdx | 0, e.kind]));
  let right = true;
  for (let s = 0; s < n; s++)
    if (kinds.get(s) !== (adopted.includes(s) ? 'lb' : 'cover')) right = false;
  ok(right, `${name}: adopted shapes draw their triangles, the rest their cover quads`);
}

// --- THE LOAD-BEARING ONE: adoption does not disturb a shape that has not been adopted
let slugSame = true,
  lbSame = true;
for (let s = 0; s < n; s++) {
  if (ADOPTED.includes(s))
    lbSame = lbSame && sameBytes(sliceOfShape(stPart, s), sliceOfShape(stFull, s));
  else slugSame = slugSame && sameBytes(sliceOfShape(stPart, s), sliceOfShape(stNone, s));
}
ok(slugSame, 'an unadopted shape is byte-identical to its all-Slug stream (Slug output unchanged)');
ok(lbSame, 'an adopted shape is byte-identical to its fully built stream');

// --- and once everything is adopted, the stream is the whole-bundle build's
ok(
  sameBytes(stFull.verts, streamOf(meshesFull.slice()).verts),
  'a fully adopted stream is byte-identical to the whole-bundle stream',
);

// ---- the worker: batching, and a streamed build that reconstructs the whole-bundle result -------
const posted = [];
globalThis.self = {
  postMessage: (m) => {
    posted.push(m);
  },
};
await import('../src/renderer/lbBuild.worker.js');
const runWorker = (extra) => {
  posted.length = 0;
  globalThis.self.onmessage({
    data: {
      id: 1,
      curves: new Float32Array(sec.curves),
      meta: pm.metaFloats,
      metaFloatsPerShape: pm.floatsPerShape,
      ranges: sec.curveRangesByShape,
      numShapes: n,
      ...extra,
    },
  });
  return posted.slice();
};

const plain = runWorker({});
ok(
  plain.length === 1 &&
    !plain[0].streamed &&
    Array.isArray(plain[0].packed) &&
    plain[0].packed.length === n,
  'no batch policy: the worker posts the single whole-bundle result it always posted',
);

const BATCH = 2;
const streamed = runWorker({ adoptShapes: BATCH, adoptMs: 0 });
const partials = streamed.filter((m) => m.kind === 'lbPartial');
const final = streamed[streamed.length - 1];
ok(partials.length >= 2, `batched: the worker posted ${partials.length} batches before the result`);
ok(
  partials.every((m) => m.shapes.length <= BATCH),
  `no batch exceeds the batch size (${BATCH})`,
);
ok(
  !!final.streamed && final.packed === null && !!final.tail,
  'the result carries only the tail, not the whole bundle',
);

// Reconstruct exactly as the main thread does, then check it against the unstreamed build.
const rebuilt = new Array(n);
for (const m of partials)
  for (let i = 0; i < m.shapes.length; i++) rebuilt[m.shapes[i]] = m.meshes[i];
for (let i = 0; i < final.tail.shapes.length; i++)
  rebuilt[final.tail.shapes[i]] = final.tail.meshes[i];
for (let s = 0; s < n; s++) if (rebuilt[s] === undefined) rebuilt[s] = null;

const counts = new Map();
for (const m of partials) for (const s of m.shapes) counts.set(s, (counts.get(s) || 0) + 1);
for (const s of final.tail.shapes) counts.set(s, (counts.get(s) || 0) + 1);
ok(
  counts.size === n && [...counts.values()].every((c) => c === 1),
  'every shape crosses the wire exactly once (no shape sent twice, none dropped)',
);

const wireSame = (a, b) =>
  (a === null && b === null) ||
  (!!a &&
    !!b &&
    a.vertexCount === b.vertexCount &&
    a.prim === b.prim &&
    a.kindMask === b.kindMask &&
    a.hasBezout === b.hasBezout &&
    sameBytes(a.verts, b.verts));
ok(
  rebuilt.every((m, s) => wireSame(m, plain[0].packed[s])),
  'the streamed build reconstructs the whole-bundle result byte for byte',
);
ok(
  sameBytes(streamOf(rebuilt).verts, streamOf(plain[0].packed).verts),
  'and its finished stream is byte-identical to the unstreamed one',
);

console.log(fail ? `\nFAIL ${fail}` : '\nall ok');
process.exit(fail ? 1 : 0);
