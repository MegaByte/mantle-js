// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// slugArcRadiusScaleSmoke — the Slug arc walkers find an arc's roots at every coordinate scale (_coverage.glsl's H and V
// arc sub-loops and hardCrossArc, and the arc loop in src/hitTest/bandWinding.js).
//
// THE HAZARD. An arc solve that treats the arc as tangent to the ray, with no roots, when its extent across the
// ray, Rlen = |(sin phi rx, cos phi ry)|, is under an ABSOLUTE 1e-10 em never fills a radius-30 circle at 2^-40,
// which is under it everywhere. Only a zero extent is degenerate: C / Rlen needs Rlen != 0 (C == 0 would make it NaN),
// and a tiny nonzero extent is already a well-posed ratio. All three walkers count through ONE rule,
// arcRayCrossings, so the zero-extent test lives there once.
//
// (a) seeded closed contours of arcs (circles, rotated ellipses, large and small sweeps) and lines, both fill rules:
//     every pixel center reads the same at 2^-40 and 2^-20 as at 1;
// (b) every pixel more than 1.5 px from the outline matches an independent winding number at all three scales;
// (c) no arc site in the shader keeps an absolute extent test.
// Mutation, required to FAIL: the absolute `Rlen <= 1e-10` restored.
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

// ---- the module under test, and a mutation of it ------------------------------------------
const SRC = readFileSync(path.join(ROOT, 'src/hitTest/bandWinding.js'), 'utf8');
const DEGENERATE = 'if (!(Rlen > 0)) return NONE;';
ok(SRC.split(DEGENERATE).length === 2, 'mutation hinge present: the arc zero-extent test');
const SHIPPED = await import('../src/hitTest/bandWinding.js');
const ABSOLUTE = await import(
  'data:text/javascript;base64,' +
    Buffer.from(SRC.split(DEGENERATE).join('if (!(Rlen > 1e-10)) return NONE;')).toString('base64')
);

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
let seed = 0xa4c1;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
function contour() {
  const k = 2 + Math.floor(rnd() * 4),
    pts = [];
  for (let i = 0; i < k; i++) {
    const a = ((i + rnd() * 0.6) / k) * Math.PI * 2,
      r = 8 + rnd() * 18;
    pts.push([+(32 + r * Math.cos(a)).toFixed(2), +(32 + r * Math.sin(a)).toFixed(2)]);
  }
  const parts = [['M', ...pts[0]]];
  for (let i = 1; i <= k; i++) {
    const [x, y] = pts[i % k],
      [px, py] = pts[i - 1],
      half = Math.hypot(x - px, y - py) / 2;
    if (half < 0.5) continue;
    if (rnd() < 0.8) {
      const rx = +(half * (1 + rnd() * 2)).toFixed(2),
        ry = +(rnd() < 0.5 ? rx : rx * (0.4 + rnd())).toFixed(2);
      parts.push([
        'A',
        rx,
        ry,
        Math.floor(rnd() * 180),
        rnd() < 0.3 ? 1 : 0,
        rnd() < 0.5 ? 1 : 0,
        x,
        y,
      ]);
    } else parts.push(['L', x, y]);
  }
  const n = (v, S) => +(v * S).toPrecision(17);
  return (S) =>
    parts
      .map((p) =>
        p[0] === 'A'
          ? `A ${n(p[1], S)} ${n(p[2], S)} ${p[3]} ${p[4]} ${p[5]} ${n(p[6], S)} ${n(p[7], S)}`
          : `${p[0]} ${n(p[1], S)} ${n(p[2], S)}`,
      )
      .join(' ') + ' Z';
}
// Not 2^20: there the IMPORTER changes the geometry first. splitSubpathsWithCloseInto (src/svg/bbox.js) calls a pen jump
// anything over an absolute 1e-4, and an arc's computed end at 2^20 misses the next start by more, so it adds closing lines.
const SCALES = [Math.pow(2, -40), Math.pow(2, -20), 1];
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
    const b1 = await importSvg(svgOf(d(1), 1, evenOdd), { preserveViewport: true }),
      rg = b1.curveRangesByShape[0];
    const pl = decodeSegs(bundles.get(1).curveF, rg.begin, rg.end).map((s) => {
      if (s.t !== 3)
        return [
          [s.x0, s.y0],
          [s.x1, s.y1],
        ];
      const o = [];
      for (let k = 0; k <= 400; k++) {
        const th = s.th0 + ((s.th1 - s.th0) * k) / 400;
        o.push([
          s.cx + s.rx * Math.cos(th) * s.cp - s.ry * Math.sin(th) * s.sp,
          s.cy + s.rx * Math.cos(th) * s.sp + s.ry * Math.sin(th) * s.cp,
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
function sweep(mod) {
  let n = 0,
    differ = 0,
    wrong = 0;
  const wrongAt = new Map();
  for (const c of cases) {
    for (let yi = 0; yi < 64; yi++)
      for (let xi = 0; xi < 64; xi++) {
        const c1 = cov(mod, c.bundles.get(1), xi + 0.5, yi + 0.5, 1, c.evenOdd);
        for (const S of SCALES)
          if (S !== 1) {
            n++;
            if (cov(mod, c.bundles.get(S), xi + 0.5, yi + 0.5, S, c.evenOdd) !== c1) differ++;
          }
      }
    for (const S of SCALES)
      for (const p of c.far)
        if (Math.abs(cov(mod, c.bundles.get(S), p.x, p.y, S, c.evenOdd) - p.want) > 1e-9) {
          wrong++;
          wrongAt.set(S, (wrongAt.get(S) || 0) + 1);
        }
  }
  return { n, differ, wrong, wrongAt };
}
{
  const r = sweep(SHIPPED);
  ok(
    r.n > 500000 && r.differ === 0,
    `(a) every pixel reads the same at 2^-40 and 2^-20 as at 1 (${r.differ} of ${r.n} differ)`,
  );
  ok(
    farTotal > 50000 && r.wrong === 0,
    `(b) ${farTotal} pixels per scale more than 1.5 px from the outline match the winding number at all three scales (${r.wrong} wrong)`,
  );
}

// ---- (c) the shader ------------------------------------------------------------------------------
{
  const gl = readFileSync(path.join(ROOT, 'src/shaders/_coverage.glsl'), 'utf8').replace(
    /\/\/[^\n]*/g,
    '',
  );
  // No walker has a `tangent` branch to guard: a ray grazing an extremum falls out of
  // arcRayCrossings' end-side test with no crossing, which is the tangent answer, and its
  // only degeneracy is a ZERO extent across the ray -- a segment
  // parallel to it, which never crosses.
  const rule = gl.slice(
    gl.indexOf('vec3 arcRayCrossings('),
    gl.indexOf('\n}\n', gl.indexOf('vec3 arcRayCrossings(')),
  );
  ok(
    !/Rlen\s*(<=|>)\s*1e-10/.test(gl) &&
      /if \(!\(Rlen > 0\.0\)\) return vec3\(0\.0\);/.test(rule) &&
      !/tangent9|tangentV/.test(gl),
    "(c) the arc walkers' one rule tests only a zero extent, and returns no crossings for one",
  );
}

// ---- mutation -----------------------------------------------------------------------------------
{
  const r = sweep(ABSOLUTE);
  ok(
    r.differ > 0 || r.wrong > 0,
    `mutation "the absolute Rlen <= 1e-10 restored" is caught: ${r.differ} pixels off scale 1, ${r.wrong} far pixels wrong (${[...r.wrongAt].map(([S, k]) => `2^${Math.log2(S)}: ${k}`).join(', ')})`,
  );
}

if (fail) {
  console.error(`SLUG-ARC-RADIUS-SCALE FAIL (${fail})`);
  process.exit(1);
}
console.log('SLUG-ARC-RADIUS-SCALE PASS');
