// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchLeakWidthSmoke — a leak has a WIDTH, and it is a number, not a yes/no about the caller's bar.
//
// `leakOfInner` reports how far past its own arcs a patch's half-space conjunction reaches (`depth`). How much
// of the conjunction stands behind it there -- the width -- must be a number too. Answering only with a
// verdict -- handing in a probe step (`nudgePx`, defaulting to its own tolerance), stepping half of it off the
// stretch and asking `inPatch` -- says nothing beyond a width the caller has already chosen, so the SEARCH's
// predicate is non-monotone in its own bar and nobody can see what the bar hides.
//
// That is a WIDTH POLICY and it is a defensible one for the search -- a cut costs a patch and a seam, and a
// seam across a thin feature drops the ramp that feature needed -- but it has to be STATED, and the width has
// to be reported so each caller can state its own. This pins:
//
//   (1) every leak carries a finite `width >= 0` beside its `depth`;
//   (2) the width is exactly SCALE-EQUIVARIANT -- scale the artwork by 2^k and the width scales by 2^k;
//   (3) depth and width are INDEPENDENT: the corpus carries leaks that are deep AND narrower than the search's
//       own bar, which is exactly the population a depth-only reading cannot separate;
//   (4) the policy is a parameter. `minWidthPx` moves the emptiness escape and `samePx` moves the
//       same-algebraic-curve threshold, SEPARATELY, and the default reproduces the
//       shipped verdict exactly;
//   (5) `measuredWidth: true` compares the MEASURED width to the policy instead of asking the policy's own
//       probe, and is available but off by default, because every decomposition in the corpus is searched
//       under the probe.
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// This pins the SEARCH's leak predicate, so the corpus must keep reaching the search: the extracted-cycle complete-paint area
// would take the crossing paints before any patch exists.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__CP_NO_CYCLE_AREA = 1;
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { headlessCPatchBundle, contoursToConverter, shapeEvenOdd, cpatchCurvePlane } =
  await import('../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { circleFromContours, ellipseFromContours } = await import('../src/geom/shapeRecognize.js');
const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
const { leakOfInner } = await import('../src/renderer/cpatchConvert.js');
const { SEG_LINE, SEG_QUAD, SEG_CUBIC, mkLine, mkQuad, mkCubic, mkRQuad } =
  await import('../src/primitives/seg.js');

const FILE = path.resolve(ROOT, 'examples/tiger.svg');
if (!existsSync(FILE)) {
  console.log('SKIP cpatchLeakWidthSmoke: tiger.svg not present');
  process.exit(0);
}
const TOL = 0.05,
  MAXS = 25;
const _w = console.warn;
console.warn = () => {};
const bundle = headlessCPatchBundle(await importSvg(readFileSync(FILE, 'utf8')));
const cf = cpatchCurvePlane(bundle);
const ranges = bundle.curveRangesByShape || [];

const scaleContours = (cs, S) =>
  cs.map((c) =>
    c.map((sg) => {
      const P = (q) => q && [q[0] * S, q[1] * S];
      if (sg.type === SEG_LINE) return mkLine(P(sg.p1), P(sg.p2), sg.is_fill_only);
      if (sg.type === SEG_QUAD) return mkQuad(P(sg.p1), P(sg.p2), P(sg.p3));
      if (sg.type === SEG_CUBIC) return mkCubic(P(sg.p1), P(sg.p2), P(sg.p3), P(sg.p4));
      const c0 = sg.circle;
      return mkRQuad(
        P(sg.p1),
        P(sg.p2),
        P(sg.p3),
        sg.w,
        c0 ? { cx: c0.cx * S, cy: c0.cy * S, r: c0.r * S } : null,
      );
    }),
  );
const patchesOf = (contours, s) => {
  const cs = contoursToConverter(contours, null);
  if (!cs) return [];
  const out = [];
  try {
    packCPatchShape(cs, 0, {
      evenOdd: shapeEvenOdd(bundle, s),
      cycleCache: new Map(),
      search: 'full',
      onPatches: (a) => out.push(...a),
    });
  } catch {
    return [];
  }
  return out;
};
// THE GATE'S QUESTION (the patch's BOX, which is what the renderer's fence is) rather than the search's
// COVER HULL: a finished patch is valid against its hull by construction, so the search's own call returns
// null on every one of them and a comparison there is vacuous.
const GATE = (ext) => ({
  nudgePx: ext > 0 ? (0.02 / 256) * ext : TOL,
  monotone: true,
  anyStretch: true,
  box: true,
});

const shapes = [];
for (let s = 0; s < ranges.length && shapes.length < MAXS; s++) {
  const r = ranges[s];
  if (!r) continue;
  let contours = null;
  try {
    contours = curveRangeToContours(cf, r.begin, r.end);
  } catch {
    continue;
  }
  if (!contours || !contours.length) continue;
  if (circleFromContours(contours) || ellipseFromContours(contours)) continue;
  const ps = patchesOf(contours, s);
  if (ps.length) shapes.push({ s, contours, ps });
}
console.warn = _w;
ok(shapes.length >= 10, `${shapes.length} tiger shapes with patches (need 10)`);

// ---- (1) every leak carries a width ---------------------------------------------------------------------
const leaks = [];
{
  let n = 0,
    noWidth = 0,
    bad = 0;
  for (const { s, ps } of shapes)
    for (let pi = 0; pi < ps.length; pi++) {
      const ext = Math.max(ps[pi].bbox[2] - ps[pi].bbox[0], ps[pi].bbox[3] - ps[pi].bbox[1]);
      let lk = null;
      try {
        lk = leakOfInner(ps[pi], TOL, 0, GATE(ext));
      } catch {
        lk = null;
      }
      if (!lk) continue;
      n++;
      if (!('width' in lk)) {
        noWidth++;
        continue;
      }
      if (!Number.isFinite(lk.width) || lk.width < 0 || lk.width > ext * 2) bad++;
      else leaks.push({ s, pi, ext, depth: lk.depth, width: lk.width });
    }
  ok(n >= 50, `${n} leaks to look at (need 50)`);
  ok(
    noWidth === 0 && bad === 0,
    `(1) every leak carries a finite width in [0, 2*extent] beside its depth (${noWidth} with no width field, ${bad} out of range)`,
  );
}

// ---- (2) the width scales with the artwork ---------------------------------------------------------------
{
  let checked = 0,
    bad = 0,
    worst = 0,
    row = '',
    zeros = 0;
  for (const { s, contours, ps } of shapes) {
    for (const k of [-8, 8]) {
      const S = Math.pow(2, k),
        sc = patchesOf(scaleContours(contours, S), s);
      if (sc.length !== ps.length) continue;
      for (let pi = 0; pi < ps.length; pi++) {
        const eA = Math.max(ps[pi].bbox[2] - ps[pi].bbox[0], ps[pi].bbox[3] - ps[pi].bbox[1]);
        const eB = Math.max(sc[pi].bbox[2] - sc[pi].bbox[0], sc[pi].bbox[3] - sc[pi].bbox[1]);
        let a = null,
          b = null;
        try {
          a = leakOfInner(ps[pi], TOL, 0, GATE(eA));
        } catch {
          a = null;
        }
        try {
          b = leakOfInner(sc[pi], TOL * S, 0, GATE(eB));
        } catch {
          b = null;
        }
        if (!a || !b) continue;
        // A ZERO width must stay zero, and a positive one must scale by exactly 2^k.
        if (!(a.width > 0)) {
          zeros++;
          if (b.width !== 0) {
            bad++;
            row = `#${s} p${pi} at 2^${k}: 0 -> ${b.width}`;
          }
          continue;
        }
        checked++;
        const rel = Math.abs(b.width / S - a.width) / a.width;
        if (rel > worst) {
          worst = rel;
          row = `#${s} p${pi} at 2^${k}: ${a.width.toExponential(6)} vs ${(b.width / S).toExponential(6)}`;
        }
        if (rel > 1e-9) bad++;
      }
    }
  }
  ok(
    checked >= 10 && bad === 0,
    `(2) the width scales with the artwork: ${checked} positive-width leaks at 2^-8 and 2^8 (plus ${zeros} that are zero at both), ${bad} off by more than 1e-9 relative (worst ${worst.toExponential(3)} ${row})`,
  );
}

// ---- (3) depth and width are independent -----------------------------------------------------------------
if (!leaks.length)
  ok(false, '(3) no leak carried a usable width, so depth-vs-width cannot be read');
else {
  const ds = leaks.map((l) => l.depth).sort((a, b) => a - b);
  const med = ds[ds.length >> 1];
  const deep = leaks.filter((l) => l.depth > med);
  const deepNarrow = deep.filter((l) => l.width < TOL);
  ok(
    deepNarrow.length > 0 && deepNarrow.length < deep.length,
    `(3) depth and width do not track: of ${deep.length} leaks deeper than the median (${med.toFixed(3)}), ${deepNarrow.length} are narrower than the search's own bar ${TOL} and ${deep.length - deepNarrow.length} are not`,
  );
  ok(
    leaks.some((l) => l.width === 0) && leaks.some((l) => l.width > TOL),
    `(3) ...and both ends exist: ${leaks.filter((l) => l.width === 0).length} leaks hold no area at all just inside the curve, ${leaks.filter((l) => l.width > TOL).length} are wider than ${TOL} (widest ${Math.max(...leaks.map((l) => l.width)).toFixed(3)})`,
  );
}

// ---- (4) the policy is a parameter, and the default is the shipped verdict --------------------------------
{
  let same = 0,
    movedByWidth = 0,
    movedBySame = 0,
    total = 0;
  for (const { ps } of shapes)
    for (let pi = 0; pi < ps.length; pi++) {
      total++;
      const base = (() => {
        try {
          return leakOfInner(ps[pi], TOL, 0, { box: true });
        } catch {
          return null;
        }
      })();
      const explicit = (() => {
        try {
          return leakOfInner(ps[pi], TOL, 0, { box: true, minWidthPx: TOL, samePx: TOL });
        } catch {
          return null;
        }
      })();
      const wideBar = (() => {
        try {
          return leakOfInner(ps[pi], TOL, 0, { box: true, minWidthPx: TOL * 64 });
        } catch {
          return null;
        }
      })();
      const sameBar = (() => {
        try {
          return leakOfInner(ps[pi], TOL, 0, { box: true, samePx: TOL * 1e6 });
        } catch {
          return null;
        }
      })();
      if (
        !!base === !!explicit &&
        (!base || (base.t === explicit.t && base.depth === explicit.depth))
      )
        same++;
      if (!!base !== !!wideBar) movedByWidth++;
      if (!!base !== !!sameBar) movedBySame++;
    }
  ok(
    same === total,
    `(4) stating the default explicitly ({minWidthPx: tolPx, samePx: tolPx}) is the shipped verdict on all ${total} patches (${total - same} differ)`,
  );
  ok(
    movedByWidth > 0,
    `(4) ...and the width policy is live: a 64x wider minWidthPx moves ${movedByWidth} of ${total} patches`,
  );
  ok(
    movedBySame > 0,
    `(4) ...and samePx is a SEPARATE knob: a 1e6x samePx moves ${movedBySame} of ${total} patches on its own`,
  );
}

// ---- (5) the measured predicate is available, and named ---------------------------------------------------
{
  let leaked = 0,
    moved = 0;
  const rows = [];
  for (const { s, ps } of shapes)
    for (let pi = 0; pi < ps.length; pi++) {
      const a = (() => {
        try {
          return leakOfInner(ps[pi], TOL, 0, { box: true });
        } catch {
          return null;
        }
      })();
      const b = (() => {
        try {
          return leakOfInner(ps[pi], TOL, 0, { box: true, measuredWidth: true });
        } catch {
          return null;
        }
      })();
      if (a || b) leaked++;
      if (!!a !== !!b || (a && b && (a.t !== b.t || a.depth !== b.depth))) {
        moved++;
        if (rows.length < 4)
          rows.push(
            `#${s} p${pi}: probe ${a ? `d=${a.depth.toFixed(4)} w=${a.width.toExponential(2)}` : 'none'} -> measured ${b ? `d=${b.depth.toFixed(4)} w=${b.width.toExponential(2)}` : 'none'}`,
          );
      }
    }
  ok(
    leaked >= 20,
    `(5) ${leaked} patches leak under the search's ask, so this comparison is not vacuous`,
  );
  ok(
    moved * 20 < leaked,
    `(5) measuredWidth agrees with the probe on all but ${moved} of them${rows.length ? ' -- ' + rows.join('; ') : ''}`,
  );
}

if (fail) {
  console.error(`CPATCH-LEAK-WIDTH FAIL (${fail})`);
  process.exit(1);
}
console.log('CPATCH-LEAK-WIDTH PASS');
