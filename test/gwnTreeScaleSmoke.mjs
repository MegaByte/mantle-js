// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gwnTreeScaleSmoke — the GWN run tree the encoder builds is the same tree, up to scale, at every size.
//
// The run tree's piece expansion (textures.js buildTexturesShape, the gwnTree block) may carry no absolute tolerance:
// chords and tangents under 1e-12, a solve determinant under 1e-18, deviation bounds and pads padded by +1e-12, a chord
// under 1e-10 (cl2 1e-20), contour joins at 1e-9 (EPSJ), an ink probe's ray nudged by 1e-7 (the per-piece probe's
// offset is relative), a forest junction test at 1e-9 * (w + h + 1), and -- through lbCubicMath -- inflections at 1e-12
// and loops at 1e-9 on lengths squared would each change a tree's STRUCTURE with scale (piece counts, cut order, a
// contour's ink side); at 2^-40 a unit cubic loses its inflection split, a loop its loop, contours join and holes flip.
//
// Shapes: a serpentine cubic, a self-intersecting loop cubic, a quad blob, a rotated ellipse, an even-odd ring, two
// separate squares in one path, and a contour whose ink probe sits 0.05 below another contour (the nudge case):
//   (a) imported inside scale(2^-40), scale(2^-20) and scale(2^20), every tree's structure -- node and ref counts,
//       node codes, piece types and ink sides, the cut, the grid windings -- is scale 1's, and every coordinate is
//       scale 1's times the scale exactly (unit vectors to 1e-12);
//   (b) through the float32 emulation of the shader, GWN winding-only and GWN + SDF read every pixel center at those
//       sizes as at 1;
//   (c) mutations, each restoring one absolute tolerance in a copy of src/ and caught by (a).
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, cpSync, rmSync, mkdtempSync } from 'fs';
import { hasCxx, buildGlslEmu, fillShapes, K_GWN, GWN_SDF, GWN_WIND } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const BODY = `<path d="M20.3 20.1 C 100.4 20.2 30.6 100.7 110.2 99.4 L 110.2 110.3 L 20.3 110.3 Z"/>
  <path d="M130.1 20.2 C 230.6 120.4 110.2 120.8 210.3 20.6 Z"/>
  <path d="M230.2 90.4 Q 270.7 -5.3 310.1 90.8 Q 270.3 60.2 230.2 90.4 Z"/>
  <path d="M330.3 60.2 A 55.3 27.1 25 1 0 410.1 60.4 A 55.3 27.1 25 1 0 330.3 60.2 Z"/>
  <path fill-rule="evenodd" d="M70.4 180.2 m -50.3 0 a 50.3 50.3 0 1 0 100.6 0 a 50.3 50.3 0 1 0 -100.6 0 Z M70.4 180.2 m -20.1 0 a 20.1 20.1 0 1 0 40.2 0 a 20.1 20.1 0 1 0 -40.2 0 Z"/>
  <path d="M150.2 140.1 H 190.3 V 180.4 H 150.2 Z M200.1 190.2 H 240.4 V 230.3 H 200.1 Z"/>
  <path d="M260.2 180 L 300.2 180 L 280.2 140 Z M270.2 180.05 H 290.2 V 220.1 H 270.2 Z"/>`;
const svgAt = (S) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${420 * S} ${240 * S}"><g transform="scale(${S})">${BODY}</g></svg>`;
const LOGS = [-40, -20, 20];

function decode(band, curve, sh) {
  const g = sh.GD[1] * 4096 + sh.GD[0],
    bandsX = sh.GD[2] + 1,
    bandsY = sh.GD[3] + 1;
  const T = (off) => [0, 1, 2, 3].map((k) => band[(g + off) * 4 + k]);
  const hdr = T((bandsY + bandsX) * 2);
  const nodeBase = hdr[0] | 0,
    nodeCount = Math.abs(hdr[1]) | 0,
    refBase = hdr[2] | 0,
    refCount = hdr[3] | 0;
  const o = {
    ints: [Math.sign(hdr[1]), nodeCount, refCount],
    lab: ['orientation', 'node count', 'ref count'],
    coords: [],
    inv: [],
    unit: [],
    axis: [],
  };
  const I = (v, l) => {
    o.ints.push(v);
    o.lab.push(l);
  };
  for (let i = 0; i < nodeCount; i++) {
    const A = T(nodeBase + i * 2),
      B = T(nodeBase + i * 2 + 1);
    I(B[3], `node ${i} code`);
    o.coords.push(...A, B[0], B[1], B[2]);
  }
  const locs = [];
  for (let i = 0; i < refCount; i++) {
    const R = T(refBase + i);
    I(R[2], `ref ${i} type`);
    I(R[3], `ref ${i} ink side`);
    locs.push([(R[1] | 0) * 4096 + (R[0] | 0), ((R[2] + 0.5) | 0) % 16]);
  }
  const ext = T(refBase + refCount);
  I(ext[1], 'tier-2 band count');
  I(ext[3], 'grid size');
  const rbBase = ext[0] | 0,
    GB = ext[1] | 0,
    gridBase = ext[2] | 0,
    gwh = ext[3] | 0;
  for (let b = 0; b < GB; b++) {
    const h = T(rbBase + (b >> 1)),
      base = h[(b & 1) * 2] | 0,
      cnt = h[(b & 1) * 2 + 1] | 0;
    I(cnt, `cut band ${b} count`);
    for (let e = 0; e < cnt; e++) {
      const E = T(base + e);
      I(E[0], `cut ${b}.${e}`);
      o.coords.push(E[1], E[2], E[3]);
    }
  }
  if (gridBase > 0)
    for (let ci = 0; ci < (gwh >> 8) * (gwh & 255); ci++) {
      const c = T(gridBase + (ci >> 1));
      I(c[(ci & 1) * 2], `grid cell ${ci} winding`);
      o.coords.push(c[(ci & 1) * 2 + 1]);
    }
  for (const [loc, ty] of locs) {
    const C = (k) => [0, 1, 2, 3].map((j) => curve[(loc + k) * 4 + j]);
    if (ty === 0) o.coords.push(...C(1));
    else if (ty === 1) o.coords.push(...C(1), ...C(2).slice(0, 2));
    else if (ty === 6) o.coords.push(...C(0), ...C(1));
    else if (ty === 4) {
      const k = C(1),
        l = C(2),
        m = C(3);
      o.coords.push(...C(0), m[3]);
      o.inv.push(k[0], k[1], l[0], l[1], m[0], m[1]);
      o.unit.push(k[2], l[2], m[2], l[3], ...C(4));
      I(k[3], 'cubic piece lune');
      if (k[3] === 0) o.coords.push(...C(5));
    } else if (ty === 5) {
      // (cos phi, sin phi) is the ellipse's axis, whose SIGN is the importer's choice (phi and phi + pi are one ellipse,
      // and the transform's eigen-solve picks either): compared as an axis, not as a vector
      const r = C(2);
      o.coords.push(...C(0), ...C(1), r[3]);
      o.axis.push([r[0], r[1]]);
      o.unit.push(...C(3));
      I(r[2], 'arc piece lune');
    }
  }
  return o;
}
async function trees(importSvg, S) {
  const b = await importSvg(svgAt(S), { preserveViewport: true, gwnTree: true });
  const shapes = fillShapes(b, parseMetaBin, M),
    band = new Float32Array(b.bands),
    curve = new Float32Array(b.curves);
  return { b, shapes, band, curve, trees: shapes.map((sh) => decode(band, curve, sh)) };
}
// the first way tree B (imported at S) is not tree A up to scale, or null
function differs(A, B, S) {
  if (A.trees.length !== B.trees.length)
    return `shape count ${A.trees.length} vs ${B.trees.length}`;
  for (let i = 0; i < A.trees.length; i++) {
    const a = A.trees[i],
      b = B.trees[i];
    const j = a.ints.findIndex((v, k) => v !== b.ints[k]);
    if (a.ints.length !== b.ints.length || j >= 0)
      return `shape ${i}: ${a.lab[j] ?? 'length'} ${a.ints[j]} vs ${b.ints[j]}`;
    if (a.coords.length !== b.coords.length) return `shape ${i}: coordinate count`;
    const c = a.coords.findIndex((v, k) => Math.fround(v * S) !== b.coords[k]);
    if (c >= 0) return `shape ${i}: coordinate ${c} ${a.coords[c]} * S != ${b.coords[c]}`;
    const n = a.inv.findIndex((v, k) => Math.fround(v / S) !== b.inv[k]);
    if (n >= 0) return `shape ${i}: implicit row ${n}`;
    const u = a.unit.findIndex((v, k) => !(Math.abs(v - b.unit[k]) <= 1e-12));
    if (u >= 0) return `shape ${i}: unit component ${u} ${a.unit[u]} vs ${b.unit[u]}`;
    // float32 (cos, sin) pairs: parallel to a float32 rounding
    const x = a.axis.findIndex(
      (v, k) => !(Math.abs(Math.abs(v[0] * b.axis[k][0] + v[1] * b.axis[k][1]) - 1) <= 1e-6),
    );
    if (x >= 0) return `shape ${i}: arc axis ${x} (${a.axis[x]} vs ${b.axis[x]})`;
  }
  return null;
}
async function check(importSvg) {
  const base = await trees(importSvg, 1),
    out = {};
  for (const lg of LOGS)
    out[lg] = differs(base, await trees(importSvg, Math.pow(2, lg)), Math.pow(2, lg));
  return { base, out };
}
// ---- (a) --------------------------------------------------------------------------------------------------------------
const { default: importSvg } = await import('../src/svg/importer.js');
const cur = await check(importSvg);
{
  const t = cur.base;
  ok(
    t.shapes.length === 7 && t.shapes.every((s) => s.tree),
    `seven tree shapes at scale 1 (${t.shapes.length})`,
  );
  const types = new Set(
    t.trees.flatMap((o) => o.ints.filter((_, k) => /type$/.test(o.lab[k])).map((v) => v % 16)),
  );
  ok(
    [0, 1, 4, 5, 6].every((ty) => types.has(ty)),
    `piece types reached: ${[...types].sort().join(', ')} (need 0, 1, 4, 5, 6)`,
  );
  for (const lg of LOGS)
    ok(
      cur.out[lg] === null,
      `(a) at 2^${lg} every tree is scale 1's, up to scale${cur.out[lg] ? ` (first difference: ${cur.out[lg]})` : ''}`,
    );
}
// ---- (b) --------------------------------------------------------------------------------------------------------------
if (!hasCxx()) console.log('  SKIP (b): no C++ compiler ($CXX, clang++, g++, c++)');
else {
  const res = [];
  for (const defines of [GWN_WIND, GWN_SDF]) {
    const emu = buildGlslEmu(ROOT, { defines });
    const t = cur.base,
      q = [];
    for (const sh of t.shapes)
      for (let y = Math.floor(sh.bb[1]) - 1; y <= Math.ceil(sh.bb[3]) + 1; y++)
        for (let x = Math.floor(sh.bb[0]) - 1; x <= Math.ceil(sh.bb[2]) + 1; x++)
          q.push([t.shapes.indexOf(sh), x + 0.5, y + 0.5]);
    const run = (T, S) =>
      emu.run(
        T.band,
        T.curve,
        q.map(([i, x, y]) => ({
          k: K_GWN,
          GD: T.shapes[i].GD,
          bb: T.shapes[i].bb,
          eo: T.shapes[i].eo,
          c: [Math.fround(x * S), Math.fround(y * S)],
          ePx: [S, S],
        })),
      );
    const base = run(t, 1),
      row = [];
    for (const lg of LOGS) {
      const S = Math.pow(2, lg),
        r = run(await trees(importSvg, S), S);
      row.push(r.reduce((n, v, i) => n + (v !== base[i] ? 1 : 0), 0));
    }
    res.push(row);
    if (defines === GWN_WIND) ok(q.length > 20000, `(b) not vacuous: ${q.length} pixel centers`);
  }
  ok(
    res.flat().every((n) => n === 0),
    `(b) GWN reads every pixel center as at 1 at 2^${LOGS.join(', 2^')} (differing: winding ${res[0].join('/')}, SDF ${res[1].join('/')})`,
  );
}
// ---- (c) --------------------------------------------------------------------------------------------------------------
{
  const MUTS = [
    // lbCubicMath's default path is relative too, so dropping `rel` does not bring the absolute tests
    // back: these put them back in lbCubicMath itself.
    [
      'inflections judged against an absolute 1e-12',
      'src/geom/lbCubicMath.js',
      'const m = rel ? Math.abs(a) + Math.abs(b) + Math.abs(c) : Math.max(Math.abs(a), Math.abs(b), Math.abs(c));',
      'const m = 1;',
    ],
    [
      'loops judged against an absolute 1e-9',
      'src/geom/lbCubicMath.js',
      'if (!(Math.abs(denom) > (rel ? 1e-9 : 1e-12) * Math.hypot(c3[0], c3[1]) * Math.hypot(c2[0], c2[1]))) return null;',
      'if (Math.abs(denom) < 1e-9) return null;',
    ],
    [
      "the implicit rows' determinant under an absolute 1e-18",
      'src/svg/textures.js',
      'if (!(Math.abs(det) > 1e-6 * best)) return null;',
      'if (Math.abs(det) < 1e-18) return null;',
    ],
    [
      "a cubic piece's deviation bound padded by an absolute 1e-12",
      'src/svg/textures.js',
      '* 1.0001 + 1e-12 * cl;',
      '* 1.0001 + 1e-12;',
    ],
    // (the per-contour ink rule's two hinges -- its runs joined at 1e-9, its probe nudged by 1e-7 -- went with it)
    [
      'the per-piece ink probe offset by an absolute 1e-7',
      'src/svg/textures.js',
      'const d = 2 ** -17, nx = -dy * d, ny = dx * d;',
      'const d = 1e-7 / (2 * L), nx = -dy * d, ny = dx * d;',
    ],
    [
      'the per-piece "no direction" test against an absolute 1e-9',
      'src/svg/textures.js',
      'if (!(L > 2 ** -26 * Math.max(Math.abs(x), Math.abs(y)))) return null;',
      'if (!(L > 1e-9)) return null;',
    ],
    [
      "the forest's contours split at 1e-9 * (w + h + 1)",
      'src/svg/textures.js',
      'if (!pointsMeet(pieces[k - 1].e, pieces[k].s, pieces[k - 1].mag, pieces[k].mag)) {',
      'if (Math.max(Math.abs(pieces[k - 1].e[0] - pieces[k].s[0]), Math.abs(pieces[k - 1].e[1] - pieces[k].s[1])) > 1e-9 * (Math.abs(bbX1 - bbX0) + Math.abs(bbY1 - bbY0) + 1)) {',
    ],
  ];
  for (const [name, file, from, to] of MUTS) {
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    if (!text.includes(from)) {
      ok(false, `(c) mutation hinge present: ${name}`);
      continue;
    }
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'gwnTreeScale-'));
    try {
      cpSync(path.join(ROOT, 'src'), path.join(tmp, 'src'), { recursive: true });
      writeFileSync(path.join(tmp, file), text.split(from).join(to));
      const mut = (await import(path.join(tmp, 'src/svg/importer.js'))).default;
      const r = await check(mut);
      const caught = LOGS.filter((lg) => r.out[lg] !== null);
      ok(
        caught.length > 0,
        `(c) mutation "${name}" is caught${caught.length ? ` at 2^${caught.join(', 2^')} (${r.out[caught[0]]})` : ''}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

if (fail) {
  console.error(`GWN-TREE-SCALE FAIL (${fail})`);
  process.exit(1);
}
console.log('GWN-TREE-SCALE PASS');
