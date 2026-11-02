// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Point programs, VAO and retained buffers belong to the renderer and must be released on dispose: the list buffers (aacPointsGen:false) and the
// generated points' entry tables (the default), each in its own page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = `<canvas id="c" width="128" height="128"></canvas><script type="module">
import {importSvg,createBundle,createRenderer,loadShaders,setDiagnostics} from '/src/index.js';
const gen=new URLSearchParams(location.search).get('gen')!=='0';
const gl=c.getContext('webgl2',{depth:true,antialias:false,preserveDrawingBuffer:true});
const ext=gl.getExtension('WEBGL_debug_renderer_info'),backend=ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
console.log('dispose fixture: shaders');
const shaderObjects=new Set(),createShader=gl.createShader.bind(gl);
gl.createShader=type=>{const shader=createShader(type);shaderObjects.add(shader);return shader;};
const shaders=await loadShaders(new URL('/src/shaders/',location.href));
console.log('dispose fixture: import');
const b=createBundle(gl,await importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#d3439b" fill-opacity=".55" d="M20 20L36 21L26 37Z"/></svg>',{preserveViewport:true}));
let captured=[];
const original=gl.drawArraysInstanced.bind(gl);
const unitTex=u=>{const a=gl.getParameter(gl.ACTIVE_TEXTURE);gl.activeTexture(gl.TEXTURE0+u);const t=gl.getParameter(gl.TEXTURE_BINDING_2D);gl.activeTexture(a);return t;};   // (the table rides unit 6)
gl.drawArraysInstanced=(mode,...args)=>{if(mode===gl.POINTS&&captured)captured.push({buffer:gen?unitTex(6):gl.getParameter(gl.ARRAY_BUFFER_BINDING),vao:gl.getParameter(gl.VERTEX_ARRAY_BINDING),program:gl.getParameter(gl.CURRENT_PROGRAM)});return original(mode,...args);};
const renderer=()=>{const r=createRenderer(gl,shaders,{aacFill:true,aacPointsRowGate:false,aacPointsGen:gen});r.setFillEngine({route:'none',kernel:'aac',primitives:'off'});r.setViewport(128,128);r.prewarmBundle(b);r.precompileFills();return r;};
async function draw(r,scale){for(let i=0;i<4;i++){r.beginFrame([0,0,0,0]);r.drawBundle(b,{worldMatrix:[scale,0,0,0,scale,0,0,0,1]});r.endFrame();await new Promise(ok=>setTimeout(ok,20));}const p=new Uint8Array(128*128*4);gl.readPixels(0,0,128,128,gl.RGBA,gl.UNSIGNED_BYTE,p);return p;}
console.log('dispose fixture: renderer');
const r=renderer();for(const s of [.65,.8,1])await draw(r,s);const before=await draw(r,1);
if(!(r.debugStats.engines.viaRoute['aac@points']>0))throw Error('Point route did not draw');
const buffers=new Set(captured.map(x=>x.buffer)),vaos=new Set(captured.map(x=>x.vao)),programs=new Set(captured.map(x=>x.program));
if(shaderObjects.size<2||buffers.size<2||!vaos.size||!programs.size)throw Error('Point resources not exercised');
r.dispose();captured=null;gl.useProgram(null);
const afterDispose={shaders:[...shaderObjects].map(x=>gl.isShader(x)),buffers:[...buffers].map(x=>gen?gl.isTexture(x):gl.isBuffer(x)),vaos:[...vaos].map(x=>gl.isVertexArray(x)),programs:[...programs].map(x=>gl.isProgram(x))};
const r2=renderer(),after=await draw(r2,1);let maxByte=0;for(let i=0;i<before.length;i++)maxByte=Math.max(maxByte,Math.abs(before[i]-after[i]));
const actualPoints=r2.debugStats.engines.viaRoute['aac@points']||0;r2.dispose();
gl.useProgram(null);
const compileFailures=[];setDiagnostics({onError:()=>{}});
for(const asyncShaderCompile of [false,true]){
 const from=shaderObjects.size;let failure=null,deletedLinking=0;
 const khrLink=gl.getExtension('KHR_parallel_shader_compile'),deleteProgram=gl.deleteProgram.bind(gl);   // (a program deleted while its link runs raises GL_INVALID_VALUE later, from no call: glError below saw it about once in 30 loaded runs)
 gl.deleteProgram=p=>{if(khrLink&&p&&!gl.getProgramParameter(p,khrLink.COMPLETION_STATUS_KHR))deletedLinking++;deleteProgram(p);};
 try{const broken=createRenderer(gl,{...shaders,fillFrag:shaders.fillFrag+'\\n#error intentional_shader_failure\\n'},{asyncShaderCompile});await broken.ready;}catch(e){failure=String(e);}
 delete gl.deleteProgram;
 if(deletedLinking)throw Error('A failed compile deleted programs still linking: '+JSON.stringify({deletedLinking,asyncShaderCompile}));
 // (a shader outlives its deletion while a program it is attached to is still linking: released means released once those links end)
 const released=performance.now();
 while([...shaderObjects].slice(from).some(shader=>gl.isShader(shader))&&performance.now()-released<30000)await new Promise(ok=>setTimeout(ok,8));
 const retained=[...shaderObjects].slice(from).filter(shader=>gl.isShader(shader)).length;
 if(!failure?.includes('intentional_shader_failure')||retained)throw Error('Failed compile lost diagnostics or retained shaders: '+JSON.stringify({failure,retained,asyncShaderCompile}));
 compileFailures.push({asyncShaderCompile,retained});
}
setDiagnostics({onError:null});
const earlyAllocations={buffers:0,textures:0};
for(const [method,key]of [['createBuffer','buffers'],['createTexture','textures']]){
 const original=gl[method].bind(gl);gl[method]=(...args)=>{earlyAllocations[key]++;return original(...args);};
}
const shaderStart=shaderObjects.size,cancelled=createRenderer(gl,shaders,{asyncShaderCompile:true});
const cancellation=cancelled.ready.then(()=>{throw Error('Cancelled initialization resolved');},error=>String(error));
if(typeof cancelled.dispose!=='function')throw Error('Pre-ready renderer has no dispose method');
cancelled.dispose();cancelled.dispose();
const cancellationError=await cancellation,cancelWait=performance.now();
while([...shaderObjects].slice(shaderStart).some(shader=>gl.isShader(shader))){if(performance.now()-cancelWait>30000)throw Error('Cancelled shaders did not release');await new Promise(ok=>setTimeout(ok,8));}
const earlyShaders=[...shaderObjects].slice(shaderStart).filter(shader=>gl.isShader(shader)).length;
if(!cancellationError.includes('disposed before shader preparation')||earlyShaders||earlyAllocations.buffers||earlyAllocations.textures||cancelled.debugStats)throw Error('Cancelled renderer initialized or retained resources');
window.result={gen,backend,cancellationError,earlyAllocations,earlyShaders,compileFailures,afterDispose,maxByte,actualPoints,glError:gl.getError(),count:{buffers:buffers.size,vaos:vaos.size,programs:programs.size}};
</script>`;
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
  page.on('console', (e) => console.log(e.text()));
  for (const gen of [1, 0]) {
    await page.goto('http://127.0.0.1:' + server.address().port + '/?gen=' + gen);
    await page.waitForFunction('window.result', { timeout: pageTimeoutFor(90000), polling: 100 });
    const d = await page.evaluate(() => window.result);
    console.log(JSON.stringify(d));
    assert.equal(d.gen, !!gen);
    assert(/Apple.*Metal|Metal.*Apple/.test(d.backend));
    assert.equal(d.glError, 0);
    assert(d.maxByte <= 1 && d.actualPoints > 0);
    for (const [kind, alive] of Object.entries(d.afterDispose))
      assert(
        alive.every((x) => !x),
        kind +
          ' remain live after renderer.dispose (' +
          (gen ? 'generated tables' : 'point lists') +
          ')',
      );
  }
  console.log('aacPointsDisposeGpuSmoke PASS');
} finally {
  await browser?.close();
  await new Promise((ok) => server.close(ok));
}
