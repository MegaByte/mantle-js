// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupFilterSkipRenderSmoke -- a filtered group served from the filter-result cache without repainting its children draws what the
// repainting group drew (record-level proofs: test/groupFilterSkipSmoke.mjs).
//
// Each cell renders one document at 128 px on a warmed (cache-hit) frame in four arms, balanced OFF, ON, OFF, ON (OFF = the children repaint,
// the debug flag; ON = the cached result composites alone). The two OFF arms are the A/A control: the noise floor of a fresh bundle. The
// ON arms must match the OFF arms within 1/255, and must actually have skipped (debugStats.groupFilterSkips grew in ON, not in OFF).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = process.env.SMOKE_SRC_ROOT
  ? path.resolve(process.env.SMOKE_SRC_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // (SMOKE_SRC_ROOT: draw another source tree, to compare a failure against it)
const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = (body, f) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/><defs><filter id="f" x="-30%" y="-30%" width="170%" height="170%" color-interpolation-filters="sRGB">${f}</filter><rect id="fs" x="0" y="0" width="20" height="16" rx="3" fill="#e04020" stroke="#2040c0" stroke-width="5"/></defs>${body}</svg>`;
const SHADOW =
  '<feDropShadow dx="3" dy="3" stdDeviation="1.5" flood-color="#000" flood-opacity=".5"/>';
const MERGE =
  '<feOffset dx="4" dy="3" result="o"/><feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge>';
const BLUR = '<feGaussianBlur stdDeviation="2"/>';
const leaf = (x, y, extra = '') =>
  `<rect x="${x}" y="${y}" width="20" height="16" rx="3" fill="#e04020" stroke="#2040c0" stroke-width="5" ${extra}/>`;
const CELLS = [
  {
    name: 'filtered fill+stroke leaves, drop shadow',
    svg: doc(
      leaf(6, 6, 'filter="url(#f)"') +
        leaf(34, 10, 'filter="url(#f)"') +
        leaf(10, 36, 'filter="url(#f)"'),
      SHADOW,
    ),
  },
  {
    name: 'overlapping filtered leaves, merge with SourceGraphic',
    svg: doc(
      leaf(8, 8, 'filter="url(#f)"') +
        leaf(20, 14, 'filter="url(#f)"') +
        leaf(14, 30, 'filter="url(#f)"'),
      MERGE,
    ),
  },
  {
    name: '<g filter> blur, three groups',
    svg: doc(
      `<g filter="url(#f)">${leaf(6, 6)}</g><g filter="url(#f)">${leaf(34, 8)}</g><g filter="url(#f)">${leaf(14, 36)}</g>`,
      BLUR,
    ),
  },
  {
    name: '<use filter> instances, drop shadow',
    svg: doc(
      `<use href="#fs" x="6" y="6" filter="url(#f)"/><use href="#fs" x="34" y="12" filter="url(#f)"/><use href="#fs" x="12" y="38" filter="url(#f)"/>`,
      SHADOW,
    ),
  },
  {
    name: 'filtered leaf with its own opacity',
    svg: doc(
      leaf(8, 10, 'filter="url(#f)" opacity=".5"') + leaf(30, 30, 'filter="url(#f)" opacity=".7"'),
      SHADOW,
    ),
  },
  {
    name: 'filtered groups inside an opacity group',
    svg: doc(
      `<g opacity=".6"><g filter="url(#f)">${leaf(6, 6)}</g><g filter="url(#f)">${leaf(30, 30)}</g></g>`,
      SHADOW,
    ),
  },
  {
    name: 'filtered group inside a filtered group',
    noAlpha: true,
    svg: doc(
      `<g filter="url(#f)"><g filter="url(#f)">${leaf(6, 6)}</g>${leaf(30, 30)}</g>`,
      SHADOW,
    ),
  },
  {
    name: 'a plain leaf painted over filtered ones',
    cached: true,
    svg: doc(
      `<rect x="0" y="20" width="64" height="12" fill="#0a0"/><g filter="url(#f)">${leaf(6, 6)}</g><rect x="0" y="40" width="64" height="6" fill="#00a" opacity=".5"/>`,
      SHADOW,
    ),
  },
];
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { paint, viewport } from '/test/_auditPaintCases.mjs';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__DEBUGOK = (globalThis.__MANTLE_DEBUG__ = true);
window.__render = async (source, route, arms, opacity) => {
  viewport(gl, R); R.setFillEngine({ route, kernel: 'aac', primitives: 'off' });
  const out = [];
  for (const off of arms) {
    globalThis.__MANTLE_NO_GROUP_FILTER_SKIP = off;
    const b = createBundle(gl, await importSvg(source, { preserveViewport: true }));
    const s0 = R.debugStats.groupFilterSkips | 0, e0 = R.debugStats.filterEvalCount;
    let px = [], err = '';
    const orig = R._filterKeyMatches, terms = new Set();
    R._filterKeyMatches = (c, key) => {
      const r = orig(c, key);
      if (!r && c && c.key) for (const k of Object.keys(key)) if (JSON.stringify(c.key[k]) !== JSON.stringify(key[k]) && c.key[k] !== key[k]) terms.add(k);
      return r;
    };
    try { px = Array.from(await paint(gl, R, b, undefined, opacity ? { alpha: opacity } : {})); } catch (e) { err = String(e && e.message || e); }
    R._filterKeyMatches = orig;
    out.push({ px, err, off, terms: [...terms], evals: R.debugStats.filterEvalCount - e0, skips: (R.debugStats.groupFilterSkips | 0) - s0 }); b.dispose();
  }
  return out;
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(p.startsWith('/test/') ? TEST_ROOT : ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { launchBrowser } = await import('./_launch.mjs');
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const ink = (px) => {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] < 250 || px[i + 1] < 250 || px[i + 2] < 250) n++;
  return n;
};
const variants = [{ route: 'none' }, { route: 'lb' }, { route: 'none', alpha: 0.5 }];
for (const c of CELLS)
  for (const v of variants) {
    if (c.noAlpha && v.alpha) continue; // (a filtered group inside a filtered group under a draw alpha raises a GL error with or without the skip)
    const tag = `${c.name} [${v.route}${v.alpha ? ', alpha ' + v.alpha : ''}]`;
    let r;
    try {
      r = await page.evaluate(
        (s, route, arms, a) => window.__render(s, route, arms, a),
        c.svg,
        v.route,
        [true, true, false, true, false],
        v.alpha || 0,
      );
    } catch (e) {
      fail(tag + ': ' + e.message);
      continue;
    }
    r.shift(); // the first arm is a throwaway: a bundle's first paint can raise a GL error of its own
    const [off1, on1, off2, on2] = r;
    if (r.some((a) => a.err)) {
      fail(
        tag +
          ': GL/draw error in arms [' +
          r.map((a) => (a.off ? 'OFF' : 'ON') + (a.err ? ':' + a.err : ':ok')).join(', ') +
          ']',
      );
      continue;
    }
    const floor = maxDiff(off1.px, off2.px),
      d = Math.max(maxDiff(off1.px, on1.px), maxDiff(off2.px, on2.px), maxDiff(off1.px, on2.px));
    const line = `${tag}: A/A floor ${floor}, ON vs OFF ${d}, skips off ${off1.skips}/${off2.skips} on ${on1.skips}/${on2.skips} (graph evaluations off ${off1.evals} on ${on1.evals}), ink ${ink(on1.px)} vs ${ink(off1.px)}`;
    if (off1.skips || off2.skips) fail(line + ' -- the OFF arm skipped');
    else if (c.cached && !(on1.skips > 0) && on1.evals <= 2)
      ok(line + ' -- (served whole by the static-scene cache, which never walks the group)');
    else if (!(v.route === 'lb' ? on1.skips > 0 || on2.skips > 0 : on1.skips > 0 && on2.skips > 0))
      fail(
        line +
          ' -- vacuous: the ON arm never skipped (key terms that differed: ' +
          on1.terms.join(',') +
          ')',
      );
    else if (ink(on1.px) < 200) fail(line + ' -- blank');
    else if (d > Math.max(1, floor)) fail(line + ' -- the skipped group draws differently');
    else ok(line);
  }
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\ngroupFilterSkipRenderSmoke: a filtered group served from its cached result matches the repainted group',
);
