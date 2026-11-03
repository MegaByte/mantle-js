// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// CPU cubic winding remains scale invariant and rejects unstable split mutations.
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
const { windingReference } = await import('./_windingReference.mjs');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- the module under test, and mutations of it -------------------------------------------
const SRC = readFileSync(path.join(ROOT, 'src/hitTest/bandWinding.js'), 'utf8');
const DEGEN = 'if (Math.abs(qa) <= 1e-6 * Math.max(Math.abs(qb), Math.abs(qc))) {';
const PAIR =
  'const qq = -0.5 * (qb + (qb >= 0 ? sd : -sd));\n      let s1 = qq / qa,\n        s2 = Math.abs(qq) > 1e-30 ? qc / qq : s1;';
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
  [
    'the absolute 1/65536 degeneracy test restored',
    await mutate([[DEGEN, 'if (Math.abs(qa) < 1 / 65536) {']]),
  ],
  [
    'the canceling root form',
    await mutate([[PAIR, 'let s1 = (-qb - sd) / (2 * qa), s2 = (-qb + sd) / (2 * qa);']]),
  ],
];

// ---- (b) small cubics keep their splits -----------------------------------------------------
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
let seed = 0xc0b1;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
function contour() {
  const k = 3 + Math.floor(rnd() * 2),
    pts = [];
  for (let i = 0; i < k; i++) {
    const a = ((i + rnd() * 0.5) / k) * Math.PI * 2,
      r = 10 + rnd() * 16;
    pts.push([Math.round(32 + r * Math.cos(a)), Math.round(32 + r * Math.sin(a))]);
  }
  const parts = [['M', pts[0][0], pts[0][1]]];
  for (let i = 1; i <= k; i++) {
    const [x, y] = pts[i % k],
      [px, py] = pts[i - 1],
      nx = py - y,
      ny = x - px,
      u = rnd();
    if (u < 0.4)
      parts.push([
        'C',
        px + (x - px) / 3 + nx * 0.7,
        py + (y - py) / 3 + ny * 0.7,
        px + (2 * (x - px)) / 3 + nx * 0.7,
        py + (2 * (y - py)) / 3 + ny * 0.7,
        x,
        y,
      ]); // arch
    else if (u < 0.7)
      parts.push([
        'C',
        px + (x - px) / 3 + nx * 0.5,
        py + (y - py) / 3 + ny * 0.5,
        px + (2 * (x - px)) / 3 - nx * 0.5,
        py + (2 * (y - py)) / 3 - ny * 0.5,
        x,
        y,
      ]); // S
    else
      parts.push([
        'C',
        px + (x - px) / 3 + nx * 0.02,
        py + (y - py) / 3 + ny * 0.02,
        px + (2 * (x - px)) / 3,
        py + (2 * (y - py)) / 3,
        x,
        y,
      ]); // near-straight
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
let probeTotal = 0,
  farTotal = 0;
// A pixel is a probe when its row is more than 1.2 units from every vertex y and critical-point y of the outline, and
// its column the same in x: there no other tolerance of the cubic walk (its on-the-ray rule reaches 1e-6 em, 1.05 units
// at 2^-20) can decide anything, so only the splits are under test.
const crit = (a, b, c, d) => {
  const A = -a + 3 * b - 3 * c + d,
    B = 3 * (a - 2 * b + c),
    C = 3 * (b - a),
    at = (t) => {
      const u = 1 - t;
      return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
    };
  const out = [a, d],
    disc = 4 * B * B - 12 * A * C;
  if (Math.abs(A) > 1e-12) {
    if (disc >= 0)
      for (const sg of [-1, 1]) {
        const t = (-2 * B + sg * Math.sqrt(disc)) / (6 * A);
        if (t > 0 && t < 1) out.push(at(t));
      }
  } else if (Math.abs(B) > 1e-12) {
    const t = -C / (2 * B);
    if (t > 0 && t < 1) out.push(at(t));
  }
  return out;
};
for (let i = 0; i < 60; i++) {
  const d = contour();
  for (const evenOdd of [false, true]) {
    const bundles = new Map();
    let rg;
    for (const S of SCALES) {
      const b = await importSvg(svgOf(d(S), S, evenOdd), { preserveViewport: true });
      if (S === 1) rg = b.curveRangesByShape[0];
      bundles.set(S, bundleOf(b));
    }
    const segs = decodeSegs(bundles.get(1).curveF, rg.begin, rg.end);
    const avoidX = [],
      avoidY = [];
    for (const s of segs) {
      if (s.t === 0) {
        avoidX.push(s.x0, s.x1);
        avoidY.push(s.y0, s.y1);
      } else {
        avoidX.push(...crit(s.x0, s.c1x, s.c2x, s.x1));
        avoidY.push(...crit(s.y0, s.c1y, s.c2y, s.y1));
      }
    }
    const ref = windingReference(segs, { pieces: 300 });
    const clear = (v, list) => list.every((a) => Math.abs(v - a) > 1.2);
    const probes = [],
      far = [];
    for (let yi = 0; yi < 64; yi++)
      for (let xi = 0; xi < 64; xi++) {
        const x = xi + 0.5,
          y = yi + 0.5;
        if (!clear(x, avoidX) || !clear(y, avoidY)) continue;
        probes.push({ x, y });
        const wn = ref(x, y);
        if (wn === null) continue;
        far.push({ x, y, want: (evenOdd ? (wn & 1) === 1 : wn !== 0) ? 1 : 0 });
      }
    probeTotal += probes.length;
    farTotal += far.length;
    cases.push({ evenOdd, bundles, probes, far });
  }
}
function sweep(mod) {
  let n = 0,
    differ = 0,
    wrong = 0;
  for (const c of cases) {
    for (const p of c.probes) {
      const c1 = cov(mod, c.bundles.get(1), p.x, p.y, 1, c.evenOdd);
      for (const S of SCALES)
        if (S !== 1) {
          n++;
          if (cov(mod, c.bundles.get(S), p.x, p.y, S, c.evenOdd) !== c1) differ++;
        }
    }
    for (const S of SCALES)
      for (const p of c.far)
        if (Math.abs(cov(mod, c.bundles.get(S), p.x, p.y, S, c.evenOdd) - p.want) > 1e-9) wrong++;
  }
  return { n, differ, wrong };
}
{
  const r = sweep(SHIPPED);
  ok(
    probeTotal > 5000 && r.differ === 0,
    `(b) ${probeTotal} pixels clear of every vertex and critical point read the same at 2^-20 and 2^20 as at 1 (${r.differ} of ${r.n} differ)`,
  );
  ok(
    farTotal > 2000 && r.wrong === 0,
    `(b) ${farTotal} of them more than 1.5 px from the outline match the winding number at all three scales (${r.wrong} wrong)`,
  );
}

// ---- mutations --------------------------------------------------------------------------------
// The split pairs first; the pixel sweep runs only for a mutant they do not catch.
for (const [name, mod] of MUTANTS) {
  let d = 0;
  const reference = SHIPPED.cubicSplits;
  let s = 0x77;
  for (let i = 0; i < 20000 && typeof mod.cubicSplits === 'function'; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    const qa = ((s & 0xffff) / 65536 - 0.5) * 1e-6,
      qb = ((s >>> 8) & 0xffff) / 65536 - 0.5,
      qc = (((s >>> 4) & 0xffff) / 65536 - 0.5) * 0.3;
    const a = reference(qa, qb, qc),
      b = mod.cubicSplits(qa, qb, qc);
    if (a[0] !== b[0] || a[1] !== b[1]) d++;
  }
  const r = d > 0 ? null : sweep(mod);
  ok(
    d > 0 || r.differ > 0 || r.wrong > 0,
    d > 0
      ? `mutation "${name}" is caught: ${d} split pairs differ from the production CPU implementation`
      : `mutation "${name}" is caught: ${r.differ} pixels off scale 1, ${r.wrong} far pixels wrong`,
  );
}

if (fail) {
  console.error(`BANDWINDING-CUBIC-SPLIT FAIL (${fail})`);
  process.exit(1);
}
console.log('BANDWINDING-CUBIC-SPLIT PASS');
