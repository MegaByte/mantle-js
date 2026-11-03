// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// A fill revealed by an override follows a GPU-resident morph through changing poses.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';
const root = resolve(import.meta.dirname, '..');
const html = `<canvas id="c" width="256" height="256"></canvas><script type="module">
import {importSvg,createBundle,createRenderer,createShapeMorph,createOverrideTable,loadShaders} from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,stencil:true,preserveDrawingBuffer:true});
const device=gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
const r=createRenderer(gl,await loadShaders(new URL('/src/shaders/',location.href).href),{});await r.ready;r.setViewport(256,256);r.setFillEngine({route:'lb',kernel:'slug',primitives:'off'});
const doc=(x,a)=>'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path id="a" d="M'+x+' '+x+'h10v10h-10Z" fill="#3366cc" fill-opacity="'+a+'"/></svg>';
const a=createBundle(gl,await importSvg(doc(3,0),{preserveViewport:true})),b=createBundle(gl,await importSvg(doc(18,0),{preserveViewport:true}));
const m=createShapeMorph(gl,a,b),table=createOverrideTable(gl,m.bundle);table.set('a',{fill:[.2,.4,.8,.5]});
const draw=()=>{r.beginFrame([1,1,1,1]);r.drawBundle(m,{overrides:table});r.endFrame();};
m.setT(0);draw();await r.awaitLbReady(m,60000);
const warm=await r.warmScene([{draw}],{maxPasses:128,readyTimeoutMs:60000,fenceTimeoutMs:60000});if(!warm.complete)throw Error('Warming incomplete');
const read=()=>{const p=new Uint8Array(256*256*4);gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,p);return p;};
const rows=[];
for(const t of [0,.25,.5,1,.25]){
 m.setT(t);draw();const actual=read(),skipCurveUploads=!!m.bundle._morphSrc.skipCurveUploads;
 const control=createBundle(gl,await importSvg(doc(3+15*t,.5),{preserveViewport:true}));
 const frame=()=>{r.beginFrame([1,1,1,1]);r.drawBundle(control);r.endFrame();};
 await r.awaitLbReady(control,60000);await r.warmScene([{draw:frame}],{maxPasses:128,readyTimeoutMs:60000,fenceTimeoutMs:60000});frame();const reference=read();
 let max=0,different=0,ink=0;for(let i=0;i<actual.length;i++){const d=Math.abs(actual[i]-reference[i]);max=Math.max(max,d);if(d)different++;if(i%4===0&&actual[i]<240)ink++;}
 rows.push({t,max,different,ink,skipCurveUploads,error:gl.getError()});control.dispose();
}
const paintRows=[];
for(const kind of ['alpha','rgb']){
 const srcDoc=doc(3,kind==='alpha'?1:.5),dstDoc=doc(3,kind==='alpha'?.25:.5).replace('#3366cc',kind==='rgb'?'#cc6633':'#3366cc');
 const src=createBundle(gl,await importSvg(srcDoc,{preserveViewport:true})),dst=createBundle(gl,await importSvg(dstDoc,{preserveViewport:true}));
 const paintMorph=createShapeMorph(gl,src,dst);paintMorph.setT(.5);
 const paintDraw=()=>{r.beginFrame([1,1,1,1]);r.drawBundle(paintMorph);r.endFrame();};
 await r.awaitLbReady(paintMorph,60000);await r.warmScene([{bundle:paintMorph.bundle,engine:'lb',draw:paintDraw}],{maxPasses:128,readyTimeoutMs:60000,fenceTimeoutMs:60000});
 for(const t of [0,1,0]){
  paintMorph.setT(t);const before=r.debugStats.engines?.draws?.lb||0;paintDraw();const actual=read(),lb=(r.debugStats.engines?.draws?.lb||0)-before;
  const endpoint=t===0?src:dst,referenceDraw=()=>{r.beginFrame([1,1,1,1]);r.drawBundle(endpoint);r.endFrame();};
  await r.awaitLbReady(endpoint,60000);await r.warmScene([{bundle:endpoint,engine:'lb',draw:referenceDraw}],{maxPasses:128,readyTimeoutMs:60000,fenceTimeoutMs:60000});referenceDraw();const reference=read();
  let max=0,ink=0;for(let i=0;i<actual.length;i++){max=Math.max(max,Math.abs(actual[i]-reference[i]));if(i%4===0&&actual[i]<240)ink++;}
  paintRows.push({kind,t,max,ink,lb,skipCurveUploads:!!paintMorph.bundle._morphSrc.skipCurveUploads,metaMoves:paintMorph.bundle._morphSrc.metaMovesWithT,error:gl.getError()});
 }
 paintMorph.dispose();src.dispose();dst.dispose();
}
window.__result={device,rows,paintRows,hasMesh:m.bundle._morphMeshes?.some(Boolean)};
table.dispose();m.dispose();a.dispose();b.dispose();r.dispose();window.__ready=true;
</script>`;
const server = http.createServer((req, res) => {
  try {
    const p = new URL(req.url, 'http://localhost').pathname;
    assert(!p.includes('..'));
    res.setHeader(
      'Content-Type',
      p === '/' ? 'text/html' : p.endsWith('.glsl') ? 'text/plain' : 'text/javascript',
    );
    res.end(p === '/' ? html : readFileSync(join(root, p)));
  } catch (e) {
    res.statusCode = 404;
    res.end(String(e));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await launchBrowser({
    headless: 'new',
    args:
      process.env.MANTLE_TEST_GL === 'swiftshader'
        ? ['--enable-unsafe-swiftshader', '--no-sandbox']
        : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(e));
  await page.goto('http://127.0.0.1:' + server.address().port + '/');
  await page.waitForFunction('window.__ready', { timeout: pageTimeoutFor(150000), polling: 100 });
  const result = await page.evaluate(() => window.__result);
  if (process.env.MANTLE_TEST_GL === 'metal')
    assert(/Metal/.test(result.device) && !/SwiftShader/.test(result.device));
  console.log('MORPH_RESULT ' + JSON.stringify(result));
  assert(result.hasMesh, 'Revealed fill has a pair mesh');
  assert.equal(result.rows.length, 5);
  for (const row of result.rows) {
    assert(row.skipCurveUploads, 'Exercise the prepared route without curve uploads');
    assert(row.ink > 100, 'Image must contain the revealed fill');
    assert(row.max <= 1, JSON.stringify(row));
    assert.equal(row.error, 0);
  }
  assert.equal(result.paintRows.length, 6);
  for (const row of result.paintRows) {
    assert(row.lb > 0, 'Exercise actual LB paint morph');
    assert(row.skipCurveUploads, 'Keep prepared geometry resident');
    assert(row.metaMoves, 'Changing authored paint keeps metadata current');
    assert(row.ink > 100, 'Paint morph must be visible');
    assert(row.max <= 1, JSON.stringify(row));
    assert.equal(row.error, 0);
  }
  console.log('morphInvisibleOverrideRenderSmoke PASS ' + JSON.stringify(result));
} finally {
  if (browser) await browser.close();
  await new Promise((r) => server.close(r));
}
