// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Check native slot reuse, attribute diffs and raster retention in a browser.
// Mutation counts cover steady draws and order changes; pixels are compared with
// fresh scenes. Canvas-token checks cover snapshots, export and URL disposal.
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
// A canvas token's blob: URL: its pixels, the export, an early draw, instanced raw canvases and disposal.
window.__tokens = async () => {
  const made = [], revoked = [];
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = (b) => { const u = create.call(URL, b); made.push(u); return u; };
  URL.revokeObjectURL = (u) => { revoked.push(u); return revoke.call(URL, u); };
  try {
    const scene = newScene();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 10;
    const g = canvas.getContext('2d');
    const paint = (fill) => { g.fillStyle = fill; g.fillRect(0, 0, 10, 10); };
    const at = (px, x, y) => Array.from(px.slice((y * W + x) * 4, (y * W + x) * 4 + 3));
    const frame = (draw) => { scene.beginFrame([1, 1, 1, 1]); draw(); scene.endFrame(); };
    paint('#00ff00');
    const token = scene.createImage(canvas);
    paint('#0000ff');
    await token.ready;
    frame(() => scene.drawImage(token, { dstRect: [0, 0, 10, 10] }));
    const href = scene.svg.querySelector('image').getAttribute('href');
    const bitmap = await createImageBitmap(await (await fetch(href)).blob());
    const probe = document.createElement('canvas'); probe.width = probe.height = 10;
    probe.getContext('2d').drawImage(bitmap, 0, 0);
    const pixels = Array.from(probe.getContext('2d').getImageData(5, 5, 1, 1).data.slice(0, 3));
    const text = await scene.exportFrameSVG();
    const exported = at(await pixelsOf(text), 5, 5);
    const early = scene.createImage(canvas);
    frame(() => { scene.drawImage(token, { dstRect: [0, 0, 10, 10] }); scene.drawImage(early, { dstRect: [20, 0, 10, 10] }); });
    const earlyHref = early.href;
    await early.ready;
    const observer = new MutationObserver(() => {});
    observer.observe(scene.svg, { subtree: true, attributes: true, attributeFilter: ['href'] });
    frame(() => { scene.drawImage(token, { dstRect: [0, 0, 10, 10] }); scene.drawImage(early, { dstRect: [20, 0, 10, 10] }); });
    const hrefWrites = observer.takeRecords().length;
    observer.disconnect();
    const madeBeforeInstanced = made.length;
    frame(() => scene.drawImageInstanced(canvas, [{ dstRect: [40, 0, 10, 10] }, { dstRect: [55, 0, 10, 10] }]));
    const instancedUrls = made.length - madeBeforeInstanced;
    token.dispose();
    frame(() => scene.drawImage(token, { dstRect: [0, 0, 10, 10] }));
    const afterDispose = scene.svg.querySelector('image').getAttribute('href').slice(0, 22);
    const other = newScene();
    const pending = other.createImage(canvas);
    other.dispose();
    await pending.ready;
    return {
      blobHref: href.startsWith('blob:'), pixels, exportHasBlob: text.includes('blob:'), exported,
      earlyData: earlyHref.startsWith('data:'), earlyKept: early.href === earlyHref, hrefWrites, instancedUrls,
      revokedOnDispose: revoked.includes(href), leaked: made.filter((u) => !revoked.includes(u)).length, afterDispose,
    };
  } finally {
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  }
};
window.__largeOrder = () => {
  const scene = newScene(), n = 2048;
  const hrefs = Array.from({ length: n }, (_, i) => RASTERS[0] + '#' + i);
  const draw = (order) => {
    scene.beginFrame();
    for (const href of order) scene.drawImage(href, { dstRect: [0, 0, 10, 10] });
    scene.endFrame();
  };
  draw(hrefs);
  const original = [...scene.svg.querySelectorAll('image')];
  const byHref = new Map(original.map(img => [img.getAttribute('href'), img]));
  let reused = true, ordered = true;
  for (const order of [hrefs.slice().reverse(), hrefs.slice(700).concat(hrefs.slice(0, 700))]) {
    draw(order);
    const images = [...scene.svg.querySelectorAll('image')];
    reused &&= images.length === n && images.every(img => byHref.get(img.getAttribute('href')) === img);
    ordered &&= images.every((img, i) => img.getAttribute('href') === order[i]);
  }
  const replacement = hrefs.map(href => href + '-new');
  draw(replacement);
  const images = [...scene.svg.querySelectorAll('image')];
  const replaced = images.length === n && images.every((img, i) =>
    img.getAttribute('href') === replacement[i] && !byHref.has(img.getAttribute('href')));
  scene.dispose();
  return { reused, ordered, replaced };
};
window.__retention = async () => {
  const scene = newScene();
  const image = new Image(10, 10); image.src = RASTERS[0]; await image.decode();
  const token = scene.createImage(image);
  const cropped = { dstRect: [5, 5, 20, 20], srcRect: [1, 1, 6, 6],
    tint: [0.5, 0.8, 1, 0.75], worldMatrix: matrix(4, 3), alpha: 0.5 };
  const plain = { dstRect: [20, 5, 20, 20] };
  const frame = (opts) => {
    scene.beginFrame([1, 1, 1, 1]);
    if (opts) scene.drawImage(token, opts);
    scene.endFrame();
  };
  const diff = (a, b) => a.reduce((n, v, i) => n + (v !== b[i]), 0);
  frame(cropped);
  const original = scene.svg.querySelector('image');
  const first = await pixelsOf(scene.svg);
  frame();
  const detached = !scene.svg.querySelector('image');
  const defsDropped = !scene.svg.querySelector('clipPath, filter');
  frame(cropped);
  const reused = scene.svg.querySelector('image') === original;
  const restored = diff(first, await pixelsOf(scene.svg));
  frame();
  frame(plain);
  const fresh = newScene();
  fresh.beginFrame([1, 1, 1, 1]); fresh.drawImage(token, plain); fresh.endFrame();
  const reset = diff(await pixelsOf(scene.svg), await pixelsOf(fresh.svg));
  const attributesReset = ['opacity', 'transform', 'filter', 'clip-path'].every(a => !original.hasAttribute(a));
  scene.dispose(); fresh.dispose();
  return { detached, defsDropped, reused, restored, reset, attributesReset };
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
      ['a raster changes source in place', ['r0', 'r1', 'r4', 'r3'], { images: 0, clones: 0 }],
    ],
  ],
  [
    'duplicates',
    [
      ['r0', 'r1', 'r0', 'r2'],
      ['duplicates reorder', ['r2', 'r0', 'r1', 'r0'], { images: 0, clones: 0 }],
      ['a duplicate leaves', ['r0', 'r2', 'r1'], { images: 0, clones: 0 }],
      ['another duplicate joins', ['r0', 'r2', 'r1', 'r0'], { images: 0, clones: 0 }],
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
      ['a raster joins between bundles', ['b4', 'r1', 'b0', 'b2', 'r3'], { images: 0, clones: 0 }],
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
      `Given ${what}, then the frame reuses available nodes`,
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
expect(
  'Removed rasters retain their images, restore detached definitions and reset omitted attributes on return',
  await page.evaluate(() => window.__retention()),
  { detached: true, defsDropped: true, reused: true, restored: 0, reset: 0, attributesReset: true },
);
expect(
  'Given thousands of rasters reverse, rotate and change sources, then their nodes are reused in draw order and stale nodes leave',
  await page.evaluate(() => window.__largeOrder()),
  { reused: true, ordered: true, replaced: true },
);

const canvas = await page.evaluate(() => window.__canvas());
expect(
  'Given a canvas createImage token drawn before it is ready, then its <image> draws from a data: URL',
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

const tokens = await page.evaluate(() => window.__tokens());
expect(
  'Given a canvas token once ready, then its <image> draws from a blob: URL',
  tokens.blobHref,
  true,
);
expect(
  'Given the canvas is repainted after createImage, then the blob: URL holds its pixels at creation',
  tokens.pixels,
  [0, 255, 0],
);
expect(
  "Given the token's frame, then exportFrameSVG() writes no blob: href and draws the raster",
  [tokens.exportHasBlob, tokens.exported],
  [false, [0, 255, 0]],
);
expect(
  'Given a token drawn before it is ready, then it keeps the data: URL it drew with, and no href is written again',
  [tokens.earlyData, tokens.earlyKept, tokens.hrefWrites],
  [true, true, 0],
);
expect(
  'Given drawImageInstanced of a raw canvas, then it makes no blob: URL',
  tokens.instancedUrls,
  0,
);
expect(
  "Given dispose(), then the token's blob: URL is revoked, and a scene disposed mid-encode leaves none",
  [tokens.revokedOnDispose, tokens.leaked],
  [true, 0],
);
expect(
  'Given a draw after dispose(), then it falls back to a data: URL',
  tokens.afterDispose,
  'data:image/png;base64,',
);

await browser.close();
server.close();
if (failures === 0) console.log('\nnativeSlotReuseSmoke: PASS');
else console.log(`\nnativeSlotReuseSmoke: FAIL (${failures})`);
process.exit(failures ? 1 : 0);
