// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbAluPerFrag -- the Loop-Blinn fill's FLOAT OPERATIONS PER FRAGMENT, counted on the shader text as it runs.
//
// No GPU. The whole unified fill draw runs through test/_lbPipeEmu.mjs in its ALU-counting mode: every float of the
// generated fragment text counts the operations it takes part in, so a fragment's count is the arithmetic its own branch
// executed, not an estimate from the source. Two tallies (see _lbPipeEmu's ALU COUNTING): `alu`, the full-rate
// operations, and `T`, the ones a GPU sends to its transcendental unit (sqrt, a division's reciprocal, trig, exp/log).
// `eq` = alu + 4 T weighs a transcendental at the quarter rate most GPUs issue them.
//
// A GPU's time is not this count: register pressure (an array spilled to memory), divergence and fill rate are not in
// it. It says where the arithmetic is, so a change's per-fragment cost can be read before a GPU times it.
//
//   node probes/lbAccuracy/_lbAluPerFrag.mjs [file.svg] [N=512]
//   DEFINES=MANTLE_LB_NO_CUBIC_CHAIN (extra variant defines, comma separated)
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { lbScene, renderScene } = await import(path.join(ROOT, 'test/_lbPipeScene.mjs'));
const FILE = process.argv[2] || path.join(ROOT, 'examples/tiger.svg');
const N = +(process.argv[3] || 512);
const DEFINES = (process.env.DEFINES || '').split(',').filter(Boolean);

const t0 = Date.now();
const sc = await lbScene(readFileSync(FILE, 'utf8'), { N });
const vt = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.vert.glsl'), 'utf8');
const ft = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const r = renderScene(sc, vt, ft, DEFINES, { alu: true });
const out = (name) => {
  const i = r.vert.io.outs.findIndex((o) => o.name === name);
  return i < 0 ? -1 : r.vert.outOff[i];
};
const oK = out('vKind'),
  oS = out('vSeam'),
  oT = out('vTC');
const KN = { 0: 'INTERIOR', 2: 'CUBIC', 4: 'CUBIC_BEZ', 10: 'EDGE_STRIP', 12: 'CURVE_BAND' };

// The provoking vertex names the branch a fragment takes: its kind, and for an interior face the chain it carries (vTC.x:
// 2 straight, 3 conic, 4 / 5 a cubic and a line; vSeam 1: chain 2 is a cubic), for a Bezout face its ring (vSeam 9 the
// resultant's, 10 the arc's).
function branchOf(t) {
  const b = (t * 3 + 2) * r.vert.outN,
    k = Math.round(r.vOut[b + oK]),
    seam = r.vOut[b + oS],
    mode = r.vOut[b + oT];
  let name = KN[k] || `kind ${k}`;
  if (k === 0) name += mode > 3.5 ? ':cubicChain' : ':straight';
  if (k === 0 && seam > 0.5) name += '+cubic2';
  if (k === 4) name += seam > 9.5 ? ':arcRing' : seam > 8.5 ? ':resRing' : ':hull';
  return name;
}
const rows = new Map(),
  all = { n: 0, alu: 0, T: 0, disc: 0 };
const recs = r.recs;
for (let q = 0; q < recs.length / 9; q++) {
  const t = recs[q * 9] | 0,
    e = sc.entries[sc.entryOfTri[t]];
  if (!e || e.kind !== 'lb') continue;
  const f = recs[q * 9 + 8],
    alu = f % 65536,
    T = Math.floor(f / 65536),
    name = branchOf(t);
  const row = rows.get(name) || rows.set(name, { n: 0, alu: 0, T: 0, disc: 0, max: 0 }).get(name);
  row.n++;
  row.alu += alu;
  row.T += T;
  row.max = Math.max(row.max, alu + 4 * T);
  if (recs[q * 9 + 7] === 1) row.disc++;
  all.n++;
  all.alu += alu;
  all.T += T;
}
console.log(
  `${path.basename(FILE)} @ ${N} px, ${DEFINES.length ? DEFINES.join(' ') : 'default variant'}: ${all.n} LB fill fragments (${((Date.now() - t0) / 1000).toFixed(0)} s)`,
);
console.log(
  '  branch                        frags   share   alu/frag    T/frag   eq/frag   max eq   share of eq',
);
const eqAll = all.alu + 4 * all.T;
for (const [name, x] of [...rows].sort((a, b) => b[1].alu + 4 * b[1].T - (a[1].alu + 4 * a[1].T))) {
  const eq = x.alu + 4 * x.T;
  console.log(
    `  ${name.padEnd(28)} ${String(x.n).padStart(7)} ${((100 * x.n) / all.n).toFixed(1).padStart(6)}% ${(x.alu / x.n).toFixed(1).padStart(10)} ${(x.T / x.n).toFixed(2).padStart(9)} ${(eq / x.n).toFixed(1).padStart(9)} ${String(x.max).padStart(8)} ${((100 * eq) / eqAll).toFixed(1).padStart(10)}%`,
  );
}
console.log(
  `  ${'ALL LB'.padEnd(28)} ${String(all.n).padStart(7)} ${'100.0'.padStart(6)}% ${(all.alu / all.n).toFixed(1).padStart(10)} ${(all.T / all.n).toFixed(2).padStart(9)} ${(eqAll / all.n).toFixed(1).padStart(9)}`,
);
