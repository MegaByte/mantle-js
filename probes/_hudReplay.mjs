// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _hudReplay.mjs — reproduce a HUD fuzzy-edge/corner-notch defect
// from a captured draw state (probes/_hudCaptureOut/*.json produced by the
// __HUD_CAPTURE hook in the running app), in isolation, comparing LB vs Slug.
//
//   CAP=probes/_hudCaptureOut/cap0.json node probes/_hudReplay.mjs   # replay a real capture
//   node probes/_hudReplay.mjs                                        # SELF-TEST the roundtrip
//
// Self-test: synthesize a translucent, non-uniform-scaled rect + tint override in
// the harness, capture it through the same __HUD_CAPTURE hook, replay the capture,
// and assert replay==original (validates the capture/replay pipeline end-to-end
// without needing the game). Then it renders LB vs Slug of that state and reports
// any edge divergence — the fuzz/notch, if the synthetic state triggers it.
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { launchBrowser } from '../test/_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'probes/_hudReplayOut');
mkdirSync(OUT, { recursive: true });
const CAP = process.env.CAP ? JSON.parse(readFileSync(process.env.CAP, 'utf8')) : null;

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="512" height="512"></canvas>
<script type="module">
globalThis.__HUD_CAPTURE = { all: true };   // capture every draw during self-test synth
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true, depth:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders);
const grab = (w,h) => { const p = new Uint8Array(w*h*4); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,p); return Array.from(p); };

// Rebuild a bundle from a capture's raw geometry by recreating the SVG rect it
// represents (the HUD bg is a rectContour). We match the captured bbox + fill.
async function rebuildBundle(capBundle) {
  const bb = capBundle.globalBBox || [0,0,100,40];
  const [x0,y0,x1,y1] = bb;
  const f = capBundle.shape0Fill || [1,1,1,0.392];
  const rgb = 'rgb(' + Math.round(f[0]*255) + ',' + Math.round(f[1]*255) + ',' + Math.round(f[2]*255) + ')';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + x0 + ' ' + y0 + ' ' + (x1-x0) + ' ' + (y1-y0) + '">'
    + '<rect x="' + x0 + '" y="' + y0 + '" width="' + (x1-x0) + '" height="' + (y1-y0) + '" fill="' + rgb + '" fill-opacity="' + f[3] + '"/></svg>';
  return createBundle(gl, await importSvg(svg, { preserveViewport: true }));
}

// Recreate the exact override table from a captured packedBuffer.
function rebuildOverrides(bundle, capOv) {
  if (!capOv || !capOv.packedBuffer) return null;
  const t = createOverrideTable(gl, bundle);
  if (t.packedBuffer && t.packedBuffer.length >= capOv.packedBuffer.length) {
    t.packedBuffer.set(capOv.packedBuffer.slice(0, t.packedBuffer.length));
    t.markDirty && t.markDirty();
    t.uploadIfDirty && t.uploadIfDirty();
  }
  return t;
}

// Render one capture with a given fill mode into the default framebuffer; returns pixels.
async function renderCapture(cap, mode) {
  const [vw, vh] = cap.viewport && cap.viewport[0] ? cap.viewport : [512,512];
  const bundle = await rebuildBundle(cap.bundle);
  const ov = rebuildOverrides(bundle, cap.overrides);
  R.setLoopBlinnFill(mode);
  R.setViewport(vw, vh); gl.viewport(0,0,vw,vh);
  if (R.prepareBundle) R.prepareBundle(bundle);
  if (R.awaitLbReady) await R.awaitLbReady(bundle);
  // Per-slot alpha may ride inst.tint (instanced HUD path) — fold its alpha into
  // the draw alpha (white-bg tint ⇒ color is 1,1,1, only alpha matters).
  const instTa = cap.instTint ? (cap.instTint[3] == null ? 1 : cap.instTint[3]) : 1;
  const opts = { worldMatrix: cap.worldMatrix ? new Float32Array(cap.worldMatrix) : undefined,
                 alpha: (cap.alpha == null ? 1 : cap.alpha) * instTa, overrides: ov || undefined };
  R.beginFrame([1,1,1,1]); R.drawInstance(bundle, opts); R.endFrame();
  const px = grab(vw, vh);
  bundle.dispose && bundle.dispose();
  return { px, vw, vh };
}

// Edge divergence: count pixels where LB and Slug differ, split into "darker than
// both bg+interior" (fuzz/overlap) vs plain AA-rim, and the max channel delta.
function edgeDiff(a, b, n) {
  let diff=0, strong=0, mx=0;
  for (let i=0;i<n;i++){ const o=i*4;
    const d=Math.max(Math.abs(a[o]-b[o]),Math.abs(a[o+1]-b[o+1]),Math.abs(a[o+2]-b[o+2]),Math.abs(a[o+3]-b[o+3]));
    if (d>mx) mx=d; if (d>10){ diff++; if (d>40) strong++; } }
  return { diff, strong, mx };
}

window.__replay = async (cap) => {
  const lb = await renderCapture(cap, 'on');
  const slug = await renderCapture(cap, 'off');
  const d = edgeDiff(lb.px, slug.px, lb.vw*lb.vh);
  return { vw: lb.vw, vh: lb.vh, lb: lb.px, slug: slug.px, diff: d,
           effA: cap.effectiveAlpha, tintA: cap.tintAlpha, nonUniform: cap.nonUniform };
};

window.__selftest = async () => {
  // synthesize: a WIDE translucent white rect + a tint override that fades alpha,
  // under a NON-UNIFORM world matrix (the HUD-slot shape).
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><rect id="bg" x="0" y="0" width="100" height="40" fill="rgb(255,255,255)" fill-opacity="0.392"/></svg>';
  const bundle = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  const ov = createOverrideTable(gl, bundle);
  ov.set('bg', { tint: [1,1,1,0.6] });   // bg alpha via tint (like the game)
  ov.uploadIfDirty && ov.uploadIfDirty();
  R.setViewport(512,512); gl.viewport(0,0,512,512);
  if (R.prepareBundle) R.prepareBundle(bundle);
  if (R.awaitLbReady) await R.awaitLbReady(bundle);
  // non-uniform: 3.6x wide, 1.4x tall, centerd-ish. column-major mat3.
  const sx=3.6, sy=1.4, wm = new Float32Array([sx,0,0, 0,sy,0, 40,120,1]);
  globalThis.__HUD_CAPTURES = [];
  R.setLoopBlinnFill('off');
  R.beginFrame([1,1,1,1]); R.drawInstance(bundle, { worldMatrix: wm, overrides: ov, alpha: 1 }); R.endFrame();
  const original = grab(512,512);
  const cap = (globalThis.__HUD_CAPTURES || [])[0] || null;
  bundle.dispose && bundle.dispose();
  if (!cap) return { ok:false, err:'capture hook did not fire' };
  // replay the capture (Slug, to compare to the original Slug render)
  const rep = await renderCapture(cap, 'off');
  const round = edgeDiff(original, rep.px, 512*512);
  // and the LB-vs-Slug divergence of the replayed state
  const play = await window.__replay(cap);
  return { ok:true, capturePresent:true, cap:{ effA:cap.effectiveAlpha, tintA:cap.tintAlpha, nonUniform:cap.nonUniform, shapes:cap.bundle.numShapes },
           roundtrip: round, lbVsSlug: play.diff };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  const p = decodeURIComponent(u.pathname);
  const mm = p.endsWith('.js') || p.endsWith('.mjs') ? 'text/javascript' : 'text/plain';
  try {
    res.writeHead(200, { 'content-type': mm + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await launchBrowser({
  headless: true,
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('  [console]', m.text().slice(0, 200));
});
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 30000,
});
await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });

const ppm = (px, w, h, file) => {
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((h - 1 - y) * w + x) * 4,
        d = (y * w + x) * 3;
      buf[d] = px[s];
      buf[d + 1] = px[s + 1];
      buf[d + 2] = px[s + 2];
    }
  writeFileSync(path.join(OUT, file), Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), buf]));
};

if (CAP) {
  // __HUD_CAPTURES is an ARRAY. List them, then pick one: env IDX, else auto-pick
  // the HUD bg box (non-uniform + translucent + fewest shapes + widest aspect).
  const caps = Array.isArray(CAP) ? CAP : [CAP];
  const aspect = (c) => {
    const m = c.worldMatrix;
    if (!m) return 1;
    const l0 = Math.hypot(m[0], m[1]),
      l1 = Math.hypot(m[3], m[4]);
    return Math.max(l0, l1) / Math.max(1e-9, Math.min(l0, l1));
  };
  console.log(`${caps.length} capture(s):`);
  caps.forEach((c, i) =>
    console.log(
      `  [${i}] effA=${(c.effectiveAlpha ?? 1).toFixed(3)} tintA=${(c.tintAlpha ?? 1).toFixed?.(3) ?? c.tintAlpha} baseA=${(c.baseFillAlpha ?? 1).toFixed?.(3) ?? c.baseFillAlpha} nonUniform=${c.nonUniform} shapes=${c.bundle?.numShapes} aspect=${aspect(c).toFixed(2)} vp=${c.viewport}`,
    ),
  );
  let idx = process.env.IDX != null ? +process.env.IDX : -1;
  if (idx < 0) {
    const cand = caps
      .map((c, i) => ({ i, c }))
      .filter(({ c }) => c.bundle && c.nonUniform && (c.effectiveAlpha ?? 1) < 0.999);
    cand.sort((a, b) => a.c.bundle.numShapes - b.c.bundle.numShapes || aspect(b.c) - aspect(a.c));
    idx = cand.length ? cand[0].i : 0;
  }
  const cap = caps[idx];
  if (!cap || !cap.bundle) {
    console.error(`no usable capture at index ${idx} (missing .bundle)`);
    await browser.close();
    server.close();
    process.exit(1);
  }
  console.log(`→ replaying [${idx}]`);
  const r = await page.evaluate((c) => window.__replay(c), cap);
  ppm(r.lb, r.vw, r.vh, 'lb.ppm');
  ppm(r.slug, r.vw, r.vh, 'slug.ppm');
  // diff mask: red where LB!=Slug
  const mbuf = Buffer.alloc(r.vw * r.vh * 3);
  for (let i = 0; i < r.vw * r.vh; i++) {
    const o = i * 4;
    const d = Math.max(
      Math.abs(r.lb[o] - r.slug[o]),
      Math.abs(r.lb[o + 1] - r.slug[o + 1]),
      Math.abs(r.lb[o + 2] - r.slug[o + 2]),
      Math.abs(r.lb[o + 3] - r.slug[o + 3]),
    );
    const yy = (i / r.vw) | 0,
      xx = i % r.vw,
      dd = ((r.vh - 1 - yy) * r.vw + xx) * 3;
    if (d > 10) {
      mbuf[dd] = 255;
      mbuf[dd + 1] = d > 40 ? 0 : 180;
      mbuf[dd + 2] = 0;
    } else {
      mbuf[dd] = r.lb[o];
      mbuf[dd + 1] = r.lb[o + 1];
      mbuf[dd + 2] = r.lb[o + 2];
    }
  }
  writeFileSync(
    path.join(OUT, 'diff.ppm'),
    Buffer.concat([Buffer.from(`P6\n${r.vw} ${r.vh}\n255\n`), mbuf]),
  );
  console.log(`REPLAY effA=${r.effA} tintA=${r.tintA} nonUniform=${r.nonUniform}`);
  console.log(
    `LB vs Slug: diff=${r.diff.diff}px strong=${r.diff.strong} maxΔ=${r.diff.mx}  (>0 strong ⇒ the bug reproduced)`,
  );
  console.log(`images: ${OUT}/lb.ppm slug.ppm diff.ppm`);
} else {
  const r = await page.evaluate(() => window.__selftest());
  console.log('SELF-TEST', JSON.stringify(r, null, 1));
  if (!r.ok) {
    console.error('FAIL: ' + r.err);
  } else {
    console.log(
      `roundtrip capture→replay: diff=${r.roundtrip.diff}px maxΔ=${r.roundtrip.mx} (want ~0 — replay reproduces the original draw)`,
    );
    console.log(
      `replayed LB vs Slug: diff=${r.lbVsSlug.diff}px strong=${r.lbVsSlug.strong} maxΔ=${r.lbVsSlug.mx}`,
    );
  }
}
await browser.close();
server.close();
