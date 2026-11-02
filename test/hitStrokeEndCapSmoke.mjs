// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// CPU stroke hit testing for independent start and end caps.
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
const t0 = Date.now();

// ---- curveGeom.js, as shipped and mutated --------------------------------------------------------
const GEOM_PATH = path.join(ROOT, 'src/hitTest/curveGeom.js');
const GEOM_SRC = readFileSync(GEOM_PATH, 'utf8');
const loadGeom = (src) => {
  const abs = src.replace(
    /from '(\.\.?\/[^']+)'/g,
    (m, rel) => `from '${new URL(rel, pathToFileURL(GEOM_PATH)).href}'`,
  );
  return import('data:text/javascript;base64,' + Buffer.from(abs).toString('base64'));
};
const SHIPPED = await loadGeom(GEOM_SRC);
const PRE_FIX_HINGE = 'const cap = atStart ? capStyle : endCapStyle;';
ok(GEOM_SRC.includes(PRE_FIX_HINGE), 'mutation hinge present: the per-end cap pick');
const PRE_FIX = await loadGeom(GEOM_SRC.replace(PRE_FIX_HINGE, 'const cap = capStyle;'));

const CAPS = ['butt', 'round', 'square'];
const PAIRS = [];
for (let sc = 0; sc < 3; sc++) for (let ec = 0; ec < 3; ec++) PAIRS.push([sc, ec]);
const cases = makeStrokeCases().filter((cs) => !cs.closed);
const toHitSegs = (segs) =>
  segs.map((s) => ({
    t: 0,
    x0: s.a[0],
    y0: s.a[1],
    x1: s.b[0],
    y1: s.b[1],
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

// Compare CPU hit testing with independent SVG geometry.
{
  const res = {}; // "start>end" -> { n, shipHitOut, shipMiss, preHitOut, preMiss }
  for (const [sc, ec] of PAIRS) {
    const k = `${CAPS[sc]}>${CAPS[ec]}`;
    const r = (res[k] = { n: 0, shipHitOut: 0, shipMiss: 0, preHitOut: 0, preMiss: 0 });
    for (const cs of cases) {
      const hs = toHitSegs(cs.segs);
      for (const c of pixels(cs)) {
        const inSvg = svgInside(c, cs.P, false, cs.halfW, sc, cs.joinStyle, cs.miterLimit, ec);
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
  const fmt = (ks, f) => ks.map((k) => `${k} ${f(res[k])}`).join(', ');

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
    `(d) the start cap for both ends is caught on the six asymmetric pairs: ${preAsym} centers disagree with SVG 2 — ${fmt(asym, (v) => `${v.preHitOut}/${v.preMiss}`)} (hit outside / missed inside)`,
  );
  ok(
    sum(sym, (v) => v.preHitOut + v.preMiss) === 0,
    '(d) and nothing moves on the three symmetric pairs, which is every bundle the SVG importer can emit',
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
  for (const cs of cases.slice(0, 40)) {
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
      const eps = 1e-4 * cs.halfW;
      for (const c of pixels(cs)) {
        const inSvg = svgInside(c, cs.P, false, cs.halfW, sc, cs.joinStyle, cs.miterLimit, ec);
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
                false,
                cs.halfW,
                sc,
                cs.joinStyle,
                cs.miterLimit,
                ec,
              ) !== inSvg,
          )
        ) {
          skipped++;
          continue;
        }
        const hit = fillHitShape(b, c[0], c[1], { mode: HitMode.Outline }) >= 0;
        const preSvg = svgInside(c, cs.P, false, cs.halfW, sc, cs.joinStyle, cs.miterLimit, sc);
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

// Flash per-axis stroke widths use inverse pixel differentials, including cull bounds.
{
  const { DOMParser, XMLSerializer } = await import('@xmldom/xmldom');
  globalThis.DOMParser ||= DOMParser;
  globalThis.XMLSerializer ||= XMLSerializer;
  const { default: importSvg } = await import('../src/svg/importer.js');
  const { parseMetaBin } = await import('../src/core/metaBin.js');
  const { fillHitShape } = await import('../src/hitTest/hitTest.js');
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

console.log(
  `${fail ? 'HIT-STROKE-END-CAP FAIL' : 'HIT-STROKE-END-CAP PASS'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
);
process.exit(fail ? 1 : 0);
