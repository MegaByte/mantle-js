// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
const ROOT = process.env.MANTLE_ROOT || new URL('../..', import.meta.url).pathname; // the package tree to probe (default: this one)
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import(ROOT + '/src/svg/importer.js');
for (const [label, f] of [
  ['2-seg (FAILS)', '/tmp/openFill_min_open.svg'],
  ['3-seg (works)', '/tmp/openFill_authored_line.svg'],
]) {
  const b = await importSvg(readFileSync(f, 'utf8'), { preserveViewport: true });
  const c = new Float32Array(b.curves);
  const r = b.curveRangesByShape[0];
  console.log(`\n${label}: [${r.begin},${r.end}) = ${r.end - r.begin} floats`);
  for (let i = r.begin; i < r.end; i += 4) {
    const t = i === r.begin ? 'HDR?' : '    ';
    console.log(
      `  [${String(i).padStart(3)}] ${t} ${[0, 1, 2, 3].map((k) => String(c[i + k]).padStart(12)).join(' ')}`,
    );
  }
}
