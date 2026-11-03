// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// importerSemanticsRenderSmoke -- the importer, compositing and morph-pose rules that change PIXELS, on the GPU (the
// record-level proofs are the node-lane twins named in each case's notes; this is the rendered check of them).
//
// Each cell renders three documents with the renderer at 128 px (white ground): the document under test, a CONTROL
// that authors the same picture without the feature, and an OLD picture (what an importer without the rule, or a
// renderer with the defect, draws). The render must match its control and must DIFFER from old somewhere, so a pass
// cannot be a picture the defect also draws. The case families share one browser, and each runs on a fresh page with
// its own renderer:
//   importerSemantics      flood style, radial focus, markers, zero-size filter regions, paint fallback, <use> sizes, em
//   importerGeometryAudit  the importer's geometry rules (compat arms included)
//   compositingGroup       mask groups, marker groups and context paints
//   filterLeafGroup        a filtered fill+stroke leaf / <use filter> renders as the equivalent <g filter>
//   paintImageMaskAudit    paint, image and mask cases
//   colorImage             premultiplied raster filtering, feComposite lighter, none channels, color rows
//   animationAudit         a rect -> diamond and a turning ellipse morph render as their literal poses
// Each case's own notes are above it.
//
// `--cpu` runs the importerSemantics cells GL-free (import all three documents, report whether the records agree) to
// debug them.
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { openPageSuite, tally } from './_pageSuite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = tally();

// The three-document page: `__render(sources)` paints each source (an SVG string, or `{ svg, opts }` for an import
// option arm) on the AAC cover with primitives off and returns the pixels.
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { paint, viewport } from '/test/_auditPaintCases.mjs';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__render = async (sources) => {
  viewport(gl, R); R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const out = [];
  for (const s of sources) {
    const b = createBundle(gl, await importSvg(typeof s === 'string' ? s : s.svg, { preserveViewport: true, ...(typeof s === 'string' ? null : s.opts) }));
    out.push(Array.from(await paint(gl, R, b))); b.dispose();
  }
  return out;
};
window.__ready = true;
</script></body></html>`;

const at = (px, x, y) => {
  const i = ((127 - Math.floor(y * 2)) * 128 + Math.floor(x * 2)) * 4;
  return [px[i], px[i + 1], px[i + 2]];
};
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const inkOf = (px) => {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] < 250 || px[i + 1] < 250 || px[i + 2] < 250) n++;
  return n;
};
// pixels that differ from the control by more than 24/255 in some channel: the edge band of a shape may, a surface may not
const badPixels = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4)
    if (
      Math.max(
        Math.abs(a[i] - b[i]),
        Math.abs(a[i + 1] - b[i + 1]),
        Math.abs(a[i + 2] - b[i + 2]),
      ) > 24
    )
      n++;
  return n;
};
/** A fresh page on the three-document harness. */
async function auditPage(suite) {
  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await suite.goto(page, HTML);
  return page;
}

// importerSemantics -- the importer-semantics rules that change PIXELS, on the GPU (the
// record-level proofs are test/svg/*ImportSmoke.mjs; this is the rendered check of them).
//
// Each cell renders three documents with the renderer at 128 px (64-unit viewBox, white ground):
//   svg      the document under test, written with the feature under test;
//   control  the same picture authored without that feature (attributes, explicit
//            values, separate paths): the render must match it to within 1/255 on every channel;
//   old      the picture without the rule, authored literally (a black flood, 16 px for 1em, a missing marker,
//            no width override ...): the render must DIFFER from svg by at least 48/255 somewhere, so a pass cannot be
//            a picture an importer without the rule also draws.
// Probes are the analytic expectation: a stated point of the 64-unit space must read a stated color. They pin ink to
// the places it belongs (and its absence to the places it does not), independent of both documents.
//
// Cells: flood color and opacity from style; radial focus defaults to the child's own cx; marker orient angle units,
// mid markers at later movetos, the marker shorthand; a zero-size filter region paints nothing; paint fallback, invalid
// declaration dropped, <use> size override on an <svg>; em in stroke widths.
//
// `--cpu` runs the same cells GL-free (import all three documents, report whether the records agree) to debug them.
function importerSemanticsCells() {
  const doc = (body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/>${body}</svg>`;
  const WHITE = [255, 255, 255],
    RED = [255, 0, 0],
    LIME = [0, 255, 0],
    BLUE = [0, 0, 255],
    BLACK = [0, 0, 0];

  // ---- flood-color / flood-opacity from style ---------------------------------------------------------------
  const floodDoc = (prim) =>
    doc(
      `<defs><filter id="f" x="0" y="0" width="1" height="1">${prim}</filter></defs><rect x="8" y="8" width="48" height="48" fill="blue" filter="url(#f)"/>`,
    );
  const shadowDoc = (prim) =>
    doc(
      `<defs><filter id="f" x="-.5" y="-.5" width="2" height="2">${prim}</filter></defs><rect x="16" y="16" width="24" height="24" fill="lime" filter="url(#f)"/>`,
    );
  // ---- the child sets only cx; fx/fy default to the child's own cx/cy -------------------------------------------
  const STOPS = '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>';
  const radial = (defs) =>
    doc(`<defs>${defs}</defs><rect x="8" y="8" width="48" height="48" fill="url(#g)"/>`);
  // ---- markers --------------------------------------------------------------------------------------------
  // A 6x3 red bar in user units, centered on its vertex: orient 90 stands it up (3 wide, 6 tall).
  const marker = (orient) =>
    `<marker id="m" markerUnits="userSpaceOnUse" markerWidth="6" markerHeight="6" refX="3" refY="1.5" orient="${orient}"><rect width="6" height="3" fill="red"/></marker>`;
  const stroked = (d, extra) =>
    `<path d="${d}" fill="none" stroke="black" stroke-width="1" ${extra}/>`;
  const ALL = 'marker-start="url(#m)" marker-mid="url(#m)" marker-end="url(#m)"';
  // ---- a zero-size filter region -------------------------------------------------------------------------------
  const regionDoc = (attrs, target) =>
    doc(`<defs><filter id="f" ${attrs}><feFlood flood-color="red"/></filter></defs>${target}`);
  const SHAPE = '<rect x="8" y="8" width="48" height="48" fill="blue" filter="url(#f)"/>';
  const GROUP =
    '<g filter="url(#f)"><rect x="8" y="8" width="20" height="48" fill="blue"/><circle cx="42" cy="32" r="14" fill="blue"/></g>';
  // ---- <use> of an <svg> with a size override --------------------------------------------------------------------
  const NEST = (attrs) =>
    `<svg ${attrs} viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/><rect width="5" height="5" fill="blue"/></svg>`;
  // ---- em ---------------------------------------------------------------------------------------------------------
  const dashed = (sw, da) =>
    doc(
      `<g font-size="20"><path d="M8 20 L56 20" fill="none" stroke="black" stroke-width="${sw}" stroke-dasharray="${da}"/></g>`,
    );

  const flood = (attrs) => floodDoc(`<feFlood ${attrs}/>`);
  const FLOOD_HALF = [127.5, 255, 127.5]; // lime at 0.5 over white
  const CELLS = [
    {
      name: 'feFlood style color and percent opacity',
      svg: flood('style="flood-color:lime;flood-opacity:50%"'),
      control: flood('flood-color="lime" flood-opacity="0.5"'),
      old: flood('flood-color="black" flood-opacity="1"'),
      probes: [
        [32, 32, FLOOD_HALF, 3],
        [4, 4, WHITE, 1],
      ],
    },
    {
      name: 'feDropShadow style flood-color',
      svg: shadowDoc('<feDropShadow dx="6" dy="6" stdDeviation="0" style="flood-color:red"/>'),
      control: shadowDoc('<feDropShadow dx="6" dy="6" stdDeviation="0" flood-color="red"/>'),
      old: shadowDoc('<feDropShadow dx="6" dy="6" stdDeviation="0" flood-color="black"/>'),
      probes: [
        [43, 43, RED, 3],
        [28, 28, LIME, 3],
        [4, 4, WHITE, 1],
      ],
    },
    {
      name: 'radial focus defaults to the child cx',
      svg: radial(
        `<radialGradient id="p" r=".5">${STOPS}</radialGradient><radialGradient id="g" href="#p" cx=".8"/>`,
      ),
      control: radial(
        `<radialGradient id="g" cx=".8" cy=".5" fx=".8" fy=".5" r=".5">${STOPS}</radialGradient>`,
      ),
      old: radial(
        `<radialGradient id="g" cx=".8" cy=".5" fx=".5" fy=".5" r=".5">${STOPS}</radialGradient>`,
      ),
      probes: [
        [46.4, 32, RED, 10],
        [4, 4, WHITE, 1],
      ],
    },
    {
      name: 'marker orient="90deg"',
      svg: doc(
        `<defs>${marker('90deg')}</defs>` + stroked('M10 20 L50 20', 'marker-end="url(#m)"'),
      ),
      control: doc(
        `<defs>${marker('90')}</defs>` + stroked('M10 20 L50 20', 'marker-end="url(#m)"'),
      ),
      old: doc(`<defs>${marker('1.57')}</defs>` + stroked('M10 20 L50 20', 'marker-end="url(#m)"')),
      probes: [
        [50, 22.5, RED, 3],
        [52.5, 20, WHITE, 3],
      ],
    },
    {
      name: 'mid markers at a later moveto',
      svg: doc(`<defs>${marker('0')}</defs>` + stroked('M10 10 L50 10 M10 30 L50 30', ALL)),
      control: doc(
        `<defs>${marker('0')}</defs>` +
          stroked('M10 10 L50 10', 'marker-start="url(#m)" marker-end="url(#m)"') +
          stroked('M10 30 L50 30', 'marker-start="url(#m)" marker-end="url(#m)"'),
      ),
      old: doc(
        `<defs>${marker('0')}</defs>` +
          stroked('M10 10 L50 10', 'marker-start="url(#m)" marker-end="url(#m)"') +
          stroked('M10 30 L50 30', 'marker-end="url(#m)"'),
      ),
      probes: [
        [10, 11, RED, 3],
        [50, 11, RED, 3],
        [10, 31, RED, 3],
        [50, 31, RED, 3],
        [30, 20, WHITE, 3],
      ],
    },
    {
      name: 'marker shorthand in style',
      svg: doc(
        `<defs>${marker('0')}</defs>` + stroked('M10 50 L30 50 L50 50', 'style="marker:url(#m)"'),
      ),
      control: doc(`<defs>${marker('0')}</defs>` + stroked('M10 50 L30 50 L50 50', ALL)),
      old: doc(`<defs>${marker('0')}</defs>` + stroked('M10 50 L30 50 L50 50', '')),
      probes: [
        [10, 51, RED, 3],
        [30, 51, RED, 3],
        [50, 51, RED, 3],
      ],
    },
    {
      name: 'filter width="0" on a shape',
      svg: regionDoc('width="0"', SHAPE),
      control: doc(''),
      old: regionDoc('width="1"', SHAPE),
      probes: [
        [32, 32, WHITE, 1],
        [10, 10, WHITE, 1],
      ],
    },
    {
      name: 'filter height="0" on a shape',
      svg: regionDoc('height="0"', SHAPE),
      control: doc(''),
      old: regionDoc('height="1"', SHAPE),
      probes: [
        [32, 32, WHITE, 1],
        [10, 10, WHITE, 1],
      ],
    },
    {
      name: 'filter width="0" on a group',
      svg: regionDoc('width="0"', GROUP),
      control: doc(''),
      old: regionDoc('width="1"', GROUP),
      probes: [
        [18, 32, WHITE, 1],
        [42, 32, WHITE, 1],
      ],
    },
    {
      name: 'paint fallback after a missing url()',
      svg: doc('<rect x="8" y="8" width="48" height="48" fill="url(#missing) lime"/>'),
      control: doc('<rect x="8" y="8" width="48" height="48" fill="lime"/>'),
      old: doc('<rect x="8" y="8" width="48" height="48" fill="black"/>'),
      probes: [
        [32, 32, LIME, 1],
        [4, 4, WHITE, 1],
      ],
    },
    {
      name: 'invalid declaration dropped',
      svg: doc('<rect x="8" y="8" width="48" height="48" style="fill:blue;fill:bogus"/>'),
      control: doc('<rect x="8" y="8" width="48" height="48" fill="blue"/>'),
      old: doc('<rect x="8" y="8" width="48" height="48" fill="black"/>'),
      probes: [
        [32, 32, BLUE, 1],
        [4, 4, WHITE, 1],
      ],
    },
    {
      name: 'use of an svg takes the width/height override',
      svg: doc(
        `<defs>${NEST('id="s" width="20" height="20"')}</defs><use href="#s" x="10" y="10" width="40" height="40"/>`,
      ),
      control: doc(NEST('x="10" y="10" width="40" height="40"')),
      old: doc(NEST('x="10" y="10" width="20" height="20"')),
      probes: [
        [15, 15, BLUE, 1],
        [25, 25, BLUE, 1],
        [45, 45, RED, 1],
        [55, 55, WHITE, 1],
      ],
    },
    {
      name: 'em in stroke-width and stroke-dasharray',
      svg: dashed('1em', '1em 0.5em'),
      control: dashed('20', '20 10'),
      old: dashed('16', '16 8'),
      probes: [
        [18, 11, BLACK, 1],
        [45, 20, BLACK, 1],
        [33, 20, WHITE, 1],
        [18, 7, WHITE, 1],
      ],
    },
  ];
  return CELLS;
}
async function importerSemantics(suite) {
  const { ok, fail } = T;
  const CELLS = importerSemanticsCells();
  const page = await auditPage(suite);
  for (const c of CELLS) {
    let px;
    try {
      px = await page.evaluate((s) => window.__render(s), [c.svg, c.control, c.old]);
    } catch (e) {
      fail(c.name + ': ' + e.message);
      continue;
    }
    const [a, b, o] = px;
    const vsControl = maxDiff(a, b),
      vsOld = maxDiff(a, o);
    const bad = c.probes
      .filter(([x, y, want, tol]) => maxDiff(at(a, x, y), want) > tol)
      .map(([x, y, want]) => `(${x},${y}) is [${at(a, x, y)}], wanted [${want}]`);
    const line = `${c.name}: control maxByte ${vsControl}, old differs by ${vsOld}, ink px svg ${inkOf(a)} / control ${inkOf(b)} / old ${inkOf(o)}`;
    if (vsControl > 1) fail(line + ' -- render differs from its control');
    else if (vsOld < 48) fail(line + ' -- vacuous: the picture without the rule is the same');
    else if (bad.length) fail(line + ' -- probes: ' + bad.join('; '));
    else ok(line);
  }
  await page.close();
}

// importerGeometryAudit -- the importer's geometry rules that change PIXELS, on the GPU (
// the record-level proofs are test/importerGeometryAuditSmoke.mjs).
//
// Each cell renders three documents with the renderer at 128 px (64-unit viewBox, white ground), as importerSemanticsRenderSmoke does:
//   svg      the document under test, written with the feature under test;
//   control  the same picture authored without that feature (the path without its repeated point, an explicit M, a
//            disc / box drawn as a fill, the phase written inside one cycle): the render must match it to within `tol` (default 1/255);
//   old      the picture without the rule, authored literally (a join that is missing, a disc where a box belongs, nothing): the render
//            must DIFFER from svg by at least 48/255 somewhere, so a pass cannot be a picture an importer without the rule also draws.
// Probes are the analytic expectation (a stated point reads a stated color), independent of both documents.
//
// `--cpu` is not offered: the CPU proofs are the record checks in importerGeometryAuditSmoke.
function importerGeometryAuditCells() {
  const doc = (body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/>${body}</svg>`;
  const WHITE = [255, 255, 255],
    BLACK = [0, 0, 0];
  const S = (d, extra = '') => `<path d="${d}" fill="none" stroke="black" ${extra}/>`;
  const W12 = 'stroke-width="12"';

  const CELLS = [
    {
      name: 'duplicated mid vertex, miter join',
      svg: doc(S('M12 54 L32 14 L32 14 L52 54', `${W12} stroke-miterlimit="10"`)),
      control: doc(S('M12 54 L32 14 L52 54', `${W12} stroke-miterlimit="10"`)),
      old: doc(S('M12 54 L32 14 M32 14 L52 54', W12)),
      probes: [
        [32, 8, BLACK, 1],
        [32, 20, BLACK, 1],
        [4, 4, WHITE, 1],
      ],
    },
    {
      name: 'duplicated first and last point, butt caps',
      svg: doc(S('M12 54 L12 54 L32 14 L52 54 L52 54', `${W12} stroke-miterlimit="10"`)),
      control: doc(S('M12 54 L32 14 L52 54', `${W12} stroke-miterlimit="10"`)),
      old: doc(S('M12 54 L32 14 L52 54 L52 54', `${W12} stroke-linecap="round"`)),
      probes: [
        [32, 8, BLACK, 1],
        [4, 4, WHITE, 1],
      ],
    },
    {
      name: 'closed polygon with a repeated last vertex',
      svg: doc(S('M12 52 L32 12 L52 52 L52 52 Z', `${W12} stroke-miterlimit="10"`)),
      control: doc(S('M12 52 L32 12 L52 52 Z', `${W12} stroke-miterlimit="10"`)),
      old: doc(S('M12 52 L32 12 L52 52 Z', `${W12} stroke-linejoin="bevel"`)),
      probes: [
        [32, 6, BLACK, 1],
        [32, 36, WHITE, 1],
      ],
    },
    {
      name: 'a segment after Z starts its own subpath (square cap at the start point)',
      svg: doc(
        S('M14 14 H34 V34 Z L50 50', `${W12} stroke-linecap="square" stroke-dasharray="20 10"`),
      ),
      control: doc(
        S(
          'M14 14 H34 V34 Z M14 14 L50 50',
          `${W12} stroke-linecap="square" stroke-dasharray="20 10"`,
        ),
      ),
      old: doc(S('M14 14 H34 V34 Z L50 50', `${W12} stroke-linecap="butt"`)),
      probes: [
        [4, 14, WHITE, 1],
        [9, 14, BLACK, 1],
      ],
    },
    {
      name: 'zero-length subpaths, round cap: a disc each',
      svg: doc(S('M18 32 L18 32 M46 32 Z', 'stroke-width="16" stroke-linecap="round"')),
      control: doc('<circle cx="18" cy="32" r="8"/><circle cx="46" cy="32" r="8"/>'),
      tol: 64,
      old: doc(S('M18 32 L18 32', 'stroke-width="16" stroke-linecap="butt"')),
      probes: [
        [18, 32, BLACK, 1],
        [46, 32, BLACK, 1],
        [24, 24, WHITE, 1],
        [18, 22, WHITE, 1],
        [12, 32, BLACK, 1],
      ],
    },
    {
      name: 'zero-length subpaths, square cap: an axis-aligned box each',
      svg: doc(S('M18 32 h0 M46 32 l0 0 z', 'stroke-width="16" stroke-linecap="square"')),
      control: doc(
        '<rect x="10" y="24" width="16" height="16"/><rect x="38" y="24" width="16" height="16"/>',
      ),
      tol: 12,
      old: doc('<circle cx="18" cy="32" r="8"/><circle cx="46" cy="32" r="8"/>'),
      probes: [
        [10.6, 24.6, BLACK, 1],
        [25.4, 39.4, BLACK, 1],
        [46, 32, BLACK, 1],
        [4, 32, WHITE, 1],
      ],
    },
    {
      name: 'zero-length subpaths, butt cap: nothing',
      svg: doc(
        S(
          'M18 32 L18 32 L18 32 M46 32 l0 0 z M32 12 A0 0 0 0 1 32 12',
          'stroke-width="16" stroke-linecap="butt"',
        ),
      ),
      control: doc(''),
      old: doc('<circle cx="18" cy="32" r="8"/><circle cx="46" cy="32" r="8"/>'),
      probes: [
        [18, 32, WHITE, 1],
        [46, 32, WHITE, 1],
        [32, 12, WHITE, 1],
      ],
    },
    {
      name: 'square cap of a zero-length subpath turns with the element (user-space axes)',
      svg: doc(
        `<g transform="rotate(45 32 32)">${S('M32 32 Z', 'stroke-width="24" stroke-linecap="square"')}</g>`,
      ),
      control: doc('<rect x="20" y="20" width="24" height="24" transform="rotate(45 32 32)"/>'),
      tol: 12,
      old: doc('<circle cx="32" cy="32" r="12"/>'),
      probes: [
        [32, 32, BLACK, 1],
        [32, 16.4, BLACK, 1],
        [32, 12, WHITE, 1],
        [22, 22, WHITE, 1],
      ],
    },
    // SVG 2 path implementation notes: the square cap of a zero-length subpath follows the path's direction there (here the 45 degree
    // segment before it); Chrome and Skia draw it axis-aligned, and importSvg({ compat: 'chrome' }) keeps that.
    {
      name: 'spec default: the square cap of a zero-length subpath follows the preceding segment (45 degrees)',
      svg: doc(S('M6 6 L22 22 M46 40 h0', 'stroke-width="16" stroke-linecap="square"')),
      control: doc(
        S('M6 6 L22 22', 'stroke-width="16" stroke-linecap="square"') +
          '<rect x="38" y="32" width="16" height="16" transform="rotate(45 46 40)"/>',
      ),
      tol: 12,
      old: doc(
        S('M6 6 L22 22', 'stroke-width="16" stroke-linecap="square"') +
          '<rect x="38" y="32" width="16" height="16"/>',
      ),
      probes: [
        [46, 31.5, BLACK, 1],
        [46, 48.5, BLACK, 1],
        [38.6, 32.6, WHITE, 1],
        [53.4, 47.4, WHITE, 1],
      ],
    },
    {
      name: "compat 'chrome': the same square stays axis-aligned",
      svg: {
        svg: doc(S('M6 6 L22 22 M46 40 h0', 'stroke-width="16" stroke-linecap="square"')),
        opts: { compat: 'chrome' },
      },
      control: doc(
        S('M6 6 L22 22', 'stroke-width="16" stroke-linecap="square"') +
          '<rect x="38" y="32" width="16" height="16"/>',
      ),
      tol: 12,
      old: doc(
        S('M6 6 L22 22', 'stroke-width="16" stroke-linecap="square"') +
          '<rect x="38" y="32" width="16" height="16" transform="rotate(45 46 40)"/>',
      ),
      probes: [
        [39.5, 33.5, BLACK, 1],
        [52.5, 46.5, BLACK, 1],
        [46, 29.5, WHITE, 1],
        [46, 50.5, WHITE, 1],
      ],
    },
    {
      name: 'a stroke-dashoffset of 100000003 is its phase 3',
      svg: doc(
        S('M2 32 H62', 'stroke-width="8" stroke-dasharray="8 8" stroke-dashoffset="100000003"'),
      ),
      control: doc(S('M2 32 H62', 'stroke-width="8" stroke-dasharray="8 8" stroke-dashoffset="3"')),
      old: doc(S('M2 32 H62', 'stroke-width="8" stroke-dasharray="8 8" stroke-dashoffset="0"')),
      probes: [
        [5, 32, BLACK, 1],
        [9, 32, WHITE, 1],
      ],
    },
    {
      name: 'pathLength scales the dash pattern',
      svg: doc(S('M4 32 H60', 'stroke-width="8" stroke-dasharray="5 5" pathLength="30"')),
      control: doc(
        S('M4 32 H60', `stroke-width="8" stroke-dasharray="${(5 * 56) / 30} ${(5 * 56) / 30}"`),
      ),
      tol: 4,
      old: doc(S('M4 32 H60', 'stroke-width="8" stroke-dasharray="5 5"')),
      probes: [
        [6, 32, BLACK, 1],
        [16, 32, WHITE, 1],
      ],
    },
    {
      name: 'a 1e8 radius arc is its chord',
      svg: doc(S('M8 32 A100000000 100000000 0 0 1 56 32', 'stroke-width="12"')),
      control: doc(S('M8 32 L56 32', 'stroke-width="12"')),
      old: doc(''),
      probes: [
        [32, 32, BLACK, 1],
        [32, 24, WHITE, 1],
        [32, 40, WHITE, 1],
      ],
    },
    {
      name: 'a miter limit equal to the corner ratio keeps the miter',
      svg: doc(
        S(
          'M10 54 L34 54 L34 30',
          `${W12} stroke-linejoin="miter" stroke-miterlimit="${Math.SQRT2}"`,
        ),
      ),
      control: doc(
        S('M10 54 L34 54 L34 30', `${W12} stroke-linejoin="miter" stroke-miterlimit="1.5"`),
      ),
      old: doc(S('M10 54 L34 54 L34 30', `${W12} stroke-linejoin="bevel"`)),
      probes: [
        [39, 59, BLACK, 1],
        [41, 61, WHITE, 1],
      ],
    },
  ];
  return CELLS;
}
async function importerGeometryAudit(suite) {
  const { ok, fail } = T;
  const CELLS = importerGeometryAuditCells();
  const page = await auditPage(suite);
  for (const c of CELLS) {
    let px;
    try {
      px = await page.evaluate((s) => window.__render(s), [c.svg, c.control, c.old]);
    } catch (e) {
      fail(c.name + ': ' + e.message);
      continue;
    }
    const [a, b, o] = px; // c.svg may be { svg, opts } for a compat arm
    const vsControl = maxDiff(a, b),
      vsOld = maxDiff(a, o);
    const bad = c.probes
      .filter(([x, y, want, tol]) => maxDiff(at(a, x, y), want) > tol)
      .map(([x, y, want]) => `(${x},${y}) is [${at(a, x, y)}], wanted [${want}]`);
    const line = `${c.name}: control maxByte ${vsControl}, old differs by ${vsOld}, ink px svg ${inkOf(a)} / control ${inkOf(b)} / old ${inkOf(o)}`;
    if (vsControl > (c.tol ?? 1)) fail(line + ' -- render differs from its control');
    else if (vsOld < 48) fail(line + ' -- vacuous: the picture without the rule is the same');
    else if (bad.length) fail(line + ' -- probes: ' + bad.join('; '));
    else ok(line);
  }
  await page.close();
}

// compositingGroup -- the compositing rules that change PIXELS, on the GPU (mask on a group, markers under
// the element's opacity, filter and mask and the <marker>'s own opacity, context-fill / context-stroke; the record-level proofs are
// test/compositingGroupSmoke.mjs).
//
// Each cell renders three documents with the renderer at 128 px (64-unit viewBox, white ground), as the importerGeometryAudit cells do:
//   svg      the document under test, written with the feature under test;
//   control  the same picture authored with features that do not depend on the rule (a group's opacity or filter standing for a uniform mask, an
//            explicit paint standing for a context paint): the render must match it to within `tol` (default 2/255);
//   old      what the defect draws, authored literally (each leaf masked on its own, an opaque marker, a black marker): the render must
//            DIFFER from it by at least 48/255 somewhere, so a pass cannot be a picture the defect also draws.
// Probes are the analytic expectation (a stated point reads a stated color), independent of both documents.
function compositingGroupCells() {
  const doc = (body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/>${body}</svg>`;
  const WHITE = [255, 255, 255];
  const G = 128 / 255; // the opacity a uniform #808080 mask stands for
  const MASK = '<mask id="m"><rect width="64" height="64" fill="#808080"/></mask>';
  const MASK_US =
    '<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#808080"/></mask>';
  const CYAN = (extra = '') => `<rect x="4" y="4" width="40" height="40" fill="#0cf" ${extra}/>`;
  const PINK = (extra = '') => `<rect x="20" y="20" width="40" height="40" fill="#f0c" ${extra}/>`;
  const TWO = CYAN() + PINK();
  const TWO_LEAF_MASKED = CYAN('mask="url(#m)"') + PINK('mask="url(#m)"');
  const MARK = (attrs = '', inner = '<circle cx="5" cy="5" r="5" fill="#f00"/>') =>
    `<marker id="k" markerWidth="10" markerHeight="10" refX="5" refY="5" markerUnits="userSpaceOnUse" ${attrs}>${inner}</marker>`;
  const PATH = (attrs = '', markers = true) =>
    `<path d="M8 32 H56" stroke="#00f" stroke-width="8" fill="none" ${markers ? 'marker-start="url(#k)" marker-end="url(#k)"' : ''} ${attrs}/>`;
  const DOTS =
    '<circle cx="8" cy="32" r="5" fill="#f00"/><circle cx="56" cy="32" r="5" fill="#f00"/>';
  const SAT =
    '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0"/></filter>';
  const over = (rgb, a, under = WHITE) => rgb.map((c, i) => c * a + under[i] * (1 - a));

  const CELLS = [
    {
      name: 'uniform gray mask over two overlapping opaque rects',
      svg: doc(`${MASK}<g mask="url(#m)">${TWO}</g>`),
      control: doc(`<g opacity="${G}">${TWO}</g>`),
      old: doc(`${MASK}${TWO_LEAF_MASKED}`),
      probes: [
        [30, 30, over([255, 0, 204], G), 3],
        [10, 10, over([0, 204, 255], G), 3],
        [55, 55, over([255, 0, 204], G), 3],
        [62, 2, WHITE, 1],
      ],
    },
    {
      name: 'gradient fade mask over two overlapping opaque rects',
      svg: doc(
        `<linearGradient id="g" x2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient><mask id="m"><rect width="64" height="64" fill="url(#g)"/></mask><g mask="url(#m)">${TWO}</g>`,
      ),
      control: doc(
        `<linearGradient id="g" x2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient><mask id="m"><rect width="64" height="64" fill="url(#g)"/></mask><filter id="i" filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64" color-interpolation-filters="sRGB"><feOffset dx="0"/></filter><g filter="url(#i)" mask="url(#m)">${TWO}</g>`,
      ),
      old: doc(
        `<linearGradient id="g" x2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient><mask id="m"><rect width="64" height="64" fill="url(#g)"/></mask>${TWO_LEAF_MASKED}`,
      ),
      tol: 4,
      probes: [
        [30.25, 30, over([255, 0, 204], 1 - 30.25 / 64), 4],
        [40.25, 30, over([255, 0, 204], 1 - 40.25 / 64), 4],
      ],
    },
    {
      name: 'mask plus group opacity: one group, both applied once',
      svg: doc(`${MASK}<g mask="url(#m)" opacity=".5">${TWO}</g>`),
      control: doc(`<g opacity="${G * 0.5}">${TWO}</g>`),
      old: doc(`${MASK}<g opacity=".5">${TWO_LEAF_MASKED}</g>`),
      minOld: 24, // the defect picture differs from this one only by the overlap's second masking (32 here)
      probes: [[30, 30, over([255, 0, 204], G * 0.5), 3]],
    },
    {
      name: 'nested group masks multiply',
      svg: doc(
        `${MASK}<mask id="m2"><rect width="64" height="64" fill="#808080"/></mask><g mask="url(#m)"><g mask="url(#m2)">${TWO}</g></g>`,
      ),
      control: doc(`<g opacity="${G}"><g opacity="${G}">${TWO}</g></g>`),
      old: doc(
        `<mask id="m2"><rect width="64" height="64" fill="#808080"/></mask>${CYAN('mask="url(#m2)"')}${PINK('mask="url(#m2)"')}`,
      ),
      probes: [[30, 30, over([255, 0, 204], G * G), 3]],
    },
    {
      name: 'mask on a <use>',
      svg: doc(`${MASK}<defs><g id="u">${TWO}</g></defs><use href="#u" mask="url(#m)"/>`),
      control: doc(`<defs><g id="u">${TWO}</g></defs><use href="#u" opacity="${G}"/>`),
      old: doc(`${MASK}${TWO_LEAF_MASKED}`),
      probes: [[30, 30, over([255, 0, 204], G), 3]],
    },
    {
      name: 'mask and clip-path on one group',
      svg: doc(
        `${MASK}<clipPath id="c"><rect width="50" height="50"/></clipPath><g mask="url(#m)" clip-path="url(#c)">${TWO}</g>`,
      ),
      control: doc(
        `<clipPath id="c"><rect width="50" height="50"/></clipPath><g clip-path="url(#c)" opacity="${G}">${TWO}</g>`,
      ),
      old: doc(
        `${MASK}<clipPath id="c"><rect width="50" height="50"/></clipPath><g clip-path="url(#c)">${TWO_LEAF_MASKED}</g>`,
      ),
      probes: [
        [30, 30, over([255, 0, 204], G), 3],
        [55, 55, WHITE, 1],
      ],
    },
    {
      name: 'a fill and a stroke under one mask (region = the box, objectBoundingBox)',
      svg: doc(
        `${MASK}<rect x="12" y="12" width="40" height="40" fill="#0cf" stroke="#f0c" stroke-width="16" mask="url(#m)"/>`,
      ),
      control: doc(
        `<clipPath id="c"><rect x="8" y="8" width="48" height="48"/></clipPath><g clip-path="url(#c)" opacity="${G}"><rect x="12" y="12" width="40" height="40" fill="#0cf" stroke="#f0c" stroke-width="16"/></g>`,
      ),
      old: doc(
        `${MASK}<rect x="12" y="12" width="40" height="40" fill="#0cf" mask="url(#m)"/><rect x="12" y="12" width="40" height="40" fill="none" stroke="#f0c" stroke-width="16" mask="url(#m)"/>`,
      ),
      probes: [
        [16, 30, over([255, 0, 204], G), 3],
        [30, 30, over([0, 204, 255], G), 3],
        [6, 30, WHITE, 1],
      ],
    },
    {
      name: 'a marker takes the path opacity',
      svg: doc(MARK() + PATH('opacity=".5"')),
      control: doc(`<g opacity=".5">${MARK()}${PATH()}</g>`),
      old: doc(PATH('opacity=".5"', false) + DOTS),
      probes: [
        [8, 32, over([255, 0, 0], 0.5), 2],
        [30, 32, over([0, 0, 255], 0.5), 2],
      ],
    },
    {
      name: 'a marker takes the path filter',
      svg: doc(SAT + MARK() + PATH('filter="url(#f)"')),
      control: doc(`${SAT}${MARK()}<g filter="url(#f)">${PATH()}</g>`),
      old: doc(SAT + PATH('filter="url(#f)"', false) + DOTS),
      tol: 3,
      probes: [
        [8, 32, [54, 54, 54], 3],
        [30, 32, [18, 18, 18], 3],
      ],
    },
    {
      name: 'a marker takes the path mask (stroke and marker mask once)',
      svg: doc(MASK_US + MARK() + PATH('mask="url(#m)"')),
      control: doc(`${MARK()}<g opacity="${G}">${PATH()}</g>`),
      old: doc(
        MASK_US +
          PATH('mask="url(#m)"', false) +
          `<circle cx="8" cy="32" r="5" fill="#f00" mask="url(#m)"/><circle cx="56" cy="32" r="5" fill="#f00" mask="url(#m)"/>`,
      ),
      probes: [
        [8, 32, over([255, 0, 0], G), 3],
        [30, 32, over([0, 0, 255], G), 3],
      ],
    },
    {
      name: 'the <marker> opacity',
      svg: doc(MARK('opacity=".5"') + PATH()),
      control: doc(
        MARK('', '<circle cx="5" cy="5" r="5" fill="#f00" fill-opacity=".5"/>') + PATH(),
      ),
      old: doc(MARK() + PATH()),
      probes: [
        [8, 27.5, over([255, 0, 0], 0.5), 2],
        [8, 32, over([255, 0, 0], 0.5, [0, 0, 255]), 2],
      ],
    },
    {
      name: 'context-stroke in a marker',
      svg: doc(MARK('', '<circle cx="5" cy="5" r="5" fill="context-stroke"/>') + PATH()),
      control: doc(MARK('', '<circle cx="5" cy="5" r="5" fill="#00f"/>') + PATH()),
      old: doc(MARK('', '<circle cx="5" cy="5" r="5" fill="#000"/>') + PATH()),
      probes: [
        [8, 27.5, [0, 0, 255], 2],
        [56, 27.5, [0, 0, 255], 2],
      ],
    },
    {
      name: 'context-fill in a marker',
      svg: doc(
        MARK('', '<circle cx="5" cy="5" r="5" fill="context-fill"/>') +
          '<path d="M12 12 L52 12 L32 52 Z" fill="#a0a" stroke="#00f" stroke-width="2" marker-start="url(#k)" marker-end="url(#k)"/>',
      ),
      // (a transform on the control's circle puts it on the walked path too, which clips a marker to its viewport as the svg's does)
      control: doc(
        MARK('', '<circle cx="5" cy="5" r="5" fill="#a0a" transform="translate(0 0)"/>') +
          '<path d="M12 12 L52 12 L32 52 Z" fill="#a0a" stroke="#00f" stroke-width="2" marker-start="url(#k)" marker-end="url(#k)"/>',
      ),
      old: doc(
        MARK('', '<circle cx="5" cy="5" r="5" fill="#000"/>') +
          '<path d="M12 12 L52 12 L32 52 Z" fill="#a0a" stroke="#00f" stroke-width="2" marker-start="url(#k)" marker-end="url(#k)"/>',
      ),
      probes: [
        [12, 12, [170, 0, 170], 2],
        [32, 30, [170, 0, 170], 2],
      ],
    },
    {
      name: 'context-fill and context-stroke in a <use> instance',
      svg: doc(
        '<defs><rect id="r" width="30" height="30" fill="context-fill" stroke="context-stroke" stroke-width="6"/></defs><use href="#r" x="10" y="10" fill="#f80" stroke="#08f"/>',
      ),
      control: doc(
        '<rect x="10" y="10" width="30" height="30" fill="#f80" stroke="#08f" stroke-width="6"/>',
      ),
      old: doc(
        '<rect x="10" y="10" width="30" height="30" fill="#000" stroke="#000" stroke-width="6"/>',
      ),
      probes: [
        [25, 25, [255, 136, 0], 2],
        [10, 25, [0, 136, 255], 2],
      ],
    },
  ];
  return CELLS;
}
async function compositingGroup(suite) {
  const { ok, fail } = T;
  const CELLS = compositingGroupCells();
  const page = await auditPage(suite);
  for (const c of CELLS) {
    let px;
    try {
      px = await page.evaluate((s) => window.__render(s), [c.svg, c.control, c.old]);
    } catch (e) {
      fail(c.name + ': ' + e.message);
      continue;
    }
    const [a, b, o] = px;
    const vsControl = maxDiff(a, b),
      vsOld = maxDiff(a, o);
    const bad = c.probes
      .filter(([x, y, want, tol]) => maxDiff(at(a, x, y), want) > tol)
      .map(([x, y, want]) => `(${x},${y}) is [${at(a, x, y)}], wanted [${want}]`);
    const line = `${c.name}: control maxByte ${vsControl}, old differs by ${vsOld}, ink px svg ${inkOf(a)} / control ${inkOf(b)} / old ${inkOf(o)}`;
    if (vsControl > (c.tol ?? 2)) fail(line + ' -- render differs from its control');
    else if (vsOld < (c.minOld ?? 48)) fail(line + ' -- vacuous: the defect picture is the same');
    else if (bad.length) fail(line + ' -- probes: ' + bad.join('; '));
    else ok(line);
  }
  await page.close();
}

// filterLeafGroup -- on the GPU: a filter on a leaf with a fill AND a stroke, and a filter on a <use>, run ONCE over the
// composited element (record-level proofs: test/filterLeafGroupSmoke.mjs).
//
// Each cell renders three documents with the renderer at 128 px (64-unit viewBox, white ground), as the compositingGroup cells do:
//   svg      the document under test (the filter on the leaf / on the <use>);
//   control  the same picture with the filter on a <g> around it (already one evaluation over the union): the render must match to `tol`;
//   old      what the defect draws, authored literally (the fill and the stroke as two elements that each carry the filter, the
//            leaves of the instance each filtered alone): the render must DIFFER from it by at least 24/255 somewhere, so a pass cannot
//            be a picture the defect also draws.
function filterLeafGroupCells() {
  const doc = (body, f) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/><defs><filter id="f" x="-30%" y="-30%" width="170%" height="170%" color-interpolation-filters="sRGB">${f}</filter></defs>${body}</svg>`;
  const R = 'x="16" y="14" width="28" height="26" rx="4"';
  const FS = (extra = '') => `${R} fill="#e04020" stroke="#2040c0" stroke-width="6" ${extra}`;
  const leaf = (extra) => `<rect ${FS(extra)}/>`;
  const grp = (extra = '') => `<g filter="url(#f)" ${extra}><rect ${FS()}/></g>`;
  const old = `<rect ${R} fill="#e04020" filter="url(#f)"/><rect ${R} fill="none" stroke="#2040c0" stroke-width="6" filter="url(#f)"/>`;
  const FILTERS = {
    feDropShadow:
      '<feDropShadow dx="4" dy="4" stdDeviation="1.5" flood-color="#000" flood-opacity=".5"/>',
    'offset + merge with SourceGraphic':
      '<feOffset dx="5" dy="4" result="o"/><feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge>',
    feGaussianBlur: '<feGaussianBlur stdDeviation="2"/>',
    'feMorphology erode': '<feMorphology operator="erode" radius="2"/>',
    'feMorphology dilate': '<feMorphology operator="dilate" radius="2"/>',
    feDiffuseLighting:
      '<feDiffuseLighting in="SourceAlpha" surfaceScale="3" diffuseConstant="1" lighting-color="#fff" result="l"><fePointLight x="10" y="6" z="30"/></feDiffuseLighting><feComposite in="SourceGraphic" in2="l" operator="arithmetic" k1="1" k2="0" k3="0" k4="0"/>',
    'feColorMatrix on alpha (translucent result)':
      '<feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 .5 0"/>',
  };
  const DEFS_USE = `<defs><rect id="a" x="8" y="8" width="30" height="30" fill="#0cf"/><rect id="b" x="24" y="24" width="30" height="30" fill="#f0c"/><g id="two"><use href="#a"/><use href="#b"/></g></defs>`;
  const CELLS = [];
  for (const [name, f] of Object.entries(FILTERS)) {
    CELLS.push({
      name: `${name} on a fill+stroke leaf`,
      svg: doc(leaf('filter="url(#f)"'), f),
      control: doc(grp(), f),
      old: doc(old, f),
      tol: 3,
      minOld: name.startsWith('feGauss') ? 8 : 24,
      probes: [],
    });
  }
  CELLS.push({
    name: 'a leaf filter with opacity: one group, filter then opacity',
    svg: doc(leaf('filter="url(#f)" opacity=".6"'), FILTERS['feDropShadow']),
    control: doc(grp('opacity=".6"'), FILTERS['feDropShadow']),
    old: doc(
      old.replace('/>', '/>').replace(/<rect /g, '<rect opacity=".6" '),
      FILTERS['feDropShadow'],
    ),
    tol: 3,
    probes: [],
  });
  CELLS.push({
    name: '<use filter> of two overlapping rects: feMorphology erode (a single-kind filter ran per leaf)',
    svg: doc(DEFS_USE + '<use href="#two" filter="url(#f)"/>', FILTERS['feMorphology erode']),
    control: doc(
      DEFS_USE + '<g filter="url(#f)"><use href="#two"/></g>',
      FILTERS['feMorphology erode'],
    ),
    old: doc(
      DEFS_USE + '<use href="#a" filter="url(#f)"/><use href="#b" filter="url(#f)"/>',
      FILTERS['feMorphology erode'],
    ),
    tol: 3,
    probes: [],
  });
  CELLS.push({
    name: '<use filter> of two overlapping rects: feMorphology dilate, x/y on the use',
    svg: doc(
      DEFS_USE + '<use href="#two" x="3" y="2" filter="url(#f)"/>',
      FILTERS['feMorphology dilate'],
    ),
    control: doc(
      DEFS_USE + '<g filter="url(#f)"><use href="#two" x="3" y="2"/></g>',
      FILTERS['feMorphology dilate'],
    ),
    old: doc(
      DEFS_USE +
        '<use href="#a" x="3" y="2" filter="url(#f)"/><use href="#b" x="3" y="2" filter="url(#f)"/>',
      FILTERS['feMorphology dilate'],
    ),
    tol: 3,
    probes: [],
  });
  CELLS.push({
    name: '<use filter> of a fill+stroke leaf',
    svg: doc(
      `<defs><rect id="fs" ${FS()}/></defs><use href="#fs" filter="url(#f)"/>`,
      FILTERS['feDropShadow'],
    ),
    control: doc(grp(), FILTERS['feDropShadow']),
    old: doc(old, FILTERS['feDropShadow']),
    tol: 3,
    probes: [],
  });
  return CELLS;
}
async function filterLeafGroup(suite) {
  const { ok, fail } = T;
  const CELLS = filterLeafGroupCells();
  const page = await auditPage(suite);
  for (const c of CELLS) {
    let px;
    try {
      px = await page.evaluate((s) => window.__render(s), [c.svg, c.control, c.old]);
    } catch (e) {
      fail(c.name + ': ' + e.message);
      continue;
    }
    const [a, b, o] = px;
    const vsControl = maxDiff(a, b),
      vsOld = maxDiff(a, o);
    const bad = c.probes
      .filter(([x, y, want, tol]) => maxDiff(at(a, x, y), want) > tol)
      .map(([x, y, want]) => `(${x},${y}) is [${at(a, x, y)}], wanted [${want}]`);
    const line = `${c.name}: control maxByte ${vsControl}, old differs by ${vsOld}, ink px svg ${inkOf(a)} / control ${inkOf(b)} / old ${inkOf(o)}`;
    if (vsControl > (c.tol ?? 2)) fail(line + ' -- render differs from its control');
    else if (vsOld < (c.minOld ?? 24)) fail(line + ' -- vacuous: the defect picture is the same');
    else if (bad.length) fail(line + ' -- probes: ' + bad.join('; '));
    else ok(line);
  }
  await page.close();
}

// paintImageMaskAudit -- the paint, image and mask behaviors that show in PIXELS,
// on the GPU. The record-level proofs are test/svg/paintImageMaskAuditSmoke.mjs; this is the rendered check.
//
// Each cell renders three documents with the renderer at 128 px (64-unit viewBox, white ground):
//   svg      the document under test, written with the feature under test;
//   control  the same picture authored with simpler features (rects, an explicit
//            gradient, a group wrapper): the render must match it except on a thin band of edge pixels;
//   old      the WRONG reading of the feature, authored literally (a stretched bitmap, a gradient over one unit, a
//            byte-rounded stop, a mask region ignored): the render must DIFFER from svg by at least 48/255 somewhere, so
//            a pass cannot be a picture that the wrong reading also draws.
// Probes are the analytic expectation: a stated point of the 64-unit space must read a stated color.
//
// Cells: an image 20x10 in a 48x48 box under meet, slice (centered and xMinYMin) and with no size; mix-blend-mode on an
// image; a hard gradient stop at 0.5 over a wide shape; a gradient href child that is userSpaceOnUse; a mask region on an
// element whose clip nests.
function paintImageMaskAuditCells() {
  const doc = (body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/>${body}</svg>`;
  const WHITE = [255, 255, 255],
    RED = [255, 0, 0],
    LIME = [0, 255, 0],
    BLUE = [0, 0, 255],
    YELLOW = [255, 255, 0],
    BLACK = [0, 0, 0];

  // A minimal RGBA PNG encoder (one IDAT, filter 0 on every row).
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  function png(w, h, px) {
    const chunk = (type, data) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(td));
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        px(x, y).forEach((v, k) => {
          raw[y * (w * 4 + 1) + 1 + x * 4 + k] = v;
        });
    return (
      'data:image/png;base64,' +
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
      ]).toString('base64')
    );
  }
  // 20x10: columns 0-4 red, 5-14 lime, 15-19 blue.
  const BANDS = png(20, 10, (x) =>
    x < 5 ? [255, 0, 0, 255] : x < 15 ? [0, 255, 0, 255] : [0, 0, 255, 255],
  );
  const image = (attrs) => `<image href="${BANDS}" image-rendering="pixelated" ${attrs}/>`;
  const bands = (x0, x1, x2, x3, y0, y1) =>
    `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="red"/>` +
    `<rect x="${x1}" y="${y0}" width="${x2 - x1}" height="${y1 - y0}" fill="lime"/><rect x="${x2}" y="${y0}" width="${x3 - x2}" height="${y1 - y0}" fill="blue"/>`;

  // ---- hard gradient stop: userSpaceOnUse over 12800 units centered on x = 32 ------------------------------------------------
  const wide = (o) =>
    doc(
      `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="-6368" y1="0" x2="6432" y2="0">` +
        `<stop offset="0" stop-color="red"/><stop offset="${o}" stop-color="red"/><stop offset="${o}" stop-color="blue"/><stop offset="1" stop-color="blue"/></linearGradient></defs>` +
        '<rect width="64" height="64" fill="url(#g)"/>',
    );
  // ---- gradient href child ---------------------------------------------------------------------------------------------------
  const ST = '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>';
  const href = (child) =>
    doc(
      `<defs><linearGradient id="p">${ST}</linearGradient>${child}</defs><rect width="64" height="64" fill="url(#g)"/>`,
    );
  // ---- mask region on an element whose clip nests ----------------------------------------------------------------------------
  const nested = (region) =>
    doc(
      `<defs><clipPath id="d"><rect x="0" y="0" width="48" height="64"/></clipPath><clipPath id="c" clip-path="url(#d)"><rect x="12" y="0" width="40" height="64"/></clipPath>` +
        `<mask id="m" maskUnits="userSpaceOnUse" ${region}><rect x="-100" y="-100" width="300" height="300" fill="white"/></mask></defs>` +
        '<rect x="4" y="8" width="56" height="48" fill="red" clip-path="url(#c)" mask="url(#m)"/>',
    );

  const CELLS = [
    {
      name: 'image meet in a 48x48 box',
      svg: doc(image('x="8" y="8" width="48" height="48"')),
      control: doc(bands(8, 20, 44, 56, 20, 44)),
      old: doc(bands(8, 20, 44, 56, 8, 56)),
      probes: [
        [12, 32, RED, 1],
        [32, 32, LIME, 1],
        [52, 32, BLUE, 1],
        [32, 12, WHITE, 1],
        [32, 52, WHITE, 1],
      ],
    },
    {
      name: 'image slice (xMidYMid) covers the box',
      svg: doc(image('x="8" y="8" width="48" height="48" preserveAspectRatio="xMidYMid slice"')),
      control: doc('<rect x="8" y="8" width="48" height="48" fill="lime"/>'),
      old: doc(bands(8, 20, 44, 56, 8, 56)),
      probes: [
        [12, 32, LIME, 1],
        [32, 32, LIME, 1],
        [52, 32, LIME, 1],
        [4, 32, WHITE, 1],
        [60, 32, WHITE, 1],
      ],
    },
    {
      name: 'image slice (xMinYMin) keeps the left edge',
      svg: doc(image('x="8" y="8" width="48" height="48" preserveAspectRatio="xMinYMin slice"')),
      control: doc(bands(8, 32, 56, 56, 8, 56)),
      old: doc(bands(8, 20, 44, 56, 8, 56)),
      probes: [
        [12, 32, RED, 1],
        [28, 32, RED, 1],
        [36, 32, LIME, 1],
        [52, 52, LIME, 1],
        [60, 32, WHITE, 1],
      ],
    },
    {
      name: "image with no width or height is the bitmap's size",
      svg: doc(image('x="8" y="8"')),
      control: doc(bands(8, 13, 23, 28, 8, 18)),
      old: doc(''),
      probes: [
        [10, 12, RED, 1],
        [18, 12, LIME, 1],
        [26, 12, BLUE, 1],
        [18, 22, WHITE, 1],
        [30, 12, WHITE, 1],
      ],
    },
    {
      name: 'mix-blend-mode: multiply on an image',
      svg: doc(
        '<rect x="4" y="4" width="56" height="56" fill="yellow"/>' +
          image('x="8" y="8" width="48" height="24" style="mix-blend-mode:multiply"'),
      ),
      control: doc(
        '<rect x="4" y="4" width="56" height="56" fill="yellow"/><g style="mix-blend-mode:multiply">' +
          image('x="8" y="8" width="48" height="24"') +
          '</g>',
      ),
      old: doc(
        '<rect x="4" y="4" width="56" height="56" fill="yellow"/>' +
          image('x="8" y="8" width="48" height="24"'),
      ),
      probes: [
        [12, 20, RED, 2],
        [32, 20, LIME, 2],
        [52, 20, BLACK, 2],
        [32, 44, YELLOW, 1],
      ],
    },
    {
      name: 'a hard stop at 0.5 lands at 0.5 over a wide shape',
      svg: wide('0.5'),
      control: doc(
        '<rect x="0" y="0" width="32" height="64" fill="red"/><rect x="32" y="0" width="32" height="64" fill="blue"/>',
      ),
      old: wide('0.50196'),
      probes: [
        [8, 32, RED, 1],
        [28, 32, RED, 1],
        [36, 32, BLUE, 1],
        [48, 32, BLUE, 1],
      ],
    },
    {
      name: 'a href child gets its own userSpaceOnUse defaults',
      svg: href('<linearGradient id="g" href="#p" gradientUnits="userSpaceOnUse"/>'),
      control: href(
        '<linearGradient id="g" href="#p" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="64" y2="0"/>',
      ),
      old: href(
        '<linearGradient id="g" href="#p" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="0"/>',
      ),
      probes: [
        [16, 32, [191, 0, 64], 3],
        [48, 32, [64, 0, 191], 3],
        [2, 32, [247, 0, 8], 4],
      ],
    },
    {
      name: 'a mask region cuts an element whose clip nests',
      svg: nested('x="24" y="0" width="16" height="64"'),
      control: doc('<rect x="24" y="8" width="16" height="48" fill="red"/>'),
      old: nested('x="-100" y="-100" width="300" height="300"'),
      probes: [
        [32, 32, RED, 1],
        [18, 32, WHITE, 1],
        [44, 32, WHITE, 1],
        [32, 4, WHITE, 1],
      ],
    },
  ];
  return CELLS;
}
async function paintImageMaskAudit(suite) {
  const { ok, fail } = T;
  const CELLS = paintImageMaskAuditCells();
  const page = await auditPage(suite);
  for (const c of CELLS) {
    let px;
    try {
      px = await page.evaluate((s) => window.__render(s), [c.svg, c.control, c.old]);
    } catch (e) {
      fail(c.name + ': ' + e.message);
      continue;
    }
    const [a, b, o] = px;
    const vsControl = badPixels(a, b),
      vsOld = maxDiff(a, o);
    const bad = c.probes
      .filter(([x, y, want, tol]) => maxDiff(at(a, x, y), want) > tol)
      .map(([x, y, want]) => `(${x},${y}) is [${at(a, x, y)}], wanted [${want}]`);
    const line = `${c.name}: ${vsControl} px differ from the control (of 16384), old differs by ${vsOld}`;
    if (vsControl > 170) fail(line + ' -- render differs from its control');
    else if (vsOld < 48) fail(line + " -- vacuous: the wrong reading's picture is the same");
    else if (bad.length) fail(line + ' -- probes: ' + bad.join('; '));
    else ok(line);
  }
  await page.close();
}

// colorImage -- compositing rules that change pixels, on the GPU: a raster <image> is filtered PREMULTIPLIED
// (no dark halo next to a transparent texel), feComposite operator="lighter" is the clamped sum, plus two color rows through the
// real draw (`none` channels and color-mix premultiplied). The grammar itself is test/svg/colorChromeSmoke.mjs.
//
// Each cell renders three documents at 128 px (64-unit viewBox, white ground) as the importerGeometryAudit cells do:
//   svg      the document under test;
//   control  the same picture authored with features that do not depend on the rule (a gradient of the image's own alpha ramp, a flat fill at
//            the summed color): it must match to within `tol` (default 4/255: bilinear weights are 8-bit);
//   old      what the defect draws, authored literally: the render must DIFFER from it by at least 48/255 somewhere.
// Probes state the analytic expectation of a point (independent of both documents).
function colorImageCells() {
  const doc = (body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/>${body}</svg>`;

  function png(w, h, rgba) {
    const crcT = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcT[n] = c >>> 0;
    }
    const crc = (b) => {
      let c = 0xffffffff;
      for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (t, d) => {
      const b = Buffer.concat([Buffer.from(t), d]);
      const o = Buffer.alloc(4);
      o.writeUInt32BE(d.length);
      const c = Buffer.alloc(4);
      c.writeUInt32BE(crc(b));
      return Buffer.concat([o, b, c]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
      raw[y * (w * 4 + 1)] = 0;
      Buffer.from(rgba.slice(y * w * 4, (y + 1) * w * 4)).copy(raw, y * (w * 4 + 1) + 1);
    }
    return (
      'data:image/png;base64,' +
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
      ]).toString('base64')
    );
  }
  // 2x1: an opaque red texel, then a transparent one (RGB 0, as a browser decodes it).
  const EDGE = png(2, 1, [255, 0, 0, 255, 0, 0, 0, 0]);
  // 64x1: red and transparent texels alternate.
  const COMB = png(
    64,
    1,
    Array.from({ length: 64 }, (_, i) => (i % 2 ? [0, 0, 0, 0] : [255, 0, 0, 255])).flat(),
  );
  // The alpha ramp a bilinear filter draws between the two texel centers of EDGE shown over x in [8, 56] (centers at 20 and 44).
  const RAMP =
    '<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="20" y1="0" x2="44" y2="0"><stop offset="0" stop-color="#f00" stop-opacity="1"/><stop offset="1" stop-color="#f00" stop-opacity="0"/></linearGradient>';
  const IMG = `<image href="${EDGE}" x="8" y="24" width="48" height="16" preserveAspectRatio="none"/>`;
  const BAR = '<rect x="8" y="24" width="48" height="16" fill="url(#g)"/>';
  // Over the white ground a half-transparent red is (255,127,127). A straight-alpha filter draws (191,127,127) there: half-dark red.
  const HALF_RED = [255, 127, 127],
    OLD_HALF = [191, 127, 127];
  const OLD_PATCH =
    '<rect x="28" y="24" width="8" height="16" fill="rgb(127,0,0)" fill-opacity=".5"/>';

  const CELLS = [
    {
      name: 'a magnified <image> next to a transparent texel keeps the red (no dark halo)',
      svg: doc(IMG),
      control: doc(`<defs>${RAMP}</defs>${BAR}`),
      old: doc(`<defs>${RAMP}</defs>${BAR}${OLD_PATCH}`),
      probes: [
        [32, 32, HALF_RED, 4],
        [12, 32, [255, 0, 0], 4],
        [52, 32, [255, 255, 255], 2],
      ],
    },
    {
      name: 'the same image under a rotation (the mapped sampler)',
      svg: doc(`<g transform="rotate(30 32 32)">${IMG}</g>`),
      control: doc(`<defs>${RAMP}</defs><g transform="rotate(30 32 32)">${BAR}</g>`),
      old: doc(`<defs>${RAMP}</defs><g transform="rotate(30 32 32)">${BAR}${OLD_PATCH}</g>`),
      probes: [[32, 32, HALF_RED, 4]],
    },
    {
      name: 'an image tile in a raster <pattern>',
      svg: doc(
        `<defs><pattern id="p" patternUnits="userSpaceOnUse" x="8" y="24" width="48" height="16">${IMG.replace('x="8" y="24"', 'x="0" y="0"')}</pattern></defs><rect x="8" y="24" width="48" height="16" fill="url(#p)"/>`,
      ),
      control: doc(`<defs>${RAMP}</defs>${BAR}`),
      old: doc(`<defs>${RAMP}</defs>${BAR}${OLD_PATCH}`),
      probes: [[32, 32, HALF_RED, 4]],
    },
    {
      name: 'an image under opacity .5 (the tint multiplies the straight color, then premultiplies)',
      svg: doc(
        `<image href="${EDGE}" x="8" y="24" width="48" height="16" preserveAspectRatio="none" opacity=".5"/>`,
      ),
      control: doc(
        '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="20" y1="0" x2="44" y2="0"><stop offset="0" stop-color="#f00" stop-opacity=".5"/><stop offset="1" stop-color="#f00" stop-opacity="0"/></linearGradient></defs><rect x="8" y="24" width="48" height="16" fill="url(#g)"/>',
      ),
      old: doc(
        '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="20" y1="0" x2="44" y2="0"><stop offset="0" stop-color="#f00" stop-opacity=".5"/><stop offset="1" stop-color="#f00" stop-opacity="0"/></linearGradient></defs><rect x="8" y="24" width="48" height="16" fill="url(#g)"/><rect x="28" y="24" width="8" height="16" fill="rgb(127,0,0)" fill-opacity=".25"/>',
      ),
      probes: [[32, 32, [255, 191, 191], 4]],
    },
    {
      name: 'a minified image (mip chain) averages red and transparent to half-transparent red',
      svg: doc(
        `<image href="${COMB}" x="28" y="28" width="8" height="8" preserveAspectRatio="none"/>`,
      ),
      control: doc('<rect x="28" y="28" width="8" height="8" fill="red" fill-opacity=".5"/>'),
      old: doc('<rect x="28" y="28" width="8" height="8" fill="rgb(127,0,0)" fill-opacity=".5"/>'),
      tol: 6,
      probes: [[32, 32, HALF_RED, 6]],
    },
    {
      name: 'feComposite lighter is the clamped sum of the premultiplied inputs',
      svg: doc(
        '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64" color-interpolation-filters="sRGB"><feFlood flood-color="#ff8000" flood-opacity=".6" result="a"/><feFlood flood-color="#0080ff" flood-opacity=".6" result="b"/><feComposite in="a" in2="b" operator="lighter"/></filter><rect width="64" height="64" filter="url(#f)"/>',
      ),
      control: doc('<rect width="64" height="64" fill="rgb(153,153,153)"/>'),
      old: doc('<rect width="64" height="64" fill="rgb(194,148,102)"/>'),
      probes: [[32, 32, [153, 153, 153], 2]],
    },
    {
      name: 'rgb(none 255 0): a `none` channel is 0',
      svg: doc('<rect x="8" y="8" width="48" height="48" fill="rgb(none 255 0)"/>'),
      control: doc('<rect x="8" y="8" width="48" height="48" fill="#00ff00"/>'),
      old: doc('<rect x="8" y="8" width="48" height="48" fill="#ffff00"/>'),
      probes: [[32, 32, [0, 255, 0], 1]],
    },
    {
      name: 'color-mix(in srgb, red, transparent) is half-transparent RED (premultiplied), not dark red',
      svg: doc(
        '<rect x="8" y="8" width="48" height="48" fill="color-mix(in srgb, red, transparent)"/>',
      ),
      control: doc('<rect x="8" y="8" width="48" height="48" fill="red" fill-opacity=".5"/>'),
      old: doc('<rect x="8" y="8" width="48" height="48" fill="rgb(128,0,0)" fill-opacity=".5"/>'),
      probes: [[32, 32, HALF_RED, 2]],
    },
  ];
  return CELLS;
}
async function colorImage(suite) {
  const { ok, fail } = T;
  const CELLS = colorImageCells();
  const page = await auditPage(suite);
  for (const c of CELLS) {
    let px;
    try {
      px = await page.evaluate((s) => window.__render(s), [c.svg, c.control, c.old]);
    } catch (e) {
      fail(c.name + ': ' + e.message);
      continue;
    }
    const [a, b, o] = px;
    const vsControl = maxDiff(a, b),
      vsOld = maxDiff(a, o);
    const bad = c.probes
      .filter(([x, y, want, tol]) => maxDiff(at(a, x, y), want) > tol)
      .map(([x, y, want]) => `(${x},${y}) is [${at(a, x, y)}], wanted [${want}]`);
    const line = `${c.name}: control maxByte ${vsControl}, old differs by ${vsOld}`;
    if (vsControl > (c.tol ?? 4)) fail(line + ' -- render differs from its control');
    else if (vsOld < 48) fail(line + ' -- vacuous: the defect picture is the same');
    else if (bad.length) fail(line + ' -- probes: ' + bad.join('; '));
    else ok(line);
  }
  await page.close();
}

// animationAudit -- the morph-pose rules that change PIXELS, on the GPU (the record-level proofs
// are test/animationAuditSmoke.mjs).
//
// Each cell morphs two endpoint documents to t = .5 and compares the render at 128 px (100-unit viewBox, white ground) with a
// CONTROL: the pose authored literally as a static document (the lerped corner points, or the lerped arc numbers). The morph
// must match its control within MAXBYTE on every channel, and must DIFFER from its `old` picture (what the morph would draw
// with the defect) by at least 48/255 somewhere, so a pass cannot be a picture the defect also draws.
//
//   a rect morphing to a rotated rect (a diamond). A rect row that kept primKind 2 would let the closed-form rect coverage of
//          the fragment shader paint the SOURCE rect's box through the pose; old = that rect.
//   a rotated ellipse (two arcs) turning 0 -> 180 degrees. A pose bbox taken as the linear lerp of the endpoint boxes is
//          smaller than the pose, so the quad extent / box-indexed coverage would clip the arcs; old = the same pose clipped to
//          the linear box.
//
// Engines: AAC and Slug covers, each with primitives 'on' (the primFast path live) and 'off'; GPU curve lerp and CPU curve lerp.
async function animationAudit(suite) {
  const { fail } = T;
  const doc = (body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="white"/>${body}</svg>`;
  const MAXBYTE = 40; // AA edge differences between a morph pose and a static document at 128 px

  const rect = doc('<rect id="s" x="30" y="30" width="40" height="40" fill="#c81e1e"/>');
  const diamond = doc('<path id="s" fill="#c81e1e" d="M50 20L80 50L50 80L20 50Z"/>');
  const P = [
      [30, 30],
      [70, 30],
      [70, 70],
      [30, 70],
    ],
    Q = [
      [50, 20],
      [80, 50],
      [50, 80],
      [20, 50],
    ];
  const lerpPoly = (t) =>
    doc(
      `<path id="s" fill="#c81e1e" d="M${P.map((v, i) => `${v[0] * (1 - t) + Q[i][0] * t} ${v[1] * (1 - t) + Q[i][1] * t}`).join('L')}Z"/>`,
    );

  // The rotation lerps as a number with the end points in place, so the pose at t = .5 is the path with rotation 90: scaled up to span the chord, it swings far out of both poses' boxes.
  const ell = (phi) =>
    doc(`<path id="s" fill="#1e5ac8" d="M90 50A40 10 ${phi} 0 1 10 50A40 10 ${phi} 0 1 90 50Z"/>`);

  const CELLS = [
    {
      name: 'rect -> diamond at t=.5',
      a: rect,
      b: diamond,
      t: 0.5,
      control: lerpPoly(0.5),
      old: doc('<rect x="30" y="30" width="40" height="40" fill="#c81e1e"/>'),
    },
    {
      name: 'ellipse 0 -> 180 degrees at t=.5',
      a: ell(0),
      b: ell(180),
      t: 0.5,
      control: ell(90),
      old: doc(
        '<clipPath id="k"><rect x="10" y="40" width="80" height="20"/></clipPath><path fill="#1e5ac8" d="M90 50A40 10 90 0 1 10 50A40 10 90 0 1 90 50Z" clip-path="url(#k)"/>',
      ),
    },
  ];
  const CONFIGS = [
    { route: 'none', kernel: 'aac', primitives: 'on' },
    { route: 'none', kernel: 'aac', primitives: 'off' },
    { route: 'none', kernel: 'slug', primitives: 'on' },
    { route: 'none', kernel: 'slug', primitives: 'off' },
  ];
  const MORPH_HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph } from '/src/index.js';
import { paint, viewport } from '/test/_auditPaintCases.mjs';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__render = async (cell, cfg, cpuLerp) => {
  viewport(gl, R); R.setFillEngine(cfg);
  const bd = async (s) => createBundle(gl, await importSvg(s, { preserveViewport: true }));
  const a = await bd(cell.a), b = await bd(cell.b), ctl = await bd(cell.control), old = await bd(cell.old);
  const m = createShapeMorph(gl, a, b, { cpuLerp });
  if (!cpuLerp) m.bundle._morphSrc.gpuSmallPlanes = true;
  m.setT(cell.t);
  const out = { pose: Array.from(await paint(gl, R, m)), control: Array.from(await paint(gl, R, ctl)), old: Array.from(await paint(gl, R, old)),
    prim: m.bundle.metaFloats[44], gpu: !!m.usesGpuCurveLerp };
  m.dispose(); a.dispose(); b.dispose(); ctl.dispose(); old.dispose();
  return out;
};
window.__backend = (() => { const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })();
window.__ready = true;
</script></body></html>`;
  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await suite.goto(page, MORPH_HTML);
  console.log('backend:', await page.evaluate(() => window.__backend));
  for (const cell of CELLS)
    for (const cfg of CONFIGS)
      for (const cpuLerp of [false, true]) {
        const tag = `${cell.name} [${cfg.kernel}/prim ${cfg.primitives}/${cpuLerp ? 'cpu' : 'gpu'} lerp]`;
        let r;
        try {
          r = await page.evaluate((c, g, l) => window.__render(c, g, l), cell, cfg, cpuLerp);
        } catch (e) {
          fail(tag + ': ' + e.message);
          continue;
        }
        const vsControl = maxDiff(r.pose, r.control),
          vsOld = maxDiff(r.pose, r.old);
        const line = `${tag}: control maxByte ${vsControl}, old differs by ${vsOld}, prim slot ${r.prim}`;
        if (vsControl > MAXBYTE) {
          fail(line + ' -- render differs from its control');
        } else if (vsOld < 48) {
          fail(line + ' -- vacuous: the defect picture is the same');
        } else T.ok(line);
      }
  await page.close();
}

if (process.argv.includes('--cpu')) {
  const { imp } = await import('./svg/_importSemantics.mjs');
  const key = (x) =>
    JSON.stringify(
      Object.keys(x)
        .sort()
        .map((k) => [
          k,
          ArrayBuffer.isView(x[k]) || x[k] instanceof ArrayBuffer
            ? Buffer.from(x[k].buffer || x[k]).toString('base64')
            : x[k],
        ]),
      (k, v) => (typeof v === 'number' && !isFinite(v) ? String(v) : v),
    );
  const same = (a, b) => key(a) === key(b);
  for (const c of importerSemanticsCells()) {
    const [s, k, o] = await Promise.all([
      imp(c.svg, { preserveViewport: true }),
      imp(c.control, { preserveViewport: true }),
      imp(c.old, { preserveViewport: true }),
    ]);
    console.log(
      `${same(s, k) ? 'record==control' : 'record!=control'} ${same(s, o) ? 'record==OLD(vacuous?)' : 'record!=old'}  ${c.name}`,
    );
  }
  process.exit(0);
}

const suite = await openPageSuite({ root: ROOT });
try {
  await T.run(
    [
      ['importerSemantics', importerSemantics],
      ['importerGeometryAudit', importerGeometryAudit],
      ['compositingGroup', compositingGroup],
      ['filterLeafGroup', filterLeafGroup],
      ['paintImageMaskAudit', paintImageMaskAudit],
      ['colorImage', colorImage],
      ['animationAudit', animationAudit],
    ],
    suite,
  );
} finally {
  await suite.close();
}
if (T.failures()) {
  console.error('\n' + T.failures() + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nimporterSemanticsRenderSmoke: the importer, compositing and morph-pose rules render as their controls on the GPU',
);
