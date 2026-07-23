// groupRectSmoke.mjs — a group must paint the same whether or not we bound it.
//
// A group cost THREE full-canvas operations, every group, every frame: snapshot the whole
// canvas as its backdrop, clear the whole accumulator, composite the whole accumulator
// back. For a group covering a corner of the screen all three were almost entirely wasted,
// and all three scale with the canvas — the same shape as the fullscreen problem.
//
// They are now bounded by the group's CONTENT RECT: the union of what its children paint,
// expanded by whatever their filters and strokes reach. Which means a rect that is too
// small silently drops a group's pixels on the floor. So: render a small group in the
// corner of a big canvas both ways, and require them to be identical.
//
// The same three passes are paid by a BLENDED LEAF (mix-blend-mode), which takes its own
// offscreen route — and by a blended leaf INSIDE a group, which composites against the
// group's local backdrop instead of the canvas. Both are covered here.
//
// The group must also be doing something VISIBLE (an opacity < 1 that actually shows the
// backdrop through it), or two blank corners would agree and prove nothing.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  const m = p.endsWith('.html') ? 'text/html'
    : (p.endsWith('.js') || p.endsWith('.mjs')) ? 'text/javascript'
    : p.endsWith('.glsl') ? 'text/plain' : 'application/octet-stream';
  let body;
  try { body = readFileSync(path.join(ROOT, p)); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': m + '; charset=utf-8' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/mantleDemo.html`;

// A big backdrop, and a SMALL translucent group off in one corner — the case the rect is
// for, and the case a too-small rect would ruin. The group's children include a stroked
// shape and a filtered one, because both reach beyond their own bbox.
const SCENE = readFileSync(new URL('../examples/smoke/groupRect__SCENE.svg', import.meta.url), 'utf8');

let failures = 0;
const fail = (m) => { failures++; console.error('FAIL', m); };
const ok = (m) => console.log('ok', m);

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 500, height: 500 });
page.on('pageerror', e => console.error('  [page-err]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 20000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 20000 });

const res = await page.evaluate(async (svg) => {
  const { importSvg, createBundle } = await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');
  // A BIG canvas: the group occupies a small fraction of it, which is exactly when the
  // full-canvas passes were waste and exactly when a bad rect clips.
  const W = 900, H = 900;
  cnv.width = W; cnv.height = H;

  globalThis.__MANTLE_DEBUG__ = true;
  let ops = { groups: 0, blends: 0 };
  const draw = async (noRect) => {
    globalThis.__MANTLE_NO_GROUP_RECT = noRect ? true : undefined;
    const b = createBundle(gl, await importSvg(svg));
    ops = { groups: (b.drawList || []).filter(o => o.kind === 'groupBegin').length,
            blends: (b.drawList || []).filter(o => o.kind === 'fillShape' && o.blendMode).length };
    const h = renderer.createBundleHandle(b);
    renderer.beginFrame([1, 1, 1, 1]);
    h.draw({});
    renderer.endFrame();
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    h.dispose(); b.dispose();
    return px;
  };

  const full = await draw(true);    // full-canvas group passes (the old behaviour)
  const rect = await draw(false);   // bounded to the group's content rect

  let diff = 0, worst = 0;
  for (let i = 0; i < full.length; i += 4) {
    const d = Math.max(Math.abs(full[i] - rect[i]), Math.abs(full[i + 1] - rect[i + 1]),
                       Math.abs(full[i + 2] - rect[i + 2]), Math.abs(full[i + 3] - rect[i + 3]));
    if (d > 0) diff++;
    if (d > worst) worst = d;
  }
  // Is the group actually THERE and actually translucent? Its children sit in the upper
  // right of the viewBox → upper-right of the canvas in GL (y up = top).
  let groupInk = 0;
  for (let y = Math.floor(H * 0.62); y < H; y++) {
    for (let x = Math.floor(W * 0.6); x < W; x++) {
      const i = (y * W + x) * 4;
      // The slab backdrop is #3d566e; anything else in that corner is the group.
      if (Math.abs(rect[i] - 0x3d) > 12 || Math.abs(rect[i + 1] - 0x56) > 12 || Math.abs(rect[i + 2] - 0x6e) > 12) groupInk++;
    }
  }
  return { diff, worst, groupInk, total: W * H, ops };
}, SCENE);

console.log(`  ops: ${res.ops.groups} groups, ${res.ops.blends} blended leaves   `
          + `group ink ${res.groupInk}px   full-canvas vs rect: ${res.diff}px differ (worst ${res.worst})`);

// The offscreen routes have to actually be TAKEN, or this compares two identical
// fast-path renders and proves nothing about the code it claims to cover.
if (res.ops.groups < 2) {
  fail(`only ${res.ops.groups} groupBegin ops — the fixture is not exercising the group route`);
} else {
  ok(`the group route is taken (${res.ops.groups} groups)`);
}
if (res.ops.blends < 2) {
  fail(`only ${res.ops.blends} blended leaves — mix-blend-mode did not survive the import, so `
     + `the blend route (four full-canvas passes per shape) is NOT covered here`);
} else {
  ok(`the per-leaf blend route is taken (${res.ops.blends} blended shapes)`);
}

if (res.groupInk < 2000) {
  fail(`the group barely rendered (${res.groupInk}px) — two blank corners would agree, so `
     + `the comparison below would prove nothing`);
} else {
  ok(`the group renders (${res.groupInk}px in its corner)`);
}
if (res.diff > 0) {
  fail(`bounding the group to its content rect changed ${res.diff}px (worst ${res.worst}). `
     + `The rect is the union of what the group's children paint, INCLUDING what their `
     + `strokes and filters reach beyond their own bbox — if it is short, the group's `
     + `pixels are dropped.`);
} else {
  ok('the bounded group is byte-identical to the full-canvas one (0px differ)');
}

await browser.close();
server.close();
console.log(failures ? `\nFAILURES: ${failures}` : '\nGROUP-RECT PASS');
process.exit(failures ? 1 : 0);
