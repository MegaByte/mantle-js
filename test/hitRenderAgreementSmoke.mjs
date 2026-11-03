// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// hitRenderAgreementSmoke — hit testing must answer from WHAT IS DRAWN.
// This is the HitMode.Coverage contract (opt-in rendered pixel coverage); the default hit model is the SVG one (hitSpecModelSmoke).
//
// The fill hit test reads the coverage the default kernel draws -- the exact box coverage (renderFill is the exact
// walk), taken from the bundle's own decoded curve data (hitTest/fillCoverage.js boxCoverage) -- so its
// inside/outside decision is the render's own, not a parallel truth that can disagree in razor cases. This smoke renders shapes
// covering every segment type and both fill rules, then compares fillHitShape at every
// pixel center against the rendered pixel:
//   * pixels the render drew solid (>= 88% ink) must HIT, pixels it left blank
//     (<= 12% ink) must MISS — zero disagreements allowed;
//   * mid-coverage pixels are compared too: a hit is drawn coverage >= 0.5, so each must hit
//     exactly when its ink is past the midline. Only pixels within MID_TOL of 127.5 are
//     excused (8-bit rounding of the 0.5 level). The even-odd rings are where a hit test that
//     models the opt-in exact-edge AA instead of the default AA goes wrong: a pixel mostly in
//     the hole hits.
//     The CPU coverage itself is also reported against the drawn value.
// Also checks the pointer-coherence memo: a second identical query sweep (memo warm)
// must return byte-identical answers to the first.
// CLIPPED AND MASKED shapes: the hit test cuts a hit by the shape's clip-path and scales it by its mask,
// so on a solid shape whose clip and mask are binary (solid children) every pixel the render drew solid hits and
// every one it left blank misses; the mid-coverage comparison needs the single-row CPU coverage and is skipped.
// adds a black mask child over a white one (the mask image is its children composited source-over) and a clip
// union past sixteen children.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvgNode } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const L = await import('../src/bundle/layout.js');
const { boxCoverage } = await import('../src/hitTest/fillCoverage.js');
const { decodeSegs } = await import('../src/hitTest/curveGeom.js');
const MID_TOL = 3; // ink levels either side of 127.5
const N = 192;
const K = 8;
const flower = (n, bulge) => {
  const c = n / 2,
    r = n * 0.36;
  const P = (j) => [
    c + r * Math.cos((2 * Math.PI * j) / K),
    c + r * Math.sin((2 * Math.PI * j) / K),
  ];
  let d = `M ${P(0)[0].toFixed(4)} ${P(0)[1].toFixed(4)} `;
  for (let j = 0; j < K; j++) {
    const A = P(j),
      B = P(j + 1);
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bulge,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bulge;
    d += `Q ${mx.toFixed(4)} ${my.toFixed(4)} ${B[0].toFixed(4)} ${B[1].toFixed(4)} `;
  }
  return d + 'Z';
};
const cubicCircle = (n) => {
  const c = n / 2,
    r = n * 0.36,
    k = 0.5523 * r;
  const P = [
    [c - r, c],
    [c, c - r],
    [c + r, c],
    [c, c + r],
  ];
  let d = `M ${P[0][0]} ${P[0][1]} `;
  for (let i = 0; i < 4; i++) {
    const A = P[i],
      B = P[(i + 1) % 4];
    const ta = [-(A[1] - c), A[0] - c],
      tb = [-(B[1] - c), B[0] - c];
    d += `C ${(A[0] + (ta[0] / r) * k).toFixed(4)} ${(A[1] + (ta[1] / r) * k).toFixed(4)} ${(B[0] - (tb[0] / r) * k).toFixed(4)} ${(B[1] - (tb[1] / r) * k).toFixed(4)} ${B[0]} ${B[1]} `;
  }
  return d + 'Z';
};
const arcCapsule = (n) => {
  const a = 0.25 * n,
    b = 0.75 * n,
    r = 0.18 * n,
    m = n / 2;
  return `M ${a} ${m - r} L ${b} ${m - r} A ${r} ${r} 0 0 1 ${b} ${m + r} L ${a} ${m + r} A ${r} ${r} 0 0 1 ${a} ${m - r} Z`;
};
const evenOddRings = (n) => {
  const c = n / 2;
  const ring = (r) =>
    `M ${c - r} ${c} A ${r} ${r} 0 1 1 ${c + r} ${c} A ${r} ${r} 0 1 1 ${c - r} ${c} Z `;
  return ring(n * 0.4) + ring(n * 0.22);
}; // same-wound: even-odd sees a hole
const SHAPES = [
  [
    'tree-cached star',
    `<path fill="#000" d="M${Array.from({ length: 64 }, (_, i) => {
      const a = (2 * Math.PI * i) / 64,
        r = N * (i % 2 ? 0.18 : 0.36);
      return [N / 2 + r * Math.cos(a), N / 2 + r * Math.sin(a)].join(' ');
    }).join('L')}Z"/>`,
  ],
  ['quads flower', `<path fill="#000" d="${flower(N, 0.25)}"/>`],
  ['cubic circle', `<path fill="#000" d="${cubicCircle(N)}"/>`],
  ['arc capsule', `<path fill="#000" d="${arcCapsule(N)}"/>`],
  ['even-odd rings', `<path fill="#000" fill-rule="evenodd" d="${evenOddRings(N)}"/>`],
];
const H = N / 2,
  Q = N / 4;
const CLIPPED = [
  [
    'a rect clipped by a circle',
    `<defs><clipPath id="c"><circle cx="${H}" cy="${H}" r="${0.3 * N}"/></clipPath></defs>` +
      `<rect x="${0.1 * N}" y="${0.1 * N}" width="${0.8 * N}" height="${0.8 * N}" fill="#000" clip-path="url(#c)"/>`,
  ],
  [
    'a rect clipped by a two-child union with an evenodd hole',
    `<defs><clipPath id="c"><rect x="0" y="0" width="${0.4 * N}" height="${N}"/>` +
      `<path clip-rule="evenodd" d="M${0.6 * N} 0 H${N} V${N} H${0.6 * N} Z M${0.7 * N} ${Q} H${0.9 * N} V${3 * Q} H${0.7 * N} Z"/></clipPath></defs>` +
      `<path fill="#000" d="${flower(N, 0.25)}" clip-path="url(#c)"/>`,
  ],
  [
    'a circle under a luminance mask (white rect, black rect)',
    `<defs><mask id="m"><rect x="0" y="0" width="${N}" height="${H}" fill="white"/>` +
      `<rect x="0" y="${H}" width="${H}" height="${H}" fill="black"/></mask></defs><path fill="#000" d="${cubicCircle(N)}" mask="url(#m)"/>`,
  ],
  [
    'a rect under a stroked mask child with its own clip',
    `<defs><clipPath id="k"><rect x="0" y="0" width="${0.6 * N}" height="${N}"/></clipPath>` +
      `<mask id="m"><line x1="0" y1="${H}" x2="${N}" y2="${0.3 * N}" stroke="white" stroke-width="${0.2 * N}" clip-path="url(#k)"/></mask></defs>` +
      `<rect x="${0.1 * N}" y="${0.1 * N}" width="${0.8 * N}" height="${0.8 * N}" fill="#000" mask="url(#m)"/>`,
  ],
  // a black child OVER a white one hides what it covers (the bake composited them as alphas, a sum)...
  [
    'a rect under a black mask child drawn over a white one',
    `<defs><mask id="m"><rect x="0" y="0" width="${N}" height="${N}" fill="white"/>` +
      `<rect x="${H}" y="0" width="${H}" height="${N}" fill="black"/><rect x="0" y="${0.8 * N}" width="${N}" height="${0.2 * N}" fill="white"/></mask></defs>` +
      `<rect x="${0.1 * N}" y="${0.1 * N}" width="${0.8 * N}" height="${0.8 * N}" fill="#000" mask="url(#m)"/>`,
  ],
  // ...and a clip union is walked past its sixteenth child (it stopped there).
  [
    'a rect clipped by a 20-child union',
    `<defs><clipPath id="c">${Array.from(
      { length: 20 },
      (_, i) =>
        `<rect x="${((i + 0.25) * N) / 20}" y="0" width="${(0.5 * N) / 20}" height="${N}"/>`,
    ).join('')}</clipPath></defs>` +
      `<rect x="${0.05 * N}" y="${0.1 * N}" width="${0.9 * N}" height="${0.8 * N}" fill="#000" clip-path="url(#c)"/>`,
  ],
];
// A CHILD AN OVERRIDE SCALES: the render's walk takes the pixel of the child's own frame, so the hit test's box must be that size too. Strips one pixel
// wide and under half a pixel wide on screen, which are only right if the box is measured where the curves are.
const strip = (y, h, w) =>
  `M0 ${y} C${w / 3} ${y} ${(2 * w) / 3} ${y} ${w} ${y} L${w} ${y + h} C${(2 * w) / 3} ${y + h} ${w / 3} ${y + h} 0 ${y + h} Z`;
const STRIPS = [
  ['up 4 (a 1 px strip)', 4, strip(10, 0.25, N)],
  ['down 4 (a 0.4 px strip)', 0.25, strip(161.2, 1.6, 4 * N)],
];
const SCALED = STRIPS.flatMap(([how, s, d]) => [
  [
    `a clip child scaled ${how}`,
    `<defs><clipPath id="c"><path d="${d}"/></clipPath></defs><rect width="${N}" height="${N}" fill="#000" clip-path="url(#c)"/>`,
    'c',
    s,
  ],
  [
    `a mask child scaled ${how}`,
    `<defs><mask id="c" maskUnits="userSpaceOnUse" x="0" y="0" width="${N}" height="${N}"><path d="${d}" fill="#fff"/></mask></defs><rect width="${N}" height="${N}" fill="#000" mask="url(#c)"/>`,
    'c',
    s,
  ],
  [`a drawn row scaled ${how}`, `<path id="d" d="${d}" fill="#000"/>`, 'd', s],
]);
const wrap = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">${inner}</svg>`;
// The CPU coverage at every pixel, in GL row order (GL row y = em row N-1-y), for the report.
async function cpuCoverage(svg) {
  const raw = await importSvgNode(svg, { preserveViewport: true });
  const MF = parseMetaBin(raw.meta, raw.metaFloatsPerShape).metaFloats;
  const curveF = new Float32Array(raw.curves),
    r0 = raw.curveRangesByShape[0];
  const segs = decodeSegs(curveF, r0.begin, r0.end);
  const evenOdd = (MF[L.META_FILL_RULE] | 0) === 1,
    cov = new Float64Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      cov[y * N + x] = boxCoverage(segs, x + 0.5, N - 1 - y + 0.5, 1, 1, evenOdd);
  return cov;
}

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, createOverrideTable, loadShaders, fillHitShape, HitMode } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{}); r.setLoopBlinnFill('off');
window.__run=async(svg)=>{
  const b=createBundle(gl, await importSvg(svg,{preserveViewport:true}));
  r.setViewport(${N},${N}); gl.viewport(0,0,${N},${N});
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const p=new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,p);
  const hits=[], hits2=[];
  for(let y=0;y<${N};y++) for(let x=0;x<${N};x++)
    hits.push(fillHitShape(b, x+0.5, (${N}-1-y)+0.5, { mode: HitMode.Coverage, worldMatrix: [1,0,0,0,1,0,0,0,1] }) >= 0 ? 1 : 0);   // GL row y = em row N-1-y
  for(let y=0;y<${N};y++) for(let x=0;x<${N};x++)
    hits2.push(fillHitShape(b, x+0.5, (${N}-1-y)+0.5, { mode: HitMode.Coverage, worldMatrix: [1,0,0,0,1,0,0,0,1] }) >= 0 ? 1 : 0);  // memo-warm sweep
  const lum=[]; for(let i=0;i<${N}*${N};i++) lum.push(p[i*4]);
  b.dispose();
  return { lum, hits, hits2 };
};
window.__runScaled=async(svg,id,s)=>{
  const b=createBundle(gl, await importSvg(svg,{preserveViewport:true}));
  const t=createOverrideTable(gl,b);
  if(id==='d') t.set(id,{localScale:[s,s]}); else if(!t.setClipper(id,{localScale:[s,s]})) throw Error('no clipper');
  r.setViewport(${N},${N}); gl.viewport(0,0,${N},${N});
  r.beginFrame([1,1,1,1]); r.drawBundle(b,{overrides:t}); r.endFrame();
  const p=new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,p);
  const hits=[], lum=[];
  for(let y=0;y<${N};y++) for(let x=0;x<${N};x++)
    hits.push(fillHitShape(b, x+0.5, (${N}-1-y)+0.5, { mode: HitMode.Coverage, worldMatrix: [1,0,0,0,1,0,0,0,1], overrides: t }) >= 0 ? 1 : 0);
  for(let i=0;i<${N}*${N};i++) lum.push(p[i*4]);
  t.dispose(); b.dispose();
  return { lum, hits };
};
window.__ready=true;
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
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message.slice(0, 400)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
for (const [name, inner, clipped] of [...SHAPES, ...CLIPPED.map(([n, i]) => [n, i, true])]) {
  const o = await pg.evaluate((s) => window.__run(s), wrap(inner));
  // A pixel is EDGE-ADJACENT when any pixel within 2 of it has mid coverage — there the
  // drawn boundary passes nearby and sub-pixel disagreement is legitimate (GPU f32 trig at
  // near-tangent arc extrema is vendor-defined; exact CPU agreement is unachievable in
  // principle). Deep interior / exterior tolerates nothing.
  const mid = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const ink = 255 - o.lum[i];
    if (ink > 30 && ink < 225) mid[i] = 1;
  }
  const nearEdge = (x, y) => {
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx,
          yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < N && yy < N && mid[yy * N + xx]) return true;
      }
    return false;
  };
  const cpu = clipped ? null : await cpuCoverage(wrap(inner));
  let solid = 0,
    blank = 0,
    disagree = 0,
    memoDiff = 0,
    edgeSoft = 0;
  let midN = 0,
    midDisagree = 0,
    midLine = 0,
    midNear = 0,
    midWorst = 0;
  const bad = [],
    midBad = [];
  for (let i = 0; i < N * N; i++) {
    if (o.hits[i] !== o.hits2[i]) memoDiff++;
    const ink = 255 - o.lum[i];
    const x = i % N,
      y = (i / N) | 0;
    if (ink >= 225) {
      solid++;
      if (!o.hits[i]) {
        if (nearEdge(x, y)) {
          edgeSoft++;
          continue;
        }
        disagree++;
        if (bad.length < 5) bad.push([x, y, 'miss-on-solid']);
      }
    } else if (ink <= 30) {
      blank++;
      if (o.hits[i]) {
        if (nearEdge(x, y)) {
          edgeSoft++;
          continue;
        }
        disagree++;
        if (bad.length < 5) bad.push([x, y, 'hit-on-blank']);
      }
    } else if (!clipped) {
      midN++;
      const d = Math.abs(cpu[i] * 255 - ink);
      if (d <= 2) midNear++;
      midWorst = Math.max(midWorst, d);
      if (o.hits[i] !== (ink >= 128 ? 1 : 0)) {
        if (Math.abs(ink - 127.5) <= MID_TOL) midLine++;
        else {
          midDisagree++;
          if (midBad.length < 5)
            midBad.push([
              x,
              y,
              `ink ${ink} cpu ${(cpu[i] * 255).toFixed(1)} ${o.hits[i] ? 'hit' : 'miss'}`,
            ]);
        }
      }
    }
  }
  check(
    disagree === 0,
    `${name}: hit == render on ${solid} solid + ${blank} blank px (${disagree} deep disagree, ${edgeSoft} edge-band tolerated)`,
  );
  if (bad.length) console.log('     ', bad.map((b) => b.join(',')).join('  '));
  if (!clipped)
    check(
      midDisagree === 0,
      `${name}: hit == drawn coverage >= 0.5 on ${midN} mid-coverage px (${midDisagree} disagree, ${midLine} within ${MID_TOL} of the midline); CPU coverage within 2/255 of the drawn value at ${midNear}, worst ${midWorst.toFixed(1)}/255`,
    );
  if (midBad.length) console.log('     ', midBad.map((b) => b.join(',')).join('  '));
  check(memoDiff === 0, `${name}: memo-warm sweep identical (${memoDiff} diffs)`);
}
for (const [name, inner, id, s] of SCALED) {
  const o = await pg.evaluate((a, b, c) => window.__runScaled(a, b, c), wrap(inner), id, s);
  let inked = 0,
    off = 0,
    first = '';
  for (let i = 0; i < N * N; i++) {
    const ink = 255 - o.lum[i];
    if (ink > 2) inked++;
    if (Math.abs(ink - 127.5) <= MID_TOL) continue;
    if (o.hits[i] !== (ink >= 128 ? 1 : 0)) {
      off++;
      if (!first)
        first = `, first at ${i % N},${(i / N) | 0}: ink ${ink}, ${o.hits[i] ? 'hit' : 'miss'}`;
    }
  }
  check(
    inked > 0 && off === 0,
    `${name}: hit == drawn coverage >= 0.5 at every pixel (${inked} inked, ${off} disagree${first})`,
  );
}
await br.close();
server.close();
if (fail) {
  console.error(`HIT-RENDER-AGREEMENT FAIL (${fail})`);
  process.exit(1);
}
console.log('HIT-RENDER-AGREEMENT PASS');
