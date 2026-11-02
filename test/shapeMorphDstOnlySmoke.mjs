// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// The GL shape morph must RENDER dst-only shapes (geometry present only
// in the destination pose), faded in across t.
//
// These shapes have no counterpart in the src pose, so the merged morph
// bundle has to (a) append their curves, (b) enclose them in globalBBox,
// (c) append their band regions repointed into the merged curve plane, and
// (d) append their cover-quad mesh chunks with fresh gids so buildDrawList
// emits a draw op. Missing ANY of those → the shape silently never rasterizes.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// SRC: a red square on the left. DST: the same red square PLUS a blue square
// on the right (the dst-only shape) — and it sits OUTSIDE src's bbox, so the
// bbox-union path is exercised too.
const SRC =
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
  '<rect x="10" y="40" width="20" height="20" fill="#FF0000"/></svg>';
const DST =
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
  '<rect x="10" y="40" width="20" height="20" fill="#FF0000"/>' +
  '<rect x="70" y="40" width="20" height="20" fill="#0000FF"/></svg>';

const HTML = `<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph, createSpriteMorph, fillHitShape, HitMode } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const m = createShapeMorph(gl, createBundle(gl, await importSvg(${JSON.stringify(SRC)})),
                               createBundle(gl, await importSvg(${JSON.stringify(DST)})));
window.__plan = { matched: m.plan.matched.length, srcOnly: m.plan.srcOnly.length, dstOnly: m.plan.dstOnly.length };
const id = new Float32Array([1,0,0,0,1,0,0,0,1]);
function scan(t) {
  m.setT(t);
  renderer.beginFrame([1,1,1,1]);
  renderer.drawBundle(m, { worldMatrix: id, overrides: m.overrides });
  renderer.endFrame();
  const px = new Uint8Array(100*100*4); gl.readPixels(0,0,100,100, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let blue = 0, red = 0;
  // Any pixel where blue dominates (covers partial fades over white too).
  let minRedInBlue = 255;
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
    const i = (y*100 + x) * 4;
    const r = px[i], g = px[i+1], b = px[i+2];
    if (b > 150 && b > r + 40 && b > g + 40) { blue++; if (r < minRedInBlue) minRedInBlue = r; }
    if (r > 150 && r > b + 40 && r > g + 40) red++;
  }
  // minRedInBlue: red channel at the bluest pixel. Over white bg a dst-only
  // blue fades in as red 255(absent) → ~128(half) → 0(full). null if no blue.
  return { blue, red, blueDepth: blue ? minRedInBlue : null };
}
window.__sweep = () => ({ t0: scan(0), t025: scan(0.25), t05: scan(0.5), t075: scan(0.75), t1: scan(1) });

window.__packedFades = async () => {
  const svg = body => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'+body+'</svg>';
  const stable='<rect id="stable" x="91" y="91" width="5" height="5" fill="red"/>';
  let prefix='',tail=stable;
  for(let i=0;i<450;i++)prefix+='<rect x="'+(150+i%30*3)+'" y="'+(150+(i/30|0)*3)+'" width="2" height="2" fill="black"/>';
  for(let i=0;i<350;i++){const x=2+(i%25)*3,y=2+(i/25|0)*6;tail+='<path id="fade'+i+'" d="M'+x+' '+y+' h2 q1 1 0 2 h-2 z" fill="blue" fill-opacity=".6"/>';}
  const a=createBundle(gl,await importSvg(svg('<g id="source">'+stable+'</g>'),{preserveViewport:true}));
  const b=createBundle(gl,await importSvg(svg('<g id="prefix">'+prefix+'</g><g id="tail">'+tail+'</g>'),{preserveViewport:true}));
  const reference=createBundle(gl,await importSvg(svg(tail),{preserveViewport:true}));
  const morph=createSpriteMorph(gl,{bundle:a,sprite:'source'},{bundle:b,sprite:'tail'},{cpuLerp:true});
  const r=createRenderer(gl,shaders,{aacPoints:false});if(r.ready)await r.ready;r.setFillEngine({route:'none',kernel:'aac',commit:false});r.setViewport(100,100);
  const shot=target=>{r.beginFrame([1,1,1,1]);r.drawBundle(target);r.endFrame();const px=new Uint8Array(100*100*4);gl.readPixels(0,0,100,100,gl.RGBA,gl.UNSIGNED_BYTE,px);return px;};
  try{
    morph.setT(0);const zero=shot(morph);morph.setT(.5);const half=shot(morph);morph.setT(1);const end=shot(morph),ref=shot(reference);morph.setT(0);const again=shot(morph);
    let max=0,repeat=0,halfInk=0;for(let i=0;i<end.length;i++){max=Math.max(max,Math.abs(end[i]-ref[i]));if(zero[i]!==again[i])repeat++;if((i&3)===0&&half[i]<250)halfInk++;}
    const floats=morph.bundle._morphSrc.mergedCurveF32.length;
    if(max>1||repeat||halfInk<100)throw Error('Packed fade image '+JSON.stringify({max,repeat,halfInk,floats}));
    if(floats>=8*4096*4)throw Error('Destination-only curves retain per-shape rows: '+floats+' floats');
    if(gl.getError())throw Error('Packed fade GL error');
    return{floats,max,repeat,halfInk,dstOnly:morph.plan.dstOnly.length};
  }finally{morph.dispose();a.dispose();b.dispose();reference.dispose();r.dispose();}
};
window.__emptyEndpoints = async () => {
  const svg = alpha => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'+(alpha ? '<rect x="10" y="10" width="80" height="80" fill="blue"/>' : '')+'</svg>';
  const results=[];
  renderer.setFillEngine({route:'none',kernel:'aac',commit:false});
  for (const [from,to] of [[0,1],[1,0],[0,0]]) {
    const a=createBundle(gl,await importSvg(svg(from),{preserveViewport:true}));
    const b=createBundle(gl,await importSvg(svg(to),{preserveViewport:true}));
    a.globalBBox=b.globalBBox=[0,0,100,100];
    let morph;
    try {
      morph=createShapeMorph(gl,a,b);morph.bundle.globalBBox=[0,0,100,100];
      const states=[];
      for (const t of [0,.25,.5,.75,1]) {
        morph.setT(t);renderer.beginFrame([1,1,1,1]);renderer.drawBundle(morph);renderer.endFrame();
        const pixel=new Uint8Array(4);gl.readPixels(50,50,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
        const expected=Math.round(255*(1-(from+(to-from)*t)));
        if(Math.abs(pixel[0]-expected)>1||Math.abs(pixel[1]-expected)>1||pixel[2]!==255||pixel[3]!==255)throw Error('Empty endpoint fade: '+[from,to,t]+' '+pixel);
        const alpha=from+(to-from)*t;
        const hit=fillHitShape(morph.bundle,50,50,{mode:HitMode.Coverage,minAlpha:Math.max(.01,alpha-.01)});
        const above=fillHitShape(morph.bundle,50,50,{mode:HitMode.Coverage,minAlpha:alpha+.01});
        if((hit>=0)!==(alpha>.01)||above>=0)throw Error('Empty endpoint hit/pixel disagreement: '+[from,to,t,alpha,hit,above]);
        morph.overrides.uploadIfDirty();
        const error=gl.getError();if(error)throw Error('Empty endpoint GL error '+error);
        states.push({t,pixel:Array.from(pixel)});
      }
      if(from===0&&to===0&&(morph.overrides.numShapes!==0||morph.overrides.packedBuffer.length!==0))throw Error('Empty override table has shapes');
      results.push({from,to,states});
    } finally {morph?.dispose();a.dispose();b.dispose();}
  }
  return results;
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
  try {
    const b = readFileSync(path.join(ROOT, p));
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(b);
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

// Honor the validation runner's requested browser backend.
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
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 15000, polling: 100 });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const plan = await page.evaluate(() => window.__plan);
if (plan.matched === 1 && plan.dstOnly === 1) ok('plan: 1 matched (red), 1 dst-only (blue)');
else fail('plan wrong: ' + JSON.stringify(plan));

const s = await page.evaluate(() => window.__sweep());
// Red is matched → always present.
if (s.t0.red > 100 && s.t1.red > 100) ok('matched red shape renders at all t');
else fail('matched red missing: ' + JSON.stringify(s));
// Blue is dst-only → absent at t=0, present at t=1.
if (s.t0.blue === 0) ok('t=0: dst-only blue ABSENT (not yet faded in)');
else fail('t=0 blue should be 0: ' + s.t0.blue);
if (s.t1.blue > 100 && s.t1.blueDepth < 60)
  ok(
    't=1: dst-only blue FULLY RENDERED (' +
      s.t1.blue +
      ' px, depth=' +
      s.t1.blueDepth +
      ') — the merged-bundle gap is fixed',
  );
else fail('t=1 dst-only not full: ' + JSON.stringify(s.t1));
// CROSSFADE: blue must FADE in continuously (over white bg the bluest pixel's
// red channel ramps 255→~128→0), not pop. blueDepth strictly decreases.
const depths = [
  s.t0.blueDepth,
  s.t025.blueDepth,
  s.t05.blueDepth,
  s.t075.blueDepth,
  s.t1.blueDepth,
];
if (s.t05.blueDepth != null && s.t05.blueDepth > 70 && s.t05.blueDepth < 190)
  ok(
    't=0.5: dst-only blue is HALF-faded (depth=' +
      s.t05.blueDepth +
      '), not popped — continuous crossfade',
  );
else fail('t=0.5 not a partial fade (binary pop?): ' + JSON.stringify(s.t05));
if (
  s.t025.blueDepth != null &&
  s.t075.blueDepth != null &&
  s.t025.blueDepth > s.t05.blueDepth &&
  s.t05.blueDepth > s.t075.blueDepth
)
  ok(
    'dst-only opacity ramps monotonically t.25>t.5>t.75 (depths ' +
      depths.slice(1, 4).join('>') +
      ')',
  );
else fail('fade not monotonic — visibility may be binary: ' + JSON.stringify(depths));

try {
  const empty = await page.evaluate(() => window.__emptyEndpoints());
  if (empty.length === 3 && empty.every((x) => x.states.length === 5))
    ok(
      'empty-source, empty-target and empty-pair morphs: exact interior fades, valid empty overrides, no GL errors',
    );
  else fail('empty endpoint matrix incomplete');
} catch (e) {
  fail('empty endpoints: ' + e.message);
}

try {
  const p = await page.evaluate(() => window.__packedFades());
  ok('Compact sprite fades cross curve rows and match the destination: ' + JSON.stringify(p));
} catch (e) {
  fail('Compact sprite fades: ' + e.message);
}
await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nshapeMorphDstOnlySmoke: all checks passed');
