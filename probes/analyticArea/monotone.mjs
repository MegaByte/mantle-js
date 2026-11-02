// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Experimental preparation for axis-aligned area draws. Native arcs retain the
// existing AAC arc path; polynomial pieces split at both coordinate extrema.
import { roots01 } from './area.mjs';
import { segSlice } from '../../src/geom/cpatchImplicit.js';
export function splitMonotone(cycles) {
  return cycles.map((c) =>
    c.flatMap((s) => {
      if (s.t !== 'quad' && s.t !== 'cubic') return [s];
      const cuts = [0, 1];
      for (let k = 0; k < 2; k++) {
        const d = s.P.slice(1).map((p, i) => p[k] - s.P[i][k]);
        const coeff =
          d.length === 2 ? [d[0], d[1] - d[0]] : [d[0], 2 * (d[1] - d[0]), d[0] - 2 * d[1] + d[2]];
        cuts.push(...roots01(coeff));
      }
      cuts.sort((a, b) => a - b);
      return cuts
        .slice(1)
        .flatMap((b, i) => (b - cuts[i] > 1e-12 ? [segSlice(s, cuts[i], b)] : []));
    }),
  );
}
