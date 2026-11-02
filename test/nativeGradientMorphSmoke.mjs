// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeGradientMorphSmoke.mjs -- the native (no-WebGL) morph interpolates a matched shape's gradient stops and parameters
// the way the WebGL morph does. Without a gradient channel in the native override table a gradient fill would
// keep its source value at every t, including t = 1 (README "What interpolates").
//
//   shape "a"   linear, objectBoundingBox, 2 stops (one with stop-opacity), axis and colors both change
//   shape "b"   radial in user space on a STROKE, center and radius change
//   shape "c"   linear in the source, radial in the destination: incompatible, held at the source (as the GL morph holds it)
//   shape "d"   same type, stop COUNT differs: the parameters tween, the stops hold at the source (as the GL stop plan does)
//   shape "e"   gradientTransform: the gradient-space transform tweens and the element carries its inverse
//   shape "f"   an opaque gradient (one texel per stop) to one with a translucent stop (two): the stops still tween
//
// The expected numbers are the GL morph's own: the record slots lerp linearly, the stop bytes lerp linearly. The picture is
// read back from the browser's rasterization of the native <svg> too, so a gradient element the browser cannot use fails here.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const pose = (defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${defs}</defs>${body}</svg>`;
const BODY = (fa, fb, fc, fd, fe, ff) =>
  `<rect id="a" x="0" y="0" width="100" height="20" fill="${fa}"/>` +
  `<circle id="b" cx="50" cy="50" r="10" fill="none" stroke="${fb}" stroke-width="8"/>` +
  `<rect id="c" x="0" y="60" width="100" height="10" fill="${fc}"/>` +
  `<rect id="d" x="0" y="72" width="100" height="10" fill="${fd}"/>` +
  `<rect id="e" x="0" y="84" width="100" height="10" fill="${fe}"/>` +
  `<rect id="f" x="0" y="95" width="100" height="5" fill="${ff}"/>`;
const A = pose(
  '<linearGradient id="ga" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff" stop-opacity="0.8"/></linearGradient>' +
    '<radialGradient id="gb" gradientUnits="userSpaceOnUse" cx="50" cy="50" r="40"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#000000"/></radialGradient>' +
    '<linearGradient id="gc" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>' +
    '<linearGradient id="gd" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>' +
    '<linearGradient id="ge" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0" gradientTransform="translate(0 0)"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>' +
    '<linearGradient id="gf" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>',
  BODY('url(#ga)', 'url(#gb)', 'url(#gc)', 'url(#gd)', 'url(#ge)', 'url(#gf)'),
);
const B = pose(
  '<linearGradient id="ga" x1="0.25" y1="0" x2="0.75" y2="0"><stop offset="0" stop-color="#00ff00"/><stop offset="1" stop-color="#ffff00" stop-opacity="0.5"/></linearGradient>' +
    '<radialGradient id="gb" gradientUnits="userSpaceOnUse" cx="60" cy="50" r="20"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#00ff00"/></radialGradient>' +
    '<radialGradient id="gc" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#00ff00"/><stop offset="1" stop-color="#ffff00"/></radialGradient>' +
    '<linearGradient id="gd" x1="0.5" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#00ff00"/><stop offset="0.5" stop-color="#ffffff"/><stop offset="1" stop-color="#ffff00"/></linearGradient>' +
    '<linearGradient id="ge" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0" gradientTransform="translate(20 0)"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>' +
    '<linearGradient id="gf" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#00ff00"/><stop offset="1" stop-color="#ffff00" stop-opacity="0.5"/></linearGradient>',
  BODY('url(#ga)', 'url(#gb)', 'url(#gc)', 'url(#gd)', 'url(#ge)', 'url(#gf)'),
);

// Raster parity against the GL morph's own semantics: shapes p/q/r/s (opaque stops, so the browser's gradient interpolation and the
// shader's agree), compared pixel by pixel with sampleGradientAt on the record lerped the way the GL morph lerps it.
const PA = pose(
  '<linearGradient id="gp" x1="0.1" y1="0.2" x2="0.9" y2="0.7" gradientTransform="rotate(30) skewX(10)" spreadMethod="reflect"><stop offset="0" stop-color="#ff0000"/><stop offset="0.4" stop-color="#ffff00"/><stop offset="1" stop-color="#0000ff"/></linearGradient>' +
    '<radialGradient id="gq" gradientUnits="userSpaceOnUse" cx="50" cy="50" r="30" fx="40" fy="45" spreadMethod="repeat"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#220066"/></radialGradient>' +
    '<linearGradient id="gr" gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="60" y2="0" gradientTransform="scale(1.5 1) translate(5 0)"><stop offset="0" stop-color="#00ffff"/><stop offset="1" stop-color="#ff00ff"/></linearGradient>' +
    '<radialGradient id="gs" cx="0.3" cy="0.6" r="0.5" gradientTransform="rotate(20)"><stop offset="0" stop-color="#ffcc00"/><stop offset="0.6" stop-color="#00cc44"/><stop offset="1" stop-color="#000000"/></radialGradient>',
  '<rect id="p" x="0" y="0" width="100" height="25" fill="url(#gp)"/><rect id="q" x="0" y="25" width="100" height="25" fill="url(#gq)"/>' +
    '<rect id="r" x="0" y="50" width="100" height="25" fill="url(#gr)"/><rect id="s" x="0" y="75" width="100" height="25" fill="url(#gs)"/>',
);
const PB = pose(
  '<linearGradient id="gp" x1="0.3" y1="0" x2="0.6" y2="0.9" gradientTransform="rotate(-20) skewX(25)" spreadMethod="reflect"><stop offset="0" stop-color="#00ff00"/><stop offset="0.6" stop-color="#ff00ff"/><stop offset="1" stop-color="#000000"/></linearGradient>' +
    '<radialGradient id="gq" gradientUnits="userSpaceOnUse" cx="60" cy="40" r="20" fx="65" fy="35" spreadMethod="repeat"><stop offset="0" stop-color="#ff8800"/><stop offset="1" stop-color="#00ff88"/></radialGradient>' +
    '<linearGradient id="gr" gradientUnits="userSpaceOnUse" x1="0" y1="10" x2="40" y2="20" gradientTransform="scale(0.8 1.2) translate(-5 3)"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>' +
    '<radialGradient id="gs" cx="0.6" cy="0.4" r="0.35" gradientTransform="rotate(-35)"><stop offset="0" stop-color="#ffffff"/><stop offset="0.6" stop-color="#cc0000"/><stop offset="1" stop-color="#220044"/></radialGradient>',
  '<rect id="p" x="0" y="0" width="100" height="25" fill="url(#gp)"/><rect id="q" x="0" y="25" width="100" height="25" fill="url(#gq)"/>' +
    '<rect id="r" x="0" y="50" width="100" height="25" fill="url(#gr)"/><rect id="s" x="0" y="75" width="100" height="25" fill="url(#gs)"/>',
);

const HTML = `<!DOCTYPE html><html><body><div id="host"></div>
<script type="module">
import { importSvg, createNativeScene, createNativeMorph } from '/src/index.js';
const src = await importSvg(${JSON.stringify(A)}, { retainSource: true });
const dst = await importSvg(${JSON.stringify(B)}, { retainSource: true });
const scene = createNativeScene(document.getElementById('host'));
scene.setViewport(100, 100);
const morph = createNativeMorph(src, dst);
function paintOf(el, prop) {
  const v = el.getAttribute(prop) || '';
  const m = /url\\(#([^)]+)\\)/.exec(v);
  if (!m) return { value: v };
  const g = scene.svg.querySelector('[id="' + m[1] + '"]');
  if (!g) return { value: v, missing: true };
  const attrs = {};
  for (const a of g.getAttributeNames()) attrs[a] = g.getAttribute(a);
  const stops = Array.from(g.querySelectorAll('stop')).map(s => ({ offset: s.getAttribute('offset'), color: s.getAttribute('stop-color'), opacity: s.getAttribute('stop-opacity') }));
  return { value: v, tag: g.localName, attrs, stops };
}
window.__at = (t) => {
  morph.setT(t);
  scene.beginFrame([0, 0, 0, 0]); scene.drawBundle(morph.bundle, { overrides: morph.overrides }); scene.endFrame();
  const out = {};
  for (const [id, prop] of [['a', 'fill'], ['b', 'stroke'], ['c', 'fill'], ['d', 'fill'], ['e', 'fill'], ['f', 'fill']]) {
    const el = scene.svg.querySelector('[data-oid="' + id + '"]');
    out[id] = el ? paintOf(el, prop) : null;
  }
  return out;
};
// Rasterize the native <svg> as the browser draws it and read pixels.
window.__pixels = async (t, pts) => {
  window.__at(t);
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  await img.decode();
  const c = document.createElement('canvas'); c.width = c.height = 100;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0, 100, 100);
  return pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data));
};
// ---- raster parity: the native scene vs sampleGradientAt on the GL-lerped record --------------------------------------------
import { sampleGradientAt } from '/src/hitTest/paintSample.js';
const psrc = await importSvg(${JSON.stringify(PA)}, { retainSource: true });
const pdst = await importSvg(${JSON.stringify(PB)}, { retainSource: true });
const pscene = createNativeScene(document.createElement('div'));
pscene.setViewport(100, 100);
const pmorph = createNativeMorph(psrc, pdst);
const SLOTS = [3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15];
window.__parity = async (t) => {
  pmorph.setT(t);
  pscene.beginFrame([0, 0, 0, 0]); pscene.drawBundle(pmorph.bundle, { overrides: pmorph.overrides }); pscene.endFrame();
  const xml = new XMLSerializer().serializeToString(pscene.svg);
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); await img.decode();
  const c = document.createElement('canvas'); c.width = c.height = 100;
  const g2 = c.getContext('2d'); g2.drawImage(img, 0, 0, 100, 100);
  const px = g2.getImageData(0, 0, 100, 100).data;
  const ga = new Float32Array(psrc.gradients), gb = new Float32Array(pdst.gradients);
  const sa = new Uint8Array(psrc.gradientStops), sb = new Uint8Array(pdst.gradientStops);
  const out = {};
  for (let k = 0; k < 4; k++) {
    const gid = k + 1, base = k * 16;
    const rec = Float32Array.from(ga.subarray(base, base + 16));
    for (const s of SLOTS) rec[s] = ga[base + s] * (1 - t) + gb[base + s] * t;
    // stops: both poses pack the same layout here (same counts), so the byte lerp is index for index
    const stops = Uint8Array.from(sa);
    for (let i = 0; i < stops.length; i++) stops[i] = Math.round(sa[i] * (1 - t) + sb[i] * t);
    // the record's own stop offset: pose A's table; B's offsets for the same gradient index differ only if counts differ
    const gd = { g: rec, s: stops };
    const y0 = k * 25; let worst = 0, n = 0, at = null;
    for (let y = y0 + 2; y < y0 + 23; y += 2) for (let x = 2; x < 98; x += 3) {
      const e = sampleGradientAt(gd, 1, x + 0.5, y + 0.5, [0, y0, 100, y0 + 25]);
      const i = (y * 100 + x) * 4;
      const d = Math.max(Math.abs(px[i] - e[0] * 255), Math.abs(px[i + 1] - e[1] * 255), Math.abs(px[i + 2] - e[2] * 255));
      n++; if (d > worst) { worst = d; at = [x, y, [px[i], px[i + 1], px[i + 2]], e.map(v => Math.round(v * 255))]; }
    }
    out['pqrs'[k]] = { worst, n, at };
  }
  return out;
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  const p = decodeURIComponent(req.url.split('?')[0]);
  try {
    const b = readFileSync(path.join(ROOT, p));
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(b);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
try {
  await openReady(page, `http://127.0.0.1:${port}/`, { ready: 'flag' });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const rgb = (c) => {
  if (!c) return null;
  let m = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /rgba?\(([^)]*)\)/.exec(c);
  return m ? m[1].split(',').slice(0, 3).map(Number) : null;
};
const num = (v) => (v == null ? NaN : parseFloat(v));
const colorNear = (c, want, tol = 1.5) => {
  const g = rgb(c);
  return !!g && g.every((v, i) => near(v, want[i], tol));
};
const matrix = (s) => {
  const m = /matrix\(([^)]*)\)/.exec(s || '');
  const v = m
    ? m[1]
        .trim()
        .split(/[\s,]+/)
        .map(Number)
    : [1, 0, 0, 1, 0, 0];
  return { a: v[0], b: v[1], c: v[2], d: v[3], e: v[4], f: v[5] };
};

const at = {};
for (const t of [0, 0.5, 1]) at[t] = await page.evaluate((x) => window.__at(x), t);

if (process.env.DBG)
  console.log(await page.evaluate(() => document.getElementById('host').innerHTML));
// a: linear bbox units
{
  const g0 = at[0].a,
    gh = at[0.5].a,
    g1 = at[1].a;
  if (
    colorNear(gh.stops?.[0]?.color, [127.5, 127.5, 0]) &&
    colorNear(gh.stops?.[1]?.color, [127.5, 127.5, 127.5])
  )
    ok('a: stop colors at t=0.5 are the midpoint');
  else fail('a: stops at t=0.5 ' + JSON.stringify(gh.stops));
  if (near(num(gh.stops?.[1]?.opacity), 0.65, 0.02))
    ok('a: stop-opacity tweens (0.8 -> 0.5 = 0.65)');
  else fail('a: stop-opacity at t=0.5 ' + JSON.stringify(gh.stops));
  if (near(num(gh.attrs?.x1), 0.125, 1e-4) && near(num(gh.attrs?.x2), 0.875, 1e-4))
    ok('a: axis x1/x2 tween (0.125, 0.875)');
  else fail('a: axis at t=0.5 ' + JSON.stringify(gh.attrs));
  if (colorNear(g0.stops?.[0]?.color, [255, 0, 0]) && near(num(g0.attrs?.x1 ?? 0), 0, 1e-6))
    ok('a: t=0 is the source');
  else fail('a: t=0 ' + JSON.stringify(g0));
  if (
    colorNear(g1.stops?.[0]?.color, [0, 255, 0]) &&
    near(num(g1.attrs?.x1), 0.25, 1e-4) &&
    near(num(g1.stops?.[1]?.opacity), 0.5, 0.01)
  )
    ok('a: t=1 is the destination');
  else fail('a: t=1 ' + JSON.stringify(g1));
  if ((gh.attrs?.gradientUnits ?? 'objectBoundingBox') === 'objectBoundingBox')
    ok('a: units stay objectBoundingBox');
  else fail('a: units ' + gh.attrs?.gradientUnits);
}
// b: radial on a stroke
{
  const gh = at[0.5].b;
  if (
    gh.tag === 'radialGradient' &&
    near(num(gh.attrs.cx), 55, 0.01) &&
    near(num(gh.attrs.r), 30, 0.01)
  )
    ok('b: stroke radial cx/r tween (55, 30)');
  else fail('b: ' + JSON.stringify(gh));
  if (colorNear(gh.stops?.[0]?.color, [255, 127.5, 127.5], 2))
    ok('b: stop 0 white -> red midpoint');
  else fail('b: stop 0 ' + JSON.stringify(gh.stops));
}
// c: incompatible types -> held
{
  const h = at[0.5].c,
    h1 = at[1].c;
  if (
    h.tag === 'linearGradient' &&
    colorNear(h.stops?.[0]?.color, [255, 0, 0]) &&
    h1.tag === 'linearGradient'
  )
    ok('c: incompatible types hold the source gradient');
  else fail('c: ' + JSON.stringify(h));
}
// d: stop count differs -> params tween, stops hold
{
  const h = at[0.5].d;
  if (near(num(h.attrs?.x1), 0.25, 1e-4)) ok('d: axis tweens even when the stop counts differ');
  else fail('d: axis ' + JSON.stringify(h.attrs));
  if (h.stops?.length === 2 && colorNear(h.stops[0].color, [255, 0, 0]))
    ok('d: stops hold at the source');
  else fail('d: stops ' + JSON.stringify(h.stops));
}
// e: gradientTransform
{
  const h = at[0.5].e,
    m = matrix(h.attrs?.gradientTransform);
  if (near(m.e, 10, 0.01) && near(m.a, 1, 1e-6) && near(m.d, 1, 1e-6))
    ok('e: gradientTransform tweens (translate 10)');
  else fail('e: ' + JSON.stringify(h.attrs));
}
// f: opaque (one texel per stop) -> a translucent stop (two texels): the packings differ, the stops still tween
{
  const h = at[0.5].f;
  if (
    colorNear(h.stops?.[0]?.color, [127.5, 127.5, 0]) &&
    colorNear(h.stops?.[1]?.color, [127.5, 127.5, 127.5]) &&
    near(num(h.stops?.[1]?.opacity), 0.75, 0.02)
  )
    ok('f: stops tween across the one-texel / two-texel packings');
  else fail('f: stops at t=0.5 ' + JSON.stringify(h.stops));
}
// pixels: the browser can use the gradient
{
  const px = await page.evaluate((t, pts) => window.__pixels(t, pts), 0.5, [
    [1, 10],
    [50, 10],
    [98, 10],
  ]);
  // a at t=0.5: axis 0.125..0.875 over x in [0,100]; left of 12.5 -> stop 0 (127.5,127.5,0), right of 87.5 -> stop 1 (127.5,127.5,127.5, alpha .75)
  if (
    px[0][0] >= 120 &&
    px[0][0] <= 135 &&
    px[0][1] >= 120 &&
    px[0][1] <= 135 &&
    px[0][2] <= 8 &&
    px[0][3] > 250
  )
    ok('pixels: a at x=1 reads stop 0 mid color');
  else fail('pixels: a at x=1 ' + px[0]);
  if (px[2][3] >= 160 && px[2][3] <= 172)
    ok('pixels: a at x=98 carries the tweened stop alpha (~166)');
  else fail('pixels: a at x=98 ' + px[2]);
  if (px[1][3] > 200 && px[1][3] < 255) ok('pixels: a at x=50 between');
  else fail('pixels: a at x=50 ' + px[1]);
}

// raster parity (t = 0, 0.37, 1)
for (const t of [0, 0.37, 1]) {
  const r = await page.evaluate((x) => window.__parity(x), t);
  for (const k of Object.keys(r)) {
    if (r[k].worst <= 4)
      ok(
        `raster ${k} t=${t}: ${r[k].n} pixels within ${r[k].worst.toFixed(1)}/255 of the GL-lerped gradient`,
      );
    else
      fail(`raster ${k} t=${t}: worst ${r[k].worst.toFixed(1)}/255 at ${JSON.stringify(r[k].at)}`);
  }
}

await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nnativeGradientMorphSmoke: all checks passed');
