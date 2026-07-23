// _fixtures.mjs — a smoke that BUILDS its SVG at runtime emits it as a file.
//
// Most smoke SVGs are static, so they live in examples/smoke/ and the smoke reads them.
// A few are generated — a path swept round a circle, a grid of shapes, a stroke laid down
// point by point — and freezing those into a file would be a lie: the fixture is the
// generator, and the next person to tune it would silently be testing something the file no
// longer contains.
//
// So the generator stays, and the smoke WRITES what it generated. The file on disk is the
// exact string the test rendered, by construction — there is no version of this that can
// drift. It also means a fixture change shows up as a diff in examples/smoke/, which is
// what you want to see.
//
// The demo's picker reads index.json, so these appear there alongside the static ones.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/smoke');
const MANIFEST = path.join(DIR, 'index.json');

/** @param {string} name  e.g. 'coverQuadBatch__SVG'  @param {string} svg */
export function emitFixture(name, svg, smoke) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    const file = `${name}.svg`;
    let out = String(svg).trim();
    if (!out.startsWith('<?xml')) out = '<?xml version="1.0" encoding="UTF-8"?>\n' + out;
    out += '\n';
    const full = path.join(DIR, file);
    // Only touch the file when the content actually changed, so a test run doesn't
    // needlessly dirty the working tree.
    if (!existsSync(full) || readFileSync(full, 'utf8') !== out) writeFileSync(full, out);

    const [base, konst] = name.split('__');
    const entry = { file, smoke: smoke || `${base}Smoke.mjs`, const: konst || name, generated: true };
    let list = [];
    try { list = JSON.parse(readFileSync(MANIFEST, 'utf8')); } catch { list = []; }
    const i = list.findIndex(e => e.file === file);
    if (i >= 0) { if (JSON.stringify(list[i]) === JSON.stringify(entry)) return svg; list[i] = entry; }
    else list.push(entry);
    list.sort((a, b) => a.file.localeCompare(b.file));
    writeFileSync(MANIFEST, JSON.stringify(list, null, 1) + '\n');
  } catch { /* emitting a fixture is a convenience; never fail a smoke over it */ }
  return svg;
}
