// instancedCompactCacheSmoke — alternating instanced assets retain their
// compacted header-free meshes instead of re-uploading every frame.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SVG = readFileSync(new URL('../examples/smoke/instancedBundleRenderDiff__SVG.svg', import.meta.url), 'utf8');

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
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
  result = await page.evaluate(async (svg) => {
    const { importSvg, createBundle, createRenderer, loadShaders } = await import('/src/index.js');
    const canvas = document.getElementById('c');
    const gl = canvas.getContext('webgl2', { depth: true, stencil: true, preserveDrawingBuffer: true });
    const renderer = createRenderer(gl, await loadShaders(new URL('/src/shaders/', location.href).href));
    renderer.setViewport(256, 256);
    renderer.setLoopBlinnFill('off');
    const sections = await importSvg(svg);
    const first = createBundle(gl, sections);
    const second = createBundle(gl, sections);
    const instances = [{}, {}];
    let uploadsAfterWarm = 0, coverAllocationsAfterWarm = 0, attrSetupAfterWarm = 0;
    let resourceClears = 0;
    const bufferData = gl.bufferData.bind(gl);
    gl.bufferData = (target, data, usage, ...rest) => {
      if (ArrayBuffer.isView(data)) uploadsAfterWarm++;
      return bufferData(target, data, usage, ...rest);
    };
    const createBuffer = gl.createBuffer.bind(gl);
    gl.createBuffer = (...args) => {
      coverAllocationsAfterWarm++;
      return createBuffer(...args);
    };
    const vertexAttribPointer = gl.vertexAttribPointer.bind(gl);
    gl.vertexAttribPointer = (...args) => {
      attrSetupAfterWarm++;
      return vertexAttribPointer(...args);
    };
    const clear = gl.clear.bind(gl);
    gl.clear = mask => {
      if (mask & (gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)) resourceClears++;
      return clear(mask);
    };
    const draw = bundle => {
      renderer.beginFrame([1, 1, 1, 1]);
      renderer.drawBundleInstanced(bundle, instances);
      renderer.endFrame();
    };
    // Warm both compact entries. The public bare-bundle API has a transient
    // handle, so each later call still uploads that handle's two VBOs. The
    // compact cache must avoid another two uploads per asset on top of those.
    draw(first); draw(second);
    uploadsAfterWarm = 0;
    coverAllocationsAfterWarm = 0;
    attrSetupAfterWarm = 0;
    resourceClears = 0;
    draw(first); draw(second);
    const fastMetrics = {
      uploads: uploadsAfterWarm,
      coverAllocations: coverAllocationsAfterWarm,
      attrSetup: attrSetupAfterWarm,
      resourceClears,
    };
    // The same retention applies to the bare normal draw path. Its first
    // visit materializes deferred cover resources; later alternation must
    // simply bind the resident handles.
    const drawNormal = bundle => {
      renderer.beginFrame([1, 1, 1, 1]);
      renderer.drawBundle(bundle);
      renderer.endFrame();
    };
    drawNormal(first); drawNormal(second);
    uploadsAfterWarm = 0;
    coverAllocationsAfterWarm = 0;
    drawNormal(first); drawNormal(second);
    const normalMetrics = {
      uploads: uploadsAfterWarm,
      coverAllocations: coverAllocationsAfterWarm,
    };
    // Eligibility is cached, but occlusion can replace drawList without a
    // geometry change. Seed an intentionally stale negative decision, then
    // advance the cull generation: the next public draw must recompute and
    // take the observable compact fast path.
    first._instSimpleCache = {
      gen: first._geomGen | 0,
      cullGen: first._cullGen | 0,
      hasMask: false,
      ok: false,
    };
    first._cullGen++;
    const fastBeforeCullRefresh = renderer.debugStats.instancedFastCount;
    draw(first);
    const routeCache = { fastDelta: renderer.debugStats.instancedFastCount - fastBeforeCullRefresh };
    const output = new Uint8Array(4);
    gl.readPixels(128, 128, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, output);
    gl.bufferData = bufferData;
    gl.createBuffer = createBuffer;
    gl.vertexAttribPointer = vertexAttribPointer;
    gl.clear = clear;
    first.dispose(); second.dispose(); renderer.dispose();
    return { fastMetrics, normalMetrics, routeCache, output: Array.from(output) };
  }, SVG);
} finally {
  await browser.close();
  server.close();
}

if (!result || result.fastMetrics.uploads !== 0) {
  console.error(`instancedCompactCacheSmoke: FAIL (fast instancing re-uploaded a normal cover mesh: ${result && result.fastMetrics.uploads})`);
  process.exit(1);
}
if (result.fastMetrics.coverAllocations !== 0) {
  console.error(`instancedCompactCacheSmoke: FAIL (fast instancing allocated ${result.fastMetrics.coverAllocations} normal cover buffers)`);
  process.exit(1);
}
if (result.fastMetrics.attrSetup !== 0) {
  console.error(`instancedCompactCacheSmoke: FAIL (fast instancing repeated ${result.fastMetrics.attrSetup} vertex-attribute setups)`);
  process.exit(1);
}
if (result.fastMetrics.resourceClears !== 2) {
  console.error(`instancedCompactCacheSmoke: FAIL (expected one frame clear per draw, got ${result && result.fastMetrics.resourceClears})`);
  process.exit(1);
}
if (result.normalMetrics.uploads !== 0 || result.normalMetrics.coverAllocations !== 0) {
  console.error(`instancedCompactCacheSmoke: FAIL (bare normal alternation rebuilt cover resources: ${JSON.stringify(result.normalMetrics)})`);
  process.exit(1);
}
if (result.routeCache.fastDelta !== 1) {
  console.error(`instancedCompactCacheSmoke: FAIL (cull-aware eligibility cache stale: ${JSON.stringify(result.routeCache)})`);
  process.exit(1);
}
if (result.output[3] === 0) {
  console.error('instancedCompactCacheSmoke: FAIL (alternating draw rendered no coverage)');
  process.exit(1);
}
console.log('instancedCompactCacheSmoke: PASS (two compact builds retained across alternating assets)');
