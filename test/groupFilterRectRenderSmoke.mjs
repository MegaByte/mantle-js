// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupFilterRectRenderSmoke -- a static cache of a bundle holding a filtered group draws the picture the live draw does, on a real GPU.
//
// A filter on a <g> paints past its children: a blur or a shadow, a flood over the whole filter region, an image placed anywhere in it. The cache's blit is cut at the bundle's content
// rect, so a rect built from the children ended the filter at a hard edge. Every case here draws the same bundle live and from a warmed static cache, on one context, and compares every
// pixel, recording the viewport the blit drew through.
// A rect too small clips the cache, so the cases go where the region is hard: an offset and an image past it, a region narrower than the children, a turned region, a moved cache, a source
// past the canvas edge, an odd canvas, and the same art authored at 1e-3 and 1e3.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAE0lEQVR4nGP4v4DhPz7MMDIUAAB4EqeBX2COLwAAAABJRU5ErkJggg==';
// `k` scales the authored numbers; the canvas sees the same art.
const art = (filter, body, k = 1, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${400 * k} ${400 * k}"><defs>${filter}</defs><rect width="${400 * k}" height="${400 * k}" fill="none"/><g id="fg" filter="url(#f)" ${attrs}>${body}</g></svg>`;
const KIDS =
  '<rect x="150" y="150" width="60" height="60" fill="#c33"/><rect x="190" y="190" width="60" height="60" fill="#3c3"/>';
const WIDE = 'x="-100%" y="-100%" width="300%" height="300%"';
const blurOffset = `<filter id="f" ${WIDE}><feGaussianBlur stdDeviation="20"/><feOffset dx="-30" dy="-30"/></filter>`;
const scaled = (k) =>
  art(
    `<filter id="f" ${WIDE}><feGaussianBlur stdDeviation="${20 * k}"/><feOffset dx="${-30 * k}" dy="${-30 * k}"/></filter>`,
    `<rect x="${150 * k}" y="${150 * k}" width="${60 * k}" height="${60 * k}" fill="#c33"/><rect x="${190 * k}" y="${190 * k}" width="${60 * k}" height="${60 * k}" fill="#3c3"/>`,
    k,
  );
const wm = (s, deg = 0, tx = 0, ty = 0) => {
  const a = (deg * Math.PI) / 180,
    c = Math.cos(a) * s,
    n = Math.sin(a) * s;
  return [c, n, 0, -n, c, 0, tx, ty, 1];
};
// reach: a canvas pixel past the children's box that must be painted, for a case whose defect is a cut [x, y] (top-left).
const CASES = [
  { name: 'blur and offset past the children', svg: art(blurOffset, KIDS), reach: [150, 150] },
  {
    name: 'drop shadow, the default region',
    svg: art(
      '<filter id="f"><feDropShadow dx="6" dy="6" stdDeviation="3" flood-color="#012"/></filter>',
      KIDS,
    ),
  },
  {
    name: 'a single blur',
    svg: art(`<filter id="f" ${WIDE}><feGaussianBlur stdDeviation="16"/></filter>`, KIDS),
  },
  {
    name: 'a flood fills the whole region',
    svg: art(
      '<filter id="f" filterUnits="userSpaceOnUse" x="40" y="40" width="320" height="320"><feFlood flood-color="#36c" flood-opacity="0.5"/></filter>',
      KIDS,
    ),
    reach: [70, 70],
  },
  {
    name: 'an offset past the region',
    svg: art(
      '<filter id="f" x="-5%" y="-5%" width="110%" height="110%"><feOffset dx="150" dy="120"/></filter>',
      KIDS,
    ),
  },
  {
    name: 'an image past the region',
    svg: art(
      `<filter id="f" filterUnits="userSpaceOnUse" x="100" y="100" width="200" height="200"><feImage href="${PNG}" x="60" y="60" width="300" height="300" result="i"/><feMerge><feMergeNode in="i"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
      KIDS,
    ),
  },
  {
    name: 'a region narrower than the children',
    svg: art(
      '<filter id="f" filterUnits="userSpaceOnUse" x="170" y="170" width="40" height="40"><feGaussianBlur stdDeviation="4"/></filter>',
      KIDS,
    ),
  },
  {
    name: 'a turned group',
    svg: art(
      '<filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8"/><feOffset dx="-14" dy="-14"/></filter>',
      KIDS,
      1,
      'transform="rotate(30 200 200)"',
    ),
  },
  { name: 'drawn at a quarter', svg: art(blurOffset, KIDS), matrix: wm(0.25) },
  { name: 'drawn turned', svg: art(blurOffset, KIDS), matrix: wm(0.5, 30) },
  {
    name: 'a moved cache',
    svg: art(blurOffset, KIDS),
    matrix: wm(0.5),
    moveTo: wm(0.5, 0, 0.3, -0.2),
    tol: 3,
  },
  {
    name: 'a blur past the canvas edge',
    svg: art(
      `<filter id="f" ${WIDE}><feGaussianBlur stdDeviation="20"/></filter>`,
      '<rect x="10" y="150" width="60" height="60" fill="#c33"/>',
    ),
    frame: true,
  },
  { name: 'an odd canvas', svg: art(blurOffset, KIDS), w: 513, h: 511 },
  { name: 'authored at 1e-3', svg: scaled(1e-3) },
  { name: 'authored at 1e3', svg: scaled(1e3) },
  // A blend at the root reads what lies under the bundle, so the handle draws live (cacheBlendBackdropRenderSmoke). The pixels still match; there is no blit to measure.
  {
    name: 'a blend mode on the group',
    svg: art(blurOffset, KIDS, 1, 'style="mix-blend-mode:multiply"'),
    drawsLive: true,
  },
  {
    name: 'a mask on the group',
    svg: art(
      blurOffset +
        '<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="400" height="400"><rect x="60" y="60" width="200" height="280" fill="#fff"/></mask>',
      KIDS,
      1,
      'mask="url(#m)"',
    ),
  },
  {
    name: 'a clip on the group',
    svg: art(
      blurOffset + '<clipPath id="c"><rect x="60" y="60" width="200" height="280"/></clipPath>',
      KIDS,
      1,
      'clip-path="url(#c)"',
    ),
  },
  {
    name: 'two groups and a leaf, far apart',
    svg: art(
      '<filter id="f" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="4"/></filter>',
      '<rect x="20" y="20" width="40" height="40" fill="#c33"/>',
    ).replace(
      '</svg>',
      '<g filter="url(#f)"><rect x="340" y="20" width="40" height="40" fill="#3c3"/></g><rect x="20" y="340" width="40" height="40" fill="#36c"/></svg>',
    ),
  },
  {
    name: 'in an opacity group',
    svg: art(blurOffset, KIDS)
      .replace('<g id="fg"', '<g opacity="0.5"><g id="fg"')
      .replace('</g></svg>', '</g></g></svg>'),
    reach: [150, 150],
  },
  {
    name: 'a filtered group in a filtered group',
    svg: art(
      blurOffset + `<filter id="f2" ${WIDE}><feGaussianBlur stdDeviation="8"/></filter>`,
      `<g filter="url(#f2)">${KIDS}</g>`,
    ),
    reach: [150, 150],
  },
  { name: 'an override on the group', svg: art(blurOffset, KIDS), override: true },
];
// A cached picture composites once more than the live one: the same bytes, within a level. A moved cache lands on a rounded pixel, at the full canvas too.
const TOL = 1;

const HTML = `<!DOCTYPE html><html><body><script type="module">
const api = await import('/src/index.js');
const shaders = await api.loadShaders(new URL('/src/shaders/', location.href).href);
window.__run = async (c) => {
  const W = c.w || 512, H = c.h || 512;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const gl = cv.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, depth: true, stencil: true });
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const device = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  // Which draws reach the canvas through the blit program, and through what viewport.
  let lastVp = [0, 0, W, H], blit = null; const isBlit = new Map();
  const vp0 = gl.viewport.bind(gl), da0 = gl.drawArrays.bind(gl);
  gl.viewport = (x, y, w, h) => { lastVp = [x, y, w, h]; vp0(x, y, w, h); };
  gl.drawArrays = (...a) => {
    const p = gl.getParameter(gl.CURRENT_PROGRAM);
    if (!isBlit.has(p)) isBlit.set(p, !!gl.getUniformLocation(p, 'uCacheTex'));
    if (isBlit.get(p) && gl.getParameter(gl.FRAMEBUFFER_BINDING) === null) blit = lastVp.slice();
    da0(...a);
  };
  const r = api.createRenderer(gl, shaders, {}); if (r.ready) await r.ready;
  r.setViewport(W, H);
  const b = api.createBundle(gl, await api.importSvg(c.svg, { preserveViewport: true }));
  const h = r.createBundleHandle(b, { staticCache: { strategy: api.CacheStrategy.ForceWholeAsset } });
  const opts = c.matrix ? { worldMatrix: new Float32Array(c.matrix) } : {};
  let ov = null;
  if (c.override) { ov = api.createOverrideTable(gl, b); ov.set('fg', { localPosition: [20, 10] }); opts.overrides = ov; }
  if (r.prepareBundle) r.prepareBundle(b);
  r.prewarmBundle(b); r.precompileFills();
  const read = () => { const p = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, p); return p; };
  const frame = (fn) => { r.beginFrame([1, 1, 1, 1]); fn(); r.endFrame(); };
  const liveAt = (o) => () => frame(() => r.drawBundle(b, o));
  const cachedAt = (o) => () => frame(() => h.draw(o));
  const settle = async (fn) => {
    await r.warmScene([{ name: 'case', draw: fn }], { maxPasses: 8, fenceTimeoutMs: 20000 });
    for (let i = 0; i < 6; i++) { fn(); await new Promise((q) => setTimeout(q, 3)); }
    return read();
  };
  const target = c.moveTo ? { ...opts, worldMatrix: new Float32Array(c.moveTo) } : opts;
  const live = await settle(liveAt(target));
  await settle(cachedAt(opts));          // the bake, at the first pose
  if (c.moveTo) await settle(cachedAt(target));
  blit = null;
  const cached = await settle(cachedAt(target));
  let bad = 0, soft = 0, max = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4; let d = 0;
    for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(live[i + k] - cached[i + k]));
    if (d > max) max = d;
    if (d > 0) soft++;
    if (d > (c.tol ?? ${TOL})) { bad++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  const painted = c.reach ? [0, 1, 2].some((k) => { const i = ((H - 1 - c.reach[1]) * W + c.reach[0]) * 4 + k; return cached[i] !== 255; }) : null;
  let fnv = 0x811c9dc5 >>> 0; for (let i = 0; i < cached.length; i++) { fnv ^= cached[i]; fnv = Math.imul(fnv, 16777619) >>> 0; }
  const out = { device, W, H, bad, soft, max, badBox: bad ? [x0, y0, x1, y1] : null, blit, valid: !!h.staticCache?.isCacheValid, painted, hash: fnv.toString(16), glError: gl.getError() };
  if (ov?.dispose) ov.dispose();
  h.dispose(); b.dispose(); r.dispose();
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
  name: 'groupFilterRectRenderSmoke',
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
  if (c.drawsLive)
    ok(
      !o.valid && !o.blit && o.glError === 0,
      `${c.name}: it draws live, with no cache and no blit (valid ${o.valid}, blit ${o.blit})`,
    );
  else
    ok(
      o.valid && !!o.blit && o.glError === 0,
      `${c.name}: the cache is valid and its blit reached the canvas (viewport ${o.blit})`,
    );
  ok(
    o.bad === 0,
    `${c.name}: cached == live within ${c.tol ?? TOL}/255 (${o.bad} px over, ${o.soft} px differ, max ${o.max}${o.badBox ? `, box ${o.badBox}` : ''})`,
  );
  if (c.reach)
    ok(
      o.painted === true,
      `${c.name}: the filter's output past the children is painted at ${c.reach}`,
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
