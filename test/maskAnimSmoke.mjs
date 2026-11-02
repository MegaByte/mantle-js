// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Moving mask children update their bakes; unchanged poses reuse them.
// Morph masks also match independently imported literal poses at AA corners.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
import { installGpuThrottle } from './_gpuThrottle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Multi-shape mask (two white rects → a real offscreen bake region). The
// LEFT window has id "win" so the override table can move it; the right is
// static. Orange fill is revealed only inside the windows.
const SVG = readFileSync(new URL('../examples/smoke/maskAnim__SVG.svg', import.meta.url), 'utf8');

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable, createShapeMorph } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
const ovr = createOverrideTable(gl, bundle);
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
window.__draw = (useOvr) => {
  renderer.setViewport(200, 100);
  renderer.beginFrame([0,0,0,1]);
  renderer.drawBundle(bundle, useOvr ? { worldMatrix: id, overrides: ovr } : { worldMatrix: id });
  renderer.endFrame();
};
window.__moveWin = (dx) => ovr.set('win', { localPosition: [dx, 0] });
window.__sample = (x, yTop) => { const b = new Uint8Array(4); gl.readPixels(x, 100-1-yTop, 1,1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
window.__bakes = () => renderer.debugStats.maskBakeCount;
window.__maskMorphChecks = async () => {
  await renderer.ready;
  renderer.setFillEngine({route:'none',kernel:'aac',primitives:'off'});
  const fixture = t => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><mask id="c" maskUnits="userSpaceOnUse" x="0" y="0" width="120" height="120">'
    + '<path id="cl0" fill="white" stroke="white" stroke-width="3" d="M10 '+(10+5*t)+'h30v40h-30Z"/>'
    + '<path id="cl1" fill="white" stroke="white" stroke-width="3" d="M70 '+(10+5*t)+'h30v40h-30Z"/></mask></defs>'
    + '<path id="a" fill="#c33" fill-opacity=".55" mask="url(#c)" d="M0 0H120V120H0Z"/>'
    + (t>0?'<path id="b" fill="#248ac9" fill-opacity="'+(.65*t)+'" mask="url(#c)" d="M0 0H120V120H0Z"/>':'')+'</svg>';
  const draw = async target => {
    renderer.beginFrame([.1,.2,.3,1]);renderer.drawBundle(target);renderer.endFrame();
    if(!await window.__gpuFence(gl,60000))throw Error('Morph mask fence');
    const pixels=new Uint8Array(200*100*4);gl.readPixels(0,0,200,100,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return pixels;
  };
  const rows=[];
  for(const gpu of [false,true]){
    const a=createBundle(gl,await importSvg(fixture(0),{preserveViewport:true}));
    const b=createBundle(gl,await importSvg(fixture(1),{preserveViewport:true}));
    const m=createShapeMorph(gl,a,b,{cpuLerp:!gpu});m.bundle._morphSrc.gpuSmallPlanes=gpu;
    for(const t of [0,.125,.875]){
      const started=performance.now();m.setT(t);
      const warm=await renderer.warmScene([{draw:()=>{renderer.beginFrame([.1,.2,.3,1]);renderer.drawBundle(m);renderer.endFrame();}}],{maxPasses:16,fenceTimeoutMs:60000});
      if(!warm.complete)throw Error('Morph mask warm incomplete '+JSON.stringify(warm));
      const actual=await draw(m),ref=createBundle(gl,await importSvg(fixture(t),{preserveViewport:true}));
      const expected=await draw(ref);ref.dispose();
      let maxByte=0;for(let i=0;i<actual.length;i++)maxByte=Math.max(maxByte,Math.abs(actual[i]-expected[i]));
      const before=renderer.debugStats.maskBakeCount;await draw(m);
      rows.push({gpu,gpuUsed:!!m.usesGpuCurveLerp,t,maxByte,rebakes:renderer.debugStats.maskBakeCount-before,glError:gl.getError()});
      await window.__gpuIdle(performance.now()-started);
    }
    m.dispose();a.dispose();b.dispose();
  }
  return rows;
};

window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  const ct = p.endsWith('.glsl') ? 'text/plain' : 'text/javascript';
  try {
    res.writeHead(200, { 'content-type': ct + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const isOrange = (p) => p[0] > 180 && p[1] > 50 && p[1] < 170 && p[2] < 70;
const isBg = (p) => p[0] < 60 && p[1] < 60 && p[2] < 60;

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
try {
  await openReady(page, `http://127.0.0.1:${port}/`, { ready: 'flag' });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

await installGpuThrottle(page);

// (1) baseline: orange in the left window (x≈30), hidden in the gap (x≈100).
const base = await page.evaluate(() => {
  window.__draw(false);
  return {
    leftWin: window.__sample(30, 50),
    gap: window.__sample(100, 50),
    bakes: window.__bakes(),
  };
});
if (isOrange(base.leftWin)) ok('baseline: orange revealed through the left window (x=30)');
else fail('baseline left window not orange: ' + base.leftWin);
if (isBg(base.gap)) ok('baseline: gap between windows is masked out (x=100)');
else fail('gap not masked: ' + base.gap);

// (2) move the left window +60 in em → its reveal shifts right. At the new
// position (x≈90) orange should appear; at the previous position (x≈30) it's gone.
const moved = await page.evaluate(() => {
  window.__moveWin(60);
  window.__draw(true);
  return {
    oldPos: window.__sample(30, 50),
    newPos: window.__sample(90, 50),
    bakes: window.__bakes(),
  };
});
if (isOrange(moved.newPos)) ok('animated mask: reveal MOVED to the new window position (x=90)');
else fail('mask did not move — reveal absent at new pos: ' + moved.newPos);
if (isBg(moved.oldPos)) ok('animated mask: previous position masked out (window left)');
else fail('old position still revealed (mask frozen?): ' + moved.oldPos);

// (3) the cache RE-BAKES when the mask child moves.
if (moved.bakes > base.bakes)
  ok('mask re-baked on animation (bakes ' + base.bakes + ' → ' + moved.bakes + ')');
else fail('mask did NOT re-bake on animation (frozen): ' + base.bakes + ' → ' + moved.bakes);

// (4) a no-op redraw at the same override state does NOT re-bake (cache holds).
const noop = await page.evaluate(() => {
  const b0 = window.__bakes();
  window.__draw(true);
  window.__draw(true);
  return { b0, b1: window.__bakes() };
});
if (noop.b1 === noop.b0) ok('no-op redraw reuses the bake (cache still works, no over-bake)');
else fail('re-baked on a static redraw: ' + noop.b0 + ' → ' + noop.b1);

const morphs = await page.evaluate(() => window.__maskMorphChecks());
for (const row of morphs) {
  if (row.maxByte <= 1 && row.rebakes === 0 && row.gpu === row.gpuUsed && row.glError === 0)
    ok('morph mask pose ' + row.t + ', GPU ' + row.gpu + ' matches and reuses its bake');
  else fail('morph mask ' + JSON.stringify(row));
}

await browser.close();
server.close();
if (failures === 0) console.log('\nMASK-ANIM PASS');
else console.log(`\nMASK-ANIM FAIL (${failures})`);
process.exit(failures ? 1 : 0);
