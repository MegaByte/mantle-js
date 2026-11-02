// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeDashCapsSmoke -- pins for the stroke shader's dash, cap and join behavior,
// through the float32 C++ emulation of the SHIPPED fragment shader (test/_glslEmu.mjs, test/_strokeMainCov.mjs mainCov) against an
// independent exact-ish SVG 2 stroke oracle (test/_strokeDashOracle.mjs: foot-point roots, join polygons, caps, Gauss-Legendre arc
// length + bisection dash cutting).
//   (a) a dotted ("0 g", round caps) quad/cubic shows NO dot at the path end when the pattern has a gap there
//   (b) dashed quad/cubic/native-arc, butt and ROUND caps, end or start in a gap: 0 pixels off the oracle
//   (c) a dash ending 4 before a vertex keeps its square/round cap and its butt end paints no corner: 0 px
//   (d) patterns under 0.5 px cycle read their duty (0.25, 0.10, 0.75) within 0.02
//   (e) native arc square cap, sweeps 300/330/345 (r=3, hw=6): 0 px off
//   (f) the miter tip at a quad->cubic vertex that curls back is painted, every join: 0 px
//   (g) an exact 180 degree reversal with miter/bevel is a butt end (no half disc past the vertex)
//              ... and miter-clip is a 2 hw wide spike clipped at ml * hw, ml = 1, 4 and 1e16
//   RESIDUALS, REPORTED NOT ASSERTED (their numbers are not pinned): square dash caps on curves (1-7 px),
//   and the closed-seam dash state.
//   node test/strokeDashCapsSmoke.mjs [--glsl path.frag.glsl]   (run another fragment shader text against the same pins)
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu } from './_glslEmu.mjs';
import { strokeRowsOf, mainCov, hasExact } from './_strokeMainCov.mjs';
import * as O from './_strokeDashOracle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP strokeDashCapsSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const gi = process.argv.indexOf('--glsl');
const GLSL = readFileSync(
  gi > 0 ? process.argv[gi + 1] : path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'),
  'utf8',
);
const EXACT = hasExact(GLSL);
const emu = buildGlslEmu(ROOT, { stroke: true, glsl: GLSL });
console.log(
  `strokeDashCapsSmoke: shader text ${gi > 0 ? process.argv[gi + 1] : 'src/shaders/generated/mantle.frag.glsl'}`,
);

let failures = 0;
const check = (good, msg) => {
  console.log(`  ${good ? 'ok' : 'FAIL'} ${msg}`);
  if (!good) failures++;
};
const report = (msg) => console.log(`  info (not asserted) ${msg}`);

async function strokeCov(svg, pix, ePx = 1) {
  const b = await importSvg(svg, { preserveViewport: true });
  if (!b.meta || b.meta.byteLength <= 32) return pix.map(() => 0);
  const B = strokeRowsOf(b);
  return B.rows.length ? Array.from(mainCov(emu, B, B.rows[0], pix, ePx, EXACT)) : pix.map(() => 0);
}
// emulator vs oracle over the pixel box of the path padded by `pad`; returns the pixels off by more than `tol`
async function compare({
  d,
  hw,
  cap = 'butt',
  join = 'miter',
  ml = 4,
  sub,
  dash = null,
  doff = 0,
  tol = 0.3,
  inside = null,
}) {
  const attrs =
    `stroke="#000" fill="none" stroke-width="${2 * hw}" stroke-linecap="${cap}" stroke-linejoin="${join}" stroke-miterlimit="${ml}"` +
    (dash ? ` stroke-dasharray="${dash.join(' ')}" stroke-dashoffset="${doff}"` : '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path d="${d}" ${attrs}/></svg>`;
  const pts = sub.flatMap((s) => s.segs.flatMap((g) => g.p)),
    pad = hw * (Math.max(ml, 2) + 1) + 2;
  const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0])) - pad)),
    x1 = Math.min(100, Math.ceil(Math.max(...pts.map((p) => p[0])) + pad));
  const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1])) - pad)),
    y1 = Math.min(100, Math.ceil(Math.max(...pts.map((p) => p[1])) + pad));
  const pix = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) pix.push([x, y]);
  const cov = await strokeCov(svg, pix);
  const sp = inside ? null : O.wholeSubpaths(sub);
  const f = inside || ((p) => O.inside(p, sp, hw, cap, join, ml));
  const bad = [];
  pix.forEach(([x, y], k) => {
    const o = O.cov(f, (q) => q, x, y, 5);
    if (Math.abs(o - cov[k]) > tol) bad.push({ x, y, emu: +cov[k].toFixed(3), ora: +o.toFixed(3) });
  });
  return bad;
}
const dstr = (s) =>
  `M${s.p[0]} ${s.t}${s.p
    .slice(1)
    .map((p) => p.join(' '))
    .join(' ')}`;
const worst = (bad) =>
  bad
    .slice(0, 2)
    .map((b) => `(${b.x},${b.y}) emu ${b.emu} oracle ${b.ora}`)
    .join('; ');
const pieceInside = (sp, pieces, hw, cap, join, ml) => (p) =>
  pieces.some((pc) => (pc.zero ? false : O.inside(p, [pc], hw, cap, join, ml)));

// ---- (a) no spurious dot at the end of a dotted curve ---------------------------------------------------------------
console.log('dotted curve end');
{
  const segs = {
    L: {
      t: 'L',
      p: [
        [10, 50],
        [75, 50],
      ],
    },
    Q: {
      t: 'Q',
      p: [
        [10, 60],
        [40, 10],
        [70, 60],
      ],
    },
    C: {
      t: 'C',
      p: [
        [10, 50],
        [30, 20],
        [50, 80],
        [75, 50],
      ],
    },
  };
  let rows = 0,
    spur = 0;
  for (const k of ['L', 'Q', 'C'])
    for (const g of [9, 10.7, 11.3, 12.9, 14.3, 16.1, 19]) {
      const sg = segs[k],
        L = O.slen(sg);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${dstr(sg)}" fill="none" stroke="#000" stroke-width="8" stroke-linecap="round" stroke-dasharray="0 ${g}"/></svg>`;
      const gap = L - Math.floor(L / g) * g,
        e = sg.p[sg.p.length - 1];
      if (gap <= 4.5) continue; // the end is inside the last dot: not informative
      const [c] = await strokeCov(svg, [[Math.floor(e[0]), Math.floor(e[1])]]);
      rows++;
      if (c > 0.5) {
        spur++;
        console.log(`    spurious dot ${k} gap ${g}: coverage ${c.toFixed(2)} at the path end`);
      }
    }
  check(rows >= 10, `${rows} informative rows (>= 10)`);
  check(spur === 0, `0 spurious dots at the path end (found ${spur})`);
}

// ---- (b) end or start in a gap, curves --------------------------------------------------------------------------
console.log('dashed curve end/start in a gap');
function arcCubics(cx, cy, r, a0, a1) {
  const n = Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2) - 1e-9),
    da = (a1 - a0) / n,
    out = [];
  for (let i = 0; i < n; i++) {
    const t0 = a0 + i * da,
      t1 = t0 + da,
      al = (4 / 3) * Math.tan(da / 4);
    const P = (t) => [cx + r * Math.cos(t), cy + r * Math.sin(t)],
      D = (t) => [-r * Math.sin(t), r * Math.cos(t)];
    const p0 = P(t0),
      p3 = P(t1),
      d0 = D(t0),
      d3 = D(t1);
    out.push({
      t: 'C',
      p: [
        p0,
        [p0[0] + al * d0[0], p0[1] + al * d0[1]],
        [p3[0] - al * d3[0], p3[1] - al * d3[1]],
        p3,
      ],
    });
  }
  return out;
}
const dashCase = async (segsO, d, where, cap) => {
  let Ls = 0;
  for (const g of segsO) Ls += O.slen(g);
  const dash = [12, 12],
    T = 24,
    hw = 3;
  const off = where === 'end' ? (((12 - (Ls - 7)) % T) + T) % T : 17; // end: last dash ends 7 before the end; start: 7 of gap first
  const sp = O.wholeSubpaths([{ segs: segsO, closed: false }])[0];
  const pieces = O.dashSub(sp, dash, off);
  return compare({
    d,
    hw,
    cap,
    sub: [{ segs: segsO, closed: false }],
    inside: pieceInside(sp, pieces, hw, cap, 'miter', 4),
    dash,
    doff: off,
  });
};
{
  const SEGS = {
    L: {
      t: 'L',
      p: [
        [10, 50],
        [65, 50],
      ],
    },
    Q: {
      t: 'Q',
      p: [
        [10, 60],
        [40, 10],
        [70, 60],
      ],
    },
    C: {
      t: 'C',
      p: [
        [10, 50],
        [30, 20],
        [50, 80],
        [65, 50],
      ],
    },
  };
  let total = 0;
  for (const kind of ['Q', 'C'])
    for (const where of ['end', 'start'])
      for (const cap of ['butt', 'round']) {
        const bad = await dashCase([SEGS[kind]], dstr(SEGS[kind]), where, cap);
        total += bad.length;
        check(
          bad.length === 0,
          `${kind} ${where} ${cap}: ${bad.length} px off the oracle ${worst(bad)}`,
        );
      }
  for (const cap of ['butt', 'round', 'square']) {
    const bad = await dashCase([SEGS.L], dstr(SEGS.L), 'end', cap);
    check(bad.length === 0, `L end ${cap}: ${bad.length} px off the oracle ${worst(bad)}`);
  }
  // native arc, 252 degrees
  const r = 30,
    cs = arcCubics(50, 50, r, 0, Math.PI * 1.4),
    s = cs[0].p[0],
    e = cs[cs.length - 1].p[3];
  const dArc = `M${s} A${r} ${r} 0 1 1 ${e}`;
  for (const where of ['end', 'start'])
    for (const cap of ['butt', 'round', 'square']) {
      const bad = await dashCase(cs, dArc, where, cap);
      check(
        bad.length === 0,
        `native arc ${where} ${cap}: ${bad.length} px off the oracle ${worst(bad)}`,
      );
    }
  // residuals: reported, never asserted
  for (const kind of ['Q', 'C'])
    for (const where of ['end', 'start']) {
      const bad = await dashCase([SEGS[kind]], dstr(SEGS[kind]), where, 'square');
      report(
        `RESIDUAL ${kind} ${where} square dash cap: ${bad.length} px differ from the oracle (tangent-plane cap vs tangent-line extension)`,
      );
    }
}

// ---- (c) a dash ending before a vertex ----------------------------------------------------------------------------
console.log('dash ending 4 before a vertex');
for (const cap of ['square', 'round', 'butt'])
  for (const join of ['miter', 'round']) {
    const Lseg = (a, b) => ({ t: 'L', p: [a, b] }),
      A = [10, 50],
      V = [50, 50],
      B = [80, 15];
    const segs = [Lseg(A, V), Lseg(V, B)],
      dash = [36, 30],
      hw = 8;
    const sp = O.wholeSubpaths([{ segs, closed: false }])[0],
      pieces = O.dashSub(sp, dash, 0);
    const bad = await compare({
      d: `M${A} L${V} L${B}`,
      hw,
      cap,
      join,
      sub: [{ segs, closed: false }],
      inside: pieceInside(sp, pieces, hw, cap, join, 4),
      dash,
      doff: 0,
    });
    check(bad.length === 0, `${cap} cap, ${join} join: ${bad.length} px differ ${worst(bad)}`);
  }

// ---- (d) sub-pixel patterns read their duty -------------------------------------------------------------------------
console.log('sub-pixel dash duty');
for (const [on, off] of [
  [0.01, 0.03],
  [0.005, 0.045],
  [0.03, 0.01],
  [0.1, 0.3],
  [0.25, 0.75],
]) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 50 H90" stroke="#000" stroke-width="6" fill="none" stroke-dasharray="${on} ${off}"/></svg>`;
  const cov = await strokeCov(svg, [
      [30, 49],
      [50, 49],
      [70, 49],
    ]),
    duty = on / (on + off);
  const err = Math.max(...cov.map((c) => Math.abs(c - duty)));
  check(
    err <= 0.02,
    `dash ${on} / gap ${off} (cycle ${(on + off).toFixed(3)} px): duty ${duty.toFixed(2)}, read ${cov.map((c) => c.toFixed(3)).join(' ')}`,
  );
}
{
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 50 H90" stroke="#000" stroke-width="6" fill="none" stroke-dasharray="0.5 1.5"/></svg>`;
  report(
    `2 px cycle duty 0.25 reads ${(await strokeCov(svg, [[50, 49]]))[0].toFixed(3)} (outside the 0.5 px scope of the duty rule)`,
  );
}

// ---- (e) native arc square cap ------------------------------------------------------------------------------------
console.log('native arc square cap, near-closed arcs');
for (const sweep of [270, 300, 330, 345]) {
  const r = 3,
    hw = 6,
    cs = arcCubics(50, 50, r, 0, (sweep * Math.PI) / 180),
    s = cs[0].p[0],
    e = cs[cs.length - 1].p[3];
  const bad = await compare({
    d: `M${s} A${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${e}`,
    hw,
    cap: 'square',
    join: 'round',
    sub: [{ segs: cs, closed: false }],
  });
  check(bad.length === 0, `sweep ${sweep}: ${bad.length} px off ${worst(bad)}`);
}

// ---- (f) miter tip at a quad->cubic vertex ---------------------------------------------------------------------------
console.log('miter tip at a quad-cubic vertex');
{
  const q = {
    t: 'Q',
    p: [
      [59.55075265818776, 29.211091999528506],
      [79.84433355733954, 56.63774492062523],
      [63.50477220653779, 37.8115272604914],
    ],
  };
  const c = {
    t: 'C',
    p: [
      [63.50477220653779, 37.8115272604914],
      [59.53298570566484, 66.25398638018126],
      [48.784465803198735, 58.220005053197966],
      [60.541439075275065, 32.97227860101139],
    ],
  };
  const f = (P) => P.map((p) => p.join(' ')).join(' ');
  const d = `M${f([q.p[0]])} Q${f(q.p.slice(1))} C${f(c.p.slice(1))}`;
  for (const join of ['miter', 'miter-clip', 'round', 'bevel']) {
    const bad = await compare({
      d,
      hw: 8.7,
      cap: 'round',
      join,
      ml: 2.63,
      sub: [{ segs: [q, c], closed: false }],
    });
    check(bad.length === 0, `${join}: ${bad.length} px off ${worst(bad)}`);
  }
}

// ---- (g) an exact 180 degree reversal ------------------------------------------------------------
console.log('exact 180 degree reversal');
for (const join of ['miter', 'bevel']) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path d="M20 50 L50 50 L20 50" stroke="#000" stroke-width="10" fill="none" stroke-linejoin="${join}" stroke-linecap="butt"/></svg>`;
  const pix = [];
  for (let x = 48; x < 64; x++) pix.push([x, 50]);
  const cov = await strokeCov(svg, pix);
  const past = Math.max(...cov.slice(2)); // x >= 50: the butt end is at x = 50, nothing past it
  check(
    cov[0] > 0.99 && cov[1] > 0.99 && past < 0.02,
    `${join}: butt end at the vertex, max coverage past x=50 ${past.toFixed(3)} (cov ${cov
      .slice(0, 5)
      .map((v) => v.toFixed(2))
      .join(' ')})`,
  );
}
// miter-clip at the exact reversal: the unbounded miter clipped at ml * hw along the incoming tangent (SVG 2 stroke-linejoin: miter-clip),
// a rectangle 2 hw wide. ml = 1e16 needs an oracle with a reversal branch: the spike runs to the
// edge of the picture and must not wrap, saturate or vanish in float32. Every cap, since the cap decides nothing at an interior vertex.
for (const ml of [1, 4, 1e16])
  for (const cap of ['butt', 'square']) {
    const sub = [
      {
        segs: [
          {
            t: 'L',
            p: [
              [20, 50],
              [50, 50],
            ],
          },
          {
            t: 'L',
            p: [
              [50, 50],
              [20, 50],
            ],
          },
        ],
        closed: false,
      },
    ];
    const bad = await compare({
      d: 'M20 50 L50 50 L20 50',
      hw: 5,
      cap,
      join: 'miter-clip',
      ml,
      sub,
      tol: 0.3,
    });
    check(
      bad.length === 0,
      `miter-clip ml ${ml} ${cap}: ${bad.length} px off the oracle ${worst(bad)}`,
    );
  }
report(
  'RESIDUAL: closed-seam dash state at the first segment of a closed contour is not handled (it needs a wire-format datum)',
);

console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exit(failures ? 1 : 0);
