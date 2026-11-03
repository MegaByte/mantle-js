// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchSimplePaintSmoke -- a complete line/quadratic paint is one area, exact where its seams were not.
//
// A text glyph 'a' (a bowl with a counter: concave, one hole) at 128 and 512 px, and the same glyph beside an island and
// inside a frame (disjoint islands and a nested hole), through probes/cpatchOwn/exs.mjs (the float32 kernel twin over every
// cover fragment against 12x12-sample exact coverage in the shape's own fill rule): with the complete-paint area, and with
// the seam path (--noarea). Subpixel glyph losses are the seam path's -- every piece of a small glyph can reject a pixel
// behind a hard seam -- so the area path has to be at least four times better on pixels off by more than 32/255, and the first-class
// bar is absolute: no pixel off by half.
import { execFileSync } from 'child_process';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const dir = mkdtempSync(path.join(tmpdir(), 'cpsimple-'));
const A =
  'M8.508301 0.760254 Q8.500488 0.744629 8.495605 0.70459 Q8.432617 0.77002 8.345215 0.77002 Q8.26709 0.77002 8.217041 0.72583 Q8.166992 0.681641 8.166992 0.61377 Q8.166992 0.53125 8.229736 0.485596 Q8.29248 0.439941 8.40625 0.439941 L8.494141 0.439941 L8.494141 0.398438 Q8.494141 0.351074 8.46582 0.322998 Q8.4375 0.294922 8.382324 0.294922 Q8.333984 0.294922 8.30127 0.319336 Q8.268555 0.34375 8.268555 0.378418 L8.177734 0.378418 Q8.177734 0.338867 8.205811 0.302002 Q8.233887 0.265137 8.281982 0.243652 Q8.330078 0.222168 8.387695 0.222168 Q8.479004 0.222168 8.530762 0.267822 Q8.58252 0.313477 8.584473 0.393555 L8.584473 0.636719 Q8.584473 0.709473 8.603027 0.752441 L8.603027 0.760254 L8.508301 0.760254 Z M8.358398 0.691406 Q8.400879 0.691406 8.438965 0.669434 Q8.477051 0.647461 8.494141 0.612305 L8.494141 0.503906 L8.42334 0.503906 Q8.257324 0.503906 8.257324 0.601074 Q8.257324 0.643555 8.285645 0.66748 Q8.313965 0.691406 8.358398 0.691406 Z';
const shift = (d, dx, dy) =>
  d.replace(
    /(-?\d+\.?\d*) (-?\d+\.?\d*)/g,
    (_, x, y) => `${(+x + dx).toFixed(6)} ${(+y + dy).toFixed(6)}`,
  );
const FIX = {
  glyph: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="8 0 1 1"><path d="${A}"/></svg>`,
  two: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="8 0 2 1"><path d="${A} ${shift(A, 1, 0)}"/></svg>`,
};
const run = (name, extra = []) => {
  const f = path.join(dir, name + '.svg');
  writeFileSync(f, FIX[name]);
  const out = execFileSync(
    'node',
    [path.join(ROOT, 'probes/cpatchOwn/exs.mjs'), '--assets', f, '--sizes', '128,512', ...extra],
    { encoding: 'utf8' },
  );
  return [...out.matchAll(/@(\d+): off>32\/255 (\d+)\s+off>=0.5 (\d+)/g)].map((m) => ({
    n: +m[1],
    off: +m[2],
    half: +m[3],
  }));
};
for (const name of Object.keys(FIX)) {
  const on = run(name),
    off = run(name, ['--noarea']);
  on.forEach((r, i) =>
    ok(
      r.half === 0 && r.off * 4 <= Math.max(off[i].off, 4) && r.off <= 6,
      `${name} @${r.n}: ${r.off} pixels off by more than 32/255 as one area, ${off[i].off} through seams; ${r.half} off by half`,
    ),
  );
}
console.log(fail ? 'cpatchSimplePaintSmoke FAIL (' + fail + ')' : 'cpatchSimplePaintSmoke PASS');
process.exit(fail ? 1 : 0);
