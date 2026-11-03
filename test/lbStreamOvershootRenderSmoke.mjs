// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbStreamOvershootRenderSmoke -- a streamed road band whose edge curve overshoots its far cap draws, and draws right, on real GL.
//
// A perspective band's edge is a quad through a midpoint, so on a bend its control point lands past the far end: the curve crosses the far cap (a quad along its own chord, which the build reads as a
// line) and comes back to its corner. A static shape with that crossing goes to its cover quad. A lightweight stream has none that is current, so a declined section is a hole in the road, on every
// frame of the bend, and its stale row takes the stream to a program no warm built. Here: real bands from a road's frames and swept ones, streamed as the road streams them (opaque, no ramp), against
// the same outline as a static path drawn by the exact cover kernel, at the road's scale and past it.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = [
  [
    [-21.27283834117725, 85.06481210682915],
    [47.034821223809246, 61.65316294540193],
    [47.00258600732872, 61.657991588901396],
    [115.14919113003918, 61.657991588901396],
    [115.11695591355866, 61.65316294540193],
    [183.42461547854515, 85.06481210682915],
  ],
  [
    [-24.43275010261469, 86.14765448454986],
    [47.23337488272105, 61.585313999608275],
    [46.65943535195244, 61.77575552108654],
    [115.49234178541546, 61.77575552108654],
    [114.91840225464682, 61.585313999608275],
    [186.5845272399826, 86.14765448454986],
  ],
  [
    [-27.95599490407325, 87.35497642225238],
    [47.5015691235665, 61.493608207528254],
    [46.292798974342325, 61.90157050242241],
    [115.85897816302557, 61.90157050242241],
    [114.65020801380138, 61.493608207528254],
    [190.10777204144114, 87.35497642225238],
  ],
  [
    [-38.33095949282078, 85.06481210682915],
    [41.36130999966346, 61.65316294540193],
    [41.32370224710285, 61.657991588901396],
    [47.00258600732872, 61.657991588901396],
    [47.034821223809246, 61.65316294540193],
    [-21.27283834117725, 85.06481210682915],
  ],
  [
    [52.94580022804439, 61.632214859128],
    [37.27444445631467, 58.866958322717494],
    [58.227327907551086, 60.21851865318604],
    [107.27621744284406, 60.21851865318604],
    [79.83584440535866, 58.866958322717494],
    [108.78043155185878, 61.632214859128],
  ],
];
// the road's band formula, swept: near and far edges of a perspective road, the midline pushed sideways
const swept = [];
{
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const w = (y) => Math.max(0.2, (y - 50) * 2.4);
  for (let i = 0; i < 8; i++) {
    const yN = 60 + rnd() * 80,
      yF = yN - 1 - rnd() * 25,
      cxN = 70 + rnd() * 20,
      cxF = cxN + (rnd() - 0.5) * 14,
      yM = (yN + yF) / 2 - rnd() * 0.8 * (yN - yF),
      cxM = (cxN + cxF) / 2 + (rnd() - 0.5) * 30;
    const c = (n, m, f) => [2 * m[0] - (n[0] + f[0]) / 2, 2 * m[1] - (n[1] + f[1]) / 2];
    const nL = [cxN - w(yN), yN],
      mL = [cxM - w(yM), yM],
      fL = [cxF - w(yF), yF],
      nR = [cxN + w(yN), yN],
      mR = [cxM + w(yM), yM],
      fR = [cxF + w(yF), yF];
    swept.push([nL, c(nL, mL, fL), fL, fR, c(fR, mR, nR), nR]);
  }
}
const BANDS = [...REAL, ...swept];
const W = 512,
  H = 256;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${W}" height="${H}"></canvas><script type="module">
import { createRenderer, loadShaders, createBundle, importSvg, buildStreamableSections, updateBundleGeometry } from '/src/index.js';
import { mkQuad } from '/src/primitives/seg.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const r = createRenderer(gl, await loadShaders(new URL('/src/shaders/', location.href).href));
r.setViewport(${W}, ${H});
const WHITE = [1, 1, 1, 1];
const segs = (b) => [mkQuad(b[0], b[1], b[2]), mkQuad(b[2], b[2], b[3]), mkQuad(b[3], b[4], b[5]), mkQuad(b[5], b[5], b[0])];
const read = () => { const p = new Uint8Array(${W * H * 4}); gl.readPixels(0, 0, ${W}, ${H}, gl.RGBA, gl.UNSIGNED_BYTE, p); return p; };
const draw = (b) => { r.beginFrame([0, 0, 0, 1]); r.drawBundle(b, {}); r.endFrame(); return read(); };
const out = [];
for (const b of ${JSON.stringify(BANDS)}) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of b) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  // the whole band, and its far left corner where the curve overshoots: at the road's scale (about 20 px per unit on a large canvas) and past it
  const bw = Math.max(x1 - x0, 2 * (y1 - y0)) * 1.1, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const views = [[cx - bw / 2, cy - bw / 4, bw, bw / 2]];
  const z = Math.max(1, Math.hypot(b[1][0] - b[2][0], b[1][1] - b[2][1]) * 4); views.push([b[2][0] - 12.3, b[2][1] - 6.15, 24.6, 12.3]); views.push([b[2][0] - z, b[2][1] - z / 2, 2 * z, z]);
  for (const v of views) {
    const d = 'M' + b[0].join(' ') + 'Q' + b[1].join(' ') + ' ' + b[2].join(' ') + 'L' + b[3].join(' ') + 'Q' + b[4].join(' ') + ' ' + b[5].join(' ') + 'Z';
    const staticB = createBundle(gl, await importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + v.join(' ') + '" width="${W}" height="${H}"><path d="' + d + '" fill="#fff"/></svg>', { preserveViewport: true }));
    r.setLoopBlinnFill(false);
    const ref = draw(staticB);
    staticB.dispose();
    r.setLoopBlinnFill('auto');
    // first built from a clean band, as a game builds it; then the frame
    const box = v.slice();
    const clean = segs([[0, 0], [0.5, 0.5], [0, 1], [1, 1], [1.5, 0.5], [1, 0]]);
    // (a second section, off the view: a stream with nothing servable left falls back to a full update, which draws right; a road always has a servable section)
    const ox = v[0] + 8 * v[2], oy = v[1], other = segs([[ox, oy], [ox, oy], [ox + 9, oy], [ox + 9, oy + 9], [ox + 9, oy + 9], [ox, oy + 9]]);
    const s = createBundle(gl, buildStreamableSections([{ segs: clean, fill: WHITE }, { segs: clean, fill: WHITE }], box));
    s._lbStreamRamp = false;
    const res = updateBundleGeometry(gl, s, [segs(b), other], { lightweight: true });
    s.globalBBox = box.slice();
    const got = draw(s);
    const hasSlug = !!s._lbHasSlug;
    s.dispose();
    let sum = 0, big = 0, ink = 0, worst = 0;
    for (let i = 0; i < got.length; i += 4) { const e = Math.abs(got[i] - ref[i]); sum += e; if (e >= 64) big++; if (e > worst) worst = e; ink += ref[i]; }
    out.push({ ok: !!(res && res.ok), hasSlug, err: +(sum / 255).toFixed(2), big, worst, ink: +(ink / 255).toFixed(1) });
  }
}
window.__out = out; window.__ready = true;
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
await openReady(page, `http://127.0.0.1:${server.address().port}/`);
const o = await page.evaluate(() => window.__out);
await browser.close();
server.close();
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
console.log(JSON.stringify(o));
const badS = o.filter((x) => !x.ok || x.hasSlug).length;
ok(
  badS === 0,
  `every band streams with a mesh, no section left to a stale row (${badS} of ${o.length} views declined)`,
);
const inked = o.filter((x) => x.ink > 50);
ok(
  inked.length >= o.length / 2,
  `the premise: the views hold the band (${inked.length} of ${o.length} with ink)`,
);
// A declined band reads its whole ink here (16509 px^2 of 16509). The bar at the band's and the road's scale is what these bands read with a curved far cap (worst 65.6 px^2); past the road's
// scale the bar is relative, since a view holds a fraction of a band at 12 times the road's scale.
const roadScale = o.filter((x, i) => i % 3 !== 2),
  past = o.filter((x, i) => i % 3 === 2);
const maxRoad = Math.max(...roadScale.map((x) => x.err)),
  maxPast = Math.max(...past.map((x) => x.err / x.ink));
ok(
  maxRoad <= 66,
  `at the band's and the road's scale the outline matches the exact kernel (worst ${maxRoad} px^2 of coverage, ${Math.max(...roadScale.map((x) => x.big))} px at 64 levels or more)`,
);
ok(maxPast <= 0.02, `and past it (worst ${(maxPast * 100).toFixed(2)}% of the view's ink)`);
process.exit(fail ? 1 : 0);
