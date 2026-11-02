// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchKernelCost — where CPatch's fragment time goes. NO GPU.
//
//   node probes/cpatchQuality/_cpatchKernelCost.mjs --asset FILE [--n 512] [--texts A.glsl,B.glsl] [--companion] [--defs A,B] [--simd]
//
// KERNEL VARIANTS THAT DO NOT PAY ON THE GPU (each timed there; the renderer has none of them):
//   eo + gate  a patch that reaches 0 on an outline term discards there; an arc solve whose answer cannot matter is
//              skipped. Output-identical, and a TIE: 1.01-1.07 (tiger).
//   nb         each bracketed root stepped by Newton, bisection off the bracket: x1.24-1.28 SLOWER, and a fixed-trip,
//              branch-free Newton (value-identical to nb) x1.32-1.46 -- so neither the early exits nor divergence were the
//              cost; the GPU favors the fixed-trip bisection the chain already runs, whatever this model's lane count says.
// --texts times other generated shader texts beside this tree's own.
//
// --asset runs the float32 twin (test/_glslEmu.mjs) over every fragment of every CPatch cover triangle, as kid-style
// harnesses rasterize them, and splits the fragments by what the base kernel returns: INTERIOR (1), EDGE (0 < c < 1)
// and EMPTY (0, a fragment the cover shaded for nothing). Per arm: nanoseconds per fragment per class (the timed
// emulator, best of REPS), and how many fragments' answers differ from the base's. --simd also counts the arc solves
// each fragment runs and prices them the way a GPU does: fragments are grouped by (patch run, 8x4 pixel tile) and a
// group pays for its busiest lane.
//
// MEASURED (tiger at 512 px, 817,257 fragments: 647,731 interior, 62,198 edge, 107,328 empty):
//
//                        interior   edge    empty   total    differ     SIMD solve-lanes / fragment
//   base                  118 ns   1247 ns  756 ns  235 ms        0     0.878   (companion on: 1.338)
//   eo                    117      1236     500     207           0
//   gate                  114      1196     745     229           0     0.796   (1.145)
//   eo + gate             115      1199     496     202           0     0.758   (1.105)
//   all (+ nb)            110       671     290     144      21,812
//   companion on: base 276 ms, all 156 ms.
//
// The edge class is the cubic chain: 1.28 solves per edge fragment, ~65 polynomial evaluations each, 24 bisection
// steps per bracket. nb's 21,812 moved fragments are rounding; against the exact coverage (the kid harness, 12x12
// reference) tiger off >32/255 5179 -> 5180 and off >= 0.5 65 -> 65, star/fish/onion/landscape/eagle unchanged in every
// count. Why the companion costs 1.46x on the GPU and 1.17x here: per LANE it adds 25% arc solves, per SIMD GROUP 52%.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (k) => argv.includes('--' + k);
const GEN = path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl');

const once = (s, from, to, tag) => {
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`edit '${tag}' matched ${n} times: the shader moved, re-derive it`);
  return s.replace(from, () => to);
};

// ---- the fragments ----------------------------------------------------------------------------------------------------
const asset = flag('asset');
if (!asset) {
  console.error(
    'usage: --asset FILE [--n N] [--texts A.glsl,B.glsl] [--companion] [--defs A,B] [--simd]',
  );
  process.exit(2);
}
if (has('companion')) {
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__CP_COMP_ON = 1;
}
console.warn = () => {};
const N = +flag('n', 512),
  REPS = +flag('reps', 5),
  CAP = 40000;
const defines = flag('defs') ? flag('defs').split(',') : [];
const { default: importSvg } = await import(path.join(ROOT, 'src/svg/importer.js'));
const CB = await import(path.join(ROOT, 'src/renderer/cpatchBuild.js'));
const { curveRangeToContours } = await import(path.join(ROOT, 'src/geom/lbContour.js'));
const { LB_STRIDE } = await import(path.join(ROOT, 'src/renderer/cpatchPack.js'));
const E = await import(path.join(ROOT, 'test/_glslEmu.mjs'));
const gl = {
  TEXTURE_2D: 1,
  texImage2D(...a) {
    gl.plane = a[8];
  },
  bindTexture() {},
  texParameteri() {},
  texSubImage2D() {},
  deleteTexture() {},
  createTexture() {
    return {};
  },
};
const bundle = CB.headlessCPatchBundle(await importSvg(readFileSync(path.resolve(asset), 'utf8')));
const cf = CB.cpatchCurvePlane(bundle); // before the build, which drops the float64 plane
CB.buildCPatchBundle(gl, bundle, { pool: false });
let x0 = Infinity,
  y0 = Infinity,
  x1 = -Infinity,
  y1 = -Infinity;
const meshes = [];
bundle.curveRangesByShape.forEach((r, s) => {
  const m = (bundle._lbMeshes || [])[s];
  if (!m || !m.cpatch) return;
  meshes.push(m);
  for (const c of CB.contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null))
    for (const g of c)
      for (const p of g.P) {
        x0 = Math.min(x0, p[0]);
        x1 = Math.max(x1, p[0]);
        y0 = Math.min(y0, p[1]);
        y1 = Math.max(y1, p[1]);
      }
});
const epp = Math.max(x1 - x0, y1 - y0) / N;
const W = Math.ceil((x1 - x0) / epp) + 8,
  H = Math.ceil((y1 - y0) / epp) + 8,
  fx0 = x0 - 4 * epp,
  fy0 = y0 - 4 * epp;
const qs = [],
  group = [];
for (const m of meshes) {
  const v = m.verts,
    S = LB_STRIDE;
  for (let tri = 0; (tri + 1) * 3 * S <= v.length; tri++) {
    const vs = [0, 1, 2].map((k) => v.subarray((tri * 3 + k) * S, (tri * 3 + k + 1) * S));
    const q = vs.map((u) => [u[0] + u[17] + u[2] * 1.5 * epp, u[1] + u[18] + u[3] * 1.5 * epp]); // the vertex stage's dilation
    let area =
      (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
    if (!(Math.abs(area) > 0)) continue;
    const o = area > 0 ? [0, 1, 2] : [0, 2, 1],
      Q = o.map((k) => q[k]),
      Wv = o.map((k) => vs[k]);
    area = Math.abs(area);
    const edge = (a, c, p) => (c[0] - a[0]) * (p[1] - a[1]) - (c[1] - a[1]) * (p[0] - a[0]);
    const inE = (w, a, c) =>
      w > 0 || (w === 0 && (c[1] - a[1] < 0 || (c[1] === a[1] && c[0] > a[0]))); // top-left rule
    const xs = Q.map((p) => p[0]),
      ys = Q.map((p) => p[1]);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - fx0) / epp - 0.5)),
      i1 = Math.min(W - 1, Math.ceil((Math.max(...xs) - fx0) / epp));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - fy0) / epp - 0.5)),
      j1 = Math.min(H - 1, Math.ceil((Math.max(...ys) - fy0) / epp));
    const f = Wv[2];
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const p = [fx0 + (i + 0.5) * epp, fy0 + (j + 0.5) * epp];
        const w0 = edge(Q[1], Q[2], p),
          w1 = edge(Q[2], Q[0], p),
          w2 = edge(Q[0], Q[1], p);
        if (!(inE(w0, Q[1], Q[2]) && inE(w1, Q[2], Q[0]) && inE(w2, Q[0], Q[1]))) continue;
        const tc = [2, 3, 4].map((c) => (w0 * Wv[0][c] + w1 * Wv[1][c] + w2 * Wv[2][c]) / area);
        qs.push({
          k: E.K_CPATCH_COV,
          GD: [f[7], f[8], f[9], f[10]],
          bb: [f[11], f[12], f[13], f[14]],
          c: [p[0] - f[17], p[1] - f[18]],
          ePx: [f[19], f[20]],
          ex: [tc[0], tc[1], tc[2], f[15], f[16], epp],
        });
        group.push(`${f[19]}:${i >> 3}:${j >> 2}`);
      }
  }
}

// ---- per text: time per class, identity, and (--simd) the arc solves --------------------------------------------------
const texts = [['base', readFileSync(GEN, 'utf8')]];
for (const f of (flag('texts') || '').split(',').filter(Boolean))
  texts.push([path.basename(path.dirname(f)) || f, readFileSync(path.resolve(f), 'utf8')]);
const base = E.buildGlslEmu(ROOT, { cpatch: true, glsl: texts[0][1], defines }).run(
  new Float32Array(4),
  gl.plane,
  qs,
);
const cls = { interior: [], edge: [], empty: [] };
base.forEach((c, k) => (c >= 1 ? cls.interior : c > 0 ? cls.edge : cls.empty).push(k));
const pick = Object.fromEntries(
  Object.entries(cls).map(([k, l]) => {
    const st = Math.max(1, l.length / CAP);
    return [
      k,
      Array.from({ length: Math.min(CAP, l.length) }, (_, i) => qs[l[Math.floor(i * st)]]),
    ];
  }),
);
// Each arm's text rewritten to COUNT its cpArcDistFoot calls and return the count in place of the coverage.
const counting = (text) => {
  let s = once(
    text,
    'float cpArcDistFoot(vec4 g0, vec4 g1, bool arc3, vec2 p, out float tOut, out vec2 footOut) {',
    'int cpArcCalls = 0;\nfloat cpArcDistFoot(vec4 g0, vec4 g1, bool arc3, vec2 p, out float tOut, out vec2 footOut) {\n  cpArcCalls++;',
    'count',
  );
  const i = s.indexOf('float cpatchCoverage() {'),
    j = s.indexOf('\n}\n', i);
  const body = s
    .slice(i, j)
    .replace('float cpatchCoverage() {', 'float cpatchCoverage() {\n  cpArcCalls = 0;')
    .replace(/\bdiscard;/g, 'return float(cpArcCalls);')
    .replace('return LBCOV_OUT(cov);', 'return float(cpArcCalls);');
  return s.slice(0, i) + body + s.slice(j);
};
console.log(
  `${path.basename(asset)} at ${N} px${has('companion') ? ', companion on' : ''}${defines.length ? ', ' + defines.join(' ') : ''}: ` +
    `${qs.length} fragments, interior ${cls.interior.length} edge ${cls.edge.length} empty ${cls.empty.length}`,
);
for (const [name, text] of texts) {
  const out =
    name === 'base'
      ? base
      : E.buildGlslEmu(ROOT, { cpatch: true, glsl: text, defines }).run(
          new Float32Array(4),
          gl.plane,
          qs,
        );
  let nd = 0,
    md = 0;
  for (let k = 0; k < qs.length; k++) {
    const d = Math.abs(out[k] - base[k]);
    if (d > 0) nd++;
    if (d > md) md = d;
  }
  const timed = E.buildGlslEmu(ROOT, { cpatch: true, glsl: text, defines, timed: true });
  const ns = {};
  for (const [k, l] of Object.entries(pick)) {
    let best = Infinity;
    for (let r = 0; l.length && r < REPS; r++)
      best = Math.min(best, timed.run(new Float32Array(4), gl.plane, l).ns / l.length);
    ns[k] = l.length ? best : 0;
  }
  const total =
    ns.interior * cls.interior.length + ns.edge * cls.edge.length + ns.empty * cls.empty.length;
  let simd = '';
  if (has('simd')) {
    const cnt = E.buildGlslEmu(ROOT, { cpatch: true, glsl: counting(text), defines }).run(
      new Float32Array(4),
      gl.plane,
      qs,
    );
    const G = new Map();
    let lanes = 0;
    cnt.forEach((c, k) => {
      lanes += c;
      G.set(group[k], Math.max(G.get(group[k]) ?? 0, c));
    });
    let busy = 0,
      sim = 0;
    for (const mx of G.values()) {
      if (mx > 0) busy++;
      sim += 32 * mx;
    }
    simd = `  solves/frag ${(lanes / qs.length).toFixed(4)}, groups with one ${busy} of ${G.size}, SIMD solve-lanes/frag ${(sim / qs.length).toFixed(3)}`;
  }
  console.log(
    `  ${name.padEnd(5)} ns/frag interior ${ns.interior.toFixed(1)} edge ${ns.edge.toFixed(1)} empty ${ns.empty.toFixed(1)}` +
      `  total ${(total / 1e6).toFixed(1)} ms  differ ${nd} (max ${md.toExponential(2)})${simd}`,
  );
}
