// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// paintConflation.mjs -- what an exact-area, per-paint AA engine gets wrong where several authored paints are partly
// inside one pixel. Every engine here computes one coverage per paint and composites in paint order, which
// treats the paints' pixel footprints as independent. Chrome (and the project's 8x box reference) composites per SAMPLE, which
// keeps their overlap. This model supplies both from one supersampled fill state: "engine" = ordered source-over of the exact
// per-paint coverage (the best any per-paint-coverage engine can do), "truth" = ordered source-over per sample, averaged.
// Their difference is the conflation floor of the technique, independent of any shader.
//
//   node probes/aaFold/paintConflation.mjs --assets a.svg[,b.svg] --sizes 32,512 [--ss 8] [--list N]
// Solid fills only (fill="#rgb|#rrggbb", fill-opacity, opacity of the element); strokes, gradients and groups are not modeled,
// so the numbers are for the FILL paints of the artwork.
import { readFileSync } from 'fs';
import path from 'path';
const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const TREE = path.resolve(
  flag('tree', path.join(path.dirname(new URL(import.meta.url).pathname), '../..')),
);
if (typeof DOMParser === 'undefined') {
  const x = await import(path.join(TREE, '../node_modules/@xmldom/xmldom/lib/index.js'));
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const src = (p) => import(path.join(TREE, p));
const { default: importSvg } = await src('src/svg/importer.js');
const CB = await src('src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await src('src/geom/lbContour.js');
const { flatten } = await import('./aacFoldModel.mjs');
const SS = +flag('ss', 8),
  LIST = +flag('list', 0),
  CLS = argv.includes('--classify'),
  HIDE = argv.includes('--hide');
const { segPt } = await src('src/geom/cpatchImplicit.js');
for (const file of flag('assets').split(',')) {
  const svg = readFileSync(file, 'utf8');
  const sc = await importSvg(svg, { preserveViewport: true });
  const meta = new Float32Array(sc.meta.buffer ? sc.meta.buffer : sc.meta); // 4-float header, then 48 floats a shape; texel 2 = (r, g, b, a) of a solid fill
  const b = CB.headlessCPatchBundle(sc),
    cf = CB.cpatchCurvePlane(b);
  const shapes = [];
  let X0 = Infinity,
    Y0 = Infinity,
    X1 = -Infinity,
    Y1 = -Infinity;
  for (let s = 0; s < b.curveRangesByShape.length; s++) {
    if (/_stroke$/.test(sc.shapeIds[s] || '')) continue;
    const mo = s * 48 + 4 + 8,
      rgb = [meta[mo] * 255, meta[mo + 1] * 255, meta[mo + 2] * 255],
      a = meta[mo + 3];
    if (!(a > 0)) continue;
    const r = b.curveRangesByShape[s],
      cs = CB.contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null);
    if (!cs.length) continue;
    const segs = flatten(cs);
    let sx0 = 1e30,
      sy0 = 1e30,
      sx1 = -1e30,
      sy1 = -1e30;
    for (const [p, q] of segs)
      for (const v of [p, q]) {
        sx0 = Math.min(sx0, v[0]);
        sx1 = Math.max(sx1, v[0]);
        sy0 = Math.min(sy0, v[1]);
        sy1 = Math.max(sy1, v[1]);
      }
    X0 = Math.min(X0, sx0);
    X1 = Math.max(X1, sx1);
    Y0 = Math.min(Y0, sy0);
    Y1 = Math.max(Y1, sy1);
    shapes.push({ s, rgb, a, segs, eo: CB.shapeEvenOdd(b, s), bb: [sx0, sy0, sx1, sy1] });
  }
  // THE HIDDEN-EDGE RULE: a segment of paint P1 exactly coincident (control points equal to 1e-6 of the drawing's size, either
  // direction) with a segment of a LATER OPAQUE paint P2, with both fills on the same side of it, is hidden: P1 contributes nothing
  // near it. flagged pieces: [{ a, b }] flattened chords, kept away from the segment's own ends by one pixel (the end pixels keep today's
  // coverage -- there P1's other boundary may leave P2).
  const gbb = sc.globalBBox,
    extAll = Math.max(gbb[2] - gbb[0], gbb[3] - gbb[1]),
    qk = 1e-6 * extAll;
  const keyOf = (P) => {
    const f = P.map((p) => Math.round(p[0] / qk) + ',' + Math.round(p[1] / qk));
    const r = [...f].reverse();
    const a = f.join(';'),
      c = r.join(';');
    return a < c ? a : c;
  };
  const inFill = (sh, px, py) => {
    let w = 0,
      c = 0;
    for (const [p, q] of sh.segs)
      if (p[1] <= py !== q[1] <= py) {
        const xx = p[0] + ((py - p[1]) / (q[1] - p[1])) * (q[0] - p[0]);
        if (xx > px) {
          w += q[1] > p[1] ? 1 : -1;
          c++;
        }
      }
    return sh.eo ? (c & 1) === 1 : w !== 0;
  };
  if (HIDE) {
    const bySeg = new Map();
    for (const sh of shapes) {
      sh.auth = [];
      const r = b.curveRangesByShape[sh.s];
      const cs = CB.contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null);
      for (const c of cs)
        for (const g of c) {
          const k = keyOf(g.P);
          sh.auth.push({ g, k });
          if (!bySeg.has(k)) bySeg.set(k, []);
          bySeg.get(k).push(sh);
        }
    }
    for (const sh of shapes) {
      sh.hid = [];
      for (const sg of sh.auth) {
        const P = sg.g.P,
          m = segPt(sg.g, 0.5),
          t = segPt(sg.g, 0.52),
          u = segPt(sg.g, 0.48);
        let nx = -(t[1] - u[1]),
          ny = t[0] - u[0];
        const nl = Math.hypot(nx, ny) || 1;
        nx /= nl;
        ny /= nl;
        const e = 1e-4 * extAll;
        const side = (q) => [
          inFill(q, m[0] + nx * e, m[1] + ny * e),
          inFill(q, m[0] - nx * e, m[1] - ny * e),
        ];
        const mine = side(sh);
        for (const o of bySeg.get(sg.k)) {
          if (o.s <= sh.s || o.a < 0.999) continue;
          const th = side(o);
          if (th[0] === mine[0] && th[1] === mine[1]) {
            sg.hidden = true;
            break;
          }
        }
        if (sg.hidden) sh.hid.push(sg);
      }
    }
  }
  for (const N of flag('sizes', '512').split(',').map(Number)) {
    const ext = Math.max(X1 - X0, Y1 - Y0),
      epp = ext / N,
      W = Math.ceil((X1 - X0) / epp) + 2,
      H = Math.ceil((Y1 - Y0) / epp) + 2,
      x0 = X0 - epp,
      y0 = Y0 - epp;
    if (HIDE)
      for (const sh of shapes) {
        sh.zero = new Set();
        if (!sh.hid.length) continue;
        const fl = new Set(),
          un = new Set(),
          R = 0.7072 * epp;
        for (const sg of sh.auth) {
          const P = sg.g.P,
            A = P[0],
            Z = P[P.length - 1],
            n = P.length === 2 ? 1 : 64;
          let prev = A;
          for (let k = 1; k <= n; k++) {
            const q = k === n ? Z : segPt(sg.g, k / n),
              mx = (prev[0] + q[0]) / 2,
              my = (prev[1] + q[1]) / 2;
            const nearEnd =
              Math.hypot(mx - A[0], my - A[1]) < epp || Math.hypot(mx - Z[0], my - Z[1]) < epp;
            const tgt = sg.hidden && !nearEnd ? fl : un;
            const i0 = Math.floor((Math.min(prev[0], q[0]) - R - x0) / epp),
              i1 = Math.ceil((Math.max(prev[0], q[0]) + R - x0) / epp);
            const j0 = Math.floor((Math.min(prev[1], q[1]) - R - y0) / epp),
              j1 = Math.ceil((Math.max(prev[1], q[1]) + R - y0) / epp);
            const dx = q[0] - prev[0],
              dy = q[1] - prev[1],
              L2 = dx * dx + dy * dy;
            for (let j = j0; j <= j1; j++)
              for (let i = i0; i <= i1; i++) {
                const cx = x0 + (i + 0.5) * epp,
                  cy = y0 + (j + 0.5) * epp;
                let t = L2 ? ((cx - prev[0]) * dx + (cy - prev[1]) * dy) / L2 : 0;
                t = Math.max(0, Math.min(1, t));
                if (Math.hypot(cx - (prev[0] + t * dx), cy - (prev[1] + t * dy)) <= R)
                  tgt.add(j * 100003 + i);
              }
            prev = q;
          }
        }
        for (const k of fl) if (!un.has(k)) sh.zero.add(k);
      }
    const NS = SS * SS;
    let n1 = 0,
      n8 = 0,
      mx = 0,
      edge = 0;
    const list = [],
      hist = {},
      errBy = {};
    for (let j = 0; j < H; j++) {
      const truth = new Float64Array(W * NS * 4),
        eng = new Float64Array(W * 4); // premultiplied RGBA 0..255
      let touched = false;
      const masks = new Map(); // pixel -> [{ id, lo, hi, n }]: which of the 64 samples each paint covers (the conflation classification)
      for (const sh of shapes) {
        if (sh.bb[3] < y0 + j * epp || sh.bb[1] > y0 + (j + 1) * epp) continue;
        const i0 = Math.max(0, Math.floor((sh.bb[0] - x0) / epp)),
          i1 = Math.min(W - 1, Math.ceil((sh.bb[2] - x0) / epp));
        const cov = new Float64Array(i1 - i0 + 1);
        for (let sy = 0; sy < SS; sy++) {
          const y = y0 + (j + (sy + 0.5) / SS) * epp,
            xs = [];
          for (const [p, q] of sh.segs)
            if (p[1] <= y !== q[1] <= y)
              xs.push([p[0] + ((y - p[1]) / (q[1] - p[1])) * (q[0] - p[0]), q[1] > p[1] ? 1 : -1]);
          if (!xs.length) continue;
          xs.sort((u, v) => u[0] - v[0]);
          for (let i = i0; i <= i1; i++)
            for (let sx = 0; sx < SS; sx++) {
              const x = x0 + (i + (sx + 0.5) / SS) * epp;
              let w = 0,
                c = 0;
              for (const [cx, dw] of xs)
                if (cx > x) {
                  w += dw;
                  c++;
                }
              if (sh.eo ? c & 1 : w !== 0) {
                cov[i - i0]++;
                touched = true;
                {
                  let e = masks.get(i);
                  if (!e) masks.set(i, (e = []));
                  let m = e.length && e[e.length - 1].id === sh.s ? e[e.length - 1] : null;
                  if (!m) e.push((m = { id: sh.s, lo: 0, hi: 0, n: 0, op: sh.a >= 0.999 }));
                  const bit = sy * SS + sx;
                  if (bit < 32) m.lo |= 1 << bit;
                  else m.hi |= 1 << (bit - 32);
                  m.n++;
                }
                const o = (i * NS + sy * SS + sx) * 4,
                  ia = 1 - sh.a; // per-sample source-over
                truth[o] = sh.rgb[0] * sh.a + truth[o] * ia;
                truth[o + 1] = sh.rgb[1] * sh.a + truth[o + 1] * ia;
                truth[o + 2] = sh.rgb[2] * sh.a + truth[o + 2] * ia;
                truth[o + 3] = 255 * sh.a + truth[o + 3] * ia;
              }
            }
        }
        for (let i = i0; i <= i1; i++) {
          // per-paint coverage, composited in order
          const c = HIDE && sh.zero.has(j * 100003 + i) ? 0 : cov[i - i0] / NS;
          if (c === 0) continue;
          const a = sh.a * c,
            ia = 1 - a,
            o = i * 4;
          eng[o] = sh.rgb[0] * a + eng[o] * ia;
          eng[o + 1] = sh.rgb[1] * a + eng[o + 1] * ia;
          eng[o + 2] = sh.rgb[2] * a + eng[o + 2] * ia;
          eng[o + 3] = 255 * a + eng[o + 3] * ia;
        }
      }
      if (!touched) continue;
      for (let i = 0; i < W; i++) {
        let d = 0;
        for (let k = 0; k < 4; k++) {
          let t = 0;
          for (let q = 0; q < NS; q++) t += truth[(i * NS + q) * 4 + k];
          t /= NS;
          d = Math.max(d, Math.abs(t - eng[i * 4 + k]));
        }
        if (CLS) {
          const e = (masks.get(i) || []).filter((m) => m.n > 0 && m.n < NS);
          const K = e.length;
          let cls = 'none';
          if (K >= 2) {
            // hidden: every partial paint but the last is wholly under later OPAQUE partial paints (the occluded edge conflation
            // that culling removes at shape granularity); abut: no two partial masks share a sample; otherwise a true overlap
            let hidden = true,
              inter = false;
            for (let a = 0; a < K; a++) {
              let ul = 0,
                uh = 0;
              for (let b = a + 1; b < K; b++)
                if (e[b].op) {
                  ul |= e[b].lo;
                  uh |= e[b].hi;
                }
              if (a < K - 1 && ((e[a].lo & ~ul) !== 0 || (e[a].hi & ~uh) !== 0)) hidden = false;
              for (let b = a + 1; b < K; b++)
                if ((e[a].lo & e[b].lo) !== 0 || (e[a].hi & e[b].hi) !== 0) inter = true;
            }
            cls = hidden ? 'hidden' : inter ? 'overlap' : 'abut';
          }
          const kk = Math.min(K, 4);
          hist[kk] = (hist[kk] || 0) + 1;
          if (d > 1) {
            const key = kk + ':' + cls;
            errBy[key] = (errBy[key] || 0) + 1;
          }
        }
        if (d > 1) {
          n1++;
          if (d > 8) n8++;
          if (d > mx) mx = d;
          if (list.length < LIST) list.push(`  px(${i},${j}) err ${d.toFixed(1)}`);
        }
      }
    }
    console.log(
      `${path.basename(file)} @${N}: fill paints ${shapes.length}  px>1B ${n1}  px>8B ${n8}  max ${mx.toFixed(1)}B   (of ${W * H} px)`,
    );
    if (CLS) {
      console.log(
        '   partial-paint count per pixel (K=0 interior/empty not listed):',
        JSON.stringify(Object.fromEntries(Object.entries(hist).filter(([k]) => k !== '0'))),
      );
      console.log('   pixels over 1 byte by K:class', JSON.stringify(errBy));
    }
    for (const l of list) console.log(l);
  }
}
