// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Corpus survey of the cubic CURVE_BAND's klm gradient pair (dk, dl): the shared-exponent format against half.
//
// The pair is d(klm)/d(em position), so under a uniform scale S it is exactly the scale-1 pair divided by S
// (the static builder is scale-equivariant, which lbCpatchScaleEquivarianceSmoke pins). So the
// scale sweep below is the corpus's own values divided by S, which is both exact and far cheaper than rebuilding
// every mesh at every exponent.
//
//   node probes/scaleRest/_klmGradCensus.mjs
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import(path.join(ROOT, 'src/svg/importer.js'));
const { buildLbShape } = await import(path.join(ROOT, 'src/renderer/lbBuildCore.js'));
const { curveRangeToContours } = await import(path.join(ROOT, 'src/renderer/loopBlinn.js'));
const { packKlmGrad, unpackKlmGrad } = await import(path.join(ROOT, 'src/renderer/lbPack.js'));

// ---- half precision, as a reference ------------------------------------------------------------------------
const _b = new ArrayBuffer(4),
  _f = new Float32Array(_b),
  _u = new Uint32Array(_b);
function toHalfBits(val) {
  _f[0] = val;
  const x = _u[0],
    s = (x >>> 16) & 0x8000,
    e = ((x >>> 23) & 0xff) - 127,
    m = x & 0x7fffff;
  if (e > 15) return s | 0x7c00;
  if (e > -15) return s | ((e + 15) << 10) | (m >>> 13);
  return s;
}
function fromHalfBits(h) {
  const s = h & 0x8000 ? -1 : 1,
    e = (h >> 10) & 0x1f,
    m = h & 0x3ff;
  if (e === 31) return m ? NaN : s * Infinity;
  if (e === 0) return s * m * Math.pow(2, -24);
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}
const halfRound = (v) => fromHalfBits(toHalfBits(v));

// ---- collect every (dk, dl) the corpus packs ----------------------------------------------------------------
const dir = (d) =>
  existsSync(path.join(ROOT, d))
    ? readdirSync(path.join(ROOT, d))
        .filter((f) => f.endsWith('.svg'))
        .sort()
        .map((f) => d + '/' + f)
    : [];
const files = [...dir('examples'), ...dir('examples/_bench'), ...dir('examples/smoke')];
const pairs = [];
const packs = []; // { file, s, verts } — for the scale-1 pack diff below
let assets = 0,
  shapes = 0,
  withRings = 0;
for (const f of files) {
  let svg, bundle;
  try {
    svg = readFileSync(path.resolve(ROOT, f), 'utf8');
  } catch {
    continue;
  }
  try {
    bundle = await importSvg(svg);
  } catch {
    continue;
  }
  if (!bundle.numShapes || !bundle.curves) continue;
  assets++;
  const meta =
    bundle.meta && bundle.meta.byteLength > 32 ? new Float32Array(bundle.meta, 32) : null;
  const mst = bundle.metaFloatsPerShape;
  const curveFloats = new Float32Array(bundle.curves);
  for (let s = 0; s < bundle.numShapes; s++) {
    const r = bundle.curveRangesByShape[s];
    if (!r || r.end <= r.begin) continue;
    const bb = meta && mst ? s * mst : -1;
    const transSolid =
      bb >= 0 &&
      meta[bb + 7] < 0.996 &&
      Math.floor(meta[bb + 28] + 0.5) === 0 &&
      (mst < 36 || Math.floor(meta[bb + 35] + 0.5) === 0);
    const evenodd = !!(meta && meta[s * mst + 13] > 0.5);
    let contours = null,
      built = null;
    try {
      contours = curveRangeToContours(curveFloats, r.begin, r.end);
    } catch {
      continue;
    }
    try {
      built = buildLbShape(contours, transSolid, evenodd);
    } catch {
      built = null;
    }
    shapes++;
    if (!built || !built.raw || !built.raw.cubics) continue;
    let any = false;
    for (const c of built.raw.cubics) {
      if (!c._ring) continue;
      for (const R of c._ring) {
        pairs.push([R.dk, R.dl]);
        any = true;
      }
    }
    if (any) {
      withRings++;
      if (built.pk && built.pk.vertexCount) packs.push({ file: path.basename(f), s, pk: built.pk });
    }
  }
}
const mag = pairs
  .flatMap(([a, b]) => [Math.abs(a), Math.abs(b)])
  .filter((v) => v > 0)
  .sort((x, y) => x - y);
console.log(
  `corpus: ${assets} assets, ${shapes} shapes, ${withRings} with cubic curve-band rings, ${pairs.length} (dk,dl) pairs`,
);
console.log(
  `  |d| at scale 1: min ${mag[0].toExponential(3)}  median ${mag[mag.length >> 1].toExponential(3)}  max ${mag[mag.length - 1].toExponential(3)}`,
);
console.log(`  spread at ONE size: 2^${Math.log2(mag[mag.length - 1] / mag[0]).toFixed(1)}`);

// ---- the RANGE each format survives -------------------------------------------------------------------------
// A pair is LOST if either component comes back as inf (saturation), as 0 when it was not 0 (flush), or as NaN.
const HALF_MAX = 65504,
  HALF_MIN_SUB = Math.pow(2, -24),
  HALF_MIN_NORM = Math.pow(2, -14);
function lost(pairs, S, rt) {
  let sat = 0,
    flush = 0,
    sub = 0;
  for (const [a0, b0] of pairs) {
    for (const v0 of [a0, b0]) {
      const v = v0 / S,
        r = rt(v);
      if (!Number.isFinite(r)) {
        sat++;
        continue;
      }
      if (v !== 0 && r === 0) {
        flush++;
        continue;
      }
      if (v !== 0 && Math.abs(v) < HALF_MIN_NORM) sub++;
    }
  }
  return { sat, flush, sub };
}
const newRt = (v) => unpackKlmGrad(packKlmGrad(v, 0))[0];
const EXPS = [-30, -20, -15, -11, -8, 0, 4, 7, 11, 16, 20, 30];
console.log(
  '\n  components lost, of ' +
    pairs.length * 2 +
    ' (saturated to inf / flushed to zero), by authored scale:',
);
console.log('    2^e      half: sat  flush            shared-exponent: sat  flush');
for (const e of EXPS) {
  const S = Math.pow(2, e);
  const h = lost(pairs, S, halfRound),
    n = lost(pairs, S, newRt);
  console.log(
    `    ${String(e).padStart(4)}   ${String(h.sat).padStart(11)} ${String(h.flush).padStart(6)}   ${String(n.sat).padStart(24)} ${String(n.flush).padStart(6)}`,
  );
}
console.log(
  `  (half's own limits: max ${HALF_MAX}, smallest normal ${HALF_MIN_NORM.toExponential(2)}, smallest subnormal ${HALF_MIN_SUB.toExponential(2)})`,
);

// ---- ACCURACY where half still works --------------------------------------------------------------------------
// The number the kernel consumes is the PAIR multiplied by the 1.5px ring push, so what matters is each
// component's error RELATIVE TO THE PAIR'S MAGNITUDE -- an error in the smaller component moves klm by that much
// of the larger component's own step. Reported both ways.
function acc(pairs, S, pack) {
  let worstSelf = 0,
    worstPair = 0,
    sumPair = 0,
    n = 0;
  for (const [a0, b0] of pairs) {
    const a = a0 / S,
      b = b0 / S;
    const [ra, rb] = pack(a, b);
    if (!Number.isFinite(ra) || !Number.isFinite(rb)) continue;
    const G = Math.max(Math.abs(a), Math.abs(b));
    if (!(G > 0)) continue;
    for (const [v, r] of [
      [a, ra],
      [b, rb],
    ]) {
      const e = Math.abs(r - v);
      if (Math.abs(v) > 0) worstSelf = Math.max(worstSelf, e / Math.abs(v));
      worstPair = Math.max(worstPair, e / G);
      sumPair += e / G;
      n++;
    }
  }
  return { worstSelf, worstPair, meanPair: sumPair / n, n };
}
const halfPair = (a, b) => [halfRound(a), halfRound(b)];
const newPair = (a, b) => unpackKlmGrad(packKlmGrad(a, b));
console.log('\n  round-trip error, over the pairs each format can still represent:');
console.log('    2^e   format             worst/own       worst/pair        mean/pair    n');
for (const e of [-8, 0, 4, -20, 20]) {
  const S = Math.pow(2, e);
  for (const [nm, p] of [
    ['half             ', halfPair],
    ['shared-exponent  ', newPair],
  ]) {
    const r = acc(pairs, S, p);
    console.log(
      `    ${String(e).padStart(4)}  ${nm} ${r.worstSelf.toExponential(3).padStart(11)} ${r.worstPair.toExponential(3).padStart(16)} ${r.meanPair.toExponential(3).padStart(16)}  ${r.n}`,
    );
  }
}
console.log(
  '\n  2^-11 = ' +
    Math.pow(2, -11).toExponential(3) +
    ' is the bar both formats are meant to hold on the PAIR.',
);

// ---- SCALE-1 PACK CENSUS ------------------------------------------------------------------------------------
// Which vertex floats differ at the AUTHORED size, and why. The packed slot is rebuilt with the half codec
// from the same decoded pair, so the diff is exact and needs no second checkout: every float that differs must
// be lane 9 of an extruded cubic CURVE_BAND ring vertex, and nothing else may move at all.
{
  const { LB_VERT_FLOATS } = await import(path.join(ROOT, 'src/renderer/lbPack.js'));
  const packHalfPair = (a, b) => {
    _u[0] = ((toHalfBits(b) << 16) | toHalfBits(a)) >>> 0;
    return _f[0];
  };
  let shapesMoved = 0,
    floatsMoved = 0,
    totalFloats = 0,
    ringVerts = 0,
    recovered = 0,
    worstOld = 0;
  const movers = [];
  for (const { file, s, pk } of packs) {
    const v = pk.verts.subarray(0, pk.vertexCount * LB_VERT_FLOATS);
    totalFloats += v.length;
    let moved = 0;
    for (let o = 0; o < v.length; o += LB_VERT_FLOATS) {
      const kd = Math.floor(v[o + 5]);
      if (!(kd === 12 && Math.abs(v[o + 6]) >= 8192)) continue;
      if (v[o + 9] === 0 && v[o + 7] === 0 && v[o + 8] === 0) continue; // inner (unextruded) ring vertex
      ringVerts++;
      const [dk, dl] = unpackKlmGrad(v[o + 9]);
      if (packHalfPair(dk, dl) !== v[o + 9]) {
        moved++;
        floatsMoved++;
      }
      const od = [halfRound(dk), halfRound(dl)],
        G = Math.max(Math.abs(dk), Math.abs(dl));
      if (G > 0) {
        worstOld = Math.max(worstOld, Math.abs(od[0] - dk) / G, Math.abs(od[1] - dl) / G);
        if (
          (dk !== 0 && od[0] === 0) ||
          (dl !== 0 && od[1] === 0) ||
          !Number.isFinite(od[0]) ||
          !Number.isFinite(od[1])
        )
          recovered++;
      }
    }
    if (moved) {
      shapesMoved++;
      movers.push(`${file}#${s}:${moved}`);
    }
  }
  console.log(
    `\n  scale-1 pack survey: ${packs.length} shapes carry cubic curve-band rings, ${totalFloats} packed floats, ${ringVerts} extruded ring vertices`,
  );
  console.log(
    `    shapes whose bytes move: ${shapesMoved} of ${packs.length}; floats that move: ${floatsMoved} (${((100 * floatsMoved) / totalFloats).toFixed(2)}% of the pack), all of them lane 9`,
  );
  console.log(
    `    components the half codec turned into a hard zero or an inf, now carried: ${recovered}`,
  );
  console.log(
    `    worst half round-trip error against the shipped decode, relative to the pair: ${worstOld.toExponential(3)}`,
  );
  console.log(`    first movers: ${movers.slice(0, 8).join(' ')}`);
}
