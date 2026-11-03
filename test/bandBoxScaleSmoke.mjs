// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bandBoxScaleSmoke — the box a shape's bands divide is formed the same way, with no absolute floor, by all three of its
// readers: the encoder (textures.js buildTexturesShape), the shaders (_coverage.glsl bandBoxSize: Slug's fillLinear and
// strokeMinDist, AAC, band-hard) and the CPU port (hitTest/bandWinding.js).
//
// Flooring each extent at an absolute 1e-6 em would band a shape under 1e-6 across -- a glyph drawn at 2^-20, anything
// at 2^-40 -- over a box larger than itself: every segment would land in the first stripes and the layout would differ
// from scale 1's. So a zero extent borrows the other, a point uses 1, and nothing else is floored.
//
// Three glyph-sized shapes (a holed cubic glyph, a curved blob, a thin bar), imported as authored and inside
// scale(2^-20) and scale(2^-40):
//   (a) the band plane is scale 1's up to scale: every integer (counts, offsets, locations) equal, every coordinate
//       (break and far bounds) scale 1's times the scale exactly;
//   (b) the CPU port's coverage at every pixel center is scale 1's;
//   (c) through the float32 emulation of the shader, Slug's renderFill, AAC and band-hard read every pixel center as at 1;
//   (d) mutations adding the 1e-6 floor to each reader, each caught.
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, cpSync, rmSync, mkdtempSync } from 'fs';
import { hasCxx, buildGlslEmu, fillShapes, K_AAC, K_HARD, K_SLUG, AAC_HARD } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// Glyph-sized shapes, 0.6 units across or less -- under 1e-6 em at 2^-20 -- seen through a fine pixel grid (D pixels per
// unit), so each is ~75 pixels across. No arcs: the importer rebuilds an arc's center form at a scale to within a
// rounding, which is not what this smoke is about.
const D = 128;
const BODY = `<path fill-rule="evenodd" d="M0.1 0.05 C 0.45 0 0.62 0.2 0.55 0.4 Q 0.5 0.62 0.3 0.6 L 0.08 0.55 Z M0.2 0.2 L 0.4 0.25 L 0.3 0.45 Z"/>
  <path d="M0.8 0.1 C 1.2 0.02 1.35 0.3 1.2 0.5 Q 1.05 0.66 0.9 0.5 Q 0.62 0.3 0.8 0.1 Z"/>
  <path d="M0.1 0.8 H 1.3 V 0.83 H 0.1 Z"/>`;
const svgAt = (S) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${1.4 * S} ${1 * S}"><g transform="scale(${S})">${BODY}</g></svg>`;
const LOGS = [-20, -40];

async function importAt(importSvg, S) {
  const b = await importSvg(svgAt(S), { preserveViewport: true });
  return {
    b,
    shapes: fillShapes(b, parseMetaBin, M),
    band: new Float32Array(b.bands),
    curve: new Float32Array(b.curves),
  };
}
function planeDiff(A, B, S) {
  if (A.band.length !== B.band.length)
    return `band plane ${A.band.length} vs ${B.band.length} floats`;
  let n = 0;
  for (let i = 0; i < A.band.length; i++)
    if (A.band[i] !== B.band[i] && Math.fround(A.band[i] * S) !== B.band[i]) n++;
  return n ? `${n} band floats neither equal nor scaled` : null;
}
// pixel centers of a grid of pixels S / D em across (the scale-1 grid, scaled with the art)
function pixels(X, S) {
  const q = [],
    p = S / D;
  for (const sh of X.shapes)
    for (let y = Math.floor(sh.bb[1] / p) - 1; y <= Math.ceil(sh.bb[3] / p) + 1; y++)
      for (let x = Math.floor(sh.bb[0] / p) - 1; x <= Math.ceil(sh.bb[2] / p) + 1; x++)
        q.push({
          GD: sh.GD,
          bb: sh.bb,
          eo: sh.eo,
          c: [Math.fround((x + 0.5) * p), Math.fround((y + 0.5) * p)],
          ePx: [p, p],
        });
  return q;
}
function portDiff(bw, A, B, S) {
  const qa = pixels(A, 1),
    qb = pixels(B, S);
  if (qa.length !== qb.length) return -1;
  let n = 0;
  for (let i = 0; i < qa.length; i++) {
    const a = bw.bandFillCoverage(
      A.band,
      A.curve,
      qa[i].GD,
      qa[i].bb,
      qa[i].c[0],
      qa[i].c[1],
      1 / qa[i].ePx[0],
      1 / qa[i].ePx[1],
      qa[i].eo,
    );
    const b = bw.bandFillCoverage(
      B.band,
      B.curve,
      qb[i].GD,
      qb[i].bb,
      qb[i].c[0],
      qb[i].c[1],
      1 / qb[i].ePx[0],
      1 / qb[i].ePx[1],
      qb[i].eo,
    );
    if (a !== b) n++;
  }
  return n;
}
function shaderDiff(glsl, A, B, S) {
  const out = [];
  const emu = buildGlslEmu(ROOT, { defines: AAC_HARD, glsl });
  const qa = pixels(A, 1),
    qb = pixels(B, S);
  for (const k of [K_SLUG, K_AAC, K_HARD]) {
    const ra = emu.run(
        A.band,
        A.curve,
        qa.map((q) => ({ ...q, k })),
      ),
      rb = emu.run(
        B.band,
        B.curve,
        qb.map((q) => ({ ...q, k })),
      );
    out.push(ra.reduce((n, v, i) => n + (v !== rb[i] ? 1 : 0), 0));
  }
  return out;
}
async function run(importSvg, bw, glsl) {
  const base = await importAt(importSvg, 1),
    r = { plane: [], port: [], shader: [], px: pixels(base, 1).length };
  for (const lg of LOGS) {
    const S = Math.pow(2, lg),
      X = await importAt(importSvg, S);
    r.plane.push(planeDiff(base, X, S));
    r.port.push(portDiff(bw, base, X, S));
    if (hasCxx()) r.shader.push(shaderDiff(glsl, base, X, S));
  }
  return r;
}
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const BW_SRC = readFileSync(path.join(ROOT, 'src/hitTest/bandWinding.js'), 'utf8');
const loadBw = (src) =>
  import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { default: importSvg } = await import('../src/svg/importer.js');
const cur = await run(importSvg, await loadBw(BW_SRC), GLSL);
ok(cur.px > 10000, `three shapes, ${cur.px} pixel centers`);
LOGS.forEach((lg, i) => {
  ok(
    cur.plane[i] === null,
    `(a) at 2^${lg} the band plane is scale 1's up to scale${cur.plane[i] ? ` (${cur.plane[i]})` : ''}`,
  );
  ok(
    cur.port[i] === 0,
    `(b) at 2^${lg} the CPU port reads every pixel center as at 1 (${cur.port[i]} differ)`,
  );
  if (hasCxx())
    ok(
      cur.shader[i].every((n) => n === 0),
      `(c) at 2^${lg} Slug, AAC and band-hard read every pixel center as at 1 (differing: ${cur.shader[i].join(' / ')})`,
    );
});
if (!hasCxx()) console.log('  SKIP (c): no C++ compiler');
// ---- (d) --------------------------------------------------------------------------------------------------------------
{
  const shaderFrom = 'vec2 bbSize = bandBoxSize(shapeBB);',
    shaderTo = 'vec2 bbSize = max(shapeBB.zw - shapeBB.xy, vec2(1e-6));';
  if (!GLSL.includes(shaderFrom)) ok(false, '(d) mutation hinge present: the shader');
  else if (hasCxx()) {
    const m = await run(importSvg, await loadBw(BW_SRC), GLSL.split(shaderFrom).join(shaderTo));
    const s = m.shader.flat().reduce((a, v) => a + v, 0);
    ok(
      s > 0,
      `(d) the shader's 1e-6 floor restored is caught (${m.shader.map((x) => x.join('/')).join(' ; ')})`,
    );
  }
  const portFrom =
    'const bbw = ew > 0 ? ew : (eh > 0 ? eh : 1), bbh = eh > 0 ? eh : (ew > 0 ? ew : 1);';
  if (!BW_SRC.includes(portFrom)) ok(false, '(d) mutation hinge present: the port');
  else {
    const m = await run(
      importSvg,
      await loadBw(
        BW_SRC.split(portFrom).join('const bbw = Math.max(ew, 1e-6), bbh = Math.max(eh, 1e-6);'),
      ),
      GLSL,
    );
    ok(
      m.port.some((n) => n !== 0),
      `(d) the port's 1e-6 floor restored is caught (${m.port.join(' / ')} pixels differ)`,
    );
  }
  const TEX = readFileSync(path.join(ROOT, 'src/svg/textures.js'), 'utf8');
  const encFrom = `  const bbW = bandExtW > 0 ? bandExtW : (bandExtH > 0 ? bandExtH : 1);
  const bbH = bandExtH > 0 ? bandExtH : (bandExtW > 0 ? bandExtW : 1);`;
  if (!TEX.includes(encFrom)) ok(false, '(d) mutation hinge present: the encoder');
  else {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'bandBoxScale-'));
    try {
      cpSync(path.join(ROOT, 'src'), path.join(tmp, 'src'), { recursive: true });
      writeFileSync(
        path.join(tmp, 'src/svg/textures.js'),
        TEX.split(encFrom).join(
          '  const bbW = Math.max(bandExtW, 1e-6), bbH = Math.max(bandExtH, 1e-6);',
        ),
      );
      const m = await run(
        (await import(path.join(tmp, 'src/svg/importer.js'))).default,
        await loadBw(BW_SRC),
        GLSL,
      );
      ok(
        m.plane.some((d) => d !== null),
        `(d) the encoder's 1e-6 floor restored is caught (${m.plane.map((d) => d ?? 'same').join(' / ')})`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

if (fail) {
  console.error(`BAND-BOX-SCALE FAIL (${fail})`);
  process.exit(1);
}
console.log('BAND-BOX-SCALE PASS');
