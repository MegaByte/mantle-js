// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// AN ENGINE DECLINES TO SLUG, never INTO THE OTHER ENGINE.
//
// CPatch and Loop-Blinn share a draw path and a wire format on purpose. They must not share a
// FALLBACK: if a CPatch failure fell through to LB, asking for CPatch and getting a decline would
// silently get you an LB draw. That coupling is not a cosmetic problem —
//   * a benchmark would file LB's morph timings under CPatch's name, and report "CPatch
//     disqualified across morph" for an engine that was never invited to draw;
//   * on filtered assets both arms would come back engines={"lb":1}, which makes one engine's
//     defect look like two engines failing identically;
//   * an engine that declines everything can look fast.
//
// So: with route:'cpatch' selected, no draw may be recorded as 'lb'. With route:'lb' selected,
// none may be recorded as 'cpatch'. Slug is the shared floor and is always allowed — that IS the
// decline.
//
// THE DECLINE PATH MUST actually RUN. Both engines draw a filter graph and a loop/cusp, so those assets cannot force a
// decline. Two rows force it, and both are a caller-set refusal rather than a built-in one: the 400-cubic star is declined by Loop-Blinn's PER-SHAPE MEMORY BUDGET
// (setLoopBlinnShapeMemoryBudget), and CPatch, which is meant to accept every shape, is made to decline one bundle
// through its test hook (__CP_TEST_DECLINE_ALL), so the path from "built nothing" onward is real.
//
// The star BUILDS on its own — 6,424 curve floats, 6,600 vertices, 633,600 bytes, no complexity gate (the progressive
// build answers build time directly) — so the row forces it through the budget, the mechanism that bounds a shape's
// memory, which is symmetric with CPatch's hook.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';
import { PKG_ROOT, requireAsset } from './_assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = [
  'examples/_convolve.svg',
  'examples/_dropshadow.svg',
  'examples/tiger.svg',
  'examples/_concave_cubic.svg',
];
// tiger is in the list, so the corpus is incomplete without it and the decline count it
// measures would be a different count: skip the file rather than silently shrink it.
const SVGS = ASSETS.map((a) => readFileSync(requireAsset(path.join(PKG_ROOT, a)), 'utf8'));
// 400 cubics, 6424 curve floats; its mesh packs 633,600 bytes, so a 64 KB per-shape budget refuses it.
let starD = 'M 160 30';
for (let i = 1; i <= 400; i++) {
  const r = i % 2 ? 130 : 100,
    a1 = (i / 400) * 2 * Math.PI,
    a0 = ((i - 0.5) / 400) * 2 * Math.PI;
  const P = (ang, rad) =>
    `${(160 + rad * Math.sin(ang)).toFixed(3)} ${(160 - rad * Math.cos(ang)).toFixed(3)}`;
  starD += ` C ${P(a0, r)} ${P(a0, r)} ${P(a1, r)}`;
}
const STAR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320"><path fill="#3366cc" d="${starD} Z"/></svg>`;
const ROWS = [];
for (let i = 0; i < SVGS.length; i++)
  for (const route of ['lb', 'cpatch']) ROWS.push({ name: ASSETS[i], svg: SVGS[i], route });
for (const route of ['lb', 'cpatch'])
  ROWS.push({
    name: 'monster-star (400 cubics)',
    svg: STAR,
    route,
    mustDecline: route === 'lb',
    lbShapeMemBytes: route === 'lb' ? 65536 : 0,
  });
ROWS.push({
  name: 'examples/_concave_cubic.svg [CPatch forced to decline]',
  svg: SVGS[3],
  route: 'cpatch',
  forceCpatchDecline: true,
  mustDecline: true,
});

const PAGE = `<!doctype html><body><canvas id=c width=320 height=320></canvas><script type=module>
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true,depth:true,stencil:true});
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const ROWS = ${JSON.stringify(ROWS)};
const out = [];
for (const row of ROWS) {
  const route = row.route;
  if (row.forceCpatchDecline) { globalThis.__MANTLE_DEBUG__ = true; globalThis.__CP_TEST_DECLINE_ALL = true; }
  const r = createRenderer(gl, shaders, route === 'cpatch' ? { cpatchFill: true, cpatchOpts: {} } : {});
  r.setViewport(320, 320); r.setFillEngine({ route });
  // The per-shape memory budget is PROCESS-WIDE (a module flag that also rides the worker input),
  // so it must be set before the bundle is created and cleared straight after this row.
  r.setLoopBlinnShapeMemoryBudget(row.lbShapeMemBytes || 0);
  const b = createBundle(gl, await importSvg(row.svg));
  r.prepareBundle(b);
  // A bundle CPatch built nothing for never gets meshes, so awaitEngine would sit out its whole timeout.
  if (r.awaitEngine) { try { await r.awaitEngine(b, route, row.forceCpatchDecline ? 3000 : 30000); } catch {} }
  r.beginFrame([1,1,1,1]); r.drawBundle(b, {}); r.endFrame();
  delete globalThis.__CP_TEST_DECLINE_ALL; delete globalThis.__MANTLE_DEBUG__;
  const px = new Uint8Array(320*320*4); gl.readPixels(0,0,320,320,gl.RGBA,gl.UNSIGNED_BYTE,px);
  let ink = 0; for (let p = 0; p < px.length; p += 4)
    if (px[p+3] > 8 && !(px[p] > 247 && px[p+1] > 247 && px[p+2] > 247)) ink++;
  const ds = r.debugStats, draws = (ds.engines && ds.engines.draws) || {};
  out.push({ asset: row.name, route, mustDecline: !!row.mustDecline, bail: b._cpatchBail || '', ink,
             drew: Object.keys(draws).filter((k) => (draws[k] | 0) > 0).sort(),
             memDeclined: ds.lbShapeMemDeclined | 0, memWanted: ds.lbShapeMemWantedBytes | 0,
             stomps: ds.fillMeshStomps | 0 });
  r.setLoopBlinnShapeMemoryBudget(0);
  b.dispose(); r.dispose();
}
window.__out = out; window.__ready = true;
</script></body>`;

const srv = http.createServer((q, r) => {
  try {
    if (q.url === '/') {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end(PAGE);
      return;
    }
    const p = decodeURIComponent(q.url.split('?')[0]);
    r.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    r.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!r.headersSent) r.writeHead(404);
    r.end();
  }
});
await new Promise((x) => srv.listen(0, '127.0.0.1', x));
const port = srv.address().port;
const args = ['--no-sandbox'];
if (process.env.GPU === '1' || process.env.MANTLE_TEST_GL === 'metal')
  args.push('--use-angle=metal', '--enable-gpu');
else args.push('--enable-unsafe-swiftshader');
const br = await launchBrowser({ headless: 'new', args });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error('[pg]', e.message));
await pg.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction(() => window.__ready, { timeout: pageTimeoutFor(300000), polling: 100 });
const rows = await pg.evaluate(() => window.__out);
await br.close();
srv.close();

let failures = 0;
const ok = (m) => console.log('  ok ' + m);
const fail = (m) => {
  console.error('FAIL ' + m);
  failures++;
};
const OTHER = { lb: 'cpatch', cpatch: 'lb' };

for (const r of rows) {
  const label = `${r.asset.replace('examples/', '')} route=${r.route}`;
  if (r.drew.includes(OTHER[r.route]))
    fail(
      `${label}: drew ${OTHER[r.route]} — an engine declined INTO the other engine (drew ${r.drew.join('+')})`,
    );
  if (r.stomps > 0)
    fail(`${label}: ${r.stomps} fill-mesh stomp(s) — two engines fought over one bundle`);
  if (r.ink < 100) fail(`${label}: ${r.ink} ink — the frame is blank, so this row proves nothing`);
}
if (!failures) ok(`no engine declined into the other, across ${rows.length} (asset, route) rows`);

// Non-vacuous: the rows built to decline must have declined, or this passes by every case succeeding.
for (const r of rows.filter((x) => x.mustDecline)) {
  const label = `${r.asset.replace('examples/', '')} route=${r.route}`;
  if (!r.drew.includes(r.route))
    ok(
      `non-vacuous: ${label} declined to ${r.drew.join('+') || 'nothing'}${r.bail ? ' (' + r.bail + ')' : ''}`,
    );
  else fail(`vacuous: ${label} was meant to decline and drew ${r.drew.join('+')}`);
}
// ...and the LB decline must be the BUDGET'S, reported rather than silent — a decline for some
// other reason would keep the row above green while saying nothing about the mechanism under test.
for (const r of rows.filter((x) => x.route === 'lb' && x.asset.startsWith('monster-star'))) {
  if (r.memDeclined > 0 && r.memWanted >= 65536)
    ok(
      `the star's LB decline is the memory budget's, and it says so: ${r.memDeclined} shape(s), largest wanted ${r.memWanted} B`,
    );
  else
    fail(
      `the star declined without the memory budget reporting it (declined=${r.memDeclined}, wanted=${r.memWanted})`,
    );
}
const declined = rows.filter((r) => !r.drew.includes(r.route));
console.log(
  `  ${declined.length} of ${rows.length} rows declined: ${declined.map((d) => d.asset.replace('examples/', '') + '/' + d.route + '→' + (d.drew.join('+') || 'none')).join(', ')}`,
);

if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nengineDeclineIsolationSmoke: CPatch and LB decline to Slug, never into each other');
