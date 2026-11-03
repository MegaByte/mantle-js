// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// measure.mjs — before/after numbers for the line branch's join and square-cap rules on the CPU (no GPU).
//
//   node probes/strokeCapJoin/measure.mjs [--before miterClipRound] [--after fixed] [--cases 1000]
//        [--seed 0x7a11] [--e2e 200] [--src /path/to/js.kontek.mantle] [--e2e-rule fixed]
//
// PORT: the line-branch port (test/_strokeShapeRef.mjs) evaluated over every segment, rule
// `before` against rule `after`, at every pixel center of seeded random polylines, against the
// exact SVG 2 stroke shape. Per join style and per cap: painted outside, unpainted, pixels whose
// coverage moved, and over the moved pixels the summed |coverage - 8x8 box coverage|.
//
// E2E: importSvg from --src (default: this package) + the band-walk emulator
// (test/_strokeBandEmu.mjs): cover quad, band pick through the meta bbox, break / far / saturation
// gates. Counts SVG-inside centers left unpainted and outside centers painted, with gates on and
// off. Run it against a source tree without the rules (--src) for the before numbers.
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '../..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BEFORE = arg('before', 'miterClipRound'),
  AFTER = arg('after', 'fixed');
const NCASES = +arg('cases', 1000),
  SEED = Number(arg('seed', '0x7a11')),
  NE2E = +arg('e2e', 0);
const SRC = path.resolve(arg('src', PKG)),
  E2E_RULE = arg('e2e-rule', AFTER);

const { minDist, coverage, svgInside, makeStrokeCases, pixels, JOINS } = await import(
  pathToFileURL(path.join(PKG, 'test/_strokeShapeRef.mjs')).href
);
const CAPS = ['butt', 'round', 'square'];

const cases = makeStrokeCases(SEED, NCASES);
const boxCov = (cs, c, n = 8) => {
  let k = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (
        svgInside(
          [c[0] - 0.5 + (i + 0.5) / n, c[1] - 0.5 + (j + 0.5) / n],
          cs.P,
          cs.closed,
          cs.halfW,
          cs.cap,
          cs.joinStyle,
          cs.miterLimit,
        )
      )
        k++;
  return k / (n * n);
};

// ---- PORT --------------------------------------------------------------------------------------
{
  const by = {};
  const row = (k) =>
    (by[k] ??= { px: 0, outB: 0, unB: 0, outA: 0, unA: 0, moved: 0, errB: 0, errA: 0 });
  const t0 = performance.now();
  for (const cs of cases) {
    const rows = [
      row(`join ${JOINS[cs.joinStyle]}`),
      row(`cap ${cs.closed ? 'closed' : CAPS[cs.cap]}`),
    ];
    for (const c of pixels(cs)) {
      const inSvg = svgInside(c, cs.P, cs.closed, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit);
      const dB = minDist(BEFORE, c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit).minD;
      const dA = minDist(AFTER, c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit).minD;
      const cB = coverage(BEFORE, c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit);
      const cA = coverage(AFTER, c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit);
      let eB = 0,
        eA = 0;
      if (cA !== cB) {
        const t = boxCov(cs, c);
        eB = Math.abs(cB - t);
        eA = Math.abs(cA - t);
      }
      for (const r of rows) {
        r.px++;
        if (dB <= cs.halfW && !inSvg) r.outB++;
        if (dB > cs.halfW && inSvg) r.unB++;
        if (dA <= cs.halfW && !inSvg) r.outA++;
        if (dA > cs.halfW && inSvg) r.unA++;
        if (cA !== cB) {
          r.moved++;
          r.errB += eB;
          r.errA += eA;
        }
      }
    }
  }
  console.log(
    `PORT  ${NCASES} polylines (seed ${SEED}), rule ${BEFORE} -> ${AFTER}  (${((performance.now() - t0) / 1000).toFixed(1)} s)`,
  );
  console.log(
    '  group            pixels   painted-outside   unpainted     moved   AA error over moved (vs 8x8 box)',
  );
  for (const [k, r] of Object.entries(by).sort())
    console.log(
      `  ${k.padEnd(16)} ${String(r.px).padStart(8)}   ${String(r.outB).padStart(5)} -> ${String(r.outA).padEnd(5)}   ${String(r.unB).padStart(5)} -> ${String(r.unA).padEnd(5)} ${String(r.moved).padStart(6)}   ${r.errB.toFixed(1)} -> ${r.errA.toFixed(1)}`,
    );
}

// ---- E2E ---------------------------------------------------------------------------------------
if (NE2E > 0) {
  if (typeof DOMParser === 'undefined') {
    const x = await import('@xmldom/xmldom');
    globalThis.DOMParser = x.DOMParser;
    globalThis.XMLSerializer = x.XMLSerializer;
  }
  const { default: importSvg } = await import(
    pathToFileURL(path.join(SRC, 'src/svg/importer.js')).href
  );
  const { makeStrokeEmu, strokeRowsOf } = await import(
    pathToFileURL(path.join(PKG, 'test/_strokeBandEmu.mjs')).href
  );
  const by = {};
  const row = (k) =>
    (by[k] ??= { px: 0, skipped: 0, unOn: 0, outOn: 0, unOff: 0, outOff: 0, quadMiss: 0 });
  const t0 = performance.now();
  for (const cs of cases.slice(0, NE2E)) {
    const d = 'M ' + cs.P.map((p) => `${p[0]} ${p[1]}`).join(' L ') + (cs.closed ? ' Z' : '');
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-100 -100 200 200"><path d="${d}" fill="none" stroke="#000" stroke-width="${2 * cs.halfW}"` +
      ` stroke-linecap="${CAPS[cs.cap]}" stroke-linejoin="${JOINS[cs.joinStyle]}" stroke-miterlimit="${cs.miterLimit}"/></svg>`;
    const b = await importSvg(svg);
    const [r0] = strokeRowsOf(b);
    // rule 'base' is the shader without the rules, whose _reach has no square cap and no sqrt(L^2 + 1)
    const reachFactor =
      E2E_RULE === 'base'
        ? cs.joinStyle === 0 || cs.joinStyle >= 3
          ? Math.max(cs.miterLimit, 1)
          : 1
        : null;
    const on = makeStrokeEmu(b, r0, { rule: E2E_RULE, gates: true, reachFactor }),
      off = makeStrokeEmu(b, r0, { rule: E2E_RULE, gates: false, reachFactor });
    const rows = [
      row(`join ${JOINS[cs.joinStyle]}`),
      row(`cap ${cs.closed ? 'closed' : CAPS[cs.cap]}`),
    ];
    const eps = 1e-4 * cs.halfW;
    for (const c of pixels(cs)) {
      const inSvg = svgInside(c, cs.P, cs.closed, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit);
      const hair = [
        [eps, 0],
        [-eps, 0],
        [0, eps],
        [0, -eps],
      ].some(
        ([dx, dy]) =>
          svgInside(
            [c[0] + dx, c[1] + dy],
            cs.P,
            cs.closed,
            cs.halfW,
            cs.cap,
            cs.joinStyle,
            cs.miterLimit,
          ) !== inSvg,
      );
      for (const r of rows) r.px++;
      if (hair) {
        for (const r of rows) r.skipped++;
        continue;
      }
      const a = on.eval(c),
        z = off.eval(c);
      const pOn = a.inQuad && a.minD <= cs.halfW,
        pOff = z.inQuad && z.minD <= cs.halfW;
      for (const r of rows) {
        if (inSvg && !pOn) r.unOn++;
        if (!inSvg && pOn) r.outOn++;
        if (inSvg && !pOff) r.unOff++;
        if (!inSvg && pOff) r.outOff++;
        if (inSvg && !a.inQuad) r.quadMiss++;
      }
    }
  }
  console.log(
    `\nE2E   importSvg from ${SRC}, rule ${E2E_RULE}, first ${NE2E} polylines  (${((performance.now() - t0) / 1000).toFixed(1)} s)`,
  );
  console.log(
    '  group            pixels  unpainted(gates on/off)  painted-outside(on/off)  inside-but-outside-cover-quad',
  );
  for (const [k, r] of Object.entries(by).sort())
    console.log(
      `  ${k.padEnd(16)} ${String(r.px - r.skipped).padStart(7)}   ${String(r.unOn).padStart(5)} / ${String(r.unOff).padEnd(5)}            ${String(r.outOn).padStart(5)} / ${String(r.outOff).padEnd(5)}            ${r.quadMiss}`,
    );
}
