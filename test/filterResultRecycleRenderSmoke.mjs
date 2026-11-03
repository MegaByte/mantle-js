// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterResultRecycleRenderSmoke -- the free list of cached filter results holds only live textures, on real GL.
//
// A cached result whose rect outgrows its texture replaces its entry. The next new entry of the first size takes a texture from the free list,
// binds its framebuffer and copies the result in; a later hit composites that texture. A deleted pair on the list makes the bind fail
// (INVALID_OPERATION: attempt to use a deleted object), so the copy lands in whatever is still bound, which is often the target it samples
// (a feedback loop, and nothing drawn), and every later hit draws nothing. The checks: no GL error in any frame, and a new entry of the first
// size draws the same pixels on its miss and on its hit as the first bundle did at that size. Both routes that store this way run: a filter
// on a shape and a filter on a group. And the list still works: a disposed bundle's live texture serves the next entry of its size, with no allocation.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// noise + displacement + blur + composite: a chain the single-kind fast paths cannot express, so it takes the filter graph route. The backing rect fixes the content bbox at the canvas.
const DEFS =
  '<defs><filter id="f" x="-60%" y="-60%" width="220%" height="220%"><feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="2" seed="4" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="8" result="d"/><feGaussianBlur in="d" stdDeviation="2" result="b"/><feComposite in="b" in2="d" operator="over"/></filter></defs>';
const BACK = '<rect x="0" y="0" width="256" height="256" fill="#fff"/>';
const SHAPE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">${DEFS}${BACK}<circle cx="64" cy="64" r="20" fill="#c33" filter="url(#f)"/></svg>`;
const GROUP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">${DEFS}${BACK}<g filter="url(#f)"><circle cx="58" cy="64" r="14" fill="#36c"/><rect x="60" y="52" width="24" height="24" fill="#3a3" opacity="0.7"/></g></svg>`;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas><script type="module">
let texAllocs = 0; { const o = WebGL2RenderingContext.prototype.texImage2D; WebGL2RenderingContext.prototype.texImage2D = function (...x) { texAllocs++; return o.apply(this, x); }; }
const { importSvg, createBundle, createRenderer, loadShaders } = await import('/src/index.js');
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const r = createRenderer(gl, await loadShaders(new URL('/src/shaders/', location.href).href), {});
r.setViewport(256, 256);
const mk = async (s) => createBundle(gl, await importSvg(s));
const px = new Uint8Array(256 * 256 * 4);
const hash = () => { gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, px); let h = 0x811c9dc5 >>> 0; for (let i = 0; i < px.length; i++) { h ^= px[i]; h = Math.imul(h, 16777619) >>> 0; } return h; };
const errors = []; let at = '';
const noteErrors = () => { for (let e = gl.getError(), n = 0; e !== gl.NO_ERROR && n < 8; e = gl.getError(), n++) errors.push(at + ': 0x' + e.toString(16)); };
const frame = (bundle, s, name) => { at = name; r.beginFrame([1, 1, 1, 1]); r.drawBundle(bundle, s === 1 ? {} : { worldMatrix: [s, 0, 0, 0, s, 0, 0, 0, 1] }); r.endFrame(); noteErrors(); return hash(); };
const out = {};
for (const [name, svg] of [['shape', ${JSON.stringify(SHAPE)}], ['group', ${JSON.stringify(GROUP)}]]) {
  const a = await mk(svg);
  const evals0 = r.debugStats.filterEvalCount | 0;
  const first = frame(a, 1, name + ' first');      // the entry, at the small size
  const firstHit = frame(a, 1, name + ' first hit');
  const small = r.debugStats.filterEvalCount - evals0;
  let big = 0;
  for (const s of [1.5, 2, 2.5, 3]) big = frame(a, s, name + ' grow x' + s);   // the rect outgrows the texture: the entry is replaced
  const evalsGrown = r.debugStats.filterEvalCount - evals0;
  // a new bundle's entry of the first size: its texture comes from the free list
  const b = await mk(svg);
  const miss = frame(b, 1, name + ' new entry');
  const evalsNew = r.debugStats.filterEvalCount - evals0;
  const hit = frame(b, 1, name + ' new entry hit');
  const evalsHit = r.debugStats.filterEvalCount - evals0;
  const hit2 = frame(b, 1, name + ' new entry hit 2');
  // the disposed bundle's texture is live, and on the list: the next entry of its size takes it
  a.dispose();
  frame(b, 1, name + ' after dispose');
  const c = await mk(svg);
  const allocs0 = texAllocs, evals1 = r.debugStats.filterEvalCount;
  const recycled = frame(c, 3, name + ' recycled');
  const recycledAllocs = texAllocs - allocs0, recycledEvals = r.debugStats.filterEvalCount - evals1;
  const recycledHit = frame(c, 3, name + ' recycled hit');
  out[name] = { first, firstHit, small, evalsGrown, miss, evalsNew, hit, evalsHit, hit2, big, recycled, recycledHit, recycledAllocs, recycledEvals };
  b.dispose(); c.dispose();
}
noteErrors();
out.errors = errors; window.__out = out; window.__ready = true;
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
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page-err]', e.message));
const consoleLines = [];
page.on('console', (m) => {
  if (/INVALID_OPERATION|Feedback loop|deleted object/.test(m.text()))
    consoleLines.push(m.text().slice(0, 160));
});
await openReady(page, `http://127.0.0.1:${server.address().port}/`);
const o = await page.evaluate(() => window.__out);
await browser.close();
server.close();
console.log(JSON.stringify(o));
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
for (const name of ['shape', 'group']) {
  const c = o[name];
  ok(
    c.small >= 1 && c.first === c.firstHit,
    `${name}: the premise: the first entry evaluated and its hit draws the same pixels (${c.small} evals)`,
  );
  ok(
    c.evalsGrown > c.small,
    `${name}: the premise: growing re-evaluated, so the entry was stored again at the larger size (${c.evalsGrown} evals)`,
  );
  ok(
    c.evalsNew > c.evalsGrown && c.evalsHit === c.evalsNew,
    `${name}: the premise: the new bundle's entry missed once, then hit (${c.evalsGrown} -> ${c.evalsNew} -> ${c.evalsHit} evals)`,
  );
  ok(
    c.miss === c.first,
    `${name}: a new entry of the first size draws the same pixels on its miss`,
  );
  ok(c.hit === c.first && c.hit2 === c.first, `${name}: and on its hits`);
  ok(
    c.recycledEvals === 1,
    `${name}: the premise: the third bundle's entry evaluated (${c.recycledEvals} evals)`,
  );
  // (a filter on a group also sizes its accumulator to the new rect, a target of its own: the count is the shape's)
  if (name === 'shape')
    ok(
      c.recycledAllocs === 0,
      `${name}: a disposed bundle's texture serves the next entry of its size, with no allocation (${c.recycledAllocs} texImage2D)`,
    );
  ok(
    c.recycled === c.big && c.recycledHit === c.big,
    `${name}: and draws the same pixels on its miss and its hit`,
  );
}
ok(
  o.errors.length === 0,
  `no GL error in any frame (${o.errors.length}${o.errors.length ? ': ' + o.errors.slice(0, 6).join(', ') : ''})`,
);
ok(
  consoleLines.length === 0,
  `no GL complaint on the console (${consoleLines.length}${consoleLines.length ? ': ' + consoleLines[0] : ''})`,
);
process.exit(fail ? 1 : 0);
