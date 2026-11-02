// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Scale-1 survey for the gwnCross sign form and the squareBB gate.
//
// (1) gwnCross: the sign form against the product form at scale 1, pixel for pixel, on the smoke's shapes.
// (2) squareBB: max(w, h) and max(w, 1e-6) can only disagree on a shape whose baked bbox side is below
//     1e-6 em, because above that max(w, 1e-6) == w and max(w, h) == w whenever w >= h -- so survey the
//     corpus's baked bbox sides and the aspect of everything the importer tags as a circle/annulus primitive.
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, readdirSync } from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { hasCxx, buildGlslEmu, fillShapes, gwnWithoutExits, K_GWN, GWN_SDF, GWN_WIND } =
  await import(path.join(ROOT, 'test/_glslEmu.mjs'));
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import(path.join(ROOT, 'src/svg/importer.js'));
const { parseMetaBin } = await import(path.join(ROOT, 'src/renderer/bundle.js'));
const M = await import(path.join(ROOT, 'src/bundle/layout.js'));
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');

// ---- (1) ---------------------------------------------------------------------------------------------------
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 220">
  <path d="M10.3 10.7 L 90.1 18.2 L 70.4 95.6 L 30.2 60.9 Z"/>
  <path d="M110.2 90.4 Q 150.7 -5.3 190.1 90.8 Q 150.3 60.2 110.2 90.4 Z"/>
  <path d="M210.4 20.3 C 290.2 20.1 220.6 100.7 300.3 99.2 L 300.3 110.1 L 210.4 110.1 Z"/>
  <path d="M320.1 20.2 C 420.6 120.4 300.2 120.8 400.3 20.6 Z"/>
  <path d="M60.3 160.2 m -45.1 0 a 45.1 45.1 0 1 0 90.2 0 a 45.1 45.1 0 1 0 -90.2 0 Z"/>
</svg>`;
{
  const b = await importSvg(SVG, { preserveViewport: true, gwnTree: true });
  const shapes = fillShapes(b, parseMetaBin, M);
  const band = new Float32Array(b.bands),
    curve = new Float32Array(b.curves);
  const qs = [];
  for (const sh of shapes)
    for (let y = Math.floor(sh.bb[1]) - 2; y <= Math.ceil(sh.bb[3]) + 2; y++)
      for (let x = Math.floor(sh.bb[0]) - 2; x <= Math.ceil(sh.bb[2]) + 2; x++)
        qs.push({ GD: sh.GD, bb: sh.bb, eo: sh.eo, c: [x + 0.5, y + 0.5], ePx: [1, 1] });
  const HINGE = 'return dy < 0.0 ? (t < 0.0 ? -1.0 : 0.0) : (t > 0.0 ? 1.0 : 0.0);';
  const OLD = 'return (t * dy > 0.0) ? sign(dy) : 0.0;';
  for (const [name, defs] of [
    ['winding', GWN_WIND],
    ['SDF', GWN_SDF],
  ]) {
    const a = buildGlslEmu(ROOT, { defines: defs, glsl: gwnWithoutExits(GLSL) }).run(
      band,
      curve,
      qs.map((q) => ({ ...q, k: K_GWN })),
    );
    const c = buildGlslEmu(ROOT, {
      defines: defs,
      glsl: gwnWithoutExits(GLSL.split(HINGE).join(OLD)),
    }).run(
      band,
      curve,
      qs.map((q) => ({ ...q, k: K_GWN })),
    );
    let n = 0;
    a.forEach((v, i) => {
      if (v !== c[i]) n++;
    });
    console.log(
      `gwnCross scale 1, ${name}: ${n} of ${a.length} pixels differ between the sign form and the product form`,
    );
  }
}

// ---- (2) ---------------------------------------------------------------------------------------------------
{
  const dirs = [path.join(ROOT, 'examples'), path.join(ROOT, 'examples/smoke')];
  const files = dirs
    .flatMap((d) =>
      readdirSync(d)
        .filter((f) => f.endsWith('.svg'))
        .map((f) => path.join(d, f)),
    )
    .sort();
  let shapesSeen = 0,
    tiny = 0,
    minSide = Infinity,
    minSideFile = '',
    prims = 0,
    primsMoved = 0,
    failed = 0;
  // The two bars only disagree when max(w, 1e-6) != max(w, h), i.e. when w < 1e-6 (the floor binds) or when
  // h > w (max(w, 1e-6) reads the x side alone). Count both, since the second is also a behavior change.
  let hGtW = 0,
    hGtWmoved = 0;
  for (const f of files) {
    let b;
    try {
      b = await importSvg(readFileSync(f, 'utf8'), { preserveViewport: true });
    } catch {
      failed++;
      continue;
    }
    const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
      F = pm.metaFloats;
    for (let s = 0; s < b.numShapes; s++) {
      const o = s * pm.floatsPerShape;
      const w = F[o + M.META_BBOX_XMAX] - F[o + M.META_BBOX_XMIN];
      const h = F[o + M.META_BBOX_YMAX] - F[o + M.META_BBOX_YMIN];
      if (!(w >= 0) || !(h >= 0)) continue;
      shapesSeen++;
      const side = Math.max(w, h);
      if (side < minSide && side > 0) {
        minSide = side;
        minSideFile = path.basename(f);
      }
      if (w < 1e-6) tiny++;
      const oldV = Math.abs(w - h) <= 1e-3 * Math.max(w, 1e-6);
      const newV = Math.abs(w - h) <= 1e-3 * Math.max(w, h);
      if (h > w) {
        hGtW++;
        if (oldV !== newV) hGtWmoved++;
      }
      const k = F[o + M.META_PRIM_KIND] | 0;
      if (k === 1 || k === 4) {
        prims++;
        if (oldV !== newV) primsMoved++;
      }
      if (oldV !== newV && !(h > w)) primsMoved += 0;
    }
  }
  console.log(
    `squareBB corpus survey: ${files.length} SVGs (${failed} unreadable), ${shapesSeen} shapes`,
  );
  console.log(`  smallest baked bbox side: ${minSide.toExponential(3)} em (${minSideFile})`);
  console.log(`  shapes with a bbox WIDTH below 1e-6 em (where the floor bound): ${tiny}`);
  console.log(`  shapes taller than wide: ${hGtW}, of which the verdict moves: ${hGtWmoved}`);
  console.log(
    `  circle/annulus-tagged shapes: ${prims}, of which the verdict moves: ${primsMoved}`,
  );
}
