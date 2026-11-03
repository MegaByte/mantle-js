// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Segment-type specialization must preserve translucent strokes and changing morph poses.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const curves = [
  'M12 20 L70 18 L80 76',
  'M12 20 Q90 4 80 76',
  'M12 20 C92 0 2 92 80 76',
  'M12 20 A42 28 25 1 1 80 76',
];
const svg = (d, opacity = 0.55, width = 9) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path id="s" d="${d}" fill="none" stroke="#3060c0" stroke-width="${width}" stroke-opacity="${opacity}" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
const fixtures = curves.map((d) => svg(d));
const HTML = `<!doctype html><canvas id="c" width="256" height="256"></canvas><script type="module">
globalThis.__MANTLE_DEBUG__ = true;
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const gl = document.querySelector('canvas').getContext('webgl2', {antialias:false, depth:true, preserveDrawingBuffer:true});
window.stage='loading shaders';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const fixtures = ${JSON.stringify(fixtures)};
const rows = [];
const make = omit => {const r=createRenderer(gl,shaders,{typeOmit:omit,aacPoints:false});r.setFillEngine({route:'none',kernel:'slug'});r.setViewport(256,256);return r;};
window.stage='creating renderers';
const full = make(false), lean = make(undefined);
const instances=[{worldMatrix:new Float32Array([.62,0,0,0,.62,0,-.2,.08,1]),tint:[.8,1,.7,1]},
 {worldMatrix:new Float32Array([.54,0,0,0,.54,0,.25,-.12,1]),tint:[1,.7,.9,.65]}];
let instProof=null;
const instDraw=gl.drawArraysInstanced.bind(gl);
gl.drawArraysInstanced=(...args)=>{
 if(args[0]===gl.TRIANGLES && args[3]===2){
  const p=gl.getParameter(gl.CURRENT_PROGRAM),text=gl.getAttachedShaders(p).map(sh=>gl.getShaderSource(sh)).join('\\n');
  const uniform=name=>{const loc=gl.getUniformLocation(p,name);return loc===null?null:gl.getUniform(p,loc);};
  instProof={key:[...text.matchAll(/^#define (MANTLE_\\w+)[^\\n]*/gm)].map(m=>m[1]).join('|'),gates:uniform('uStrokeGates'),aa:uniform('uStrokeExactAa')};
 }
 return instDraw(...args);
};
const draw = async (r,b,pair=false,instanced=false) => {
 window.stage='drawing';let proof=null;
 for(let i=0;i<100;i++){
  instProof=null;r.beginFrame([1,1,1,1]);
  if(instanced)r.drawBundleInstanced(b,instances);
  else if(pair)for(const instance of instances){const m=new Float32Array(16);for(let c=0;c<4;c++)m[c*5]=instance.tint[c];r.drawBundle(b,{worldMatrix:instance.worldMatrix,colorMatrix:m});}
  else r.drawBundle(b);
  r.endFrame();await new Promise(q=>setTimeout(q,16));
  proof=instProof;
  const key=instanced?(proof?.key||''):(r.debugStats.drawnFillVariantKey||'');
  if(i>=3&&(/MANTLE_NO_(LINE|QUAD|CUBIC|ARC)(\\||$)/.test(key)===(r===lean)))break;
 }
 const px=new Uint8Array(256*256*4);gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,px);
 return {px,key:instanced?(proof?.key||''):(r.debugStats.drawnFillVariantKey||''),proof,error:gl.getError()};
};
const compare = async (name,a,b,pair=false,expectedControl=null) => {
 const x=await draw(full,a,pair),y=await draw(lean,b,pair,pair);let max=0,changed=0,ink=0;
 for(let i=0;i<x.px.length;i++){const e=Math.abs(x.px[i]-y.px[i]);max=Math.max(max,e);changed+=e>1?1:0;if(i%4===0&&y.px[i]<240)ink++;}
 rows.push({name,max,changed,ink,full:x.key,lean:y.key,instanced:pair,proof:y.proof,expectedControl,error:x.error||y.error});
};
try {
 for(let i=0;i<fixtures.length;i++) {window.stage='import '+i;const sec=await importSvg(fixtures[i]);await compare('type '+i,createBundle(gl,sec),createBundle(gl,sec));}
 const a=await importSvg(${JSON.stringify(svg(curves[1]))}),b=await importSvg(${JSON.stringify(svg('M12 65 Q45 4 85 22', 0.25, 16))});
 const m0=createShapeMorph(gl,createBundle(gl,a),createBundle(gl,b)),m1=createShapeMorph(gl,createBundle(gl,a),createBundle(gl,b));
 for(const t of [0,0.25,0.5,0.75,1,0.25]) {m0.setT(t);m1.setT(t);await compare('morph '+t,m0,m1);}
 for(let i=0;i<fixtures.length;i++){
  const sec=await importSvg(fixtures[i]),a=createBundle(gl,sec),b=createBundle(gl,sec);
  for(const on of [null,false,true]){
   if(on!==null){for(const r of [full,lean]){r.setStrokeGates(on);r.setStrokeExactAa(on);}}
   await compare('instanced type '+i+' controls '+on,a,b,true,on===false?0:1);
  }
 }
 for(const t of [0,.5,1]){m0.setT(t);m1.setT(t);await compare('instanced morph '+t,m0,m1,true,1);}

 window.out={rows};
} catch(e){window.out={error:String(e.stack||e)};}
</script>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.setHeader('content-type', 'text/html');
    res.end(HTML);
    return;
  }
  try {
    res.setHeader(
      'content-type',
      /\.(js|mjs)$/.test(u.pathname) ? 'text/javascript' : 'text/plain',
    );
    res.end(fs.readFileSync(path.join(ROOT, decodeURIComponent(u.pathname))));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await launchBrowser({
    headless: 'new',
    args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
    protocolTimeout: 180000,
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  page.on('console', (m) => console.log('page:', m.text()));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  try {
    await page.waitForFunction('window.out', { timeout: 150000, polling: 100 });
  } catch (e) {
    console.log(
      await page.evaluate(() => ({
        stage: window.stage,
        resources: performance
          .getEntriesByType('resource')
          .slice(-5)
          .map((x) => x.name),
      })),
    );
    throw e;
  }
  const out = await page.evaluate(() => window.out);
  if (out.error) throw new Error(out.error);
  let fail = 0;
  for (const r of out.rows) {
    const ok =
      r.changed === 0 &&
      r.ink > 100 &&
      r.error === 0 &&
      /MANTLE_NO_(LINE|QUAD|CUBIC|ARC)(\||$)/.test(r.lean) &&
      !/MANTLE_NO_(LINE|QUAD|CUBIC|ARC)(\||$)/.test(r.full);
    console.log(
      `${ok ? 'ok' : 'FAIL'} ${r.name}: max ${r.max}, channels >1 ${r.changed}, ink ${r.ink}, GL ${r.error}, full ${r.full}, lean ${r.lean}`,
    );
    if (!ok) fail++;
    if (
      r.instanced &&
      (!r.proof || r.proof.gates !== r.expectedControl || r.proof.aa !== r.expectedControl)
    ) {
      console.log(
        'FAIL instanced uniforms ' + JSON.stringify(r.proof) + ' expected ' + r.expectedControl,
      );
      fail++;
    }
  }
  if (fail) throw new Error(`${fail} specialized stroke/morph comparisons failed`);
  console.log(
    'strokeTypeOmitGpuSmoke PASS: all curve types, instancing, stroke controls and translucent changing morphs match the full program within one byte',
  );
} finally {
  if (browser) await browser.close();
  await new Promise((r) => server.close(r));
}
