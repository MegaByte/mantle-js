// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbArcPieceInvarianceSmoke — the Loop-Blinn builder cuts an arc into a number of rational-quad pieces that
// depends on the arc's SWEEP and nothing else: not on where the drawing sits, not on how big it is, not on how
// it is turned, and not on which of the four equivalent ways the arc's own parameters are written down.
//
// THE TRAP. The rule is "at most a quarter turn per piece", and a bare `n = ceil(|theta1 - theta0| / (pi/2))`
// in lbContour.arcToRationalQuads puts a HALF TURN — the commonest arc there is, two of them make every circle —
// at exactly 2, where `ceil` answers 2 or 3 on the last ulp. The angles arrive from the curve plane as float32
// and every transform recomputes them through atan2, so which side of the edge an arc falls on would be decided
// by where the drawing happens to be: the same half circle turned by different angles comes out 2 pieces or 3,
// and two identical circles in one drawing 3 and 2.
//
// WHY IT MATTERS, beyond tidiness. A rational quadratic with w = cos(dtheta/2) is the conic arc exactly at any
// piece count, so both answers draw the same curve to within float32 (the worst relative deviation from the
// true ellipse is identical either way). But different piece counts are different crescents, a different
// partition and different triangles, so a pixel at a moved joint can flip almost fully: a change of
// REPRESENTATIVE with no geometry behind it (an importer arc rebuild) can move hundreds of pixels of a
// Loop-Blinn render, some almost fully, where Slug moves a handful by a few levels. Taking the edge away makes
// the two representatives build the same mesh, which (e) below pins.
//
// The slack is a few float32 ulps RELATIVE to the ratio, never absolute. It cannot cost accuracy: the real
// constraint is only that a piece stay under a HALF turn, where w reaches zero; a quarter is already a 2x
// margin. It only ever takes a piece count DOWN, and leaves the worst deviation unchanged.
//
// Mutation, required to FAIL: `Math.ceil(Math.abs(total) / (Math.PI / 2))` in geom/lbContour.js.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { curveRangeToContours, arcToRationalQuads } = await import('../src/geom/lbContour.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { LB_VERT_FLOATS } = await import('../src/renderer/lbPack.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const SEG_RQUAD = 4;
const TWO = 2 * Math.PI;

// ------------------------------------------------------------------------------------------------
// (a) the same drawing, moved, scaled and turned: the piece count must not move with it.
console.log('(a) the same arcs at every position, size and rotation');
{
  const body = (tx, ty, S, rot) =>
    `<g transform="translate(${tx} ${ty}) scale(${S}) rotate(${rot})">` +
    `<path d="M40 100 A 30 30 0 0 1 100 100 Z" fill="#345"/>` + // half circle
    `<path d="M140 100 A 30 18 25 0 1 200 100 Z" fill="#345"/>` + // half ellipse, authored rotated
    `<path d="M240 100 A 30 30 0 1 1 241 100 Z" fill="#345"/></g>`; // very nearly a full circle
  const doc = (tx, ty, S, rot) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4000 4000">${body(tx, ty, S, rot)}</svg>`;
  const piecesOf = async (svg) => {
    const b = await importSvg(svg, { preserveViewport: true });
    const f = new Float32Array(b.curves),
      out = [];
    for (const r of b.curveRangesByShape || []) {
      if (!r || r.end <= r.begin) continue;
      let n = 0;
      for (const c of curveRangeToContours(f, r.begin, r.end))
        for (const s of c) if (s.type === SEG_RQUAD) n++;
      out.push(n);
    }
    return out;
  };
  const CASES = [
    [0, 0, 1, 0],
    [0, 0, 2, 0],
    [0, 0, 4, 17],
    [0, 0, 8, 90],
    [0, 0, 1024, 45],
    [0, 0, 0.125, 31],
    [1, 0, 1, 13],
    [0.5, 0.25, 1, 200],
    [7, 13, 1, -63],
    [1000, 1000, 1, 7.5],
    [0.3333, 0.777, 1, 119],
    [0, 0, 3, 3],
    [0, 0, 5, 5],
    [0, 0, 1.5, 1.5],
    [0, 0, 0.7, 0.7],
    [11.11, 2.22, 1.3, 174.3],
  ];
  const seen = [new Set(), new Set(), new Set()];
  for (const c of CASES) (await piecesOf(doc(...c))).forEach((v, i) => seen[i] && seen[i].add(v));
  ok(
    seen.every((s) => s.size === 1),
    `${CASES.length} placements: pieces per shape ${seen.map((s) => '{' + [...s].sort((p, q) => p - q).join(',') + '}').join(' ')} (each must be one value)`,
  );
  ok(
    seen[0].has(2) && seen[1].has(2),
    `a half turn is TWO quarter-turn pieces, not three: got ${[...seen[0]][0]} and ${[...seen[1]][0]}`,
  );
}

// ------------------------------------------------------------------------------------------------
// (a2) THE TWO HALVES OF ONE ELLIPSE MUST BE CUT THE same WAY. They have the same sweep, so they must get the
//      same piece count — but their thetas are different float32 numbers, so a bare ceil can cut one ellipse's
//      halves into THREE pieces and TWO. The SDF recognizer needs a consistent cut: with 3 + 2 it does not see
//      an ellipse at all and the shape builds a full Loop-Blinn partition (186 vertices), where 2 + 2 is
//      recognized and drawn as one exact elliptical primitive (6). It is a QUALITY difference, not just a
//      cost one: an exact SDF has no crescent seams.
console.log('(a2) the two halves of one ellipse, and the SDF primitive that depends on it');
{
  const { fitEllipticalContour } = await import('../src/geom/shapeRecognize.js');
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><path d="M110 30 A 40 24 30 0 1 190 30 A 40 24 30 0 1 110 30 Z" fill="#345"/></svg>`;
  const b = await importSvg(SVG, { preserveViewport: true });
  const r = b.curveRangesByShape.find(Boolean);
  const f = new Float32Array(b.curves);
  const contours = curveRangeToContours(f, r.begin, r.end);
  const quads = contours.flat().filter((s) => s.type === SEG_RQUAD);
  // Per arc record: read the sweep out of the curve plane and cut it alone, so the two halves are comparable.
  const per = [];
  {
    let hdr = r.begin | 0;
    const end = Math.min(r.end | 0, f.length);
    while (hdr + 4 <= end) {
      const hw = f[hdr];
      if (!(hw >= 0 && hw < 16 && hw === Math.floor(hw))) break;
      const t = (hw | 0) & 3,
        d = hdr + 4;
      if (t === 3)
        per.push(
          arcToRationalQuads(f[d], f[d + 1], f[d + 2], f[d + 3], f[d + 4], f[d + 5], f[d + 6])
            .length,
        );
      hdr = t === 0 ? d + 8 : t === 3 ? d + 16 : d + 12; // an arc's endpoints texel
    }
  }
  ok(
    per.length === 2 && per[0] === per[1] && per[0] === 2,
    `the two half arcs of one ellipse get the same cut: ${per.join(' and ')} pieces (want 2 and 2)`,
  );
  ok(
    quads.length === 4 && !!fitEllipticalContour(contours[0]),
    `${quads.length} quads in all, and the contour is recognized as an exact ellipse primitive (${fitEllipticalContour(contours[0]) ? 'yes' : 'NO'})`,
  );
  const built = buildLbShape(contours, false, false);
  ok(
    built && built.pk && built.pk.vertexCount <= 12,
    `...so it draws as a primitive, not a partition: ${built && built.pk ? built.pk.vertexCount : 0} vertices`,
  );
}

// ------------------------------------------------------------------------------------------------
// (b) the count is a function of the sweep alone, and the exact multiples of a quarter turn — where every
//     circle and every rounded corner lands — are on the low side of the step, not straddling it.
console.log('(b) the count against the sweep, exactly at the quarter-turn steps');
{
  const want = (sweep) => Math.max(1, Math.ceil(sweep / (Math.PI / 2) - 1e-9));
  let bad = 0,
    first = '';
  const SWEEPS = [];
  for (const k of [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 3.5, 4]) SWEEPS.push((k * Math.PI) / 2);
  for (const s of [0.01, 0.2, 1.0, 2.0, 3.0, 4.5, 6.0, 6.283]) SWEEPS.push(s);
  for (const sweep of SWEEPS)
    for (const sign of [1, -1])
      for (const th0 of [0, 1.234, -2.5, Math.PI, 7 * Math.PI]) {
        const th1 = th0 + sign * sweep;
        const n = arcToRationalQuads(0, 0, 30, 20, Math.fround(th0), Math.fround(th1), 0).length;
        if (n !== want(sweep)) {
          bad++;
          if (!first)
            first = `sweep ${sweep.toFixed(6)} from ${th0}: ${n} pieces, want ${want(sweep)}`;
        }
      }
  ok(
    bad === 0,
    `${SWEEPS.length * 2 * 5} (sweep, direction, start) cases: ${bad} disagree with ceil(sweep / quarter turn)${first ? ' -- ' + first : ''}`,
  );
  ok(
    arcToRationalQuads(0, 0, 30, 30, 0, Math.PI, 0).length === 2 &&
      arcToRationalQuads(0, 0, 30, 30, 0, TWO, 0).length === 4 &&
      arcToRationalQuads(0, 0, 30, 30, 0, Math.PI / 2, 0).length === 1,
    'a quarter turn is 1 piece, a half turn 2, a full turn 4',
  );
}

// ------------------------------------------------------------------------------------------------
// (c) every piece is still a well-formed conic arc, and still ON the ellipse.
console.log('(c) the pieces are still the exact conic');
{
  let worstW = 1,
    worst = 0,
    whose = '';
  for (const [rx, ry, phi] of [
    [30, 30, 0],
    [30, 18, 0.4363],
    [80, 3, -1.1],
    [1e-3, 2e-3, 2],
    [5e4, 1e4, 0.2],
  ]) {
    for (const sweep of [0.3, Math.PI / 2, Math.PI, 4.5, TWO])
      for (const th0 of [0, 2.2, -1.7]) {
        const pieces = arcToRationalQuads(
          0,
          0,
          rx,
          ry,
          Math.fround(th0),
          Math.fround(th0 + sweep),
          phi,
        );
        for (const p of pieces) {
          if (p.w < worstW) worstW = p.w;
          for (let i = 0; i <= 32; i++) {
            const t = i / 32,
              u = 1 - t,
              b0 = u * u,
              b1 = 2 * t * u * p.w,
              b2 = t * t,
              den = b0 + b1 + b2;
            const px = (b0 * p.p1[0] + b1 * p.p2[0] + b2 * p.p3[0]) / den;
            const py = (b0 * p.p1[1] + b1 * p.p2[1] + b2 * p.p3[1]) / den;
            const c = Math.cos(phi),
              s = Math.sin(phi);
            const e = Math.abs(Math.hypot((c * px + s * py) / rx, (-s * px + c * py) / ry) - 1);
            if (e > worst) {
              worst = e;
              whose = `rx ${rx} ry ${ry} phi ${phi} sweep ${sweep.toFixed(3)}`;
            }
          }
        }
      }
  }
  ok(
    worstW > 0.7 && worst < 1e-9,
    `smallest weight ${worstW.toFixed(6)} (a piece under a half turn keeps w > 0), worst off-ellipse ${worst.toExponential(2)} (${whose})`,
  );
}

// ------------------------------------------------------------------------------------------------
// (d) ...and the four EQUIVALENT ways of writing the same arc down build the same Loop-Blinn mesh. This is the
//     property that arc rebuild needs: swapping the radii with phi turned a quarter, turning phi a half with theta, or
//     adding a whole turn to both thetas, are the same ellipse arc, and the builder must not be able to tell.
console.log('(d) equivalent representatives build the same mesh');
{
  // Two arcs and a skirt of lines — NOT a bare ellipse, which the SDF primitives would recognize and answer
  // with six vertices, leaving the partition untested.
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><path d="M190 120 A 25 25 0 0 1 240 120 A 25 25 0 0 1 290 120 L 290 180 L 190 180 Z" fill="#345"/></svg>`;
  const b = await importSvg(SVG, { preserveViewport: true });
  const r = b.curveRangesByShape.find(Boolean);
  const base = new Float32Array(b.curves);
  const arcAt = [];
  {
    let hdr = r.begin | 0;
    const end = Math.min(r.end | 0, base.length);
    while (hdr + 4 <= end) {
      const hw = base[hdr];
      if (!(hw >= 0 && hw < 16 && hw === Math.floor(hw))) break;
      const t = (hw | 0) & 3,
        d = hdr + 4;
      if (t === 3) arcAt.push(d);
      hdr = t === 0 ? d + 8 : t === 3 ? d + 16 : d + 12; // an arc's endpoints texel
    }
  }
  // (rx, ry, phi, th) -> the same arc written another way.
  const FORMS = [
    ['as imported', (a) => a],
    [
      'radii swapped, phi + pi/2, theta - pi/2',
      (a) => ({
        ...a,
        rx: a.ry,
        ry: a.rx,
        phi: a.phi + Math.PI / 2,
        th0: a.th0 - Math.PI / 2,
        th1: a.th1 - Math.PI / 2,
      }),
    ],
    [
      'phi + pi, theta + pi',
      (a) => ({ ...a, phi: a.phi + Math.PI, th0: a.th0 + Math.PI, th1: a.th1 + Math.PI }),
    ],
    ['theta + 2pi', (a) => ({ ...a, th0: a.th0 + TWO, th1: a.th1 + TWO })],
    ['theta - 2pi', (a) => ({ ...a, th0: a.th0 - TWO, th1: a.th1 - TWO })],
  ];
  const meshOf = (form) => {
    const c = new Float32Array(base);
    for (const d of arcAt) {
      const a = form({
        cx: c[d],
        cy: c[d + 1],
        rx: c[d + 2],
        ry: c[d + 3],
        th0: c[d + 4],
        th1: c[d + 5],
        phi: c[d + 6],
      });
      c[d] = a.cx;
      c[d + 1] = a.cy;
      c[d + 2] = a.rx;
      c[d + 3] = a.ry;
      c[d + 4] = a.th0;
      c[d + 5] = a.th1;
      c[d + 6] = a.phi;
    }
    const contours = curveRangeToContours(c, r.begin, r.end);
    const rq = contours.reduce((acc, ct) => acc + ct.filter((s) => s.type === SEG_RQUAD).length, 0);
    const built = buildLbShape(contours, false, false);
    return {
      rq,
      verts: built && built.pk ? built.pk.vertexCount : 0,
      v: built && built.pk ? built.pk.verts : null,
    };
  };
  const REF = meshOf(FORMS[0][1]);
  ok(
    arcAt.length === 2 && REF.verts > 0,
    `${arcAt.length} arc records, reference mesh ${REF.verts} verts from ${REF.rq} rational quads`,
  );
  let bad = 0,
    note = '';
  for (const [label, form] of FORMS.slice(1)) {
    const G = meshOf(form);
    // The control points come from cosines of different angles, so the last float32 bit may differ; the
    // STRUCTURE must not. Vertex count and piece count exactly, positions within a float32 ulp of the shape.
    let worst = 0;
    if (G.verts === REF.verts && G.v && REF.v) {
      for (let i = 0; i < REF.verts * LB_VERT_FLOATS; i++) {
        const d = Math.abs(G.v[i] - REF.v[i]) / Math.max(1, Math.abs(REF.v[i]));
        if (d > worst) worst = d;
      }
    }
    const good = G.rq === REF.rq && G.verts === REF.verts && worst <= 4 * 2 ** -23;
    if (!good) bad++;
    note += `\n      ${label}: ${G.rq} quads, ${G.verts} verts, worst relative float ${worst.toExponential(2)}`;
  }
  ok(
    bad === 0,
    `${FORMS.length - 1} equivalent forms all build the reference mesh (${bad} do not)${note}`,
  );
}

console.log(fail ? `lbArcPieceInvarianceSmoke FAIL (${fail})` : 'lbArcPieceInvarianceSmoke PASS');
process.exit(fail ? 1 : 0);
