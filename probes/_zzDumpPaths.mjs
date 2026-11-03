// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Dump each path's SOURCE subpaths together with the cycles JS's arrangement makes of them, so
// the C# front end can be handed the identical input. Without this the two are compared on
// different geometry -- the C# importer yields a shape per fill AND per stroke -- and a
// front-end difference is indistinguishable from an importer one.
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parsePathD } from '../src/svg/path.js';
import { pathToCycles } from '../src/geom/cpatchGraph.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = process.argv[2] || 'examples/tiger.svg';
const out = process.argv[3] || '/tmp/paths.json';
const txt = readFileSync(path.resolve(ROOT, rel), 'utf8');

const recs = [];
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
    if (s.type === 0 && a && b && Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9)
      continue;
    if (s.type === 0 && s.p2) cur.push({ t: 'line', P: [s.p1, s.p2] });
    else if (s.type === 1 && s.p3) cur.push({ t: 'quad', P: [s.p1, s.p2, s.p3] });
    else if (s.type === 2 && s.p4) cur.push({ t: 'cubic', P: [s.p1, s.p2, s.p3, s.p4] });
  }
  flush();
  if (!cs.length) continue;
  let cy = null;
  try {
    cy = pathToCycles(cs, false);
  } catch {
    cy = null;
  }
  recs.push({
    subpaths: cs.map((c) => c.map((s) => ({ t: s.t, P: s.P }))),
    cycles: (cy || []).map((c) => c.map((s) => ({ t: s.t, P: s.P, cut: !!s.cut }))),
  });
}
writeFileSync(out, JSON.stringify(recs));
console.log(
  `wrote ${recs.length} paths, ${recs.reduce((a, r) => a + r.subpaths.length, 0)} subpaths, ` +
    `${recs.reduce((a, r) => a + r.cycles.length, 0)} cycles to ${out}`,
);
