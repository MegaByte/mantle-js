// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacPointsGenGpuSmoke -- the generated points (MANTLE_POINTS_GEN, the default) paint what the uploaded point lists paint, on a physical GPU.
//
// The generated route uploads one RGBA32UI entry per (row, paint) and the vertex shader finds each point's row and pixel from gl_VertexID; the list route
// uploads 8 bytes per point. Same rows, same points, same order, same blend: the frames agree. Each scene is drawn at several scales by one
// renderer per arm, each on its own canvas, with every row on the points route (extent and byte gates opened); every visible draw is checked to have
// gone through its arm's point program. On ANGLE/Metal a program's first compile in a page differs by 1/255 at AA ties from its later cache hits, so
// both programs are compiled by a discarded pass of each mode first, and the arms run list, generated, list: the two list arms are the A/A control.
// The bar is the A/A's (identical) for coverage and inputs, and one level on at most 1 in 2000 inked channels for the rest: the two are different
// program texts, and Metal's compiler may order the shared color math differently (gradient rows: 4 of 52219 channels one level apart, all
// opaque interior pixels), while aacPointsGenTableSmoke proves the points themselves identical.
//   scenes: fills (even-odd, nonzero, arcs), strokes (caps, joins, dashes), clipped rows, gradient rows, masked rows, and a drawing of hundreds of
//   small shapes (many entries, one draw). Clipped and masked rows stop at scale 1 (the route's size limit for them); pattern rows are not in a
//   points draw here (the CPU parity smoke covers the point program's pattern block -- generation does not touch paint).
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from './_gpuThrottle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dots = () => {
  let b = '';
  for (let i = 0; i < 400; i++) {
    const x = ((i * 37) % 95) + 2,
      y = ((i * 53) % 95) + 2,
      r = 0.6 + (i % 4) * 0.5;
    b += `<path d="M${x - r} ${y + r} L${x} ${y - r} L${x + r} ${y + r} Z" fill="hsl(${(i * 29) % 360} 70% 45%)" fill-opacity="${0.5 + (i % 2) * 0.5}"${i % 5 === 0 ? ' stroke="#222" stroke-width="0.4"' : ''}/>`;
  }
  return b;
};
const SCENES = {
  fills: `<path fill-rule="evenodd" fill="#000" d="M4 50 Q20 22 36 50 Q20 78 4 50 Z M12 50 Q20 34 28 50 Q20 66 12 50 Z"/><path fill="#2b4c9a" d="M44 28 C68 24 60 48 80 44 C88 64 60 80 48 72 Z"/><path fill="#b03030" fill-opacity="0.7" d="M60 50 A14 14 0 1 1 88 50 A14 14 0 1 1 60 50 Z"/>`,
  strokes: `<path d="M8 12 L40 12 L24 32" fill="none" stroke="#204080" stroke-width="4.4" stroke-linejoin="miter"/><path d="M52 8 Q68 40 88 12" fill="none" stroke="#a02020" stroke-width="3.2" stroke-linecap="round"/><path d="M12 48 A16 12 20 0 1 44 60" fill="none" stroke="#806020" stroke-width="3.6" stroke-linejoin="round"/><path d="M56 44 L92 44 L92 68" fill="none" stroke="#000" stroke-width="2.8" stroke-dasharray="6 4"/><path d="M18 82 A12 12 0 1 1 42 82 A12 12 0 1 1 18 82 Z" fill="#e0c040" stroke="#202020" stroke-width="4"/>`, // (a path: a <circle> is a tagged primitive, which waits for a mesh this route never builds)
  clipped: `<defs><clipPath id="a"><path d="M8 8 Q40 -4 72 16 Q44 44 8 28 Z"/><path d="M60 20 L92 12 L88 48 L60 44 Z"/></clipPath><clipPath id="b"><circle cx="50" cy="72" r="18"/></clipPath></defs><rect x="4" y="4" width="88" height="52" fill="#2b4c9a" clip-path="url(#a)"/><path d="M12 48 L96 16" stroke="#a02020" stroke-width="6" fill="none" clip-path="url(#a)"/><circle cx="46" cy="72" r="24" fill="#3aa36a" stroke="#202020" stroke-width="3" clip-path="url(#b)"/>`,
  gradients: `<defs><linearGradient id="l" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4d03f"/><stop offset="0.6" stop-color="#d35400"/><stop offset="1" stop-color="#4a235a"/></linearGradient><radialGradient id="r" gradientUnits="userSpaceOnUse" cx="70" cy="30" r="24"><stop offset="0" stop-color="#fff" stop-opacity="0.9"/><stop offset="1" stop-color="#1b4f72"/></radialGradient><linearGradient id="k" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#e91e63"/></linearGradient></defs><path d="M6 6 Q28 -4 48 10 L44 34 Q24 40 6 28 Z" fill="url(#l)"/><path d="M52 8 L94 8 L94 52 L52 52 Z" fill="url(#r)" fill-opacity="0.8"/><path d="M8 80 L92 64" stroke="url(#k)" stroke-width="6" fill="none"/>`,
  masked: `<defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="40" cy="44" r="40"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#303030"/></radialGradient><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect x="0" y="0" width="64" height="100" fill="url(#g)"/><circle cx="76" cy="50" r="16" fill="#bbb"/></mask></defs><rect x="4" y="4" width="92" height="92" fill="#d35400" mask="url(#m)"/><path d="M6 90 L94 10" stroke="#1a5276" stroke-width="5" fill="none" mask="url(#m)"/>`,
  dots: dots(),
};
const SCALES = [0.37, 0.61, 1, 1.43],
  SMALL = { clipped: 3, masked: 3 }; // (the scales each scene draws through points: all, or the first n)
const N = 192;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html>');
    return;
  }
  const f = path.resolve(ROOT, '.' + decodeURIComponent(u.pathname));
  if (!f.startsWith(ROOT + path.sep)) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.setHeader('Content-Type', f.endsWith('.js') ? 'text/javascript' : 'text/plain');
    res.end(readFileSync(f));
  } catch {
    res.writeHead(404).end();
  }
});
let browser;
const stop = async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
};
const cap = capWallTime('aacPointsGenGpuSmoke', stop);
console.log(gpuThrottleBanner());
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(e.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await installGpuThrottle(page);
  for (const [name, body] of Object.entries(SCENES)) {
    const scales = SCALES.slice(0, SMALL[name] || SCALES.length);
    const row = await page.evaluate(
      async (name, body, SCALES, N) => {
        globalThis.__MANTLE_DEBUG__ = true; // (the points gate records why it declined)
        const api = await import('/src/index.js'),
          shaders = await api.loadShaders(new URL('/src/shaders/', location.href));
        const out = { device: '', modes: {} };
        for (const [arm, gen] of [
          ['warm-list', false],
          ['warm-gen', true],
          ['list', false],
          ['gen', true],
          ['list2', false],
        ]) {
          const cv = document.createElement('canvas');
          cv.width = cv.height = N;
          const gl = cv.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
          const dbg = gl.getExtension('WEBGL_debug_renderer_info');
          out.device = dbg
            ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER);
          // every POINTS draw, with whether its program is the generated one
          const seen = { pts: 0, genProg: 0, listProg: 0 },
            orig = gl.drawArraysInstanced.bind(gl);
          gl.drawArraysInstanced = (mode, ...a) => {
            if (mode === gl.POINTS) {
              seen.pts++;
              const vs =
                gl
                  .getAttachedShaders(gl.getParameter(gl.CURRENT_PROGRAM))
                  .map((s) => gl.getShaderSource(s))
                  .find((s) => /renderFillAAC|aPt/.test(s)) || '';
              if (/#define MANTLE_POINTS_GEN\b/.test(vs)) seen.genProg++;
              else seen.listProg++;
            }
            return orig(mode, ...a);
          };
          const sec = await api.importSvg(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`,
            { preserveViewport: true },
          );
          const bundle = api.createBundle(gl, sec),
            r = api.createRenderer(gl, shaders, {
              aacFill: true,
              aacPointsRowGate: false,
              aacPointsGen: gen,
              aacPointsExtMax: 1e9,
              aacPointsBytesBudget: 1e9,
            });
          r.setFillEngine({ route: 'none', kernel: 'aac' });
          r.setViewport(N, N);
          r.prewarmBundle(bundle);
          r.precompileFills();
          const frames = [];
          for (const s of SCALES) {
            const wm = [s, 0, 0, 0, s, 0, 0, 0, 1];
            for (let i = 0; i < 2; i++) {
              r.beginFrame([1, 1, 1, 1]);
              r.drawBundle(bundle, { worldMatrix: wm });
              r.endFrame();
            } // (the second frame: the first may land while the point program links)
            seen.pts = seen.genProg = seen.listProg = 0;
            r.beginFrame([1, 1, 1, 1]);
            r.drawBundle(bundle, { worldMatrix: wm });
            r.endFrame();
            if (!(await window.__gpuFence(gl, 30000))) throw Error('GPU fence');
            const px = new Uint8Array(N * N * 4);
            gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px);
            frames.push({
              s,
              px: Array.from(px),
              seen: { ...seen },
              err: gl.getError(),
              why: r.debugStats.pointsGateWhy || null,
            });
            await window.__gpuIdle(4);
          }
          out.modes[arm] = { frames, points: r.debugStats.engines.viaRoute['aac@points'] || 0 };
          bundle.dispose();
          r.dispose();
          gl.getExtension('WEBGL_lose_context').loseContext();
        }
        return out;
      },
      name,
      body,
      scales,
      N,
    );
    assert(
      !/swiftshader|llvmpipe|software/i.test(row.device),
      'physical GPU required: ' + row.device,
    );
    for (let k = 0; k < scales.length; k++) {
      const L = row.modes.list.frames[k],
        G = row.modes.gen.frames[k],
        L2 = row.modes.list2.frames[k];
      const cmp = (A, B) => {
        let diff = 0,
          worst = 0,
          at = -1;
        const px = [];
        for (let i = 0; i < A.px.length; i++) {
          const d = Math.abs(A.px[i] - B.px[i]);
          if (d) {
            diff++;
            if (d > worst) {
              worst = d;
              at = i;
            }
            const p = i >> 2;
            if (px.length < 6 && !px.some((q) => q.p === p))
              px.push({
                p,
                x: p % N,
                y: (p / N) | 0,
                a: A.px.slice(4 * p, 4 * p + 4).join(','),
                b: B.px.slice(4 * p, 4 * p + 4).join(','),
              });
          }
        }
        return { diff, worst, at, px };
      };
      let ink = 0;
      for (const v of L.px) if (v !== 255) ink++;
      const aa = cmp(L, L2),
        { diff, worst, at, px: dpx } = cmp(L, G);
      ok(
        aa.diff === 0,
        `${name} @${scales[k]}: A/A control, the two list arms agree (${aa.diff} channels differ${aa.diff ? `, worst ${aa.worst}` : ''})`,
      );
      ok(
        L.err === 0 &&
          G.err === 0 &&
          L.seen.pts > 0 &&
          L.seen.listProg === L.seen.pts &&
          G.seen.pts > 0 &&
          G.seen.genProg === G.seen.pts,
        `${name} @${scales[k]}: each mode drew through its own point program (list ${L.seen.listProg}/${L.seen.pts}, generated ${G.seen.genProg}/${G.seen.pts}; GL errors ${L.err}, ${G.err}${G.seen.pts ? '' : '; declined: ' + G.why})`,
      );
      ok(
        ink > 0 && worst <= 1 && diff * 2000 <= ink,
        `${name} @${scales[k]}: generated == list (${ink} inked channels; ${diff} differ${diff ? `, worst ${worst} at pixel ${at >> 2}: ` + dpx.map((q) => `(${q.x},${q.y}) list ${q.a} gen ${q.b}`).join('; ') : ''})`,
      );
    }
  }
  if (fail) {
    console.error(`aacPointsGenGpuSmoke FAIL (${fail})`);
    process.exitCode = 1;
  } else console.log('aacPointsGenGpuSmoke PASS');
} finally {
  cap.clear();
  await stop();
}
