// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// patternUnitsRenderSmoke — a <pattern> fill paints what the browser's own SVG renderer paints.
//
// patternUnitsSmoke checks the imported numbers against a reading of SVG 2 §14.3; this checks the PICTURE against
// Chrome's native SVG rasterizer, so a misreading of the spec cannot pass both. Each case fills the whole 100x100
// viewBox, so Mantle's content-bbox fit and the browser's viewBox fit frame it identically.
//
// Cases: userSpaceOnUse with x/y, objectBoundingBox fractions (the default), viewBox meet and slice, patternContentUnits
// objectBoundingBox, href inheritance, and the referencing element's scale and rotation.
//
// Metric: per case, the share of INTERIOR pixels (all 8 neighbours match in the reference, so no edge is under them)
// whose color differs from the reference by more than 48/255 in any channel. Mantle's analytic AA and the browser's
// rasterizer differ only at edges; a wrong tile size, origin or orientation moves whole stripes.
//
// PATTERN TRANSFORM (own page): <pattern patternTransform="rotate(θ)"> must rotate the tile lattice. The inverse linear
// part is stored in the carrier's texel 5; the sample coord is mapped into pattern space before the wrap. Discriminator:
// a 45° stripe pattern's stripes run diagonally, so a VERTICAL scan-line crosses them and hits both colors. An
// un-transformed pattern is vertical stripes, so a vertical scan-line is a SINGLE color. The rotated case must show both
// colors and the control one.
//
// PATTERN CHILDREN (the demo page, one per case): vector patterns with gradient and image fills in their children,
// rendered end-to-end; the framebuffer must carry the expected color signal -- the visual counterpart to
// patternChildrenSmoke (which checks the importer wiring). Confirms the coverage fragment shader's vector-pattern
// composite branch dispatches to sampleGradient / sampleChildImage and paints visible color. The base64-PNG image case
// needs DOM Image / Canvas APIs, so it runs only in the browser. Each case's canvas is saved under test/visuals/pattern/.
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 100;
const stripes = (w, h) =>
  `<rect width="${w}" height="${h}" fill="#ffffff"/><rect width="${w / 2}" height="${h}" fill="#0090ff"/>`;
const svg = (defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" width="100" height="100"><defs>${defs}</defs>${body}</svg>`;
const FULL = '<rect x="0" y="0" width="100" height="100" fill="url(#p)"/>';
const CASES = {
  userSpaceOnUse_xy: svg(
    `<pattern id="p" x="5" y="7" width="26" height="26" patternUnits="userSpaceOnUse">${stripes(26, 26)}</pattern>`,
    FULL,
  ),
  objectBoundingBox: svg(
    `<pattern id="p" x="0.05" y="0" width="0.25" height="0.25" patternContentUnits="userSpaceOnUse">${stripes(25, 25)}</pattern>`,
    FULL,
  ),
  viewBox_meet: svg(
    `<pattern id="p" width="30" height="20" patternUnits="userSpaceOnUse" viewBox="0 0 10 10">${stripes(10, 10)}</pattern>`,
    FULL,
  ),
  viewBox_slice: svg(
    `<pattern id="p" width="30" height="20" patternUnits="userSpaceOnUse" viewBox="0 0 10 10" preserveAspectRatio="xMinYMin slice">${stripes(10, 10)}</pattern>`,
    FULL,
  ),
  contentUnits_obb: svg(
    `<pattern id="p" width="20" height="20" patternUnits="userSpaceOnUse" patternContentUnits="objectBoundingBox">${stripes(0.2, 0.2)}</pattern>`,
    FULL,
  ),
  href: svg(
    `<pattern id="base" width="24" height="24" patternUnits="userSpaceOnUse">${stripes(24, 24)}</pattern><pattern id="p" xlink:href="#base" x="6"/>`,
    FULL,
  ),
  group_scale2: svg(
    `<pattern id="p" width="13" height="13" patternUnits="userSpaceOnUse">${stripes(13, 13)}</pattern>`,
    `<g transform="scale(2)"><rect width="50" height="50" fill="url(#p)"/></g>`,
  ),
  group_rotate30: svg(
    `<pattern id="p" width="26" height="26" patternUnits="userSpaceOnUse">${stripes(26, 26)}</pattern>`,
    `<g transform="rotate(30 50 50)"><rect x="-60" y="-60" width="220" height="220" fill="url(#p)"/></g>`,
  ),
};

const HTML = `<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="${N}" height="${N}"></canvas><canvas id="r" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const N = ${N}, CASES = ${JSON.stringify(CASES)};
const gl = document.getElementById('c').getContext('webgl2', { stencil: true, depth: true, antialias: false, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const r = createRenderer(gl, shaders);
const id = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const ref2d = document.getElementById('r').getContext('2d', { willReadFrequently: true });
async function native(svg) {
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  ref2d.fillStyle = '#000'; ref2d.fillRect(0, 0, N, N);
  ref2d.drawImage(img, 0, 0, N, N);
  return ref2d.getImageData(0, 0, N, N).data;       // top row first
}
async function mantle(svg) {
  const b = createBundle(gl, await importSvg(svg));
  for (let i = 0; i < 3; i++) { r.setViewport(N, N); r.beginFrame([0, 0, 0, 1]); r.drawBundle(b, { worldMatrix: id }); r.endFrame(); }
  const px = new Uint8Array(N * N * 4);
  gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px);   // bottom row first
  const out = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) out.set(px.subarray((N - 1 - y) * N * 4, (N - y) * N * 4), y * N * 4);
  try { b.dispose(); } catch {}
  return out;
}
const out = {};
try {
  for (const [name, svg] of Object.entries(CASES)) {
    const ref = await native(svg), got = await mantle(svg);
    let interior = 0, wrong = 0;
    const same = (a, b) => Math.max(Math.abs(ref[a] - ref[b]), Math.abs(ref[a + 1] - ref[b + 1]), Math.abs(ref[a + 2] - ref[b + 2])) <= 8;
    for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
      const o = (y * N + x) * 4;
      let flat = true;
      for (let dy = -1; dy <= 1 && flat; dy++) for (let dx = -1; dx <= 1; dx++) if (!same(o, ((y + dy) * N + x + dx) * 4)) { flat = false; break; }
      if (!flat) continue;
      interior++;
      if (Math.max(Math.abs(ref[o] - got[o]), Math.abs(ref[o + 1] - got[o + 1]), Math.abs(ref[o + 2] - got[o + 2])) > 48) wrong++;
    }
    out[name] = { interior, wrong };
  }
  out.ok = true;
} catch (e) { out.err = String((e && e.stack) || e); }
window.__out = out;
</script></body></html>`;

// 26px tile: white, with the left 13px an OPAQUE cyan stripe → vertical stripes
// when un-transformed. The fill rect is the whole 100×100 viewport.
const tile = (xform) =>
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs>' +
  `<pattern id="p" width="26" height="26" patternUnits="userSpaceOnUse"${xform}>` +
  '<rect width="26" height="26" fill="#ffffff"/><rect width="13" height="26" fill="#0090ff"/></pattern>' +
  '</defs><rect x="0" y="0" width="100" height="100" fill="url(#p)"/></svg>';
const ROTATED = tile(' patternTransform="rotate(45)"');
const CONTROL = tile('');

const TRANSFORM_HTML = `<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { stencil:true, depth:true, antialias:false, preserveDrawingBuffer:true });
const sh = await loadShaders(new URL('/src/shaders/', location.href).href);
const r = createRenderer(gl, sh);
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
async function render(svg) {
  const b = createBundle(gl, await importSvg(svg));
  r.setViewport(100,100); r.beginFrame([0,0,0,1]);
  r.drawBundle(b, { worldMatrix: id }); r.endFrame();
  const px = (x,yTop) => { const a=new Uint8Array(4); gl.readPixels(x,100-1-yTop,1,1,gl.RGBA,gl.UNSIGNED_BYTE,a); return [a[0],a[1],a[2]]; };
  // Scan a vertical line at x=50 across y.
  const col = [];
  for (let y = 5; y < 100; y += 6) col.push(px(50, y));
  return col;
}
window.__run = async () => ({ rotated: await render(${JSON.stringify(ROTATED)}), control: await render(${JSON.stringify(CONTROL)}) });
window.__ready = true;
</script></body></html>`;

// The demo-page cases: an image-filled and a gradient-filled pattern tile.
const VISUAL_CASES = [
  {
    name: 'pattern-image',
    svgUrl: 'examples/_pattern_image.svg',
    desc: 'tile with embedded RGBA base64 PNG (R/G/B/Y quadrants)',
    // The 32x32 PNG has all four primary channels. Demand visible
    // coverage in each — the coverage shader composite branch dispatches
    // sampleChildImage on cImgId > 0 for FLAG_LAYER rows inside the
    // carrier's atlasSlot.w==2 branch.
    expect: (s) => s.redish > 100 && s.greenish > 100 && s.blueish > 100,
  },
  {
    name: 'pattern-gradient',
    svgUrl: 'examples/_pattern_gradient.svg',
    desc: 'tile with linear gradient (R→B) + radial gradient (Y→G) children',
    // The pattern paints a horizontal red→blue linear behind a
    // yellow→green radial dot per tile. Demand visible red, blue,
    // and yellow/green channel signal across the framebuffer.
    expect: (s) => s.redish > 100 && s.blueish > 100 && (s.greenish > 100 || s.nonWhite > 50000),
  },
];

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/' || u.pathname === '/transform') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(u.pathname === '/' ? HTML : TRANSFORM_HTML);
    return;
  }
  try {
    const b = readFileSync(path.join(ROOT, decodeURIComponent(u.pathname)));
    res.writeHead(200, {
      'content-type':
        (/\.(js|mjs)$/.test(u.pathname)
          ? 'text/javascript'
          : u.pathname.endsWith('.html')
            ? 'text/html'
            : u.pathname.endsWith('.svg')
              ? 'image/svg+xml'
              : 'text/plain') + '; charset=utf-8',
    });
    res.end(b);
  } catch {
    try {
      res.writeHead(404);
    } catch {}
    res.end();
  }
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 30000,
});
await page
  .waitForFunction('window.__out !== undefined', { timeout: 120000, polling: 100 })
  .catch(() => {});
const r = await page.evaluate(() => window.__out);
await page.close();

let failures = 0;
if (!r || !r.ok) {
  console.log('FAIL did not complete: ' + (r && r.err));
  failures++;
} else {
  for (const [name, v] of Object.entries(r)) {
    if (name === 'ok') continue;
    const share = v.interior ? v.wrong / v.interior : 1;
    const pass = v.interior > 1000 && share <= 0.01;
    console.log(
      `${pass ? '  ok' : 'FAIL'} ${name}: ${v.wrong} of ${v.interior} interior px differ from the browser's rendering (${(share * 100).toFixed(2)}%)`,
    );
    if (!pass) failures++;
  }
}
console.log(failures ? `\nPATTERN-UNITS-RENDER FAIL (${failures})` : '\nPATTERN-UNITS-RENDER PASS');
// The rotated lattice against its untransformed control, on its own page.
async function transformSection() {
  const ok = (m) => console.log('ok ' + m);
  const fail = (m) => {
    failures++;
    console.error('FAIL: ' + m);
  };
  const isCyan = (p) => p[2] > 150 && p[0] < 90;
  const isWhite = (p) => p[0] > 200 && p[1] > 200 && p[2] > 200;
  const countColors = (col) => ({
    cyan: col.filter(isCyan).length,
    white: col.filter(isWhite).length,
  });

  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await openReady(page, `http://127.0.0.1:${server.address().port}/transform`, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return;
  }

  const r = await page.evaluate(() => window.__run());
  const rc = countColors(r.rotated),
    cc = countColors(r.control);
  console.log('  rotated vertical scan:', JSON.stringify(rc), '| control:', JSON.stringify(cc));

  // Rotated (45°): the vertical scan-line crosses diagonal stripes → both colors.
  if (rc.cyan >= 3 && rc.white >= 3)
    ok('rotate(45) pattern: vertical scan hits BOTH stripe colors (diagonal lattice)');
  else fail('rotated pattern not diagonal (vertical scan one color): ' + JSON.stringify(rc));

  // Control (no transform): vertical stripes → the x=50 scan-line is ONE color.
  if (cc.cyan === 0 || cc.white === 0)
    ok(
      'control (no patternTransform): vertical scan is a single color (vertical stripes) — test discriminates',
    );
  else fail('control not vertical stripes — discriminator weak: ' + JSON.stringify(cc));

  await page.close();
}
// The pattern-children cases on the demo page, a page per case.
async function childrenSection() {
  const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'visuals', 'pattern');
  mkdirSync(OUT, { recursive: true });
  function fail(name, msg) {
    failures++;
    console.error(`FAIL [${name}]: ${msg}`);
  }
  for (const c of VISUAL_CASES) {
    const page = await browser.newPage();
    await page.setViewport({ width: 400, height: 400 });
    page.on('pageerror', (e) => console.error(`  [${c.name} page-err]`, e.message));
    page.on('console', (m) => {
      const t = m.text();
      if (/error|fail|warn|status/i.test(t)) console.log(`  [${c.name} console]`, t);
    });
    // Auto-load via the demo's `?svg=` query param. The demo fetches
    // the URL, runs importSvg, and calls setBundle → renderer.render().
    const target = `http://127.0.0.1:${server.address().port}/mantleDemo.html?svg=/${encodeURIComponent(c.svgUrl)}`;
    try {
      await page.goto(target, { waitUntil: 'load', timeout: pageTimeoutFor() });
      // Wait for the demo's status to settle out of the "Fetching …"
      // message — boot() updates it once the SVG either loads or fails.
      await page.waitForFunction(
        () => {
          const st = document.getElementById('status');
          return st && !/Fetching|Converting/.test(st.textContent);
        },
        { timeout: pageTimeoutFor(), polling: 100 },
      );
    } catch (e) {
      const statusTxt = await page.evaluate(
        () => document.getElementById('status') && document.getElementById('status').textContent,
      );
      fail(c.name, `goto/wait failed: ${e.message} (status="${statusTxt}")`);
      await page.close();
      continue;
    }
    // Read back framebuffer pixels. The demo's WebGL context was
    // created without preserveDrawingBuffer, so we can't read the back
    // buffer directly after a render+present cycle. Instead, the demo
    // exposes its renderer + gl handles globally; trigger a fresh
    // render then immediately read pixels in the same tick before the
    // implicit swap. (Browsers preserve the back buffer until JS yields
    // to the event loop — calling readPixels right after render() inside
    // the same tick is safe.)
    const stats = await page.evaluate(() => {
      const cnv = document.getElementById('glcanvas');
      if (!cnv) return null;
      const gl = window.__mantleGl;
      const renderer = window.__mantleRenderer;
      if (!gl || !renderer) return null;
      // Fresh render + readPixels in the same synchronous tick — the
      // demo's WebGL2 context has preserveDrawingBuffer:false, so we
      // must read before the browser yields to the event loop.
      renderer.render();
      const bundle = window.__mantleGetBundle && window.__mantleGetBundle();
      const dbgBundle = bundle
        ? {
            numShapes: bundle.numShapes,
            gradientCount: bundle.gradientCount,
            gradientStopsCount: bundle.gradientStopsCount,
            hasGradientTex: !!bundle.gradientTex,
            hasGradientStopsTex: !!bundle.gradientStopsTex,
            drawListLen: bundle.drawList ? bundle.drawList.length : 0,
          }
        : null;
      const w = cnv.width,
        h = cnv.height;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let opaque = 0;
      let redish = 0,
        greenish = 0,
        blueish = 0;
      let nonWhite = 0;
      let sampleRGB = null;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i],
          g = px[i + 1],
          b = px[i + 2],
          a = px[i + 3];
        if (a < 16) continue;
        opaque++;
        if (r < 240 || g < 240 || b < 240) {
          nonWhite++;
          if (!sampleRGB) sampleRGB = [r, g, b, a];
        }
        if (r > 64 && r - g > 32 && r - b > 32) redish++;
        if (g > 64 && g - r > 32 && g - b > 32) greenish++;
        if (b > 64 && b - r > 32 && b - g > 32) blueish++;
      }
      // Targeted samples: in pattern_gradient, the linear gradient
      // (red→blue, horizontal) fills 0..40 in pattern-em-space and is
      // tiled across 20..180. So at the left edge of a tile we expect
      // red-ish; at the right edge of a tile, blue-ish; at the center
      // of a tile, the radial gradient (yellow→green) blots over the
      // linear. Sample a row of pixels across one tile to verify the
      // gradient actually paints.
      const rowY = (h / 2) | 0;
      const rowSamples = [];
      for (let sx = 0; sx <= w; sx += w / 20) {
        const idx = (rowY * w + Math.min(w - 1, sx | 0)) * 4;
        rowSamples.push([px[idx], px[idx + 1], px[idx + 2], px[idx + 3]]);
      }
      return {
        w,
        h,
        opaque,
        redish,
        greenish,
        blueish,
        nonWhite,
        sampleRGB,
        rendererAvail: !!renderer,
        glAvail: !!gl,
        rowSamples,
        dbgBundle,
      };
    });
    if (stats.dbgBundle) console.log(`  bundle[${c.name}]:`, JSON.stringify(stats.dbgBundle));
    if (!stats) {
      fail(c.name, 'no canvas / WebGL2 context');
      await page.close();
      continue;
    }
    console.log(
      `  diag[${c.name}]: w=${stats.w} h=${stats.h} opaque=${stats.opaque} nonWhite=${stats.nonWhite} sample=${JSON.stringify(stats.sampleRGB)} renderer=${stats.rendererAvail} gl=${stats.glAvail}`,
    );
    if (stats.rowSamples && c.name === 'pattern-gradient') {
      console.log(
        `  row[${c.name}]: ${stats.rowSamples
          .slice(0, 8)
          .map((p) => `(${p[0]},${p[1]},${p[2]})`)
          .join(' ')}`,
      );
    }
    // Capture the rendered PNG for inspection.
    // Snapshot the canvas via toDataURL — page.screenshot grabs the
    // composited page (HTML chrome), not the WebGL canvas pixels.
    const dataUrl = await page.evaluate(() => {
      const cnv = document.getElementById('glcanvas');
      const renderer = window.__mantleRenderer;
      if (!cnv || !renderer) return null;
      renderer.render();
      return cnv.toDataURL('image/png');
    });
    if (dataUrl && dataUrl.startsWith('data:image/png;base64,')) {
      writeFileSync(
        path.join(OUT, `${c.name}.png`),
        Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'),
      );
    }

    if (c.expect(stats)) {
      console.log(
        `PASS ${c.name}: opaque=${stats.opaque} r=${stats.redish} g=${stats.greenish} b=${stats.blueish}`,
      );
    } else {
      fail(
        c.name,
        `coverage insufficient: opaque=${stats.opaque} r=${stats.redish} g=${stats.greenish} b=${stats.blueish}`,
      );
    }
    await page.close();
  }
}
{
  const before = failures;
  await transformSection();
  console.log(
    failures === before
      ? '\nPATTERN-TRANSFORM PASS'
      : `\nPATTERN-TRANSFORM FAIL (${failures - before})`,
  );
}
{
  const before = failures;
  await childrenSection();
  console.log(
    failures === before
      ? `\nPATTERN VISUAL PASS (${VISUAL_CASES.length} cases)`
      : `\nPATTERN VISUAL FAIL (${failures - before})`,
  );
}
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
