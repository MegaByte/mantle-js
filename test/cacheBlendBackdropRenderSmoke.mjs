// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cacheBlendBackdropRenderSmoke -- a bundle with a row that blends with what lies under it draws live under every cache strategy, so its picture is right over any backdrop. The bake has nothing to blend
// with: a whole-asset cache of a root multiply would draw up to 29,840 px wrong here, max 163/255, over a colored canvas and a drawn rect (and an Auto cache of the filtered group likewise). Over white
// it hides, since multiply over white is a plain draw. A blend inside an isolating group reads only that group, so it still caches, and art with no blend still caches. On a real GPU, every pixel against the same art drawn live.
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 256,
  TOL = 3;
const KIDS = '<rect x="150" y="150" width="100" height="100" fill="#c33"/>';
const LEAF = (extra = '') => `<rect x="60" y="60" width="90" height="90" fill="#fa0"${extra}/>`;
const MULT = ' style="mix-blend-mode:multiply"';
const doc = (b) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs><filter id="bl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8"/></filter></defs><rect width="400" height="400" fill="none"/>${b}</svg>`;
const UNDER = doc('<rect x="20" y="20" width="300" height="200" fill="#c6c"/>');
const CASES = [
  // [name, art, whether it reads the backdrop]
  ['no blend', doc(`<g opacity="0.8">${KIDS}</g>${LEAF()}`), false],
  ['a multiply inside an opacity group', doc(`<g opacity="0.9">${LEAF(MULT)}${KIDS}</g>`), false],
  [
    'a multiply inside an isolated group',
    doc(`<g style="isolation:isolate">${LEAF(MULT)}${KIDS}</g>`),
    false,
  ],
  [
    'a multiply inside a filtered group',
    doc(`<g filter="url(#bl)">${LEAF(MULT)}${KIDS}</g>`),
    false,
  ],
  ['a multiply leaf', doc(LEAF(MULT)), true],
  ['two leaves, one multiply', doc(`${LEAF(MULT)}${KIDS}`), true],
  ['a multiply group', doc(`<g${MULT}>${KIDS}${LEAF()}</g>`), true],
  ['a filtered multiply group', doc(`<g filter="url(#bl)"${MULT}>${KIDS}</g>`), true],
  ['a multiply inside a plain group', doc(`<g>${LEAF(MULT)}${KIDS}</g>`), true],
];
const HTML = `<!DOCTYPE html><html><body><script type="module">
const api = await import('/src/index.js');
const shaders = await api.loadShaders(new URL('/src/shaders/', location.href).href);
window.__run = async (svg, under, strategy) => {
  const cv = document.createElement('canvas'); cv.width = cv.height = ${N};
  const gl = cv.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, depth: true, stencil: true });
  const r = api.createRenderer(gl, shaders, {}); if (r.ready) await r.ready; r.setViewport(${N}, ${N});
  const b = api.createBundle(gl, await api.importSvg(svg, { preserveViewport: true })), u = api.createBundle(gl, await api.importSvg(under, { preserveViewport: true }));
  r.prewarmBundle(b); r.prewarmBundle(u); r.precompileFills();
  const h = r.createBundleHandle(b, { staticCache: { strategy: api.CacheStrategy[strategy] } });
  const read = () => { const p = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, p); return p; };
  const shot = async (fn, frames) => {
    const d = () => { r.beginFrame([0.2, 0.6, 0.9, 1]); r.drawBundle(u, {}); fn(); r.endFrame(); };
    await r.warmScene([{ name: 'c', draw: d }], { maxPasses: 8, fenceTimeoutMs: 20000 });
    for (let i = 0; i < frames; i++) { d(); await new Promise((q) => setTimeout(q, 3)); }
    return read();
  };
  const live = await shot(() => r.drawBundle(b, {}), 6);
  await shot(() => h.draw({}), 30);
  const cached = await shot(() => h.draw({}), 30);
  let over = 0, max = 0; for (let i = 0; i < live.length; i++) { const d = Math.abs(live[i] - cached[i]); if (d > max) max = d; if (d > ${TOL}) over++; }
  const out = { over, max, valid: !!h.staticCache?.isCacheValid, err: gl.getError() };
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
for (const [name, svg, reads] of CASES)
  for (const strategy of ['ForceWholeAsset', 'Auto']) {
    const o = await page.evaluate((s, u, st) => window.__run(s, u, st), svg, UNDER, strategy);
    ok(
      o.over === 0 && o.err === 0,
      `${name}, ${strategy}: cached == live within ${TOL}/255 (${o.over} channels over, max ${o.max})`,
    );
    if (reads)
      ok(
        !o.valid,
        `${name}, ${strategy}: it reads the backdrop, so it draws live (valid ${o.valid})`,
      );
    else if (strategy === 'ForceWholeAsset')
      ok(o.valid, `${name}, ${strategy}: it does not, so it still caches (valid ${o.valid})`);
  }
await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall ok');
process.exit(fail ? 1 : 0);
