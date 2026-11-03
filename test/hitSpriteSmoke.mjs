// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// hitSpriteSmoke -- hit tests take a sprite (an id or a [first, last] shape range) so a sheet answers per sprite.
// drawSprite draws one sprite of a sheet; the hit tests answered for every sprite at its authored position and a sprite
// under another one could never be reached. Checked GL-free on importSvg sections:
//   (a) { sprite: id } answers only rows of that sprite, and misses at a point only another sprite covers;
//   (b) a sprite under an overlapping sprite is reachable (the unrestricted query returns the one on top);
//   (c) an explicit [first, last] range works the same, an unknown id or a bad range misses;
//   (d) fillHits, fillHitId and Coverage mode honor it; hit-only rows are never answered under a sprite;
//   (e) without the option nothing changes.
import { fillHitShape, fillHits, fillHitId, HitMode } from '../src/hitTest/hitTest.js';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg } = await import('../src/index.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const SHEET = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100">
  <g id="red"><rect x="0" y="0" width="60" height="100" fill="#d33"/><rect x="40" y="0" width="60" height="100" fill="#d33"/></g>
  <rect id="green" x="100" y="0" width="100" height="100" fill="#3a3"/>
  <rect id="blue" x="200" y="0" width="100" height="100" fill="#33d"/>
  <rect id="top" x="80" y="20" width="60" height="60" fill="#fa0"/>
  <rect id="ghost" x="250" y="40" width="30" height="30" fill="none" pointer-events="all"/>
</svg>`;
const sec = await importSvg(SHEET);
const R = sec.spriteRanges;
ok(
  R && R.red && R.green && R.blue && R.top,
  'the sheet has sprites red green blue top: ' + JSON.stringify(R),
);
const rows = (id) => R[id];

// (a)
ok(
  fillHitShape(sec, 150, 50, { sprite: 'green' }) === rows('green')[0],
  '(a) green answers at its own point',
);
ok(
  fillHitShape(sec, 150, 50, { sprite: 'red' }) === -1,
  '(a) red misses at a point only green covers',
);
ok(
  fillHitShape(sec, 20, 50, { sprite: 'red' }) >= rows('red')[0] &&
    fillHitShape(sec, 20, 50, { sprite: 'red' }) <= rows('red')[1],
  '(a) red answers with one of its rows',
);
// (b) the point (120, 50) is covered by green below and top above
const topRow = rows('top')[0];
ok(fillHitShape(sec, 120, 50) === topRow, '(b) unrestricted: the sprite on top answers');
ok(
  fillHitShape(sec, 120, 50, { sprite: 'green' }) === rows('green')[0],
  '(b) the sprite underneath is reachable',
);
ok(fillHitShape(sec, 120, 50, { sprite: 'top' }) === topRow, '(b) the top sprite still answers');
// (c)
const [g0, g1] = rows('green');
ok(fillHitShape(sec, 120, 50, { sprite: [g0, g1] }) === g0, '(c) an explicit range works');
ok(fillHitShape(sec, 120, 50, { sprite: 'nope' }) === -1, '(c) an unknown id misses');
ok(
  fillHitShape(sec, 120, 50, { sprite: [5, 2] }) === -1 &&
    fillHitShape(sec, 120, 50, { sprite: [0, 999] }) === -1,
  '(c) a bad range misses',
);
ok(
  fillHitShape(sec, 120, 50, { sprite: 'constructor' }) === -1,
  '(c) a prototype name is not a sprite',
);
// (d)
const hs = fillHits(sec, 120, 50, { sprite: [g0, topRow] });
ok(
  hs.length === 2 && hs[0] === topRow && hs[1] === g0,
  '(d) fillHits returns the window front to back: ' + JSON.stringify(hs),
);
ok(fillHitId(sec, 120, 50, { sprite: 'green' }) === 'green', '(d) fillHitId follows');
ok(
  fillHitShape(sec, 265, 55) === sec.numShapes,
  '(d) without a sprite the hit-only region answers on top (index numShapes)',
);
ok(
  fillHitShape(sec, 265, 55, { sprite: 'blue' }) === rows('blue')[0],
  '(d) a sprite query skips the hit-only row and answers the sprite under it',
);
ok(
  fillHits(sec, 265, 55, { sprite: [0, sec.numShapes - 1] }).every((i) => i < sec.numShapes),
  '(d) a whole-sheet window never contains a hit-only index',
);
ok(
  fillHitShape(sec, 120, 50, { mode: HitMode.Bbox, sprite: 'green' }) === g0,
  '(d) Bbox mode honors it',
);
// (e)
ok(
  fillHitShape(sec, 20, 50) >= 0 && fillHitShape(sec, 1000, 50) === -1,
  '(e) no option: unchanged',
);
process.exit(fail ? 1 : 0);
