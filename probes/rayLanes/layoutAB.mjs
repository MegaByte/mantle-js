// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// layoutAB — the ray-lane reject timed against the LEGACY band layout on the same shader, in one page.
//   node probes/rayLanes/layoutAB.mjs --svg a.svg,b.svg [--kernel slug|aac|hard-band] [--size 1024] [--reps 16]
// Arm "legacy" imports with { rayLanes: false }: the encoding without ray lanes, header bit clear, so every walker takes
// no reject and reads the far bound alone. Arm "lanes" is the default. One renderer draws both
// bundles (same program), a discard renderer is created first, and an A/A arm is a second legacy bundle.
// THROTTLED (test/_gpuThrottle.mjs): every timed sample is followed by an idle of at least its own length
// (MANTLE_GPU_DUTY, default 0.5) plus a rest, outside the timed region, and the run is capped at MANTLE_GPU_WALL_MS.
// The fence is polled with a MessageChannel yield (window.__gpuFence), not setTimeout(0), which clamps to 4 ms once
// nested behind the idle's timer. Run it in the FOREGROUND, one GPU job at a time.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../../test/_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from '../../test/_gpuThrottle.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const SVGS = flag('svg')
  .split(',')
  .map((f) => ({ name: path.basename(f), text: readFileSync(f, 'utf8') }));
const N = +flag('size', 1024),
  REPS = +flag('reps', 16),
  DRAWS = +flag('draws', 10),
  KERNEL = flag('kernel', 'slug');
const HTML = `<!DOCTYPE html><html><body><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
async function mkR() { const c = document.createElement('canvas'); c.width = c.height = ${N}; document.body.appendChild(c);
  const gl = c.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
  const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready; R.setViewport(${N}, ${N}); R.setFillEngine({ route: 'none', kernel: '${KERNEL}' }); return { gl, R }; }
window.__run = async (svg) => {
  await mkR();                                             // discard: the first renderer stays slow
  const { gl, R } = await mkR();
  const arms = [['legacy', createBundle(gl, await importSvg(svg, { rayLanes: false }))], ['A/A', createBundle(gl, await importSvg(svg, { rayLanes: false }))], ['lanes', createBundle(gl, await importSvg(svg))]];
  const draw = (b) => { R.beginFrame([1,1,1,1]); R.drawBundle(b); R.endFrame(); };
  const read = () => { const p = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,p); return p; };
  const time = async (b) => { const t0 = performance.now(); for (let i = 0; i < ${DRAWS}; i++) draw(b);
    await window.__gpuFence(gl);   // a MessageChannel poll: after the idle's timer a setTimeout poll clamps to 4 ms
    const ms = performance.now() - t0; await window.__gpuIdle(ms); return ms; };   // THE THROTTLE, after the clock stopped
  for (const [, b] of arms) { for (let i = 0; i < 8; i++) { draw(b); if (R.precompileFills) { try { R.precompileFills(); } catch {} } } await time(b); }
  draw(arms[0][1]); const ref = read(); const px = {};
  for (const [n, b] of arms) { draw(b); const p = read(); let d = 0; for (let i = 0; i < p.length; i++) if (p[i] !== ref[i]) d++; px[n] = d; }
  const t = {}; for (const [n] of arms) t[n] = [];
  for (let r = 0; r < ${REPS}; r++) { const order = (r & 1) ? arms.slice().reverse() : arms; for (const [n, b] of order) t[n].push(await time(b)); }
  const med = (v) => { const s = v.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
  return arms.map(([n]) => ({ n, ms: med(t[n]), px: px[n] }));
};
window.__ready = true;</script></body></html>`;
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
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const cap = capWallTime('layoutAB', async () => {
  await browser.close();
  server.close();
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000 });
await installGpuThrottle(page);
console.log(gpuThrottleBanner());
for (const s of SVGS) {
  const rows = await page.evaluate((t) => window.__run(t), s.text);
  const b = rows[0].ms;
  console.log(
    `${s.name} @${N}, kernel ${KERNEL}: ` +
      rows
        .map((r) => `${r.n} ${r.ms.toFixed(2)} ms (${(r.ms / b).toFixed(3)}x, ${r.px} ch)`)
        .join('   '),
  );
}
cap.clear();
await browser.close();
server.close();
