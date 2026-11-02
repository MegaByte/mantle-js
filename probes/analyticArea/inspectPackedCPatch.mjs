// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Trace the package kernel against actual GPU texture readback, not a rebuilt
// static pack. A morph's CPU shadow contains a sampled endpoint, not its pose.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildGlslEmu, K_CPATCH_COV, K_CPATCH_CURVE } from '../../test/_glslEmu.mjs';
const [input, output] = process.argv.slice(2),
  d = JSON.parse(readFileSync(input)),
  root = new URL('../../', import.meta.url).pathname;
const traces = [];
for (const contract of [false, true]) {
  const emu = buildGlslEmu(root, { cpatch: true, contract });
  for (const row of d.rows) {
    const c = d.config.cases.find((c) => c.name === row.name),
      [bx, by, bw, bh] = c.bbox,
      epp = Math.max(bw, bh) / c.size;
    for (const arm of row.arms.filter((a) => a.packed))
      for (const [x, y] of c.referencePixels || [c.pixel]) {
        const pt = [
            bx + bw / 2 + (x + 0.5 - c.size / 2) * epp,
            by + bh / 2 + (y + 0.5 - c.size / 2) * epp,
          ],
          plane = Float32Array.from(arm.packed.plane),
          hits = [];
        for (let shape = 0; shape < arm.packed.meshes.length; shape++) {
          const v = arm.packed.meshes[shape].verts;
          for (let at = 0; at < v.length; at += 72) {
            const vs = [0, 1, 2].map((k) => v.slice(at + k * 24, at + (k + 1) * 24)),
              f = vs[2];
            const P = vs.map((v) => [
              v[0] + v[17] + v[2] * 1.5 * epp,
              v[1] + v[18] + v[3] * 1.5 * epp,
            ]);
            const cross = (a, b, p) =>
              (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
            const ar = cross(P[0], P[1], P[2]),
              sg = Math.sign(ar),
              w = [cross(P[1], P[2], pt), cross(P[2], P[0], pt), cross(P[0], P[1], pt)].map(
                (z) => z * sg,
              );
            if (!ar || w.some((z) => z < 0)) continue;
            const tc = [2, 3, 4].map(
                (k) => w.reduce((s, z, j) => s + z * vs[j][k], 0) / Math.abs(ar),
              ),
              local = pt.map((z, k) => z - f[17 + k]);
            const query = {
              k: K_CPATCH_COV,
              GD: f.slice(7, 11),
              bb: f.slice(11, 15),
              c: local,
              ePx: f.slice(19, 21),
              ex: [...tc, f[15], f[16], epp],
            };
            const cov = emu.run(new Float32Array(4), plane, [query])[0],
              constraints = [];
            for (let j = 0; j < f[20]; j++) {
              const idx = f[19] + j,
                base = idx * 28,
                values = Array.from(
                  emu.run(
                    new Float32Array(4),
                    plane,
                    Array.from({ length: 9 }, (_, which) => ({
                      k: K_CPATCH_CURVE,
                      GD: [which, idx, 0, 0],
                      bb: [0, 0, 0, 0],
                      ePx: [0, 0],
                      c: local,
                      ex: [0, 0, 0, 0, 0, epp],
                    })),
                  ),
                );
              constraints.push({
                idx,
                kind: plane[base + 3],
                values,
                rows: Array.from(plane.slice(base, base + 28)),
              });
            }
            hits.push({ shape, triangle: at / 72, cov, query, constraints });
          }
        }
        const trace = { arm: arm.name, contract, x, y, pt, epp, hits };
        traces.push(trace);
        console.log(
          JSON.stringify({
            ...trace,
            hits: hits.map((h) => ({
              ...h,
              constraints: h.constraints.map(({ rows, ...s }) => s),
            })),
          }),
        );
      }
  }
}
if (output) writeFileSync(output, JSON.stringify({ input, traces }, null, 2) + '\n');
