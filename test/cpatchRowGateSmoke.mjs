// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchRowGateSmoke — the CPatch hull-row gate decides the same thing at every scale, and its
// leak predicate is monotone in its own tolerance.
//
// THE GATE. A packed patch carries six hull planes that fence what the cover quad's 1.5px dilation
// would otherwise let its half-spaces paint outside it. They cost a per-fragment loop, so the
// packer asks whether this patch's conjunction reaches past its own box at all, and drops them
// where it does not. Asked against a FLAT 0.02 in the drawing's own units, that question makes
// 518 of 1345 corpus shapes pack a different row set under an exact power-of-two scaling at 2^-20
// and 110 at 2^8 (probes/_zzScaleWide), with the gate off and everything else equal giving none at
// any exponent from 2^-20 to 2^20. Nothing about a drawing changes when it is
// authored twice the size, so a gate whose answer does is a defect.
//
// It is also not a DEPTH question, which is the trap the obvious repair falls into: scaling the bar
// to the contour's own accepted defect size drops rows on patches whose leak is shallow and long,
// and tiger #132's patch 105 holds 17.9 px^2 of ink outside its shape that way (per patch, by
// probes/cpatchGate/_rowGateSpill.mjs). The shipped gate carries no policy bar at all -- only a
// numerical floor at the patch's own scale, which keeps the probe off the patch's own ends.
//
// WHAT IS PINNED
//   scale        the packed wire at 2^k is the scale-1 wire scaled, with the gate ON, on the
//                shapes the flat bar moved (tiger #0, #1, #4 at 2^-20 and 2^8; lbMemBudget #84,
//                whose refusal ladder carried the flat bar into a normalized frame, at 2^8)
//   monotone     patchLeaksInBox is monotone in its bar: a leak found at a tight bar and deeper
//                than a looser one must still be found at the looser one, and a patch fenced at a
//                loose bar must be fenced at every tighter one. A predicate whose nudge and
//                same-curve threshold both read the bar, and whose feasible set is clipped by it
//                before the probes are placed, breaks the first of those on 1397 of tiger's 3716
//                patches over a ladder from 0.0005 to 1.28.
//   superset     the shipped gate fences every patch the flat bar fences. That is the whole
//                correctness argument for the gate: a hull row is a min() of a half-plane's
//                coverage, so a strictly larger row set cannot spill more.
import { readFileSync } from 'fs';
// The hull-row check exercises retained seam patches, not complete-paint covers.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__CP_NO_AREA = 1;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { contoursToConverter } = await import('../src/renderer/cpatchBuild.js');
const { packCPatchShape, K_ROWS } = await import('../src/renderer/cpatchPack.js');
const CV = await import('../src/renderer/cpatchConvert.js');
const { patchLeaksInBox, CP_TOL_DEFAULT } = CV;

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
const _warn = console.warn;
console.warn = () => {};

// ------------------------------------------------------------------ comparator
/// Is a == b * S^e for some integer e, to `tol` relative? (probes/_zzScaleWide.mjs's numEq.)
function numEq(a, b, S, tol) {
  if (a === b || (a !== a && b !== b)) return true;
  if (!isFinite(a) || !isFinite(b) || a === 0 || b === 0) return false;
  for (let e = -8, p = S ** -8; e <= 8; e++, p *= S)
    if (Math.abs(a / p - b) <= Math.abs(b) * tol) return true;
  return false;
}
function cmpWire(a, b, S) {
  for (const k of ['vertexCount', 'kindMask', 'unresolved', 'dropped', 'cells']) {
    if ((a[k] | 0) !== (b[k] | 0)) return `${k}: ${b[k]} -> ${a[k]}`;
  }
  for (const k of ['texels', 'verts']) {
    if (a[k].length !== b[k].length) return `${k}: length ${b[k].length} -> ${a[k].length}`;
    for (let i = 0; i < a[k].length; i++)
      if (!numEq(a[k][i], b[k][i], S, 1e-6)) return `${k}[${i}]: ${b[k][i]} -> ${a[k][i]}`;
  }
  return null;
}

// ------------------------------------------------------------------ inputs
/// The float64 curve plane where the importer kept one: the CPatch front end's own input.
async function load(file) {
  const svg = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
    .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
    .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
  const sec = await importSvg(svg, { preserveViewport: true });
  return { sec, cf: sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves) };
}
/// FRESH converter segments at 2^k. A spread copy would carry the implicit and packed memos, which
/// live on the segment under symbols, and every scale would then read the first one's answers.
const scaled = (cs, S) =>
  cs.map((c) =>
    c.map((sg) => {
      const o = { t: sg.t, P: sg.P.map((p) => [p[0] * S, p[1] * S]) };
      if (sg.cut) o.cut = true;
      if (sg.w !== undefined) o.w = sg.w;
      return o;
    }),
  );
const packAt = (cs, S, patches) => {
  const w = packCPatchShape(scaled(cs, S), 0, {
    evenOdd: false,
    onPatches: patches ? (a) => patches.push(...a) : undefined,
  });
  return (
    w && {
      texels: w.texels,
      verts: w.verts,
      vertexCount: w.vertexCount,
      kindMask: w.kindMask | 0,
      unresolved: w.unresolved | 0,
      dropped: w.dropped | 0,
      cells: w.cells | 0,
    }
  );
};
const contourOf = (A, s) => {
  const r = A.sec.curveRangesByShape[s];
  return contoursToConverter(curveRangeToContours(A.cf, r.begin, r.end), null);
};

// ------------------------------------------------------------------ the gate is scale-free
console.log(
  'CPatch hull-row gate (packCPatchShape, gate ON): the wire at 2^k is the wire at 1, scaled',
);
const T = await load('examples/tiger.svg');
const M = await load('examples/smoke/lbMemBudget__SVG.svg');
{
  // THE GATE IS DECIDING, asserted rather than assumed: a gate that kept every patch's rows (or none)
  // would make the wire trivially scale-free and this whole file pass for the wrong reason. There is
  // no switch to turn the gate off, so the gate's own verdicts are what is checked -- on the shapes below (the three the scale check uses, plus three small
  // ones that each carry an exempted patch), some patches keep their rows and some are exempted.
  {
    const ps = [];
    for (const s of [0, 1, 4, 2, 6, 11]) packAt(contourOf(T, s), 1, ps);
    const kept = ps.filter((q) => q[K_ROWS] === true).length,
      exempt = ps.filter((q) => q[K_ROWS] === false).length;
    check(
      kept > 0 && exempt > 0 && kept + exempt === ps.length,
      `the exact row gate decides per patch (${kept} keep their rows, ${exempt} exempt, of ${ps.length})`,
    );
  }
  for (const [A, name, s, KS] of [
    [T, 'tiger', 0, [-20, 8]],
    [T, 'tiger', 1, [-20, 8]],
    [T, 'tiger', 4, [-20, 8]],
    [M, 'lbMemBudget', 84, [8]],
  ]) {
    const cs = contourOf(A, s);
    const ref = packAt(cs, 1, null);
    for (const k of KS) {
      const got = packAt(cs, 2 ** k, null);
      const w = ref && got ? cmpWire(got, ref, 2 ** k) : 'packed nothing';
      check(!w, `${name} #${s} packs the scale-1 wire at 2^${k}${w ? ' -- ' + w : ''}`);
    }
  }
}

// ------------------------------------------------------------------ the predicate is monotone
console.log('patchLeaksInBox is monotone in its own bar');
{
  const patches = [];
  for (const [A, s] of [
    [T, 12],
    [T, 24],
    [T, 132],
    [M, 299],
  ])
    packAt(contourOf(A, s), 1, patches);
  check(
    patches.length > 100,
    `the sampled shapes decompose into patches to test (${patches.length})`,
  );
  // leakOfInner is the DEPTH behind the verdict; without it "found at a tight bar" cannot be
  // stated, so its absence is a failure rather than a skip.
  check(
    typeof CV.leakOfInner === 'function',
    'cpatchConvert exports leakOfInner (the depth behind the verdict)',
  );
  const BARS = [0.002, 0.01, 0.02, 0.061, 0.16, 0.64];
  let deep = 0,
    rise = 0,
    tested = 0,
    seen = 0;
  for (const p of patches) {
    const ext = Math.max(p.bbox[2] - p.bbox[0], p.bbox[3] - p.bbox[1]);
    // THE GATE'S own ASK, not a bare number: leakOfInner takes an `ask` object, and a number in
    // that slot reads as "no fields set", which is the SEARCH's ask -- the file would then grade a
    // predicate the gate does not use and pass while the gate was broken.
    const gateAsk = {
      nudgePx: ext > 0 ? (CP_TOL_DEFAULT / 256) * ext : 1e-12,
      monotone: true,
      anyStretch: true,
      box: true,
    };
    const gate = BARS.map((t) => {
      try {
        return patchLeaksInBox(p, t);
      } catch {
        return true;
      }
    });
    const lk = BARS.map((t) => {
      let v = null;
      try {
        v = CV.leakOfInner(p, t, 0, gateAsk);
      } catch {
        v = null;
      }
      return v;
    });
    for (let a = 0; a < BARS.length; a++) {
      if (!gate[a] || !lk[a]) continue;
      seen++;
      for (let b = a + 1; b < BARS.length; b++) {
        if (!(lk[a].depth > BARS[b])) continue; // the leak would not clear the looser bar anyway
        tested++;
        if (!gate[b]) {
          deep++;
          b = BARS.length;
        }
      }
    }
    // The other direction needs no depth at all: "a leak at least t deep exists" is non-increasing
    // in t by its own statement, so fenced at a looser bar and not at a tighter one is a
    // contradiction on its face.
    for (let a = 0; a < BARS.length; a++) {
      if (gate[a]) continue;
      let b = a + 1;
      while (b < BARS.length && !gate[b]) b++;
      if (b < BARS.length) {
        rise++;
        break;
      }
    }
  }
  check(
    seen > 0 && tested > 0,
    `the sampled patches produce leaks to compare across bars (${seen} verdicts, ${tested} pairs)`,
  );
  check(
    deep === 0,
    `a leak found at a tight bar and deeper than a looser one is found at the looser one (${deep} patches fail)`,
  );
  check(
    rise === 0,
    `no patch is fenced at a looser bar and left unfenced at a tighter one (${rise} patches fail)`,
  );
}

// ------------------------------------------------------------------ the row set only grows
console.log('the shipped gate fences every patch the flat bar fences');
{
  // THE FLAT BAR'S VERDICT, REPRODUCED exactly, and NOT patchLeaksInBox(p, 0.02). That call passes
  // the gate's ask whatever bar it is handed, so it answers "the shipped predicate at the flat bar"
  // and this check silently stops being a baseline -- it reads 0 lost while tiger #188's patch 0
  // loses rows that hold 1.01 px^2 of ink outside the shape. The flat-bar gate is the SEARCH's ask
  // at the flat bar with the strict re-test, which is what this is.
  const flatPreFix = (p) => {
    let lk = null;
    try {
      lk = CV.leakOfInner(p, CP_TOL_DEFAULT, 0, { box: true });
    } catch {
      lk = { depth: Infinity };
    }
    return !!(lk && lk.depth > CP_TOL_DEFAULT);
  };
  let lost = 0,
    gained = 0,
    n = 0;
  // #188 is the shape the faithful baseline caught, so it stays in the list by name.
  for (const [A, name, s] of [
    [T, 'tiger', 24],
    [T, 'tiger', 42],
    [T, 'tiger', 132],
    [T, 'tiger', 145],
    [T, 'tiger', 188],
    [T, 'tiger', 31],
    [T, 'tiger', 37],
    [M, 'lbMemBudget', 84],
    [M, 'lbMemBudget', 299],
  ]) {
    const patches = [];
    packAt(contourOf(A, s), 1, patches);
    for (const p of patches) {
      n++;
      let flat = true,
        now = true;
      try {
        flat = flatPreFix(p);
      } catch {
        flat = true;
      }
      try {
        now = patchLeaksInBox(p);
      } catch {
        now = true;
      }
      if (flat && !now) lost++;
      if (!flat && now) gained++;
    }
    void name;
  }
  check(n > 100, `enough patches to be a statement (${n})`);
  check(
    lost === 0,
    `no patch loses the rows the flat bar gave it (${lost} of ${n}; ${gained} gained)`,
  );
}

console.warn = _warn;
if (fail) {
  console.log(`FAIL cpatchRowGateSmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS cpatchRowGateSmoke');
