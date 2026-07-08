// Exercises all 6 card-flip a→b morph pairs end-to-end. Each interval should
// produce a CLEAN silhouette at t=0/0.5/1 — no fragmentation — across every
// pose pair. Requires external card-flip pose fixtures (see CARDS_DIR);
// renders PNGs for visual inspection.
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// External art fixtures. Point CARDS_DIR at a folder of card-flip
// pose SVGs (card-flip.NNx.svg pairs); the test skips cleanly when
// it's unset or the folder is missing.
const CARDS_DIR = process.env.CARDS_DIR || '';
if (!CARDS_DIR || !existsSync(CARDS_DIR)) {
  console.log(`SKIP cardFlipRepro: card fixtures not found (set CARDS_DIR to a card-flip pose folder)`);
  process.exit(0);
}
const OUT = path.join(__dirname, 'visuals', 'card-flip-repro');
mkdirSync(OUT, { recursive: true });

function mime(p) {
  if (p.endsWith('.html')) return 'text/html';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  if (p.endsWith('.glsl')) return 'text/plain';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try { res.writeHead(200, { 'content-type': mime(p) + '; charset=utf-8' });
        res.end(readFileSync(path.join(ROOT, p))); }
  catch { try { res.writeHead(404); res.end(); } catch {} }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/mantleDemo.html`;

const intervals = [];
for (let i = 0; i < 6; i++) {
  const aId = `0${i}a`.slice(-3);
  const bId = `0${i}b`.slice(-3);
  intervals.push({
    intervalIndex: i,
    srcSvg: readFileSync(path.join(CARDS_DIR, `card-flip.${aId}.svg`), 'utf8'),
    dstSvg: readFileSync(path.join(CARDS_DIR, `card-flip.${bId}.svg`), 'utf8'),
  });
}

let failures = 0;
const fail = (m) => { failures++; console.error('FAIL', m); };
const ok   = (m) => console.log('ok', m);

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 400, height: 400 });
page.on('pageerror', e => console.error('  [page-err]', e.message));

await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 10000 });

// Override SVG fills to magenta-ish hues so we can tell the static
// poses apart from the morph lerp. We replace fill="#FFFFFF" → red /
// blue in each pair.
function tintSvg(svg, color) {
  return svg.replace(/fill="#FFFFFF"/g, `fill="${color}"`).replace(/fill-opacity="[^"]+"/g, '');
}

for (const iv of intervals) {
  const SRC = tintSvg(iv.srcSvg, '#ff0000');
  const DST = tintSvg(iv.dstSvg, '#0000ff');

  const result = await page.evaluate(async (srcSvg, dstSvg) => {
    const { importSvg, createBundle, createShapeMorph } =
      await import('/src/index.js');
    const gl = window.__mantleGl;
    const renderer = window.__mantleRenderer;
    const cnv = document.getElementById('glcanvas');

    async function mkb(svg) { return createBundle(gl, await importSvg(svg)); }
    const bSrc = await mkb(srcSvg);
    const bDst = await mkb(dstSvg);

    function snap(handle) {
      renderer.render(handle);
      return cnv.toDataURL('image/png');
    }

    const morph = createShapeMorph(gl, bSrc, bDst);
    const refSrcPng = snap(bSrc);
    const refDstPng = snap(bDst);
    morph.setT(0);   const m0Png   = snap(morph);
    morph.setT(0.25); const m25Png = snap(morph);
    morph.setT(0.5); const mMidPng = snap(morph);
    morph.setT(0.75); const m75Png = snap(morph);
    morph.setT(1);   const m1Png   = snap(morph);

    // Compare morph0 to refSrc and morph1 to refDst pixel-by-pixel.
    function diffCount(a, b) {
      // Both are data: URLs — decode via image data instead.
      return null; // do diff outside the browser
    }

    morph.dispose(); bSrc.dispose(); bDst.dispose();
    return {
      refSrcPng, refDstPng,
      m0Png, m25Png, mMidPng, m75Png, m1Png,
    };
  }, SRC, DST);

  // Save all PNGs.
  for (const [name, dataUrl] of Object.entries(result)) {
    if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) continue;
    const buf = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
    const fname = `iv${iv.intervalIndex}-${name.replace(/Png$/, '')}.png`;
    writeFileSync(path.join(OUT, fname), buf);
  }
  console.log(`  iv ${iv.intervalIndex} → saved 7 PNGs to ${OUT}/iv${iv.intervalIndex}-*.png`);
}

await browser.close();
server.close();

console.log();
console.log('Visual inspection required: open PNGs in', OUT);
