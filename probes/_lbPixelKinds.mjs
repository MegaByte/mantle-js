// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbPixelKinds.mjs -- which LB fragment kinds land on a neighborhood of one pixel, and are they saturated.
// GPU probe: run it alone. usage: node probes/_lbPixelKinds.mjs OUT.json   (cases are inline)
import { writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2];
const body =
  '<path fill="#fff" d="M95.8,63.85Q95.8,94.6 64.3,94.6Q32.8,94.6 32.8,63.85Q32.8,33.1 64.3,33.1Q95.8,33.1 95.8,63.85Z"/>';
const dm =
  '<rect x="0" y="0" width="1" height="1" fill="#fff" fill-opacity="0.01"/><rect x="127" y="127" width="1" height="1" fill="#fff" fill-opacity="0.01"/>';
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${body}${dm}</svg>`;
const sh = (m, dx, dy) => {
  const a = m.slice();
  a[6] += (dx * 2) / 128;
  a[7] += (dy * 2) / 128;
  return a;
};
const AX = [1.3, 0, 0, 0, 0.55, 0, 0, 0, 1];
const CASES = [
  { name: 'aniso dy0 (BAD px 64,80)', M: sh(AX, 0, 0), px: [64, 80] },
  { name: 'aniso dy.25 (BAD px 64,80)', M: sh(AX, 0, 0.25), px: [64, 80] },
  { name: 'aniso dy.5 (ok)', M: sh(AX, 0, 0.5), px: [64, 80] },
  { name: 'identity (ok)', M: [1, 0, 0, 0, 1, 0, 0, 0, 1], px: [64, 95] },
];
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="128" height="128"></canvas><script type="module">
globalThis.__MANTLE_DEBUG__ = true;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { setSdfPrimitivesEnabled } from '/src/geom/shapeRecognize.js';
setSdfPrimitivesEnabled(false);   // the SAME path as the accuracy harness: a recognised ellipse would draw as a DISC primitive
const S = 128;
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const n = (v) => Math.round(v / (255 / 64));
const out = [];
for (const c of ${JSON.stringify(CASES)}) for (const claim of [true]) {
  const r = createRenderer(gl, shaders, { aacFill: false, fillDefines: ['MANTLE_LB_FILL', 'MANTLE_LB_FRAGDBG 0.004'], unifiedFillDepthClaim: claim });
  const b = createBundle(gl, await importSvg(${JSON.stringify(SVG)}, {preserveViewport: true}));
  r.setLoopBlinnFill('on'); try { r.prepareBundle(b); } catch {} try { await r.awaitLbReady(b, 20000); } catch {}
  r.setViewport(S, S);
  for (let i = 0; i < 2; i++) { r.beginFrame([0, 0, 0, 0]); r.drawBundle(b, { worldMatrix: c.M }); r.endFrame(); }
  const px = new Uint8Array(S * S * 4); gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const rows = [];
  for (let y = c.px[1] - 2; y <= c.px[1] + 2; y++) { const row = []; for (let x = c.px[0] - 3; x <= c.px[0] + 3; x++) { const o = ((S - 1 - y) * S + x) * 4; row.push(n(px[o + 3]) + ':' + Math.round(px[o] / (255 / 64) * 15) + ':s' + n(px[o + 1]));   // fragments : kind (coarse; 8-bit rounding) : saturated } rows.push(row.join(' ')); }
  out.push({ name: c.name, claim, rows }); b.dispose(); r.dispose();
}
window.out = out;
</script></body></html>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    const b = await_read(path.join(ROOT, decodeURIComponent(u.pathname)));
    res.writeHead(200, {
      'content-type':
        u.pathname.endsWith('.js') || u.pathname.endsWith('.mjs')
          ? 'text/javascript'
          : 'text/plain',
    });
    res.end(b);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
import { readFileSync } from 'fs';
function await_read(p) {
  return readFileSync(p);
}
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 180000,
});
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (e) => logs.push(String(e.message)));
page.on('console', (m) => {
  if (m.type() === 'error') logs.push(m.text());
});
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 30000,
});
try {
  await page.waitForFunction('typeof window.out !== "undefined"', { timeout: 120000 });
} catch {
  console.log('never finished', logs.join('|'));
  await browser.close();
  server.close();
  process.exit(1);
}
const r = await page.evaluate(() => window.out);
await browser.close();
server.close();
writeFileSync(OUT, JSON.stringify(r));
for (const o of r) {
  console.log(`== ${o.name} claim=${o.claim}  (fragments:kind:saturated)`);
  for (const l of o.rows) console.log('  ' + l);
}
