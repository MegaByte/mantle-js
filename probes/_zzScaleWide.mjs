// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzScaleWide — stage equivariance for Loop-Blinn and CPatch over 2^-20 .. 2^20, per stage and per
// exponent, over a whole corpus, plain and with an origin offset.
//
// _zzScaleStage's method, widened. A power-of-two scale is exact through + - * / sqrt, so a stage run
// on 2^k * input must return 2^k^e * (its output on the input) for SOME integer e per number, bit for
// bit up to the ulp noise of hypot/trig. Anything else is a comparison against a constant.
//
// WHAT IS COMPARED. Every enumerable own field of every stage output, walked generically -- not a
// hand-written list, because a hand-written list is exactly how a probe misses cubic hulls, klmn, quad
// tri/tc and the end normals. Structure (keys, array lengths, typed-array kinds, booleans, strings,
// null-ness) must match exactly; numbers must match under some power of the scale (1e-9 relative in
// float64 fields, 1e-6 in Float32Array fields). A value in one of the LB vertex lanes lbPack fills with
// packHalf2x16 (kind 12: 15, 16, and 9 in cubic mode; a kind-4 ring's 22) is retried as two halves: both
// must then match under some power, and a half that saturates or flushes to zero on one side only is
// tallied as `half-range` -- the vertex format's range -- rather than as a decision.
//
// STAGES (STAGES=a,b,..; default all):
//   decode32  curveRangeToContours on the scaled float32 curve plane (the LB and CPU input)
//   decode64  the same on the float64 plane, where the importer kept one (the CPatch input)
//   recog     circleFromContours / ellipseFromContours / extractAnnuli (engine choice)
//   lbShape   buildLbShape: cusp split, fast mesh, CDT partition, declines, dropDegenerateFaces, pack
//   lbCdt     buildLoopBlinnCDT alone, then packLoopBlinnMesh (the two LB stages _zzScaleStage compares)
//   resolve   resolveSelfOverlap (the partition's retry)
//   graph     contoursToConverter + pathToCycles (the CPatch front end)
//   cpatch    contoursToConverter + packCPatchShape: the patches and the wire (texels, verts, counts)
//
// INPUT. By default a stage's input is the scale-1 decode, rebuilt FIELD BY FIELD at 2^k (a spread copy
// carries the segment's memoised implicit and packed forms under symbols -- see _zzScaleStage). That
// isolates each stage. INPUT=plane decodes the scaled plane instead (the pipeline as it runs).
//
// OFFSET=1: the plane is translate(16384 S, 16384 S) scale(S), rounded into its own float type. That
// changes rounding, so bit equality against the plain run is not expected. Two things are reported:
//   decisions  offset@2^k against PLAIN@1: structure, tags, decline, kind lanes, patch/texel counts
//   differs    offset@2^k against OFFSET@1, numerically (the offset scales too, so this is still exact)
// plus the offset@1 -> plain@1 decision baseline, which is the translation alone.
//
//   node probes/_zzScaleWide.mjs [file.svg ...]      (default: examples, examples/_bench, examples/smoke)
//   KS=-20,20 STAGES=lbShape OFFSET=1 OUT=x.json VERBOSE=1
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { curveRangeToContours, extractAnnuli } = await import('../src/geom/lbContour.js');
const { buildLoopBlinnCDT } = await import('../src/renderer/loopBlinn.js');
const { packLoopBlinnMesh, LB_VERT_FLOATS } = await import('../src/renderer/lbPack.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { contoursToConverter } = await import('../src/renderer/cpatchBuild.js');
const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
const { pathToCycles } = await import('../src/geom/cpatchGraph.js');
const { resolveSelfOverlap } = await import('../src/renderer/shapeResolve.js');
const { circleFromContours, ellipseFromContours } = await import('../src/geom/shapeRecognize.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_RQUAD, mkLine, mkQuad, mkCubic, mkRQuad } =
  await import('../src/primitives/seg.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KS = (process.env.KS || '-20,-16,-12,-8,8,12,16,20').split(',').map(Number);
const ALL = ['decode32', 'decode64', 'recog', 'lbShape', 'lbCdt', 'resolve', 'graph', 'cpatch'];
const STAGES = (process.env.STAGES || ALL.join(',')).split(',');
const OFFSET = !!process.env.OFFSET;
const INPUT = OFFSET ? 'plane' : process.env.INPUT || 'contours';
const VERBOSE = !!process.env.VERBOSE;
const OFF = 16384;
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
  files = [...dir('examples'), ...dir('examples/_bench'), ...dir('examples/smoke')];
}

// ---------------------------------------------------------------- the comparator
const f32 = new Float32Array(1),
  u32 = new Uint32Array(f32.buffer);
function halves(v) {
  f32[0] = v;
  const x = u32[0];
  return [x & 0xffff, x >>> 16].map(halfToNum);
}
function halfToNum(h) {
  const s = h & 0x8000 ? -1 : 1,
    e = (h >>> 10) & 0x1f,
    m = h & 0x3ff;
  if (e === 0) return s * m * Math.pow(2, -24); // toHalfBits writes no subnormals; m is 0 there
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}
/// Is there an integer power e with a == b * S^e to `tol` relative?
function numEq(a, b, S, tol) {
  if (a === b) return true;
  if (a !== a && b !== b) return true;
  if (!isFinite(a) || !isFinite(b) || a === 0 || b === 0) return false;
  const m = Math.abs(b) * tol;
  let p = Math.pow(S, -8);
  for (let e = -8; e <= 8; e++, p *= S) if (Math.abs(a / p - b) <= m) return true;
  return false;
}
function numsIn(s) {
  return (s.match(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi) || []).map(Number);
}
/// Walks a (scaled) and b (reference) together. mode 'value' compares every number; mode 'decide'
/// compares structure and the scale-free TAGS only. Returns null or the first difference as a path.
const TAGS = new Set([
  'type',
  't',
  'sign',
  'out',
  'kindMask',
  'vertexCount',
  'unresolved',
  'dropped',
  'cells',
  'pid',
  'ci9',
  'si9',
  'pi9',
  '_ri9',
  'declined',
  'prim',
  'hasBezout',
  'cut',
  'invis9',
  'ramped',
  'rest',
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
    if (mode === 'decide') {
      if (
        key === 'verts' &&
        a.constructor === Float32Array &&
        a.length % LB_VERT_FLOATS === 0 &&
        p.includes('lb')
      )
        for (let i = 5; i < a.length; i += LB_VERT_FLOATS)
          if (a[i] !== b[i]) return `${p}[kind@${(i - 5) / LB_VERT_FLOATS}]: ${b[i]} -> ${a[i]}`;
      return null;
    }
    const t = a.constructor === Float32Array ? 1e-6 : tol;
    // only THE LANES lbPack FILLS WITH packHalf2x16 are bit patterns: kind 12's own-normals (15, 16) and,
    // in cubic mode (|sign| >= 8192), its (dk, dl) at lane 9; a kind-4 ring vertex's normal at lane 22.
    // Retrying any other float as a half pair excused real differences (0 -> x reads as a saturated half).
    const lbVerts = key === 'verts' && p.includes('lbpk') && a.length % LB_VERT_FLOATS === 0;
    const packedLane = (i) => {
      if (!lbVerts) return false;
      const lane = i % LB_VERT_FLOATS,
        v0 = i - lane,
        kd = Math.floor(b[v0 + 5]); // the kind lane carries flags in its fraction
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
        // A HALF THAT SATURATES is the vertex format's range, not a decision: noted, and the scan goes on
        // so it cannot hide a real difference later in the same stream.
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
          if (!HALF.note)
            HALF.note = `${p}[${i}] lane ${i % LB_VERT_FLOATS}: half-range ${hb} -> ${ha}`;
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
  // In the REFERENCE object's own order, so a stage's earlier product (the mesh) is blamed before what is derived from it (the pack).
  for (const k of Object.keys(b)) {
    const r = cmp(a[k], b[k], S, mode, `${p}.${k}`, seen, tol, k);
    if (r) return r;
  }
  return null;
}

// ---------------------------------------------------------------- inputs
/// The plane at 2^k (and offset), rounded into its own float type, header and scale-free slots kept.
function scalePlane(plane, ranges, S, off) {
  const out = plane.slice();
  const T = off ? OFF : 0;
  const done = new Uint8Array(plane.length);
  const put = (i, pos) => {
    if (done[i]) return;
    done[i] = 1;
    out[i] = pos ? (plane[i] + T) * S : plane[i] * S;
  };
  for (const r of ranges) {
    if (!r) continue;
    let hdr = r.begin | 0;
    const end = Math.min(r.end | 0, plane.length);
    while (hdr + 4 <= end) {
      const hw = plane[hdr];
      if (!(hw >= 0 && hw < 16 && hw === Math.floor(hw))) break;
      const ty = (hw | 0) & 3,
        d = hdr + 4;
      if (ty === SEG_LINE) {
        for (let i = 0; i < 4; i++) put(d + i, true);
        hdr = d + 8;
      } else if (ty === SEG_QUAD) {
        for (let i = 0; i < 6; i++) put(d + i, true);
        hdr = d + 12;
      } else if (ty === SEG_CUBIC) {
        for (let i = 0; i < 8; i++) put(d + i, true);
        hdr = d + 12;
      } else {
        put(d, true);
        put(d + 1, true);
        put(d + 2, false);
        put(d + 3, false);
        hdr = d + 12;
      }
    }
  }
  return out;
}
/// Fresh segments at 2^k: every field the decoder writes, and nothing memoised.
function scaleContours(cs, S) {
  const P = (q) => q && [q[0] * S, q[1] * S];
  return cs.map((c) =>
    c.map((sg) => {
      let o;
      if (sg.type === SEG_LINE) o = mkLine(P(sg.p1), P(sg.p2), sg.is_fill_only);
      else if (sg.type === SEG_QUAD) o = mkQuad(P(sg.p1), P(sg.p2), P(sg.p3));
      else if (sg.type === SEG_CUBIC) o = mkCubic(P(sg.p1), P(sg.p2), P(sg.p3), P(sg.p4));
      else
        o = mkRQuad(
          P(sg.p1),
          P(sg.p2),
          P(sg.p3),
          sg.w,
          sg.circle ? { cx: sg.circle.cx * S, cy: sg.circle.cy * S, r: sg.circle.r * S } : null,
        );
      for (const k of Object.keys(sg))
        if (!(k in o)) throw new Error('scaleContours: unhandled field ' + k);
      return o;
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
const STAGE = {
  decode32: (x) => x.c32(),
  decode64: (x) => (x.has64 ? x.c64() : null),
  recog: (x) => {
    const c = x.c32();
    if (!c) return null;
    const a = extractAnnuli(c, x.evenOdd ? 'evenodd' : 'nonzero');
    return {
      circle: circleFromContours(c),
      ellipse: ellipseFromContours(c),
      annuli: a.annuli,
      rest: a.rest.length,
    };
  },
  lbShape: (x) => {
    const c = x.c32();
    if (!c) return null;
    const b = buildLbShape(c, x.transSolid, x.evenOdd);
    if (!b) return { declined: true };
    const pk = b.pk;
    return {
      declined: false,
      raw: b.raw,
      lbpk: {
        verts: pk.verts.subarray(0, pk.vertexCount * LB_VERT_FLOATS),
        vertexCount: pk.vertexCount,
        kindMask: pk.kindMask | 0,
        prim: !!pk.prim,
        hasBezout: !!pk.hasBezout,
        fallback: pk.fallback,
      },
    };
  },
  lbCdt: (x) => {
    const c = x.c32();
    if (!c) return null;
    const m = buildLoopBlinnCDT(c, { fillRule: x.evenOdd ? 'evenodd' : 'nonzero' });
    const pk = packLoopBlinnMesh(m);
    return {
      raw: m,
      lbpk: pk
        ? {
            verts: pk.verts.subarray(0, pk.vertexCount * LB_VERT_FLOATS),
            vertexCount: pk.vertexCount,
            kindMask: pk.kindMask | 0,
          }
        : null,
    };
  },
  resolve: (x) => {
    const c = x.c32();
    return c ? resolveSelfOverlap(c, x.evenOdd ? 'evenodd' : 'nonzero') : null;
  },
  graph: (x) => {
    const c = x.c64();
    if (!c) return null;
    const cs = contoursToConverter(c, null);
    return cs ? pathToCycles(cs, x.evenOdd) : null;
  },
  cpatch: (x) => {
    const c = x.c64();
    if (!c) return null;
    if (circleFromContours(c) || ellipseFromContours(c)) return { primitive: true };
    const cs = contoursToConverter(c, null);
    if (!cs) return null;
    const patches = [];
    const w = packCPatchShape(cs, 0, { evenOdd: x.evenOdd, onPatches: (a) => patches.push(...a) });
    return {
      patches: patches.map((q) => ({
        curves: q.curves.map((cv) => ({ t: cv.t, P: cv.P, w: cv.w, cut: !!cv.cut })),
        inside: q.inside,
        bbox: q.bbox,
        cover: q.cover,
        obb: q.obb,
        impls: (q.impls || []).map((im) => ({ s: im.s, impl: im.impl })),
      })),
      wire: w
        ? {
            texels: w.texels,
            verts: w.verts,
            vertexCount: w.vertexCount,
            kindMask: w.kindMask | 0,
            unresolved: w.unresolved | 0,
            cells: w.cells | 0,
            dropped: w.dropped | 0,
          }
        : null,
    };
  },
};

// ---------------------------------------------------------------- run
const stats = {}; // stats[mode][stage][k] = { n, bad, why: {} }
/// Every count is kept for the whole corpus and for the arc-bearing assets, split into their arc shapes and
/// their other shapes (the importer audit's F5 split).
let SUBSET = [];
const bump1 = (mode, st, k, why) => {
  const s = (((stats[mode] ||= {})[st] ||= {})[k] ||= { n: 0, bad: 0, why: {} });
  s.n++;
  if (why) {
    s.bad++;
    const w = why.replace(/\[\d+\]/g, '[]').replace(/:.*$/, '');
    s.why[w] = (s.why[w] | 0) + 1;
  }
};
const bump = (mode, st, k, why) => {
  bump1(mode, st, k, why);
  for (const sub of SUBSET) bump1(mode + '/' + sub, st, k, why);
};
/// Compare, and book a saturated half separately from the verdict.
const judge = (mode, st, k, out, ref, S, how) => {
  HALF.note = '';
  const w = out && out.__throw ? 'throw ' + out.__throw : cmp(out, ref, S, how, st);
  if (how === 'value') bump(mode + ' half-range', st, k, HALF.note || null);
  bump(mode, st, k, w);
  return w;
};
const rows = [];
const t0 = Date.now();
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
  const fps = meta.floatsPerShape;
  const p32 = new Float32Array(sec.curves),
    p64 = sec.curves64 ? new Float64Array(sec.curves64) : null;
  const ranges = sec.curveRangesByShape || [];
  const planes = new Map();
  const planeAt = (S, off) => {
    const key = S + (off ? 'o' : '');
    if (!planes.has(key))
      planes.set(key, {
        p32: scalePlane(p32, ranges, S, off),
        p64: p64 ? scalePlane(p64, ranges, S, off) : null,
      });
    return planes.get(key);
  };
  const hasArc = (s) => {
    const r = ranges[s];
    if (!r || r.end <= r.begin || !(meta.metaFloats[s * fps + 7] > 0)) return false;
    const c = curveRangeToContours(p32, r.begin, r.end);
    return !!(c && c.some((q) => q.some((sg) => sg.type === SEG_RQUAD)));
  };
  let arcAsset = false;
  for (let s = 0; s < meta.numShapes && !arcAsset; s++) arcAsset = hasArc(s);
  for (let s = 0; s < meta.numShapes; s++) {
    const r = ranges[s];
    if (!r || r.end <= r.begin || !(meta.metaFloats[s * fps + 7] > 0)) continue;
    SUBSET = arcAsset ? ['arcAsset', hasArc(s) ? 'arcShape' : 'arcAssetOther'] : [];
    const mf = meta.metaFloats,
      bb = s * fps;
    const transSolid =
      mf[bb + 7] < 0.996 &&
      Math.floor(mf[bb + 28] + 0.5) === 0 &&
      (fps < 36 || Math.floor(mf[bb + 35] + 0.5) === 0);
    const evenOdd = mf[bb + 13] > 0.5;
    const base32 = curveRangeToContours(p32, r.begin, r.end),
      base64 = p64 ? curveRangeToContours(p64, r.begin, r.end) : base32;
    // One input maker per (scale, offset). decode stages always read the plane.
    const inputAt = (S, off, forcePlane) => {
      const usePlane = forcePlane || INPUT === 'plane' || off;
      const pl = usePlane ? planeAt(S, off) : null;
      return {
        transSolid,
        evenOdd,
        has64: !!p64,
        c32: () =>
          usePlane
            ? curveRangeToContours(pl.p32, r.begin, r.end)
            : base32 && scaleContours(base32, S),
        c64: () =>
          usePlane
            ? curveRangeToContours(pl.p64 || pl.p32, r.begin, r.end)
            : base64 && scaleContours(base64, S),
      };
    };
    for (const st of STAGES) {
      const plane = st === 'decode32' || st === 'decode64';
      const ref = tryRun(() => STAGE[st](inputAt(1, false, plane)));
      if (ref === null || (ref && ref.__throw)) continue;
      const refOff = OFFSET ? tryRun(() => STAGE[st](inputAt(1, true, plane))) : null;
      if (OFFSET) {
        const w = judge('offset-baseline', st, 0, refOff, ref, 1, 'decide');
        if (w && VERBOSE) rows.push(`${f} #${s} ${st} offset@1 vs plain@1: ${w}`);
      }
      for (const k of KS) {
        const S = Math.pow(2, k);
        const out = tryRun(() => STAGE[st](inputAt(S, OFFSET, plane)));
        if (!OFFSET) {
          const w = judge('plain', st, k, out, ref, S, 'value');
          if (w) rows.push(`${f} #${s} ${st} 2^${k}: ${w}`);
          else if (HALF.note && VERBOSE) rows.push(`${f} #${s} ${st} 2^${k}: ${HALF.note}`);
        } else {
          const wd = judge('offset-decisions', st, k, out, ref, S, 'decide');
          if (wd) rows.push(`${f} #${s} ${st} 2^${k} decide: ${wd}`);
          const wv =
            refOff && !refOff.__throw
              ? judge('offset-differs', st, k, out, refOff, S, 'value')
              : 'no offset ref';
          if (wv && VERBOSE) rows.push(`${f} #${s} ${st} 2^${k} differs: ${wv}`);
        }
      }
    }
  }
  if (VERBOSE) console.error(`${f} ${Math.round((Date.now() - t0) / 1000)}s`);
}
console.warn = _warn;
for (const mode of Object.keys(stats)) {
  console.log(`== ${mode} (INPUT=${INPUT}) ==`);
  for (const st of Object.keys(stats[mode])) {
    const line = Object.entries(stats[mode][st])
      .map(([k, v]) => `2^${k} ${v.bad}/${v.n}`)
      .join('  ');
    console.log(`  ${st.padEnd(9)} ${line}`);
    if (VERBOSE)
      for (const [k, v] of Object.entries(stats[mode][st]))
        if (v.bad) console.log(`      2^${k}: ${JSON.stringify(v.why)}`);
  }
}
if (process.env.OUT)
  writeFileSync(process.env.OUT, JSON.stringify({ files, KS, OFFSET, INPUT, stats, rows }));
const lim = +(process.env.ROWS || 20);
for (const r of rows.slice(0, lim)) console.log('  ' + r);
console.log(`${rows.length} difference rows, ${Math.round((Date.now() - t0) / 1000)} s`);
