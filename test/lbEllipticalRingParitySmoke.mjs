// lbEllipticalRingParitySmoke.mjs — a MILDLY elliptical ring (aspect ~1.06, like a
// font 'o'/'O'/'0') must NOT be mistaken for a circle by the annulus SDF. The
// circle fit only sampled the on-curve ENDPOINTS, so a few-percent ellipse passed
// (res/r≈0.02 < the old 0.03 tolerance) and rendered as a MIS-SIZED circle — the
// ring came out too thick, mean boundary error ~0.3 vs Slug (MuseoSans o/O/0 were
// visibly rough). The fit now also checks each segment's t=½ ON-CURVE midpoint and
// tightens to 0.01·r, so the ellipse is rejected → it takes the accurate CDT
// crescent path and matches Slug. (True circles sit at res/r≈0, still SDF-exact —
// guarded by lbCircleSdfSmoke / lbAnnulusSdfSmoke.)
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const R = 64;
// N-quad ellipse; aspect rx/ry ~1.06 → a few-percent ellipse (endpoints near a
// circle, curve bulges off it). control = endpoint-tangent intersection.
function quadEllipse(cx, cy, rx, ry, ccw) {
  const N = 8;
  const pt = (a) => [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  const tn = (a) => [-rx * Math.sin(a), ry * Math.cos(a)];
  let d = '';
  for (let i = 0; i < N; i++) {
    const sg = ccw ? 1 : -1, a0 = sg * 2 * Math.PI * i / N, a1 = sg * 2 * Math.PI * (i + 1) / N;
    const p0 = pt(a0), p1 = pt(a1), t0 = tn(a0).map(v => v * sg), t1 = tn(a1).map(v => v * sg);
    const det = t0[0] * (-t1[1]) - t0[1] * (-t1[0]);
    const s = ((p1[0] - p0[0]) * (-t1[1]) - (p1[1] - p0[1]) * (-t1[0])) / det;
    const ctrl = [p0[0] + s * t0[0], p0[1] + s * t0[1]];
    d += (i === 0 ? `M${p0[0].toFixed(3)} ${p0[1].toFixed(3)} ` : '') + `Q${ctrl[0].toFixed(3)} ${ctrl[1].toFixed(3)} ${p1[0].toFixed(3)} ${p1[1].toFixed(3)} `;
  }
  return d + 'Z';
}
// outer CCW + inner CW → nonzero fills the ring. rx/ry ≈ 1.03 (a few-percent
// ellipse, like a font 'o') — res/r≈0.02 sits between the old 0.03 tolerance
// (false-accept → mis-sized circle, mean≈0.3) and the new 0.01 (rejected → CDT).
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${R} ${R}" width="${R}" height="${R}"><path fill="black" d="${quadEllipse(32, 32, 26, 25.2, true)} ${quadEllipse(32, 32, 17.3, 16.8, false)}"/></svg>`;

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
let worst=0, sum=0, n=0, hole=cov(lb.px, 32, 32);
for (let y=0;y<${R};y++) for (let x=0;x<${R};x++){ const s=cov(slug.px,x,y), l=cov(lb.px,x,y);
  if ((s>0.02&&s<0.98)||(l>0.02&&l<0.98)){ const e=Math.abs(s-l); if(e>worst)worst=e; sum+=e; n++; } }
window.__out = { lbRouted: lb.routed, worst:+worst.toFixed(3), mean:+(sum/Math.max(n,1)).toFixed(4), hole:+hole.toFixed(2) };
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
if (o.lbRouted) ok('elliptical ring routes through LB'); else fail('ring did NOT route to LB');
if (o.hole < 0.05) ok('ring hole stays empty (' + o.hole + ')'); else fail('ring hole filled (' + o.hole + ')');
// The regression discriminator is MEAN: a false circle-fit renders a mis-sized
// circle → the whole boundary is off, mean ≈ 0.3; the correct CDT path is ≈ 0.05.
if (o.mean <= 0.12) ok('elliptical ring matches Slug — not mistaken for a circle (mean ' + o.mean + ')');
else fail('elliptical ring rendered as a mis-sized circle (mean ' + o.mean + ') — annulus false-accept?');

await browser.close();
server.close();
if (failures) { console.error('\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\nlbEllipticalRingParitySmoke: a few-percent-elliptical ring is not mis-rendered as a circle');
