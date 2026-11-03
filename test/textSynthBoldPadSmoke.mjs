// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// textSynthBoldPadSmoke — emitShape sizes its row for the STROKE it carries.
//
// svg/buildContext.js `emitShape` is the shared per-shape emit that font/textRun.js and
// font/textColrEmit.js use for every glyph. Synthetic bold goes through it as a 0.04 em stroke in
// the run's own color ON TOP of the fill (there is no bold face to select), so that row paints a
// stroke. Sized from the PATH box -- band-membership pad 0, cover-quad pad 0, and the meta bbox
// path-tight -- the outer half of the synthesised weight would have no fragments wherever the
// outline touches its own bbox: the left and right of every stem, the top and bottom of every bar.
// At 64 px per em that is the outer 1.28 px of each extreme edge.
//
// The row carries the two boxes svg/bundleFinalize.js keeps for a stroke row, which are not
// interchangeable: the meta bbox is path + halfW and the bands are BINNED through that same
// box, while the band-membership pad and the cover quad take the whole reach from
// src/bundle/strokeReach.js.
//
//   (a) A/B on bundles built straight through emitShape from seeded closed quad contours at glyph
//       scale: how many pixel centers the stroke inks fall outside the cover quad, and how many the
//       band walk cannot reach, path-box sized and stroke-box sized;
//   (b) the real thing, if the Roboto fixture is present: a synthetically bolded run's glyph rows;
//   (c) RECORDED, NOT ASSERTED: the bbox accumulator that becomes a text bundle's globalBBox is
//       the PATH box, so a bold run's ink reaches halfW outside its own framing box;
//   (d) the source.
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { makeCurveCases, minDistCurve } from './_strokeCurveRef.mjs';
import { makeStrokeEmu } from './_strokeBandEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { packMetaBody } = await import('../src/svg/meta.js');
const { texelToBytes } = await import('../src/svg/textures.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const t0 = Date.now();

// ---- buildContext.js, as shipped and path-box sized ---------------------------------------------
const BC_PATH = path.join(ROOT, 'src/svg/buildContext.js');
const BC_SRC = readFileSync(BC_PATH, 'utf8');
const loadBC = (src) => {
  const abs = src.replace(
    /from '(\.\.?\/[^']+)'/g,
    (m, rel) => `from '${new URL(rel, pathToFileURL(BC_PATH)).href}'`,
  );
  return import('data:text/javascript;base64,' + Buffer.from(abs).toString('base64'));
};
const PAD_HINGE = `  const strokePad = hasStroke
    ? halfW * strokeReachFactor(opts.joinStyle | 0, opts.miterLimit ?? 4, opts.capStyle | 0,
                                opts.endCapStyle == null ? (opts.capStyle | 0) : opts.endCapStyle)
    : 0;
  const bbMeta = hasStroke ? [bb[0] - halfW, bb[1] - halfW, bb[2] + halfW, bb[3] + halfW] : bb;`;
ok(BC_SRC.includes(PAD_HINGE), 'mutation hinge present: the pad and the meta box');
const SHIPPED = await loadBC(BC_SRC);
const PRE_FIX = await loadBC(
  BC_SRC.replace(PAD_HINGE, '  const strokePad = 0;\n  const bbMeta = bb;'),
);

/** One shape through emitShape, packed into the sections dict the band emulator reads. */
function emitBundle(BC, segs, opts) {
  const ctx = BC.makeBuildContext({});
  const gidBox = { next: 1 };
  BC.emitShape(ctx, segs, opts, gidBox, null);
  const body = packMetaBody(ctx.metas);
  const meta = new ArrayBuffer(32 + body.byteLength);
  const dv = new DataView(meta);
  dv.setUint32(0, ctx.metas.length, true);
  new Uint8Array(meta, 32).set(body);
  return {
    numShapes: ctx.metas.length,
    metaFloatsPerShape: 48,
    meta,
    curves: texelToBytes(ctx.curveBuf).buffer,
    bands: texelToBytes(ctx.bandBuf).buffer,
    curveGeom: new Float32Array(ctx.hybridFloats).buffer,
  };
}

// ---- (a) the A/B -------------------------------------------------------------------------------
// Closed quad contours at glyph scale, stroked the way synthetic bold strokes a glyph: the fill's
// own color, 0.04 em wide, miter joins at limit 4, no free ends. The reference is the PORT over
// every segment -- no bands, no cover quad -- so this measures REACH and not the stroke rule.
const HALF_W = 0.02,
  SW = 2 * HALF_W;
const glyphCases = makeCurveCases(0x51de, 600)
  .filter((cs) => cs.closed && cs.segs.length >= 3)
  .slice(0, 90)
  .map((cs) => {
    // rescale each chain into a ~1 em box, the size a glyph outline lands at
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const [a, b, c] of cs.Q)
      for (const p of [a, b, c]) {
        x0 = Math.min(x0, p[0]);
        y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]);
        y1 = Math.max(y1, p[1]);
      }
    const s = 0.7 / Math.max(x1 - x0, y1 - y0, 1e-9);
    const Q = cs.Q.map((seg) => seg.map(([x, y]) => [(x - x0) * s, (y - y0) * s]));
    return { Q, segs: null, closed: true };
  });
{
  const { quadSegs } = await import('./_strokeCurveRef.mjs');
  const SEG_QUAD = 1;
  const toImporterSegs = (Q) => Q.map(([p1, p2, p3]) => ({ type: SEG_QUAD, p1, p2, p3 }));
  const opts = {
    fillRgba: [0, 0, 0, 1],
    strokeRgba: [0, 0, 0, 1],
    strokeWidth: SW,
    joinStyle: 0,
    miterLimit: 4,
    capStyle: 0,
  };
  // one em is 64 device pixels, which is ordinary body text
  const PX = 64;
  let nInk = 0,
    outQuadPre = 0,
    outQuadNew = 0,
    unreachedPre = 0,
    unreachedNew = 0;
  for (const cs of glyphCases) {
    const segs = toImporterSegs(cs.Q);
    const qs = quadSegs(cs.Q, true);
    const bPre = emitBundle(PRE_FIX, segs, opts),
      bNew = emitBundle(SHIPPED, segs, opts);
    // evaluate in PIXEL space: scale the bundle's em by PX by walking pixel centers in em
    const ePre = makeStrokeEmu(bPre, 0, { kind: 'quad' });
    const eNew = makeStrokeEmu(bNew, 0, { kind: 'quad' });
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const [a, b, c] of cs.Q)
      for (const p of [a, b, c]) {
        x0 = Math.min(x0, p[0]);
        y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]);
        y1 = Math.max(y1, p[1]);
      }
    const pad = HALF_W * 4 + 2 / PX;
    for (let py = Math.floor((y0 - pad) * PX); py <= Math.ceil((y1 + pad) * PX); py++)
      for (let px = Math.floor((x0 - pad) * PX); px <= Math.ceil((x1 + pad) * PX); px++) {
        const c = [(px + 0.5) / PX, (py + 0.5) / PX];
        // the port over every segment: no bands, no quad
        if (!(minDistCurve('fixed', c, qs, HALF_W, 0, 0, 4).minD <= HALF_W)) continue;
        nInk++;
        const rp = ePre.eval(c),
          rn = eNew.eval(c);
        if (!rp.inQuad) outQuadPre++;
        else if (!(rp.minD <= HALF_W * (1 + 1e-5))) unreachedPre++;
        if (!rn.inQuad) outQuadNew++;
        else if (!(rn.minD <= HALF_W * (1 + 1e-5))) unreachedNew++;
      }
  }
  ok(
    nInk > 20000 && outQuadPre > 0 && outQuadNew === 0 && unreachedNew === 0,
    `(a) over ${glyphCases.length} glyph-scale contours at ${PX} px per em, of ${nInk} pixel centers the synthetic-bold stroke inks: ` +
      `outside the cover quad ${outQuadPre} -> ${outQuadNew}, unreached by the band walk ${unreachedPre} -> ${unreachedNew}`,
  );
  ok(
    outQuadPre / nInk > 0.01,
    `(a) that is ${((100 * outQuadPre) / nInk).toFixed(1)}% of the stroke's own ink, all of it the outer edge of the synthesised weight`,
  );
}

// ---- (b) a real synthetically bolded run --------------------------------------------------------
{
  const FIXTURE = path.join(ROOT, 'test/font/fixtures/roboto-regular.ttf');
  if (!existsSync(FIXTURE)) {
    console.log('  SKIP (b) roboto fixture not fetched (run scripts/fetchTestFixtures.mjs)');
  } else {
    const { MantleFontAsset } = await import('../src/font/fontAsset.js');
    const { buildTextSections } = await import('../src/font/textSections.js');
    const font = new MantleFontAsset(new Uint8Array(readFileSync(FIXTURE)));
    const { sections } = await buildTextSections(
      font,
      'Hg',
      { fontSizePx: 64, weight: 700, fill: [0, 0, 0, 1] },
      false,
    );
    const meta = new Float32Array(sections.meta, 32),
      st = sections.metaFloatsPerShape | 0;
    const n = Math.floor(meta.length / st);
    const cg = new Float32Array(sections.curveGeom);
    const quadOf = (gid) => {
      for (let o = 0; o + 12 <= cg.length;) {
        const nv = cg[o] | 0;
        if ((cg[o + 1] | 0) === gid) {
          let a = [Infinity, Infinity, -Infinity, -Infinity];
          for (let v = 0; v < nv; v++) {
            const x = cg[o + 12 + v * 12],
              y = cg[o + 12 + v * 12 + 1];
            a = [Math.min(a[0], x), Math.min(a[1], y), Math.max(a[2], x), Math.max(a[3], y)];
          }
          return a;
        }
        o += 12 + nv * 12;
      }
      return null;
    };
    let rows = 0,
      padded = 0,
      quadPadded = 0;
    for (let i = 0; i < n; i++) {
      const o = i * st,
        hw = meta[o + 12] * 0.5;
      if (!(hw > 0)) continue;
      rows++;
      const q = quadOf(meta[o + 14] | 0);
      // the meta bbox is path + halfW and the quad is path + halfW * 4 (miter, limit 4), so the
      // quad stands exactly 3 half-widths outside the meta bbox on every side
      if (
        q &&
        Math.abs(meta[o] - q[0] - 3 * hw) < 1e-4 &&
        Math.abs(q[2] - meta[o + 2] - 3 * hw) < 1e-4
      )
        quadPadded++;
      if (hw > 0) padded++;
    }
    ok(
      rows === 2 && padded === 2 && quadPadded === 2,
      `(b) a synthetically bolded run: ${rows} glyph rows, ${quadPadded} of them with the cover quad standing the stroke's whole reach outside the halfW-padded meta bbox`,
    );
  }
}

// ---- (c) the globalBBox overshoot, measured rather than asserted ---------------------------------
//
// RECORDED, NOT ASSERTED: this section prints the size of the overshoot. The bbox
// accumulator `emitShape` unions into is the PATH box; it becomes a text bundle's globalBBox, which
// is a FRAMING box -- `font/textSections.js` re-builds the run with originX/originY so that box's
// (xmin, ymin) sits at (0, 0), and `renderer/frameLoop.js` fits draws to it (scale
// min(W/bboxW, H/bboxH), centered). So a synthetically bolded run's ink lies OUTSIDE the box the
// renderer fits, by exactly one half-width on each of the four sides, and the fit pushes that band
// off the canvas.
//
// Widening it is not a one-line change: it moves every
// synthetically bolded run. In the non-layout-box branch of textSections the re-build origin
// becomes (-(bbXmin - halfW), -(bbYmin - halfW)), so every glyph TRANSLATES by +halfW in both axes
// and the box grows by 2*halfW on each axis -- which changes the fit scale, so every bold text
// raster changes size and position, and every cached one changes key (renderer/cacheDraw.js keys on
// arScale(globalBBox)). In the LAYOUT-BOX branch globalBBox is pinned to [0, 0, boxW, typoBottom -
// typoTop] and is not the ink box at all, so widening the accumulator would not move it there and
// the overshoot would remain.
{
  const FIXTURE2 = path.join(ROOT, 'test/font/fixtures/roboto-regular.ttf');
  if (!existsSync(FIXTURE2)) {
    console.log('  SKIP (c) roboto fixture not fetched (run scripts/fetchTestFixtures.mjs)');
    ok(
      /\/\/ The PATH box, not the stroke's\. This accumulator becomes a text bundle's globalBBox/.test(
        BC_SRC,
      ),
      '(c) RECORDED in the source, at least: the accumulator is still the PATH box',
    );
  } else {
    const { MantleFontAsset } = await import('../src/font/fontAsset.js');
    const { buildTextSections } = await import('../src/font/textSections.js');
    const font = new MantleFontAsset(new Uint8Array(readFileSync(FIXTURE2)));
    const measure = async (text, weight) => {
      const { sections } = await buildTextSections(
        font,
        text,
        { fontSizePx: 64, weight, fill: [0, 0, 0, 1] },
        false,
      );
      const hdr = new DataView(sections.meta);
      const gbb = [
        hdr.getFloat32(4, true),
        hdr.getFloat32(8, true),
        hdr.getFloat32(12, true),
        hdr.getFloat32(16, true),
      ];
      const meta = new Float32Array(sections.meta, 32),
        st = sections.metaFloatsPerShape | 0;
      let ink = [Infinity, Infinity, -Infinity, -Infinity],
        hw = 0;
      for (let i = 0, n = Math.floor(meta.length / st); i < n; i++) {
        const o = i * st;
        ink = [
          Math.min(ink[0], meta[o]),
          Math.min(ink[1], meta[o + 1]),
          Math.max(ink[2], meta[o + 2]),
          Math.max(ink[3], meta[o + 3]),
        ];
        hw = Math.max(hw, meta[o + 12] * 0.5);
      }
      // the four overshoots, in em: how far the ink reaches outside the framing box
      return {
        gbb,
        hw,
        over: [
          gbb[0] - ink[0],
          gbb[1] - ink[1],
          ink[2] - (gbb[0] + gbb[2]),
          ink[3] - (gbb[1] + gbb[3]),
        ],
      };
    };
    const reg = await measure('Hamburg', 400),
      bold = await measure('Hamburg', 700),
      hg = await measure('Hg', 700);
    ok(
      reg.hw === 0 && reg.over.every((v) => Math.abs(v) < 1e-6),
      "(c) weight 400 carries no stroke and its ink is exactly its globalBBox — the overshoot is synthetic bold's alone",
    );
    ok(
      bold.hw > 0 && bold.over.every((v) => Math.abs(v - bold.hw) < 1e-6),
      `(c) a synthetically bolded "Hamburg" (0.04 em stroke, halfW ${bold.hw}) reaches EXACTLY one half-width outside its own globalBBox on all four sides: [${bold.over.map((v) => v.toFixed(5)).join(', ')}] em`,
    );
    // and what a caller sees: renderer/frameLoop.js fits the content box, so that band is cut
    const cut = (m, px) => m.hw * Math.min(px / m.gbb[2], px / m.gbb[3]);
    ok(
      cut(bold, 256) > 1 && cut(hg, 256) > cut(bold, 256),
      `(c) and a renderer that fits the content box cuts it at the canvas edge: "Hamburg" loses ${cut(bold, 256).toFixed(2)} device px per side at a 256 px viewport and ${cut(bold, 512).toFixed(2)} at 512; the shorter "Hg" scales harder and loses ${cut(hg, 256).toFixed(2)} and ${cut(hg, 512).toFixed(2)}`,
    );
    ok(
      /\/\/ The PATH box, not the stroke's\. This accumulator becomes a text bundle's globalBBox/.test(
        BC_SRC,
      ),
      '(c) RECORDED, NOT FIXED: widening the accumulator translates every glyph of every bolded run by +halfW and changes the fit scale, so it needs a render-lane re-bake — see the note above this check',
    );
  }
}

// ---- (d) the source -------------------------------------------------------------------------------
{
  ok(
    /import \{ strokeReachFactor \} from '\.\.\/bundle\/strokeReach\.js';/.test(BC_SRC),
    '(d) emitShape takes the one reach bound',
  );
  ok(
    /buildTexturesShape\(segs, bandsX, bandsY, bbMeta, ctx\.curveBuf, ctx\.bandBuf, strokePad,/.test(
      BC_SRC,
    ),
    '(d) the bands are binned through the SAME box the shader indexes them by, with the reach as a membership pad',
  );
  ok(
    /getCoverQuadMesh\(segs, gid, fill, opts\.fillRule \|\| 'nonzero', strokePad[,)]/.test(BC_SRC),
    '(d) and the cover quad takes that pad too',
  );
  ok(
    /pickBandsXY\(segs, bbMeta, ctx\.vBands !== false, ctx\.bandK \|\| 32\)/.test(BC_SRC),
    '(d) and the band COUNT is picked from the same box',
  );
}

console.log(
  `${fail ? 'TEXT-SYNTH-BOLD-PAD FAIL' : 'TEXT-SYNTH-BOLD-PAD PASS'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
);
process.exit(fail ? 1 : 0);
