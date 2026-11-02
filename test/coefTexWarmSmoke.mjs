// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// coefTexWarmSmoke — the CPatch renderer has no coefficient-texture warm-up, and no switch for one.
//
// WHY. A warm-up -- create, upload and delete one RGBA32F coefficient block texture of full size at renderer
// construction -- moves nothing on a GPU: the first frame does not change, because the first-renderer cost is
// the first COMPILE of each shader source, which stays slow for the program's life, not the page's first large
// allocation. A switch that ships off is not kept, so neither the warm-up nor `globalThis.__MANTLE_COEF_WARM`
// exists.
//
// WHAT this PINS, on the real renderer over test/_fakeWebgl2.mjs with every texture call counted:
//   * no source under src/ reads `__MANTLE_COEF_WARM` or defines the warm-up;
//   * `__MANTLE_COEF_WARM` set to anything such a switch would take (`true`, `'8x8'`, `'256x4096'`) changes
//     nothing: the same texture creations, uploads (sizes included), deletions and draws as unset,
//     through construction and a CPatch frame;
//   * and the frame is really CPatch, so the comparison is not two empty logs.
// A tree with the warm-up FAILS: `true` allocates, uploads and deletes an extra 256 x 2432 texture at
// construction, and the source scan finds the switch.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
import { makeFakeWebgl2 } from './_fakeWebgl2.mjs';
import { importSvg, createBundle, createRenderer } from '../src/index.js';
import { SHADER_FILENAMES } from '../src/shaders/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const shaders = {};
for (const [k, f] of SHADER_FILENAMES) {
  try {
    shaders[k] = readFileSync(path.join(ROOT, 'src/shaders/generated', f), 'utf8');
  } catch {
    /* optional program */
  }
}

// A cubic star: CPatch converts it (no primitive), in node serially.
const K = 5,
  N = 128;
let d = '';
for (let j = 0; j <= 2 * K; j++) {
  const a = (Math.PI * j) / K,
    r = j % 2 ? 22 : 60,
    x = (100 + r * Math.cos(a)).toFixed(3),
    y = (100 + r * Math.sin(a)).toFixed(3);
  d += j ? ` L${x} ${y}` : `M${x} ${y}`;
}
const SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#234" d="${d} Z"/>` +
  '<path fill="#a42" d="M40 150 C60 110 140 190 160 150 C140 190 60 190 40 150 Z"/></svg>';

/// One renderer's life on a fake context, every texture call recorded: construction, then CPatch frames.
async function life(flag) {
  const prev = globalThis.__MANTLE_COEF_WARM;
  if (flag === undefined) delete globalThis.__MANTLE_COEF_WARM;
  else globalThis.__MANTLE_COEF_WARM = flag;
  try {
    const { gl, log } = makeFakeWebgl2(N, N);
    const calls = [];
    for (const name of ['createTexture', 'deleteTexture', 'texImage2D', 'texSubImage2D']) {
      const f = gl[name].bind(gl);
      gl[name] = (...a) => {
        if (name === 'texImage2D')
          calls.push([name, a[2], a[3], a[4], a[7], a[8] ? a[8].length : null]);
        else if (name === 'texSubImage2D') calls.push([name, a[4], a[5]]);
        else calls.push([name]);
        return f(...a);
      };
    }
    const R = createRenderer(gl, shaders, { cpatchFill: true, aacFill: false });
    if (R.ready) await R.ready;
    const b = createBundle(gl, await importSvg(SVG));
    let drew = 0;
    for (let i = 0; i < 12 && !drew; i++) {
      R.prepareBundle(b);
      const before = ((R.debugStats.engines || {}).draws || {}).cpatch | 0;
      R.setViewport(N, N);
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(b);
      R.endFrame();
      drew = (((R.debugStats.engines || {}).draws || {}).cpatch | 0) - before;
    }
    const draws = log.filter((e) => e.op === 'draw').map((e) => e.count);
    return {
      calls: JSON.stringify(calls),
      draws: JSON.stringify(draws),
      drew,
      nTex: calls.filter((c) => c[0] === 'createTexture').length,
    };
  } finally {
    if (prev === undefined) delete globalThis.__MANTLE_COEF_WARM;
    else globalThis.__MANTLE_COEF_WARM = prev;
  }
}

// No code reads the switch or defines the lever (a comment naming it is not code).
const { readdirSync, statSync } = await import('fs');
const hits = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const q = path.join(dir, f);
    if (statSync(q).isDirectory()) {
      walk(q);
      continue;
    }
    if (!/\.(m?js|glsl)$/.test(f)) continue;
    const code = readFileSync(q, 'utf8')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    if (/__MANTLE_COEF_WARM|_warmCoefTex|_coefWarm/.test(code)) hits.push(path.relative(ROOT, q));
  }
})(path.join(ROOT, 'src'));
ok(
  hits.length === 0,
  `no source reads __MANTLE_COEF_WARM or defines the warm-up${hits.length ? ' -- found in ' + hits.join(', ') : ''}`,
);
const base = await life(undefined);
ok(
  base.drew > 0,
  `the frame is CPatch (${base.drew} CPatch draw(s), ${base.nTex} textures created)`,
);
for (const v of [true, '8x8', '256x4096']) {
  const got = await life(v);
  ok(
    got.calls === base.calls && got.draws === base.draws,
    `__MANTLE_COEF_WARM = ${JSON.stringify(v)} changes nothing: the same ${got.nTex} texture creations, uploads, deletions and draws as unset`,
  );
}

console.log(fail ? `coefTexWarmSmoke FAIL (${fail})` : 'coefTexWarmSmoke PASS');
process.exit(fail ? 1 : 0);
