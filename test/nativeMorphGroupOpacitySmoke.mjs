// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeMorphGroupOpacitySmoke -- leaf opacity on the no-WebGL fallback: the native morph (createNativeMorph, the browser's own SVG engine
// drawing the source markup) fades a fill+stroke leaf's opacity as ONE element, across 1 as well (.5 -> 1, 1 -> .5) and within .5 -> .8.
//
// The leaf's group rows have no element of their own in the source markup (the leaf is the element), so the morph drives the leaf's
// opacity from the leaf's rows (override `elementOpacity`), and for a pose that has no group (1 -> .5) from the rows the target's
// group stands for. Each cell draws the morph at t and the authored pose of that t through the same scene, 1x, on white, and they
// must agree to within 2/255; the one-after-the-other picture (fill-opacity and stroke-opacity) must differ by at least 24/255.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const XA = 20,
  XB = 40,
  TS = [0, 0.25, 0.5, 0.75, 1];
const leaf = (x, extra, id) =>
  `<path${id} d="M${x} 20h64v64h-64Z" fill="#ff0000" stroke="#0000ff" stroke-width="16"${extra}/>`;
const doc = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${body}</svg>`;
const CELLS = [];
for (const named of [true, false])
  for (const [oa, ob] of [
    [0.5, 1],
    [0.5, 0.8],
    [1, 0.5],
  ])
    for (const t of TS) {
      const a = oa + (ob - oa) * t,
        x = XA + (XB - XA) * t,
        id = named ? ' id="a"' : '',
        op = (v) => (v === 1 ? '' : ` opacity="${v}"`);
      CELLS.push({
        name: `${named ? 'named' : 'unnamed'} ${oa} -> ${ob} at t=${t}`,
        t,
        a,
        from: doc(leaf(XA, op(oa), id)),
        to: doc(leaf(XB, op(ob), id)),
        control: doc(leaf(x, op(a), id)),
        old: doc(leaf(x, ` fill-opacity="${a}" stroke-opacity="${a}"`, id)),
      });
    }
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
<script type="module">
import { importSvg, createNativeScene, createNativeMorph } from '/src/index.js';
const ctx = document.getElementById('c').getContext('2d', { willReadFrequently: true });
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
async function shot(scene) {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(scene.svg)); });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 128, 128); ctx.drawImage(img, 0, 0, 128, 128);
  return b64(new Uint8Array(ctx.getImageData(0, 0, 128, 128).data.buffer));
}
window.__morph = async (from, to, t) => {
  const a = await importSvg(from, { retainSource: true }), b = await importSvg(to, { retainSource: true });
  const scene = createNativeScene(document.createElement('div')); scene.setViewport(128, 128);
  const m = createNativeMorph(a, b); m.setT(t);
  scene.beginFrame([1, 1, 1, 1]); scene.drawBundle(m.bundle, { overrides: m.overrides }); scene.endFrame();
  const r = await shot(scene); m.dispose(); return r;
};
window.__still = async (svg) => {
  const a = await importSvg(svg, { retainSource: true });
  const scene = createNativeScene(document.createElement('div')); scene.setViewport(128, 128);
  scene.beginFrame([1, 1, 1, 1]); scene.drawBundle(a); scene.endFrame();
  return shot(scene);
};
window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  try {
    const b = readFileSync(path.join(ROOT, decodeURIComponent(req.url.split('?')[0])));
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(b);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await openReady(page, `http://127.0.0.1:${server.address().port}/`, { ready: 'flag' });
const u8 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
let failures = 0;
for (const c of CELLS) {
  let svg, control, old;
  try {
    svg = u8(await page.evaluate((f, t, tt) => window.__morph(f, t, tt), c.from, c.to, c.t));
    control = u8(await page.evaluate((s) => window.__still(s), c.control));
    old = u8(await page.evaluate((s) => window.__still(s), c.old));
  } catch (e) {
    failures++;
    console.error('FAIL: ' + c.name + ': ' + e.message);
    continue;
  }
  const vsControl = maxDiff(svg, control),
    vsOld = maxDiff(svg, old),
    mid = c.a > 0.04 && c.a < 0.96;
  const line = `${c.name}: vs control ${vsControl}, vs old ${vsOld}`;
  if (vsControl > 2) {
    failures++;
    console.error('FAIL: ' + line + ' -- the native morph differs from the authored pose');
  } else if (mid && vsOld < 24) {
    failures++;
    console.error('FAIL: ' + line + ' -- vacuous');
  } else console.log('ok ' + line);
}
await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(
  '\nnativeMorphGroupOpacitySmoke: the native morph fades a fill+stroke leaf as one element',
);
