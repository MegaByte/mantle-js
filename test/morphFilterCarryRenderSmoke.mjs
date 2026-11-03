// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphFilterCarryRenderSmoke -- on the GPU: a morph carries the filter of the ACTIVE pose, re-resolves a group filter's
// objectBoundingBox region against the lerped member boxes, and interpolates a hueless transparent color premultiplied while
// fill and fill-opacity interpolate on their own.
//
// Each cell renders at 128 px on white:
//   svg      the MORPH between two poses at t (default engine route; importSvg keepInvisibleShapes for the color cells);
//   control  the authored pose of the same t: for a filter, the source pose below the middle of the morph and the destination pose from there
//            (geometry lerped by hand); for a color, a plain rect whose fill and fill-opacity are the lerps;
//   chrome   Chrome's own SVG engine drawing the control at 8x, box-averaged to 128 px (the AA reference), scored on flat pixels.
// The morph must equal the control to within 2/255 (the ends exactly the authored poses), and Chrome to within the filter tolerance.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { compare } from './_chrome8Ref.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 128;
const TS = [0, 0.25, 0.5, 0.75, 1];
const DEFS =
  '<defs><filter id="f3" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3"/></filter><filter id="f8" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="8"/></filter></defs>';
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${DEFS}${body}</svg>`;
const flt = (f) => (f ? ` filter="url(#${f})"` : '');
const SHAPES = {
  leaf: (x, f) =>
    `<path id="a" d="M${x} 30h50v50h-50Z" fill="#ff0000" stroke="#0000ff" stroke-width="12"${flt(f)}/>`,
  fill: (x, f) => `<path id="a" d="M${x} 30h50v50h-50Z" fill="#ff0000"${flt(f)}/>`,
  group: (x, f) =>
    `<g${flt(f)}><path id="a" d="M${x} 20h40v40h-40Z" fill="#ff0000"/><path id="b" d="M${x + 12} 66h40v40h-40Z" fill="#00aa00" opacity=".8"/></g>`,
};
const CELLS = [];
const lerp = (a, b, t) => a + (b - a) * t;
for (const [kind, shape] of Object.entries(SHAPES))
  for (const [fa, fb] of [
    [null, 'f3'],
    ['f3', null],
    ['f3', 'f8'],
  ])
    for (const moving of [false, true])
      for (const t of TS) {
        if (moving && kind === 'fill') continue;
        const xa = 24,
          xb = moving ? 44 : 24,
          x = lerp(xa, xb, t);
        CELLS.push({
          name: `${kind} ${fa || 'none'} -> ${fb || 'none'}${moving ? ' moving' : ''} at t=${t}`,
          t,
          from: doc(shape(xa, fa)),
          to: doc(shape(xb, fb)),
          control: doc(shape(x, t >= 0.5 ? fb : fa)),
          moving,
        });
      }

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${W}" height="${W}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, createShapeMorph, createOverrideTable, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
R.setViewport(${W}, ${W});
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const readFrom = (g) => {
  const px = new Uint8Array(${W} * ${W} * 4); g.readPixels(0, 0, ${W}, ${W}, g.RGBA, g.UNSIGNED_BYTE, px);
  const out = new Uint8Array(px.length);
  for (let y = 0; y < ${W}; y++) for (let x = 0; x < ${W}; x++) {
    const s = ((${W} - 1 - y) * ${W} + x) * 4, d = (y * ${W} + x) * 4, a = px[s + 3]; out[d + 3] = a;
    if (a) for (let k = 0; k < 3; k++) out[d + k] = Math.min(255, Math.round(px[s + k] * 255 / a));
  }
  return b64(out);
};
const read = () => readFrom(gl);
const frames = (bundle) => { for (let i = 0; i < 4; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(bundle); R.endFrame(); } };
window.__still = async (svg, io) => {
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true, ...(io || {}) })); R.prepareBundle && R.prepareBundle(b);
  frames(b); const r = read(); b.dispose(); return r;
};
window.__morph = async (from, to, t, kernel, io) => {
  if (kernel) R.setFillEngine({ route: 'none', kernel, primitives: 'off' }); else R.setFillEngine({ route: 'auto', kernel: 'auto' });
  const A = createBundle(gl, await importSvg(from, { preserveViewport: true, ...(io || {}) })), B = createBundle(gl, await importSvg(to, { preserveViewport: true, ...(io || {}) }));
  const m = createShapeMorph(gl, A, B); m.setT(t);
  frames(m.bundle); const r = read(); m.dispose(); A.dispose(); B.dispose(); return r;
};
// A second renderer with the group atlas off (the same morph drawn a pass pair per group): the atlas must not change a pixel.
const gl2 = document.createElement('canvas'); gl2.width = ${W}; gl2.height = ${W};
const G2 = gl2.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const R2 = createRenderer(G2, shaders, { groupAtlas: false }); if (R2.ready) await R2.ready;
R2.setViewport(${W}, ${W});
window.__morphAtlas = async (from, to, t, off) => {
  const g = off ? G2 : gl, r = off ? R2 : R;
  const A = createBundle(g, await importSvg(from, { preserveViewport: true })), B = createBundle(g, await importSvg(to, { preserveViewport: true }));
  const m = createShapeMorph(g, A, B); m.setT(t);
  for (let i = 0; i < 4; i++) { r.beginFrame([1, 1, 1, 1]); r.drawBundle(m.bundle); r.endFrame(); }
  const out = readFrom(g);
  m.dispose(); A.dispose(); B.dispose(); return out;
};
window.__override = async (svg, value, target) => {
  R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  const end = target ? createBundle(gl, await importSvg(target, { preserveViewport: true })) : null;
  const morph = end ? createShapeMorph(gl, b, end) : null;
  if (morph) morph.setT(.5);
  const shown = morph ? morph.bundle : b;
  const table = createOverrideTable(gl, shown);
  table.set('G', value);
  try {
    for (let i = 0; i < 4; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(shown, { overrides: table }); R.endFrame(); }
    return read();
  } finally { table.dispose(); if (morph) morph.dispose(); if (end) end.dispose(); b.dispose(); }
};
window.__sequence = async (from, to, ts, gpu) => {
  R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const A = createBundle(gl, await importSvg(from, { preserveViewport: true }));
  const B = createBundle(gl, await importSvg(to, { preserveViewport: true }));
  const m = createShapeMorph(gl, A, B, { cpuLerp: !gpu });
  m.bundle._morphSrc.gpuSmallPlanes = gpu;
  const out = [];
  let draws = 0;
  const draw = gl.drawArrays.bind(gl);
  gl.drawArrays = (...args) => { draws++; return draw(...args); };
  try {
    for (const t of ts) { m.setT(t); frames(m.bundle); out.push(read()); }
    return { images: out, draws, error: gl.getError() };
  } finally { gl.drawArrays = draw; m.dispose(); A.dispose(); B.dispose(); }
};
window.__device = () => {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
};
window.__chrome = async (svg, S) => {
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
  const c2 = document.createElement('canvas'); c2.width = ${W} * S; c2.height = ${W} * S;
  const x2 = c2.getContext('2d', { willReadFrequently: true }); x2.fillStyle = '#fff'; x2.fillRect(0, 0, ${W} * S, ${W} * S);
  x2.drawImage(img, 0, 0, ${W} * S, ${W} * S);
  const d = x2.getImageData(0, 0, ${W} * S, ${W} * S).data, out = new Uint8Array(${W} * ${W} * 4);
  for (let yy = 0; yy < ${W}; yy++) for (let xx = 0; xx < ${W}; xx++) {
    let r = 0, g = 0, bl = 0, a = 0;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) { const q = ((yy * S + j) * ${W} * S + xx * S + i) * 4, al = d[q + 3]; r += d[q] * al; g += d[q + 1] * al; bl += d[q + 2] * al; a += al; }
    const o = (yy * ${W} + xx) * 4; out[o + 3] = Math.round(a / (S * S));
    if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(bl / a); }
  }
  return b64(out);
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
await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
const device = await page.evaluate(() => window.__device());
console.log('DEVICE ' + device);
if (process.env.MANTLE_TEST_GL !== 'swiftshader' && !/Metal/.test(device))
  throw new Error('Physical Metal required: ' + device);
const u8 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const at = (px, x, y) => {
  const i = (Math.floor(y * 1) * W + Math.floor(x * 1)) * 4;
  return [px[i], px[i + 1], px[i + 2]];
};
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const rows = [];
for (const c of CELLS) {
  if (process.env.MORPH_FILTER_CELL && !c.name.includes(process.env.MORPH_FILTER_CELL)) continue;
  let svg, control, other, chrome;
  try {
    svg = u8(await page.evaluate((f, t, tt) => window.__morph(f, t, tt, null), c.from, c.to, c.t));
    control = u8(await page.evaluate((s) => window.__still(s), c.control));
    // the pose the morph must NOT show yet (or any more): the other side's filter at the same geometry
    other = u8(await page.evaluate((s) => window.__still(s), c.t >= 0.5 ? c.from : c.to));
    chrome = u8(await page.evaluate((s) => window.__chrome(s, 8), c.control));
  } catch (e) {
    fail(c.name + ': ' + e.message);
    continue;
  }
  const vs = maxDiff(svg, control),
    cr = compare(svg, chrome, W, W, { tol: 8, edge: chrome });
  rows.push(cr);
  const line = `${c.name}: vs authored pose ${vs}; vs Chrome 8x flat max ${cr.max} mean ${cr.mean.toFixed(3)}`;
  if (vs > 2) fail(line + ' -- the morph differs from the authored pose');
  else if (cr.max > 24) fail(line + ' -- the morph differs from Chrome at ' + cr.at);
  else ok(line);
}
const overrideGroup = (transform = '', tint = false, opacity = 1) =>
  doc(
    '<g id="G" filter="url(#f3)" opacity=".8" ' +
      transform +
      '><path id="a" d="M24 20h40v40h-40Z" fill="' +
      (tint ? '#800000' : '#ff0000') +
      '" opacity="' +
      opacity +
      '"/><path id="b" d="M36 46h40v40h-40Z" fill="#00aa00" opacity="' +
      opacity +
      '"/></g>',
  );
for (const [name, value, expected] of [
  ['translate', { localPosition: [12, 4] }, overrideGroup('transform="translate(12 4)"')],
  ['scale', { localScale: [1.5, 1.5] }, overrideGroup('transform="scale(1.5)"')],
  ['visibility', { visibility: 0.5 }, overrideGroup('', false, 0.5)],
  ['tint', { tint: [0.5, 1, 0.25, 0.5] }, overrideGroup('', true, 0.5)],
  ['hidden', { visibility: 0 }, overrideGroup('', false, 0)],
]) {
  const label = 'filtered group override ' + name;
  if (process.env.MORPH_FILTER_CELL && !label.includes(process.env.MORPH_FILTER_CELL)) continue;
  const got = u8(
    await page.evaluate((svg, v) => window.__override(svg, v), overrideGroup(), value),
  );
  const expectedPixels = u8(await page.evaluate((svg) => window.__still(svg), expected));
  const error = maxDiff(got, expectedPixels);
  if (error > 2) fail(label + ': vs authored ' + error);
  else ok(label + ': vs authored ' + error);
}
for (const [name, from, target] of [
  ['existing filter', overrideGroup(), overrideGroup()],
  ['destination filter', overrideGroup().replace('filter="url(#f3)"', ''), overrideGroup()],
]) {
  const label = 'filtered morph group override ' + name;
  if (process.env.MORPH_FILTER_CELL && !label.includes(process.env.MORPH_FILTER_CELL)) continue;
  const got = u8(
    await page.evaluate(
      (svg, to) => window.__override(svg, { localPosition: [12, 4], visibility: 0.5 }, to),
      from,
      target,
    ),
  );
  const expectedPixels = u8(
    await page.evaluate(
      (svg) => window.__still(svg),
      overrideGroup('transform="translate(12 4)"', false, 0.5),
    ),
  );
  const error = maxDiff(got, expectedPixels);
  if (error > 2) fail(label + ': vs authored ' + error);
  else ok(label + ': vs authored ' + error);
}
// Retain a morph while crossing and reversing binding thresholds on both interpolation backends.
for (const [fa, fb] of [
  [null, 'f3'],
  ['f3', null],
  ['f3', 'f8'],
]) {
  const ts = [0, 0.25, 0.499, 0.5, 0.75, 1, 0.75, 0.499, 0];
  const from = doc(SHAPES.group(24, fa)),
    to = doc(SHAPES.group(44, fb));
  const cpu = await page.evaluate(
    (a, b, values) => window.__sequence(a, b, values, false),
    from,
    to,
    ts,
  );
  const gpu = await page.evaluate(
    (a, b, values) => window.__sequence(a, b, values, true),
    from,
    to,
    ts,
  );
  {
    let error = 0;
    for (let i = 0; i < ts.length; i++)
      error = Math.max(error, maxDiff(u8(cpu.images[i]), u8(gpu.images[i])));
    if (error > 1 || cpu.error || gpu.error || !(gpu.draws > cpu.draws))
      fail(
        'retained filter ' +
          fa +
          ' -> ' +
          fb +
          ': diff=' +
          error +
          ', GL=' +
          cpu.error +
          '/' +
          gpu.error +
          ', draws=' +
          cpu.draws +
          '/' +
          gpu.draws,
      );
    else
      ok(
        'retained filter ' +
          fa +
          ' -> ' +
          fb +
          ': CPU/GPU max=' +
          error +
          ', extra GPU lerp draws=' +
          (gpu.draws - cpu.draws),
      );
  }
}
// Colors: fill and fill-opacity interpolate on their own; a color with alpha 0 of its own has no hue (premultiplied).
const rect = (attrs) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect id="a" x="24" y="24" width="80" height="80" ${attrs}/></svg>`;
const hex = (v) => Math.round(v).toString(16).padStart(2, '0');
for (const [name, from, to, want] of [
  [
    'red -> blue at fill-opacity 0',
    'fill="#ff0000"',
    'fill="#0000ff" fill-opacity="0"',
    (t) => `fill="#${hex(255 * (1 - t))}00${hex(255 * t)}" fill-opacity="${1 - t}"`,
  ],
  [
    'red -> rgba(0,0,255,0)',
    'fill="#ff0000"',
    'fill="rgba(0,0,255,0)"',
    (t) => `fill="#ff0000" fill-opacity="${1 - t}"`,
  ],
  [
    'transparent -> red',
    'fill="transparent"',
    'fill="#ff0000"',
    (t) => `fill="#ff0000" fill-opacity="${t}"`,
  ],
])
  for (const t of TS) {
    const label = `color ${name} at t=${t}`;
    if (process.env.MORPH_FILTER_CELL && !label.includes(process.env.MORPH_FILTER_CELL)) continue;
    try {
      const svg = u8(
        await page.evaluate(
          (f, g, tt) => window.__morph(f, g, tt, null, { keepInvisibleShapes: true }),
          rect(from),
          rect(to),
          t,
        ),
      );
      const control = u8(await page.evaluate((s) => window.__still(s), rect(want(t))));
      const vs = maxDiff(svg, control),
        c = at(svg, 64, 64);
      if (vs > 2) fail(`${label}: [${c}] differs from the authored fill by ${vs}`);
      else ok(`${label}: [${c}] vs authored ${vs}`);
    } catch (e) {
      fail(label + ': ' + e.message);
    }
  }
// Opacity, fill-opacity and stroke-opacity move together: the picture is the authored pose with each property lerped -- the product of the
// lerps, as CSS animates them separately -- and Chrome draws that pose the same.
{
  const leaf = (x, o, fo) =>
    doc(
      `<path id="a" d="M${x} 30h50v50h-50Z" fill="#ff0000" stroke="#0000ff" stroke-width="12" opacity="${o}" fill-opacity="${fo}" stroke-opacity="${fo}"/>`,
    );
  for (const t of TS) {
    const label = `leaf opacity .5 -> 1 with fill/stroke-opacity 1 -> .5 at t=${t}`;
    if (process.env.MORPH_FILTER_CELL && !label.includes(process.env.MORPH_FILTER_CELL)) continue;
    try {
      const svg = u8(
        await page.evaluate(
          (f, g, tt) => window.__morph(f, g, tt, null),
          leaf(24, 0.5, 1),
          leaf(44, 1, 0.5),
          t,
        ),
      );
      const control = u8(
        await page.evaluate(
          (x) => window.__still(x),
          leaf(lerp(24, 44, t), lerp(0.5, 1, t), lerp(1, 0.5, t)),
        ),
      );
      const chrome = u8(
        await page.evaluate(
          (x) => window.__chrome(x, 8),
          leaf(lerp(24, 44, t), lerp(0.5, 1, t), lerp(1, 0.5, t)),
        ),
      );
      const vs = maxDiff(svg, control),
        cr = compare(svg, chrome, W, W, { tol: 8, edge: chrome });
      if (vs > 2) fail(`${label}: differs from the authored pose by ${vs}`);
      else if (cr.max > 8) fail(`${label}: differs from Chrome 8x at ${cr.at} (${cr.max})`);
      else ok(`${label}: vs authored ${vs}, Chrome 8x flat max ${cr.max}`);
    } catch (e) {
      fail(label + ': ' + e.message);
    }
  }
}
// The group atlas on a morph: a grid of faded fill+stroke leaves, .5 -> 1 while moving, with the atlas on and off, and the authored pose.
{
  const grid = (n, dx, op) =>
    doc(
      Array.from(
        { length: n },
        (_, i) =>
          `<path id="l${i}" d="M${6 + (i % 4) * 30 + dx} ${6 + Math.floor(i / 4) * 40}h16v26h-16Z" fill="#ff0000" stroke="#0000ff" stroke-width="6"${op === 1 ? '' : ` opacity="${op}"`}/>`,
      ).join(''),
    );
  for (const t of TS) {
    const label = `atlas on a morph of 12 faded leaves .5 -> 1 at t=${t}`;
    if (process.env.MORPH_FILTER_CELL && !label.includes(process.env.MORPH_FILTER_CELL)) continue;
    try {
      const on = u8(
        await page.evaluate(
          (f, g, tt) => window.__morphAtlas(f, g, tt, false),
          grid(12, 0, 0.5),
          grid(12, 8, 1),
          t,
        ),
      );
      const off = u8(
        await page.evaluate(
          (f, g, tt) => window.__morphAtlas(f, g, tt, true),
          grid(12, 0, 0.5),
          grid(12, 8, 1),
          t,
        ),
      );
      const control = u8(
        await page.evaluate((s) => window.__still(s), grid(12, 8 * t, 0.5 + 0.5 * t)),
      );
      const a = maxDiff(on, off),
        c = maxDiff(on, control);
      if (a > 1) fail(`${label}: atlas on differs from atlas off by ${a}`);
      else if (c > 2) fail(`${label}: differs from the authored pose by ${c}`);
      else ok(`${label}: on vs off ${a}, vs authored ${c}`);
    } catch (e) {
      fail(label + ': ' + e.message);
    }
  }
}
await browser.close();
server.close();
console.log(
  `\nChrome 8x, flat pixels, ${rows.length} filter cells: worst ${rows.reduce((m, r) => Math.max(m, r.max), 0)}`,
);
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nmorphFilterCarryRenderSmoke: a morph wears the filter of its active pose, resolves a group region against the lerped boxes, and interpolates colors independently',
);
