// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Save dynamically generated SVG fixtures in examples/smoke/ and update the demo
// index. Each file contains the exact SVG rendered by its test. Static fixtures
// are stored directly in examples/smoke/.
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
    const entry = {
      file,
      smoke: smoke || `${base}Smoke.mjs`,
      const: konst || name,
      generated: true,
    };
    let list = [];
    try {
      list = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    } catch {
      list = [];
    }
    const i = list.findIndex((e) => e.file === file);
    if (i >= 0) {
      if (JSON.stringify(list[i]) === JSON.stringify(entry)) return svg;
      list[i] = entry;
    } else list.push(entry);
    list.sort((a, b) => a.file.localeCompare(b.file));
    writeFileSync(MANIFEST, JSON.stringify(list, null, 1) + '\n');
  } catch {
    /* emitting a fixture is a convenience; never fail a smoke over it */
  }
  return svg;
}
