// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// spriteOtherGroupRenderSmoke -- a sprite draw paints that sprite, and no filtered group of another one.
//
// A subset draw keeps group rows so a sprite that holds a group composites it, and it kept them all: every filtered group on the sheet ran. A blur of
// nothing paints nothing, but a generator paints its region whatever its source is, so drawing one sprite painted another's flood. On a real GPU, over
// white, against the same sprite's pixels on a sheet that has no such group: each draw entry, opaque and faded, on the cover route and the unified one.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLOOD =
  '<filter id="fl" filterUnits="userSpaceOnUse" x="40" y="40" width="160" height="160"><feFlood flood-color="#06c"/></filter>';
const BG = '<rect width="400" height="400" fill="none"/>';
const OTHER = '<g id="other"><rect x="300" y="300" width="20" height="20" fill="#c33"/></g>';
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs>${FLOOD}</defs>${BG}${body}</svg>`;
const SHEET = doc(
  `<g id="fl"><g filter="url(#fl)"><rect x="60" y="60" width="20" height="20" fill="#3c3"/></g></g>${OTHER}`,
);
const AFTER = doc(
  `${OTHER}<g id="fl"><g filter="url(#fl)"><rect x="60" y="60" width="20" height="20" fill="#3c3"/></g></g>`,
);
const NESTED = doc(
  `<g id="fl" opacity="0.5"><g filter="url(#fl)"><g filter="url(#fl)"><rect x="60" y="60" width="20" height="20" fill="#3c3"/></g></g></g>${OTHER}`,
);
const ALONE = doc(
  `<g id="fl"><rect x="60" y="60" width="20" height="20" fill="#3c3"/></g>${OTHER}`,
);
const FLOOD_PX = [52, 52, 255, 255]; // the region (40 .. 200 of 400) on the 512 px canvas, inset by a pixel

const HTML = `<!DOCTYPE html><html><body><script type="module">
const api = await import('/src/index.js');
const shaders = await api.loadShaders(new URL('/src/shaders/', location.href).href);
window.__run = async (svg, c) => {
  const W = 512, H = 512, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const gl = cv.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, depth: true, stencil: true });
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const device = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const r = api.createRenderer(gl, shaders, {}); if (r.ready) await r.ready; r.setViewport(W, H);
  if (c.route) r.setFillEngine({ route: c.route });
  const b = api.createBundle(gl, await api.importSvg(svg, { preserveViewport: true }));
  if (r.prepareBundle) r.prepareBundle(b);
  if (c.route) await r.awaitEngine(b, c.route);
  r.prewarmBundle(b); r.precompileFills();
  const wm = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const draw = {
    sprite: (a) => r.drawSprite(b, c.sprite, { alpha: a }),
    instanced: (a) => r.drawSpriteInstanced(b, c.sprite, [{ worldMatrix: wm, alpha: a }], {}),
    whole: (a) => r.drawBundle(b, { alpha: a }),
  }[c.draw];
  const d = () => { r.beginFrame([1, 1, 1, 1]); draw(c.alpha); r.endFrame(); };
  await r.warmScene([{ name: 'case', draw: d }], { maxPasses: 8, fenceTimeoutMs: 20000 });
  for (let i = 0; i < 6; i++) { d(); await new Promise((q) => setTimeout(q, 3)); }
  const p = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, p);
  const route = r.debugStats.engines ? JSON.stringify(r.debugStats.engines.viaRoute || {}) : '';
  let s = ''; for (let k = 0; k < p.length; k += 8192) s += String.fromCharCode.apply(null, p.subarray(k, k + 8192));
  const out = { device, a: btoa(s), route, glError: gl.getError() };
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
  name: 'spriteOtherGroupRenderSmoke',
});
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const run = async (svg, c) => {
  const o = await page.evaluate((s, cc) => window.__run(s, cc), svg, c);
  o.px = Buffer.from(o.a, 'base64');
  delete o.a;
  return o;
};
const W = 512;
// painted = not white, in GL rows; the flood's region is symmetric enough to test by its own box, flipped
const inFlood = (x, y) =>
  x >= FLOOD_PX[0] && x < FLOOD_PX[2] && W - 1 - y >= FLOOD_PX[1] && W - 1 - y < FLOOD_PX[3];
const count = (px, pred) => {
  let n = 0;
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if ((px[i] !== 255 || px[i + 1] !== 255 || px[i + 2] !== 255) && pred(x, y)) n++;
    }
  return n;
};
const maxDiff = (a, b) => {
  let m = 0,
    n = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
    if (d) n++;
  }
  return [m, n];
};

let first = true;
for (const [routeName, route] of [
  ['cover route', null],
  ['Loop-Blinn route', 'lb'],
]) {
  const label = (s) => `${routeName}: ${s}`;
  const ref = await run(ALONE, { draw: 'sprite', sprite: 'other', alpha: 1, route });
  if (first && process.env.MANTLE_TEST_GL !== 'swiftshader')
    ok(
      /Apple|Metal/.test(ref.device) && !/SwiftShader|software/i.test(ref.device),
      `physical Metal device: ${ref.device}`,
    );
  first = false;
  ok(
    ref.glError === 0 && count(ref.px, () => true) > 300,
    label(
      `the reference, the sprite on a sheet with no filtered group, painted ${count(ref.px, () => true)} px`,
    ),
  );
  const refFaded = await run(ALONE, { draw: 'sprite', sprite: 'other', alpha: 0.5, route });
  for (const [name, svg] of [
    ['the filtered group comes first', SHEET],
    ['the filtered group comes last', AFTER],
    ['nested filtered groups in a plain one', NESTED],
  ]) {
    for (const [dn, draw] of [
      ['drawSprite', 'sprite'],
      ['drawSpriteInstanced', 'instanced'],
    ]) {
      const o = await run(svg, { draw, sprite: 'other', alpha: 1, route });
      const [m, n] = maxDiff(o.px, ref.px);
      ok(
        o.glError === 0 && count(o.px, inFlood) === 0,
        label(
          `${name}, ${dn} of another sprite, opaque: ${count(o.px, inFlood)} px in the flood's region (route ${o.route})`,
        ),
      );
      ok(
        m <= 1,
        label(
          `${name}, ${dn} of another sprite, opaque: the sprite's own pixels (${n} differ, max ${m})`,
        ),
      );
    }
    const f = await run(svg, { draw: 'sprite', sprite: 'other', alpha: 0.5, route });
    const [m, n] = maxDiff(f.px, refFaded.px);
    ok(
      count(f.px, inFlood) === 0 && m <= 1,
      label(
        `${name}, drawSprite of another sprite, at alpha 0.5: ${count(f.px, inFlood)} px in the flood's region, against the reference ${n} differ, max ${m}`,
      ),
    );
  }
  // and the sprite that owns the group, and the whole sheet, still paint it
  const own = await run(SHEET, { draw: 'sprite', sprite: 'fl', alpha: 1, route });
  const nOwn = count(own.px, inFlood),
    span = (FLOOD_PX[2] - FLOOD_PX[0]) * (FLOOD_PX[3] - FLOOD_PX[1]);
  ok(
    nOwn === span,
    label(`drawSprite of the sprite that holds the group paints its flood (${nOwn} of ${span} px)`),
  );
  ok(
    count(own.px, (x, y) => x > 370 && W - 1 - y > 370) === 0,
    label('...and not the other sprite'),
  );
  const nest = await run(NESTED, { draw: 'sprite', sprite: 'fl', alpha: 1, route });
  ok(
    count(nest.px, inFlood) === span,
    label(
      `drawSprite of a sprite with nested filtered groups paints them (${count(nest.px, inFlood)} of ${span} px)`,
    ),
  );
  const whole = await run(SHEET, { draw: 'whole', alpha: 1, route });
  ok(
    count(whole.px, inFlood) === span,
    label(`a whole-sheet draw paints the flood (${count(whole.px, inFlood)} of ${span} px)`),
  );
  // a row range that names the group's own row asks for the group, leaf or no leaf; one past it does not
  const rows = await run(SHEET, { draw: 'sprite', sprite: [0, 2], alpha: 1, route });
  ok(
    count(rows.px, inFlood) === span,
    label(
      `a row range holding the group's rows paints it (${count(rows.px, inFlood)} of ${span} px)`,
    ),
  );
}
await browser.close();
server.close();
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
