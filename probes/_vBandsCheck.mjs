// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _vBandsCheck — with opts.vBands:false the bundle keeps ONE V band. AAC must be
// pixel-identical (it never reads them); Slug must still be CORRECT (its V ray
// walks a single band containing every segment) though slower.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 256;
const SH = {
  star: 'M128 18 L158 98 L243 98 L175 148 L201 228 L128 178 L55 228 L81 148 L13 98 L98 98 Z',
  blob: 'M60 128 C60 40 196 40 196 128 C196 216 60 216 60 128 Z',
  arc: 'M40 128 A88 70 0 1 0 216 128 A88 70 0 1 0 40 128 Z',
};
const SVGS = Object.fromEntries(
  Object.entries(SH).map(([k, d]) => [
    k,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#3366cc" d="${d}"/></svg>`,
  ]),
);
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const SVGS=${JSON.stringify(SVGS)};
async function render(svg,aac,vBands){
  const sec=await importSvg(svg,{vBands});
  const r=createRenderer(gl,shaders,aac?{aacFill:true}:{});
  r.setViewport(${N},${N}); r.setLoopBlinnFill('off');
  const b=createBundle(gl,sec);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const px=new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px);
  const bytes=(sec.bandBytes!==undefined)?sec.bandBytes:(sec.bandData?sec.bandData.length:0);
  b.dispose(); return {px:Array.from(px), bytes};
}
const out={};
try{ for(const k of Object.keys(SVGS)) out[k]={
  aacV:await render(SVGS[k],true,true), aacNoV:await render(SVGS[k],true,false),
  slugV:await render(SVGS[k],false,true), slugNoV:await render(SVGS[k],false,false) }; }
catch(e){ out.err=String(e); }
window.__out=out; window.__ready=true;
</script></body></html>`;
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
const port = server.address().port;
const br = await launchBrowser({
  headless: 'new',
  args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 60000 });
const o = await pg.evaluate(() => window.__out);
await br.close();
server.close();
if (o.err) {
  console.error('threw:', o.err);
  process.exit(1);
}
const cmp = (a, b) => {
  let n = 0,
    mx = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d) {
      n++;
    }
    if (d > mx) mx = d;
  }
  return [n, mx];
};
let fail = 0;
for (const k of Object.keys(SH)) {
  const [an, am] = cmp(o[k].aacV.px, o[k].aacNoV.px);
  const [sn, sm] = cmp(o[k].slugV.px, o[k].slugNoV.px);
  const bandKB = (o[k].aacV.bytes / 1024).toFixed(1),
    bandKB2 = (o[k].aacNoV.bytes / 1024).toFixed(1);
  console.log(`[${k}]`);
  an === 0
    ? console.log('  ok AAC pixel-identical with vBands:false (never reads V bands)')
    : (fail++, console.error(`  FAIL AAC differs: ${an} channels, max ${am}`));
  sm <= 1
    ? console.log(`  ok Slug still correct with one V band (max channel diff ${sm})`)
    : (fail++, console.error(`  FAIL Slug differs by ${sm}`));
  if (o[k].aacV.bytes) console.log(`  band bytes ${bandKB} KiB -> ${bandKB2} KiB`);
}
console.log(fail ? `\nVBANDS FAIL (${fail})` : '\nVBANDS PASS');
process.exit(fail ? 1 : 0);
