// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _nativeMorphGroupArt.mjs: the poses shared by nativeMorphGroupSpaceSmoke (node, DOM geometry) and nativeMorphGroupRasterSmoke (browser, pixels).
// ---- the art -----------------------------------------------------------------------------------------------------------------
// numbers per pose: p is a line + cubic, c a circle (an arc), both change between poses.
export const PA = { p: [0, 0, 40, 0, 50, 10, 50, 30, 40, 40], c: [60, 30, 8] };
export const PB = { p: [2, 3, 30, -2, 55, 20, 60, 25, 35, 45], c: [70, 40, 14] };
export const MID = {
  p: PA.p.map((v, i) => (v + PB.p[i]) / 2),
  c: PA.c.map((v, i) => (v + PB.c[i]) / 2),
};
export const shapes = (P, own = '', sw = 0) =>
  `<path id="p" ${own ? `transform="${own}" ` : ''}d="M${P.p[0]} ${P.p[1]}L${P.p[2]} ${P.p[3]}C${P.p[4]} ${P.p[5]} ${P.p[6]} ${P.p[7]} ${P.p[8]} ${P.p[9]}Z" fill="#c00"${sw ? ` stroke="#000" stroke-width="${sw}"` : ''}/>` +
  `<circle id="c" cx="${P.c[0]}" cy="${P.c[1]}" r="${P.c[2]}" fill="#00c"/>`;
export const CASES = {
  group: (P) => `<g transform="translate(30 10)">${shapes(P)}</g>`,
  nested: (P) =>
    `<g transform="translate(10 5)"><g transform="rotate(30)"><g transform="scale(1.5 0.7)">${shapes(P)}</g></g></g>`,
  skewOwn: (P) =>
    `<g transform="matrix(1 0.3 0.2 1.2 5 7)">${shapes(P, 'rotate(20) scale(1 2)')}</g>`,
  ownOnly: (P) => shapes(P, 'translate(10 10) scale(2)'),
  // nested <use>, a <symbol> target (its viewBox fit and viewport clip), an <svg> target (the use's width/height replace its own),
  // a use of a group that holds a symbol use, and an authored nested <svg>. Every one has two instances (the inline svg has one).
  nestedUse: (P) =>
    `<defs><g id="in">${shapes(P)}</g><g id="out"><use href="#in" transform="translate(5 5) rotate(10)"/></g></defs><use href="#out" transform="translate(30 10) scale(0.5)"/><use href="#out" x="20" y="45"/>`,
  symbol: (P) =>
    `<defs><symbol id="s" viewBox="0 0 100 100">${shapes(P)}</symbol></defs><use href="#s" x="10" y="20" width="60" height="30"/><use href="#s" transform="translate(50 50) scale(0.4)" width="100" height="100"/>`,
  svgTarget: (P) =>
    `<defs><svg id="v" width="40" height="40" viewBox="0 0 100 100">${shapes(P)}</svg></defs><use href="#v" x="5" y="5"/><use href="#v" x="50" y="50" width="30" height="50"/>`,
  nestedSymbol: (P) =>
    `<defs><symbol id="s2" viewBox="0 0 100 100">${shapes(P)}</symbol><g id="w"><use href="#s2" width="100" height="100" transform="rotate(10)"/></g></defs><use href="#w" transform="translate(10 10) scale(0.8)"/><use href="#w" transform="translate(50 40) scale(0.5)"/>`,
  inlineSvg: (P) =>
    `<svg x="10" y="10" width="80" height="50" viewBox="0 0 100 100" preserveAspectRatio="xMinYMax meet">${shapes(P)}</svg>`,
  use: (P) =>
    `<defs><g id="t">${shapes(P)}</g></defs><use href="#t" transform="translate(30 10) scale(0.5)"/><use href="#t" x="20" y="45"/>`,
};
