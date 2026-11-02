// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _svgImageFitCases.mjs — how an SVG <image> places its document, case by case, under importSvg's two
// compat modes: 'spec' (SVG 2 §image, the default) and 'chrome' (what Chrome draws).
//
// Every case is an <image x=10 y=10 width=80 height=40> in a 100x60 cell, over a white rect covering the
// cell. The referenced document draws four rects: red fills its viewBox 0 0 10 10, yellow its top fifth
// (y 0..2), green lies past its LEFT edge (x -10..0) and blue past its RIGHT edge (x 10..20). The colors
// at PTS say which fit applied and what was clipped.
//
// `chrome` rows are Chrome 147.0.7727.57, measured through both of its routes (the outer document as an
// <img>, and inline SVG; they agree on every point). `spec` rows are SVG 2 §image as importWalkStructure.js
// svgImagePlacement reads it: the natural aspect ratio is the root's width/height when both are lengths,
// else its viewBox's; the image's preserveAspectRatio fits it into the image's rect, giving the
// image-rendering rect R, onto which the viewBox is stretched (the root's own preserveAspectRatio is
// ignored); no viewBox leaves the content unscaled at R's origin; the image's overflow clips to its rect,
// the root's to R. Where the rows differ, Chrome departs from the spec.
//
// Used by test/svg/svgImageDocumentSmoke.mjs (both modes, on the imported rows) and
// test/svgImageDocumentRenderSmoke.mjs (chrome mode against Chrome, spec mode at the divergences).

export const PTS = [
  [15, 30],
  [45, 30],
  [55, 30],
  [85, 30],
  [50, 14],
  [95, 30],
  [15, 15],
  [25, 15],
  [35, 15],
  [45, 15],
  [50, 4],
  [5, 30],
];

export const RGB = {
  red: [255, 0, 0],
  yel: [255, 255, 0],
  grn: [0, 255, 0],
  blu: [0, 0, 255],
  wht: [255, 255, 255],
};

const VB = 'viewBox="0 0 10 10"';
// [id, what, image preserveAspectRatio, root attributes, image attributes, spec row, chrome row]
export const CASES = [
  [
    '1',
    'default fit, root viewBox',
    '',
    VB,
    '',
    'grn red red blu yel wht grn grn yel yel wht wht',
    'grn red red blu yel wht grn grn yel yel wht wht',
  ],
  [
    '2',
    'image slice',
    'xMidYMid slice',
    VB,
    '',
    'red red red red red wht red red red red wht wht',
    'grn red red blu yel wht grn grn yel yel wht wht',
  ],
  [
    '3',
    'image xMinYMid meet',
    'xMinYMid meet',
    VB,
    '',
    'red red blu blu blu wht yel yel yel yel wht wht',
    'grn red red blu yel wht grn grn yel yel wht wht',
  ],
  [
    '4',
    'image none',
    'none',
    VB,
    '',
    'red red red red yel wht yel yel yel yel wht wht',
    'red red red red yel wht yel yel yel yel wht wht',
  ],
  [
    '5',
    'root xMinYMid meet',
    '',
    VB + ' preserveAspectRatio="xMinYMid meet"',
    '',
    'grn red red blu yel wht grn grn yel yel wht wht',
    'red red blu blu blu wht yel yel yel yel wht wht',
  ],
  [
    '6',
    'root slice',
    '',
    VB + ' preserveAspectRatio="xMidYMid slice"',
    '',
    'grn red red blu yel wht grn grn yel yel wht wht',
    'red red red red red wht red red red red wht wht',
  ],
  [
    '7',
    'image slice, root slice',
    'xMidYMid slice',
    VB + ' preserveAspectRatio="xMidYMid slice"',
    '',
    'red red red red red wht red red red red wht wht',
    'red red red red red wht red red red red wht wht',
  ],
  [
    '8',
    'image xMinYMid, root xMaxYMid',
    'xMinYMid meet',
    VB + ' preserveAspectRatio="xMaxYMid meet"',
    '',
    'red red blu blu blu wht yel yel yel yel wht wht',
    'grn grn red red yel wht grn grn grn grn wht wht',
  ],
  [
    '9',
    'image none, root xMinYMid',
    'none',
    VB + ' preserveAspectRatio="xMinYMid meet"',
    '',
    'red red red red yel wht yel yel yel yel wht wht',
    'red red red red yel wht yel yel yel yel wht wht',
  ],
  [
    '10',
    'image slice, root viewBox + width/height 10',
    'xMidYMid slice',
    VB + ' width="10" height="10"',
    '',
    'red red red red red wht red red red red wht wht',
    'grn red red blu yel wht grn grn yel yel wht wht',
  ],
  [
    '11',
    'root width 20 height 10 (2:1) over a 1:1 viewBox',
    '',
    VB + ' width="20" height="10"',
    '',
    'red red red red yel wht yel yel yel yel wht wht',
    'grn red red blu yel wht grn grn yel yel wht wht',
  ],
  [
    '12',
    'root width/height 10, no viewBox',
    '',
    'width="10" height="10"',
    '',
    'wht wht wht wht wht wht wht grn red blu wht wht',
    'red red red red yel wht yel yel yel yel wht wht',
  ],
  [
    '13',
    'image slice, root width/height 10, no viewBox',
    'xMidYMid slice',
    'width="10" height="10"',
    '',
    'wht wht wht wht wht wht wht wht wht wht wht wht',
    'red red red red yel wht yel yel yel yel wht wht',
  ],
  [
    '14',
    'root: no viewBox, no size',
    '',
    '',
    '',
    'wht wht wht wht wht wht red blu wht wht wht wht',
    'wht wht wht wht wht wht red blu wht wht wht wht',
  ],
  [
    '15',
    'root overflow hidden',
    '',
    VB + ' overflow="hidden"',
    '',
    'wht red red wht yel wht wht wht yel yel wht wht',
    'grn red red blu yel wht grn grn yel yel wht wht',
  ],
  [
    '16',
    'image xMinYMid meet, root width/height 10, no viewBox',
    'xMinYMid meet',
    'width="10" height="10"',
    '',
    'wht wht wht wht wht wht red blu wht wht wht wht',
    'red red red red yel wht yel yel yel yel wht wht',
  ],
  [
    '17',
    'image none, root width 20 height 10',
    'none',
    VB + ' width="20" height="10"',
    '',
    'red red red red yel wht yel yel yel yel wht wht',
    'grn red red blu yel wht grn grn yel yel wht wht',
  ],
  [
    '18',
    'image slice, image overflow visible',
    'xMidYMid slice',
    VB,
    ' overflow="visible"',
    'red red red red red blu red red red red yel grn',
    'grn red red blu yel wht grn grn yel yel wht wht',
  ],
].map(([id, what, imgPar, rootAttrs, imgAttrs, spec, chrome]) => ({
  id,
  what,
  imgPar,
  rootAttrs,
  imgAttrs,
  spec: spec.split(' '),
  chrome: chrome.split(' '),
}));

const BODY =
  '<rect x="-10" width="10" height="10" fill="#0f0"/><rect x="10" width="10" height="10" fill="#00f"/>' +
  '<rect width="10" height="10" fill="#f00"/><rect width="10" height="2" fill="#ff0"/>';
const b64 = (s) => 'data:image/svg+xml;base64,' + Buffer.from(s, 'utf8').toString('base64');

/// One case's cell: the white rect and the <image>, in the cell's own coordinates (0..100 x 0..60).
export function cellMarkup(c) {
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" ${c.rootAttrs}>${BODY}</svg>`;
  return (
    `<rect width="100" height="60" fill="#fff"/><image x="10" y="10" width="80" height="40"` +
    `${c.imgPar ? ` preserveAspectRatio="${c.imgPar}"` : ''}${c.imgAttrs} href="${b64(doc)}"/>`
  );
}

/// One case as a standalone 100x60 document.
export const cellSvg = (c) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60" viewBox="0 0 100 60">${cellMarkup(c)}</svg>`;

/// Every case in one document: cell i at CELL_ORIGIN(i). Cells sit 260 x 80 apart, 80 in and 10 down,
/// so what a case draws past its image rect (case 18 reaches x -70..170, y -10..70 of its cell) stays
/// inside its own slot.
export const GRID_COLS = 3;
export const cellOrigin = (i) => [(i % GRID_COLS) * 260 + 80, Math.floor(i / GRID_COLS) * 80 + 10];
export const GRID_W = GRID_COLS * 260,
  GRID_H = Math.ceil(CASES.length / GRID_COLS) * 80;
export const gridSvg = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${GRID_W}" height="${GRID_H}" viewBox="0 0 ${GRID_W} ${GRID_H}">` +
  CASES.map((c, i) => {
    const [x, y] = cellOrigin(i);
    return `<g transform="translate(${x} ${y})">${cellMarkup(c)}</g>`;
  }).join('') +
  '</svg>';
