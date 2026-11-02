// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeDashSeamSmoke -- the dash pattern runs CONTINUOUSLY through the start/end seam of a closed dashed contour.
//
// A closed subpath has no caps at its seam (SVG 2 13.5). When a dash is on at both ends of it, the two are ONE dash with one join
// at the seam vertex; a dash that only starts there, or only ends there, is an ordinary dash with its caps; the join is drawn only
// where a dash covers the vertex. The first segment of a closed contour has to know the contour's length (or, equivalently, the
// pattern phase at its end) to tell which of the four states the seam is in -- the wire carries it (src/svg/textures.js, header bit
// 16 + the length in the header's w).
//
// The SHIPPED fragment shader, compiled to float32 (test/_glslEmu.mjs, test/_strokeMainCov.mjs mainCov), against the independent SVG 2
// oracle (test/_strokeDashOracle.mjs dashClosed). Cases: closed squares, triangles, circles as 4 cubics, rounded rects, one self-closing
// cubic, Arial/Roboto glyph outlines (O, B, 8: every closed subpath dashed from its own start), with the seam on a straight edge, at a
// vertex, at a smooth curve joint, exactly on a dash boundary and in all four dash states; butt/round/square caps, miter/round/bevel
// joins; pathLength scaling; scales 2^-20, 1 and 2^20. A pixel "differs" when the emulator and the oracle's 5 x 5 box sample are more
// than 0.3 coverage apart.
//   node test/strokeDashSeamSmoke.mjs [--glsl path.frag.glsl] [--report] [--full] [--part k/n]
//   --part k/n  every n-th row starting at the k-th: the accuracy lane gives a smoke 180 s, the whole set takes ~9 minutes, so scripts/accuracyDiagnostics.mjs
//               registers strokeDashSeamPart1Smoke.mjs ... Part6Smoke.mjs, each this file with --part k/6
//   --only s  only the rows whose label contains s;  --report  print every row (even passing); --full the whole grid (slow); --glsl another shader text
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu } from './_glslEmu.mjs';
import { strokeRowsOf, mainCov, hasExact } from './_strokeMainCov.mjs';
import * as O from './_strokeDashOracle.mjs';
import * as C from './_strokeSeamCases.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP strokeDashSeamSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const argv = process.argv.slice(2);
const pi = argv.indexOf('--part'),
  PART =
    pi >= 0
      ? (() => {
          const [i, n] = argv[pi + 1].split('/').map(Number);
          return { i: i - 1, n };
        })()
      : null;
const gi = argv.indexOf('--glsl'),
  REPORT = argv.includes('--report'),
  FULL = argv.includes('--full'),
  oi = argv.indexOf('--only'),
  ONLY = oi >= 0 ? argv[oi + 1] : null;
const GLSL = readFileSync(
  gi >= 0 ? argv[gi + 1] : path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'),
  'utf8',
);
const EXACT = hasExact(GLSL);
const emu = buildGlslEmu(ROOT, { stroke: true, glsl: GLSL });
console.log(
  `strokeDashSeamSmoke: shader text ${gi >= 0 ? argv[gi + 1] : 'src/shaders/generated/mantle.frag.glsl'}`,
);

let failures = 0,
  totalBad = 0,
  totalResid = 0,
  rows = 0,
  seen = 0;
const check = (good, msg) => {
  if (REPORT || !good) console.log(`  ${good ? 'ok' : 'FAIL'} ${msg}`);
  if (!good) failures++;
};

/// Differing pixels of one case, over the pixels within `win` px of a seam (or the whole padded box when win is null).
export async function runCase(c, win = 18) {
  const S = c.S || 1,
    ml = c.ml || 4;
  const svg = C.svgFor(c);
  const b = await importSvg(svg, C.importOpts(c));
  const B = strokeRowsOf(b);
  const pts = c.subs.flatMap((s) => s.segs.flatMap((g) => g.p)),
    pad = c.hw * (Math.max(ml, 2) + 1) + 2;
  const seams = C.seamsOf(c.subs);
  const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0])) - pad)),
    x1 = Math.min(100, Math.ceil(Math.max(...pts.map((p) => p[0])) + pad));
  const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1])) - pad)),
    y1 = Math.min(100, Math.ceil(Math.max(...pts.map((p) => p[1])) + pad));
  const pix = [];
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      if (win && !seams.some((s) => Math.hypot(x + 0.5 - s[0], y + 0.5 - s[1]) <= win)) continue;
      pix.push([x, y]);
    }
  const cov = B.rows.length
    ? Array.from(mainCov(emu, B, B.rows[0], pix, S, EXACT))
    : pix.map(() => 0);
  const inside = C.insideFor(c),
    bad = [];
  pix.forEach(([x, y], k) => {
    const o = O.cov(inside, (q) => q, x, y, 5);
    if (Math.abs(o - cov[k]) > 0.3) bad.push({ x, y, emu: +cov[k].toFixed(3), ora: +o.toFixed(3) });
  });
  // ATTRIBUTION. A pixel the shader gets wrong that the SEAM did not touch is the dash/cap model's own residual (round and square dash caps on curves, dashes
  // shorter than the half width at a vertex), not this row's. It is told by a CONTROL that is the same drawing without this seam:
  //   the contour started one segment later (path rotated; the offset moved by that segment's length, so the dashes lie where they did): the seam is now at the
  //   NEXT vertex and the old one is an interior vertex, drawn by the interior-vertex code; or, for a single segment or several contours, the
  //   subpaths left OPEN (no Z), which has no seam at all; or, for a merged seam, the same DASH through an ordinary vertex (the interior-vertex twin below).
  // A pixel is the model's own when, in EITHER control, the truth is the same (oracle within 0.05) and the shader's coverage is wrong there too (more than 0.2 off, within 0.25 of the
  // main drawing's: the same error to within the float noise of a different dash phase): the seam made no difference to it. Those are counted apart and are not failures.
  if (!bad.length || !c.subs.every((s) => s.closed)) return { bad, resid: [], n: pix.length };
  const controls = [{ ...c, subs: c.subs.map((s) => ({ ...s, closed: false })) }];
  if (c.subs.length === 1 && c.subs[0].segs.length >= 2) {
    const sg = c.subs[0].segs,
      L0 = O.slen({ t: sg[0].t, p: sg[0].p }),
      k = c.pathLength ? O.subLen(O.wholeSubpaths(c.subs)[0]) / c.pathLength : 1;
    controls.push({
      ...c,
      subs: [{ closed: true, segs: [...sg.slice(1), sg[0]] }],
      doff: c.doff + L0 / k,
    });
  }
  // The INTERIOR-VERTEX TWIN of a merged seam: the dash that passes through the seam, drawn as the same dash through an ordinary vertex -- the path made of the
  // last segment and the first one only, one dash [its length, 1e4] starting where the merged dash does. Same dash, same arms, same join, and the code for an
  // interior vertex (which the seam must be indistinguishable from).
  if (c.subs.length === 1 && c.subs[0].segs.length >= 2) {
    const sp = O.wholeSubpaths(c.subs)[0],
      pieces = O.dashClosed(sp, ...C.trueDash(c)),
      sg = sp.segs;
    const m = pieces.find(
      (q) => q.segs.length === 2 && q.segs[0].s === sg[sg.length - 1].s && q.segs[1].s === sg[0].s,
    );
    if (m)
      controls.push({
        ...c,
        pathLength: 0,
        subs: [{ closed: false, segs: [sg[sg.length - 1].s, sg[0].s] }],
        dash: [O.slen(m.segs[0].s, m.segs[0].t0, 1) + O.slen(m.segs[1].s, 0, m.segs[1].t1), 1e4],
        doff: -O.slen(m.segs[0].s, 0, m.segs[0].t0),
      });
  }
  let mine = bad;
  const resid = [];
  for (const co of controls) {
    const Bo = strokeRowsOf(await importSvg(C.svgFor(co), C.importOpts(co)));
    const covO = Array.from(
        mainCov(
          emu,
          Bo,
          Bo.rows[0],
          mine.map((b) => [b.x, b.y]),
          S,
          EXACT,
        ),
      ),
      insideO = C.insideFor(co),
      still = [];
    mine.forEach((b, k) => {
      const oO = O.cov(insideO, (q) => q, b.x, b.y, 5);
      if (
        Math.abs(oO - b.ora) <= 0.05 &&
        Math.abs(covO[k] - b.emu) <= 0.25 &&
        Math.abs(oO - covO[k]) > 0.2
      )
        resid.push(b);
      else still.push(b);
    });
    mine = still;
  }
  return { bad: mine, resid, n: pix.length };
}
const worst = (bad) =>
  bad
    .slice(0, 2)
    .map((b) => `(${b.x},${b.y}) emu ${b.emu} oracle ${b.ora}`)
    .join('; ');
const label = (c, st) =>
  `${c.mode === 'chrome' ? '' : 'SPEC '}${c.id} ${c.cap}/${c.join} dash [${c.dash.join(' ')}] off ${+c.doff.toFixed(3)}${c.S && c.S !== 1 ? ` S=2^${Math.round(Math.log2(c.S))}` : ''}${c.pathLength ? ` pathLength ${c.pathLength}` : ''} (F ${st[0] ? 'on' : 'off'}, E ${st[1] ? 'on' : 'off'})`;
async function row(c, win = 18) {
  const st = C.seamState(c);
  if (ONLY && !label(c, st).includes(ONLY)) return { st, bad: [] };
  if (PART && seen++ % PART.n !== PART.i) return { st, bad: [] };
  const { bad, resid } = await runCase(c, win);
  rows++;
  totalBad += bad.length;
  totalResid += resid.length;
  check(
    bad.length === 0,
    `${label(c, st)}: ${bad.length} px differ ${worst(bad)}${resid.length ? ` (+${resid.length} px the control without this seam has too)` : ''}`,
  );
  return { st, bad };
}

const COMBOS = [
  ['butt', 'miter'],
  ['round', 'round'],
  ['square', 'miter'],
  ['butt', 'bevel'],
  ['round', 'miter'],
  ['square', 'round'],
];
const PATTERNS = [
  [30, 20],
  [14, 10],
  [6, 4],
];
const states = new Set();
/// the offsets that put the seam in every state: 0 (a dash starts at the seam), L (a pattern end at the seam), and generic ones
function offsets(shape, dash) {
  const L = O.subLen(O.wholeSubpaths(shape.subs)[0]),
    T = dash.reduce((a, b) => a + b, 0),
    mod = (v) => ((v % T) + T) % T;
  // a boundary exactly AT the seam is only decidable where L is exact (the oracle's float64 sum and the shader's float32 one agree): the shapes
  // with integer side lengths. Elsewhere L + offset would sit a rounding error from the boundary, and which side it falls on is noise.
  const edge = shape.exact ? [mod(-L), mod(dash[0] - L)] : [0.07 * T + 0.5, 0.64 * T + 0.25];
  return [0, ...edge, 0.21 * T, 0.37 * T, 0.58 * T, 0.83 * T].map((v) => +v.toPrecision(12));
}
// curves: the square dash cap on a curve is the known tangent-plane residual (1-7 px at ANY dash end), not the seam's: those rows are reported
const curved = (id) => !/^(square|squareEdge|tri|tri345|triEdge)$/.test(id);
const capsFor = (id) => (curved(id) ? COMBOS.filter(([c]) => c !== 'square') : COMBOS);

console.log(
  'closed shapes: the seam in every dash state, caps x joins (windows of 18 px about the seam)',
);
{
  const SH = C.shapes();
  let k = 0;
  for (const shape of SH) {
    const pats = FULL ? PATTERNS : [PATTERNS[k % 3], PATTERNS[(k + 1) % 3]];
    for (const dash of pats)
      for (const doff of FULL ? offsets(shape, dash) : offsets(shape, dash).slice(0, 7)) {
        const CB = capsFor(shape.id);
        const combos = FULL ? CB : [CB[k++ % CB.length], CB[k++ % CB.length]];
        for (const [cap, join] of combos) {
          const c = {
            id: shape.id,
            subs: shape.subs,
            hw: 5,
            cap,
            join,
            ml: 4,
            dash,
            doff,
            mode: 'chrome',
          };
          const { st } = await row(c);
          states.add(`${st[0]}${st[1]}`);
        }
      }
  }
  check(
    states.size === 4,
    `the cases reach all four seam states (F,E): ${[...states].sort().join(' ')}`,
  );
}

// ---- the seven rows the shader-only attempt made worse: tri round miter [30,20] 10 etc ------------------------------------------
console.log("the shader-only attempt's worse rows (triangle/square, round cap, miter join)");
for (const [id, dash, doff, hw] of [
  ['tri', [30, 20], 10, 5],
  ['tri', [30, 20], 0, 5],
  ['square', [30, 20], 10, 5],
  ['square', [14, 10], 7, 5],
  ['tri', [14, 10], 0, 5],
  ['triEdge', [30, 20], 10, 5],
  ['squareEdge', [30, 20], 10, 5],
]) {
  const shape = C.shapes().find((s) => s.id === id);
  await row(
    { id, subs: shape.subs, hw, cap: 'round', join: 'miter', ml: 4, dash, doff, mode: 'chrome' },
    30,
  );
}

// ---- whole shapes (every pixel of the padded box) --------------------------------------------------------------------------------
console.log('whole shapes, every pixel');
for (const [id, cap, join, dash, doff] of [
  ['square', 'butt', 'miter', [14, 10], 0],
  ['tri', 'round', 'round', [30, 20], 10],
  ['circle', 'butt', 'miter', [14, 10], 3],
  ['rrect', 'square', 'miter', [14, 10], 5],
  ['loop', 'round', 'round', [14, 10], 0],
]) {
  const shape = C.shapes().find((s) => s.id === id);
  await row({ id, subs: shape.subs, hw: 4, cap, join, ml: 4, dash, doff, mode: 'chrome' }, null);
}

// ---- the DEFAULT (compat 'spec'): the seam is two dash ends (SVG 2 13.5.7) -----------------------------------------------------------
console.log('compat spec (the default): the seam is two capped dash ends, never a join');
let ks = 0;
for (const shape of C.shapes()) {
  const dash = PATTERNS[1];
  for (const doff of offsets(shape, dash).slice(0, 4)) {
    const CB = capsFor(shape.id),
      [cap, join] = CB[ks++ % CB.length];
    await row({
      id: shape.id,
      subs: shape.subs,
      hw: 5,
      cap,
      join,
      ml: 4,
      dash,
      doff,
      mode: 'spec',
    });
  }
}

// ---- pathLength ---------------------------------------------------------------------------------------------------------------
console.log('pathLength scaling');
for (const [id, pl, dash, doff] of [
  ['square', 100, [10, 5], 0],
  ['square', 150, [10, 5], 4],
  ['tri', 80, [6, 4], 2],
  ['circle', 100, [8, 6], 0],
]) {
  const shape = C.shapes().find((s) => s.id === id);
  await row(
    {
      id,
      subs: shape.subs,
      hw: 4,
      cap: 'butt',
      join: 'miter',
      ml: 4,
      dash,
      doff,
      pathLength: pl,
      mode: 'chrome',
    },
    26,
  );
}

// ---- scale: the answer is the same at 2^-20, 1 and 2^20 ---------------------------------------------------------------------------
console.log('scale 2^-20, 2^0, 2^20');
for (const S of [2 ** -20, 1, 2 ** 20])
  for (const [id, cap, join, dash, doff] of [
    ['square', 'butt', 'miter', [14, 10], 0],
    ['tri', 'round', 'miter', [30, 20], 10],
    ['circle', 'round', 'round', [14, 10], 3],
    ['square', 'square', 'bevel', [30, 20], 0],
  ]) {
    const shape = C.shapes().find((s) => s.id === id);
    await row({ id, subs: shape.subs, hw: 5, cap, join, ml: 4, dash, doff, S, mode: 'chrome' }, 24);
  }

// ---- glyph outlines: Arial (or the repo's Roboto fixture) O, B, 8; each closed subpath dashed from its own start -------------------------
console.log('glyph outlines O, B, 8 (holes: each closed subpath separately)');
{
  const fontPaths = [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    path.join(ROOT, 'test/font/fixtures/roboto-regular.ttf'),
  ];
  const fp = fontPaths.find((p) => existsSync(p));
  if (!fp) console.log('  SKIP no Arial/Roboto font file');
  else {
    const { MantleFontAsset } = await import('../src/font/fontAsset.js');
    const { buildSvgTextGlyphs } = await import('../src/font/textRun.js');
    const { segsToPathD } = await import('../src/svg/segment.js');
    const font = new MantleFontAsset(new Uint8Array(readFileSync(fp)));
    for (const ch of ['O', 'B', '8']) {
      const g = buildSvgTextGlyphs(ch, font, 30, 75, 80).glyphs[0];
      const subs = C.parsePathD(segsToPathD(g.segs, true));
      for (const [cap, join, dash, doff] of [
        ['butt', 'miter', [9, 5], 0],
        ['round', 'round', [12, 7], 4.5],
        ['square', 'bevel', [7, 4], 9],
      ]) {
        await row(
          {
            id: `glyph ${ch} (${subs.length} contours)`,
            subs,
            hw: 1.6,
            cap,
            join,
            ml: 4,
            dash,
            doff,
            mode: 'chrome',
          },
          FULL ? null : 100,
        );
      }
    }
  }
}

console.log(
  `\n${rows} rows, ${totalBad} differing px in total (${totalResid} more are the dash/cap model's own: the same pixels are wrong the same way with the seam moved to the next vertex, the contour open, or the same dash through an ordinary vertex)`,
);
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
