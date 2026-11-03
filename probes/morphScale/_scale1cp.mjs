// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _scale1cp — THE SCALE-1 SURVEY FOR THE CPATCH MORPH PATH, and the distributions behind it.
//
// The Loop-Blinn relative bars move nothing at scale 1 (_scale1.mjs diffs to zero). The CPatch
// ones do: `tolPx` is the pair's own accepted defect size rather than a flat 0.05 on every hop, a
// different number for every drawing. This writes one digest line per pair so the
// two trees can be diffed, and reports the distributions that say WHICH decisions can move at all.
//
// Per pair: the split (piece counts and the parameters both poses are cut at), the two certificates'
// verdicts, the layout's shape, and -- with PLAN=1 -- the whole plan's segment boundaries. Plus two
// distributions the digest cannot show:
//   tol      the derived bar against the flat 0.05 it replaces, per pair
//   stub     the length of every closing segment, over the pair's extent: what `_same`'s bar can
//            possibly move is exactly the segments between an absolute 1e-9 and ext * 2^-24
//
//   node probes/morphScale/_scale1cp.mjs > a.txt     STEP=2  PLAN=1  DIST=1
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { parseMetaBin } = await import('../../src/core/metaBin.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { convertContour } = await import('../../src/renderer/cpatchConvert.js');
const { splitForMorph, certifyMorphClip, certifyMorphLeak, extractLayout, planMorph } =
  await import('../../src/renderer/cpatchMorphCert.js');
const { SEG_LINE, SEG_QUAD, SEG_CUBIC } = await import('../../src/primitives/seg.js');
const { assetPairs, synthPairs, selfPairs } = await import('./_morphPairs.mjs');

const KINDS = new Set((process.env.KIND || 'asset,synth,mixed,self,selfMixed').split(','));
const STEP = +(process.env.STEP || 2);
const SELF = process.env.SELF || '../MantleSamples/Assets/Mantle/tiger.svg';
const PLAN = !!process.env.PLAN;
const _warn = console.warn;
console.warn = () => {};

const CP_T = { [SEG_LINE]: 'line', [SEG_QUAD]: 'quad', [SEG_CUBIC]: 'cubic' };
function cpCurves(contour) {
  const out = [];
  for (const sg of contour) {
    const t = CP_T[sg.type] || 'rquad';
    const P = [sg.p1, sg.p2, sg.p3, sg.p4].filter(Boolean).map((q) => [q[0], q[1]]);
    if (P.length < 2) return null;
    out.push(t === 'rquad' ? { t, P, w: sg.w } : { t, P });
  }
  return out.length >= 2 ? out : null;
}
const convert = (cs, o) => {
  try {
    return convertContour(cs, {
      maxCurves: 8,
      noCurveCuts: true,
      forceBezout: true,
      leakMargin: (o && o.leakMargin) || 0,
      countFirst: o && o.countFirst,
    });
  } catch {
    return null;
  }
};
const r6 = (v) => (typeof v === 'number' ? v.toPrecision(8) : v);

const pairs = [
  ...(await assetPairs(importSvg, parseMetaBin, curveRangeToContours)),
  ...(await synthPairs(importSvg, parseMetaBin, curveRangeToContours)),
  ...(SELF !== 'none'
    ? await selfPairs(importSvg, parseMetaBin, curveRangeToContours, { file: SELF, step: STEP })
    : []),
].filter((p) => KINDS.has(p.kind));

const dist = [];
for (const p of pairs) {
  if (p.src.length !== 1 || p.dst.length !== 1) {
    console.log(`${p.kind}/${p.name}\tmulti-contour`);
    continue;
  }
  const A0 = cpCurves(p.src[0]),
    B0 = cpCurves(p.dst[0]);
  if (!A0 || !B0 || A0.length !== B0.length) {
    console.log(`${p.kind}/${p.name}\tunpairable`);
    continue;
  }
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const cs of [A0, B0])
    for (const c of cs)
      for (const q of c.P) {
        if (q[0] < x0) x0 = q[0];
        if (q[0] > x1) x1 = q[0];
        if (q[1] < y0) y0 = q[1];
        if (q[1] > y1) y1 = q[1];
      }
  const ext = Math.max(x1 - x0, y1 - y0);
  for (const cs of [A0, B0])
    for (const c of cs)
      dist.push(
        Math.hypot(c.P[c.P.length - 1][0] - c.P[0][0], c.P[c.P.length - 1][1] - c.P[0][1]) /
          (ext || 1),
      );
  let line = `${p.kind}/${p.name}\text=${r6(ext)}`;
  try {
    const [A, B] = splitForMorph(A0, B0);
    line += `\tsplit=${A.length}/${B.length}`;
    // The cut parameters themselves: a piece's own P is the evidence the split moved.
    line += `\tcuts=${A.map((c) => c.P.map((q) => q.map(r6).join(',')).join(';')).join('|').length}`;
    const conv = convert(A, { leakMargin: 0 });
    line += `\tpatches=${conv ? conv.patches.length : -1}`;
    if (conv && conv.patches.length) {
      const L = extractLayout(conv.patches, A);
      line += `\tlayout=${L ? L.map((l) => l.length).join(',') : 'null'}`;
      const idx = conv.patches[0].curves.map((c) => A.indexOf(c)).filter((i) => i >= 0);
      if (idx.length >= 2) {
        const ca = idx.map((i) => A[i]),
          cb = idx.map((i) => B[i]);
        const cl = certifyMorphClip(ca, cb, {}),
          lk = certifyMorphLeak(ca, cb, {});
        line += `\tclip=${cl.ok ? 1 : 0}:${cl.pairs | 0}:${cl.certified | 0}:${cl.failures.length}:${cl.inconclusive | 0}`;
        line += `\tleak=${lk.ok ? 1 : 0}:${lk.certified | 0}:${lk.failures.length}`;
      }
    }
    if (PLAN) {
      const pl = planMorph(A, B, convert, {});
      line += `\tplan=${pl ? pl.map((s) => `${s.t0}-${s.t1}:${s.layout.length}`).join(' ') : 'null'}`;
    }
  } catch (e) {
    line += `\tTHROW ${String((e && e.message) || e).slice(0, 50)}`;
  }
  console.log(line);
}
console.warn = _warn;
if (process.env.DIST) {
  const e2 = (x) => (x > 0 ? Math.round(-Math.log2(x)) : 999);
  const h = new Map();
  for (const v of dist) {
    const e = e2(v);
    h.set(e, (h.get(e) | 0) + 1);
  }
  const es = [...h.keys()].sort((a, b) => a - b);
  console.error(
    `segment length / pair extent: ${dist.length} segments, min 2^-${es[es.length - 1]}, max 2^-${es[0]}`,
  );
  // 2^-24 is the relative bar; a segment BETWEEN an absolute 1e-9 and this is one whose drop status
  // the two bars disagree on -- at the sizes this corpus is authored at, which the caller must state.
  for (const bar of [20, 24, 28, 40, 52]) {
    let below = 0;
    for (const e of es) if (e > bar) below += h.get(e);
    console.error(`   below ext * 2^-${bar}: ${below}`);
  }
}
