// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeMorphGroupRasterSmoke.mjs: pixels for transformed native morphs. A native morph inside a transformed group (and <use>, an own transform, a stroke
// that changes width under a scale) is rasterized by the browser and compared with the browser's own rendering of the same pose
// imported as a static svg: t = 0 is pose A, t = 1 pose B, t = 0.5 the pose authored at the average geometry (exact for lines, cubics
// and a circle whose radius and center are averaged). A morph shape left in bundle coordinates would sit displaced by the group's transform.
// Both sides go through the same <img> -> canvas path at 100x100, so antialiasing is the browser's on both.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
import { CASES, PA, PB, MID, shapes } from './_nativeMorphGroupArt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svgOf = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${body}</svg>`;
const ALL = {
  ...CASES,
  stroked: (P, sw = 2) => `<g transform="rotate(15) scale(1.4 0.8)">${shapes(P, '', sw)}</g>`,
};
const POSES = {};
for (const [name, mk] of Object.entries(ALL)) {
  const sw = name === 'stroked' ? [2, 6, 4] : [undefined, undefined, undefined];
  POSES[name] = [svgOf(mk(PA, sw[0])), svgOf(mk(PB, sw[1])), svgOf(mk(MID, sw[2]))];
}

const HTML = `<!DOCTYPE html><html><body><div id="host"></div><script type="module">
import { importSvg, createNativeScene, createNativeMorph, createNativeOverrideTable } from '/src/index.js';
const POSES = ${JSON.stringify(POSES)};
async function raster(xml) {
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); await img.decode();
  const c = document.createElement('canvas'); c.width = c.height = 100; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 100, 100);
  return Array.from(g.getImageData(0, 0, 100, 100).data);
}
window.__case = async (name) => {
  const [a, b] = await Promise.all([importSvg(POSES[name][0], { retainSource: true }), importSvg(POSES[name][1], { retainSource: true })]);
  const scene = createNativeScene(document.createElement('div')); scene.setViewport(100, 100);
  const morph = createNativeMorph(a, b);
  const out = [];
  for (const [t, k] of [[0, 0], [0.5, 2], [1, 1]]) {
    morph.setT(t);
    scene.beginFrame([0, 0, 0, 0]); scene.drawBundle(morph.bundle, { overrides: morph.overrides }); scene.endFrame();
    out.push({ t, native: await raster(new XMLSerializer().serializeToString(scene.svg)), ref: await raster(POSES[name][k]) });
  }
  return out;
};
window.__groupOverride = async (source, expected, values) => {
  const b = await importSvg(source, { retainSource: true, preserveViewport: true });
  const scene = createNativeScene(document.createElement('div')); scene.setViewport(100, 100);
  const table = createNativeOverrideTable(b), out = [];
  try {
    for (const value of values) {
      table.clearAll();
      if (value) for (const [id, override] of value) table.set(id, override);
      scene.beginFrame([0, 0, 0, 0]); scene.drawBundle(b, { overrides: table }); scene.endFrame();
      out.push(await raster(new XMLSerializer().serializeToString(scene.svg)));
    }
    return { images: out, reference: await raster(expected), original: await raster(source) };
  } finally { table.dispose(); scene.dispose(); }
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
let failures = 0;
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
for (const name of Object.keys(ALL)) {
  const frames = await page.evaluate((n) => window.__case(n), name);
  for (const { t, native, ref } of frames) {
    let sum = 0,
      big = 0,
      painted = 0;
    for (let i = 0; i < native.length; i += 4) {
      const d = Math.max(
        Math.abs(native[i] - ref[i]),
        Math.abs(native[i + 1] - ref[i + 1]),
        Math.abs(native[i + 2] - ref[i + 2]),
        Math.abs(native[i + 3] - ref[i + 3]),
      );
      sum += d;
      if (d > 48) big++;
      if (ref[i + 3] > 0) painted++;
    }
    const mean = sum / (native.length / 4);
    // A displaced shape differs over its whole footprint (hundreds of pixels); edge antialiasing differs on a few (under 3% of the painted area).
    if (painted > 300 && big <= 0.03 * painted + 10)
      console.log(
        `ok ${name} t=${t}: ${painted} painted pixels, ${big} differ by more than 48/255 (mean ${mean.toFixed(3)})`,
      );
    else {
      failures++;
      console.error(
        `FAIL ${name} t=${t}: ${painted} painted pixels, ${big} differ by more than 48/255 (mean ${mean.toFixed(3)})`,
      );
    }
  }
}
const filterDefs = '<defs><filter id="f"><feGaussianBlur stdDeviation="1.5"/></filter></defs>';
const content = (opacity = 1, tinted = false) =>
  '<path id="a" d="M15 15h25v25h-25Z" fill="' +
  (tinted ? '#800000' : '#ff0000') +
  '" opacity="' +
  opacity +
  '"/><path id="b" d="M30 30h25v25h-25Z" fill="#00aa00" opacity="' +
  opacity +
  '"/>';
const grouped = (c, original = '') =>
  '<g id="H" transform="' +
  original +
  '"><g id="G" filter="url(#f)" opacity=".8">' +
  c +
  '</g></g>';
const makeOverrideCase = (
  name,
  value,
  transform = '',
  original = '',
  opacity = 1,
  tinted = false,
  outer = null,
) => ({
  name,
  source: svgOf(filterDefs + grouped(content(), original)),
  expected: svgOf(
    filterDefs +
      (transform ? '<g transform="' + transform + '">' : '') +
      grouped(content(opacity, tinted), original) +
      (transform ? '</g>' : ''),
  ),
  values: [['G', value], ...(outer ? [['H', outer]] : [])],
});
for (const c of [
  makeOverrideCase('filtered translation', { localPosition: [12, 4] }, 'translate(12 4)'),
  makeOverrideCase('filtered scale', { localScale: [1.2, 0.8] }, 'scale(1.2 .8)'),
  makeOverrideCase(
    'nested authored transform',
    { localPosition: [12, 4] },
    'translate(12 4)',
    'translate(5 3) rotate(10) scale(.8 .9)',
  ),
  makeOverrideCase(
    'two active groups',
    { localPosition: [12, 4] },
    'rotate(12) translate(12 4)',
    'translate(5 3) scale(.8 .9)',
    1,
    false,
    { localRotation: (12 * Math.PI) / 180 },
  ),
  makeOverrideCase('filtered visibility', { visibility: 0.5 }, '', '', 0.5),
  makeOverrideCase(
    'filtered tint and visibility',
    { visibility: 0.5, tint: [0.5, 1, 0.25, 0.5] },
    '',
    '',
    0.25,
    true,
  ),
  makeOverrideCase('filtered hidden', { visibility: 0 }, '', '', 0),
]) {
  const row = await page.evaluate(
    (c) => window.__groupOverride(c.source, c.expected, [c.values, null, c.values]),
    c,
  );
  const delta = (a, b) => {
    let max = 0;
    for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
    return max;
  };
  const max = Math.max(
    delta(row.images[0], row.reference),
    delta(row.images[1], row.original),
    delta(row.images[2], row.reference),
  );
  if (max <= 2) console.log('ok native ' + c.name + ': max ' + max + ', clear/reapply restored');
  else {
    failures++;
    console.error('FAIL native ' + c.name + ': max ' + max);
  }
}
await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nnativeMorphGroupRasterSmoke: all checks passed');
