// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _wasmCdtBench.mjs — 3-way benchmark of the Bowyer-Watson Delaunay core that
// dominates the Loop-Blinn worker build (src/renderer/cdt.js `delaunay(pts)`).
//
// The question: how much of a wasm speedup is DATA RELAYOUT and how much is the
// LANGUAGE/RUNTIME? Three variants of the same algorithm (incremental
// Bowyer-Watson, walk-to-locate + flood-fill cavity):
//
//   A) js-idiom  — near-verbatim copy of cdt.js's delaunay STRUCTURE:
//                  Array<[x,y]> points, Array<[i,j,k]> triangles, Map edge
//                  adjacency keyed by a*2^32+b, Set badSet, and TWO fresh Maps
//                  allocated PER POINT INSERTION (count, firstE), ccw() returning
//                  a fresh array.
//   B) js-flat   — same algorithm, relaid out: Float64Array points, Int32Array
//                  triangles, flat open-addressed edge hash in typed arrays,
//                  ZERO per-insertion allocation.
//   C) rust-wasm — the same flat algorithm as (B), in Rust (probes/_wasmCdt/cdt.rs),
//                  compiled to wasm32-unknown-unknown by raw rustc at run time.
//
// PREDICATES — read this before drawing conclusions:
//   All three variants use the IDENTICAL plain-double (NON-ROBUST) orient2d /
//   incircle, so the bench isolates layout + runtime rather than predicate
//   implementation. The real cdt.js uses Shewchuk-style robust ADAPTIVE
//   predicates (src/geom/predicates.js); those are allocation-free float math
//   in both languages and would add a similar constant to all three variants.
//   Sign convention is mirrored from predicates.js: its orient2d returns the
//   CCW-positive determinant (it computes the CW-positive form given in the
//   filter and negates it), and incircle is the standard 3x3 determinant form.
//   Do NOT read these numbers as "cdt.js would get this much faster" without
//   accounting for the predicate constant.
//
// Inputs are spatially-coherent contour-like point sets (points walked along
// offset closed curves), NOT uniform random — cdt.js's walk-to-locate exploits
// exactly that contour coherence, and uniform random would misrepresent it.
//
// Usage: node probes/_wasmCdtBench.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '_wasmCdt', 'cdt.rs');
const WASM = join(HERE, '_wasmCdt', 'cdt.wasm');

// ---------------------------------------------------------------------------
// Shared non-robust predicates (JS side; the Rust side has the same formulas).
// ---------------------------------------------------------------------------

// CCW-positive; mirrors predicates.js's returned sign.
const orient2dXY = (ax, ay, bx, by, cx, cy) => -((ay - cy) * (bx - cx) - (ax - cx) * (by - cy));

const incircleXY = (ax, ay, bx, by, cx, cy, dx, dy) => {
  const adx = ax - dx,
    ady = ay - dy;
  const bdx = bx - dx,
    bdy = by - dy;
  const cdx = cx - dx,
    cdy = cy - dy;
  const bdxcdy = bdx * cdy,
    cdxbdy = cdx * bdy;
  const cdxady = cdx * ady,
    adxcdy = adx * cdy;
  const adxbdy = adx * bdy,
    bdxady = bdx * ady;
  const alift = adx * adx + ady * ady;
  const blift = bdx * bdx + bdy * bdy;
  const clift = cdx * cdx + cdy * cdy;
  return alift * (bdxcdy - cdxbdy) + blift * (cdxady - adxcdy) + clift * (adxbdy - bdxady);
};

// ---------------------------------------------------------------------------
// (A) js-idiom — structural copy of cdt.js delaunay() (lines ~52-122).
// ---------------------------------------------------------------------------

const orient2d = (a, b, c) => orient2dXY(a[0], a[1], b[0], b[1], c[0], c[1]);
const incircle = (a, b, c, d) => incircleXY(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]);
const edgeKey = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);

function ccw(pts, a, b, c) {
  return orient2d(pts[a], pts[b], pts[c]) < 0 ? [a, c, b] : [a, b, c];
}

function delaunayIdiom(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const dx = maxX - minX || 1,
    dy = maxY - minY || 1,
    dm = Math.max(dx, dy) * 20;
  const cx = (minX + maxX) / 2,
    cy = (minY + maxY) / 2;
  const P = pts.concat([
    [cx - dm, cy - dm],
    [cx + dm, cy - dm],
    [cx, cy + dm],
  ]);
  const tris = [[n, n + 1, n + 2]];
  const em = new Map();
  const addTE = (k, t) => {
    let a = em.get(k);
    if (!a) {
      a = [];
      em.set(k, a);
    }
    a.push(t);
  };
  const remTE = (k, t) => {
    const a = em.get(k);
    if (!a) return;
    const i = a.indexOf(t);
    if (i >= 0) {
      a[i] = a[a.length - 1];
      a.pop();
    }
    if (!a.length) em.delete(k);
  };
  const nbr = (u, v, t) => {
    const a = em.get(edgeKey(u, v));
    if (!a) return -1;
    return a[0] === t ? (a.length > 1 ? a[1] : -1) : a[0];
  };
  addTE(edgeKey(n, n + 1), 0);
  addTE(edgeKey(n + 1, n + 2), 0);
  addTE(edgeKey(n + 2, n), 0);
  const free = [];
  let lastT = 0;
  const bad = [],
    badSet = new Set(),
    stack = [];
  for (let ip = 0; ip < n; ip++) {
    const p = P[ip];
    let t = lastT;
    if (!tris[t]) t = tris.findIndex(Boolean);
    let g = 0;
    const gMax = tris.length + 64;
    while (g++ < gMax) {
      const T = tris[t];
      const a = T[0],
        b = T[1],
        c = T[2];
      if (orient2d(P[a], P[b], p) < 0) {
        const nb = nbr(a, b, t);
        if (nb < 0) break;
        t = nb;
        continue;
      }
      if (orient2d(P[b], P[c], p) < 0) {
        const nb = nbr(b, c, t);
        if (nb < 0) break;
        t = nb;
        continue;
      }
      if (orient2d(P[c], P[a], p) < 0) {
        const nb = nbr(c, a, t);
        if (nb < 0) break;
        t = nb;
        continue;
      }
      break;
    }
    const T0 = tris[t];
    if (!T0 || incircle(P[T0[0]], P[T0[1]], P[T0[2]], p) <= 0) continue;
    bad.length = 0;
    badSet.clear();
    stack.length = 0;
    bad.push(t);
    badSet.add(t);
    stack.push(t);
    while (stack.length) {
      const bt = stack.pop(),
        T = tris[bt];
      for (let e = 0; e < 3; e++) {
        const nb = nbr(T[e], T[(e + 1) % 3], bt);
        if (nb < 0 || badSet.has(nb)) continue;
        const N = tris[nb];
        if (incircle(P[N[0]], P[N[1]], P[N[2]], p) > 0) {
          badSet.add(nb);
          bad.push(nb);
          stack.push(nb);
        }
      }
    }
    const count = new Map(),
      firstE = new Map();
    for (const bt of bad) {
      const T = tris[bt];
      for (let e = 0; e < 3; e++) {
        const u = T[e],
          v = T[(e + 1) % 3],
          k = edgeKey(u, v);
        count.set(k, (count.get(k) || 0) + 1);
        if (!firstE.has(k)) firstE.set(k, [u, v]);
      }
    }
    for (const bt of bad) {
      const T = tris[bt];
      for (let e = 0; e < 3; e++) remTE(edgeKey(T[e], T[(e + 1) % 3]), bt);
      tris[bt] = null;
      free.push(bt);
    }
    for (const [k, uv] of firstE) {
      if (count.get(k) !== 1) continue;
      const nt = free.length ? free.pop() : tris.push(null) - 1;
      tris[nt] = ccw(P, uv[0], uv[1], ip);
      const T = tris[nt];
      addTE(edgeKey(T[0], T[1]), nt);
      addTE(edgeKey(T[1], T[2]), nt);
      addTE(edgeKey(T[2], T[0]), nt);
      lastT = nt;
    }
  }
  const out = [];
  for (const T of tris) if (T && T[0] < n && T[1] < n && T[2] < n) out.push(T);
  return out;
}

// ---------------------------------------------------------------------------
// (B) js-flat — identical algorithm, typed-array layout, zero per-insertion
//     allocation. Buffers are allocated once per Flat instance and reused; the
//     edge hash resets only the slots the previous run claimed.
// ---------------------------------------------------------------------------

class FlatCdt {
  constructor(maxPts) {
    const MAXT = Math.max(1024, maxPts * 4 + 64);
    let cap = 1024;
    while (cap < maxPts * 32) cap <<= 1; // edge-hash capacity (power of two)
    this.MAXT = MAXT;
    this.CAP = cap;
    this.MASK = cap - 1;
    this.P = new Float64Array((maxPts + 3) * 2);
    this.tri = new Int32Array(MAXT * 3);
    this.alive = new Uint8Array(MAXT); // 0 free, 1 alive, 2 alive+badSet
    this.free = new Int32Array(MAXT);
    this.bad = new Int32Array(MAXT);
    this.stk = new Int32Array(MAXT);
    this.touch = new Int32Array(MAXT * 3);
    this.out = new Int32Array(MAXT * 3);
    this.ekLo = new Uint32Array(cap); // key = (u,v) split; 0/0 in ekUse = empty
    this.ekHi = new Uint32Array(cap);
    this.ekUse = new Uint8Array(cap);
    this.es0 = new Int32Array(cap);
    this.es1 = new Int32Array(cap);
    this.ecn = new Int32Array(cap);
    this.ect = new Int32Array(cap);
    this.efu = new Int32Array(cap);
    this.efv = new Int32Array(cap);
    this.eused = new Int32Array(cap);
    this.nused = 0;
    this.overflow = false;
  }

  _slot(a, b, create) {
    const u = a < b ? a : b,
      v = a < b ? b : a;
    let h = (Math.imul(u, 0x9e3779b1) ^ Math.imul(v, 0x85ebca77)) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    h = Math.imul(h, 0x7feb352d) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    let i = h & this.MASK;
    const { ekLo, ekHi, ekUse } = this;
    for (;;) {
      if (ekUse[i] === 0) {
        if (!create) return -1;
        ekUse[i] = 1;
        ekHi[i] = u;
        ekLo[i] = v;
        this.es0[i] = -1;
        this.es1[i] = -1;
        this.ecn[i] = 0;
        this.ect[i] = 0;
        this.eused[this.nused++] = i;
        return i;
      }
      if (ekHi[i] === u && ekLo[i] === v) return i;
      i = (i + 1) & this.MASK;
    }
  }

  _addTE(s, t) {
    const cn = this.ecn[s];
    if (cn === 0) this.es0[s] = t;
    else if (cn === 1) this.es1[s] = t;
    else {
      this.overflow = true;
      return;
    }
    this.ecn[s] = cn + 1;
  }

  _remTE(s, t) {
    const cn = this.ecn[s];
    if (cn === 1) {
      if (this.es0[s] === t) this.ecn[s] = 0;
    } else if (cn === 2) {
      if (this.es0[s] === t) {
        this.es0[s] = this.es1[s];
        this.ecn[s] = 1;
      } else if (this.es1[s] === t) this.ecn[s] = 1;
    }
  }

  _nbr(u, v, t) {
    const s = this._slot(u, v, false);
    if (s < 0) return -1;
    const cn = this.ecn[s];
    if (cn === 0) return -1;
    return this.es0[s] === t ? (cn > 1 ? this.es1[s] : -1) : this.es0[s];
  }

  // pts: Float64Array of n*2. Returns the triangle count; triangles live in this.out.
  run(n) {
    this.overflow = false;
    if (n < 3) return -1;
    const P = this.P,
      tri = this.tri,
      alive = this.alive,
      free = this.free;
    const bad = this.bad,
      stk = this.stk,
      touch = this.touch,
      out = this.out;
    for (let i = 0; i < this.nused; i++) this.ekUse[this.eused[i]] = 0;
    this.nused = 0;
    alive.fill(0);

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = P[i * 2],
        y = P[i * 2 + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const dx = maxX - minX || 1,
      dy = maxY - minY || 1,
      dm = Math.max(dx, dy) * 20;
    const cx = (minX + maxX) / 2,
      cy = (minY + maxY) / 2;
    P[n * 2] = cx - dm;
    P[n * 2 + 1] = cy - dm;
    P[(n + 1) * 2] = cx + dm;
    P[(n + 1) * 2 + 1] = cy - dm;
    P[(n + 2) * 2] = cx;
    P[(n + 2) * 2 + 1] = cy + dm;

    const or2 = (a, b, c) =>
      orient2dXY(P[a * 2], P[a * 2 + 1], P[b * 2], P[b * 2 + 1], P[c * 2], P[c * 2 + 1]);
    const inc = (a, b, c, d) =>
      incircleXY(
        P[a * 2],
        P[a * 2 + 1],
        P[b * 2],
        P[b * 2 + 1],
        P[c * 2],
        P[c * 2 + 1],
        P[d * 2],
        P[d * 2 + 1],
      );

    let ntri = 1;
    tri[0] = n;
    tri[1] = n + 1;
    tri[2] = n + 2;
    alive[0] = 1;
    this._addTE(this._slot(n, n + 1, true), 0);
    this._addTE(this._slot(n + 1, n + 2, true), 0);
    this._addTE(this._slot(n + 2, n, true), 0);
    let nfree = 0,
      lastT = 0;

    for (let ip = 0; ip < n; ip++) {
      let t = lastT;
      if (alive[t] === 0) {
        t = -1;
        for (let j = 0; j < ntri; j++)
          if (alive[j] !== 0) {
            t = j;
            break;
          }
        if (t < 0) return -1;
      }
      const gMax = ntri + 64;
      for (let g = 0; g < gMax; g++) {
        const tb = t * 3,
          a = tri[tb],
          b = tri[tb + 1],
          c = tri[tb + 2];
        if (or2(a, b, ip) < 0) {
          const nb = this._nbr(a, b, t);
          if (nb < 0) break;
          t = nb;
          continue;
        }
        if (or2(b, c, ip) < 0) {
          const nb = this._nbr(b, c, t);
          if (nb < 0) break;
          t = nb;
          continue;
        }
        if (or2(c, a, ip) < 0) {
          const nb = this._nbr(c, a, t);
          if (nb < 0) break;
          t = nb;
          continue;
        }
        break;
      }
      if (alive[t] === 0 || inc(tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2], ip) <= 0) continue;

      let nbad = 0,
        nstk = 0;
      bad[nbad++] = t;
      alive[t] = 2;
      stk[nstk++] = t;
      while (nstk > 0) {
        const bt = stk[--nstk],
          tb = bt * 3;
        for (let e = 0; e < 3; e++) {
          const nb = this._nbr(tri[tb + e], tri[tb + ((e + 1) % 3)], bt);
          if (nb < 0 || alive[nb] === 2) continue;
          const nn = nb * 3;
          if (inc(tri[nn], tri[nn + 1], tri[nn + 2], ip) > 0) {
            alive[nb] = 2;
            bad[nbad++] = nb;
            stk[nstk++] = nb;
          }
        }
      }
      let ntouch = 0;
      for (let i = 0; i < nbad; i++) {
        const tb = bad[i] * 3;
        for (let e = 0; e < 3; e++) {
          const u = tri[tb + e],
            v = tri[tb + ((e + 1) % 3)];
          const s = this._slot(u, v, true);
          const c = this.ect[s];
          if (c === 0) {
            this.efu[s] = u;
            this.efv[s] = v;
            touch[ntouch++] = s;
          }
          this.ect[s] = c + 1;
        }
      }
      for (let i = 0; i < nbad; i++) {
        const bt = bad[i],
          tb = bt * 3;
        for (let e = 0; e < 3; e++)
          this._remTE(this._slot(tri[tb + e], tri[tb + ((e + 1) % 3)], true), bt);
        alive[bt] = 0;
        free[nfree++] = bt;
      }
      for (let i = 0; i < ntouch; i++) {
        const s = touch[i],
          c = this.ect[s];
        this.ect[s] = 0;
        if (c !== 1) continue;
        const nt = nfree > 0 ? free[--nfree] : ntri++;
        const u = this.efu[s],
          v = this.efv[s];
        const neg = or2(u, v, ip) < 0;
        const a = u,
          b = neg ? ip : v,
          c2 = neg ? v : ip;
        const tb = nt * 3;
        tri[tb] = a;
        tri[tb + 1] = b;
        tri[tb + 2] = c2;
        alive[nt] = 1;
        this._addTE(this._slot(a, b, true), nt);
        this._addTE(this._slot(b, c2, true), nt);
        this._addTE(this._slot(c2, a, true), nt);
        lastT = nt;
      }
    }
    let nout = 0;
    for (let t = 0; t < ntri; t++) {
      if (alive[t] === 0) continue;
      const a = tri[t * 3],
        b = tri[t * 3 + 1],
        c = tri[t * 3 + 2];
      if (a < n && b < n && c < n) {
        out[nout * 3] = a;
        out[nout * 3 + 1] = b;
        out[nout * 3 + 2] = c;
        nout++;
      }
    }
    return nout;
  }
}

// ---------------------------------------------------------------------------
// (C) rust-wasm — build with raw rustc, then instantiate.
// ---------------------------------------------------------------------------

function buildWasm() {
  mkdirSync(join(HERE, '_wasmCdt'), { recursive: true });
  // Homebrew's rustc SHADOWS rustup in PATH and cannot see the wasm32 core crate
  // ("can't find crate for `core`"). Always resolve through rustup.
  let rustc;
  try {
    rustc = execFileSync('rustup', ['which', 'rustc'], { encoding: 'utf8' }).trim();
  } catch (e) {
    console.error('rustup not found — cannot resolve a rustc that has the wasm32 core crate.');
    process.exit(1);
  }
  try {
    execFileSync(
      rustc,
      ['--target', 'wasm32-unknown-unknown', '-O', '--crate-type=cdylib', '-o', WASM, SRC],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    console.error('rustc build FAILED:\n' + (e.stderr || e.message));
    process.exit(1);
  }
  if (!existsSync(WASM)) {
    console.error('rustc reported success but ' + WASM + ' is missing');
    process.exit(1);
  }
  return rustc;
}

async function loadWasm() {
  const mod = await WebAssembly.instantiate(readFileSync(WASM), {});
  return mod.instance.exports;
}

// ---------------------------------------------------------------------------
// Inputs: spatially-coherent contour-like point sets — points walked along
// closed offset curves (a harmonic blob), the shape of real LB control-point
// input. Deterministic; deduped so no two points coincide.
// ---------------------------------------------------------------------------

function contourPoints(n) {
  const pts = [];
  const rings = Math.max(3, Math.round(Math.sqrt(n) / 3));
  const per = Math.floor(n / rings);
  const seen = new Set();
  for (let r = 0; r < rings && pts.length < n; r++) {
    const off = 12 + r * 9.37; // offset curve radius
    const phase = r * 0.618;
    const cnt = r === rings - 1 ? n - pts.length : per;
    for (let i = 0; i < cnt; i++) {
      const th = (i / cnt) * Math.PI * 2 + phase;
      const rad = off * (1 + 0.34 * Math.sin(3 * th + phase) + 0.11 * Math.cos(7 * th));
      const x = Math.round((256 + rad * Math.cos(th)) * 64) / 64; // 1/64 design grid
      const y = Math.round((256 + rad * Math.sin(th) * 0.82) * 64) / 64;
      const k = x + ':' + y;
      if (seen.has(k)) continue;
      seen.add(k);
      pts.push([x, y]);
    }
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Canonicalization + timing
// ---------------------------------------------------------------------------

function canon(tris) {
  const a = tris.map((t) => {
    const s = [t[0], t[1], t[2]].sort((x, y) => x - y);
    return s;
  });
  a.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  return a;
}

function diffCount(A, B) {
  const key = (t) => t[0] + ',' + t[1] + ',' + t[2];
  const sa = new Set(A.map(key)),
    sb = new Set(B.map(key));
  let d = 0;
  for (const k of sa) if (!sb.has(k)) d++;
  for (const k of sb) if (!sa.has(k)) d++;
  return d;
}

function minOf(fn, runs = 7, warm = 3) {
  for (let i = 0; i < warm; i++) fn();
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  return best;
}

// ---------------------------------------------------------------------------

const SIZES = [500, 2000, 8000];

const rustc = buildWasm();
const w = await loadWasm();
const wMem = () => new Float64Array(w.memory.buffer, w.ptsPtr(), (w.maxPoints() + 3) * 2);

console.log('rustc:', execFileSync(rustc, ['--version'], { encoding: 'utf8' }).trim());
console.log('node :', process.version, '| wasm max points:', w.maxPoints());
console.log('predicates: plain-double (non-robust), IDENTICAL in all 3 variants — this bench');
console.log('            isolates layout/runtime, not predicate implementation. Real cdt.js uses');
console.log(
  '            robust adaptive predicates: allocation-free float math in both languages,',
);
console.log('            a similar constant added to all three variants.');
console.log('input: spatially-coherent contour-like points (offset closed curves), matching the');
console.log("       contour coherence cdt.js's walk-to-locate exploits.");
console.log('note : lbBuildCore has no curve-count gate in front of analytic rendering; a');
console.log('       4000-curve-float bar would be a proxy for build TIME, which the progressive');
console.log('       build answers directly. So the 8000-point row IS what the production LB path');
console.log('       triangulates.');
console.log('');

const rows = [];
let failed = false;

for (const size of SIZES) {
  const pts = contourPoints(size);
  const n = pts.length;

  // A
  const triA = delaunayIdiom(pts.map((p) => [p[0], p[1]]));

  // B
  const flat = new FlatCdt(n);
  const loadFlat = () => {
    for (let i = 0; i < n; i++) {
      flat.P[i * 2] = pts[i][0];
      flat.P[i * 2 + 1] = pts[i][1];
    }
  };
  loadFlat();
  const nB = flat.run(n);
  if (flat.overflow) {
    console.error('js-flat: edge slot overflow (>2 triangles per edge)');
    process.exit(1);
  }
  const triB = [];
  for (let i = 0; i < nB; i++)
    triB.push([flat.out[i * 3], flat.out[i * 3 + 1], flat.out[i * 3 + 2]]);

  // C
  const loadWasmPts = () => {
    const m = wMem();
    for (let i = 0; i < n; i++) {
      m[i * 2] = pts[i][0];
      m[i * 2 + 1] = pts[i][1];
    }
  };
  loadWasmPts();
  const nC = w.run(n);
  if (nC < 0) {
    console.error('rust-wasm: run() failed for n=' + n);
    process.exit(1);
  }
  if (w.overflowed()) {
    console.error('rust-wasm: edge slot overflow');
    process.exit(1);
  }
  const outC = new Int32Array(w.memory.buffer, w.outPtr(), nC * 3);
  const triC = [];
  for (let i = 0; i < nC; i++) triC.push([outC[i * 3], outC[i * 3 + 1], outC[i * 3 + 2]]);

  // CORRECTNESS GATE
  const cA = canon(triA),
    cB = canon(triB),
    cC = canon(triC);
  const dAB = diffCount(cA, cB),
    dAC = diffCount(cA, cC),
    dBC = diffCount(cB, cC);
  if (dAB || dAC || dBC) {
    failed = true;
    console.error(`CORRECTNESS GATE FAILED at n=${n}:`);
    console.error(`  counts: js-idiom=${cA.length} js-flat=${cB.length} rust-wasm=${cC.length}`);
    console.error(
      `  differing triangles: idiom-vs-flat=${dAB} idiom-vs-rust=${dAC} flat-vs-rust=${dBC}`,
    );
    continue;
  }

  const tA = minOf(() => delaunayIdiom(pts.map((p) => [p[0], p[1]])));
  const tB = minOf(() => {
    loadFlat();
    flat.run(n);
  });
  const tC = minOf(() => {
    loadWasmPts();
    w.run(n);
  });
  rows.push({ n, tA, tB, tC, tris: cA.length });
}

if (failed) {
  console.error('\nFAIL: variants disagree — no timings reported.');
  process.exit(1);
}

console.log('All three variants produce IDENTICAL triangulations (exact canonicalized-set match).');
console.log('');
const f = (x) => x.toFixed(3).padStart(9);
console.log(
  ' size |  tris | js-idiom |  js-flat | rust-wasm | flat/idiom | rust/flat | rust/idiom',
);
console.log(
  '------+-------+----------+----------+-----------+------------+-----------+-----------',
);
for (const r of rows) {
  console.log(
    `${String(r.n).padStart(5)} |${String(r.tris).padStart(6)} |${f(r.tA)} |${f(r.tB)} |${f(r.tC)} |` +
      `${(r.tA / r.tB).toFixed(2) + 'x'.padStart(1)}`.padStart(12) +
      ` |${((r.tB / r.tC).toFixed(2) + 'x').padStart(10)} |${((r.tA / r.tC).toFixed(2) + 'x').padStart(10)}`,
  );
}
console.log(
  '\n(ms per triangulation, min of 7 after 3 warmups; flat/idiom and rust/flat are SPEEDUPS.)',
);

const geo = (sel) => Math.exp(rows.reduce((s, r) => s + Math.log(sel(r)), 0) / rows.length);
const gRelayout = geo((r) => r.tA / r.tB);
const gLang = geo((r) => r.tB / r.tC);
console.log(`\ngeomean speedup — relayout (js-idiom -> js-flat): ${gRelayout.toFixed(2)}x`);
console.log(`geomean speedup — language  (js-flat  -> rust-wasm): ${gLang.toFixed(2)}x`);
console.log(
  `geomean speedup — combined  (js-idiom -> rust-wasm): ${geo((r) => r.tA / r.tC).toFixed(2)}x`,
);
// The two factors land close together and the winner flips run to run, so only
// call one dominant when the gap is bigger than run-to-run noise (~15%).
const ratio = gRelayout / gLang;
if (ratio > 1.15) {
  console.log(
    `\nDominant factor: DATA RELAYOUT (${gRelayout.toFixed(2)}x) over the language (${gLang.toFixed(2)}x).`,
  );
} else if (ratio < 1 / 1.15) {
  console.log(
    `\nDominant factor: RUST/WASM, the language/runtime (${gLang.toFixed(2)}x) over relayout (${gRelayout.toFixed(2)}x).`,
  );
} else {
  console.log(
    `\nNEITHER factor dominates: relayout ${gRelayout.toFixed(2)}x and language ${gLang.toFixed(2)}x are within noise`,
  );
  console.log(
    'of each other — they contribute roughly equally, and they MULTIPLY. Half the total win is',
  );
  console.log('available in pure JS by relaying out the data; the rest needs the wasm move.');
}
