// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _circleArcLenAB — the closed-form circular arc length against the GL-16 rule, in one page.
//   node probes/_circleArcLenAB.mjs
// Two renderers (plus an A/A copy): one compiled from the package shader text, one with the circle
// branch removed from arcArcLen. 400 dashed circles at 1024 px, fence-timed, ABBA.
// THROTTLED (test/_gpuThrottle.mjs): every timed sample is followed by an idle of at least its own length
// (MANTLE_GPU_DUTY, default 0.5) plus a rest, outside the timed region, and the run is capped at MANTLE_GPU_WALL_MS.
// The fence is polled with a MessageChannel yield (window.__gpuFence), not setTimeout(0), which clamps to 4 ms once
// nested behind the idle's timer. Run it in the FOREGROUND, one GPU job at a time.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
import { gpuThrottlePageSource, capWallTime, gpuThrottleBanner } from '../test/_gpuThrottle.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 1024,
  REPS = Number(process.env.REPS || 16),
  DRAWS = Number(process.env.DRAWS || 10);
let body = '';
for (let i = 0; i < 400; i++) {
  const x = 30 + (i % 20) * 50,
    y = 30 + Math.floor(i / 20) * 50;
  body += `<circle cx="${x}" cy="${y}" r="${18 + (i % 5)}" fill="none" stroke="#000" stroke-width="3" stroke-dasharray="4 3"/>`;
}
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">${body}</svg>`;
const HTML = `<!DOCTYPE html><html><body><canvas id="a" width="${N}" height="${N}"></canvas><canvas id="b" width="${N}" height="${N}"></canvas><canvas id="c" width="${N}" height="${N}"></canvas><canvas id="d" width="${N}" height="${N}"></canvas>
<script>${gpuThrottlePageSource()}</script>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const base = await loadShaders(new URL('/src/shaders/', location.href).href);
const LINE = 'if (d1.z == d1.w) return t * abs(dth) * abs(d1.z);';
const noCircle = {}; let hits = 0;
for (const k of Object.keys(base)) { const v = base[k]; noCircle[k] = (typeof v === 'string' && v.includes(LINE)) ? (hits++, v.split(LINE).join('')) : v; }
async function side(id, sh) {
  const gl = document.getElementById(id).getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  const R = createRenderer(gl, sh, {}); if (R.ready) await R.ready; R.setViewport(${N}, ${N});
  const b = createBundle(gl, await importSvg(${JSON.stringify(SVG)}, { preserveViewport: true }));
  const draw = () => { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); };
  const time = async () => { const t0 = performance.now(); for (let i = 0; i < ${DRAWS}; i++) draw();
    await window.__gpuFence(gl);   // a MessageChannel poll: after the idle's timer a setTimeout poll clamps to 4 ms
    const ms = performance.now() - t0; await window.__gpuIdle(ms); return ms; };   // THE THROTTLE, after the clock stopped
  const read = () => { const p = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, p); return p; };
  for (let i = 0; i < 6; i++) draw(); await time();
  return { draw, time, read };
}
// A DISCARD renderer first: a page's first renderer stays slow for life (cold-arm trap), and an
// A/A arm that reads 0.61x is what that looked like on the first run.
await side('d', base);
const A = await side('a', base), B = await side('b', noCircle), A2 = await side('c', base);
A.draw(); B.draw(); const pa = A.read(), pb = B.read(); let diff = 0, ink = 0; for (let i = 0; i < pa.length; i += 4) { if (pa[i] !== pb[i]) diff++; if (pa[i] < 128) ink++; }
const t = { closed: [], gl16: [], aa: [] };
for (let r = 0; r < ${REPS}; r++) { const o = (r & 1) ? [['gl16', B], ['closed', A], ['aa', A2]] : [['closed', A], ['aa', A2], ['gl16', B]]; for (const [k, x] of o) t[k].push(await x.time()); }
const med = (v) => { const s = v.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
window.__out = { hits, diff, ink, closed: med(t.closed), gl16: med(t.gl16), aa: med(t.aa) }; window.__ready = true;
</script></body></html>`;
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
const cap = capWallTime('_circleArcLenAB', async () => {
  await browser.close();
  server.close();
});
console.log(gpuThrottleBanner());
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 200 });
const o = await page.evaluate(() => window.__out);
console.log(
  `shader texts with the circle branch removed: ${o.hits}; pixels differing: ${o.diff} of ${o.ink} ink px`,
);
console.log(
  `median ms per ${DRAWS} draws: closed-form ${o.closed.toFixed(2)}  GL-16 ${o.gl16.toFixed(2)}  A/A ${o.aa.toFixed(2)}  -> GL-16/closed ${(o.gl16 / o.closed).toFixed(3)}x, A/A ${(o.aa / o.closed).toFixed(3)}x`,
);
cap.clear();
await browser.close();
server.close();
