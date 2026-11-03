// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// spriteSheetSmoke.mjs — sprite-sheet addressing proof.
// One SVG sheet with 3 addressable sprites at distinct x-positions:
//   #red   — top-level <g id> with 2 rects, left third   (x≈0..100)
//   #green — top-level <g id> with 1 rect,  middle third  (x≈100..200)
//   #blue  — lone id'd top-level <rect>,    right third   (x≈200..300)
// plus one UN-id'd top-level rect (not addressable).
//
// Asserts:
//   1. bundle.spriteRanges maps each id to the right meta-row range; the
//      un-id'd shape gets no entry.
//   2. drawSprite(id) renders only that sprite — its pixels present, the
//      OTHER sprites' pixels absent (subset clip works).
//   3. drawSprite output for a sprite == the matching region of a full
//      drawBundle (parity — the subset is a faithful slice).
//   4. drawSpriteInstanced stamps one sprite at N transforms (count + a
//      shifted copy lands where expected).
//   5. opts.sprites import filter keeps only listed sprites and SHRINKS
//      the bundle (numShapes drops; dropped sprites are gone, not hidden).
//   6. Unknown sprite id → drawSprite returns false (no throw).
//
// The sprite APIs built on the same kind of sheet, each on its own page in the same browser:
//
// SPRITE MORPH (page /morph): createSpriteMorph.
// One sheet with two morph-pose sprites that share per-shape topology so
// they actually curve-lerp (not just crossfade):
//   #poseA — a red rect on the left
//   #poseB — a blue rect on the right, same rect topology, different position
// Morphing poseA→poseB should slide/recolor the rect from A to B, rendering
// only the morphing sprite (the other sheet shapes hidden).
//
// Asserts:
//   1. createSpriteMorph builds from two sprites of the same sheet bundle
//      (src === dst) without self-matching (the headline same-bundle trap).
//   2. The morph renders only the sprite — non-sprite shapes are hidden.
//   3. setT(0) ≈ poseA, setT(1) ≈ poseB, setT(0.5) is between — geometry
//      interpolates, no GL error.
//   4. Cross-bundle morph (two separate sheets, same sprite id) also works.
//   5. Unknown sprite id throws; overlapping same-bundle ranges throw.
//
// MORPH CLIP (page /morph-clip).
// An animated clip must survive a sprite morph: composeMorphSections must
// forward bundle.clipperRows so overrides.setClipper() resolves on the
// morph bundle — otherwise an animated clipPath on a morphed (sprite)
// bundle silently stops moving.
//
// Fixture: a sheet whose 'win' sprite is a big orange rect clipped to a small
// window; 'plain' is the morph partner (same rect topology, no clip). After
// createSpriteMorph('win'→'plain'), assert:
//   1. The morph bundle FORWARDS clipperRows (the 'window' clip is present).
//   2. setClipper('window', …) returns true.
//   3. Moving the clip actually changes the rendered output (the orange
//      window shifts), proving the clip override reaches the shader.
//
// SPRITE TIMELINE (page /timeline): createSpriteTimeline.
// One sheet with three pose sprites of matched topology (a single rect that
// recolors + moves). A 3-key timeline plays poseA → poseB → poseC. Asserts:
//   1. setTime at each key time shows that key's pose (red / green / blue).
//   2. Between keys the active sprite interpolates (geometry + color).
//   3. The bracket morph is reused on the hot path (same bracket → no
//      rebuild) and rebuilds when crossing a key.
//   4. Clamping before key 0 / after key N holds the end pose.
//   5. dispose() runs clean (no GL error after).
//
// RANGE ROUTE (page /range-route): drawSprite must paint ONE sprite, on every fill route.
// drawSprite communicates the subset only by setting R.draw.shapeRange (drawSprites.js), so every
// fill route must read it: an analytic (Loop-Blinn) route that packs the whole drawList into one
// VBO without it paints the ENTIRE SHEET. Silent, because the usual usage draws every sprite in
// the sheet and the over-draw hides under identical content.
//
// Guards the invariant directly: draw ONE sprite from a multi-sprite sheet and require the inked
// bbox to match the Slug cover-quad route's. Runs LB 'on' AND 'off' so the two
// routes must agree, and asserts the ink stays inside the sprite's own column.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SHEET = readFileSync(
  new URL('../examples/smoke/spriteSheet__SHEET.svg', import.meta.url),
  'utf8',
);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="300" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const sheetSections = await importSvg(${JSON.stringify(SHEET)});
const bundle = createBundle(gl, sheetSections);
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
window.__ranges = bundle.spriteRanges;
window.__numShapes = bundle.numShapes;
window.__hasDrawSprite = typeof renderer.drawSprite === 'function';
window.__T = (s, tx, ty) => new Float32Array([s,0,0, 0,s,0, tx,ty,1]);
window.__full = () => {
  renderer.setViewport(300, 100); renderer.beginFrame([0,0,0,1]);
  renderer.drawBundle(bundle, { worldMatrix: id }); renderer.endFrame();
};
window.__sprite = (sid, opts) => {
  renderer.setViewport(300, 100); renderer.beginFrame([0,0,0,1]);
  const r = renderer.drawSprite(bundle, sid, opts || { worldMatrix: id }); renderer.endFrame();
  return r;
};
window.__spriteInst = (sid, instances, shared) => {
  renderer.setViewport(300, 100); renderer.beginFrame([0,0,0,1]);
  const n = renderer.drawSpriteInstanced(bundle, sid, instances, shared || {}); renderer.endFrame();
  return n;
};
// import-filter probe: returns the filtered bundle's shape count + ranges.
window.__filtered = async () => {
  const sec = await importSvg(${JSON.stringify(SHEET)}, { sprites: ['red', 'green'] });
  const b = createBundle(gl, sec);
  return { numShapes: b.numShapes, ranges: b.spriteRanges };
};
window.__sample = (x, yTop) => { const b = new Uint8Array(4); gl.readPixels(x, 100-1-yTop, 1,1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
window.__ready = true;
</script></body></html>`;

// The createSpriteMorph page.
const MORPH_HTML = (() => {
  // Two sprites, matched topology (both a single <rect>), different x + color.
  // A third un-id'd shape (green marker) must NOT appear in the morph.
  const SHEET = readFileSync(
    new URL('../examples/smoke/spriteMorph__SHEET.svg', import.meta.url),
    'utf8',
  );
  // A second sheet with the same sprite id 'poseA' (cross-bundle case).
  const SHEET2 = readFileSync(
    new URL('../examples/smoke/spriteMorph__SHEET2.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
  <canvas id="c" width="300" height="100"></canvas>
  <script type="module">
  import { importSvg, createBundle, createRenderer, loadShaders, createSpriteMorph } from '/src/index.js';
  const cnv = document.getElementById('c');
  const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
  const renderer = createRenderer(gl, shaders);
  const sheet  = createBundle(gl, await importSvg(${JSON.stringify(SHEET)}));
  const sheet2 = createBundle(gl, await importSvg(${JSON.stringify(SHEET2)}));
  const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
  window.__ranges = sheet.spriteRanges;
  window.__hasFn = typeof createSpriteMorph === 'function';

  // Same-bundle morph: poseA → poseB, both in sheet.
  let morph = null;
  window.__build = () => {
    morph = createSpriteMorph(gl, { bundle: sheet, sprite: 'poseA' }, { bundle: sheet, sprite: 'poseB' });
    return { numShapes: morph.bundle.numShapes,
             matched: morph.plan.matched.length,
             selfMatch: morph.plan.matched.some(m => m.srcIdx === m.dstIdx),
             hidden: morph.plan.hidden ? morph.plan.hidden.length : 0 };
  };
  window.__draw = (t) => {
    morph.setT(t);
    renderer.setViewport(300, 100);
    renderer.beginFrame([0,0,0,1]);
    renderer.drawBundle(morph.bundle, { worldMatrix: id, overrides: morph.overrides });
    renderer.endFrame();
  };
  window.__sample = (x, yTop) => { const b = new Uint8Array(4); gl.readPixels(x, 100-1-yTop, 1,1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
  window.__glErr = () => gl.getError();

  // Cross-bundle: sheet.poseA → sheet2.poseA.
  window.__buildCross = () => {
    const m = createSpriteMorph(gl, { bundle: sheet, sprite: 'poseA' }, { bundle: sheet2, sprite: 'poseA' });
    m.setT(0.5);
    const n = m.bundle.numShapes, matched = m.plan.matched.length;
    m.dispose();
    return { n, matched };
  };
  window.__throwsUnknown = () => { try { createSpriteMorph(gl, { bundle: sheet, sprite: 'nope' }, { bundle: sheet, sprite: 'poseB' }); return false; } catch { return true; } };
  window.__throwsOverlap = () => { try { createSpriteMorph(gl, { bundle: sheet, sprite: 'poseA' }, { bundle: sheet, sprite: 'poseA' }); return false; } catch { return true; } };
  window.__ready = true;
  </script></body></html>`;

  return HTML;
})();

// The an animated clip survives a sprite morph page.
const MORPH_CLIP_HTML = (() => {
  // 'win' = orange rect clipped to a 20×20 window at (40,40). 'plain' = a
  // matching rect (morph partner). The clipPath layer rows are appended after
  // the visible shapes (outside any sprite range) — exactly the case that
  // exercises the forwarded-clipperRows path.
  const SHEET = readFileSync(
    new URL('../examples/smoke/spriteMorphClip__SHEET.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
  <canvas id="c" width="100" height="100"></canvas>
  <script type="module">
  import { importSvg, createBundle, createRenderer, loadShaders, createSpriteMorph } from '/src/index.js';
  const cnv = document.getElementById('c');
  const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
  const renderer = createRenderer(gl, shaders);
  const sheet = createBundle(gl, await importSvg(${JSON.stringify(SHEET)}));
  const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
  window.__sheetClippers = Object.keys(sheet.clipperRows || {});

  // Morph the clipped sprite against the plain one, pinned at t=0 (fully 'win').
  const morph = createSpriteMorph(gl, { bundle: sheet, sprite: 'win' }, { bundle: sheet, sprite: 'plain' });
  morph.setT(0);
  window.__morphClippers = Object.keys(morph.bundle.clipperRows || {});

  window.__draw = () => {
    renderer.setViewport(100, 100);
    renderer.beginFrame([0,0,0,1]);
    renderer.drawBundle(morph.bundle, { worldMatrix: id, overrides: morph.overrides });
    renderer.endFrame();
  };
  window.__setClip = (dx, dy) => morph.overrides.setClipper('window', { localPosition: [dx, dy] });
  window.__sample = (x, yTop) => { const b = new Uint8Array(4); gl.readPixels(x, 100-1-yTop, 1,1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
  window.__ready = true;
  </script></body></html>`;

  return HTML;
})();

// The createSpriteTimeline page.
const TIMELINE_HTML = (() => {
  // Three poses, each a single rect (matched topology), at distinct x + color.
  const SHEET = readFileSync(
    new URL('../examples/smoke/spriteTimeline__SHEET.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
  <canvas id="c" width="300" height="100"></canvas>
  <script type="module">
  import { importSvg, createBundle, createRenderer, loadShaders, createSpriteTimeline } from '/src/index.js';
  const cnv = document.getElementById('c');
  const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
  const renderer = createRenderer(gl, shaders);
  const sheet = createBundle(gl, await importSvg(${JSON.stringify(SHEET)}));
  const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
  window.__hasFn = typeof createSpriteTimeline === 'function';

  const tl = createSpriteTimeline(gl,
    [ { bundle: sheet, sprite: 'a' },
      { bundle: sheet, sprite: 'b' },
      { bundle: sheet, sprite: 'c' } ],
    [ { time: 0.0, refIndex: 0 },
      { time: 1.0, refIndex: 1 },
      { time: 2.0, refIndex: 2 } ]);
  window.__duration = tl.duration;
  window.__draw = (time) => {
    tl.setTime(time);
    renderer.setViewport(300, 100);
    renderer.beginFrame([0,0,0,1]);
    renderer.drawBundle(tl.bundle, { worldMatrix: id, overrides: tl.currentMorph ? tl.currentMorph.overrides : null });
    renderer.endFrame();
  };
  window.__morphId = () => tl.currentMorph;   // identity check for hot-path reuse
  window.__sample = (x, yTop) => { const b = new Uint8Array(4); gl.readPixels(x, 100-1-yTop, 1,1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
  window.__glErr = () => gl.getError();
  // scan for the dominant color + its x position
  window.__scan = () => {
    let best = { x:-1, ch:'.', v:0 };
    for (let x = 0; x < 300; x += 4) {
      const p = window.__sample(x, 50);
      const m = Math.max(p[0], p[1], p[2]);
      if (m > best.v && m > 100) { best = { x, ch: p[0]===m?'R':p[1]===m?'G':'B', v:m, rgb:[p[0],p[1],p[2]] }; }
    }
    return best;
  };
  window.__disposeAndErr = () => { tl.dispose(); return gl.getError(); };
  window.__ready = true;
  </script></body></html>`;

  return HTML;
})();

// The range-route page: four curved sprites in four columns.
const RANGE_ROUTE_HTML = (() => {
  // 4 sprites in 4 well-separated columns. Curved (cubic) so the LB route genuinely engages.
  const N = 256;
  const blob = (cx, cy, r, fill) =>
    `<path fill="${fill}" d="M ${cx - r} ${cy} C ${cx - r} ${cy - r * 1.3} ${cx + r} ${cy - r * 1.3} ${cx + r} ${cy} C ${cx + r} ${cy + r * 1.3} ${cx - r} ${cy + r * 1.3} ${cx - r} ${cy} Z"/>`;
  const SHEET =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">` +
    [0, 1, 2, 3].map((i) => `<g id="s${i}">${blob(32 + i * 64, 128, 24, '#3366cc')}</g>`).join('') +
    `</svg>`;

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
  <script type="module">
  import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
  const gl = document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
  const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
  const r = createRenderer(gl, shaders, {}); r.setViewport(${N}, ${N});
  const sheet = createBundle(gl, await importSvg(${JSON.stringify(SHEET)}, { preserveViewport: true }));
  r.prepareBundle && r.prepareBundle(sheet);
  if (r.awaitLbReady) await r.awaitLbReady(sheet);

  // Inked bbox + pixel count of one drawn sprite.
  const measure = () => {
    const px = new Uint8Array(${N} * ${N} * 4);
    gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let ink = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) {
      const o = (y * ${N} + x) * 4;
      if (px[o] < 200 || px[o+1] < 200 || px[o+2] < 200) {   // anything not white
        ink++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return ink ? { ink, x0, x1, y0, y1 } : { ink: 0, x0: -1, x1: -1, y0: -1, y1: -1 };
  };
  const one = (mode, id) => {
    r.setLoopBlinnFill(mode);
    r.beginFrame([1,1,1,1]); r.drawSprite(sheet, id, {}); r.endFrame();
    return measure();
  };
  const out = {};
  for (const id of ['s0', 's2']) { out[id + '_slug'] = one('off', id); out[id + '_lb'] = one('on', id); }
  // Reference: the WHOLE sheet, so a test that accidentally draws everything is detectable.
  r.setLoopBlinnFill('off');
  r.beginFrame([1,1,1,1]); r.drawBundle(sheet, {}); r.endFrame();
  out.whole = measure();
  window.__out = out; window.__ready = true;
  </script></body></html>`;

  return HTML;
})();
const PAGES = {
  '/morph': MORPH_HTML,
  '/morph-clip': MORPH_CLIP_HTML,
  '/timeline': TIMELINE_HTML,
  '/range-route': RANGE_ROUTE_HTML,
};

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  if (PAGES[req.url]) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGES[req.url]);
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
  const t = m.text();
  if (/Mantle\]/.test(t)) console.log('  [page]', t);
});
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000, polling: 100 });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

if (await page.evaluate(() => window.__hasDrawSprite)) ok('renderer.drawSprite exists');
else fail('drawSprite not exported');

// (1) spriteRanges map.
const ranges = await page.evaluate(() => window.__ranges);
const ns = await page.evaluate(() => window.__numShapes);
if (ranges && ranges.red && ranges.green && ranges.blue)
  ok('spriteRanges has red/green/blue: ' + JSON.stringify(ranges));
else fail('spriteRanges missing ids: ' + JSON.stringify(ranges));
if (ranges && ranges.red && ranges.red[0] === 0 && ranges.red[1] === 1)
  ok('red maps to its 2 shapes [0,1]');
else fail('red range wrong: ' + JSON.stringify(ranges && ranges.red));
if (ranges && Object.keys(ranges).length === 3)
  ok('un-id top-level shape is NOT addressable (3 sprites total)');
else fail('unexpected sprite count: ' + Object.keys(ranges || {}).length);

// Establish the full-render colors at each sprite's center.
const fullCols = await page.evaluate(() => {
  window.__full();
  return {
    red: window.__sample(50, 30),
    green: window.__sample(150, 50),
    blue: window.__sample(250, 50),
  };
});
if (fullCols.red[0] > 180 && fullCols.green[1] > 180 && fullCols.blue[2] > 180)
  ok('full render: red|green|blue at their thirds');
else fail('full render colors wrong: ' + JSON.stringify(fullCols));

// (2)+(3) drawSprite isolates each sprite + matches the full-render region.
for (const [sid, cx, cy, chan] of [
  ['red', 50, 30, 0],
  ['green', 150, 50, 1],
  ['blue', 250, 50, 2],
]) {
  const r = await page.evaluate(
    (sid, cx, cy) => {
      const drew = window.__sprite(sid);
      return { drew, self: window.__sample(cx, cy) };
    },
    sid,
    cx,
    cy,
  );
  if (r.drew) ok('drawSprite("' + sid + '") drew');
  else fail('drawSprite("' + sid + '") returned false');
  if (r.self[chan] > 180)
    ok('  ' + sid + ': its own pixels present (chan ' + chan + '=' + r.self[chan] + ')');
  else fail('  ' + sid + ': own pixels missing: ' + r.self);
}
// Cross-absence: after drawing only green, red & blue regions are background.
const greenOnly = await page.evaluate(() => {
  window.__sprite('green');
  return {
    red: window.__sample(50, 30),
    green: window.__sample(150, 50),
    blue: window.__sample(250, 50),
  };
});
if (greenOnly.green[1] > 180 && greenOnly.red[0] < 40 && greenOnly.blue[2] < 40)
  ok('drawSprite("green") isolates green — red & blue regions are empty (subset clip works)');
else fail('green isolation failed: ' + JSON.stringify(greenOnly));

// Parity: drawSprite("blue") center == full-render blue center.
const par = await page.evaluate(() => {
  window.__full();
  const full = window.__sample(250, 50);
  window.__sprite('blue');
  const sub = window.__sample(250, 50);
  return { full, sub };
});
const pdmax = Math.max(...[0, 1, 2, 3].map((k) => Math.abs(par.full[k] - par.sub[k])));
if (pdmax <= 2) ok('drawSprite parity: blue subset == full-render blue (Δ=' + pdmax + ')');
else fail('subset ≠ full region: full=' + par.full + ' sub=' + par.sub);

// (4) drawSpriteInstanced: 2 copies of blue, one shifted left. Verify the
// instance count, that the origin copy is present, and that a shifted copy
// puts blue somewhere LEFT of the original (exact landing depends on the
// clip→pixel fit, so scan the left half rather than guess a pixel).
const inst = await page.evaluate(() => {
  const n = window.__spriteInst('blue', [
    { worldMatrix: window.__T(1, 0, 0) },
    { worldMatrix: window.__T(1, -0.6, 0) }, // shift left
  ]);
  let blueLeft = false;
  for (let x = 0; x < 230; x += 8) {
    const p = window.__sample(x, 50);
    if (p[2] > 150 && p[0] < 80) {
      blueLeft = true;
      break;
    }
  }
  return { n, orig: window.__sample(250, 50), blueLeft };
});
if (inst.n === 2) ok('drawSpriteInstanced drew 2 instances');
else fail('instance count: ' + inst.n);
if (inst.orig[2] > 150) ok('  instanced sprite present at origin');
else fail('  origin instance missing: ' + inst.orig);
if (inst.blueLeft) ok('  shifted instance moved blue into the left half');
else fail('  shifted instance not found left of origin');

// (5) import filter shrinks the bundle.
const filt = await page.evaluate(() => window.__filtered());
if (filt.numShapes < ns)
  ok('opts.sprites filter shrank bundle: ' + filt.numShapes + ' < ' + ns + ' shapes');
else fail('filter did not shrink bundle: ' + filt.numShapes + ' vs ' + ns);
if (filt.ranges.red && filt.ranges.green && !filt.ranges.blue)
  ok('  filtered bundle keeps red+green, drops blue entirely');
else fail('  filter kept wrong sprites: ' + JSON.stringify(filt.ranges));

// (6) unknown id → false.
const unk = await page.evaluate(() => window.__sprite('nope'));
if (unk === false) ok('unknown sprite id → drawSprite returns false');
else fail('unknown id returned: ' + unk);

if (failures === 0) console.log('\nSPRITE-SHEET PASS');
else console.log(`\nSPRITE-SHEET FAIL (${failures})`);

// ---- createSpriteMorph ----
{
  const before = failures;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (/Mantle\]/.test(t)) console.log('  [page]', t);
  });
  let ready = true;
  try {
    await openReady(page, `http://127.0.0.1:${port}/morph`, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    ready = false;
  }
  if (ready) {
    if (await page.evaluate(() => window.__hasFn)) ok('createSpriteMorph exported');
    else fail('createSpriteMorph not exported');

    const ranges = await page.evaluate(() => window.__ranges);
    if (ranges && ranges.poseA && ranges.poseB)
      ok('sheet has poseA + poseB sprites: ' + JSON.stringify(ranges));
    else fail('sheet sprite ranges wrong: ' + JSON.stringify(ranges));

    // (1) build, same-bundle, no self-match.
    const b = await page.evaluate(() => window.__build());
    if (b.matched >= 1) ok("morph matched the two sprites' rects (" + b.matched + ' matched)');
    else fail('no matched shapes: ' + JSON.stringify(b));
    if (!b.selfMatch) ok('no self-match (src===dst handled — sprite A matched B, not itself)');
    else fail('a shape matched ITSELF (same-bundle trap)');
    if (b.hidden >= 1) ok('non-sprite shapes hidden (' + b.hidden + ' rows forced invisible)');
    else fail('no hidden shapes — whole sheet would render: ' + JSON.stringify(b));

    // (2)+(3) interpolation: at t=0 red rect at poseA (x≈50); at t=1 blue at poseB (x≈250); mid between.
    const r0 = await page.evaluate(() => {
      window.__draw(0);
      return {
        a: window.__sample(50, 50),
        b: window.__sample(250, 50),
        marker: window.__sample(150, 50),
        err: window.__glErr(),
      };
    });
    if (r0.err === 0) ok('setT(0) no GL error');
    else fail('GL error at t=0: ' + r0.err);
    if (r0.a[0] > 180 && r0.a[2] < 80) ok('t=0: red rect at poseA position');
    else fail('t=0 poseA wrong: ' + r0.a);
    if (r0.marker[1] < 120)
      ok('t=0: un-id\\u2019d green marker NOT rendered (only the sprite morphs)');
    else fail('foreign marker rendered: ' + r0.marker);

    const r1 = await page.evaluate(() => {
      window.__draw(1);
      return { a: window.__sample(50, 50), b: window.__sample(250, 50), err: window.__glErr() };
    });
    if (r1.err === 0) ok('setT(1) no GL error');
    else fail('GL error at t=1: ' + r1.err);
    if (r1.b[2] > 180 && r1.b[0] < 80)
      ok('t=1: blue rect at poseB position (geometry + color morphed across)');
    else fail('t=1 poseB wrong: ' + r1.b);
    if (r1.a[0] < 120) ok('t=1: rect no longer at poseA (it moved)');
    else fail('t=1 still red at poseA: ' + r1.a);

    const rMid = await page.evaluate(() => {
      window.__draw(0.5);
      return {
        mid: window.__sample(150, 50),
        a: window.__sample(50, 50),
        b: window.__sample(250, 50),
        err: window.__glErr(),
      };
    });
    if (rMid.err === 0) ok('setT(0.5) no GL error');
    else fail('GL error at t=0.5: ' + rMid.err);
    // At t=0.5 the rect sits at the MIDDLE (x≈150), color halfway red↔blue
    // (purple), and the two end positions are background. Geometry + color
    // both interpolated.
    const isPurple = (p) => p[0] > 60 && p[2] > 60 && p[1] < 80;
    const isBg = (p) => p[0] < 60 && p[2] < 60;
    if (isPurple(rMid.mid))
      ok('t=0.5: rect at the midpoint, color halfway red↔blue (' + rMid.mid + ')');
    else fail('t=0.5 midpoint not interpolated: ' + rMid.mid);
    if (isBg(rMid.a) && isBg(rMid.b))
      ok('t=0.5: the two end positions are empty (rect genuinely moved to the middle)');
    else fail('t=0.5 ends not empty: a=' + rMid.a + ' b=' + rMid.b);

    // (4) cross-bundle.
    const cross = await page.evaluate(() => window.__buildCross());
    if (cross.matched >= 1) ok('cross-bundle morph (two sheets, same sprite id) matched + built');
    else fail('cross-bundle morph failed: ' + JSON.stringify(cross));

    // (5) error cases.
    if (await page.evaluate(() => window.__throwsUnknown())) ok('unknown sprite id throws');
    else fail('unknown id did not throw');
    if (await page.evaluate(() => window.__throwsOverlap()))
      ok('overlapping same-bundle ranges throw');
    else fail('overlap did not throw');
  }
  await page.close();
  const n = failures - before;
  if (n === 0) console.log('\nSPRITE-MORPH PASS');
  else console.log(`\nSPRITE-MORPH FAIL (${n})`);
}

// ---- an animated clip survives a sprite morph ----
{
  const before = failures;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  let ready = true;
  try {
    await openReady(page, `http://127.0.0.1:${port}/morph-clip`, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    ready = false;
  }
  if (ready) {
    // Sanity: the sheet has the 'window' clip.
    const sheetClips = await page.evaluate(() => window.__sheetClippers);
    if (sheetClips.includes('window')) ok('sheet exposes clipperRows.window');
    else fail('sheet missing window clip: ' + JSON.stringify(sheetClips));

    // (1) The morph bundle FORWARDS clipperRows.
    const morphClips = await page.evaluate(() => window.__morphClippers);
    if (morphClips.includes('window')) ok('morph bundle forwarded clipperRows.window (fix)');
    else
      fail(
        'morph bundle dropped clipperRows: ' +
          JSON.stringify(morphClips) +
          ' — animated clip would silently stop',
      );

    // (2) setClipper returns true on the morph bundle.
    const ret = await page.evaluate(() => window.__setClip(0, 0));
    if (ret === true) ok('setClipper("window") returns true on the morph bundle');
    else fail('setClipper returned ' + ret + ' (clip not resolvable)');

    // (3) Moving the clip visibly shifts the orange window. Baseline window at
    // (40..60); a probe inside it is orange, outside is background. Shift the
    // clip +25 in x → the probe that was inside is now outside (and vice versa).
    const r = await page.evaluate(() => {
      window.__setClip(0, 0);
      window.__draw();
      const at50 = window.__sample(50, 50); // inside the un-moved window → orange
      const at80 = window.__sample(80, 50); // outside → background
      window.__setClip(25, 0);
      window.__draw(); // shift window right by 25 (em)
      const at50b = window.__sample(50, 50); // now outside the moved window
      const at80b = window.__sample(80, 50); // now inside → orange
      return { at50, at80, at50b, at80b };
    });
    const isOrange = (p) => p[0] > 180 && p[1] > 60 && p[1] < 160 && p[2] < 60;
    const isBg = (p) => p[0] < 60 && p[1] < 60 && p[2] < 60;
    if (isOrange(r.at50) && isBg(r.at80)) ok('baseline: orange window at x=50, background at x=80');
    else fail('baseline clip wrong: at50=' + r.at50 + ' at80=' + r.at80);
    if (isBg(r.at50b) && isOrange(r.at80b))
      ok('clip moved: window shifted to x=80 (clip override reaches the shader)');
    else fail('clip did NOT move: at50=' + r.at50b + ' at80=' + r.at80b);
  }
  await page.close();
  const n = failures - before;
  if (n === 0) console.log('\nSPRITE-MORPH-CLIP PASS');
  else console.log(`\nSPRITE-MORPH-CLIP FAIL (${n})`);
}

// ---- createSpriteTimeline ----
{
  const before = failures;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (/Mantle\]/.test(t)) console.log('  [page]', t);
  });
  let ready = true;
  try {
    await openReady(page, `http://127.0.0.1:${port}/timeline`, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    ready = false;
  }
  if (ready) {
    if (await page.evaluate(() => window.__hasFn)) ok('createSpriteTimeline exported');
    else fail('createSpriteTimeline not exported');
    if ((await page.evaluate(() => window.__duration)) === 2.0)
      ok('duration = 2.0 (last key - first key)');
    else fail('duration wrong: ' + (await page.evaluate(() => window.__duration)));

    // (1) key times → each pose. (Hold at exact key times: lo===hi.)
    const ka = await page.evaluate(() => {
      window.__draw(0.0);
      return window.__scan();
    });
    if (ka.ch === 'R') ok('t=0.0: pose A (red) at x=' + ka.x);
    else fail('t=0.0 not red: ' + JSON.stringify(ka));
    const kb = await page.evaluate(() => {
      window.__draw(1.0);
      return window.__scan();
    });
    if (kb.ch === 'G') ok('t=1.0: pose B (green) at x=' + kb.x);
    else fail('t=1.0 not green: ' + JSON.stringify(kb));
    const kc = await page.evaluate(() => {
      window.__draw(2.0);
      return window.__scan();
    });
    if (kc.ch === 'B') ok('t=2.0: pose C (blue) at x=' + kc.x);
    else fail('t=2.0 not blue: ' + JSON.stringify(kc));

    // position ordering: A left of B left of C.
    if (ka.x < kb.x && kb.x < kc.x)
      ok(
        'poses advance left→right across the timeline (' + ka.x + ' < ' + kb.x + ' < ' + kc.x + ')',
      );
    else fail('pose positions not ordered: ' + ka.x + ',' + kb.x + ',' + kc.x);

    // (2) between keys: t=0.5 blends A→B (rect between them, color red↔green).
    const mid = await page.evaluate(() => {
      window.__draw(0.5);
      return window.__scan();
    });
    if (mid.x > ka.x && mid.x < kb.x) ok('t=0.5: active sprite between A and B (x=' + mid.x + ')');
    else fail('t=0.5 not between A,B: ' + JSON.stringify(mid));

    // (3) hot-path reuse: two times in the same bracket → same morph object;
    // crossing a key → different morph object.
    const reuse = await page.evaluate(() => {
      window.__draw(0.3);
      const m1 = window.__morphId();
      window.__draw(0.7);
      const m2 = window.__morphId(); // same bracket [0,1]
      window.__draw(1.5);
      const m3 = window.__morphId(); // bracket [1,2]
      return { sameBracket: m1 === m2, crossedBracket: m2 !== m3 };
    });
    if (reuse.sameBracket) ok('same bracket reuses the morph (no rebuild on hot path)');
    else fail('morph rebuilt within one bracket');
    if (reuse.crossedBracket) ok('crossing a key rebuilds the morph for the new bracket');
    else fail('morph not rebuilt across keys');

    // (4) clamp before/after.
    const before = await page.evaluate(() => {
      window.__draw(-1);
      return window.__scan();
    });
    if (before.ch === 'R') ok('t<0 clamps to pose A (red)');
    else fail('clamp-before wrong: ' + JSON.stringify(before));
    const after = await page.evaluate(() => {
      window.__draw(99);
      return window.__scan();
    });
    if (after.ch === 'B') ok('t>duration clamps to pose C (blue)');
    else fail('clamp-after wrong: ' + JSON.stringify(after));

    // (5) dispose clean.
    const derr = await page.evaluate(() => window.__disposeAndErr());
    if (derr === 0) ok('dispose() ran clean (no GL error)');
    else fail('GL error after dispose: ' + derr);
  }
  await page.close();
  const n = failures - before;
  if (n === 0) console.log('\nSPRITE-TIMELINE PASS');
  else console.log(`\nSPRITE-TIMELINE FAIL (${n})`);
}

// ---- a sprite subset paints one sprite on the LB route too, not the whole sheet ----
{
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[page-err]', e.message));
  let ready = true;
  try {
    await openReady(page, `http://127.0.0.1:${port}/range-route`, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    ready = false;
  }
  if (ready) {
    const out = await page.evaluate(() => window.__out);

    let fail = 0;
    const bb = (o) => `ink=${o.ink} bbox=[${o.x0},${o.x1}]x[${o.y0},${o.y1}]`;
    console.log('  whole sheet (reference):', bb(out.whole));
    for (const id of ['s0', 's2']) {
      const s = out[id + '_slug'],
        l = out[id + '_lb'];
      console.log(`  ${id}: slug ${bb(s)}`);
      console.log(`  ${id}: lb   ${bb(l)}`);
      // The LB route must paint the same sprite the Slug route does — not the whole sheet.
      if (l.ink === 0) {
        console.log(`FAIL ${id}: LB drew nothing`);
        fail++;
        continue;
      }
      const wideningX = l.x1 - l.x0 - (s.x1 - s.x0);
      if (wideningX > 4) {
        console.log(
          `FAIL ${id}: LB ink spans ${l.x1 - l.x0}px vs Slug ${s.x1 - s.x0}px — LB is painting beyond the sprite`,
        );
        fail++;
      } else if (Math.abs(l.ink - s.ink) > Math.max(40, s.ink * 0.15)) {
        console.log(`FAIL ${id}: LB ink ${l.ink} vs Slug ${s.ink} — routes disagree`);
        fail++;
      } else {
        console.log(`ok ${id}: LB matches Slug (one sprite, not the sheet)`);
      }
    }
    failures += fail;
    if (fail) console.log(`\nSPRITE-RANGE-ROUTE FAIL (${fail})`);
    else console.log('\nSPRITE-RANGE-ROUTE PASS');
  }
  await page.close();
}

await browser.close();
server.close();
process.exit(failures ? 1 : 0);
