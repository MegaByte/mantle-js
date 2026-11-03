// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _emSiteCensus — what is each em-tuned length WORTH, in scale-free units, over the corpus?
//
// Runs buildLbShape per shape with the __LB_EMT hook on and, per site, records the quantity `q` the
// constant is compared against, the references it could be expressed in, whether the site's OTHER
// conditions passed (so a constant is only credited with the decisions it actually owns), and the
// current verdict `hit`.
//
// THE HOOK IS NOT IN THE PACKAGE SOURCE -- the sites it would sit at are the builder's innermost
// loops and must not pay a property lookup for a probe. Re-add it to run this: a one-line helper that
// pushes a record onto globalThis.__LB_EMT, called at each site, with the record shape each site needs
// in the PLAN table at the bottom of this file. Without it the probe reports "no sites recorded" and
// exits; lbPartition.js is the exception, its __LB_HULLDUMP hook is in the package.
//
// It then prints, per site:
//   sep      the gap between the HIT population's top and the MISS population's bottom, in each
//            reference. A gap means SOME coefficient reproduces every scale-1 decision; an overlap
//            means none does, and the report has to justify what moves.
//   sweep    for a ladder of coefficients c, how many DECIDING records (other === true) flip.
//
// References: span = the shape's own extent (65536 / _koScale, the bbox diagonal snapped to a power
// of two, exactly equivariant), fs = the face's own sqrt(area), ms = the face's longest side, len =
// the candidate edge's length, ulp = a float32 ulp of the coordinates, chord/sag for a hull.
//
//   node probes/lbEmTuned/_emSiteCensus.mjs [file.svg ...]        OUT=x.json  TOP=1
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { buildLbShape } = await import('../../src/renderer/lbBuildCore.js');
const { parseMetaBin } = await import('../../src/core/metaBin.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const _warn = console.warn;
if (!process.env.WARN) console.warn = () => {};

let files = process.argv.slice(2);
if (!files.length) {
  const dir = (d) =>
    existsSync(path.join(ROOT, d))
      ? readdirSync(path.join(ROOT, d))
          .filter((f) => f.endsWith('.svg'))
          .sort()
          .map((f) => d + '/' + f)
      : [];
  files = [...dir('examples'), ...dir('examples/smoke')];
}

const sites = new Map();
let cur = null;
globalThis.__LB_EMT = (site, rec, span) => {
  let s = sites.get(site);
  if (!s) sites.set(site, (s = []));
  if (s.length < 600000) s.push({ ...rec, span, who: cur });
};

for (const f of files) {
  let svg;
  try {
    svg = readFileSync(path.resolve(ROOT, f), 'utf8');
  } catch {
    continue;
  }
  svg = svg
    .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
    .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
  let sec;
  try {
    sec = await importSvg(svg, { preserveViewport: true });
  } catch {
    continue;
  }
  if (!sec || !sec.curves || !sec.numShapes) continue;
  const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  const fps = meta.floatsPerShape,
    mf = meta.metaFloats;
  const p32 = new Float32Array(sec.curves);
  for (let s = 0; s < meta.numShapes; s++) {
    const r = (sec.curveRangesByShape || [])[s];
    if (!r || r.end <= r.begin || !(mf[s * fps + 7] > 0)) continue;
    const bb = s * fps;
    const transSolid =
      mf[bb + 7] < 0.996 &&
      Math.floor(mf[bb + 28] + 0.5) === 0 &&
      (fps < 36 || Math.floor(mf[bb + 35] + 0.5) === 0);
    const evenOdd = mf[bb + 13] > 0.5;
    const c = curveRangeToContours(p32, r.begin, r.end);
    if (!c) continue;
    cur = f + '#' + s;
    try {
      buildLbShape(c, transSolid, evenOdd);
    } catch {
      /* build failures are not this probe's subject */
    }
  }
}
console.warn = _warn;
if (!sites.size) {
  console.log(
    'no sites recorded: the __LB_EMT calls are not in src/. Re-add them at the sites in the PLAN table at the bottom of this probe.',
  );
  process.exit(2);
}

// site -> { dir: '<' or '>', refs: {name: fn} }.  dir '<' means hit === (q < K).
const PLAN = {
  i1225: { dir: '>', refs: { span: (r) => r.span, fs: (r) => r.fs, ms: (r) => r.ms } },
  i1235: { dir: '>', refs: { span: (r) => r.span } },
  i1248: { dir: '>', refs: { span: (r) => r.span, fs: (r) => r.fs } },
  i1302: { dir: '<=', refs: { span: (r) => r.span, fs: (r) => r.fs } },
  i835: { dir: '<', refs: { span2: (r) => r.span * r.span, ms2: (r) => r.ms * r.ms } },
  i868: { dir: '<', refs: { span2: (r) => r.span * r.span, ms2: (r) => r.ms * r.ms } },
  i846: { dir: '>', refs: { span: (r) => r.span, ulp: (r) => r.u } },
  i846min: { dir: '>', refs: { span: (r) => r.span, ulp: (r) => r.u } },
  i872: { dir: '<=', refs: { span: (r) => r.span, ulp: (r) => r.u } },
  i614: { dir: '<', refs: { span: (r) => r.span, len: (r) => r.len } },
  i840: { dir: '<', refs: { span: (r) => r.span, len: (r) => r.len } },
  i885: { dir: '<', refs: { span: (r) => r.span, len: (r) => r.len } },
  i620: { dir: '>', refs: { span: (r) => r.span, ulp: (r) => r.u } },
  i607: { dir: '<', refs: { span: (r) => r.span, ulp: (r) => r.u } },
  i512: { dir: '<', refs: { span: (r) => r.span, m2s: (r) => Math.max(r.m2, r.span) } },
  iEML: { dir: '>', refs: { span: (r) => r.span, ms: (r) => r.ms } },
  p2165: { dir: '>', refs: { span: (r) => r.span, chord: (r) => r.chord, sag: (r) => r.sag } },
};

const LADDER = [];
for (let e = -20; e <= 0; e++) {
  LADDER.push(10 ** e);
  LADDER.push(3 * 10 ** e);
}
LADDER.sort((a, b) => a - b);

const out = {};
for (const [site, recs] of [...sites].sort()) {
  const p = PLAN[site];
  const dec = recs.filter((r) => r.other !== false);
  const hit = dec.filter((r) => r.hit),
    miss = dec.filter((r) => !r.hit);
  console.log(
    `\n== ${site} ==  records ${recs.length}  deciding ${dec.length}  hit ${hit.length}  miss ${miss.length}  shapes ${new Set(recs.map((r) => r.who)).size}`,
  );
  if (!p) continue;
  out[site] = { n: dec.length, hit: hit.length, miss: miss.length, refs: {} };
  for (const [rn, rf] of Object.entries(p.refs)) {
    const H = hit
      .map((r) => r.q / rf(r))
      .filter(isFinite)
      .sort((a, b) => a - b);
    const M = miss
      .map((r) => r.q / rf(r))
      .filter(isFinite)
      .sort((a, b) => a - b);
    // dir '<' (hit means q below K): a coefficient exists iff max(HIT) < min(MISS).
    const lo =
      p.dir[0] === '<'
        ? H.length
          ? H[H.length - 1]
          : -Infinity
        : M.length
          ? M[M.length - 1]
          : -Infinity;
    const hi = p.dir[0] === '<' ? (M.length ? M[0] : Infinity) : H.length ? H[0] : Infinity;
    const clean = lo < hi;
    console.log(
      `   ${rn.padEnd(6)} hit[${H.length ? H[0].toExponential(2) + ' .. ' + H[H.length - 1].toExponential(2) : '-'}]  miss[${M.length ? M[0].toExponential(2) + ' .. ' + M[M.length - 1].toExponential(2) : '-'}]  ${clean ? `SEPARATES: any c in (${lo.toExponential(2)}, ${hi.toExponential(2)})` : 'OVERLAPS'}`,
    );
    // sweep: flips per coefficient
    const rows = [];
    for (const c of LADDER) {
      let flip = 0;
      for (const r of dec) {
        const v = r.q / rf(r);
        const now = !!r.hit;
        const then = p.dir[0] === '<' ? (p.dir === '<=' ? v <= c : v < c) : v > c;
        if (now !== then) flip++;
      }
      rows.push([c, flip]);
    }
    const best = rows.reduce((a, b) => (b[1] < a[1] ? b : a));
    const zero = rows.filter((x) => x[1] === 0).map((x) => x[0]);
    console.log(
      `          sweep: best c=${best[0].toExponential(0)} flips ${best[1]}${zero.length ? `;  zero-flip c in [${zero[0].toExponential(0)} .. ${zero[zero.length - 1].toExponential(0)}]` : ''}`,
    );
    out[site].refs[rn] = { lo, hi, clean, sweep: rows, zero };
  }
  if (process.env.TOP) {
    const key = Object.keys(p.refs)[0],
      rf = p.refs[key];
    const ex = (a, n) =>
      a
        .slice(0, n)
        .map((r) => `${r.who} ${(r.q / rf(r)).toExponential(2)}`)
        .join('  ');
    console.log(
      `          hit examples:  ${ex(
        hit.slice().sort((a, b) => rf(b) && b.q / rf(b) - a.q / rf(a)),
        6,
      )}`,
    );
    console.log(
      `          miss examples: ${ex(
        miss.slice().sort((a, b) => a.q / rf(a) - b.q / rf(b)),
        6,
      )}`,
    );
  }
}
if (sites.has('p2165')) {
  const all = sites.get('p2165');
  const byN = {};
  for (const r of all) byN[r.n] = (byN[r.n] | 0) + 1;
  console.log(
    `\np2165 n histogram ${JSON.stringify(byN)};  cap ${all.filter((r) => r.cap).length}/${all.length};  conic ${all.filter((r) => r.conic).length}`,
  );
  const sp = all.map((r) => r.sag / r.span).sort((a, b) => a - b);
  console.log(
    `p2165 sag/span: min ${sp[0].toExponential(2)} p50 ${sp[sp.length >> 1].toExponential(2)} max ${sp[sp.length - 1].toExponential(2)}`,
  );
  // what n would a relative tolerance c*span ask for, and how many hulls move?
  for (const c of [3e-6, 1e-5, 1.5259e-5, 3e-5, 1e-4]) {
    let same = 0,
      finer = 0,
      coarser = 0,
      cap = 0;
    for (const r of all) {
      let n = 2;
      while (n < 64 && r.sag / (n * n) > c * r.span) n *= 2;
      if (n === r.n) same++;
      else if (n > r.n) finer++;
      else coarser++;
      if (n >= 64) cap++;
    }
    console.log(
      `  tol = ${c.toExponential(3)}*span: same ${same}  finer ${finer}  coarser ${coarser}  capped ${cap}/${all.length}`,
    );
  }
}
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(out));
