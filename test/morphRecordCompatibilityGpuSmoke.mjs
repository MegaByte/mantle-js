// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Incompatible curve records use the ordered source-over fade, including translucent paints.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { launchBrowser } from './_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = `<canvas id="c" width="128" height="128"></canvas><script type="module">
import {importSvg,createBundle,createRenderer,loadShaders,createShapeMorph} from '/src/index.js';
const gl=c.getContext('webgl2',{depth:true,antialias:false,preserveDrawingBuffer:true});
const ext=gl.getExtension('WEBGL_debug_renderer_info'),backend=gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
const r=createRenderer(gl,await loadShaders(new URL('/src/shaders/',location.href)));
r.setFillEngine({route:'none',kernel:'aac',primitives:'off'});r.setViewport(128,128);
const svg=d=>'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path id="s" fill="#d3439b" fill-opacity=".55" d="'+d+'"/></svg>';
const A=createBundle(gl,await importSvg(svg('M10 10Q40 20 80 70L10 10Z'))),B=createBundle(gl,await importSvg(svg('M10 10C40 20 50 30 80 70L10 10Z')));
const out=[];
async function draw(m,A,B,t,reference){
 for(let i=0;i<4;i++){r.beginFrame([0,0,0,0]);if(reference){r.drawBundle(A,{alpha:1-t});r.drawBundle(B,{alpha:t});}else r.drawBundle(m);r.endFrame();await new Promise(ok=>setTimeout(ok,20));}
 const pixels=new Uint8Array(128*128*4);gl.readPixels(0,0,128,128,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return pixels;
}
for(const reverse of [false,true])for(const cpuLerp of [false,true]){
 const a=reverse?B:A,b=reverse?A:B,m=createShapeMorph(gl,a,b,{cpuLerp});let maxByte=0,ink=0;
 for(const t of [0,.25,.5,.75,1]){m.setT(t);const actual=await draw(m,a,b,t,false),ref=await draw(m,a,b,t,true);for(let i=0;i<ref.length;i++){maxByte=Math.max(maxByte,Math.abs(actual[i]-ref[i]));if(i%4===3)ink+=ref[i];}}
 out.push({reverse,cpuLerp,maxByte,ink,matched:m.plan.matched.length,srcOnly:m.plan.srcOnly.length,dstOnly:m.plan.dstOnly.length,glError:gl.getError()});m.dispose();
}
window.result={backend,out,engines:r.debugStats.engines.draws};A.dispose();B.dispose();r.dispose();
</script>`;
const before = process.env.MANTLE_RECORD_BEFORE
  ? execFileSync('git', ['show', '588c3561:js.kontek.mantle/src/core/morphCore.js'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
  : null;
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
    res.end(before && u === '/src/core/morphCore.js' ? before : readFileSync(f));
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
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction('window.result', { timeout: 90000, polling: 100 });
  const d = await page.evaluate(() => window.result);
  console.log(JSON.stringify(d));
  assert(/Apple.*Metal|Metal.*Apple/.test(d.backend));
  assert(d.engines.aac > 0);
  for (const x of d.out) {
    assert(x.ink > 1e5);
    assert.equal(x.glError, 0);
    assert.equal(x.matched, 0);
    assert.equal(x.srcOnly, 1);
    assert.equal(x.dstOnly, 1);
    assert(x.maxByte <= 1, 'ordered source-over fade differs by ' + x.maxByte + ' bytes');
  }
  console.log('morphRecordCompatibilityGpuSmoke PASS');
} finally {
  await browser?.close();
  await new Promise((ok) => server.close(ok));
}
