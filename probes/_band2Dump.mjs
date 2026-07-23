// _band2Dump — render one probe shape viaSlug / LB and write PNGs.
import { readFileSync, writeFileSync } from 'fs';
import http from 'http'; import path from 'path'; import { fileURLToPath } from 'url'; import puppeteer from 'puppeteer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 192;
const which = process.argv[2] || 'box';
const wrap = (d, n) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}"><path fill="#000000" d="${d}"/></svg>`;
function quadLineBox(n) { const a = 0.18 * n, b = 0.82 * n, bulge = 0.14 * n, m = n / 2;
  return `M ${a} ${a} Q ${m} ${a - bulge} ${b} ${a} L ${b} ${b} Q ${m} ${b + bulge} ${a} ${b} Z`; }
function quadRing(n) { const c = n / 2, r = n * 0.36, K = 8;
  const P = (i) => { const a = (i / K) * 2 * Math.PI; return [c + r * Math.cos(a), c + r * Math.sin(a)]; };
  let d = `M ${P(0)[0].toFixed(4)} ${P(0)[1].toFixed(4)} `;
  for (let i = 0; i < K; i++) { const A = P(i), B = P(i + 1);
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.35, my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.35;
    d += `Q ${mx.toFixed(4)} ${my.toFixed(4)} ${B[0].toFixed(4)} ${B[1].toFixed(4)} `; }
  return d + 'Z'; }
function quadStar(n) { const c = n / 2, R = n * 0.42, r = n * 0.19, K = 5; let pts = [];
  for (let i = 0; i < 2 * K; i++) { const a = -Math.PI / 2 + i * Math.PI / K, rad = (i % 2 ? r : R);
    pts.push([c + rad * Math.cos(a), c + rad * Math.sin(a)]); }
  let d = `M ${pts[0][0].toFixed(4)} ${pts[0][1].toFixed(4)} `;
  for (let i = 0; i < 2 * K; i++) { const A = pts[i], B = pts[(i + 1) % (2 * K)];
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.12, my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.12;
    d += `Q ${mx.toFixed(4)} ${my.toFixed(4)} ${B[0].toFixed(4)} ${B[1].toFixed(4)} `; }
  return d + 'Z'; }
const SH = { box: quadLineBox, ring: quadRing, star: quadStar };
const svg = wrap(SH[which](N), N);
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
window.__run = async (svgTxt, lbMode) => {
  const r=createRenderer(gl,shaders,{}); r.setLoopBlinnFill(lbMode);
  const sec=await importSvg(svgTxt,{preserveViewport:true});
  const b=createBundle(gl,sec);
  r.prepareBundle && r.prepareBundle(b);
  r.setViewport(${N},${N}); gl.viewport(0,0,${N},${N});
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const p=new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,p);
  b.dispose();
  return Array.from(p);
};
window.__ready=true;</script></body></html>`;
const server = http.createServer((q, res) => { try { if (q.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; } const pp = decodeURIComponent(q.url.split('?')[0]); res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' }); res.end(readFileSync(path.join(ROOT, pp))); } catch { if (!res.headersSent) res.writeHead(404); res.end(); } });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const shot = async (lbMode) => {
  const pg = await br.newPage(); pg.on('pageerror', e => console.error(' [err]', e.message));
  await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
  await pg.waitForFunction(() => window.__ready === true, { timeout: 120000 });
  const px = await pg.evaluate((s, m) => window.__run(s, m), svg, lbMode);
  await pg.close();
  return Uint8Array.from(px);
};
// tiny PNG writer (grayscale from R channel), no deps
import zlib from 'zlib';
const png = (pix, w, h) => {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) { const i = ((h - 1 - y) * w + x) * 4;
      raw[y * (w * 3 + 1) + 1 + x * 3] = pix[i]; raw[y * (w * 3 + 1) + 2 + x * 3] = pix[i + 1]; raw[y * (w * 3 + 1) + 3 + x * 3] = pix[i + 2]; } }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]); const crcT = Buffer.alloc(4);
    crcT.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) : crc32(td)); return Buffer.concat([len, td, crcT]); };
  function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const outDir = process.env.DUMP_DIR || '/tmp';
const slug = await shot('off');
const lb = await shot('on');
writeFileSync(path.join(outDir, `band2_${which}_slug.png`), png(slug, N, N));
writeFileSync(path.join(outDir, `band2_${which}_lb.png`), png(lb, N, N));
await br.close(); server.close();
console.log('wrote', path.join(outDir, `band2_${which}_{slug,lb}.png`));
