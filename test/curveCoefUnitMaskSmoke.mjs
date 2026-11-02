// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// curveCoefUnitMaskSmoke — a curve-texture Loop-Blinn program drawn by the CLASSIC fill pass never samples an integer
// texture through uCurveCoefTex.
//
// The default route binds a Loop-Blinn variant (MANTLE_LB_CURVE_TEX) even when the classic pass draws the bundle as
// cover quads, and that program declares a float sampler, uCurveCoefTex, on unit 12. Only the unified draw binds a real
// table there. The mask bake owns unit 12 too: it leaves its INTEGER row-to-layer texture on it. A float sampler on an
// integer texture fails draw validation and the draw is dropped, so a luminance-masked bundle would draw a completely
// blank frame at 512 and 2048 px on the default route while every pinned route draws it. So the classic pass binds a
// float texture on the sampler's unit.
//
// HOW: the real renderer on test/_fakeGl.mjs (no GPU). The texture formats and the uniform values are tracked on a proxy;
// after the bundle is warm onto its curve-texture program, the bake's leftover (an integer texture on unit 12) is put in place, and at every
// draw of a program that declares uCurveCoefTex the texture on that sampler's unit must not be an integer format.
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { noteExternalGlWrite } = await import('../src/core/glEpoch.js');
const { importSvg, createBundle, createRenderer } = await import('../src/index.js');
const warn = console.warn;
console.warn = () => {};

// A hand-built masked scene in the shape of the failing asset: a radial-gradient luminance mask over a group of 120 small
// filled shapes bounded by quadratic curves (rounded bars) and a few cubic blobs.
const bars = [];
for (let i = 0; i < 120; i++) {
  const x = -70 + (i % 12) * 12,
    y = -110 + Math.floor(i / 12) * 10;
  bars.push(
    `<path d="M ${x} ${y} L ${x + 8} ${y} Q ${x + 11} ${y} ${x + 11} ${y + 3} Q ${x + 11} ${y + 6} ${x + 8} ${y + 6}` +
      ` L ${x} ${y + 6} Q ${x - 3} ${y + 6} ${x - 3} ${y + 3} Q ${x - 3} ${y} ${x} ${y} Z" fill="#${(0x8e1e1d + i * 0x010203).toString(16).slice(-6)}"/>`,
  );
}
for (let i = 0; i < 6; i++) {
  const cx = -50 + i * 20,
    cy = -8;
  bars.push(
    `<path d="M ${cx - 8} ${cy} C ${cx - 8} ${cy - 9} ${cx + 8} ${cy - 9} ${cx + 8} ${cy} C ${cx + 8} ${cy + 9} ${cx - 8} ${cy + 9} ${cx - 8} ${cy} Z" fill="#226"/>`,
  );
}
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-80 -120 160 120"><defs>' +
  '<radialGradient id="mg" cx="0.5" cy="0.5" r="0.6"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#222"/></radialGradient>' +
  '<mask id="vm" maskUnits="userSpaceOnUse" x="-80" y="-120" width="160" height="120"><rect x="-80" y="-120" width="160" height="120" fill="url(#mg)"/></mask></defs>' +
  `<g mask="url(#vm)"><g>${bars.join('')}</g></g></svg>`;

const N = 512;
const F = createFakeGl({ width: N, height: N });
const base = F.gl;
const ov = {};
const gl = new Proxy(base, {
  get: (t, k) => (k in ov ? ov[k] : t[k]),
  set: (t, k, v) => {
    ov[k] = v;
    return true;
  },
});
const REAL_R32I = 0x823b;
let unit = 0;
const unitTex = {};
const fmt = new Map();
const loc = new Map();
const progUni = new Map();
let cur = null;
const wrap = (fn, f) => {
  const o = base[fn].bind(base);
  ov[fn] = (...a) => {
    f(...a);
    return o(...a);
  };
};
wrap('activeTexture', (u) => {
  unit = u - 0x84c0;
});
wrap('bindTexture', (t, x) => {
  if (t === 0x0de1) unitTex[unit] = x;
});
wrap('texImage2D', (t, l, ifmt) => {
  if (l === 0 && unitTex[unit]) fmt.set(unitTex[unit], ifmt);
});
wrap('texStorage2D', (t, l, ifmt) => {
  if (unitTex[unit]) fmt.set(unitTex[unit], ifmt);
});
{
  const o = base.getUniformLocation.bind(base);
  ov.getUniformLocation = (p, n) => {
    const l = o(p, n);
    if (l && typeof l === 'object') loc.set(l, n);
    return l;
  };
}
wrap('uniform1i', (l, x) => {
  const n = loc.get(l);
  if (n && cur) (progUni.get(cur) || progUni.set(cur, {}).get(cur))[n] = x;
});
wrap('useProgram', (p) => {
  cur = p;
});
let bad = 0,
  checked = 0,
  armed = false;
for (const fn of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
  wrap(fn, () => {
    if (!armed || !cur) return;
    const u = (progUni.get(cur) || {}).uCurveCoefTex;
    if (u === undefined) return;
    checked++;
    if (fmt.get(unitTex[u]) === REAL_R32I) bad++;
  });
}

const r = createRenderer(gl, taggedShaderSources(), { psoWarmIdle: () => true });
r.setViewport(N, N);
const b = createBundle(gl, await importSvg(SVG));
r.prepareBundle(b);
const frame = () => {
  r.beginFrame([1, 1, 1, 1]);
  r.drawBundle(b, {});
  r.endFrame();
};
for (let f = 0; f < 12; f++) {
  frame();
  await new Promise((x) => setTimeout(x, 20));
}
if (r.awaitEngine) {
  try {
    await r.awaitEngine(b, 'auto', 30000);
  } catch {
    /* the draws below still count */
  }
}
for (let f = 0; f < 4; f++) frame();
// What the mask bake leaves behind: its INTEGER row-to-layer texture on unit 12, the unit shadow forgotten (the bake calls
// _forgetFillUnits for exactly this; here the same epoch bump). The fake GL does not order the bake after the coefficient table the way a real
// frame sequence can, so the leftover is put there directly.
const intTex = gl.createTexture();
gl.activeTexture(0x84c0 + 12);
gl.bindTexture(0x0de1, intTex);
gl.texImage2D(0x0de1, 0, REAL_R32I, 1, 1, 0, 0x8d94, 0x1404, new Int32Array(1));
gl.activeTexture(0x84c0);
noteExternalGlWrite(); // the epoch bump the renderer's own _forgetFillUnits makes
armed = true;
frame();
frame();
console.warn = warn;
ok(
  checked > 0,
  `a program declaring uCurveCoefTex was drawn after the leftover (${checked} draws)`,
);
ok(
  bad === 0,
  `no such draw sampled an integer texture through uCurveCoefTex (${bad} of ${checked})`,
);
if (fail) {
  console.log(`curveCoefUnitMaskSmoke: ${fail} FAIL`);
  process.exit(1);
}
console.log('curveCoefUnitMaskSmoke: PASS');
