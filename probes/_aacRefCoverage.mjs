// _aacRefCoverage — for WHICH content does aacFill:true actually change the
// pixels? Before retargeting the smokes' reference from Slug to AAC, establish
// where AAC is genuinely a different (more accurate) engine and where it is
// byte-identical to Slug — because a reference that silently equals Slug would
// make the retarget vacuous, not stricter.
//
//   node probes/_aacRefCoverage.mjs
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 128;

const CASES = {
  poly:     '<polygon points="14,14 110,30 96,110 30,96" fill="#000"/>',
  quad:     '<path d="M14 96 Q64 4 114 96 Z" fill="#000"/>',
  cubic:    '<path d="M14 96 C34 8 94 8 114 96 Z" fill="#000"/>',
  arc:      '<path d="M20 64 A44 44 0 1 1 108 64 A44 44 0 1 1 20 64 Z" fill="#000"/>',
  circle:   '<circle cx="64" cy="64" r="46" fill="#000"/>',
  hole:     '<path d="M10 10 H118 V118 H10 Z M40 40 H88 V88 H40 Z" fill="#000" fill-rule="evenodd"/>',
  thin:     '<path d="M12 60 L116 62 L116 68 L12 66 Z" fill="#000"/>',
  gradient: '<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#888"/></linearGradient></defs><circle cx="64" cy="64" r="46" fill="url(#g)"/>',
  stroke:   '<path d="M20 100 Q64 10 108 100" fill="none" stroke="#000" stroke-width="9"/>',
};

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true, depth:true, stencil:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const CASES = ${JSON.stringify(CASES)};
const mk = (o) => { const r = createRenderer(gl, shaders, o); r.setViewport(${N}, ${N}); r.setLoopBlinnFill('off'); return r; };
const rSlug = mk({}), rAac = mk({ aacFill: true });
const read = () => { const p = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,p); return p; };
const draw = (r,b) => { r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); return read(); };
const out = [];
for (const k in CASES) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">' + CASES[k] + '</svg>';
  const b = createBundle(gl, await importSvg(svg));
  rSlug.prepareBundle(b);
  const s = draw(rSlug, b), a = draw(rAac, b);
  let diff = 0, mx = 0, ink = 0, inkA = 0;
  for (let i = 0; i < s.length; i += 4) {
    if (s[i] < 250) ink++;
    if (a[i] < 250) inkA++;
    const d = Math.abs(s[i] - a[i]);
    if (d > 0) diff++;
    if (d > mx) mx = d;
  }
  // INDEPENDENT adjudicator: the browser's own Canvas2D path fill, 4x
  // supersampled. Neither Slug nor AAC is trusted to referee the other.
  const SS = 4, cv = document.createElement('canvas'); cv.width = cv.height = ${N} * SS;
  const cx2 = cv.getContext('2d'); cx2.scale(SS, SS);
  cx2.fillStyle = '#000';
  const dPath = /d="([^"]+)"/.exec(CASES[k]), pts = /points="([^"]+)"/.exec(CASES[k]);
  let inkR = -1;
  if (dPath && !/stroke=/.test(CASES[k])) {
    const pth = new Path2D(dPath[1]);
    cx2.fill(pth, /evenodd/.test(CASES[k]) ? 'evenodd' : 'nonzero');
    const id = cx2.getImageData(0, 0, cv.width, cv.height).data;
    let acc = 0;
    for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) {
      let cov = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++)
        cov += id[(((y*SS+sy)*cv.width) + (x*SS+sx))*4 + 3] / 255;
      if (cov / (SS*SS) > 0.02) acc++;
    }
    inkR = acc;
  }
  void pts;
  out.push({ k, diff, mx, ink, inkA, inkR });
  b.dispose();
}
window.__out = out; window.__ready = true;
</${'script'}></body></html>`;

const server = http.createServer((q, res) => {
  const f = q.url.split('?')[0];
  if (f === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(HTML); return; }
  try {
    const body = readFileSync(path.join(ROOT, f));
    const ext = path.extname(f);
    res.writeHead(200, { 'Content-Type': ext === '.js' || ext === '.mjs' ? 'text/javascript' : ext === '.glsl' ? 'text/plain' : 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(0, r));
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const pg = await browser.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle0' });
await pg.waitForFunction('window.__ready === true', { timeout: 120000, polling: 50 });
const o = await pg.evaluate(() => window.__out);
await browser.close(); server.close();
console.log('\n  does aacFill:true differ from Slug?  (diff = px where they disagree)\n');
console.log('   case      slugInk   aacInk   REF(2d)   diffPx  maxDiff');
for (const r of o)
  console.log(`   ${r.k.padEnd(9)} ${String(r.ink).padStart(7)} ${String(r.inkA).padStart(8)} ${String(r.inkR).padStart(8)} ${String(r.diff).padStart(8)} ${String(r.mx).padStart(8)}`
    + (r.diff === 0 ? '   IDENTICAL' : Math.abs(r.ink - r.inkA) > r.ink * 0.05 ? '   *** INK MISMATCH ***' : ''));
