// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gwnCrossPrimFloorScaleSmoke — two GWN/AAC tests that must carry no ABSOLUTE FLOOR.
//
// (1) `gwnCross` decides a ray crossing from the SIGNS of `t`, a cross product (em^2), and `dy`, a length (em),
//     never from `t * dy > 0.0`. That product is em^3, so it leaves float32's NORMAL range at an em scale of about
//     (2^-126)^(1/3) = 2.3e-13 and leaves the denormals entirely near 1.1e-15 -- and a GPU FLUSHES a denormal
//     to zero, so on real hardware the test reads `0.0 > 0.0` and the crossing is not counted at all. That is
//     not a rounded edge: a contour's winding is wrong, so a filled shape vanishes or inverts. Only the signs
//     of the two factors are wanted, and `dy` is never zero where the product would be formed, so the sign
//     comparison is bit-identical everywhere the product survives and correct everywhere it does not.
//
// (2) `mantle.frag`'s `squareBB` -- which decides whether the circle and annulus fast paths may run, by asking
//     whether the baked bbox is square -- compares against `max(w, h)`. In `abs(w - h) <= 1e-3 * max(w, 1e-6)` the
//     `1e-6` would be an absolute em length inside a test that is otherwise a pure ratio, so at a small enough
//     drawing size the bar is the whole shape and every ellipse reads square: a non-uniformly scaled circle takes
//     the circle fast path and is drawn as a circle. Against `max(w, h)` both sides scale by exactly S and the
//     decision cannot move.
//
// Through the float32 emulation of the SHIPPED shader text (test/_glslEmu.mjs) for (1), and through the
// shipped `squareBB` line itself, extracted verbatim, for (2).
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import {
  hasCxx,
  buildGlslEmu,
  fillShapes,
  scaleFillData,
  gwnWithoutExits,
  K_GWN,
  GWN_SDF,
  GWN_WIND,
} from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP gwnCrossPrimFloorScaleSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
  process.exit(0);
}

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');

// ---- (2) squareBB: the shipped line, evaluated ------------------------------------------------------------
// Extracted rather than restated, so a shader edit that puts an absolute length back is caught here and not
// only on a GPU. The expression is `abs`, `max`, subtraction, a multiply and a compare; float64 decides every
// case in the grid below identically to float32, whose nearest boundary is three orders away.
function squareBBFn(src) {
  const m = src.match(/bool\s+squareBB\s*=([\s\S]*?);/);
  if (!m) return null;
  const js = m[1]
    .replace(/vShapeBBox\.x/g, 'B[0]')
    .replace(/vShapeBBox\.y/g, 'B[1]')
    .replace(/vShapeBBox\.z/g, 'B[2]')
    .replace(/vShapeBBox\.w/g, 'B[3]')
    .replace(/\babs\s*\(/g, 'Math.abs(')
    .replace(/\bmax\s*\(/g, 'Math.max(');
  if (/[^\s\w.,()[\]*\/+\-<=>]/.test(js.replace(/\d+e-?\d+/g, '0'))) return null; // only the operators we mapped
  return { fn: new Function('B', `return !!(${js});`), text: m[1].replace(/\s+/g, ' ').trim() };
}
{
  const cur = squareBBFn(GLSL);
  ok(!!cur, `squareBB extracted from the shipped shader: ${cur ? cur.text : 'NOT FOUND'}`);
  if (cur) {
    // A circle, and ellipses whose aspect misses square by 0.2%, 1%, 10% and 2:1. A unit-extent box at the
    // origin, then the same box scaled by 2^e -- the drawing authored (or transformed) larger or smaller.
    const ASPECT = [
      ['circle', 1],
      ['0.2% off', 1.002],
      ['1% off', 1.01],
      ['10% off', 1.1],
      ['2:1', 2],
    ];
    const EXPS = [-30, -24, -20, -12, -6, 0, 6, 12, 20, 24, 30];
    const verdicts = (fn) =>
      ASPECT.map(([, r]) =>
        EXPS.map((e) => {
          const S = Math.pow(2, e);
          return fn([0, 0, S, r * S]) ? 1 : 0;
        }),
      );
    const moved = (v) =>
      v.reduce((n, row) => n + row.filter((x) => x !== row[EXPS.indexOf(0)]).length, 0);
    const vs = verdicts(cur.fn);
    ok(
      moved(vs) === 0,
      `squareBB decides the same at 2^-30..2^30 for every aspect (${ASPECT.map(([n], i) => `${n}:${vs[i].join('')}`).join('  ')})`,
    );
    // ...and it decides them RIGHT at scale 1: only the true circle is square.
    const at1 = ASPECT.map(([, r]) => cur.fn([0, 0, 1, r]));
    ok(
      at1[0] === true && at1.slice(1).every((v) => v === false),
      `scale 1: square only for the circle (${ASPECT.map(([n], i) => `${n}=${at1[i]}`).join(', ')})`,
    );
    // The mutation: the floor this item removed.
    const OLDBAR = 'max(vShapeBBox.z - vShapeBBox.x, vShapeBBox.w - vShapeBBox.y)';
    const NEWBAR = 'max(vShapeBBox.z - vShapeBBox.x, 1e-6)';
    ok(GLSL.includes(OLDBAR), 'squareBB mutation hinge present');
    const mut = squareBBFn(GLSL.split(OLDBAR).join(NEWBAR));
    const mv = mut ? verdicts(mut.fn) : null;
    ok(
      mv && moved(mv) > 0,
      `mutation "the square-bbox bar floors the side at 1e-6 em" is caught: ${mv ? mv.map((row, i) => `${ASPECT[i][0]}:${row.join('')}`).join('  ') : 'NOT BUILT'}`,
    );
  }
}

// ---- (2b) the hit test's twin of the same gate --------------------------------------------------------------
// `pointInPrim` returns -1 ("not a fast prim here, walk the outline") for a bbox that is not square. It carried
// the same absolute floor, so the hit test and the renderer disagreed about the same shape at the same size.
{
  const { pointInPrim } = await import('../src/hitTest/fillCoverage.js');
  const meta = new Float32Array(64);
  const verdict = (e, aspect) => {
    const S = Math.pow(2, e);
    meta[0] = 0;
    meta[1] = 0;
    meta[2] = S;
    meta[3] = aspect * S; // bbox
    meta[44] = 1; // primKind = circle
    // A point in the corner of the box: inside the 2:1 ellipse's bbox, outside a circle of the short radius.
    return pointInPrim(meta, 0, 0.94 * S, 0.5 * aspect * S);
  };
  const EXPS = [-30, -24, -20, -12, -6, 0, 6, 12, 20];
  for (const [name, aspect] of [
    ['circle', 1],
    ['2:1', 2],
  ]) {
    const v = EXPS.map((e) => verdict(e, aspect));
    ok(
      v.every((x) => x === v[EXPS.indexOf(0)]),
      `pointInPrim answers the same at 2^-30..2^20 for a ${name} bbox (${v.join(',')})`,
    );
  }
}

// ---- (1) gwnCross: the shipped kernel, at scale ------------------------------------------------------------
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');

// Lines, a curved quad, a serpentine cubic (type-4), a loop cubic (type-6) and a circle (type-5): every piece
// type whose chord crossing goes through gwnCross.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 220">
  <path d="M10.3 10.7 L 90.1 18.2 L 70.4 95.6 L 30.2 60.9 Z"/>
  <path d="M110.2 90.4 Q 150.7 -5.3 190.1 90.8 Q 150.3 60.2 110.2 90.4 Z"/>
  <path d="M210.4 20.3 C 290.2 20.1 220.6 100.7 300.3 99.2 L 300.3 110.1 L 210.4 110.1 Z"/>
  <path d="M320.1 20.2 C 420.6 120.4 300.2 120.8 400.3 20.6 Z"/>
  <path d="M60.3 160.2 m -45.1 0 a 45.1 45.1 0 1 0 90.2 0 a 45.1 45.1 0 1 0 -90.2 0 Z"/>
</svg>`;
const b = await importSvg(SVG, { preserveViewport: true, gwnTree: true });
const shapes = fillShapes(b, parseMetaBin, M);
const band = new Float32Array(b.bands),
  curve = new Float32Array(b.curves);
const qs = [];
for (const sh of shapes)
  for (let y = Math.floor(sh.bb[1]) - 2; y <= Math.ceil(sh.bb[3]) + 2; y++)
    for (let x = Math.floor(sh.bb[0]) - 2; x <= Math.ceil(sh.bb[2]) + 2; x++)
      qs.push({ GD: sh.GD, bb: sh.bb, eo: sh.eo, c: [x + 0.5, y + 0.5], ePx: [1, 1] });
{
  const types = new Set();
  for (const sh of shapes) {
    const g = sh.GD[1] * 4096 + sh.GD[0],
      h = (g + (sh.GD[2] + sh.GD[3] + 2) * 2) * 4;
    const refBase = band[h + 2] | 0,
      refCount = band[h + 3] | 0;
    for (let i = 0; i < refCount; i++)
      types.add(((band[(g + refBase + i) * 4 + 2] + 0.5) | 0) % 16);
  }
  ok(
    shapes.length === 5 &&
      shapes.every((s) => s.tree) &&
      [0, 1, 4, 5, 6].every((t) => types.has(t)),
    `five shapes with run trees; piece types ${[...types].sort().join(', ')} (need 0, 1, 4, 5, 6); ${qs.length} pixel centers`,
  );
}

// The early exits (grid and band tiers) divide by the shape's bbox and carry floors guarded elsewhere
// (gwnKernelScaleSmoke), so the crossing itself is read with them taken out.
function differing(glsl, defines, logs) {
  const emu = buildGlslEmu(ROOT, { defines, glsl });
  const base = emu.run(
    band,
    curve,
    qs.map((q) => ({ ...q, k: K_GWN })),
  );
  const out = [];
  for (const lg of logs) {
    const S = Math.pow(2, lg),
      sc = scaleFillData(band, curve, shapes, S);
    const r = emu.run(
      sc.band,
      sc.curve,
      qs.map((q) => ({
        ...q,
        k: K_GWN,
        bb: q.bb.map((v) => Math.fround(v * S)),
        c: [Math.fround(q.c[0] * S), Math.fround(q.c[1] * S)],
        ePx: [S, S],
      })),
    );
    let n = 0;
    r.forEach((v, i) => {
      if (v !== base[i]) n++;
    });
    out.push(n);
  }
  return out;
}

const HINGE = 'return dy < 0.0 ? (t < 0.0 ? -1.0 : 0.0) : (t > 0.0 ? 1.0 : 0.0);';
const AS_PRODUCT = 'return (t * dy > 0.0) ? sign(dy) : 0.0;';
// C++ keeps denormals and a GPU does not, so the product form measured here is KINDER than the hardware's by
// about four binades. This models the flush, and is the reading that applies to a real draw.
const AS_PRODUCT_FTZ =
  'float p = t * dy; return ((p < 0.0 ? -p : p) < 1.17549435e-38 ? 0.0 : p) > 0.0 ? sign(dy) : 0.0;';

const DEEP = [-40, -48, -56, -60];
ok(GLSL.includes(HINGE), 'gwnCross mutation hinge present');
{
  const w = differing(gwnWithoutExits(GLSL), GWN_WIND, DEEP);
  const s = differing(gwnWithoutExits(GLSL), GWN_SDF, DEEP);
  ok(
    w.every((n) => n === 0) && s.every((n) => n === 0),
    `the sign form reads every pixel as at scale 1 at 2^-40, 2^-48, 2^-56, 2^-60 (differing: winding ${w.join('/')}, SDF ${s.join('/')})`,
  );
}
for (const [name, to, exps] of [
  ['the crossing multiplies t by dy', AS_PRODUCT, DEEP],
  ['...and the GPU flushes the denormal product to zero', AS_PRODUCT_FTZ, [-40, -44, -48]],
]) {
  const src = GLSL.split(HINGE).join(to);
  const w = differing(gwnWithoutExits(src), GWN_WIND, exps);
  const s = differing(gwnWithoutExits(src), GWN_SDF, exps);
  ok(
    w.some((n) => n > 0) || s.some((n) => n > 0),
    `mutation "${name}" is caught at 2^${exps.join(', 2^')}: winding ${w.join('/')}, SDF ${s.join('/')}`,
  );
}

if (fail) {
  console.error(`GWN-CROSS-PRIM-FLOOR FAIL (${fail})`);
  process.exit(1);
}
console.log('GWN-CROSS-PRIM-FLOOR PASS');
