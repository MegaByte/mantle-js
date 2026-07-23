#!/usr/bin/env node
// probes/_circleMorphRoute.mjs — does a circle→circle (and ring→ring) morph
// route through the LB pair, and how close is mid-t to the Slug morph?
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 256;

const circleSvg = (cx, cy, r, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">${extra}<circle cx="${cx}" cy="${cy}" r="${r}" fill="#204080"/></svg>`;
const ringSvg = (cx, cy, r0, r1) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><path fill-rule="evenodd" fill="#204080" d="M ${cx - r1} ${cy} A ${r1} ${r1} 0 1 0 ${cx + r1} ${cy} A ${r1} ${r1} 0 1 0 ${cx - r1} ${cy} Z M ${cx - r0} ${cy} A ${r0} ${r0} 0 1 0 ${cx + r0} ${cy} A ${r0} ${r0} 0 1 0 ${cx - r0} ${cy} Z"/></svg>`;

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N};
const read = () => { const p = new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); return p; };
const ink = (p) => { let n = 0; for (let i = 0; i < N*N; i++) if (p[i*4] < 200) n++; return n; };
const diff = (a, b) => { let n = 0; for (let i = 0; i < N*N; i++) if (Math.abs(a[i*4]-b[i*4]) > 40) n++; return n; };

async function run(svgA, svgB) {
  const out = {};
  for (const lb of [false, true]) {
    const r = createRenderer(gl, shaders, {});
    r.setLoopBlinnMorphFill(lb ? 'auto' : 'off');
    const bSrc = createBundle(gl, await importSvg(svgA));
    const bDst = createBundle(gl, await importSvg(svgB));
    const mb = createShapeMorph(gl, bSrc, bDst);
    const frames = {};
    let routedN = 0;
    mb.setT(0); r.setViewport(N, N); r.beginFrame([1,1,1,1]); r.drawBundle(mb); r.endFrame();   // warm build
    for (const t of [0, 0.5, 1]) {
      mb.setT(t);
      const before = r.debugStats.loopBlinnMorphRouteCount;
      r.setViewport(N, N); r.beginFrame([1,1,1,1]);
      r.drawBundle(mb); r.endFrame();
      routedN += (r.debugStats.loopBlinnMorphRouteCount - before) > 0 ? 1 : 0;
      frames[t] = read();
    }
    const meshes = mb._morphMeshes || (mb.bundle && mb.bundle._morphMeshes) || [];
    out[lb ? 'lb' : 'slug'] = {
      frames,
      modes: meshes.map(m => m ? (m.mode || 'mesh') + ':v' + (m.vertexCount|0) + (m.segments ? ':' + m.segments.length : '') : 'null'),
      routed: routedN,
    };
  }
  return {
    modes: out.lb.modes,
    routed: out.lb.routed,
    ink0: [ink(out.slug.frames[0]), ink(out.lb.frames[0])],
    inkMid: [ink(out.slug.frames[0.5]), ink(out.lb.frames[0.5])],
    ink1: [ink(out.slug.frames[1]), ink(out.lb.frames[1])],
    dMid: diff(out.slug.frames[0.5], out.lb.frames[0.5]),
    d0: diff(out.slug.frames[0], out.lb.frames[0]),
    d1: diff(out.slug.frames[1], out.lb.frames[1]),
  };
}
const circ = await run(${JSON.stringify(circleSvg(80, 90, 50))}, ${JSON.stringify(circleSvg(120, 100, 70))});
const ring = await run(${JSON.stringify(ringSvg(90, 90, 30, 60))}, ${JSON.stringify(ringSvg(110, 100, 40, 75))});
document.title = 'DONE ' + JSON.stringify({ circ, ring });
</${'script'}></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
pg.on('console', (m) => console.log(' [pg]', m.text()));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
let ok = false;
for (let i = 0; i < 240; i++) { ok = await pg.evaluate(() => document.title.startsWith('DONE')); if (ok) break; await new Promise(r => setTimeout(r, 500)); }
if (!ok) { console.error('TIMEOUT'); process.exit(1); }
console.log(JSON.stringify(JSON.parse((await pg.title()).slice(5)), null, 1));
await br.close(); server.close();
