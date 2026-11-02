// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// slugCubicVertexTouchSmoke — a cubic outline that TOUCHES a scanline, at a vertex or at an extremum, counts the
// crossings of that scanline the way the line walker does (_coverage.glsl solveCubicBisect and its H/V/band-hard
// callers, and solveCubicBisect in src/hitTest/bandWinding.js).
//
// THE HAZARD. A cubic walk that classifies a value of exactly 0 as NEGATIVE, patches the vertex that crosses the
// ray with an apex rule and drops roots at t = 1 counts one crossing instead of none or two at a vertex the outline
// only touches, and where the other ray agrees the pixel reads blank: the whole row through a heart's notch, left
// of it. The line walker counts 0 as NON-NEGATIVE (a ray a hair toward the negative side); the cubic walk does the
// same, reads the segment's ends as p1 and p4 exactly, keeps a root at t = 1, and takes each crossing's direction
// from its monotone piece instead of the slope at the root (0 at a touch).
//
// (a) a heart, both orientations, whose notch vertex sits on a sample row and is touched from the negative side
//     by both cubics, and the same heart with one side of the notch a LINE (the walkers must agree on a vertex
//     they share): every pixel on that row more than 1.5 px from the outline matches an independent winding
//     number, at 2^-20, 1 and 2^20, both fill rules;
// (b) a 4-cubic circle whose four vertices sit on sample rows and columns, and two circles placed so that one
//     pixel's H ray touches the first at its lowest point and its V ray touches the second at its rightmost, with
//     the tangent flat there (the slope at both roots is 0), and that placement again with a line on one side of
//     each touched vertex: the same, on those rows and columns;
// (c) an arch whose extremum lies inside a segment exactly on a sample row: the same, and the two pixels
//     either side of the extremum read within 0.004 of a 400x400 supersampled coverage (both under 0.5).
// (d) the shader carries the same rule: solveCubicBisect's classification, exact ends and direction, and its caller
//     (band-hard's hardCrossCubic) keeps t = 1 and takes the direction from it.
// Mutations, each required to FAIL: 0 counted as negative; a root at t = 1 dropped; the direction taken from the
// slope at the root.
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

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- the module under test, and mutations of it -------------------------------------------
const SRC = readFileSync(path.join(ROOT, 'src/hitTest/bandWinding.js'), 'utf8');
const SIDE = 'const sLo = yLo >= 0,\n      sHi = yHi >= 0;';
const FILTER = 'if (tsv[j] < 0 || rs[j] !== rs[j]) continue;';
const DIR = 'const sgn = horiz ? (upv[j] ? -1 : 1) : upv[j] ? 1 : -1;';
const mutate = (pairs) => {
  let s = SRC;
  for (const [from, to] of pairs) {
    ok(s.includes(from), `mutation hinge present: ${from.slice(0, 48)}`);
    s = s.split(from).join(to);
  }
  return import('data:text/javascript;base64,' + Buffer.from(s).toString('base64'));
};
const SHIPPED = await import('../src/hitTest/bandWinding.js');
const MUTANTS = [
  ['0 counted as negative', await mutate([[SIDE, 'const sLo = yLo > 0, sHi = yHi > 0;']])],
  [
    'a root at t = 1 dropped',
    await mutate([[FILTER, 'if (tsv[j] < 0 || tsv[j] >= 1 || rs[j] !== rs[j]) continue;']]),
  ],
  [
    'the direction taken from the slope at the root',
    await mutate([
      [
        DIR,
        'const dcd = evalCD(cubicCoeff(ry[0], ry[1], ry[2], ry[3]), tsv[j]); const sgn = horiz ? (dcd < 0 ? 1 : -1) : (dcd >= 0 ? 1 : -1);',
      ],
    ]),
  ],
];

// ---- the shapes -----------------------------------------------------------------------------
const SHAPES = {
  heart:
    'M 32.5 20.5 C 32.5 8 10 8 10 25 C 10 40 32.5 50 32.5 58 C 32.5 50 55 40 55 25 C 55 8 32.5 8 32.5 20.5 Z',
  'heart reversed':
    'M 32.5 20.5 C 32.5 8 55 8 55 25 C 55 40 32.5 50 32.5 58 C 32.5 50 10 40 10 25 C 10 8 32.5 8 32.5 20.5 Z',
  circle: (() => {
    const c = 32.5,
      r = 20,
      k = 0.5523 * r;
    return (
      `M ${c - r} ${c} C ${c - r} ${c - k} ${c - k} ${c - r} ${c} ${c - r} C ${c + k} ${c - r} ${c + r} ${c - k} ${c + r} ${c} ` +
      `C ${c + r} ${c + k} ${c + k} ${c + r} ${c} ${c + r} C ${c - k} ${c + r} ${c - r} ${c + k} ${c - r} ${c} Z`
    );
  })(),
  arch: 'M 8 32 C 8 10 56 10 56 32 C 56 54 8 54 8 32 Z', // extrema at (32, 15.5) and (32, 48.5), inside the segments
  'heart with a line':
    'M 32.5 20.5 C 32.5 8 55 8 55 25 C 55 40 32.5 50 32.5 58 C 32.5 50 10 40 10 25 C 10 12 14 8 20 8 L 32.5 20.5 Z',
  'heart with a line reversed':
    'M 32.5 20.5 L 20 8 C 14 8 10 12 10 25 C 10 40 32.5 50 32.5 58 C 32.5 50 55 40 55 25 C 55 8 32.5 8 32.5 20.5 Z',
  'two circles': (() => {
    const k = 5.523,
      ring = (cx, cy, r) =>
        `M ${cx - r} ${cy} C ${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} C ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} ` +
        `C ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} C ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} Z`;
    return ring(40.5, 10.5, 10) + ' ' + ring(10.5, 40.5, 10);
  })(),
  // the same placement with a LINE on one side of each touched vertex: the cubic and line walkers must agree there
  'line and cubic pair':
    'M 40.5 20.5 L 30.5 10.5 C 30.5 4 50.5 4 50.5 10.5 C 50.5 14 44 18 40.5 20.5 Z M 20.5 40.5 L 10.5 30.5 C 4 30.5 4 50.5 10.5 50.5 C 14 50.5 18 44 20.5 40.5 Z',
};
const PROBES = {
  // the rows (y) and columns (x) that touch
  heart: { rows: [20.5], cols: [] },
  'heart reversed': { rows: [20.5], cols: [] },
  circle: { rows: [12.5, 32.5, 52.5], cols: [12.5, 32.5, 52.5] },
  arch: { rows: [15.5, 48.5], cols: [] },
  'heart with a line': { rows: [20.5], cols: [] },
  'heart with a line reversed': { rows: [20.5], cols: [] },
  'two circles': { rows: [20.5], cols: [20.5] },
  'line and cubic pair': { rows: [20.5], cols: [20.5] },
};
// the outline flattened finely from the path text, for the winding number, the distance and the supersample
function outline(d) {
  const subpaths = [];
  for (const sub of d.split('M').filter((q) => q.trim())) {
    const tok = sub.trim().split(/\s+/),
      pts = [];
    let x = Number(tok[0]),
      y = Number(tok[1]),
      i = 2;
    while (i < tok.length) {
      if (tok[i] === 'Z') break;
      if (tok[i] === 'L') {
        const x3 = Number(tok[i + 1]),
          y3 = Number(tok[i + 2]);
        for (let k = 0; k < 600; k++)
          pts.push([x + ((x3 - x) * k) / 600, y + ((y3 - y) * k) / 600]);
        x = x3;
        y = y3;
        i += 3;
      } else {
        const [x1, y1, x2, y2, x3, y3] = tok.slice(i + 1, i + 7).map(Number);
        for (let k = 0; k < 600; k++) {
          const t = k / 600,
            u = 1 - t,
            w0 = u * u * u,
            w1 = 3 * u * u * t,
            w2 = 3 * u * t * t,
            w3 = t * t * t;
          pts.push([w0 * x + w1 * x1 + w2 * x2 + w3 * x3, w0 * y + w1 * y1 + w2 * y2 + w3 * y3]);
        }
        x = x3;
        y = y3;
        i += 7;
      }
    }
    subpaths.push(pts);
  }
  return subpaths;
}
const winding = (subs, x, y) => {
  let w = 0;
  for (const pts of subs)
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i],
        b = pts[(i + 1) % pts.length];
      w += Math.atan2(
        (a[0] - x) * (b[1] - y) - (a[1] - y) * (b[0] - x),
        (a[0] - x) * (b[0] - x) + (a[1] - y) * (b[1] - y),
      );
    }
  return Math.round(w / (2 * Math.PI));
};
const distance = (subs, x, y) => {
  let d = Infinity;
  for (const pts of subs) for (const p of pts) d = Math.min(d, Math.hypot(p[0] - x, p[1] - y));
  return d;
};
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
const SCALES = [Math.pow(2, -20), 1, Math.pow(2, 20)];
const cases = [];
for (const [name, d] of Object.entries(SHAPES)) {
  const pts = outline(d),
    far = [];
  const probe = (x, y) => {
    if (distance(pts, x, y) > 1.5) far.push({ x, y, want: winding(pts, x, y) });
  };
  for (const y of PROBES[name].rows) for (let xi = 0; xi < 64; xi++) probe(xi + 0.5, y);
  for (const x of PROBES[name].cols) for (let yi = 0; yi < 64; yi++) probe(x, yi + 0.5);
  for (const S of SCALES)
    for (const evenOdd of [false, true]) {
      const dS = d.replace(/-?\d+(\.\d+)?/g, (m) => `${+(Number(m) * S).toPrecision(17)}`);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${64 * S} ${64 * S}"><path ${evenOdd ? 'fill-rule="evenodd" ' : ''}d="${dS}"/></svg>`;
      cases.push({
        name,
        S,
        evenOdd,
        far,
        B: bundleOf(await importSvg(svg, { preserveViewport: true })),
      });
    }
}
const cov = (mod, c, x, y) =>
  mod.bandFillCoverage(
    c.B.bandF,
    c.B.curveF,
    c.B.gd,
    c.B.bb,
    x * c.S,
    y * c.S,
    1 / c.S,
    1 / c.S,
    c.evenOdd,
  );
function wrong(mod, which) {
  let n = 0,
    bad = 0;
  for (const c of cases) {
    if (which && !which.includes(c.name)) continue;
    for (const p of c.far) {
      const want = (c.evenOdd ? (p.want & 1) === 1 : p.want !== 0) ? 1 : 0;
      n++;
      if (Math.abs(cov(mod, c, p.x, p.y) - want) > 1e-9) bad++;
    }
  }
  return { n, bad };
}
// (c)'s two pixels beside the arch's extremum, against a 400x400 supersample
const archPts = outline(SHAPES.arch);
const EXTREMUM_PX = [
  [31, 15],
  [32, 15],
].map(([x, y]) => {
  let inside = 0;
  for (let j = 0; j < 400; j++)
    for (let i = 0; i < 400; i++)
      if (winding(archPts, x + (i + 0.5) / 400, y + (j + 0.5) / 400) !== 0) inside++;
  return { x: x + 0.5, y: y + 0.5, ref: inside / 160000 };
});
function extremumWorst(mod) {
  let worst = 0,
    above = 0;
  for (const c of cases)
    if (c.name === 'arch')
      for (const p of EXTREMUM_PX) {
        const v = cov(mod, c, p.x, p.y);
        worst = Math.max(worst, Math.abs(v - p.ref));
        if (v >= 0.5) above++;
      }
  return { worst, above };
}

// ---- checks ---------------------------------------------------------------------------------
for (const [label, which] of [
  [
    '(a) heart notch rows',
    ['heart', 'heart reversed', 'heart with a line', 'heart with a line reversed'],
  ],
  ['(b) circle vertex rows and columns', ['circle', 'two circles', 'line and cubic pair']],
  ['(c) arch extremum rows', ['arch']],
]) {
  const r = wrong(SHIPPED, which);
  ok(
    r.n > 100 && r.bad === 0,
    `${label}: every far pixel matches the winding number at 2^-20, 1 and 2^20, both fill rules (${r.bad} of ${r.n} wrong)`,
  );
}
{
  const e = extremumWorst(SHIPPED);
  ok(
    e.worst <= 0.004 && e.above === 0,
    `(c) the pixels beside the arch's extremum read within 0.004 of the supersample (worst ${e.worst.toFixed(4)}; references ${EXTREMUM_PX.map((p) => p.ref.toFixed(4)).join(', ')}; ${e.above} read >= 0.5)`,
  );
}
{
  const gl = readFileSync(path.join(ROOT, 'src/shaders/_coverage.glsl'), 'utf8');
  const fn = gl.slice(gl.indexOf('void solveCubicBisect('), gl.indexOf('@@BOX_COV@@'));
  ok(
    /void solveCubicBisect\(vec4 p12, vec4 p34, bool vert, out vec3 r, out vec3 t, out vec3 up\)/.test(
      fn,
    ) &&
      /float lo = 0\.0, yLo = yEnd0;/.test(fn) &&
      /float yHi = \(hi < 1\.0\) \? evalC\(cy, hi\) : yEnd1;/.test(fn) &&
      /bool sLo = yLo >= 0\.0;/.test(fn) &&
      /sLo != sHi/.test(fn) &&
      /bool sHi = yHi >= 0\.0;/.test(fn) &&
      /uu = sHi \? 1\.0 : 0\.0;/.test(fn) &&
      !/apexTol|EPS/.test(fn.replace(/\/\/[^\n]*/g, '')),
    "(d) solveCubicBisect: 0 counts as non-negative, the ends are p1 and p4, the direction is the piece's, no on-the-ray tolerance",
  );
  const calls = [
    ...gl.matchAll(/solveCubicBisect\(p12, p34, (false|true), rs, ts, up\);([\s\S]*?)\n  \}/g),
  ];
  ok(
    calls.length === 1 &&
      calls.every(
        (m) =>
          !/ts\[j\] >= 1\.0/.test(m[2]) &&
          /up\[j\] > 0\.5/.test(m[2]) &&
          !/evalCD\(c[xy], ts\[j\]\)/.test(m[2]),
      ),
    `(d) hardCrossCubic, the one caller left, keeps a root at t = 1 and takes its direction from up (${calls.length} of 1 found)`,
  );
}
for (const [name, mod] of MUTANTS) {
  const r = wrong(mod),
    e = extremumWorst(mod);
  ok(
    r.bad > 0 || e.worst > 0.004 || e.above > 0,
    `mutation "${name}" is caught: ${r.bad} far pixels wrong, extremum pixels worst ${e.worst.toFixed(4)} (${e.above} >= 0.5)`,
  );
}

if (fail) {
  console.error(`SLUG-CUBIC-VERTEX-TOUCH FAIL (${fail})`);
  process.exit(1);
}
console.log('SLUG-CUBIC-VERTEX-TOUCH PASS');
