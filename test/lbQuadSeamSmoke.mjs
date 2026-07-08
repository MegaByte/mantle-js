// lbQuadSeamSmoke.mjs — a SMOOTH all-quadratic ellipse (rx≠ry → real kind-1 quad
// crescents, NOT the circular SDF) rendered at small scale. The PRIMARY contract:
// LB must not OVER-cover the curve (the fragment's curvature-aware coverage lands
// the ½-level exactly on the arc, not on its over-reaching tangent line — the fix
// for the user-visible "overcoverage on curves"). The earlier VS radial dilation
// closed the additive-MAX seam notch but over-covered systematically; it's gone.
// A sub-pixel seam notch (under-coverage where adjacent crescents pinch) remains
// and is bounded here — far less objectionable than the over-coverage it replaced.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// N quadratic segments approximating an ELLIPSE, control = tangent intersection.
function quadEllipse(cx, cy, rx, ry) {
  const N = 8;
  const pt = (a) => [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  const tan = (a) => [-rx * Math.sin(a), ry * Math.cos(a)];
  let d = '';
  for (let i = 0; i < N; i++) {
    const a0 = 2 * Math.PI * i / N, a1 = 2 * Math.PI * (i + 1) / N;
    const p0 = pt(a0), p1 = pt(a1), t0 = tan(a0), t1 = tan(a1);
    const det = t0[0] * (-t1[1]) - t0[1] * (-t1[0]);
    const s = ((p1[0] - p0[0]) * (-t1[1]) - (p1[1] - p0[1]) * (-t1[0])) / det;
    const ctrl = [p0[0] + s * t0[0], p0[1] + s * t0[1]];
    d += (i === 0 ? `M${p0[0].toFixed(3)} ${p0[1].toFixed(3)} ` : '') +
         `Q${ctrl[0].toFixed(3)} ${ctrl[1].toFixed(3)} ${p1[0].toFixed(3)} ${p1[1].toFixed(3)} `;
  }
  return d + 'Z';
}
const R = 40;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40"><path fill="#000" d="${quadEllipse(20, 20, 17, 11)}"/></svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${R}" height="${R}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(${R}, ${R});
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle);
const read = () => { const px = new Uint8Array(${R}*${R}*4); gl.readPixels(0,0,${R},${R},gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const cov = (px,x,y) => { const q = ((${R}-1-y)*${R}+x)*4; return (255-px[q])/255; };
const draw = (m) => { renderer.setLoopBlinnFill(m); const r = renderer.debugStats.loopBlinnRouteCount;
  renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle); renderer.endFrame();
  return { px: read(), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
const slug = draw('off'), lb = draw('on');
let sum=0, sgn=0, n=0, maxOver=0, maxUnder=0, notch=0;
for (let y=0;y<${R};y++) for (let x=0;x<${R};x++){ const s=cov(slug.px,x,y), l=cov(lb.px,x,y);
  if ((s>0.02&&s<0.98)||(l>0.02&&l<0.98)){ const d=l-s; sum+=Math.abs(d); sgn+=d; n++;
    if (d>maxOver) maxOver=d; if (-d>maxUnder) maxUnder=-d;
    if (s>0.1 && l<0.02) notch=Math.max(notch, s); } }   // undercount notch: Slug partial, LB ~0
window.__out = { lbRouted: lb.routed, bias:+(sgn/Math.max(n,1)).toFixed(4), maxOver:+maxOver.toFixed(3), maxUnder:+maxUnder.toFixed(3),
  mean:+(sum/Math.max(n,1)).toFixed(4), notch:+notch.toFixed(3) };
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' }); res.end(readFileSync(path.join(ROOT, p)));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('  [console]', m.text()); });
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
} catch (e) { fail('setup: ' + e.message); await browser.close(); server.close(); process.exit(1); }

const o = await page.evaluate(() => window.__out);
console.log('  ', JSON.stringify(o));
if (o.lbRouted) ok('quad ellipse routes through LB'); else fail('ellipse did NOT route to LB');
// PRIMARY: no SYSTEMATIC over-coverage. The signed mean over the AA band (bias) must
// be ≈0 — the tangent-line model biased it strongly positive (the "overcoverage on
// curves" the user hit). Individual seam pixels may still swing ± (isolated pinches),
// so the guard is on the bias, not per-pixel maxima.
if (o.bias <= 0.02) ok('no systematic curve over-coverage (band bias = ' + o.bias + ')');
else fail('LB systematically OVER-covers the quad arc (band bias ' + o.bias + ') — tangent-line coverage regressed?');
if (o.mean <= 0.03) ok('mean boundary error ' + o.mean); else fail('mean boundary error too high (' + o.mean + ')');
// Residual seam notch (under-coverage at crescent pinch) must stay sub-pixel-bounded.
if (o.maxUnder <= 0.25) ok('seam notch bounded (max under-coverage ' + o.maxUnder + ')');
else fail('seam notch too deep (max under-coverage ' + o.maxUnder + ') — crescents pinching badly?');

await browser.close();
server.close();
if (failures) { console.error('\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\nlbQuadSeamSmoke: curvature-aware coverage — no over-coverage, seam notch bounded');
