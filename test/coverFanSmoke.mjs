// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// coverFanSmoke — the Slug/AAC cover FAN (svg/mesh.js getCoverFanVerts), every fill row's cover.
//
// A fill row's cover is its shape's convex hull, in at most 8 vertices, wherever that is under 85% of the box's
// area, with miter normals that push each edge out by the box filter's full reach (0.7071 px) when the vertex shader
// dilates it. Pinned here, Node only:
//
//   (a) GEOMETRY, over synthetic shapes of every segment type: each fan is a triangle fan of a STRICTLY CONVEX
//       polygon in the float32 values the vertex buffer holds; it contains 512 samples of every segment of its
//       outline (not the curves' own control points, which a fan hugging the curve leaves outside); its area is
//       under 85% of the box's; each vertex's normal meets the unit normals of both edges there at sqrt(2) (so each
//       edge moves 0.7071 px);
//   (b) the IMPORT: a fan import writes the box import's (coverFan: false) bands and curves byte for byte, fans only
//       fill rows, and leaves stroke rows' covers (padded boxes) alone;
//   (c) THE PICTURE: probes/fillperf/coverFanProof.mjs --quick -- every pixel center inside the box and not the fan
//       has coverage under half an 8-bit level under the emulated Slug and AAC kernels, at three pixel sizes;
//   (d) THE FAN IS THE COVER, with no switch: the import without options is the fan import; every cover writer
//       takes it (the fill-row sites from ctx.coverFan, which only the coverFan: false test hook turns off, and
//       streamGeometry's rebuild from getCoverQuadMesh's default, true); and NINE-SLICE slices a fan chunk exactly as
//       it slices the box -- the fan bundle's 9-sliced mesh is the box bundle's byte for byte.
//   (e) A FILTERED SHAPE KEEPS THE BOX: its SourceGraphic pass renders into a bbox-sized RT or a canvas-sized one, which
//       must agree byte for byte (filterBboxRenderDiffSmoke), and a fan's internal edges through the AA band made them
//       differ by a level (bundleFinalize.js).
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const {
  parseCoverQuadChunks,
  buildGidToShapeIdx,
  COVER_QUAD_STRIDE,
  BUNDLE_FLAG_HYBRID_MESH_CHUNKED,
} = await import('../src/renderer/coverQuadChunks.js');
const { decodeSegs } = await import('../src/hitTest/curveGeom.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const f4 = (v) => v.toFixed(4);
function star(kind, n, cx, cy, r0, r1) {
  const P = (k, r) => [cx + r * Math.cos((Math.PI * k) / n), cy + r * Math.sin((Math.PI * k) / n)];
  let d = `M${f4(P(0, r0)[0])} ${f4(P(0, r0)[1])} `;
  for (let k = 0; k < 2 * n; k += 2) {
    const a = P(k, r0),
      m = P(k + 1, r1),
      b = P(k + 2, r0);
    if (kind === 'Q') d += `Q${f4(m[0])} ${f4(m[1])} ${f4(b[0])} ${f4(b[1])} `;
    else if (kind === 'C')
      d += `C${f4(a[0] + (m[0] - a[0]) * 1.4)} ${f4(a[1] + (m[1] - a[1]) * 1.4)} ${f4(b[0] + (m[0] - b[0]) * 1.4)} ${f4(b[1] + (m[1] - b[1]) * 1.4)} ${f4(b[0])} ${f4(b[1])} `;
    else if (kind === 'A')
      d += `A${f4(r0 * 0.3)} ${f4(r0 * 0.2)} ${k * 7} 0 1 ${f4(b[0])} ${f4(b[1])} `;
    else d += `L${f4(m[0])} ${f4(m[1])} L${f4(b[0])} ${f4(b[1])} `;
  }
  return d + 'Z';
}
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <path d="${star('Q', 9, 60, 60, 40, 55)}"/>
  <path d="${star('C', 7, 170, 60, 34, 50)}"/>
  <path d="${star('A', 8, 280, 60, 40, 28)}"/>
  <path d="${star('L', 5, 360, 60, 36, 14)}"/>
  <path fill-rule="evenodd" d="M20 200 A50 50 0 1 1 120 200 A50 50 0 1 1 20 200 Z M45 200 A25 18 30 1 0 95 200 A25 18 30 1 0 45 200 Z"/>
  <path d="M150 160 A 30 50 -20 0 1 230 160 A 30 20 10 1 1 150 160 Z"/>
  <path d="M250 290 L 390 150 L 396 156 L 256 296 Z"/>
  <path d="M260 180 C 260 290 320 180 330 290 L 300 170 Z"/>
  <path d="M150 250 h 80 v 40 h -80 Z" stroke="#08f" stroke-width="6"/>
</svg>`;

async function load(opts) {
  const b = await importSvg(SVG, { preserveViewport: true, ...opts });
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const cg = new Float32Array(b.curveGeom);
  return {
    b,
    pm,
    cg,
    chunks: parseCoverQuadChunks(cg, BUNDLE_FLAG_HYBRID_MESH_CHUNKED),
    gid: buildGidToShapeIdx(pm.metaFloats, b.numShapes, pm.floatsPerShape),
  };
}
// the box import is named, not defaulted: the smoke holds whichever way COVER_FAN_DEFAULT is set
const Q = await load({ coverFan: false }),
  F = await load({ coverFan: true });

// ---- (b) the import ------------------------------------------------------------------------------------------------
const same = (a, b) => a.byteLength === b.byteLength && Buffer.from(a).equals(Buffer.from(b));
ok(
  same(Q.b.bands, F.b.bands) && same(Q.b.curves, F.b.curves),
  "(b) the fan import writes the box import's bands and curves byte for byte",
);
const rowOf = (X, ch) => X.gid.get(ch.gid);
const isFill = (X, s) => X.pm.metaFloats[s * X.pm.floatsPerShape + M.META_FILL_A] > 0;
let fans = 0,
  strokeFanned = 0,
  fillRows = 0;
const byGid = new Map(F.chunks.map((c) => [c.gid, c]));
for (const ch of Q.chunks) {
  const s = rowOf(Q, ch),
    f = byGid.get(ch.gid);
  if (s == null || !f) continue;
  if (isFill(Q, s)) {
    fillRows++;
    if (f.count !== ch.count) fans++;
  } else if (
    f.count !== ch.count ||
    !Q.cg
      .subarray(ch.start * 12, (ch.start + ch.count) * 12)
      .every((v, i) => Object.is(v, F.cg[f.start * 12 + i]))
  )
    strokeFanned++;
}
ok(
  fans >= 6 && fans < fillRows,
  `(b) ${fans} of ${fillRows} fill rows take a fan (the rect and the bar keep their box)`,
);
ok(strokeFanned === 0, `(b) stroke rows keep their padded box covers (${strokeFanned} changed)`);

// ---- (a) geometry ------------------------------------------------------------------------------------------------
let checked = 0,
  bad = [];
for (const ch of F.chunks) {
  const s = rowOf(F, ch);
  const qc = Q.chunks.find((c) => c.gid === ch.gid);
  if (s == null || !isFill(F, s) || !qc) continue;
  const V = (k) => {
    const o = (ch.start + k) * COVER_QUAD_STRIDE;
    return { p: [F.cg[o], F.cg[o + 1]], n: [F.cg[o + 2], F.cg[o + 3]] };
  };
  const boxArea = (() => {
    const o = (k) => (qc.start + k) * COVER_QUAD_STRIDE;
    const a = [Q.cg[o(0)], Q.cg[o(0) + 1]],
      b = [Q.cg[o(1)], Q.cg[o(1) + 1]],
      c = [Q.cg[o(2)], Q.cg[o(2) + 1]];
    return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  })();
  const isFan =
    ch.count !== qc.count ||
    [0, 1, 2, 3, 4, 5].some((k) => Q.cg[(qc.start + k) * 12] !== F.cg[(ch.start + k) * 12]);
  if (!isFan) continue;
  checked++;
  // the polygon: v0, then each triangle's second vertex, then the last
  const poly = [V(0)];
  for (let t = 0; t < ch.count; t += 3) poly.push(V(t + 1));
  poly.push(V(ch.count - 1));
  const n = poly.length;
  let convex = true,
    area = 0,
    miter = true;
  for (let i = 0; i < n; i++) {
    const a = poly[(i - 1 + n) % n].p,
      v = poly[i].p,
      b = poly[(i + 1) % n].p;
    if (!((v[0] - a[0]) * (b[1] - v[1]) - (v[1] - a[1]) * (b[0] - v[0]) > 0)) convex = false;
    area += v[0] * b[1] - b[0] * v[1];
    // the vertex normal against the unit outward normals of the two edges at it
    for (const [p0, p1] of [
      [a, v],
      [v, b],
    ]) {
      const dx = p1[0] - p0[0],
        dy = p1[1] - p0[1],
        L = Math.hypot(dx, dy),
        m = poly[i].n;
      if (Math.abs((m[0] * dy - m[1] * dx) / L - Math.SQRT2) > 1e-5) miter = false;
    }
  }
  area *= 0.5;
  // containment of the outline, sampled, and of the control geometry
  const segs = decodeSegs(
    new Float32Array(F.b.curves),
    F.b.curveRangesByShape[s].begin,
    F.b.curveRangesByShape[s].end,
  );
  const pts = [];
  for (const g of segs)
    for (let k = 0; k <= 512; k++) {
      const t = k / 512,
        u = 1 - t;
      if (g.t === 0) pts.push([g.x0 + (g.x1 - g.x0) * t, g.y0 + (g.y1 - g.y0) * t]);
      else if (g.t === 1)
        pts.push([
          u * u * g.x0 + 2 * u * t * g.cx + t * t * g.x1,
          u * u * g.y0 + 2 * u * t * g.cy + t * t * g.y1,
        ]);
      else if (g.t === 2)
        pts.push([
          u * u * u * g.x0 + 3 * u * u * t * g.c1x + 3 * u * t * t * g.c2x + t * t * t * g.x1,
          u * u * u * g.y0 + 3 * u * u * t * g.c1y + 3 * u * t * t * g.c2y + t * t * t * g.y1,
        ]);
      else {
        const th = g.th0 + (g.th1 - g.th0) * t;
        pts.push([
          g.cx + g.cp * g.rx * Math.cos(th) - g.sp * g.ry * Math.sin(th),
          g.cy + g.sp * g.rx * Math.cos(th) + g.cp * g.ry * Math.sin(th),
        ]);
      }
    }
  let outside = 0;
  for (const q of pts)
    for (let i = 0; i < n; i++) {
      const a = poly[i].p,
        b = poly[(i + 1) % n].p;
      if ((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) < 0) {
        outside++;
        break;
      }
    }
  if (!convex || !miter || outside || !(area > 0 && area < 0.85 * boxArea))
    bad.push(
      `row ${s}: convex ${convex} miter ${miter} outside ${outside} area ${area.toFixed(2)} box ${boxArea.toFixed(2)}`,
    );
}
ok(
  checked >= 6 && bad.length === 0,
  `(a) ${checked} fans: strictly convex in float32, holding 512 samples per segment of the outline, under 85% of the box, sqrt(2) miters${bad.length ? ' -- ' + bad.join('; ') : ''}`,
);

// ---- (c) the picture ---------------------------------------------------------------------------------------------
// In this process (the lane runs one test at a time): the probe reads its arguments from this global.
globalThis.__coverFanProofArgs = ['--quick'];
await import('../probes/fillperf/coverFanProof.mjs');
ok(
  globalThis.__coverFanProofFail === 0,
  `(c) probes/fillperf/coverFanProof.mjs --quick passes: the fan drops no ink under the emulated Slug and AAC kernels`,
);

// ---- (d) the fan is the cover -------------------------------------------------------------------------------------
{
  const { readFileSync } = await import('fs');
  const D = await load({});
  ok(
    same(D.b.curveGeom, F.b.curveGeom) && !same(D.b.curveGeom, Q.b.curveGeom),
    '(d) the import without options is the fan import (and not the box one)',
  );
  const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  const calls = [
    'svg/buildContext.js',
    'svg/bundleFinalize.js',
    'renderer/streamGeometry.js',
  ].flatMap((f) =>
    [
      ...src(f)
        .replace(/\/\/[^\n]*/g, '')
        .matchAll(/getCoverQuadMesh\(([^;]*?)\);/g),
    ].map((m) => ({
      f,
      args: m[1]
        .replace(/\[[^\]]*\]/g, '[]')
        .split(',')
        .map((a) => a.trim()),
    })),
  );
  // a fill-row site passes ctx.coverFan === true; a stroke site passes a pad (no fan under a pad); the stream rebuild
  // passes neither and takes the default, which is the fan
  const bad = calls.filter(
    (c) =>
      !(
        c.args[5] === 'ctx.coverFan === true' ||
        c.args[5] === 'ctx.coverFan === true && !sd.filterId' ||
        (c.args.length === 5 && /pad/i.test(c.args[4])) ||
        (c.f === 'renderer/streamGeometry.js' && c.args.length === 4)
      ),
  );
  ok(
    calls.length === 4 &&
      bad.length === 0 &&
      /coverFan: opts\.coverFan !== false,/.test(src('svg/buildContext.js')) &&
      /coverFan = true, fanShare = null\)/.test(src('svg/mesh.js')) &&
      !/COVER_FAN_DEFAULT/.test(src('svg/mesh.js')),
    `(d) every cover writer takes the fan, and no switch is left (${calls.length} getCoverQuadMesh calls${bad.length ? '; not: ' + bad.map((c) => c.f + ' ' + c.args.join(', ')).join(' | ') : ''})`,
  );
  const { buildNineSliceMesh } = await import('../src/renderer/nineSlice.js');
  const slice = (X) =>
    buildNineSliceMesh({
      meshFloats: X.cg,
      chunks: X.chunks,
      gidToShapeIdx: X.gid,
      metaFloats: X.pm.metaFloats,
      metaStride: X.pm.floatsPerShape,
      border: [20, 10, 20, 10],
      worldSize: [700, 500],
      nativeBBox: [0, 0, 400, 300],
    });
  const sQ = slice(Q),
    sF = slice(F);
  const fanChunks = F.chunks.filter((c) => c.count !== 6 && isFill(F, rowOf(F, c))).length;
  ok(
    fanChunks > 0 && same(sQ.meshFloats, sF.meshFloats),
    `(d) nine-slice slices the ${fanChunks} fan chunks that are not 6 vertices as it slices their boxes: the two 9-sliced meshes are byte for byte the same`,
  );
}

// ---- (e) a filtered shape keeps the box ------------------------------------------------------------------------------
{
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><defs><filter id="b"><feGaussianBlur stdDeviation="3"/></filter></defs>
<circle cx="80" cy="100" r="40" fill="#06c"/><circle cx="200" cy="100" r="40" fill="#06c" filter="url(#b)"/></svg>`;
  const b = await importSvg(svg, { preserveViewport: true });
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    cg = new Float32Array(b.curveGeom);
  const gid = buildGidToShapeIdx(pm.metaFloats, b.numShapes, pm.floatsPerShape);
  const counts = parseCoverQuadChunks(cg, BUNDLE_FLAG_HYBRID_MESH_CHUNKED).map((c) => ({
    n: c.count,
    filtered: pm.metaFloats[gid.get(c.gid) * pm.floatsPerShape + M.META_FILTER_ID] > 0,
  }));
  const plain = counts.filter((c) => !c.filtered),
    filt = counts.filter((c) => c.filtered);
  ok(
    plain.length === 1 && plain[0].n > 6 && filt.length === 1 && filt[0].n === 6,
    `(e) the unfiltered circle takes a fan (${plain.map((c) => c.n)} vertices) and the filtered one keeps its box (${filt.map((c) => c.n)})`,
  );
}

if (fail) {
  console.error(`COVER-FAN FAIL (${fail})`);
  process.exit(1);
}
console.log('COVER-FAN PASS');
