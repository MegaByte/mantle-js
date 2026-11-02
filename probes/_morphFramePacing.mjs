// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _morphFramePacing — what fits in a FRAME, on a loop that presents.
//
// Every other timing probe here batches frames and syncs at the end. That is fine for pricing one
// step against another, and wrong for the question the engine gates actually ask, which is "how
// much of this can the renderer carry before it stops keeping up". Batching also lets the GPU fall
// arbitrarily far behind, which distorts anything hazard-shaped: the meta-plane ring can read
// negative batched and cannot be checked shallow, because bolting a per-frame readPixels onto a
// batch costs 1.6ms and drowns what it is measuring.
//
// So this presents. It drives requestAnimationFrame, draws K morphs a frame, and reports the
// median interval between callbacks as K grows. No GPU timer, no readPixels, no batch — the clock
// is the frame loop itself, which is the one an application lives on.
//
// Read it as a curve, not a number. If a browser paces at 60Hz the intervals sit at 16.7 until the
// engine cannot keep up and then climb, and the K where that happens is the gate. If it free-runs,
// the intervals ARE the frame cost and the curve is a cost model. Both are printed rather than
// assumed, and the free-run case is detected by whether K=1 lands near 16.7.
//
// Engines are rotated across rounds for the same reason the paired probe rotates: whoever runs
// first pays for caches the rest find warm.
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 512);
const KS = (process.env.KS || '1,2,4,8').split(',').map(Number);
const FRAMES = +(process.env.FRAMES || 48);
const ROUNDS = +(process.env.ROUNDS || 3);
const ENGINES = (process.env.ENGINES || 'slug,lb,cpatch').split(',');
const A = 'M20 4 Q36 4 36 20 Q36 36 20 36 Q4 36 4 20 Q4 4 20 4 Z';
const B = 'M20 7 Q33 3 34 20 Q35 33 20 34 Q7 35 6 20 Q5 7 20 7 Z';
const svg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="${d}" fill="#fff"/></svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const S = ${N}, KS = ${JSON.stringify(KS)}, FRAMES = ${FRAMES}, ROUNDS = ${ROUNDS};
const ENGINES = ${JSON.stringify(ENGINES)};
const gl = document.getElementById('c').getContext('webgl2',
  { antialias: false, depth: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const KMAX = Math.max(...KS);

// ---- one renderer and KMAX morphs per engine, built once -------------------------------------
const rigs = [];
for (const eng of ENGINES) {
  const r = createRenderer(gl, shaders,
    eng === 'cpatch' ? { cpatchFill: true, cpatchOpts: { interiorN: 8 }, aacFill: false, unifiedMorph: true }
    : eng === 'lb' ? { aacFill: false, unifiedMorph: true }
    : { aacFill: false });
  r.setLoopBlinnFill(eng === 'slug' ? 'off' : 'on');
  const all = [];
  for (let i = 0; i < KMAX; i++)
    all.push(createShapeMorph(gl, createBundle(gl, await importSvg(${JSON.stringify(svg(A))})),
                                  createBundle(gl, await importSvg(${JSON.stringify(svg(B))}))));
  // Every bundle must reach its engine before it is timed. A CPatch plan is requested BY
  // prepareBundle, so a bundle never prepared reads undefined and waiting only on 'pending'
  // returns before it has asked.
  for (const m of all) m.setT(0);
  for (let i = 0; i < 1600; i++) {
    let pend = false;
    for (const m of all) {
      const b = m.bundle || m;
      if (r.prepareBundle) { try { r.prepareBundle(b); } catch {} }
      const pl = b._cpatchMorphPlan;
      if (eng === 'cpatch' && (pl === undefined || pl === 'pending')) pend = true;
    }
    if (!pend) break;
    await sleep(20);
  }
  for (const m of all) { if (r.awaitLbReady) { try { await r.awaitLbReady(m, 20000); } catch {} } }
  // K HAS TO SCALE THE WORK, AND MAKING IT DO SO IS THE HARD PART. Three ways tried:
  //
  //   OVERLAPPING, opaque — every bundle is fitted to the viewport, so K identical shapes land on
  //   the same pixels and shared-depth hidden-surface removal makes all but the front one nearly
  //   free FOR THE ENGINES THAT CLAIM DEPTH. That is not an engine comparison: stacked morphs can
  //   show CPatch flat at 16.70ms through 128 morphs while LB reads 137 and Slug 325, because
  //   CPatch draws one of them and Slug all 128.
  //
  //   TRANSLUCENT overlap — alpha below 1 defeats the depth claim, so every draw shades. It also
  //   routes somewhere far more expensive; K=4 at 512 did not finish inside 560s. Unusable.
  //
  //   TILED, which is what this does. A grid of 1/side-scale copies, so no two draws share a
  //   pixel and no engine can be flattered by overlap. Honest, and it under-loads: each copy is
  //   smaller, so K=side^2 totals a single canvas of fill. Saturation therefore has to come from
  //   the RESOLUTION, not from K — raise N until the curve bends, and read K as per-draw cost.
  const side = Math.max(1, Math.ceil(Math.sqrt(KMAX)));
  const cell = (i) => {
    const cx = i % side, cy = (i / side) | 0, sc = 1 / side;
    return new Float32Array([sc, 0, 0, 0, 0, sc, 0, 0, 0, 0, 1, 0,
                             -1 + sc * (2 * cx + 1), -1 + sc * (2 * cy + 1), 0, 1]);
  };
  const draw = (k, t) => {
    for (let i = 0; i < k; i++) { all[i].setT(t); if (r.prepareBundle) { try { r.prepareBundle(all[i].bundle || all[i]); } catch {} } }
    r.setViewport(S, S); r.beginFrame([0, 0, 0, 1]);
    for (let i = 0; i < k; i++) r.drawBundle(all[i], { worldMatrix: cell(i) });
    r.endFrame();
  };
  for (let i = 0; i < 30; i++) { draw(KMAX, 0.5); if (r.precompileFills) { try { r.precompileFills(); } catch {} } await sleep(0); }
  rigs.push({ eng, r, all, draw,
              built: all.map((m) => ((m.bundle || m)._cpatchBuilt | 0)).reduce((x, y) => x + y, 0) });
}

/// Drive rAF for FRAMES callbacks, drawing k morphs each, and return the intervals between them.
const burst = (rig, k) => new Promise((resolve) => {
  const iv = [];
  let n = 0, last = 0, kk = 0;
  const step = (ts) => {
    if (last) iv.push(ts - last);
    last = ts;
    rig.draw(k, 0.15 + 0.7 * ((kk = (kk + 1) & 255) / 255));
    if (++n < FRAMES) requestAnimationFrame(step); else resolve(iv);
  };
  requestAnimationFrame(step);
});

const out = [];
for (let round = 0; round < ROUNDS; round++) {
  for (let pos = 0; pos < rigs.length; pos++) {
    const rig = rigs[(round + pos) % rigs.length];          // rotate, as the paired probe does
    for (const k of KS) {
      await burst(rig, k);                                   // untimed warm burst
      const iv = await burst(rig, k);
      out.push({ eng: rig.eng, k, ms: median(iv), built: rig.built });
    }
  }
}
window.__out = { rows: out, ks: KS, engines: ENGINES };
window.__ready = 1;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    const body = fs.readFileSync(p);
    res.writeHead(200, {
      'Content-Type': p.endsWith('.js') || p.endsWith('.mjs') ? 'text/javascript' : 'text/plain',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('nope');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--use-angle=metal', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__ready === 1', { timeout: 540000 });
const o = await page.evaluate('window.__out');
await browser.close();
server.close();

const med = (a) => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
};
console.log(
  `\nFrame pacing on a PRESENTING loop, ${N}x${N}, ${FRAMES} frames a burst, ${ROUNDS} rotated rounds\n`,
);
const kMin = Math.min(...o.ks);
const k1 = med(o.rows.filter((r) => r.k === kMin).map((r) => r.ms));
const paced = k1 != null && k1 > 14 && k1 < 19;
console.log(
  `  rAF at K=${kMin} is ${k1 == null ? '?' : k1.toFixed(2)}ms — ${
    paced
      ? 'PACED (~60Hz), so read these as headroom: 16.70 means keeping up, and any climb is dropped frames'
      : 'FREE-RUNNING, so these intervals ARE the frame cost'
  }\n`,
);
console.log('  engine   ' + o.ks.map((k) => ('K=' + k).padStart(9)).join('') + '     cpatchBuilt');
for (const eng of o.engines) {
  const cells = o.ks.map((k) => {
    const v = med(o.rows.filter((r) => r.eng === eng && r.k === k).map((r) => r.ms));
    return (v == null ? '-' : v.toFixed(2)).padStart(9);
  });
  const b = o.rows.find((r) => r.eng === eng);
  console.log(`  ${eng.padEnd(8)} ${cells.join('')}     ${b ? b.built : '-'}`);
}
console.log(
  '\n  cpatchBuilt is how many of the ' +
    Math.max(...o.ks) +
    ' bundles actually reached CPatch.' +
    ' Anything less and that row is a different engine wearing the name.',
);
