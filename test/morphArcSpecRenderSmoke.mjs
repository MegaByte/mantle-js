// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphArcSpecRenderSmoke -- on the GPU, an arc morph draws what SVG 2, 9.3.2 draws, on the CPU lerp and on the GPU lerp with its fixup pass, in Slug and AAC, and a
// Loop-Blinn or CPatch pin draws it too (through the cover-quad kernel, since a control-point lerp cannot). The reference is Chrome at 8x box-averaged: animating `d` where Chrome and the spec
// agree (rotation and radii), the spec's numbers drawn static for the flags, and `d` animating again for compat: 'chrome', which steps a flag where Chrome does.
// A thin ellipse F.6.6 scaled far up, turning through 180, is here for the fixup pass: sin(pi) reads exactly 0 and atan(+1, -0) read -pi/2, so the GPU route alone bulged the wrong way.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
const ROOT =
  process.env.MANTLE_ARC_SPEC_TREE ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 128,
  S = 8,
  FLAT = 32;
const paint = (stroke) => (stroke ? 'fill="none" stroke="#000" stroke-width="5"' : 'fill="#000"');
const svgOf = (d, stroke, extra = '', size = 0) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"${size ? ` width="${size}" height="${size}"` : ''}>${extra}<path id="p" d="${d}" ${paint(stroke)}/></svg>`;
const CASES = [
  { name: 'a quarter turn', a: 'M30 64A40 10 0 1 1 98 64Z', b: 'M30 64A40 10 90 1 1 98 64Z' },
  {
    name: '350 to 10',
    a: 'M30 64A40 12 350 0 1 98 64Z',
    b: 'M30 64A40 12 10 0 1 98 64Z',
    nearest: 'M30 64A40 12 350 0 1 98 64Z'.replace('350', '370'),
  },
  { name: 'radii swapped', a: 'M30 64A40 12 0 0 1 98 64Z', b: 'M30 64A12 40 90 0 1 98 64Z' },
  {
    name: 'a thin ellipse turning',
    a: 'M60 20A32 .4 0 0 1 60 60L90 60L90 20Z',
    b: 'M60 20A32 .4 240 0 1 60 60L90 60L90 20Z',
  },
  {
    name: 'stroke turning',
    a: 'M30 64A40 12 0 0 1 98 64',
    b: 'M30 64A40 12 120 0 1 98 64',
    stroke: true,
  },
  {
    name: 'a chord swinging through zero',
    a: 'M40 64A24 24 0 0 1 88 64Z',
    b: 'M88 64A24 24 0 0 1 40 64Z',
  },
  { name: 'a chord shortening', a: 'M40 64A24 24 0 1 1 88 64Z', b: 'M60 64A12 12 0 1 1 68 64Z' },
  {
    name: 'sweep 0 to 1',
    a: 'M30 64A40 40 0 0 0 98 64Z',
    b: 'M30 64A40 40 0 0 1 98 64Z',
    flags: true,
  },
  {
    name: 'large 1 to 0',
    a: 'M30 64A40 40 0 1 1 98 64Z',
    b: 'M30 64A40 40 0 0 1 98 64Z',
    flags: true,
  },
  {
    name: 'each flag the other way',
    a: 'M30 64A40 40 0 1 0 98 64Z',
    b: 'M30 64A40 40 0 0 1 98 64Z',
    flags: true,
  },
];
const TS = [0, 0.25, 0.75, 1];
const specD = (a, b, t) => {
  if (t === 0) return a;
  if (t === 1) return b;
  const A = [...a.matchAll(/[MLAZ]|-?\d*\.?\d+/g)].map((m) => m[0]),
    B = [...b.matchAll(/[MLAZ]|-?\d*\.?\d+/g)].map((m) => m[0]);
  let out = '',
    cmd = '',
    n = 0;
  A.forEach((v, k) => {
    if (/[A-Z]/.test(v)) {
      cmd = v;
      n = 0;
      out += v;
      return;
    }
    const x = +v + (+B[k] - +v) * t,
      flag = cmd === 'A' && (n === 3 || n === 4);
    out += (n ? ' ' : '') + (flag ? (x !== 0 ? 1 : 0) : x);
    n++;
  });
  return out;
};
const cssAt = (c, t) =>
  svgOf(
    c.a,
    c.stroke,
    `<style>@keyframes k{from{d:path("${c.a}")}to{d:path("${c.b}")}}#p{animation:k 1000ms linear both paused;animation-delay:${-t * 1000}ms}</style>`,
    N * S,
  );
const HTML = `<!doctype html><canvas id="c" width="${N}" height="${N}"></canvas><script type="module">
import {importSvg,createBundle,createRenderer,loadShaders,createShapeMorph} from '/src/index.js';
const gl=c.getContext('webgl2',{depth:true,antialias:false,preserveDrawingBuffer:true});
const r=createRenderer(gl,await loadShaders(new URL('/src/shaders/',location.href)));r.setViewport(${N},${N});
const PINS={cpu:{},gpu:{},aac:{route:'none',kernel:'aac',primitives:'off'},lb:{route:'lb'},cpatch:{route:'cpatch'}};
const same=(a,b)=>{for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;};
const read=()=>{const px=new Uint8Array(${N}*${N}*4);gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px);const o=new Uint8Array(${N}*${N});for(let y=0;y<${N};y++)for(let x=0;x<${N};x++)o[y*${N}+x]=px[((${N}-1-y)*${N}+x)*4];return o;};
window.raster=async(svg)=>{const img=new Image();img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);await img.decode();
 const cv=document.createElement('canvas');cv.width=cv.height=${N * S};const cx=cv.getContext('2d',{willReadFrequently:true});cx.fillStyle='#fff';cx.fillRect(0,0,${N * S},${N * S});cx.drawImage(img,0,0,${N * S},${N * S});
 const d=cx.getImageData(0,0,${N * S},${N * S}).data,o=new Array(${N * N});for(let y=0;y<${N};y++)for(let x=0;x<${N};x++){let s=0;for(let j=0;j<${S};j++)for(let i=0;i<${S};i++)s+=d[((y*${S}+j)*${N * S}+x*${S}+i)*4];o[y*${N}+x]=Math.round(s/${S * S});}return o;};
window.arm=async(arm,sa,sb,ts,compat,arcRotation)=>{
 r.setFillEngine({route:'auto',kernel:'auto',primitives:'on'});r.setFillEngine(PINS[arm]);
 const A=createBundle(gl,await importSvg(sa,{preserveViewport:true})),B=createBundle(gl,await importSvg(sb,{preserveViewport:true}));
 const m=createShapeMorph(gl,A,B,{cpuLerp:arm==='cpu',compat,arcRotation});if(arm!=='cpu')m.bundle._morphSrc.gpuSmallPlanes=true;
 const out=[];for(const t of ts){m.setT(t);let prev=null,cur=null;for(let f=0;f<80;f++){r.beginFrame([1,1,1,1]);r.drawBundle(m);r.endFrame();await new Promise(ok=>setTimeout(ok,10));cur=read();
   const pending=m.bundle._cpatchMorphPlan==='pending'||(arm==='lb'&&m.bundle._morphWorkerSrc&&!m.bundle._morphMeshesBuilt);if(prev&&f>=3&&!pending&&same(prev,cur))break;prev=cur;}out.push(Array.from(cur));}
 const err=gl.getError();m.dispose();A.dispose?.();B.dispose?.();return {frames:out,err};};
window.__ready=true;</script>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://local').pathname;
  if (u === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(HTML);
    return;
  }
  const f = path.resolve(ROOT, '.' + decodeURIComponent(u));
  if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader('Content-Type', f.endsWith('.js') ? 'text/javascript' : 'text/plain');
  res.end(readFileSync(f));
});
let browser;
try {
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(e.message));
  await openReady(page, 'http://127.0.0.1:' + server.address().port + '/');
  const raster = (svg) => page.evaluate((s) => window.raster(s), svg);
  let poses = 0;
  const check = (px, ref, label, bar) => {
    let flat = 0,
      worst = 0;
    for (let i = 0; i < ref.length; i++) {
      const d = Math.abs(px[i] - ref[i]);
      if (d > worst) worst = d;
      if (d > FLAT) flat++;
    }
    assert.ok(
      flat <= bar,
      `${label}: ${flat} px off by over ${FLAT}/255, worst ${worst} (bar ${bar})`,
    );
    poses++;
  };
  for (const c of CASES) {
    const sa = svgOf(c.a, c.stroke),
      sb = svgOf(c.b, c.stroke);
    const refs = [];
    for (const t of TS)
      refs.push(
        await raster(c.flags ? svgOf(specD(c.a, c.b, t), c.stroke, '', N * S) : cssAt(c, t)),
      );
    for (const arm of ['cpu', 'gpu', 'aac', 'lb', 'cpatch']) {
      const { frames, err } = await page.evaluate(
        (arm, a, b, ts) => window.arm(arm, a, b, ts),
        arm,
        sa,
        sb,
        TS,
      );
      assert.equal(err, 0, `${c.name}, ${arm}: a GL error`);
      frames.forEach((px, k) => check(px, refs[k], `${c.name}, ${arm}, t = ${TS[k]}`, 2));
    }
    if (c.nearest) {
      // arcRotation: 'shortest' draws what the numbers draw once the destination is written nearest
      const nearRefs = [];
      for (const t of TS) nearRefs.push(await raster(cssAt({ ...c, b: c.nearest }, t)));
      for (const arm of ['cpu', 'gpu', 'aac', 'lb', 'cpatch']) {
        const { frames, err } = await page.evaluate(
          (arm, a, b, ts) => window.arm(arm, a, b, ts, undefined, 'shortest'),
          arm,
          sa,
          sb,
          TS,
        );
        assert.equal(err, 0, `${c.name}, shortest, ${arm}: a GL error`);
        frames.forEach((px, k) =>
          check(px, nearRefs[k], `${c.name}, shortest, ${arm}, t = ${TS[k]}`, 2),
        );
      }
    }
    if (c.flags) {
      const { frames } = await page.evaluate(
        (a, b, ts) => window.arm('gpu', a, b, ts, 'chrome'),
        sa,
        sb,
        TS,
      );
      for (let k = 0; k < TS.length; k++)
        check(
          frames[k],
          await raster(cssAt(c, TS[k])),
          `${c.name}, compat chrome, t = ${TS[k]}`,
          2,
        );
    }
  }
  console.log(`morphArcSpecRenderSmoke PASS: ${CASES.length} pairs, ${poses} poses`);
} finally {
  await browser?.close();
  await new Promise((ok) => server.close(ok));
}
process.exit(0);
