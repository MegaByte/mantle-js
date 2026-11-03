// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _offPixels — off pixels one by one: the LB route on the GPU against an 8x box-averaged Chrome reference, next
// to the kernel's CPU twin on the same scene, so every GPU pixel the twin does not reproduce is named.
//
// On a circle, a star, an S-curve and an ellipse at 384 px, at IDENTITY, the LB route can show a few dozen edge pixels
// off by more than 32/255 where Slug shows about one, and the twin (_lbKernel/_lbRaster, the static LB kernel composited
// OVER) reproduces only some of them. This probe says where the other GPU pixels are and which shape and engine drew them.
//
// For each of route 'lb' and route 'none' (Slug): the whole scene, then each shape SOLO (black on white, so a shape's
// own pixels are attributable), with the engine draw tally of each render. Every pixel off by more than 32/255 is
// listed with its position, the render's value, the reference's value (both 0..255, 255 = white), the solo shape that
// owns it, and whether the twin has it. The twin's list comes from the same scene through _lbAaAudit's pieces.
//
//   node probes/lbAccuracy/_offPixels.mjs [OUT.json]        (TWIN_ONLY=1: the CPU half, no browser)
//   GPU: needs a GPU (ANGLE Metal); MANTLE_TEST_GL=swiftshader runs it in software, whose AA may differ.
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.argv[2] || path.join(os.tmpdir(), 'offPixels.json');
const N = 384;
const SHAPES = [
  '<circle cx="120" cy="130" r="70" fill="#000"/>',
  '<path d="M250 60 L280 150 L370 150 L300 205 L325 295 L250 240 L175 295 L200 205 L130 150 L220 150 Z" fill="#000"/>',
  '<path d="M40 300 C80 230 160 380 200 300 S300 240 340 330 L340 370 L40 370 Z" fill="#000"/>',
  '<ellipse cx="300" cy="80" rx="60" ry="22" fill="#000"/>',
];
const NAMES = ['circle', 'star', 'S-curve', 'ellipse'];
const svgOf = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">${body}</svg>`;

// ── the twin's pixels, on the CPU ─────────────────────────────────────────────────────────────────
async function twinPixels() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'offpx-')),
    file = path.join(dir, 'scene.svg');
  writeFileSync(file, svgOf(SHAPES.join('')));
  process.env.PRESERVE_VIEWPORT = '1';
  const R = await import('./_lbRaster.mjs'),
    REF = await import('./_lbAaRef.mjs');
  const bundle = await R.loadSvg(file);
  const { shapes, bbox } = await R.shapesOf(bundle),
    view = R.viewOf(bbox, N);
  const { rowSpans, contoursToConverter, closed } = await REF.refKit();
  const out = new Map();
  for (const sh of shapes) {
    const built = await R.buildMesh(sh);
    if (!built) continue;
    const acc = new Float64Array(N * N).fill(1);
    R.rasterMesh(built.pk, view, acc, {});
    const curves = closed(contoursToConverter(sh.contours, null));
    for (let j = 0; j < N; j++) {
      const rc = new Map();
      for (let i = 0; i < N; i++) {
        const mo = 1 - acc[j * N + i];
        const ex = REF.exactCov(rowSpans, curves, i, j, view, 64, sh.evenOdd, rc);
        if (Math.abs(mo - ex) > 32 / 255)
          out.set(i + ',' + j, {
            shape: NAMES[sh.s],
            twin: Math.round(255 * (1 - mo)),
            exact: Math.round(255 * (1 - ex)),
          });
      }
    }
  }
  return out;
}

// ── the GPU ───────────────────────────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__shot = async (svg, route) => {
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b); if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  const before = Object.assign({}, (R.debugStats.engines || {}).draws || {});
  for (let i = 0; i < 3; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
  const after = (R.debugStats.engines || {}).draws || {}, drew = {};
  for (const k in after) { const n = (after[k] | 0) - (before[k] | 0); if (n) drew[k] = n; }
  const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px); b.dispose && b.dispose();
  const red = []; for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) red.push(px[((${N} - 1 - y) * ${N} + x) * 4]);
  return { red, drew };
};
window.__ref = async (svg) => {   // Chrome at 8x, box-averaged: area coverage (Chrome at 1x point-samples)
  const SS = 8, M2 = ${N} * SS, img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('width="${N}" height="${N}"', 'width="' + M2 + '" height="' + M2 + '"'));
  await img.decode();
  const c2 = document.createElement('canvas'); c2.width = c2.height = M2; const ctx = c2.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, M2, M2); ctx.drawImage(img, 0, 0, M2, M2);
  const big = ctx.getImageData(0, 0, M2, M2).data, out = [];
  for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) {
    let s = 0; for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) s += big[((y * SS + j) * M2 + x * SS + i) * 4];
    out.push(s / (SS * SS));
  }
  return out;
};
window.__ready = true;</script></body></html>`;

const twin = await twinPixels();
if (process.env.TWIN_ONLY) {
  // the CPU half alone: no browser
  const by = {};
  for (const v of twin.values()) by[v.shape] = (by[v.shape] || 0) + 1;
  console.log(`twin: ${twin.size} px off by more than 32/255`, JSON.stringify(by));
  for (const [k, v] of twin) console.log(`  ${k} ${v.shape} twin ${v.twin} exact ${v.exact}`);
  process.exit(0);
}
const { launchBrowser } = await import(path.join(ROOT, 'test/_launch.mjs'));
const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
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
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
const report = { twinCount: twin.size, routes: {} };
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  const scene = svgOf(SHAPES.join(''));
  const ref = await page.evaluate((s) => window.__ref(s), scene);
  // which shape owns a pixel: the solo reference that is not white there
  const soloRef = [];
  for (const body of SHAPES) soloRef.push(await page.evaluate((s) => window.__ref(s), svgOf(body)));
  for (const route of ['lb', 'none']) {
    const shot = await page.evaluate((s, r) => window.__shot(s, r), scene, route);
    const solo = [];
    for (const body of SHAPES)
      solo.push(await page.evaluate((s, r) => window.__shot(s, r), svgOf(body), route));
    const pixels = [];
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const k = y * N + x,
          m = shot.red[k],
          r = ref[k];
        if ((m === 255 && r > 254.5) || (m === 0 && r < 0.5)) continue;
        if (Math.abs(m - r) <= 32) continue;
        const owners = SHAPES.map((_, s) =>
          soloRef[s][k] < 254.5 || solo[s].red[k] < 255 ? NAMES[s] : null,
        ).filter(Boolean);
        const t = twin.get(x + ',' + y);
        pixels.push({ x, y, drawn: m, ref: Math.round(r), owners, twin: t ? t.twin : null });
      }
    report.routes[route] = {
      drew: shot.drew,
      soloDrew: solo.map((s, i) => ({ shape: NAMES[i], drew: s.drew })),
      off32: pixels.length,
      notInTwin: pixels.filter((p) => p.twin == null).length,
      pixels,
    };
    console.log(
      `${route.padEnd(4)} drew ${JSON.stringify(shot.drew)}: ${pixels.length} px off by more than 32/255, ` +
        `${pixels.filter((p) => p.twin == null).length} of them not in the twin's ${twin.size}`,
    );
    const by = {};
    for (const p of pixels) for (const o of p.owners) by[o] = (by[o] || 0) + 1;
    console.log('     by shape', JSON.stringify(by));
  }
} finally {
  await browser.close();
  server.close();
}
writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log('wrote', OUT);
