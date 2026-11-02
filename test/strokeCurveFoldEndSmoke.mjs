// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Verify curved stroke bodies that extend past an endpoint and square-cap corners.
// Compare the generated shader against the independent SVG stroke oracle at
// three coordinate scales, then repeat with degree-elevated cubics. Mutants
// removing the interior foot or endpoint cap must lose reference-covered pixels.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';
import { strokeRowsOf, mainCov, refCov, hasExact } from './_strokeMainCov.mjs';
import { svgInsideCurve, makeCurveCases } from './_strokeCurveRef.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!EMU.hasCxx()) {
  console.log('  SKIPPED: no C++ compiler');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const importSvg = (await import('../src/svg/importer.js')).default;
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const HOOK = '  if ((t < 1e-4 || t > 1.0 - 1e-4) && uIn >= 0.0) {\n',
  HOOKQ = HOOK + '    vec2 qIn = (A * uIn + B) * uIn + s0;';
const HOOKC = HOOK + '    vec2 qIn = vec2(evalC(cx, uIn), evalC(cy, uIn));';
const ELSEQ = 'vec2 pE = e == 0 ? p1 : p3, uE = e == 0 ? -strokeUnit(dStart) : strokeUnit(dEnd);'; // the quad's end caps
ok(
  GLSL.split(HOOKQ).length === 2 &&
    GLSL.split(HOOKC).length === 2 &&
    GLSL.split(ELSEQ).length === 2,
  'the interior foot past the end is in the shipped shader text, quad and cubic',
);
const CAPS = ['butt', 'round', 'square'];
// The seeded quad chains (makeCurveCases), open ones: every pixel about each free end.
const JN = ['miter', 'round', 'bevel', 'miter-clip', 'arcs'];
// ...those whose end turns tighter than halfW (the radius of curvature at a free end, |d1|^3 / |cross(d1, d2)|)
const radiusAt = ([p0, p1, p2], atStart) => {
  const d1 = atStart
    ? [2 * (p1[0] - p0[0]), 2 * (p1[1] - p0[1])]
    : [2 * (p2[0] - p1[0]), 2 * (p2[1] - p1[1])];
  const d2 = [2 * (p0[0] - 2 * p1[0] + p2[0]), 2 * (p0[1] - 2 * p1[1] + p2[1])],
    c = Math.abs(d1[0] * d2[1] - d1[1] * d2[0]);
  return c > 0 ? Math.hypot(d1[0], d1[1]) ** 3 / c : Infinity;
};
const CASES = makeCurveCases()
  .slice(0, 300)
  .filter(
    (c) =>
      !c.closed &&
      c.joinStyle !== 4 &&
      Math.min(radiusAt(c.Q[0], true), radiusAt(c.Q[c.Q.length - 1], false)) < c.halfW,
  );
const referenceByCase = new WeakMap();
async function score(glsl, S, list = CASES, cubic = false) {
  const emu = EMU.buildGlslEmu(ROOT, { stroke: true, glsl }),
    exact = hasExact(glsl);
  let n = 0,
    lost = 0,
    sum = 0,
    at = '';
  for (const cs of list) {
    const ml = Math.max(cs.miterLimit, 1),
      R = cs.halfW * Math.sqrt(ml * ml + 1) + 2;
    let rx0 = Infinity,
      ry0 = Infinity;
    for (const q of cs.Q)
      for (const p of q) {
        rx0 = Math.min(rx0, p[0]);
        ry0 = Math.min(ry0, p[1]);
      }
    const off = [Math.ceil(R + 2 - rx0) + 0.37, Math.ceil(R + 2 - ry0) + 0.61],
      mv = (p) => [p[0] + off[0], p[1] + off[1]];
    let d = '';
    cs.Q.forEach(([p0, p1, p2], k) => {
      const a = mv(p0),
        b = mv(p1),
        c = mv(p2);
      d +=
        (k === 0 ? `M ${a[0]} ${a[1]} ` : '') +
        (cubic
          ? `C ${a[0] + (2 / 3) * (b[0] - a[0])} ${a[1] + (2 / 3) * (b[1] - a[1])} ${c[0] + (2 / 3) * (b[0] - c[0])} ${c[1] + (2 / 3) * (b[1] - c[1])} ${c[0]} ${c[1]} `
          : `Q ${b[0]} ${b[1]} ${c[0]} ${c[1]} `);
    });
    const W = 128;
    const B = strokeRowsOf(
      await importSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W * S}" height="${W * S}" viewBox="0 0 ${W * S} ${W * S}"><g transform="scale(${S})"><path d="${d}" fill="none" stroke="#000" stroke-width="${2 * cs.halfW}" stroke-linejoin="${JN[cs.joinStyle]}" stroke-linecap="${CAPS[cs.cap]}" stroke-miterlimit="${cs.miterLimit}"/></g></svg>`,
        { preserveViewport: true },
      ),
    );
    const pix = [];
    const Rw = 2 * cs.halfW + 3; // the normals past an end reach at most 2 halfW from it
    for (const V of [mv(cs.Q[0][0]), mv(cs.Q[cs.Q.length - 1][2])])
      for (let y = Math.floor(V[1] - Rw); y <= Math.ceil(V[1] + Rw); y++)
        for (let x = Math.floor(V[0] - Rw); x <= Math.ceil(V[0] + Rw); x++) pix.push([x, y]);
    // The reference grid depends only on cs, independently of shader, scale
    // and degree elevation. Share its oracle values across those runs.
    let reference = referenceByCase.get(cs);
    if (!reference) {
      reference = Float64Array.from(pix, ([x, y]) =>
        refCov(
          (p) =>
            svgInsideCurve(
              [p[0] - off[0], p[1] - off[1]],
              cs.segs,
              false,
              cs.halfW,
              cs.cap,
              cs.joinStyle,
              cs.miterLimit,
            ),
          (a, b) => [a, b],
          x,
          y,
        ),
      );
      referenceByCase.set(cs, reference);
    }
    const cov = mainCov(emu, B, B.rows[0], pix, S, exact);
    pix.forEach(([x, y], i) => {
      const r = reference[i];
      if (r === 0 && cov[i] === 0) return;
      n++;
      sum += Math.abs(cov[i] - r);
      if (r >= 0.75 && cov[i] < 0.25) {
        lost++;
        if (!at)
          at = `${d} ${CAPS[cs.cap]} hw ${cs.halfW} px ${x},${y}: ${cov[i].toFixed(3)} for ${r.toFixed(3)}`;
      }
    });
  }
  return { n, lost, sum, at };
}
const now = {},
  LEFT = +(process.env.LEFT || 0);
console.log(`  (${CASES.length} of the 300 seeded chains end tighter than halfW)`);
for (const S of [2 ** -20, 1, 2 ** 20]) {
  const r = (now[S] = await score(GLSL, S, S === 1 ? CASES : CASES.filter((_, i) => i % 4 === 0)));
  ok(
    r.lost <= LEFT,
    `(a) at 2^${Math.log2(S)}: ${r.n} pixels about the free ends of seeded quad chains, ${r.lost} that SVG 2 covers three quarters read under a quarter${r.at ? ' (' + r.at + ')' : ''}`,
  );
}
{
  const r = await score(GLSL.replace(HOOKQ, HOOKQ.replace('if (', 'if (false && ')), 1); // the interior foot off, the end's cap kept
  ok(
    r.lost > 20 && now[1].sum < 0.7 * r.sum,
    `(b, c) without the interior foot: ${r.lost} pixels lost (${r.at}); the summed error ${r.sum.toFixed(2)}, now ${now[1].sum.toFixed(2)}`,
  );
}
{
  // the end's cap off, the interior foot kept: square caps' corners past a body that turns away
  const sq = CASES.filter((c) => c.cap === 2);
  const r = await score(GLSL.replace(ELSEQ, ELSEQ + ' continue;'), 1, sq);
  ok(
    r.lost > 0,
    `(c) without the end's cap for an interior closest point: ${r.lost} pixels lost at square caps (${r.at})`,
  );
}
// ---- (d) the cubic solver ----
for (const S of [1, 2 ** 20]) {
  const r = await score(GLSL, S, S === 1 ? CASES : CASES.filter((_, i) => i % 4 === 0), true);
  ok(
    r.lost <= LEFT,
    `(d) at 2^${Math.log2(S)}: ${r.n} pixels about the same chains as cubics, ${r.lost} lost${r.at ? ' (' + r.at + ')' : ''}; summed ${r.sum.toFixed(2)}`,
  );
}
{
  const r = await score(
    GLSL.replace(HOOKC, HOOKC.replace('if (', 'if (false && ')),
    1,
    CASES,
    true,
  );
  ok(
    r.lost > 20,
    `(d) without the cubic's interior foot: ${r.lost} pixels lost (${r.at}); summed ${r.sum.toFixed(2)}`,
  );
}
console.log(fail ? `STROKE-CURVE-FOLD-END FAIL (${fail})` : 'STROKE-CURVE-FOLD-END PASS');
process.exit(fail ? 1 : 0);
