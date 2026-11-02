// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gwnTreeBoxScaleSmoke — the GWN run tree's occupancy grid and tier-2 bands divide the same box in the encoder and the
// kernel, at every size.
//
// The encoder builds the grid and the bands (textures.js, the run tree's bbW / bbH) and the kernel looks a pixel up
// (renderFillGWNSDF's bbSz and bandH) over the same box. ABSOLUTE floors would make them disagree: with max(extent, 1e-9)
// in one and max(extent, 1e-6) in the other, a shape under 1e-6 across -- a glyph drawn at 2^-20, anything at 2^-40 --
// finds its cell in a different box from the one it was built in, and takes another cell's certified winding (whole
// regions flipped). Both form the box with gwnBoxSize: a zero extent borrows the other, a point uses 1, and nothing else
// is floored.
//
//   (a) import: a star with 24 pieces (tier-2 bands), a circle, an even-odd ring, a thin horizontal bar and a cubic
//       blob, each imported as authored and inside scale(2^-40), scale(2^-20) and scale(2^20): the grid dimensions and
//       band count are the same at every size, and every grid cell's winding at 2^-20 and 2^20;
//   (b) kernel, through the float32 emulation of the shader with the early exits ON: GWN winding-only and GWN + SDF
//       read every pixel center the same at 2^-40, 2^-20, 2^20 and 2^40 as at 1 (data scaled exactly);
//   (c) mutations: 1e-6 floors put into the kernel (grid, then bands) are each caught by (b);
//   (d) the encoder forms the box as the kernel does (text: the encoder is JS and (a) runs it; this pins the form).
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import {
  hasCxx,
  buildGlslEmu,
  fillShapes,
  scaleFillData,
  K_GWN,
  GWN_SDF,
  GWN_WIND,
} from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const star = (cx, cy, R, r, n) => {
  let d = '';
  for (let i = 0; i < 2 * n; i++) {
    const a = (Math.PI * i) / n,
      rr = i % 2 ? r : R;
    d += `${i ? 'L' : 'M'}${(cx + rr * Math.cos(a)).toFixed(3)} ${(cy + rr * Math.sin(a)).toFixed(3)} `;
  }
  return d + 'Z';
};
const BODY = `<path d="${star(60.3, 60.2, 55.1, 30.7, 12)}"/>
  <path d="M180.2 60.3 m -50.1 0 a 50.1 50.1 0 1 0 100.2 0 a 50.1 50.1 0 1 0 -100.2 0 Z"/>
  <path fill-rule="evenodd" d="M300.4 60.1 m -55.2 0 a 55.2 55.2 0 1 0 110.4 0 a 55.2 55.2 0 1 0 -110.4 0 Z M300.4 60.1 m -25.3 0 a 25.3 25.3 0 1 0 50.6 0 a 25.3 25.3 0 1 0 -50.6 0 Z"/>
  <path d="M10.1 130.2 H 350.3 V 131.4 H 10.1 Z"/>
  <path d="M20.2 150.3 C 120.4 140.1 160.7 230.2 90.3 215.4 C 40.1 205.2 -10.3 180.4 20.2 150.3 Z"/>`;
const svgAt = (S) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${360 * S} ${240 * S}"><g transform="scale(${S})">${BODY}</g></svg>`;

// ---- (a) --------------------------------------------------------------------------------------------------------------
function treeLayout(b) {
  const shapes = fillShapes(b, parseMetaBin, M),
    band = new Float32Array(b.bands);
  return shapes.map((sh) => {
    const g = sh.GD[1] * 4096 + sh.GD[0],
      h = (g + (sh.GD[2] + sh.GD[3] + 2) * 2) * 4;
    const refBase = band[h + 2] | 0,
      refCount = band[h + 3] | 0,
      ext = (g + refBase + refCount) * 4;
    const GB = band[ext + 1] | 0,
      gridBase = band[ext + 2] | 0,
      gwh = band[ext + 3] | 0;
    const wind = [];
    for (let ci = 0; ci < (gwh >> 8) * (gwh & 255); ci++)
      wind.push(band[(g + gridBase + (ci >> 1)) * 4 + (ci & 1) * 2]);
    return { tree: sh.tree, GB, gw: gwh >> 8, gh: gwh & 255, wind: wind.join(',') };
  });
}
{
  const base = treeLayout(await importSvg(svgAt(1), { preserveViewport: true, gwnTree: true }));
  ok(
    base.length === 5 && base.every((t) => t.tree) && base.some((t) => t.GB > 0),
    `five tree shapes at scale 1, tier-2 bands on ${base.filter((t) => t.GB > 0).length}`,
  );
  // Cell windings are compared where the pieces themselves scale exactly (at 2^-40 the piece expansion's own absolute
  // tolerances still bite; gwnTreeScaleSmoke holds those).
  for (const lg of [-40, -20, 20]) {
    const L = treeLayout(
      await importSvg(svgAt(Math.pow(2, lg)), { preserveViewport: true, gwnTree: true }),
    );
    const bad = base
      .map((t, i) =>
        L[i] &&
        (L[i].GB !== t.GB ||
          L[i].gw !== t.gw ||
          L[i].gh !== t.gh ||
          (lg > -40 && L[i].wind !== t.wind))
          ? i
          : -1,
      )
      .filter((i) => i >= 0);
    ok(
      L.length === base.length && bad.length === 0,
      `(a) at 2^${lg} every shape's grid (${base.map((t) => `${t.gw}x${t.gh}`).join(' ')}) and band count${lg > -40 ? ' and cell windings' : ''} are scale 1's${bad.length ? ` (differ: shapes ${bad.join(', ')}: ${bad.map((i) => `${L[i].gw}x${L[i].gh} GB ${L[i].GB}`).join('; ')})` : ''}`,
    );
  }
}
// ---- (b), (c) ---------------------------------------------------------------------------------------------------------
if (!hasCxx()) console.log('  SKIP (b), (c): no C++ compiler ($CXX, clang++, g++, c++)');
else {
  const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
  const b = await importSvg(svgAt(1), { preserveViewport: true, gwnTree: true });
  const shapes = fillShapes(b, parseMetaBin, M),
    band = new Float32Array(b.bands),
    curve = new Float32Array(b.curves);
  const qs = [];
  for (const sh of shapes)
    for (let y = Math.floor(sh.bb[1]) - 2; y <= Math.ceil(sh.bb[3]) + 2; y++)
      for (let x = Math.floor(sh.bb[0]) - 2; x <= Math.ceil(sh.bb[2]) + 2; x++)
        qs.push({ GD: sh.GD, bb: sh.bb, eo: sh.eo, c: [x + 0.5, y + 0.5], ePx: [1, 1] });
  const LOGS = [-40, -20, 20, 40];
  const differing = (glsl) =>
    [GWN_WIND, GWN_SDF].map((defines) => {
      const emu = buildGlslEmu(ROOT, { defines, glsl });
      const base = emu.run(
        band,
        curve,
        qs.map((q) => ({ ...q, k: K_GWN })),
      );
      return LOGS.map((lg) => {
        const S = Math.pow(2, lg),
          sc = scaleFillData(band, curve, shapes, S);
        const r = emu.run(
          sc.band,
          sc.curve,
          qs.map((q) => ({
            ...q,
            k: K_GWN,
            bb: q.bb.map((v) => Math.fround(v * S)),
            c: [Math.fround(q.c[0] * S), Math.fround(q.c[1] * S)],
            ePx: [S, S],
          })),
        );
        return r.reduce((n, v, i) => n + (v !== base[i] ? 1 : 0), 0);
      });
    });
  const d = differing(GLSL);
  ok(
    d.flat().every((n) => n === 0),
    `(b) with the early exits, ${qs.length} pixel centers read as at 1 at 2^${LOGS.join(', 2^')} (differing: winding ${d[0].join('/')}, SDF ${d[1].join('/')})`,
  );
  const muts = [
    [
      'the grid looked up over max(extent, 1e-6)',
      'vec2 bbSz = gwnBoxSize(shapeBB);',
      'vec2 bbSz = max(shapeBB.zw - shapeBB.xy, vec2(1e-6));',
    ],
    [
      'the tier-2 bands over max(height, 1e-6)',
      'float bandH = gwnBoxSize(shapeBB).y / float(GB);',
      'float bandH = max(shapeBB.w - shapeBB.y, 1e-6) / float(GB);',
    ],
  ];
  for (const [name, from, to] of muts) {
    if (!GLSL.includes(from)) {
      ok(false, `(c) mutation hinge present: ${name}`);
      continue;
    }
    const m = differing(GLSL.split(from).join(to));
    ok(
      m.flat().some((n) => n > 0),
      `(c) mutation "${name}" is caught (differing: winding ${m[0].join('/')}, SDF ${m[1].join('/')})`,
    );
  }
}
// ---- (d) --------------------------------------------------------------------------------------------------------------
{
  const js = readFileSync(path.join(ROOT, 'src/svg/textures.js'), 'utf8');
  ok(
    /const bbW = extW > 0 \? extW : \(extH > 0 \? extH : 1\), bbH = extH > 0 \? extH : \(extW > 0 \? extW : 1\);/.test(
      js,
    ) && !/Math\.max\(bbX1 - bbX0, 1e-9\)/.test(js),
    '(d) the encoder forms the grid and band box as gwnBoxSize does, with no 1e-9 floor',
  );
}

if (fail) {
  console.error(`GWN-TREE-BOX-SCALE FAIL (${fail})`);
  process.exit(1);
}
console.log('GWN-TREE-BOX-SCALE PASS');
