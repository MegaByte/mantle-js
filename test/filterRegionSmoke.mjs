// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterRegionSmoke — a <filter> region CLIPS the output, on every frame and on both fill routes.
//
// Per Filter Effects 1 §7.1, x/y/width/height on <filter> (in filterUnits: objectBoundingBox, the default, or
// userSpaceOnUse) define a region that clips the filter output: nothing outside it is painted, however far a blur
// reaches. An unstated region is -10%/-10%/120%/120% of the element's bounding box, and that box is the geometry alone,
// so a wide stroke is cut as well. Chrome and WebKit render every case below that way.
//
// Ignoring a stated region lets a blur paint 1208 px past it. A shape that references the filter itself clips to a
// stated objectBoundingBox region, to a userSpaceOnUse region through its own transform, and to the implicit default. A filter inherited from a group keeps
// the stated-objectBoundingBox rule; filterRegionImportSmoke checks the region arrays for every case and says why.
//
// THE REGION CLIPS THE COMPOSITE, NOT THE CACHED RESULT, so one frame proves nothing about a static shape: the first
// frame evaluates the filter and every later one composites the stored texture; a cache hit that dropped the region
// would hold the clip for exactly one frame. Each scene therefore draws until a frame evaluates nothing and checks that
// frame too. The region resolves from the geometry bbox, not the stroke-padded one, so a wide stroke is cut.
//
// Both fill routes run every scene: the drawList loop (Loop-Blinn off) and the unified route (Loop-Blinn on), which
// isolates a filtered shape through a composite of its own. Their cached frames must also AGREE, because a region clips
// a wrong result as neatly as a right one: a filter cache keyed without the bundle would have each scene's fresh bundle
// composite the previous scene's blur, and the graph scene pass every region check with no offset.
//
// Each scene is a filtered 20x20 square at (40,40) and the rect its output must stay inside. The control states a region
// far wider than its rect, so the blur must show ink outside it, or this probe is measuring nothing.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Corner dots pin globalBBox to the full viewBox. Without them the content bbox is just the filtered rect, the renderer
// fits THAT to the viewport, and a region maps outside the canvas entirely -- every pixel then counts as "inside" and the
// probe reports 0 outside whatever the code does.
const DOTS =
  '<rect x="0" y="0" width="0.5" height="0.5" fill="#000"/>' +
  '<rect x="99.5" y="99.5" width="0.5" height="0.5" fill="#000"/>';
const BLUR = '<feGaussianBlur stdDeviation="4"/>';
const scene = (filterAttrs, shape, prims = BLUR) =>
  DOTS + `<defs><filter id="f"${filterAttrs}>${prims}</filter></defs>` + shape;
const SQUARE = '<rect x="40" y="40" width="20" height="20" fill="#000" filter="url(#f)"/>';
const REGION = { x: 35, y: 35, w: 30, h: 30 };
const SCENES = {
  'wide stated region (control)': {
    svg: scene(' x="-2" y="-2" width="5" height="5"', SQUARE),
    region: REGION,
    control: true,
  },
  // Fractions of the 20x20 square: -0.25..1.25 is em 35..65, the same REGION.
  'objectBoundingBox region': {
    svg: scene(' x="-0.25" y="-0.25" width="1.5" height="1.5"', SQUARE),
    region: REGION,
  },
  'userSpaceOnUse region': {
    svg: scene(' filterUnits="userSpaceOnUse" x="35" y="35" width="30" height="30"', SQUARE),
    region: REGION,
  },
  // The square drawn at x=30 and moved 10 right: the region is in ITS user space, 25..55, so root 35..65.
  'userSpaceOnUse region on a translated shape': {
    svg: scene(
      ' filterUnits="userSpaceOnUse" x="25" y="35" width="30" height="30"',
      '<rect x="30" y="40" width="20" height="20" fill="#000" transform="translate(10 0)" filter="url(#f)"/>',
    ),
    region: REGION,
  },
  // No region stated: -10%/120% of the 20x20 square is em 38..62.
  'implicit default region': { svg: scene('', SQUARE), region: { x: 38, y: 38, w: 24, h: 24 } },
  // Two primitives make a filter GRAPH, which caches and composites apart from a lone blur's single-kind record.
  // The unified route caches a graph only when its root is the whole canvas (morphDraw.js), and this root is a sub-rect,
  // so there it evaluates every frame and the region check runs on an evaluated frame instead of a cached one.
  'implicit default region, filter graph': {
    svg: scene(
      '',
      SQUARE,
      '<feGaussianBlur stdDeviation="4" result="b"/><feOffset in="b" dx="2" dy="2"/>',
    ),
    region: { x: 38, y: 38, w: 24, h: 24 },
    uncachedOnUnified: true,
  },
  // A 6-wide stroke reaches 37..63, but the default region is 120% of the GEOMETRY, 38..62, so the stroke is cut.
  'implicit default region, wide stroke': {
    svg: scene(
      '',
      '<rect x="40" y="40" width="20" height="20" fill="#000" stroke="#000" stroke-width="6" filter="url(#f)"/>',
    ),
    region: { x: 38, y: 38, w: 24, h: 24 },
  },
  // A filter on a <g> belongs to the group: the region is 120% of the GROUP's box, and each child is cut at it.
  'filter on a group clips at the group box': {
    svg: scene(
      '',
      '<g filter="url(#f)"><rect x="40" y="40" width="20" height="20" fill="#000"/></g>',
    ),
    region: { x: 38, y: 38, w: 24, h: 24 },
  },
  // Two children: the box is the UNION (30..70 by 40..50), so the region is 26..74 by 39..51.
  'filter on a group of two shapes uses their union': {
    svg: scene(
      '',
      '<g filter="url(#f)"><rect x="30" y="40" width="10" height="10" fill="#000"/>' +
        '<rect x="60" y="40" width="10" height="10" fill="#000"/></g>',
    ),
    region: { x: 26, y: 39, w: 48, h: 12 },
  },
  // A line has no height, so an objectBoundingBox region has none: the filter output is empty and nothing is drawn,
  // which is what Chrome and WebKit render.
  'zero-height box draws nothing': {
    svg: scene(
      '',
      '<line x1="30" y1="50" x2="70" y2="50" stroke="#000" stroke-width="8" filter="url(#f)"/>',
    ),
    region: { x: 0, y: 0, w: 100, h: 100 },
    empty: true,
  },
  // The non-standard override for converted content whose source did not clip: the blur keeps its full reach.
  'data-mantle-filter-region="none" keeps the effect unclipped': {
    svg: scene(' data-mantle-filter-region="none"', SQUARE),
    region: { x: 38, y: 38, w: 24, h: 24 },
    control: true,
  },
};

const mime = (p) =>
  /\.(js|mjs)$/.test(p)
    ? 'text/javascript'
    : p.endsWith('.glsl')
      ? 'text/plain'
      : 'application/octet-stream';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<canvas id=c width=400 height=400></canvas>');
    return;
  }
  const p = decodeURIComponent(u.pathname);
  try {
    const b = readFileSync(path.join(ROOT, p));
    res.writeHead(200, { 'content-type': mime(p) + '; charset=utf-8' });
    res.end(b);
  } catch {
    try {
      res.writeHead(404);
    } catch {}
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

let failures = 0;
const ok = (m) => console.log('  ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL ' + m);
};

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 30000,
});

const out = await page.evaluate(async (scenes) => {
  const { importSvg, createBundle, createRenderer, loadShaders } = await import('/src/index.js');
  const cv = document.getElementById('c');
  const S = 400;
  const gl = cv.getContext('webgl2', {
    antialias: false,
    preserveDrawingBuffer: true,
    stencil: true,
    depth: true,
  });
  const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
  // rAF alone never settles in a headless page with no visible work.
  const nextFrame = () =>
    new Promise((r) => {
      const _t = setTimeout(r, 100);
      requestAnimationFrame(() => {
        clearTimeout(_t);
        r();
      });
    });
  const res = {},
    shots = {};
  for (const route of ['drawList', 'unified']) {
    // aacFill off so the unified arm is Loop-Blinn's route and not a third engine.
    const R = createRenderer(gl, shaders, { aacFill: false });
    R.setLoopBlinnFill(route === 'unified' ? 'on' : 'off');
    const stats = () => R.debugStats || {};
    for (const [name, sc] of Object.entries(scenes)) {
      const sec = await importSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' + sc.svg + '</svg>',
      );
      const b = createBundle(gl, sec);
      const frame = () => {
        R.setViewport(S, S);
        R.beginFrame([1, 1, 1, 1]);
        R.drawBundle(b);
        R.endFrame();
      };
      if (route === 'unified') {
        // As unifiedFilterSplitSmoke: the mesh arrives off-thread and the first draw names the variant the bundle needs.
        try {
          R.prepareBundle(b);
        } catch {}
        if (R.awaitLbReady) {
          try {
            await R.awaitLbReady(b, 20000);
          } catch {}
        }
        if (R.prewarmBundle) {
          try {
            R.prewarmBundle(b);
          } catch {}
        }
        for (let i = 0; i < 10 && !((stats().unifiedFillDraws | 0) > 0); i++) {
          frame();
          if (R.precompileFills) {
            try {
              R.precompileFills();
            } catch {}
          }
          await nextFrame();
        }
      }
      // globalBBox is what the renderer fits to the viewport, so em -> px goes through it rather than through the viewBox.
      const gb = sec.globalBBox;
      const sx = S / gb[2],
        sy = S / gb[3];
      const rx0 = (sc.region.x - gb[0]) * sx,
        ry0 = (sc.region.y - gb[1]) * sy;
      const rx1 = rx0 + sc.region.w * sx,
        ry1 = ry0 + sc.region.h * sy;
      const measure = () => {
        const px = new Uint8Array(S * S * 4);
        gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let inside = 0,
          outside = 0;
        for (let y = 0; y < S; y++)
          for (let x = 0; x < S; x++) {
            const i = (y * S + x) * 4;
            if (px[i] > 245 && px[i + 1] > 245 && px[i + 2] > 245) continue; // background
            if (x < 6 || x > S - 6 || y < 6 || y > S - 6) continue; // the pinning dots
            const yTop = S - 1 - y; // canvas y is GL-bottom-up
            if (x >= rx0 && x <= rx1 && yTop >= ry0 && yTop <= ry1) inside++;
            else outside++;
          }
        return { inside, outside, px };
      };
      frame();
      const first = measure();
      // Draw until a frame evaluates no filter: that frame composited the cached result.
      let hit = false,
        uni = 0;
      for (let i = 0; i < 12 && !hit; i++) {
        await nextFrame();
        const e0 = stats().filterEvalCount | 0,
          u0 = stats().unifiedFilterDraws | 0;
        frame();
        hit = (stats().filterEvalCount | 0) === e0;
        uni = (stats().unifiedFilterDraws | 0) - u0;
      }
      const cached = measure();
      shots[route + ': ' + name] = cached.px;
      res[route + ': ' + name] = {
        first: { inside: first.inside, outside: first.outside },
        cached: { inside: cached.inside, outside: cached.outside },
        hit,
        uni,
      };
      b.dispose();
    }
  }
  for (const name of Object.keys(scenes)) {
    const a = shots['drawList: ' + name],
      c = shots['unified: ' + name];
    if (!a || !c) continue;
    let px = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (
        Math.max(
          Math.abs(a[i] - c[i]),
          Math.abs(a[i + 1] - c[i + 1]),
          Math.abs(a[i + 2] - c[i + 2]),
        ) > 32
      )
        px++;
    }
    res['routes differ: ' + name] = px;
  }
  return res;
}, SCENES);

await browser.close();
server.close();

const fmt = (m) =>
  `inside ${String(m.inside).padStart(6)}  outside ${String(m.outside).padStart(6)}`;
for (const [key, v] of Object.entries(out)) {
  if (key.startsWith('routes differ: ')) continue;
  console.log(
    `   ${key.padEnd(56)} first ${fmt(v.first)}   cached ${fmt(v.cached)}${v.hit ? '' : '   (no cache hit)'}`,
  );
}
for (const route of ['drawList', 'unified']) {
  for (const [name, sc] of Object.entries(SCENES)) {
    const key = route + ': ' + name,
      v = out[key];
    if (!v) {
      fail(`${key}: did not render`);
      continue;
    }
    if (route === 'unified' && !(v.uni > 0)) {
      fail(
        `${key}: the unified route drew no filtered shape, so this arm measured the drawList loop again`,
      );
      continue;
    }
    if (sc.empty && !v.hit) {
      // Nothing is composited, so the route may never reach its result cache; the drawn-nothing check is the point.
      console.log(`  note ${key}: no cache hit (nothing is composited)`);
    } else if (!v.hit && route === 'unified' && sc.uncachedOnUnified) {
      console.log(
        `  note ${key}: evaluated on every frame (a sub-canvas graph root is not cached on this route)`,
      );
    } else if (!v.hit) {
      fail(
        `${key}: no frame in 12 came off the filter-result cache, so the cached composite went unchecked`,
      );
      continue;
    }
    for (const [when, m] of [
      ['first frame', v.first],
      ['cached frame', v.cached],
    ]) {
      if (sc.empty) {
        if (m.inside === 0 && m.outside === 0)
          ok(`${key}, ${when}: draws nothing, as an empty region requires`);
        else
          fail(
            `${key}, ${when}: ${m.inside + m.outside} px drawn, but the region is empty so the element is not rendered`,
          );
      } else if (sc.control) {
        if (m.outside > 0)
          ok(
            `${key}, ${when}: ink reaches past the rect (${m.outside} px), so the probe can see a clip`,
          );
        else
          fail(
            `${key}, ${when}: no ink outside the rect even with a wide region, so something else clips and this probe measures nothing`,
          );
      } else if (m.inside === 0) {
        fail(`${key}, ${when}: nothing rendered inside the region, over-clipped`);
      } else if (m.outside === 0) {
        ok(`${key}, ${when}: clips the output to the region (0 px outside, ${m.inside} px inside)`);
      } else {
        fail(
          `${key}, ${when}: ${m.outside} px outside the region, so the clip is missing or on the wrong rect`,
        );
      }
    }
  }
}
for (const name of Object.keys(SCENES)) {
  const d = out['routes differ: ' + name],
    v = out['drawList: ' + name];
  if (d === undefined || !v) continue;
  // Loop-Blinn and Slug antialias edges a little differently; a wrong filter result differs by thousands of pixels.
  const allow = Math.max(16, Math.ceil(0.01 * (v.cached.inside + v.cached.outside)));
  if (d <= allow)
    ok(`${name}: both routes draw the same cached frame (${d} px differ, allowed ${allow})`);
  else
    fail(
      `${name}: the unified route's cached frame differs from the drawList loop's by ${d} px (allowed ${allow}), so one route drew a different result`,
    );
}
console.log();
console.log(failures === 0 ? 'FILTER-REGION PASS' : `FILTER-REGION FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
