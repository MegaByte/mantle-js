// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// slugQuadRootScaleSmoke — the Slug quad ray solver answers the same at every coordinate scale
// (_coverage.glsl slugSolveHorizQuad / slugSolveVertQuad, and slugSolveQuad in src/hitTest/bandWinding.js).
//
// THE HAZARD. A solver that sends any quad whose leading coefficient a is under an absolute 1/65536 em to a
// linear path, t = c/(2b), is right only for a straight quad, and the stable root pair already gets that one
// exactly (d = |b|, q = 2b, tSml = c/(2b)), with the sign-pattern LUT admitting only that root. So such a path
// fixes nothing, and it breaks every really curved quad small enough to fall under the constant: at 2^-20 that
// is nearly all of them. An `abs(q) > 1e-30` guard is a no-op too, since d > 0 makes |q| >= d.
//
// (a) seeded closed contours of quads (curved, straight with the control point at the chord midpoint, and
//     symmetric arches) with some lines, both fill rules: every pixel center reads the same at 2^-20 and
//     2^20 as at 1;
// (b) every pixel more than 1.5 px from the outline matches an independent winding number (an angle sum over
//     a fine flattening of the decoded segments);
// (c) a straight quad reads within 1e-6 of the same edge drawn as a line;
// (d) neither shader solver keeps a linear path or an absolute guard.
// Mutations, each required to FAIL: the absolute linear path restored; both roots taken from the stable one.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const { decodeSegs } = await import('../src/hitTest/curveGeom.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- the module under test, and mutations of it -------------------------------------------
const SRC = readFileSync(path.join(ROOT, 'src/hitTest/bandWinding.js'), 'utf8');
const PAIR = '  const t1 = b >= 0 ? tSml : tBig;\n  const t2 = b >= 0 ? tBig : tSml;\n';
const mutate = (pairs) => {
  let s = SRC;
  for (const [from, to] of pairs) {
    ok(s.includes(from), `mutation hinge present: ${from.trim().slice(0, 48)}`);
    s = s.split(from).join(to);
  }
  return import('data:text/javascript;base64,' + Buffer.from(s).toString('base64'));
};
const SHIPPED = await import('../src/hitTest/bandWinding.js');
const MUTANTS = [
  [
    'the absolute 1/65536 linear path restored',
    await mutate([
      [
        PAIR,
        '  let t1 = b >= 0 ? tSml : tBig;\n  let t2 = b >= 0 ? tBig : tSml;\n  if (Math.abs(a) < 1 / 65536) { t1 = cc * 0.5 / b; t2 = t1; }\n',
      ],
    ]),
  ],
  [
    'both roots taken from the stable one',
    await mutate([[PAIR, '  const t1 = tSml;\n  const t2 = tSml;\n']]),
  ],
];

function bundleOf(b) {
  const MF = parseMetaBin(b.meta, b.metaFloatsPerShape).metaFloats;
  return {
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
const svgOf = (d, S, evenOdd) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${64 * S} ${64 * S}"><path ${evenOdd ? 'fill-rule="evenodd" ' : ''}d="${d}"/></svg>`;
const cov = (mod, B, x, y, S, evenOdd) =>
  mod.bandFillCoverage(B.bandF, B.curveF, B.gd, B.bb, x * S, y * S, 1 / S, 1 / S, evenOdd);

// ---- the cases ------------------------------------------------------------------------------
let seed = 0x9a0d;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
function contour() {
  const k = 3 + Math.floor(rnd() * 5),
    pts = [];
  for (let i = 0; i < k; i++) {
    const a = ((i + rnd() * 0.6) / k) * Math.PI * 2,
      r = 8 + rnd() * 20;
    pts.push([Math.round(32 + r * Math.cos(a)), Math.round(32 + r * Math.sin(a))]);
  }
  const parts = [['M', pts[0][0], pts[0][1]]];
  for (let i = 1; i <= k; i++) {
    const [x, y] = pts[i % k],
      [px, py] = pts[i - 1],
      u = rnd();
    if (u < 0.2) parts.push(['L', x, y]);
    else if (u < 0.45)
      parts.push(['Q', (px + x) / 2, (py + y) / 2, x, y]); // straight: a == 0
    else if (u < 0.6)
      parts.push(['Q', (px + x) / 2 + (py - y) * 0.6, (py + y) / 2 + (x - px) * 0.6, x, y]); // symmetric arch
    else
      parts.push([
        'Q',
        Math.round(px + (x - px) * rnd() + (rnd() - 0.5) * 30),
        Math.round(py + (y - py) * rnd() + (rnd() - 0.5) * 30),
        x,
        y,
      ]);
  }
  return (S) =>
    parts
      .map(
        (p) =>
          p[0] +
          ' ' +
          p
            .slice(1)
            .map((v) => +(v * S).toPrecision(17))
            .join(' '),
      )
      .join(' ') + ' Z';
}
const SCALES = [Math.pow(2, -20), 1, Math.pow(2, 20)];
const cases = [];
let farTotal = 0;
for (let i = 0; i < 40; i++) {
  const d = contour();
  for (const evenOdd of [false, true]) {
    const bundles = new Map();
    for (const S of SCALES)
      bundles.set(
        S,
        bundleOf(await importSvg(svgOf(d(S), S, evenOdd), { preserveViewport: true })),
      );
    const B1 = bundles.get(1),
      b1 = await importSvg(svgOf(d(1), 1, evenOdd), { preserveViewport: true });
    const rg = b1.curveRangesByShape[0];
    const pl = decodeSegs(B1.curveF, rg.begin, rg.end).map((s) => {
      if (s.t === 0)
        return [
          [s.x0, s.y0],
          [s.x1, s.y1],
        ];
      const o = [];
      for (let k = 0; k <= 200; k++) {
        const t = k / 200,
          u = 1 - t;
        o.push([
          u * u * s.x0 + 2 * u * t * s.cx + t * t * s.x1,
          u * u * s.y0 + 2 * u * t * s.cy + t * t * s.y1,
        ]);
      }
      return o;
    });
    const far = [];
    for (let yi = 0; yi < 64; yi++)
      for (let xi = 0; xi < 64; xi++) {
        const x = xi + 0.5,
          y = yi + 0.5;
        let dist = Infinity,
          w = 0;
        for (const p of pl)
          for (let j = 0; j + 1 < p.length; j++) {
            const ax = p[j][0] - x,
              ay = p[j][1] - y,
              bx = p[j + 1][0] - x,
              by = p[j + 1][1] - y;
            w += Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
            const dx = bx - ax,
              dy = by - ay,
              L2 = dx * dx + dy * dy;
            const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
            dist = Math.min(dist, Math.hypot(ax + t * dx, ay + t * dy));
          }
        if (dist <= 1.5) continue;
        const wn = Math.round(w / (2 * Math.PI));
        far.push({ x, y, want: (evenOdd ? (wn & 1) === 1 : wn !== 0) ? 1 : 0 });
      }
    farTotal += far.length;
    cases.push({ evenOdd, bundles, far });
  }
}
function offScale(mod) {
  let n = 0,
    differ = 0,
    worst = 0;
  for (const c of cases) {
    const B1 = c.bundles.get(1);
    for (let yi = 0; yi < 64; yi++)
      for (let xi = 0; xi < 64; xi++) {
        const c1 = cov(mod, B1, xi + 0.5, yi + 0.5, 1, c.evenOdd);
        for (const S of SCALES) {
          if (S === 1) continue;
          const cs = cov(mod, c.bundles.get(S), xi + 0.5, yi + 0.5, S, c.evenOdd);
          n++;
          if (cs !== c1) {
            differ++;
            worst = Math.max(worst, Math.abs(cs - c1));
          }
        }
      }
  }
  return { n, differ, worst };
}
function farWrong(mod) {
  let wrong = 0;
  for (const c of cases)
    for (const S of SCALES)
      for (const p of c.far)
        if (Math.abs(cov(mod, c.bundles.get(S), p.x, p.y, S, c.evenOdd) - p.want) > 1e-9) wrong++;
  return wrong;
}

// ---- (a), (b) ----------------------------------------------------------------------------------
{
  const s = offScale(SHIPPED),
    w = farWrong(SHIPPED);
  ok(
    s.n > 300000 && s.differ === 0,
    `(a) every pixel reads the same at 2^-20 and 2^20 as at 1 (${s.differ} of ${s.n} differ${s.differ ? `, worst ${s.worst.toFixed(3)}` : ''})`,
  );
  ok(
    farTotal > 50000 && w === 0,
    `(b) ${farTotal} pixels per scale more than 1.5 px from the outline match the winding number at all three scales (${w} wrong)`,
  );
}

// ---- (c) a straight quad is its line -----------------------------------------------------------
{
  let n = 0,
    worst = 0;
  for (let i = 0; i < 60; i++) {
    const x0 = Math.round(rnd() * 64),
      y0 = Math.round(rnd() * 64),
      x1 = Math.round(rnd() * 64),
      y1 = Math.round(rnd() * 64);
    const tri = `${x1} ${y0} Z`;
    const asLine = `M ${x0} ${y0} L ${x1} ${y1} L ${tri}`,
      asQuad = `M ${x0} ${y0} Q ${(x0 + x1) / 2} ${(y0 + y1) / 2} ${x1} ${y1} L ${tri}`;
    const BL = bundleOf(await importSvg(svgOf(asLine, 1, false), { preserveViewport: true }));
    const BQ = bundleOf(await importSvg(svgOf(asQuad, 1, false), { preserveViewport: true }));
    for (let yi = 0; yi < 64; yi += 3)
      for (let xi = 0; xi < 64; xi += 3) {
        n++;
        worst = Math.max(
          worst,
          Math.abs(
            cov(SHIPPED, BL, xi + 0.5, yi + 0.5, 1, false) -
              cov(SHIPPED, BQ, xi + 0.5, yi + 0.5, 1, false),
          ),
        );
      }
  }
  ok(
    worst <= 1e-6,
    `(c) a quad with its control point at the chord midpoint reads as its line: worst difference ${worst.toExponential(1)} over ${n} pixels`,
  );
}

// ---- (d) the shader ------------------------------------------------------------------------------
{
  const gl = readFileSync(path.join(ROOT, 'src/shaders/_coverage.glsl'), 'utf8');
  for (const name of ['slugSolveHorizQuad', 'slugSolveVertQuad']) {
    const at = gl.indexOf(`vec4 ${name}(`),
      body = at < 0 ? '' : gl.slice(at, gl.indexOf('\n}\n', at));
    ok(
      body.length > 0 && !/65536|1e-30|\brb\b/.test(body) && /\? p12\.[xy] \/ q : tBig;/.test(body),
      `(d) ${name} has no linear path and divides by q under d > 0 alone`,
    );
  }
}

// ---- mutations ----------------------------------------------------------------------------------
for (const [name, mod] of MUTANTS) {
  const s = offScale(mod),
    w = farWrong(mod);
  ok(
    s.differ > 0 || w > 0,
    `mutation "${name}" is caught: ${s.differ} pixels off scale 1, ${w} far pixels wrong`,
  );
}

if (fail) {
  console.error(`SLUG-QUAD-ROOT-SCALE FAIL (${fail})`);
  process.exit(1);
}
console.log('SLUG-QUAD-ROOT-SCALE PASS');
