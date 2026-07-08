// primHitTestSmoke — the analytic primKind fill hit-test (pointInPrim in
// src/hitTest/hitTest.js) must agree with the rendered SDF boundary: a point
// inside the bbox CORNER but outside the circle / rounded corner must MISS,
// proving the hit test follows the closed-form coverage and not the bbox.
import { DOMParser as DP } from '@xmldom/xmldom'; globalThis.DOMParser = DP;
import importSvg from '../src/svg/importer.js';
import { fillHitShape, HitMode } from '../src/hitTest/index.js';

let fails = 0;
const approx = (msg, got, want) => {
  if (got !== want) { console.error(`FAIL: ${msg} — got ${got}, want ${want}`); fails++; }
  else console.log(`ok ${msg}`);
};

// ── circle: cx=50 cy=50 r=30, square bbox [20,20,80,80] → primKind 1 ──
{
  const b = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
       <circle cx="50" cy="50" r="30" fill="#c00"/></svg>`);
  const hit = (x, y) => fillHitShape(b, x, y, { mode: HitMode.Coverage }) >= 0;
  approx('circle center (50,50) inside',          hit(50, 50), true);
  approx('circle near-top (50,79) inside  (d=29)', hit(50, 79), true);
  approx('circle past-top (50,82) outside (d=32)', hit(50, 82), false);
  // bbox corner: inside [20,80]² but dist 39.6 > r → must MISS (this is the
  // whole point — a bbox test would wrongly report a hit here).
  approx('circle bbox-corner (78,78) outside',     hit(78, 78), false);
}

// ── roundRect: x=10 y=10 w=80 h=80 rx=ry=20 → primKind 3, corner r=20 ──
{
  const b = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
       <rect x="10" y="10" width="80" height="80" rx="20" ry="20" fill="#06c"/></svg>`);
  const hit = (x, y) => fillHitShape(b, x, y, { mode: HitMode.Coverage }) >= 0;
  approx('roundRect center (50,50) inside',         hit(50, 50), true);
  approx('roundRect left-edge mid (12,50) inside',  hit(12, 50), true);
  // corner arc centered (30,30) r=20: (12,12) is dist 25.5 > 20 → MISS.
  approx('roundRect bbox-corner (12,12) outside',   hit(12, 12), false);
  // just inside the same corner along the diagonal: (30-14.1,30-14.1)=(15.9,15.9)
  approx('roundRect inside-corner (17,17) inside',  hit(17, 17), true);
}

// ── sharp rect: x=10 y=10 w=80 h=80 → primKind 2, corners filled ──
{
  const b = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
       <rect x="10" y="10" width="80" height="80" fill="#0a0"/></svg>`);
  const hit = (x, y) => fillHitShape(b, x, y, { mode: HitMode.Coverage }) >= 0;
  approx('rect bbox-corner (12,12) inside',  hit(12, 12), true);
  approx('rect just-outside (8,50) outside', hit(8, 50), false);
}

if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nprimHitTestSmoke: all assertions passed');
