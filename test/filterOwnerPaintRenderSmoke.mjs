// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Filter FillPaint / StrokePaint inputs, on the physical GPU: each filtered owner with a static solid
// fill and stroke must match, within one byte per channel, an independently authored rectangle of the color
// the primitive must produce. 38 primitive/combination cases x opaque/translucent paints (the cases) x
// AAC/Slug kernels x lean/combined programs x two draw alphas. The expected image never uses a filter.
// Infinite-extent inputs, constant sampling maps and zero texel steps are what keep blur, morphology, offset,
// tile, convolve, displacement and lighting from clipping or fading the paint at the source's edge.
//
//   MANTLE_TEST_GL=metal node test/filterOwnerPaintRenderSmoke.mjs
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from './_gpuThrottle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      const imports = {};
      for (const [key, value] of Object.entries(
        JSON.parse(readFileSync(root + '/package.json', 'utf8')).exports,
      )) {
        const file = typeof value === 'string' ? value : value.default;
        if (file?.endsWith('.js') && !key.includes('*'))
          imports['@kontek/mantle' + (key === '.' ? '' : key.slice(1))] = file.slice(1);
      }
      res.end('<script type="importmap">' + JSON.stringify({ imports }) + '</script><body/>');
      return;
    }
    const f = path.resolve(root, '.' + req.url.split('?')[0]);
    if (!f.startsWith(root + path.sep)) throw Error('outside root');
    res.setHeader('content-type', f.endsWith('.glsl') ? 'text/plain' : 'text/javascript');
    res.end(readFileSync(f));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
const cap = capWallTime(
  'filterOwnerPaint',
  async () => {
    await browser?.close();
    server.close();
  },
  600000,
);
console.log(gpuThrottleBanner());
try {
  browser = await launchBrowser({
    headless: 'new',
    protocolTimeout: 600000,
    args:
      process.env.MANTLE_TEST_GL === 'swiftshader'
        ? ['--enable-unsafe-swiftshader', '--no-sandbox']
        : ['--no-sandbox', '--use-angle=metal', '--use-gl=angle'],
  });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  await installGpuThrottle(page);
  const result = await page.evaluate(async () => {
    const M = await import('/src/index.js'),
      shaders = await M.loadShaders(new URL('/src/shaders/', location.href).href);
    const cases = [
      [
        'fill identity/opaque',
        '<feColorMatrix in="FillPaint" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0"/>',
        'rgb(0 255 0)',
        0.5,
        '',
        'rgba(0,255,0,1)',
        'rgba(0,0,255,1)',
      ],
      [
        'stroke identity/opaque',
        '<feColorMatrix in="StrokePaint" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0"/>',
        'rgb(0 0 255)',
        0.5,
        '',
        'rgba(0,255,0,1)',
        'rgba(0,0,255,1)',
      ],
      [
        'zero blur/opaque',
        '<feGaussianBlur in="FillPaint" stdDeviation="0"/>',
        'rgb(0 255 0)',
        0.5,
        '',
        'rgba(0,255,0,1)',
        'rgba(0,0,255,1)',
      ],
      [
        'blur/opaque',
        '<feGaussianBlur in="FillPaint" stdDeviation="2"/>',
        'rgb(0 255 0)',
        0.5,
        '',
        'rgba(0,255,0,1)',
        'rgba(0,0,255,1)',
      ],
      [
        'erode/opaque',
        '<feMorphology in="FillPaint" operator="erode" radius="2"/>',
        'rgb(0 255 0)',
        0.5,
        '',
        'rgba(0,255,0,1)',
        'rgba(0,0,255,1)',
      ],
      [
        'dilate/opaque',
        '<feMorphology in="FillPaint" operator="dilate" radius="2"/>',
        'rgb(0 255 0)',
        0.5,
        '',
        'rgba(0,255,0,1)',
        'rgba(0,0,255,1)',
      ],
      [
        'offset/opaque',
        '<feOffset in="FillPaint" dx="-7.25" dy="3.5"/>',
        'rgb(0 255 0)',
        0.5,
        '',
        'rgba(0,255,0,1)',
        'rgba(0,0,255,1)',
      ],
      [
        'tile/opaque',
        '<feTile in="FillPaint"/>',
        'rgb(0 255 0)',
        0.5,
        '',
        'rgba(0,255,0,1)',
        'rgba(0,0,255,1)',
      ],
      [
        'convolve/opaque',
        '<feConvolveMatrix in="FillPaint" order="3" kernelMatrix="0 0 0 0 1 0 0 0 0"/>',
        'rgb(0 255 0)',
        0.5,
        '',
        'rgba(0,255,0,1)',
        'rgba(0,0,255,1)',
      ],
      [
        'displace/opaque',
        '<feDisplacementMap in="FillPaint" in2="SourceGraphic" scale="8"/>',
        'rgb(0 255 0)',
        0.5,
        '',
        'rgba(0,255,0,1)',
        'rgba(0,0,255,1)',
      ],
      [
        'merge one/opaque',
        '<feMerge><feMergeNode in="FillPaint"/></feMerge>',
        'rgb(0 255 0)',
        0.5,
        '',
        'rgba(0,255,0,1)',
        'rgba(0,0,255,1)',
      ],
      [
        'paint intersection/opaque',
        '<feComposite in="FillPaint" in2="StrokePaint" operator="in"/>',
        'rgb(0 255 0)',
        0.5,
        '',
        'rgba(0,255,0,1)',
        'rgba(0,0,255,1)',
      ],
      [
        'source intersection/opaque',
        '<feComposite in="FillPaint" in2="SourceAlpha" operator="in"/>',
        'rgb(0 255 0)',
        0.3,
        'source',
        'rgba(0,255,0,1)',
        'rgba(0,0,255,1)',
      ],
      [
        'source masked/opaque',
        '<feComposite in="SourceGraphic" in2="FillPaint" operator="in"/>',
        'rgb(255 0 0)',
        0.3,
        'source',
        'rgba(0,255,0,1)',
        'rgba(0,0,255,1)',
      ],
      [
        'screen/opaque',
        '<feBlend in="FillPaint" in2="StrokePaint" mode="screen"/>',
        'rgb(0 255.0 255.0)',
        0.5,
        '',
        'rgba(0,255,0,1)',
        'rgba(0,0,255,1)',
      ],
      [
        'transfer/opaque',
        '<feComponentTransfer in="FillPaint"><feFuncR type="linear" slope="0" intercept="1"/><feFuncG type="linear" slope="0" intercept="0"/></feComponentTransfer>',
        'rgb(255 0 0)',
        0.5,
        '',
        'rgba(0,255,0,1)',
        'rgba(0,0,255,1)',
      ],
      [
        'merge two/opaque',
        '<feMerge><feMergeNode in="FillPaint"/><feMergeNode in="StrokePaint"/></feMerge>',
        'rgb(0 0.0 255.0)',
        0.5,
        '',
        'rgba(0,255,0,1)',
        'rgba(0,0,255,1)',
      ],
      [
        'diffuse/opaque',
        '<feDiffuseLighting in="FillPaint" lighting-color="red" diffuseConstant=".5" surfaceScale="1"><feDistantLight azimuth="0" elevation="90"/></feDiffuseLighting>',
        'rgb(127.5 0 0)',
        0.5,
        '',
        'rgba(0,255,0,1)',
        'rgba(0,0,255,1)',
      ],
      [
        'specular/opaque',
        '<feSpecularLighting in="FillPaint" lighting-color="white" specularConstant=".5" specularExponent="1" surfaceScale="1"><feDistantLight azimuth="0" elevation="90"/></feSpecularLighting>',
        'rgb(255 255 255)',
        0.25,
        '',
        'rgba(0,255,0,1)',
        'rgba(0,0,255,1)',
      ],
      [
        'fill identity/translucent',
        '<feColorMatrix in="FillPaint" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0"/>',
        'rgb(0 255 0)',
        0.2,
        '',
        'rgba(0,255,0,0.4)',
        'rgba(0,0,255,0.7)',
      ],
      [
        'stroke identity/translucent',
        '<feColorMatrix in="StrokePaint" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0"/>',
        'rgb(0 0 255)',
        0.35,
        '',
        'rgba(0,255,0,0.4)',
        'rgba(0,0,255,0.7)',
      ],
      [
        'zero blur/translucent',
        '<feGaussianBlur in="FillPaint" stdDeviation="0"/>',
        'rgb(0 255 0)',
        0.2,
        '',
        'rgba(0,255,0,0.4)',
        'rgba(0,0,255,0.7)',
      ],
      [
        'blur/translucent',
        '<feGaussianBlur in="FillPaint" stdDeviation="2"/>',
        'rgb(0 255 0)',
        0.2,
        '',
        'rgba(0,255,0,0.4)',
        'rgba(0,0,255,0.7)',
      ],
      [
        'erode/translucent',
        '<feMorphology in="FillPaint" operator="erode" radius="2"/>',
        'rgb(0 255 0)',
        0.2,
        '',
        'rgba(0,255,0,0.4)',
        'rgba(0,0,255,0.7)',
      ],
      [
        'dilate/translucent',
        '<feMorphology in="FillPaint" operator="dilate" radius="2"/>',
        'rgb(0 255 0)',
        0.2,
        '',
        'rgba(0,255,0,0.4)',
        'rgba(0,0,255,0.7)',
      ],
      [
        'offset/translucent',
        '<feOffset in="FillPaint" dx="-7.25" dy="3.5"/>',
        'rgb(0 255 0)',
        0.2,
        '',
        'rgba(0,255,0,0.4)',
        'rgba(0,0,255,0.7)',
      ],
      [
        'tile/translucent',
        '<feTile in="FillPaint"/>',
        'rgb(0 255 0)',
        0.2,
        '',
        'rgba(0,255,0,0.4)',
        'rgba(0,0,255,0.7)',
      ],
      [
        'convolve/translucent',
        '<feConvolveMatrix in="FillPaint" order="3" kernelMatrix="0 0 0 0 1 0 0 0 0"/>',
        'rgb(0 255 0)',
        0.2,
        '',
        'rgba(0,255,0,0.4)',
        'rgba(0,0,255,0.7)',
      ],
      [
        'displace/translucent',
        '<feDisplacementMap in="FillPaint" in2="SourceGraphic" scale="8"/>',
        'rgb(0 255 0)',
        0.2,
        '',
        'rgba(0,255,0,0.4)',
        'rgba(0,0,255,0.7)',
      ],
      [
        'merge one/translucent',
        '<feMerge><feMergeNode in="FillPaint"/></feMerge>',
        'rgb(0 255 0)',
        0.2,
        '',
        'rgba(0,255,0,0.4)',
        'rgba(0,0,255,0.7)',
      ],
      [
        'paint intersection/translucent',
        '<feComposite in="FillPaint" in2="StrokePaint" operator="in"/>',
        'rgb(0 255 0)',
        0.13999999999999999,
        '',
        'rgba(0,255,0,0.4)',
        'rgba(0,0,255,0.7)',
      ],
      [
        'source intersection/translucent',
        '<feComposite in="FillPaint" in2="SourceAlpha" operator="in"/>',
        'rgb(0 255 0)',
        0.12,
        'source',
        'rgba(0,255,0,0.4)',
        'rgba(0,0,255,0.7)',
      ],
      [
        'source masked/translucent',
        '<feComposite in="SourceGraphic" in2="FillPaint" operator="in"/>',
        'rgb(255 0 0)',
        0.12,
        'source',
        'rgba(0,255,0,0.4)',
        'rgba(0,0,255,0.7)',
      ],
      [
        'screen/translucent',
        '<feBlend in="FillPaint" in2="StrokePaint" mode="screen"/>',
        'rgb(0 124.39024390243902 217.68292682926827)',
        0.41000000000000003,
        '',
        'rgba(0,255,0,0.4)',
        'rgba(0,0,255,0.7)',
      ],
      [
        'transfer/translucent',
        '<feComponentTransfer in="FillPaint"><feFuncR type="linear" slope="0" intercept="1"/><feFuncG type="linear" slope="0" intercept="0"/></feComponentTransfer>',
        'rgb(255 0 0)',
        0.2,
        '',
        'rgba(0,255,0,0.4)',
        'rgba(0,0,255,0.7)',
      ],
      [
        'merge two/translucent',
        '<feMerge><feMergeNode in="FillPaint"/><feMergeNode in="StrokePaint"/></feMerge>',
        'rgb(0 37.31707317073171 217.68292682926827)',
        0.41000000000000003,
        '',
        'rgba(0,255,0,0.4)',
        'rgba(0,0,255,0.7)',
      ],
      [
        'diffuse/translucent',
        '<feDiffuseLighting in="FillPaint" lighting-color="red" diffuseConstant=".5" surfaceScale="1"><feDistantLight azimuth="0" elevation="90"/></feDiffuseLighting>',
        'rgb(127.5 0 0)',
        0.5,
        '',
        'rgba(0,255,0,0.4)',
        'rgba(0,0,255,0.7)',
      ],
      [
        'specular/translucent',
        '<feSpecularLighting in="FillPaint" lighting-color="white" specularConstant=".5" specularExponent="1" surfaceScale="1"><feDistantLight azimuth="0" elevation="90"/></feSpecularLighting>',
        'rgb(255 255 255)',
        0.25,
        '',
        'rgba(0,255,0,0.4)',
        'rgba(0,0,255,0.7)',
      ],
    ];
    const rows = [],
      spent = { buildMs: 0, warmMs: 0, readMs: 0 };
    for (const kernel of ['aac', 'slug'])
      for (const combined of [false, true]) {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
        const backend = gl.getParameter(
          gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL,
        );
        const renderer = M.createRenderer(gl, shaders, {
          aacFill: kernel === 'aac',
          aacPoints: false,
          disableFillVariants: combined,
        });
        await renderer.ready;
        renderer.setViewport(64, 64);
        renderer.setFillEngine({ route: 'none', kernel, primitives: 'off' });
        for (const [name, primitives, color, opacity, geometry, fill, stroke] of cases)
          for (const drawAlpha of [1, 0.5]) {
            const start = performance.now(),
              wrap = (content) =>
                `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${content}</svg>`,
              rect = (fill, a, filter = '') =>
                `<rect x="${geometry === 'source' ? 24 : 0}" y="${geometry === 'source' ? 24 : 0}" width="${geometry === 'source' ? 8 : 64}" height="${geometry === 'source' ? 8 : 64}" fill="${fill}" fill-opacity="${a}" ${filter}/>`;
            const actual = M.createBundle(
              gl,
              await M.importSvg(
                wrap(
                  `<defs><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64" color-interpolation-filters="sRGB">${primitives}</filter></defs>` +
                    `<g fill="${fill}" stroke="${stroke}" fill-opacity=".1" stroke-opacity=".2" opacity=".5" filter="url(#f)"><rect x="24" y="24" width="8" height="8" fill="red" stroke="none" fill-opacity=".6"/></g>`,
                ),
                { preserveViewport: true },
              ),
              { occlusionCull: false },
            );
            const expected = M.createBundle(
              gl,
              await M.importSvg(wrap(rect(color, opacity)), { preserveViewport: true }),
              { occlusionCull: false },
            );
            const draw = (b) => {
              renderer.beginFrame([0, 0, 0, 0]);
              renderer.drawBundle(b, { alpha: drawAlpha });
              renderer.endFrame();
            };
            const read = async (b) => {
              draw(b);
              if (!(await window.__gpuFence(gl, 60000))) throw Error('fence');
              const p = new Uint8Array(64 * 64 * 4);
              gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, p);
              return p;
            };
            // The throttle's idle is owed for the GPU's busy time: the two fenced reads, each two 64 px draws. Parsing and building the
            // bundles is CPU work, and the warm's time is program links and fence waits around the same two draws per pass.
            const warmStart = performance.now();
            spent.buildMs += warmStart - start;
            const warm = await renderer.warmScene(
              [{ draw: () => draw(actual) }, { draw: () => draw(expected) }],
              { maxPasses: 64, fenceTimeoutMs: 60000 },
            );
            if (!warm.complete) throw Error('warm');
            const readStart = performance.now();
            spent.warmMs += readStart - warmStart;
            const a = await read(actual),
              e = await read(expected);
            const readMs = performance.now() - readStart;
            spent.readMs += readMs;
            let maxByte = 0,
              failedPixels = 0;
            for (let i = 0; i < a.length; i += 4) {
              let bad = false;
              for (let c = 0; c < 4; c++) {
                const error = Math.abs(a[i + c] - e[i + c]);
                maxByte = Math.max(maxByte, error);
                bad ||= error > 1;
              }
              failedPixels += bad;
            }
            rows.push({
              name,
              kernel,
              combined,
              drawAlpha,
              maxByte,
              failedPixels,
              actualCenter: Array.from(a.slice((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 4)),
              expectedCenter: Array.from(e.slice((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 4)),
              backend,
              glError: gl.getError(),
            });
            actual.dispose();
            expected.dispose();
            await window.__gpuIdle(readMs);
          }
        renderer.dispose();
        gl.getExtension('WEBGL_lose_context').loseContext();
      }
    return { rows, spent };
  });
  const failed = result.rows.filter((r) => r.maxByte > 1 || r.glError);
  console.log({
    states: result.rows.length,
    failed: failed.length,
    buildS: +(result.spent.buildMs / 1000).toFixed(1),
    warmS: +(result.spent.warmMs / 1000).toFixed(1),
    readS: +(result.spent.readMs / 1000).toFixed(1),
  });
  if (result.rows.length !== 304) throw Error('expected 304 states, ran ' + result.rows.length);
  if (failed.length) {
    console.error(failed.slice(0, 8));
    throw Error('filter owner paint pixels');
  }
  console.log('filterOwnerPaintRenderSmoke PASS');
} finally {
  cap.clear();
  await browser?.close();
  server.close();
}
