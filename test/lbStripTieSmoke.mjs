// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbStripTieSmoke — an edge strip paints the pixel centers the rasterizer gives it on its own edge.
//
// A pixel center on the line an interior face and its edge strip share goes to exactly one of them, by the rasterizer's
// tie rule and its subpixel snap. A strip that CEDES any fragment it reads a hair inside the edge
// (`fOwn < 0 && c10 < 0.999 -> discard`) leaves such a pixel to nobody when the rasterizer has chosen the strip: the
// strip's quad lies wholly on the edge's air side, so the cession has no other target. On a test star (a 384 px scene at
// identity) whose straight edges put pixel centers exactly on the edge line, that draws a stair of EMPTY pixels, 0 where
// the path covers 0.5. The whole-LB-pipeline emulator reproduces
// the stair once vertices are snapped to a 1/256 subpixel grid; this draws the scene that way under both tie
// conventions GL allows and requires no pixel of the star off the exact box filter by more than 32/255.
// SKIPs (exit 77) without a C++ compiler and clang.
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasLbPipeEmu } from './_lbPipeEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasLbPipeEmu()) {
  console.log('SKIP lbStripTieSmoke: needs a C++17 compiler and clang');
  process.exit(77);
}
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const STAR =
  '<path d="M250 60 L280 150 L370 150 L300 205 L325 295 L250 240 L175 295 L200 205 L130 150 L220 150 Z" fill="#000"/>';
const dir = mkdtempSync(path.join(os.tmpdir(), 'lbStripTie-')),
  file = path.join(dir, 'star.svg');
writeFileSync(
  file,
  `<svg xmlns="http://www.w3.org/2000/svg" width="384" height="384" viewBox="0 0 384 384">${STAR}</svg>`,
);
try {
  for (const tie of ['topleft', 'bottomright']) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'probes/lbAccuracy/_lbEmuPaint.mjs')], {
      env: {
        ...process.env,
        SVG: file,
        N: '384',
        WIN: '120,50,380,300',
        OFF: '32',
        SNAP: '256',
        TIE: tie,
      },
      encoding: 'utf8',
      timeout: 170000,
    });
    const m = /OFF by more than 32\/255: (\d+) px/.exec(r.stdout || '');
    ok(
      !!m && +m[1] === 0,
      `the star at identity, vertices snapped to 1/256 px, ${tie} ties: ` +
        `${m ? m[1] : '(no answer: ' + (r.stderr || '').slice(0, 200) + ')'} px off by more than 32/255`,
    );
    if (m && +m[1] > 0) console.log((r.stdout.match(/^\s+@\(.*$/gm) || []).slice(0, 12).join('\n'));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(fail ? `lbStripTieSmoke: ${fail} FAILED` : 'lbStripTieSmoke: all passed');
process.exit(fail ? 1 : 0);
