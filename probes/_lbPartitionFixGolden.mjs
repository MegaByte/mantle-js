// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbPartitionFixGolden.mjs — JS/C# parity goldens for the Loop-Blinn partition.
//
// Covers the partition features the C# partition structure shares, each on the shape its JS smoke uses:
//   - the power-of-two key origin and verifyInteriorSign / orientContoursForFill they lean on;
//   - splitOverlappingQuadHulls9: quad hulls that cross (thin arc ring, same-way leaf, rounded bar
//     end) and hulls that nest (nested sliver);
//   - faceStraddles9 / airFace9 on every CDT face, both modes: the crescent whose own curve runs
//     through an all-air face (hole-parity rings), notch faces whose vertices are the
//     outline's joints, a quad hull crossing a contour line;
//   - the builder's constraints, Steiner points, quads and edges for each shape, plus a notched
//     quad star and arc star;
//   - splitOverlappingQuadHullsPair9 and the morph pair on arc rings and on a disc whose inner
//     circle is an invisible boundary.
//
// faceStraddles9 and airFace9 are closures inside buildLoopBlinnPartition, and the hull split
// helpers are module-private. Rather than export them from the renderer, this loads a copy of
// lbPartition.js with its imports pointed back at the real modules, the private helpers exported,
// and one tap line after airFace9 that hands the closures out. The code under test is the file's
// own text; nothing in src/ changes.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
(await import('../src/geom/shapeRecognize.js')).setSdfPrimitivesEnabled(false);
const { default: importSvg } = await import('../src/svg/importer.js');
const { curveRangeToContours } = await import('../src/renderer/loopBlinn.js');
const lbContour = await import('../src/geom/lbContour.js');
const { rayWinding, calibrateInterior, verifyInteriorSign, orientContoursForFill, _setKeyOrigin } =
  lbContour;
const { buildLoopBlinnPartitionPair } = await import('../src/renderer/lbPartitionPair.js');

// ---- the tapped copy of lbPartition.js ----------------------------------------------------------
const srcUrl = new URL('../src/renderer/lbPartition.js', import.meta.url);
let text = readFileSync(srcUrl, 'utf8');
text = text.replace(/from '(\.\.?\/[^']+)'/g, (_, p) => `from '${new URL(p, srcUrl).href}'`);
const anchor =
  '    return !inkAt((Pa9[0] + Pb9[0] + Pc9[0]) / 3, (Pa9[1] + Pb9[1] + Pc9[1]) / 3);\n  };\n';
if (text.split(anchor).length !== 2)
  throw new Error('airFace9 anchor not found exactly once -- update the tap');
text = text.replace(
  anchor,
  anchor +
    '  if (globalThis.__lbTap9) globalThis.__lbTap9({ faceStraddles9, airFace9, allSegs, pts, constraints, tris: cdtRes.tris, eps: _eps });\n',
);
text += '\nexport { quadFlat9, halveQuad9, quadHullHits9, splitOverlappingQuadHulls9 };\n';
const tmp = mkdtempSync(join(tmpdir(), 'lbfix-'));
const tapPath = join(tmp, 'lbPartitionTap.mjs');
writeFileSync(tapPath, text);
const tapped = await import(pathToFileURL(tapPath).href);
rmSync(tmp, { recursive: true, force: true });

// ---- serialization ------------------------------------------------------------------------------
const segOut = (s) => ({
  t: s.type,
  p1: s.p1,
  p2: s.p2 || null,
  p3: s.p3 || null,
  p4: s.p4 || null,
  w: s.w ?? null,
  circle: s.circle ? { cx: s.circle.cx, cy: s.circle.cy, r: s.circle.r } : null,
});
const ctOut = (ct) => ct.map((c) => c.map(segOut));

async function contoursOf(svg) {
  const b = await importSvg(svg, { preserveViewport: true });
  const r = b.curveRangesByShape[0];
  return curveRangeToContours(new Float32Array(b.curves), r.begin, r.end);
}

// The builder's own fill probe over a segment list: the ray lifted by 1e-5 of the extent.
function inkOf(segs, fillRule) {
  let xa = Infinity,
    xb = -Infinity,
    ya = Infinity,
    yb = -Infinity;
  for (const sg of segs)
    for (const P of [sg.p1, sg.p2, sg.p3])
      if (P) {
        if (P[0] < xa) xa = P[0];
        if (P[0] > xb) xb = P[0];
        if (P[1] < ya) ya = P[1];
        if (P[1] > yb) yb = P[1];
      }
  const eps = Math.max(xb - xa, yb - ya, 1e-6) * 1e-5;
  return (p) => {
    const w = rayWinding(segs, p[0], p[1] + eps);
    return fillRule === 'evenodd' ? (w & 1) === 1 : w !== 0;
  };
}

// ---- static shapes ------------------------------------------------------------------------------
const svgOf = (vb, rule, d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"><path fill="#3366cc" fill-rule="${rule}" d="${d}"/></svg>`;
const ringD = (cx, cy, R, r) =>
  `M${cx} ${cy - R} A${R} ${R} 0 1 0 ${cx} ${cy + R} A${R} ${R} 0 1 0 ${cx} ${cy - R} Z ` +
  `M${cx} ${cy - r} A${r} ${r} 0 1 1 ${cx} ${cy + r} A${r} ${r} 0 1 1 ${cx} ${cy - r} Z`;
// Ten-point stars around (50,50) whose edges bow outward: quads, then circular arcs.
const starPts = [];
for (let i = 0; i < 10; i++) {
  const a = -Math.PI / 2 + (i * Math.PI) / 5,
    rr = i % 2 ? 16 : 42;
  starPts.push([50 + rr * Math.cos(a), 50 + rr * Math.sin(a)]);
}
const fx = (v) => +v.toFixed(4);
let quadStarD = `M${fx(starPts[0][0])} ${fx(starPts[0][1])}`;
let arcStarD = quadStarD;
for (let i = 0; i < 10; i++) {
  const P = starPts[i],
    Q = starPts[(i + 1) % 10];
  const mx = (P[0] + Q[0]) / 2,
    my = (P[1] + Q[1]) / 2,
    dx = Q[0] - P[0],
    dy = Q[1] - P[1],
    L = Math.hypot(dx, dy);
  // outward = away from the center
  let nx = dy / L,
    ny = -dx / L;
  if (nx * (mx - 50) + ny * (my - 50) < 0) {
    nx = -nx;
    ny = -ny;
  }
  quadStarD += ` Q${fx(mx + nx * 0.18 * L)} ${fx(my + ny * 0.18 * L)} ${fx(Q[0])} ${fx(Q[1])}`;
  arcStarD += ` A${fx(0.9 * L)} ${fx(0.9 * L)} 0 0 0 ${fx(Q[0])} ${fx(Q[1])}`;
}
quadStarD += ' Z';
arcStarD += ' Z';

const staticCases = [
  // lbQuadHullCrossSmoke: hulls that cross ...
  [
    'thin arc ring',
    svgOf('0 0 100 100', 'evenodd', 'M50 10 a40 40 0 1 0 0.1 0 Z M50 20 a30 30 0 1 0 0.1 0 Z'),
    'evenodd',
  ],
  [
    'same-way leaf',
    svgOf(
      '-25 -34 12 10',
      'nonzero',
      'M -17.85 -27.6 L -14.1 -31.25 Q -19.531 -32.644 -23.725 -26.6 L -23.625 -26.6 Q -22.363 -29.021 -17.85 -27.6 Z',
    ),
    'nonzero',
  ],
  [
    'rounded bar end',
    svgOf(
      '-36 3 72 11',
      'nonzero',
      'M -34 4.8 Q -33.05 8.7 -25.3 9.05 L 34 9.05 L 34 12.05 L 30 12.05 L -25.3 12.05 Q -27.575 11.947 -29.275 11.55 Q -33.329 10.555 -34 7.8 Z',
    ),
    'nonzero',
  ],
  // ... and hulls that nest.
  [
    'nested sliver',
    svgOf(
      '-19.3 13.5 0.5 2.8',
      'evenodd',
      'M -18.875 13.65 Q -19.175 14.972 -19 16.125 Q -19.125 15.107 -18.9 13.95 Q -18.892 13.795 -18.875 13.65 Z',
    ),
    'evenodd',
  ],
  // lbAirFaceCrescentSmoke: crescents whose curve runs through an all-air face.
  ['hole parity ring', svgOf('0 0 100 100', 'nonzero', ringD(50, 50, 44, 20)), 'nonzero'],
  ['offset ring', svgOf('0 0 100 100', 'nonzero', ringD(50.1, 49.7, 43.3, 19.7)), 'nonzero'],
  // lbNotchAirFaceSmoke: notch faces whose vertices are the outline's own joints.
  [
    'notch',
    svgOf(
      '0 -12 30 26',
      'nonzero',
      'M 25 -8.95 Q 4.25 -10.15 5.05 11.35 L 25 11.4 L 25 10.4 L 17.3 10.4 L 17.3 5.35 L 8.85 5.35 L 8.85 -2.35 L 13.1 -2.35 Q 13.4 -3.15 13.9 -3.35 L 17.3 -4.6 L 17.3 -7.4 L 25 -7.4 Z',
    ),
    'nonzero',
  ],
  // A concave quad whose control point pokes past the outline's long top edge.
  [
    'hook under a line',
    svgOf('0 -20 100 60', 'nonzero', 'M0 0 L100 0 L100 40 L60 40 Q50 -12 40 40 L0 40 Z'),
    'nonzero',
  ],
  ['quad star', svgOf('0 0 100 100', 'nonzero', quadStarD), 'nonzero'],
  ['arc star', svgOf('0 0 100 100', 'nonzero', arcStarD), 'nonzero'],
];

const statics = [];
for (const [name, svg, fillRule] of staticCases) {
  const contours = await contoursOf(svg);
  const rec = { name, fillRule, contours: ctOut(contours) };

  _setKeyOrigin(contours);
  rec.keyOrigin = { kox: lbContour._kox, koy: lbContour._koy, koScale: lbContour._koScale };

  const authoredInk = inkOf(contours.flat(), fillRule);
  rec.interiorSign = contours.map((c) => {
    const s0 = calibrateInterior(c, authoredInk);
    return [s0, verifyInteriorSign(c, authoredInk, s0)];
  });
  rec.oriented = ctOut(orientContoursForFill(contours, authoredInk));

  _setKeyOrigin(contours);
  rec.hullSplit = ctOut(tapped.splitOverlappingQuadHulls9(contours));

  let tap = null;
  globalThis.__lbTap9 = (t) => {
    tap = t;
  };
  globalThis.__lbDeclineWhy = null;
  const mesh = tapped.buildLoopBlinnPartition(contours, { fillRule });
  globalThis.__lbTap9 = null;
  rec.declineWhy = mesh ? null : globalThis.__lbDeclineWhy || null;
  if (tap) {
    rec.tap = {
      allSegs: tap.allSegs.map(segOut),
      eps: tap.eps,
      pts: tap.pts.map((p) => [p[0], p[1]]),
      constraints: tap.constraints.map((c) => [c[0], c[1]]),
      tris: tap.tris.map((t) => [t[0], t[1], t[2]]),
      // every CDT face, asked both ways: [straddles, straddles touch, air face, air face touch]
      faces: tap.tris.map((t) => {
        const A = tap.pts[t[0]],
          B = tap.pts[t[1]],
          C = tap.pts[t[2]];
        return [
          tap.faceStraddles9(A, B, C, false),
          tap.faceStraddles9(A, B, C, true),
          tap.airFace9(A, B, C, false),
          tap.airFace9(A, B, C, true),
        ];
      }),
    };
  } else rec.tap = null;
  rec.mesh = mesh
    ? {
        quads: mesh.quads.map((q) => ({
          tri: Array.from(q.tri),
          sign: q.sign,
          w: q.w,
          hi9: q._hi9 ?? -1,
          fat: q._fat === undefined ? -1 : q._fat ? 1 : 0,
          tc: Array.from(q.tc),
        })),
        cubics: mesh.cubics.length,
        edges: mesh.edges.map((e) => ({ p1: e.p1, p2: e.p2, nx: e.nx, ny: e.ny })),
        hulls9: mesh.hulls9.map((h) => ({
          ai: h.ai,
          ci: h.ci,
          bi: h.bi,
          sign: h.sign,
          invis9: !!h.invis9,
          ci9: h.ci9,
          si9: h.si9,
        })),
        steiner9: mesh.steiner9.map((s) => s.pt),
        stripArcs: mesh.stripArcs.length,
      }
    : null;
  statics.push(rec);
}

// ---- morph pairs --------------------------------------------------------------------------------
const quarterRing = (cx, cy, R, r) =>
  `M${cx} ${cy - R} A${R} ${R} 0 0 0 ${cx - R} ${cy} A${R} ${R} 0 0 0 ${cx} ${cy + R} ` +
  `A${R} ${R} 0 0 0 ${cx + R} ${cy} A${R} ${R} 0 0 0 ${cx} ${cy - R} Z ` +
  `M${cx} ${cy - r} A${r} ${r} 0 0 1 ${cx + r} ${cy} A${r} ${r} 0 0 1 ${cx} ${cy + r} ` +
  `A${r} ${r} 0 0 1 ${cx - r} ${cy} A${r} ${r} 0 0 1 ${cx} ${cy - r} Z`;
const grow = (ct) =>
  ct.map((c) =>
    c.map((g) => {
      const o = { ...g };
      for (const k of ['p1', 'p2', 'p3', 'p4'])
        if (g[k]) o[k] = [126 + 1.1 * (g[k][0] - 126) + 6, 126 + 1.1 * (g[k][1] - 126) - 4];
      return o;
    }),
  );
const readSvg = (f) => readFileSync(new URL('../examples/smoke/' + f, import.meta.url), 'utf8');

const pairCases = [];
{
  const src = await contoursOf(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 252 252"><path fill="#7777ff" d="${quarterRing(126, 126, 99.8, 76.2)}"/></svg>`,
  );
  pairCases.push(['thick arc ring', src, grow(src)]);
}
{
  const src = await contoursOf(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 252 252"><path fill="#7777ff" d="M126 46A110 80 0 0 0 16 126A110 80 0 0 0 126 206A110 80 0 0 0 236 126A110 80 0 0 0 126 46Z M126 68A86 58 0 0 1 212 126A86 58 0 0 1 126 184A86 58 0 0 1 40 126A86 58 0 0 1 126 68Z"/></svg>`,
  );
  pairCases.push(['elliptical arc ring', src, grow(src)]);
}
{
  const load = async (f) => {
    const b = await importSvg(readSvg(f));
    const r = b.curveRangesByShape[0];
    return curveRangeToContours(new Float32Array(b.curves), r.begin, r.end);
  };
  pairCases.push([
    'invisible inner circle',
    await load('lbGpuMorph__SRC.svg'),
    await load('lbGpuMorph__DST.svg'),
  ]);
}

const meshOut = (m) => ({
  interior: m.interior.length / 6,
  quads: m.quads.map((q) => ({
    tri: Array.from(q.tri),
    sign: q.sign,
    w: q.w,
    tc: Array.from(q.tc),
  })),
  edges: m.edges.map((e) => ({ p1: e.p1, p2: e.p2, nx: e.nx, ny: e.ny })),
  stripArcs: m.stripArcs.length,
  hulls9: m.hulls9 ? m.hulls9.length : -1,
});
const pairs = [];
for (const [name, src, dst] of pairCases) {
  const rec = { name, src: ctOut(src), dst: ctOut(dst) };
  const [S, D] = tapped.splitOverlappingQuadHullsPair9(src, dst, 'nonzero');
  rec.split = {
    src: ctOut(S),
    dst: ctOut(D),
    keyOrigin: { kox: lbContour._kox, koy: lbContour._koy, koScale: lbContour._koScale },
  };
  for (const [tag, plain] of [
    ['pair', false],
    ['pairPlain', true],
  ]) {
    const pr = buildLoopBlinnPartitionPair(
      src,
      dst,
      'nonzero',
      plain ? { plainDstRows: true } : undefined,
    );
    rec[tag] = pr ? { src: meshOut(pr.src), dst: meshOut(pr.dst) } : null;
  }
  pairs.push(rec);
}

writeFileSync(
  new URL('../../csharp_tests/lb-parity/goldens/partfix.json', import.meta.url),
  JSON.stringify({ version: 1, statics, pairs }),
);
console.log('emitted partfix goldens:');
for (const s of statics)
  console.log(
    `  ${s.name}: ${s.contours.map((c) => c.length).join('+')} segs -> split ${s.hullSplit.map((c) => c.length).join('+')}, ` +
      (s.tap ? `${s.tap.pts.length} pts / ${s.tap.tris.length} faces, ` : 'no CDT, ') +
      (s.mesh
        ? `${s.mesh.quads.length}q ${s.mesh.edges.length}e ${s.mesh.steiner9.length} steiner`
        : `declined (${s.declineWhy})`),
  );
for (const p of pairs)
  console.log(
    `  pair ${p.name}: split ${p.split.src.map((c) => c.length).join('+')}, ` +
      `pair ${p.pair ? p.pair.dst.quads.length + 'q' : 'null'}, plain ${p.pairPlain ? p.pairPlain.dst.quads.length + 'q' : 'null'}`,
  );
