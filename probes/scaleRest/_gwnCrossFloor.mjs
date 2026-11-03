// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gwnCross floor probe: where does the t*dy product form break, and does the sign form hold?
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
  hasCxx,
  buildGlslEmu,
  fillShapes,
  scaleFillData,
  gwnWithoutExits,
  K_GWN,
  GWN_SDF,
  GWN_WIND,
} = await import(path.join(ROOT, 'test/_glslEmu.mjs'));
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import(path.join(ROOT, 'src/svg/importer.js'));
const { parseMetaBin } = await import(path.join(ROOT, 'src/renderer/bundle.js'));
const M = await import(path.join(ROOT, 'src/bundle/layout.js'));

const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 220">
  <path d="M10.3 10.7 L 90.1 18.2 L 70.4 95.6 L 30.2 60.9 Z"/>
  <path d="M110.2 90.4 Q 150.7 -5.3 190.1 90.8 Q 150.3 60.2 110.2 90.4 Z"/>
  <path d="M210.4 20.3 C 290.2 20.1 220.6 100.7 300.3 99.2 L 300.3 110.1 L 210.4 110.1 Z"/>
  <path d="M320.1 20.2 C 420.6 120.4 300.2 120.8 400.3 20.6 Z"/>
  <path d="M60.3 160.2 m -45.1 0 a 45.1 45.1 0 1 0 90.2 0 a 45.1 45.1 0 1 0 -90.2 0 Z"/>
</svg>`;
const b = await importSvg(SVG, { preserveViewport: true, gwnTree: true });
const shapes = fillShapes(b, parseMetaBin, M);
const band = new Float32Array(b.bands),
  curve = new Float32Array(b.curves);
const qs = [];
for (const sh of shapes)
  for (let y = Math.floor(sh.bb[1]) - 2; y <= Math.ceil(sh.bb[3]) + 2; y++)
    for (let x = Math.floor(sh.bb[0]) - 2; x <= Math.ceil(sh.bb[2]) + 2; x++)
      qs.push({ GD: sh.GD, bb: sh.bb, eo: sh.eo, c: [x + 0.5, y + 0.5], ePx: [1, 1] });
console.log('shapes', shapes.length, 'pixels', qs.length);

function differing(glsl, defines, logs) {
  const emu = buildGlslEmu(ROOT, { defines, glsl });
  const base = emu.run(
    band,
    curve,
    qs.map((q) => ({ ...q, k: K_GWN })),
  );
  const out = [];
  for (const lg of logs) {
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
    let n = 0;
    r.forEach((v, i) => {
      if (v !== base[i]) n++;
    });
    out.push(n);
  }
  return out;
}

const NEW = 'return dy < 0.0 ? (t < 0.0 ? -1.0 : 0.0) : (t > 0.0 ? 1.0 : 0.0);';
const OLD = 'return (t * dy > 0.0) ? sign(dy) : 0.0;';
// A GPU flushes a denormal result to zero; C++ does not. Model it.
const FTZ =
  'float p = t * dy; return ((p < 0.0 ? -p : p) < 1.17549435e-38 ? 0.0 : p) > 0.0 ? sign(dy) : 0.0;';

console.log('hinge present:', GLSL.includes(NEW));
const EXPS = [-40, -44, -48, -52, -56, -58, -60, -62];
console.log('exps', EXPS.join(','));
for (const [name, src] of [
  ['NEW (sign form)', GLSL],
  ['OLD (t*dy)', GLSL.split(NEW).join(OLD)],
  ['OLD+FTZ (GPU model)', GLSL.split(NEW).join(FTZ)],
]) {
  const w = differing(gwnWithoutExits(src), GWN_WIND, EXPS);
  const s = differing(gwnWithoutExits(src), GWN_SDF, EXPS);
  console.log(`${name.padEnd(22)} wind ${w.join('/')}  sdf ${s.join('/')}`);
}
