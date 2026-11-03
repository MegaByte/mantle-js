// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Physical-GPU checks for COLR gradient coordinates and transformed generators.
// Synthetic colors use authored gradient definitions. Font controls also compare
// with Chrome when the synthetic font loads there.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { buildColrTestFont } from './font/_colrFontFixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 256;
const ROUTES = ['none', 'lb'];
const FONTS = ['h', 'v', 'sweep'].map((kind) => ({
  kind,
  family: `ColrGrad${kind}`,
  b64: Buffer.from(
    buildColrTestFont({
      codepoint: 0x41,
      colrV1GlyphGrad: kind,
      complete: true,
      family: `ColrGrad${kind}`,
    }),
  ).toString('base64'),
}));
// Fractions across the glyph's ink box at which colors are read (clear of the anti-aliased edge).
const FRACS = [0.15, 0.3, 0.5, 0.7, 0.85];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createTextBundle } from '/src/index.js';
import { MantleFontAsset } from '/src/font/fontAsset.js';
import { registerColorEmojiReaders } from '/src/font/color/index.js';
registerColorEmojiReaders();
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
const bytesOf = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const read = () => { const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  // top-down rows, as a 2D canvas reads
  const out = new Uint8Array(${N} * ${N} * 4);
  for (let y = 0; y < ${N}; y++) out.set(px.subarray((${N} - 1 - y) * ${N} * 4, (${N} - y) * ${N} * 4), y * ${N} * 4);
  return out; };
const draw = async (b, route, opts) => {
  R.setFillEngine({ route, kernel: 'slug' });
  const bundle = b.bundle || b;
  if (R.prepareBundle) R.prepareBundle(bundle);
  if (R.awaitLbReady) { try { await R.awaitLbReady(bundle, 20000); } catch {} }
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  if(b.bundle && R.warmScene){
    // Cold Metal pipelines can exceed the default interactive fence budget.
    const warmed=await R.warmScene([{draw:()=>{R.beginFrame([1,1,1,1]);R.drawBundle(b,opts||{});R.endFrame();}}],{fenceTimeoutMs:60000});
    if(!warmed.complete)throw Error('Font draw state did not warm: '+JSON.stringify(warmed));
  }
  let before = null;
  for (let i = 0; i < 4; i++) { if (i === 3) before = Object.assign({}, R.debugStats); R.beginFrame([1, 1, 1, 1]); R.drawBundle(b, opts || {}); R.endFrame(); }
  return { leaves: (R.debugStats.unifiedColrLeaves | 0) - (before.unifiedColrLeaves | 0), px: Array.from(read()) };
};
// The probe's case: a 64 px square with a synthetic graph, the gradient in bundle em (= canvas px here).
window.__square = async (dir, route, transformed = false) => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}"><rect x="100" y="100" width="64" height="64" fill="#0f0"/></svg>';
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  const op = b.drawList.filter((o) => o.kind === 'fillShape').pop();
  const p0 = dir === 'h' ? [100, 132] : [132, 100], p1 = dir === 'h' ? [164, 132] : [132, 164];
  if(transformed&&dir!=='radial'){p0[0]-=600;p1[0]-=600;}
  const p2 = [p0[0] - (p1[1] - p0[1]), p0[1] + (p1[0] - p0[0])];
  const affine=dir==='radial'?[1e6,0,0,1e6,0,0]:[1,0,0,1,600,0],scale=transformed&&dir==='radial'?1e6:1;
  b.colrGraphs = [{ nodes: [
    ...(dir==='radial'?[{type:'PaintRadialGradient',inputs:[],params:{c0:[132/scale,132/scale],c1:[132/scale,132/scale],r0:0,r1:32/scale,extend:0,stops:[{offset:0,color:[1,0,0,1]},{offset:1,color:[0,0,1,1]}]}}]:[
    { type: 'PaintLinearGradient', inputs: [], params: { p0, p1, p2, extend: 0,
      stops: [{ offset: 0, color: [1, 0, 0, 1] }, { offset: 1, color: [0, 0, 1, 1] }] } }]),
    ...(transformed?[{type:'PaintTransform',inputs:[0],params:{affine}}]:[]),
    { type: 'PaintGlyph', inputs: [transformed?1:0], params: { glyphId: 1 } },
  ], rootOut: transformed?2:1 }];
  op.colrGraphId = 1;
  const r = await draw(b, route);
  b.dispose && b.dispose();
  return r;
};
// A COLRv1 font's glyph through TextRun, drawn at half the canvas (the world matrix leaves a margin).
window.__font = async (b64, route, compat) => {
  const font = new MantleFontAsset(bytesOf(b64), compat ? { compat } : {});
  const tb = await createTextBundle(gl, { font, text: 'A', style: { fontSize: 1, fill: [0, 0, 0, 1] } });
  const r = await draw(tb, route, { worldMatrix: [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1] });
  r.graphs = (tb.bundle.colrGraphs || []).length;
  tb.dispose && tb.dispose();
  return r;
};
// Chrome: the same bytes through FontFace, on a 2D canvas. The square spans 50..350 of 1000 units, so at
// 400 px it is 120 px, centered by the pen and baseline chosen here. Null when the font does not load.
window.__chrome = async (b64, family) => {
  try {
    const face = new FontFace(family, bytesOf(b64));
    await face.load();
    document.fonts.add(face);
  } catch (e) { return { err: String(e && e.message || e) }; }
  const cv = document.createElement('canvas'); cv.width = cv.height = ${N};
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, ${N}, ${N});
  ctx.font = '400px "' + family + '"'; ctx.fillStyle = '#000'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('A', 128 - 0.2 * 400, 128 + 0.2 * 400);
  return { px: Array.from(ctx.getImageData(0, 0, ${N}, ${N}).data) };
};
window.__queueDisposed = async () => {
  const sections=await importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M10 10L50 10L50 50L10 50Z"/></svg>');
  const expired=Array.from({length:32},()=>createBundle(gl,sections));
  R.precompileFills({draw:false});
  for(const b of expired)b.dispose();
};
window.__glError=()=>gl.getError();
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
const RED = [255, 0, 0],
  BLUE = [0, 0, 255];
// Mantle's default: OpenType's linear-light color line. Chrome's own render, and Mantle's compat: 'chrome', interpolate the encoded values.
const toLin = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const lerpSpec = (t) =>
  RED.map((r, i) => 255 * toSrgb(toLin(r) + (toLin(BLUE[i]) - toLin(r)) * clamp01(t)));
const lerpChrome = (t) => RED.map((r, i) => r + (BLUE[i] - r) * clamp01(t));
const at = (px, x, y) => {
  const i = (y * N + x) * 4;
  return [px[i], px[i + 1], px[i + 2]];
};
// The glyph's ink box: pixels well away from the white ground (anti-aliased fringes excluded).
const inkBox = (px) => {
  let x0 = N,
    y0 = N,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const c = at(px, x, y);
      if (Math.max(...c.map((v) => 255 - v)) > 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 }; // pixel edges
};
// t at a pixel center, from the box it sits in (fx, fy measured top-down). The fonts' grid is y up, so
// their vertical gradient is red at the BOTTOM; the synthetic square's graph is in bundle em, y down, so
// its vertical gradient ('v-down') is red at the top.
const tOf = (kind, fx, fy) => {
  if (kind === 'h') return fx;
  if (kind === 'v') return 1 - fy;
  if (kind === 'v-down') return fy;
  if (kind === 'radial') return 2 * Math.hypot(fx - 0.5, fy - 0.5);
  let a = (Math.atan2(-(fy - 0.5), fx - 0.5) * 180) / Math.PI;
  if (a < 0) a += 360;
  return a / 360;
};
// The points read: every pair of fractions, except (for the sweep) the seam along +x.
const pointsIn = (box, kind) => {
  const out = [];
  for (const fy of FRACS)
    for (const fx of FRACS) {
      const x = Math.floor(box.x0 + fx * (box.x1 - box.x0)),
        y = Math.floor(box.y0 + fy * (box.y1 - box.y0));
      const cfx = (x + 0.5 - box.x0) / (box.x1 - box.x0),
        cfy = (y + 0.5 - box.y0) / (box.y1 - box.y0);
      if (
        kind === 'sweep' &&
        ((cfx > 0.5 && Math.abs(cfy - 0.5) < 0.12) || Math.hypot(cfx - 0.5, cfy - 0.5) < 0.1)
      )
        continue;
      out.push({ x, y, t: tOf(kind, cfx, cfy) });
    }
  return out;
};
// Within this of the expectation: the 8-bit targets, the stop LUT, and the ink box's half-pixel edges.
const TOL = 8;
const check = (tag, px, kind, box, lerp = lerpSpec) => {
  let worst = 0,
    where = null;
  for (const p of pointsIn(box, kind)) {
    const got = at(px, p.x, p.y),
      want = lerp(p.t);
    const d = Math.max(...got.map((v, i) => Math.abs(v - want[i])));
    if (d > worst) {
      worst = d;
      where = { ...p, got, want: want.map(Math.round) };
    }
  }
  const msg = `${tag}: colors across the glyph within ${worst.toFixed(1)}/255 of the gradient (box ${box.x0},${box.y0}..${box.x1},${box.y1})`;
  if (worst <= TOL) ok(msg);
  else
    fail(
      `${msg} -- worst at (${where.x},${where.y}), t ${where.t.toFixed(3)}: got rgb(${where.got}) want rgb(${where.want})`,
    );
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
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  // 1. The GPU probe's square: the square is at (100, 100)..(164, 164) by construction.
  for (const dir of ['h', 'v', 'radial'])
    for (const route of ROUTES)
      for (const transformed of [false, true]) {
        const r = await page.evaluate(
          (d, rt, tr) => window.__square(d, rt, tr),
          dir,
          route,
          transformed,
        );
        if (route === 'lb' && !(r.leaves > 0))
          fail(`square ${dir}, route lb: the unified route served no COLR leaf`);
        check(
          `synthetic graph on a 64 px square, ${dir === 'h' ? 'horizontal' : 'vertical'}, route ${route}`,
          r.px,
          dir === 'radial' ? 'radial' : dir === 'h' ? 'h' : 'v-down',
          { x0: 100, y0: 100, x1: 164, y1: 164 },
        );
      }
  await page.evaluate(() => window.__queueDisposed());
  // 2. A COLRv1 font's glyph, Mantle on both routes and Chrome.
  for (const f of FONTS) {
    const ch = await page.evaluate((b, fam) => window.__chrome(b, fam), f.b64, f.family);
    const cbox = ch.px ? inkBox(ch.px) : null;
    if (!cbox)
      console.log(
        `note: Chrome did not render the ${f.kind} COLRv1 font (${ch.err || 'no ink'}); the CPU expectation stands alone`,
      );
    else check(`Chrome, font ${f.kind}`, ch.px, f.kind, cbox, lerpChrome);
    for (const route of ROUTES) {
      const r = await page.evaluate((b, rt) => window.__font(b, rt), f.b64, route);
      const tag = `COLRv1 font ${f.kind}, route ${route}`;
      if (r.graphs !== 1) {
        fail(`${tag}: the text bundle carries ${r.graphs} COLR graphs, want 1`);
        continue;
      }
      if (route === 'lb' && !(r.leaves > 0)) fail(`${tag}: the unified route served no COLR leaf`);
      const box = inkBox(r.px);
      if (!box) {
        fail(`${tag}: no ink`);
        continue;
      }
      check(tag, r.px, f.kind, box);
      if (cbox) {
        // Mantle against Chrome, fraction for fraction across each one's own glyph box, in Chrome's reading of the color line.
        const rc = await page.evaluate((b, rt) => window.__font(b, rt, 'chrome'), f.b64, route);
        const boxC = inkBox(rc.px);
        if (!boxC) {
          fail(`${tag}, compat chrome: no ink`);
          continue;
        }
        check(`${tag}, compat chrome`, rc.px, f.kind, boxC, lerpChrome);
        let worst = 0,
          where = null;
        for (const fy of FRACS)
          for (const fx of FRACS) {
            if (f.kind === 'sweep' && fx > 0.5 && Math.abs(fy - 0.5) < 0.12) continue;
            const m = at(
              rc.px,
              Math.floor(boxC.x0 + fx * (boxC.x1 - boxC.x0)),
              Math.floor(boxC.y0 + fy * (boxC.y1 - boxC.y0)),
            );
            const c = at(
              ch.px,
              Math.floor(cbox.x0 + fx * (cbox.x1 - cbox.x0)),
              Math.floor(cbox.y0 + fy * (cbox.y1 - cbox.y0)),
            );
            const d = Math.max(...m.map((v, i) => Math.abs(v - c[i])));
            if (d > worst) {
              worst = d;
              where = { fx, fy, m, c };
            }
          }
        const msg = `${tag} against Chrome: within ${worst}/255 at matching fractions of each glyph`;
        if (worst <= 2 * TOL) ok(msg);
        else
          fail(
            `${msg} -- worst at (${where.fx}, ${where.fy}): mantle rgb(${where.m}) chrome rgb(${where.c})`,
          );
      }
    }
  }
  const glError = await page.evaluate(() => window.__glError());
  if (glError) fail('Native GL error ' + glError);
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
  '\ncolrGradientPlacementRenderSmoke: COLRv1 gradients land where their coordinates say, inside the glyph',
);
