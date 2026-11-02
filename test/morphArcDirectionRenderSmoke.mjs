// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Physical-GPU validation of opt-in arc direction matching, including translucent dashed strokes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './_launch.mjs';
const ROOT =
  process.env.MANTLE_DIRECTION_TREE ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = `<canvas id="c" width="128" height="128"></canvas><script type="module">
import {importSvg,createBundle,createRenderer,loadShaders,createShapeMorph} from '/src/index.js';
const gl=c.getContext('webgl2',{depth:true,antialias:false,preserveDrawingBuffer:true});
const ext=gl.getExtension('WEBGL_debug_renderer_info');
const backend=ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
const r=createRenderer(gl,await loadShaders(new URL('/src/shaders/',location.href)));
r.setFillEngine({route:'none',kernel:'aac',primitives:'off'});r.setViewport(128,128);
window.run=async cfg=>{
 const {ellipse,dash,reverse,cpuLerp,align}=cfg,rx=ellipse?36:30,ry=ellipse?22:30,phi=ellipse?30:0;
 const st='id="s" fill="#3677ab" fill-opacity=".55" stroke="#dc3853" stroke-opacity=".45" stroke-width="2"'+(dash?' stroke-dasharray="5 3"':'');
 const tf=ellipse?' transform="rotate(30 50 50)"':'';
 const svg=s=>'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'+s+'</svg>';
 const e=.0002,p=t=>(50+rx*Math.cos(t))+' '+(50+ry*Math.sin(t));
 const full=svg('<ellipse '+st+' cx="50" cy="50" rx="'+rx+'" ry="'+ry+'"'+tf+'/>');
 const arc=svg('<path '+st+' d="M'+p(Math.PI+e)+' A'+rx+' '+ry+' 0 1 0 '+p(-Math.PI+3*e)+'"'+tf+'/>');
 const A=createBundle(gl,await importSvg(reverse?arc:full,{preserveViewport:true}));
 const B=createBundle(gl,await importSvg(reverse?full:arc,{preserveViewport:true}));
 const m=createShapeMorph(gl,A,B,{cpuLerp,alignFullTurnDirection:align});
 const ms=m._morphSrc||m.bundle._morphSrc;
 if(!cpuLerp)ms.gpuSmallPlanes=true; // Force the existing GPU path for this small test plane.
 let off=-1;for(let i=4;i+20<=ms.mergedCurveF32.length;i+=4)if((ms.mergedCurveF32[i]&3)===3&&ms.mergedCurveF32[i+6]>0){off=i;break;}
 const da=ms.mergedCurveF32[off+9]-ms.mergedCurveF32[off+8],db=ms.dstCurveF32[off+9]-ms.dstCurveF32[off+8];
 const ts=align?[0,.25,.5,.75,1]:[da/(da-db)];
 const out=[];
 for(const t of ts){
  m.setT(t);
  for(let i=0;i<5;i++){r.beginFrame([0,0,0,0]);r.drawBundle(m);r.endFrame();await new Promise(ok=>setTimeout(ok,20));}
  const px=new Uint8Array(128*128*4);gl.readPixels(0,0,128,128,gl.RGBA,gl.UNSIGNED_BYTE,px);
  let inside=0,bad=0,ink=0;const cp=Math.cos(phi*Math.PI/180),sp=Math.sin(phi*Math.PI/180);
  for(let y=0;y<128;y++)for(let x=0;x<128;x++){
   const at=((127-y)*128+x)*4,alpha=px[at+3];ink+=alpha/255;
   const dx=(x+.5)*100/128-50,dy=(y+.5)*100/128-50;
   if(Math.hypot((cp*dx+sp*dy)/rx,(-sp*dx+cp*dy)/ry)<.8){inside++;if(Math.abs(alpha-140)>1)bad++;}
  }
  let bytes='';for(let i=0;i<px.length;i+=4096)bytes+=String.fromCharCode(...px.subarray(i,i+4096));
  out.push({t,inside,bad,ink,glError:gl.getError(),rgba:btoa(bytes)});
 }
 const result={backend,usesGpuCurveLerp:m.usesGpuCurveLerp,engines:r.debugStats.engines.draws,out};
 m.dispose();A.dispose?.();B.dispose?.();return result;
};window.ready=true;</script>`;
const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://local').pathname;
    if (u === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(HTML);
      return;
    }
    const f = path.resolve(ROOT, '.' + decodeURIComponent(u));
    if (!f.startsWith(ROOT + path.sep)) throw Error('path');
    res.setHeader('Content-Type', u.endsWith('.glsl') ? 'text/plain' : 'text/javascript');
    res.end(readFileSync(f));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
let browser;
try {
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(e.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction('window.ready', { timeout: 60000, polling: 100 });
  const cases = [],
    gpuFrames = new Map();
  for (const ellipse of [false, true])
    for (const dash of [false, true])
      for (const reverse of [false, true])
        for (const cpuLerp of [false, true])
          cases.push({ ellipse, dash, reverse, cpuLerp, align: true });
  for (const cfg of process.env.MANTLE_DIRECTION_FIRST_ONLY ? cases.slice(0, 1) : cases) {
    const { ellipse, dash, reverse, cpuLerp } = cfg;
    const data = await page.evaluate((c) => window.run(c), cfg);
    assert(
      /Apple.*Metal|Metal.*Apple/.test(data.backend) && !/software|swiftshader/i.test(data.backend),
    );
    assert(data.engines.aac > 0, 'actual AAC draws');
    assert.equal(data.usesGpuCurveLerp, !cpuLerp, 'both interpolation backends execute');
    for (const frame of data.out) {
      assert.equal(frame.glError, 0);
      assert(frame.inside > 500);
      assert.equal(frame.bad, 0, 'translucent filled interior stays painted');
    }
    const pairKey = JSON.stringify({ ellipse, dash, reverse });
    const frames = data.out.map((f) => Buffer.from(f.rgba, 'base64'));
    if (cpuLerp) {
      const gpu = gpuFrames.get(pairKey);
      assert(gpu, 'GPU arm ran before its CPU pair');
      let maxByte = 0;
      for (let k = 0; k < frames.length; k++)
        for (let i = 0; i < frames[k].length; i++)
          maxByte = Math.max(maxByte, Math.abs(frames[k][i] - gpu[k][i]));
      assert(maxByte <= 1, 'full RGBA CPU/GPU parity: ' + maxByte + ' bytes');
      data.parityMaxByte = maxByte;
    } else gpuFrames.set(pairKey, frames);
    for (const frame of data.out) delete frame.rgba;
    console.log(JSON.stringify({ cfg, ...data }));
    const endpointInk = Math.min(data.out[0].ink, data.out.at(-1).ink);
    assert(
      data.out.every((f) => f.ink >= 0.98 * endpointInk),
      'stroke coverage persists throughout the morph',
    );
  }
  const preserved = await page.evaluate((c) => window.run(c), {
    ellipse: false,
    dash: false,
    reverse: false,
    cpuLerp: false,
    align: false,
  });
  assert(
    preserved.out[0].ink < 10 && preserved.out[0].bad === preserved.out[0].inside,
    'preserve mode retains the authored zero-sweep crossing',
  );
  console.log(
    'morphArcDirectionRenderSmoke PASS: 16 Metal cases, 80 poses; CPU/GPU interpolation, pair orders, dashed translucent circles and rotated ellipses; preserve control',
  );
} finally {
  await browser?.close();
  await new Promise((ok) => server.close(ok));
}
