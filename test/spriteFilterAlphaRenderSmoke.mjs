// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// spriteFilterAlphaRenderSmoke -- a faded draw of a sprite that paints through a filtered group is not cut at the sprite's leaves.
//
// A draw at alpha < 1 is a group: its accumulator and composite are bounded by what the draw paints. A sprite's list of what it paints held only its leaves, and instance batches their boxes,
// so a blur or a shadow past them ended at a hard edge. On a real GPU, over white, a draw at 0.5 must be (opaque + white) / 2 at every pixel: each draw entry that takes this path, a sprite
// that is the filtered group or holds one, a row range inside one, and a sprite with no filter on the same sheet.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFS =
  '<defs><filter id="b" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="20"/><feOffset dx="-30" dy="-30"/></filter></defs><rect width="400" height="400" fill="none"/>';
const KIDS =
  '<rect x="150" y="150" width="60" height="60" fill="#c33"/><rect x="190" y="190" width="60" height="60" fill="#3c3"/>';
const PLAIN =
  '<g id="plain"><rect x="330" y="330" width="20" height="20" fill="#36c"/><rect x="340" y="340" width="20" height="20" fill="#c33"/></g>';
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">${DEFS}${body}</svg>`;
const SHEET = doc(`<g id="s"><g filter="url(#b)">${KIDS}</g></g>${PLAIN}`);
const OWN = doc(`<g id="s" filter="url(#b)">${KIDS}</g>${PLAIN}`);
const INSIDE = doc(`<g filter="url(#b)">${KIDS}</g>${PLAIN}`);
const WHOLE = doc(`<g filter="url(#b)">${KIDS}</g>`);
const CASES = [
  { name: 'drawSprite, a filtered group in the sprite', svg: SHEET, draw: 'sprite', sprite: 's' },
  { name: 'drawSprite, the sprite is the filtered group', svg: OWN, draw: 'sprite', sprite: 's' },
  {
    name: 'drawSprite, a row range inside a filtered group',
    svg: INSIDE,
    draw: 'sprite',
    sprite: [1, 2],
  },
  { name: "a sprite timeline's held frame", svg: SHEET, draw: 'timeline', sprite: 's' },
  { name: 'drawSpriteInstanced', svg: SHEET, draw: 'spriteInstanced', sprite: 's' },
  { name: 'drawBundleInstanced, a bundle holding a filtered group', svg: WHOLE, draw: 'instanced' },
  {
    name: 'drawSprite, no filter in the sprite, one on the sheet',
    svg: SHEET,
    draw: 'sprite',
    sprite: 'plain',
  },
];
const TOL = 2; // the composite's rounding, twice

const HTML = `<!DOCTYPE html><html><body><script type="module">
const api = await import('/src/index.js');
const shaders = await api.loadShaders(new URL('/src/shaders/', location.href).href);
window.__run = async (c) => {
  const W = 512, H = 512, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const gl = cv.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, depth: true, stencil: true });
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const device = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const r = api.createRenderer(gl, shaders, {}); if (r.ready) await r.ready; r.setViewport(W, H);
  const b = api.createBundle(gl, await api.importSvg(c.svg, { preserveViewport: true }));
  if (r.prepareBundle) r.prepareBundle(b);
  r.prewarmBundle(b); r.precompileFills();
  const read = () => { const p = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, p); return p; };
  const shot = async (fn) => {
    const d = () => { r.beginFrame([1, 1, 1, 1]); fn(); r.endFrame(); };
    await r.warmScene([{ name: 'case', draw: d }], { maxPasses: 8, fenceTimeoutMs: 20000 });
    for (let i = 0; i < 6; i++) { d(); await new Promise((q) => setTimeout(q, 3)); }
    return read();
  };
  const wm = (s, tx, ty) => new Float32Array([s, 0, 0, 0, s, 0, tx, ty, 1]);
  const insts = (a) => [{ worldMatrix: wm(0.3, -0.5, -0.5), alpha: a }, { worldMatrix: wm(0.3, 0.5, 0.5), alpha: a }];
  let tl = null;
  if (c.draw === 'timeline') { tl = api.createSpriteTimeline(gl, [{ bundle: b, sprite: c.sprite }], [{ time: 0, refIndex: 0 }]); tl.setTime(0); }
  const draw = {
    sprite: (a) => r.drawSprite(b, c.sprite, { alpha: a }),
    timeline: (a) => r.drawBundle(tl.bundle, { alpha: a }),
    spriteInstanced: (a) => r.drawSpriteInstanced(b, c.sprite, insts(a), {}),
    instanced: (a) => r.drawBundleInstanced(b, insts(a), {}),
  }[c.draw];
  const opaque = await shot(() => draw(1));
  const faded = await shot(() => draw(0.5));
  let bad = 0, max = 0, painted = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4; let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs((opaque[i + k] + 255) / 2 - faded[i + k]));
    if (opaque[i] !== 255 || opaque[i + 1] !== 255 || opaque[i + 2] !== 255) painted++;
    if (d > max) max = d;
    if (d > ${TOL}) { bad++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  let fnv = 0x811c9dc5 >>> 0; for (let i = 0; i < faded.length; i++) { fnv ^= faded[i]; fnv = Math.imul(fnv, 16777619) >>> 0; }
  const out = { device, bad, max, painted, box: bad ? [x0, y0, x1, y1] : null, hash: fnv.toString(16), glError: gl.getError() };
  if (tl) tl.dispose();
  b.dispose(); r.dispose();
  gl.getExtension('WEBGL_lose_context')?.loseContext();
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
  name: 'spriteFilterAlphaRenderSmoke',
});
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const rows = [];
for (const c of CASES) {
  const o = await page.evaluate((cc) => window.__run(cc), c);
  rows.push({ name: c.name, ...o });
  if (rows.length === 1 && process.env.MANTLE_TEST_GL !== 'swiftshader')
    ok(
      /Apple|Metal/.test(o.device) && !/SwiftShader|software/i.test(o.device),
      `physical Metal device: ${o.device}`,
    );
  ok(o.glError === 0 && o.painted > 0, `${c.name}: drew ${o.painted} px, no GL error`);
  ok(
    o.bad === 0,
    `${c.name}: faded == (opaque + white) / 2 within ${TOL}/255 (${o.bad} px over, max ${o.max}${o.box ? `, box ${o.box}` : ''})`,
  );
}
console.log('ROWS ' + JSON.stringify(rows));
await browser.close();
server.close();
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
