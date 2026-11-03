// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// unifiedFillDrawSmoke.mjs — cover quads and Loop-Blinn triangles render
// correctly in ONE drawArrays through the fill ubershader.
//
// The end-to-end proof. With coverage and paint in different programs an LB
// shape would reach the paint pipeline only by rendering coverage to an RT and
// compositing per shape — a stroked bundle costing over a hundred GL draws where
// Slug costs 1. The ubershader computes LB coverage itself, so the whole bundle
// is one painter-sorted buffer and one draw.
//
// Asserts what actually matters:
//   • ONE GL draw call for the whole bundle;
//   • the result matches Slug (it is the reference — this is a different way to
//     compute the same coverage, not a different picture);
//   • LB geometry really was in the buffer, so a silent fallback to all-cover-
//     quads cannot pass.
//
// THE VARIANT ITSELF (first page, so both of its programs compile fresh in this browser, as they would
// in an app's first frame; the unified draw's own page comes after it).
// MANTLE_LB_FILL splices lbCoverage() (and its varyings, and the vertex-side
// setup) into mantle.vert/frag, so an LB triangle computes its own coverage and
// then takes the ordinary paint/stroke/clip/mask/filter path in the same draw as
// the cover quads — instead of rendering coverage to an RT and compositing per
// shape, which would cost a stroked bundle 2N+ draws where Slug costs 1.
//
// The unified draw is what routes geometry through it; this asserts the two
// things the variant itself must keep, which would silently rot otherwise:
//   1. the variant COMPILES AND LINKS — buildShaders does no GLSL validation, so
//      without this the splice could be broken and no suite would notice;
//   2. it renders cover-quad content IDENTICALLY to the default program, since
//      every cover-quad vertex is stamped vKind = -1 and must take the existing
//      coverage path untouched.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Curved, solid, opaque — the class the LB route is built for.
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M50 10 C80 10 90 40 90 55 C90 80 65 92 50 92 C35 92 10 80 10 55 C10 40 20 10 50 10Z" fill="#3060c0"/>' +
  '<circle cx="34" cy="46" r="9" fill="#e0e0f0"/></svg>';

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const S = 200;
const gl = document.getElementById('c').getContext('webgl2',
  { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sec = await importSvg(${JSON.stringify(SVG)});

let draws = 0;
for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
  const orig = gl[m].bind(gl);
  gl[m] = (...a) => { draws++; return orig(...a); };
}
const read = () => { const px = new Uint8Array(S * S * 4);
  gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };

// Reference: plain Slug, cover quads only.
const rs = createRenderer(gl, shaders, { aacFill: false });
const bs = createBundle(gl, sec);
rs.setViewport(S, S); rs.beginFrame([0, 0, 0, 1]); rs.drawBundle(bs, {}); rs.endFrame();
const slug = read();

// Unified: same content, LB coverage computed inside the ubershader.
const ru = createRenderer(gl, shaders, { aacFill: false, fillDefines: ['MANTLE_LB_FILL'] });
const bu = createBundle(gl, sec);
ru.setLoopBlinnFill('on');
try { ru.prepareBundle(bu); } catch {}
if (ru.awaitLbReady) { try { await ru.awaitLbReady(bu, 20000); } catch {} }

const meshes = bu._lbMeshes || [];
let lbShapes = 0, lbVerts = 0;
for (const m of meshes) if (m && !m.slug && m.vertexCount > 0) { lbShapes++; lbVerts += m.vertexCount; }

ru.setViewport(S, S);
ru.beginFrame([0, 0, 0, 1]);
draws = 0;
ru.drawBundle(bu, {});
const unifiedDraws = draws;
const served = unifiedDraws > 0;
ru.endFrame();
const uni = read();

let diff = 0, n = 0, inkS = 0, inkU = 0;
for (let i = 0; i < S * S; i++) {
  const o = i * 4;
  const a = slug[o] + slug[o + 1] + slug[o + 2], b = uni[o] + uni[o + 1] + uni[o + 2];
  if (a > 24) inkS++;
  if (b > 24) inkU++;
  if (a > 24 || b > 24) { n++; for (let k = 0; k < 3; k++) diff += Math.abs(slug[o + k] - uni[o + k]); }
}
window.out = { served, unifiedDraws, lbShapes, lbVerts,
               inkS, inkU, meanDiff: n ? +(diff / (n * 3)).toFixed(2) : 0 };
</script></body></html>`;

// The variant page: the default program against MANTLE_LB_FILL on cover-quad content.
const VARIANT_HTML = (() => {
  const SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<path d="M50 12 C82 12 88 50 50 88 C12 50 18 12 50 12Z" fill="#3060c0" stroke="#c03030" stroke-width="6"/>' +
    '<circle cx="30" cy="70" r="14" fill="#40a060"/></svg>';

  const HTML = `<!DOCTYPE html><html><body>
  <canvas id="c" width="160" height="160"></canvas>
  <script type="module">
  globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
  import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
  const gl = document.getElementById('c').getContext('webgl2',
    { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
  const sec = await importSvg(${JSON.stringify(SVG)});

  const shoot = (opts) => {
    const r = createRenderer(gl, shaders, opts);
    const b = createBundle(gl, sec);
    r.setViewport(160, 160);
    r.beginFrame([0, 0, 0, 1]);
    r.drawBundle(b, {});
    r.endFrame();
    const px = new Uint8Array(160 * 160 * 4);
    gl.readPixels(0, 0, 160, 160, gl.RGBA, gl.UNSIGNED_BYTE, px);
    try { b.dispose(); } catch {}
    return px;
  };

  let err = null;
  const onErr = (e) => { err = String(e.message || e); };
  window.addEventListener('error', onErr);

  const base = shoot({ aacFill: false });
  // The variant under test. A link failure surfaces as a console error and a
  // blank frame, so both the pixel check and the ink check below catch it.
  const lb = shoot({ aacFill: false, fillDefines: ['MANTLE_LB_FILL'] });

  let diff = 0, ink = 0;
  for (let i = 0; i < 160 * 160; i++) {
    const o = i * 4;
    if (base[o] + base[o + 1] + base[o + 2] > 24) ink++;
    for (let k = 0; k < 3; k++) diff += Math.abs(base[o + k] - lb[o + k]);
  }
  window.out_err = err;
  window.out_ink = ink;
  window.out_diff = diff;
  </script></body></html>`;
  return HTML;
})();

const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
    return;
  }
  if (u.pathname === '/variant') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(VARIANT_HTML);
    return;
  }
  try {
    const b = readFileSync(path.join(ROOT, decodeURIComponent(u.pathname)));
    res.writeHead(200, { 'content-type': mime(u.pathname) + '; charset=utf-8' });
    res.end(b);
  } catch {
    try {
      res.writeHead(404);
    } catch {}
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 180000,
});
// ---- the MANTLE_LB_FILL variant compiles, links and leaves cover-quad pixels byte-identical ----
let variantFail = 0;
{
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text());
  });
  page.on('pageerror', (e) => logs.push(String(e.message)));
  await page.goto(`http://127.0.0.1:${server.address().port}/variant`, {
    waitUntil: 'load',
    timeout: 30000,
  });
  let finished = true;
  try {
    await page.waitForFunction('typeof out_diff !== "undefined"', { timeout: 60000, polling: 100 });
  } catch (e) {
    console.log(
      '  page never finished. diagnostics:\n    ' + (logs.join('\n    ') || '(none captured)'),
    );
    finished = false;
    variantFail++;
  }
  if (finished) {
    const r = await page.evaluate(() => ({ err: out_err, ink: out_ink, diff: out_diff }));
    let fail = 0;
    const ok = (c, m) => {
      console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
      if (!c) fail++;
    };
    console.log(`  ${JSON.stringify(r)}`);
    // A shader that fails to compile logs it; anything mentioning the LB splice is fatal.
    const shaderErr = logs.filter((l) => /shader|compil|link|GLSL|ERROR:/i.test(l));
    if (shaderErr.length) console.log('  shader diagnostics:\n    ' + shaderErr.join('\n    '));
    ok(!shaderErr.length, 'MANTLE_LB_FILL variant compiles and links (no shader diagnostics)');
    ok(r.ink > 2000, `content actually rendered (${r.ink}px ink)`);
    ok(
      r.diff === 0,
      `cover-quad output byte-identical to the default program (total channel diff ${r.diff})`,
    );
    console.log(
      `\nMANTLE_LB_FILL variant: ${fail ? 'FAIL' : 'PASS'} — the ubershader hosts lbCoverage`,
    );
    variantFail += fail;
  }
  await page.close();
}

const page = await browser.newPage();
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error') logs.push(m.text());
});
page.on('pageerror', (e) => logs.push(String(e.message)));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 30000,
});
try {
  await page.waitForFunction('typeof window.out !== "undefined"', { timeout: 90000, polling: 100 });
} catch {
  console.log('  page never finished:\n    ' + (logs.join('\n    ') || '(none)'));
  await browser.close();
  server.close();
  process.exit(1);
}
const r = await page.evaluate(() => window.out);
await browser.close();
server.close();

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
console.log(`  ${JSON.stringify(r)}`);
if (logs.length) console.log('  console errors:\n    ' + logs.join('\n    '));
ok(r.served === true, 'the unified path served the bundle');
ok(
  r.lbShapes > 0,
  `LB meshes actually present (${r.lbShapes} shapes, ${r.lbVerts} verts) — not a silent all-cover-quad fallback`,
);
ok(r.unifiedDraws === 1, `whole bundle drawn in ONE GL call (got ${r.unifiedDraws})`);
ok(r.inkU > 3000, `unified path rendered ink (${r.inkU}px)`);
ok(
  Math.abs(r.inkU - r.inkS) / Math.max(r.inkS, 1) < 0.05,
  `ink within 5% of Slug (${r.inkU} vs ${r.inkS})`,
);
ok(r.meanDiff < 12, `mean channel difference vs Slug is AA-scale (${r.meanDiff})`);

console.log(`\nunifiedFillDrawSmoke: ${fail ? 'FAIL' : 'PASS'} — cover quads + LB in one draw`);
process.exit(fail || variantFail ? 1 : 0);
