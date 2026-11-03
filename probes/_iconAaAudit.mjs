#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// probes/_iconAaAudit.mjs — LB AA ACCURACY on real SVG icons (not glyphs).
// Same measurement as _polyClipAB but for SVG assets: render each icon with
// Slug and with Loop-Blinn at SIZE px, and compare both against an 8×
// supersampled Slug reference downsampled to SIZE. Reports mean |Δ| on edge
// pixels, the count of cells off by >THRESH, and the worst cell — so LB's AA
// can be judged against ground truth rather than against Slug.
//
//   ICON_DIR=<dir> [SIZE=64 WORST=1 WORST_TH=50] node probes/_iconAaAudit.mjs
import { readFileSync, readdirSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const HERE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.MANTLE_ROOT ? path.resolve(process.env.MANTLE_ROOT) : HERE_ROOT;
const DIR = process.env.ICON_DIR;
if (!DIR) throw new Error('ICON_DIR must name a directory of SVG assets');
const SIZE = +(process.env.SIZE || 64);
const SS = 8;
const WORST_TH = +(process.env.WORST_TH || 50);
const POLY = process.env.POLYCLIP === '1';
const files = readdirSync(DIR)
  .filter((f) => /\.svg$/i.test(f))
  .sort();

const HTML = `<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="${SIZE * SS}" height="${SIZE * SS}"></canvas>
<script type="module">
window.__MANTLE_DEBUG__ = true;
globalThis.__EDGE_TAP = ${process.env.EDGETAP ? '[]' : 'null'};
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { curveRangeToContours } from '/src/geom/lbContour.js';
const gl = document.getElementById('c').getContext('webgl2', {
  antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true,
});
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const rSlug = createRenderer(gl, shaders, {}); rSlug.setLoopBlinnFill('off');
const rLb   = createRenderer(gl, shaders, {}); rLb.setLoopBlinnFill('on');
const grab = (n) => {
  const p = new Uint8Array(n * n * 4);
  gl.readPixels(0, 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, p);
  // luminance, so a colored fill still yields a clean coverage ramp on white
  const a = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) a[i] = (p[i * 4] * 0.299 + p[i * 4 + 1] * 0.587 + p[i * 4 + 2] * 0.114);
  return a;
};
const down = (hi, n, ss) => {
  const lo = new Float64Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let s = 0;
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) s += hi[(y * ss + j) * (n * ss) + (x * ss + i)];
    lo[y * n + x] = s / (ss * ss);
  }
  return lo;
};
window.__run = async (svgTxt, size) => {
  const render = async (r, n) => {
    const sec = await importSvg(svgTxt, { preserveViewport: true });
    const bun = createBundle(gl, sec);
    r.prepareBundle && r.prepareBundle(bun);
    if (r.awaitLbReady) await r.awaitLbReady(bun);
    r.setViewport(n, n); gl.viewport(0, 0, n, n);
    const c0 = (r.debugStats && r.debugStats.loopBlinnRouteCount) || 0;
    r.beginFrame([1, 1, 1, 1]); r.drawBundle(bun); r.endFrame();
    const a = grab(n);
    let verts = 0;
    for (const m of (bun._lbMeshes || [])) if (m && m.vertexCount) verts += m.vertexCount;
    a.verts = verts;
    a.routed = ((r.debugStats && r.debugStats.loopBlinnRouteCount) || 0) - c0;
    bun.dispose && bun.dispose();
    return a;
  };
  const ref = down(await render(rSlug, size * ${SS}), size, ${SS});
  const s = await render(rSlug, size), x = await render(rLb, size);
  const err = (a) => {
    let sum = 0, nEdge = 0, nBad = 0, mx = 0; const worst = [];
    for (let i = 0; i < size * size; i++) {
      const r0 = ref[i];
      if (r0 > 1 && r0 < 254) {                    // EDGE pixels only
        const d = Math.abs(a[i] - r0);
        sum += d; nEdge++;
        if (d > 8) nBad++;
        if (d > mx) mx = d;
        if (d > ${WORST_TH}) worst.push([i % size, (i / size) | 0, Math.round(d), Math.round(a[i]), Math.round(r0)]);
      }
    }
    worst.sort((p, q) => q[2] - p[2]);
    return { mean: sum / Math.max(1, nEdge), nBad, nEdge, max: mx, worst: worst.slice(0, 40) };
  };
  if (${process.env.RAWDUMP ? 'true' : 'false'}) {
    const secR = await importSvg(svgTxt, { preserveViewport: true });
    const bunR = createBundle(gl, secR);
    const F = bunR.curveFloats;
    // arc payload texels: (cx,cy,rx,ry) then (th0,th1,phi,0)
    for (let t = 0; t + 7 < F.length; t += 4) {
      const [a, b, c2, d] = [F[t], F[t+1], F[t+2], F[t+3]];
      if (Math.abs(Math.abs(c2) - 32) < 0.01 && Math.abs(Math.abs(d) - 32) < 0.01)
        console.error('[RAW] texel' + (t/4) + ' cx=' + a.toFixed(2) + ' cy=' + b.toFixed(2) +
          ' rx=' + c2.toFixed(3) + ' ry=' + d.toFixed(3) +
          '  | next: th0=' + F[t+4].toFixed(4) + ' th1=' + F[t+5].toFixed(4) + ' phi=' + F[t+6].toFixed(4));
    }
    bunR.dispose && bunR.dispose();
  }
  let hulls = null;
  if (${process.env.HULLDUMP ? 'true' : 'false'}) {
    const sec3 = await importSvg(svgTxt, { preserveViewport: true });
    const bun3 = createBundle(gl, sec3);
    rLb.prepareBundle && rLb.prepareBundle(bun3);
    if (rLb.awaitLbReady) await rLb.awaitLbReady(bun3);
    hulls = [];
    const CX = ${+(process.env.HULLX || 32)};
    for (const m of (bun3._lbMeshes || [])) {
      if (!m || !m.verts || !m.vertexCount) continue;
      for (let i = 0; i + 2 < m.vertexCount; i += 3) {
        const T = [];
        const TC = [];
        for (let k = 0; k < 3; k++) { T.push([m.verts[(i + k) * 24], m.verts[(i + k) * 24 + 1]]);
          TC.push([m.verts[(i + k) * 24 + 2], m.verts[(i + k) * 24 + 3], m.verts[(i + k) * 24 + 4]]); }
        const sgn = m.verts[i * 24 + 6];
        const kind = Math.floor(m.verts[i * 24 + 5] + 0.001);
        const xs = T.map((q) => q[0]), ys = T.map((q) => q[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        // point-in-triangle for a probe point (PX,PY) in SVG coords
        const PX = ${+(process.env.HULLX || 32)} + 0.5, PY = ${+(process.env.HULLY || 20)};
        const sign = (a, b, c) => (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1]);
        const d1 = sign([PX, PY], T[0], T[1]), d2 = sign([PX, PY], T[1], T[2]), d3 = sign([PX, PY], T[2], T[0]);
        const neg = (d1 < 0) || (d2 < 0) || (d3 < 0), pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
        const PXb = ${+(process.env.HULLX || 32)} + 0.5, PYb = ${+(process.env.HULLY || 20)};
        const area2 = Math.abs((T[1][0]-T[0][0])*(T[2][1]-T[0][1]) - (T[2][0]-T[0][0])*(T[1][1]-T[0][1]));
        const R9 = ${+(process.env.HULLR || 1.5)};
        const inBox = x0 - R9 <= PXb && x1 + R9 >= PXb && y0 - R9 <= PYb && y1 + R9 >= PYb;
        if (inBox) hulls.push({ kind, x0, x1, y0, y1, T, TC, sgn, area2, contains: !(neg && pos) });
      }
    }
    bun3.dispose && bun3.dispose();
  }
  let segs = null;
  if (${process.env.SEGDUMP ? 'true' : 'false'}) {
    const sec2 = await importSvg(svgTxt, { preserveViewport: true });
    const bun2 = createBundle(gl, sec2);
    segs = [];
    for (const rg of (bun2.curveRangesByShape || [])) {
      for (const c of curveRangeToContours(bun2.curveFloats, rg.begin, rg.end)) {
        for (const sg of c) segs.push({ t: sg.type, p1: sg.p1, p2: sg.p2, p3: sg.p3 || null, p4: sg.p4 || null, w: sg.w || null });
      }
    }
    bun2.dispose && bun2.dispose();
  }
  const col = [];
  if (${process.env.COL ? 'true' : 'false'}) { const cx = ${+(process.env.COL || 32)};
    for (let y = 0; y < size; y++) col.push([y, Math.round(s[y * size + cx]), Math.round(ref[y * size + cx]), Math.round(x[y * size + cx])]);
  }
  let map = null;
  if (${process.env.MAP ? 'true' : 'false'}) {
    const g = (v) => v > 240 ? '.' : v > 200 ? ':' : v > 170 ? '+' : '#';
    map = { slug: [], lb: [] };
    for (let y = size - 1; y >= 0; y--) {            // bottom-up buffer → print top-down
      let rs = '', rl = '';
      for (let xq = 0; xq < size; xq++) { rs += g(s[y * size + xq]); rl += g(x[y * size + xq]); }
      map.slug.push(rs); map.lb.push(rl);
    }
  }
  return { partErr: globalThis.__lbPartitionErr || null, map, hulls, segs, col, slug: err(s), lb: err(x), lbVerts: x.verts, lbRouted: x.routed, edges: globalThis.__EDGE_TAP ? globalThis.__EDGE_TAP.flat() : null };
};
window.__ready = true;
</${'script'}></body></html>`;

const server = http.createServer((q, res) => {
  let f = q.url.split('?')[0];
  if (f === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    const body = readFileSync(path.join(ROOT, f));
    const ext = path.extname(f);
    const ct =
      ext === '.js' || ext === '.mjs'
        ? 'text/javascript'
        : ext === '.glsl'
          ? 'text/plain'
          : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('nf');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
// Runs on the machine's REAL GPU (ANGLE Metal on Apple silicon). ~76x faster than
// the SwiftShader software rasterizer and it is what users run — SwiftShader can
// MASK real-GPU bugs. The two do not agree numerically (AA means run ~1.5-2x
// higher on SwiftShader), so never compare a number across the two.
// SWIFTSHADER=1 forces the software path.
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.SWIFTSHADER === '1' ? ['--enable-unsafe-swiftshader', '--use-gl=swiftshader'] : [],
});
const pg = await browser.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
pg.on('console', (m) => {
  if (m.type() === 'error') console.error(' [console]', m.text());
});
await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
await pg.waitForFunction('window.__ready === true', { timeout: 120000 });

console.log(`\n  ${path.basename(DIR)} @${SIZE}px  POLYCLIP=${POLY ? 'ON' : 'off'}`);
console.log(
  '  icon                     slug(mean/bad/max)      lb(mean/bad/max)      verts routed',
);
const f2 = (e) =>
  `${e.mean.toFixed(2).padStart(5)}/${String(e.nBad).padStart(4)}/${String(Math.round(e.max)).padStart(4)}`;
let sm = 0,
  lm = 0,
  sb = 0,
  lb = 0;
for (const f of files) {
  const txt = readFileSync(path.join(DIR, f), 'utf8');
  let o;
  try {
    o = await pg.evaluate((s, z) => window.__run(s, z), txt, SIZE);
  } catch (e) {
    console.log(`   ${f.padEnd(24)} ERROR ${String(e.message).slice(0, 60)}`);
    continue;
  }
  sm += o.slug.mean;
  lm += o.lb.mean;
  sb += o.slug.nBad;
  lb += o.lb.nBad;
  if (o.partErr) console.log('     [partition threw] ' + String(o.partErr).slice(0, 200));
  console.log(
    `   ${f.replace(/\.svg$/, '').padEnd(24)} ${f2(o.slug).padEnd(22)}  ${f2(o.lb).padEnd(20)}  ${String(o.lbVerts).padStart(5)} ${o.lbRouted}`,
  );
  if (process.env.WORST && o.lb.worst.length)
    console.log(
      `     LB   worst (x,y,d,lb,ref):`,
      o.lb.worst
        .slice(0, 12)
        .map((w) => w.join(','))
        .join('  '),
    );
  if (process.env.WIND && o.segs) {
    // nonzero winding at the probe point, from the shape's own contours:
    // flatten every curve to 96 chords and count signed horizontal crossings.
    const qAt = (A, C, B, w, t) => {
      const u = 1 - t,
        d = u * u + 2 * u * t * w + t * t;
      return [
        (u * u * A[0] + 2 * u * t * w * C[0] + t * t * B[0]) / d,
        (u * u * A[1] + 2 * u * t * w * C[1] + t * t * B[1]) / d,
      ];
    };
    const pts = [];
    for (const g of o.segs) {
      const end = g.t === 0 ? g.p2 : g.t === 3 || g.t === 4 ? g.p4 || g.p3 : g.p3 || g.p2;
      if (!end) continue;
      if (g.t === 0) pts.push([g.p1, end]);
      else {
        let prev = g.p1;
        for (let i = 1; i <= 96; i++) {
          const q = qAt(g.p1, g.p2, end, g.w || 1, i / 96);
          pts.push([prev, q]);
          prev = q;
        }
      }
    }
    const PX = +(process.env.HULLX || 32) + 0.5,
      PY = +(process.env.HULLY || 30);
    let wind = 0;
    for (const [a, b] of pts) {
      if (a[1] <= PY === b[1] <= PY) continue;
      const t = (PY - a[1]) / (b[1] - a[1]);
      if (a[0] + t * (b[0] - a[0]) > PX) wind += b[1] > a[1] ? 1 : -1;
    }
    console.log(
      `     winding at (${PX}, ${PY}) = ${wind}  → nonzero says ${wind !== 0 ? 'INK' : 'EMPTY'}`,
    );
  }
  if (process.env.HULLDUMP && o.hulls) {
    console.log(
      `     tris CONTAINING (${+(process.env.HULLX || 32) + 0.5}, ${process.env.HULLY || 20}): ${o.hulls.length}`,
    );
    for (const h of o.hulls.slice(0, 60)) {
      console.log(
        `       kind=${h.kind} area2=${h.area2.toFixed(3)} contains=${h.contains} sign=${h.sgn} tri=${h.T.map((q) => q.map((v) => v.toFixed(2)).join(',')).join(' | ')}`,
      );
      console.log(
        `         tc =${h.TC.map((q) => q.map((v) => v.toFixed(3)).join(',')).join(' | ')}`,
      );
      // barycentric f = sign*(U^2 - V*R) at the probe point and at +-2px in x
      if (h.area2 < 1e-9) continue;
      const A = h.T[0],
        B = h.T[1],
        C = h.T[2];
      const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
      for (const dx of [-2, -0.5, 0, 0.5, 2]) {
        const PX = +(process.env.HULLX || 32) + 0.5 + dx,
          PY = +(process.env.HULLY || 20);
        const l1 = ((B[1] - C[1]) * (PX - C[0]) + (C[0] - B[0]) * (PY - C[1])) / den;
        const l2 = ((C[1] - A[1]) * (PX - C[0]) + (A[0] - C[0]) * (PY - C[1])) / den;
        const l3 = 1 - l1 - l2;
        const U = l1 * h.TC[0][0] + l2 * h.TC[1][0] + l3 * h.TC[2][0];
        const V = l1 * h.TC[0][1] + l2 * h.TC[1][1] + l3 * h.TC[2][1];
        const R = l1 * h.TC[0][2] + l2 * h.TC[1][2] + l3 * h.TC[2][2];
        console.log(
          `         x=${PX.toFixed(1)}  U=${U.toFixed(4)} V=${V.toFixed(4)} R=${R.toFixed(4)}  f=${(h.sgn * (U * U - V * R)).toFixed(5)}`,
        );
      }
    }
  }
  if (process.env.SEGDUMP && o.segs) {
    console.log(`     segs: ${o.segs.length}`);
    // END point by type: line p2 · quad/rquad p3 · cubic/arc p4 (segment.js segEnd)
    for (const g of o.segs) {
      const end = g.t === 0 ? g.p2 : g.t === 3 || g.t === 4 ? g.p4 || g.p3 : g.p3 || g.p2;
      if (!end) continue;
      const dx = Math.abs(end[0] - g.p1[0]),
        dy = Math.abs(end[1] - g.p1[1]);
      const HY = +(process.env.HSCAN || 0);
      const nearRow =
        HY > 0 &&
        ((g.p1[1] > HY - 1.2 && g.p1[1] < HY + 1.2) || (end[1] > HY - 1.2 && end[1] < HY + 1.2));
      const near32 = Math.abs(g.p1[0] - 32) < 0.6 || Math.abs(end[0] - 32) < 0.6;
      if (nearRow || (HY === 0 && ((dx < 0.6 && dy > 1.0) || near32)))
        console.log(
          `       t=${g.t} (${g.p1[0].toFixed(2)},${g.p1[1].toFixed(2)})->(${end[0].toFixed(2)},${end[1].toFixed(2)})` +
            (g.p2 && g.t !== 0 ? ` c(${g.p2[0].toFixed(2)},${g.p2[1].toFixed(2)}) w=${g.w}` : ''),
        );
    }
  }
  if (process.env.MAP && o.map) {
    console.log('     SLUG (left)            LB (right)   [# ink · . empty]');
    for (let i = 0; i < o.map.slug.length; i += 1)
      console.log('       ' + o.map.slug[i] + '   ' + o.map.lb[i]);
  }
  if (process.env.COL && o.col && o.col.length) {
    console.log(
      `     col x=${process.env.COL}  rasterY: slug1x / slug8xREF / LB   (bottom-up; ink=152 cyan, bg=255)`,
    );
    for (const [y, sv, rv, lv] of o.col)
      if (y >= +(process.env.COLLO || 20) && y <= +(process.env.COLHI || 45))
        console.log(
          `       y=${String(y).padStart(2)}  ${String(sv).padStart(4)} ${String(rv).padStart(5)} ${String(lv).padStart(5)}`,
        );
  }
  if (process.env.EDGETAP && o.edges) {
    const vert = o.edges.filter(
      (e) => Math.abs(e.p1[0] - e.p2[0]) < 1e-4 && Math.abs(e.p1[1] - e.p2[1]) > 2,
    );
    console.log(
      `     vertical edges (${vert.length}):`,
      vert
        .slice(0, 10)
        .map((e) => `x=${e.p1[0].toFixed(2)} y${e.p1[1].toFixed(1)}..${e.p2[1].toFixed(1)}`)
        .join('  '),
    );
  }
  if (process.env.WORST && o.slug.worst.length)
    console.log(
      `     SLUG worst (x,y,d,val,ref):`,
      o.slug.worst
        .slice(0, 12)
        .map((w) => w.join(','))
        .join('  '),
    );
}
console.log(
  `  ─── totals: slug mean=${sm.toFixed(2)} bad=${sb}   lb mean=${lm.toFixed(2)} bad=${lb}`,
);
// REFERENCE TRUST: the reference is Slug at 8x. When Slug at 1x disagrees with
// its own 8x downsample by a lot, the reference is not ground truth for that
// shape and neither column means anything. On the pause ring icons Slug's mean
// runs 3-5 with ~300 bad cells, and an independent browser raster sides with LB
// on 8 of 9 flagged cells - such "LB defects" are reference artifacts.
// Cross-check any flagged cell against a browser raster before
// believing it.
if (sm > 1.0)
  console.log(
    `  [warn] slug mean=${sm.toFixed(2)} — Slug disagrees with its own 8x reference; treat these numbers as UNTRUSTED and adjudicate flagged cells against a browser raster.`,
  );
await browser.close();
server.close();
