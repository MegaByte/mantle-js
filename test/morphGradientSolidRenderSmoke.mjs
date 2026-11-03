// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphGradientSolidRenderSmoke -- a gradient morphing to a solid color, and back, lands on each pose.
//
// A gradient row paints stops * row color with its color white, so a morph that keeps the source's paint binding draws a gradient to #123 as the gradient * #123 at t = 1, near black;
// a solid to a gradient as white at t = 1; and two gradients that cannot lerp (a linear and a radial, or two stop counts) as the source's throughout. The reference is Chrome drawing each pose at 8x, box-averaged, on the CPU and the GPU lerp, for a fill and a stroke; a pixel off by more than 48/255 fails.
import { readFileSync, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 128,
  S = 8,
  BAR = 48;
const LG = (id, a, b) =>
  `<linearGradient id="${id}"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;
const doc = (defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${defs}</defs>${body}</svg>`;
const fill = (p) => `<rect id="a" x="20" y="20" width="60" height="60" fill="${p}"/>`;
// (on the pixel grid at this size: a stroke's corner pixel at a fractional position reads 57/255 from the reference even static, and is not what this asks)
const stroke = (p) =>
  `<rect id="a" x="25" y="25" width="50" height="50" fill="none" stroke="${p}" stroke-width="12.5"/>`;
const RG = (id, a, b) =>
  `<radialGradient id="${id}"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></radialGradient>`;
const G = LG('s', '#f00', '#ff0');
const CASES = [
  ['a gradient fill to a solid', doc(G, fill('url(#s)')), doc('', fill('#123'))],
  ['a solid fill to a gradient', doc('', fill('#123')), doc(G, fill('url(#s)'))],
  ['a gradient stroke to a solid', doc(G, stroke('url(#s)')), doc('', stroke('#123'))],
  ['a solid stroke to a gradient', doc('', stroke('#123')), doc(G, stroke('url(#s)'))],
  [
    'a translucent gradient to a solid',
    doc(LG('s', '#f00', 'rgba(255,255,0,.5)'), fill('url(#s)')),
    doc('', fill('#123')),
  ],
  [
    'a linear gradient to a radial one',
    doc(G, fill('url(#s)')),
    doc(RG('s', '#00f', '#0ff'), fill('url(#s)')),
  ],
  [
    'a two-stop gradient to a three-stop one',
    doc(G, fill('url(#s)')),
    doc(
      '<linearGradient id="s"><stop offset="0" stop-color="#00f"/><stop offset=".5" stop-color="#fff"/><stop offset="1" stop-color="#0f0"/></linearGradient>',
      fill('url(#s)'),
    ),
  ],
  [
    '(control) a gradient to a gradient',
    doc(G, fill('url(#s)')),
    doc(LG('s', '#00f', '#0f0'), fill('url(#s)')),
  ],
  ['(control) a solid to a solid', doc('', fill('#123')), doc('', fill('#f80'))],
];
const HTML = `<!doctype html><canvas id="c" width="${N}" height="${N}"></canvas><script type="module">
import {importSvg,createBundle,createRenderer,loadShaders,createShapeMorph,createNativeScene,createNativeMorph} from '/src/index.js';
const gl=c.getContext('webgl2',{depth:true,antialias:false,preserveDrawingBuffer:true});
const R=createRenderer(gl,await loadShaders(new URL('/src/shaders/',location.href)));R.setViewport(${N},${N});
const read=()=>{const px=new Uint8Array(${N}*${N}*4);gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px);const o=new Array(${N}*${N}*3);for(let y=0;y<${N};y++)for(let x=0;x<${N};x++)for(let k=0;k<3;k++)o[(y*${N}+x)*3+k]=px[((${N}-1-y)*${N}+x)*4+k];return o;};
window.raster=async(svg)=>{const img=new Image();img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);await img.decode();
 const cv=document.createElement('canvas');cv.width=cv.height=${N * S};const cx=cv.getContext('2d',{willReadFrequently:true});cx.fillStyle='#fff';cx.fillRect(0,0,${N * S},${N * S});cx.drawImage(img,0,0,${N * S},${N * S});
 const d=cx.getImageData(0,0,${N * S},${N * S}).data,o=new Array(${N}*${N}*3);for(let y=0;y<${N};y++)for(let x=0;x<${N};x++)for(let k=0;k<3;k++){let s=0;for(let j=0;j<${S};j++)for(let i=0;i<${S};i++)s+=d[((y*${S}+j)*${N * S}+x*${S}+i)*4+k];o[(y*${N}+x)*3+k]=Math.round(s/${S * S});}return o;};
window.arm=async(cpu,sa,sb)=>{const A=createBundle(gl,await importSvg(sa,{preserveViewport:true})),B=createBundle(gl,await importSvg(sb,{preserveViewport:true}));
 const m=createShapeMorph(gl,A,B,{cpuLerp:cpu});if(!cpu)m.bundle._morphSrc.gpuSmallPlanes=true;const out=[];
 for(const t of [0,0.5,1]){m.setT(t);let prev=null,cur=null;for(let f=0;f<60;f++){R.beginFrame([1,1,1,1]);R.drawBundle(m);R.endFrame();await new Promise(ok=>setTimeout(ok,10));cur=read();if(prev&&f>=3&&prev.every((v,i)=>v===cur[i]))break;prev=cur;}out.push(cur);}
 const err=gl.getError();m.dispose();return {frames:out,err};};
window.native=async(sa,sb)=>{const A=await importSvg(sa,{preserveViewport:true,retainSource:true}),B=await importSvg(sb,{preserveViewport:true,retainSource:true});
 const h=document.createElement('div');document.body.appendChild(h);const sc=createNativeScene(h);sc.setViewport(${N},${N});const m=createNativeMorph(A,B),out=[];
 for(const t of [0,1]){m.setT(t);for(let i=0;i<2;i++){sc.beginFrame([1,1,1,1]);sc.drawBundle(m.bundle,{overrides:m.overrides});sc.endFrame();}
  const s=sc.svg.cloneNode(true);s.setAttribute('width',${N * S});s.setAttribute('height',${N * S});out.push(await window.raster(new XMLSerializer().serializeToString(s)));}
 m.dispose&&m.dispose();h.remove();return out;};
window.__ready=true;</script>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://local').pathname;
  if (u === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(HTML);
    return;
  }
  const f = path.resolve(ROOT, '.' + decodeURIComponent(u));
  if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader('Content-Type', f.endsWith('.js') ? 'text/javascript' : 'text/plain');
  res.end(readFileSync(f));
});
let browser,
  failures = 0,
  cells = 0;
const off = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 3)
    if (
      Math.max(
        Math.abs(a[i] - b[i]),
        Math.abs(a[i + 1] - b[i + 1]),
        Math.abs(a[i + 2] - b[i + 2]),
      ) > BAR
    )
      n++;
  return n;
};
try {
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    console.error(e.message);
    failures++;
  });
  await openReady(page, 'http://127.0.0.1:' + server.address().port + '/');
  const raster = (svg) => page.evaluate((s) => window.raster(s), svg);
  for (const [name, a, b] of CASES) {
    const ra = await raster(a),
      rb = await raster(b);
    for (const cpu of [true, false]) {
      const { frames, err } = await page.evaluate((c, x, y) => window.arm(c, x, y), cpu, a, b);
      const n0 = off(frames[0], ra),
        n1 = off(frames[2], rb),
        good = n0 === 0 && n1 === 0 && err === 0;
      // Between the poses a paint pair has no spec reading; it has to be a picture, not a hole: the shape stays inked.
      let ink = 0;
      for (let i = 0; i < frames[1].length; i += 3)
        if (frames[1][i] + frames[1][i + 1] + frames[1][i + 2] < 750) ink++;
      const inked = ink > 0;
      cells++;
      console.log(
        `  ${good && inked ? 'ok' : 'FAIL'} ${name}, ${cpu ? 'cpu' : 'gpu'}: t = 0 ${n0} px, t = 1 ${n1} px off by more than ${BAR}/255; t = .5 ink ${ink}; GL error ${err}`,
      );
      if (!good || !inked) failures++;
    }
    // The native morph, the pairs of a gradient and a solid: a gradient element of its own carries the color across. (A pair of two gradient kinds keeps its authored paint there.)
    if (/solid/.test(name) && !/control/.test(name)) {
      const [n0, n1] = await page.evaluate((x, y) => window.native(x, y), a, b),
        c0 = off(n0, ra),
        c1 = off(n1, rb);
      cells++;
      console.log(
        `  ${c0 === 0 && c1 === 0 ? 'ok' : 'FAIL'} ${name}, native: t = 0 ${c0} px, t = 1 ${c1} px off by more than ${BAR}/255`,
      );
      if (c0 || c1) failures++;
    }
  }
} finally {
  await browser?.close();
  await new Promise((ok) => server.close(ok));
}
if (failures) {
  console.error(`morphGradientSolidRenderSmoke: ${failures} failed of ${cells}`);
  process.exit(1);
}
console.log(`morphGradientSolidRenderSmoke PASS: ${cells} cells`);
process.exit(0);
