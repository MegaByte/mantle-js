// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bandArcEndpointMembershipSmoke — the band encoder lists an arc in every stripe its endpoint could be ON THE RAY for
// (src/svg/textures.js band membership; read by _coverage.glsl's arc walkers and src/hitTest/bandWinding.js).
//
// THE DEFECT. Every arc walker counts an arc's crossings from its endpoint SIDES (arcRayCrossings), and places an
// endpoint within ONE float32 ulp of the ray (arcRayUlp, 1.2e-7 of |center| + |rx| + |ry| on the crossing axis) ON
// it, so the arc and the segment sharing that vertex decide it the same way. That works only if the walked band
// LISTS the arc. Membership by the arc's tight bbox, which comes from the center form and so puts an endpoint a
// rounding error inside where the path put it, fails: a ring's vertex at 125 reads 124.99999999999997, a stripe starting
// at exactly 125 leaves the arc out, and the row through the vertex loses its crossing. Symmetric art puts vertices on
// stripe boundaries all the time (the center of a 16-band layout). Arcs are binned with a relative pad on each axis
// (2e-5 of the sum, wider than the walkers' one-ulp window needs).
//
// (a) rings of four arcs, and their transposes, centered on stripe boundaries of their own band layout: every arc
//     with an endpoint within the walkers' reach of a stripe -- the one-ulp snap plus the endpoint's own float32
//     reconstruction, which is one ulp again -- is listed in that stripe's H band (y) and V band (x);
// (b) the H ray: rows through the transposed rings' vertices, sampled exactly on the vertices' coordinates, match
//     the analytic ring membership at every pixel more than 1.5 units from the outline, at 2^-20, 1 and 2^20;
// (c) the V ray: the same on columns through the rings' vertices.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const { decodeSegs } = await import('../src/hitTest/curveGeom.js');
const { bandFillCoverage, arcRayUlp } = await import('../src/hitTest/bandWinding.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const n = (v, S) => +(v * S).toPrecision(17);

// a ring: an outer circle of four arcs and an inner one wound the other way, both with vertices on the center row and
// column; TRANSPOSED swaps x and y (and the sweeps). Center, outer and inner radius per ring.
const RINGS = [
  [125, 125, 100, 90],
  [375, 125, 100, 76],
  [60, 60, 40, 33],
  [300, 300, 250, 120],
];
function ringPath([cx, cy, R, r], S, transposed) {
  const P = (x, y) => (transposed ? `${n(y, S)} ${n(x, S)}` : `${n(x, S)} ${n(y, S)}`);
  const s0 = transposed ? 1 : 0,
    s1 = transposed ? 0 : 1;
  return (
    `M ${P(cx, cy - R)} A ${n(R, S)} ${n(R, S)} 0 0 ${s0} ${P(cx - R, cy)} A ${n(R, S)} ${n(R, S)} 0 0 ${s0} ${P(cx, cy + R)} ` +
    `A ${n(R, S)} ${n(R, S)} 0 0 ${s0} ${P(cx + R, cy)} A ${n(R, S)} ${n(R, S)} 0 0 ${s0} ${P(cx, cy - R)} Z ` +
    `M ${P(cx, cy - r)} A ${n(r, S)} ${n(r, S)} 0 0 ${s1} ${P(cx + r, cy)} A ${n(r, S)} ${n(r, S)} 0 0 ${s1} ${P(cx, cy + r)} ` +
    `A ${n(r, S)} ${n(r, S)} 0 0 ${s1} ${P(cx - r, cy)} A ${n(r, S)} ${n(r, S)} 0 0 ${s1} ${P(cx, cy - r)} Z`
  );
}
async function bundleOf(ring, S, transposed) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(600, S)} ${n(600, S)}"><path fill="#000" d="${ringPath(ring, S, transposed)}"/></svg>`;
  const b = await importSvg(svg, { preserveViewport: true });
  const MF = parseMetaBin(b.meta, b.metaFloatsPerShape).metaFloats;
  return {
    raw: b,
    bandF: new Float32Array(b.bands),
    curveF: new Float32Array(b.curves),
    gd: [
      MF[M.META_GLYPH_LOC_X],
      MF[M.META_GLYPH_LOC_Y],
      MF[M.META_BAND_MAX_X],
      MF[M.META_BAND_MAX_Y],
    ],
    bb: [MF[M.META_BBOX_XMIN], MF[M.META_BBOX_YMIN], MF[M.META_BBOX_XMAX], MF[M.META_BBOX_YMAX]],
  };
}

// ---- (a) band lists -------------------------------------------------------------------------
function bandArcs(B, horiz, band) {
  const bandsY = (B.gd[3] | 0) + 1;
  const tex = (off) => ((B.gd[1] | 0) * 4096 + (B.gd[0] | 0) + off) * 4;
  const hdr = horiz ? band * 2 : bandsY * 2 + band * 2,
    cb = tex(hdr);
  const skip = (B.bandF[cb] | 0) + (B.bandF[cb + 1] | 0) + (B.bandF[cb + 2] | 0),
    nA = B.bandF[cb + 3] | 0,
    arr = B.bandF[tex(hdr + 1)] | 0;
  const locs = new Set();
  for (let i = 0; i < nA; i++) locs.add(B.bandF[tex(arr + skip + i)] | 0);
  return locs;
}
{
  let checked = 0,
    missing = 0;
  const where = [];
  for (const ring of RINGS)
    for (const transposed of [false, true]) {
      const B = await bundleOf(ring, 1, transposed);
      const rg = B.raw.curveRangesByShape[0];
      const bandsX = (B.gd[2] | 0) + 1,
        bandsY = (B.gd[3] | 0) + 1;
      // arcs with their header locs: walk the curve range the way decodeSegs does, one header per segment
      const segs = decodeSegs(B.curveF, rg.begin, rg.end).filter((s) => s.t === 3);
      const headers = [];
      for (let h = rg.begin; h + 8 <= rg.end;) {
        const type = (B.curveF[h] | 0) & 3;
        if (type === 3) headers.push((h / 4) | 0);
        h += type === 0 ? 12 : type === 3 ? 20 : 16; // an arc's endpoints texel
      }
      segs.forEach((s, k) => {
        const loc = headers[k];
        for (const [horiz, count, lo, span] of [
          [true, bandsY, B.bb[1], B.bb[3] - B.bb[1]],
          [false, bandsX, B.bb[0], B.bb[2] - B.bb[0]],
        ]) {
          const tol = 2 * (horiz ? arcRayUlp(s.cy, s.rx, s.ry) : arcRayUlp(s.cx, s.rx, s.ry));
          for (const e of horiz ? [s.y0, s.y1] : [s.x0, s.x1])
            for (let band = 0; band < count; band++) {
              const bLo = lo + (band * span) / count,
                bHi = lo + ((band + 1) * span) / count;
              if (e + tol < bLo || e - tol > bHi) continue; // the endpoint cannot be on a ray in this stripe
              checked++;
              if (!bandArcs(B, horiz, band).has(loc)) {
                missing++;
                if (where.length < 4)
                  where.push(
                    `ring ${ring.join(',')}${transposed ? ' transposed' : ''} ${horiz ? 'H' : 'V'} band ${band} lacks the arc ending at ${e}`,
                  );
              }
            }
        }
      });
    }
  ok(
    checked > 100 && missing === 0,
    `(a) every arc with an endpoint within the walkers' reach of a stripe is listed in its band (${missing} of ${checked} missing${where.length ? ': ' + where.join('; ') : ''})`,
  );
}

// ---- (b), (c) the rays through the vertices ----------------------------------------------------
async function linesWrong(horizOnly) {
  let n2 = 0,
    wrong = 0;
  for (const ring of RINGS)
    for (const transposed of [false, true])
      for (const S of [Math.pow(2, -20), 1, Math.pow(2, 20)]) {
        const B = await bundleOf(ring, S, transposed);
        const [cx0, cy0, R, r] = ring,
          cx = transposed ? cy0 : cx0,
          cy = transposed ? cx0 : cy0;
        const inside = (x, y) => {
          const d = Math.hypot(x - cx, y - cy);
          return d < R && d > r ? 1 : 0;
        };
        const far = (x, y) => {
          const d = Math.hypot(x - cx, y - cy);
          return Math.abs(d - R) > 1.5 && Math.abs(d - r) > 1.5;
        };
        // H checks rows through the vertices of the transposed rings, V columns through the untransposed ones
        if (horizOnly !== transposed) continue;
        for (let t = -R - 10; t <= R + 10; t++) {
          const [x, y] = horizOnly ? [cx + t, cy] : [cx, cy + t];
          if (!far(x, y)) continue;
          n2++;
          if (
            bandFillCoverage(B.bandF, B.curveF, B.gd, B.bb, x * S, y * S, 1 / S, 1 / S, false) !==
            inside(x, y)
          )
            wrong++;
        }
      }
  return { n2, wrong };
}
{
  const h = await linesWrong(true);
  ok(
    h.n2 > 500 && h.wrong === 0,
    `(b) H: rows through the transposed rings' vertices match the ring at 2^-20, 1 and 2^20 (${h.wrong} of ${h.n2} wrong)`,
  );
  const v = await linesWrong(false);
  ok(
    v.n2 > 500 && v.wrong === 0,
    `(c) V: columns through the rings' vertices match the ring at 2^-20, 1 and 2^20 (${v.wrong} of ${v.n2} wrong)`,
  );
}

if (fail) {
  console.error(`BAND-ARC-ENDPOINT-MEMBERSHIP FAIL (${fail})`);
  process.exit(1);
}
console.log('BAND-ARC-ENDPOINT-MEMBERSHIP PASS');
