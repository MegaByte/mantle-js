// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// scaleRangeRenderSmoke -- the GPU half of the scale-range checks (scaleRangeSmoke is the CPU half).
// Every cell draws the same picture at model scale S (every authored length times S; the viewBox, stroke widths, gradient vectors,
// pattern tiles, blur sigmas and filter regions scale with it; the device stays 128 px) and must equal the scale-1 control of that
// cell to 2/255. A scale-dependent constant shows up as a cell that differs from its control. Slug and AAC are pinned.
//   bboxGrad     objectBoundingBox gradient (a 1e-6 floor on the bbox extent):   2^-20, 2^-28, 2^20, and unit-sized art at 2^-20
//   blur/shadow  blur and drop shadow sigma (1e-6 / 1e-12 floors on the bundle size): 2^-20, 2^-28, 2^20
//   radial       radial gradient quadratic (B*B left float32):                    2^-36, 2^-28, 2^-20, 2^20, 2^28
//   region       filter region pixel snap (16 double ulps on float32 meta):       S = 1e-6 and 1e12
//   miter        stroke-miterlimit 1e300 (the cover pad is not that many half-widths): the 4-limit picture, 2^-20, 2^-28, 2^20
//   patternMean  a pattern tile of 0.1 px averages to the tile's mean color (not the background): the analytic mean, 2^-20, 2^-28, 2^20
//   shortVector  a gradient vector shorter than a float32 ulp is a hard step:     64 .. 64 + 1e-6 at 1, 2^-20, 2^20
// The documents are built INSIDE the page (scripts/genSmokeAssets.mjs derives a fixture from every <svg> string a smoke builds at module scope).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT =
  process.env.MANTLE_SRC_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 128;
const ARMS = (process.env.SCALE_ARMS || 'slug,aac').split(',');
const only = process.env.SCALE_ONLY ? new Set(process.env.SCALE_ONLY.split(',')) : null;
// [case, scales]: a scale is a number, or '2^k'.
const CELLS = [
  ['bboxGrad', [-20, -28, 20]],
  ['bboxGradUnit', [-20]],
  ['blur', [-20, -28, 20]],
  ['shadow', [-20, -28, 20]],
  ['radial', [-36, -28, -20, 20, 28]],
  ['region', ['1e-6', '1e12', -20, 20]],
  ['miter', [-20, -28, 20]],
  ['patternMean', [-20, -28, 20]],
  ['shortVector', [-20, 20]],
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script>globalThis.__MANTLE_DEBUG__ = true;</script>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
const f = String;
const sc = (S, v) => f(v * S);
const open = (S, o, w) => '<' + 'svg xmlns="http://www.w3.org/2000/svg" viewBox="' + f(o) + ' ' + f(o) + ' ' + f(w * S) + ' ' + f(w * S) + '" width="${N}" height="${N}">';
const BG = (S, o) => '<rect x="' + f(o) + '" y="' + f(o) + '" width="' + sc(S, 128) + '" height="' + sc(S, 128) + '" fill="#e8e8e8"/>';
const SQ = (S, o, a = '', u = 1) => '<path d="M' + f(10 * S * u + o) + ' ' + f(10 * S * u + o) + ' H' + f(118 * S * u + o) + ' V' + f(118 * S * u + o) + ' H' + f(10 * S * u + o) + ' Z" ' + a + '/>';
const G2 = (id, a) => '<linearGradient id="' + id + '" ' + a + '><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>';
// Each case: (S, o, v) => the svg text. v = the case variant ('control' draws the scale-1 reference of a case whose picture is not S-times the art).
const CASES = {
  bboxGrad: (S, o) => open(S, o, 128) + BG(S, o) + '<defs>' + G2('g', '') + '</defs>' + SQ(S, o, 'fill="url(#g)"') + '</svg>',
  bboxGradUnit: (S, o) => open(S, o, 1) + '<rect x="' + f(o) + '" y="' + f(o) + '" width="' + f(S) + '" height="' + f(S) + '" fill="#e8e8e8"/><defs>' + G2('g', '') + '</defs>' + SQ(S, o, 'fill="url(#g)"', 1 / 128) + '</svg>',
  blur: (S, o) => open(S, o, 128) + BG(S, o) + '<defs><filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="' + sc(S, 6) + '"/></filter></defs>'
    + '<circle cx="' + f(64 * S + o) + '" cy="' + f(64 * S + o) + '" r="' + sc(S, 30) + '" fill="#c00" filter="url(#f)"/></svg>',
  shadow: (S, o) => open(S, o, 128) + BG(S, o) + '<defs><filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="' + sc(S, 8) + '" dy="' + sc(S, 8) + '" stdDeviation="' + sc(S, 4) + '" flood-color="#000"/></filter></defs>'
    + '<rect x="' + f(30 * S + o) + '" y="' + f(30 * S + o) + '" width="' + sc(S, 50) + '" height="' + sc(S, 50) + '" fill="#c00" filter="url(#f)"/></svg>',
  radial: (S, o) => open(S, o, 128) + BG(S, o) + '<defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="' + f(64 * S + o) + '" cy="' + f(64 * S + o) + '" r="' + sc(S, 54) + '" fx="' + f(44 * S + o) + '" fy="' + f(54 * S + o)
    + '"><stop offset="0" stop-color="#ff0"/><stop offset="1" stop-color="#00f"/></radialGradient></defs>' + SQ(S, o, 'fill="url(#g)"') + '</svg>',
  region: (S, o) => open(S, o, 128) + BG(S, o) + '<defs><filter id="f" filterUnits="userSpaceOnUse" x="' + f(10 * S + o) + '" y="' + f(10 * S + o) + '" width="' + sc(S, 80) + '" height="' + sc(S, 80)
    + '"><feOffset dx="' + sc(S, 10) + '" dy="0"/></filter></defs><path d="M' + f(20 * S + o) + ' ' + f(20 * S + o) + ' H' + f(100 * S + o) + ' V' + f(100 * S + o) + ' H' + f(20 * S + o) + ' Z" fill="#c00" filter="url(#f)"/></svg>',
  // a 53 degree corner, miter limit 1e300 at scale S, against the same corner at limit 4 at scale 1 (both miter)
  miter: (S, o, v) => open(S, o, 128) + BG(S, o) + '<path d="M' + f(20 * S + o) + ' ' + f(100 * S + o) + ' L' + f(60 * S + o) + ' ' + f(20 * S + o) + ' L' + f(100 * S + o) + ' ' + f(100 * S + o)
    + '" fill="none" stroke="#c0392b" stroke-width="' + sc(S, 8) + '" stroke-linejoin="miter" stroke-miterlimit="' + (v === 'control' ? '4' : '1e300') + '"/></svg>',
  // red and blue quarters of a tile of 0.1 px
  patternMean: (S, o) => open(S, o, 128) + BG(S, o) + '<defs><pattern id="p" patternUnits="userSpaceOnUse" x="' + f(o) + '" y="' + f(o) + '" width="' + sc(S, 0.1) + '" height="' + sc(S, 0.1) + '"><rect width="' + sc(S, 0.05) + '" height="' + sc(S, 0.05)
    + '" fill="#c00"/><rect x="' + sc(S, 0.05) + '" y="' + sc(S, 0.05) + '" width="' + sc(S, 0.05) + '" height="' + sc(S, 0.05) + '" fill="#00c"/></pattern></defs>' + SQ(S, o, 'fill="url(#p)"') + '</svg>',
  // a vector from 64 to 64 + 1e-6 (below a float32 ulp at 64): red left of 64, blue right
  shortVector: (S, o) => open(S, o, 128) + BG(S, o) + '<defs>' + G2('g', 'gradientUnits="userSpaceOnUse" x1="' + f(64 * S + o) + '" y1="0" x2="' + f((64 + 1e-6) * S + o) + '" y2="0"') + '</defs>' + SQ(S, o, 'fill="url(#g)"') + '</svg>',
};
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
window.__cell = async (name, S, kernel, variant) => {
  R.setFillEngine({ route: 'none', kernel });
  const svg = CASES[name](S, 0, variant);
  let b;
  try { b = createBundle(gl, await importSvg(svg, { preserveViewport: true })); } catch (e) { return { err: 'import: ' + e.message }; }
  const err = [];
  try {
    R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
    if (R.prepareBundle) R.prepareBundle(b);
    // warm until a whole pass builds nothing: a program variant (the sub-pixel pattern tile's) may still be compiling, and a draw that
    // lands before it is ready uses the base program
    const frame = () => { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); };
    await R.warmScene([{ draw: frame }], { maxPasses: 16 });
    frame();
  } catch (e) { err.push('draw ' + e.message); }
  const px = new Uint8Array(${N} * ${N} * 4);
  gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const glErr = gl.getError();
  b.dispose && b.dispose();
  return { px: b64(px), err: err.join(';') || (glErr ? 'gl ' + glErr : '') };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { launchBrowser } = await import('./_launch.mjs');
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 90000, polling: 100 });

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const cell = async (name, S, kernel, variant) => {
  const r = await page.evaluate(
    (a, b, c, d) => window.__cell(a, b, c, d),
    name,
    S,
    kernel,
    variant,
  );
  if (r.px) r.px = new Uint8Array(Buffer.from(r.px, 'base64'));
  return r;
};
const maxDiff = (a, b) => {
  let m = 0,
    n = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
    if (d > 40) n++;
  }
  return [m, n];
};
const at = (px, x, y) => {
  const i = ((N - 1 - y) * N + x) * 4;
  return [px[i], px[i + 1], px[i + 2]];
};
const block = (px, x0, y0, w, h) => {
  const s = [0, 0, 0];
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) {
      const p = at(px, x, y);
      s[0] += p[0];
      s[1] += p[1];
      s[2] += p[2];
    }
  return s.map((v) => v / (w * h));
};
const TOL = 2;
for (const kernel of ARMS) {
  for (const [name, scales] of CELLS) {
    if (only && !only.has(name)) continue;
    const control = await cell(name, 1, kernel, 'control');
    if (!control.px || control.err) {
      fail(kernel + ' ' + name + ' control: ' + control.err);
      continue;
    }
    // the analytic expectations of the control (and so of every cell that equals it)
    if (name === 'patternMean') {
      const m = block(control.px, 60, 60, 8, 8),
        want = [167, 116, 167];
      if (m.every((v, i) => Math.abs(v - want[i]) <= 3))
        ok(
          kernel +
            ' patternMean control: a 0.1 px tile reads its mean (' +
            m.map((v) => v.toFixed(0)) +
            ')',
        );
      else
        fail(
          kernel +
            ' patternMean control: a 0.1 px tile reads (' +
            m.map((v) => v.toFixed(0)) +
            '), the mean is (' +
            want +
            ') (it faded to the background 232,232,232)',
        );
    }
    if (name === 'shortVector') {
      const l = at(control.px, 30, 64),
        r = at(control.px, 100, 64);
      if (l[0] > 240 && l[2] < 15 && r[0] < 15 && r[2] > 240)
        ok(kernel + ' shortVector control: red left of the step, blue right');
      else
        fail(
          kernel +
            ' shortVector control: left ' +
            l +
            ' right ' +
            r +
            ' (red / blue expected; a solid last stop is the zero-length vector)',
        );
    }
    if (name === 'miter') {
      const ink = (px) => {
        let n = 0;
        for (let y = 6; y < 20; y++)
          for (let x = 52; x < 68; x++) n += (232 - at(px, x, y)[0]) / 40;
        return n / (14 * 16);
      };
      const v = ink(control.px);
      if (!(v > 0.1))
        fail(kernel + ' miter control: the 4-limit miter tip has no ink (' + v.toFixed(2) + ')');
    }
    for (const sc of scales) {
      const S = typeof sc === 'string' ? +sc : 2 ** sc;
      const label = kernel + ' ' + name + ' S=' + (typeof sc === 'string' ? sc : '2^' + sc);
      const r = await cell(name, S, kernel, 'cell');
      if (!r.px || r.err) {
        fail(label + ': ' + r.err);
        continue;
      }
      const [m, n] = maxDiff(r.px, control.px);
      if (m <= TOL) ok(label + ' equals the scale-1 control (max ' + m + ')');
      else fail(label + ' differs from the scale-1 control: max ' + m + ', ' + n + ' px over 40');
    }
  }
}
await browser.close();
server.close();
if (failures) {
  console.error('SCALE RANGE (GPU) FAIL (' + failures + ')');
  process.exit(1);
}
console.log('SCALE RANGE (GPU) PASS');
