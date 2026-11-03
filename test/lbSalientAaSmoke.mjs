// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbSalientAaSmoke — LB vs 8×SS / AAC must not show SALIENT AA errors.
//
// MSE can look fine while a few pixels jump solid↔empty next to each other
// (neighbor spikes) or a ramp wobbles. This smoke scores:
//   - monotone edge crossings (reuse aaMonotonic’s solid→bg runs)
//   - neighbor spikes: |Δ| ≫ mean of 4-neighbors’ |Δ| on the error field
//   - nBad: pixels off by >0.1 coverage vs the box-downsampled 8× Slug ref
//
// Shapes: kappa-cubic CIRCLE / TINY disc and ELLIPSE must take kind-7 SDF
// (seam-free); a line TRIANGLE stays near-exact.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 192,
  SS = 8;
const wrap = (d, n) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}"><path fill="#000000" d="${d}"/></svg>`;
function circle(n) {
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
}
function tiny(n) {
  const c = n / 2,
    r = n * 0.028,
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
}
function tri(n) {
  return `M ${0.12 * n} ${0.15 * n} L ${0.88 * n} ${0.42 * n} L ${0.3 * n} ${0.9 * n} Z`;
}
function ellipse(n) {
  const cx = n / 2,
    cy = n / 2,
    rx = n * 0.4,
    ry = n * 0.26,
    k = 0.5523;
  const P = [
    [cx - rx, cy],
    [cx, cy - ry],
    [cx + rx, cy],
    [cx, cy + ry],
  ];
  let d = `M ${P[0][0]} ${P[0][1]} `;
  const C = [
    [
      [cx - rx, cy - ry * k],
      [cx - rx * k, cy - ry],
    ],
    [
      [cx + rx * k, cy - ry],
      [cx + rx, cy - ry * k],
    ],
    [
      [cx + rx, cy + ry * k],
      [cx + rx * k, cy + ry],
    ],
    [
      [cx - rx * k, cy + ry],
      [cx - rx, cy + ry * k],
    ],
  ];
  for (let i = 0; i < 4; i++) {
    const B = P[(i + 1) % 4];
    d += `C ${C[i][0][0].toFixed(4)} ${C[i][0][1].toFixed(4)} ${C[i][1][0].toFixed(4)} ${C[i][1][1].toFixed(4)} ${B[0]} ${B[1]} `;
  }
  return d + 'Z';
}

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N * SS}" height="${N * SS}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N}, SS = ${SS};
const rSlug = createRenderer(gl, shaders, {}); rSlug.setLoopBlinnFill('off');
const rLb = createRenderer(gl, shaders, {}); rLb.setLoopBlinnFill('on');
const grab = (w, h) => {
  const p = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, p);
  const a = new Float64Array(w * h); for (let i = 0; i < w * h; i++) a[i] = p[i * 4]; return a;
};
async function render(r, sec, n) {
  const b = createBundle(gl, sec);
  if (r !== rSlug) { r.prepareBundle(b); if (r.awaitLbReady) await r.awaitLbReady(b); }
  r.setViewport(n, n); gl.viewport(0, 0, n, n);
  r.beginFrame([1, 1, 1, 1]); r.drawBundle(b); r.endFrame();
  const a = grab(n, n); const kinds = {};
  for (const m of (b._lbMeshes || [])) {
    if (!m || !m.verts) continue;
    for (let i = 0; i < m.vertexCount; i++) {
      const k = Math.floor(m.verts[i * 24 + 5] + 0.001); kinds[k] = (kinds[k] || 0) + 1;
    }
  }
  a.kinds = kinds; a.routed = r.debugStats.loopBlinnRouteCount; b.dispose(); return a;
}
const down = (hi, n, ss) => {
  const lo = new Float64Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let s = 0; for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) s += hi[(y * ss + j) * (n * ss) + (x * ss + i)];
    lo[y * n + x] = s / (ss * ss);
  }
  return lo;
};
function score(a, ref) {
  let sum = 0, nEdge = 0, nBad = 0, max = 0, spikes = 0;
  const diff = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const r = ref[i]; if (r <= 2 || r >= 253) { diff[i] = 0; continue; }
    const d = Math.abs(a[i] - r); diff[i] = d; sum += d; nEdge++; if (d > max) max = d; if (d > 25) nBad++;
  }
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const i = y * N + x; if (diff[i] < 20) continue;
    const nb = (diff[i - 1] + diff[i + 1] + diff[i - N] + diff[i + N]) / 4;
    if (diff[i] > nb + 30 && diff[i] > 40) spikes++;
  }
  const cov = (x, y) => (255 - a[y * N + x]) / 255 * 100;
  let wobble = 0, runs = 0;
  const scan = (get) => {
    for (let a0 = 0; a0 < N; a0++) {
      let run = [], prevSolid = false;
      for (let b = 0; b <= N; b++) {
        const c = b < N ? get(a0, b) : 0;
        const solid = c > 97, bg = c < 3;
        if (solid || bg || b === N) {
          if (run.length >= 1 && run.length <= 5 && prevSolid === bg && (prevSolid || solid)) {
            const seq = prevSolid ? run : run.slice().reverse(); runs++;
            for (let i = 1; i < seq.length; i++) if (seq[i] - seq[i - 1] > 6) wobble++;
          }
          run = []; prevSolid = solid;
        } else run.push(c);
      }
    }
  };
  scan((y, x) => cov(x, y)); scan((x, y) => cov(x, y));
  return { mean: sum / Math.max(1, nEdge), max, nBad, spikes, wobble, runs, kinds: a.kinds };
}
window.__run = async (shapes) => {
  const out = [];
  for (const [name, lo, hi] of shapes) {
    const IV = { preserveViewport: true };
    const ref = down(await render(rSlug, await importSvg(hi, IV), N * SS), N, SS);
    const lb = await render(rLb, await importSvg(lo, IV), N);
    out.push({ name, routed: 1, ...score(lb, ref) });
  }
  return out;
};
window.__ready = true;
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
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 100 });
const shapes = [
  ['circle', wrap(circle(N), N), wrap(circle(N * SS), N * SS)],
  ['tiny', wrap(tiny(N), N), wrap(tiny(N * SS), N * SS)],
  ['tri', wrap(tri(N), N), wrap(tri(N * SS), N * SS)],
  ['ellipse', wrap(ellipse(N), N), wrap(ellipse(N * SS), N * SS)],
];
const rows = await pg.evaluate((s) => window.__run(s), shapes);
await br.close();
server.close();

let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));
const by = Object.fromEntries(rows.map((r) => [r.name, r]));
for (const r of rows) {
  console.log(
    `  ${r.name.padEnd(8)} mean=${r.mean.toFixed(2)} max=${r.max.toFixed(0)} bad=${r.nBad} spikes=${r.spikes} wobble=${r.wobble}/${r.runs} kinds=${JSON.stringify(r.kinds)}`,
  );
}

ok(
  (by.circle.kinds[7] || 0) > 0,
  `kappa circle takes kind-7 SDF (${by.circle.kinds[7] || 0} verts)`,
);
ok(
  (by.tiny.kinds[7] || 0) > 0,
  `tiny kappa disc takes kind-7 SDF (${by.tiny.kinds[7] || 0} verts)`,
);
ok(
  by.circle.spikes === 0 && by.circle.nBad === 0,
  `circle: no spikes/bad (spikes=${by.circle.spikes}, bad=${by.circle.nBad})`,
);
ok(
  by.tiny.spikes === 0 && by.tiny.nBad === 0,
  `tiny: no spikes/bad (spikes=${by.tiny.spikes}, bad=${by.tiny.nBad})`,
);
ok(
  by.circle.wobble === 0 && by.tiny.wobble === 0 && by.tri.wobble === 0,
  `monotone ramps (circle/tiny/tri wobble ${by.circle.wobble}/${by.tiny.wobble}/${by.tri.wobble})`,
);
ok(
  by.tri.spikes <= 2 && by.tri.nBad <= 4,
  `triangle spikes/bad bounded (${by.tri.spikes}/${by.tri.nBad})`,
);
ok(
  (by.ellipse.kinds[7] || 0) > 0,
  `kappa ellipse takes kind-7 elliptical SDF (${by.ellipse.kinds[7] || 0} verts)`,
);
ok(
  by.ellipse.spikes === 0 && by.ellipse.nBad === 0,
  `ellipse: no spikes/bad (spikes=${by.ellipse.spikes}, bad=${by.ellipse.nBad})`,
);
ok(by.ellipse.wobble === 0, `ellipse monotone (wobble=${by.ellipse.wobble})`);

console.log(fail ? `\nLB-SALIENT-AA FAIL (${fail})` : '\nLB-SALIENT-AA PASS');
process.exit(fail ? 1 : 0);
