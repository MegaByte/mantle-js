// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbTipSmoke — tips and shallow curve joints must match 4× AAC without kind-8.
//
// Line–line: kind-10 START tip-cession + adaptive VS reach.
// Curve–curve (incl. shallow): kind-12 chains (κ=0 when shallow).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 192,
  SS = 4;
const wrap = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#000000" d="${d}"/></svg>`;
const wrapHi = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N * SS} ${N * SS}" width="${N * SS}" height="${N * SS}"><path fill="#000000" d="${d}"/></svg>`;

function sharpV(n) {
  const m = n / 2,
    top = 0.12 * n,
    bot = 0.88 * n,
    half = 0.38 * n;
  return `M ${m} ${bot} L ${m - half} ${top} L ${m - half * 0.35} ${top} L ${m} ${bot - 0.08 * n} L ${m + half * 0.35} ${top} L ${m + half} ${top} Z`;
}
function box(n) {
  const a = 0.2 * n,
    b = 0.8 * n;
  return `M ${a} ${a} L ${b} ${a} L ${b} ${b} L ${a} ${b} Z`;
}
function kite(n) {
  const m = n / 2,
    R = 0.4 * n,
    r = 0.26 * n;
  return `M ${m} ${m - R} L ${m + r} ${m} L ${m} ${m + R} L ${m - r} ${m} Z`;
}
// Shallow-joint quad ring (small bulge → |turn| well below LB_BAND_SHARP_TURN).
function shallowRing(n) {
  const c = n / 2,
    r = n * 0.36,
    K = 8;
  const P = (i) => {
    const a = (i / K) * 2 * Math.PI;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  };
  let d = `M ${P(0)[0].toFixed(4)} ${P(0)[1].toFixed(4)} `;
  for (let i = 0; i < K; i++) {
    const A = P(i),
      B = P(i + 1);
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.08,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.08;
    d += `Q ${mx.toFixed(4)} ${my.toFixed(4)} ${B[0].toFixed(4)} ${B[1].toFixed(4)} `;
  }
  return d + 'Z';
}

const SHAPES = {
  v: [wrap(sharpV(N)), wrapHi(sharpV(N * SS))],
  kite: [wrap(kite(N)), wrapHi(kite(N * SS))],
  box: [wrap(box(N)), wrapHi(box(N * SS))],
  shallow: [wrap(shallowRing(N)), wrapHi(shallowRing(N * SS))],
};

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N * SS}" height="${N * SS}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N}, SS = ${SS};
const rSlug = createRenderer(gl, shaders, {}); rSlug.setLoopBlinnFill('off');
const rLb = createRenderer(gl, shaders, {}); rLb.setLoopBlinnFill('on');
const grab = (w, h) => { const p = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, p);
  const a = new Float64Array(w * h); for (let i = 0; i < w * h; i++) a[i] = p[i * 4]; return a; };
const render = async (r, sec, n) => {
  const b = createBundle(gl, sec);
  if (r !== rSlug && r.prepareBundle) r.prepareBundle(b);
  // prepareBundle is non-blocking by contract: it kicks off the mesh build and the
  // fill-variant link and returns. While that variant is still linking a bundle
  // falls to the best non-LB engine rather than to the classic coverage-RT routes,
  // so measuring the first frame would score another engine's AA as LB's.
  if (r !== rSlug && r.awaitLbReady) await r.awaitLbReady(b);
  r.setViewport(n, n); gl.viewport(0, 0, n, n);
  const c0 = r.debugStats.loopBlinnRouteCount;
  r.beginFrame([1, 1, 1, 1]); r.drawBundle(b); r.endFrame();
  const a = grab(n, n); a.routed = r.debugStats.loopBlinnRouteCount - c0;
  const kinds = {};
  for (const m of (b._lbMeshes || [])) if (m && m.verts)
    for (let i = 0; i < m.vertexCount; i++) {
      const k = Math.floor(m.verts[i * 24 + 5] + 0.001);
      kinds[k] = (kinds[k] || 0) + 1;
    }
  a.kinds = kinds;
  b.dispose(); return a;
};
const down = (hi, n, ss) => {
  const lo = new Float64Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let s = 0; for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) s += hi[(y * ss + j) * (n * ss) + (x * ss + i)];
    lo[y * n + x] = s / (ss * ss);
  }
  return lo;
};
window.__run = async (shapes) => {
  const out = {};
  for (const [name, [lo, hi]] of Object.entries(shapes)) {
    const secLo = await importSvg(lo), secHi = await importSvg(hi);
    const ref = down(await render(rSlug, secHi, N * SS), N, SS);
    const x = await render(rLb, secLo, N);
    let sum = 0, nEdge = 0, nBad = 0;
    for (let i = 0; i < x.length; i++) {
      const r = ref[i]; if (r > 2 && r < 253) { const d = Math.abs(x[i] - r); sum += d; if (d > 25) nBad++; nEdge++; }
    }
    out[name] = { routed: x.routed, kinds: x.kinds, mean: sum / Math.max(1, nEdge), nBad, nEdge };
  }
  return out;
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const o = await pg.evaluate((s) => window.__run(s), SHAPES);
await br.close();
server.close();

let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));
for (const [n, e] of Object.entries(o)) {
  console.log(
    `  ${n}: routed=${e.routed} kinds=${JSON.stringify(e.kinds)} mean=${e.mean.toFixed(3)} bad=${e.nBad}`,
  );
  ok(e.routed > 0, `${n}: LB routed`);
  if (n === 'shallow') {
    ok((e.kinds[12] || 0) > 0, `${n}: emits kind-12 (${e.kinds[12] || 0})`);
  } else {
    ok((e.kinds[10] || 0) > 0, `${n}: emits kind-10 (${e.kinds[10] || 0})`);
  }
  ok((e.kinds[8] || 0) === 0, `${n}: no kind-8 (${e.kinds[8] || 0})`);
  ok(e.nBad <= 8, `${n}: bad px bounded (${e.nBad} <= 8)`);
  ok(e.mean < 2.5, `${n}: mean err (${e.mean.toFixed(3)} < 2.5 /255)`);
}
console.log(fail ? `\nLB-TIP FAIL (${fail})` : '\nLB-TIP PASS');
process.exit(fail ? 1 : 0);
