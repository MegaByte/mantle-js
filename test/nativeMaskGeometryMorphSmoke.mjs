// nativeMaskGeometryMorphSmoke.mjs — an animated <mask>'s geometry
// interpolates through a native morph (the reveal-wipe path).
//
// A mask layer shape is excluded from the positional shapeElByIndex walk
// (it's not a rendered leaf), so a morph's per-frame interpolated mask
// `pathD` would otherwise have nowhere to land and the mask would freeze at
// the source pose while the shapes lerp smoothly. The importer exposes mask
// svgId→row range in bundle.clipperRows, and the native scene routes a
// layer-shape override to the <mask>'s child <path>. This morphs a mask
// whose reveal rect grows 12→52 and asserts the mask child's bottom edge
// lerps continuously (not stepped).

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MROOT = path.resolve(__dirname, '..');

// Two poses: a box revealed by a mask whose bottom edge moves 12 → 52.
const pose = (maskBottom) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60">
  <defs><mask id="rev"><path d="M0 0 L100 0 L100 ${maskBottom} L0 ${maskBottom} Z" fill="#fff"/></mask></defs>
  <g mask="url(#rev)"><rect x="10" y="10" width="80" height="40" fill="#0000ff"/></g>
</svg>`;

const HTML = `<!DOCTYPE html><html><body><div id="host"></div>
<script type="module">
import { importSvg } from '/src/svg/importer.js';
import { createNativeScene, createNativeMorph } from '/src/fallback/index.js';
const o = { retainSource:true, keepInvisibleShapes:true };
const a = await importSvg(${JSON.stringify(pose(12))}, o);
const b = await importSvg(${JSON.stringify(pose(52))}, o);
const scene = createNativeScene(document.getElementById('host'), { coordinateSpace:'bundle' });
const morph = createNativeMorph(a, b);
const ID = new Float32Array([1,0,0,0,1,0,0,0,1]);
function maskBottom(){
  const mp = scene.svg.querySelector('mask path'); if(!mp) return null;
  const nums = [...(mp.getAttribute('d')||'').matchAll(/(-?\\d+\\.?\\d*)/g)].map(m=>+m[1]);
  let maxY=-1e9; for(let i=1;i<nums.length;i+=2) if(nums[i]>maxY) maxY=nums[i];
  return +maxY.toFixed(3);
}
function frame(t){ morph.setT(t); scene.beginFrame([0,0,0,0]);
  scene.drawBundle(morph.bundle, { worldMatrix: ID, overrides: morph.overrides }); scene.endFrame(); }
const out=[];
for(const t of [0,0.25,0.5,0.75,1.0]){ frame(t); out.push({ t, maskBottom: maskBottom() }); }
window.__out = out; window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, {'content-type':'text/html'}); res.end(HTML); return; }
  let p = decodeURIComponent(req.url.split('?')[0]);
  try { res.writeHead(200, {'content-type':'text/javascript'}); res.end(readFileSync(path.join(MROOT, p))); }
  catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30000 });
  const got = await page.waitForFunction('window.__ready === true', { timeout: 30000 }).then(()=>1).catch(()=>0);
  if (!got) { fail('page did not become ready'); }
  else {
    const out = await page.evaluate('window.__out');
    const ys = out.map(x => x.maskBottom);
    console.log('mask bottom edge across morph:', JSON.stringify(ys));
    if (ys.every(y => y != null)) ok('mask child element addressed (geometry override landed)');
    else fail('mask child not addressed: ' + ys);
    if (new Set(ys).size >= 4) ok('mask geometry CHANGES per t — interpolates (not frozen/stepped)');
    else fail('mask geometry barely changes — frozen/snapping: ' + ys);
    const mono = ys.every((y, i) => i === 0 || y >= ys[i-1] - 0.01);
    if (mono && ys[0] < 20 && ys[ys.length-1] > 44)
      ok(`mask bottom lerps 12→52 monotonically (${ys[0]}→${ys[ys.length-1]}) — smooth reveal wipe`);
    else fail('mask bottom not monotonic 12→52: ' + ys);
  }
} finally { await browser.close(); server.close(); }
console.log(failures ? `\n${failures} FAILURE(S)` : '\nNATIVE-MASK-GEOMETRY-MORPH PASS');
process.exit(failures ? 1 : 0);
