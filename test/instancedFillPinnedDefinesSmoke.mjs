// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Caller fillDefines must reach both stages of the instanced program.
// Use an explicit cover route so asynchronous LB preparation cannot change
// the engine between the otherwise identical image comparisons.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M50 10 C80 10 90 40 90 55 C90 80 65 92 50 92 C35 92 10 80 10 55 C10 40 20 10 50 10Z" fill="#3060c0"/>' +
  '<circle cx="34" cy="46" r="9" fill="#e0e0f0"/></svg>';
const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="240" height="240"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sec = await importSvg(${JSON.stringify(SVG)});
let warns = 0, instDraws = 0;
const ow = console.warn.bind(console);
console.warn = (...a) => { if (String(a[0]).includes('instanced fill program failed')) warns++; ow(...a); };
const od = gl.drawArraysInstanced.bind(gl); gl.drawArraysInstanced = (...a) => { instDraws++; return od(...a); };
const ST = (s, tx, ty) => new Float32Array([s, 0, 0, 0, s, 0, tx, ty, 1]);
const one = async (opts) => {
  const r = createRenderer(gl, shaders, opts); await r.ready;
  r.setFillEngine({ route: 'none', kernel: opts.aacFill ? 'aac' : 'slug', primitives: 'off' });
  const b = createBundle(gl, sec);
  warns = 0; instDraws = 0;
  const px = new Uint8Array(240 * 240 * 4); let n = -1;
  // The instanced program links in the background where the driver compiles in parallel; the per-instance loop draws until it is done.
  for (let f = 0; f < 1200 && (f < 4 || instDraws === 0); f++) {
    r.setViewport(240, 240); r.beginFrame([0, 0, 0, 1]);
    // worldMatrix is CLIP space
    n = r.drawBundleInstanced(b, [{ worldMatrix: ST(0.45, -0.5, 0.5) }, { worldMatrix: ST(0.45, 0.5, 0.5) }, { worldMatrix: ST(0.45, -0.5, -0.5) }, { worldMatrix: ST(0.45, 0.5, -0.5) }], {});
    r.endFrame();
    gl.readPixels(0, 0, 240, 240, gl.RGBA, gl.UNSIGNED_BYTE, px);   // right after the frame, as the other smokes do
    await new Promise((q) => setTimeout(q, 25));
  }
  const result = { px, warns, instDraws, n };
  b.dispose(); r.dispose();
  return result;
};
const d = await one({ aacFill: false });
const p = await one({ aacFill: false, fillDefines: ['MANTLE_LB_FILL'] });
let diff = 0, ink = 0, inkP = 0; for (let i = 0; i < d.px.length; i += 4) { if (d.px[i] + d.px[i + 1] + d.px[i + 2] > 24) ink++; if (p.px[i] + p.px[i + 1] + p.px[i + 2] > 24) inkP++; for (let k = 0; k < 3; k++) diff += Math.abs(d.px[i + k] - p.px[i + k]); }
// Verify caller defines with the AAC cover kernel too.
const dA = await one({ aacFill: true });
const pA = await one({ aacFill: true, fillDefines: ['MANTLE_LB_FILL'] });
let diffA = 0, maxA = 0, inkA = 0; for (let i = 0; i < dA.px.length; i += 4) { if (dA.px[i] + dA.px[i + 1] + dA.px[i + 2] > 24) inkA++; for (let k = 0; k < 3; k++) { const delta = Math.abs(dA.px[i + k] - pA.px[i + k]); diffA += delta; maxA = Math.max(maxA, delta); } }
window.out = { device: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL), aac: { defWarns: dA.warns, pinWarns: pA.warns, defInst: dA.instDraws, pinInst: pA.instDraws, ink: inkA, diff: diffA, max: maxA }, defN: d.n, pinN: p.n, defWarns: d.warns, pinWarns: p.warns, defInst: d.instDraws, pinInst: p.instDraws, ink, inkP, diff };
</script></body></html>`;
const mime = (q) =>
  /\.(js|mjs)$/.test(q) ? 'text/javascript' : q.endsWith('.glsl') ? 'text/plain' : 'text/html';
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
if (process.env.MANTLE_TEST_GL === 'metal')
  ok(/Metal/.test(r.device) && !/SwiftShader/i.test(r.device), 'physical device: ' + r.device);
ok(r.defWarns === 0, `default renderer: 0 instanced-link warnings (${r.defWarns})`);
ok(r.pinWarns === 0, `pinned MANTLE_LB_FILL renderer: 0 instanced-link warnings (${r.pinWarns})`);
ok(
  r.defInst >= 1 && r.pinInst >= 1,
  `the instanced draw is really used (default ${r.defInst}, pinned ${r.pinInst} drawArraysInstanced)`,
);
ok(
  r.ink > 3000 && r.inkP > 3000,
  `ink drawn on BOTH before comparing (default ${r.ink}px, pinned ${r.inkP}px)`,
);
ok(r.diff === 0, `the pinned picture equals the default picture (sum abs diff ${r.diff})`);
ok(
  r.aac.defWarns === 0 && r.aac.pinWarns === 0,
  `aacFill:true, default and pinned: 0 instanced-link warnings (${r.aac.defWarns}, ${r.aac.pinWarns})`,
);
ok(
  r.aac.ink > 3000 && r.aac.defInst > 0,
  `aacFill:true draws ink (${r.aac.ink}px) through the instanced program (${r.aac.defInst} draws)`,
);
ok(
  r.aac.max <= 1,
  `AAC pinned and default images agree within one byte (max ${r.aac.max}, sum ${r.aac.diff})`,
);
console.log(`\ninstancedFillPinnedDefinesSmoke: ${fail ? 'FAIL' : 'PASS'}`);
process.exit(fail ? 1 : 0);
