// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Development diagnostic: translated GLSL cubic splits compared with the CPU implementation.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const SHIPPED = await import('../src/hitTest/bandWinding.js');

// ---- (a) the shader's split block ---------------------------------------------------------
function glslSplits() {
  const gl = readFileSync(path.join(ROOT, 'src/shaders/_coverage.glsl'), 'utf8');
  const fn = gl.indexOf('void solveCubicBisect(');
  const from = gl.indexOf('  float qa = 3.0 * cy.x;', fn),
    to = gl.indexOf('  float yEnd0 = vert', fn);
  if (fn < 0 || from < 0 || to < 0) return null;
  const body = gl
    .slice(from, to)
    .replace(/\/\/[^\n]*/g, '')
    .replace(/float qa = 3\.0 \* cy\.x;\s*float qb = 2\.0 \* cy\.y;\s*float qc = cy\.z;/, '')
    .replace(/\bfloat /g, 'let ');
  return Function(
    'abs',
    'max',
    'sqrt',
    `return (qa, qb, qc) => { ${body}; return [split1, split2]; };`,
  )(Math.abs, Math.max, Math.sqrt);
}
{
  const gl = glslSplits();
  ok(!!gl, '(a) the shader split block transliterates');
  let seed = 0x5b17,
    n = 0,
    d = 0;
  const rnd = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const mag = () => (rnd() < 0.5 ? -1 : 1) * Math.pow(10, -30 + 60 * rnd());
  const has = typeof SHIPPED.cubicSplits === 'function';
  if (gl && has)
    for (let i = 0; i < 300000; i++) {
      const S = Math.pow(10, -30 + 60 * rnd());
      let qa = mag(),
        qb = mag(),
        qc = mag();
      const kind = i % 6;
      if (kind === 1) {
        qa = (rnd() - 0.5) * S;
        qb = (rnd() - 0.5) * S;
        qc = (rnd() - 0.5) * S;
      } // one magnitude
      if (kind === 2) qa = qb * (rnd() - 0.5) * 2e-6; // near the degeneracy line
      if (kind === 3) {
        qa = 0;
      }
      if (kind === 4) {
        qb = 0;
        if (rnd() < 0.5) qc = 0;
      }
      if (kind === 5) {
        qc = ((qb * qb) / (4 * qa)) * (1 + (rnd() - 0.5) * 1e-12);
      } // disc near 0
      const a = gl(qa, qb, qc),
        b = SHIPPED.cubicSplits(qa, qb, qc);
      n++;
      if (!(Object.is(a[0], b[0]) || a[0] === b[0]) || !(Object.is(a[1], b[1]) || a[1] === b[1]))
        d++;
    }
  ok(
    gl && has && d === 0,
    `(a) cubicSplits returns the shader's splits bit for bit (${has ? `${d} of ${n} differ` : 'not exported'})`,
  );
}

if (fail) process.exit(1);
console.log('BANDWINDING-CUBIC-SHADER PASS');
