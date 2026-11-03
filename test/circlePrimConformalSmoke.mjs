// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// circlePrimConformalSmoke — a <circle> takes the circle fast path only where it is still a circle: under a conformal
// transform.
//
// THE TRAP. Tagging every <circle> primKind 1 and leaving the gate to the shader's square-bbox test (and the hit
// test's twin of it, hitTest/fillCoverage.js pointInPrim) is not enough: a non-uniformly scaled circle is an ellipse,
// whose document bbox is not square -- except under a rotation as well: rotate(45) scale(2 1) bakes an ellipse with a
// SQUARE bbox, and the fill would draw, and the hit test answer, the circle inscribed in that box. The stroke's annulus
// fast path (primKind 4) keeps framed rows off it for the same reason.
//
// So the tag needs a conformal CTM (bundle/strokeFrame.js ctmConformal, a relative test), and the shader and the
// hit test, which read the tag, walk the ellipse.
//
// (a) under rotate(45) scale(2 1), rotate(30) scale(3 1), skewX(40) rotate(20) and scale(1 1.0001) rotate(45): the fill
//     row carries no circle tag, and the hit test's Coverage answer at points on a ring about the ellipse matches the
//     true ellipse (points 3% clear of it);
// (b) under identity, rotate(30) scale(2), scale(-2 2) and scale(2) skewX(0): the tag stays, and the answers match.
if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { fillHitShape, HitMode } = await import('../src/hitTest/index.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const D2R = Math.PI / 180;
const mm = (P, Q) => [
  P[0] * Q[0] + P[2] * Q[1],
  P[1] * Q[0] + P[3] * Q[1],
  P[0] * Q[2] + P[2] * Q[3],
  P[1] * Q[2] + P[3] * Q[3],
];
const rot = (d) => [Math.cos(d * D2R), Math.sin(d * D2R), -Math.sin(d * D2R), Math.cos(d * D2R)];
const skx = (d) => [1, 0, Math.tan(d * D2R), 1];
const CASES = [
  { t: 'rotate(45) scale(2 1)', M: mm(rot(45), [2, 0, 0, 1]), conformal: false },
  { t: 'rotate(30) scale(3 1)', M: mm(rot(30), [3, 0, 0, 1]), conformal: false },
  { t: 'skewX(40) rotate(20)', M: mm(skx(40), rot(20)), conformal: false },
  { t: 'scale(1 1.0001) rotate(45)', M: mm([1, 0, 0, 1.0001], rot(45)), conformal: false },
  { t: 'translate(0 0)', M: [1, 0, 0, 1], conformal: true },
  { t: 'rotate(30) scale(2)', M: mm(rot(30), [2, 0, 0, 2]), conformal: true },
  { t: 'scale(-2 2)', M: [-2, 0, 0, 2], conformal: true },
  { t: 'scale(2) skewX(0)', M: [2, 0, 0, 2], conformal: true },
];
const R0 = 10,
  C = [50, 50];
for (const cs of CASES) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">` +
    `<g transform="translate(${C[0]} ${C[1]}) ${cs.t}"><circle cx="0" cy="0" r="${R0}" fill="#f00"/></g></svg>`;
  const b = await importSvg(svg, { preserveViewport: true });
  const meta = new Float32Array(b.meta, 32);
  const prim = meta[44] | 0;
  // points on rings about the ellipse: local radius 0.97 R0 (inside) and 1.03 R0 (outside), mapped through M
  let bad = 0,
    n = 0,
    first = '';
  for (let i = 0; i < 180; i++)
    for (const s of [0.97, 1.03]) {
      const th = (2 * Math.PI * (i + 0.5)) / 180,
        l = [s * R0 * Math.cos(th), s * R0 * Math.sin(th)];
      const p = [C[0] + cs.M[0] * l[0] + cs.M[2] * l[1], C[1] + cs.M[1] * l[0] + cs.M[3] * l[1]];
      const hit = fillHitShape(b, p[0], p[1], { mode: HitMode.Coverage }) >= 0;
      n++;
      if (hit !== s < 1) {
        bad++;
        if (!first)
          first = `local radius ${s} R at ${((th * 180) / Math.PI).toFixed(0)} deg: ${hit ? 'hit' : 'miss'}`;
      }
    }
  const tagOk = cs.conformal ? prim === 1 : prim === 0;
  ok(
    tagOk && bad === 0,
    `(${cs.conformal ? 'b' : 'a'}) ${cs.t}: fill row primKind ${prim} (want ${cs.conformal ? 1 : 0}); the hit test answers ${bad} of ${n} points on the wrong side of the ellipse${first ? ' -- first ' + first : ''}`,
  );
}
// Thin invertible CTMs retain their inverse metric instead of a mean width.
{
  const { strokeFrameOf, ctmSingular } = await import('../src/bundle/strokeFrame.js');
  for (const factor of [2 ** -20, 1, 2 ** 20])
    for (const matrix of [
      [2, 0, 0, 1e-8],
      [1e-8, 0, 0, 2],
      [1, 1, 1, 1 + 1e-8],
      [-2, 0, 0, 1e-8],
    ]) {
      const M = matrix.map((x) => x * factor),
        frame = strokeFrameOf([...M, 0, 0]);
      const N = frame && frame.N;
      const at = (x, y) => [N[0] * x + N[2] * y, N[1] * x + N[3] * y];
      const first = N && at(M[0], M[1]),
        second = N && at(M[2], M[3]);
      ok(
        !ctmSingular(M) &&
          !!N &&
          N.every(Number.isFinite) &&
          frame.sMin > 0 &&
          frame.sMax > frame.sMin &&
          Math.abs(Math.hypot(...first) / frame.sMax - 1) < 1e-6 &&
          Math.abs(Math.hypot(...second) / frame.sMax - 1) < 1e-6,
        'thin invertible CTM preserves both local basis lengths at scale ' + factor,
      );
    }
  for (const M of [
    [1, 1, 1, 1 + 1e-8],
    [1, 0, 0, 1e-100],
  ]) {
    const frame = strokeFrameOf(M);
    ok(
      frame && !frame.representable && !ctmSingular(M),
      'unrepresentable inverse is distinct from conformal and singular CTMs',
    );
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M8 0H24" transform="matrix(${M.join(' ')} 0 32)" fill="none" stroke="red" stroke-width="8"/></svg>`;
    const bundle = await importSvg(svg, { preserveViewport: true });
    const meta = new Float32Array(bundle.meta, 32);
    ok(
      Array.from(meta).every(Number.isFinite),
      'unrepresentable inverse does not enter float32 metadata',
    );
  }
  for (const M of [
    [2, 0, 0, 0],
    [0, 0, 0, 2],
    [1, 1, 1, 1],
    [0, 0, 0, 0],
  ]) {
    ok(
      ctmSingular(M) && strokeFrameOf(M) === null,
      'exact singularity is distinguished from thin invertibility',
    );
  }
}
console.log(fail ? `CIRCLE-PRIM-CONFORMAL FAIL (${fail})` : 'CIRCLE-PRIM-CONFORMAL PASS');
process.exit(fail ? 1 : 0);
