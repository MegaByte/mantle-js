// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzMorphScale — STAGE EQUIVARIANCE FOR MORPHS, the one thing probes/_zzScaleWide.mjs cannot do.
//
// _zzScaleWide runs a stage on 2^k * input, divides by 2^k and demands bit equality; a power-of-two
// scale is exact through + - * / sqrt, so anything that moves is a comparison against something that
// did not scale. It runs STATIC stages only, one shape per entry -- and a morph is not a shape, it is
// a PAIR of them. Every decision that makes a morph (one merged cubic split plan, one provenance
// transform, one layout, one certificate over a continuum of poses) is taken on the pair, so none of
// it is measured there. A pair-level bar that does not scale is invisible to every static stage.
//
// WHAT EQUIVARIANCE MEANS FOR A PAIR. Both poses scaled by the same 2^k. The pair is one object --
// one plan, one topology, one certificate -- so scaling one pose alone is a different morph, not the
// same morph at a different size. The pair's answer must therefore be the scale-1 answer times the
// same power, number for number, tag for tag, exactly as for a static shape.
//
// WHY THE CORPUS CARRIES MIXED-SIZE PAIRS. A flat world-unit tolerance is wrong for a pair in a way
// uniform scaling alone under-reports: when the two poses differ in size, the constant is a different
// fraction of each, so the shared decision is taken in whichever pose's units the constant happens to
// suit. Scale such a pair and both fractions move, so the defect shows up at more exponents and at
// smaller ones. `_morphPairs.mjs` builds four of them (a disc shrinking 16x, a blob growing 16x in
// quad and cubic form, a flipping cubic at 8x) alongside the smoke corpus's 38 asset pairs.
//
// STAGES (STAGES=a,b,..; default lbPair,lbPairPlain,lbSeg,cpSplit,cpCert):
//   lbPair       buildLoopBlinnPartitionPair + packLoopBlinnMesh on both poses (the morph-pair builder)
//   lbPairPlain  the same with { plainDstRows: true } -- lbMorphCore's last attempt before Slug
//   lbSeg        segmentPartitionPairMorph: the t-segmentation a flip morph falls back to
//   cpSplit      toCurvesPair + splitForMorph: the inflection cuts both poses are cut at
//   cpCert       certifyMorphClip + certifyMorphLeak on the source pose's first patch (the CPatch morph bar)
//   cpPlan       planMorph end to end. MINUTES per pair -- opt in, and keep the corpus small.
//
// OFFSET=1: both poses are translated by 16384*S before the scale, rounded into float32 the way the
// plane is. That changes rounding, so bit equality against the plain run is not expected; what is
// reported is `offset-decisions` (structure and scale-free tags against PLAIN@1) and `offset-differs`
// (numerically against OFFSET@1, which scales too, so that one is still exact), plus the offset@1 ->
// plain@1 baseline, which is the translation alone.
//
// ONE EXPONENT PER PROCESS is what `_run.mjs` does, and it matters: the builders memoise implicits and
// packed forms on the segment objects and `_setKeyOrigin` leaves module state behind, so a second
// exponent in the same process can read a first one's answer and report a divergence that is not one.
//
//   node probes/morphScale/_zzMorphScale.mjs           KS=-20,20 STAGES=lbPair OFFSET=1 OUT=x.json
//   KIND=asset,synth,mixed  only=<substring>  ROWS=40  VERBOSE=1
import { writeFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { parseMetaBin } = await import('../../src/core/metaBin.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { buildLoopBlinnPartitionPair } = await import('../../src/renderer/lbPartitionPair.js');
const { segmentPartitionPairMorph } = await import('../../src/renderer/loopBlinnMorph.js');
const { packLoopBlinnMesh, LB_VERT_FLOATS } = await import('../../src/renderer/lbPack.js');
const { splitForMorph, planMorph, certifyMorphClip, certifyMorphLeak } =
  await import('../../src/renderer/cpatchMorphCert.js');
const { convertContour } = await import('../../src/renderer/cpatchConvert.js');
const { SEG_LINE, SEG_QUAD, SEG_CUBIC, mkLine, mkQuad, mkCubic, mkRQuad } =
  await import('../../src/primitives/seg.js');
const { assetPairs, synthPairs, selfPairs } = await import('./_morphPairs.mjs');

const KS = (process.env.KS || '-20,-16,-12,-8,8,12,16,20').split(',').map(Number);
const ALL = ['lbPair', 'lbPairPlain', 'lbSeg', 'cpSplit', 'cpCert'];
const STAGES = (process.env.STAGES || ALL.join(',')).split(',');
const KINDS = new Set((process.env.KIND || 'asset,synth,mixed,self,selfMixed').split(','));
const SELF = process.env.SELF || '../MantleSamples/Assets/Mantle/tiger.svg';
const STEP = +(process.env.STEP || 1);
const ONLY = process.env.ONLY || '';
const OFFSET = !!process.env.OFFSET;
const VERBOSE = !!process.env.VERBOSE;
const OFF = 16384;
const _warn = console.warn;
if (!process.env.WARN) console.warn = () => {};

// ---------------------------------------------------------------- the comparator (_zzScaleWide's)
const f32 = new Float32Array(1),
  u32 = new Uint32Array(f32.buffer);
const halfToNum = (h) => {
  const s = h & 0x8000 ? -1 : 1,
    e = (h >>> 10) & 0x1f,
    m = h & 0x3ff;
  return e === 0
    ? s * m * 2 ** -24
    : e === 31
      ? m
        ? NaN
        : s * Infinity
      : s * (1 + m / 1024) * 2 ** (e - 15);
};
const halves = (v) => {
  f32[0] = v;
  const x = u32[0];
  return [halfToNum(x & 0xffff), halfToNum(x >>> 16)];
};
function numEq(a, b, S, tol) {
  if (a === b || (a !== a && b !== b)) return true;
  if (!isFinite(a) || !isFinite(b) || a === 0 || b === 0) return false;
  const m = Math.abs(b) * tol;
  for (let e = -8, p = S ** -8; e <= 8; e++, p *= S) if (Math.abs(a / p - b) <= m) return true;
  return false;
}
const numsIn = (s) => (s.match(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi) || []).map(Number);
/// Scale-free TAGS: what `decide` mode compares. A morph pair's own decisions live here.
const TAGS = new Set([
  'type',
  't',
  'sign',
  'out',
  'kindMask',
  'vertexCount',
  'declined',
  'prim',
  'hasBezout',
  'cut',
  'invis9',
  'ci9',
  'si9',
  'pi9',
  '_ri9',
  'rows',
  'segments',
  'ok',
  'certified',
  'inconclusive',
  'failures',
  'n',
  'mode',
  'pieces',
  'nA',
  'nB',
  'why',
]);
const HALF = { note: '' };
function cmp(a, b, S, mode, p = '', seen = new Map(), tol = 1e-9, key = '') {
  if (typeof a !== typeof b) return `${p}: ${typeof b} -> ${typeof a}`;
  if (typeof a === 'number') {
    if (mode === 'decide') return TAGS.has(key) && a !== b ? `${p}: ${b} -> ${a}` : null;
    return numEq(a, b, S, tol) ? null : `${p}: ${b} -> ${a}`;
  }
  if (typeof a === 'string') {
    if (a === b) return null;
    const na = numsIn(a),
      nb = numsIn(b);
    const ra = a.replace(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi, '#'),
      rb = b.replace(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi, '#');
    if (ra !== rb || na.length !== nb.length) return `${p}: "${b}" -> "${a}"`;
    if (mode === 'decide') return null;
    for (let i = 0; i < na.length; i++)
      if (!numEq(na[i], nb[i], S, tol)) return `${p}: "${b}" -> "${a}"`;
    return null;
  }
  if (typeof a !== 'object')
    return a === b || typeof a === 'function' ? null : `${p}: ${b} -> ${a}`;
  if (a === null || b === null)
    return a === b
      ? null
      : `${p}: ${b === null ? 'null' : 'obj'} -> ${a === null ? 'null' : 'obj'}`;
  if (seen.has(b)) return null;
  seen.set(b, a);
  if (ArrayBuffer.isView(a)) {
    if (a.constructor !== b.constructor || a.length !== b.length)
      return `${p}: ${b.constructor.name}[${b.length}] -> ${a.constructor.name}[${a.length}]`;
    const lbVerts = key === 'verts' && a.length % LB_VERT_FLOATS === 0;
    if (mode === 'decide') {
      if (lbVerts)
        for (let i = 5; i < a.length; i += LB_VERT_FLOATS)
          if (a[i] !== b[i]) return `${p}[kind@${(i - 5) / LB_VERT_FLOATS}]: ${b[i]} -> ${a[i]}`;
      return null;
    }
    const t = a.constructor === Float32Array ? 1e-6 : tol;
    // Only the lanes lbPack fills with packHalf2x16 are bit patterns (see _zzScaleWide's header).
    const packedLane = (i) => {
      if (!lbVerts) return false;
      const lane = i % LB_VERT_FLOATS,
        v0 = i - lane,
        kd = Math.floor(b[v0 + 5]);
      if (kd === 12)
        return lane === 15 || lane === 16 || (lane === 9 && Math.abs(b[v0 + 6]) >= 8192);
      if (kd === 4) return lane === 22 && b[v0 + 23] === 9;
      return false;
    };
    for (let i = 0; i < a.length; i++) {
      if (numEq(a[i], b[i], S, t)) continue;
      if (packedLane(i)) {
        const ha = halves(a[i]),
          hb = halves(b[i]);
        if (numEq(ha[0], hb[0], S, 2e-3) && numEq(ha[1], hb[1], S, 2e-3)) continue;
        if (
          [0, 1].some(
            (j) =>
              (ha[j] === 0 || !isFinite(ha[j]) || hb[j] === 0 || !isFinite(hb[j])) &&
              ha[j] !== hb[j],
          ) &&
          [0, 1].every(
            (j) =>
              numEq(ha[j], hb[j], S, 2e-3) ||
              ha[j] === 0 ||
              hb[j] === 0 ||
              !isFinite(ha[j]) ||
              !isFinite(hb[j]),
          )
        ) {
          if (!HALF.note) HALF.note = `${p}[${i}] lane ${i % LB_VERT_FLOATS}: half-range`;
          continue;
        }
      }
      return `${p}[${i}]: ${b[i]} -> ${a[i]}`;
    }
    return null;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${p}: array-ness`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${p}: length ${b.length} -> ${a.length}`;
    for (let i = 0; i < a.length; i++) {
      const r = cmp(a[i], b[i], S, mode, `${p}[${i}]`, seen, tol, key);
      if (r) return r;
    }
    return null;
  }
  if (a instanceof Map || a instanceof Set) {
    if (a.size !== b.size) return `${p}: size ${b.size} -> ${a.size}`;
    const av = [...a],
      bv = [...b];
    for (let i = 0; i < av.length; i++) {
      const r = cmp(av[i], bv[i], S, mode, `${p}{${i}}`, seen, tol, key);
      if (r) return r;
    }
    return null;
  }
  const ka = Object.keys(a).sort(),
    kb = Object.keys(b).sort();
  if (ka.join() !== kb.join()) return `${p}: keys {${kb}} -> {${ka}}`;
  for (const k of Object.keys(b)) {
    const r = cmp(a[k], b[k], S, mode, `${p}.${k}`, seen, tol, k);
    if (r) return r;
  }
  return null;
}

// ---------------------------------------------------------------- inputs
/// FRESH segments at 2^k (and offset), field by field: a spread copy carries the builders' memos.
/// The offset is rounded into float32 first, the way a translated plane arrives.
const r32 = (v) => {
  f32[0] = v;
  return f32[0];
};
function scaleContours(cs, S, off) {
  const T = off ? OFF : 0;
  const P = (q) =>
    q && [off ? r32((q[0] + T) * S) : q[0] * S, off ? r32((q[1] + T) * S) : q[1] * S];
  return cs.map((c) =>
    c.map((sg) => {
      if (sg.type === SEG_LINE) return mkLine(P(sg.p1), P(sg.p2), sg.is_fill_only);
      if (sg.type === SEG_QUAD) return mkQuad(P(sg.p1), P(sg.p2), P(sg.p3));
      if (sg.type === SEG_CUBIC) return mkCubic(P(sg.p1), P(sg.p2), P(sg.p3), P(sg.p4));
      const c0 = sg.circle;
      return mkRQuad(
        P(sg.p1),
        P(sg.p2),
        P(sg.p3),
        sg.w,
        c0
          ? {
              cx: off ? r32((c0.cx + T) * S) : c0.cx * S,
              cy: off ? r32((c0.cy + T) * S) : c0.cy * S,
              r: off ? r32(c0.r * S) : c0.r * S,
            }
          : null,
      );
    }),
  );
}

// ---------------------------------------------------------------- stages
const tryRun = (f) => {
  try {
    return f();
  } catch (ex) {
    return { __throw: String((ex && ex.message) || ex).slice(0, 80) };
  }
};
const packOf = (m) => {
  const pk = packLoopBlinnMesh(m);
  return pk
    ? {
        verts: pk.verts.subarray(0, pk.vertexCount * LB_VERT_FLOATS),
        vertexCount: pk.vertexCount,
        kindMask: pk.kindMask | 0,
        prim: !!pk.prim,
        hasBezout: !!pk.hasBezout,
      }
    : null;
};
const pairOut = (pr) =>
  pr
    ? { declined: false, src: pr.src, dst: pr.dst, pkS: packOf(pr.src), pkD: packOf(pr.dst) }
    : { declined: true };

/// The importer's segs -> the converter's {t, P, w}, the way cpatchMorphBuild's toCurvesPair does.
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
const cpPairOf = (x) => {
  if (x.src.length !== 1 || x.dst.length !== 1) return null;
  const A = cpCurves(x.src[0]),
    B = cpCurves(x.dst[0]);
  return A && B && A.length === B.length ? [A, B] : null;
};
const cpConvert = (cs, o) => {
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

const STAGE = {
  lbPair: (x) => pairOut(buildLoopBlinnPartitionPair(x.src, x.dst, x.fillRule)),
  lbPairPlain: (x) =>
    pairOut(buildLoopBlinnPartitionPair(x.src, x.dst, x.fillRule, { plainDstRows: true })),
  lbSeg: (x) => {
    const segs = segmentPartitionPairMorph(x.src, x.dst, x.fillRule);
    if (!segs) return { segments: -1 };
    return {
      segments: segs.length,
      spans: segs.map((s) => ({ tLo: s.tLo, tHi: s.tHi, tLoB: s.tLoB, tHiB: s.tHiB })),
      packs: segs.map((s) => ({ pkS: packOf(s.pair.src), pkD: packOf(s.pair.dst) })),
    };
  },
  cpSplit: (x) => {
    const pr = cpPairOf(x);
    if (!pr) return null;
    const [A, B] = splitForMorph(pr[0], pr[1]);
    return { nA: A.length, nB: B.length, A, B };
  },
  cpCert: (x) => {
    const pr = cpPairOf(x);
    if (!pr) return null;
    const [A, B] = splitForMorph(pr[0], pr[1]);
    const conv = cpConvert(A, { leakMargin: 0 });
    if (!conv || !conv.patches.length) return { patches: 0 };
    // The FIRST patch's two curve lists at both poses, paired by the layout the converter gives --
    // the certificate's own inputs. Only the verdicts are compared; the grids are its internals.
    const idx = conv.patches[0].curves.map((c) => A.indexOf(c)).filter((i) => i >= 0);
    if (idx.length < 2) return { patches: conv.patches.length, cert: null };
    const ca = idx.map((i) => A[i]),
      cb = idx.map((i) => B[i]);
    const cl = certifyMorphClip(ca, cb, {});
    const lk = certifyMorphLeak(ca, cb, {});
    return {
      patches: conv.patches.length,
      nPatchCurves: idx.length,
      clip: {
        ok: !!cl.ok,
        pairs: cl.pairs | 0,
        certified: cl.certified | 0,
        failures: cl.failures.length,
        inconclusive: cl.inconclusive | 0,
      },
      leak: { ok: !!lk.ok, failures: lk.failures.length, certified: lk.certified | 0 },
    };
  },
  cpPlan: (x) => {
    const pr = cpPairOf(x);
    if (!pr) return null;
    const [A, B] = splitForMorph(pr[0], pr[1]);
    const plan = planMorph(A, B, cpConvert, {});
    if (!plan) return { segments: -1 };
    return {
      segments: plan.length,
      spans: plan.map((s) => ({ t0: s.t0, t1: s.t1, n: s.layout.length })),
    };
  },
};

// ---------------------------------------------------------------- run
const stats = {};
const bump1 = (mode, st, k, why) => {
  const s = (((stats[mode] ||= {})[st] ||= {})[k] ||= { n: 0, bad: 0, why: {} });
  s.n++;
  if (why) {
    s.bad++;
    const w = why.replace(/\[\d+\]/g, '[]').replace(/:.*$/, '');
    s.why[w] = (s.why[w] | 0) + 1;
  }
};
let SUBSET = [];
const bump = (mode, st, k, why) => {
  bump1(mode, st, k, why);
  for (const sub of SUBSET) bump1(mode + '/' + sub, st, k, why);
};
const judge = (mode, st, k, out, ref, S, how) => {
  HALF.note = '';
  const w = out && out.__throw ? 'throw ' + out.__throw : cmp(out, ref, S, how, st);
  if (how === 'value') bump(mode + ' half-range', st, k, HALF.note || null);
  bump(mode, st, k, w);
  return w;
};

const rows = [];
const t0 = Date.now();
const wantSelf = KINDS.has('self') || KINDS.has('selfMixed');
let pairs = [
  ...(await assetPairs(importSvg, parseMetaBin, curveRangeToContours)),
  ...(await synthPairs(importSvg, parseMetaBin, curveRangeToContours)),
  ...(wantSelf && SELF !== 'none'
    ? await selfPairs(importSvg, parseMetaBin, curveRangeToContours, { file: SELF, step: STEP })
    : []),
];
pairs = pairs.filter((p) => KINDS.has(p.kind) && (!ONLY || p.name.includes(ONLY)));
for (const p of pairs) {
  SUBSET = [p.kind];
  const at = (S, off) => ({
    fillRule: p.evenOdd ? 'evenodd' : 'nonzero',
    transSolid: p.transSolid,
    src: scaleContours(p.src, S, off),
    dst: scaleContours(p.dst, S, off),
  });
  for (const st of STAGES) {
    const ref = tryRun(() => STAGE[st](at(1, false)));
    if (ref === null || (ref && ref.__throw)) continue;
    const refOff = OFFSET ? tryRun(() => STAGE[st](at(1, true))) : null;
    if (OFFSET) {
      const w = judge('offset-baseline', st, 0, refOff, ref, 1, 'decide');
      if (w && VERBOSE) rows.push(`${p.name} ${st} offset@1 vs plain@1: ${w}`);
    }
    for (const k of KS) {
      const S = 2 ** k;
      const out = tryRun(() => STAGE[st](at(S, OFFSET)));
      if (!OFFSET) {
        const w = judge('plain', st, k, out, ref, S, 'value');
        if (w) rows.push(`${p.name} ${st} 2^${k}: ${w}`);
      } else {
        const wd = judge('offset-decisions', st, k, out, ref, S, 'decide');
        if (wd) rows.push(`${p.name} ${st} 2^${k} decide: ${wd}`);
        const wv =
          refOff && !refOff.__throw
            ? judge('offset-differs', st, k, out, refOff, S, 'value')
            : 'no offset ref';
        if (wv && VERBOSE) rows.push(`${p.name} ${st} 2^${k} differs: ${wv}`);
      }
    }
  }
  if (VERBOSE) console.error(`${p.name} ${Math.round((Date.now() - t0) / 1000)}s`);
}
console.warn = _warn;
for (const mode of Object.keys(stats)) {
  console.log(`== ${mode} ==`);
  for (const st of Object.keys(stats[mode])) {
    console.log(
      `  ${st.padEnd(12)} ` +
        Object.entries(stats[mode][st])
          .map(([k, v]) => `2^${k} ${v.bad}/${v.n}`)
          .join('  '),
    );
    if (VERBOSE)
      for (const [k, v] of Object.entries(stats[mode][st]))
        if (v.bad) console.log(`      2^${k}: ${JSON.stringify(v.why)}`);
  }
}
if (process.env.OUT)
  writeFileSync(process.env.OUT, JSON.stringify({ pairs: pairs.length, KS, OFFSET, stats, rows }));
for (const r of rows.slice(0, +(process.env.ROWS || 20))) console.log('  ' + r);
console.log(
  `${pairs.length} pairs, ${rows.length} difference rows, ${Math.round((Date.now() - t0) / 1000)} s`,
);
