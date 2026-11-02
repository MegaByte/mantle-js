// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzScaleBranchDiff — WHERE a stage's control flow parts ways between two exactly related scales.
//
// Stage equivariance (_zzScaleWide) says a stage's output moved; this says which BRANCH moved it. A
// power-of-two scale is exact through + - * / sqrt, so the two runs execute the same blocks the same
// number of times until a comparison against a constant decides differently. V8's precise block
// coverage counts every block; run the stage once at scale 1 and once at 2^k and diff the counts. The
// smallest differing blocks, listed by source line, are the candidates -- the first one in source order
// inside the first differing function is usually the comparison itself.
//
//   node probes/_zzScaleBranchDiff.mjs FILE.svg SHAPE K [STAGE]     STAGE = lbShape | lbCdt | cpatch | graph
//   OFFSET=1 compares offset@2^k against offset@1 instead.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import inspector from 'inspector';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { buildLoopBlinnCDT } = await import('../src/renderer/loopBlinn.js');
const { packLoopBlinnMesh } = await import('../src/renderer/lbPack.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { contoursToConverter } = await import('../src/renderer/cpatchBuild.js');
const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
const { pathToCycles } = await import('../src/geom/cpatchGraph.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const { SEG_LINE, SEG_QUAD, SEG_CUBIC, mkLine, mkQuad, mkCubic, mkRQuad } =
  await import('../src/primitives/seg.js');
console.warn = () => {};

const [file, shapeArg, kArg, stage = 'lbShape'] = process.argv.slice(2);
const s = +shapeArg,
  S = 2 ** +kArg,
  OFF = process.env.OFFSET ? 16384 : 0;
const svg = readFileSync(file, 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(svg, { preserveViewport: true });
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape),
  fps = meta.floatsPerShape,
  mf = meta.metaFloats,
  bb = s * fps;
const transSolid =
  mf[bb + 7] < 0.996 &&
  Math.floor(mf[bb + 28] + 0.5) === 0 &&
  (fps < 36 || Math.floor(mf[bb + 35] + 0.5) === 0);
const evenOdd = mf[bb + 13] > 0.5;
const r = sec.curveRangesByShape[s];
const plane =
  stage === 'cpatch' || stage === 'graph'
    ? sec.curves64
      ? new Float64Array(sec.curves64)
      : new Float32Array(sec.curves)
    : new Float32Array(sec.curves);
const base = curveRangeToContours(plane, r.begin, r.end);
const f32 = plane instanceof Float32Array ? Math.fround : (v) => v;
// Fresh segments (see _zzScaleWide); with OFFSET the translation is applied and rounded like the plane.
const at = (Sc) =>
  base.map((c) =>
    c.map((sg) => {
      const P = (q) =>
        q && (OFF ? [f32((q[0] + OFF) * Sc), f32((q[1] + OFF) * Sc)] : [q[0] * Sc, q[1] * Sc]);
      if (sg.type === SEG_LINE) return mkLine(P(sg.p1), P(sg.p2), sg.is_fill_only);
      if (sg.type === SEG_QUAD) return mkQuad(P(sg.p1), P(sg.p2), P(sg.p3));
      if (sg.type === SEG_CUBIC) return mkCubic(P(sg.p1), P(sg.p2), P(sg.p3), P(sg.p4));
      return mkRQuad(
        P(sg.p1),
        P(sg.p2),
        P(sg.p3),
        sg.w,
        sg.circle
          ? { cx: (sg.circle.cx + OFF) * Sc, cy: (sg.circle.cy + OFF) * Sc, r: sg.circle.r * Sc }
          : null,
      );
    }),
  );
const RUN = {
  lbShape: (c) => {
    const b = buildLbShape(c, transSolid, evenOdd);
    return b ? b.pk.vertexCount : -1;
  },
  lbCdt: (c) => {
    const m = buildLoopBlinnCDT(c, { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
    return packLoopBlinnMesh(m).vertexCount;
  },
  cpatch: (c) => {
    const w = packCPatchShape(contoursToConverter(c, null), 0, { evenOdd });
    return w ? w.texels.length : -1;
  },
  graph: (c) => {
    const cy = pathToCycles(contoursToConverter(c, null), evenOdd);
    return cy ? cy.length : -1;
  },
}[stage];

const session = new inspector.Session();
session.connect();
const post = (m, p) =>
  new Promise((res, rej) => session.post(m, p || {}, (e, v) => (e ? rej(e) : res(v))));
await post('Profiler.enable');
await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
RUN(at(1));
RUN(at(S)); // warm: lazily compiled functions report whole-function counts only
await post('Profiler.takePreciseCoverage');
const outA = RUN(at(1));
const A = (await post('Profiler.takePreciseCoverage')).result;
const outB = RUN(at(S));
const B = (await post('Profiler.takePreciseCoverage')).result;
console.log(`${stage} at 1: ${outA}, at 2^${kArg}: ${outB}`);

const key = (fn, rg) => `${fn.functionName}|${rg.startOffset}|${rg.endOffset}`;
const index = (res) => {
  const m = new Map();
  for (const sc of res) {
    if (!sc.url.includes('/src/')) continue;
    for (const fn of sc.functions)
      for (const rg of fn.ranges)
        m.set(sc.url + '|' + key(fn, rg), { url: sc.url, fn: fn.functionName, rg });
  }
  return m;
};
const ia = index(A),
  ib = index(B);
const src = new Map();
const lineOf = (url, off) => {
  if (!src.has(url)) src.set(url, readFileSync(fileURLToPath(url), 'utf8'));
  const t = src.get(url);
  let n = 1;
  for (let i = 0; i < off && i < t.length; i++) if (t.charCodeAt(i) === 10) n++;
  return n;
};
const diffs = [];
for (const [k, a] of ia) {
  const b = ib.get(k);
  const cb = b ? b.rg.count : 0;
  if (a.rg.count !== cb) diffs.push({ ...a, ca: a.rg.count, cb });
}
for (const [k, b] of ib) if (!ia.has(k)) diffs.push({ ...b, ca: 0, cb: b.rg.count });
// Smallest ranges first within a file: an inner block that ran a different number of times is closer to
// the deciding comparison than the function around it.
diffs.sort((x, y) =>
  x.url < y.url ? -1 : x.url > y.url ? 1 : x.rg.startOffset - y.rg.startOffset,
);
const lim = +(process.env.ROWS || 40);
for (const d of diffs.slice(0, lim)) {
  const L0 = lineOf(d.url, d.rg.startOffset),
    L1 = lineOf(d.url, d.rg.endOffset);
  const text = src.get(d.url).split('\n')[L0 - 1].trim().slice(0, 110);
  console.log(
    `${d.url.replace(/.*\/src\//, '')}:${L0}-${L1} ${d.fn || '(anon)'} count ${d.ca} -> ${d.cb}   ${text}`,
  );
}
console.log(`${diffs.length} blocks differ`);
