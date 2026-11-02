// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// A matched-shape morph stays correctly addressed when the bundle has
// expanded <text> glyphs AND a <mask>.
//
// Two poses: a box whose apex Y moves (2 → 20) plus masked text. The box is
// matched shape 0; the morph must write the box's lerped geometry to the BOX
// element, not to the mask's <path> in <defs> or to a glyph. Asserts the box
// element's apex Y lerps MONOTONICALLY 2 → 20 across the bracket, with a
// constant visible-element count and no slot accumulation.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { fontFixture, requireAsset } from './_assets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MROOT = path.resolve(__dirname, '..');
const fontB64 = readFileSync(requireAsset(fontFixture('roboto-regular.ttf'))).toString('base64');

// Pose A: box apex at y=2. Pose B: box apex at y=20. Masked text in both.
const pose = (apexY) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60">
  <defs><mask id="m"><path d="M0 0 L120 0 L120 ${30 + apexY} L0 ${30 + apexY} Z" fill="#fff"/></mask></defs>
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
function frame(t){ morph.setT(t); scene.beginFrame([0,0,0,0]);
  scene.drawBundle(morph.bundle,{worldMatrix:ID, overrides:morph.overrides}); scene.endFrame(); }
const samples=[];
for(const t of [0,0.25,0.5,0.75,1.0]){ frame(t); const vp=visPaths();
  const box=vp[0]?vp[0].getAttribute('d'):''; const m=box.match(/M\\s*60\\s+([\\d.]+)/);
  samples.push({ t, slots: scene.svg.children.length, nVis: vp.length, boxApexY: m?+m[1]:null }); }
window.__samples = samples; window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  try {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(readFileSync(path.join(MROOT, p)));
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

const browser = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('  [console]', m.text());
});
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30000 });
  const got = await page
    .waitForFunction('window.__ready === true', { timeout: 30000, polling: 100 })
    .then(() => 1)
    .catch(() => 0);
  if (!got) {
    fail('page did not become ready');
  } else {
    const s = await page.evaluate('window.__samples');
    console.log('samples:', JSON.stringify(s));
    const ys = s.map((x) => x.boxApexY);
    if (s.every((x) => x.slots === 1)) ok('one slot (no accumulation)');
    else fail('slot count varied: ' + s.map((x) => x.slots));
    if (s.every((x) => x.nVis === s[0].nVis && x.nVis >= 3))
      ok(`visible-element count constant (${s[0].nVis})`);
    else fail('visible count varied: ' + s.map((x) => x.nVis));
    if (ys.every((y) => y != null)) ok('box element addressed at every t (apex Y present)');
    else fail('box apex Y missing at some t (addressing lost): ' + ys);
    // Monotonic increasing 2 → 20 (the box element gets the BOX morph, not
    // the mask's frozen geometry or a glyph).
    const mono = ys.every((y, i) => i === 0 || y >= ys[i - 1] - 0.01);
    if (mono && ys[0] < 5 && ys[ys.length - 1] > 15)
      ok(
        `box apex Y lerps monotonically ${ys[0]}→${ys[ys.length - 1]} (matched-shape morph correct)`,
      );
    else fail('box apex Y not monotonic 2→20 (desync / triangle-backwards): ' + ys);
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nNATIVE-TEXT-MASK-MORPH PASS');
process.exit(failures ? 1 : 0);
