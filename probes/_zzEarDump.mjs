// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzEarDump — the ear cut that invented area: its chord, and what the loop looks like there.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { rowSpans, insideContour, patchBBox } from '../src/renderer/cpatchConvert.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const S = +(process.env.S || 82);
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float64Array(sec.curves64);
const r = sec.curveRangesByShape[S];
const list = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
const src = [];
for (const c of list) for (const sg of c) src.push(sg);
const D = [];
globalThis.__CP_EAR_DUMP = D;
packCPatchShape(list, 0, {});
console.log(`${D.length} ear cuts on s${S}`);
const K = 15;
const frac = (l) => {
  const b = patchBBox(l);
  if (!b) return 0;
  let inL = 0,
    out = 0;
  for (let j = 0; j < K; j++)
    for (let i = 0; i < K; i++) {
      const x = b[0] + ((b[2] - b[0]) * (i + 0.5)) / K,
        y = b[1] + ((b[3] - b[1]) * (j + 0.5)) / K;
      if (!insideContour(l, x, y)) continue;
      inL++;
      let ok = false;
      for (const sp of rowSpans(src, y) || []) if (x >= sp[0] && x <= sp[1]) ok = true;
      if (!ok) out++;
    }
  return inL ? out / inL : 0;
};
for (const d of D) {
  const fp = frac(d.piece),
    fr = frac(d.rest),
    fl = frac(d.loop);
  if (fp < 0.05 && fr < 0.05) continue;
  console.log(
    `  ear e=${d.e} N=${d.N}: loop ${d.loop.length} (${(fl * 100).toFixed(0)}% out)` +
      ` -> piece ${d.piece.length} (${(fp * 100).toFixed(0)}% out), rest ${d.rest.length} (${(fr * 100).toFixed(0)}% out)`,
  );
  console.log(
    `     chord a (${d.a[0].toFixed(3)}, ${d.a[1].toFixed(3)}) -> b (${d.b[0].toFixed(3)}, ${d.b[1].toFixed(3)})`,
  );
  // is the chord actually inside the loop? sample it
  let outN = 0,
    tot = 0;
  for (let t = 1; t < 40; t++) {
    const u = t / 40,
      x = d.a[0] + (d.b[0] - d.a[0]) * u,
      y = d.a[1] + (d.b[1] - d.a[1]) * u;
    tot++;
    if (!insideContour(d.loop, x, y)) outN++;
  }
  console.log(`     the chord is outside its own loop at ${outN} of ${tot} samples`);
  console.log(
    `     loop segs: ` +
      d.loop
        .map(
          (sg, k) =>
            `${k}:${sg.t[0]}${sg.cut ? '*' : ''}(${segPt(sg, 0)[0].toFixed(1)},${segPt(sg, 0)[1].toFixed(1)})`,
        )
        .join(' '),
  );
}

// ---- the accepted chord, examined ----
{
  let d = D[0],
    bf = -1;
  for (const e of D) {
    const f = frac(e.piece);
    if (f > bf) {
      bf = f;
      d = e;
    }
  }
  console.log(
    `\nworst ear: piece ${(bf * 100).toFixed(0)}% outside the shape, e=${d.e} N=${d.N}, loop ${d.loop.length}`,
  );
  const a = d.a,
    b = d.b;
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    L = Math.hypot(dx, dy);
  const h = [-dy / L, dx / L, -((-dy / L) * a[0] + (dx / L) * a[1])];
  const ux = dx / L,
    uy = dy / L;
  const { affRootsOnSeg, segTightBBox } = await import('../src/geom/cpatchImplicit.js');
  console.log(`\nthe accepted chord, crossing by crossing (L = ${L.toFixed(3)}):`);
  const cx0 = Math.min(a[0], b[0]) - 1e-9,
    cx1 = Math.max(a[0], b[0]) + 1e-9;
  const cy0 = Math.min(a[1], b[1]) - 1e-9,
    cy1 = Math.max(a[1], b[1]) + 1e-9;
  for (let k = 0; k < d.loop.length; k++) {
    const sg = d.loop[k],
      sb = segTightBBox(sg);
    const boxed = !(sb[2] < cx0 || sb[0] > cx1 || sb[3] < cy0 || sb[1] > cy1);
    const ts = affRootsOnSeg(h, sg);
    if (!ts.length) continue;
    for (const t of ts) {
      const q = segPt(sg, t);
      const u = ((q[0] - a[0]) * ux + (q[1] - a[1]) * uy) / L;
      const near = Math.min(
        Math.hypot(q[0] - a[0], q[1] - a[1]),
        Math.hypot(q[0] - b[0], q[1] - b[1]),
      );
      const kept = boxed && u > 1e-6 && u < 1 - 1e-6 && near >= 1e-7;
      if (u < -0.2 || u > 1.2) continue;
      console.log(
        `   seg ${k} (${sg.t}) t=${t.toFixed(6)} at (${q[0].toFixed(3)},${q[1].toFixed(3)}) u=${u.toFixed(6)}` +
          ` box=${boxed ? 'meets' : 'MISSES'} nearEnd=${near.toExponential(2)} -> ${kept ? 'REJECTS the chord' : 'skipped'}`,
      );
    }
  }
  console.log(
    `   chord samples inside the loop: ` +
      Array.from({ length: 9 }, (_, i) => {
        const u = (i + 1) / 10;
        return `${u.toFixed(1)}:${insideContour(d.loop, a[0] + dx * u, a[1] + dy * u) ? 'in' : 'out'}`;
      }).join(' '),
  );
}

// ---- the row that disagrees with its neighbours ----
{
  let d = D[0],
    bf = -1;
  for (const e of D) {
    const f = frac(e.piece);
    if (f > bf) {
      bf = f;
      d = e;
    }
  }
  const { segTightBBox } = await import('../src/geom/cpatchImplicit.js');
  const a = d.a,
    b = d.b;
  console.log('\nthe spans at each sample row (the winding, per row):');
  for (const u of [0.4, 0.5, 0.6]) {
    const x = a[0] + (b[0] - a[0]) * u,
      y = a[1] + (b[1] - a[1]) * u;
    const sp = rowSpans(d.loop, y) || [];
    console.log(
      `  u=${u} y=${y.toFixed(9)} x=${x.toFixed(3)}: ${sp.length} spans ` +
        sp.map((s) => `[${s[0].toFixed(3)}, ${s[1].toFixed(3)}]`).join(' '),
    );
    // which segments does this row cross at all?
    const hit = [];
    for (let k = 0; k < d.loop.length; k++) {
      const bb = segTightBBox(d.loop[k]);
      if (y >= bb[1] && y < bb[3]) hit.push(`${k}(y ${bb[1].toFixed(6)}..${bb[3].toFixed(6)})`);
      else if (y >= bb[1] - 1e-3 && y < bb[3] + 1e-3)
        hit.push(`${k}:NEAR(y ${bb[1].toFixed(6)}..${bb[3].toFixed(6)})`);
    }
    console.log(`      segments whose y-range holds the row: ${hit.join(' ')}`);
  }
}

// ---- exactly how far is the bad row from the vertex? ----
{
  let d = D[0],
    bf = -1;
  for (const e of D) {
    const f = frac(e.piece);
    if (f > bf) {
      bf = f;
      d = e;
    }
  }
  const y = (d.a[1] + d.b[1]) / 2;
  console.log(`\nrow y = ${y.toPrecision(20)}`);
  for (let k = 0; k < d.loop.length; k++) {
    const P = d.loop[k].P;
    for (const [w, q] of [
      ['start', P[0]],
      ['end', P[P.length - 1]],
    ]) {
      if (Math.abs(q[1] - y) < 1e-6)
        console.log(
          `   seg ${k} ${w} y = ${q[1].toPrecision(20)}  delta ${(q[1] - y).toExponential(3)}  equal=${q[1] === y}`,
        );
    }
  }
}
