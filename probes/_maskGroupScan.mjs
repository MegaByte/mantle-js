// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _maskGroupScan -- which SVGs under a root open a GROUP row that carries a mask?
//   node probes/_maskGroupScan.mjs OUT.json ROOT [ROOT...]        (src of this checkout)
// Writes [{file, groupMasks, rows, bytes}] for every SVG with at least one such row.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { default: importSvg } = await import(path.join(HERE, 'src/svg/importer.js'));
const { parseMetaBin } = await import(path.join(HERE, 'src/renderer/bundle.js'));
console.warn = () => {};
console.log = (
  (l) =>
  (...a) => {
    if (a[0] && String(a[0]).startsWith('@@')) l(...a);
  }
)(console.log);
const [out, ...roots] = process.argv.slice(2);
const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    if (n === 'node_modules' || n.startsWith('.')) continue;
    const p = path.join(d, n);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (n.endsWith('.svg')) files.push(p);
  }
};
for (const r of roots) walk(r);
const res = [];
for (const f of files) {
  let txt;
  try {
    txt = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  if (!/<mask[\s>]/.test(txt) || !/mask\s*[=:]/.test(txt)) continue;
  try {
    const b = await importSvg(txt, { preserveViewport: true });
    const st = b.metaFloatsPerShape,
      mf = parseMetaBin(b.meta, st).metaFloats;
    let gm = 0;
    for (let r = 0; r < mf.length / st; r++) {
      const o = r * st,
        fl = Math.round(mf[o + 27]);
      if (fl & 64 && !(fl & 256) && mf[o + 31] > 0) gm++;
    }
    if (gm) res.push({ file: f, groupMasks: gm, rows: mf.length / st, bytes: txt.length });
  } catch (e) {
    /* unparsable */
  }
}
writeFileSync(out, JSON.stringify(res, null, 1));
process.stdout.write(
  `@@ scanned ${files.length} with-mask-text, ${res.length} have group mask rows\n`,
);
