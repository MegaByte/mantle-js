// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbBand2Smoke — Loop-Blinn corner and tip quality of kind-12 curve-band chains, scored against
// 4x AAC:
//   lbBand2   the unified curve band (kind 12) replaces the kind-9 strip and kind-8 corner caps
//   lbTip     line tips and shallow curve joints match 4x AAC without kind-8
// Each case runs on its own page (its own context and renderer) in one browser; see _caseHost.mjs.

import path from 'path';
import { fileURLToPath } from 'url';
import { openCaseHost, runCases } from './_caseHost.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// lbBand2 — guards the LB unified curve band (kind 12, always-on).
//
// Kind-12 replaces the legacy kind-9 bbox strip + kind-8 corner cap zoo for
// integral/rational exterior bands: one primitive per arc owning the exterior
// band AND both end wedges (all non-straight curve–curve corners chain; shallow
// joints use κ≡0 tangent combine so kind-8 is unnecessary).
//
// Asserts: emission (kind-12, no kind-9), corner quality vs 4× AAC, no new
// artifacts on ring / quad-line box.
async function lbBand2(host) {
  const N = 192,
    SS = 4;
  const wrap = (d) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#000000" d="${d}"/></svg>`;
  const wrapHi = (d) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N * SS} ${N * SS}" width="${N * SS}" height="${N * SS}"><path fill="#000000" d="${d}"/></svg>`;
  function quadRing(n) {
    const c = n / 2,
      r = n * 0.36,
      K = 8;
    const P = (i) => {
      const a = (i / K) * 2 * Math.PI;
      return [c + r * Math.cos(a), c + r * Math.sin(a)];
    };
    let d = `M ${P(0)[0].toFixed(4)} ${P(0)[1].toFixed(4)} `;
    for (let i = 0; i < K; i++) {
      const A = P(i),
        B = P(i + 1);
      const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.35,
        my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.35;
      d += `Q ${mx.toFixed(4)} ${my.toFixed(4)} ${B[0].toFixed(4)} ${B[1].toFixed(4)} `;
    }
    return d + 'Z';
  }
  function quadLineBox(n) {
    const a = 0.18 * n,
      b = 0.82 * n,
      bulge = 0.14 * n,
      m = n / 2;
    return `M ${a} ${a} Q ${m} ${a - bulge} ${b} ${a} L ${b} ${b} Q ${m} ${b + bulge} ${a} ${b} Z`;
  }
  function quadStar(n) {
    const c = n / 2,
      R = n * 0.42,
      r = n * 0.19,
      K = 5;
    let pts = [];
    for (let i = 0; i < 2 * K; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / K,
        rad = i % 2 ? r : R;
      pts.push([c + rad * Math.cos(a), c + rad * Math.sin(a)]);
    }
    let d = `M ${pts[0][0].toFixed(4)} ${pts[0][1].toFixed(4)} `;
    for (let i = 0; i < 2 * K; i++) {
      const A = pts[i],
        B = pts[(i + 1) % (2 * K)];
      const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.12,
        my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.12;
      d += `Q ${mx.toFixed(4)} ${my.toFixed(4)} ${B[0].toFixed(4)} ${B[1].toFixed(4)} `;
    }
    return d + 'Z';
  }
  const SHAPES = {
    ring: [wrap(quadRing(N)), wrapHi(quadRing(N * SS))],
    box: [wrap(quadLineBox(N)), wrapHi(quadLineBox(N * SS))],
    star: [wrap(quadStar(N)), wrapHi(quadStar(N * SS))],
  };

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N * SS}" height="${N * SS}"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N}, SS=${SS};
const mkR=(o,lb)=>{const r=createRenderer(gl,shaders,o); r.setLoopBlinnFill(lb); return r;};
const rAac=mkR({aacFill:true},'off'), rLb=mkR({},'on');
const grab=(w,h)=>{const p=new Uint8Array(w*h*4); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,p);
  const a=new Float64Array(w*h); for(let i=0;i<w*h;i++) a[i]=p[i*4]; return a;};
const render=async (r,svgTxt,n)=>{const b=createBundle(gl,svgTxt);
  r.prepareBundle && r.prepareBundle(b);
  if (r.awaitLbReady) await r.awaitLbReady(b);
  r.setViewport(n,n); gl.viewport(0,0,n,n);
  const c0=r.debugStats.loopBlinnRouteCount;
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const routed=r.debugStats.loopBlinnRouteCount-c0;
  const kinds={};
  for(const m of (b._lbMeshes||[])){ if(!m||!m.verts) continue;
    for(let i=0;i<m.vertexCount;i++){ const k=Math.floor(m.verts[i*24+5]+0.001); kinds[k]=(kinds[k]||0)+1; } }
  const a=grab(n,n); b.dispose(); return {a, routed, kinds};};
const down=(hi,n,ss)=>{const lo=new Float64Array(n*n);
  for(let y=0;y<n;y++) for(let x=0;x<n;x++){ let s=0;
    for(let j=0;j<ss;j++) for(let i=0;i<ss;i++) s+=hi[(y*ss+j)*(n*ss)+(x*ss+i)];
    lo[y*n+x]=s/(ss*ss); } return lo; };
const err=(a,ref)=>{ let sum=0, nEdge=0, nBad=0;
  for(let i=0;i<a.length;i++){ const r=ref[i]; if(r>2 && r<253){ const d=Math.abs(a[i]-r); sum+=d; if(d>25) nBad++; nEdge++; } }
  return {mean:sum/Math.max(1,nEdge), nBad}; };
window.__run = async (shapes) => {
  const out={};
  for(const [name,[svgTxt,svgHi]] of Object.entries(shapes)){
    const IV = { preserveViewport: true };
    const secLo=await importSvg(svgTxt, IV), secHi=await importSvg(svgHi, IV);
    const refR=await render(rAac, secHi, N*SS); const ref=down(refR.a,N,SS);
    const lb=await render(rLb, secLo, N);
    out[name]={ e:err(lb.a,ref), routed:lb.routed, kinds:lb.kinds };
  }
  return out;
};
window.__ready=true;</script></body></html>`;

  const br = host.browser;
  const pg = await br.newPage();
  pg.on('pageerror', (e) => console.error(' [err]', e.message));
  await pg.goto(host.page(HTML), { waitUntil: 'load', timeout: 90000 });
  await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 100 });
  const band2 = await pg.evaluate((s) => window.__run(s), SHAPES);
  await pg.close();

  let fail = 0;
  const check = (ok, msg) => {
    console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
    if (!ok) fail++;
  };
  for (const n of ['ring', 'box', 'star']) {
    check(band2[n].routed === 1, `${n}: LB routed`);
  }
  check((band2.star.kinds[12] || 0) > 0, `star emits kind-12 (${band2.star.kinds[12] || 0} verts)`);
  check(
    (band2.star.kinds[9] || 0) === 0,
    `star emits no kind-9 strips (${band2.star.kinds[9] || 0})`,
  );
  check(
    (band2.star.kinds[1] || 0) === 0,
    `star emits no kind-1 crescents (${band2.star.kinds[1] || 0})`,
  );
  check(
    (band2.star.kinds[11] || 0) === 0,
    `star emits no kind-11 (${band2.star.kinds[11] || 0}; integral→kind-5)`,
  );
  check(
    (band2.star.kinds[5] || 0) > 0,
    `star emits kind-5 fill crescents (${band2.star.kinds[5] || 0})`,
  );
  check(
    (band2.star.kinds[8] || 0) === 0,
    `star emits no kind-8 caps (${band2.star.kinds[8] || 0})`,
  );
  check(band2.star.e.nBad <= 12, `star bad px small (${band2.star.e.nBad} <= 12)`);
  check(band2.star.e.mean < 2.0, `star mean err (${band2.star.e.mean.toFixed(3)} < 2.0 /255)`);
  check(band2.ring.e.nBad === 0, `ring zero bad px (${band2.ring.e.nBad})`);
  check(band2.ring.e.mean < 0.8, `ring mean err (${band2.ring.e.mean.toFixed(3)} < 0.8 /255)`);
  check(band2.box.e.nBad <= 4, `box bad px bounded (${band2.box.e.nBad} <= 4)`);
  if (fail) {
    console.error(`LB-BAND2 FAIL (${fail})`);
    return fail;
  }
  console.log('LB-BAND2 PASS');
  return fail;
}

// lbTip — tips and shallow curve joints must match 4× AAC without kind-8.
//
// Line–line: kind-10 START tip-cession + adaptive VS reach.
// Curve–curve (incl. shallow): kind-12 chains (κ=0 when shallow).
async function lbTip(host) {
  const N = 192,
    SS = 4;
  const wrap = (d) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#000000" d="${d}"/></svg>`;
  const wrapHi = (d) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N * SS} ${N * SS}" width="${N * SS}" height="${N * SS}"><path fill="#000000" d="${d}"/></svg>`;

  function sharpV(n) {
    const m = n / 2,
      top = 0.12 * n,
      bot = 0.88 * n,
      half = 0.38 * n;
    return `M ${m} ${bot} L ${m - half} ${top} L ${m - half * 0.35} ${top} L ${m} ${bot - 0.08 * n} L ${m + half * 0.35} ${top} L ${m + half} ${top} Z`;
  }
  function box(n) {
    const a = 0.2 * n,
      b = 0.8 * n;
    return `M ${a} ${a} L ${b} ${a} L ${b} ${b} L ${a} ${b} Z`;
  }
  function kite(n) {
    const m = n / 2,
      R = 0.4 * n,
      r = 0.26 * n;
    return `M ${m} ${m - R} L ${m + r} ${m} L ${m} ${m + R} L ${m - r} ${m} Z`;
  }
  // Shallow-joint quad ring (small bulge → |turn| well below LB_BAND_SHARP_TURN).
  function shallowRing(n) {
    const c = n / 2,
      r = n * 0.36,
      K = 8;
    const P = (i) => {
      const a = (i / K) * 2 * Math.PI;
      return [c + r * Math.cos(a), c + r * Math.sin(a)];
    };
    let d = `M ${P(0)[0].toFixed(4)} ${P(0)[1].toFixed(4)} `;
    for (let i = 0; i < K; i++) {
      const A = P(i),
        B = P(i + 1);
      const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.08,
        my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.08;
      d += `Q ${mx.toFixed(4)} ${my.toFixed(4)} ${B[0].toFixed(4)} ${B[1].toFixed(4)} `;
    }
    return d + 'Z';
  }

  const SHAPES = {
    v: [wrap(sharpV(N)), wrapHi(sharpV(N * SS))],
    kite: [wrap(kite(N)), wrapHi(kite(N * SS))],
    box: [wrap(box(N)), wrapHi(box(N * SS))],
    shallow: [wrap(shallowRing(N)), wrapHi(shallowRing(N * SS))],
  };

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N * SS}" height="${N * SS}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N}, SS = ${SS};
const rSlug = createRenderer(gl, shaders, {}); rSlug.setLoopBlinnFill('off');
const rLb = createRenderer(gl, shaders, {}); rLb.setLoopBlinnFill('on');
const grab = (w, h) => { const p = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, p);
  const a = new Float64Array(w * h); for (let i = 0; i < w * h; i++) a[i] = p[i * 4]; return a; };
const render = async (r, sec, n) => {
  const b = createBundle(gl, sec);
  if (r !== rSlug && r.prepareBundle) r.prepareBundle(b);
  // prepareBundle is non-blocking by contract: it kicks off the mesh build and the
  // fill-variant link and returns. While that variant is still linking a bundle
  // falls to the best non-LB engine rather than to the classic coverage-RT routes,
  // so measuring the first frame would score another engine's AA as LB's.
  if (r !== rSlug && r.awaitLbReady) await r.awaitLbReady(b);
  r.setViewport(n, n); gl.viewport(0, 0, n, n);
  const c0 = r.debugStats.loopBlinnRouteCount;
  r.beginFrame([1, 1, 1, 1]); r.drawBundle(b); r.endFrame();
  const a = grab(n, n); a.routed = r.debugStats.loopBlinnRouteCount - c0;
  const kinds = {};
  for (const m of (b._lbMeshes || [])) if (m && m.verts)
    for (let i = 0; i < m.vertexCount; i++) {
      const k = Math.floor(m.verts[i * 24 + 5] + 0.001);
      kinds[k] = (kinds[k] || 0) + 1;
    }
  a.kinds = kinds;
  b.dispose(); return a;
};
const down = (hi, n, ss) => {
  const lo = new Float64Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let s = 0; for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) s += hi[(y * ss + j) * (n * ss) + (x * ss + i)];
    lo[y * n + x] = s / (ss * ss);
  }
  return lo;
};
window.__run = async (shapes) => {
  const out = {};
  for (const [name, [lo, hi]] of Object.entries(shapes)) {
    const secLo = await importSvg(lo), secHi = await importSvg(hi);
    const ref = down(await render(rSlug, secHi, N * SS), N, SS);
    const x = await render(rLb, secLo, N);
    let sum = 0, nEdge = 0, nBad = 0;
    for (let i = 0; i < x.length; i++) {
      const r = ref[i]; if (r > 2 && r < 253) { const d = Math.abs(x[i] - r); sum += d; if (d > 25) nBad++; nEdge++; }
    }
    out[name] = { routed: x.routed, kinds: x.kinds, mean: sum / Math.max(1, nEdge), nBad, nEdge };
  }
  return out;
};
window.__ready = true;
</script></body></html>`;

  const br = host.browser;
  const pg = await br.newPage();
  pg.on('pageerror', (e) => console.error(' [err]', e.message));
  await pg.goto(host.page(HTML), { waitUntil: 'load', timeout: 90000 });
  await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
  const o = await pg.evaluate((s) => window.__run(s), SHAPES);
  await pg.close();

  let fail = 0;
  const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));
  for (const [n, e] of Object.entries(o)) {
    console.log(
      `  ${n}: routed=${e.routed} kinds=${JSON.stringify(e.kinds)} mean=${e.mean.toFixed(3)} bad=${e.nBad}`,
    );
    ok(e.routed > 0, `${n}: LB routed`);
    if (n === 'shallow') {
      ok((e.kinds[12] || 0) > 0, `${n}: emits kind-12 (${e.kinds[12] || 0})`);
    } else {
      ok((e.kinds[10] || 0) > 0, `${n}: emits kind-10 (${e.kinds[10] || 0})`);
    }
    ok((e.kinds[8] || 0) === 0, `${n}: no kind-8 (${e.kinds[8] || 0})`);
    ok(e.nBad <= 8, `${n}: bad px bounded (${e.nBad} <= 8)`);
    ok(e.mean < 2.5, `${n}: mean err (${e.mean.toFixed(3)} < 2.5 /255)`);
  }
  console.log(fail ? `\nLB-TIP FAIL (${fail})` : '\nLB-TIP PASS');
  return fail;
}

const host = await openCaseHost(ROOT, { headless: 'new', args: ['--no-sandbox'] });
const failures = await runCases(host, [
  ['lbBand2', lbBand2],
  ['lbTip', lbTip],
]);
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nlbBand2Smoke: kind-12 bands and tips match 4x AAC');
