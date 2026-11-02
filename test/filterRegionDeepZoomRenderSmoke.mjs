// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterRegionDeepZoomRenderSmoke -- a filter region's edge past 2^31 px does not wrap. A scissor that took its edges with a bit-or would turn the region into a rect that holds nothing under a deep
// zoom: a flood blanks at scale 2^23 and 2^24 and comes back at 2^26. On a real GPU the canvas sits inside the region at each of these scales, so every pixel is painted, with the filter's own color.
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 256,
  SCALES = [20, 22, 23, 24, 25, 26, 28, 31];
const FLOOD =
  '<filter id="f" filterUnits="userSpaceOnUse" x="40" y="40" width="320" height="320"><feFlood flood-color="#36c" flood-opacity="0.8"/></filter>';
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs>${FLOOD}</defs><rect width="400" height="400" fill="none"/>${body}</svg>`;
const CASES = [
  [
    'a flood on a group',
    doc('<g filter="url(#f)"><rect x="150" y="150" width="100" height="100" fill="#c33"/></g>'),
  ],
  [
    'a flood on a leaf',
    doc('<rect x="150" y="150" width="100" height="100" fill="#c33" filter="url(#f)"/>'),
  ],
];
const HTML = `<!DOCTYPE html><html><body><script type="module">
const api = await import('/src/index.js');
const shaders = await api.loadShaders(new URL('/src/shaders/', location.href).href);
window.__run = async (svg, scales) => {
  const cv = document.createElement('canvas'); cv.width = cv.height = ${N};
  const gl = cv.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, depth: true, stencil: true });
  const r = api.createRenderer(gl, shaders, {}); if (r.ready) await r.ready; r.setViewport(${N}, ${N});
  const b = api.createBundle(gl, await api.importSvg(svg, { preserveViewport: true }));
  r.prewarmBundle(b); r.precompileFills();
  const out = [];
  for (const k of scales) {
    const s = 2 ** k, m = new Float32Array([s, 0, 0, 0, s, 0, 0, 0, 1]);
    const d = () => { r.beginFrame([1, 1, 1, 1]); r.drawBundle(b, { worldMatrix: m }); r.endFrame(); };
    await r.warmScene([{ name: 'c', draw: d }], { maxPasses: 8, fenceTimeoutMs: 20000 });
    for (let i = 0; i < 3; i++) { d(); await new Promise((q) => setTimeout(q, 3)); }
    const p = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, p);
    let ink = 0; for (let i = 0; i < p.length; i += 4) if (p[i] !== 255 || p[i + 1] !== 255 || p[i + 2] !== 255) ink++;
    const c = (${N} >> 1) * ${N} * 4 + (${N} >> 1) * 4;
    out.push({ k, ink, center: [p[c], p[c + 1], p[c + 2]], err: gl.getError() });
  }
  r.dispose(); gl.getExtension('WEBGL_lose_context')?.loseContext();
  return out;
};
window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--no-sandbox', '--enable-unsafe-swiftshader']
      : ['--no-sandbox', '--use-angle=metal', '--use-gl=angle'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page-err]', e.message));
await openReady(page, `http://127.0.0.1:${server.address().port}/`, { ready: 'flag' });
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
for (const [name, svg] of CASES) {
  for (const o of await page.evaluate((s, k) => window.__run(s, k), svg, SCALES)) {
    ok(
      o.ink === N * N && o.center[0] < 120 && o.center[2] > 180 && o.err === 0,
      `${name} at 2^${o.k}: ${o.ink} of ${N * N} px painted, center ${o.center}, GL error ${o.err}`,
    );
  }
}
await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall ok');
process.exit(fail ? 1 : 0);
