// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// radialFrSmoke -- the SVG 2 focal radius `fr` of a radialGradient. Record level (CPU): how fr is parsed and carried; the pixels are proved
// against Chrome by paintRowsRenderSmoke.
//   * fr rides as the remainder of the record's spread slot: slot = spread + q / 2, q = fr / (fr + r); round(slot) is still the spread.
//   * a gradient WITHOUT an fr writes the bare spread: its records are byte-identical to an fr-free encoding.
//   * the GLSL solver (_paintSample.glsl gradientT, mirrored below) is checked against a brute-force two-circle evaluation.
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
let failures = 0;
const check = (good, msg) => {
  console.log(`  ${good ? 'ok' : 'FAIL'} ${msg}`);
  if (!good) failures++;
};
let warned = [];
const warn = console.warn;
console.warn = (...a) => warned.push(a.join(' '));
const rec = async (attrs, spread = '', rect = '<rect width="64" height="64" fill="url(#g)"/>') => {
  warned = [];
  const b = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><radialGradient id="g" ${attrs} ${spread}><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></radialGradient></defs>${rect}</svg>`,
    { preserveViewport: true },
  );
  return Array.from(new Float32Array(b.gradients, 0, 16));
};

console.log('records');
{
  let g = await rec('');
  check(g[1] === 0 && g[14] === 0.5, 'no fr: the bare spread (0) and r .5');
  g = await rec('fr="0"', 'spreadMethod="repeat"');
  check(g[1] === 2, 'fr 0, repeat: the bare spread 2 (byte-identical to a gradient with no fr)');
  g = await rec('fr=".2"');
  const q = 0.2 / 0.7;
  check(
    Math.abs(g[1] - 0.5 * q) < 1e-7 && Math.round(g[1]) === 0,
    `fr .2, r .5: slot ${g[1]} = q/2 = ${(0.5 * q).toFixed(6)}, spread reads 0`,
  );
  g = await rec('fr="20%"', 'spreadMethod="reflect"');
  check(
    Math.round(g[1]) === 1 && Math.abs(g[1] - 1 - 0.5 * q) < 2e-7,
    `fr 20%, reflect: spread 1 + q/2 (${g[1]})`,
  );
  g = await rec('fr=".7"', 'spreadMethod="repeat"');
  check(
    Math.round(g[1]) === 2 && g[1] > 2.2 && g[1] < 2.5,
    `fr > r (.7 vs .5): not clamped (slot ${g[1]})`,
  );
  g = await rec('fr="1e12"', 'spreadMethod="repeat"');
  check(
    Math.round(g[1]) === 2 && g[1] < 2.5,
    `an enormous fr keeps the spread readable (slot ${g[1]})`,
  );
  g = await rec('fr="-.2"');
  check(g[1] === 0, 'a negative fr is an error and reads as 0');
  g = await rec('fr=".2" r="0"');
  check(g[1] === 0 && warned.some((w) => /fr/.test(w)), 'r = 0 with fr: loud warning, fr ignored');
  g = await rec('gradientUnits="userSpaceOnUse" cx="32" cy="32" r="28" fr="10"');
  check(Math.abs(g[1] - (0.5 * 10) / 38) < 1e-6, 'userSpaceOnUse fr in user units');
  g = await rec('gradientUnits="userSpaceOnUse" cx="32" cy="32" r="28" fr="25%"');
  const diag = Math.sqrt((64 * 64 + 64 * 64) / 2);
  check(
    Math.abs(g[1] - (0.5 * (0.25 * diag)) / (0.25 * diag + 28)) < 1e-6,
    'a percentage fr is of the normalized diagonal, as r is',
  );
  warned = [];
  const b = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><radialGradient id="g" fr=".2"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></radialGradient><radialGradient id="h" href="#g"/></defs><rect width="32" height="64" fill="url(#h)"/></svg>',
    { preserveViewport: true },
  );
  const hg = new Float32Array(b.gradients, 0, 16);
  check(Math.abs(hg[1] - 0.5 * q) < 1e-7, 'fr is inherited through href');
}

console.log('the solver against brute force');
// A mirror of gradientT's fr branch (float64).
function solve(p, f, fr, c, r) {
  const cf = [c[0] - f[0], c[1] - f[1]],
    d = [p[0] - f[0], p[1] - f[1]];
  const dr = r - fr,
    qa = cf[0] * cf[0] + cf[1] * cf[1] - dr * dr,
    qb = d[0] * cf[0] + d[1] * cf[1] + fr * dr,
    qc = d[0] * d[0] + d[1] * d[1] - fr * fr;
  const qd = qb * qb - qa * qc;
  if (dr === 0 && qa === 0 && qb === 0) return qc < 0 ? 0 : 1;
  if (qd < 0) return null; // (the shader returns the double root b / a here for the cone edge's AA; its coverage is 0 past the pixel)
  const sq = Math.sqrt(qd),
    m = qb + (qb >= 0 ? sq : -sq);
  const t1 = m !== 0 ? qc / m : 0,
    ok1 = m !== 0 && fr + t1 * dr >= 0;
  let t2 = 0,
    ok2 =
      m !== 0 &&
      Math.abs(qa) > 1e-6 * (cf[0] * cf[0] + cf[1] * cf[1] + dr * dr) &&
      Math.abs(qa) * 1e12 > Math.abs(m);
  if (ok2) {
    t2 = m / qa;
    ok2 = fr + t2 * dr >= 0;
  }
  if (!ok1 && !ok2) return null;
  return ok1 && ok2 ? Math.max(t1, t2) : ok1 ? t1 : t2;
}
/// The largest t in [-T, T] whose circle passes through p with a non-negative radius, found by scanning the signed distance for sign changes.
function brute(p, f, fr, c, r) {
  const g = (t) =>
    Math.hypot(p[0] - (f[0] + t * (c[0] - f[0])), p[1] - (f[1] + t * (c[1] - f[1]))) -
    (fr + t * (r - fr));
  const T = 60,
    N = 24000;
  let best = null,
    prev = g(T),
    pt = T;
  for (let i = 1; i <= N; i++) {
    const t = T - (2 * T * i) / N,
      v = g(t);
    if ((prev === 0 || prev > 0 !== v > 0) && fr + pt * (r - fr) >= -1e-9) {
      // refine by bisection
      let lo = t,
        hi = pt;
      for (let k = 0; k < 60; k++) {
        const mid = 0.5 * (lo + hi);
        if (g(mid) > 0 === g(lo) > 0) lo = mid;
        else hi = mid;
      }
      const tr = 0.5 * (lo + hi);
      if (fr + tr * (r - fr) >= -1e-9) {
        best = tr;
        break;
      }
    }
    prev = v;
    pt = t;
  }
  return best;
}
{
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  let n = 0,
    bad = 0,
    nullMismatch = 0,
    worst = 0;
  for (let k = 0; k < 3000; k++) {
    const c = [rnd(), rnd()],
      f = [
        c[0] + (rnd() - 0.5) * (k % 3 ? 0.6 : 0.05),
        c[1] + (rnd() - 0.5) * (k % 3 ? 0.6 : 0.05),
      ];
    const r = 0.1 + rnd() * 0.6,
      fr = rnd() < 0.2 ? r * (1 + rnd()) : rnd() * r;
    const p = [rnd() * 1.4 - 0.2, rnd() * 1.4 - 0.2];
    const a = solve(p, f, fr, c, r),
      b = brute(p, f, fr, c, r);
    if (a !== null && Math.abs(a) > 50) continue; // beyond the brute-force window (|t| <= 60)
    n++;
    if ((a === null) !== (b === null)) {
      nullMismatch++;
      if (nullMismatch < 4) console.log('   mismatch', JSON.stringify({ p, f, fr, c, r, a, b }));
      continue;
    }
    if (a !== null) {
      const e = Math.abs(a - b);
      worst = Math.max(worst, e);
      if (e > 1e-6) bad++;
    }
  }
  check(
    bad === 0 && nullMismatch <= 3,
    `${n} random circles: ${bad} roots off (worst ${worst.toExponential(2)}), ${nullMismatch} painted-vs-not disagreements (tangent edges only)`,
  );
}
{
  // The focal circle internally tangent to the end circle (|c - f| = r - fr: the quadratic term vanishes), the case that sent a point to t = 1e8.
  const c = [0.5, 0.5],
    f = [0.9, 0.5],
    fr = 0.1,
    r = 0.5;
  let bad = 0,
    n = 0;
  for (let i = 0; i < 400; i++) {
    const p = [((i % 20) / 19) * 1.2 - 0.1, (Math.floor(i / 20) / 19) * 1.2 - 0.1];
    const a = solve(p, f, fr, c, r),
      b = brute(p, f, fr, c, r);
    if (a !== null && Math.abs(a) > 50) continue;
    n++;
    if ((a === null) !== (b === null) || (a !== null && Math.abs(a - b) > 1e-6)) bad++;
  }
  check(bad <= 2, `internally tangent circles: ${n} points, ${bad} disagree with brute force`);
}
console.warn = warn;
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('radialFrSmoke: all passed');
