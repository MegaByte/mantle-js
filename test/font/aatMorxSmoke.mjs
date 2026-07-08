// Verifies AAT 'morx' shaping for AAT-only fonts (no GSUB).
//
// Apple Chancery forms ligatures + contextual swashes via morx. Asserts the
// morx engine ligates known sequences and that buildTextRun routes AAT-only
// fonts through it (fewer emitted shapes than input characters).
// Skips when the font is unavailable.

import { readFileSync, existsSync } from 'fs';
import { parseTtfTables } from '../../src/font/ttfTables.js';
import { AatMorx } from '../../src/font/typography/aatMorx.js';
import { MantleFontAsset, buildTextRun } from '../../src/font/index.js';

const p = '/System/Library/Fonts/Supplemental/Apple Chancery.ttf';
if (!existsSync(p)) { console.log('Skip aatMorx: no Apple Chancery'); process.exit(0); }

let failures = 0;
const fail = (m) => { console.error('FAIL', m); failures++; };
const ok = (m) => console.log('ok', m);

const bytes = new Uint8Array(readFileSync(p));
const t = parseTtfTables(bytes);
const morx = new AatMorx(t);

// ---- T1: morx present + ligature formation matches HarfBuzz refs ----
if (!morx.hasMorx) fail('T1 Apple Chancery should have morx');
else ok('T1 hasMorx');

const gid = (s) => [...s].map((c) => t.codepointToGlyphIndex(c.codePointAt(0)));
const refs = {
  office: [82, 331, 70, 72],       // o + ffi-ligature + c + e
  first: [192, 85, 86, 87],        // fi-ligature + r + s + t
  stuff: [86, 87, 88, 330],        // s + t + u + ff-ligature
  no: [81, 82],                    // unchanged
};
for (const [s, ref] of Object.entries(refs)) {
  const out = morx.apply(gid(s)).gids;
  const eq = out.length === ref.length && out.every((x, k) => x === ref[k]);
  if (!eq) fail(`T2 "${s}" → [${out}] != HarfBuzz [${ref}]`);
  else ok(`T2 "${s}" → [${out}]`);
}

// ---- T3: source map length tracks the shaped output ----
{
  const r = morx.apply(gid('difficult'));
  if (r.src.length !== r.gids.length) fail(`T3 src/gids length mismatch (${r.src.length} vs ${r.gids.length})`);
  else ok(`T3 src map aligned (${r.gids.length} glyphs)`);
}

// ---- T4: end-to-end — buildTextRun routes AAT font through morx ----
{
  const font = new MantleFontAsset(bytes);
  if (!font.usesAatShaping) fail('T4 usesAatShaping should be true (morx, no GSUB)');
  else {
    const b = await buildTextRun('office', font, [0, 0, 0, 1]);
    if (b.numShapes !== 4) fail(`T4 "office" should emit 4 shapes (ffi ligated), got ${b.numShapes}`);
    else ok('T4 buildTextRun ligates "office" → 4 shapes');
  }
}

console.log(failures ? `\nAAT-MORX FAIL (${failures})` : '\nAAT-MORX PASS');
process.exit(failures ? 1 : 0);
