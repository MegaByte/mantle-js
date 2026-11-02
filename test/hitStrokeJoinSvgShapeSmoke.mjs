// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// CPU stroke hit testing against independent SVG geometry and imported bundles.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { svgInside, makeStrokeCases, pixels, JOINS } from './_strokeShapeRef.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { fillHitShape, HitMode } = await import('../src/hitTest/hitTest.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- curveGeom.js, as shipped and mutated ------------------------------------------------------
const GEOM_PATH = path.join(ROOT, 'src/hitTest/curveGeom.js');
const GEOM_SRC = readFileSync(GEOM_PATH, 'utf8');
const loadGeom = (src) => {
  const abs = src.replace(
    /from '(\.\.?\/[^']+)'/g,
    (m, rel) => `from '${new URL(rel, pathToFileURL(GEOM_PATH)).href}'`,
  );
  return import('data:text/javascript;base64,' + Buffer.from(abs).toString('base64'));
};
const mutant = (from, to) => {
  const hit = GEOM_SRC.includes(from);
  ok(hit, `mutation hinge present: ${from.slice(0, 60)}`);
  return loadGeom(GEOM_SRC.replace(from, to));
};
const SHIPPED = await loadGeom(GEOM_SRC);

const cases = makeStrokeCases();
const toHitSegs = (segs, scale = 1) =>
  segs.map((s) => ({
    t: 0,
    x0: s.a[0] * scale,
    y0: s.a[1] * scale,
    x1: s.b[0] * scale,
    y1: s.b[1] * scale,
    f: false,
    sd: 0,
    freeS: s.freeStart,
    freeE: s.freeEnd,
    itx: s.inTan[0],
    ity: s.inTan[1],
    otx: s.outTan[0],
    oty: s.outTan[1],
    kSS: 0,
    kSE: 0,
    kPE: 0,
    kNS: 0,
  }));
function disagreements(geom, scale = 1, joins = [0, 1, 2, 3, 4]) {
  const byJoin = {};
  for (const cs of cases) {
    if (!joins.includes(cs.joinStyle)) continue;
    const k = JOINS[cs.joinStyle];
    byJoin[k] ??= { n: 0, hitOutside: 0, missInside: 0 };
    const hs = toHitSegs(cs.segs, scale),
      P = cs.P.map((p) => [p[0] * scale, p[1] * scale]),
      hw = cs.halfW * scale;
    for (const c0 of pixels(cs)) {
      const c = [c0[0] * scale, c0[1] * scale];
      const hit = geom.pointOnStroke(
        hs,
        c[0],
        c[1],
        hw,
        cs.cap,
        cs.joinStyle,
        cs.miterLimit,
        null,
        0,
      );
      const inSvg = svgInside(c, P, cs.closed, hw, cs.cap, cs.joinStyle, cs.miterLimit);
      byJoin[k].n++;
      if (hit && !inSvg) byJoin[k].hitOutside++;
      if (!hit && inSvg) byJoin[k].missInside++;
    }
  }
  return byJoin;
}
const total = (r) => Object.values(r).reduce((s, v) => s + v.hitOutside + v.missInside, 0);
const fmt = (r) =>
  Object.entries(r)
    .map(([k, v]) => `${k} ${v.hitOutside}/${v.missInside}`)
    .join(', ');

// ---- (a) against SVG 2 -------------------------------------------------------------------------
{
  const r = disagreements(SHIPPED);
  ok(
    total(r) === 0,
    `(a) pointOnStroke agrees with the SVG 2 shape at every pixel center (hit outside / missed inside: ${fmt(r)})`,
  );
  for (const S of [1e-3, 1e3]) {
    const rs = disagreements(SHIPPED, S);
    ok(total(rs) === 0, `(a) and at coordinate scale ${S} (${total(rs)} disagree)`);
  }
}

// ---- (c) end to end through importSvg + fillHitShape ---------------------------------------------
{
  let n = 0,
    skipped = 0,
    wrong = 0,
    squareWrong = 0,
    squareN = 0;
  const examples = [];
  for (const cs of cases.slice(0, 60)) {
    const reach = cs.halfW * Math.max(cs.miterLimit, 1) + 2;
    const xs = cs.P.map((p) => p[0]),
      ys = cs.P.map((p) => p[1]);
    const vb = [
      Math.min(...xs) - reach,
      Math.min(...ys) - reach,
      Math.max(...xs) - Math.min(...xs) + 2 * reach,
      Math.max(...ys) - Math.min(...ys) + 2 * reach,
    ];
    const d = 'M ' + cs.P.map((p) => `${p[0]} ${p[1]}`).join(' L ') + (cs.closed ? ' Z' : '');
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}"><path d="${d}" fill="none" stroke="#000" stroke-width="${2 * cs.halfW}"` +
      ` stroke-linecap="${['butt', 'round', 'square'][cs.cap]}" stroke-linejoin="${JOINS[cs.joinStyle]}" stroke-miterlimit="${cs.miterLimit}"/></svg>`;
    const b = await importSvg(svg);
    const eps = 1e-4 * cs.halfW;
    for (const c of pixels(cs)) {
      const inSvg = svgInside(c, cs.P, cs.closed, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit);
      if (
        [
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
        )
      ) {
        skipped++;
        continue;
      }
      const hit = fillHitShape(b, c[0], c[1], { mode: HitMode.Outline }) >= 0;
      // A square cap's far corner reaches halfW * (|t| + |n|) along an axis, up to halfW * sqrt(2),
      // past the stroke row's halfW-padded meta bbox, so the hit test's cull may not stop at that
      // bbox. Counted apart as well, so a failure there names it.
      if (!cs.closed && cs.cap === 2) {
        squareN++;
        if (hit !== inSvg) squareWrong++;
      }
      n++;
      if (hit !== inSvg) {
        wrong++;
        if (examples.length < 3)
          examples.push(
            `${JOINS[cs.joinStyle]} (${c.map((v) => v.toFixed(2))}) hit ${hit} svg ${inSvg}`,
          );
      }
    }
  }
  ok(
    n > 30000 && wrong === 0,
    `(c) end to end, every cap: fillHitShape(Outline) agrees at ${n - wrong} of ${n} centers (${skipped} on a boundary skipped)${examples.length ? ': ' + examples.join('; ') : ''}`,
  );
  ok(
    squareN > 30000 && squareWrong === 0,
    `(c) of them with square caps: ${squareWrong} of ${squareN} disagree`,
  );
}

// ---- (d) mutations and the line shortcut ---------------------------------------------------------
{
  const M = [
    [
      'the wedge ignored',
      await mutant('if (qx * tAx + qy * tAy < 0 || qx * tBx + qy * tBy > 0) return false;', ''),
    ],
    [
      'the miter limit ignored',
      await mutant(
        'return halfW <= Math.min(miterLimit, MAX_MITER_RATIO) * halfW * sinHalf && inKite;',
        'return inKite;',
      ),
    ],
  ];
  for (const [name, geom] of M) {
    const r = disagreements(geom, 1, [0, 1, 2]);
    ok(total(r) > 0, `mutation "${name}" is caught: ${fmt(r)}`);
  }
  // THE LINE BRANCH IS A SHORTCUT, NOT A SEPARATE RULE. The CURVE path (capJoinDist's generic
  // branches) has the join wedge, the butt end outside it, the shader's half-angle and the shader's
  // bisector clip, so sending a straight segment's interior end down it answers the same shape on
  // the whole population: the mutation is not catchable, and THAT is the check. `lineJoinContains`
  // stays because it is a membership test with no distance to compute, not because it disagrees.
  {
    const noLine = await mutant(
      'if (s.t === SEG_LINE && !(atStart ? s.freeS : s.freeE)) {',
      'if (false) {',
    );
    const r = disagreements(noLine, 1, [0, 1, 2]);
    ok(
      total(r) === 0,
      `(d) and the curve path answers the LINE path's shape: with lineJoinContains bypassed entirely, ${total(r)} centers disagree with SVG 2 (${fmt(r)}) — without the curve-join rules the generic path falls through to the halfW disc`,
    );
  }
}

if (fail) {
  console.error(`HIT-STROKE-JOIN-SVG-SHAPE FAIL (${fail})`);
  process.exit(1);
}
console.log(`HIT-STROKE-JOIN-SVG-SHAPE PASS (${(performance.now() / 1000).toFixed(1)} s)`);
