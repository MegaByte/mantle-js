// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// maskCodeSolidParityRenderSmoke -- carrying the optional MASK code in a fill program must not change SOLID output.
// Arm A: a solid-only asset (lean program, no mask code). Arm B: the same asset plus a tiny masked rect in the top-left corner
// (the bundle then needs the mask code, so its fill program is the larger one). Same renderer options, same draw. Every pixel
// outside the corner holding the injected rect must be byte-identical.
//
// WHY every SHADER IS COMPILED FRESH. ANGLE/Metal may give a freshly compiled program and a program-cache hit for the same source
// different float code (fma contraction): a different byte at an AA rounding tie. Which arm hits the cache depends on arm ORDER, not
// on the shader source, so a naive "render A, then render B" compares a fresh compile with a cache hit and reports the driver, not
// the mask code (channels off by 1 on tiger.svg, identical for A,A and for B,A: the mask code is irrelevant to it). The
// control appends a unique comment to every shader source so every program in both arms is a fresh compile.
// MASK_PARITY_NAIVE=1 turns the control off (diagnostic only; expected to fail on a driver that has the cache difference).
import { readFileSync, existsSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAIVE = process.env.MASK_PARITY_NAIVE === '1';
const N = 512,
  CORNER = 16;

const ART =
  '<path d="M60 340 C20 200 120 40 220 70 C320 100 380 220 300 330 C250 400 110 390 60 340Z" fill="#c0392b"/>' +
  '<path d="M120 300 C100 200 170 120 240 140 C310 160 320 250 260 310 C210 350 140 350 120 300Z" fill="#f1c40f" fill-opacity="0.8"/>' +
  '<circle cx="250" cy="120" r="70" fill="#2980b9" fill-opacity="0.6"/><ellipse cx="140" cy="130" rx="90" ry="40" transform="rotate(-25 140 130)" fill="#27ae60"/>' +
  '<path d="M30 30 L370 60 L330 370 L40 340Z" fill="none"/><path d="M200 20 L240 150 L370 150 L265 225 L305 350 L200 275 L95 350 L135 225 L30 150 L160 150Z" fill="#8e44ad" fill-opacity="0.7" fill-rule="evenodd"/>';
const TIGER = path.join(ROOT, 'examples/tiger.svg'); // the reproducer (an ignored fixture); the inline art below stands in when it is absent
const INLINE =
  '<' +
  'svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect x="0" y="0" width="400" height="400" fill="#ecf0f1"/>' +
  ART +
  '</svg>';
const SVG = existsSync(TIGER) ? readFileSync(TIGER, 'utf8') : INLINE;
const vb = (/viewBox="([^"]+)"/.exec(SVG) || [])[1]?.split(/[ ,]+/).map(Number) || [0, 0, 400, 400];
const SVG_MASK = SVG.replace(
  /<svg([^>]*)>/,
  (m) =>
    m +
    `<defs><mask id="parityMask"><rect x="${vb[0]}" y="${vb[1]}" width="2" height="2" fill="#fff"/></mask></defs><rect x="${vb[0]}" y="${vb[1]}" width="2" height="2" mask="url(#parityMask)" fill="#808080"/>`,
);

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
let uniq = ${NAIVE ? 'false' : 'true'}, n = 0, progCount = 0, fillSrcs = [];
const ss = gl.shaderSource.bind(gl);
gl.shaderSource = (s, src) => { if (uniq) src = src.replace(/\\n$/, '') + '\\n// parity fresh ' + (++n) + '\\n'; if (gl.getShaderParameter(s, gl.SHADER_TYPE) === gl.FRAGMENT_SHADER) fillSrcs.push(src); return ss(s, src); };
const cp = gl.createProgram.bind(gl); gl.createProgram = () => { progCount++; return cp(); };
const arm = async (text) => {
  fillSrcs = [];
  const sec = await importSvg(text); const r = createRenderer(gl, shaders, {}); const b = createBundle(gl, sec);
  const px = new Uint8Array(${N} * ${N} * 4); let prev = null, same = 0, lastProg = 0, f = 0;
  for (; f < 400 && (same < 12 || f < 20 || f - lastProg < 12); f++) {
    const pc = progCount; r.setViewport(${N}, ${N}); r.beginFrame([1, 1, 1, 1]); r.drawBundle(b, {}); r.endFrame(); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
    same = prev && px.every((v, i) => v === prev[i]) ? same + 1 : 0; prev = px.slice(); if (progCount !== pc) lastProg = f; await new Promise((q) => setTimeout(q, 50));
  }
  // fill programs: those compiled with the lean-omission defines; the mask arm must hold at least one without MANTLE_NO_MASK
  const fills = fillSrcs.filter((s) => /#define MANTLE_NO_GRADIENT/.test(s));
  return { px, frames: f, fillPrograms: fills.length, withMaskCode: fills.filter((s) => !/#define MANTLE_NO_MASK/.test(s)).length };
};
const A = await arm(${JSON.stringify(SVG)});
const B = await arm(${JSON.stringify(SVG_MASK)});
const A2 = await arm(${JSON.stringify(SVG)});
const cmp = (a, b) => { let diff = 0, max = 0, ink = 0, first = null;
  for (let i = 0; i < a.px.length; i += 4) { const p = i / 4, x = p % ${N}, y = ${N} - 1 - Math.floor(p / ${N}); if (a.px[i + 3]) ink++; if (x < ${CORNER} && y < ${CORNER}) continue;   // readPixels rows run bottom-up
    for (let k = 0; k < 3; k++) { const d = Math.abs(a.px[i + k] - b.px[i + k]); if (d) { diff++; if (d > max) max = d; if (!first) first = [x, y, k, a.px[i + k], b.px[i + k]]; } } }
  return { diff, max, ink, first }; };
window.__result = { ab: cmp(A, B), aa: cmp(A, A2), a: { frames: A.frames, fillPrograms: A.fillPrograms, withMaskCode: A.withMaskCode }, b: { frames: B.frames, fillPrograms: B.fillPrograms, withMaskCode: B.withMaskCode } };
window.__done = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  const p = decodeURIComponent(u.pathname);
  try {
    res.writeHead(200, {
      'content-type':
        (/\.m?js$/.test(p)
          ? 'text/javascript'
          : p.endsWith('.glsl')
            ? 'text/plain'
            : 'application/octet-stream') + '; charset=utf-8',
    });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
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
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/404/.test(m.text())) errs.push(m.text());
});
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 30000,
});
await page
  .waitForFunction(() => window.__done === true, { timeout: 120000, polling: 200 })
  .catch(() => {});
const r = await page.evaluate(() => window.__result);
await browser.close();
server.close();

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
if (!r) {
  fail('page never finished: ' + errs.join(' | '));
} else {
  console.log(JSON.stringify(r));
  if (!(r.ab.ink > 1000)) fail('nothing rendered');
  if (r.b.withMaskCode < 1)
    fail('arm B holds no fill program with the mask code (the test would not exercise it)');
  else
    ok(
      `arm B carries mask code in ${r.b.withMaskCode} of ${r.b.fillPrograms} fill programs; arm A in ${r.a.withMaskCode} of ${r.a.fillPrograms}`,
    );
  if (r.a.withMaskCode > 0)
    fail('arm A (solid only) carries the mask code; the lean variant was not selected');
  if (r.aa.diff === 0) ok('A/A control byte-identical');
  else
    fail(
      `A/A control differs (${r.aa.diff} channels, max ${r.aa.max}) at ${JSON.stringify(r.aa.first)}`,
    );
  if (r.ab.diff === 0) ok('solid output byte-identical with and without the mask code');
  else
    fail(
      `mask code changed solid output: ${r.ab.diff} channels, max ${r.ab.max}/255, first ${JSON.stringify(r.ab.first)}`,
    );
  if (errs.length) fail('page errors: ' + errs.join(' | '));
}
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nmaskCodeSolidParityRenderSmoke: the mask code does not move solid pixels');
