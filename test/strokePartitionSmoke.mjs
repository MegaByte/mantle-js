// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokePartitionSmoke.mjs — bisector ownership reproduces the MAX-union.
//
// The split stroke emits one quad per segment, and adjacent quads OVERLAP at
// every joint. That overlap is the only reason the pass needs a MAX-blended
// coverage render target: plain OVER would double-blend a translucent stroke
// there. The RT costs a per-shape composite (so a stroked bundle draws 2N+ times
// where Slug draws once) and quantizes every stroke's AA to 8 bits.
//
// With ownership on, each segment claims only its side of the angle bisector
// with each neighbor, so coverage becomes a PARTITION and OVER is exact at any
// alpha — which is the precondition for stroke segments joining the unified fill
// draw and the RT going away.
//
// This asserts the partition is not a different picture: same ink, AA-scale
// difference, and crucially NO SEAMS at the joints, which is the failure mode a
// bad ownership rule produces (a dropped row of pixels where both segments
// think the other owns it).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// A polyline with sharp joints plus a curve: the joints are where ownership
// actually decides anything. Stroked, unfilled, so only the stroke is measured.
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M12 80 L34 26 L56 74 L78 26 C88 40 92 60 88 80" fill="none" ' +
  'stroke="#c03030" stroke-width="9" stroke-linejoin="miter" stroke-linecap="butt"/></svg>';

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="240" height="240"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const S = 240;
const gl = document.getElementById('c').getContext('webgl2',
  { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sec = await importSvg(${JSON.stringify(SVG)});
const read = () => { const px = new Uint8Array(S * S * 4);
  gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };

const shoot = (partition) => {
  const r = createRenderer(gl, shaders, { aacFill: false });
  const b = createBundle(gl, sec);
  r.setLoopBlinnFill('on');
  if (r.setStrokePartition) r.setStrokePartition(partition);
  try { r.prepareBundle(b); } catch {}
  r.setViewport(S, S); r.beginFrame([0, 0, 0, 1]); r.drawBundle(b, {}); r.endFrame();
  const px = read();
  try { b.dispose(); } catch {}
  return px;
};

const union = shoot(false);
const part  = shoot(true);

const lum = (px, i) => px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2];
let inkU = 0, inkP = 0, diff = 0, n = 0, worst = 0;
// A seam is an interior hole: a pixel the union painted SOLID that the partition
// left (near) empty. That is the specific artifact a wrong ownership rule makes.
let seams = 0;
for (let i = 0; i < S * S; i++) {
  const a = lum(union, i), b = lum(part, i);
  if (a > 24) inkU++;
  if (b > 24) inkP++;
  if (a > 24 || b > 24) {
    n++;
    let d = 0;
    for (let k = 0; k < 3; k++) d += Math.abs(union[i * 4 + k] - part[i * 4 + k]);
    diff += d;
    if (d > worst) worst = d;
  }
  if (a > 600 && b < 120) seams++;
}
window.out = { inkU, inkP, meanDiff: n ? +(diff / (n * 3)).toFixed(2) : 0,
               worstPx: worst, seams };
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
  protocolTimeout: 180000,
});
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
ok(r.inkU > 4000, `union rendered a stroke (${r.inkU}px)`);
ok(
  Math.abs(r.inkP - r.inkU) / Math.max(r.inkU, 1) < 0.02,
  `partition ink within 2% of union (${r.inkP} vs ${r.inkU})`,
);
ok(r.seams === 0, `no seam pixels at the joints (${r.seams} solid-in-union pixels went empty)`);
ok(r.meanDiff < 2, `mean channel difference is AA-scale (${r.meanDiff})`);

console.log(
  `\nstrokePartitionSmoke: ${fail ? 'FAIL' : 'PASS'} — ownership reproduces the union, so OVER can replace MAX`,
);
process.exit(fail ? 1 : 0);
