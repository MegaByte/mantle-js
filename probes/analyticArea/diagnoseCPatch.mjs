// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
import importSvg from '../../src/svg/importer.js';
import * as CB from '../../src/renderer/cpatchBuild.js';
import { patchCoverage } from '../../src/renderer/cpatchCov.js';
import { buildGlslEmu, K_CPATCH_COV, K_CPATCH_CURVE, K_CPATCH_ARC } from '../../test/_glslEmu.mjs';
const root = new URL('../../', import.meta.url).pathname;
const emu = buildGlslEmu(root, { cpatch: true });
for (const file of process.argv.slice(2)) {
  const d = JSON.parse(readFileSync(file));
  for (const row of d.rows) {
    const c = d.config.cases.find((c) => c.name === row.name && c.size === row.size),
      actual = row.arms.find((a) => a.name === 'cpatch'),
      worst = actual.colorQuality?.worst || { x: c.pixel[0], y: c.pixel[1] };
    const [bx, by, bw, bh] = c.bbox,
      epp = Math.max(bw, bh) / row.size,
      pt = [
        bx + bw / 2 + (worst.x + 0.5 - row.size / 2) * epp,
        by + bh / 2 + (worst.y + 0.5 - row.size / 2) * epp,
      ];
    const b = CB.headlessCPatchBundle(await importSvg(c.svg, { preserveViewport: true })),
      ps = [];
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
    CB.buildCPatchBundle(gl, b, { pool: false, onPatches: (a) => ps.push(...a) });
    console.log(JSON.stringify({ name: c.name, size: c.size, pt, epp, worst, patches: ps.length }));
    globalThis.__CP_TRACE = true;
    ps.forEach((p, i) => {
      const bb = p.bbox;
      if (
        bb &&
        (pt[0] < bb[0] - epp || pt[0] > bb[2] + epp || pt[1] < bb[1] - epp || pt[1] > bb[3] + epp)
      )
        return;
      globalThis.__cpTrace = {};
      const cov = patchCoverage(p, ...pt, epp);
      console.log(
        JSON.stringify({
          patch: i,
          cov,
          trace: globalThis.__cpTrace,
          curves: p.curves.map((s) => ({ t: s.t, P: s.P, cut: s.cut })),
        }),
      );
    });
    if (actual.packed) {
      b._lbMeshes = actual.packed.meshes.map((m) => ({ verts: Float32Array.from(m.verts) }));
      gl.plane = Float32Array.from(actual.packed.plane);
      console.log('Using actual browser upload, not CPU rebuild');
    }
    const qs = [],
      ids = [];
    for (const m of b._lbMeshes || []) {
      if (!m?.verts) continue;
      const v = m.verts;
      for (let i = 0; i < v.length; i += 72) {
        const vs = [0, 1, 2].map((k) => v.subarray(i + k * 24, i + (k + 1) * 24)),
          q = vs.map((v) => [v[0] + v[17] + v[2] * 1.5 * epp, v[1] + v[18] + v[3] * 1.5 * epp]);
        const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
        const ar = cross(q[0], q[1], q[2]),
          sg = Math.sign(ar),
          ww = [cross(q[1], q[2], pt), cross(q[2], q[0], pt), cross(q[0], q[1], pt)].map(
            (x) => x * sg,
          );
        if (!ar || ww.some((x) => x < 0)) continue;
        const tc = [2, 3, 4].map((k) => ww.reduce((s, w, j) => s + w * vs[j][k], 0) / Math.abs(ar)),
          f = vs[2];
        qs.push({
          k: K_CPATCH_COV,
          GD: Array.from(f.slice(7, 11)),
          bb: Array.from(f.slice(11, 15)),
          c: [pt[0] - f[17], pt[1] - f[18]],
          ePx: [f[19], f[20]],
          ex: [...tc, f[15], f[16], epp],
        });
        ids.push(i / 72);
      }
    }
    const got = emu.run(new Float32Array(4), gl.plane, qs);
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i],
        out = [];
      for (let j = 0; j < q.ePx[1]; j++) {
        const rr = emu.run(
          new Float32Array(4),
          gl.plane,
          Array.from({ length: 9 }, (_, which) => ({
            k: K_CPATCH_CURVE,
            bb: [0, 0, 0, 0],
            ePx: [0, 0],
            GD: [which, q.ePx[0] + j, 0, 0],
            c: q.c,
            ex: [0, 0, 0, 0, 0, epp],
          })),
        );
        if (rr[0] < 1) {
          const base = (q.ePx[0] + j) * 28,
            g0 = Array.from(gl.plane.slice(base + 20, base + 24)),
            g1 = Array.from(gl.plane.slice(base + 24, base + 28));
          const arc3 = Math.floor(gl.plane[base + 3] / 32) % 2 !== 0;
          const arc = emu.run(
            new Float32Array(4),
            gl.plane,
            [0, 1].map((which) => ({
              k: K_CPATCH_ARC,
              GD: [arc3 ? 1 : 0, which, 0, 0],
              bb: g0,
              c: q.c,
              ePx: [0, 0],
              ex: g1,
            })),
          );
          out.push({ constraint: j, values: Array.from(rr), arc: Array.from(arc), g0, g1 });
        }
      }
      console.log(JSON.stringify({ triangle: ids[i], cov: got[i], query: q, constraints: out }));
    }
  }
}
