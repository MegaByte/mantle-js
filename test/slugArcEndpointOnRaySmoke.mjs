// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// slugArcEndpointOnRaySmoke — an arc endpoint that lies ON a scanline, horizontal or vertical, is decided by the
// line walker's convention, never by the arc's own root solve (_coverage.glsl's hardCrossArc through arcRayCrossings,
// and the ray walk in src/hitTest/bandWinding.js; the default kernel answers a pixel with AAC's integral and counts no ray).
//
// THE HAZARD. The line walker counts a centered y of exactly 0 as non-negative — the same as
// counting crossings of a ray a hair toward y < 0. An arc walker that solves y(θ) = c.y lands the
// root at an endpoint on the ray just inside or just outside the θ span by rounding alone. Outside,
// the touch reads as a crossing (a one-row slit); inside is the MAJORITY, and there the root and the
// neighbor both count the touch. A HEADING rule inside a window (1e-5 of |center| + |rx| + |ry|),
// counting an endpoint in it by where the arc goes next and dropping the root it owns, is wrong for
// an endpoint strictly off the ray inside the window, so every walker
// COUNTS from the endpoint SIDES: the arc is split at its stationary angles into monotone pieces,
// a piece whose ends straddle the ray is exactly one crossing, signed by the end the PATH reaches
// last, and the solve only places it. The ends are the record's STORED vertices, the floats the
// neighboring segments store, so the arc and its neighbor decide a vertex by one number: there is no
// snap (ends rebuilt from the angles would need one, within a float32 ulp of the ray).
//
// Every fixture below runs twice: as authored, on the H ray, and TRANSPOSED (x and y swapped, the
// ellipse's rotation reflected, the sweep flipped), which puts the same situation on the V ray.
//
// (a) the two notch fixtures — the arc arriving at the touched apex (the first slit) and
//     leaving it (the mirror slit) — read the touched row (and, transposed, column) equal to its
//     neighbors, both fill rules, at 2^-20, 1 and 2^20;
// (b) a seeded sweep of closed line+arc contours with vertices on exact rows: every pixel more than
//     1.5 px from the outline on a row through an arc endpoint (a column, transposed) matches an
//     independent winding number (angle sum over a fine flattening of the decoded segments), at
//     2^-20, 1 and 2^20;
// (c) the stored ends touch only those lines: one 0.01 px or 0.37 px away is bit-identical to
//     the walk with the ends rebuilt from the angles;
// (d) the shader's ray counter (band-hard's hardCrossArc) counts through arcRayCrossings, as the port does.
// Mutations, each built by rewriting the real module and each required to FAIL (a) or (b):
// the path direction dropped from the crossing's sign, the monotone split removed, the ends
// rebuilt from the angles, and the V ray reading the H ray's sign convention.
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
const DIR = 'return [(dir > 0 ? bNeg : aNeg) ? 2 : 1, Math.min(tb, Math.max(ta, t))];';
const SPLIT = 'const in0 = e0 > lo && e0 < hi,\n    in1 = e1 > lo && e1 < hi;';
const ENDS = 'const pLo = dir > 0 ? pS : pE,\n        pHi = dir > 0 ? pE : pS;';
const VSIGN = 'const sgn = horiz ? (endNeg ? 1 : -1) : endNeg ? -1 : 1;';
const mutate = (pairs) => {
  let s = SRC;
  for (const [from, to] of pairs) {
    const hit = from instanceof RegExp ? from.test(s) : s.includes(from);
    ok(hit, `mutation hinge present: ${String(from).slice(0, 48)}`);
    s = s.replace(from, to);
  }
  return import('data:text/javascript;base64,' + Buffer.from(s).toString('base64'));
};
const SHIPPED = await import('../src/hitTest/bandWinding.js');
const MUTANTS = [
  [
    'path direction dropped from the sign',
    await mutate([[DIR, DIR.replace('(dir > 0 ? bNeg : aNeg)', 'bNeg')]]),
  ],
  [
    'monotone split removed (the ends of the whole sweep decide)',
    await mutate([[SPLIT, 'const in0 = false, in1 = false;']]),
  ],
  [
    'the ends rebuilt from the angles (the stored vertices ignored)',
    await mutate([[ENDS, 'const pLo = at(lo), pHi = at(hi);']]),
  ],
  [
    "the V ray reads the H ray's sign convention",
    await mutate([[VSIGN, 'const sgn = endNeg ? 1 : -1;']]),
  ],
];
const OFF = MUTANTS[2][1]; // the walk with the ends rebuilt from the angles

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
const n = (v, S) => +(v * S).toPrecision(17);
// A path as parts: ['M'|'L', x, y] or ['A', rx, ry, rotation, large, sweep, x, y]. TRANSPOSED swaps x and y, which
// reflects the ellipse (rotation 90 - r) and reverses its turning (sweep flipped).
function pathOf(parts, S, transposed) {
  return (
    parts
      .map((p) => {
        if (p[0] === 'A') {
          const [, rx, ry, rot, large, sweep, x, y] = p;
          return transposed
            ? `A ${n(rx, S)} ${n(ry, S)} ${90 - rot} ${large} ${1 - sweep} ${n(y, S)} ${n(x, S)}`
            : `A ${n(rx, S)} ${n(ry, S)} ${rot} ${large} ${sweep} ${n(x, S)} ${n(y, S)}`;
        }
        return transposed
          ? `${p[0]} ${n(p[2], S)} ${n(p[1], S)}`
          : `${p[0]} ${n(p[1], S)} ${n(p[2], S)}`;
      })
      .join(' ') + ' Z'
  );
}
const AXES = [
  ['H', false],
  ['V', true],
];
// probe (u, v) as (x, y) on the H ray, or (v, u) transposed: u runs along the ray, v across it
const probe = (mod, B, u, v, S, pp, evenOdd, transposed) =>
  transposed
    ? mod.bandFillCoverage(B.bandF, B.curveF, B.gd, B.bb, v * S, u * S, pp, pp, evenOdd)
    : mod.bandFillCoverage(B.bandF, B.curveF, B.gd, B.bb, u * S, v * S, pp, pp, evenOdd);

// ---- (a) the notch fixtures ------------------------------------------------------------------
// A box with a notch in its top edge whose apex (50,50) sits on a row. ARRIVES: the arc comes down
// to the apex and a line leaves it. LEAVES: a line comes down and the arc leaves it. A scanline at
// y = 50 touches the apex; the pixels left of it are solid. Transposed, the notch is in the left
// edge and a column at x = 50 touches it.
const NOTCH = {
  arrives: [
    ['M', 10, 10],
    ['L', 35, 10],
    ['A', 30, 30, 0, 0, 0, 50, 50],
    ['L', 60, 10],
    ['L', 90, 10],
    ['L', 90, 90],
    ['L', 10, 90],
  ],
  leaves: [
    ['M', 10, 10],
    ['L', 40, 10],
    ['L', 50, 50],
    ['A', 30, 30, 0, 0, 1, 60, 10],
    ['L', 90, 10],
    ['L', 90, 90],
    ['L', 10, 90],
  ],
};
const XS = [15, 20, 30, 40, 45];
const SCALES = [Math.pow(2, -20), 1, Math.pow(2, 20)];
const notchCache = new Map();
async function notchLines(mod, name, S, evenOdd, transposed) {
  const key = `${name}:${S}:${evenOdd}:${transposed}`;
  if (!notchCache.has(key)) {
    const svg = svgOf(pathOf(NOTCH[name], S, transposed), (S * 100) / 64, evenOdd);
    notchCache.set(key, bundleOf(await importSvg(svg, { preserveViewport: true })));
  }
  const B = notchCache.get(key),
    pp = 5.12 / S;
  const at = (v) =>
    XS.map((u) => probe(mod, B, u, v, S, pp, evenOdd, transposed).toFixed(3)).join(' ');
  return { before: at(49), touch: at(50), after: at(51) };
}
async function notchBad(mod) {
  const bad = { H: [], V: [] };
  for (const [axis, transposed] of AXES)
    for (const name of Object.keys(NOTCH))
      for (const evenOdd of [false, true])
        for (const S of SCALES) {
          const r = await notchLines(mod, name, S, evenOdd, transposed);
          if (r.touch !== r.before || r.touch !== r.after)
            bad[axis].push(
              `${name}/${evenOdd ? 'eo' : 'nz'}/2^${Math.round(Math.log2(S))}: touch ${r.touch} vs ${r.before}`,
            );
        }
  return bad;
}
{
  const bad = await notchBad(SHIPPED);
  ok(
    bad.H.length === 0,
    `(a) H: both notches keep the touched row at every scale and fill rule (${bad.H.length ? bad.H.join('; ') : '12 of 12'})`,
  );
  ok(
    bad.V.length === 0,
    `(a) V: both transposed notches keep the touched column at every scale and fill rule (${bad.V.length ? bad.V.join('; ') : '12 of 12'})`,
  );
}

// ---- (b) seeded sweep against an independent winding number ---------------------------------
let seed = 0x5eed6;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
function contour() {
  const k = ri(3, 7),
    pts = [];
  for (let i = 0; i < k; i++) {
    const a = ((i + rnd() * 0.6) / k) * Math.PI * 2,
      r = 10 + rnd() * 18;
    pts.push([Math.round(32 + r * Math.cos(a)), Math.round(32 + r * Math.sin(a))]);
  }
  for (let i = 0; i < k; i++) if (rnd() < 0.3) pts[i][1] = pts[(i + 1) % k][1]; // rows through several vertices
  const parts = [['M', pts[0][0], pts[0][1]]];
  for (let i = 1; i <= k; i++) {
    const [x, y] = pts[i % k],
      [px, py] = pts[i - 1];
    if (Math.hypot(x - px, y - py) < 1) continue;
    if (rnd() < 0.7) {
      const rad = Math.max(1, Math.round((Math.hypot(x - px, y - py) / 2) * (1 + rnd() * 2)));
      parts.push([
        'A',
        rad,
        rnd() < 0.5 ? rad : Math.max(1, Math.round(rad * (0.5 + rnd()))),
        rnd() < 0.5 ? 0 : ri(0, 170),
        ri(0, 1),
        ri(0, 1),
        x,
        y,
      ]);
    } else parts.push(['L', x, y]);
  }
  return parts;
}
const SWEEP_SCALES = [Math.pow(2, -20), 1, Math.pow(2, 20)];
const cases = [];
const linesTotal = { H: 0, V: 0 },
  farTotal = { H: 0, V: 0 };
for (let i = 0; i < 40; i++) {
  const parts = contour();
  for (const [axis, transposed] of AXES)
    for (const evenOdd of [false, true]) {
      const b1 = await importSvg(svgOf(pathOf(parts, 1, transposed), 1, evenOdd), {
        preserveViewport: true,
      });
      const B1 = bundleOf(b1),
        rg = b1.curveRangesByShape[0];
      const segs = decodeSegs(B1.curveF, rg.begin, rg.end);
      const ref = windingReference(segs, { pieces: 400 });
      // the lines through an arc endpoint that cross the ray: rows for H, columns for V (v is that coordinate)
      const lines = [
        ...new Set(
          segs
            .filter((s) => s.t === 3)
            .flatMap((s) =>
              transposed
                ? [Math.round(s.x0), Math.round(s.x1)]
                : [Math.round(s.y0), Math.round(s.y1)],
            ),
        ),
      ];
      linesTotal[axis] += lines.length;
      const pix = [];
      for (const v of lines)
        for (let ui = 0; ui <= 64; ui++) {
          const u = ui + 0.5,
            x = transposed ? v : u,
            y = transposed ? u : v;
          const wn = ref(x, y);
          if (wn === null) continue;
          pix.push({ u, v, want: (evenOdd ? (wn & 1) === 1 : wn !== 0) ? 1 : 0 });
        }
      farTotal[axis] += pix.length;
      const bundles = [[1, B1]];
      for (const S of SWEEP_SCALES)
        if (S !== 1)
          bundles.push([
            S,
            bundleOf(
              await importSvg(svgOf(pathOf(parts, S, transposed), S, evenOdd), {
                preserveViewport: true,
              }),
            ),
          ]);
      cases.push({ axis, transposed, evenOdd, lines, pix, bundles });
    }
}
function sweepWrong(mod) {
  const wrong = { H: 0, V: 0 };
  for (const c of cases)
    for (const [S, B] of c.bundles)
      for (const p of c.pix) {
        const v = probe(mod, B, p.u, p.v, S, 1 / S, c.evenOdd, c.transposed);
        if (Math.abs(v - p.want) > 1e-9) wrong[c.axis]++;
      }
  return wrong;
}
{
  const wrong = sweepWrong(SHIPPED),
    off = sweepWrong(OFF);
  for (const [axis] of AXES) {
    const what = axis === 'H' ? 'rows' : 'columns';
    ok(
      farTotal[axis] > 10000,
      `(b) ${axis}: the sweep is not vacuous: ${cases.length / 2} contour/fill-rule cases, ${linesTotal[axis]} ${what} through an arc endpoint, ${farTotal[axis]} pixels with an exact answer per scale`,
    );
    ok(
      wrong[axis] === 0,
      `(b) ${axis}: every one matches the independent winding number at 2^-20, 1 and 2^20 (${wrong[axis]} wrong; ${off[axis]} wrong with the ends rebuilt)`,
    );
  }
}
// (b) runs at 2^-20 as well, so a line walker that skips a line whose rise is under an absolute
// 1/65536 em (at that scale every line under 16 units tall) fails here.

// ---- (c) no other line moves ----------------------------------------------------------------
{
  let moved = 0,
    n2 = 0;
  for (const c of cases) {
    const B = c.bundles[0][1];
    for (const v0 of c.lines)
      for (const dv of [-0.01, 0.01, 0.37])
        for (let ui = 0; ui <= 64; ui += 2) {
          n2++;
          if (
            probe(SHIPPED, B, ui + 0.5, v0 + dv, 1, 1, c.evenOdd, c.transposed) !==
            probe(OFF, B, ui + 0.5, v0 + dv, 1, 1, c.evenOdd, c.transposed)
          )
            moved++;
        }
  }
  ok(
    moved === 0,
    `(c) rows and columns 0.01 px and 0.37 px off a vertex are bit-identical to the walk with the ends rebuilt (${moved} of ${n2} differ)`,
  );
}

// ---- mutations --------------------------------------------------------------------------------
for (const [name, mod] of MUTANTS) {
  const bad = await notchBad(mod),
    wrong = sweepWrong(mod);
  ok(
    bad.H.length + bad.V.length > 0 || wrong.H + wrong.V > 0,
    `mutation "${name}" is caught: notch lines lost H ${bad.H.length} / V ${bad.V.length}, sweep pixels wrong H ${wrong.H} / V ${wrong.V}`,
  );
}

// ---- (d) the shader sites ---------------------------------------------------------------------
{
  const gl = readFileSync(path.join(ROOT, 'src/shaders/_coverage.glsl'), 'utf8');
  const code = (t) => t.replace(/\/\/[^\n]*/g, ''); // the CODE; comments may still name the heading rule
  const slice = (from, to) => {
    const i = gl.indexOf(from);
    return code(gl.slice(i, gl.indexOf(to, i)));
  };
  const hard = slice('float hardCrossArc(', '\n}\n');
  const rule = slice('vec3 arcRayCrossings(', '\n}\n');
  const piece = slice('float arcPieceCross(', '\n}\n');
  // THE RULE, once: the end-side test on each monotone piece, the sign from the end the PATH reaches last.
  ok(
    /bool aNeg = ua < 0\.0, bNeg = ub < 0\.0;/.test(piece) &&
      /if \(aNeg == bNeg\) return 0\.0;/.test(piece),
    "(d) arcPieceCross: the crossing COUNT is the line walker's end-side test on each monotone piece",
  );
  ok(
    /bool in0 = e0 > lo && e0 < hi, in1 = e1 > lo && e1 < hi;/.test(rule) &&
      /arcPieceCross\(lo, uLo, t1, u1, dir\),\s*arcPieceCross\(t1, u1, t2, u2, dir\),\s*arcPieceCross\(t2, u2, hi, uHi, dir\)/.test(
        rule,
      ),
    '(d) arcRayCrossings: the sweep is split at the stationary angles inside it, into three fixed pieces',
  );
  ok(
    /return \(\(dir > 0\.0\) \? bNeg : aNeg\) \? 2\.0 : 1\.0;/.test(piece),
    '(d) arcPieceCross: the sign is the side of the end the path reaches last, so a reversed sweep counts the same way',
  );
  ok(
    !/\[(n|m|i|i \+ 1)\]/.test(rule + piece),
    '(d) arcRayCrossings: no dynamically indexed array (every slot a caller reads is a constant once unrolled)',
  );
  ok(
    !/eUlp|arcRayUlp\(/.test(rule) &&
      /void arcEndsLoHi\(vec4 e, float dir, out vec2 pLo, out vec2 pHi\)/.test(gl),
    '(d) arcRayCrossings: no snap -- the ends are the stored vertices (arcEndsLoHi)',
  );
  // ...and its caller: +x crossings only, a crossing ending below counting -1.
  ok(
    /= arcRayCrossings\(sw\.x, sw\.y, sw\.z, sp \* d1\.z, cp \* d1\.w, -\(d1\.y - c\.y\),\s*pLo\.y - c\.y, pHi\.y - c\.y, false, pcU, axU\);/.test(
      hard,
    ) &&
      /arcEndsLoHi\(ends, sw\.z, pLo, pHi\);/.test(hard) &&
      /w \+= \(cr\[j\] > 1\.5\) \? -1\.0 : 1\.0;/.test(hard),
    '(d) hardCrossArc: the same count, +x crossings only, +y counting +1, keeping a touching pair (aa false): the same count',
  );
  // NONE of the heading rule is left: no window, no heading test, no owned-root drop, no range test.
  for (const [name, t] of [
    ['hardCrossArc', hard],
    ['arcRayCrossings', rule + piece],
  ]) {
    ok(
      !/arcOnRayTol|arcInRange\(|bool own|tangent9|tangentV|arcDir/.test(t),
      `(d) ${name}: no window, heading, owned-root drop or range test is left`,
    );
  }
}

if (fail) {
  console.error(`SLUG-ARC-ENDPOINT-ON-RAY FAIL (${fail})`);
  process.exit(1);
}
console.log(`SLUG-ARC-ENDPOINT-ON-RAY PASS (${(performance.now() / 1000).toFixed(1)} s)`);
