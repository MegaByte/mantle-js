// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { ellipseFromRQuad } from './area.mjs';

export function pathData(cs) {
  return cs
    .map(
      (c) =>
        'M' +
        c[0].P[0].join(' ') +
        c
          .map((s) => {
            if (s.t === 'line') return 'L' + s.P[1].join(' ');
            if (s.t === 'quad' || (s.t === 'rquad' && s.w === 1))
              return 'Q' + s.P.slice(1).flat().join(' ');
            if (s.t === 'cubic') return 'C' + s.P.slice(1).flat().join(' ');
            const e = ellipseFromRQuad(s),
              [u, v] = [e.u, e.v];
            const a = u[0] * u[0] + v[0] * v[0],
              b = u[0] * u[1] + v[0] * v[1],
              d = u[1] * u[1] + v[1] * v[1];
            const phi = Math.atan2(2 * b, a - d) / 2,
              disc = Math.hypot(a - d, 2 * b),
              rx = Math.sqrt((a + d + disc) / 2);
            // determinant form avoids subtracting similar eigenvalues for thin ellipses.
            const det = u[0] * v[1] - u[1] * v[0],
              ry = Math.abs(det) / rx;
            return `A${rx} ${ry} ${(phi * 180) / Math.PI} 0 ${det > 0 ? 1 : 0} ${s.P[2].join(' ')}`;
          })
          .join('') +
        'Z',
    )
    .join(' ');
}
