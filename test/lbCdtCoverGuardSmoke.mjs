// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbCdtCoverGuardSmoke — the CDT / partition-carve route does not ask the mesh-coverage bound,
// and the reason it need not is pinned rather than argued.
//
// `meshUnderCovers` refuses a mesh whose deliberate OVER-estimate of paintable area is under HALF
// the shape's true area. The fast route asks it; the partition route accepts on
// `!cdt.fallback.length` alone. It need not ask: the rows the bound could flag there draw NO FILL (stroke-only rows,
// fill alpha 0), where declining recovers no ink and costs a Slug cover quad each; and since the build closes an open
// contour as SVG fills it, the bound flags nothing on tiger. This pins four things: the one predicate's answer; the loop integral
// the bound divides by; that there is one accept site and it asks the predicate; and, end to end on
// tiger, that every row the bound would flag on the partition route draws no fill -- so a PAINTED
// fill that under-covers fails here instead of shipping as missing ink.
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as CORE from '../src/renderer/lbBuildCore.js';
import { SEG_LINE, SEG_CUBIC } from '../src/primitives/seg.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));
const { cdtMeshAccepted, meshUnderCovers, buildLbShape } = CORE;

const hasFn = typeof cdtMeshAccepted === 'function';
ok(hasFn, 'lbBuildCore exports cdtMeshAccepted');

// ── 1. the predicate ───────────────────────────────────────────────────────────────────────────
const sq = [
  [
    { type: SEG_LINE, p1: [0, 0], p2: [100, 0] },
    { type: SEG_LINE, p1: [100, 0], p2: [100, 100] },
    { type: SEG_LINE, p1: [100, 100], p2: [0, 100] },
    { type: SEG_LINE, p1: [0, 100], p2: [0, 0] },
  ],
];
const mesh = (o) => ({
  interior: new Float32Array(0),
  edges: [],
  quads: [],
  cubics: [],
  circles: [],
  annuli: [],
  stripArcs: [],
  fallback: [],
  ...o,
});
// 50 unit^2 of triangle for a 10000 unit^2 square: the bound is 0.005 of the true area.
const starved = mesh({ interior: new Float32Array([0, 0, 10, 0, 0, 10]) });
const declined = mesh({ fallback: [{}] });
if (hasFn) {
  ok(
    meshUnderCovers(starved, sq) === true,
    'the bound flags a partition covering 0.5% of its square',
  );
  ok(
    cdtMeshAccepted(starved) === true,
    '...and the partition route accepts it: the route does not ask the bound',
  );
  ok(cdtMeshAccepted(declined) === false, 'a CDT that reported a fallback is refused');
  ok(cdtMeshAccepted(null) === false, 'a null CDT is refused');
  // A switch the route does not read must stay inert if a page sets it.
  globalThis.__LB_CDT_COVER_GUARD = true;
  ok(cdtMeshAccepted(starved) === true, 'a leftover __LB_CDT_COVER_GUARD global arms nothing');
  delete globalThis.__LB_CDT_COVER_GUARD;
}

// ── 1b. THE NUMBER THE BOUND DIVIDES BY ──────────────────────────────────────────────────────
// `contourAreaExact` is a LOOP integral, and its per-segment terms carry the coordinates
// themselves: they telescope to an area only once the path returns to where it started. Fed an
// OPEN contour it keeps whatever the missing closing chord would have contributed, which is
// proportional to the POSITION — so the same shape would report a different area depending on where
// it is laid out, and the bound's ratio with it.
{
  const { contourAreaExact } = CORE;
  const move = (cs, d) =>
    cs.map((c) =>
      c.map((sg) => {
        const P = (p) => (p ? [p[0] + d, p[1] + d] : p);
        const o = { ...sg };
        for (const k of ['p1', 'p2', 'p3', 'p4']) if (sg[k]) o[k] = P(sg[k]);
        return o;
      }),
    );
  // An OPEN square: three sides, no closing line. Closed by a chord it is 100 x 100.
  const openSq = [
    [
      { type: SEG_LINE, p1: [0, 0], p2: [100, 0] },
      { type: SEG_LINE, p1: [100, 0], p2: [100, 100] },
      { type: SEG_LINE, p1: [100, 100], p2: [0, 100] },
    ],
  ];
  const a0 = contourAreaExact(openSq);
  ok(
    Math.abs(a0 - 10000) < 1e-6,
    `an open square's area is the closed one: ${a0.toFixed(6)} (want 10000)`,
  );
  for (const d of [1e3, 1e5]) {
    const ad = contourAreaExact(move(openSq, d));
    ok(
      Math.abs(ad - a0) <= 1e-6 * Math.max(a0, 1),
      `...and it is the SAME area moved by ${d}: ${ad.toFixed(6)}`,
    );
  }
  // A CLOSED contour must not move by a bit: the chord has zero length and contributes zero.
  const closedSq = [[...openSq[0], { type: SEG_LINE, p1: [0, 100], p2: [0, 0] }]];
  ok(
    contourAreaExact(closedSq) === contourAreaExact(openSq),
    'a closed contour is bit-identical to the open one the chord completes',
  );
  ok(
    Math.abs(contourAreaExact(move(closedSq, 1e3)) - 10000) < 1e-6,
    'a closed square keeps its area wherever it is laid out',
  );
}

// ── 2. THERE IS ONE ACCEPT SITE, AND IT ASKS ─────────────────────────────────────────────────
// A predicate nothing calls is a comment — and two build paths that each keep their own copy of
// the rule let one of them skip asking. The route lives in ONE place, so the check is that no
// second copy exists rather than that both copies ask.
const strip = (file) =>
  readFileSync(path.join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
{
  const core = strip('src/renderer/lbBuildCore.js');
  ok(/\bcdtMeshAccepted\s*\(/.test(core), 'buildLbShape — the one route — calls cdtMeshAccepted');
  const bare = core.match(/if\s*\(\s*cdt9?\s*&&\s*!\s*cdt9?\.fallback\.length/g);
  ok(
    !bare,
    `...with no bare \`!cdt.fallback.length\` accept left${bare ? ' — ' + bare.length + ' remain' : ''}`,
  );
  const md = strip('src/renderer/morphDraw.js');
  ok(/\bbuildLbShape\s*\(/.test(md), "the main thread's _ensureLbMeshes delegates to buildLbShape");
  // The route predicates are what a SECOND copy of the route would have to consult, so their
  // absence here is the property: no fast-vs-CDT decision may be taken in this file.
  for (const p of [
    'fastMeshAccepted',
    'cdtMeshAccepted',
    'contoursAllStraight',
    'hasDisjointContours',
  ]) {
    ok(
      !new RegExp('\\b' + p + '\\s*\\(').test(md),
      `...and takes no route decision of its own (no ${p} in morphDraw.js)`,
    );
  }
}

// ── 3. end to end: every row the bound would flag on tiger's partition route draws no fill ──────
const TIGER = path.resolve(ROOT, 'examples/tiger.svg');
if (!existsSync(TIGER)) {
  console.log('  SKIP the end-to-end case: examples/tiger.svg is absent');
} else if (!hasFn) {
  ok(false, 'the end-to-end case needs cdtMeshAccepted, which is absent');
} else {
  const xd = await import('@xmldom/xmldom');
  globalThis.DOMParser = globalThis.DOMParser || xd.DOMParser;
  globalThis.XMLSerializer = globalThis.XMLSerializer || xd.XMLSerializer;
  const warn = console.warn;
  console.warn = () => {};
  const { default: importSvg } = await import('../src/svg/importer.js');
  const { parseMetaBin } = await import('../src/renderer/bundle.js');
  const { shapesOf } = await import('../probes/lbAccuracy/_lbRaster.mjs');
  const bundle = await importSvg(readFileSync(TIGER, 'utf8'));
  const { shapes } = await shapesOf(bundle);
  const pm = parseMetaBin(bundle.meta, bundle.metaFloatsPerShape);
  console.warn = warn;
  // A fast-route mesh already passed the bound (fastMeshAccepted), so a flagged mesh is a partition.
  let builtN = 0;
  const flagged = [];
  for (const sh of shapes) {
    let b = null;
    try {
      b = buildLbShape(sh.contours, sh.transSolid, sh.evenOdd);
    } catch {
      b = null;
    }
    if (!b || !b.pk || !b.pk.vertexCount) continue;
    builtN++;
    if (meshUnderCovers(b.raw, sh.contours))
      flagged.push({ s: sh.s, fillAlpha: pm.metaFloats[sh.s * pm.floatsPerShape + 7] });
  }
  // ...AND NONE ON TIGER. Its stroke-only rows have OPEN contours, where the fill region is not defined. The fill
  // builders close an open contour as SVG fills a path (lbContour.js closeOpenContours), so their meshes cover their
  // shape and the bound flags nothing on tiger: a PAINTED fill that under-covers would still fail the second check.
  const names = flagged.map((f) => '#' + f.s + ' (fill alpha ' + f.fillAlpha + ')').join(', ');
  ok(
    flagged.length === 0,
    `tiger: the bound flags none of ${builtN} partition meshes (open contours are closed before the build)` +
      (flagged.length ? ` — got ${names}` : ''),
  );
  ok(
    flagged.every((f) => f.fillAlpha === 0),
    `tiger: ...and any it did flag would draw NO fill, so accepting it costs no ink`,
  );
}

console.log(fail ? `LB-CDT-COVER-GUARD FAIL (${fail})` : 'LB-CDT-COVER-GUARD OK');
process.exit(fail ? 1 : 0);
