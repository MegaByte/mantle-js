// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupOverBlitRenderSmoke — a normal-blend group composited by the fixed-function src-over blit
// matches the copy-and-composite path, and Chrome.
//
// For a normal group, groupEnd blends the accumulator over its target with ONE, ONE_MINUS_SRC_ALPHA
// at uTint = vec4(opacity), where the copy path recomputes opacity x source over a copy of the
// backdrop in composite.frag, under a REPLACE. The two are algebraically the same; the blend unit
// rounds differently from the shader's unpremultiply round trip, so the full-frame diff between
// them may reach 1 LSB and no more. Every case renders in ONE page, on both routes, with the blit
// path and with __MANTLE_GROUP_COPY_COMPOSITE (debug) forcing the copy path, plus once through the
// static cache (whose bake redirects the canvas binds). Fractional canvas alpha -- a translucent
// ground on a transparent canvas -- is where a wrong backdrop term would show, so most cases use it.
// The route is asserted from debugStats, and the blit arm is compared with Chrome at flat points.
// The dataflow (no copy, the blend, the tint, the map) is test/groupOverBlitSmoke.mjs (node).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 120;
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">${body}</svg>`;
const GROUND = '<rect x="0" y="0" width="120" height="120" fill="#ffc864" fill-opacity="0.5"/>';
const RED = '<rect x="10" y="10" width="60" height="80" fill="#f00"/>';
const BLUE = '<rect x="40" y="40" width="60" height="60" fill="#00f" fill-opacity="0.7"/>';
const GREEN = '<rect x="80" y="80" width="30" height="30" fill="#0a0"/>';
const PTS = [
  [25, 25, 'red only'],
  [55, 55, 'red under blue'],
  [90, 50, 'blue only'],
  [5, 110, 'ground only'],
];
const CASES = [
  {
    name: 'opacity group over a 50% ground, transparent canvas',
    ground: 'transparent',
    svg: svg(`${GROUND}<g opacity="0.5">${RED}${BLUE}</g>`),
    pts: PTS,
    grouped: 1,
  },
  {
    name: 'opacity group on white',
    ground: 'white',
    svg: svg(`<g opacity="0.6">${RED}${BLUE}</g>`),
    pts: PTS,
    grouped: 1,
  },
  {
    name: 'nested opacity groups, transparent canvas',
    ground: 'transparent',
    svg: svg(`${GROUND}<g opacity="0.5">${RED}<g opacity="0.25">${BLUE}</g>${GREEN}</g>`),
    pts: [...PTS, [95, 95, 'late green']],
    grouped: 2,
  },
  {
    name: 'isolated group at opacity 1, transparent canvas',
    ground: 'transparent',
    svg: svg(`${GROUND}<g style="isolation:isolate">${RED}${BLUE}</g>`),
    pts: PTS,
    grouped: 1,
  },
  {
    name: 'multiply group in an opacity group, on white',
    ground: 'white',
    svg: svg(
      `<rect x="0" y="0" width="120" height="120" fill="#ffc864"/><g opacity="0.5">${RED}<g style="mix-blend-mode:multiply">${BLUE}</g>${GREEN}</g>`,
    ),
    pts: [...PTS, [95, 95, 'late green']],
    grouped: 2,
  },
  {
    name: 'opacity group in a screen group, on white',
    ground: 'white',
    svg: svg(
      `<rect x="0" y="0" width="120" height="120" fill="#3c64a0"/><g style="mix-blend-mode:screen">${RED}<g opacity="0.5">${BLUE}</g>${GREEN}</g>`,
    ),
    pts: [...PTS, [95, 95, 'late green']],
    grouped: 2,
  },
];
const ROUTES = ['none', 'lb'];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, CacheStrategy } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
const read = () => { const p = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, p); return p; };
const setFlag = (on) => {
  if (on) { globalThis.__MANTLE_DEBUG__ = true; globalThis.__MANTLE_GROUP_COPY_COMPOSITE = true; }
  else { delete globalThis.__MANTLE_DEBUG__; delete globalThis.__MANTLE_GROUP_COPY_COMPOSITE; }
};
window.__case = async (svg, ground, pts, route, cached) => {
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  const clear = ground === 'white' ? [1, 1, 1, 1] : [0, 0, 0, 0];
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  const arm = (copy) => {
    setFlag(copy);
    try {
      let before = null;
      if (cached) {
        R.setBundle(b);
        R.enableStaticCache({ strategy: CacheStrategy.ForceWholeAsset });
        for (let i = 0; i < 3; i++) R.render();
        const valid = !!(R.staticCache && R.staticCache.isCacheValid);
        const px = read();
        R.disableStaticCache();
        return { px, route: { valid } };
      }
      for (let i = 0; i < 4; i++) {
        if (i === 3) before = Object.assign({}, R.debugStats);
        R.beginFrame(clear); R.drawBundle(b); R.endFrame();
      }
      const after = R.debugStats;
      const d = (k) => (after[k] | 0) - (before[k] | 0);
      return { px: read(), route: { gate: after.unifiedFillGate, uniDraws: d('unifiedFillDraws'), groupBrackets: d('unifiedGroupBrackets') } };
    } finally { setFlag(false); }
  };
  const blit = arm(false), copy = arm(true);
  let n = 0, mx = 0;
  for (let i = 0; i < blit.px.length; i++) { const dd = Math.abs(blit.px[i] - copy.px[i]); if (dd) n++; if (dd > mx) mx = dd; }
  b.dispose && b.dispose();
  let chromePts = null;
  if (!cached) {
    const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
    const cv = document.createElement('canvas'); cv.width = cv.height = ${N};
    const ctx = cv.getContext('2d');
    if (ground === 'white') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, ${N}, ${N}); }
    ctx.drawImage(img, 0, 0);
    const ref = ctx.getImageData(0, 0, ${N}, ${N}).data;
    // The WebGL canvas is premultiplied; the 2D canvas's getImageData is straight. Compare straight.
    const straight = (p, i) => { const a = p[i + 3]; return a ? [p[i] * 255 / a, p[i + 1] * 255 / a, p[i + 2] * 255 / a, a] : [0, 0, 0, 0]; };
    chromePts = pts.map(([x, y, what]) => ({ x, y, what,
      mantle: straight(blit.px, ((${N} - 1 - y) * ${N} + x) * 4).map((v) => Math.round(v)),
      chrome: Array.from(ref.slice((y * ${N} + x) * 4, (y * ${N} + x) * 4 + 4)) }));
  }
  return { blitRoute: blit.route, copyRoute: copy.route, diff: { n, mx }, chromePts };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => fail('page: ' + e.message));
// Straight-alpha colors at flat points: a premultiplied byte at alpha ~0.25 un-premultiplies to
// 4x its rounding, so Chrome and the blend unit may part by a few there.
const TOL = 4;
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  const arms = [];
  for (const c of CASES) for (const route of ROUTES) arms.push({ c, route, cached: false });
  arms.push({ c: CASES[0], route: 'none', cached: true });
  arms.push({ c: CASES[2], route: 'none', cached: true });
  for (const { c, route, cached } of arms) {
    const r = await page.evaluate(
      (s, g, p, rt, ca) => window.__case(s, g, p, rt, ca),
      c.svg,
      c.ground,
      c.pts,
      route,
      cached,
    );
    const tag = `${c.name}, route ${route}${cached ? ', static cache' : ''}`;
    if (cached) {
      if (r.blitRoute.valid && r.copyRoute.valid) ok(`${tag}: both arms drew from a valid bake`);
      else
        fail(
          `${tag}: the static cache was not valid (blit ${r.blitRoute.valid}, copy ${r.copyRoute.valid})`,
        );
    } else {
      for (const [armName, took] of [
        ['blit', r.blitRoute],
        ['copy', r.copyRoute],
      ]) {
        const msg = `${tag}, ${armName} arm: gate ${took.gate}, unified draws ${took.uniDraws}, group brackets ${took.groupBrackets}`;
        if (route === 'none') {
          if (took.uniDraws === 0) ok(msg + ' (classic)');
          else fail(msg + ' -- the classic arm drew on the unified route');
        } else if (took.uniDraws > 0 && took.groupBrackets >= 2 * c.grouped) ok(msg + ' (unified)');
        else fail(msg + ' -- the unified arm did not serve the groups');
      }
    }
    const dm = `${tag}: blit vs copy path, ${r.diff.n} channel(s) differ, max ${r.diff.mx}`;
    if (r.diff.mx <= 1) ok(dm);
    else fail(dm + ' (want at most 1 LSB)');
    for (const p of r.chromePts || []) {
      const d = Math.max(...p.mantle.map((v, i) => Math.abs(v - p.chrome[i])));
      const msg = `${tag}, ${p.what} (${p.x},${p.y}): mantle rgba(${p.mantle.join(',')}) chrome rgba(${p.chrome.join(',')})`;
      if (d <= TOL) ok(msg);
      else fail(msg + ` -- off by ${d}/255`);
    }
  }
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\ngroupOverBlitRenderSmoke: normal groups composite by the blit, within 1 LSB of the copy path and at Chrome',
);
