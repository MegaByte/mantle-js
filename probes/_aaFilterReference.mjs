// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _aaFilterReference — is our AA yardstick measuring ALIASING, or conformance to a box filter?
//
// Every AA number in this project is scored against an 8x supersampled BOX reference: AAC ~20x
// better than Slug, CPatch 0.10-0.76 against Loop-Blinn's exact arc SDF at 0.005. Manson &
// Schaefer 2013 (Analytic Rasterization of Curves with Polynomial Filters, EG) show that box is
// the WORST of the common filters — it passes high frequencies that tent and Mitchell remove —
// so a box reference scores CONFORMANCE TO BOX, and an engine could alias less while scoring
// worse.
//
// The naive version of this check is invalid and worth naming: scoring box-coverage engines
// against a tent reference just reports that none of them implements a tent filter, and every
// arm gets worse together. What matters is whether the RANKING moves. So each engine is scored
// against three references built from the same 8x render — box, tent, Mitchell-Netravali — and
// the orderings are compared.
//
// The fixture has to alias, or there is nothing to measure. A radial fan puts unbounded
// frequency near the center (Manson's Figures 5 and 6 use the same idea), and the curved
// variant does it with quadratics so the curve kernels are exercised rather than only the
// straight-edge path.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const C = 200,
  R = 190;
/// N wedges radiating from the center. Frequency rises without bound toward the middle, which
/// is exactly where a box filter fails and a wider filter does not.
function fanSvg(n, curved) {
  const f = (v) => v.map((q) => q.toFixed(3)).join(' ');
  const pt = (a, r) => [C + r * Math.cos(a), C + r * Math.sin(a)];
  let d = '';
  for (let k = 0; k < n; k++) {
    const a0 = (2 * Math.PI * k) / n,
      a1 = a0 + Math.PI / n;
    const A = pt(a0, R),
      B = pt(a1, R);
    if (!curved) d += `M ${f([C, C])} L ${f(A)} L ${f(B)} Z `;
    else {
      // Bow each outer edge so the wedge boundary is a quadratic rather than a chord.
      const am = (a0 + a1) / 2;
      const M = pt(am, R * 1.18);
      d += `M ${f([C, C])} L ${f(A)} Q ${f(M)} ${f(B)} Z `;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><path d="${d}" fill="#000"/></svg>`;
}

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="2048" height="2048"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cv=document.getElementById('c');
const gl=cv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const sync=()=>{const p=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return p[0];};

async function render(svg, engine, res){
  // gwnTree:true only BUILDS the run tree; the renderer still needs MANTLE_GWN to use it.
  // Without the define the arm renders through the ordinary path and is a duplicate of Slug —
  // which is exactly what the first run of this probe reported, slug and gwn agreeing to three
  // decimals on every fixture.
  const opts = engine==='aac' ? {aacFill:true}
             : engine==='gwn' ? {fillDefines:['MANTLE_GWN','MANTLE_GWN_SDF']} : {};
  const r=createRenderer(gl,shaders,opts);
  if(engine==='lb') r.setLoopBlinnFill('on');
  const sec=await importSvg(svg, engine==='gwn'?{gwnTree:true}:undefined);
  const b=createBundle(gl,sec); r.prepareBundle&&r.prepareBundle(b);
  if(engine==='lb'&&r.awaitLbReady) await r.awaitLbReady(b,30000).catch(()=>{});
  cv.width=res; cv.height=res; r.setViewport(res,res); gl.viewport(0,0,res,res);
  for(let i=0;i<40;i++){ r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
    if((r.debugStats&&r.debugStats.unifiedFillGate)!=='variant-warming') break;
    await new Promise(s=>setTimeout(s,10)); }
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
  const px=new Uint8Array(res*res*4); gl.readPixels(0,0,res,res,gl.RGBA,gl.UNSIGNED_BYTE,px);
  b.dispose();
  const out=new Float64Array(res*res);
  let ink=0;
  for(let i=0;i<res*res;i++){ out[i]=(255-px[i*4])/255; if(out[i]>0.5) ink++; }
  out.inkFrac = ink/(res*res);
  return out;
}
window.__render=render;
window.__ready=true;
</script></body></html>`;

/// Downsample an S-times supersampled image with a separable filter of the given radius in
/// OUTPUT pixels. Box r=0.5 reduces to the plain block average every other probe uses.
function downsample(src, srcRes, S, kernel, radius) {
  const n = srcRes / S,
    out = new Float64Array(n * n);
  const half = Math.ceil(radius * S);
  const w = [];
  let wsum = 0;
  for (let d = -half; d <= half; d++) {
    const t = (d + 0.5) / S;
    const v = kernel(t);
    w.push(v);
    wsum += v;
  }
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const cx = x * S + S / 2,
        cy = y * S + S / 2;
      let acc = 0,
        tot = 0;
      for (let j = 0; j < w.length; j++) {
        const sy = Math.round(cy + (j - half) + 0.5) - 1;
        if (sy < 0 || sy >= srcRes) continue;
        for (let i = 0; i < w.length; i++) {
          const sx = Math.round(cx + (i - half) + 0.5) - 1;
          if (sx < 0 || sx >= srcRes) continue;
          const ww = w[i] * w[j];
          acc += src[sy * srcRes + sx] * ww;
          tot += ww;
        }
      }
      out[y * n + x] = tot > 0 ? acc / tot : 0;
    }
  return out;
}
const boxK = (t) => (Math.abs(t) <= 0.5 ? 1 : 0);
const tentK = (t) => Math.max(0, 1 - Math.abs(t));
const mitchellK = (t) => {
  // Mitchell-Netravali B = C = 1/3
  const x = Math.abs(t) * 2,
    B = 1 / 3,
    Cc = 1 / 3;
  if (x < 1)
    return ((12 - 9 * B - 6 * Cc) * x ** 3 + (-18 + 12 * B + 6 * Cc) * x ** 2 + (6 - 2 * B)) / 6;
  if (x < 2)
    return (
      ((-B - 6 * Cc) * x ** 3 +
        (6 * B + 30 * Cc) * x ** 2 +
        (-12 * B - 48 * Cc) * x +
        (8 * B + 24 * Cc)) /
      6
    );
  return 0;
};
const score = (a, ref) => {
  let s = 0,
    c = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] > 0.004 || ref[i] > 0.004) {
      s += Math.abs(a[i] - ref[i]);
      c++;
    }
  }
  return (255 * s) / Math.max(c, 1);
};

const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, res) => {
  try {
    const _p = q.url.split('?')[0];
    if (_p === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    res.writeHead(200, { 'content-type': mime(_p) + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, decodeURIComponent(_p))));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 600000,
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction('window.__ready===true', { timeout: 60000 });

const Q = 256,
  S = 8;
const REF = process.env.REF || 'aac';
// LB is excluded: the ink gate shows it renders 1-5% of the ink on this fixture, which is a
// rendering defect on thin wedge fans and not an AA number. Tracked separately.
const ENGINES = ['aac', 'slug', 'gwn'];
for (const [label, curved] of [
  ['straight wedges', false],
  ['quadratic wedges', true],
]) {
  for (const n of [64, 160]) {
    const svg = fanSvg(n, curved);
    // One high-supersample render is the ground truth; the three references differ only in the
    // filter that resamples it, so any ranking change is the FILTER and nothing else.
    // THE REFERENCE ENGINE IS A VARIABLE, NOT A CONSTANT. Building the 8x ground truth with
    // AAC and then scoring AAC against it is self-agreement, and AAC is the arm whose lead is
    // in question — so REF selects which engine renders the truth and the comparison is run
    // both ways. If AAC's advantage only exists against an AAC-rendered reference, it is not
    // an accuracy result at all.
    const hi = await pg.evaluate(
      (s, e, r) => window.__render(s, e, r).then((a) => Array.from(a)),
      svg,
      REF,
      Q * S,
    );
    const hiF = Float64Array.from(hi);
    const refs = {
      box: downsample(hiF, Q * S, S, boxK, 0.5),
      tent: downsample(hiF, Q * S, S, tentK, 1),
      mitchell: downsample(hiF, Q * S, S, mitchellK, 1),
    };
    const rows = [];
    for (const e of ENGINES) {
      const raw = await pg.evaluate(
        (s, en, r) => window.__render(s, en, r).then((a) => ({ a: Array.from(a), ink: a.inkFrac })),
        svg,
        e,
        Q,
      );
      const img = Float64Array.from(raw.a);
      img.inkFrac = raw.ink;
      rows.push({
        e,
        ink: img.inkFrac,
        box: score(img, refs.box),
        tent: score(img, refs.tent),
        mitchell: score(img, refs.mitchell),
      });
    }
    const order = (k) =>
      rows
        .slice()
        .sort((a, b) => a[k] - b[k])
        .map((r) => r.e)
        .join(' < ');
    console.log(
      `\n${label}, ${n} wedges — ground truth rendered by ${REF.toUpperCase()} at ${S}x (err/255)`,
    );
    // INK GATE. An engine rendering the wrong picture scores an AA error that is not an AA
    // error; the reference's own ink fraction is the yardstick.
    let refInk = 0;
    for (const v of refs.box) if (v > 0.5) refInk++;
    refInk /= refs.box.length;
    console.log('  engine     box     tent   mitchell     ink   (ref ' + refInk.toFixed(3) + ')');
    for (const r of rows)
      console.log(
        `  ${r.e.padEnd(7)} ${r.box.toFixed(3).padStart(7)} ${r.tent.toFixed(3).padStart(7)} ${r.mitchell.toFixed(3).padStart(8)}` +
          `  ${r.ink.toFixed(3).padStart(6)}  ${Math.abs(r.ink - refInk) > 0.05 * Math.max(refInk, 1e-6) ? 'INK MISMATCH — not an AA number' : ''}`,
      );
    console.log(`  ranking by box      : ${order('box')}`);
    console.log(`  ranking by tent     : ${order('tent')}`);
    console.log(`  ranking by mitchell : ${order('mitchell')}`);
    console.log(
      `  -> ${
        order('box') === order('tent') && order('box') === order('mitchell')
          ? 'RANKING UNCHANGED — the box reference is not misleading us here'
          : 'RANKING CHANGES with the reference filter'
      }`,
    );
  }
}
await br.close();
server.close();
