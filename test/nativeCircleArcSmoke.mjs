// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeCircleArcSmoke.mjs — a circle decoded back to a path `d` must still
// be a circle in the browser.
//
// The no-WebGL fallback decodes curve buffers to SVG path data (morph frames
// and streamed geometry have no source markup to reuse). svg/shape.js encodes
// every <circle> and <ellipse> as ONE arc over [-PI, PI], and a full
// revolution lands back on its own start point — so the decoder emitted
//
//   M20 50 A30 30 0 1 1 20 50 ...
//
// with identical endpoints. SVG §F.6.2: an elliptical arc whose endpoints are
// identical "is equivalent to omitting the elliptical arc segment entirely."
// The circle didn't render.
//
// The browser is the authority on that rule, not the spec text or my reading
// of it, so this renders the decoded `d` for real and compares it against the
// <circle> it came from. A pure-JS assertion on the string could only check
// what I already believe.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';

globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { default: importSvg } = await import('../src/svg/importer.js');
const { curveRangeToPathD } = await import('../src/fallback/curveToPathD.js');
const { segsToPathD } = await import('../src/svg/segment.js');
const { parseShape } = await import('../src/svg/shape.js');

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('  ok ' + m);

// Decode each shape through the fallback's own decoder.
const decode = async (markup) => {
  const r = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${markup}</svg>`,
    {},
  );
  const cf = r.curveFloats || new Float32Array(r.curves);
  const rg = r.curveRangesByShape[0];
  return curveRangeToPathD(cf, rg.begin, rg.end);
};

// The OTHER path to a `d` string. curveRangeToPathD decodes the packed curve
// buffer (morph frames); segsToPathD converts a segment list, and is what the
// native streaming road and the WebGL stream's path cache use. Both had the
// same full-sweep bug, so both are checked here — fixing one and not the other
// would have left circles vanishing on the streaming path only.
const decodeSegs = (markup) => {
  const doc = new DP().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${markup}</svg>`,
    'text/xml',
  );
  const el = doc.documentElement.getElementsByTagName('*')[0];
  return segsToPathD(parseShape(el, { vx: 100, vy: 100, vd: 100 }));
};

const CASES = [
  { name: 'circle', markup: '<circle cx="50" cy="50" r="30"/>' },
  { name: 'ellipse', markup: '<ellipse cx="50" cy="50" rx="30" ry="18"/>' },
  // A genuine half arc must be untouched by the full-sweep split.
  { name: 'half arc', markup: '<path d="M20 50A30 30 0 0 1 80 50Z"/>' },
];
for (const c of CASES) {
  c.d = await decode(c.markup);
  c.dSegs = decodeSegs(c.markup);
}

const server = http.createServer((req, res) => {
  try {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, 'mantleDemo.html')));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 200, height: 200 });

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, {
    waitUntil: 'load',
    timeout: 20000,
  });

  const out = await page.evaluate(
    async (cases) => {
      // Rasterize a fragment of SVG markup and count filled pixels.
      const inkOf = async (inner) => {
        const svg =
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" ' +
          `width="200" height="200">${inner}</svg>`;
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = () => rej(new Error('img load failed'));
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        });
        const cv = document.createElement('canvas');
        cv.width = 200;
        cv.height = 200;
        const c = cv.getContext('2d');
        c.fillStyle = '#fff';
        c.fillRect(0, 0, 200, 200);
        c.drawImage(img, 0, 0, 200, 200);
        const d = c.getImageData(0, 0, 200, 200).data;
        let ink = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 128) ink++;
        return ink;
      };
      const res = [];
      for (const c of cases) {
        res.push({
          name: c.name,
          source: await inkOf(c.markup.replace('/>', ' fill="#000"/>')),
          decoded: await inkOf(`<path d="${c.d}" fill="#000"/>`),
          decodedSegs: await inkOf(`<path d="${c.dSegs}" fill="#000"/>`),
        });
      }
      return res;
    },
    CASES.map(({ name, markup, d, dSegs }) => ({ name, markup, d, dSegs })),
  );

  for (const r of out) {
    if (r.source < 500) {
      fail(`${r.name}: the SOURCE markup rendered ${r.source} px — the rig is broken`);
      continue;
    }
    if (r.decoded < 500) {
      fail(
        `${r.name}: decoded path rendered ${r.decoded} px vs ${r.source} for the source — ` +
          'the browser dropped the arc (identical endpoints, §F.6.2)',
      );
      continue;
    }
    const drift = Math.abs(r.decoded - r.source) / r.source;
    if (drift < 0.02)
      ok(`${r.name}: curve-buffer decode matches the source (${r.decoded} vs ${r.source} px)`);
    else
      fail(
        `${r.name}: curve-buffer decode covers ${r.decoded} px vs ${r.source} (${(drift * 100).toFixed(1)}% off)`,
      );

    if (r.decodedSegs < 500) {
      fail(
        `${r.name}: segsToPathD rendered ${r.decodedSegs} px vs ${r.source} — ` +
          'the browser dropped the arc on the streaming path',
      );
    } else {
      const ds = Math.abs(r.decodedSegs - r.source) / r.source;
      if (ds < 0.02)
        ok(`${r.name}: segsToPathD matches the source (${r.decodedSegs} vs ${r.source} px)`);
      else
        fail(
          `${r.name}: segsToPathD covers ${r.decodedSegs} px vs ${r.source} (${(ds * 100).toFixed(1)}% off)`,
        );
    }
  }
} catch (e) {
  fail(`drive failed: ${e.message}`);
}

await browser.close();
server.close();
console.log();
console.log(failures === 0 ? 'NATIVE-CIRCLE-ARC PASS' : `NATIVE-CIRCLE-ARC FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
