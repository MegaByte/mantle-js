// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbBandFootprintSmoke — a curve band's tight footprint (lbPack band12TightFootprint) rasterizes every
// fragment the padded bbox did that the band kernel can keep, rasterizes each once, and adds none.
//
// A bbox-mode band rasterizes its control triangle's bbox pushed out a quarter pixel, and the kernel discards most of
// it. The tight footprint drops the regions the kernel discards at every
// point -- T itself, and for an unchained band the bbox beyond the legs (sign < 0) or beyond the chord within
// 0 <= u <= 1 (sign > 0) -- and tiles the rest with convex cells and a frame. It is opt-in: __LB_BAND_FOOTPRINT = 'tight'.
//
// No GPU. (a) The tiling, on random control triangles (generic, grid-snapped, thin; three scales and offsets) at three
// pixel sizes: every sample of the bbox footprint outside the removed set is covered exactly once, none twice, and no
// vertex leaves the bbox footprint. (b) The removed set, against the kernel's own tests: every removed sample is inside
// T (hull turf) or, unchained, has f = s (u^2 - v) <= 0 (the band's f < 0 discard; f = 0 only at T's corners). (c) The
// pack: with the switch on, a quad shape's bands keep their flat slots and only kind 12 gains vertices; with it off the
// stream is the bbox one. (d) A morph pair's packs ignore the switch (their two poses are lerped vertex for vertex).
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { band12TightFootprint, LB_VERT_FLOATS: VF } = await import('../src/renderer/lbPack.js');
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { buildLbBundle } = await import('../src/renderer/lbBuildCore.js');
const { buildMorphBundle } = await import('../src/renderer/lbMorphCore.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const t0 = Date.now();
const warn = console.warn;
console.warn = () => {};

// ── (a) + (b): tiling and the removed set ────────────────────────────────────────────────────────────────────────────
{
  let seed = 7;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
  const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let cases = 0,
    holes = 0,
    doubles = 0,
    outside = 0,
    removedBad = 0,
    removedN = 0,
    keptN = 0;
  for (let it = 0; it < 1500; it++) {
    const SC = [1e-3, 1, 1e4][it % 3],
      OX = [0, 1000, -3e5][it % 3],
      thin = rnd() < 0.3 ? 0.02 : 1,
      grid = rnd() < 0.5;
    const pt = () =>
      grid
        ? [OX + (SC * Math.round(rnd() * 8)) / 2, OX + (SC * Math.round(rnd() * 8)) / 2]
        : [OX + SC * rnd() * 10, OX + SC * thin * rnd() * 10];
    const a = pt(),
      c = pt(),
      b = pt();
    const det = (c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0]);
    if (!(Math.abs(det) > 1e-3 * SC * SC)) continue;
    const sign = rnd() < 0.5 ? -1 : 1,
      unchained = rnd() < 0.7;
    const fp = band12TightFootprint(a[0], a[1], c[0], c[1], b[0], b[1], sign, unchained, Infinity);
    if (!fp) continue;
    cases++;
    const x0 = Math.min(a[0], b[0], c[0]),
      x1 = Math.max(a[0], b[0], c[0]),
      y0 = Math.min(a[1], b[1], c[1]),
      y1 = Math.max(a[1], b[1], c[1]);
    // The kernel's uv frame: a = (0,0), c = (1/2,0), b = (1,1); R == 1 (integral).
    const e1x = c[0] - a[0],
      e1y = c[1] - a[1],
      e2x = b[0] - a[0],
      e2y = b[1] - a[1],
      dd = e1x * e2y - e1y * e2x;
    const Hux = (0.5 * e2y - e1y) / dd,
      Huy = (e1x - 0.5 * e2x) / dd,
      Hvx = -e1y / dd,
      Hvy = e1x / dd;
    const uv = (p) => [
      Hux * (p[0] - a[0]) + Huy * (p[1] - a[1]),
      Hvx * (p[0] - a[0]) + Hvy * (p[1] - a[1]),
    ];
    const hull = (u, v, e) => v >= -e && u >= v - e && 1 - 2 * u + v >= -e;
    for (const d of [0.013, 0.37, 2.9].map((x) => x * SC)) {
      for (const q of fp) {
        const X = q[0] + q[2] * d,
          Y = q[1] + q[3] * d,
          e = 1e-9 * SC;
        if (X < x0 - d - e || X > x1 + d + e || Y < y0 - d - e || Y > y1 + d + e) outside++;
      }
      const tr = [];
      for (let i = 0; i < fp.length; i += 3)
        tr.push(
          [0, 1, 2].map((k) => [fp[i + k][0] + fp[i + k][2] * d, fp[i + k][1] + fp[i + k][3] * d]),
        );
      for (let k = 0; k < 120; k++) {
        const p = [x0 - d + rnd() * (x1 - x0 + 2 * d), y0 - d + rnd() * (y1 - y0 + 2 * d)];
        let cnt = 0,
          edge = false;
        for (const t of tr) {
          const ar = orient(t[0], t[1], t[2]);
          if (!(Math.abs(ar) > 0)) continue;
          const o = [orient(t[0], t[1], p), orient(t[1], t[2], p), orient(t[2], t[0], p)];
          if (Math.min(...o.map(Math.abs)) < 1e-9 * Math.abs(ar)) edge = true;
          if (o.every((x) => x / ar >= 0)) cnt++;
        }
        if (edge) continue;
        const [u, v] = uv(p),
          eps = 1e-9;
        const removed =
          hull(u, v, eps) ||
          (unchained &&
            (sign < 0
              ? v <= eps || v <= 2 * u - 1 + eps
              : v >= u - eps && u >= -eps && u <= 1 + eps));
        if (cnt > 1) doubles++;
        if (!cnt && !removed) holes++;
        if (!cnt) {
          // Not rasterized: the kernel must discard it. Inside T by the hull test, or f = s (u^2 - v) <= 0 unchained.
          removedN++;
          const f = sign * (u * u - v);
          if (!(hull(u, v, 1e-9) || (unchained && f <= 1e-9))) removedBad++;
        } else keptN++;
      }
    }
  }
  console.log(
    `-- (a)/(b): ${cases} control triangles x 3 pixel sizes, ${keptN} samples kept, ${removedN} removed`,
  );
  ok(cases > 800, `the random set exercises the construction (${cases} footprints)`);
  ok(!holes, `every sample the kernel can keep is rasterized (${holes} holes)`);
  ok(!doubles, `no sample is rasterized twice (${doubles})`);
  ok(!outside, `no vertex leaves the bbox footprint (${outside})`);
  ok(
    removedN > 1000 && !removedBad,
    `every sample left out is one the kernel discards: inside T, or unchained with f <= 0 (${removedBad} of ${removedN})`,
  );
}

// ── (c): the pack ─────────────────────────────────────────────────────────────────────────────────────────────────────
const QUAD =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path fill="#000" d="M37 20 Q37 24.556 32.021 27.778 Q27.042 31 20 31 Q12.958 31 7.979 27.778 Q3 24.556 3 20 Q3 15.444 7.979 12.222 Q12.958 9 20 9 Q27.042 9 32.021 12.222 Q37 15.444 37 20 Z"/></svg>';
const packOf = async (svg) => {
  const sec = await importSvg(svg),
    pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  const res = buildLbBundle({
    curveFloats: new Float32Array(sec.curves),
    metaFloats: pm.metaFloats,
    metaFloatsPerShape: pm.floatsPerShape,
    ranges: sec.curveRangesByShape,
    numShapes: sec.numShapes,
  });
  return res.packed[0];
};
{
  console.log("-- (c): lbQuadSeamSmoke's ellipse of 8 quads");
  delete globalThis.__LB_BAND_FOOTPRINT;
  const off = await packOf(QUAD);
  globalThis.__LB_BAND_FOOTPRINT = 'tight';
  const on = await packOf(QUAD);
  delete globalThis.__LB_BAND_FOOTPRINT;
  const byKind = (pk) => {
    const m = {};
    for (let v = 0; v < pk.vertexCount; v++) {
      const k = Math.round(pk.verts[v * VF + 5]);
      m[k] = (m[k] || 0) + 1;
    }
    return m;
  };
  const kOff = byKind(off),
    kOn = byKind(on);
  ok(
    Object.keys(kOff).every((k) => k === '12' || kOn[k] === kOff[k]),
    `only kind 12 changes its vertex count (${JSON.stringify(kOff)} -> ${JSON.stringify(kOn)})`,
  );
  ok(
    (kOn[12] || 0) > (kOff[12] || 0) && kOff[12] === 6 * 8,
    `the bands take the tight footprint (${kOff[12]} -> ${kOn[12]} band vertices)`,
  );
  // Each band's flat slots (aFlags, aC1, aC2, aC3) are the same on every vertex, and the same as the bbox pack's.
  const bands = (pk) => {
    const m = new Map();
    for (let v = 0; v < pk.vertexCount; v++) {
      const o = v * VF;
      if (Math.round(pk.verts[o + 5]) !== 12) continue;
      const key = Array.from(pk.verts.subarray(o + 19, o + 23)).join(',') + '/' + pk.verts[o + 6];
      const flat = Array.from(pk.verts.subarray(o + 5, o + 7))
        .concat(Array.from(pk.verts.subarray(o + 11, o + 23)))
        .join(',');
      if (!m.has(key)) m.set(key, new Set());
      m.get(key).add(flat);
    }
    return m;
  };
  const bOff = bands(off),
    bOn = bands(on);
  ok(
    bOff.size === 8 &&
      bOn.size === 8 &&
      [...bOn].every(([k, s]) => s.size === 1 && bOff.has(k) && [...s][0] === [...bOff.get(k)][0]),
    `every band keeps its flat slots, on every vertex (${bOn.size} bands)`,
  );
  // Every tight vertex is an em point of its band's bbox plus a push of 0, a side normal or a corner diagonal.
  let badPush = 0;
  for (let v = 0; v < on.vertexCount; v++) {
    const o = v * VF;
    if (Math.round(on.verts[o + 5]) !== 12) continue;
    const px = on.verts[o + 7],
      py = on.verts[o + 8];
    if (!([-1, 0, 1].includes(px) && [-1, 0, 1].includes(py))) badPush++;
  }
  ok(!badPush, `every push is 0, a side normal or a corner diagonal (${badPush} others)`);
}

// ── (d): morph pairs ignore the switch ────────────────────────────────────────────────────────────────────────────────
{
  console.log('-- (d): a quad morph pair');
  const qs = (k) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path fill="#000" d="M37 20 Q37 ${24.5 + k} 32 27.8 Q27 31 20 31 Q13 31 8 27.8 Q3 24.5 3 20 Q3 15.4 8 12.2 Q13 ${9 - k} 20 9 Q27 9 32 12.2 Q37 15.4 37 20 Z"/></svg>`;
  const A = await importSvg(qs(0)),
    B = await importSvg(qs(3));
  const pa = parseMetaBin(A.meta, A.metaFloatsPerShape),
    pb = parseMetaBin(B.meta, B.metaFloatsPerShape);
  const input = () => ({
    srcCurve: new Float32Array(A.curves),
    dstCurve: new Float32Array(B.curves),
    srcMeta: pa.metaFloats,
    dstMeta: pb.metaFloats,
    metaStride: pa.floatsPerShape,
    ranges: A.curveRangesByShape,
    numShapes: A.numShapes,
    bb: pa.globalBBox,
  });
  const vbos = (r) =>
    (r && r.meshes ? r.meshes : []).flatMap((m) =>
      !m ? [] : (m.segments || [m]).map((g) => g.vbo),
    );
  delete globalThis.__LB_BAND_FOOTPRINT;
  const v0 = vbos(buildMorphBundle(input()));
  globalThis.__LB_BAND_FOOTPRINT = 'tight';
  const v1 = vbos(buildMorphBundle(input()));
  delete globalThis.__LB_BAND_FOOTPRINT;
  const same =
    v0.length > 0 &&
    v0.length === v1.length &&
    v0.every((x, i) => x.length === v1[i].length && x.every((e, k) => Object.is(e, v1[i][k])));
  ok(same, `the pair's streams are byte-identical with the switch on (${v0.length} streams)`);
}

console.warn = warn;
console.log(
  fail
    ? `lbBandFootprintSmoke FAIL (${fail})`
    : `lbBandFootprintSmoke: all checks passed (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
);
process.exit(fail ? 1 : 0);
