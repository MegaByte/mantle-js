// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzFlagCross — a regression guard for the two ways a page-side Loop-Blinn A/B measures nothing.
//
// A `__lb*` test hook set on the page has to reach the build, which runs in lbBuild.worker.js --
// a separate global scope that sees them only because the pool posts them with the input.
// And the module-level LB mesh cache outlives the bundle AND the renderer, keyed by curve
// bytes, caching Slug VERDICTS as well as meshes: without clearLbMeshCaches() between arms the
// second arm gets the first's decisions back without building, and both arms print the same
// number in either order. Expect 142 LB / 84 Slug with the audit on and 226 / 0 with it off; two
// equal lines mean the harness, not the switch.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = readFileSync(
  path.join(ROOT, process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg'),
  'utf8',
)
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="64" height="64"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { clearLbMeshCaches } from '/src/renderer/morphDraw.js';
const gl=document.getElementById('c').getContext('webgl2');
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
window.__run=async(svg,ORDER)=>{
  const out=[];
  // A FRESH IMPORT PER ARM. Two bundles built from the SAME section can share a build, and then
  // both arms report the first arm's answer -- which is what "no effect" would look like.
  for (const off of ORDER) {
    const sec=await importSvg(svg,{preserveViewport:true});
    if (off) { globalThis.__MANTLE_DEBUG__ = true; globalThis.__lbAuditOff = 1; } else delete globalThis.__lbAuditOff;
    clearLbMeshCaches();
    const r=createRenderer(gl,shaders,{}); r.setLoopBlinnFill('on');
    const b=createBundle(gl,sec); if (r.prepareBundle) r.prepareBundle(b);
    await r.awaitLbReady(b);
    const ms=b._lbMeshes||[]; let slug=0,real=0;
    for (const m of ms) { if (!m || m.slug===true) slug++; else real++; }
    out.push({off, real, slug, n: ms.length}); b.dispose();
  }
  return out;
};
</script></body></html>`;
const srv = http.createServer((q, s) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/') {
    s.writeHead(200, { 'content-type': 'text/html' });
    return s.end(HTML);
  }
  try {
    const p = path.join(ROOT, u);
    if (!p.startsWith(ROOT)) throw 0;
    const body = readFileSync(p);
    s.writeHead(200, {
      'content-type': u.endsWith('.js') || u.endsWith('.mjs') ? 'text/javascript' : 'text/plain',
    });
    s.end(body);
  } catch {
    s.writeHead(404);
    s.end('no');
  }
});
await new Promise((z) => srv.listen(0, z));
const br = await launchBrowser({
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=metal', '--no-sandbox'],
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));

pg.on('console', (m) => {
  if (!m.text().includes('favicon')) console.log('CONSOLE ' + m.text());
});
await pg.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'networkidle0' });
await pg.waitForFunction('!!window.__run', { timeout: 120000 });
for (const r of await pg.evaluate(
  (s, o) => window.__run(s, o),
  SVG,
  (process.env.ORDER || '0,1').split(',').map(Number),
))
  console.log(`__lbAuditOff=${r.off}: ${r.real} LB / ${r.slug} Slug  (of ${r.n})`);
await br.close();
srv.close();
