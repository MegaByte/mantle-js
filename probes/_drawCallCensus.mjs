// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _drawCallCensus — how many GL draw calls does a multi-BUNDLE scene actually cost, and what
// forces each one? This is the headroom question for cross-bundle batching.
//
// Within-bundle batching is already solved (the header-free cover-quad VBO collapsed a real game
// scene from ~4449 to ~50 draws/frame). So the open question is what remains ACROSS bundles: if
// N bundles drawn in painter's order cost ~N draws, cross-bundle batching can only ever remove
// the state changes between them — and the fixed cost per draw is ~0.02-0.035ms (see
// probes/_wgpuFillrate.mjs), so the ceiling on the win is (draws removed) x that.
//
// Method: monkey-patch drawArrays/drawArraysInstanced on the live context and attribute each
// call, plus count the state changes (useProgram / bindTexture / blend changes) between them,
// since those are what a reorder-and-batch scheme would actually eliminate.
//
// COUNTS only — do NOT add timings to this scene without also passing `preserveViewport: true`
// to importSvg. Without it importSvg fits each bundle's TIGHT CONTENT BBOX to the viewport, so
// every single-shape bundle here renders blown up to fill the canvas while a merged/one-bundle
// comparand draws the same shapes small. Draw COUNTS are unaffected (which is all this probe
// reports), but any ms/frame measured this way is meaningless — fake 20-40x "speedups"
// (probes/_atlasMultiBundle.mjs sets the flag for this reason).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Scenes: the interesting axis is BUNDLE COUNT and whether bundles overlap, because
// disjoint bundles can be reordered freely (order is unobservable) while overlapping ones cannot.
const shape = (cx, cy, r, fill) =>
  `<path fill="${fill}" d="M ${cx - r} ${cy} C ${cx - r} ${cy - r * 1.3} ${cx + r} ${cy - r * 1.3} ${cx + r} ${cy} C ${cx + r} ${cy + r * 1.3} ${cx - r} ${cy + r * 1.3} ${cx - r} ${cy} Z"/>`;
const svgOf = (parts) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${parts.join('')}</svg>`;

// one bundle holding K shapes (the batched-within case)
const manyShapesOneBundle = (K) =>
  svgOf(
    Array.from({ length: K }, (_, i) =>
      shape(60 + (i % 8) * 55, 60 + Math.floor(i / 8) * 55, 22, `hsl(${(i * 37) % 360},60%,50%)`),
    ),
  );
// K separate single-shape bundles, laid out DISJOINT (a grid) — reorderable in principle
const disjointBundles = (K) =>
  Array.from({ length: K }, (_, i) =>
    svgOf([
      shape(60 + (i % 8) * 55, 60 + Math.floor(i / 8) * 55, 22, `hsl(${(i * 37) % 360},60%,50%)`),
    ]),
  );
// K separate single-shape bundles that all OVERLAP at the center — NOT reorderable
const overlappingBundles = (K) =>
  Array.from({ length: K }, (_, i) =>
    svgOf([shape(256 + (i % 3) * 8, 256 + (i % 5) * 8, 90, `hsl(${(i * 37) % 360},60%,50%)`)]),
  );

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="512" height="512"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const shapeAt = ${shape.toString()};
const svgOfParts = ${svgOf.toString()};
const gl = document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true});
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const r = createRenderer(gl, shaders, {}); r.setViewport(512,512);

// Instrument: count draws and the state changes BETWEEN them. State changes are the thing a
// cross-bundle batcher would remove; draws alone understate the cost.
let draws=0, progSwitch=0, texBinds=0, lastProg=null;
const _da=gl.drawArrays.bind(gl), _dai=gl.drawArraysInstanced.bind(gl);
const _up=gl.useProgram.bind(gl), _bt=gl.bindTexture.bind(gl);
gl.drawArrays=(...a)=>{draws++;_da(...a);};
gl.drawArraysInstanced=(...a)=>{draws++;_dai(...a);};
gl.useProgram=(p)=>{ if(p!==lastProg){progSwitch++;lastProg=p;} _up(p); };
gl.bindTexture=(...a)=>{texBinds++;_bt(...a);};

// Sprite sheet: ONE bundle holding K id'd top-level groups, each drawn individually via
// drawSprite (a subset draw of the shared bundle). This is the existing API's answer to
// "share data across disjoint content" — no atlasing work needed, the sheet IS the atlas.
window.__runSplit = async (sheetK, drawK, lb) => {
  r.setLoopBlinnFill(lb ? 'on' : 'off');
  const parts = [];
  for (let i = 0; i < sheetK; i++)
    parts.push('<g id="s' + i + '">' + shapeAt(60 + (i % 8) * 55, 60 + Math.floor(i / 8) * 55, 22,
      'hsl(' + (i * 37 % 360) + ',60%,50%)') + '</g>');
  const sheet = createBundle(gl, await importSvg(svgOfParts(parts), { preserveViewport: true }));
  r.prepareBundle && r.prepareBundle(sheet);
  if (r.awaitLbReady) await r.awaitLbReady(sheet);
  const paint = () => { r.beginFrame([1,1,1,1]);
    for (let i = 0; i < drawK; i++) r.drawSprite(sheet, 's' + i, {}); r.endFrame(); };
  paint();
  const fence = () => { const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0]; };
  let best=1e9;
  for(let rep=0;rep<9;rep++){ const t0=performance.now(); for(let f=0;f<20;f++) paint(); fence();
    best=Math.min(best,(performance.now()-t0)/20); }
  sheet.dispose();
  return { sheetK, drawK, ms: best, usPerDraw: best*1000/drawK };
};

window.__runSheet = async (K, lb, instanced) => {
  r.setLoopBlinnFill(lb ? 'on' : 'off');
  const parts = [];
  for (let i = 0; i < K; i++)
    parts.push('<g id="s' + i + '">' + shapeAt(60 + (i % 8) * 55, 60 + Math.floor(i / 8) * 55, 22,
      'hsl(' + (i * 37 % 360) + ',60%,50%)') + '</g>');
  const sheet = createBundle(gl, await importSvg(svgOfParts(parts), { preserveViewport: true }));
  r.prepareBundle && r.prepareBundle(sheet);
  if (r.awaitLbReady) await r.awaitLbReady(sheet);
  const paint = () => {
    r.beginFrame([1,1,1,1]);
    if (instanced && r.drawSpriteInstanced) {
      for (let i = 0; i < K; i++) r.drawSpriteInstanced(sheet, 's' + i, [{ worldMatrix: [1,0,0,0,1,0,0,0,1] }], {});
    } else {
      for (let i = 0; i < K; i++) r.drawSprite(sheet, 's' + i, {});
    }
    r.endFrame();
  };
  const whole = () => { r.beginFrame([1,1,1,1]); r.drawBundle(sheet, {}); r.endFrame(); };
  paint(); whole();
  draws=0; progSwitch=0; texBinds=0; lastProg=null;
  paint();
  const out = { draws, progSwitch, texBinds, bundles: K };
  draws=0; whole(); out.wholeDraws = draws;
  // Same content both ways => apples-to-apples. min-of-9 over runs of 20 frames (performance.now
  // is 0.1ms-clamped), arms interleaved so GPU clock ramp hits both equally.
  const fence = () => { const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0]; };
  const timeIt = (fn) => { let best=1e9;
    for(let rep=0;rep<9;rep++){ const t0=performance.now(); for(let f=0;f<20;f++) fn(); fence();
      best=Math.min(best,(performance.now()-t0)/20); } return best; };
  let msSprites=1e9, msWhole=1e9;
  for (let i=0;i<3;i++){ msSprites=Math.min(msSprites,timeIt(paint)); msWhole=Math.min(msWhole,timeIt(whole)); }
  out.msSprites = msSprites; out.msWhole = msWhole;
  sheet.dispose();
  return out;
};

window.__run = async (scene, lb) => {
  r.setLoopBlinnFill(lb ? 'on' : 'off');
  const bundles = [];
  for (const svg of scene.svgs) bundles.push(createBundle(gl, await importSvg(svg)));
  const mounts = scene.mounts || 1;   // >1 => draw the SAME bundle N times at different transforms
  for (const b of bundles) { r.prepareBundle && r.prepareBundle(b); }
  if (r.awaitLbReady) { for (const b of bundles) await r.awaitLbReady(b); }
  // warm (compile variants etc.) so the counted frame is steady-state
  const paint=()=>{ r.beginFrame([1,1,1,1]);
    for(const b of bundles) for(let m=0;m<mounts;m++)
      r.drawBundle(b,{worldMatrix:[1,0,0,0,1,0,(m%8)*40,Math.floor(m/8)*40,1]});
    r.endFrame(); };
  paint();
  draws=0; progSwitch=0; texBinds=0; lastProg=null;
  paint();
  const out={draws,progSwitch,texBinds,bundles:bundles.length*mounts};
  for(const b of bundles) b.dispose();
  return out;
};
window.__ready=true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
// HEADLESS EVEN ON THE GPU. Headless Chrome reaches the real GPU: ANGLE (Apple, ANGLE Metal
// Renderer) reports and TIMES the same headless or headful.
// A window is not free to the person running this: macOS CLAMPS --window-position (measured:
// screenX/Y 83,65 whatever you pass), so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const browser = await launchBrowser({
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=metal'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page-err]', e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000 });

const scenes = [
  ['1 bundle, 32 shapes', { svgs: [manyShapesOneBundle(32)] }],
  ['32 bundles, disjoint', { svgs: disjointBundles(32) }],
  ['32 bundles, all overlapping', { svgs: overlappingBundles(32) }],
  ['64 bundles, disjoint', { svgs: disjointBundles(64) }],
  ['1 bundle x 32 MOUNTS', { svgs: [svgOf([shape(40, 40, 22, '#38c')])], mounts: 32 }],
];
const rows = [];
for (const [name, scene] of scenes) {
  for (const lb of [true, false]) {
    rows.push([
      `${name} [${lb ? 'LB' : 'Slug'}]`,
      await page.evaluate((s, l) => window.__run(s, l), scene, lb),
    ]);
  }
}
for (const K of [4, 8, 16, 32, 64]) {
  for (const lb of [true, false]) {
    rows.push([
      `${K} sprites, ONE sheet [${lb ? 'LB' : 'Slug'}]`,
      await page.evaluate((k, l) => window.__runSheet(k, l, false), K, lb),
    ]);
  }
}
const split = [];
for (const [sk, dk] of [
  [64, 8],
  [8, 8],
  [64, 64],
  [64, 32],
  [32, 32],
])
  split.push(await page.evaluate((a, b, l) => window.__runSplit(a, b, l), sk, dk, true));
await browser.close();
server.close();
console.log('\n  DISCRIMINATOR [LB] — is the per-draw cost driven by BUNDLE SIZE or CALL COUNT?');
console.log('  sheet shapes | drawn | ms/frame | us/draw');
for (const s of split)
  console.log(
    `  ${String(s.sheetK).padStart(12)} | ${String(s.drawK).padStart(5)} | ${s.ms.toFixed(3).padStart(8)} | ${s.usPerDraw.toFixed(1).padStart(7)}`,
  );
console.log(
  '  If us/draw tracks SHEET SHAPES (64/8 ~ 64/64, not ~ 8/8), each drawSprite scans the',
);
console.log('  whole bundle => O(bundleShapes x calls). If it tracks DRAWN, the cost is per-call.');

console.log('GL draw calls + state changes for ONE steady-state frame\n');
console.log('  scene                              | bundles | draws | progSwitch | texBinds');
for (const [name, r] of rows) {
  console.log(
    `  ${name.padEnd(34)} | ${String(r.bundles).padStart(7)} | ${String(r.draws).padStart(5)} | ${String(r.progSwitch).padStart(10)} | ${String(r.texBinds).padStart(8)}`,
  );
}
console.log(
  '\n  SPRITE SHEET — data ALREADY shared (one bundle, one texture set), so this is purely',
);
console.log('  the cost of not coalescing consecutive same-bundle draws:');
for (const [name, r] of rows) {
  if (r.msSprites === undefined) continue;
  console.log(
    `  ${name.padEnd(34)} | ${r.draws} draws ${r.msSprites.toFixed(3)}ms  vs  ${r.wholeDraws} draw ${r.msWhole.toFixed(3)}ms` +
      `  => ${(r.msSprites - r.msWhole).toFixed(3)}ms on the table (${(((r.msSprites - r.msWhole) / Math.max(r.draws - 1, 1)) * 1000).toFixed(1)}us/draw)`,
  );
}
console.log(
  '\n  Read: "1 bundle, 32 shapes" is the already-batched baseline. If the 32-bundle rows',
);
console.log('  cost ~32x more draws, cross-bundle batching has real headroom; if the renderer');
console.log('  already collapses them, it does not. The disjoint row is the one a reordering');
console.log('  batcher could legally collapse — the overlapping row is order-locked by OVER.');
