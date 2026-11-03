// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _straightChain — should a PURE-STRAIGHT outline take the analytic chain route?
//
// THE DEFECT WITHOUT IT. An interior face that touches the outline but carries no line row falls to
// `lbCoverage`'s `else return 1.0` — a flat solid over a pixel the path only partly covers. On a
// 500-gon at 512 px that is 1008 of 2032 edge pixels at 44.83/255, ALL over-paint and 99.9% of the
// asset's antialiasing error, while EDGE_STRIP on the same drawing scores 0.04/255.
//
// WHY THE ROW IS MISSING, measured rather than guessed: 3442 of the 5852 faces within a pixel of
// the outline carry no row, the side test passes on every one of them, and what fails is the SPAN
// — `lineFits` needs all three vertices inside ONE edge's own extent. At 500 sides an edge is
// 3.2 px and the faces span two to four of them: the median face needs 0.50 edge lengths of slack
// and the worst 3.97. A half-plane cannot describe a boundary that turns four times across one
// face, so no relaxation of the span test is the answer — the chain can, and `chainBoxCov` is
// exact for exactly this (probes/_polyClip.mjs, 0.5/255 against a 256x supersample).
//
// THE TRADE. Gating the chain route on `hulls.length || cubicRecs.length` excludes a pure-straight
// shape, which suits HUD rects and E/H/L/T, where one face sits inside one edge's span and the line
// row is better, but not the many-short-edges case above; such a gate cannot tell the two apart.
// This prices both regimes. Every straight outline takes the chain route.
//
// TWO ARMS per shape, each scored against the PATH's own exact coverage (_lbAaRef.mjs):
//   earcut      a single straight contour through buildLoopBlinnMesh
//   cdt-chain   the partition's analytic chain
//
//   node probes/lbAccuracy/_straightChain.mjs [file.svg ...]   CANVAS=512 SLICES=64
import path from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import os from 'os';
import { loadSvg, shapesOf, viewOf, buildMesh, rasterMesh, ROOT } from './_lbRaster.mjs';
import { refKit, exactCov } from './_lbAaRef.mjs';
import { decodeVert, LBK } from './_lbKernel.mjs';

console.warn = () => {};
const LB = await import('../../src/renderer/loopBlinn.js');
const CANVAS = +(process.env.CANVAS || 512);
const SLICES = +(process.env.SLICES || 64);

// ── the two regimes, as synthetic assets ──────────────────────────────────────────────────────
const S = 100;
const wrap = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">` +
  `<path d="${d}" fill="#000"/></svg>`;
const ngon = (n) => {
  let d = '';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    d +=
      (i ? 'L ' : 'M ') +
      (S / 2 + S * 0.45 * Math.cos(a)).toFixed(6) +
      ' ' +
      (S / 2 + S * 0.45 * Math.sin(a)).toFixed(6) +
      ' ';
  }
  return d + 'Z';
};
const star = (n, rIn) => {
  let d = '';
  for (let i = 0; i < 2 * n; i++) {
    const a = (i / (2 * n)) * Math.PI * 2 - Math.PI / 2,
      r = S * (i % 2 ? rIn : 0.45);
    d +=
      (i ? 'L ' : 'M ') +
      (S / 2 + r * Math.cos(a)).toFixed(6) +
      ' ' +
      (S / 2 + r * Math.sin(a)).toFixed(6) +
      ' ';
  }
  return d + 'Z';
};
const SYNTH = {
  // THE CASE A STRAIGHT-SHAPE EXCLUSION SUITS: axis-aligned edges hundreds of pixels long.
  'rect (HUD)': wrap('M 12 20 L 88 20 L 88 74 L 12 74 Z'),
  'L (reflex corner)': wrap('M 15 15 L 55 15 L 55 55 L 85 55 L 85 85 L 15 85 Z'),
  'thin bar (2 px)': wrap(`M 20 49.8 L 80 49.8 L 80 50.2 L 20 50.2 Z`),
  'diagonal triangle': wrap('M 12 15 L 88 42 L 30 90 Z'),
  // ...AND THE CASE IT DOES NOT: many short edges, each a few pixels.
  'star 5 (sharp)': wrap(star(5, 0.17)),
  'star 24': wrap(star(24, 0.32)),
  '12-gon (edge ~60 px)': wrap(ngon(12)),
  '50-gon (edge ~29 px)': wrap(ngon(50)),
  '200-gon (edge ~7 px)': wrap(ngon(200)),
  '500-gon (edge ~3 px)': wrap(ngon(500)),
  '1000-gon (edge ~1.4 px)': wrap(ngon(1000)),
};

const rowsOf = (pk) => {
  const c = { solid: 0, line: 0, chain: 0, conic: 0 };
  for (let t = 0; t + 2 < pk.vertexCount; t += 3) {
    const a = decodeVert(pk.verts, t + 2);
    if (a.kind !== LBK.INTERIOR) continue;
    if (a.tc[0] > 2.5) c.conic++;
    else if (a.tc[0] > 1.5) c.chain++;
    else if (a.C3[0] * a.C3[0] + a.C3[1] * a.C3[1] > 1e-9) c.line++;
    else c.solid++;
  }
  return c;
};

async function scoreArm(pk, sh, view, kit) {
  const cv = kit.contoursToConverter(sh.contours, null);
  if (!cv) return null;
  const curves = kit.closed(cv);
  const acc = new Float64Array(CANVAS * CANVAS).fill(1);
  rasterMesh(pk, view, acc, {}, null, null, null);
  let aaErr = 0,
    aaN = 0,
    aaMax = 0,
    sgn = 0,
    miss = 0,
    stray = 0;
  const sgnBuf = new Float64Array(CANVAS * CANVAS),
    edgeBuf = new Uint8Array(CANVAS * CANVAS);
  const rc = new Map();
  for (let j = 0; j < CANVAS; j++) {
    rc.clear();
    for (let i = 0; i < CANVAS; i++) {
      const ex = exactCov(kit.rowSpans, curves, i, j, view, SLICES, sh.evenOdd, rc);
      const mo = 1 - acc[j * CANVAS + i];
      const d = mo - ex;
      sgnBuf[j * CANVAS + i] = d;
      if (ex > 1e-6 && ex < 1 - 1e-6) {
        edgeBuf[j * CANVAS + i] = 1;
        aaN++;
        aaErr += Math.abs(d);
        sgn += d;
        aaMax = Math.max(aaMax, Math.abs(d));
      } else if (ex >= 1 - 1e-6) {
        if (mo < 1) miss += 1 - mo;
      } else if (mo > 0) stray += mo;
    }
  }
  // jaggies on both axes
  let jaggy = 0;
  const at = (i, j) => sgnBuf[j * CANVAS + i];
  for (let j = 1; j < CANVAS - 1; j++)
    for (let i = 1; i < CANVAS - 1; i++) {
      if (!edgeBuf[j * CANVAS + i]) continue;
      const c = at(i, j);
      const hx =
        (c - at(i - 1, j) > 0.25 && c - at(i + 1, j) > 0.25) ||
        (at(i - 1, j) - c > 0.25 && at(i + 1, j) - c > 0.25);
      const hy =
        (c - at(i, j - 1) > 0.25 && c - at(i, j + 1) > 0.25) ||
        (at(i, j - 1) - c > 0.25 && at(i, j + 1) - c > 0.25);
      if (hx || hy) jaggy++;
    }
  return { aaErr, aaN, aaMax, sgn, miss, stray, jaggy, verts: pk.vertexCount, rows: rowsOf(pk) };
}

const cdtArm = (sh) => {
  try {
    const cdt = LB.buildLoopBlinnCDT(sh.contours, { fillRule: sh.evenOdd ? 'evenodd' : 'nonzero' });
    if (!cdt || cdt.fallback.length) return null;
    LB.dropDegenerateFaces(cdt);
    return LB.packLoopBlinnMesh(cdt);
  } catch {
    return null;
  }
};

const files = process.argv.slice(2);
const targets = [];
const tmp = path.join(os.tmpdir(), 'mantle-straightchain');
if (!existsSync(tmp)) {
  try {
    (await import('fs')).mkdirSync(tmp, { recursive: true });
  } catch {
    /* exists */
  }
}
for (const [name, svg] of Object.entries(SYNTH)) {
  const p = path.join(tmp, name.replace(/[^\w]+/g, '_') + '.svg');
  writeFileSync(p, svg);
  targets.push([name, p]);
}
for (const f of files) targets.push([f.split('/').pop(), path.resolve(ROOT, f)]);

const kit = await refKit();
console.log(`CANVAS=${CANVAS} SLICES=${SLICES}   mean/max are per EDGE pixel, in /255\n`);
console.log(
  '  shape                      arm         verts   rows(solid/line/chain)   mean     max   signed   jaggy',
);
const totals = { earcut: 0, 'cdt-chain': 0 };
for (const [name, file] of targets) {
  const bundle = await loadSvg(file);
  const { shapes, bbox } = await shapesOf(bundle);
  const view = viewOf(bbox, CANVAS);
  for (const sh of shapes) {
    const fast = await buildMesh(sh);
    const arms = [
      ['earcut', fast && fast.pk],
      ['cdt-chain', cdtArm(sh)],
    ];
    let first = true;
    for (const [arm, pk] of arms) {
      const label = (first ? `${name}${shapes.length > 1 ? ' #' + sh.s : ''}` : '').padEnd(25);
      first = false;
      if (!pk) {
        console.log(`  ${label}  ${arm.padEnd(10)}  (no mesh)`);
        continue;
      }
      const r = await scoreArm(pk, sh, view, kit);
      if (!r) {
        console.log(`  ${label}  ${arm.padEnd(10)}  (no reference)`);
        continue;
      }
      totals[arm] += r.aaErr;
      console.log(
        `  ${label}  ${arm.padEnd(10)} ${String(r.verts).padStart(6)}   ` +
          `${String(r.rows.solid).padStart(5)}/${String(r.rows.line).padStart(5)}/${String(r.rows.chain).padStart(5)}   ` +
          `${((r.aaErr / Math.max(1, r.aaN)) * 255).toFixed(2).padStart(6)}  ${(r.aaMax * 255).toFixed(1).padStart(6)}  ` +
          `${((r.sgn >= 0 ? '+' : '') + ((r.sgn / Math.max(1, r.aaN)) * 255).toFixed(2)).padStart(7)}  ${String(r.jaggy).padStart(6)}`,
      );
    }
  }
}
console.log(
  `\n  total AA error over every shape above: earcut ${totals.earcut.toFixed(2)} px^2,` +
    ` cdt-chain ${totals['cdt-chain'].toFixed(2)} px^2`,
);
