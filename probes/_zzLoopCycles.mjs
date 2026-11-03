// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
import { pathToCycles, flattenGraph, extractCycles, scoreFill } from '../src/geom/cpatchGraph.js';
const J = JSON.parse(readFileSync(process.env.IN, 'utf8'));
const base = J.a.map((sg) => ({
  t: sg.t,
  P: sg.P.map((p) => [p[0] / J.Sa, p[1] / J.Sa]),
  ...(sg.cut ? { cut: true } : {}),
}));
const sc = (S) =>
  base.map((sg) => ({
    t: sg.t,
    P: sg.P.map((p) => [p[0] * S, p[1] * S]),
    ...(sg.cut ? { cut: true } : {}),
  }));
for (const k of (process.env.KS || '1,2').split(',').map(Number)) {
  const L = sc(2 ** k);
  const g = flattenGraph([L]);
  const cy = pathToCycles([L], false);
  console.log(
    `2^${k}: graph edges=${g.edges.length} nodes=${g.nodes.length}  cycles=${cy ? cy.map((c) => c.length).join(',') : 'null'}`,
  );
}
