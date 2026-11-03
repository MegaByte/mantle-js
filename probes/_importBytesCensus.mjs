// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _importBytesCensus — every asset's bundle, fingerprinted, so an importer change can be told apart from no
// change and every asset it moved can be named.
//
// THE STANDARD the importer passes are held to: a change that is not supposed to move the scale-1 output must
// come back ALL identical, and any byte that does move needs an explanation. Two checks per asset — one over
// every ArrayBuffer section, one over every scalar / JSON field — so "the bytes are the same but numShapes
// changed" cannot hide.
//
//   node probes/_importBytesCensus.mjs OUT.json [file.svg ...]
//   node probes/_importBytesCensus.mjs --diff A.json B.json
//
// With no files it takes examples/*.svg, examples/_bench/*.svg and examples/smoke/*.svg (tiger lives in
// examples/); the gitignored ones are skipped when absent, so say so when you report a total.
//
// OPTS is extra importSvg options as JSON, merged after preserveViewport — the silhouette is an OPTION, and
// a defect inside it is invisible to a default-options run:
//   OPTS='{"computeSilhouette":true}' node probes/_importBytesCensus.mjs sil.json
//
// --diff names each moved asset and, for a field difference, each field that moved; for a section difference,
// each section. That is the report: a count alone cannot be explained.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv[2] === '--diff') {
  const A = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const B = JSON.parse(readFileSync(process.argv[4], 'utf8'));
  let same = 0,
    moved = 0,
    only = 0;
  for (const k of [...new Set([...Object.keys(A), ...Object.keys(B)])].sort()) {
    const a = A[k],
      b = B[k];
    if (!a || !b) {
      only += 2;
      console.log(`ONLY IN ${a ? 'A' : 'B'}: ${k}`);
      continue;
    }
    for (const part of ['bytes', 'fields']) {
      if (a[part] === b[part]) {
        same++;
        continue;
      }
      moved++;
      console.log(`${k} ${part}: ${a[part]} -> ${b[part]}`);
      const detail = part === 'fields' ? [a.f, b.f] : [a.s, b.s];
      if (!detail[0] || !detail[1]) continue;
      for (const n of [...new Set([...Object.keys(detail[0]), ...Object.keys(detail[1])])].sort()) {
        const x = JSON.stringify(detail[0][n]),
          y = JSON.stringify(detail[1][n]);
        if (x === y) continue;
        const cut = (s) => (s && s.length > 160 ? s.slice(0, 160) + `… (${s.length} chars)` : s);
        console.log(`    ${part === 'fields' ? '' : 'section '}${n}: ${cut(x)} -> ${cut(y)}`);
      }
    }
  }
  console.log(
    `\n${same} of ${same + moved + only} byte-identical (${moved} moved, ${only} only in one)`,
  );
  process.exit(moved || only ? 1 : 0);
}

const out = process.argv[2];
if (!out) {
  console.error('usage: _importBytesCensus.mjs OUT.json [file.svg ...] | --diff A.json B.json');
  process.exit(2);
}

if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
console.warn = () => {};

const OPTS = Object.assign(
  { preserveViewport: true },
  process.env.OPTS ? JSON.parse(process.env.OPTS) : {},
);
let files = process.argv.slice(3);
if (!files.length) {
  const dir = (d) =>
    existsSync(path.join(ROOT, d))
      ? readdirSync(path.join(ROOT, d))
          .filter((f) => f.endsWith('.svg'))
          .sort()
          .map((f) => d + '/' + f)
      : [];
  files = [...dir('examples'), ...dir('examples/_bench'), ...dir('examples/smoke')];
}

const h = (b) => createHash('sha1').update(b).digest('hex').slice(0, 16);
const result = {};
for (const f of files) {
  // The same key from any checkout, as _lbMeshCensus does.
  const rel = f.includes('examples/') ? f.slice(f.lastIndexOf('examples/')) : f;
  let svg;
  try {
    svg = readFileSync(path.resolve(ROOT, f), 'utf8');
  } catch {
    continue;
  }
  let b;
  try {
    b = await importSvg(svg, OPTS);
  } catch (e) {
    result[rel] = { bytes: 'THREW', fields: String(e && e.message).slice(0, 120) };
    continue;
  }
  const sec = {},
    fld = {};
  for (const k of Object.keys(b).sort()) {
    const v = b[k];
    if (v instanceof ArrayBuffer) sec[k] = h(new Uint8Array(v));
    else if (ArrayBuffer.isView(v))
      sec[k] = h(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    else fld[k] = v; // scalars, arrays and plain objects, compared as JSON
  }
  result[rel] = { bytes: h(JSON.stringify(sec)), fields: h(JSON.stringify(fld)), s: sec, f: fld };
}
writeFileSync(out, JSON.stringify(result));
const n = Object.keys(result).length;
console.log(
  `scan: ${n} assets, ${n * 2} checks${process.env.OPTS ? ` (OPTS ${process.env.OPTS})` : ''} -> ${out}`,
);
