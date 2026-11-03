// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _shaderCompileCost — how long does the fill shader take to compile+link?
// Each NEW variant (per-bundle defines) forces a synchronous finalizeShaderCompiles(), so
// this lands as a frame hitch the first time a bundle with a new feature set is drawn.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="64" height="64"></canvas><script type="module">
import { createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const R=createRenderer(gl,shaders,{});
const sets = { 'fill (default)': [], 'fill + MANTLE_AAC': ['MANTLE_AAC'] };
const out={};
for(const [name,defs] of Object.entries(sets)){
  const t0=performance.now();
  const p=R.program(R.shaderSources.fillVert, R.withDefines(R.shaderSources.fillFrag, defs), 'probe:'+name);
  R.finalizeShaderCompiles();
  out[name]=+(performance.now()-t0).toFixed(1);
}
out['frag source lines'] = R.shaderSources.fillFrag.split('\\n').length;
window.__out=out; window.__ready=true;</script></body></html>`;
const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000 });
const o = await pg.evaluate(() => window.__out);
await br.close();
server.close();
const tag = process.env.TAG || '';
for (const [k, v] of Object.entries(o)) console.log(`[${tag}] ${k.padEnd(20)} ${v}`);
