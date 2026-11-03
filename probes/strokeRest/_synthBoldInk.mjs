// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _synthBoldInk.mjs — the CPU prediction of the ink svg/buildContext.js emitShape adds by sizing a
// synthetic-bold glyph row for the stroke it carries.
//
//   node probes/strokeRest/_synthBoldInk.mjs
//   PX=192 TEXT=Hamburg node probes/strokeRest/_synthBoldInk.mjs
//
// Synthetic bold has no SVG form: there is no bold face to select, so font/textColrEmit.js paints
// the run's color as a 0.04 em STROKE on top of the glyph's fill, through the one emitShape that
// every glyph goes through. A row sized from the PATH box -- band pad 0, cover-quad pad 0, meta
// bbox path-tight -- leaves the outer half of the synthesized weight with no fragments wherever
// the outline touches its own bbox. emitShape pads the row by the stroke's reach.
//
// This prints, for a real run at a stated size:
//   * each glyph row's meta bbox, path-tight and padded;
//   * the ink the padded row gains, in device pixels;
//   * the two terms the model excludes from the gain, so a disagreement can be attributed instead
//     of guessed at.
//
// THE MODEL LIVES IN test/_synthBoldInkModel.mjs, with the derivation of both terms. In short, the
// gain is not "the stroke coverage outside the path-tight cover quad". The baked quad is not the
// quad that rasterizes -- the vertex shader dilates every edge by half a device pixel, which is
// scale-LINEAR ink a path-tight row already paints -- and the excluded region is NOT disjoint from
// the fill. emitShape puts fill and stroke on ONE row; the padded row's wider band membership
// reaches pixels on the INNER half of the stroke that a path-tight walk misses, and those lie inside
// the path where the fill is already solid, so the render gains nothing there at all.
//
// MEASURED (probes/strokeRest/_synthBoldInkGpu.mjs, 0.000 A/A floor, byte-identical across Slug,
// Loop-Blinn and CPatch) is the gain with a band walk that does not add the stroke's AA reach:
// 736.2 px at 96 px/em and 3601.7 at 192, where the model says 758.6 and 3601.9. With the AA reach,
// which the renderer adds, the render gains 724.0 and 3,548.4 and the model says 746.6 and 3,548.8.
// A model without the two terms says 1307.1 and 4892.1 (43.7% and 26.4% high).
//
// WHAT WOULD FALSIFY IT: see README.md. The residual is a boundary effect of sampling coverage at
// the pixel CENTER, so it must SHRINK with size -- a model that misses by a larger fraction at
// 192 px/em than at 96 is wrong about something else.
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FIXTURE = path.join(ROOT, 'test/font/fixtures/roboto-regular.ttf');
if (!existsSync(FIXTURE)) {
  console.log('SKIP — roboto fixture not fetched (node scripts/fetchTestFixtures.mjs)');
  process.exit(0);
}

const TEXT = process.env.TEXT || 'Hamburg';
const PX = +(process.env.PX || 96);
const { MantleFontAsset } = await import(path.join(ROOT, 'src/font/fontAsset.js'));
const { buildTextSections } = await import(path.join(ROOT, 'src/font/textSections.js'));
const { synthBoldInkGain } = await import(path.join(ROOT, 'test/_synthBoldInkModel.mjs'));

/// What the GPU measured for "Hamburg" at these two sizes, so the run prints its own residual.
const MEASURED = { 96: 736.2, 192: 3601.7 };

const font = new MantleFontAsset(new Uint8Array(readFileSync(FIXTURE)));
const { sections } = await buildTextSections(
  font,
  TEXT,
  { fontSizePx: PX, weight: 700, fill: [0, 0, 0, 1] },
  false,
);
const out = synthBoldInkGain(sections, PX);

console.log(
  `"${TEXT}" at ${PX} px per em, weight 700 with no bold face (synthetic bold): ${out.rows.length} glyph rows`,
);
for (const r of out.rows) {
  console.log(
    `  row ${r.row}: halfW ${r.halfWpx.toFixed(2)} px, ink gained ${r.gain.toFixed(1)} px` +
      `   meta bbox [${r.bboxPre.map((v) => v.toFixed(1)).join(', ')}]` +
      ` -> [${r.bboxNew.map((v) => v.toFixed(1)).join(', ')}]`,
  );
}
console.log(`\nTOTAL INK GAINED: ${out.total.toFixed(1)} device pixels`);
console.log(`  excluded from the gain, because a path-tight row already paints it:`);
console.log(
  `    the cover quad's own half-pixel AA dilation, already painted   ${out.quadDilation.toFixed(1)} px`,
);
console.log(
  `    the fill on the same row, already solid where the stroke gains ${out.fillAlready.toFixed(1)} px`,
);
const m = MEASURED[PX];
if (m != null) {
  const d = out.total - m;
  console.log(
    `\n  MEASURED on the GPU at this size: ${m.toFixed(1)} px` +
      `   residual ${d >= 0 ? '+' : ''}${d.toFixed(1)} (${((100 * d) / m).toFixed(2)}%)`,
  );
} else {
  console.log(
    `\n  (no GPU measurement recorded at ${PX} px/em; run probes/strokeRest/_synthBoldInkGpu.mjs)`,
  );
}
console.log(
  `\nExpected ink-bbox expansion per glyph: halfW on every side, and a MITER join can reach`,
);
console.log(
  `up to 4 * halfW past a corner. See README.md for the recipe and what would falsify it.`,
);
