// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// hitFillDefaultAaSmoke — the fill hit test's coverage is the coverage a DEFAULT renderer draws.
//
// A default renderer's fill kernel is the exact box coverage: renderFill -- Slug's entry, every default
// program's -- answers with AAC's walk, the pixel's exact signed area folded through the fill rule. fillHitShape(Coverage)
// hits where that coverage reaches the edge midline, and reads it as boxCoverage (hitTest/fillCoverage.js, f64) from the
// bundle's own decoded curve data, not from Slug's two-ray estimate (bandWinding.js), which models a kernel no default
// renderer draws.
//
// (a) the default kernel is the exact walk: renderFill and renderFillM answer with AAC's (renderFillAAC, renderFillAACM
//     in a rotated-map program), and no renderer option defines MANTLE_EXACT_EDGE (exactEdgeAa is accepted and ignored);
// (b) seeded pairs of overlapping, same-wound convex polygons, every pixel center with one edge within 1.5 px, at 2^-20,
//     1 and 2^20, both fill rules, against the exact box coverage by polygon clipping:
//       - boxCoverage is that coverage to 1e-5 at every probe (the float32 curve data's floor: the polygons are stored
//         rounded to 2^-24 of their size): outer edges, interior edges between winding 1 and 2 (solid under nonzero,
//         a partial under even-odd);
//       - the shader's default kernel (the shipped text in float32, test/_glslEmu.mjs) is it to 1e-5 at every probe;
// (c) fillHitShape(Coverage) hits exactly where boxCoverage >= 0.5 -- and on a spike thinner than a pixel that is NOT
//     where the pixel center is inside;
// (d) every probe reads the same at 2^-20 and 2^20 as at 1: the coordinates scale by a power of 2.
// Mutations, each required to FAIL: the fill rule dropped from the fold (nonzero for both), a segment left of the cell
// adding nothing (the far field lost).
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, fillShapes, K_SLUG } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const { fillHitShape, HitMode } = await import('../src/hitTest/hitTest.js');
// A query with no worldMatrix is a point query (point-in-fill); the pixel-box coverage this smoke compares against is the
// identity worldMatrix: one bundle unit per pixel.
const ONE_PX = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const { decodeSegs } = await import('../src/hitTest/curveGeom.js');

const t0 = Date.now();
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- the module under test, and mutations of it -------------------------------------------
const SRC = readFileSync(path.join(ROOT, 'src/hitTest/fillCoverage.js'), 'utf8');
const mutate = (pairs) => {
  let s = SRC;
  for (const [from, to] of pairs) {
    ok(s.includes(from), `mutation hinge present: ${from.slice(0, 60)}`);
    s = s.split(from).join(to);
  }
  // the module imports siblings by relative path: point them at the real files
  s = s
    .replace(/from '\.\.\//g, `from '${new URL('../src/', import.meta.url).href}`)
    .replace(/from '\.\//g, `from '${new URL('../src/hitTest/', import.meta.url).href}`);
  return import('data:text/javascript;base64,' + Buffer.from(s).toString('base64'));
};
const SHIPPED = await import('../src/hitTest/fillCoverage.js');
const MUTANTS = [
  [
    'the fill rule dropped from the fold',
    await mutate([['if (evenOdd) { let m = run % 2;', 'if (false) { let m = run % 2;']]),
  ],
  [
    'a segment left of the cell adds nothing',
    await mutate([
      [
        'return Math.min(1, Math.max(0, yb)) - Math.min(1, Math.max(0, ya));\n  }',
        'return 0;\n  }',
      ],
    ]),
  ],
];

// ---- (a) the default kernel -----------------------------------------------------------------
{
  const GL = readFileSync(path.join(ROOT, 'src/shaders/_coverage.glsl'), 'utf8').replace(
    /\/\/[^\n]*/g,
    '',
  );
  const body = (sig) => {
    const i = GL.indexOf(sig);
    return i < 0 ? '' : GL.slice(i, GL.indexOf('\n}\n', i));
  };
  const rf = body('float renderFill(vec2 c, vec2 px, ivec4 GD, bool evenOdd, vec4 shapeBB) {');
  const rfm = body(
    'float renderFillM(vec2 c, vec2 mx, vec2 my, ivec4 GD, bool evenOdd, vec4 shapeBB) {',
  );
  ok(
    /return renderFillAAC\(c, px, GD, evenOdd, shapeBB\);/.test(rf),
    '(a) renderFill answers with the exact walk (renderFillAAC)',
  );
  ok(
    /#ifdef MANTLE_ROTATED_MAP\s*return renderFillAACM\(c, mx, my, GD, evenOdd, shapeBB\);\s*#else\s*return renderFillAAC\(c, vec2\(mx\.x, my\.y\), GD, evenOdd, shapeBB\);\s*#endif/.test(
      rfm,
    ),
    "(a) renderFillM answers with AAC's rotated footprint in a rotated-map program, and the exact walk otherwise",
  );
  const R = readFileSync(path.join(ROOT, 'src/renderer/renderer.js'), 'utf8');
  const defs = [...R.matchAll(/'MANTLE_EXACT_EDGE'/g)].length;
  ok(
    defs === 0 && !/opts\.exactEdgeAa/.test(R),
    `(a) no renderer option defines MANTLE_EXACT_EDGE: exactEdgeAa is accepted and ignored (${defs} site(s))`,
  );
}

// ---- (b) overlapping convex polygons against their exact box coverage ------------------------
let seed = 0x5195;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const poly = (cx, cy, r) => {
  const k = 3 + Math.floor(rnd() * 5),
    a0 = rnd() * Math.PI * 2,
    p = [];
  for (let i = 0; i < k; i++) {
    const a = a0 + ((i + 0.15 + rnd() * 0.7) / k) * Math.PI * 2;
    p.push([+(cx + r * Math.cos(a)).toFixed(3), +(cy + r * Math.sin(a)).toFixed(3)]);
  }
  return p;
};
const area = (p) => {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i],
      b = p[(i + 1) % p.length];
    s += a[0] * b[1] - a[1] * b[0];
  }
  return Math.abs(s) / 2;
};
function clipHalf(p, side) {
  // keep side(v) >= 0 (Sutherland-Hodgman, convex clipper)
  const o = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i],
      b = p[(i + 1) % p.length],
      sa = side(a),
      sb = side(b);
    if (sa >= 0) o.push(a);
    if (sa >= 0 !== sb >= 0) {
      const t = sa / (sa - sb);
      o.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return o;
}
const clipConvex = (p, q) => {
  const sg = Math.sign(
    (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[1][1] - q[0][1]) * (q[2][0] - q[0][0]),
  );
  for (let i = 0; i < q.length && p.length; i++) {
    const a = q[i],
      b = q[(i + 1) % q.length];
    p = clipHalf(p, (v) => sg * ((b[0] - a[0]) * (v[1] - a[1]) - (b[1] - a[1]) * (v[0] - a[0])));
  }
  return p;
};
const boxArea = (p, x, y) => {
  const q = clipConvex(p, [
    [x, y],
    [x + 1, y],
    [x + 1, y + 1],
    [x, y + 1],
  ]);
  return q.length ? area(q) : 0;
};
const segDist = (px, py, a, b) => {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
};
const inConvex = (p, x, y) => {
  let pos = 0,
    neg = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i],
      b = p[(i + 1) % p.length];
    const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (c > 0) pos++;
    else if (c < 0) neg++;
  }
  return !(pos && neg);
};

// Each probe: a pixel with exactly one edge within 1.5 px of its center, its exact coverage under each fill rule.
const CASES = [];
for (let c = 0; c < 40; c++) {
  const r1 = 10 + rnd() * 14,
    cx1 = 32 + (rnd() - 0.5) * 8,
    cy1 = 32 + (rnd() - 0.5) * 8;
  const r2 = 5 + rnd() * 12,
    ang = rnd() * Math.PI * 2,
    off = rnd() * r1;
  const P1 = poly(cx1, cy1, r1),
    P2 = poly(cx1 + off * Math.cos(ang), cy1 + off * Math.sin(ang), r2);
  const I = clipConvex(P1, P2),
    edges = [];
  for (const p of [P1, P2])
    for (let i = 0; i < p.length; i++) edges.push([p, p[i], p[(i + 1) % p.length]]);
  const probes = [];
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const cx = x + 0.5,
        cy = y + 0.5,
        near = edges.filter((e) => segDist(cx, cy, e[1], e[2]) < 1.5);
      if (near.length !== 1) continue;
      const own = near[0],
        interior = inConvex(own[0] === P1 ? P2 : P1, cx, cy);
      const a1 = boxArea(P1, x, y),
        a2 = boxArea(P2, x, y),
        a12 = I.length ? boxArea(I, x, y) : 0;
      probes.push({ x, y, interior, nz: Math.min(1, a1 + a2 - a12), eo: a1 + a2 - 2 * a12 });
    }
  CASES.push({
    d: (S) =>
      [P1, P2]
        .map(
          (p) =>
            'M ' +
            p
              .map((v) => `${+(v[0] * S).toPrecision(17)} ${+(v[1] * S).toPrecision(17)}`)
              .join(' L ') +
            ' Z',
        )
        .join(' '),
    probes,
  });
}
const SCALES = [Math.pow(2, -20), 1, Math.pow(2, 20)];
const bundles = new Map();
for (const S of SCALES)
  for (const evenOdd of [false, true])
    for (let c = 0; c < CASES.length; c++) {
      const raw = await importSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${64 * S} ${64 * S}"><path ${evenOdd ? 'fill-rule="evenodd" ' : ''}d="${CASES[c].d(S)}"/></svg>`,
        { preserveViewport: true },
      );
      const MF = parseMetaBin(raw.meta, raw.metaFloatsPerShape).metaFloats,
        curveF = new Float32Array(raw.curves);
      const [sh] = fillShapes(raw, parseMetaBin, M);
      bundles.set(`${S}:${evenOdd}:${c}`, {
        raw,
        sh,
        band: new Float32Array(raw.bands),
        curveF,
        segs: decodeSegs(curveF, raw.curveRangesByShape[0].begin, raw.curveRangesByShape[0].end),
        bb: [
          MF[M.META_BBOX_XMIN],
          MF[M.META_BBOX_YMIN],
          MF[M.META_BBOX_XMAX],
          MF[M.META_BBOX_YMAX],
        ],
      });
    }
function sweep(mod) {
  const r = { n: 0, outer: 0, corner: 0, nzIn: 0, eoIn: 0, worst: 0, bad: 0, where: [] };
  for (const S of SCALES)
    for (const evenOdd of [false, true])
      for (let c = 0; c < CASES.length; c++) {
        const B = bundles.get(`${S}:${evenOdd}:${c}`);
        for (const p of CASES[c].probes) {
          const truth = evenOdd ? p.eo : p.nz;
          const cov = mod.boxCoverage(B.segs, (p.x + 0.5) * S, (p.y + 0.5) * S, S, S, evenOdd);
          const e = Math.abs(cov - truth);
          r.n++;
          r.worst = Math.max(r.worst, e);
          if (!p.interior) r.outer++;
          else if (evenOdd) r.eoIn++;
          else r.nzIn++;
          if (e > 1e-5) {
            r.bad++;
            if (r.where.length < 3)
              r.where.push(
                `case ${c} ${evenOdd ? 'eo' : 'nz'} 2^${Math.log2(S)} px ${p.x},${p.y} cov ${cov.toFixed(6)} truth ${truth.toFixed(6)}`,
              );
          }
        }
      }
  return r;
}
{
  const r = sweep(SHIPPED);
  ok(
    r.n > 50000 && r.outer > 10000 && r.nzIn > 1000 && r.eoIn > 1000 && r.bad === 0,
    `(b) boxCoverage is the exact box coverage to 1e-5 at all ${r.n} probes -- ${r.outer} on outer edges, ${r.nzIn} on nonzero interior edges, ${r.eoIn} on even-odd ones (worst ${r.worst.toExponential(1)})`,
  );
  if (r.where.length) console.log('     ', r.where.join('; '));
}
if (hasCxx()) {
  // the default program's kernel: no MANTLE_AAC, the stripe walk (no pair define), as a base program draws it
  const emu = buildGlslEmu(ROOT, { defines: [] });
  let n = 0,
    worst = 0,
    at = '';
  for (const S of SCALES)
    for (const evenOdd of [false, true])
      for (let c = 0; c < CASES.length; c++) {
        const B = bundles.get(`${S}:${evenOdd}:${c}`),
          qs = CASES[c].probes;
        const got = emu.run(
          B.band,
          B.curveF,
          qs.map((p) => ({
            k: K_SLUG,
            GD: B.sh.GD,
            bb: B.sh.bb,
            eo: evenOdd,
            c: [(p.x + 0.5) * S, (p.y + 0.5) * S],
            ePx: [S, S],
          })),
        );
        qs.forEach((p, i) => {
          n++;
          const e = Math.abs(got[i] - (evenOdd ? p.eo : p.nz));
          if (e > worst) {
            worst = e;
            at = `case ${c} ${evenOdd ? 'eo' : 'nz'} 2^${Math.log2(S)} px ${p.x},${p.y}`;
          }
        });
      }
  ok(
    n > 50000 && worst < 1e-5,
    `(b) the shader's default kernel is that coverage to 1e-5 at all ${n} probes (worst ${worst.toExponential(1)}${at ? ` at ${at}` : ''})`,
  );
} else console.log('  SKIPPED the shader half of (b): no C++ compiler ($CXX, clang++, g++, c++)');

// ---- (c) the consumer ---------------------------------------------------------------------
{
  let n = 0,
    differ = 0;
  for (const evenOdd of [false, true])
    for (let c = 0; c < CASES.length; c++) {
      const B = bundles.get(`1:${evenOdd}:${c}`);
      for (const p of CASES[c].probes) {
        const cov = SHIPPED.boxCoverage(B.segs, p.x + 0.5, p.y + 0.5, 1, 1, evenOdd);
        n++;
        if (
          (fillHitShape(B.raw, p.x + 0.5, p.y + 0.5, {
            mode: HitMode.Coverage,
            worldMatrix: ONE_PX,
          }) ===
            0) !==
          cov >= 0.5
        )
          differ++;
      }
    }
  ok(
    n > 10000 && differ === 0,
    `(c) fillHitShape(Coverage) hits exactly where boxCoverage >= 0.5 (${differ} of ${n} differ)`,
  );
  // a spike 0.6 px tall at its base: pixel centers inside it cover under half their pixel
  const raw = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 20"><path d="M 4 10.2 L 60 10.5 L 4 10.8 Z"/></svg>',
    { preserveViewport: true },
  );
  const segs = decodeSegs(
    new Float32Array(raw.curves),
    raw.curveRangesByShape[0].begin,
    raw.curveRangesByShape[0].end,
  );
  let m = 0,
    md = 0,
    centre = 0;
  for (let y = 8; y < 12; y++)
    for (let x = 0; x < 64; x++) {
      const cov = SHIPPED.boxCoverage(segs, x + 0.5, y + 0.5, 1, 1, false);
      m++;
      if (
        (fillHitShape(raw, x + 0.5, y + 0.5, { mode: HitMode.Coverage, worldMatrix: ONE_PX }) ===
          0) !==
        cov >= 0.5
      )
        md++;
      if (SHIPPED.pointInFill(segs, x + 0.5, y + 0.5, false) !== cov >= 0.5) centre++;
    }
  ok(
    md === 0 && centre > 0,
    `(c) ...and on a sub-pixel spike, where ${centre} of ${m} pixels hold the center but under half the area (${md} differ)`,
  );
}

// ---- (d) coordinate scale ------------------------------------------------------------------
{
  let n = 0,
    differ = 0;
  for (const S of SCALES)
    for (const evenOdd of [false, true])
      for (let c = 0; c < CASES.length; c++) {
        if (S === 1) continue;
        const B = bundles.get(`${S}:${evenOdd}:${c}`),
          B1 = bundles.get(`1:${evenOdd}:${c}`);
        for (const p of CASES[c].probes) {
          n++;
          if (
            SHIPPED.boxCoverage(B.segs, (p.x + 0.5) * S, (p.y + 0.5) * S, S, S, evenOdd) !==
            SHIPPED.boxCoverage(B1.segs, p.x + 0.5, p.y + 0.5, 1, 1, evenOdd)
          )
            differ++;
        }
      }
  ok(
    n > 50000 && differ === 0,
    `(d) every probe reads the same at 2^-20 and 2^20 as at 1 (${differ} of ${n} differ)`,
  );
}

// ---- mutations ----------------------------------------------------------------------------
for (const [name, mod] of MUTANTS) {
  const r = sweep(mod);
  ok(
    r.bad > 0,
    `mutation "${name}" is caught: ${r.bad} of ${r.n} probes off the exact coverage (worst ${r.worst.toFixed(3)})`,
  );
}

if (fail) {
  console.error(`HIT-FILL-DEFAULT-AA FAIL (${fail})`);
  process.exit(1);
}
console.log(`HIT-FILL-DEFAULT-AA PASS (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
