// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// tableLayoutSmoke -- per-item texture tables (meta, gradient, dash, filter, override, mask row) wrap in 4096-row
// bands instead of growing one row per item past MAX_TEXTURE_SIZE.
//  1. a table of <= 4096 rows keeps exactly the single-band `cols x n` layout (byte-identical for everything that fits one band);
//  2. a taller one maps every (row, col) to a distinct texel inside `cols * bands x 4096`, and uploadTableRows / packTable agree
//     with that map;
//  3. the GLSL helpers (_bundleLayout.glsl) are the same map as tableTexel, and no shader fetches those samplers with a raw ivec2;
//  4. checkTableFits names the table, the count and the limit.
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  TAB_H,
  META_COLS,
  GRAD_COLS,
  DASH_COLS,
  FILTER_COLS,
  OVERRIDE_COLS,
  MRL_COLS,
  tableDims,
  tableTexel,
  tableCapacity,
  checkTableFits,
  checkPlaneFits,
  packTable,
  uploadTableRows,
  maxTextureSize,
  maxArrayLayers,
} from '../src/renderer/tableLayout.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const TABLES = {
  meta: META_COLS,
  grad: GRAD_COLS,
  dash: DASH_COLS,
  filter: FILTER_COLS,
  override: OVERRIDE_COLS,
  mrl: MRL_COLS,
};

// 1. <= 4096 rows: the single-band layout.
for (const [name, cols] of Object.entries(TABLES)) {
  for (const n of [0, 1, 2, 100, 4095, 4096]) {
    const d = tableDims(cols, n);
    ok(
      d.w === cols && d.h === Math.max(1, n) && d.bands === 1,
      `${name}: ${n} rows is ${cols} x ${Math.max(1, n)} as before`,
    );
  }
  for (const r of [0, 1, 17, 4095]) {
    const [x, y] = tableTexel(cols, 3 % cols, r);
    ok(x === 3 % cols && y === r, `${name}: row ${r} < 4096 sits at (col, row) as before`);
  }
}

// 2. > 4096 rows: bijective, in range, uploads agree.
class StubGl {
  constructor(w, h) {
    this.TEXTURE_2D = 3553;
    this.RGBA = 6408;
    this.FLOAT = 5126;
    this.w = w;
    this.h = h;
    this.px = new Float32Array(w * h * 4).fill(-1);
    this.calls = 0;
  }
  texSubImage2D(_t, _l, x, y, w, h, _f, _ty, src) {
    this.calls++;
    if (x + w > this.w || y + h > this.h || x < 0 || y < 0)
      throw new Error(`texSubImage2D out of range (${x},${y},${w},${h}) vs ${this.w}x${this.h}`);
    for (let j = 0; j < h; j++)
      this.px.set(src.subarray(j * w * 4, (j + 1) * w * 4), ((y + j) * this.w + x) * 4);
  }
}
for (const [name, cols] of Object.entries(TABLES)) {
  for (const n of [4097, 8192, 8193, 20000]) {
    const d = tableDims(cols, n);
    ok(
      d.h === TAB_H && d.w === cols * Math.ceil(n / TAB_H),
      `${name}: ${n} rows is ${d.w} x ${d.h}`,
    );
    const data = new Float32Array(n * cols * 4);
    for (let i = 0; i < data.length; i++) data[i] = i + 1;
    const gl = new StubGl(d.w, d.h);
    let threw = null;
    try {
      uploadTableRows(gl, cols, 0, n - 1, data);
    } catch (e) {
      threw = e;
    }
    ok(
      !threw,
      `${name} ${n}: uploadTableRows stays inside the texture (${threw ? threw.message : gl.calls + ' calls'})`,
    );
    let bad = 0;
    for (let r = 0; r < n && bad < 5; r += r < 4200 || r > n - 80 ? 1 : 97)
      for (let c = 0; c < cols; c++) {
        const [x, y] = tableTexel(cols, c, r);
        const at = (y * d.w + x) * 4,
          src = (r * cols + c) * 4;
        if (gl.px[at] !== data[src] || gl.px[at + 3] !== data[src + 3]) bad++;
      }
    ok(bad === 0, `${name} ${n}: every texel read by tableTexel holds the table's value`);
    const packed = packTable(data, cols, n);
    let same = packed.length === gl.px.length;
    for (let i = 0; same && i < packed.length; i++)
      if (packed[i] !== gl.px[i] && gl.px[i] !== -1) same = false;
    ok(same, `${name} ${n}: packTable is the uploaded plane`);
    // partial spans (the dirty band of an override table, a streamed meta span) cross the band edge
    const gl2 = new StubGl(d.w, d.h);
    const lo = TAB_H - 3,
      hi = Math.min(n - 1, TAB_H + 2);
    uploadTableRows(gl2, cols, lo, hi, data.subarray(lo * cols * 4, (hi + 1) * cols * 4));
    let part = true;
    for (let r = lo; r <= hi; r++) {
      const [x, y] = tableTexel(cols, 0, r);
      if (gl2.px[(y * d.w + x) * 4] !== data[r * cols * 4]) part = false;
    }
    ok(part, `${name} ${n}: a span across the band edge lands row by row`);
  }
}
{
  // unique texels
  const seen = new Set();
  let dup = 0;
  for (let r = 0; r < 20000; r++)
    for (let c = 0; c < META_COLS; c++) {
      const [x, y] = tableTexel(META_COLS, c, r);
      const k = y * 100000 + x;
      if (seen.has(k)) dup++;
      seen.add(k);
    }
  ok(dup === 0, 'meta: 20000 rows x 12 texels map to 240000 distinct texels');
}

// 3. the GLSL helpers are this map; no raw fetches.
const SH = path.join(ROOT, 'src', 'shaders');
const layout = readFileSync(path.join(SH, '_bundleLayout.glsl'), 'utf8');
const helperOf = {
  metaAt: META_COLS,
  gradAt: GRAD_COLS,
  dashAt: DASH_COLS,
  filterAt: FILTER_COLS,
  ovAt: OVERRIDE_COLS,
  mrlAt: MRL_COLS,
};
for (const [fn, cols] of Object.entries(helperOf)) {
  const m = layout.match(
    new RegExp(`ivec2 ${fn}\\(int c, int r\\)\\s*\\{ return ivec2\\((.+?), (.+?)\\); \\}`),
  );
  ok(!!m, `${fn} is defined in _bundleLayout.glsl`);
  if (!m) continue;
  const f = new Function('c', 'r', `return [${m[1]}, ${m[2]}];`);
  let same = true;
  for (const r of [0, 1, 4095, 4096, 4097, 8191, 8192, 12345, 40000, 1000000])
    for (const c of [0, 1, cols - 1]) {
      const a = f(c, r),
        b = tableTexel(cols, c, r);
      if (a[0] !== b[0] || a[1] !== b[1]) same = false;
    }
  ok(same, `${fn}(c, r) is tableTexel(${cols}, c, r)`);
}
const sampler = {
  uMetaTex: 'metaAt',
  uGradientTex: 'gradAt',
  uDashTex: 'dashAt',
  uFilterTex: 'filterAt',
  uOverrideTex: 'ovAt',
  uMaskRowToLayerTex: 'mrlAt',
  uMaskRowToLayerTexBake: 'mrlAt',
};
let raw = [],
  wrong = [],
  seenFetch = 0;
for (const f of readdirSync(SH).filter((x) => x.endsWith('.glsl'))) {
  const src = readFileSync(path.join(SH, f), 'utf8').split('\n');
  src.forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    for (const m of line.matchAll(/texelFetch\(\s*(u\w+)\s*,\s*(\w+)\(/g)) {
      if (!(m[1] in sampler)) continue;
      seenFetch++;
      if (m[2] === 'ivec2') raw.push(`${f}:${i + 1}`);
      else if (m[2] !== sampler[m[1]]) wrong.push(`${f}:${i + 1} ${m[1]} via ${m[2]}`);
    }
    if (
      /textureSize\(\s*uMetaTex/.test(line) &&
      !/metaRowsOf\(textureSize\(uMetaTex, 0\)\)/.test(line)
    )
      raw.push(`${f}:${i + 1} textureSize(uMetaTex).y`);
  });
}
ok(seenFetch > 150, `${seenFetch} table fetches scanned`);
ok(raw.length === 0, `no raw ivec2 fetch of a wrapped table (${raw.slice(0, 5).join(', ')})`);
ok(
  wrong.length === 0,
  `each table is fetched through its own helper (${wrong.slice(0, 5).join(', ')})`,
);

// 4. the hard check.
const gl16 = { MAX_TEXTURE_SIZE: 3379, getParameter: (p) => (p === 3379 ? 16384 : null) };
const glAt = (lim) => ({ MAX_TEXTURE_SIZE: 3379, getParameter: (p) => (p === 3379 ? lim : null) });
ok(
  maxTextureSize(gl16) === 16384 && maxTextureSize({}) === 16384,
  'maxTextureSize reads the device limit (16384 for a stub)',
);
ok(
  tableCapacity(META_COLS, 4096) === 4096 * 341 && tableCapacity(DASH_COLS, 16384) === 4096 * 1024,
  'capacity = 4096 rows x floor(limit / cols) bands',
);
const thrown = (f) => {
  try {
    f();
    return null;
  } catch (e) {
    return String(e.message);
  }
};
checkTableFits(glAt(4096), 'meta (shape) table', META_COLS, 40000);
let msg = thrown(() => checkTableFits(glAt(4096), 'dash table', DASH_COLS, 1048577));
ok(
  msg && /dash table/.test(msg) && /1048577/.test(msg) && /4096/.test(msg) && /1048576/.test(msg),
  `an over-capacity table throws naming table, count and limit (${msg})`,
);
msg = thrown(() => checkTableFits(glAt(2048), 'meta (shape) table', META_COLS, 10));
ok(
  msg && /MAX_TEXTURE_SIZE is 2048/.test(msg),
  `a device below 4096 throws instead of failing at upload (${msg})`,
);
msg = thrown(() => checkPlaneFits(glAt(4096), 'image atlas', 4096, 5000));
ok(
  msg && /image atlas/.test(msg) && /5000/.test(msg),
  `a plane taller than the device limit throws (${msg})`,
);

// 5. A layer limit is read from the context once: Safari answers each MAX_ARRAY_TEXTURE_LAYERS read with a round trip to the GPU process
// (1.6 ms), and every bundle handle checks it.
let layerReads = 0;
const glLayers = {
  MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
  getParameter: (p) => (p === 0x88ff ? (layerReads++, 2048) : null),
};
const layers = [maxArrayLayers(glLayers), maxArrayLayers(glLayers), maxArrayLayers(glLayers)];
ok(
  layers.every((v) => v === 2048) && layerReads === 1,
  `maxArrayLayers reads the context once (${layerReads} reads)`,
);
ok(maxArrayLayers({}) === 256, 'maxArrayLayers is 256 for a stub');

if (fail) {
  console.log('\nTABLE-LAYOUT FAIL');
  process.exit(1);
}
console.log('\nTABLE-LAYOUT PASS');
