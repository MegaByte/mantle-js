// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphGroupOpacityRenderSmoke -- on the GPU, against Chrome: a fill+stroke leaf with opacity below 1 is ONE composited element
// (SVG: opacity applies to the element as a whole), and a morph across or within such opacities renders the group at the lerped opacity.
//
// Each cell renders, at 128 px on white (64-unit viewBox x2):
//   svg      the MORPH between two poses of the leaf at t (renderer, default engine route);
//   control  the authored pose of the same t (same geometry and opacity lerped by hand), a plain document with `opacity=`: the morph must
//            equal it to within 2/255;
//   old      the one-after-the-other picture authored literally (`fill-opacity` and `stroke-opacity` carrying the opacity, so the paints composite one
//            after the other): the morph must DIFFER from it by at least 24/255 somewhere wherever the opacity is strictly between 0 and 1;
//   chrome   Chrome's own SVG engine drawing the authored pose at 8x, box-averaged to 128 px (the AA reference): the morph and the `old`
//            picture are both scored against it on flat pixels, so the table shows what group compositing changes.
// The cell's analytic probes (a stated point reads a stated color) are independent of all of them.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { compare } from './_chrome8Ref.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 128;
const TS = [0, 0.25, 0.5, 0.75, 1];
const TRANSITIONS = [
  [0.5, 1],
  [0.5, 0.8],
  [1, 0.5],
];
const XA = 20,
  XB = 40;
const leaf = (x, op, id = '') =>
  `<path${id} d="M${x} 20h64v64h-64Z" fill="#ff0000" stroke="#0000ff" stroke-width="16"${op}/>`;
const doc = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${body}</svg>`;
const mix = (rgb, a, under = [255, 255, 255]) => rgb.map((c, i) => c * a + under[i] * (1 - a));

const CELLS = [];
for (const named of [false, true])
  for (const [oa, ob] of TRANSITIONS)
    for (const t of TS) {
      const a = oa + (ob - oa) * t,
        x = XA + (XB - XA) * t,
        id = named ? ' id="a"' : '';
      const op = (v) => (v === 1 ? '' : ` opacity="${v}"`);
      CELLS.push({
        name: `${named ? 'named' : 'unnamed'} opacity ${oa} -> ${ob} at t=${t}`,
        t,
        a,
        named,
        from: doc(leaf(XA, op(oa), id)),
        to: doc(leaf(XB, op(ob), id)),
        control: doc(leaf(x, op(a), id)),
        old: doc(leaf(x, ` fill-opacity="${a}" stroke-opacity="${a}"`, id)),
        // fill only, fill under stroke (the overlap), stroke only: with the leaf composited once the overlap is the stroke color at a.
        probes: [
          [x + 40, 52, mix([255, 0, 0], a), 3],
          [x + 4, 52, mix([0, 0, 255], a), 3],
          [x - 4, 52, mix([0, 0, 255], a), 3],
          [3, 3, [255, 255, 255], 1],
        ],
      });
    }

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${W}" height="${W}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, createShapeMorph, createSpriteMorph, createOverrideTable, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
R.setViewport(${W}, ${W});
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const read = () => {
  const px = new Uint8Array(${W} * ${W} * 4); gl.readPixels(0, 0, ${W}, ${W}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = new Uint8Array(px.length);
  for (let y = 0; y < ${W}; y++) for (let x = 0; x < ${W}; x++) {
    const s = ((${W} - 1 - y) * ${W} + x) * 4, d = (y * ${W} + x) * 4, a = px[s + 3]; out[d + 3] = a;
    if (a) for (let k = 0; k < 3; k++) out[d + k] = Math.min(255, Math.round(px[s + k] * 255 / a));
  }
  return b64(out);
};
const frames = (bundle) => { for (let i = 0; i < 4; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(bundle); R.endFrame(); } };
window.__still = async (svg) => {
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true })); R.prepareBundle && R.prepareBundle(b);
  frames(b); const r = read(); b.dispose(); return r;
};
window.__morph = async (from, to, t, kernel) => {
  if (kernel) R.setFillEngine({ route: 'none', kernel, primitives: 'off' }); else R.setFillEngine({ route: 'auto', kernel: 'auto' });
  const A = createBundle(gl, await importSvg(from, { preserveViewport: true })), B = createBundle(gl, await importSvg(to, { preserveViewport: true }));
  const m = createShapeMorph(gl, A, B); m.setT(t);
  frames(m.bundle); const r = read(); m.dispose(); A.dispose(); B.dispose(); return r;
};
window.__sprite = async (svg, id) => {
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true })); R.prepareBundle && R.prepareBundle(b);
  for (let i = 0; i < 4; i++) { R.beginFrame([1, 1, 1, 1]); R.drawSprite(b, id); R.endFrame(); }
  const r = read(); b.dispose(); return r;
};
window.__spriteMorph = async (from, to, id, t) => {
  const A = createBundle(gl, await importSvg(from, { preserveViewport: true })), B = createBundle(gl, await importSvg(to, { preserveViewport: true }));
  const m = createSpriteMorph(gl, { bundle: A, sprite: id }, { bundle: B, sprite: id }); m.setT(t);
  frames(m.bundle); const r = read(); m.dispose(); A.dispose(); B.dispose(); return r;
};
window.__spriteOfMorph = async (from, to, id, t) => {
  const A = createBundle(gl, await importSvg(from, { preserveViewport: true })), B = createBundle(gl, await importSvg(to, { preserveViewport: true }));
  const m = createShapeMorph(gl, A, B); m.setT(t);
  for (let i = 0; i < 4; i++) { R.beginFrame([1, 1, 1, 1]); R.drawSprite(m.bundle, id); R.endFrame(); }
  const r = read(); m.dispose(); A.dispose(); B.dispose(); return r;
};
window.__morphOv = async (from, to, t, ops) => {
  R.setFillEngine({ route: 'auto', kernel: 'auto' });
  const A = createBundle(gl, await importSvg(from, { preserveViewport: true })), B = createBundle(gl, await importSvg(to, { preserveViewport: true }));
  const m = createShapeMorph(gl, A, B); m.setT(t);
  const table = createOverrideTable(gl, m.bundle), resolved = ops.map(([k, o]) => table.set(k, o));
  for (let i = 0; i < 4; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(m.bundle, { overrides: table }); R.endFrame(); }
  const r = read(); m.dispose(); A.dispose(); B.dispose(); return { px: r, resolved };
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
const KERNELS = [null, 'aac', 'slug'];
const rows = [];
for (const kernel of KERNELS)
  for (const c of CELLS) {
    if (kernel && c.named) continue; // the explicit kernels run the unnamed cells (the harder match)
    const label = `${c.name}${kernel ? ' [' + kernel + ']' : ''}`;
    if (process.env.MORPH_GROUP_CELL && !label.includes(process.env.MORPH_GROUP_CELL)) continue;
    let svg, control, old, chrome;
    try {
      svg = u8(
        await page.evaluate(
          (f, t, tt, k) => window.__morph(f, t, tt, k),
          c.from,
          c.to,
          c.t,
          kernel,
        ),
      );
      control = u8(await page.evaluate((s) => window.__still(s), c.control));
      old = u8(await page.evaluate((s) => window.__still(s), c.old));
      chrome = u8(await page.evaluate((s) => window.__chrome(s, 8), c.control));
    } catch (e) {
      fail(label + ': ' + e.message);
      continue;
    }
    const vsControl = maxDiff(svg, control),
      vsOld = maxDiff(svg, old);
    if (process.env.MORPH_GROUP_DEBUG)
      console.log(
        '   probes svg/control/old:',
        c.probes
          .map(
            ([x, y]) => `(${x},${y}) [${at(svg, x, y)}] [${at(control, x, y)}] [${at(old, x, y)}]`,
          )
          .join('  '),
      );
    const bad = c.probes
      .filter(([x, y, want, tol]) => maxDiff(at(svg, x, y), want) > tol)
      .map(([x, y, want]) => `(${x},${y}) is [${at(svg, x, y)}], wanted [${want.map(Math.round)}]`);
    const fix = compare(svg, chrome, W, W, { tol: 8, edge: chrome }),
      was = compare(old, chrome, W, W, { tol: 8, edge: chrome });
    rows.push({ label, fix, was });
    const line = `${label}: vs control ${vsControl}, vs old ${vsOld}; vs Chrome 8x flat: morph max ${fix.max} mean ${fix.mean.toFixed(3)} (n ${fix.n}), old max ${was.max} mean ${was.mean.toFixed(3)}`;
    const mid = c.a > 0.04 && c.a < 0.96;
    if (vsControl > 2) fail(line + ' -- the morph differs from the authored pose');
    else if (mid && vsOld < 24)
      fail(line + ' -- vacuous: the one-after-the-other picture is the same');
    else if (fix.max > 6) fail(line + ' -- the morph differs from Chrome at ' + fix.at);
    else if (bad.length) fail(line + ' -- probes: ' + bad.join('; '));
    else ok(line);
  }
// Sprites: a sheet with the leaf (id a, its group rows inside the sprite range) and a circle (id c). The sprite draws the leaf alone.
const CIRCLE = '<circle id="c" cx="100" cy="100" r="12" fill="#00aa00"/>';
for (const [oa, ob] of TRANSITIONS)
  for (const t of [0.25, 0.5, 0.75]) {
    const a = oa + (ob - oa) * t,
      x = XA + (XB - XA) * t,
      op = (v) => (v === 1 ? '' : ` opacity="${v}"`);
    const label = `sprite a of a sheet, ${oa} -> ${ob} at t=${t}`;
    if (process.env.MORPH_GROUP_CELL && !label.includes(process.env.MORPH_GROUP_CELL)) continue;
    try {
      const morph = u8(
        await page.evaluate(
          (f, g, id, tt) => window.__spriteMorph(f, g, id, tt),
          doc(leaf(XA, op(oa), ' id="a"') + CIRCLE),
          doc(leaf(XB, op(ob), ' id="a"') + CIRCLE),
          'a',
          t,
        ),
      );
      const control = u8(
        await page.evaluate((sv) => window.__still(sv), doc(leaf(x, op(a), ' id="a"'))),
      );
      const d = maxDiff(morph, control),
        ground = at(morph, 100, 100);
      if (d > 2) fail(`${label}: the sprite morph differs from the authored leaf by ${d}`);
      else if (maxDiff(ground, [255, 255, 255]) > 1)
        fail(`${label}: the rest of the sheet is drawn ([${ground}] at the circle)`);
      else ok(`${label}: vs control ${d}, the circle is not drawn`);
    } catch (e) {
      fail(label + ': ' + e.message);
    }
  }
// Overrides on the morph bundle (a table the caller made for it): rows keep their ids ('a' the fill, 'a_stroke' the stroke) next to the group rows.
for (const [oa, ob] of TRANSITIONS) {
  const t = 0.5,
    a = oa + (ob - oa) * t,
    x = XA + (XB - XA) * t,
    op = (v) => (v === 1 ? '' : ` opacity="${v}"`);
  const fillOnly = (extra) =>
    doc(`<path id="a" d="M${x} 20h64v64h-64Z" fill="#ff0000"${op(a)}${extra}/>`);
  const label = `override on the morph bundle, ${oa} -> ${ob} at t=${t}: the stroke hidden`;
  if (process.env.MORPH_GROUP_CELL && !label.includes(process.env.MORPH_GROUP_CELL)) continue;
  try {
    const r = await page.evaluate(
      (f, g, tt, ops) => window.__morphOv(f, g, tt, ops),
      doc(leaf(XA, op(oa), ' id="a"')),
      doc(leaf(XB, op(ob), ' id="a"')),
      t,
      [['a_stroke', { visibility: 0 }]],
    );
    const got = u8(r.px),
      control = u8(await page.evaluate((sv) => window.__still(sv), fillOnly('')));
    const d = maxDiff(got, control);
    if (!r.resolved.every(Boolean)) fail(`${label}: the key did not resolve`);
    else if (d > 2) fail(`${label}: differs from the fill-only leaf by ${d}`);
    else ok(`${label}: vs control ${d}`);
  } catch (e) {
    fail(label + ': ' + e.message);
  }
}
// drawSprite on a whole-sheet morph bundle: the sprite's range is the source's, and the group rows a pose lacks are appended behind it.
for (const [oa, ob] of TRANSITIONS) {
  const t = 0.5,
    a = oa + (ob - oa) * t,
    x = XA + (XB - XA) * t,
    op = (v) => (v === 1 ? '' : ` opacity="${v}"`);
  const label = `drawSprite a of a morph bundle, ${oa} -> ${ob} at t=${t}`;
  if (process.env.MORPH_GROUP_CELL && !label.includes(process.env.MORPH_GROUP_CELL)) continue;
  try {
    const got = u8(
      await page.evaluate(
        (f, g, id, tt) => window.__spriteOfMorph(f, g, id, tt),
        doc(leaf(XA, op(oa), ' id="a"') + CIRCLE),
        doc(leaf(XB, op(ob), ' id="a"') + CIRCLE),
        'a',
        t,
      ),
    );
    const control = u8(
      await page.evaluate((sv) => window.__still(sv), doc(leaf(x, op(a), ' id="a"'))),
    );
    const d = maxDiff(got, control);
    if (d > 2) fail(`${label}: differs from the authored leaf by ${d}`);
    else ok(`${label}: vs control ${d}`);
  } catch (e) {
    fail(label + ': ' + e.message);
  }
}
for (const o of [0.5]) {
  const label = `drawSprite a of a sheet whose leaf has opacity ${o} (range [0,3])`;
  try {
    const sheet = doc(leaf(XA, ` opacity="${o}"`, ' id="a"') + CIRCLE);
    const sprite = u8(await page.evaluate((sv, id) => window.__sprite(sv, id), sheet, 'a'));
    const control = u8(
      await page.evaluate((sv) => window.__still(sv), doc(leaf(XA, ` opacity="${o}"`, ' id="a"'))),
    );
    const circle = u8(await page.evaluate((sv, id) => window.__sprite(sv, id), sheet, 'c'));
    const d = maxDiff(sprite, control),
      green = at(circle, 100, 100),
      none = at(circle, 40, 52);
    if (d > 2) fail(`${label}: differs from the leaf alone by ${d}`);
    else if (green[0] > 20 || green[1] < 150)
      fail(`${label}: sprite c is not the circle ([${green}])`);
    else if (maxDiff(none, [255, 255, 255]) > 1) fail(`${label}: sprite c also draws the leaf`);
    else ok(`${label}: vs control ${d}; sprite c draws only the circle`);
  } catch (e) {
    fail(label + ': ' + e.message);
  }
}
await browser.close();
server.close();
const worst = rows.reduce((m, r) => Math.max(m, r.fix.max), 0),
  worstOld = rows.reduce((m, r) => Math.max(m, r.was.max), 0);
console.log(
  `\nChrome 8x, flat pixels, ${rows.length} cells: morph worst ${worst}, the one-after-the-other picture worst ${worstOld}`,
);
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nmorphGroupOpacityRenderSmoke: a fill+stroke leaf morphs as one group, equal to its authored pose and to Chrome',
);
