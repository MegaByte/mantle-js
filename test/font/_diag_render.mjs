// Quick one-shot render: take a string, drop a PNG. Used to capture
// before/after diffs for things like kerning.
import { readFileSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import puppeteer from 'puppeteer';
import { decodeIfWoff2 } from '../../src/font/fontAsset.js';
const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '../..');

const markup = process.argv[2] || 'AVATar Wave';
const outPath = process.argv[3] || 'font/test/visuals/_diag/sample.png';
const fontPath = process.argv[4] || '/System/Library/Fonts/Supplemental/Arial.ttf';

// Headless Chromium (--enable-unsafe-swiftshader) lacks DecompressionStream
// 'br' support, so pre-decode woff2 here in Node where it works.
let fontBytes = new Uint8Array(readFileSync(fontPath));
fontBytes = await decodeIfWoff2(fontBytes);

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname === '/' ? '/mantleDemo.html' : u.pathname;
  try { res.writeHead(200, { 'content-type': mime(p) }); res.end(readFileSync(path.join(ROOT, p))); }
  catch (e) { try { res.writeHead(404); res.end(); } catch {} }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 200, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:${port}/mantleDemo.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.mantleTextReady === true, { timeout: 5000 });

const ttf = Array.from(fontBytes);
const ret = await page.evaluate(
  async (ttf, m) => await window.mantleRenderText(new Uint8Array(ttf), m, { defaultColor: [0,0,0,1] }),
  ttf, markup);
console.log('render:', ret);

const b64 = await page.evaluate(() => {
  const f = window.__mantleLastFrame;
  const w = f.w, h = f.h;
  const cnv = document.createElement('canvas');
  cnv.width = w; cnv.height = h;
  const ctx = cnv.getContext('2d');
  const id = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const so = (srcY * w + x) * 4, o = (y * w + x) * 4;
      const r = f.data[so], g = f.data[so+1], b = f.data[so+2], a = f.data[so+3];
      id.data[o] = Math.min(255, r + (255 - a));
      id.data[o+1] = Math.min(255, g + (255 - a));
      id.data[o+2] = Math.min(255, b + (255 - a));
      id.data[o+3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);
  return cnv.toDataURL('image/png').split(',')[1];
});
writeFileSync(outPath, Buffer.from(b64, 'base64'));
console.log('wrote', outPath);

await browser.close();
server.close();
