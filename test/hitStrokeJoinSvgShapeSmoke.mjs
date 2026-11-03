// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// CPU stroke hit testing against independent SVG 2 geometry and imported bundles, with each free end taking its own cap.
//   (a) pointOnStroke agrees with the SVG 2 shape at every pixel center: the open cases under all nine start>end cap pairs, the
//       closed cases by join, and every case again at coordinate scales 1e-3 and 1e3;
//   (c) end to end through importSvg + fillHitShape(Outline): every cap the importer emits, and three asymmetric pairs written
//       into meta slot 46 after the import;
//   (d) mutations are caught: the join wedge, the miter limit, and the start cap used for both ends; the line branch is a
//       shortcut whose shape the curve path answers too;
//   (e) Flash per-axis stroke widths use inverse pixel differentials, including the cull bounds.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { svgInside, capInside, makeStrokeCases, pixels, JOINS } from './_strokeShapeRef.mjs';

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
const PRE_FIX_HINGE = 'const cap = atStart ? capStyle : endCapStyle;';
ok(GEOM_SRC.includes(PRE_FIX_HINGE), 'mutation hinge present: the per-end cap pick');
const PRE_FIX = await loadGeom(GEOM_SRC.replace(PRE_FIX_HINGE, 'const cap = capStyle;'));

const cases = makeStrokeCases();
const openCases = cases.filter((cs) => !cs.closed);
const CAPS = ['butt', 'round', 'square'];
const PAIRS = [];
for (let sc = 0; sc < 3; sc++) for (let ec = 0; ec < 3; ec++) PAIRS.push([sc, ec]);
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
function disagreements(geom, scale = 1, joins = [0, 1, 2, 3, 4], closedOnly = false) {
  const byJoin = {};
  for (const cs of cases) {
    if (!joins.includes(cs.joinStyle) || (closedOnly && !cs.closed)) continue;
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

// The SVG 2 shape of an open polyline is its body and joins plus each free end's cap, so one
// evaluation of each part answers every cap pair at a point.
const shapeParts = (c, cs) => ({
  core: svgInside(c, cs.P, false, cs.halfW, 0, cs.joinStyle, cs.miterLimit, 0),
  start: [false, capInside(c, cs.P, cs.halfW, 1, true), capInside(c, cs.P, cs.halfW, 2, true)],
  end: [false, capInside(c, cs.P, cs.halfW, 1, false), capInside(c, cs.P, cs.halfW, 2, false)],
});
const insideFor = (parts, sc, ec) => parts.core || parts.start[sc] || parts.end[ec];

// ---- (a) against SVG 2 -------------------------------------------------------------------------
// The open cases are checked under every start>end cap pair. Its symmetric pairs are the whole
// open shape (endCapStyle defaults to capStyle, and the body OR each cap is svgInside with that
// cap), so the per-join sweep at scale 1 covers only the closed cases.
{
  const res = {}; // "start>end" -> { n, shipHitOut, shipMiss, preHitOut, preMiss }
  for (const [sc, ec] of PAIRS)
    res[`${CAPS[sc]}>${CAPS[ec]}`] = { n: 0, shipHitOut: 0, shipMiss: 0, preHitOut: 0, preMiss: 0 };
  for (const cs of openCases) {
    const hs = toHitSegs(cs.segs);
    for (const c of pixels(cs)) {
      const parts = shapeParts(c, cs);
      for (const [sc, ec] of PAIRS) {
        const r = res[`${CAPS[sc]}>${CAPS[ec]}`];
        const inSvg = insideFor(parts, sc, ec);
        const hit = SHIPPED.pointOnStroke(
          hs,
          c[0],
          c[1],
          cs.halfW,
          sc,
          cs.joinStyle,
          cs.miterLimit,
          null,
          0,
          ec,
        );
        const pre = PRE_FIX.pointOnStroke(
          hs,
          c[0],
          c[1],
          cs.halfW,
          sc,
          cs.joinStyle,
          cs.miterLimit,
          null,
          0,
          ec,
        );
        r.n++;
        if (hit && !inSvg) r.shipHitOut++;
        if (!hit && inSvg) r.shipMiss++;
        if (pre && !inSvg) r.preHitOut++;
        if (!pre && inSvg) r.preMiss++;
      }
    }
  }
  const asym = PAIRS.filter(([a, b]) => a !== b).map(([a, b]) => `${CAPS[a]}>${CAPS[b]}`);
  const sym = PAIRS.filter(([a, b]) => a === b).map(([a, b]) => `${CAPS[a]}>${CAPS[b]}`);
  const sum = (ks, f) => ks.reduce((s, k) => s + f(res[k]), 0);
  const fmtPairs = (ks, f) => ks.map((k) => `${k} ${f(res[k])}`).join(', ');

  ok(
    sum(
      PAIRS.map(([a, b]) => `${CAPS[a]}>${CAPS[b]}`),
      (v) => v.shipHitOut + v.shipMiss,
    ) === 0,
    `(a) pointOnStroke agrees with the SVG 2 shape at all ${res['butt>butt'].n * 9} centers over nine cap pairs`,
  );
  const preAsym = sum(asym, (v) => v.preHitOut + v.preMiss);
  ok(
    preAsym > 1000,
    `(d) the start cap for both ends is caught on the six asymmetric pairs: ${preAsym} centers disagree with SVG 2 — ${fmtPairs(asym, (v) => `${v.preHitOut}/${v.preMiss}`)} (hit outside / missed inside)`,
  );
  ok(
    sum(sym, (v) => v.preHitOut + v.preMiss) === 0,
    '(d) and nothing moves on the three symmetric pairs, which is every bundle the SVG importer can emit',
  );
}
{
  const r = disagreements(SHIPPED, 1, [0, 1, 2, 3, 4], true);
  ok(
    total(r) === 0,
    `(a) pointOnStroke agrees with the SVG 2 shape at every pixel center of the closed cases (hit outside / missed inside: ${fmt(r)})`,
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

// ---- (c) end to end through importSvg + a rewritten slot 46 ----------------------------------------
{
  // The importer has no syntax for an asymmetric pair, so the row is written after the fact. Its
  // band pad and cover quad come from the START cap (src/bundle/strokeReach.js), so only the pairs
  // whose end cap reaches no further than the start one are exact end to end; a butt>square row
  // would need the pad a real Flash ingest gives it (strokeReachFactor takes both caps already).
  const SHRINKING = [
    [2, 0],
    [2, 1],
    [1, 0],
  ];
  const META_END_CAP_OR_RX = 46,
    META_STROKE_W = 12,
    META_FILL_A = 7;
  let n = 0,
    wrong = 0,
    skipped = 0,
    preWrong = 0;
  const examples = [];
  for (const cs of openCases.slice(0, 40)) {
    const reach = cs.halfW * Math.max(cs.miterLimit, 1) + 2;
    const xs = cs.P.map((p) => p[0]),
      ys = cs.P.map((p) => p[1]);
    const vb = [
      Math.min(...xs) - reach,
      Math.min(...ys) - reach,
      Math.max(...xs) - Math.min(...xs) + 2 * reach,
      Math.max(...ys) - Math.min(...ys) + 2 * reach,
    ];
    const d = 'M ' + cs.P.map((p) => `${p[0]} ${p[1]}`).join(' L ');
    const rows = [];
    for (const [sc, ec] of SHRINKING) {
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}"><path d="${d}" fill="none" stroke="#000" stroke-width="${2 * cs.halfW}"` +
        ` stroke-linecap="${CAPS[sc]}" stroke-linejoin="${JOINS[cs.joinStyle]}" stroke-miterlimit="${cs.miterLimit}"/></svg>`;
      const b = await importSvg(svg);
      const meta = new Float32Array(b.meta, 32),
        stride = b.metaFloatsPerShape || 48;
      let row = -1;
      for (let i = 0; i * stride < meta.length; i++)
        if (meta[i * stride + META_STROKE_W] > 0 && !(meta[i * stride + META_FILL_A] > 0)) {
          row = i;
          break;
        }
      if (row < 0) continue;
      meta[row * stride + META_END_CAP_OR_RX] = ec + 1; // the encoding meta.js writes
      rows.push({ sc, ec, b });
    }
    const eps = 1e-4 * cs.halfW;
    for (const c of pixels(cs)) {
      // the center first, then the four neighbors that tell a center on the boundary
      const at = [
        c,
        [c[0] + eps, c[1]],
        [c[0] - eps, c[1]],
        [c[0], c[1] + eps],
        [c[0], c[1] - eps],
      ].map((q) => shapeParts(q, cs));
      for (const { sc, ec, b } of rows) {
        const inSvg = insideFor(at[0], sc, ec);
        if (at.some((parts) => insideFor(parts, sc, ec) !== inSvg)) {
          skipped++;
          continue;
        }
        const hit = fillHitShape(b, c[0], c[1], { mode: HitMode.Outline }) >= 0;
        const preSvg = insideFor(at[0], sc, sc);
        if (preSvg !== inSvg) preWrong++;
        n++;
        if (hit !== inSvg) {
          wrong++;
          if (examples.length < 3)
            examples.push(
              `${CAPS[sc]}>${CAPS[ec]} (${c.map((v) => v.toFixed(2))}) hit ${hit} svg ${inSvg}`,
            );
        }
      }
    }
  }
  ok(
    n > 5000 && wrong === 0,
    `(c) end to end: fillHitShape(Outline) agrees with SVG 2 at ${n - wrong} of ${n} centers over three asymmetric rows (${skipped} on a boundary skipped)${examples.length ? ': ' + examples.join('; ') : ''}`,
  );
  ok(
    preWrong > 200,
    `(c) and the two shapes really differ there: ${preWrong} of ${n} centers change when the end cap becomes the start cap`,
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

// ---- (e) Flash per-axis stroke widths use inverse pixel differentials, including cull bounds -------
{
  const { parseMetaBin } = await import('../src/core/metaBin.js');
  for (const [flags, half] of [
    [0, 4],
    [1, 8.5],
    [8192, 1],
    [16384, 16],
    [24576, 8.5],
  ]) {
    const sec = await importSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-64 -64 128 128"><path d="M-20 0L20 0" fill="none" stroke="red" stroke-width="8" stroke-linejoin="round"/></svg>',
      { preserveViewport: true },
    );
    parseMetaBin(sec.meta, sec.metaFloatsPerShape).metaFloats[27] = flags;
    for (const y of [2, 8])
      if (
        fillHitShape(sec, 0, y * 0.25, {
          mode: 'outline',
          worldMatrix: [4, 0, 0, 0, 0.25, 0, 0, 0, 1],
        }) >=
          0 !==
        y <= half
      )
        throw new Error(`per-axis stroke hit ${flags}/${y}`);
  }
}

if (fail) {
  console.error(`HIT-STROKE-JOIN-SVG-SHAPE FAIL (${fail})`);
  process.exit(1);
}
console.log(`HIT-STROKE-JOIN-SVG-SHAPE PASS (${(performance.now() / 1000).toFixed(1)} s)`);
