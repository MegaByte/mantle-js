// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// coverFanProof — the Slug/AAC cover FAN (svg/mesh.js getCoverFanVerts, importSvg({ coverFan: true }))
// against the box cover: does it drop only fragments whose coverage is exactly 0, and how many does it
// drop? Node only, no GPU: the covers are the imported vertex data, dilated as the vertex shader's coverQuadDilate
// dilates them, and the coverage is the float32 emulation of the package Slug and AAC kernels (test/_glslEmu.mjs).
//
//   node probes/fillperf/coverFanProof.mjs [--quick] [--only name] [--rotate]
//
// For every fill row whose cover became a fan, at pixel sizes of 1/16, 1/128 and 1/1024 of the shape and at the
// drawing's own 512 px raster, a lattice of pixel centers over both dilated covers is classified (inside the box,
// inside the fan). A fragment is shaded where its center is inside the cover, and a fragment outside it paints
// nothing, so the two covers draw the same picture iff every center inside exactly one of them has coverage 0. Those
// centers go through both kernels. A coverage of half an 8-bit level or more (1/510) at a center the BOX covers and
// the fan does not is a VIOLATION and fails the run: the fan would lose ink. At a center only the FAN covers it is ink
// the box clipped -- the box pushes each edge half a pixel, short of the box filter's reach along a rotated (OBB)
// edge -- which the fan's 0.7071 px reaches: counted and reported, the one place the picture changes, and
// toward the exact area. Below the half level it is AAC's float32 residue (the telescoped signed area of a cell the
// shape never reaches cancels to ~1e-8, not to 0), which no 8-bit target can show. The lattice counts are the
// fragments each cover shades.
//
// THE VIEW. Unrotated and isotropic (the default): a cover vertex moves by `normal * ePx / 2` (coverQuadDilate
// with m3 = (0,0,0,1) and equal pixel scales). --rotate adds a 30-degree view rotation: the lattice turns, the
// dilation is unchanged (it is length-preserving), and the kernel's per-axis pixel size becomes fwidth's
// ePx (|cos| + |sin|); there the BOX cover itself clips AA (its 0.5 px pushes are short of the rotated pixel's
// reach), so the run reports, per cover, the centers with nonzero coverage that it leaves out, rather than failing.
//
// Also checked: the fan import writes the same bands and curves as the box import (only the cover geometry moves).
import { readFileSync, readdirSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, K_AAC, K_SLUG, AAC_HARD } from '../../test/_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO = path.resolve(ROOT, '..');
// EMBEDDED: test/coverFanSmoke.mjs sets globalThis.__coverFanProofArgs and imports this file, so the proof runs in
// its process (the node lane runs one test at a time); the verdict then lands in globalThis.__coverFanProofFail.
const EMBED = Array.isArray(globalThis.__coverFanProofArgs);
const argv = EMBED ? globalThis.__coverFanProofArgs : process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (k) => argv.includes('--' + k);
if (!hasCxx()) {
  if (EMBED) throw new Error('coverFanProof: no C++ compiler');
  console.error('coverFanProof: no C++ compiler');
  process.exit(2);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../../src/svg/importer.js');
const { parseMetaBin } = await import('../../src/renderer/bundle.js');
const M = await import('../../src/bundle/layout.js');
const {
  parseCoverQuadChunks,
  buildGidToShapeIdx,
  COVER_QUAD_STRIDE,
  BUNDLE_FLAG_HYBRID_MESH_CHUNKED,
} = await import('../../src/renderer/coverQuadChunks.js');
const { decodeSegs } = await import('../../src/hitTest/curveGeom.js');
// Distance from p to a shape's outline, sampled (lines exactly, curves and arcs at 512 points each), for judging a
// center the kernels call inked: a pixel's box reaches 0.7071 px from its center, so a center more than 0.75 px from
// every outline point (the reach plus the sampling's own error, far below 0.04 px here) has true coverage 0 whatever
// a kernel returns there.
function outlineDist(segs, p) {
  let d = Infinity;
  const seg2 = (ax, ay, bx, by) => {
    const dx = bx - ax,
      dy = by - ay,
      L = dx * dx + dy * dy;
    const t = L > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L)) : 0;
    d = Math.min(d, Math.hypot(ax + t * dx - p[0], ay + t * dy - p[1]));
  };
  for (const g of segs) {
    if (g.t === 0) {
      seg2(g.x0, g.y0, g.x1, g.y1);
      continue;
    }
    let px = g.x0,
      py = g.y0;
    for (let k = 1; k <= 512; k++) {
      const t = k / 512,
        u = 1 - t;
      let x, y;
      if (g.t === 1) {
        x = u * u * g.x0 + 2 * u * t * g.cx + t * t * g.x1;
        y = u * u * g.y0 + 2 * u * t * g.cy + t * t * g.y1;
      } else if (g.t === 2) {
        x = u * u * u * g.x0 + 3 * u * u * t * g.c1x + 3 * u * t * t * g.c2x + t * t * t * g.x1;
        y = u * u * u * g.y0 + 3 * u * u * t * g.c1y + 3 * u * t * t * g.c2y + t * t * t * g.y1;
      } else {
        const th = g.th0 + (g.th1 - g.th0) * t;
        x = g.cx + g.cp * g.rx * Math.cos(th) - g.sp * g.ry * Math.sin(th);
        y = g.cy + g.sp * g.rx * Math.cos(th) + g.cp * g.ry * Math.sin(th);
      }
      seg2(px, py, x, y);
      px = x;
      py = y;
    }
  }
  return d;
}
const emu = buildGlslEmu(ROOT, { defines: AAC_HARD });

// ---- corpus -------------------------------------------------------------------------------------------------------
const QUICK = has('quick');
const readDir = (d, pick = () => true) =>
  existsSync(d)
    ? readdirSync(d)
        .filter((f) => f.endsWith('.svg'))
        .sort()
        .filter(pick)
        .map((f) => ({
          name: path.relative(REPO, path.join(d, f)),
          text: readFileSync(path.join(d, f), 'utf8'),
        }))
    : [];
const corpus = [];
corpus.push(...readDir(path.join(ROOT, 'examples'), (f) => !QUICK || f === 'tiger.svg'));
corpus.push(...readDir(path.join(ROOT, 'examples/_bench')));
if (!QUICK) {
  corpus.push(...readDir(path.join(ROOT, 'examples/smoke'), (_f, i) => i % 4 === 0));
  corpus.push(
    ...readDir(path.join(REPO, 'MantleSamples/Assets/Mantle')),
    ...readDir(path.join(REPO, 'fixtures/svg')),
  );
}
for (const [name, file, gen] of [
  ['text(roboto)', 'mantle-fillperf-text.svg', 'probes/rayLanes/makeTextSvg.mjs'],
  ['arcSheet', 'mantle-fillperf-arcs.svg', 'probes/fillperf/makeArcSvg.mjs'],
]) {
  const p = path.join(os.tmpdir(), file);
  if (!existsSync(p))
    try {
      execFileSync(
        process.execPath,
        [path.join(ROOT, gen), p, ...(name.startsWith('text') ? ['6'] : [])],
        { stdio: 'ignore' },
      );
    } catch {}
  if (existsSync(p)) corpus.push({ name, text: readFileSync(p, 'utf8') });
}
if (flag('only')) {
  const keep = flag('only').split(',');
  for (let i = corpus.length - 1; i >= 0; i--)
    if (!keep.some((k) => corpus[i].name.includes(k))) corpus.splice(i, 1);
}

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

// ---- covers -------------------------------------------------------------------------------------------------------
// A chunk's triangles, each vertex moved by normal * h (the vertex shader's dilation at half-pixel h, in em).
function dilatedTris(cg, ch, h) {
  const tris = [];
  const V = (k) => {
    const o = (ch.start + k) * COVER_QUAD_STRIDE;
    return [Math.fround(cg[o] + cg[o + 2] * h), Math.fround(cg[o + 1] + cg[o + 3] * h)];
  };
  for (let t = 0; t + 2 < ch.count; t += 3) tris.push([V(t), V(t + 1), V(t + 2)]);
  return tris;
}
const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
// Inside a triangle, edges inclusive on one side as a rasterizer's top-left rule would be: a center exactly on an
// edge shared by two fan triangles is claimed once. For the proof only whole-cover membership matters.
function inTris(tris, p) {
  for (const [a, b, c] of tris) {
    const d0 = cross(a, b, p),
      d1 = cross(b, c, p),
      d2 = cross(c, a, p);
    if ((d0 >= 0 && d1 >= 0 && d2 >= 0) || (d0 <= 0 && d1 <= 0 && d2 <= 0)) return true;
  }
  return false;
}
function trisBox(tris) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const t of tris)
    for (const [x, y] of t) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  return [x0, y0, x1, y1];
}

async function load(text, fan) {
  try {
    const b = await importSvg(text, { preserveViewport: true, coverFan: fan });
    if (!b || !b.bands || !b.curveGeom) return null;
    const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
    const cg = new Float32Array(b.curveGeom);
    return {
      b,
      pm,
      cg,
      chunks: parseCoverQuadChunks(cg, BUNDLE_FLAG_HYBRID_MESH_CHUNKED),
      gidToShape: buildGidToShapeIdx(pm.metaFloats, b.numShapes, pm.floatsPerShape),
      band: new Float32Array(b.bands),
      curve: new Float32Array(b.curves),
    };
  } catch {
    return null;
  }
}

const ROT = has('rotate') ? Math.PI / 6 : 0,
  cR = Math.cos(ROT),
  sR = Math.sin(ROT);
const SCALES = flag('scales', QUICK ? '0' : '-20,0,20')
  .split(',')
  .map((k) => 2 ** +k);
const T = {
  drawings: 0,
  rows: 0,
  fans: 0,
  sameLayout: 0,
  layoutBad: 0,
  fragBox: 0,
  fragFan: 0,
  queried: 0,
  violations: 0,
  clipBox: 0,
  clipFan: 0,
  ex: [],
  vertsBox: 0,
  vertsFan: 0,
  residue: 0,
  residueMax: 0,
  gained: 0,
  gainedSlug: 0,
  gainedMax: 0,
  stray: 0,
  strayMax: 0,
  strayFar: 0,
};
const QUANTUM = 1 / 510; // half an 8-bit level
const t0 = Date.now();
for (const S of SCALES)
  for (const c of corpus) {
    const text = wrap(c.text, S);
    if (!text) continue;
    const Q = await load(text, false),
      F = await load(text, true);
    if (!Q || !F) continue;
    T.drawings++;
    const same =
      Q.band.length === F.band.length &&
      Q.curve.length === F.curve.length &&
      Q.band.every((v, i) => Object.is(v, F.band[i])) &&
      Q.curve.every((v, i) => Object.is(v, F.curve[i]));
    if (same) T.sameLayout++;
    else {
      T.layoutBad++;
      continue;
    }
    const vb = Q.b.viewBox || [0, 0, 1, 1];
    const byGid = new Map(F.chunks.map((ch) => [ch.gid, ch]));
    const queries = [],
      meta = [];
    for (const chQ of Q.chunks) {
      const chF = byGid.get(chQ.gid);
      const s = Q.gidToShape.get(chQ.gid);
      if (!chF || s == null) continue;
      const o = s * Q.pm.floatsPerShape,
        MF = Q.pm.metaFloats;
      if (!(MF[o + M.META_FILL_A] > 0) || (MF[o + M.META_BAND_MAX_Y] | 0) < 0) continue;
      T.rows++;
      T.vertsBox += chQ.count;
      T.vertsFan += chF.count;
      if (chF.count === chQ.count) continue; // no fan for this row
      T.fans++;
      const GD = [
        MF[o + M.META_GLYPH_LOC_X] | 0,
        MF[o + M.META_GLYPH_LOC_Y] | 0,
        MF[o + M.META_BAND_MAX_X] | 0,
        MF[o + M.META_BAND_MAX_Y] | 0,
      ];
      const bb = [
        MF[o + M.META_BBOX_XMIN],
        MF[o + M.META_BBOX_YMIN],
        MF[o + M.META_BBOX_XMAX],
        MF[o + M.META_BBOX_YMAX],
      ];
      const eo = (MF[o + M.META_FILL_RULE] | 0) === 1;
      const ext = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
      if (!(ext > 0)) continue;
      const sizes = [ext / 16, ext / 128, Math.max(vb[2], vb[3]) / 512];
      for (const ePx of sizes) {
        const h = ePx / 2;
        const tQ = dilatedTris(Q.cg, chQ, h),
          tF = dilatedTris(F.cg, chF, h);
        const bq = trisBox(tQ),
          bf = trisBox(tF);
        const box = [
          Math.min(bq[0], bf[0]),
          Math.min(bq[1], bf[1]),
          Math.max(bq[2], bf[2]),
          Math.max(bq[3], bf[3]),
        ];
        // the lattice: pixel centers at a sub-pixel offset, turned by the view rotation about the box's corner
        const w = (box[2] - box[0]) / ePx,
          hh = (box[3] - box[1]) / ePx;
        const span =
          Math.ceil(
            (Math.abs(w * cR) + Math.abs(hh * sR) + Math.abs(w * sR) + Math.abs(hh * cR)) / 1,
          ) + 4;
        if (span * span > 1.5e6) continue; // a pixel size far below the shape: sampled by the others
        const cx0 = 0.5 * (box[0] + box[2]),
          cy0 = 0.5 * (box[1] + box[3]);
        const ePxAxis = ePx * (Math.abs(cR) + Math.abs(sR)); // fwidth of the em coordinate under the rotation
        for (let j = -span / 2; j < span / 2; j++)
          for (let i = -span / 2; i < span / 2; i++) {
            const u = (i + 0.37) * ePx,
              v = (j + 0.61) * ePx;
            const p = [Math.fround(cx0 + u * cR - v * sR), Math.fround(cy0 + u * sR + v * cR)];
            if (p[0] < box[0] || p[0] > box[2] || p[1] < box[1] || p[1] > box[3]) continue;
            const inQ = inTris(tQ, p),
              inF = inTris(tF, p);
            if (inQ) T.fragBox++;
            if (inF) T.fragFan++;
            if (inQ === inF) continue;
            queries.push({ GD, bb, eo, c: p, ePx: [ePxAxis, ePxAxis] });
            meta.push({
              inQ,
              inF,
              name: c.name,
              S,
              ePx,
              s,
              curve: Q.curve,
              range: Q.b.curveRangesByShape[s],
            });
          }
      }
      if (queries.length > 150000) flush(Q, queries.splice(0), meta.splice(0));
    }
    flush(Q, queries, meta);
  }
function flush(Q, queries, meta) {
  if (!queries.length) return;
  for (let k0 = 0; k0 < queries.length; k0 += 200000) {
    const qs = queries.slice(k0, k0 + 200000),
      ms = meta.slice(k0, k0 + 200000);
    const slug = emu.run(
      Q.band,
      Q.curve,
      qs.map((q) => ({ ...q, k: K_SLUG })),
    );
    const aac = emu.run(
      Q.band,
      Q.curve,
      qs.map((q) => ({ ...q, k: K_AAC })),
    );
    T.queried += qs.length;
    for (let i = 0; i < qs.length; i++) {
      if (!(slug[i] !== 0 || aac[i] !== 0)) continue;
      const mag = Math.max(Math.abs(slug[i]), Math.abs(aac[i]));
      if (mag < QUANTUM) {
        T.residue++;
        T.residueMax = Math.max(T.residueMax, mag);
        continue;
      }
      if (ROT) {
        if (ms[i].inQ) T.clipFan++;
        else T.clipBox++;
        continue;
      }
      if (ms[i].inF) {
        T.gained++;
        if (Math.abs(slug[i]) >= QUANTUM) T.gainedSlug++;
        T.gainedMax = Math.max(T.gainedMax, mag);
        continue;
      }
      // inked at a center the fan leaves out: lost ink, unless the center is more than 0.75 px from every point of
      // the outline, where the true coverage is 0 and the kernel's answer is its own error
      const segs = ms[i].range ? decodeSegs(ms[i].curve, ms[i].range.begin, ms[i].range.end) : null;
      const far = segs ? outlineDist(segs, qs[i].c) / ms[i].ePx : 0;
      if (far > 0.75) {
        T.stray++;
        T.strayMax = Math.max(T.strayMax, mag);
        if (far > T.strayFar) {
          T.strayFar = far;
          T.strayEx = `${ms[i].name}@2^${Math.log2(ms[i].S)} ePx ${ms[i].ePx.toPrecision(4)} c=(${qs[i].c}) ${far.toFixed(1)} px out: slug ${slug[i]} aac ${aac[i]}`;
        }
        continue;
      }
      T.violations++;
      if (T.ex.length < 8)
        T.ex.push(
          `${ms[i].name}@2^${Math.log2(ms[i].S)} ePx ${ms[i].ePx.toPrecision(4)} c=(${qs[i].c}) in ${ms[i].inQ ? 'box' : 'fan'} only: slug ${slug[i]} aac ${aac[i]}`,
        );
    }
  }
}
let fail = 0;
const ok = (cnd, m) => {
  console.log(`  ${cnd ? 'ok' : 'FAIL'} ${m}`);
  if (!cnd) fail++;
};
ok(
  T.layoutBad === 0,
  `the fan import writes the box import's bands and curves byte for byte (${T.sameLayout} drawings; ${T.layoutBad} differ)`,
);
ok(
  T.fans > 0,
  `${T.fans} of ${T.rows} fill rows take a fan (${T.drawings} drawing-scale imports); cover vertices ${T.vertsBox} -> ${T.vertsFan}`,
);
console.log(
  `  fragments shaded over the lattices: box ${T.fragBox}, fan ${T.fragFan} (${((T.fragFan / T.fragBox - 1) * 100).toFixed(1)}%)`,
);
if (ROT)
  console.log(
    `  rotated view (30 deg): centers with nonzero coverage left out -- by the box ${T.clipBox}, by the fan ${T.clipFan} (of ${T.queried} centers inside exactly one cover)`,
  );
else {
  ok(
    T.queried > 0 && T.violations === 0,
    `the fan drops no ink: every center inside the box and not the fan has coverage under half an 8-bit level under Slug and AAC (${T.violations} at or above it, of ${T.queried} centers inside exactly one cover)`,
  );
  console.log(
    `  ink the box clipped and the fan draws: ${T.gained} centers (${T.gainedSlug} of them under Slug), coverage up to ${T.gainedMax.toFixed(4)}`,
  );
  console.log(
    `  stray coverage the box drew and the fan does not -- a kernel answer more than 0.75 px from the outline, where the` +
      ` true coverage is 0: ${T.stray} centres, up to ${T.strayMax.toFixed(4)}, as far as ${T.strayFar.toFixed(1)} px`,
  );
  if (T.strayEx) console.log(`       farthest: ${T.strayEx}`);
}
console.log(
  `  (${T.residue} of those centers carry AAC's sub-level float32 residue, max ${T.residueMax.toExponential(2)}; Slug returns exactly 0 at every one)`,
);
for (const e of T.ex) console.log(`       ${e}`);
console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
globalThis.__coverFanProofFail = fail;
if (fail) {
  console.log('COVER-FAN-PROOF FAIL');
  if (!EMBED) process.exit(1);
} else console.log('COVER-FAN-PROOF PASS');
