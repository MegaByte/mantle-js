// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Shared tiger loader: SVG path data -> converter-shaped contours -> graph front-end cycles.
import { readFileSync } from 'fs';
import { parsePathD } from '../src/svg/path.js';
import { pathToCycles } from '../src/geom/cpatchGraph.js';

export function tigerCycles(file = new URL('../examples/tiger.svg', import.meta.url)) {
  const txt = readFileSync(file, 'utf8');
  const paths = [];
  for (const m of txt.matchAll(/\sd\s*=\s*"([^"]+)"/g)) {
    let segs;
    try {
      segs = parsePathD(m[1]);
    } catch {
      continue;
    }
    const cs = [];
    let cur = null;
    const flush = () => {
      if (cur && cur.length >= 2) cs.push(cur);
      cur = null;
    };
    for (const s of segs) {
      if (s.subStart) flush();
      if (!cur) cur = [];
      const pts = [s.p1, s.p2, s.p3, s.p4].filter(Boolean);
      const a = pts[0],
        b = pts[pts.length - 1];
      // A closing segment of zero length is not geometry; kept, it defeats packing.
      if (s.type === 0 && a && b && Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9)
        continue;
      if (s.type === 0 && s.p2) cur.push({ t: 'line', P: [s.p1, s.p2] });
      else if (s.type === 1 && s.p3) cur.push({ t: 'quad', P: [s.p1, s.p2, s.p3] });
      else if (s.type === 2 && s.p4) cur.push({ t: 'cubic', P: [s.p1, s.p2, s.p3, s.p4] });
    }
    flush();
    if (cs.length) paths.push(cs);
  }
  const cycles = [];
  let fell = 0;
  for (const cs of paths) {
    let cy = null;
    try {
      cy = pathToCycles(cs, false);
    } catch {
      /* falls back below */
    }
    if (cy && cy.length) for (const c of cy) cycles.push(c);
    else {
      fell++;
      for (const c of cs) cycles.push(c);
    }
  }
  return { cycles, fell, paths };
}
