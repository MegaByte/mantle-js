// instancedCompactCacheManySmoke — a scene that alternates many instanced
// assets every frame (a forest of tree stamps) keeps every compacted mesh
// resident instead of evicting and re-uploading each one per frame.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SVG = readFileSync(new URL('../examples/smoke/instancedBundleRenderDiff__SVG.svg', import.meta.url), 'utf8');
const ASSETS = 24;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  if (url.searchParams.has('raw')) {
    let source;
    try { source = readFileSync(path.join(ROOT, p), 'utf8'); }
    catch { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(`export default ${JSON.stringify(source)};`);
    return;
  }
  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><canvas id="c" width="256" height="256"></canvas>`);
    return;
  }
  const type = p.endsWith('.js') || p.endsWith('.mjs') ? 'text/javascript'
    : p.endsWith('.glsl') ? 'text/plain' : 'application/octet-stream';
  let body;
  try { body = readFileSync(path.join(ROOT, p)); }
  catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': type });
  res.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
let result;
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 15000 });
  result = await page.evaluate(async (svg, assets) => {
    const { importSvg, createBundle, createRenderer, loadShaders } = await import('/src/index.js');
    const canvas = document.getElementById('c');
    const gl = canvas.getContext('webgl2', { depth: true, stencil: true, preserveDrawingBuffer: true });
    const renderer = createRenderer(gl, await loadShaders(new URL('/src/shaders/', location.href).href));
    renderer.setViewport(256, 256);
    renderer.setLoopBlinnFill('off');
    const sections = await importSvg(svg);
    const bundles = Array.from({ length: assets }, () => createBundle(gl, sections));
    const instances = [{}, {}];
    const drawFrame = () => {
      renderer.beginFrame([1, 1, 1, 1]);
      for (const bundle of bundles) renderer.drawBundleInstanced(bundle, instances);
      renderer.endFrame();
    };
    drawFrame();
    const fastBefore = renderer.debugStats.instancedFastCount;
    let uploads = 0;
    const bufferData = gl.bufferData.bind(gl);
    gl.bufferData = (target, data, usage, ...rest) => {
      if (ArrayBuffer.isView(data)) uploads++;
      return bufferData(target, data, usage, ...rest);
    };
    drawFrame();
    drawFrame();
    gl.bufferData = bufferData;
    const fastDraws = renderer.debugStats.instancedFastCount - fastBefore;
    for (const bundle of bundles) bundle.dispose();
    let released = 0;
    const deleteBuffer = gl.deleteBuffer.bind(gl);
    gl.deleteBuffer = (buffer) => {
      released++;
      return deleteBuffer(buffer);
    };
    const replacement = createBundle(gl, sections);
    renderer.beginFrame([1, 1, 1, 1]);
    renderer.drawBundleInstanced(replacement, instances);
    renderer.endFrame();
    gl.deleteBuffer = deleteBuffer;
    replacement.dispose();
    renderer.dispose();
    return { uploads, fastDraws, released };
  }, SVG, ASSETS);
} finally {
  await browser.close();
  server.close();
}

if (!result || result.fastDraws !== ASSETS * 2) {
  console.error(`instancedCompactCacheManySmoke: FAIL (expected ${ASSETS * 2} fast instanced draws, got ${result && result.fastDraws})`);
  process.exit(1);
}
if (result.uploads !== 0) {
  console.error(`instancedCompactCacheManySmoke: FAIL (${ASSETS} alternating assets re-uploaded ${result.uploads} compact meshes across two frames)`);
  process.exit(1);
}
if (result.released < ASSETS * 2) {
  console.error(`instancedCompactCacheManySmoke: FAIL (disposed assets kept their compact meshes: ${result.released} of ${ASSETS * 2} buffers released)`);
  process.exit(1);
}
console.log(`instancedCompactCacheManySmoke: PASS (${ASSETS} alternating instanced assets stay resident until disposed)`);
