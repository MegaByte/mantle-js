// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _clipXformShape2 — same as _clipXformShape but every doc carries an invisible
// full-viewBox ANCHOR rect so globalBBox (and therefore the renderer's
// bbox-normalizing autofit) is identical across cases. mantle vs the browser's
// own SVG render, pixel counts + ink bbox.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANCHOR = '<rect x="0" y="0" width="100" height="100" fill="#ff0000" fill-opacity="0.004"/>';
const CLIPS = {
  none: null,
  all: 'M -50 -50 L 150 -50 L 150 150 L -50 150 Z',
  top: 'M 0 0 L 100 0 L 100 50 L 0 50 Z',
  bot: 'M 0 50 L 100 50 L 100 100 L 0 100 Z',
};
const LEAVES = {
  // same USER-space geometry, expressed with and without a leaf transform
  fill_noxf: '<path fill="#00ff00" d="M 20 20 L 80 20 L 80 80 L 20 80 Z"/>',
  fill_xf:
    '<path fill="#00ff00" d="M 0 0 L 60 0 L 60 60 L 0 60 Z" transform="matrix(1, 0, 0, -1, 20, 80)"/>',
  stroke_noxf: '<path fill="none" stroke="#00ff00" stroke-width="20" d="M 30 20 L 30 80"/>',
  stroke_xf:
    '<path fill="none" stroke="#00ff00" stroke-width="20" d="M 0 0 L 0 60" transform="matrix(1, 0, 0, -1, 30, 80)"/>',
};
const docs = {};
for (const [cn, cd] of Object.entries(CLIPS))
  for (const [ln, lv] of Object.entries(LEAVES)) {
    const body = cd
      ? `<defs><clipPath id="k"><path clip-rule="nonzero" d="${cd}"/></clipPath></defs>${ANCHOR}<g clip-path="url(#k)">${lv}</g>`
      : ANCHOR + lv;
    docs[cn + '|' + ln] =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
      body +
      '</svg>';
  }
const HTML = `<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cnv=document.getElementById('c');
const gl=cnv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const renderer=createRenderer(gl, await loadShaders(new URL('/src/shaders/', location.href).href));
const src={};
const get=async k=>(src[k]=src[k]||await (await fetch('/__v/'+encodeURIComponent(k))).text());
window.__mantle=async k=>{
  const imp=await importSvg(await get(k));
  const b=createBundle(gl,imp);
  if(renderer.awaitLbReady){try{await renderer.awaitLbReady(b);}catch{}}
  renderer.setViewport(100,100);
  renderer.beginFrame([0,0,0,1]);
  renderer.drawBundle(b,{worldMatrix:new Float32Array([1,0,0,0,1,0,0,0,1])});
  renderer.endFrame();
  const px=new Uint8Array(40000);gl.readPixels(0,0,100,100,gl.RGBA,gl.UNSIGNED_BYTE,px);
  let n=0,y0=1e9,y1=-1;
  for(let y=0;y<100;y++)for(let x=0;x<100;x++){const i=((99-y)*100+x)*4;
    if(px[i+1]>80&&px[i]<80){n++;if(y<y0)y0=y;if(y>y1)y1=y;}}
  return {n,y0:n?y0:-1,y1,gbb:Array.from(imp.globalBBox||[])};
};
window.__native=async k=>{const s=await get(k);return new Promise(res=>{
  const c2=document.createElement('canvas');c2.width=100;c2.height=100;
  const cx=c2.getContext('2d');const img=new Image();
  img.onload=()=>{cx.drawImage(img,0,0,100,100);const d=cx.getImageData(0,0,100,100).data;
    let n=0,y0=1e9,y1=-1;for(let y=0;y<100;y++)for(let x=0;x<100;x++){const i=(y*100+x)*4;
      if(d[i+1]>80&&d[i]<80&&d[i+3]>80){n++;if(y<y0)y0=y;if(y>y1)y1=y;}}
    res({n,y0:n?y0:-1,y1});};
  img.onerror=()=>res(null);
  img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(s);});};
window.__ready=true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  if (req.url.startsWith('/__v/')) {
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    res.end(docs[decodeURIComponent(req.url.slice(5))] || '');
    return;
  }
  const p = decodeURIComponent(req.url.split('?')[0]);
  try {
    res.writeHead(200, {
      'content-type': (p.endsWith('.glsl') ? 'text/plain' : 'text/javascript') + '; charset=utf-8',
    });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await launchBrowser({
  headless: 'new',
  args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 120000 });
console.log('case'.padEnd(18) + 'mantle'.padStart(18) + 'native'.padStart(18) + '  verdict');
for (const k of Object.keys(docs)) {
  const m = await page.evaluate((kk) => window.__mantle(kk), k);
  const n = await page.evaluate((kk) => window.__native(kk), k);
  const f = (r) => (r ? `${r.n} (${r.y0}..${r.y1})` : 'null');
  const bad = n && Math.abs(m.n - n.n) > Math.max(50, n.n * 0.15);
  console.log(
    k.padEnd(18) + f(m).padStart(18) + f(n).padStart(18) + (bad ? '   <== MISMATCH' : ''),
  );
}
await browser.close();
server.close();
