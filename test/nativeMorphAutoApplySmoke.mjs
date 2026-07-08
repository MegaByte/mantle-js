// nativeMorphAutoApplySmoke.mjs — drawBundle(morph.bundle) draws the
// tween on native even when the caller does not forward morph.overrides.
//
// On GL a shape morph bakes interpolated geometry into the bundle's mesh,
// so `drawBundle(morph.bundle)` alone animates. On native the tween lives
// in a separate override table; a caller that forgets to forward it would
// render the static src pose and the animation would snap pose-to-pose at
// bracket edges. createNativeMorph stashes its table on the bundle and the
// scene auto-applies it when no explicit table is passed, restoring the
// "just draw the bundle" parity.
//
// This draws without passing overrides and asserts the box still lerps.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MROOT = path.resolve(__dirname, '..');
const fontB64 = readFileSync(new URL('./font/fixtures/roboto-regular.ttf', import.meta.url)).toString('base64');

const pose = (apexY) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60">
  <defs><mask id="m"><rect x="0" y="0" width="120" height="60" fill="#fff"/></mask></defs>
  <g mask="url(#m)">
    <path d="M60 ${apexY} L80 ${apexY + 18} L40 ${apexY + 18} Z" fill="#0000ff"/>
    <text x="20" y="50" font-family="Roboto" font-size="16" fill="#ff0000">Hi</text>
  </g>
</svg>`;

const HTML = `<!DOCTYPE html><html><body><div id="host"></div>
<script type="module">
import { importSvg } from '/src/svg/importer.js';
import { MantleFontAsset } from '/src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '/src/font/textRun.js';
import { createNativeScene, createNativeMorph } from '/src/fallback/index.js';
const FONT = new MantleFontAsset(Uint8Array.from(atob('${fontB64}'), c => c.charCodeAt(0)));
const o = { retainSource:true, keepInvisibleShapes:true, fonts:{ Roboto: FONT }, svgTextLayout: buildSvgTextGlyphs };
const a = await importSvg(${JSON.stringify(pose(2))}, o);
const b = await importSvg(${JSON.stringify(pose(20))}, o);
const scene = createNativeScene(document.getElementById('host'), { coordinateSpace:'bundle' });
const morph = createNativeMorph(a, b);
const ID = new Float32Array([1,0,0,0,1,0,0,0,1]);
function visPaths(){ return [...scene.svg.querySelectorAll('path')].filter(p=>{
  for(let n=p.parentNode;n&&n!==scene.svg;n=n.parentNode){const t=n.tagName&&n.tagName.toLowerCase();
    if(t==='mask'||t==='defs'||t==='clippath')return false;} return true; }); }
// Draw without { overrides } — the auto-apply path under test.
function frame(t){ morph.setT(t); scene.beginFrame([0,0,0,0]);
  scene.drawBundle(morph.bundle, { worldMatrix: ID }); scene.endFrame(); }
const out=[];
for(const t of [0,0.25,0.5,0.75,1.0]){ frame(t); const vp=visPaths();
  const d=vp[0]?vp[0].getAttribute('d'):''; const m=d.match(/M\\s*60\\s+([\\d.]+)/);
  out.push({ t, boxApexY: m?+m[1]:null }); }
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
    const ys = out.map(x => x.boxApexY);
    console.log('box apex Y (no overrides passed):', JSON.stringify(ys));
    if (ys.every(y => y != null)) ok('box element addressed at every t');
    else fail('box apex Y missing: ' + ys);
    const distinct = new Set(ys).size;
    if (distinct >= 4) ok('geometry changes per t — tween auto-applied (not snapping to src pose)');
    else fail('box apex Y barely changes — morph NOT auto-applied (snapping): ' + ys);
    const mono = ys.every((y, i) => i === 0 || y >= ys[i-1] - 0.01);
    if (mono && ys[0] < 5 && ys[ys.length-1] > 15)
      ok(`monotonic 2→20 without forwarding overrides (${ys[0]}→${ys[ys.length-1]})`);
    else fail('not monotonic 2→20: ' + ys);
  }
} finally { await browser.close(); server.close(); }
console.log(failures ? `\n${failures} FAILURE(S)` : '\nNATIVE-MORPH-AUTO-APPLY PASS');
process.exit(failures ? 1 : 0);
