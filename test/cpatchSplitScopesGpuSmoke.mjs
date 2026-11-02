// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchSplitScopesGpuSmoke -- the ordered area/seam split draws every scope of the unified stream, and its pixels are the
// combined program's.
//
// A complete cubic area paint needs the native-cubic integral, which is presence on every fragment of a combined CPatch program.
// The split draws such a paint in a program that has only the area walk and everything else in a program with none, as ordered
// runs of the one vertex stream. The scopes that draw a RANGE of that stream -- a group's children, a run between blend leaves
// and filters, a filtered shape's isolated source render, a sprite subset, a draw under overrides -- must take the same runs, and
// must be the combined draw's picture (<= 1 byte). Each scope is drawn twice on one renderer pinned to CPatch: split (the default)
// and combined (debug hook __CP_AREA_SPLIT = false). The engine ledger proves both: the split arm counts area runs and CPatch rows, the
// combined arm counts none.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 160;
// Cubic area paints plus a stroked rectangle that requires the seam program.
const loop = (dx, dy, fill, op, extra = '') =>
  `<path fill="${fill}" fill-opacity="${op}" ${extra} d="M${20 + dx} ${50 + dy}C${20 + dx} ${dy - 10} ${100 + dx} ${dy - 10} ${100 + dx} ${50 + dy}C${100 + dx} ${80 + dy} ${70 + dx} ${85 + dy} ${60 + dx} ${70 + dy}L${54 + dx} ${100 + dy}L${46 + dx} ${100 + dy}L${40 + dx} ${70 + dy}C${30 + dx} ${85 + dy} ${20 + dx} ${80 + dy} ${20 + dx} ${50 + dy}Z"/>`;
const lens = (dx, dy, fill, op, extra = '') =>
  `<path fill="${fill}" fill-opacity="${op}" ${extra} d="M${20 + dx} ${50 + dy}C${20 + dx} ${dy} ${100 + dx} ${dy} ${100 + dx} ${50 + dy}C${100 + dx} ${90 + dy} ${20 + dx} ${90 + dy} ${20 + dx} ${50 + dy}Z"/>`;
const rect = (dx, dy, fill) =>
  `<path fill="${fill}" fill-opacity=".5" stroke="#222" stroke-opacity=".5" stroke-width="2" d="M${30 + dx} ${30 + dy}H${90 + dx}V${70 + dy}H${30 + dx}Z"/>`;
// The stroked rectangle guarantees both area and seam runs as certification improves.
const content = (dx = 0, dy = 0) =>
  lens(dx, dy, '#d433a9', 0.5) +
  loop(dx + 14, dy + 6, '#348bc4', 0.5) +
  lens(dx + 22, dy + 12, '#42c452', 0.45) +
  loop(dx + 30, dy + 4, '#e08a1e', 0.5) +
  rect(dx + 10, dy + 20, '#2b4acb');
const wrap = (body, defs = '', vb = `0 0 ${N} ${N}`) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${vb.split(' ')[2]}" height="${N}">${defs}${body}</svg>`;
const SCOPES = [
  { name: 'plain', svg: wrap(content()), draw: 'bundle' },
  {
    name: 'group-opacity',
    svg: wrap(
      loop(0, 0, '#888', 0.5) +
        `<g opacity=".6">${content(10, 10)}</g>` +
        lens(30, 40, '#a22', 0.5),
    ),
    draw: 'bundle',
  },
  {
    name: 'blend-leaf',
    svg: wrap(
      content() +
        loop(20, 20, '#7aa', 0.8, 'style="mix-blend-mode:multiply"') +
        lens(40, 40, '#ca3', 0.5),
    ),
    draw: 'bundle',
  },
  {
    name: 'filter',
    svg: wrap(
      lens(0, 0, '#d433a9', 0.5) +
        `<g filter="url(#f)">${loop(10, 10, '#348bc4', 0.6)}${lens(20, 20, '#42c452', 0.5)}${rect(15, 12, '#2b4acb')}</g>` +
        loop(40, 30, '#e08a1e', 0.5),
      '<defs><filter id="f" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2"/></filter></defs>',
    ),
    draw: 'bundle',
  },
  {
    name: 'sprite',
    svg: wrap(
      `<g id="s0">${content(0, 0)}</g><g id="s1">${content(160, 0)}</g>`,
      '',
      `0 0 ${2 * N} ${N}`,
    ),
    draw: 'sprite',
    sprite: 's1',
  },
  { name: 'overrides', svg: wrap(content()), draw: 'overrides' },
];
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
// Exercise filtered child draws on every arm rather than reusing their raster.
const r = createRenderer(gl, shaders, { cpatchFill: true, aacPoints: false, groupFilterCache: false, unifiedFilterCache: false });
r.setFillEngine({ route: 'cpatch', kernel: 'slug' });
const SCOPES = ${JSON.stringify(SCOPES)};
const sleep = (ms) => new Promise((f) => setTimeout(f, ms));
const read = () => { const w = gl.canvas.width, px = new Uint8Array(w * ${N} * 4); gl.readPixels(0, 0, w, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px); return Array.from(px); };
const out = [];
for (const sc of SCOPES) {
  globalThis.__CP_AREA_SPLIT = undefined;
  const w = sc.draw === 'sprite' ? ${2 * N} : ${N};
  gl.canvas.width = w; gl.canvas.height = ${N};
  r.setViewport(w, ${N});
  const bundle = createBundle(gl, await importSvg(sc.svg, { preserveViewport: true }));
  r.prepareBundle(bundle);
  if (!await r.awaitEngine(bundle, 'cpatch', 30000)) throw Error(sc.name + ': CPatch preparation did not complete');
  const ovr = sc.draw === 'overrides' ? createOverrideTable(gl, bundle) : null;
  if (ovr) { ovr.set(1, { localPosition: [0, -14] }); ovr.set(3, { localPosition: [10, 6] }); }
  const frame = () => {
    r.beginFrame([1, 1, 1, 1]);
    if (sc.draw === 'sprite') r.drawSprite(bundle, sc.sprite, {});
    else r.drawBundle(bundle, ovr ? { overrides: ovr } : {});
    r.endFrame();
  };
  const stats = () => { const s = r.debugStats; return { split: s.cpatchAreaSplitDraws | 0, area: s.cpatchAreaSplitAreaDraws | 0, uni: s.unifiedFillDraws | 0, eng: s.engines ? JSON.parse(JSON.stringify(s.engines)) : null, gate: s.unifiedFillGate }; };
  // SPLIT arm (the default): warm until both run variants are ready and a frame draws split runs.
  globalThis.__CP_AREA_SPLIT = undefined;
  const warming = await r.warmScene([{name:sc.name, bundle, engine:'cpatch', draw:frame}], {maxPasses:12, readyTimeoutMs:30000});
  if (!warming.complete) throw Error(sc.name + ': scene warming incomplete ' + JSON.stringify(warming));
  let a0 = stats(), warm = 0, a1;
  for (; warm < 200; warm++) {
    frame(); r.precompileFills && r.precompileFills(); gl.finish();
    a1 = stats(); if (a1.split > a0.split) { a0 = a1; frame(); gl.finish(); a1 = stats(); break; }
    a0 = a1; await sleep(30);
  }
  const split = read(), splitD = { split: a1.split - a0.split, area: a1.area - a0.area, uni: a1.uni - a0.uni, gate: a1.gate };
  // COMBINED arm.
  globalThis.__CP_AREA_SPLIT = false;
  frame(); gl.finish();
  const b0 = stats(); frame(); gl.finish(); const b1 = stats();
  const comb = read(), combD = { split: b1.split - b0.split, area: b1.area - b0.area, uni: b1.uni - b0.uni, gate: b1.gate };
  let maxd = 0, ink = 0, nd = 0;
  for (let i = 0; i < split.length; i++) { const d = Math.abs(split[i] - comb[i]); if (d > maxd) maxd = d; if (d > 1) nd++; if (i % 4 === 0 && (split[i] !== 255 || split[i + 1] !== 255 || split[i + 2] !== 255)) ink++; }
  out.push({ name: sc.name, warm, splitD, combD, maxd, nd, ink, engSplit: a1.eng && a1.eng.cpatch, engComb: b1.eng && b1.eng.cpatch, engines: b1.eng });
}
window.__out = out; window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page-err]', e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 150000, polling: 200 });
const out = await page.evaluate(() => window.__out);
await browser.close();
server.close();
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
for (const o of out) {
  console.log(
    `${o.name}: split ${JSON.stringify(o.splitD)} combined ${JSON.stringify(o.combD)} maxDiff ${o.maxd} (${o.nd} px > 1), ink ${o.ink}, warm ${o.warm}`,
  );
  ok(o.ink > 500, `${o.name}: it painted (${o.ink} px)`);
  ok(
    o.splitD.area >= 1 && o.splitD.split >= 2,
    `${o.name}: the split arm drew ordered runs (${o.splitD.split} runs, ${o.splitD.area} area) through the unified route`,
  );
  ok(
    o.combD.split === 0 && o.combD.uni >= 1,
    `${o.name}: the combined arm drew the unified route with no split runs`,
  );
  ok(o.maxd <= 1, `${o.name}: split is the combined picture to 1 byte (max ${o.maxd})`);
}
console.log(
  fail ? `\ncpatchSplitScopesGpuSmoke FAIL (${fail})` : '\ncpatchSplitScopesGpuSmoke PASS',
);
process.exit(fail ? 1 : 0);
