// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// openSubpathOccupancySmoke — an OPEN filled subpath's occupancy grid certifies no cell outside
// the fill, for every kernel that reads the interior-skip grid.
//
// SVG fills an open subpath as if it were closed, and the importer honors that for the FILL
// ENCODING: `splitSubpathsWithCloseInto` appends a synthetic closing edge before the bands and the
// curve table are built, so every kernel's walk is correct on its own. The occupancy grid must
// close the subpath too: built from `sd.segs`, the path AS AUTHORED, its inside test crosses each
// segment's flattened run and never closes a contour itself, so an open subpath's missing edge lets
// the crossing parity run on past it and certifies cells beyond the chord as interior. The
// shader's skip (`occSkip ? 1.0 : ...` in mantle.frag.glsl) would then paint those cells at full
// coverage, downstream of a winding that is right.
//
// WHY ONE PAGE CAN SHOW IT AND ANOTHER NOT. By default the grid is built OFF THREAD and lands a few
// frames in (`bundle.pendingOccupancy`, the occupancy worker). A page that waits for it
// (`probes/_zzEnginePaint.mjs`) draws the skip; a direct render reads frame one, before any bit is
// set. This file models the waiting page — the pending job built exactly as the worker builds it,
// written into the curve plane, and the cover quad the draw rasterizes: on openFillNoZ__SVG.svg at
// 1024 its slug ink is the no-grid ink (108,542.7 px-eq), as the Z form's is.
//
// WHAT this PINS, each at the geometric scales 2^-20, 1 and 2^20:
//   1. every cell the grid certifies (sync build AND the worker's async job) is wholly inside the
//      fill, checked against the exact winding over the decoded, closed fill segments;
//   2. the open form and its Z twin give IDENTICAL grids, sync and async;
//   3. Slug and AAC through the shipped shader text (test/_glslEmu.mjs, float32), with the grid's
//      skip applied as the shader applies it inside the draw's cover quad, stay within 1/255 of an
//      exact supersampled coverage in ink, the grid adds no solid pixel outside the fill to what
//      the kernel alone paints, and the open form's ink is the Z form's to 0.1% (the Z form keeps
//      a zero-length authored close, which moves AAC by under one px-eq).
//
// With an as-authored grid, 251 of the 342 cells certified on openFillNoZ reach outside the fill (the Z
// form certifies none), and on the S-curve 73 of 353.
//
// NOT this CASE: a cubic that ends on its own last handle is a crossing-solve case for the kernel itself
// (test/slugZeroSpeedEndSmoke.mjs); the check below only asks that the grid add nothing to whatever the
// kernel paints.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, fillShapes, K_SLUG, K_AAC, AAC_HARD } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { parseCoverQuadChunks } = await import('../src/renderer/coverQuadChunks.js');
const { buildOccupancyGrid } = await import('../src/svg/occupancy.js');
const { decodeSegs } = await import('../src/hitTest/curveGeom.js');
const { pointInFill } = await import('../src/hitTest/fillCoverage.js');
const M = await import('../src/bundle/layout.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// Open subpaths that carry a fill: openFillNoZ (its cubic's P2 == P3), and three whose grids certify
// interior cells, so the skip is exercised rather than dormant.
const CASES = [
  {
    name: 'fixture',
    vb: [1740, 778, 28, 28],
    d: 'M 1762.4 783.1 C 1762.1 799.2 1745.3 799.2 1745.3 799.2',
  },
  { name: 'S-curve', vb: [0, 0, 100, 100], d: 'M 50 10 C 95 10 95 90 50 90 C 20 90 10 60 30 50' },
  { name: 'hook', vb: [0, 0, 100, 100], d: 'M 10 90 C 0 0 80 0 90 30 C 95 60 70 70 60 60' },
  { name: 'quad', vb: [0, 0, 100, 100], d: 'M 20 80 Q 20 10 90 30' },
];
const scaleD = (d, s) => d.replace(/-?\d+(\.\d+)?/g, (n) => String(Number(n) * s));
const svgOf = (c, s, z) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${c.vb.map((v) => v * s).join(' ')}">` +
  `<path fill="#db7200" d="${scaleD(c.d, s)}${z ? ' Z' : ''}"/></svg>`;

/// The fill shape's grid, both ways it is built: SYNC (importSvg's `occupancyGrid` option, packed
/// in-buffer) and ASYNC (the pending job, built here as src/renderer/occupancyWorkerPool.js builds it).
async function grids(svg) {
  const sync = await importSvg(svg, { preserveViewport: true, occupancyGrid: { grid: 24 } });
  const asyn = await importSvg(svg, { preserveViewport: true });
  const read = (b, curve) => {
    const sh = fillShapes(b, parseMetaBin, M)[0];
    const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
      F = pm.metaFloats,
      o = sh.s * pm.floatsPerShape;
    const base = F[o + M.META_SOLID_START] | 0,
      G = F[o + M.META_SOLID_COUNT] | 0;
    const bits = new Uint8Array(G * G);
    for (let c = 0; c < G * G; c++) bits[c] = curve[base * 4 + c] > 0.5 ? 1 : 0;
    return { b, sh, curve, base, G, bits, segs: decodeSegs(curve, sh.range.begin, sh.range.end) };
  };
  const curveA = new Float32Array(asyn.curves);
  const jobs = asyn.pendingOccupancy || [];
  let jobClosed = true;
  for (const p of jobs) {
    // every subpath the worker is handed has to END where it STARTS (these cases have no arcs, so
    // each segment's ends are p1 and its last control point)
    let start = null,
      prev = null;
    const shut = () => !start || (prev[0] === start[0] && prev[1] === start[1]);
    for (const s of p.segs) {
      if (s.subStart || !start) {
        if (!shut()) jobClosed = false;
        start = s.p1;
      }
      prev = s.p4 || s.p3 || s.p2;
    }
    if (!shut()) jobClosed = false;
    const g = buildOccupancyGrid(p.segs, p.bbox, p.evenOdd, { grid: p.G, minInteriorFrac: 0.15 });
    if (g && g.bits)
      for (let i = 0; i < g.bits.length; i++) curveA[p.base * 4 + i] = g.bits[i] || 0;
  }
  return {
    sync: read(sync, new Float32Array(sync.curves)),
    async: { ...read(asyn, curveA), jobs: jobs.length, jobClosed },
  };
}

/// Set cells that are not wholly inside the fill: 8x8 sample centers per cell against the exact
/// winding over the decoded (closed) fill segments.
function uncertified(g) {
  const { sh, G, bits, segs } = g;
  const cw = (sh.bb[2] - sh.bb[0]) / G,
    ch = (sh.bb[3] - sh.bb[1]) / G;
  let set = 0,
    bad = 0;
  for (let c = 0; c < G * G; c++) {
    if (!bits[c]) continue;
    set++;
    const gx = c % G,
      gy = (c / G) | 0;
    let out = false;
    for (let j = 0; j < 8 && !out; j++)
      for (let i = 0; i < 8; i++)
        if (
          !pointInFill(
            segs,
            sh.bb[0] + (gx + (i + 0.5) / 8) * cw,
            sh.bb[1] + (gy + (j + 0.5) / 8) * ch,
            sh.eo,
          )
        ) {
          out = true;
          break;
        }
    if (out) bad++;
  }
  return { set, bad };
}

const same = (a, b) =>
  a.G === b.G && a.bits.length === b.bits.length && a.bits.every((v, i) => v === b.bits[i]);

for (const k of [-20, 0, 20]) {
  const s = 2 ** k;
  for (const c of CASES) {
    const open = await grids(svgOf(c, s, false)),
      zed = await grids(svgOf(c, s, true));
    for (const [arm, g] of [
      ['sync', open.sync],
      ['async', open.async],
    ]) {
      const u = uncertified(g);
      ok(
        u.bad === 0,
        `2^${k} ${c.name} (open) ${arm} grid G=${g.G}: ${u.set} cells certified interior, ${u.bad} reach outside the fill`,
      );
    }
    ok(
      open.async.jobs === 1 && open.async.jobClosed,
      `2^${k} ${c.name}: the occupancy worker's job carries a CLOSED contour (${open.async.jobs} job)`,
    );
    ok(
      same(open.sync, zed.sync) && same(open.async, zed.async),
      `2^${k} ${c.name}: the open form and its Z twin build the same grid (sync G ${open.sync.G}/${zed.sync.G}, async G ${open.async.G}/${zed.async.G})`,
    );
  }
}

// ---- the kernels through the draw -----------------------------------------------------------------
// Coverage the waiting page sees at every pixel center its cover quad rasterizes: the grid's skip
// where it applies (cell >= 1.5 px on both axes, as the shader gates it), the kernel elsewhere.
if (!hasCxx()) {
  console.log('  -- no C++ compiler ($CXX, clang++, g++, c++): the kernel half is skipped');
} else {
  const emuSlug = buildGlslEmu(ROOT, { defines: [] }),
    emuAac = buildGlslEmu(ROOT, { defines: AAC_HARD });
  const SS = 8;
  const draw = (g, N) => {
    const { b, sh, curve, base, G, segs } = g;
    const vb = b.viewBox,
      e = vb[2] / N;
    const cq = new Float32Array(b.curveGeom),
      ch0 = parseCoverQuadChunks(cq, b.flags)[0];
    const V = [];
    for (let v = 0; v < ch0.count; v++) {
      const q = (ch0.start + v) * 12;
      V.push([cq[q] + cq[q + 2] * 0.5 * e, cq[q + 1] + cq[q + 3] * 0.5 * e]);
    }
    const side = (u, v, w) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
    const inTri = (p, a, b2, c) => {
      const d1 = side(a, b2, p),
        d2 = side(b2, c, p),
        d3 = side(c, a, p);
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
    };
    const inQuad = (p) => {
      for (let t = 0; t + 2 < V.length; t += 3) if (inTri(p, V[t], V[t + 1], V[t + 2])) return true;
      return false;
    };
    const cw = (sh.bb[2] - sh.bb[0]) / G,
      chh = (sh.bb[3] - sh.bb[1]) / G;
    const q = [],
      skip = [],
      ref = [];
    for (let py = 0; py < N; py++)
      for (let px = 0; px < N; px++) {
        const c = [vb[0] + (px + 0.5) * e, vb[1] + (py + 0.5) * e];
        if (!inQuad(c)) continue;
        let sk = false;
        if (G > 0 && cw >= 1.5 * e && chh >= 1.5 * e) {
          const cx = Math.floor((c[0] - sh.bb[0]) / cw),
            cy = Math.floor((c[1] - sh.bb[1]) / chh);
          sk = cx >= 0 && cy >= 0 && cx < G && cy < G && curve[base * 4 + cy * G + cx] > 0.5;
        }
        let a = 0;
        for (let j = 0; j < SS; j++)
          for (let i = 0; i < SS; i++)
            if (
              pointInFill(
                segs,
                vb[0] + (px + (i + 0.5) / SS) * e,
                vb[1] + (py + (j + 0.5) / SS) * e,
                sh.eo,
              )
            )
              a++;
        q.push({ GD: sh.GD, bb: sh.bb, eo: sh.eo, c, ePx: [e, e] });
        skip.push(sk);
        ref.push(a / (SS * SS));
      }
    const out = {};
    for (const [name, emu, kk] of [
      ['slug', emuSlug, K_SLUG],
      ['aac', emuAac, K_AAC],
    ]) {
      const r = emu.run(
        new Float32Array(b.bands),
        curve,
        q.map((x) => ({ ...x, k: kk })),
      );
      let ink = 0,
        rink = 0,
        outside = 0,
        kernelOutside = 0,
        skipped = 0;
      r.forEach((v0, i) => {
        const v = skip[i] ? 1 : v0;
        if (skip[i]) skipped++;
        ink += v;
        rink += ref[i];
        if (ref[i] === 0 && v > 0.5) outside++;
        if (ref[i] === 0 && v0 > 0.5) kernelOutside++;
      });
      out[name] = { ink, rink, outside, kernelOutside, skipped };
    }
    return out;
  };
  const N = 256;
  for (const k of [-20, 0, 20]) {
    const s = 2 ** k;
    for (const c of CASES) {
      const open = await grids(svgOf(c, s, false)),
        zed = await grids(svgOf(c, s, true));
      const o = draw(open.async, N),
        z = draw(zed.async, N);
      for (const name of ['slug', 'aac']) {
        const a = o[name],
          b = z[name],
          rel = Math.abs(a.ink / a.rink - 1);
        ok(
          a.outside === a.kernelOutside &&
            a.outside === b.outside &&
            rel < 1 / 255 &&
            Math.abs(a.ink - b.ink) <= 1e-3 * a.rink,
          `2^${k} ${c.name} @${N} ${name} with the grid (${a.skipped} px skipped): ink ${a.ink.toFixed(1)} vs exact ${a.rink.toFixed(1)} ` +
            `(${(rel * 100).toFixed(3)}%), the Z form ${b.ink.toFixed(1)}; solid outside ${a.outside}, the kernel alone ${a.kernelOutside}, the Z form ${b.outside}`,
        );
      }
    }
  }
}

console.log(fail ? `openSubpathOccupancySmoke FAIL (${fail})` : 'openSubpathOccupancySmoke PASS');
process.exit(fail ? 1 : 0);
