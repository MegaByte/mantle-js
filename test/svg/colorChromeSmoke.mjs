// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colorChromeSmoke -- CSS color parsing and compositing against Chrome (`none` and negative saturation, color-mix,
// light-dark(), system colors, calc(), relative color syntax, malformed colors fall back, the clear color is straight
// alpha, a premultipliedAlpha:false context is reported), CPU only.
//
// 1. test/fixtures/colorChrome.json is Chrome's own answer for ~650 color strings, generated once by
//    a generator run in Chrome: each string as an SVG presentation attribute, whether Chrome
//    KEEPS it (valid) or ignores it (the element then inherits), and the sRGB8 pixel it paints over opaque white (w) and over opaque black (k).
//    Every entry is asserted: validity through cssDecl.isColorValue (the gate the cascade uses) and, for a valid one, the premultiplied pixels
//    over white and black within 1/255 (8-bit rounding of alpha).
// 2. The importer: an invalid color is dropped and the element inherits; `currentcolor` named inside a color function is resolved from the
//    element's `color`.
// 3. The frame clear is straight alpha (premultiplied for the GL canvas, written as rgba() by the native scene and the export) and a context
//    made with premultipliedAlpha:false is reported.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { parseColor, parseColorStrict, setColorCompat } =
  await import('../../src/svg/color.js').then((m) => ({
    parseColor: m.parseColor,
    parseColorStrict: m.parseColorStrict || ((s) => m.parseColor(s)),
    setColorCompat: m.setColorCompat,
  }));
const { isColorValue } = await import('../../src/svg/cssDecl.js');
const { default: importSvg } = await import('../../src/svg/importer.js');
const { parseMetaBin } = await import('../../src/renderer/bundle.js');

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const check = (good, msg) => {
  if (good) console.log('  ok ' + msg);
  else fail(msg);
};

// ---- 1. Chrome's table -------------------------------------------------------------------------------------------------------------
const fixture = JSON.parse(
  fs.readFileSync(path.join(HERE, '..', 'fixtures', 'colorChrome.json'), 'utf8'),
);
{
  // Chrome's table is Chrome's: it rejects AccentColor / AccentColorText, which CSS Color 4 defines (valid by default; see specDefaultSmoke).
  setColorCompat('chrome');
  let n = 0,
    validBad = [],
    pixelBad = [];
  for (const e of fixture.entries) {
    n++;
    if (isColorValue(e.c) !== e.valid) {
      validBad.push(`${JSON.stringify(e.c)}: Chrome ${e.valid ? 'keeps' : 'drops'} it`);
      continue;
    }
    if (!e.valid || /currentcolor/i.test(e.c)) continue; // currentcolor in a function is substituted by the importer (section 2)
    const [r, g, b, a] = parseColorStrict(e.c);
    const W = [r, g, b].map((x) => Math.round(255 * (x * a + (1 - a)))),
      K = [r, g, b].map((x) => Math.round(255 * x * a));
    const d = Math.max(
      ...W.map((x, i) => Math.abs(x - e.w[i])),
      ...K.map((x, i) => Math.abs(x - e.k[i])),
    );
    if (d > 1)
      pixelBad.push(
        `${JSON.stringify(e.c)}: over white [${W}] over black [${K}], Chrome [${e.w}] [${e.k}]`,
      );
  }
  console.log(`Chrome table: ${n} strings (${fixture.chrome})`);
  check(
    validBad.length === 0,
    `validity matches Chrome for all ${n} strings` +
      (validBad.length
        ? `; ${validBad.length} differ:\n    ` + validBad.slice(0, 25).join('\n    ')
        : ''),
  );
  check(
    pixelBad.length === 0,
    'the painted pixels match Chrome within 1/255' +
      (pixelBad.length
        ? `; ${pixelBad.length} differ:\n    ` + pixelBad.slice(0, 25).join('\n    ')
        : ''),
  );
  setColorCompat('spec');
}

// ---- 2. the importer ---------------------------------------------------------------------------------------------------------------
async function fills(body) {
  const b = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`,
    { preserveViewport: true },
  );
  const st = b.metaFloatsPerShape,
    mf = parseMetaBin(b.meta, st).metaFloats,
    out = [];
  for (let r = 0; r < mf.length / st; r++) {
    const o = r * st,
      flags = Math.round(mf[o + 27]);
    if (flags & (256 | 64 | 128)) continue;
    out.push(Array.from(mf.slice(o + 4, o + 8)).map((v) => +v.toFixed(3)));
  }
  return out;
}
const near = (a, b) =>
  !!a && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.004);
const warn = console.warn;
const warned = [];
console.warn = (...a) => {
  warned.push(a.join(' '));
};
console.log('the importer');
for (const [bad, why] of [
  ['rgb(1,2)', 'two channels'],
  ['rgb(255,0,0,)', 'trailing comma'],
  ['hsl(120,100,50)', 'legacy hsl without %'],
  ['rgba(255 0 0 .5)', 'modern rgba without a slash'],
  ['color-mix(in srgb, red 120%, blue)', 'percentage over 100'],
]) {
  const [f] = await fills(`<g fill="#0a0"><rect width="9" height="9" fill="${bad}"/></g>`);
  check(
    near(f, [0, 0.667, 0, 1]),
    `fill="${bad}" (${why}) is dropped: the rect inherits the parent's green (got ${JSON.stringify(f)})`,
  );
  const [s] = await fills(
    `<style>g{fill:#0a0}rect{fill:${bad}}</style><g><rect width="9" height="9"/></g>`,
  );
  check(near(s, [0, 0.667, 0, 1]), `a stylesheet rule fill:${bad} is dropped too`);
}
{
  const [f] = await fills(
    '<g color="#f00"><rect width="9" height="9" fill="color-mix(in srgb, currentcolor, blue)"/></g>',
  );
  check(
    near(f, [0.5, 0, 0.5, 1]),
    `color-mix(in srgb, currentcolor, blue) under color:#f00 mixes the element's color (got ${JSON.stringify(f)})`,
  );
  const [g] = await fills(
    '<g color="#0000ff"><rect width="9" height="9" style="fill: rgb(from currentcolor 255 g b)"/></g>',
  );
  check(
    near(g, [1, 0, 1, 1]),
    `rgb(from currentcolor 255 g b) under color:blue (got ${JSON.stringify(g)})`,
  );
  const [h] = await fills('<rect width="9" height="9" fill="light-dark(#08f, red)"/>');
  check(
    near(h, [0, 0.533, 1, 1]),
    `light-dark(#08f, red) is the light value (got ${JSON.stringify(h)})`,
  );
  const before = warned.length;
  await fills('<rect width="9" height="9" fill="color-mix(in srgb, currentcolor, blue)"/>');
  check(warned.length === before, 'a resolved currentcolor does not warn');
}
console.warn = warn;

// ---- 3. the clear color and the context attributes -----------------------------------------------------------------------------------------
{
  const { M, mkRenderer, exportDetail } = await import('../_exportHarness.mjs');
  const { createFakeGl, taggedShaderSources } = await import('../_fakeGl.mjs');
  console.log('the frame clear and the canvas');
  const F = createFakeGl({ width: 32, height: 32 });
  const calls = [];
  const gl = new Proxy(F.gl, {
    get: (t, k) =>
      k === 'clearColor'
        ? (...a) => {
            calls.push(a);
          }
        : t[k],
  });
  const R = M.createRenderer(gl, taggedShaderSources(), { captureFrames: true });
  if (R.ready) await R.ready;
  R.setViewport(32, 32);
  R.beginFrame([1, 0, 0, 0.5]);
  R.endFrame();
  const c = calls[calls.length - 1] || [];
  check(
    c.length === 4 &&
      Math.abs(c[0] - 0.5) < 1e-6 &&
      c[1] === 0 &&
      c[2] === 0 &&
      Math.abs(c[3] - 0.5) < 1e-6,
    `beginFrame([1,0,0,.5]) clears the premultiplied canvas to (.5,0,0,.5) (got ${JSON.stringify(c)})`,
  );
  // The documented clear is four numbers; a three-number clear is rejected by the argument check (lifecycle contract).
  let threw = false;
  try {
    R.beginFrame([0.2, 0.4, 0.6]);
    R.endFrame();
  } catch (e) {
    threw = /clearColor/.test(String(e.message));
  }
  check(threw, 'a three-number clear throws (clearColor must be [r, g, b, a])');
  R.beginFrame([1, 1, 1, 0]);
  R.endFrame();
  const c0 = calls[calls.length - 1] || [];
  check(
    c0.every((v) => v === 0),
    `[1,1,1,0] clears to transparent black, a valid premultiplied value (got ${JSON.stringify(c0)})`,
  );
  R.beginFrame([1, 0, 0, 0.5]);
  R.endFrame();
  const r = await exportDetail(R);
  check(
    /rgba\(255,0,0,0\.5\)/.test(r.svg),
    'the export writes the same clear as straight rgba(255,0,0,0.5) (what the GL canvas now shows)',
  );

  const seen = [];
  const w0 = console.warn;
  console.warn = (...a) => {
    seen.push(a.join(' '));
  };
  const bad = new Proxy(createFakeGl({ width: 8, height: 8 }).gl, {
    get: (t, k) =>
      k === 'getContextAttributes'
        ? () => ({ alpha: true, premultipliedAlpha: false, depth: true, stencil: true })
        : t[k],
  });
  const R2 = M.createRenderer(bad, taggedShaderSources(), {});
  console.warn = w0;
  check(
    seen.some((m) => /premultipliedAlpha:false/.test(m)),
    'a premultipliedAlpha:false context is reported at createRenderer',
  );
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(
  '\ncolorChromeSmoke: the color grammar matches Chrome, an invalid color falls back, the clear is straight alpha',
);
