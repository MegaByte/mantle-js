// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbInvisibleBoundaryScaleSmoke — the static partition's INVISIBLE-BOUNDARY probe asks the same question at
// every drawing size.
//
// A cubic piece's `ccx9` (which side of the curve is ink, so which side the crescent paints) and its
// `invis9` (both sides ink, so the piece fills SOLID and carries no crescent frame at all) both come from an
// ink probe placed at `cm9 ± (n/nl)·off`. Whether that probe RUNS must not be gated on an absolute em length
// (`nl9 > 1e-12 && chord9 > 1e-12` on the cubic branch, `nl9 < 1e-9` on the quad branch): the same piece would
// be probed at one drawing size and skipped at another, and neither answer is a ramp: one flips which side
// of the outline is painted, the other replaces a crescent with solid.
//
// The bar is `emEps()`, one float32 ulp of the shape's own extent -- the unit this builder is written
// against, and the one the MORPH PAIR's twin of this very test uses. It is not a
// tolerance: below it `cm9 ± (n/nl)·off` is the same packed position twice, so the two `inkAt` calls read one
// point and "both sides are ink" is whatever that point happens to be.
//
//   (a) asset-free: the per-piece (sign, invis) vector of buildLoopBlinnPartition on in-repo cubic artwork is
//       the same at every exponent of a ladder;
//   (b) tiger #112/grow and #114/grow under the morph probe's 16384-unit offset, where an absolute gate
//       moves the t-segmenter's own 24-cell oracle scan between 2^0 and 2^-8..2^-20.
//       With examples/tiger.svg not fetched, the same scan runs on two shapes of test/_tigerOrFixture.mjs's generated art.
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { tigerOrFixture, tigerIsPresent } from './_tigerOrFixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const { parseMetaBin } = await import('../src/core/metaBin.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { buildLoopBlinnPartition } = await import('../src/renderer/lbPartition.js');
const { buildLoopBlinnPartitionPair } = await import('../src/renderer/lbPartitionPair.js');
const { SEG_LINE, SEG_QUAD, SEG_CUBIC, mkLine, mkQuad, mkCubic, mkRQuad } =
  await import('../src/primitives/seg.js');
const _warn = console.warn;
console.warn = () => {};

const f32 = new Float32Array(1);
const r32 = (v) => {
  f32[0] = v;
  return f32[0];
};
/// Rebuilt through the constructors, never spread: a spread copy carries the builders' memoised implicit and
/// packed forms under symbols, and those would describe the PRE-transform curve.
const mapContours = (cs, P, circ) =>
  cs.map((c) =>
    c.map((sg) => {
      if (sg.type === SEG_LINE) return mkLine(P(sg.p1), P(sg.p2), sg.is_fill_only);
      if (sg.type === SEG_QUAD) return mkQuad(P(sg.p1), P(sg.p2), P(sg.p3));
      if (sg.type === SEG_CUBIC) return mkCubic(P(sg.p1), P(sg.p2), P(sg.p3), P(sg.p4));
      return mkRQuad(P(sg.p1), P(sg.p2), P(sg.p3), sg.w, sg.circle ? circ(sg.circle) : null);
    }),
  );
const scaled = (cs, S) =>
  mapContours(
    cs,
    (q) => q && [q[0] * S, q[1] * S],
    (c) => ({ cx: c.cx * S, cy: c.cy * S, r: c.r * S }),
  );
const OFF = 16384;
const offScaled = (cs, S) =>
  mapContours(
    cs,
    (q) => q && [r32((q[0] + OFF) * S), r32((q[1] + OFF) * S)],
    (c) => ({ cx: r32((c.cx + OFF) * S), cy: r32((c.cy + OFF) * S), r: r32(c.r * S) }),
  );

/// The per-piece facts the ink probe decides: whether the piece is an invisible boundary, and which side its
/// crescent paints. Both are the probe's, and both change the mesh.
function pieceFacts(contours, evenOdd) {
  let p = null;
  try {
    p = buildLoopBlinnPartition(contours, { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
  } catch {
    return null;
  }
  if (!p || !p.cubicRecs9) return null;
  return p.cubicRecs9
    .map((r) => `${r.ci9}.${r.si9}.${r.pi9}${r.invis9 ? 'I' : 'v'}${r.sign > 0 ? '+' : '-'}`)
    .join(' ');
}

/// The morph probe's own import, so the shape INDICES named above (#112, #114) are these shapes:
/// probes/morphScale/_morphPairs.mjs strips strokes before importing, and a stroke row shifts the numbering.
const strip = (s) =>
  s.replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"').replace(/stroke-width\s*=\s*"[^"]*"/g, '');

async function shapesOf(source, want) {
  const text = want ? source : readFileSync(source, 'utf8');
  const b = await importSvg(want ? strip(text) : text, { preserveViewport: true });
  const m = parseMetaBin(b.meta, b.metaFloatsPerShape),
    fps = m.floatsPerShape;
  const plane = new Float32Array(b.curves),
    ranges = b.curveRangesByShape || [];
  const out = [];
  for (let s = 0; s < m.numShapes; s++) {
    if (want && !want.has(s)) continue;
    const r = ranges[s];
    if (!r || r.end <= r.begin || !(m.metaFloats[s * fps + 7] > 0)) continue;
    let cs = null;
    try {
      cs = curveRangeToContours(plane, r.begin, r.end);
    } catch {
      continue;
    }
    if (!cs || !cs.length) continue;
    out.push({ s, cs, evenOdd: m.metaFloats[s * fps + 13] > 0.5 });
  }
  return out;
}

// ---- (a) the per-piece facts, at a ladder of drawing sizes -----------------------------------------------
// ABSOLUTE floors are em lengths, so for any piece there is a size at which its nl9 falls under them
// while the shape is otherwise perfectly healthy: an ordinary 100-unit cubic reaches 1e-12 at about 2^-47.
// That is the whole defect -- the question changes with the size -- and the ladder is where it shows.
{
  const LADDER = [-20, -40, -44, -48, 8, 20];
  const { readdirSync } = await import('fs');
  const files = [];
  for (const d of ['examples', 'examples/smoke']) {
    const p = path.join(ROOT, d);
    if (existsSync(p))
      for (const f of readdirSync(p)
        .filter((x) => x.endsWith('.svg'))
        .sort())
        files.push(path.join(p, f));
  }
  // Every shape of every file, with no cap: tiger, sorted first, would use up a small one and leave the even-odd rings further down the list unchecked.
  let checked = 0,
    moved = 0;
  const rows = [];
  for (const f of files) {
    let ss = [];
    try {
      ss = await shapesOf(f, null);
    } catch {
      continue;
    }
    for (const { s, cs, evenOdd } of ss) {
      const base = pieceFacts(cs, evenOdd);
      if (!base || !base.length) continue;
      checked++;
      for (const k of LADDER) {
        const got = pieceFacts(scaled(cs, Math.pow(2, k)), evenOdd);
        if (got !== base) {
          moved++;
          if (rows.length < 5) rows.push(`${path.basename(f)} #${s} at 2^${k}`);
          break;
        }
      }
    }
  }
  ok(checked >= 40, `(a) ${checked} in-repo cubic shapes with pieces to look at`);
  ok(
    moved === 0,
    `(a) the per-piece (sign, invisible) facts are the same at 2^${LADDER.join(', 2^')}: ${moved} of ${checked} shapes move${rows.length ? ' (' + rows.join(', ') + ')' : ''}`,
  );
}

// ---- (b) tiger #112 and #114 under the morph probe's offset ------------------------------------------------------------------------
// `examples/tiger.svg` is what scripts/fetchTestFixtures.mjs (the `pretest` hook) puts there.
{
  // The pair the morph probe builds: the shape morphed to a 1.1x, 0.05rad rotation of itself about its own
  // centroid (probes/morphScale/_morphPairs.mjs `selfPairs`), then translated by 16384 and scaled -- and the
  // translate is rounded into float32 the way a translated plane arrives. Multiplying by a power of two
  // commutes with that rounding, so offset@2^k is exactly 2^k times offset@1: any difference in the answer is
  // an absolute bar, never the offset's own rounding.
  // With the tiger absent, two generated shapes of the lumpy kind (even rows) that are not even-odd.
  const want = new Set(tigerIsPresent() ? [112, 114] : [2, 4]);
  const shapes = await shapesOf(tigerOrFixture(), want);
  ok(
    shapes.length === 2,
    `(b) art shapes ${[...want].join(' and ')} decoded (${shapes.length} of 2)`,
  );
  for (const { s, cs, evenOdd } of shapes) {
    let cx = 0,
      cy = 0,
      n = 0;
    for (const c of cs)
      for (const sg of c)
        for (const q of [sg.p1, sg.p2, sg.p3, sg.p4])
          if (q) {
            cx += q[0];
            cy += q[1];
            n++;
          }
    cx /= n;
    cy /= n;
    const ca = Math.cos(0.05),
      sa = Math.sin(0.05),
      K = 1.1;
    const dst = mapContours(
      cs,
      (q) =>
        q && [
          cx + ((q[0] - cx) * ca - (q[1] - cy) * sa) * K,
          cy + ((q[0] - cx) * sa + (q[1] - cy) * ca) * K,
        ],
      (c) => ({ cx: cx + (c.cx - cx) * K, cy: cy + (c.cy - cy) * K, r: c.r * K }),
    );
    const lerp = (a, b, t) => {
      if (t <= 0) return a;
      if (t >= 1) return b;
      const u = 1 - t,
        lp = (p, q) => [p[0] * u + q[0] * t, p[1] * u + q[1] * t];
      return a.map((ac, ci) =>
        ac.map((ss, si) => {
          const ds = b[ci][si];
          if (ss.type === SEG_LINE)
            return mkLine(lp(ss.p1, ds.p1), lp(ss.p2, ds.p2), ss.is_fill_only);
          if (ss.type === SEG_QUAD)
            return mkQuad(lp(ss.p1, ds.p1), lp(ss.p2, ds.p2), lp(ss.p3, ds.p3));
          if (ss.type === SEG_CUBIC)
            return mkCubic(lp(ss.p1, ds.p1), lp(ss.p2, ds.p2), lp(ss.p3, ds.p3), lp(ss.p4, ds.p4));
          return mkRQuad(lp(ss.p1, ds.p1), lp(ss.p2, ds.p2), lp(ss.p3, ds.p3), ss.w, null);
        }),
      );
    };
    const rule = evenOdd ? 'evenodd' : 'nonzero';
    // The segmenter's own oracle: 24 cells, each asking whether the pair builds over that interval of t.
    const scan = (S) => {
      const sc = offScaled(cs, S),
        dc = offScaled(dst, S),
        v = [];
      for (let i = 0; i < 24; i++) {
        let r = false;
        try {
          r = !!buildLoopBlinnPartitionPair(
            lerp(sc, dc, i / 24),
            lerp(sc, dc, (i + 1) / 24),
            rule,
            { plainDstRows: true },
          );
        } catch {
          r = false;
        }
        v.push(r ? 1 : 0);
      }
      return v.join('');
    };
    const base = scan(1),
      at8 = scan(Math.pow(2, -8)),
      at20 = scan(Math.pow(2, -20));
    ok(
      base === at8 && base === at20,
      `(b) art #${s}/grow: the 24-cell oracle scan is the same at 2^0, 2^-8 and 2^-20 (${base} / ${at8} / ${at20})`,
    );
  }
}

console.warn = _warn;
if (fail) {
  console.error(`LB-INVISIBLE-BOUNDARY-SCALE FAIL (${fail})`);
  process.exit(1);
}
console.log('LB-INVISIBLE-BOUNDARY-SCALE PASS');
