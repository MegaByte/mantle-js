// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svgCommentDashSmoke — no SVG asset the lanes or probes load has "--" inside an XML comment.
//
// XML 1.0 §2.5 forbids the string "--" inside a comment, and a comment may not end in "-". xmldom lets
// it pass, so every node smoke read such a file fine -- but Chrome's DOMParser rejects the document and
// importSvg returns ZERO shapes, so a timing asset with "--move" in a comment times an empty frame.
// This scans the directories whose SVGs a browser loads.
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0,
  files = 0;
for (const d of ['probes/filtperf', 'examples/smoke', 'examples']) {
  const dir = path.join(ROOT, d);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.svg'))) {
    files++;
    const s = readFileSync(path.join(dir, f), 'utf8');
    for (const m of s.matchAll(/<!--([\s\S]*?)-->/g)) {
      if (m[1].includes('--') || m[1].endsWith('-')) {
        fail++;
        const at = m[1].indexOf('--');
        console.log(
          `  FAIL ${d}/${f}: a comment holds "--": ...${m[1].slice(Math.max(0, at - 30), at + 20).replace(/\n/g, ' ')}...`,
        );
        break;
      }
    }
  }
}
console.log(
  `  ${fail ? 'FAIL' : 'ok'} ${files} SVG files scanned, ${fail} with "--" inside a comment`,
);
console.log(fail ? `svgCommentDashSmoke FAIL (${fail})` : 'svgCommentDashSmoke PASS');
process.exit(fail ? 1 : 0);
