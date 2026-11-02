// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphFullTurnReanchorSmoke.mjs -- a full-turn arc (<circle>/<ellipse>) morphing against an arc that starts elsewhere must
// start where that arc starts.
//
// A full turn has no start of its own, but its record stores one: the two ends of the arc (texel 3), which the shader trusts for
// its crossing counts, and which the morph lerps componentwise. Pairing a circle whose start is (cx + r, cy) with the same circle
// authored from (cx - r, cy) would lerp the circle's ends to the midpoint of the two starts -- the CENTER, off the ellipse -- and
// the pose at t = 0.5 would have a collapsed interior: a blank frame (from top or bottom, half ink). So the morph re-anchors the full-turn
// side's theta_start to the parametric angle of the other side's start point on its own ellipse, phi-aware, so the ends of every
// lerped record stay on the lerped ellipse.
//
// The check is on the records the morph interpolates (the planes the CPU lerp and the GPU pre-pass both read): at t = .25, .5
// and .75 the lerped record's stored start must lie on the lerped ellipse (|R(-phi)(p - c) / r| = 1, a dimensionless ratio),
// and the angle theta_start must name that same point. Four starts, both directions of the pair, a rotated ellipse, and the
// whole picture authored at 2^-20, 1 and 2^20 units. GPU: test/morphFullTurnReanchorRenderSmoke.mjs.

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { default: importSvg } = await import('../src/svg/importer.js');
const { createFakeGl } = await import('./_fakeGl.mjs');
const { createShapeMorph } = await import('../src/animation/shapeMorph.js');
const { createBundle } = await import('../src/renderer/bundle.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const st = 'id="s" fill="#000"';
const svg = (b, k) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${100 * k} ${100 * k}">${b}</svg>`;
// one-arc paths over the ellipse (cx, cy, rx, ry) from +x, -x, top, bottom, clockwise on screen, ends a hair apart
const arcFrom = (k, cx, cy, rx, ry, which) => {
  const e = 0.0002,
    a = (th) => `${(cx + rx * Math.cos(th)) * k} ${(cy + ry * Math.sin(th)) * k}`;
  const t0 = { '+x': e, '-x': Math.PI + e, top: -Math.PI / 2 + e, bottom: Math.PI / 2 + e }[which];
  return `M ${a(t0)} A ${rx * k} ${ry * k} 0 1 1 ${a(t0 + 2 * Math.PI - 2 * e)}`;
};
// the first arc record (header float offset) in a curve plane
const find = (buf) => {
  for (let i = 4; i + 20 <= buf.length; i += 4) if ((buf[i] & 3) === 3 && buf[i + 6] > 0) return i;
  return -1;
};

for (const k of [2 ** -20, 1, 2 ** 20]) {
  for (const [name, rx, ry, rot] of [
    ['circle', 30, 30, false],
    ['ellipse 40x22', 40, 22, false],
    ['ellipse 40x22 rotated 30', 40, 22, true],
  ]) {
    for (const which of ['+x', '-x', 'top', 'bottom']) {
      for (const dir of ['full->arc', 'arc->full']) {
        const tf = rot ? ` transform="rotate(30 ${50 * k} ${50 * k})"` : '';
        const full = `<ellipse ${st} cx="${50 * k}" cy="${50 * k}" rx="${rx * k}" ry="${ry * k}"${tf}/>`;
        const arc = `<path ${st} d="${arcFrom(k, 50, 50, rx, ry, which)}"${tf}/>`;
        const { gl } = createFakeGl();
        const A = createBundle(gl, await importSvg(svg(dir === 'full->arc' ? full : arc, k)));
        const B = createBundle(gl, await importSvg(svg(dir === 'full->arc' ? arc : full, k)));
        const m = createShapeMorph(gl, A, B);
        const ms = m._morphSrc || (m.bundle && m.bundle._morphSrc);
        const s = ms.mergedCurveF32,
          d = ms.dstCurveF32,
          o = find(s);
        if (!ms.matchedAll || o < 0 || find(d) !== o) {
          ok(
            false,
            `${name} ${which} ${dir} @2^${Math.log2(k)}: the pair did not match (matchedAll ${ms.matchedAll})`,
          );
          continue;
        }
        let worstOn = 0,
          worstTh = 0;
        for (const t of [0.25, 0.5, 0.75]) {
          const L = (i) => s[o + i] * (1 - t) + d[o + i] * t;
          const cx = L(4),
            cy = L(5),
            rxL = L(6),
            ryL = L(7),
            th0 = L(8),
            phi = L(10),
            px = L(12),
            py = L(13);
          const cp = Math.cos(phi),
            sp = Math.sin(phi),
            dx = px - cx,
            dy = py - cy;
          const u = (cp * dx + sp * dy) / rxL,
            v = (-sp * dx + cp * dy) / ryL;
          worstOn = Math.max(worstOn, Math.abs(Math.hypot(u, v) - 1));
          // theta_start names the stored start: cos/sin of it against the normalized offset
          worstTh = Math.max(worstTh, Math.hypot(u - Math.cos(th0), v - Math.sin(th0)));
        }
        ok(
          worstOn <= 1e-3 && worstTh <= 1e-3,
          `${name} ${which} ${dir} @2^${Math.log2(k)}: lerped start on the lerped ellipse (off by ${worstOn.toExponential(1)}), theta_start names it (${worstTh.toExponential(1)})`,
        );
      }
    }
  }
}
if (fail) {
  console.error(`FAIL morphFullTurnReanchorSmoke: ${fail}`);
  process.exit(1);
}
console.log('morphFullTurnReanchorSmoke PASS');
