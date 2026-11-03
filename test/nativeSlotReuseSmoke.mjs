// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeSlotReuseSmoke.mjs -- what a native (no-WebGL) frame writes into its DOM, counted by a MutationObserver in a real
// browser. A slow device's SVG fallback restyles and repaints for every DOM write, and decodes each new <image> again.
//
// Given a raster drawn in place, the frame mutates nothing; moved, only its transform; faded, only its opacity, and the
// fade's end removes only that. Given a raster or a bundle joining, leaving or swapping places in the middle of the draw
// order (alone or between the other kind), the draws after it keep their nodes: only a raster or bundle the last frame
// did not draw builds an <image> or a clone. Each sequence's last frame draws the same pixels as a fresh scene drawing
// that frame, and every mounted <image> shows its own draw's source. A raw canvas redrawn shows its new pixels, and a
// canvas createImage token's href is a data: URL, so the frame's own exportFrameSVG() still carries the raster.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = `<!DOCTYPE html><html><body><script type="module">
import { importSvg, createNativeScene } from '/src/index.js';
const W = 80, H = 40;
const FILLS = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff'];
const svgOf = (fill) => '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" fill="' + fill + '"/></svg>';
const pngOf = (fill) => {
  const c = document.createElement('canvas'); c.width = c.height = 10;
  const g = c.getContext('2d'); g.fillStyle = fill; g.fillRect(0, 0, 10, 10);
  return c.toDataURL('image/png');
};
const RASTERS = FILLS.map(pngOf);
const BUNDLES = await Promise.all(FILLS.map((f) => importSvg(svgOf(f), { retainSource: true })));
const matrix = (tx, ty) => new Float32Array([1, 0, 0, 0, 1, 0, tx, ty, 1]);
// A draw is 'r<n>' (raster n) or 'b<n>' (bundle n), placed by its source so a reorder moves no pixels, or an object
// { k, s, tx, alpha } for the attribute cases.
const spec = (d) => (typeof d === 'string' ? { k: d[0], s: +d.slice(1) } : d);
function drawAll(scene, draws) {
  scene.beginFrame([1, 1, 1, 1]);
  for (const raw of draws) {
    const d = spec(raw);
    const tx = d.tx ?? d.s * 15, extra = d.alpha === undefined ? {} : { alpha: d.alpha };
    if (d.k === 'b') scene.drawBundle(BUNDLES[d.s], { worldMatrix: matrix(tx, 20), ...extra });
    else scene.drawImage(RASTERS[d.s], { dstRect: [0, 0, 10, 10], worldMatrix: matrix(tx, 0), ...extra });
  }
  scene.endFrame();
}
const newScene = () => {
  const s = createNativeScene(document.createElement('div'), { coordinateSpace: 'viewport' });
  s.setViewport(W, H);
  return s;
};
const scenes = new Map();
const seen = new WeakSet();
// The scene's top-level draws in document order: 'r<n>' for a raster wrapper (by its <image>'s href), 'b<n>' for a
// bundle clone (by its rect's fill).
const mounted = (scene) => [...scene.svg.children].filter((c) => c.localName === 'g').map((c) => {
  const img = c.querySelector('image');
  if (img) return 'r' + RASTERS.indexOf(img.getAttribute('href'));
  const rect = c.querySelector('rect');
  return 'b' + FILLS.indexOf(rect && rect.getAttribute('fill'));
});
window.__frame = (name, draws) => {
  if (!scenes.has(name)) scenes.set(name, newScene());
  const scene = scenes.get(name);
  const observer = new MutationObserver(() => {});
  observer.observe(scene.svg, { subtree: true, childList: true, attributes: true });
  drawAll(scene, draws);
  const records = observer.takeRecords();
  observer.disconnect();
  const changes = [...new Set(records.map((r) => r.type === 'attributes' ? r.target.localName + '.' + r.attributeName : r.target.localName + ' children'))].sort();
  let images = 0, clones = 0;
  for (const c of scene.svg.children) {
    if (c.localName !== 'g' || seen.has(c)) continue;
    seen.add(c);
    if (!c.querySelector('image')) clones++;
  }
  for (const img of scene.svg.querySelectorAll('image')) if (!seen.has(img)) { seen.add(img); images++; }
  return { changes, records: records.length, images, clones, mounted: mounted(scene), imageCount: scene.svg.querySelectorAll('image').length };
};
async function pixelsOf(svgOrText) {
  const xml = typeof svgOrText === 'string' ? svgOrText : new XMLSerializer().serializeToString(svgOrText);
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  await img.decode();
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0, W, H);
  return g.getImageData(0, 0, W, H).data;
}
// Pixels that differ between the named scene and a fresh scene drawing the same frame.
window.__sameAsFresh = async (name, draws) => {
  const fresh = newScene();
  drawAll(fresh, draws);
  const a = await pixelsOf(scenes.get(name).svg), b = await pixelsOf(fresh.svg);
  let differ = 0, ink = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) differ++;
    if (a[i] < 250 || a[i + 1] < 250 || a[i + 2] < 250) ink++;
  }
  return { differ, ink };
};
window.__canvas = async () => {
  const scene = newScene();
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 10;
  const g = canvas.getContext('2d');
  const paint = (fill) => { g.fillStyle = fill; g.fillRect(0, 0, 10, 10); };
  const at = (px, x, y) => Array.from(px.slice((y * W + x) * 4, (y * W + x) * 4 + 3));
  paint('#00ff00');
  const token = scene.createImage(canvas);
  scene.beginFrame([1, 1, 1, 1]); scene.drawImage(token, { dstRect: [0, 0, 10, 10] }); scene.endFrame();
  const tokenHref = scene.svg.querySelector('image').getAttribute('href');
  const exported = at(await pixelsOf(await scene.exportFrameSVG()), 5, 5);
  paint('#0000ff');
  scene.beginFrame([1, 1, 1, 1]); scene.drawImage(token, { dstRect: [0, 0, 10, 10] }); scene.drawImage(canvas, { dstRect: [20, 0, 10, 10] }); scene.endFrame();
  const blue = at(await pixelsOf(scene.svg), 25, 5);
  paint('#ff0000');
  scene.beginFrame([1, 1, 1, 1]); scene.drawImage(canvas, { dstRect: [20, 0, 10, 10] }); scene.endFrame();
  const red = at(await pixelsOf(scene.svg), 25, 5);
  return { dataHref: tokenHref.startsWith('data:'), exported, blue, red, imageCount: scene.svg.querySelectorAll('image').length };
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
    const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    const b = readFileSync(f);
    res.writeHead(200, {
      'content-type': f.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : 'text/plain; charset=utf-8',
    });
    res.end(b);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let failures = 0;
const expect = (message, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) console.log('ok ' + message);
  else {
    failures++;
    console.error(
      `FAIL ${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
};
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
const frame = (name, draws) => page.evaluate((n, d) => window.__frame(n, d), name, draws);
const r0 = (tx, alpha) => ({ k: 'r', s: 0, tx, ...(alpha === undefined ? {} : { alpha }) });

// Attribute writes of a raster drawn again.
await frame('attrs', [r0(0), r0(50)]);
const still = await frame('attrs', [r0(0), r0(50)]);
expect('Given two rasters drawn in place again, then the frame mutates no DOM', still.changes, []);
expect(
  'Given a raster moves, then only its transform changes',
  (await frame('attrs', [r0(0), r0(60)])).changes,
  ['image.transform'],
);
expect(
  'Given a raster fades, then only its opacity changes',
  (await frame('attrs', [r0(0, 0.5), r0(60)])).changes,
  ['image.opacity'],
);
expect(
  'Given its fade ends, then only its opacity is removed',
  (await frame('attrs', [r0(0), r0(60)])).changes,
  ['image.opacity'],
);
expect(
  'Given a raster is no longer drawn, then its image leaves the scene',
  (await frame('attrs', [r0(0)])).imageCount,
  1,
);

// Draws joining, leaving and swapping in the middle of the order. `images` and `clones` count the nodes the frame built.
const SEQUENCES = [
  [
    'rasters',
    [
      ['r0', 'r1', 'r2', 'r3'],
      ['a raster leaves the middle', ['r0', 'r2', 'r3'], { images: 0, clones: 0 }],
      ['a raster joins the middle', ['r0', 'r4', 'r2', 'r3'], { images: 1, clones: 0 }],
      ['two rasters swap places', ['r0', 'r2', 'r4', 'r3'], { images: 0, clones: 0 }],
      ['a raster changes source in place', ['r0', 'r1', 'r4', 'r3'], { images: 1, clones: 0 }],
    ],
  ],
  [
    'bundles',
    [
      ['b0', 'b1', 'b2', 'b3'],
      ['a bundle leaves the middle', ['b0', 'b2', 'b3'], { images: 0, clones: 0 }],
      ['a bundle joins the middle', ['b0', 'b4', 'b2', 'b3'], { images: 0, clones: 1 }],
      ['two bundles swap places', ['b0', 'b2', 'b4', 'b3'], { images: 0, clones: 0 }],
    ],
  ],
  [
    'mixed',
    [
      ['b0', 'r1', 'b2', 'r3'],
      ['a raster between bundles leaves', ['b0', 'b2', 'r3'], { images: 0, clones: 0 }],
      ['a bundle joins ahead of all', ['b4', 'b0', 'b2', 'r3'], { images: 0, clones: 1 }],
      ['a raster joins between bundles', ['b4', 'r1', 'b0', 'b2', 'r3'], { images: 1, clones: 0 }],
      [
        'a raster moves ahead of a bundle',
        ['b4', 'r1', 'b0', 'r3', 'b2'],
        { images: 0, clones: 0 },
      ],
    ],
  ],
];
const measured = [];
for (const [name, [first, ...steps]] of SEQUENCES) {
  await frame(name, first);
  let last = first;
  for (const [what, draws, want] of steps) {
    const got = await frame(name, draws);
    measured.push(
      `${what}: ${got.records} mutation records, ${got.images} <image>, ${got.clones} clones`,
    );
    expect(
      `Given ${what}, then the frame builds only what the last frame did not draw`,
      { images: got.images, clones: got.clones },
      want,
    );
    expect(`Given ${what}, then the scene mounts the draws in draw order`, got.mounted, draws);
    expect(
      `Given ${what}, then each raster draw has one <image>`,
      got.imageCount,
      draws.filter((d) => d[0] === 'r').length,
    );
    last = draws;
  }
  const px = await page.evaluate((n, d) => window.__sameAsFresh(n, d), name, last);
  expect(
    `Given the ${name} sequence, then its last frame draws the pixels a fresh scene draws (${px.ink} px of ink)`,
    px.differ,
    0,
  );
}
for (const m of measured) console.log('  measured ' + m);

const canvas = await page.evaluate(() => window.__canvas());
expect(
  'Given a canvas createImage token, then its <image> draws from a data: URL',
  canvas.dataHref,
  true,
);
expect(
  "Given a canvas token's frame, then the frame's exportFrameSVG() draws the raster",
  canvas.exported,
  [0, 255, 0],
);
expect(
  'Given a raw canvas redrawn, then the next frame shows its new pixels',
  canvas.blue,
  [0, 0, 255],
);
expect(
  'Given it is redrawn again and drawn alone, then it shows those pixels with one <image>',
  [canvas.red, canvas.imageCount],
  [[255, 0, 0], 1],
);

await browser.close();
server.close();
if (failures === 0) console.log('\nnativeSlotReuseSmoke: PASS');
else console.log(`\nnativeSlotReuseSmoke: FAIL (${failures})`);
process.exit(failures ? 1 : 0);
