// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// exportFrameSvgSmoke.mjs — proof that the WebGL (non-native) renderer can
// serialize the current FRAME to an SVG string by replaying its recorded
// draw list through the native (DOM) backend — renderer.exportFrameSVG().
//
// Runs in a real browser (puppeteer) with a REAL WebGL2 context (the
// non-native renderer is the thing under test) AND real DOMParser /
// XMLSerializer (so the native replay + serialization are genuine).
//
// Asserts:
//   1. Frame export is available when capture is enabled.
//   2. A drawn frame serializes to a parseable <svg> with content.
//   3. Per-shape overrides land in the markup: a hidden shape is hidden,
//      a recolored shape carries its new fill.
//   4. A shape MORPH reconstructs geometry on demand: export at t=0 and
//      t=0.5 differ (the lerped path is rebuilt on the CPU at call time),
//      with zero skipped draws.
//   5. PRECONDITION: a bundle imported WITHOUT retainSource is skipped
//      (and reported in notes), not silently emitted blank.
//
// TEXT bundles export two ways (a second page, shaping with the Roboto fixture):
//   - default (recoverText off): glyph-outline <path>s, synthesized from
//     the GL text bundle's own geometry (which carries no svgSource).
//   - recoverText:true with a bundle built { retainText:true }: a real
//     SVG <text> element carrying the original string, fill and baseline.
//   - recoverText:true but NO retained text → falls back to glyph paths.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
import { fontFixture, optionalAsset } from './_assets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// The text page shapes with Roboto; without the fixture only that page is skipped.
const FONT_PATH = optionalAsset(fontFixture('roboto-regular.ttf'));
const fontB64 = FONT_PATH ? readFileSync(FONT_PATH).toString('base64') : '';

// Three id'd shapes so overrides can address them by id.
const ART = readFileSync(
  new URL('../examples/smoke/exportFrameSvg__ART.svg', import.meta.url),
  'utf8',
);

// Two matched-topology poses (same id 'p', same path topology, different x)
// for a whole-bundle shape morph. The matched path lerps geometrically.
const POSE_A = readFileSync(
  new URL('../examples/smoke/exportFrameSvg__POSE_A.svg', import.meta.url),
  'utf8',
);
const POSE_B = readFileSync(
  new URL('../examples/smoke/exportFrameSvg__POSE_B.svg', import.meta.url),
  'utf8',
);

// A two-sprite sheet for drawSprite subset export.
const SHEET = readFileSync(
  new URL('../examples/smoke/exportFrameSvg__SHEET.svg', import.meta.url),
  'utf8',
);

// A clipped shape whose clip can be moved via setClipper('win', …).
const CLIPART = readFileSync(
  new URL('../examples/smoke/exportFrameSvg__CLIPART.svg', import.meta.url),
  'utf8',
);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable, createShapeMorph }
  from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);

const artSections = await importSvg(${JSON.stringify(ART)}, { retainSource: true });
const art = createBundle(gl, artSections);
const noSrc = createBundle(gl, await importSvg(${JSON.stringify(ART)})); // no retainSource

const poseA = createBundle(gl, await importSvg(${JSON.stringify(POSE_A)}, { retainSource: true }));
const poseB = createBundle(gl, await importSvg(${JSON.stringify(POSE_B)}, { retainSource: true }));
const sheet = createBundle(gl, await importSvg(${JSON.stringify(SHEET)}, { retainSource: true }));
const clipArt = createBundle(gl, await importSvg(${JSON.stringify(CLIPART)}, { retainSource: true }));

window.__hasFn = typeof renderer.exportFrameSVG === 'function';
// Capture defaults OFF (export instrumentation is opt-in); enable it for
// the frames we want to export — the intended usage pattern.
window.__capDefaultOff = renderer.frameCaptureEnabled === false;
renderer.setFrameCapture(true);

// Draw a plain frame, then export it.
window.__exportPlain = async () => {
  renderer.setViewport(100, 100);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(art, {});
  renderer.endFrame();
  return await renderer.exportFrameSVG({ detail: true });
};

// Draw with overrides: hide 'dot', recolor 'box' to a unique green.
window.__exportOverridden = async () => {
  const ovr = createOverrideTable(gl, art);
  ovr.set('dot', { visibility: 0 });
  ovr.set('box', { fill: [0.1, 0.8, 0.3, 1] });
  renderer.setViewport(100, 100);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(art, { overrides: ovr });
  renderer.endFrame();
  return await renderer.exportFrameSVG();
};

// Morph poseA→poseB; export at a given t.
const morph = createShapeMorph(gl, poseA, poseB);
window.__exportMorph = async (t) => {
  morph.setT(t);
  renderer.setViewport(100, 100);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(morph, {});
  renderer.endFrame();
  return await renderer.exportFrameSVG({ detail: true });
};

// drawSprite subset: only the addressed sprite's shapes should survive;
// the rest of the sheet is hidden. Compare a full-sheet draw (nothing
// hidden) against a single-sprite draw (the other sprite hidden).
window.__exportSheetFull = async () => {
  renderer.setViewport(200, 100);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(sheet, {});
  renderer.endFrame();
  return await renderer.exportFrameSVG();
};
window.__exportSprite = async () => {
  renderer.setViewport(200, 100);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawSprite(sheet, 'poseB', {});
  renderer.endFrame();
  return await renderer.exportFrameSVG({ detail: true });
};

// Animated clipper: move the clip via setClipper, then export — the live
// <clipPath> element should carry the transform in the markup.
window.__exportClipper = async () => {
  const ovr = createOverrideTable(gl, clipArt);
  ovr.setClipper('win', { localPosition: [30, 0] });
  renderer.setViewport(100, 100);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(clipArt, { overrides: ovr });
  renderer.endFrame();
  return await renderer.exportFrameSVG();
};

// A bundle with no retained source must be skipped, not blank-emitted.
window.__exportNoSrc = async () => {
  renderer.setViewport(100, 100);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(noSrc, {});
  renderer.endFrame();
  return await renderer.exportFrameSVG({ detail: true });
};

// Parse helper run in-page (real DOMParser).
window.__parse = (svg) => {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  // Count visually-hidden elements (opacity 0 via attr or style).
  let hidden = 0;
  for (const el of root.querySelectorAll('*')) {
    const op = el.getAttribute('opacity');
    const st = (el.getAttribute('style') || '');
    const disp = el.style ? el.style.display : '';
    if (op === '0' || /opacity\\s*:\\s*0(?!\\.)/.test(st) || disp === 'none'
        || /display\\s*:\\s*none/.test(st)) hidden++;
  }
  return {
    tag: root.tagName.toLowerCase(),
    childCount: root.querySelectorAll('*').length,
    hidden,
    // The recolor fill [0.1,0.8,0.3,1] serializes (rgbaToCss) to
    // rgba(26,204,77,1). Assert that exact value reached the markup.
    hasGreenFill: /rgba\\(\\s*26\\s*,\\s*204\\s*,\\s*77\\b/.test(svg),
  };
};

window.__exportPlacement = async () => {
  await renderer.ready;
  const body = '<rect x="8" y="10" width="20" height="16" fill="red"/><path d="M4 44H60" fill="none" stroke="white" stroke-width="8" vector-effect="non-scaling-stroke" stroke-dasharray="8 4"/>';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 64 64">' + body + '</svg>';
  const bundle = createBundle(gl, await importSvg(svg, {retainSource:true,preserveViewport:true}));
  const previousEngine = renderer.getFillEngine();
  renderer.setFillEngine({route:'none',kernel:'aac',primitives:'off'});
  const rows = [];
  const raster = async text => {
    const im = new Image(); im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text); await im.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 800;
    const ctx = canvas.getContext('2d'); ctx.drawImage(im,0,0,800,800); return ctx.getImageData(0,0,800,800).data;
  };
  try {
    renderer.setViewport(100,100);
    for (const mode of ['default','world','rect','instances']) {
      const opts = mode === 'world' ? {worldMatrix:[2,0,0,0,2,0,0,0,1]} : mode === 'rect' ? {dstRect:[-25,-25,150,150],clipToRect:false} : {};
      const draw = () => {
        renderer.beginFrame([0,0,0,0]);
        if (mode === 'instances') renderer.drawBundleInstanced(bundle,[{worldMatrix:[1,0,0,0,1,0,-.4,.2,1]},{worldMatrix:[.5,0,0,0,.5,0,.5,-.5,1]}]);
        else renderer.drawBundle(bundle,opts);
        renderer.endFrame();
      };
      draw(); gl.finish();
      const pixels = new Uint8Array(100*100*4); gl.readPixels(0,0,100,100,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      const exported = await renderer.exportFrameSVG({detail:true});
      const ref = await raster(exported.svg); let max=0,checked=0,ink=0;
      for (let y=3;y<97;y+=2) for(let x=3;x<97;x+=2) {
        const center=((y*8+4)*800+x*8+4)*4; let stable=true;
        for(const dy of [-12,0,12]) for(const dx of [-12,0,12]) for(let k=0;k<4;k++) if(ref[center+(dy*800+dx)*4+k]!==ref[center+k])stable=false;
        if(!stable)continue; checked++; if(ref[center+3]>0)ink++;
        const at=((99-y)*100+x)*4,a=ref[center+3];
        for(let k=0;k<4;k++)max=Math.max(max,Math.abs(pixels[at+k]-(k===3?a:ref[center+k]*a/255)));
      }
      rows.push({mode,max,checked,ink,drawn:exported.drawn,skipped:exported.skipped});
    }
  } finally {bundle.dispose();renderer.setFillEngine(previousEngine);}
  return rows;
};

window.__ready = true;
</script></body></html>`;

const TEXT_HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="256" height="128"></canvas>
<script type="module">
import { createRenderer, loadShaders, createTextBundle, MantleFontAsset }
  from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
renderer.setFrameCapture(true);   // export capture is opt-in (defaults off)
const FONT = new MantleFontAsset(Uint8Array.from(atob('${fontB64}'), c => c.charCodeAt(0)));
const STYLE = { fill: [0.1, 0.2, 0.7, 1], fontSizePx: 32 };

const tbKeep = await createTextBundle(gl, { font: FONT, text: 'Hi', style: STYLE, retainText: true });
const tbPlain = await createTextBundle(gl, { font: FONT, text: 'Hi', style: STYLE });

window.__hasSource = !!(tbKeep.bundle && tbKeep.bundle.textSource);
window.__plainNoSource = !(tbPlain.bundle && tbPlain.bundle.textSource);

const exportOf = async (tb, recoverText) => {
  renderer.setViewport(256, 128);
  renderer.beginFrame([1, 1, 1, 1]);
  renderer.drawBundle(tb.bundle, {});
  renderer.endFrame();
  return await renderer.exportFrameSVG({ recoverText, detail: true });
};
window.__keepGlyphs = () => exportOf(tbKeep, false);
window.__keepText   = () => exportOf(tbKeep, true);
window.__plainRecover = () => exportOf(tbPlain, true);

window.__parse = (svg) => {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  const text = root.querySelector('text');
  return {
    paths: root.querySelectorAll('path').length,
    hasText: !!text,
    textContent: text ? text.textContent : null,
    textFill: text ? text.getAttribute('fill') : null,
    textY: text ? text.getAttribute('y') : null,
    textSize: text ? text.getAttribute('font-size') : null,
  };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  if (req.url === '/text') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(TEXT_HTML);
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  const ct = p.endsWith('.glsl') ? 'text/plain' : 'text/javascript';
  try {
    res.writeHead(200, { 'content-type': ct + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

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
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('  [console]', m.text());
});
try {
  await openReady(page, `http://127.0.0.1:${port}/`, { ready: 'flag' });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

// (1) API surface.
if (await page.evaluate(() => window.__hasFn)) ok('renderer.exportFrameSVG exists');
else fail('exportFrameSVG not present');
if (await page.evaluate(() => window.__capDefaultOff))
  ok('frame capture OFF by default (export instrumentation is opt-in)');
else fail('frameCaptureEnabled should default to false');

const placements = await page.evaluate(() => window.__exportPlacement());
for (const row of placements) {
  if (
    row.max <= 1 &&
    row.checked > 100 &&
    row.ink > 0 &&
    row.skipped === 0 &&
    row.drawn === (row.mode === 'instances' ? 2 : 1)
  )
    ok('viewport export placement ' + JSON.stringify(row));
  else fail('viewport export placement ' + JSON.stringify(row));
}

// (2) Plain frame serializes to a parseable, non-empty <svg>.
const plain = await page.evaluate(async () => {
  const rep = await window.__exportPlain();
  return { rep, p: window.__parse(rep.svg) };
});
if (typeof plain.rep.svg === 'string' && plain.p.tag === 'svg' && plain.p.childCount > 0)
  ok('plain frame → parseable <svg> with ' + plain.p.childCount + ' elements');
else fail('plain export malformed: ' + JSON.stringify(plain.rep).slice(0, 200));
if (plain.rep.drawn === 1 && plain.rep.skipped === 0) ok('plain frame: drawn=1 skipped=0');
else
  fail('plain draw/skip counts: ' + JSON.stringify({ d: plain.rep.drawn, s: plain.rep.skipped }));

// (3) Overrides land in the markup: one hidden, one recolored.
const ovr = await page.evaluate(async () => {
  const svg = await window.__exportOverridden();
  return { svg, p: window.__parse(svg) };
});
if (ovr.p.hidden >= 1)
  ok('overridden frame hides the addressed shape (' + ovr.p.hidden + ' hidden)');
else fail('hidden-shape override did not land in markup');
if (ovr.p.hasGreenFill) ok('overridden frame carries the recolored fill');
else fail('recolor override fill not found in markup');

// (4) Morph reconstructs geometry on demand: t=0 vs t=0.5 differ.
const m = await page.evaluate(async () => {
  const a = await window.__exportMorph(0);
  const b = await window.__exportMorph(0.5);
  return { a, b };
});
if (m.a.drawn >= 1 && m.a.skipped === 0 && m.b.drawn >= 1 && m.b.skipped === 0)
  ok('morph frames export with no skipped draws');
else fail('morph export draw/skip: ' + JSON.stringify({ a: m.a, b: m.b }).slice(0, 200));
if (m.a.svg !== m.b.svg)
  ok('morph geometry differs between t=0 and t=0.5 (CPU rebuild at export time)');
else fail('morph export identical across t — geometry not reconstructed');

// (5) drawSprite subset export: only the sprite's shapes survive.
const sp = await page.evaluate(async () => {
  const full = window.__parse(await window.__exportSheetFull());
  const rep = await window.__exportSprite();
  return { fullHidden: full.hidden, rep, p: window.__parse(rep.svg) };
});
if (sp.fullHidden === 0 && sp.p.hidden >= 1 && sp.rep.drawn === 1 && sp.rep.skipped === 0)
  ok(
    'drawSprite exports the sprite subset (other sprite hidden: full=' +
      sp.fullHidden +
      ' sprite=' +
      sp.p.hidden +
      ')',
  );
else
  fail(
    'sprite-subset export wrong: ' +
      JSON.stringify({ full: sp.fullHidden, rep: sp.rep, hidden: sp.p.hidden }).slice(0, 200),
  );

// (6) Animated clipper export: the <clipPath> child carries the transform.
const clip = await page.evaluate(async () => {
  const svg = await window.__exportClipper();
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  // The transform lands on the clip element (clipPath or its child).
  const moved = [...doc.documentElement.querySelectorAll('*')].some((e) => {
    const t = e.getAttribute('transform') || '';
    return /translate\(\s*30\b/.test(t);
  });
  return { moved, hasClip: /clipPath/i.test(svg) };
});
if (clip.hasClip && clip.moved)
  ok('setClipper transform reproduced on the live <clipPath> (translate 30)');
else fail('animated clipper not reproduced in export: ' + JSON.stringify(clip));

// (7) Precondition: no-retainSource bundle is skipped + noted, not blank.
const ns = await page.evaluate(async () => await window.__exportNoSrc());
if (ns.skipped >= 1 && ns.drawn === 0 && ns.notes.some((n) => /svgSource|retainSource/i.test(n)))
  ok('bundle without retainSource is skipped + reported (not silently blank)');
else fail('no-retainSource handling wrong: ' + JSON.stringify(ns).slice(0, 200));

// ---- text bundles: glyph outlines by default, a real <text> with recoverText ----
if (FONT_PATH) {
  const textFailures = failures;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  let ready = true;
  try {
    await openReady(page, `http://127.0.0.1:${port}/text`, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    ready = false;
  }
  if (ready) {
    if (await page.evaluate(() => window.__hasSource))
      ok('createTextBundle({retainText}) attaches bundle.textSource');
    else fail('retainText did not attach textSource');
    if (await page.evaluate(() => window.__plainNoSource))
      ok('default createTextBundle leaves textSource unset');
    else fail('plain text bundle unexpectedly has textSource');

    // (1) Default export → synthesized glyph outlines, no <text>.
    const glyphs = await page.evaluate(async () => {
      const rep = await window.__keepGlyphs();
      return { rep, p: window.__parse(rep.svg) };
    });
    if (
      glyphs.rep.drawn === 1 &&
      glyphs.rep.skipped === 0 &&
      glyphs.p.paths >= 1 &&
      !glyphs.p.hasText
    )
      ok('default text export → ' + glyphs.p.paths + ' glyph <path>s (synthesized), no <text>');
    else
      fail(
        'glyph text export wrong: ' +
          JSON.stringify({ d: glyphs.rep.drawn, s: glyphs.rep.skipped, p: glyphs.p }).slice(0, 200),
      );

    // (2) recoverText → a real <text> with the original string, fill, baseline.
    const txt = await page.evaluate(async () => {
      const rep = await window.__keepText();
      return { rep, p: window.__parse(rep.svg) };
    });
    if (txt.p.hasText && txt.p.textContent === 'Hi')
      ok('recoverText emits <text> with the original string "Hi"');
    else fail('recovered <text> missing/incorrect string: ' + JSON.stringify(txt.p).slice(0, 200));
    if (txt.p.textFill === 'rgba(26,51,179,1)')
      ok('recovered <text> carries the original fill (rgba(26,51,179,1))');
    else fail('recovered <text> fill wrong: ' + txt.p.textFill);
    if (txt.p.textSize === '1' && txt.p.textY != null && Number.isFinite(parseFloat(txt.p.textY)))
      ok('recovered <text> uses em font-size + a finite baseline y=' + txt.p.textY);
    else fail('recovered <text> size/baseline wrong: size=' + txt.p.textSize + ' y=' + txt.p.textY);

    // (3) recoverText on a bundle WITHOUT retained text → glyph fallback.
    const fb = await page.evaluate(async () => {
      const rep = await window.__plainRecover();
      return { rep, p: window.__parse(rep.svg) };
    });
    if (fb.p.paths >= 1 && !fb.p.hasText && fb.rep.drawn === 1)
      ok('recoverText on a non-retained text bundle falls back to glyph outlines');
    else fail('glyph fallback wrong: ' + JSON.stringify({ rep: fb.rep, p: fb.p }).slice(0, 200));
  }
  await page.close();
  if (failures === textFailures) console.log('\\ntext export: all assertions passed');
}

await browser.close();
server.close();
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\\nexportFrameSvgSmoke: all assertions passed');
