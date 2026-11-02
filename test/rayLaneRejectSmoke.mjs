// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// rayLaneRejectSmoke — the crossing-axis lanes change no answer, and skip what they should.
//
// A FILL-only band structure writes each segment's (min, max) on the list's crossing axis -- y for an H
// list (stripe, pair and AAC level lists), x for a V list -- into its band entries' z/w lanes, and says so
// in bit 0 of every band header's texel 1 .y (svg/textures.js BAND_HDR_RAY_LANES). Every fill walker --
// band-hard's ray and the exact walk's stripe, pair and level lists (AAC's, and Slug's) -- then skips an
// entry whose range misses its ray (the exact walk: its cell) before it fetches the segment. A skip is only allowed where the entry's
// contribution is exactly zero, so every answer must be the one the walk gives without it. Pinned:
//
//   (a) the encoding: every header of every fill structure carries the bit; a line's, quad's or cubic's
//       lanes ARE the min and max of its curve texels on the crossing axis, an arc's contain its sampled
//       extent; stroke structures keep (far bound, 0); a legacy import (`rayLanes: false`) is the pre-lane
//       layout, and differs from the lane import in nothing but the lanes and the bit;
//   (b) the CPU walker (hitTest/bandWinding.js, the shader's port) with the reject and without it, over
//       synthetic lines, quads, cubics and arcs, even-odd rings, a cubic loop and the tracked corpus, at
//       2^-20, 1 and 2^20, on a grid plus rays through every control coordinate: the walk's whole STATE
//       (xcov, ycov, xwgt, ywgt, slH, slV) and its coverage identical everywhere; the skip rate printed;
//   (c) the version gate: a legacy bundle reads exactly as the lane bundle does, and the reject takes
//       nothing from it;
//   (d) the float32 emulation of the shipped shader text (test/_glslEmu.mjs): Slug's renderFill, AAC and
//       band-hard, shipped vs the reject compiled out (probes/rayLanes/noRayReject.arms.json's replacement),
//       identical at every query, at a normal and a few-pixel size, and the legacy bundle identical
//       through the shipped text;
//   (e) non-vacuity: a reject one comparison too eager (the CPU port, band-hard's rayLaneMiss, the exact walk's
//       aacLaneMiss) and lanes built from the TIGHT box instead of the control hull are each caught;
//   (f) a morph composed from lane bundles carries the bit on no structure any of its rows reference.
import {
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  cpSync,
  rmSync,
  mkdtempSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, fillShapes, K_AAC, K_HARD, K_SLUG, AAC_HARD } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const T0 = Date.now();
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const { BAND_HDR_RAY_LANES } = await import('../src/svg/textures.js');
const { buildMorphPlan, composeMorphSections } = await import('../src/core/morphCore.js');
const BW_SRC = readFileSync(path.join(ROOT, 'src/hitTest/bandWinding.js'), 'utf8');
const loadBw = (src) =>
  import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const BW = await loadBw(BW_SRC);

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const TEX_W = 4096;

// ---- the corpus ------------------------------------------------------------------------------------------------
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
  // integer and half-integer vertices, so rays through pixel centers run exactly through them
  lattice: svg(
    '0 0 64 64',
    '<path d="M4.5 4.5 H 30.5 V 20 L 40.5 20.5 L 40.5 40.5 Q 30 60.5 4.5 40.5 Z M10.5 10.5 V 30.5 H 20.5 Z"/>' +
      '<rect x="44" y="4.5" width="15.5" height="20" rx="4" ry="6"/><path d="M44 30 C 44 60 60 30 60 60 L 44 60 Z"/>',
  ),
  // a glyph-like outline, quads only, with a counter
  glyph: svg(
    '0 0 100 100',
    '<path d="M20 90 L 45 10 Q 50 5 55 10 L 80 90 L 68 90 L 61 68 L 39 68 L 32 90 Z M 42 58 L 58 58 L 50 30 Z"/>',
  ),
};
const corpus = Object.entries(SYNTH).map(([name, text]) => ({ name, text, synth: true }));
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
const examples = readDir(path.join(ROOT, 'examples'));
const smokeSvgs = readDir(path.join(ROOT, 'examples/smoke'));
const bench = readDir(path.join(ROOT, 'examples/_bench'));
corpus.push(...examples, ...bench, ...smokeSvgs);
const TIGER = corpus.find((c) => c.name === 'examples/tiger.svg');
if (!TIGER)
  console.log(
    '  (examples/tiger.svg absent -- `npm run fetch:fixtures`; the rest of the corpus still runs)',
  );

// Wrap a drawing in scale(S) with its viewBox scaled to match (importerScaleInvariantSmoke's wrapper), or null
// when it has no box to scale.
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
async function load(text, opts = {}, imp = importSvg) {
  try {
    const b = await imp(text, { preserveViewport: true, ...opts });
    if (!b || !b.bands) return null;
    // A group row carries the group's opacity as its fill alpha and NO structure (glyphLoc 0, band counts 1 x 1): it
    // points at the first shape's headers, which no walker reads through it. Every structure the encoder writes has
    // at least four H bands (pickBandsAxis), so a row with one is not a fill shape.
    return {
      b,
      band: new Float32Array(b.bands),
      curve: new Float32Array(b.curves),
      shapes: fillShapes(b, parseMetaBin, M).filter((sh) => sh.GD[3] >= 1),
      meta: parseMetaBin(b.meta, b.metaFloatsPerShape),
    };
  } catch {
    return null;
  }
}

// ---- a structure, decoded ----------------------------------------------------------------------------------------
function structure(band, GD) {
  const g = GD[1] * TEX_W + GD[0],
    bandsX = GD[2] + 1,
    bandsY = GD[3] + 1;
  const at = (t, c) => band[(g + t) * 4 + c];
  const lvSlot = (at(1, 1) | 0) & ~1,
    nLv = at(1, 2) | 0,
    lFirst = at(1, 3) | 0;
  const slots = [];
  for (let b = 0; b < bandsY; b++) slots.push({ slot: b * 2, h: true });
  for (let b = 0; b < bandsX; b++) slots.push({ slot: (bandsY + b) * 2, h: false });
  for (let l = Math.max(lFirst, 1), k = 0; nLv > 0 && l <= nLv; l++)
    for (let b = 0; b < (bandsY + (1 << l) - 1) >> l; b++, k++)
      slots.push({ slot: lvSlot + k * 2, h: true });
  return slots.map(({ slot, h }) => {
    const n = [0, 1, 2, 3].map((c) => at(slot, c) | 0),
      arr = at(slot + 1, 0) | 0,
      flag = (at(slot + 1, 1) | 0) & BAND_HDR_RAY_LANES;
    const entries = [];
    for (let type = 0, k = 0; type < 4; type++)
      for (let i = 0; i < n[type]; i++, k++)
        entries.push({
          type,
          texel: g + arr + k,
          loc: at(arr + k, 0) | 0,
          brk: at(arr + k, 1),
          z: at(arr + k, 2),
          w: at(arr + k, 3),
        });
    return { h, flag, hdrTexel: g + slot + 1, entries };
  });
}
// A segment's coordinates on one axis (0 = x, 1 = y), from its curve texels -- the floats the walkers read.
function ctrl(curve, loc, type, ax) {
  const t = (k, c) => curve[(loc + k) * 4 + c];
  if (type === 0) return [t(1, ax), t(1, 2 + ax)];
  if (type === 1) return [t(1, ax), t(1, 2 + ax), t(2, ax)];
  if (type === 2) return [t(1, ax), t(1, 2 + ax), t(2, ax), t(2, 2 + ax)];
  // an arc: its sampled extent in float64 from the float32 record (d1 = cx, cy, rx, ry; d2 = th0, th1, phi)
  const cx = t(1, 0),
    cy = t(1, 1),
    rx = t(1, 2),
    ry = t(1, 3),
    th0 = t(2, 0),
    th1 = t(2, 1),
    phi = t(2, 2);
  const lo = Math.min(th0, th1),
    hi = Math.min(Math.max(th0, th1), lo + 2 * Math.PI),
    out = [];
  for (let k = 0; k <= 720; k++) {
    const th = lo + ((hi - lo) * k) / 720;
    out.push(
      ax === 0
        ? cx + Math.cos(phi) * rx * Math.cos(th) - Math.sin(phi) * ry * Math.sin(th)
        : cy + Math.sin(phi) * rx * Math.cos(th) + Math.cos(phi) * ry * Math.sin(th),
    );
  }
  return out;
}
const strokeRows = (X) => {
  const F = X.meta.metaFloats,
    st = X.meta.floatsPerShape,
    out = [];
  for (let s = 0; s < X.b.numShapes; s++) {
    const o = s * st;
    if (
      F[o + M.META_STROKE_W] > 0 &&
      !(F[o + M.META_FILL_A] > 0) &&
      (F[o + M.META_BAND_MAX_Y] | 0) >= 1
    )
      out.push([
        F[o + M.META_GLYPH_LOC_X] | 0,
        F[o + M.META_GLYPH_LOC_Y] | 0,
        F[o + M.META_BAND_MAX_X] | 0,
        F[o + M.META_BAND_MAX_Y] | 0,
      ]);
  }
  return out;
};

// ---- queries ------------------------------------------------------------------------------------------------------
// A grid over the shape (and a margin), plus rays through its control coordinates: a vertex on the ray is where "0
// counts as non-negative" decides a crossing, so that is where a reject that is one comparison off shows.
function queries(X, sh, G = 10, R = 16) {
  const [x0, y0, x1, y1] = sh.bb,
    ext = Math.max(x1 - x0, y1 - y0) || Math.max(Math.abs(x0), Math.abs(y0), 1);
  const px = 48 / ext;
  const gx = (i, n) => x0 - 0.05 * ext + ((i + 0.37) / n) * (x1 - x0 + 0.1 * ext);
  const gy = (j, n) => y0 - 0.05 * ext + ((j + 0.61) / n) * (y1 - y0 + 0.1 * ext);
  const pts = [];
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) pts.push([gx(i, G), gy(j, G)]);
  const xs = new Set(),
    ys = new Set();
  for (const hd of structure(X.band, sh.GD))
    for (const e of hd.entries) {
      if (e.type === 3) continue;
      for (const v of ctrl(X.curve, e.loc, e.type, 0)) xs.add(v);
      for (const v of ctrl(X.curve, e.loc, e.type, 1)) ys.add(v);
    }
  const pick = (set) => {
    const a = [...set].sort((p, q) => p - q);
    if (a.length <= R) return a;
    return Array.from({ length: R }, (_, k) => a[Math.floor((k * (a.length - 1)) / (R - 1))]);
  };
  for (const y of pick(ys)) for (let i = 0; i < 6; i++) pts.push([gx(i, 6), y]);
  for (const x of pick(xs)) for (let j = 0; j < 6; j++) pts.push([x, gy(j, 6)]);
  return { px, pts };
}
const newStats = () => ({
  test: [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  skip: [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
});
const addStats = (a, b) => {
  for (let p = 0; p < 2; p++)
    for (let t = 0; t < 4; t++) {
      a.test[p][t] += b.test[p][t];
      a.skip[p][t] += b.skip[p][t];
    }
};
const sameState = (a, b) => a.every((v, i) => Object.is(v, b[i]));
// The CPU walker over one bundle: (reject on, walker bw) vs (reject off, the shipped port). Returns
// { n, diff, stats }; `other` runs the reject-on side over a different bundle with the same layout (the version gate).
function cpuCompare(X, bw = BW, { other = null, base = BW } = {}) {
  let n = 0,
    diff = 0;
  const stats = newStats(),
    sa = new Array(6),
    sb = new Array(6);
  for (const sh of X.shapes) {
    const { px, pts } = queries(X, sh);
    const Y = other || X;
    for (const [x, y] of pts) {
      const a = bw.bandFillCoverage(Y.band, Y.curve, sh.GD, sh.bb, x, y, px, px, sh.eo, {
        stats,
        state: sa,
      });
      const b = base.bandFillCoverage(X.band, X.curve, sh.GD, sh.bb, x, y, px, px, sh.eo, {
        rayReject: false,
        state: sb,
      });
      n++;
      if (!Object.is(a, b) || !sameState(sa, sb)) diff++;
    }
  }
  return { n, diff, stats };
}
const rate = (s, p, t) => {
  const T = t == null ? s.test[p].reduce((a, v) => a + v, 0) : s.test[p][t],
    K = t == null ? s.skip[p].reduce((a, v) => a + v, 0) : s.skip[p][t];
  return T ? `${((100 * K) / T).toFixed(1)}% of ${T}` : 'none';
};

// ---- (a) + (b) + (c): the encoding and the CPU walker --------------------------------------------------------------
console.log(
  '(a) the encoding  (b) the CPU walker with and without the reject  (c) the version gate',
);
const SCALES = [2 ** -20, 1, 2 ** 20];
const total = newStats(),
  tigerStats = newStats();
let files = 0,
  importFailed = 0,
  queriesRun = 0,
  cpuDiff = 0;
let encBad = 0,
  encChecked = 0,
  arcChecked = 0,
  strokeBad = 0,
  strokeChecked = 0;
let legacyBad = 0,
  legacyLayoutBad = 0,
  legacyChecked = 0,
  legacyDiff = 0,
  legacySkips = 0,
  legacyN = 0;
const perScale = SCALES.map(() => ({ n: 0, diff: 0 }));
for (const [si, S] of SCALES.entries()) {
  for (const [ci, c] of corpus.entries()) {
    // every drawing at scale 1; at 2^-20 and 2^20 the synthetic set, examples/ and every fourth smoke asset
    if (S !== 1 && !c.synth && c.name.startsWith('examples/smoke/') && ci % 4 !== 0) continue;
    const text = wrap(c.text, S);
    if (!text) continue;
    const X = await load(text);
    if (!X) {
      if (S === 1) importFailed++;
      continue;
    }
    if (S === 1) files++;
    const r = cpuCompare(X);
    perScale[si].n += r.n;
    perScale[si].diff += r.diff;
    queriesRun += r.n;
    cpuDiff += r.diff;
    if (S === 1) {
      addStats(total, r.stats);
      if (c === TIGER) addStats(tigerStats, r.stats);
    }
    if (process.env.DEBUG && r.diff) console.log(`   ${c.name} @${S}: ${r.diff} of ${r.n} differ`);
    if (S !== 1) continue;
    // (a) the lanes, entry by entry
    for (const sh of X.shapes)
      for (const hd of structure(X.band, sh.GD)) {
        if (!hd.flag) {
          encBad++;
          continue;
        }
        for (const e of hd.entries) {
          const v = ctrl(X.curve, e.loc, e.type, hd.h ? 1 : 0);
          const lo = Math.min(...v),
            hi = Math.max(...v);
          encChecked++;
          const bad = e.type === 3 ? !(e.z <= lo && e.w >= hi) : !(e.z === lo && e.w === hi);
          if (e.type === 3) arcChecked++;
          if (bad) {
            encBad++;
            if (process.env.DEBUG)
              console.log(
                `   lane ${c.name} type ${e.type} ${hd.h ? 'H' : 'V'} z ${e.z} w ${e.w} vs ${lo} ${hi}`,
              );
          }
        }
      }
    for (const GD of strokeRows(X))
      for (const hd of structure(X.band, GD)) {
        strokeChecked++;
        if (hd.flag || hd.entries.some((e) => e.w !== 0)) strokeBad++;
      }
    // (c) the legacy layout of the same drawing (the synthetic set, examples/ and the local bench corpus)
    if (!c.name.startsWith('examples/smoke/')) {
      const L = await load(text, { rayLanes: false });
      if (!L) {
        legacyBad++;
        continue;
      }
      legacyChecked++;
      if (L.band.length !== X.band.length || L.shapes.length !== X.shapes.length) {
        legacyLayoutBad++;
        continue;
      }
      // bit for bit the same plane but for the lanes and the header bit
      const laneFloats = new Set();
      for (const sh of X.shapes)
        for (const hd of structure(X.band, sh.GD)) {
          laneFloats.add(hd.hdrTexel * 4 + 1);
          for (const e of hd.entries) {
            laneFloats.add(e.texel * 4 + 2);
            laneFloats.add(e.texel * 4 + 3);
          }
        }
      let odd = 0;
      for (let i = 0; i < X.band.length; i++) {
        if (laneFloats.has(i)) continue;
        if (!Object.is(X.band[i], L.band[i])) odd++;
      }
      // ...where the legacy header holds the lane header's .y without the bit, and every entry (z, 0)
      for (const sh of L.shapes)
        for (const hd of structure(L.band, sh.GD)) {
          if (hd.flag || hd.entries.some((e) => e.w !== 0)) odd++;
          if (
            L.band[hd.hdrTexel * 4 + 1] !==
            ((X.band[hd.hdrTexel * 4 + 1] | 0) & ~BAND_HDR_RAY_LANES)
          )
            odd++;
        }
      if (
        odd ||
        L.curve.length !== X.curve.length ||
        !L.curve.every((v, i) => Object.is(v, X.curve[i]))
      )
        legacyLayoutBad++;
      // the legacy bundle, WITH the reject asked for, against the lane bundle without it: the same walk
      const g = cpuCompare(X, BW, { other: L });
      legacyN += g.n;
      legacyDiff += g.diff;
      legacySkips += g.stats.skip.flat().reduce((a, v) => a + v, 0);
    }
  }
}
ok(
  files > 100 && importFailed < files / 10,
  `${files} drawings imported (${importFailed} would not import and are not counted)`,
);
ok(
  encChecked > 10000 && encBad === 0,
  `(a) every fill header carries the bit and every entry's lanes are its control hull on the crossing axis (${encChecked} entries, ${arcChecked} arcs contain their sampled extent; ${encBad} wrong)`,
);
ok(
  strokeChecked > 50 && strokeBad === 0,
  `(a) stroke structures keep (far bound, 0) with the bit clear (${strokeChecked} bands; ${strokeBad} wrong)`,
);
ok(
  legacyChecked > 20 && legacyBad === 0 && legacyLayoutBad === 0,
  `(a) a legacy import (rayLanes: false) is the lane import but for the lanes and the bit, with (far, 0) everywhere (${legacyChecked} drawings; ${legacyBad + legacyLayoutBad} differ)`,
);
SCALES.forEach((S, i) =>
  ok(
    perScale[i].n > 1000 && perScale[i].diff === 0,
    `(b) at scale 2^${Math.log2(S)}, the walk's state and coverage are identical with and without the reject at ${perScale[i].n} queries (${perScale[i].diff} differ)`,
  ),
);
ok(
  legacyN > 1000 && legacyDiff === 0 && legacySkips === 0,
  `(c) a legacy bundle reads as the lane bundle does at ${legacyN} queries (${legacyDiff} differ), the reject skipping ${legacySkips} of its entries`,
);
const typeNames = ['line', 'quad', 'cubic', 'arc'];
console.log(
  `  skip rate, scale 1, the whole corpus (entries past the break that the lanes reject): H ${rate(total, 0)}, V ${rate(total, 1)}`,
);
for (let t = 0; t < 4; t++)
  console.log(`    ${typeNames[t].padEnd(5)}  H ${rate(total, 0, t)}   V ${rate(total, 1, t)}`);
if (TIGER)
  console.log(`  skip rate, tiger.svg: H ${rate(tigerStats, 0)}, V ${rate(tigerStats, 1)}`);
ok(
  total.skip[0].reduce((a, v) => a + v, 0) > 0 && total.skip[1].reduce((a, v) => a + v, 0) > 0,
  '(b) the reject is not vacuous: it skips entries on both rays',
);

// ---- (d) the shader text, emulated ---------------------------------------------------------------------------------
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const HINGE = 'bool fillRayReject(vec4 hdr1) { return bandHasRayLanes(hdr1); }';
const RAY_MISS = 'bool rayLaneMiss(vec4 e, float r) { return e.w - r < 0.0 || e.z - r >= 0.0; }';
const AAC_MISS = 'return max(a, b) < q0 - AAC_LANE_SLACK || min(a, b) > q1 + AAC_LANE_SLACK;';
const once = (t, s) => t.split(s).length === 2;
ok(
  once(GLSL, HINGE) && once(GLSL, RAY_MISS) && once(GLSL, AAC_MISS),
  "(d) the shader's reject hinges are present, once each (fillRayReject, rayLaneMiss, aacLaneMiss)",
);
if (!hasCxx())
  console.log('  SKIP (d) and the shader half of (e): no C++ compiler ($CXX, clang++, g++, c++)');
else {
  const variant = (from, to) => GLSL.split(from).join(to);
  const eShip = buildGlslEmu(ROOT, { defines: AAC_HARD });
  const eOff = buildGlslEmu(ROOT, {
    defines: AAC_HARD,
    glsl: variant(HINGE, 'bool fillRayReject(vec4 hdr1) { return false; }'),
  });
  const eRay = buildGlslEmu(ROOT, {
    defines: AAC_HARD,
    glsl: variant(RAY_MISS, RAY_MISS.replace('e.w - r < 0.0', 'e.w - r <= 0.0')),
  });
  const eAac = buildGlslEmu(ROOT, {
    defines: AAC_HARD,
    glsl: variant(AAC_MISS, AAC_MISS.replace('q0 - AAC_LANE_SLACK', 'q0 + 0.125')),
  });
  const KS = [
    [K_SLUG, 'Slug'],
    [K_AAC, 'AAC'],
    [K_HARD, 'band-hard'],
  ];
  const emuSet = corpus.filter(
    (c) => c.synth || c === TIGER || c.name.startsWith('examples/_') || bench.includes(c),
  );
  const diff = (a, b) => a.reduce((n, v, i) => n + (Object.is(v, b[i]) ? 0 : 1), 0);
  const res = {
    n: 0,
    off: [0, 0, 0],
    ray: [0, 0, 0],
    aac: [0, 0, 0],
    legacy: [0, 0, 0],
    legacyN: 0,
  };
  for (const S of SCALES)
    for (const c of emuSet) {
      const text = wrap(c.text, S);
      if (!text) continue;
      const X = await load(text);
      if (!X || !X.shapes.length) continue;
      const L = S === 1 ? await load(text, { rayLanes: false }) : null;
      const qs = [];
      for (const sh of X.shapes) {
        const { px, pts } = queries(X, sh, 8, 12);
        // at the drawing's own size and at a few pixels across (AAC walks its levels and straddles there)
        for (const scale of [1, 1 / 16])
          for (const [x, y] of pts)
            qs.push({
              GD: sh.GD,
              bb: sh.bb,
              eo: sh.eo,
              c: [x, y],
              ePx: [1 / (px * scale), 1 / (px * scale)],
            });
      }
      res.n += qs.length;
      // the three kernels in one emulator run per variant, in thirds
      const q = KS.flatMap(([k]) => qs.map((v) => ({ ...v, k })));
      const third = (arr, i) => arr.subarray(i * qs.length, (i + 1) * qs.length);
      const ship = eShip.run(X.band, X.curve, q),
        off = eOff.run(X.band, X.curve, q);
      const ray = eRay.run(X.band, X.curve, q),
        aac = eAac.run(X.band, X.curve, q);
      const leg = L && L.band.length === X.band.length ? eShip.run(L.band, L.curve, q) : null;
      if (leg) res.legacyN += qs.length;
      KS.forEach((_, i) => {
        const s0 = third(ship, i);
        res.off[i] += diff(s0, third(off, i));
        res.ray[i] += diff(s0, third(ray, i));
        res.aac[i] += diff(s0, third(aac, i));
        if (leg) res.legacy[i] += diff(s0, third(leg, i));
      });
    }
  KS.forEach(([, name], i) =>
    ok(
      res.n > 10000 && res.off[i] === 0,
      `(d) ${name}: the shipped shader equals it with the reject compiled out at ${res.n} queries over 2^-20, 1 and 2^20 (${res.off[i]} differ)`,
    ),
  );
  KS.forEach(([, name], i) =>
    ok(
      res.legacyN > 1000 && res.legacy[i] === 0,
      `(d) ${name}: a legacy bundle through the shipped shader reads as the lane bundle at ${res.legacyN} queries (${res.legacy[i]} differ)`,
    ),
  );
  // Slug's renderFill walks with aacLaneMiss (it is AAC's walk), so the ray reject's reader is band-hard
  ok(
    res.ray[2] > 0,
    `(e) rayLaneMiss one comparison too eager (max - r <= 0) is caught: band-hard ${res.ray[2]} differ (Slug ${res.ray[0]}: its walk no longer reads it)`,
  );
  ok(
    res.aac[0] > 0,
    `(e) ...and aacLaneMiss too eager is caught through Slug's renderFill as well: ${res.aac[0]} differ`,
  );
  ok(
    res.aac[1] > 0,
    `(e) aacLaneMiss rejecting an eighth of a cell into the window is caught: AAC ${res.aac[1]} differ`,
  );
}

// ---- (e) the CPU port and the encoder, mutated ---------------------------------------------------------------------
{
  const PORT_FROM = 'const miss = (e) => bandF[e + 3] - ray < 0 || bandF[e + 2] - ray >= 0;';
  ok(once(BW_SRC, PORT_FROM), "(e) the port's reject hinge is present once");
  const eager = await loadBw(
    BW_SRC.split(PORT_FROM).join(PORT_FROM.replace('- ray < 0', '- ray <= 0')),
  );
  let d = 0;
  for (const c of corpus.filter((x) => x.synth)) {
    const X = await load(c.text);
    if (X) d += cpuCompare(X, eager).diff;
  }
  ok(
    d > 0,
    `(e) the port's reject one comparison too eager (max - r <= 0) is caught at ${d} queries`,
  );

  const TEX = readFileSync(path.join(ROOT, 'src/svg/textures.js'), 'utf8');
  const ENC_FROM =
    'const laneF = rayLanes ? controlHullLanes(segs, segTypes, segBbsF, arcPadX, arcPadY) : null;';
  if (!once(TEX, ENC_FROM)) ok(false, "(e) the encoder's lane hinge is present once");
  else {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'rayLaneReject-'));
    try {
      cpSync(path.join(ROOT, 'src'), path.join(tmp, 'src'), { recursive: true });
      writeFileSync(
        path.join(tmp, 'src/svg/textures.js'),
        TEX.split(ENC_FROM).join('const laneF = rayLanes ? segBbsF : null;'),
      );
      const tightImport = (await import(path.join(tmp, 'src/svg/importer.js'))).default;
      // WHAT THE MUTANT CHANGES IS A TOUCH. A ray through the control hull but past the curve's tight box either misses the curve or
      // grazes it at an extremum, where the solvers return a PAIR of crossings at one point with opposite signs: no net crossing, but
      // two ramp weights, which is the only thing the walk with the reject on and the walk with it off could disagree about. Since
      // the walker drops an exactly coincident opposite-sign pair whole, so the mutant is equal BY CONSTRUCTION on the shipped
      // walker (0 queries differ; the measure that the tight lanes lose nothing the walk counts). The witness for the lane hinge is
      // therefore the walker with that cancel compiled out, on which the touch weights are visible again.
      const CANCEL = 'pend[5 * j + 1] === pend[5 * i + 1] && pend[5 * j + 2] === -pend[5 * i + 2]';
      ok(once(BW_SRC, CANCEL), "(e) the walker's coincident-pair cancel hinge is present once");
      const noCancel = await loadBw(BW_SRC.split(CANCEL).join('false'));
      let dt = 0,
        dtShipped = 0;
      for (const name of ['quadStar', 'cubicStar', 'glyph', 'loop']) {
        const X = await load(SYNTH[name], {}, tightImport);
        if (X) {
          dt += cpuCompare(X, noCancel, { base: noCancel }).diff;
          dtShipped += cpuCompare(X).diff;
        }
      }
      ok(
        dt > 0,
        `(e) lanes from the curve's TIGHT box instead of its control hull are caught at ${dt} queries on the walker without the coincident-pair cancel (a ray through the hull but past the curve still reaches the solvers: its touch weights)`,
      );
      ok(
        dtShipped === 0,
        `(e) on the shipped walker the tight-lane mutant changes nothing the walk counts (${dtShipped} differ): the touches it skips are canceled pairs`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// ---- (f) a morph --------------------------------------------------------------------------------------------------
{
  const asBundle = (b) => ({
    ...b,
    metaFloats: new Float32Array(b.meta, 32),
    curveFloats: new Float32Array(b.curves),
    shapeIds: b.shapeIds || [],
  });
  const pose = (dx, extra) =>
    svg(
      '0 0 200 128',
      `<path id="a" d="${star('Q', 9, 64 + dx, 64, 40, 62)}"/><path id="b" d="${star('C', 7, 140, 64 - dx, 30, 50)}"/>${extra}`,
    );
  const src = asBundle(
    await importSvg(pose(0, `<path id="only" d="${poly(24, 170, 110, 12)}"/>`), {
      preserveViewport: true,
    }),
  );
  const dst = asBundle(await importSvg(pose(12, ''), { preserveViewport: true }));
  const lanesIn = (b) => {
    let n = 0;
    for (const sh of fillShapes(b, parseMetaBin, M))
      for (const hd of structure(new Float32Array(b.bands), sh.GD)) n += hd.flag;
    return n;
  };
  const before = lanesIn(src);
  const morph = composeMorphSections(src, dst, buildMorphPlan(src, dst));
  const pm = parseMetaBin(morph.meta, morph.metaFloatsPerShape),
    MF = pm.metaFloats,
    mband = new Float32Array(morph.bands);
  let rows = 0,
    withBit = 0;
  for (let s = 0; s < pm.numShapes; s++) {
    const o = s * pm.floatsPerShape;
    if (
      (MF[o + M.META_BAND_MAX_Y] | 0) < 0 ||
      !(MF[o + M.META_FILL_A] > 0 || MF[o + M.META_STROKE_W] > 0)
    )
      continue;
    const GD = [
      MF[o + M.META_GLYPH_LOC_X] | 0,
      MF[o + M.META_GLYPH_LOC_Y] | 0,
      MF[o + M.META_BAND_MAX_X] | 0,
      MF[o + M.META_BAND_MAX_Y] | 0,
    ];
    rows++;
    // and every entry holds the base layout: (far bound, 0) -- the cleared lists an inert far bound (-FLT_MAX)
    for (const hd of structure(mband, GD)) {
      withBit += hd.flag;
      if (hd.entries.some((e) => e.w !== 0)) withBit++;
    }
  }
  ok(
    before > 0 && rows >= 3 && withBit === 0,
    `(f) a morph of lane bundles (${before} lane headers in src) carries the bit on none of the ${rows} rows' structures, and (z, 0) in every entry (${withBit} wrong)`,
  );
  ok(lanesIn(src) === before, "(f) ...and leaves its source bundle's bands as they were");
}

console.log(`  (${queriesRun} CPU queries, ${((Date.now() - T0) / 1000).toFixed(1)} s)`);
if (fail) {
  console.error(`RAY-LANE-REJECT FAIL (${fail})`);
  process.exit(1);
}
console.log('RAY-LANE-REJECT PASS');
