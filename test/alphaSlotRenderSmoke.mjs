// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// alphaSlotRenderSmoke -- faded instances that touch, each in a slot of its own and drawn together (renderer.js R._alphaSlotBatch), paint
// what the layered accumulators paint (record-level proofs: test/groupAtlasSmoke.mjs (M)).
//
// Each cell draws one bundle as 64 (or fewer) instances at alpha below 1 on a 128 px canvas in balanced arms OFF, ON, OFF, ON
// (OFF = the layers, the debug flag __MANTLE_NO_ALPHA_SLOTS; the first OFF is a throwaway that compiles everything). The two OFF arms are the
// A/A control. The ON arms must match the OFF arms within 1/255 on every channel, must actually have taken the slot path
// (debugStats.alphaSlotBatches grew), and must not be blank.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { writeFileSync, mkdirSync } from 'fs';
function png(px, w, h) {
  const crcT = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcT[n] = c;
  }
  const crc = (b) => {
    let c = -1;
    for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (t, d) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    px.copy(raw, y * (w * 4 + 1) + 1, (h - 1 - y) * w * 4, (h - y) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// SLOT_PNG=dir writes the ON, OFF and amplified difference pictures of every cell that differs, to look at them
const savePngs = (dir, name, on, off) => {
  mkdirSync(dir, { recursive: true });
  const top = (px) => Buffer.from(px);
  const diff = new Uint8Array(on.length);
  for (let i = 0; i < on.length; i += 4) {
    const d = Math.min(
      255,
      3 *
        Math.max(
          Math.abs(on[i] - off[i]),
          Math.abs(on[i + 1] - off[i + 1]),
          Math.abs(on[i + 2] - off[i + 2]),
        ),
    );
    diff[i] = d;
    diff[i + 1] = d;
    diff[i + 2] = d;
    diff[i + 3] = 255;
  }
  const base = path.join(dir, name.replace(/[^a-z0-9]+/gi, '_'));
  writeFileSync(base + '.on.png', png(top(on), 128, 128));
  writeFileSync(base + '.off.png', png(top(off), 128, 128));
  writeFileSync(base + '.diff.png', png(top(diff), 128, 128));
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${body}</svg>`;
const TWO = doc(
  '<rect x="4" y="4" width="28" height="28" fill="#e04020"/><rect x="16" y="16" width="28" height="28" fill="#2040c0"/>',
);
const PAUSE = doc(
  '<circle cx="24" cy="24" r="21" fill="#32A8EA" stroke="#FFFFFF" stroke-width="3"/><rect x="15" y="14" width="6" height="20" rx="1.5" fill="#FFFFFF" stroke="#9B9B9B" stroke-width="1.5"/><rect x="27" y="14" width="6" height="20" rx="1.5" fill="#FFFFFF" stroke="#9B9B9B" stroke-width="1.5"/>',
);
const CURVY = doc(
  '<path d="M6 40 C6 8 42 8 42 40 Z" fill="#0a8" stroke="#a20" stroke-width="3"/><circle cx="24" cy="30" r="8" fill="#fc0"/>',
);
// instance sets: a function of the canvas to the instance list (clip-space matrices [m00 m10 0 m01 m11 0 tx ty 1])
const grid =
  (k, alphaOf, extra = () => ({}), n = 64) =>
  () =>
    Array.from({ length: n }, (_, i) => {
      const g = Math.ceil(Math.sqrt(n)),
        s = 2 / g,
        m = [s * k, 0, 0, 0, s * k, 0, -1 + s * ((i % g) + 0.5), 1 - s * (((i / g) | 0) + 0.5), 1];
      return { worldMatrix: m, alpha: alphaOf(i), ...extra(i) };
    });
const rot = (a, s, tx, ty) => [
  s * Math.cos(a),
  s * Math.sin(a),
  0,
  -s * Math.sin(a),
  s * Math.cos(a),
  0,
  tx,
  ty,
  1,
];
const CELLS = [
  { name: 'two-rect icon, 8 x 8 grid overlapping, alpha .5', svg: TWO, inst: grid(0.9, () => 0.5) },
  {
    name: 'fill+stroke icon, grid overlapping, mixed alphas',
    svg: PAUSE,
    inst: grid(0.9, (i) => 0.25 + 0.5 * (i % 2)),
  },
  {
    name: 'curvy fill+stroke, grid overlapping, per-instance tint',
    svg: CURVY,
    inst: grid(
      0.9,
      () => 0.6,
      (i) => ({ tint: [1, 1 - (i % 4) * 0.2, 1, 1] }),
    ),
  },
  {
    name: 'rotated and skewed instances',
    svg: PAUSE,
    inst: () =>
      Array.from({ length: 24 }, (_, i) => ({
        worldMatrix: rot(
          i * 0.4,
          0.35 + 0.01 * i,
          -0.8 + 0.15 * (i % 12),
          -0.5 + 0.9 * ((i / 12) | 0),
        ),
        alpha: 0.5,
      })),
  },
  {
    name: 'instances hanging off the canvas',
    svg: TWO,
    inst: () =>
      Array.from({ length: 16 }, (_, i) => ({
        worldMatrix: [0.5, 0, 0, 0, 0.5, 0, -1.1 + 0.3 * (i % 8), 0.9 - 0.8 * ((i / 8) | 0), 1],
        alpha: 0.5,
      })),
  },
  {
    name: 'many large instances (more than one atlas block)',
    svg: PAUSE,
    inst: grid(
      1.6,
      () => 0.4,
      () => ({}),
      100,
    ),
  },
  {
    name: 'tiny instances, tight grid',
    svg: TWO,
    inst: grid(
      1.3,
      () => 0.5,
      () => ({}),
      256,
    ),
  },
];
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
globalThis.__MANTLE_DEBUG__ = true;
window.__render = async (source, instList, route, arms) => {
  gl.canvas.width = 128; gl.canvas.height = 128; R.setViewport(128, 128);
  R.setFillEngine({ route, kernel: 'slug' });
  const out = [];
  for (const off of arms) {
    globalThis.__MANTLE_NO_ALPHA_SLOTS = off;
    const b = createBundle(gl, await importSvg(source, { preserveViewport: true }));
    const insts = instList.map((x) => ({ ...x, worldMatrix: new Float32Array(x.worldMatrix) }));
    const s0 = R.debugStats.alphaSlotBatches | 0;
    let px = [], err = '';
    try {
      const draw = () => { R.beginFrame([1, 1, 1, 1]); R.drawBundleInstanced(b, insts); R.endFrame(); };
      const warmed = await R.warmScene([{ draw }], { maxPasses: 16, fenceTimeoutMs: 60000 });
      if (!warmed.complete) throw Error('did not finish warming');
      draw();
      const buf = new Uint8Array(128 * 128 * 4);
      gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      if (gl.getError() !== gl.NO_ERROR) throw Error('GL error');
      px = Array.from(buf);
    } catch (e) { err = String(e && e.message || e); }
    out.push({ px, err, off, batches: (R.debugStats.alphaSlotBatches | 0) - s0 }); b.dispose();
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
    res.end(readFileSync(path.join(ROOT, p)));
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
for (const c of CELLS)
  for (const route of ['none']) {
    const tag = `${c.name} [${route}]`;
    let r;
    try {
      r = await page.evaluate(
        (s, i, rt, arms) => window.__render(s, i, rt, arms),
        c.svg,
        c.inst(),
        route,
        [true, true, false, true, false],
      );
    } catch (e) {
      fail(tag + ': ' + e.message);
      continue;
    }
    r.shift();
    if (r.some((a) => a.err)) {
      fail(
        tag +
          ': error in arms [' +
          r.map((a) => (a.off ? 'OFF' : 'ON') + (a.err ? ':' + a.err : ':ok')).join(', ') +
          ']',
      );
      continue;
    }
    const [off1, on1, off2, on2] = r;
    const floor = maxDiff(off1.px, off2.px),
      d = Math.max(maxDiff(off1.px, on1.px), maxDiff(off2.px, on2.px), maxDiff(off1.px, on2.px));
    const line = `${tag}: A/A floor ${floor}, ON vs OFF ${d}, slot batches on ${on1.batches}/${on2.batches} off ${off1.batches}/${off2.batches}, ink ${ink(on1.px)} vs ${ink(off1.px)}`;
    if (off1.batches || off2.batches) fail(line + ' -- the OFF arm took the slot path');
    else if (!(on1.batches > 0 && on2.batches > 0))
      fail(line + ' -- vacuous: the ON arm never took the slot path');
    else if (ink(on1.px) < 100) fail(line + ' -- blank');
    else if (d > Math.max(1, floor)) {
      // where: the differing pixels' count and box, and a few samples (top-down pixel coordinates)
      let n = 0,
        x0 = 1e9,
        y0 = 1e9,
        x1 = -1,
        y1 = -1;
      const samples = [];
      for (let i = 0; i < on1.px.length; i += 4) {
        const dd = Math.max(
          Math.abs(on1.px[i] - off1.px[i]),
          Math.abs(on1.px[i + 1] - off1.px[i + 1]),
          Math.abs(on1.px[i + 2] - off1.px[i + 2]),
          Math.abs(on1.px[i + 3] - off1.px[i + 3]),
        );
        if (dd > 1) {
          const p = i / 4,
            x = p % 128,
            y = 127 - Math.floor(p / 128);
          n++;
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
          if (samples.length < 6 && n % 37 === 1)
            samples.push(
              `(${x},${y}) on [${on1.px.slice(i, i + 4)}] off [${off1.px.slice(i, i + 4)}]`,
            );
        }
      }
      if (process.env.SLOT_PNG) savePngs(process.env.SLOT_PNG, c.name, on1.px, off1.px);
      fail(
        line +
          ` -- the slotted instances draw differently: ${n} px differ by more than 1, in x ${x0}..${x1}, y ${y0}..${y1}; ${samples.join('; ')}`,
      );
    } else ok(line);
  }
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nalphaSlotRenderSmoke: faded instances in slots match the layered accumulators');
