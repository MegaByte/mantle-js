// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bandDiscriminatorSmoke — the band discriminator: wrong solid pixels shared by Slug and AAC but not by
// Loop-Blinn are in the band data or the shared walk, and a BAND-HARD arm (the same bands with no AA) tells
// the two apart: "if band-hard also shows them it is the band data; if band-hard is clean it is the shared AA tail."
//
// The original illustration is not in this repository. Set MANTLE_LOCAL_SVG to an optional
// local SVG to score it too. `examples/smoke/bandDiscriminatorTwin__SVG.svg` is a structural twin
// (same shape class, none of that artwork) and is what runs by default.
//
// RUN AGAINST THE exact FILL ORACLE, with the shipped shader text in float32 (test/_glslEmu.mjs),
// at 512 and 1024, over every solid-interior pixel center of every fill shape: slug, aac and band-hard
// must all read 0 wrong. The shape class: 7 meta rows and 22 segments, every filled subpath closed by
// the importer (the two open ones close to a gap of exactly 0), and two straight strokes with ROUND
// caps under a reflecting matrix(1, 0, 0, -1, ..).
//
// THE STROKE ROWS, the second half of this file, are held to the exact SVG 2 stroke shape
// (`test/_strokeShapeRef.mjs` svgInside) through everything the renderer reaches for one stroke
// pixel — the baked cover quad, the H band picked through the META bbox, the walk's break/far/saturation
// gates and the shipped line branch (`test/_strokeBandEmu.mjs`): 0 unpainted and 0 painted outside.
// The instrument is LIVE on those mechanisms: reading the cap as BUTT, reading it as SQUARE, and
// dropping the segment from one band each move it, by more than 808 px at 1024.
//
// The asset is also scored as `probes/_zzEnginePaint.mjs` imports it (that probe STRIPS strokes unless
// KEEPSTROKES=1); the stripped bundle must score identically.
//
// THE OCCUPANCY GRID. A page that waits a few frames draws with the interior-skip grid's bits, which are
// built off thread. A grid built from the path AS AUTHORED would certify cells past an open filled
// subpath's closing chord and the skip would paint them solid under Slug, AAC, band-hard and GWN alike,
// while Loop-Blinn builds its own mesh. The `occ` arm below lands the grid and must read 0 too;
// test/openSubpathOccupancySmoke.mjs pins the mechanism.
//
// WHAT this PINS. If band membership (src/svg/textures.js), the `.z` maxX prune or any bounded loop
// drops a segment on this shape class, band-hard moves and the other two do not — which is the
// discriminator doing its job — and if a cap, a pad, a reach or a band drops a stroke pixel on it,
// the stroke half moves.

import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, fillShapes, K_HARD, K_AAC, K_SLUG, AAC_HARD } from './_glslEmu.mjs';
import { strokeRowsOf, makeStrokeEmu } from './_strokeBandEmu.mjs';
import { svgInside } from './_strokeShapeRef.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP bandDiscriminatorSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { contoursToConverter } = await import('../src/renderer/cpatchBuild.js');
const { rowSpans } = await import('../src/renderer/cpatchConvert.js');
const { buildOccupancyGrid } = await import('../src/svg/occupancy.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// Slug and band-hard compile from one define set; AAC needs its own.
const emuSlug = buildGlslEmu(ROOT, { defines: ['MANTLE_HARD'] });
const emuAac = buildGlslEmu(ROOT, { defines: AAC_HARD });
// NON-VACUITY: the same instrument with renderFillHardBand's break-early prune made one em too
// eager, which is the shape of every "the band walk lost a segment" defect. If a zero here cannot
// be moved by that, a zero means nothing.
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const HB = GLSL.indexOf('float renderFillHardBand(');
const HB_END = GLSL.indexOf('\n}\n', HB);
const MUT =
  GLSL.slice(0, HB) +
  GLSL.slice(HB, HB_END)
    .split('if (segRaw.y < c.x) break;')
    .join('if (segRaw.y < c.x + 1.0) break;') +
  GLSL.slice(HB_END);
const emuBlind = buildGlslEmu(ROOT, { defines: ['MANTLE_HARD'], glsl: MUT });
const insideAt = (segs, x, y, eo) => {
  for (const s of rowSpans(segs, y, eo)) if (x >= s[0] && x < s[1]) return 1;
  return 0;
};

/// Wrong SOLID pixel centers per engine, over every fill shape, at N px. `occ` also lands the
/// interior-skip grid the way a page that waits a few frames sees it: each pending job built as
/// src/renderer/occupancyWorkerPool.js builds it, its bits written into the curve plane, and the
/// shader's skip (cell >= 1.5 px on both axes) standing in for the kernel where a set cell covers.
async function score(svg, N, hardEmu = emuSlug, { occ = false } = {}) {
  const b = await importSvg(svg, { preserveViewport: true });
  const shapes = fillShapes(b, parseMetaBin, M);
  const curve = new Float32Array(b.curves),
    band = new Float32Array(b.bands);
  let occCells = 0;
  if (occ)
    for (const p of b.pendingOccupancy || []) {
      const g = buildOccupancyGrid(p.segs, p.bbox, p.evenOdd, { grid: p.G, minInteriorFrac: 0.15 });
      if (g && g.bits)
        for (let i = 0; i < g.bits.length; i++) {
          curve[p.base * 4 + i] = g.bits[i] || 0;
          if (g.bits[i]) occCells++;
        }
    }
  const pmO = parseMetaBin(b.meta, b.metaFloatsPerShape);
  for (const sh of shapes) {
    const cs = contoursToConverter(curveRangeToContours(curve, sh.range.begin, sh.range.end), null);
    sh.segs = cs ? cs.flat() : null;
  }
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of shapes) {
    x0 = Math.min(x0, s.bb[0]);
    y0 = Math.min(y0, s.bb[1]);
    x1 = Math.max(x1, s.bb[2]);
    y1 = Math.max(y1, s.bb[3]);
  }
  const px = Math.max(x1 - x0, y1 - y0) / N;
  const r = {
    slug: 0,
    aac: 0,
    hard: 0,
    tot: 0,
    shapes: shapes.length,
    rows: b.numShapes,
    segs: b.totalSegments,
    openClosed: 0,
    occCells,
  };
  for (const sh of shapes) {
    if (!sh.segs || !sh.segs.length) continue;
    const oO = sh.s * pmO.floatsPerShape,
      oBase = pmO.metaFloats[oO + M.META_SOLID_START] | 0,
      oG = pmO.metaFloats[oO + M.META_SOLID_COUNT] | 0;
    const oW = (sh.bb[2] - sh.bb[0]) / oG,
      oH = (sh.bb[3] - sh.bb[1]) / oG;
    const skipAt = (x, y) => {
      if (!occ || !(oG > 0) || !(oW >= 1.5 * px && oH >= 1.5 * px)) return false;
      const cx = Math.floor((x - sh.bb[0]) / oW),
        cy = Math.floor((y - sh.bb[1]) / oH);
      return cx >= 0 && cy >= 0 && cx < oG && cy < oG && curve[oBase * 4 + cy * oG + cx] > 0.5;
    };
    const i0 = Math.floor((sh.bb[0] - x0) / px) - 2,
      i1 = Math.ceil((sh.bb[2] - x0) / px) + 2;
    const j0 = Math.floor((sh.bb[1] - y0) / px) - 2,
      j1 = Math.ceil((sh.bb[3] - y0) / px) + 2;
    const W = i1 - i0 + 1,
      H = j1 - j0 + 1;
    if (W * H > 6e6) continue;
    const qS = [],
      qH = [],
      qA = [],
      ins = [],
      skip = [];
    for (let j = 0; j < H; j++) {
      const y = y0 + (j0 + j + 0.5) * px;
      for (let i = 0; i < W; i++) {
        const x = x0 + (i0 + i + 0.5) * px,
          c = [x, y],
          a = { GD: sh.GD, bb: sh.bb, eo: sh.eo, c, ePx: [px, px] };
        qS.push({ k: K_SLUG, ...a });
        qH.push({ k: K_HARD, ...a });
        qA.push({ k: K_AAC, ...a });
        ins.push(insideAt(sh.segs, x, y, sh.eo));
        skip.push(skipAt(x, y));
      }
    }
    const rS = emuSlug.run(band, curve, qS),
      rH = hardEmu.run(band, curve, qH),
      rA = emuAac.run(band, curve, qA);
    for (let k = 0; k < skip.length; k++)
      if (skip[k]) {
        rS[k] = 1;
        rH[k] = 1;
        rA[k] = 1;
      }
    for (let j = 1; j < H - 1; j++)
      for (let i = 1; i < W - 1; i++) {
        const k = j * W + i,
          v = ins[k];
        let same = true;
        for (let dj = -1; dj <= 1 && same; dj++)
          for (let di = -1; di <= 1; di++)
            if (ins[(j + dj) * W + i + di] !== v) {
              same = false;
              break;
            }
        if (!same) continue;
        r.tot++;
        if (Math.abs(rS[k] - v) > 0.5) r.slug++;
        if (Math.abs(rA[k] - v) > 0.5) r.aac++;
        if (Math.abs(rH[k] - v) > 0.5) r.hard++;
      }
  }
  // Every filled subpath must arrive closed, or the band walk and the oracle share one wrong answer.
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    F = pm.metaFloats;
  let worstGap = 0;
  for (let s = 0; s < b.numShapes; s++) {
    const o = s * pm.floatsPerShape;
    if (!(F[o + M.META_FILL_A] > 0)) continue;
    const rg = b.curveRangesByShape[s];
    if (!rg) continue;
    for (const c of curveRangeToContours(curve, rg.begin, rg.end)) {
      const f = c[0],
        l = c[c.length - 1];
      const p0 = f.p1 || f.p0 || f.a,
        pN = l.p4 || l.p3 || l.p2 || l.b;
      if (p0 && pN) worstGap = Math.max(worstGap, Math.hypot(p0[0] - pN[0], p0[1] - pN[1]));
    }
  }
  r.openClosed = worstGap;
  return r;
}

// ---- the STROKE half --------------------------------------------------------------------------
// `capAs`/`dropBand` are MUTATIONS of the imported bundle, not of the reference: the exact SVG 2
// shape below is always built from what the artwork says, so a mutated arm is a renderer that has
// lost the cap or the band while the truth stays put. That is the only way a zero here means
// anything — every rule mutation `_strokeShapeRef` offers is INERT on a straight ROUND-capped
// segment with no joins (checked: prefix, squareCapDrop, buttPastEnd, radialOutside, a short far gate and
// indexing the bands through the cover quad's box all leave both rows at 0/0).
function mutate(b, { capAs = null, dropBand = false } = {}) {
  const stride = b.metaFloatsPerShape || 48;
  let out = b;
  if (capAs !== null) {
    const meta = b.meta.slice(0),
      f = new Float32Array(meta, 32);
    for (let i = 0; i * stride < f.length; i++)
      if (f[i * stride + M.META_STROKE_W] > 0) f[i * stride + M.META_CAP_STYLE] = capAs;
    out = { ...out, meta };
  }
  if (dropBand) {
    const bands = out.bands.slice(0),
      bf = new Float32Array(bands),
      mf = new Float32Array(out.meta, 32);
    for (const row of strokeRowsOf(out)) {
      const o = row * stride,
        gl = mf[o + M.META_GLYPH_LOC_Y] * 4096 + mf[o + M.META_GLYPH_LOC_X];
      const nB = (mf[o + M.META_BAND_MAX_Y] | 0) + 1;
      bf[(gl + (nB >> 1) * 2) * 4] = 0; // the middle band lists no LINE segments
    }
    out = { ...out, bands };
  }
  return out;
}

/// Pixel centers the SVG 2 stroke shape owns that the renderer leaves unpainted, and the reverse,
/// over every stroke row, at N px on the same content-bbox fit the fill half uses.
async function scoreStrokes(svg, N, mut = {}) {
  const b = await importSvg(svg, { preserveViewport: true });
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    F = pm.metaFloats,
    FPS = pm.floatsPerShape;
  const curve = new Float32Array(b.curves);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let s = 0; s < b.numShapes; s++) {
    const o = s * FPS;
    x0 = Math.min(x0, F[o + M.META_BBOX_XMIN]);
    y0 = Math.min(y0, F[o + M.META_BBOX_YMIN]);
    x1 = Math.max(x1, F[o + M.META_BBOX_XMAX]);
    y1 = Math.max(y1, F[o + M.META_BBOX_YMAX]);
  }
  const px = Math.max(x1 - x0, y1 - y0) / N,
    mb = mutate(b, mut);
  const r = { rows: 0, inside: 0, unpainted: 0, outside: 0, noQuad: 0, noBand: 0, per: [] };
  for (const row of strokeRowsOf(b)) {
    const o = row * FPS,
      rg = b.curveRangesByShape[row];
    const cont = curveRangeToContours(curve, rg.begin, rg.end);
    // every stroke row on this shape class is ONE straight segment; anything else is a new case
    if (cont.length !== 1 || cont[0].length !== 1 || cont[0][0].type !== 0) continue;
    const P = [cont[0][0].p1, cont[0][0].p2];
    const halfW = F[o + M.META_STROKE_W] * 0.5,
      cap = F[o + M.META_CAP_STYLE] | 0;
    const join = F[o + M.META_JOIN_STYLE] | 0,
      ml = F[o + M.META_MITER_LIMIT];
    const emu = makeStrokeEmu(mb, row);
    const bb = [
      F[o + M.META_BBOX_XMIN],
      F[o + M.META_BBOX_YMIN],
      F[o + M.META_BBOX_XMAX],
      F[o + M.META_BBOX_YMAX],
    ];
    const i0 = Math.floor((bb[0] - x0) / px) - 3,
      i1 = Math.ceil((bb[2] - x0) / px) + 3;
    const j0 = Math.floor((bb[1] - y0) / px) - 3,
      j1 = Math.ceil((bb[3] - y0) / px) + 3;
    let ins = 0,
      unp = 0,
      out = 0;
    for (let j = j0; j <= j1; j++) {
      const y = y0 + (j + 0.5) * px;
      for (let i = i0; i <= i1; i++) {
        const c = [x0 + (i + 0.5) * px, y];
        const truth = svgInside(c, P, false, halfW, cap, join, ml),
          e = emu.eval(c);
        const painted = e.cov > 0.5;
        if (truth) {
          ins++;
          if (!painted) {
            unp++;
            if (!e.inQuad) r.noQuad++;
            if (e.minD > 1e19) r.noBand++;
          }
        } else if (painted) out++;
      }
    }
    r.rows++;
    r.inside += ins;
    r.unpainted += unp;
    r.outside += out;
    r.per.push(
      `row ${row} halfW ${halfW.toFixed(3)} cap ${cap}: ${ins} inside, ${unp} unpainted, ${out} outside`,
    );
  }
  return r;
}

const TWIN = readFileSync(path.join(ROOT, 'examples/smoke/bandDiscriminatorTwin__SVG.svg'), 'utf8');
for (const N of [512, 1024]) {
  const r = await score(TWIN, N);
  ok(
    r.slug === 0 && r.aac === 0 && r.hard === 0,
    `the twin @${N}: ${r.rows} meta rows, ${r.segs} segments, ${r.shapes} fill shapes, ${r.tot} solid-interior centers — slug ${r.slug}, aac ${r.aac}, BAND-HARD ${r.hard} wrong`,
  );
  if (N === 512)
    ok(
      r.openClosed === 0,
      `the twin's filled subpaths all arrive CLOSED (worst gap ${r.openClosed}) — two of them are open in the source`,
    );
}

// ...and with the interior-skip grid landed: a grid built from the path as authored would certify cells
// past the twin's two OPEN filled subpaths' closing chords and the skip would paint them solid under all
// three kernels (test/openSubpathOccupancySmoke.mjs has the mechanism).
for (const N of [512, 1024]) {
  const r = await score(TWIN, N, emuSlug, { occ: true });
  ok(
    r.occCells > 0 && r.slug === 0 && r.aac === 0 && r.hard === 0,
    `the twin @${N} WITH THE OCCUPANCY GRID LANDED (${r.occCells} cells): ${r.tot} solid-interior centers — slug ${r.slug}, aac ${r.aac}, band-hard ${r.hard} wrong`,
  );
}

for (const N of [512, 1024]) {
  const r = await scoreStrokes(TWIN, N);
  ok(
    r.rows === 2 && r.unpainted === 0 && r.outside === 0,
    `the twin's STROKE rows @${N}: ${r.rows} rows, ${r.inside} centers the SVG 2 shape owns — ${r.unpainted} UNPAINTED (${r.noQuad} outside the cover quad, ${r.noBand} with no segment in their band), ${r.outside} painted outside`,
  );
  for (const p of r.per) console.log(`     ${p}`);
}

// Optional local SVG, when MANTLE_LOCAL_SVG points at one. It is not part of this repository.
const LOCAL_SVG = process.env.MANTLE_LOCAL_SVG || '';
if (LOCAL_SVG && existsSync(LOCAL_SVG)) {
  const src = readFileSync(LOCAL_SVG, 'utf8');
  // ...and as probes/_zzEnginePaint.mjs imports it, which STRIPS strokes unless KEEPSTROKES=1, so the
  // 5-row bundle that probe renders is scored too.
  const stripped = src
    .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
    .replace(/stroke-width\s*=\s*"[^"]*"/g, '')
    .replace(/(^|[;{\s"'])stroke\s*:\s*[^;}"']+/g, '$1stroke:none');
  for (const N of [512, 1024]) {
    const r = await score(src, N);
    ok(
      r.slug === 0 && r.aac === 0 && r.hard === 0,
      `optional local SVG @${N}: ${r.rows} meta rows, ${r.segs} segments, ${r.tot} solid-interior centers — slug ${r.slug}, aac ${r.aac}, BAND-HARD ${r.hard} wrong: not the bands, not the walk, not either kernel`,
    );
    const ro = await score(src, N, emuSlug, { occ: true });
    ok(
      ro.occCells > 0 && ro.slug === 0 && ro.aac === 0 && ro.hard === 0,
      `optional local SVG @${N} WITH THE OCCUPANCY GRID LANDED (${ro.occCells} cells): slug ${ro.slug}, aac ${ro.aac}, band-hard ${ro.hard} wrong`,
    );
    const rs = await score(stripped, N);
    ok(
      rs.slug === 0 && rs.aac === 0 && rs.hard === 0 && rs.tot === r.tot,
      `...and STROKE-STRIPPED, the bundle _zzEnginePaint renders @${N}: ${rs.rows} meta rows, ${rs.segs} segments, ${rs.tot} centers — slug ${rs.slug}, aac ${rs.aac}, hard ${rs.hard}. The strip is not the difference`,
    );
    const st = await scoreStrokes(src, N);
    ok(
      st.rows === 2 && st.unpainted === 0 && st.outside === 0,
      `optional local SVG's ROUND-capped strokes under matrix(1,0,0,-1,..) @${N}: ${st.inside} centers the SVG 2 shape owns — ${st.unpainted} UNPAINTED (${st.noQuad} outside the cover quad, ${st.noBand} with no segment in their band), ${st.outside} painted outside. The remaining branch is negative too`,
    );
    for (const p of st.per) console.log(`     ${p}`);
  }
} else {
  console.log('  -- optional local SVG not set (MANTLE_LOCAL_SVG); the stand-in above ran');
}

// ---- the stroke instrument is live --------------------------------------------------------------
// Three mutations of the renderer's own data, each the shape of a stroke defect: a cap the meta calls
// BUTT, one it calls SQUARE, and a band that lists no segment. Their magnitudes exceed 808 px at 1024,
// so a defect of that size could not hide behind the zeros above.
for (const N of [512, 1024]) {
  const butt = await scoreStrokes(TWIN, N, { capAs: 0 });
  const sq = await scoreStrokes(TWIN, N, { capAs: 2 });
  const drop = await scoreStrokes(TWIN, N, { dropBand: true });
  ok(
    butt.unpainted > 0 && sq.outside > 0 && drop.unpainted > 0,
    `@${N} a cap read BUTT loses ${butt.unpainted} px, read SQUARE paints ${sq.outside} outside, and a band that drops the segment loses ${drop.unpainted} — so the stroke zeros are a measurement, not a blind spot`,
  );
  if (N === 1024)
    ok(
      butt.unpainted > 808 && drop.unpainted > 808,
      `@1024 both live arms are LARGER than 808 px (${butt.unpainted}, ${drop.unpainted}), so an 808-sized defect of either kind would show`,
    );
}

// ---- the instrument is live ---------------------------------------------------------------------
{
  ok(MUT !== GLSL, 'the prune mutation applies to the shipped hard-band walk');
  const r = await score(TWIN, 512, emuBlind);
  ok(
    r.hard > 0 && r.slug === 0 && r.aac === 0,
    `a band walk that prunes one em too early moves BAND-HARD to ${r.hard} wrong and leaves slug ${r.slug} and aac ${r.aac} alone ` +
      '— so the three zeros above are a measurement, not a blind spot',
  );
}

console.log(fail ? `bandDiscriminatorSmoke FAIL (${fail})` : 'bandDiscriminatorSmoke PASS');
process.exit(fail ? 1 : 0);
