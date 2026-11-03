// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// pinnedEngineDeclineRenderSmoke -- a pinned engine draws, or the engine ledger says why it did not.
//
// On a real GPU, with the engine ledger of the last frame as the proof:
//   - `route: 'cpatch'` draws CPatch at any size: a few-curve shape far past the canvas, and a many-curve area cell the cost gate would price out, with no decline;
//   - a row with no CPatch geometry (a transform override puts it on its cover quad) records `declines.cpatch.unsupported`;
//   - `kernel: 'hard-tree'` draws the tree where the bundle has one, and where it has none it draws hard-band and `declines['hard-tree']['no-gwn-tree']` says so.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEW =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#d33" d="M0 0 L100 0 C100 40 80 60 100 100 L0 90 C20 60 10 30 0 0 Z"/></svg>';
const scallop = (n) => {
  let d = 'M50 5 ';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI - Math.PI / 2,
      b = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2,
      m = (a + b) / 2,
      P = (t, r) => `${(50 + r * Math.cos(t)).toFixed(3)} ${(50 + r * Math.sin(t)).toFixed(3)}`;
    d += `C${P(a + (m - a) * 0.3, 49)} ${P(b - (b - m) * 0.3, 49)} ${P(b, 45)} `;
  }
  return d + 'Z';
};
const MANY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#d33" d="${scallop(64)}"/></svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="512" height="512"></canvas><script type="module">
const api = await import('/src/index.js');
const shaders = await api.loadShaders(new URL('/src/shaders/', location.href).href);
const gl = document.getElementById('c').getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, depth: true, stencil: true });
window.__device = () => { const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); };
window.__run = async (svg, c) => {
  const warned = []; const ow = console.warn; console.warn = (...a) => { warned.push(a.join(' ')); ow(...a); };
  const r = api.createRenderer(gl, shaders, { nonBlocking: false, asyncShaderCompile: false }); if (r.ready) await r.ready;
  r.setFillEngine(c.engine); r.setViewport(512, 512);
  const b = api.createBundle(gl, await api.importSvg(svg, { preserveViewport: true, ...(c.iopts || {}) }));
  const wm = new Float32Array(c.m);
  let overrides; if (c.moved) { overrides = api.createOverrideTable(gl, b); overrides.set(0, { localPosition: [1, 0] }); }
  const draw = () => { r.beginFrame([0, 0, 0, 0]); r.drawBundle(b, overrides ? { worldMatrix: wm, overrides } : { worldMatrix: wm }); r.endFrame(); };
  if (r.prepareBundle) r.prepareBundle(b);
  draw(); if (c.wait) await r.awaitEngine(b, c.wait); if (r.ready) await r.ready;
  r.prewarmBundle(b); r.precompileFills();
  await r.warmScene([{ name: 'case', draw }], { maxPasses: 8, fenceTimeoutMs: 20000 });
  for (let i = 0; i < 3; i++) draw();
  const e0 = JSON.parse(JSON.stringify(r.debugStats.engines));
  draw();
  const e1 = r.debugStats.engines, via = {};
  for (const k of Object.keys(e1.viaRoute || {})) { const d = (e1.viaRoute[k] | 0) - ((e0.viaRoute || {})[k] | 0); if (d) via[k] = d; }
  const p = new Uint8Array(512 * 512 * 4); gl.readPixels(0, 0, 512, 512, gl.RGBA, gl.UNSIGNED_BYTE, p);
  let s = ''; for (let k = 3, q = ''; k < p.length; k += 4) { q += String.fromCharCode(p[k]); if (q.length >= 8192 || k + 4 >= p.length) { s += q; q = ''; } }
  const out = { via, declines: JSON.parse(JSON.stringify(e1.declines || {})), a: btoa(s), warned: warned.filter((t) => /hard-tree/.test(t)).length, glError: gl.getError() };
  console.warn = ow; b.dispose(); r.dispose();
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
await openReady(page, `http://127.0.0.1:${server.address().port}/`, {
  name: 'pinnedEngineDeclineRenderSmoke',
});
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const device = await page.evaluate(() => window.__device());
if (process.env.MANTLE_TEST_GL !== 'swiftshader')
  ok(
    /Apple|Metal/.test(device) && !/SwiftShader|software/i.test(device),
    `physical Metal device: ${device}`,
  );
const run = (svg, c) => page.evaluate((s, cc) => window.__run(s, cc), svg, c);
const zoomAt = (z, x, y) => {
  const px = x / 50 - 1,
    py = 1 - y / 50;
  return [z, 0, 0, 0, z, 0, -z * px, -z * py, 1];
};
const onlyVia = (o, name) =>
  Object.keys(o.via).length > 0 && Object.keys(o.via).every((k) => k.startsWith(name + '@'));
const J = (x) => JSON.stringify(x);
const CPATCH = { route: 'cpatch', kernel: 'slug' };

// A few curves: pays at any zoom, so the pin draws what it asked for. The middle of a filled art is solid, its far corner empty: the same picture the cover pass gives.
for (const zl of [0, 4, 8, 12]) {
  const z = 2 ** zl,
    m = zoomAt(z, 50, 50);
  const o = await run(FEW, { engine: CPATCH, wait: 'cpatch', m }),
    s = await run(FEW, { engine: { route: 'none', kernel: 'slug' }, m });
  ok(
    onlyVia(o, 'cpatch') && !o.declines.cpatch,
    `route cpatch, few curves, zoom 2^${zl}: drew ${J(o.via)}, declines ${J(o.declines)}`,
  );
  const a = Buffer.from(o.a, 'base64'),
    b = Buffer.from(s.a, 'base64');
  let far = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 128) far++;
  ok(
    far === 0,
    `route cpatch, few curves, zoom 2^${zl}: the cover pass's picture (${far} px off by more than half; the diagonal of an area cell's two triangles runs through this view)`,
  );
}
// Many curves, at any size: the request wins over the cost gate 'cpatch-auto' keeps.
for (const [name, m] of [
  ['at an eighth of the canvas', [0.125, 0, 0, 0, 0.125, 0, 0, 0, 1]],
  ['filling the canvas', zoomAt(1, 50, 50)],
  ['past the canvas', zoomAt(64, 50, 5)],
]) {
  const o = await run(MANY, { engine: CPATCH, wait: 'cpatch', m });
  ok(
    onlyVia(o, 'cpatch') && !o.declines.cpatch,
    `route cpatch, 64 curves ${name}: drew ${J(o.via)}, declines ${J(o.declines)}`,
  );
}
{
  const auto = await run(MANY, {
    engine: { route: 'cpatch-auto', kernel: 'slug' },
    wait: 'cpatch',
    m: zoomAt(64, 50, 5),
  });
  ok(
    !auto.via['cpatch@unified'] && !auto.declines.cpatch,
    `route cpatch-auto, 64 curves past the canvas: the gate chooses, drew ${J(auto.via)}, declines ${J(auto.declines)}`,
  );
  const moved = await run(FEW, {
    engine: CPATCH,
    wait: 'cpatch',
    m: zoomAt(1, 50, 50),
    moved: true,
  });
  ok(
    !moved.via['cpatch@unified'] && moved.declines.cpatch && moved.declines.cpatch.unsupported > 0,
    `route cpatch, a row with no CPatch geometry: drew ${J(moved.via)}, and the engine ledger says so: ${J(moved.declines)}`,
  );
}
// hard-tree
{
  const pin = { route: 'none', kernel: 'hard-tree' },
    m = zoomAt(1, 50, 50);
  const tree = await run(FEW, { engine: pin, iopts: { gwnTree: true }, m });
  ok(
    onlyVia(tree, 'hard-tree') && !tree.declines['hard-tree'] && tree.warned === 0,
    `hard-tree with the tree: drew ${J(tree.via)}, declines ${J(tree.declines)}`,
  );
  const none = await run(FEW, { engine: pin, m });
  ok(onlyVia(none, 'hard-band'), `hard-tree without the tree draws ${J(none.via)}`);
  ok(
    none.declines['hard-tree'] && none.declines['hard-tree']['no-gwn-tree'] > 0,
    `...and the engine ledger says why: ${J(none.declines)}`,
  );
  ok(none.warned === 1, `...and warns once (${none.warned})`);
}
await browser.close();
server.close();
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
