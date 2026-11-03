// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphFullTurnReanchorRenderSmoke.mjs -- a full turn re-anchors, in pixels: a circle (or ellipse) morphing into the same shape authored as
// ONE arc must stay full at every t, whichever point that arc starts from.
//
// Paired as they come, the two starts would lerp the full turn's stored ends to the midpoint of the two starts, off the ellipse:
// from -x (with a +x circle) the pose at t = 0.5 would be EMPTY, from top and bottom half ink. See morphFullTurnReanchorSmoke.mjs for the record-level proof; this one reads pixels on the GPU.
//
// Drives a real WebGL2 context. MANTLE_GPU is not needed; the default flags are the lane's own.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 200,
  TS = [0, 0.25, 0.5, 0.75, 1];
const st = 'id="s" fill="#2f6fb0"';
const C = `<circle ${st} cx="50" cy="50" r="30"/>`,
  E = `<ellipse ${st} cx="50" cy="50" rx="40" ry="22"/>`;
// one-arc paths over the same ellipse, clockwise, ends a hair apart (a chord of 0.02 of 60 units)
const arc = (cx, cy, rx, ry, which) => {
  const e = 0.0002,
    a = (th) => `${(cx + rx * Math.cos(th)).toFixed(4)} ${(cy + ry * Math.sin(th)).toFixed(4)}`;
  const t0 = { '+x': e, '-x': Math.PI + e, top: -Math.PI / 2 + e, bottom: Math.PI / 2 + e }[which];
  return `<path ${st} d="M ${a(t0)} A ${rx} ${ry} 0 1 1 ${a(t0 + 2 * Math.PI - 2 * e)}"/>`;
};
const PAIRS = {};
for (const w of ['+x', '-x', 'top', 'bottom'])
  PAIRS[`circle -> one arc from ${w}`] = [C, arc(50, 50, 30, 30, w)];
for (const w of ['+x', '-x']) PAIRS[`ellipse -> one arc from ${w}`] = [E, arc(50, 50, 40, 22, w)];
PAIRS['one arc from -x -> circle'] = [arc(50, 50, 30, 30, '-x'), C];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__run = async (a, b, ts) => {
  const svg = (x) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' + x + '</svg>';
  const A = createBundle(gl, await importSvg(svg(a), { preserveViewport: true })), B = createBundle(gl, await importSvg(svg(b), { preserveViewport: true }));
  const m = createShapeMorph(gl, A, B); const out = [];
  for (const t of ts) {
    m.setT(t);
    for (let f = 0; f < 4; f++) { R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N}); R.beginFrame([1, 1, 1, 1]); R.drawBundle(m); R.endFrame(); await new Promise((r) => setTimeout(r, 30)); }
    const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let ink = 0; for (let i = 0; i < px.length; i += 4) ink += (255 - px[i]) / 255;
    out.push(ink);
  }
  return { matched: !!((m._morphSrc || (m.bundle && m.bundle._morphSrc)) || {}).matchedAll, ink: out };
};
window.__ready = true;</script></body></html>`;
const server = http.createServer((req, res) => {
  try {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    res.writeHead(200, { 'content-type': u.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, u)));
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
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction('window.__ready === true', { timeout: 60000 });
let fail = 0;
for (const [name, [a, b]] of Object.entries(PAIRS)) {
  const r = await page.evaluate((x, y, ts) => window.__run(x, y, ts), a, b, TS);
  // a morph between the same ellipse spelled two ways is that ellipse at every t: the ink at t is the ink at 0, to the coverage the
  // two spellings' edge pixels disagree by (the one-arc path is not the ellipse to the last pixel: its ends are 0.02 apart)
  const ink0 = r.ink[0],
    worst = Math.max(...r.ink.map((v) => Math.abs(v - ink0) / ink0));
  const good = r.matched && worst <= 0.02;
  console.log(
    `${good ? '  ok' : 'FAIL'} ${name}: matched ${r.matched}, ink ${r.ink.map((v) => v.toFixed(0)).join(' / ')} (worst frame ${(100 * worst).toFixed(2)}% from the t = 0 ink)`,
  );
  if (!good) fail++;
}
await browser.close();
server.close();
if (fail) {
  console.error(`FAIL morphFullTurnReanchorRenderSmoke: ${fail}`);
  process.exit(1);
}
console.log('morphFullTurnReanchorRenderSmoke PASS');
