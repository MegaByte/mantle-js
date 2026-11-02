// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbFillVariantCompileSmoke.mjs — the ubershader can HOST Loop-Blinn coverage.
//
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

const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
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
  protocolTimeout: 120000,
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text());
});
page.on('pageerror', (e) => logs.push(String(e.message)));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 30000,
});
try {
  await page.waitForFunction('typeof out_diff !== "undefined"', { timeout: 60000, polling: 100 });
} catch (e) {
  console.log(
    '  page never finished. diagnostics:\n    ' + (logs.join('\n    ') || '(none captured)'),
  );
  await browser.close();
  server.close();
  process.exit(1);
}
const r = await page.evaluate(() => ({ err: out_err, ink: out_ink, diff: out_diff }));
await browser.close();
server.close();

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
  `\nlbFillVariantCompileSmoke: ${fail ? 'FAIL' : 'PASS'} — the ubershader hosts lbCoverage`,
);
process.exit(fail ? 1 : 0);
