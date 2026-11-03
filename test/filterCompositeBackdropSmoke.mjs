// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterCompositeBackdropSmoke — a filtered shape composites over its backdrop ONCE, and a filtered
// child stays inside its opacity group, on both routes.
//
// composite.frag.glsl in normal mode already composites src-over against a backdrop snapshot,
// so a call site that then blends that result with ONE, ONE_MINUS_SRC_ALPHA applies the backdrop a
// second time. Invisible where the backdrop alpha is 0 or 1; where it is fractional the result is
// too bright and too opaque (source alpha 0 over backdrop alpha 0.5 reads 0.75).
// On the unified route a graph-filtered shape inside an opacity group must not copy the group's
// accumulator into the texture groupBegin stored the canvas backdrop in, clear the accumulator, and
// composite to the canvas -- the group would lose its earlier children and the filtered one escape
// the group's opacity. Such a bundle is served on the unified route, so every group case here also
// ASSERTS THE ROUTE of the frame it reads: the unified arm must
// have isolated the filtered child there (unifiedFilterDraws) inside a group it served
// (unifiedGroupBrackets), and the classic arm must not have drawn on the unified route at all. A
// case that falls to the other route would compare the classic route with itself.
// NESTED groups (a group inside a group) must not share one accumulator on either route; the nested
// cases below pin that each group composites into its parent.
//
// THE REFERENCE IS CHROME'S rendering of the same SVG, read back through a 2D canvas: alpha on a
// transparent ground, color on a white one, at points away from the blur's edges.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 120;
// A large filter region: the blur's output is exactly 0 over most of it, which is where a double-counted backdrop shows.
const FILT =
  '<filter id="b" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="1.5"/></filter>' +
  // A chain the single-kind heuristic cannot fold, so it imports as a filter GRAPH.
  '<filter id="g" x="-100%" y="-100%" width="300%" height="300%"><feMorphology operator="dilate" radius="1"/><feGaussianBlur stdDeviation="1.5"/></filter>';
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}"><defs>${FILT}</defs>${body}</svg>`;
const CASES = [
  // a half-transparent rect, a blurred circle over part of it, on a TRANSPARENT ground.
  {
    name: 'filtered shape over a 50% backdrop',
    ground: 'transparent',
    svg: svg(
      '<rect x="0" y="0" width="120" height="120" fill="#000" fill-opacity="0.5"/><circle cx="40" cy="60" r="15" fill="#00f" filter="url(#b)"/>',
    ),
    pts: [
      [40, 60, 'in the circle'],
      [75, 60, 'filter region, blur is 0'],
      [40, 95, 'filter region below, blur is 0'],
      [10, 10, 'rect only'],
    ],
  },
  // an opacity group holding a rect and then a blurred circle, on WHITE.
  {
    name: 'filtered child in an opacity group',
    ground: 'white',
    grouped: true,
    svg: svg(
      '<g opacity="0.5"><rect x="10" y="10" width="60" height="100" fill="#f00"/><circle cx="80" cy="60" r="18" fill="#00f" filter="url(#b)"/></g>',
    ),
    pts: [
      [30, 60, 'rect only'],
      [85, 60, 'circle only'],
      [66, 60, 'rect under circle'],
    ],
  },
  // the same through a filter GRAPH, which takes the other branch of the isolation step.
  {
    name: 'graph-filtered child in an opacity group',
    ground: 'white',
    grouped: true,
    svg: svg(
      '<g opacity="0.5"><rect x="10" y="10" width="60" height="100" fill="#f00"/><circle cx="80" cy="60" r="18" fill="#00f" filter="url(#g)"/></g>',
    ),
    pts: [
      [30, 60, 'rect only'],
      [85, 60, 'circle only'],
      [66, 60, 'rect under circle'],
    ],
  },
  // a child AFTER the filtered one must still land in the group (the isolation step leaves
  // the accumulator bound for the runs after it).
  {
    name: 'plain child after a filtered one in an opacity group',
    ground: 'white',
    grouped: true,
    svg: svg(
      '<g opacity="0.5"><rect x="10" y="10" width="60" height="100" fill="#f00"/><circle cx="80" cy="60" r="18" fill="#00f" filter="url(#b)"/><rect x="88" y="88" width="24" height="24" fill="#0a0"/></g>',
    ),
    pts: [
      [30, 60, 'rect only'],
      [85, 60, 'circle only'],
      [100, 100, 'late rect'],
    ],
  },
  // a BLEND-MODE group over a colored backdrop: groupEnd multiplies the accumulator into the
  // canvas, so a filtered child that escaped it would paint plain blue, and one that cleared it
  // would lose the red rect to the backdrop.
  {
    name: 'filtered child in a multiply group',
    ground: 'white',
    grouped: true,
    svg: svg(
      '<rect x="0" y="0" width="120" height="120" fill="#ffc864"/><g style="mix-blend-mode:multiply"><rect x="10" y="10" width="60" height="100" fill="#f00"/><circle cx="80" cy="60" r="18" fill="#00f" filter="url(#b)"/></g>',
    ),
    pts: [
      [30, 60, 'rect only'],
      [85, 60, 'circle only'],
      [66, 60, 'rect under circle'],
      [110, 10, 'backdrop only'],
    ],
  },
  // NESTED groups: the inner group composites into the OUTER group's accumulator, and the outer
  // group's later child lands there too. With one accumulator over a snapshot of the canvas for
  // every group, the inner groupBegin would clear the outer group's red rect inside the inner
  // group's rect (60,45 white), the inner group escape the outer opacity (the circle at 0.5, not
  // 0.25), and the late green rect be overwritten by the outer groupEnd (white).
  {
    name: 'nested opacity groups with a filtered child',
    ground: 'white',
    grouped: true,
    svg: svg(
      '<g opacity="0.5"><rect x="10" y="10" width="60" height="100" fill="#f00"/><g opacity="0.5"><circle cx="80" cy="60" r="18" fill="#00f" filter="url(#b)"/></g><rect x="88" y="88" width="24" height="24" fill="#0a0"/></g>',
    ),
    pts: [
      [30, 60, 'rect only'],
      [60, 45, "rect inside the inner group's rect"],
      [85, 60, 'circle only'],
      [66, 60, 'rect under circle'],
      [100, 100, 'late rect'],
    ],
  },
  // ...and a BLEND group nested in an opacity group: the multiply blends with the outer group's
  // content (transparent beside the rect, so the circle stays blue there), never with the canvas.
  {
    name: 'filtered child in a multiply group nested in an opacity group',
    ground: 'white',
    grouped: true,
    svg: svg(
      '<rect x="0" y="0" width="120" height="120" fill="#ffc864"/><g opacity="0.5"><rect x="10" y="10" width="60" height="100" fill="#f00"/><g style="mix-blend-mode:multiply"><circle cx="80" cy="60" r="18" fill="#00f" filter="url(#b)"/></g></g>',
    ),
    pts: [
      [30, 60, 'rect only'],
      [85, 60, 'circle only'],
      [66, 60, 'rect under circle'],
      [110, 10, 'backdrop only'],
    ],
  },
];
const ROUTES = ['none', 'lb'];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__case = async (svg, ground, pts, route) => {
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  const clear = ground === 'white' ? [1, 1, 1, 1] : [0, 0, 0, 0];
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  // The route is read off the LAST frame -- the one whose pixels are compared below.
  let before = null;
  for (let i = 0; i < 4; i++) {
    if (i === 3) before = Object.assign({}, R.debugStats);
    R.beginFrame(clear); R.drawBundle(b); R.endFrame();
  }
  const after = R.debugStats;
  const d = (k) => (after[k] | 0) - (before[k] | 0);
  const routeOf = { gate: after.unifiedFillGate, uniDraws: d('unifiedFillDraws'),
                    filterDraws: d('unifiedFilterDraws'), groupBrackets: d('unifiedGroupBrackets') };
  const px = new Uint8Array(${N} * ${N} * 4);
  gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const drew = Object.assign({}, (R.debugStats.engines || {}).draws || {});
  b.dispose && b.dispose();
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
  const cv = document.createElement('canvas'); cv.width = cv.height = ${N};
  const ctx = cv.getContext('2d');
  if (ground === 'white') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, ${N}, ${N}); }
  ctx.drawImage(img, 0, 0);
  const ref = ctx.getImageData(0, 0, ${N}, ${N}).data;
  // The WebGL canvas is premultiplied; the 2D canvas's getImageData is straight. Compare straight.
  const straight = (p, i) => { const a = p[i + 3]; return a ? [p[i] * 255 / a, p[i + 1] * 255 / a, p[i + 2] * 255 / a, a] : [0, 0, 0, 0]; };
  return { route: routeOf, pts: pts.map(([x, y, what]) => ({ x, y, what,
    mantle: straight(px, ((${N} - 1 - y) * ${N} + x) * 4).map((v) => Math.round(v)),
    chrome: Array.from(ref.slice((y * ${N} + x) * 4, (y * ${N} + x) * 4 + 4)) })) };
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
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => fail('page: ' + e.message));
// Within 6/255 on every channel: both sides blur, and a Gaussian is approximated differently, but the
// sampled points sit where the blur is flat (deep inside, or far outside), so they agree tightly.
const TOL = 6;
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  for (const c of CASES)
    for (const route of ROUTES) {
      const { route: took, pts } = await page.evaluate(
        (s, g, p, r) => window.__case(s, g, p, r),
        c.svg,
        c.ground,
        c.pts,
        route,
      );
      const tookMsg =
        `${c.name}, route ${route}: last frame gate ${took.gate}, unified draws ${took.uniDraws}, ` +
        `filter isolations ${took.filterDraws}, group brackets ${took.groupBrackets}`;
      if (route === 'none') {
        if (took.uniDraws === 0) ok(tookMsg + ' (classic route)');
        else fail(tookMsg + ' -- the classic arm drew on the unified route');
      } else if (took.filterDraws > 0 && (!c.grouped || took.groupBrackets > 0)) {
        ok(tookMsg + ' (unified route)');
      } else {
        fail(
          tookMsg +
            ' -- the unified arm did not isolate the filtered child on the unified route' +
            (c.grouped ? ' inside a group it served' : ''),
        );
      }
      for (const p of pts) {
        const d = Math.max(...p.mantle.map((v, i) => Math.abs(v - p.chrome[i])));
        const msg = `${c.name}, route ${route}, ${p.what} (${p.x},${p.y}): mantle rgba(${p.mantle.join(',')}) chrome rgba(${p.chrome.join(',')})`;
        if (d <= TOL) ok(msg);
        else fail(msg + ` — off by ${d}/255`);
      }
    }
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nfilterCompositeBackdropSmoke: filtered shapes composite once, inside their groups, on both routes',
);
