// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// kernelIdentity — is a fill-kernel change OUTPUT-IDENTICAL? Two assembled fill shaders (the base and a candidate)
// through test/_glslEmu.mjs, the float32 emulation of the package shader text, over one corpus at three scales, every
// answer compared bit for bit. Node only, no GPU. Built for fill-performance changes: each is one commit, timed on
// the GPU afterwards, and this is the proof that the commit moved no pixel.
//
//   node probes/fillperf/kernelIdentity.mjs [--base-rev HEAD~1 | --base file.glsl] [--cand file.glsl]
//        [--kernels slug,aac,aacStripe,hard,gwnSdf,gwnWind,treeHard] [--defines MANTLE_NO_CUBIC,...]
//        [--raster 64,256] [--scales -20,0,20] [--base-root dir] [--quick] [--text path.svg] [--fetches]
//        [--oracle] [--only name,name] [--fma base|cand|both] [--dump file.jsonl]
//
// --oracle: for the no-AA kernels (hard, treeHard, gwnWind: 0/1 answers), every query where the two disagree is
// judged against the exact f64 point-in-fill test on the decoded outline (hitTest/fillCoverage.js pointInFill),
// and the harness reports which side was right -- the bar for a change that moves answers by design.
//
// --ref-aac: for the AA kernels (slug; aac itself is the reference), every query where the two differ is also
// scored against AAC's exact-area answer at the same query (from the candidate text): the mean and max error of
// each side, and how many differences change an 8-bit level -- the bar for a change that moves AA by design.
//
// --exact: for the AA kernels (slug, aac, aacStripe), every query where the two differ is scored against the exact
// box coverage in f64 (cellCoverage.mjs) -- mean and max error of each side, how many moved closer, and the STRAY
// answers: base at or above half an 8-bit level where the exact coverage is 0.
//
// --fma base|cand|both: that side's emulator is built with FUSED multiply-adds (test/_glslEmu.mjs `contract`), as a GPU
// compiler contracts a * b + c. With the same text on both sides (--base file = the candidate) the question becomes
// which answers depend on contraction -- the class of fault where two exact negatives round to the same sign.
// --exact and --oracle then say which side was right.
//
// --dump file.jsonl writes every difference past rounding (|d| > 1e-6, or 1e-6 of a pixel for a stroke distance) as one
// JSON line: kernel, drawing, scale, query, both answers, and the query's distance to its shape's outline in pixels -- so
// a 0/1 flip at a knife edge (a query within float32's noise of the boundary) reads apart from one that is not.
//
// --fetches also counts every query's texelFetch calls on the band and curve planes, base against candidate
// (a change that claims to fetch no more -- or less -- is checked on the same text).
//
// THE KERNELS (one emulator per define set, each run on the base and the candidate text):
//   slug       renderFill                 (every program compiles it)
//   aac        renderFillAAC, pair bands   MANTLE_AAC + MANTLE_AAC_PAIR_BANDS (the default layout)
//   aacStripe  renderFillAAC, stripe walk  MANTLE_AAC without pair bands (the per-stripe window path)
//   hard       renderFillHardBand          MANTLE_HARD
//   gwnSdf     renderFillGWNSDF            MANTLE_GWN + MANTLE_GWN_SDF        (imports with the run tree)
//   gwnWind    renderFillGWNSDF, winding   MANTLE_GWN                          (ditto)
//   treeHard   renderFillGWNSDF, tree-hard MANTLE_HARD_TREE + MANTLE_GWN       (ditto)
//   stroke     strokeMinDist over every stroke row: minD and the boundary normal, gates on and off, dash off
//
// THE QUERIES, per fill shape: a 10 x 10 grid over its bbox and a margin, and rays through up to 16 of its control
// coordinates on each axis (a vertex on the ray is where a one-comparison change shows), rows and columns within a few
// float32 ulps of every arc endpoint and extreme (where the arc snap and the bands' arc pad decide), each at the drawing's own
// pixel size and at 1/16 of it (a few-pixel shape: AAC's straddle and level walks); plus, with --raster, every pixel
// center of an N-pixel raster of the drawing inside the shape's bbox and a pixel (its cover quad, roughly).
//
// THE SCALES: the drawing wrapped in scale(2^k) with its viewBox scaled to match, k in --scales (default -20, 0, 20),
// so a change that is identical only at scale 1 is caught.
//
// THE DATA: imported once by this tree's importer (both shaders read the same bands and curves) -- or, with
// --base-root, the base shader reads what the importer under that directory writes (for an encoder change), and
// the question becomes whether the coverage is identical, not the kernel.
//
// Also a legacy import (rayLanes: false: the layout without lanes, no lane reject) of every drawing at scale 1, so the
// no-reject path of every walker is held to the same bar.
//
// Exit 0 iff every kernel is identical at every query. `sign-of-zero` differences (+0 vs -0) are reported apart
// and count as differences.
import {
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
// the stroke walk as the fill shader's call site runs it (`strokeWalk: true`; _glslEmu.mjs names it K_STROKE_BAND)
import {
  hasCxx,
  buildGlslEmu,
  fillShapes,
  K_AAC,
  K_HARD,
  K_SLUG,
  K_GWN,
  K_STROKE_BAND as K_STROKE_WALK,
  K_STROKE_BAND_GX as K_STROKE_WALK_GX,
  K_STROKE_BAND_GY as K_STROKE_WALK_GY,
} from '../../test/_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (k) => argv.includes('--' + k);
if (!hasCxx()) {
  console.error('kernelIdentity: no C++ compiler');
  process.exit(2);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}

// ---- the two shader texts ------------------------------------------------------------------------------------------
const GEN = 'src/shaders/generated/mantle.frag.glsl';
const baseText = flag('base')
  ? readFileSync(flag('base'), 'utf8')
  : execFileSync('git', ['show', `${flag('base-rev', 'HEAD~1')}:./${GEN}`], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    });
const candText = readFileSync(flag('cand') || path.join(ROOT, GEN), 'utf8');
const FMA = flag('fma', '');
if (FMA && !['base', 'cand', 'both'].includes(FMA)) {
  console.error('--fma takes base, cand or both');
  process.exit(2);
}
const fmaB = FMA === 'base' || FMA === 'both',
  fmaC = FMA === 'cand' || FMA === 'both';
const sameText = baseText === candText && fmaB === fmaC;
const baseRoot = flag('base-root') ? path.resolve(flag('base-root')) : null;
if (sameText && !baseRoot)
  console.log('  NOTE: the base and candidate shader texts are identical (an A/A run)');
if (FMA)
  console.log(
    `  fused multiply-adds: base ${fmaB ? 'fused' : 'unfused'}, candidate ${fmaC ? 'fused' : 'unfused'}`,
  );

const KSETS = {
  slug: { k: K_SLUG, defines: ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS', 'MANTLE_HARD'] },
  aac: { k: K_AAC, defines: ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS', 'MANTLE_HARD'] },
  hard: { k: K_HARD, defines: ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS', 'MANTLE_HARD'] },
  aacStripe: { k: K_AAC, defines: ['MANTLE_AAC', 'MANTLE_HARD'] },
  gwnSdf: { k: K_GWN, defines: ['MANTLE_GWN', 'MANTLE_GWN_SDF'], tree: true },
  gwnWind: { k: K_GWN, defines: ['MANTLE_GWN'], tree: true },
  treeHard: { k: K_GWN, defines: ['MANTLE_HARD_TREE', 'MANTLE_GWN'], tree: true },
  stroke: { k: K_STROKE_WALK, defines: [], strokeWalk: true },
};
const kernels = flag('kernels', 'slug,aac,aacStripe,hard').split(',').filter(Boolean);
for (const k of kernels)
  if (!KSETS[k]) {
    console.error(`unknown kernel ${k}`);
    process.exit(2);
  }
const extraDefs = flag('defines', '').split(',').filter(Boolean);
// One emulator pair per distinct define set; kernels sharing a set run in one emulator call.
const groups = new Map();
for (const k of kernels) {
  const defs = [...KSETS[k].defines, ...extraDefs];
  const key =
    defs.join('+') + (KSETS[k].tree ? ':tree' : '') + (KSETS[k].strokeWalk ? ':stroke' : '');
  if (!groups.has(key))
    groups.set(key, {
      defs,
      tree: !!KSETS[k].tree,
      strokeWalk: !!KSETS[k].strokeWalk,
      kernels: [],
    });
  groups.get(key).kernels.push(k);
}
const FETCHES = has('fetches');
for (const g of groups.values()) {
  g.eBase = buildGlslEmu(ROOT, {
    defines: g.defs,
    glsl: baseText,
    strokeWalk: g.strokeWalk,
    contract: fmaB,
  });
  g.eCand = sameText
    ? g.eBase
    : buildGlslEmu(ROOT, {
        defines: g.defs,
        glsl: candText,
        strokeWalk: g.strokeWalk,
        contract: fmaC,
      });
  if (FETCHES)
    for (const plane of ['band', 'curve']) {
      g['fBase' + plane] = buildGlslEmu(ROOT, {
        defines: g.defs,
        glsl: baseText,
        strokeWalk: g.strokeWalk,
        fetchCount: plane,
        contract: fmaB,
      });
      g['fCand' + plane] = buildGlslEmu(ROOT, {
        defines: g.defs,
        glsl: candText,
        strokeWalk: g.strokeWalk,
        fetchCount: plane,
        contract: fmaC,
      });
    }
}

// ---- the corpus ----------------------------------------------------------------------------------------------------
const svg = (vb, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${body}</svg>`;
const f4 = (v) => v.toFixed(4);
function poly(n, cx, cy, r) {
  let d = '';
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n;
    d += `${k ? 'L' : 'M'}${f4(cx + r * Math.cos(a))} ${f4(cy + r * Math.sin(a))} `;
  }
  return d + 'Z';
}
function star(kind, n, cx, cy, r0, r1) {
  const P = (k, r) => [cx + r * Math.cos((Math.PI * k) / n), cy + r * Math.sin((Math.PI * k) / n)];
  let d = `M${f4(P(0, r0)[0])} ${f4(P(0, r0)[1])} `;
  for (let k = 0; k < 2 * n; k += 2) {
    const a = P(k, r0),
      m = P(k + 1, r1),
      b = P(k + 2, r0);
    if (kind === 'Q') d += `Q${f4(m[0])} ${f4(m[1])} ${f4(b[0])} ${f4(b[1])} `;
    else if (kind === 'C')
      d += `C${f4(a[0] + (m[0] - a[0]) * 1.4)} ${f4(a[1] + (m[1] - a[1]) * 1.4)} ${f4(b[0] + (m[0] - b[0]) * 1.4)} ${f4(b[1] + (m[1] - b[1]) * 1.4)} ${f4(b[0])} ${f4(b[1])} `;
    else d += `A${f4(r0 * 0.3)} ${f4(r0 * 0.2)} ${k * 7} 0 1 ${f4(b[0])} ${f4(b[1])} `;
  }
  return d + 'Z';
}
const SYNTH = {
  poly64: svg('0 0 128 128', `<path d="${poly(64, 64, 64, 50)}"/>`),
  quadStar: svg('0 0 128 128', `<path d="${star('Q', 9, 64, 64, 40, 62)}"/>`),
  cubicStar: svg('0 0 128 128', `<path d="${star('C', 7, 64, 64, 36, 60)}"/>`),
  arcStar: svg('0 0 128 128', `<path d="${star('A', 8, 64, 64, 44, 30)}"/>`),
  rings: svg(
    '0 0 128 128',
    '<path fill-rule="evenodd" d="M14 64 A50 50 0 1 1 114 64 A50 50 0 1 1 14 64 Z M34 64 A30 22 30 1 0 94 64 A30 22 30 1 0 34 64 Z"/>' +
      '<ellipse cx="64" cy="64" rx="12" ry="7" transform="rotate(23 64 64)"/>',
  ),
  loop: svg(
    '0 0 128 128',
    '<path d="M10 100 C 140 -20 -10 -20 118 100 Z"/><path d="M20 20 C 60 120 70 -20 110 30 L 100 40 Z"/>',
  ),
  lattice: svg(
    '0 0 64 64',
    '<path d="M4.5 4.5 H 30.5 V 20 L 40.5 20.5 L 40.5 40.5 Q 30 60.5 4.5 40.5 Z M10.5 10.5 V 30.5 H 20.5 Z"/>' +
      '<rect x="44" y="4.5" width="15.5" height="20" rx="4" ry="6"/><path d="M44 30 C 44 60 60 30 60 60 L 44 60 Z"/>',
  ),
  glyph: svg(
    '0 0 100 100',
    '<path d="M20 90 L 45 10 Q 50 5 55 10 L 80 90 L 68 90 L 61 68 L 39 68 L 32 90 Z M 42 58 L 58 58 L 50 30 Z"/>',
  ),
  // symmetric cubics (a3 == 0 exactly on one axis) and cusps: the degenerate branches of every cubic solver
  cubicSym: svg(
    '0 0 128 128',
    '<path d="M14 96 C34 8 94 8 114 96 Z"/><path d="M20 20 C 100 20 20 100 100 100 L 20 100 Z"/>' +
      '<path d="M60 10 C 120 60 0 60 60 110 C 70 60 50 60 60 10 Z"/>',
  ),
  // arcs: rounded rects, a full circle, rotated ellipses, a tiny radius, and arcs far from the origin
  arcs: svg(
    '0 0 256 256',
    '<rect x="8" y="8" width="100" height="60" rx="18" ry="12"/><circle cx="180" cy="60" r="44"/>' +
      '<ellipse cx="70" cy="170" rx="50" ry="20" transform="rotate(35 70 170)"/><circle cx="200" cy="200" r="1.3"/>' +
      '<path d="M140 150 A 30 50 -20 0 1 220 150 A 30 20 10 1 1 140 150 Z"/>',
  ),
};
const corpus = Object.entries(SYNTH).map(([name, text]) => ({ name, text }));
const readDir = (d, pick = () => true) =>
  existsSync(d)
    ? readdirSync(d)
        .filter((f) => f.endsWith('.svg'))
        .sort()
        .filter(pick)
        .map((f) => ({
          name: path.relative(ROOT, path.join(d, f)),
          text: readFileSync(path.join(d, f), 'utf8'),
        }))
    : [];
const QUICK = has('quick');
corpus.push(...readDir(path.join(ROOT, 'examples'), (f) => !QUICK || f === 'tiger.svg'));
corpus.push(...readDir(path.join(ROOT, 'examples/_bench')));
if (!QUICK)
  corpus.push(
    ...readDir(path.join(ROOT, 'examples/smoke'), (_f, i) => flag('only') || i % 4 === 0),
  );
const TEXT = flag('text') || path.join(os.tmpdir(), 'mantle-fillperf-text.svg');
if (!existsSync(TEXT) && existsSync(path.join(ROOT, 'test/font/fixtures/roboto-regular.ttf')))
  execFileSync(process.execPath, [path.join(ROOT, 'probes/rayLanes/makeTextSvg.mjs'), TEXT, '6'], {
    stdio: 'ignore',
  });
if (existsSync(TEXT)) corpus.push({ name: 'text(roboto)', text: readFileSync(TEXT, 'utf8') });
// an arc sheet: 120 shapes of path arcs only (probes/fillperf/makeArcSvg.mjs), so none is taken off the band walk
const ARCS = path.join(os.tmpdir(), 'mantle-fillperf-arcs.svg');
if (!existsSync(ARCS))
  execFileSync(process.execPath, [path.join(ROOT, 'probes/fillperf/makeArcSvg.mjs'), ARCS], {
    stdio: 'ignore',
  });
corpus.push({ name: 'arcSheet', text: readFileSync(ARCS, 'utf8') });
// --only a,b: just the corpus entries whose name contains one of these
if (flag('only')) {
  const keep = flag('only').split(',');
  for (let i = corpus.length - 1; i >= 0; i--)
    if (!keep.some((k) => corpus[i].name.includes(k))) corpus.splice(i, 1);
}
if (!corpus.some((c) => c.name === 'examples/tiger.svg'))
  console.log('  (examples/tiger.svg absent -- copy the fixtures in; the rest runs)');

function wrap(raw, S) {
  if (S === 1) return raw;
  const m = raw.match(/<svg\b[^>]*>/);
  if (!m) return null;
  let vb = (m[0].match(/viewBox="([^"]+)"/) || [])[1];
  let open = m[0];
  if (!vb) {
    const w = parseFloat((m[0].match(/\bwidth="([\d.]+)(px)?"/) || [])[1]),
      h = parseFloat((m[0].match(/\bheight="([\d.]+)(px)?"/) || [])[1]);
    if (!(w > 0 && h > 0)) return null;
    vb = `0 0 ${w} ${h}`;
    open = open.replace(/<svg\b/, `<svg viewBox="${vb}"`);
  }
  const v = vb
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) return null;
  open = open.replace(/viewBox="[^"]+"/, `viewBox="${v.map((x) => x * S).join(' ')}"`);
  const i0 = raw.indexOf(m[0]) + m[0].length,
    i1 = raw.lastIndexOf('</svg>');
  if (i1 < i0) return null;
  return open + `<g transform="scale(${S})">` + raw.slice(i0, i1) + '</g></svg>';
}

async function importer(root) {
  const u = (p) => pathToFileURL(path.join(root, p)).href;
  return {
    importSvg: (await import(u('src/svg/importer.js'))).default,
    parseMetaBin: (await import(u('src/renderer/bundle.js'))).parseMetaBin,
    M: await import(u('src/bundle/layout.js')),
  };
}
const IC = await importer(ROOT),
  IB = baseRoot ? await importer(baseRoot) : null;
const ORACLE = has('oracle');
const { decodeSegs } = await import('../../src/hitTest/curveGeom.js');
const { pointInFill } = await import('../../src/hitTest/fillCoverage.js');
const HARD_KERNELS = new Set(['hard', 'treeHard', 'gwnWind']);
const EXACT = has('exact');
const { cellCoverage } = await import('./cellCoverage.mjs');
const AA_KERNELS = new Set(['slug', 'aac', 'aacStripe']);
const DUMP = flag('dump') ? openSync(flag('dump'), 'w') : null;
const { closest } = await import('../../src/hitTest/curveGeom.js');
/// The query's distance to its shape's outline, in pixels (the nearest segment, f64).
function outlinePx(sh, curve, c, ePx) {
  if (!sh.range) return null;
  if (!sh.segs) sh.segs = decodeSegs(curve, sh.range.begin, sh.range.end);
  let d2 = Infinity;
  for (const s of sh.segs) d2 = Math.min(d2, closest(s, c[0], c[1]).d2);
  return Math.sqrt(d2) / ePx[0];
}
/// The exact coverage of the ePx-wide pixel box centered on c, f64 (cellCoverage.mjs).
// THE PIXEL THE KERNEL READS: the query's center and size go to the shader through a float32 buffer, so the reference
// integrates the float32 pixel. With the float64 one it scored a different pixel: at y ~ 1e5 (noAaArcRow__FAR) the
// center rounds by up to 0.0039 em, 0.003 of a pixel there, and every kernel read ~2e-3 off an "exact" that was not.
function exactCoverage(sh, curve, c, ePx) {
  if (!sh.segs) sh.segs = decodeSegs(curve, sh.range.begin, sh.range.end);
  return cellCoverage(
    sh.segs,
    [Math.fround(c[0]), Math.fround(c[1])],
    [Math.fround(ePx[0]), Math.fround(ePx[1])],
    sh.eo,
  );
}
async function load(I, text, opts) {
  try {
    const b = await I.importSvg(text, { preserveViewport: true, ...opts });
    if (!b || !b.bands) return null;
    return {
      b,
      band: new Float32Array(b.bands),
      curve: new Float32Array(b.curves),
      shapes: fillShapes(b, I.parseMetaBin, I.M).filter((sh) => sh.GD[3] >= 1),
      strokes: strokeRows(b, I),
    };
  } catch {
    return null;
  }
}

// Every row a stroke pass walks: a visible stroke width and a band structure. Its walk's parameters, as the fill
// shader's call site reads them from the meta row (dash off: the emulator has no dash table).
function strokeRows(b, I) {
  const pm = I.parseMetaBin(b.meta, b.metaFloatsPerShape),
    F = pm.metaFloats,
    M = I.M,
    out = [];
  for (let s = 0; s < b.numShapes; s++) {
    const o = s * pm.floatsPerShape;
    if (!(F[o + M.META_STROKE_W] > 0) || (F[o + M.META_BAND_MAX_Y] | 0) < 1) continue;
    const startCap = (F[o + M.META_CAP_STYLE] + 0.5) | 0,
      endEnc = (F[o + M.META_END_CAP_OR_RX] + 0.5) | 0;
    out.push({
      GD: [
        F[o + M.META_GLYPH_LOC_X] | 0,
        F[o + M.META_GLYPH_LOC_Y] | 0,
        F[o + M.META_BAND_MAX_X] | 0,
        F[o + M.META_BAND_MAX_Y] | 0,
      ],
      bb: [
        F[o + M.META_BBOX_XMIN],
        F[o + M.META_BBOX_YMIN],
        F[o + M.META_BBOX_XMAX],
        F[o + M.META_BBOX_YMAX],
      ],
      eo: false,
      ex: [
        F[o + M.META_STROKE_W] * 0.5,
        startCap,
        endEnc === 0 ? startCap : endEnc - 1,
        (F[o + M.META_JOIN_STYLE] + 0.5) | 0,
        F[o + M.META_MITER_LIMIT],
        0,
      ],
    });
  }
  return out;
}

// ---- queries -------------------------------------------------------------------------------------------------------
const TEX_W = 4096;
function ctrlCoords(X, sh) {
  const g = sh.GD[1] * TEX_W + sh.GD[0],
    bandsY = sh.GD[3] + 1,
    bandsX = sh.GD[2] + 1;
  const at = (t, c) => X.band[(g + t) * 4 + c];
  const xs = new Set(),
    ys = new Set(),
    arcXs = new Set(),
    arcYs = new Set();
  for (let s = 0; s < bandsY + bandsX; s++) {
    const n = [0, 1, 2, 3].map((c) => at(s * 2, c) | 0),
      arr = at(s * 2 + 1, 0) | 0;
    for (let type = 0, k = 0; type < 4; type++)
      for (let i = 0; i < n[type]; i++, k++) {
        const loc = at(arr + k, 0) | 0,
          t = (j, c) => X.curve[(loc + j) * 4 + c];
        if (type === 3) {
          // an arc: its endpoints and its ellipse's extremes on each axis, and rows and columns a few float32 ulps of
          // |center| + |rx| + |ry| to either side -- where the walkers' one-ulp snap and the bands' arc pad decide
          const cx = t(1, 0),
            cy = t(1, 1),
            rx = t(1, 2),
            ry = t(1, 3),
            th0 = t(2, 0),
            th1 = t(2, 1),
            phi = t(2, 2);
          const cp = Math.cos(phi),
            sp = Math.sin(phi);
          const P = (th) => [
            cx + cp * rx * Math.cos(th) - sp * ry * Math.sin(th),
            cy + sp * rx * Math.cos(th) + cp * ry * Math.sin(th),
          ];
          const ux = 1.2e-7 * (Math.abs(cx) + Math.abs(rx) + Math.abs(ry)),
            uy = 1.2e-7 * (Math.abs(cy) + Math.abs(rx) + Math.abs(ry));
          const Rx = Math.hypot(cp * rx, sp * ry),
            Ry = Math.hypot(sp * rx, cp * ry);
          for (const [x, y] of [P(th0), P(th1), [cx - Rx, cy - Ry], [cx + Rx, cy + Ry]])
            for (const m of [0, -0.5, 0.5, -1, 1, -1.5, 1.5, -2, 2, -3, 3, -5, 5]) {
              arcXs.add(x + m * ux);
              arcYs.add(y + m * uy);
            }
          continue;
        }
        const pts =
          type === 0
            ? [
                [t(1, 0), t(1, 1)],
                [t(1, 2), t(1, 3)],
              ]
            : type === 1
              ? [
                  [t(1, 0), t(1, 1)],
                  [t(1, 2), t(1, 3)],
                  [t(2, 0), t(2, 1)],
                ]
              : [
                  [t(1, 0), t(1, 1)],
                  [t(1, 2), t(1, 3)],
                  [t(2, 0), t(2, 1)],
                  [t(2, 2), t(2, 3)],
                ];
        for (const [x, y] of pts) {
          xs.add(x);
          ys.add(y);
        }
      }
  }
  return { xs, ys, arcXs, arcYs };
}
const RASTER = flag('raster', '').split(',').filter(Boolean).map(Number);
function queries(X, sh, vb) {
  const [x0, y0, x1, y1] = sh.bb,
    ext = Math.max(x1 - x0, y1 - y0) || Math.max(Math.abs(x0), Math.abs(y0), 1);
  const px = 48 / ext,
    G = 10,
    R = 16;
  const gx = (i, n) => x0 - 0.05 * ext + ((i + 0.37) / n) * (x1 - x0 + 0.1 * ext);
  const gy = (j, n) => y0 - 0.05 * ext + ((j + 0.61) / n) * (y1 - y0 + 0.1 * ext);
  const pts = [];
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) pts.push([gx(i, G), gy(j, G)]);
  const { xs, ys, arcXs, arcYs } = ctrlCoords(X, sh);
  const pick = (set, r = R) => {
    const a = [...set].sort((p, q) => p - q);
    if (a.length <= r) return a;
    return Array.from({ length: r }, (_, k) => a[Math.floor((k * (a.length - 1)) / (r - 1))]);
  };
  for (const y of pick(ys)) for (let i = 0; i < 6; i++) pts.push([gx(i, 6), y]);
  for (const x of pick(xs)) for (let j = 0; j < 6; j++) pts.push([x, gy(j, 6)]);
  // every arc row and column near an endpoint or extreme (up to 208 each way), across the shape
  for (const y of pick(arcYs, 208)) for (let i = 0; i < 12; i++) pts.push([gx(i, 12), y]);
  for (const x of pick(arcXs, 208)) for (let j = 0; j < 12; j++) pts.push([x, gy(j, 12)]);
  const out = [];
  for (const scale of [1, 1 / 16])
    for (const [x, y] of pts) out.push({ c: [x, y], ePx: [1 / (px * scale), 1 / (px * scale)] });
  // an N-pixel raster of the drawing's box, the pixel centers over this shape's bbox and a pixel. Not for a row far
  // larger than the drawing's box: a pattern tile's children live in the tile's own units, which the scale(2^k)
  // wrapper does not scale, so at 2^-20 the drawing's pixel is 2^20 times too small for them -- below the float32
  // resolution of their coordinates, a query no render makes (a tile is sampled in its own units).
  const vbExt = Math.max(vb[2], vb[3]);
  for (const N of ext > 4 * vbExt ? [] : RASTER) {
    const e = Math.max(vb[2], vb[3]) / N;
    const i0 = Math.floor((x0 - vb[0]) / e) - 1,
      i1 = Math.ceil((x1 - vb[0]) / e) + 1;
    const j0 = Math.floor((y0 - vb[1]) / e) - 1,
      j1 = Math.ceil((y1 - vb[1]) / e) + 1;
    for (let j = Math.max(j0, 0); j <= Math.min(j1, N - 1); j++)
      for (let i = Math.max(i0, 0); i <= Math.min(i1, N - 1); i++)
        out.push({
          c: [Math.fround(vb[0] + (i + 0.5) * e), Math.fround(vb[1] + (j + 0.5) * e)],
          ePx: [e, e],
        });
  }
  return out;
}

// ---- run -----------------------------------------------------------------------------------------------------------
const SCALES = flag('scales', '-20,0,20')
  .split(',')
  .map((k) => 2 ** +k);
const res = {};
const REF_AAC = has('ref-aac');
for (const k of kernels)
  res[k] = {
    n: 0,
    diff: 0,
    zero: 0,
    maxAbs: 0,
    where: new Map(),
    ex: [],
    judged: [0, 0, 0],
    bucket: [0, 0, 0], // |d| <= 1e-6 (rounding), under half an 8-bit level, at or above it
    exact: {
      n: 0,
      eB: 0,
      eC: 0,
      mB: 0,
      mC: 0,
      closer: 0,
      farther: 0,
      stray: 0,
      strayFixed: 0,
      strayMax: 0,
      strayNew: 0,
      strayNewMax: 0,
      strayNewEx: '',
      worseMax: 0,
      worseEx: '',
    },
    ref: { n: 0, eBase: 0, eCand: 0, mBase: 0, mCand: 0, level: 0, better: 0, worse: 0 },
    fetch: { band: [0, 0, 0], curve: [0, 0, 0] },
  }; // [base total, candidate total, queries whose count differs]
const t0 = Date.now();
let drawings = 0;
async function runOne(name, S, XC, XB, grp) {
  if (!XC || !XB) return;
  const SC = grp.strokeWalk ? XC.strokes : XC.shapes,
    SB = grp.strokeWalk ? XB.strokes : XB.shapes;
  if (!SC.length) return;
  if (SC.length !== SB.length) {
    console.log(
      `  FAIL ${name}@${S}: the base import has ${SB.length} rows, the candidate ${SC.length}`,
    );
    for (const k of grp.kernels) res[k].diff++;
    return;
  }
  const vb = XC.b.viewBox || [0, 0, 1, 1];
  // in batches of whole shapes, so a large raster never holds more than ~300k queries at once
  let qC = [],
    qB = [],
    qShape = [];
  for (let si = 0; si < SC.length; si++) {
    const sh = SC[si],
      shB = SB[si];
    for (const q of queries(XC, sh, vb)) {
      qShape.push(sh);
      qC.push({ GD: sh.GD, bb: sh.bb, eo: sh.eo, ex: sh.ex, ...q });
      qB.push({ GD: shB.GD, bb: shB.bb, eo: shB.eo, ex: shB.ex, ...q });
    }
    if (qC.length >= 300000 || si === SC.length - 1) {
      runBatch(name, S, XC, XB, grp, qC, qB, qShape);
      qC = [];
      qB = [];
      qShape = [];
    }
  }
}
function runBatch(name, S, XC, XB, grp, qC, qB, qShape) {
  if (!qC.length) return;
  // a stroke row is walked with the gates on and off (eo), and read three ways: minD and the normal's x and y
  const kinds = (k) =>
    grp.strokeWalk ? [K_STROKE_WALK, K_STROKE_WALK_GX, K_STROKE_WALK_GY] : [KSETS[k].k];
  const kq = (qs) =>
    grp.kernels.flatMap((k) =>
      kinds(k).flatMap((kk) =>
        (grp.strokeWalk ? [true, false] : [null]).flatMap((gate) =>
          qs.map((v) => ({ ...v, k: kk, ...(gate === null ? {} : { eo: gate }) })),
        ),
      ),
    );
  const a = grp.eBase.run(XB.band, XB.curve, kq(qB)),
    b = grp.eCand.run(XC.band, XC.curve, kq(qC));
  const per = grp.strokeWalk ? 6 : 1; // answers per query per kernel
  if (FETCHES)
    for (const plane of ['band', 'curve']) {
      const fa = grp['fBase' + plane].run(XB.band, XB.curve, kq(qB)),
        fb = grp['fCand' + plane].run(XC.band, XC.curve, kq(qC));
      grp.kernels.forEach((k, ki) => {
        const f = res[k].fetch[plane];
        for (let j = 0; j < qC.length * per; j++) {
          const u = fa[ki * qC.length * per + j],
            v = fb[ki * qC.length * per + j];
          f[0] += u;
          f[1] += v;
          if (u !== v) f[2]++;
        }
      });
    }
  let aacRef = null;
  const refOf = () =>
    aacRef ||
    (aacRef = grp.eCand.run(
      XC.band,
      XC.curve,
      qC.map((v) => ({ ...v, k: K_AAC })),
    ));
  grp.kernels.forEach((k, ki) => {
    const r = res[k];
    for (let j = 0; j < qC.length * per; j++) {
      const i = j % qC.length;
      let u = a[ki * qC.length * per + j],
        v = b[ki * qC.length * per + j];
      // A LAYOUT CHANGE (--base-root) is held to the stroke's COVERAGE, not its raw walk: a distance past the
      // stroke's reach (halfW + strokeAaReachEm, where coverage is 0 under any AA) reads as the reach itself, and
      // the boundary normal reads 0 there -- a band that no longer lists a segment beyond the reach changes minD
      // from a far distance to 1e20 and nothing else.
      if (baseRoot && grp.strokeWalk) {
        const n = qC.length,
          gate = Math.floor(j / n) % 2,
          e = qC[i].ePx,
          hw = qC[i].ex[0];
        const cap = Math.fround(
          hw + Math.max(0.25 * (e[0] + e[1]) - hw, 0) + 0.5 * Math.hypot(e[0], e[1]),
        );
        const dA = a[ki * n * per + gate * n + i],
          dB = b[ki * n * per + gate * n + i];
        const kind = Math.floor(j / (2 * n));
        if (kind === 0) {
          u = Math.min(u, cap);
          v = Math.min(v, cap);
        } else {
          if (dA >= cap) u = 0;
          if (dB >= cap) v = 0;
        }
      }
      r.n++;
      if (Object.is(u, v)) continue;
      if (u === v) r.zero++;
      r.diff++;
      const d = Math.abs(u - v);
      if (d > r.maxAbs || Number.isNaN(d)) r.maxAbs = Number.isNaN(d) ? NaN : d;
      r.bucket[d <= 1e-6 ? 0 : d < 1 / 510 ? 1 : 2]++;
      r.where.set(name, (r.where.get(name) || 0) + 1);
      if (REF_AAC && k === 'slug' && grp.defs.includes('MANTLE_AAC')) {
        const ref = refOf()[i],
          eb = Math.abs(u - ref),
          ec = Math.abs(v - ref),
          R = r.ref;
        R.n++;
        R.eBase += eb;
        R.eCand += ec;
        R.mBase = Math.max(R.mBase, eb);
        R.mCand = Math.max(R.mCand, ec);
        if (Math.round(u * 255) !== Math.round(v * 255)) R.level++;
        if (ec < eb) R.better++;
        else if (ec > eb) R.worse++;
      }
      // the exact reference for every move past rounding, and one in 64 of the rest (it is a whole-outline integral)
      if (EXACT && AA_KERNELS.has(k) && qShape[i].range && (d > 1e-6 || (r.diff & 63) === 1)) {
        const E = r.exact,
          ex = exactCoverage(qShape[i], XC.curve, qC[i].c, qC[i].ePx),
          eb = Math.abs(u - ex),
          ec = Math.abs(v - ex);
        E.n++;
        E.eB += eb;
        E.eC += ec;
        E.mB = Math.max(E.mB, eb);
        {
          // by the shape's size in pixels: the error of each side, and how many moved farther by over half a level
          const bb = qShape[i].bb,
            sz = Math.max(bb[2] - bb[0], bb[3] - bb[1]) / qC[i].ePx[0];
          const k2 = sz < 4 ? 0 : sz < 16 ? 1 : sz < 64 ? 2 : 3,
            Z =
              E.bySize ||
              (E.bySize = [0, 1, 2, 3].map(() => ({ n: 0, eB: 0, eC: 0, far: 0, farMax: 0 })));
          Z[k2].n++;
          Z[k2].eB += eb;
          Z[k2].eC += ec;
          if (ec - eb > 1 / 510) Z[k2].far++;
          Z[k2].farMax = Math.max(Z[k2].farMax, ec - eb);
        }
        if (ec > E.mC) {
          E.mC = ec;
          E.mCEx = `${name}@2^${Math.log2(S)} c=(${qC[i].c}) ePx=${qC[i].ePx[0]}: ${u} -> ${v}, exact ${ex.toFixed(6)}`;
        }
        if (ec < eb) E.closer++;
        else if (ec > eb) {
          E.farther++;
          if (ec - eb > E.worseMax) {
            E.worseMax = ec - eb;
            E.worseEx = `${name}@2^${Math.log2(S)} c=(${qC[i].c}) ePx=${qC[i].ePx[0]}: ${u} -> ${v}, exact ${ex.toFixed(6)}`;
          }
        }
        if (
          process.env.DUMP_FARTHER &&
          ec - eb > +process.env.DUMP_FARTHER &&
          (!process.env.DUMP_MINPX ||
            Math.max(qShape[i].bb[2] - qShape[i].bb[0], qShape[i].bb[3] - qShape[i].bb[1]) /
              qC[i].ePx[0] >=
              +process.env.DUMP_MINPX)
        )
          console.log(
            `FARTHER ${k} ${name}@2^${Math.log2(S)} c=${qC[i].c[0]},${qC[i].c[1]} e=${qC[i].ePx[0]} shape ${qShape[i].s}: ${u} -> ${v} exact ${ex}`,
          );
        if (u >= 1 / 510 && ex < 1e-9) {
          E.stray++;
          if (v < 1 / 510) E.strayFixed++;
          E.strayMax = Math.max(E.strayMax, u);
        }
        // ...and the ones the CANDIDATE makes: at or over half a level where the exact coverage is 0 and the base was not
        if (v >= 1 / 510 && u < 1 / 510 && ex < 1e-9) {
          E.strayNew++;
          if (v > E.strayNewMax) {
            E.strayNewMax = v;
            E.strayNewEx = `${name}@2^${Math.log2(S)} c=(${qC[i].c}) ePx=${qC[i].ePx[0]} shape ${qShape[i].s}: ${u} -> ${v}`;
          }
        }
      }
      if (DUMP) {
        const e = qC[i].ePx[0],
          big = grp.strokeWalk && Math.floor(j / (2 * qC.length)) === 0 ? d > 1e-6 * e : d > 1e-6;
        if (big) {
          const rec = {
            k,
            name,
            s: Math.log2(S),
            c: qC[i].c,
            ePx: qC[i].ePx,
            u,
            v,
            shape: qShape[i].s,
          };
          if (grp.strokeWalk) {
            const n = qC.length,
              gate = Math.floor(j / n) % 2,
              kind = Math.floor(j / (2 * n));
            rec.gate = gate;
            rec.kind = kind;
            rec.hwPx = qC[i].ex[0] / e;
            // the distance in pixels; a normal component as it is, beside both sides' distances
            if (kind === 0) rec.dPx = d / e;
            rec.minDPx = [a[ki * n * per + gate * n + i] / e, b[ki * n * per + gate * n + i] / e];
          } else rec.distPx = outlinePx(qShape[i], XC.curve, qC[i].c, qC[i].ePx);
          if (!grp.strokeWalk && qShape[i].range && (AA_KERNELS.has(k) || k === 'gwnSdf'))
            rec.ex = exactCoverage(qShape[i], XC.curve, qC[i].c, qC[i].ePx);
          if (HARD_KERNELS.has(k) && qShape[i].range) {
            const sh = qShape[i];
            if (!sh.segs) sh.segs = decodeSegs(XC.curve, sh.range.begin, sh.range.end);
            rec.inside = pointInFill(sh.segs, qC[i].c[0], qC[i].c[1], sh.eo) ? 1 : 0;
          }
          writeSync(DUMP, JSON.stringify(rec) + '\n');
        }
      }
      if (ORACLE && HARD_KERNELS.has(k) && qShape[i].range) {
        const sh = qShape[i];
        if (!sh.segs) sh.segs = decodeSegs(XC.curve, sh.range.begin, sh.range.end);
        const exact = pointInFill(sh.segs, qC[i].c[0], qC[i].c[1], sh.eo) ? 1 : 0;
        r.judged[u === exact ? 0 : v === exact ? 1 : 2]++;
      }
      // the six largest differences (the first six when they tie)
      const line = `${name}@2^${Math.log2(S)} c=(${qC[i].c}) ePx=${qC[i].ePx[0]}: ${u} -> ${v}`;
      if (r.ex.length < 6) r.ex.push([d, line]);
      else {
        let w = 0;
        for (let e = 1; e < 6; e++) if (r.ex[e][0] < r.ex[w][0]) w = e;
        if (d > r.ex[w][0]) r.ex[w] = [d, line];
      }
    }
  });
}
for (const grp of groups.values()) {
  for (const S of SCALES)
    for (const c of corpus) {
      const text = wrap(c.text, S);
      if (!text) continue;
      const opts = grp.tree ? { gwnTree: true } : {};
      const XC = await load(IC, text, opts);
      const XB = IB ? await load(IB, text, opts) : XC;
      await runOne(c.name, S, XC, XB, grp);
      if (S === 1 && !grp.tree) {
        // the pre-SR19 layout: every walker's no-reject path
        const LC = await load(IC, text, { rayLanes: false });
        const LB = IB ? await load(IB, text, { rayLanes: false }) : LC;
        await runOne(c.name + '(legacy)', S, LC, LB, grp);
      }
      drawings++;
    }
}
let fail = 0;
for (const k of kernels) {
  const r = res[k];
  const okk = r.n > 0 && r.diff === 0;
  if (!okk) fail++;
  console.log(
    `  ${okk ? 'ok' : 'FAIL'} ${k.padEnd(9)} ${r.diff} of ${r.n} queries differ${r.zero ? ` (${r.zero} only in the sign of zero)` : ''}${r.diff ? `, max |d| ${r.maxAbs}` : ''}`,
  );
  if (r.diff)
    console.log(
      `       |d| <= 1e-6: ${r.bucket[0]}; under half an 8-bit level: ${r.bucket[1]}; at or above it: ${r.bucket[2]}`,
    );
  if (REF_AAC && r.ref.n) {
    const R = r.ref;
    console.log(
      `       against AAC's exact area at those ${R.n}: mean |err| base ${(R.eBase / R.n).toExponential(3)}, candidate ${(R.eCand / R.n).toExponential(3)}; max base ${R.mBase.toFixed(4)}, candidate ${R.mCand.toFixed(4)}; closer ${R.better}, farther ${R.worse}; ${R.level} change an 8-bit level`,
    );
  }
  if (EXACT && r.exact.n) {
    const E = r.exact;
    console.log(
      `       against the exact box coverage (f64) at those ${E.n}: mean |err| base ${(E.eB / E.n).toExponential(3)}, candidate ${(E.eC / E.n).toExponential(3)}; max base ${E.mB.toFixed(5)}, candidate ${E.mC.toFixed(5)}; closer ${E.closer}, farther ${E.farther} (by at most ${E.worseMax.toExponential(2)})`,
    );
    console.log(
      `       stray answers (base >= half a level where the exact coverage is 0): ${E.stray}, up to ${E.strayMax.toFixed(4)}; ${E.strayFixed} now under half a level`,
    );
    console.log(
      `       NEW stray answers (candidate >= half a level where the exact coverage is 0, base under it): ${E.strayNew}` +
        (E.strayNew ? `, up to ${E.strayNewMax.toFixed(4)}: ${E.strayNewEx}` : ''),
    );
    if (E.worseEx) console.log(`       farthest move away: ${E.worseEx}`);
    if (E.mCEx) console.log(`       candidate's largest error there: ${E.mCEx}`);
    if (E.bySize)
      console.log(
        "       by the shape's size in pixels: " +
          ['< 4', '4-16', '16-64', '>= 64']
            .map((lbl, q) => {
              const Z = E.bySize[q];
              return `${lbl}: ${Z.n} moved, mean |err| ${(Z.eB / Math.max(1, Z.n)).toExponential(2)} -> ${(Z.eC / Math.max(1, Z.n)).toExponential(2)}, ${Z.far} farther by over half a level (at most ${Z.farMax.toFixed(3)})`;
            })
            .join('; '),
      );
  }
  if (ORACLE && r.diff && HARD_KERNELS.has(k))
    console.log(
      `       against the exact inside test: base right at ${r.judged[0]}, candidate right at ${r.judged[1]}, neither at ${r.judged[2]}`,
    );
  if (FETCHES)
    for (const plane of ['band', 'curve']) {
      const f = r.fetch[plane];
      console.log(
        `       ${plane} fetches: base ${f[0]}, candidate ${f[1]} (${f[1] === f[0] ? 'same' : ((f[1] / f[0] - 1) * 100).toFixed(2) + '%'}), ${f[2]} queries differ in count`,
      );
    }
  if (r.diff) {
    console.log(
      `       where: ${[...r.where]
        .sort((p, q) => q[1] - p[1])
        .slice(0, 8)
        .map(([n, m]) => `${n} ${m}`)
        .join(', ')}`,
    );
    for (const e of r.ex.sort((p, q) => q[0] - p[0])) console.log(`       ${e[1]}`);
  }
}
console.log(
  `  (${drawings} drawing-scale runs over ${[...groups.values()].length} define set(s)${extraDefs.length ? ` + ${extraDefs.join(',')}` : ''}, scales ${SCALES.map((s) => '2^' + Math.log2(s)).join(' ')}${RASTER.length ? `, rasters ${RASTER.join(',')}` : ''}; ${((Date.now() - t0) / 1000).toFixed(1)} s)`,
);
if (fail) {
  console.log('KERNEL-IDENTITY FAIL');
  process.exit(1);
}
console.log('KERNEL-IDENTITY PASS');
